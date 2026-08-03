import sys
import tempfile
import unittest
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR.parent))

from server import main, store


class StaticVideoBillingTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "static-video-billing.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.user = store.add_member(
            "静态视频普通用户", "static-video-user", "123456", "user",
        )
        self.member = store.member_public(self.user)

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _source(self, reservation, status, total_points=0):
        return {
            "id": "static-project-test",
            "status": status,
            "billing": {
                "reservationId": str(reservation.get("reservationId") or ""),
                "ownerId": self.member["id"],
                "pointLimit": int(reservation.get("points") or 0),
                "bypassed": bool(reservation.get("bypassed")),
                "status": "ready-to-settle",
            },
            "billingUsage": {
                "sceneImageCount": 4,
                "continuityImageCount": 2,
                "imageCount": 6,
                "imagePoints": 30,
                "ttsChars": 88,
                "ttsPoints": max(0, int(total_points) - 30),
                "totalPoints": int(total_points),
            },
        }

    def test_daily_static_success_settles_actual_usage_once(self):
        reservation, error = store.reserve_generation_points(
            self.user[0], 70, "静态视频图片与口播", "static:daily-success",
        )
        self.assertIsNone(error)
        self.assertEqual(70, reservation["quota"]["reserved"])

        source = self._source(reservation, "succeeded", total_points=32)
        main._reconcile_static_video_billing(self.member, source)
        self.assertEqual("settled", source["billing"]["status"])
        self.assertEqual(32, source["billing"]["settlement"]["deductedPoints"])
        quota = store.generation_quota(self.user[0])
        self.assertEqual(32, quota["used"])
        self.assertEqual(0, quota["reserved"])
        self.assertEqual(38, quota["remaining"])

        # Repeated project polling must not charge the same terminal task twice.
        main._reconcile_static_video_billing(self.member, source)
        self.assertEqual(32, store.generation_quota(self.user[0])["used"])

    def test_daily_static_failure_releases_the_full_freeze(self):
        reservation, error = store.reserve_generation_points(
            self.user[0], 70, "静态视频图片与口播", "static:daily-failure",
        )
        self.assertIsNone(error)
        source = self._source(reservation, "failed", total_points=17)
        main._reconcile_static_video_billing(self.member, source)
        self.assertEqual("released", source["billing"]["status"])
        quota = store.generation_quota(self.user[0])
        self.assertEqual(0, quota["used"])
        self.assertEqual(0, quota["reserved"])
        self.assertEqual(70, quota["remaining"])

    def test_subscription_static_success_uses_actual_points(self):
        quota, error = store.activate_personal_subscription_plan(
            self.user[0], "personal-pro", activated_by="verified-test-order",
        )
        self.assertIsNone(error)
        self.assertEqual(2200, quota["remaining"])
        reservation, error = store.reserve_generation_points(
            self.user[0], 200, "静态视频图片与口播", "static:subscription",
        )
        self.assertIsNone(error)
        settled, error = store.settle_generation_points(
            self.user[0], reservation["reservationId"], consumed_points=46,
        )
        self.assertIsNone(error)
        self.assertEqual(46, settled["deducted"])
        self.assertEqual(46, settled["chargedPoints"])
        self.assertEqual(200, settled["reservedPoints"])
        self.assertEqual(46, settled["quota"]["used"])
        self.assertEqual(2154, settled["quota"]["remaining"])

    def test_invalid_actual_usage_does_not_consume_or_release_reservation(self):
        reservation, error = store.reserve_generation_points(
            self.user[0], 40, "静态视频图片与口播", "static:invalid-usage",
        )
        self.assertIsNone(error)
        result, error = store.settle_generation_points(
            self.user[0], reservation["reservationId"], consumed_points=41,
        )
        self.assertEqual("invalid_consumed_points", error)
        self.assertEqual(40, result["reserved"])
        self.assertEqual(0, result["used"])
        store.release_generation_points(self.user[0], reservation["reservationId"])

    def test_internal_acg_static_generation_remains_unlimited(self):
        acg = store.add_member(
            "静态视频 ACG 成员",
            "static-video-acg-member",
            "123456",
            "editor",
            team_id=store.INTERNAL_TEAM_ID,
            team_role="creator",
        )
        member = store.member_public(acg)
        reservation, error = store.reserve_generation_points(
            acg[0], 200, "静态视频图片与口播", "static:acg-unlimited",
        )
        self.assertIsNone(error)
        self.assertTrue(reservation["bypassed"])
        source = {
            "id": "static-project-acg",
            "status": "succeeded",
            "billing": {
                "reservationId": "",
                "ownerId": acg[0],
                "pointLimit": 200,
                "bypassed": True,
                "status": "ready-to-settle",
            },
            "billingUsage": {"totalPoints": 87},
        }
        main._reconcile_static_video_billing(member, source)
        self.assertEqual("bypassed", source["billing"]["status"])
        self.assertEqual(0, source["billing"]["settlement"]["deductedPoints"])
        self.assertEqual("unlimited", store.generation_quota(acg[0])["type"])


if __name__ == "__main__":
    unittest.main()
