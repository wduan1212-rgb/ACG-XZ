import asyncio
import base64
import hashlib
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from server import main, store


PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(
    b"\x89PNG\r\n\x1a\nbackground-job-test"
).decode("ascii")


class BatchImageBackgroundJobsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_db = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        self.previous_upload_dir = main.UPLOAD_DIR
        store.DB_PATH = Path(self.temp.name) / "batch-jobs.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        main.UPLOAD_DIR = Path(self.temp.name) / "uploads"
        self.member_row = store.add_member(
            "批量任务用户", "batch-background-user", "123456", "editor",
        )
        self.owner_id = self.member_row[0]
        now = int(time.time() * 1000)
        store.upsert_docs("accounts", [{
            "id": "account-a", "name": "账号 A", "mode": "图文",
            "ownerId": self.owner_id, "createdAt": now, "updatedAt": now,
        }], actor_id=self.owner_id)
        store.upsert_docs("productions", [{
            "id": "production-a", "accountId": "account-a", "ownerId": self.owner_id,
            "mode": "图文", "createdAt": now, "updatedAt": now,
            "artifacts": {"images": {"items": [
                {"prompt": "图片一", "operationKey": "batch-image-production-a-1", "status": "queued"},
                {"prompt": "图片二", "operationKey": "batch-image-production-a-2", "status": "queued"},
                {"prompt": "图片三", "operationKey": "batch-image-production-a-3", "status": "queued"},
            ]}},
        }], actor_id=self.owner_id)

    def tearDown(self):
        store.DB_PATH = self.previous_db
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        main.UPLOAD_DIR = self.previous_upload_dir
        self.temp.cleanup()

    def jobs(self):
        jobs = [{
            "clientJobId": f"batch-image-production-a-{index + 1}",
            "productionId": "production-a",
            "accountId": "account-a",
            "itemIndex": index,
            "operationKey": f"batch-image-production-a-{index + 1}",
            "prompt": f"生成图片 {index + 1}",
            "refs": [],
            "ratio": "3:4",
            "assetName": f"结果 {index + 1}",
        } for index in range(3)]
        for job in jobs:
            job["requestFingerprint"] = store._canonical_json_sha256(job)
        return jobs

    def test_batch_registration_is_atomic_idempotent_and_owner_scoped(self):
        first = store.create_batch_image_generation_jobs(self.owner_id, self.jobs())
        self.assertEqual(3, len(first))
        self.assertTrue(all(created for _job, created in first))
        replay = store.create_batch_image_generation_jobs(self.owner_id, self.jobs())
        self.assertTrue(all(not created for _job, created in replay))

        conflicting = self.jobs()
        conflicting[1]["prompt"] = "不同的图片请求"
        conflicting[1]["requestFingerprint"] = store._canonical_json_sha256({
            key: value for key, value in conflicting[1].items()
            if key != "requestFingerprint"
        })
        with self.assertRaisesRegex(ValueError, "batch_image_generation_job_conflict"):
            store.create_batch_image_generation_jobs(self.owner_id, conflicting)

        other = store.add_member("另一个用户", "batch-other-user", "123456", "editor")
        self.assertIsNone(store.get_batch_image_generation_job(
            other[0], "batch-image-production-a-1",
        ))

    def test_worker_persists_each_asset_and_production_slot_without_browser(self):
        store.create_batch_image_generation_jobs(self.owner_id, self.jobs())

        async def generated(*_args, **_kwargs):
            await asyncio.sleep(0.01)
            return {
                "ok": True, "dataUrl": PNG_DATA_URL, "model": "mock-image",
                "usedRefs": 0, "skippedRefs": 0, "ratio": "3:4", "mode": "mock",
                "referenceReceipt": {"intended": 0, "used": 0, "skipped": 0},
            }

        async def exercise():
            # The locked regression suite intentionally runs without provider
            # secrets.  Keep the production configuration guard intact while
            # replacing both its secret and the paid provider boundary here.
            with patch.object(main, "IMAGE_API_KEY", "test-image-key"), patch.object(
                main, "_image_generate_impl", side_effect=generated,
            ):
                await asyncio.gather(*[
                    main._run_batch_image_generation_job(
                        self.owner_id, f"batch-image-production-a-{index + 1}",
                    )
                    for index in range(3)
                ])

        asyncio.run(exercise())
        state = store.state_for(
            self.owner_id, "editor", collections=["productions", "assets"],
        )
        production = state["productions"][0]
        items = production["artifacts"]["images"]["items"]
        self.assertTrue(all(item["status"] == "done" for item in items))
        self.assertTrue(all(item["referenceReceipt"]["used"] == 0 for item in items))
        self.assertEqual(3, len({item["assetId"] for item in items}))
        self.assertEqual(3, len(state["assets"]))
        self.assertTrue(all(Path(main.UPLOAD_DIR / asset["serverFileName"]).is_file() for asset in state["assets"]))
        self.assertTrue(all(
            store.get_batch_image_generation_job(
                self.owner_id, f"batch-image-production-a-{index + 1}",
            )["status"] == "succeeded"
            for index in range(3)
        ))

    def test_restart_resumes_queued_and_quarantines_running(self):
        store.create_batch_image_generation_jobs(self.owner_id, self.jobs())
        _job, claimed = store.claim_batch_image_generation_job(
            self.owner_id, "batch-image-production-a-1",
        )
        self.assertTrue(claimed)
        queued = store.recover_batch_image_generation_jobs()
        self.assertEqual(
            {"batch-image-production-a-2", "batch-image-production-a-3"},
            {item["jobId"] for item in queued},
        )
        interrupted = store.get_batch_image_generation_job(
            self.owner_id, "batch-image-production-a-1",
        )
        self.assertEqual("confirming", interrupted["status"])

    def test_usage_only_quota_never_calls_legacy_reservation(self):
        with patch.object(
            store, "reserve_generation_points", side_effect=AssertionError("legacy gate called"),
        ):
            reservation = main._quota_begin(
                {"id": self.owner_id}, 999999, "测试功能", "test.feature",
                "operation-one", hashlib.sha256(b"request").hexdigest(),
            )
        self.assertTrue(reservation["bypassed"])
        self.assertEqual("usage-only", reservation["status"])
        self.assertEqual(0, reservation["deducted"])


class FairImageSubmitQueueTest(unittest.IsolatedAsyncioTestCase):
    async def test_round_robin_prevents_one_surface_from_monopolizing_capacity(self):
        queue = main._FairImageSubmitQueue(1)
        order = []
        first_started = asyncio.Event()
        release_first = asyncio.Event()

        async def worker(name, key, hold=False):
            async with main._fair_image_submit_slot(queue, key):
                order.append(name)
                if hold:
                    first_started.set()
                    await release_first.wait()
                await asyncio.sleep(0)

        first = asyncio.create_task(worker("a1", "member-a:batch", True))
        await first_started.wait()
        pending = [
            asyncio.create_task(worker("a2", "member-a:batch")),
            asyncio.create_task(worker("b1", "member-b:canvas")),
            asyncio.create_task(worker("a3", "member-a:batch")),
        ]
        await asyncio.sleep(0)
        release_first.set()
        await asyncio.gather(first, *pending)
        self.assertEqual(["a1", "a2", "b1", "a3"], order)
        self.assertEqual(0, queue.active)


if __name__ == "__main__":
    unittest.main()
