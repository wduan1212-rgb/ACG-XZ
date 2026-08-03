import asyncio
import base64
import sqlite3
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR.parent))

from server import main, store


PNG_DATA_URL = "data:image/png;base64," + base64.b64encode(
    b"\x89PNG\r\n\x1a\nquota-test"
).decode("ascii")


class PersonalQuotaReservationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "quota.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.user = store.add_member("个人用户", "quota-user", "123456", "user")
        self.member = store.member_public(self.user)

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def test_atomic_reserve_settle_and_idempotent_replay(self):
        reserved, error = store.reserve_personal_daily_points(
            self.user[0], 50, "图片生成", "image:first",
        )
        self.assertIsNone(error)
        self.assertEqual("active", reserved["status"])
        self.assertEqual(50, reserved["quota"]["reserved"])
        self.assertEqual(20, reserved["quota"]["remaining"])

        repeated, error = store.reserve_personal_daily_points(
            self.user[0], 50, "图片生成", "image:first",
        )
        self.assertIsNone(error)
        self.assertTrue(repeated["reused"])
        self.assertEqual(reserved["reservationId"], repeated["reservationId"])

        rejected, error = store.reserve_personal_daily_points(
            self.user[0], 25, "图片生成", "image:second",
        )
        self.assertEqual("insufficient_points", error)
        self.assertEqual(20, rejected["remaining"])

        settled, error = store.settle_personal_daily_points(
            self.user[0], reserved["reservationId"],
        )
        self.assertIsNone(error)
        self.assertEqual("settled", settled["status"])
        self.assertEqual(50, settled["deducted"])
        self.assertEqual(50, settled["quota"]["used"])
        self.assertEqual(0, settled["quota"]["reserved"])

        replay, error = store.settle_personal_daily_points(
            self.user[0], reserved["reservationId"],
        )
        self.assertIsNone(error)
        self.assertTrue(replay["reused"])
        self.assertEqual(0, replay["deducted"])
        self.assertEqual(50, replay["quota"]["used"])

        conn = sqlite3.connect(store.DB_PATH)
        try:
            count = conn.execute(
                "SELECT COUNT(*) FROM personal_daily_quota_events WHERE member_id=?",
                (self.user[0],),
            ).fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(1, count)

    def test_release_is_idempotent_and_same_key_can_retry_after_failure(self):
        reserved, error = store.reserve_personal_daily_points(
            self.user[0], 30, "语音生成", "tts:retry",
        )
        self.assertIsNone(error)
        released, error = store.release_personal_daily_points(
            self.user[0], reserved["reservationId"],
        )
        self.assertIsNone(error)
        self.assertEqual("released", released["status"])
        self.assertEqual(70, released["quota"]["remaining"])

        repeated, error = store.release_personal_daily_points(
            self.user[0], reserved["reservationId"],
        )
        self.assertIsNone(error)
        self.assertTrue(repeated["reused"])

        retried, error = store.reserve_personal_daily_points(
            self.user[0], 30, "语音生成", "tts:retry",
        )
        self.assertIsNone(error)
        self.assertTrue(retried["retried"])
        self.assertEqual("active", retried["status"])
        self.assertEqual(40, retried["quota"]["remaining"])

    def test_released_key_cannot_be_reused_for_a_different_request(self):
        reserved, error = store.reserve_personal_daily_points(
            self.user[0],
            5,
            "图片生成",
            "image:bound-request",
            request_fingerprint="request-a",
        )
        self.assertIsNone(error)
        store.release_personal_daily_points(self.user[0], reserved["reservationId"])

        repeated, error = store.reserve_personal_daily_points(
            self.user[0],
            5,
            "图片生成",
            "image:bound-request",
            request_fingerprint="request-b",
        )
        self.assertIsNone(repeated)
        self.assertEqual("idempotency_conflict", error)

    def test_canvas_receipt_points_must_equal_the_reserved_total(self):
        reserved, error = store.reserve_personal_daily_points(
            self.user[0], 10, "无限画布图片生成", "canvas:receipt-total",
        )
        self.assertIsNone(error)
        result, error = store.settle_personal_daily_points(
            self.user[0],
            reserved["reservationId"],
            canvas_receipts=[{
                "dataUrl": PNG_DATA_URL,
                "points": 5,
                "feature": "无限画布图片生成",
            }],
        )
        self.assertEqual("receipt_points_mismatch", error)
        self.assertEqual(10, result["reserved"])
        self.assertEqual(0, result["used"])
        store.release_personal_daily_points(self.user[0], reserved["reservationId"])

    def test_concurrent_reservations_cannot_overspend_daily_limit(self):
        def reserve(index):
            return store.reserve_personal_daily_points(
                self.user[0], 20, "并发生图", f"parallel:{index}",
            )

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(reserve, range(4)))
        accepted = [item for item, error in results if error is None]
        errors = [error for _item, error in results if error]
        self.assertEqual(3, len(accepted))
        self.assertEqual(["insufficient_points"], errors)
        quota = store.personal_daily_quota(self.user[0])
        self.assertEqual(60, quota["reserved"])
        self.assertEqual(10, quota["remaining"])

    def test_next_china_day_gets_a_fresh_non_accumulating_grant(self):
        reserved, error = store.reserve_personal_daily_points(
            self.user[0], 60, "跨日测试", "day-one", now_ms=0,
        )
        self.assertIsNone(error)
        self.assertEqual(10, reserved["quota"]["remaining"])

        next_day = store.personal_daily_quota(
            self.user[0], now_ms=24 * 60 * 60 * 1000,
        )
        self.assertNotEqual(reserved["quotaDay"], next_day["day"])
        self.assertEqual(70, next_day["remaining"])
        self.assertEqual(0, next_day["reserved"])
        self.assertTrue(next_day["nonAccumulating"])

    def test_china_midnight_resets_at_utc_sixteen_without_carrying_points(self):
        before_midnight = int(datetime(
            2026, 8, 1, 15, 59, 59, tzinfo=timezone.utc,
        ).timestamp() * 1000)
        at_midnight = int(datetime(
            2026, 8, 1, 16, 0, 0, tzinfo=timezone.utc,
        ).timestamp() * 1000)
        reserved, error = store.reserve_personal_daily_points(
            self.user[0], 65, "中国时区跨日", "china-day-one",
            now_ms=before_midnight,
        )
        self.assertIsNone(error)
        self.assertEqual("2026-08-01", reserved["quotaDay"])
        self.assertEqual(5, reserved["quota"]["remaining"])
        self.assertEqual(at_midnight, reserved["quota"]["resetAt"])

        fresh = store.personal_daily_quota(self.user[0], now_ms=at_midnight)
        self.assertEqual("2026-08-02", fresh["day"])
        self.assertEqual(70, fresh["remaining"])
        self.assertEqual(0, fresh["used"])
        self.assertEqual(0, fresh["reserved"])

    def test_timeout_releases_reserved_points(self):
        async def timed_out():
            await asyncio.wait_for(asyncio.sleep(1), timeout=0.001)

        async def run():
            return await main._run_personal_billable(
                self.member,
                points=5,
                feature="超时生图",
                namespace="test.timeout",
                idempotency_key="timeout-release",
                request_fingerprint="timeout-request",
                operation=timed_out,
            )

        with self.assertRaises(asyncio.TimeoutError):
            asyncio.run(run())
        quota = store.personal_daily_quota(self.user[0])
        self.assertEqual(0, quota["reserved"])
        self.assertEqual(0, quota["used"])
        self.assertEqual(70, quota["remaining"])

    def test_acg_team_account_bypasses_personal_wallet(self):
        team_member = store.add_member(
            "ACG 成员",
            "acg-quota-member",
            "123456",
            "editor",
            team_id=store.INTERNAL_TEAM_ID,
            team_role="creator",
        )
        reserved, error = store.reserve_personal_daily_points(
            team_member[0], 70, "图片生成", "team:bypass",
        )
        self.assertIsNone(reserved)
        self.assertEqual("not_personal_user", error)
        self.assertIsNone(store.personal_daily_quota(team_member[0]))

        personal_role_team_member = store.add_member(
            "团队内个人角色",
            "team-user-role",
            "123456",
            "user",
            team_id=store.INTERNAL_TEAM_ID,
            team_role="creator",
        )
        reserved, error = store.reserve_personal_daily_points(
            personal_role_team_member[0], 70, "图片生成", "team:user-bypass",
        )
        self.assertIsNone(reserved)
        self.assertEqual("not_personal_user", error)
        self.assertIsNone(store.personal_daily_quota(personal_role_team_member[0]))

    def test_cancelled_operation_releases_freeze(self):
        async def cancelled():
            raise asyncio.CancelledError()

        async def run():
            return await main._run_personal_billable(
                self.member,
                points=5,
                feature="取消生图",
                namespace="test.cancel",
                idempotency_key="cancelled",
                request_fingerprint="cancelled-request",
                operation=cancelled,
            )

        with self.assertRaises(asyncio.CancelledError):
            asyncio.run(run())
        quota = store.personal_daily_quota(self.user[0])
        self.assertEqual(0, quota["reserved"])
        self.assertEqual(0, quota["used"])
        self.assertEqual(70, quota["remaining"])


class SubscriptionQuotaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "subscription-quota.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.user = store.add_member(
            "订阅个人用户", "subscription-user", "123456", "user",
        )
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _customer_team(self, plan="team"):
        owner = store.add_member(
            "外部团队所有者", f"external-owner-{plan}", "123456", "user",
        )
        activated, error = store.activate_customer_team_plan(
            owner[0], f"外部测试团队-{plan}", plan=plan,
        )
        self.assertIsNone(error)
        member = store.add_member(
            "外部团队成员",
            f"external-member-{plan}",
            "123456",
            "editor",
            team_id=activated["teamId"],
            team_role="creator",
            added_by=owner[0],
        )
        return owner, member, activated["teamId"]

    def test_personal_plan_limits_upgrade_and_monthly_reset_do_not_accumulate(self):
        august = int(datetime(
            2026, 8, 2, 0, 0, tzinfo=timezone.utc,
        ).timestamp() * 1000)
        september = int(datetime(
            2026, 9, 2, 0, 0, tzinfo=timezone.utc,
        ).timestamp() * 1000)
        quota, error = store.activate_personal_subscription_plan(
            self.user[0], "personal-pro", activated_by="verified-order-1",
            now_ms=august,
        )
        self.assertIsNone(error)
        self.assertEqual(2200, quota["limit"])

        reservation, error = store.reserve_generation_points(
            self.user[0], 200, "订阅图片", "personal-plan-use",
            now_ms=august,
        )
        self.assertIsNone(error)
        settled, error = store.settle_generation_points(
            self.user[0], reservation["reservationId"], now_ms=august,
        )
        self.assertIsNone(error)
        self.assertEqual(200, settled["quota"]["used"])

        upgraded, error = store.activate_personal_subscription_plan(
            self.user[0], "personal-advanced", activated_by="verified-order-2",
            now_ms=august,
        )
        self.assertIsNone(error)
        self.assertEqual(3600, upgraded["limit"])
        self.assertEqual(200, upgraded["used"])

        fresh = store.subscription_monthly_quota(
            self.user[0], now_ms=september,
        )
        self.assertEqual("2026-09", fresh["month"])
        self.assertEqual(3600, fresh["limit"])
        self.assertEqual(0, fresh["used"])
        self.assertEqual(0, fresh["purchased"])
        self.assertEqual(3600, fresh["remaining"])
        self.assertTrue(fresh["nonAccumulating"])

    def test_external_team_wallet_is_shared_and_concurrent_reserve_cannot_overdraw(self):
        owner, member, team_id = self._customer_team("team")

        def reserve(index):
            account = owner if index % 2 == 0 else member
            return store.reserve_generation_points(
                account[0], 1000, "团队并发生成", f"team-parallel:{index}",
            )

        with ThreadPoolExecutor(max_workers=10) as pool:
            results = list(pool.map(reserve, range(10)))
        accepted = [result for result, error in results if error is None]
        rejected = [error for _result, error in results if error]
        self.assertEqual(9, len(accepted))
        self.assertEqual(["insufficient_points"], rejected)
        owner_quota = store.generation_quota(owner[0])
        member_quota = store.generation_quota(member[0])
        self.assertEqual(9000, owner_quota["limit"])
        self.assertEqual(9000, owner_quota["reserved"])
        self.assertEqual(0, owner_quota["remaining"])
        self.assertEqual(owner_quota, member_quota)
        self.assertEqual({"type": "team", "id": team_id}, owner_quota["billingScope"])

        for reservation in accepted:
            released, error = store.release_generation_points(
                reservation["memberId"], reservation["reservationId"],
            )
            self.assertIsNone(error)
            self.assertEqual("released", released["status"])
        self.assertEqual(9000, store.generation_quota(owner[0])["remaining"])

    def test_only_internal_acg_is_unlimited_even_if_external_quota_mode_is_tampered(self):
        owner, _member, team_id = self._customer_team("team-pro")
        with sqlite3.connect(store.DB_PATH) as conn:
            conn.execute(
                "UPDATE teams SET quota_mode='unlimited' WHERE id=?", (team_id,),
            )
            conn.commit()
        quota = store.generation_quota(owner[0])
        self.assertEqual("subscription", quota["type"])
        self.assertEqual(20000, quota["limit"])
        rejected, error = store.reserve_generation_points(
            owner[0], 20001, "不可绕过", "external-not-unlimited",
        )
        self.assertEqual("insufficient_points", error)
        self.assertEqual(20000, rejected["remaining"])

        acg_member = store.add_member(
            "ACG 无限成员", "acg-unlimited-member", "123456", "editor",
            team_id=store.INTERNAL_TEAM_ID,
            team_role="creator",
        )
        bypassed, error = store.reserve_generation_points(
            acg_member[0], 999999, "内部团队生成", "acg-unlimited",
        )
        self.assertIsNone(error)
        self.assertTrue(bypassed["bypassed"])
        self.assertEqual("unlimited", bypassed["billingType"])

    def test_subscription_release_retry_settle_and_idempotency_are_durable(self):
        quota, error = store.activate_personal_subscription_plan(
            self.user[0], "personal-pro", activated_by="verified-order",
        )
        self.assertIsNone(error)
        self.assertEqual(2200, quota["remaining"])
        reserved, error = store.reserve_generation_points(
            self.user[0], 200, "音色设计", "subscription-retry",
            request_fingerprint="same-request",
        )
        self.assertIsNone(error)
        released, error = store.release_generation_points(
            self.user[0], reserved["reservationId"],
        )
        self.assertIsNone(error)
        self.assertEqual(2200, released["quota"]["remaining"])

        retried, error = store.reserve_generation_points(
            self.user[0], 200, "音色设计", "subscription-retry",
            request_fingerprint="same-request",
        )
        self.assertIsNone(error)
        self.assertTrue(retried["retried"])
        conflict, error = store.reserve_generation_points(
            self.user[0], 200, "音色设计", "subscription-retry",
            request_fingerprint="changed-request",
        )
        self.assertIsNone(conflict)
        self.assertEqual("idempotency_conflict", error)
        settled, error = store.settle_generation_points(
            self.user[0], retried["reservationId"],
        )
        self.assertIsNone(error)
        self.assertEqual(200, settled["deducted"])
        replay, error = store.settle_generation_points(
            self.user[0], retried["reservationId"],
        )
        self.assertIsNone(error)
        self.assertEqual(0, replay["deducted"])
        self.assertEqual(200, replay["quota"]["used"])

    def test_verified_addon_is_idempotent_and_never_activates_a_plan(self):
        no_plan, error = store.grant_subscription_addon_points(
            self.user[0], 1000, "unverified-preview-click",
        )
        self.assertIsNone(no_plan)
        self.assertEqual("subscription_required", error)
        store.activate_personal_subscription_plan(
            self.user[0], "personal-pro", activated_by="verified-order",
        )
        first, error = store.grant_subscription_addon_points(
            self.user[0], 1000, "verified-addon-order",
            activated_by="billing-worker",
        )
        self.assertIsNone(error)
        self.assertEqual(3200, first["limit"])
        repeated, error = store.grant_subscription_addon_points(
            self.user[0], 1000, "verified-addon-order",
            activated_by="billing-worker",
        )
        self.assertIsNone(error)
        self.assertTrue(repeated["reused"])
        self.assertEqual(3200, repeated["limit"])
        conflict, error = store.grant_subscription_addon_points(
            self.user[0], 5000, "verified-addon-order",
            activated_by="billing-worker",
        )
        self.assertIsNone(conflict)
        self.assertEqual("idempotency_conflict", error)

    def test_external_team_endpoint_settles_success_and_releases_provider_failure(self):
        owner, _member, team_id = self._customer_team("team")
        headers = {
            "Authorization": f"Bearer {store.make_token(owner[0])}",
        }
        observations = []

        async def success(_req, member, **_kwargs):
            observations.append(store.generation_quota(member["id"]))
            return {
                "ok": True,
                "dataUrl": PNG_DATA_URL,
                "model": "mock-image",
                "usedRefs": 0,
                "skippedRefs": 0,
                "compressedRefs": 0,
                "ratio": "1:1",
                "mode": "images",
            }

        with patch.object(main, "_image_generate_impl", side_effect=success):
            response = self.client.post(
                "/api/image/generate",
                json={"prompt": "外部团队生图", "idempotencyKey": "team-image-ok"},
                headers=headers,
            )
        self.assertEqual(200, response.status_code, response.text)
        billing = response.json()["billing"]
        self.assertFalse(billing["bypassed"])
        self.assertEqual("subscription", billing["billingType"])
        self.assertEqual({"type": "team", "id": team_id}, billing["billingScope"])
        self.assertEqual(5, billing["deductedPoints"])
        self.assertEqual(5, observations[0]["reserved"])

        async def failure(_req, _member, **_kwargs):
            raise HTTPException(502, "mock provider failed")

        with patch.object(main, "_image_generate_impl", side_effect=failure):
            failed = self.client.post(
                "/api/image/generate",
                json={"prompt": "失败不扣点", "idempotencyKey": "team-image-fail"},
                headers=headers,
            )
        self.assertEqual(502, failed.status_code)
        quota = store.generation_quota(owner[0])
        self.assertEqual(5, quota["used"])
        self.assertEqual(0, quota["reserved"])


class PersonalQuotaEndpointTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "quota-api.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.user = store.add_member("接口用户", "quota-api-user", "123456", "user")
        self.headers = {"Authorization": f"Bearer {store.make_token(self.user[0])}"}
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def test_main_image_reserves_before_call_settles_success_and_blocks_replay(self):
        observations = []

        async def generated(_req, member, **_kwargs):
            observations.append(store.personal_daily_quota(member["id"]))
            return {
                "ok": True,
                "dataUrl": PNG_DATA_URL,
                "model": "mock-image",
                "usedRefs": 0,
                "skippedRefs": 0,
                "compressedRefs": 0,
                "ratio": "1:1",
                "mode": "images",
            }

        headers = {**self.headers, "Idempotency-Key": "same-image"}
        with patch.object(main, "_image_generate_impl", side_effect=generated) as mocked:
            first = self.client.post(
                "/api/image/generate", json={"prompt": "生成测试图"}, headers=headers,
            )
            replay = self.client.post(
                "/api/image/generate", json={"prompt": "生成测试图"}, headers=headers,
            )
        self.assertEqual(200, first.status_code, first.text)
        self.assertEqual(409, replay.status_code)
        self.assertEqual(1, mocked.call_count)
        self.assertEqual(main.IMAGE_GENERATION_POINTS, observations[0]["reserved"])
        self.assertEqual(0, observations[0]["used"])
        self.assertEqual(main.IMAGE_GENERATION_POINTS, first.json()["dailyQuota"]["used"])
        self.assertEqual("settled", first.json()["billing"]["status"])

    def test_main_image_failure_releases_without_charging(self):
        async def failed(_req, _member, **_kwargs):
            raise HTTPException(502, "mock provider failed")

        with patch.object(main, "_image_generate_impl", side_effect=failed):
            response = self.client.post(
                "/api/image/generate",
                json={"prompt": "失败生图", "idempotencyKey": "failed-image"},
                headers=self.headers,
            )
        self.assertEqual(502, response.status_code)
        quota = store.personal_daily_quota(self.user[0])
        self.assertEqual(0, quota["reserved"])
        self.assertEqual(0, quota["used"])

    def test_insufficient_points_rejects_before_provider_call(self):
        quota, error = store.deduct_personal_daily_points(
            self.user[0], 70, "测试用尽", "fill-daily-wallet",
        )
        self.assertIsNone(error)
        self.assertEqual(0, quota["remaining"])
        mocked = AsyncMock(return_value={"ok": True, "dataUrl": PNG_DATA_URL})
        with patch.object(main, "_image_generate_impl", new=mocked):
            response = self.client.post(
                "/api/image/generate",
                json={"prompt": "不应调用上游", "idempotencyKey": "no-balance"},
                headers=self.headers,
            )
        self.assertEqual(402, response.status_code)
        mocked.assert_not_awaited()

    def test_personal_generation_requires_key_and_binds_it_to_request(self):
        mocked = AsyncMock(side_effect=HTTPException(502, "mock provider failed"))
        with patch.object(main, "_image_generate_impl", new=mocked):
            missing = self.client.post(
                "/api/image/generate",
                json={"prompt": "没有幂等键"},
                headers=self.headers,
            )
            first = self.client.post(
                "/api/image/generate",
                json={"prompt": "原请求", "idempotencyKey": "bound-image"},
                headers=self.headers,
            )
            changed = self.client.post(
                "/api/image/generate",
                json={"prompt": "换了内容", "idempotencyKey": "bound-image"},
                headers=self.headers,
            )
        self.assertEqual(400, missing.status_code)
        self.assertEqual(502, first.status_code)
        self.assertEqual(409, changed.status_code)
        self.assertEqual(1, mocked.await_count)
        quota = store.personal_daily_quota(self.user[0])
        self.assertEqual(0, quota["reserved"])
        self.assertEqual(0, quota["used"])

    def test_tts_uses_character_rate_and_voice_design_uses_fixed_rate(self):
        quota, error = store.activate_personal_subscription_plan(
            self.user[0], "personal-pro", activated_by="test-entitlement",
        )
        self.assertIsNone(error)
        self.assertEqual(2200, quota["limit"])
        tts_result = {
            "ok": True,
            "audioDataUrl": "data:audio/mp3;base64,dGVzdA==",
            "voiceId": "mock",
            "model": "mock-tts",
            "durationMs": 1000,
            "duration": 1,
            "traceId": "trace",
            "fallbackVoice": False,
        }
        design_result = {
            "ok": True,
            "provider": "minimax",
            "voiceId": "designed",
            "name": "designed",
            "audioDataUrl": "",
            "model": "mock-tts",
            "traceId": "trace-design",
        }
        with patch.object(main, "_tts_generate_impl", new=AsyncMock(return_value=tts_result)), patch.object(
            main, "_tts_voice_design_impl", new=AsyncMock(return_value=design_result),
        ):
            tts = self.client.post(
                "/api/tts/generate",
                json={"text": "字" * 201, "idempotencyKey": "tts-201"},
                headers=self.headers,
            )
            design = self.client.post(
                "/api/tts/voice/design",
                json={"prompt": "温暖女声", "idempotencyKey": "voice-design"},
                headers=self.headers,
            )
        self.assertEqual(200, tts.status_code, tts.text)
        self.assertEqual(200, design.status_code, design.text)
        self.assertEqual(2, main.TTS_POINTS_PER_100_CHARS)
        self.assertEqual(6, tts.json()["billing"]["deductedPoints"])
        self.assertEqual(main.VOICE_DESIGN_POINTS, design.json()["billing"]["deductedPoints"])
        self.assertEqual(
            6 + main.VOICE_DESIGN_POINTS,
            store.subscription_monthly_quota(self.user[0])["used"],
        )

    def test_canvas_multi_image_settles_before_blob_put_and_put_is_zero_charge(self):
        async def generated(_prompt, _size, _refs, **_kwargs):
            return {
                "dataUrl": PNG_DATA_URL,
                "width": 1024,
                "height": 1024,
                "usedRefs": 0,
                "skippedRefs": 0,
                "model": "mock-canvas",
                "mode": "images",
            }

        with patch.object(main, "_custom_canvas_generated_image", side_effect=generated):
            response = self.client.post(
                "/api/custom-canvas/generate",
                json={
                    "prompt": "两张测试图",
                    "count": 2,
                    "size": "1024x1024",
                    "idempotencyKey": "canvas-two",
                },
                headers=self.headers,
            )
        self.assertEqual(200, response.status_code, response.text)
        data = response.json()
        self.assertEqual(2, len(data["images"]))
        self.assertEqual(10, data["billing"]["deductedPoints"])
        self.assertEqual(10, store.personal_daily_quota(self.user[0])["used"])

        image = data["images"][0]
        payload = {
            "dataUrl": image["dataUrl"],
            "outputId": "canvas-output-1",
            "generationReceipt": image["generationReceipt"],
        }
        first_put = self.client.post(
            "/api/custom-canvas/blobs", json=payload, headers=self.headers,
        )
        second_put = self.client.post(
            "/api/custom-canvas/blobs", json=payload, headers=self.headers,
        )
        self.assertEqual(200, first_put.status_code, first_put.text)
        self.assertEqual(200, second_put.status_code, second_put.text)
        self.assertEqual(0, first_put.json()["billing"]["deductedPoints"])
        self.assertTrue(first_put.json()["billing"]["settledAtGeneration"])
        self.assertEqual(10, store.personal_daily_quota(self.user[0])["used"])

    def test_canvas_receipt_failure_rolls_back_settlement_and_releases(self):
        generated = {
            "dataUrl": PNG_DATA_URL,
            "width": 1024,
            "height": 1024,
            "usedRefs": 0,
            "skippedRefs": 0,
            "model": "mock-canvas",
            "mode": "images",
        }
        with patch.object(
            main, "_custom_canvas_generated_image", new=AsyncMock(return_value=generated),
        ), patch.object(
            store,
            "_insert_custom_canvas_generation_receipts_locked",
            side_effect=sqlite3.OperationalError("receipt write failed"),
        ):
            with self.assertRaises(sqlite3.OperationalError):
                self.client.post(
                    "/api/custom-canvas/generate",
                    json={
                        "prompt": "收据失败",
                        "count": 2,
                        "size": "1024x1024",
                        "idempotencyKey": "canvas-receipt-failure",
                    },
                    headers=self.headers,
                )
        quota = store.personal_daily_quota(self.user[0])
        self.assertEqual(0, quota["reserved"])
        self.assertEqual(0, quota["used"])
        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(
                0,
                conn.execute(
                    "SELECT COUNT(*) FROM custom_canvas_generation_receipts"
                ).fetchone()[0],
            )

    def test_canvas_parallel_failure_cancels_and_awaits_siblings(self):
        cancelled = []

        async def slow():
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                cancelled.append(True)
                raise

        async def failed():
            await asyncio.sleep(0)
            raise RuntimeError("one output failed")

        async def run():
            with self.assertRaises(RuntimeError):
                await main._gather_cancel_on_error([slow(), failed()])

        asyncio.run(run())
        self.assertEqual([True], cancelled)

    def test_all_canvas_image_edit_routes_share_the_safe_settlement_wrapper(self):
        generated = {
            "dataUrl": PNG_DATA_URL,
            "width": 1024,
            "height": 1024,
            "usedRefs": 1,
            "skippedRefs": 0,
            "model": "mock-canvas",
            "mode": "images",
        }
        with patch.object(
            main,
            "_custom_canvas_generated_image",
            new=AsyncMock(return_value=generated),
        ), patch.object(
            main,
            "_custom_canvas_mask_edit",
            new=AsyncMock(return_value={
                "dataUrl": PNG_DATA_URL, "width": 1024, "height": 1024,
            }),
        ):
            enhance = self.client.post(
                "/api/custom-canvas/enhance",
                json={
                    "image": PNG_DATA_URL,
                    "size": "1024x1024",
                    "idempotencyKey": "enhance-one",
                },
                headers=self.headers,
            )
            transform = self.client.post(
                "/api/custom-canvas/transform",
                json={
                    "image": PNG_DATA_URL,
                    "prompt": "保持主体，调整配色",
                    "size": "1024x1024",
                    "idempotencyKey": "transform-one",
                },
                headers=self.headers,
            )
            region = self.client.post(
                "/api/custom-canvas/edit-region",
                json={
                    "image": PNG_DATA_URL,
                    "mask": PNG_DATA_URL,
                    "instruction": "优化局部",
                    "width": 1024,
                    "height": 1024,
                    "idempotencyKey": "region-one",
                },
                headers=self.headers,
            )
        for response in (enhance, transform, region):
            self.assertEqual(200, response.status_code, response.text)
            self.assertEqual(
                main.CUSTOM_CANVAS_IMAGE_GENERATION_POINTS,
                response.json()["billing"]["deductedPoints"],
            )
        self.assertTrue(enhance.json()["images"][0]["generationReceipt"])
        self.assertTrue(transform.json()["image"]["generationReceipt"])
        self.assertTrue(region.json()["image"]["generationReceipt"])
        self.assertEqual(
            3 * main.CUSTOM_CANVAS_IMAGE_GENERATION_POINTS,
            store.personal_daily_quota(self.user[0])["used"],
        )

    def test_team_image_generation_is_explicitly_unlimited_bypass(self):
        team_member = store.add_member(
            "ACG 接口成员",
            "acg-api-member",
            "123456",
            "editor",
            team_id=store.INTERNAL_TEAM_ID,
            team_role="creator",
        )
        headers = {"Authorization": f"Bearer {store.make_token(team_member[0])}"}
        result = {
            "ok": True,
            "dataUrl": PNG_DATA_URL,
            "model": "mock-image",
            "usedRefs": 0,
            "skippedRefs": 0,
            "compressedRefs": 0,
            "ratio": "1:1",
            "mode": "images",
        }
        with patch.object(main, "_image_generate_impl", new=AsyncMock(return_value=result)):
            response = self.client.post(
                "/api/image/generate", json={"prompt": "ACG 生图"}, headers=headers,
            )
        self.assertEqual(200, response.status_code, response.text)
        self.assertTrue(response.json()["billing"]["bypassed"])
        self.assertEqual(0, response.json()["billing"]["deductedPoints"])
        self.assertIsNone(store.personal_daily_quota(team_member[0]))

    def test_main_image_adapter_reuses_provider_ref_as_idempotency_key(self):
        source = (SERVER_DIR.parent / "js" / "api" / "providers.js").read_text(
            encoding="utf-8",
        )
        image_adapter = source[source.index('id: "openai-image"'):]
        image_adapter = image_adapter[:image_adapter.index('id: "mock-tts"')]
        self.assertIn("idempotencyKey: ref", image_adapter)
        self.assertIn('generationOperationKey("tts")', source)
        self.assertIn('generationOperationKey("voice-design")', source)


if __name__ == "__main__":
    unittest.main()
