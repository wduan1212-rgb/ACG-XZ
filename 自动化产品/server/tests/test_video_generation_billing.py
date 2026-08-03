import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from server import main, store


class VideoGenerationBillingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "video-billing.sqlite"
        store._initialized = False
        self.user_row = store.add_member(
            "订阅用户", "video-billing-user", "123456", "user",
        )
        self.other_row = store.add_member(
            "其他用户", "video-billing-other", "123456", "user",
        )
        activated, error = store.activate_personal_subscription_plan(
            self.user_row[0], "personal-pro", activated_by="test",
        )
        self.assertIsNone(error)
        self.assertIsNotNone(activated)
        self.member = store.member_public(store.get_member(self.user_row[0]))
        self.other = store.member_public(store.get_member(self.other_row[0]))

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    @staticmethod
    def _request(model="seedance-2.0", duration=15):
        return main.VideoSubmitReq(
            prompt="生成一条测试视频", model=model, duration=duration,
        )

    def _submit(self, key, provider_ref, *, model="seedance-2.0", duration=15):
        upstream = AsyncMock(return_value={
            "ok": True,
            "provider": "seedance",
            "providerRef": provider_ref,
        })
        with patch.object(main, "_video_submit_upstream", upstream):
            response = asyncio.run(main.video_submit(
                self._request(model=model, duration=duration),
                idempotency_key=key,
                _me=self.member,
            ))
        return response, upstream

    def test_pricing_uses_published_per_minute_rates(self):
        fast = main._video_generation_billing_spec(
            self._request(model="seedance-fast", duration=15),
        )
        standard = main._video_generation_billing_spec(
            self._request(model="seedance-2.0", duration=15),
        )
        self.assertEqual(240, fast["points"])
        self.assertEqual(300, standard["points"])
        self.assertEqual(960, fast["ratePerMinute"])
        self.assertEqual(1200, standard["ratePerMinute"])

    def test_submit_reserves_idempotently_and_success_poll_settles(self):
        response, upstream = self._submit("success-key", "provider-success")
        self.assertEqual(300, response["billing"]["requestedPoints"])
        quota = store.generation_quota(self.user_row[0])
        self.assertEqual(300, quota["reserved"])
        self.assertEqual(0, quota["used"])

        with patch.object(main, "_video_submit_upstream", AsyncMock()) as replay:
            repeated = asyncio.run(main.video_submit(
                self._request(), idempotency_key="success-key", _me=self.member,
            ))
        self.assertEqual(response, repeated)
        self.assertEqual(1, upstream.await_count)
        replay.assert_not_awaited()

        with patch.object(main, "_video_poll_upstream", AsyncMock(return_value={
            "ok": True,
            "status": "succeeded",
            "progress": 100,
            "output": {"url": "/generated/video.mp4"},
            "error": None,
        })):
            completed = asyncio.run(main.video_poll(
                "provider-success", _me=self.member,
            ))
        self.assertEqual("settled", completed["billing"]["status"])
        self.assertEqual(300, completed["billing"]["deductedPoints"])
        quota = store.generation_quota(self.user_row[0])
        self.assertEqual(0, quota["reserved"])
        self.assertEqual(300, quota["used"])

        # Terminal polling is served from SQLite after a process-style re-init.
        store._initialized = False
        replayed = asyncio.run(main.video_poll(
            "provider-success", _me=self.member,
        ))
        self.assertEqual(completed, replayed)

    def test_failure_and_cancel_release_points_without_cross_member_access(self):
        self._submit("failed-key", "provider-failed")
        with patch.object(main, "_video_poll_upstream", AsyncMock(return_value={
            "ok": True,
            "status": "failed",
            "progress": 0,
            "output": None,
            "error": "上游失败",
        })):
            failed = asyncio.run(main.video_poll(
                "provider-failed", _me=self.member,
            ))
        self.assertEqual("released", failed["billing"]["status"])
        self.assertEqual(0, store.generation_quota(self.user_row[0])["reserved"])

        self._submit("cancel-key", "provider-cancel")
        with self.assertRaises(HTTPException) as hidden:
            asyncio.run(main.video_cancel("provider-cancel", _me=self.other))
        self.assertEqual(404, hidden.exception.status_code)
        with self.assertRaises(HTTPException) as hidden_poll:
            asyncio.run(main.video_poll("provider-cancel", _me=self.other))
        self.assertEqual(404, hidden_poll.exception.status_code)

        cancel_upstream = AsyncMock(return_value={"ok": True})
        with patch.object(main, "_video_cancel_upstream", cancel_upstream):
            cancelled = asyncio.run(main.video_cancel(
                "provider-cancel", _me=self.member,
            ))
        self.assertEqual("cancelled", cancelled["status"])
        self.assertEqual("released", cancelled["billing"]["status"])
        repeated = asyncio.run(main.video_cancel(
            "provider-cancel", _me=self.member,
        ))
        self.assertTrue(repeated["reused"])
        self.assertEqual(1, cancel_upstream.await_count)

    def test_provider_cancel_failure_keeps_reservation_and_daily_user_is_guarded(self):
        self._submit("cancel-error", "provider-cancel-error")
        with patch.object(
            main,
            "_video_cancel_upstream",
            AsyncMock(side_effect=HTTPException(502, "取消失败")),
        ):
            with self.assertRaises(HTTPException):
                asyncio.run(main.video_cancel(
                    "provider-cancel-error", _me=self.member,
                ))
        self.assertEqual(300, store.generation_quota(self.user_row[0])["reserved"])

        ordinary = store.member_public(store.get_member(self.other_row[0]))
        upstream = AsyncMock()
        with patch.object(main, "_video_submit_upstream", upstream):
            with self.assertRaises(HTTPException) as insufficient:
                asyncio.run(main.video_submit(
                    self._request(duration=4),
                    idempotency_key="ordinary-standard",
                    _me=ordinary,
                ))
        self.assertEqual(402, insufficient.exception.status_code)
        upstream.assert_not_awaited()
        quota = store.generation_quota(self.other_row[0])
        self.assertEqual(70, quota["remaining"])
        self.assertEqual(0, quota["reserved"])

        affordable_upstream = AsyncMock(return_value={
            "ok": True,
            "provider": "seedance",
            "providerRef": "provider-daily-fast",
        })
        with patch.object(main, "_video_submit_upstream", affordable_upstream):
            affordable = asyncio.run(main.video_submit(
                self._request(model="seedance-fast", duration=4),
                idempotency_key="ordinary-fast",
                _me=ordinary,
            ))
        self.assertEqual(64, affordable["billing"]["requestedPoints"])
        self.assertEqual(64, store.generation_quota(self.other_row[0])["reserved"])
        with patch.object(
            main, "_video_cancel_upstream", AsyncMock(return_value={"ok": True}),
        ):
            asyncio.run(main.video_cancel(
                "provider-daily-fast", _me=ordinary,
            ))
        quota = store.generation_quota(self.other_row[0])
        self.assertEqual(70, quota["remaining"])
        self.assertEqual(0, quota["reserved"])

    def test_acg_internal_team_bypasses_wallet_exactly(self):
        acg_row = store.add_member(
            "ACG 创作者", "video-billing-acg", "123456", "editor",
            team_id=store.INTERNAL_TEAM_ID, team_role="creator",
        )
        acg = store.member_public(store.get_member(acg_row[0]))
        upstream = AsyncMock(return_value={
            "ok": True,
            "provider": "seedance",
            "providerRef": "provider-acg",
        })
        with patch.object(main, "_video_submit_upstream", upstream):
            submitted = asyncio.run(main.video_submit(
                self._request(), idempotency_key="acg-key", _me=acg,
            ))
        self.assertTrue(submitted["billing"]["bypassed"])
        with patch.object(main, "_video_poll_upstream", AsyncMock(return_value={
            "ok": True, "status": "succeeded", "progress": 100,
            "output": {"url": "/generated/acg.mp4"}, "error": None,
        })):
            completed = asyncio.run(main.video_poll(
                "provider-acg", _me=acg,
            ))
        self.assertTrue(completed["billing"]["bypassed"])
        self.assertEqual(0, completed["billing"]["deductedPoints"])

    def test_stale_unsubmitted_task_is_recovered_after_restart(self):
        spec = main._video_generation_billing_spec(self._request())
        task, error, created = store.create_video_generation_billing_task(
            self.user_row[0], "video.submit:stale-key", "stale-fingerprint",
            spec["points"], spec["feature"], spec["model"],
            spec["durationSeconds"], now_ms=0,
        )
        self.assertIsNone(error)
        self.assertTrue(created)
        reserved, error = store.reserve_generation_points(
            self.user_row[0], spec["points"], spec["feature"],
            "video.submit.stale", request_fingerprint="stale-fingerprint",
        )
        self.assertIsNone(error)
        task, error = store.attach_video_generation_reservation(
            task["id"], self.user_row[0], reserved["reservationId"],
            main._quota_billing_public(reserved), now_ms=0,
        )
        self.assertIsNone(error)
        main._recover_stale_video_billing_tasks()
        recovered = store.get_video_generation_billing_task(
            self.user_row[0], task_id=task["id"],
        )
        self.assertEqual("interrupted", recovered["status"])
        self.assertEqual("released", recovered["billing"]["status"])
        self.assertEqual(0, store.generation_quota(self.user_row[0])["reserved"])


if __name__ == "__main__":
    unittest.main()
