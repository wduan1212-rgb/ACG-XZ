import tempfile
import time
import unittest
from pathlib import Path

from server import store


class AccountCreationAndPublishRulesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "quota.sqlite"
        store._initialized = False

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _team_members_and_account(self):
        admin = store.get_member_by_username(store.DEFAULT_ADMIN_USERNAME)
        account = {
            "id": "shared-xhs-account",
            "name": "共享小红书账号",
            "platform": "小红书",
            "mode": "图文",
            "updatedAt": int(time.time() * 1000),
        }
        store.upsert_member_collection(admin[0], "admin", "accounts", [account])
        member = store.add_member("配额成员", "quota-member", "123456", "user")
        request, error = store.add_team_join_request(
            member[0], store.INTERNAL_TEAM_NAME, "配额并发测试"
        )
        self.assertIsNone(error)
        joined, error = store.review_team_join_request(request["id"], admin[0], True)
        self.assertIsNone(error)
        self.assertEqual("editor", joined["role"])
        return admin, member, account

    def test_daily_limit_is_shared_across_team_members_and_server_stamped(self):
        admin, member, account = self._team_members_and_account()
        yesterday = int(time.time() * 1000) - 48 * 60 * 60 * 1000
        first = {
            "id": "quota-production-1", "accountId": account["id"],
            "ownerId": admin[0], "createdAt": yesterday, "updatedAt": yesterday,
        }
        second = {
            "id": "quota-production-2", "accountId": account["id"],
            "ownerId": member[0], "createdAt": yesterday, "updatedAt": yesterday,
        }
        store.upsert_member_collection(admin[0], "admin", "productions", [first])
        store.upsert_member_collection(member[0], "editor", "productions", [second])

        quota = store.account_creation_quotas(member[0], [account["id"]])
        self.assertEqual(2, quota["items"][0]["used"])
        self.assertEqual(0, quota["items"][0]["remaining"])

        with self.assertRaises(store.AccountDailyCreationQuotaExceeded):
            store.upsert_member_collection(admin[0], "admin", "productions", [{
                "id": "quota-production-3", "accountId": account["id"],
                "ownerId": admin[0], "createdAt": yesterday, "updatedAt": yesterday,
            }])

        # Updating an existing production never consumes a second slot.
        first["title"] = "更新标题"
        first["updatedAt"] = int(time.time() * 1000) + 1000
        result = store.upsert_member_collection(admin[0], "admin", "productions", [first])
        self.assertEqual(1, result["written"])

    def test_publish_text_rules_match_platform_contract(self):
        self.assertEqual(
            "xiaohongshu_title_too_long",
            store._publish_text_rule_error(
                {"platform": "小红书"}, {"title": "标" * 21, "copy": ""}
            ),
        )
        self.assertEqual(
            "xiaohongshu_copy_too_long",
            store._publish_text_rule_error(
                {"platform": "小红书"}, {"title": "合规标题", "copy": "文" * 1001}
            ),
        )
        self.assertEqual(
            "wechat_channels_title_has_punctuation",
            store._publish_text_rule_error(
                {"platform": "视频号"}, {"title": "这是标题！", "copy": ""}
            ),
        )
        self.assertEqual(
            "wechat_channels_title_too_long",
            store._publish_text_rule_error(
                {"platform": "视频号"}, {"title": "标" * 17, "copy": ""}
            ),
        )
        self.assertIsNone(store._publish_text_rule_error(
            {"platform": "视频号"}, {"title": "十六字内无标点标题", "copy": ""}
        ))


if __name__ == "__main__":
    unittest.main()
