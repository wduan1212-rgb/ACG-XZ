import tempfile
import unittest
import importlib
import sys
from pathlib import Path

from test_store_tombstone import load_isolated_store


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
main = importlib.import_module("main")


class SupplierStateTest(unittest.TestCase):
    def test_supplier_children_request_items_are_typed_models(self):
        req = main.SupplierChildrenReq(items=[{
            "name": "子账号",
            "username": "typed_supplier_child",
            "pin": "local-test-pin",
        }])
        self.assertEqual(len(req.items), 1)
        item = req.items[0]
        payload = item.model_dump() if hasattr(item, "model_dump") else item.dict()
        self.assertEqual(payload["username"], "typed_supplier_child")

    def test_supplier_child_batch_is_atomic_and_rejects_duplicate_usernames(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            made = store.create_supplier_children("supplier-parent", [
                {"name": "子账号一", "username": "supplier_child_one", "pin": "local-test-pin"},
                {"name": "子账号二", "username": "supplier_child_two", "pin": "local-test-pin"},
            ])
            self.assertEqual(len(made), 2)

            with self.assertRaisesRegex(ValueError, "username_exists"):
                store.create_supplier_children("supplier-parent", [
                    {"name": "不应落库", "username": "supplier_child_three", "pin": "local-test-pin"},
                    {"name": "重复账号", "username": "supplier_child_one", "pin": "local-test-pin"},
                ])

            children = store.list_supplier_children("supplier-parent")
            self.assertEqual({row["username"] for row in children}, {"supplier_child_one", "supplier_child_two"})

    def test_parent_receives_account_avatar_and_original_creation_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("accounts", [{
                "id": "account-1",
                "name": "测试账号",
                "platform": "视频号",
                "mode": "视频",
                "avatarAssetId": "avatar-1",
                "homepageUrl": "https://example.com/profile",
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
            self.assertEqual(snapshot["accounts"][0]["homepageUrl"], "https://example.com/profile")

    def test_homepage_edit_is_shared_but_parent_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("accounts", [{
                "id": "account-1",
                "name": "测试账号",
                "platform": "小红书",
                "mode": "图文",
                "updatedAt": 100,
            }])

            denied, err = store.update_supplier_account_homepage(
                "account-1", "https://blocked.example", "supplier-child", "supplier_child"
            )
            self.assertIsNone(denied)
            self.assertEqual(err, "forbidden")

            updated, err = store.update_supplier_account_homepage(
                "account-1", "example.com/profile", "supplier-parent", "supplier_parent"
            )
            self.assertIsNone(err)
            self.assertEqual(updated["homepageUrl"], "https://example.com/profile")
            creator_snapshot = store.state_for("admin-1", "admin")
            supplier_snapshot = store.state_for("supplier-parent", "supplier_parent")
            self.assertEqual(creator_snapshot["accounts"][0]["homepageUrl"], updated["homepageUrl"])
            self.assertEqual(supplier_snapshot["accounts"][0]["homepageUrl"], updated["homepageUrl"])

    def test_only_supplier_download_marks_supplier_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("assets", [{
                "id": "delivery-1",
                "accountId": "account-1",
                "type": "视频",
                "name": "交付成片",
                "delivered": True,
                "status": "未下载",
                "updatedAt": 100,
            }])

            denied, err = store.mark_supplier_asset_downloaded("delivery-1", "editor-1", "editor")
            self.assertIsNone(denied)
            self.assertEqual(err, "forbidden")

            denied, err = store.mark_supplier_asset_downloaded("delivery-1", "admin-1", "admin")
            self.assertIsNone(denied)
            self.assertEqual(err, "forbidden")

            updated, err = store.mark_supplier_asset_downloaded("delivery-1", "supplier-parent", "supplier_parent")
            self.assertIsNone(err)
            self.assertEqual(updated["status"], "已下载")
            self.assertGreater(updated["supplierDownloadedAt"], 0)
            self.assertEqual(updated["supplierDownloadedBy"], "supplier-parent")

    def test_supplier_admin_can_list_and_edit_all_supplier_members(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            parent_a = store.add_member("供应商管理员甲", "supplier_parent_a", "local-test-pin", "supplier_parent")
            parent_b = store.add_member("供应商管理员乙", "supplier_parent_b", "local-test-pin", "supplier_parent")
            child = store.create_supplier_children(parent_a[0], [{
                "name": "子账号", "username": "supplier_child_editable", "pin": "local-test-pin",
            }])[0]

            visible = store.list_supplier_members()
            self.assertTrue({parent_a[0], parent_b[0], child["id"]}.issubset({row["id"] for row in visible}))
            updated = store.update_member(parent_b[0], name="管理员乙已更新", pin="new-local-test-pin")
            self.assertEqual(store.member_public(updated)["name"], "管理员乙已更新")

    def test_delivery_remarks_are_persistent_and_track_reads(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            editor = store.add_member("创作者", "remarks_editor", "local-test-pin", "editor")
            supplier = store.add_member("供应商管理员", "remarks_supplier", "local-test-pin", "supplier_parent")
            store.upsert_docs("assets", [{
                "id": "delivery-remarks-1",
                "accountId": "account-1",
                "ownerId": editor[0],
                "byMemberId": editor[0],
                "type": "图集",
                "name": "交付图集",
                "delivered": True,
                "updatedAt": 100,
            }])

            item, err = store.add_delivery_remark("delivery-remarks-1", {
                "id": supplier[0], "name": "供应商管理员", "role": "supplier_parent",
            }, "请补一张封面")
            self.assertIsNone(err)
            self.assertEqual(item["remarks"][0]["text"], "请补一张封面")
            self.assertGreater(item["latestRemarkAt"], item["remarkReadAt"].get(editor[0], 0))

            item, err = store.mark_delivery_remarks_read("delivery-remarks-1", editor[0], "editor")
            self.assertIsNone(err)
            self.assertGreaterEqual(item["remarkReadAt"][editor[0]], item["latestRemarkAt"])

            item, err = store.add_delivery_remark("delivery-remarks-1", {
                "id": editor[0], "name": "创作者", "role": "editor",
            }, "已补充，请复核")
            self.assertIsNone(err)
            self.assertEqual(len(item["remarks"]), 2)

    def test_stale_asset_upsert_preserves_server_remark_timeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("assets", [{
                "id": "delivery-preserve-1", "delivered": True, "name": "交付内容", "updatedAt": 100,
                "remarks": [{"id": "remark-1", "text": "服务端备注", "createdAt": 200}],
                "remarkReadAt": {"supplier-1": 200}, "latestRemarkAt": 200,
            }])
            store.upsert_docs("assets", [{
                "id": "delivery-preserve-1", "delivered": True, "name": "旧客户端回写", "updatedAt": 300,
            }])
            snapshot = store.state_for("admin-1", "admin")
            item = next(row for row in snapshot["assets"] if row["id"] == "delivery-preserve-1")
            self.assertEqual(item["remarks"][0]["text"], "服务端备注")
            self.assertEqual(item["latestRemarkAt"], 200)


if __name__ == "__main__":
    unittest.main()
