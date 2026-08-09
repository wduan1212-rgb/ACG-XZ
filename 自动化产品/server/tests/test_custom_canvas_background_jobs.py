import asyncio
import hashlib
import importlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


SERVER_DIR = Path(__file__).resolve().parents[1]
TEST_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_custom_canvas_draft_persistence import load_canvas_store


main = importlib.import_module("main")


class CustomCanvasBackgroundJobTest(unittest.TestCase):
    def test_store_job_resolves_browser_source_id_to_stable_project_scope(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            with store._lock:
                conn = store._connect()
                try:
                    now = 100
                    conn.execute("UPDATE members SET role='user' WHERE id='creator-a'")
                    project = {
                        "id": "canvas-stable-a",
                        "ownerId": "creator-a",
                        "kind": "canvas",
                        "projectState": {"sourceProjectId": "browser-project-a"},
                    }
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('customProjects',?,?,?,?)",
                        ("canvas-stable-a", "creator-a", now, json.dumps(project)),
                    )
                    conn.execute(
                        "INSERT INTO resource_scopes("
                        "resource_kind,resource_id,scope_type,scope_id,owner_id,"
                        "provenance,captured_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                        (
                            "doc:customProjects", "canvas-stable-a", "member",
                            "creator-a", "creator-a", "test-source", now, now,
                        ),
                    )
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,"
                        "status,summary) VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_NAME,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
                            "test", now, now, "success", "{}",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()

            created, inserted = store.create_custom_canvas_generation_job(
                "creator-a",
                "browser-job-a",
                hashlib.sha256(b"browser-request-a").hexdigest(),
                source_project_id="browser-project-a",
            )
            self.assertTrue(inserted)
            self.assertEqual(created["sourceProjectId"], "browser-project-a")
            with store._lock:
                conn = store._connect()
                try:
                    internal_id = store._custom_canvas_generation_job_id(
                        "creator-a", "browser-job-a"
                    )
                    scope = conn.execute(
                        "SELECT scope_type,scope_id,owner_id FROM resource_scopes "
                        "WHERE resource_kind=? AND resource_id=?",
                        (
                            store._doc_resource_kind(
                                store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION
                            ),
                            internal_id,
                        ),
                    ).fetchone()
                finally:
                    conn.close()
            self.assertEqual(("member", "creator-a", "creator-a"), scope)

            with self.assertRaisesRegex(
                PermissionError, "resource_reference_scope_missing"
            ):
                store.create_custom_canvas_generation_job(
                    "creator-a",
                    "browser-job-missing",
                    hashlib.sha256(b"browser-request-missing").hexdigest(),
                    source_project_id="browser-project-missing",
                )

    def test_store_jobs_are_owner_scoped_idempotent_and_success_is_immutable(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            with store._lock:
                conn = store._connect()
                try:
                    now = 100
                    conn.execute(
                        "UPDATE members SET role='user' WHERE id='creator-a'"
                    )
                    project = {
                        "id": "project-a", "ownerId": "creator-a",
                        "name": "scope source", "updatedAt": now,
                    }
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('customProjects','project-a','creator-a',?,?)",
                        (now, json.dumps(project)),
                    )
                    conn.execute(
                        "INSERT INTO resource_scopes("
                        "resource_kind,resource_id,scope_type,scope_id,owner_id,"
                        "provenance,captured_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                        (
                            "doc:customProjects", "project-a", "member", "creator-a",
                            "creator-a", "test-source", now, now,
                        ),
                    )
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,"
                        "status,summary) VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_NAME,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
                            "test", now, now, "success", "{}",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()
            fingerprint = hashlib.sha256(b"request-a").hexdigest()
            created, inserted = store.create_custom_canvas_generation_job(
                "creator-a",
                "job-a",
                fingerprint,
                source_project_id="project-a",
            )
            self.assertTrue(inserted)
            self.assertEqual(created["status"], "queued")
            self.assertEqual(created["sourceProjectId"], "project-a")
            with store._lock:
                conn = store._connect()
                try:
                    internal_id = store._custom_canvas_generation_job_id(
                        "creator-a", "job-a"
                    )
                    scope = conn.execute(
                        "SELECT scope_type,scope_id,owner_id FROM resource_scopes "
                        "WHERE resource_kind=? AND resource_id=?",
                        (
                            store._doc_resource_kind(
                                store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION
                            ),
                            internal_id,
                        ),
                    ).fetchone()
                finally:
                    conn.close()
            self.assertEqual(("member", "creator-a", "creator-a"), scope)

            duplicate, inserted = store.create_custom_canvas_generation_job(
                "creator-a",
                "job-a",
                fingerprint,
                source_project_id="project-a",
            )
            self.assertFalse(inserted)
            self.assertEqual(duplicate["jobId"], "job-a")
            self.assertIsNone(store.get_custom_canvas_generation_job("creator-b", "job-a"))

            with self.assertRaisesRegex(ValueError, "custom_canvas_generation_job_conflict"):
                store.create_custom_canvas_generation_job(
                    "creator-a",
                    "job-a",
                    hashlib.sha256(b"request-b").hexdigest(),
                    source_project_id="project-a",
                )

            running, claimed = store.claim_custom_canvas_generation_job("creator-a", "job-a")
            self.assertTrue(claimed)
            self.assertEqual(running["status"], "running")
            replay, claimed = store.claim_custom_canvas_generation_job("creator-a", "job-a")
            self.assertFalse(claimed)
            self.assertEqual(replay["status"], "running")

            succeeded = store.finish_custom_canvas_generation_job(
                "creator-a",
                "job-a",
                status="succeeded",
                result={"images": [{"dataUrl": "/api/custom-canvas/blobs/" + "a" * 64}]},
            )
            self.assertEqual(succeeded["status"], "succeeded")
            replay = store.finish_custom_canvas_generation_job(
                "creator-a",
                "job-a",
                status="failed",
                error="must not replace success",
            )
            self.assertEqual(replay["status"], "succeeded")
            self.assertEqual(replay.get("error", ""), "")

    def test_server_worker_persists_stable_output_and_never_replays_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            request = main.CustomCanvasGenerateReq(
                prompt="后台生成测试",
                count=1,
                size="1024x1024",
                idempotencyKey="job-worker",
            )
            fingerprint = main._quota_request_fingerprint(request)
            store.create_custom_canvas_generation_job(
                "creator-a",
                "job-worker",
                fingerprint,
                source_project_id="project-worker",
            )
            generated = {
                "images": [{
                    "dataUrl": "data:image/png;base64,c2FmZQ==",
                    # Provider URLs are deliberately transient: the worker
                    # persists only the verified local blob URL/hash.
                    "providerUrl": "https://provider.invalid/transient.png",
                    "sourceUrl": "https://provider.invalid/source.png",
                    "width": 1024,
                    "height": 1024,
                    "label": "测试图",
                    "variant": 1,
                    "generationReceipt": "test-receipt",
                }],
                "usedRefs": 0,
                "skippedRefs": 0,
                "model": "test-model",
                "mode": "text",
                "billing": {"status": "settled"},
            }
            stable = {
                "url": "/api/custom-canvas/blobs/" + "b" * 64,
                "contentHash": "b" * 64,
            }
            provider = AsyncMock(return_value=generated)
            with patch.object(main, "store", store), patch.object(
                main,
                "_custom_canvas_generate_result",
                new=provider,
            ), patch.object(store, "save_custom_canvas_blob", return_value=stable):
                asyncio.run(main._run_custom_canvas_generation_job(
                    {"id": "creator-a", "role": "editor"},
                    "job-worker",
                    "job-worker",
                    "generate",
                    request,
                ))
                job = store.get_custom_canvas_generation_job("creator-a", "job-worker")
                self.assertEqual(job["status"], "succeeded")
                self.assertEqual(job["images"][0]["dataUrl"], stable["url"])
                self.assertEqual(job["images"][0]["assetUrl"], stable["url"])
                self.assertNotIn("providerUrl", job["images"][0])
                self.assertNotIn("sourceUrl", job["images"][0])
                self.assertEqual(provider.await_count, 1)

                asyncio.run(main._run_custom_canvas_generation_job(
                    {"id": "creator-a", "role": "editor"},
                    "job-worker",
                    "job-worker",
                    "generate",
                    request,
                ))
                self.assertEqual(provider.await_count, 1)

    def test_failed_job_is_terminal_without_automatic_provider_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            request = main.CustomCanvasGenerateReq(
                prompt="失败测试",
                count=1,
                size="1024x1024",
                idempotencyKey="job-failed",
            )
            store.create_custom_canvas_generation_job(
                "creator-a",
                "job-failed",
                main._quota_request_fingerprint(request),
                source_project_id="project-failed",
            )
            provider = AsyncMock(side_effect=RuntimeError("provider failure"))
            with patch.object(main, "store", store), patch.object(
                main,
                "_custom_canvas_generate_result",
                new=provider,
            ):
                asyncio.run(main._run_custom_canvas_generation_job(
                    {"id": "creator-a", "role": "editor"},
                    "job-failed",
                    "job-failed",
                    "generate",
                    request,
                ))
                job = store.get_custom_canvas_generation_job("creator-a", "job-failed")
                self.assertEqual(job["status"], "failed")
                self.assertIn("RuntimeError", job["error"])

                asyncio.run(main._run_custom_canvas_generation_job(
                    {"id": "creator-a", "role": "editor"},
                    "job-failed",
                    "job-failed",
                    "generate",
                    request,
                ))
                self.assertEqual(provider.await_count, 1)

    def test_transform_worker_persists_stable_output_and_never_replays_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_canvas_store(tmp)
            request = main.CustomCanvasTransformReq(
                image="data:image/png;base64,c291cmNl",
                prompt="只修改副标题",
                size="1920x1080",
                idempotencyKey="job-transform",
            )
            fingerprint = hashlib.sha256(
                f"transform:{main._quota_request_fingerprint(request)}".encode("utf-8")
            ).hexdigest()
            store.create_custom_canvas_generation_job(
                "creator-a",
                "job-transform",
                fingerprint,
                source_project_id="project-transform",
            )
            transformed = {
                "image": {
                    "dataUrl": "data:image/png;base64,dHJhbnNmb3JtZWQ=",
                    "width": 1920,
                    "height": 1080,
                    "generationReceipt": "transform-receipt",
                },
                "billing": {"status": "settled"},
                "dailyQuota": {"remaining": 9},
            }
            stable = {
                "url": "/api/custom-canvas/blobs/" + "c" * 64,
                "contentHash": "c" * 64,
            }
            provider = AsyncMock(return_value=transformed)
            with patch.object(main, "store", store), patch.object(
                main,
                "_custom_canvas_transform_result",
                new=provider,
            ), patch.object(store, "save_custom_canvas_blob", return_value=stable):
                asyncio.run(main._run_custom_canvas_generation_job(
                    {"id": "creator-a", "role": "editor"},
                    "job-transform",
                    "job-transform",
                    "transform",
                    request,
                ))
                job = store.get_custom_canvas_generation_job("creator-a", "job-transform")
                self.assertEqual(job["status"], "succeeded")
                self.assertEqual(job["images"][0]["dataUrl"], stable["url"])
                self.assertEqual(job["images"][0]["assetUrl"], stable["url"])
                self.assertEqual(job["images"][0]["width"], 1920)
                self.assertEqual(provider.await_count, 1)

                asyncio.run(main._run_custom_canvas_generation_job(
                    {"id": "creator-a", "role": "editor"},
                    "job-transform",
                    "job-transform",
                    "transform",
                    request,
                ))
                self.assertEqual(provider.await_count, 1)


if __name__ == "__main__":
    unittest.main()
