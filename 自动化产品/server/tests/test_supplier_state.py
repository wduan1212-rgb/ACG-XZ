import tempfile
import unittest

from test_store_tombstone import load_isolated_store


class SupplierStateTest(unittest.TestCase):
    def test_parent_receives_account_avatar_and_original_creation_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("accounts", [{
                "id": "account-1",
                "name": "测试账号",
                "platform": "视频号",
                "mode": "视频",
                "avatarAssetId": "avatar-1",
                "updatedAt": 100,
            }])
            store.upsert_docs("productions", [{
                "id": "production-1",
                "accountId": "account-1",
                "stage": "delivered",
                "createdAt": 123456,
                "updatedAt": 200,
            }])
            store.upsert_docs("assets", [{
                "id": "avatar-1",
                "accountId": "account-1",
                "type": "图片",
                "name": "账号头像",
                "createdAt": 100,
                "updatedAt": 100,
            }, {
                "id": "delivery-1",
                "accountId": "account-1",
                "productionId": "production-1",
                "type": "视频",
                "name": "交付成片",
                "delivered": True,
                "createdAt": 300,
                "updatedAt": 300,
            }])

            snapshot = store.state_for("supplier-parent", "supplier_parent")
            assets = {item["id"]: item for item in snapshot["assets"]}

            self.assertIn("avatar-1", assets)
            self.assertEqual(assets["delivery-1"]["sourceCreatedAt"], 123456)


if __name__ == "__main__":
    unittest.main()
