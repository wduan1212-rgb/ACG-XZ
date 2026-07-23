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
    def test_global_editing_assets_are_visible_across_creator_owners(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("assets", [
                {
                    "id": "global-bgm",
                    "ownerId": "creator-a",
                    "accountId": "account-a",
                    "name": "共享 BGM",
                    "type": "音频",
                    "tags": ["BGM", "音乐库"],
                    "createdAt": 1,
                },
                {
                    "id": "private-image",
                    "ownerId": "creator-a",
                    "accountId": "account-a",
                    "name": "账号私有图",
                    "type": "图片",
                    "tags": ["账号素材"],
                    "createdAt": 2,
                },
            ])
            snapshot = store.state_for("creator-b", "creator")
            visible = {item["id"] for item in snapshot["assets"]}
            self.assertIn("global-bgm", visible)
            self.assertNotIn("private-image", visible)

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

    def test_supplier_return_link_updates_creator_asset_and_active_analytics_atomically(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("accounts", [{
                "id": "account-1", "name": "测试账号", "platform": "小红书", "mode": "图文", "updatedAt": 100,
            }])
            store.upsert_docs("assets", [{
                "id": "delivery-link-1",
                "accountId": "account-1",
                "productionId": "production-1",
                "type": "图集",
                "name": "交付图集",
                "title": "发布标题",
                "delivered": True,
                "status": "已下载",
                "supplierDownloadedAt": 80,
                "supplierDownloadedBy": "supplier-parent",
                "updatedAt": 100,
            }])

            denied, denied_link, err = store.update_supplier_asset_published_link(
                "delivery-link-1", "https://www.xiaohongshu.com/explore/first", "", "", "",
                "admin-1", "admin",
            )
            self.assertIsNone(denied)
            self.assertIsNone(denied_link)
            self.assertEqual(err, "forbidden")

            first, first_link, err = store.update_supplier_asset_published_link(
                "delivery-link-1", "https://www.xiaohongshu.com/explore/first", "首轮备注", "首轮标题", "分享文本",
                "supplier-parent", "supplier_parent",
            )
            self.assertIsNone(err)
            self.assertEqual(first["status"], "已发布")
            self.assertEqual(first["supplierDownloadedAt"], 80)
            self.assertEqual(first_link["assetId"], "delivery-link-1")
            self.assertEqual(first_link["url"], first["publishedUrl"])
            self.assertEqual(first_link["status"], "pending")

            creator_snapshot = store.state_for("admin-1", "admin")
            creator_asset = next(row for row in creator_snapshot["assets"] if row["id"] == "delivery-link-1")
            creator_link = next(row for row in creator_snapshot["analyticsLinks"] if row["id"] == first_link["id"])
            self.assertEqual(creator_asset["publishedUrl"], first["publishedUrl"])
            self.assertEqual(creator_link["url"], first["publishedUrl"])

            store.upsert_docs("metricSnapshots", [{
                "id": "snapshot-first", "linkId": first_link["id"], "fetchedAt": 200,
                "metrics": {"views": 100}, "updatedAt": 200,
            }])
            second, second_link, err = store.update_supplier_asset_published_link(
                "delivery-link-1", "https://channels.weixin.qq.com/web/pages/feed?finderUserName=second",
                "链接已修改", "修改后标题", "新的分享文本", "supplier-parent", "supplier_parent",
            )
            self.assertIsNone(err)
            self.assertEqual(second_link["id"], first_link["id"])
            self.assertEqual(second["publishedUrl"], second_link["url"])
            self.assertEqual(second["status"], "已发布")
            self.assertEqual(second["supplierDownloadedAt"], 80)

            updated_snapshot = store.state_for("admin-1", "admin")
            links = {row["id"]: row for row in updated_snapshot["analyticsLinks"]}
            self.assertEqual(links[second_link["id"]]["status"], "pending")
            self.assertEqual(len(links), 1)
            archived_snapshot = next(row for row in updated_snapshot["metricSnapshots"] if row["id"] == "snapshot-first")
            self.assertEqual(archived_snapshot["archivedLinkId"], first_link["id"])
            self.assertNotEqual(archived_snapshot["linkId"], first_link["id"])

            store.upsert_docs("assets", [{
                **second,
                "publishedUrl": "https://stale.example/old",
                "publishedAt": 1,
                "publishedUpdatedAt": 1,
                "status": "已下载",
                "updatedAt": second["updatedAt"] + 10,
            }])
            preserved = next(
                row for row in store.state_for("admin-1", "admin")["assets"] if row["id"] == "delivery-link-1"
            )
            self.assertEqual(preserved["publishedUrl"], second["publishedUrl"])
            self.assertEqual(preserved["status"], "已发布")

    def test_supplier_child_only_sees_assigned_deliveries_and_can_return_their_links(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            parent = store.add_member("供应商母账号", "return_link_parent", "local-test-pin", "supplier_parent")
            child = store.create_supplier_children(parent[0], [{
                "name": "供应商子账号", "username": "return_link_child", "pin": "local-test-pin",
            }])[0]
            store.set_supplier_child_accounts(parent[0], child["id"], ["account-assigned"], parent[0])
            store.upsert_docs("accounts", [{
                "id": "account-assigned", "name": "已分配账号", "platform": "小红书", "mode": "图文", "updatedAt": 80,
            }, {
                "id": "account-other", "name": "其他账号", "platform": "小红书", "mode": "图文", "updatedAt": 80,
            }])
            store.upsert_docs("assets", [{
                "id": "delivery-assigned", "accountId": "account-assigned", "name": "已分配素材",
                "delivered": True, "pubSeq": 252, "updatedAt": 100,
            }, {
                "id": "delivery-unassigned", "accountId": "account-other", "name": "未分配素材",
                "delivered": True, "pubSeq": 251, "updatedAt": 100,
            }])

            child_snapshot = store.state_for(child["id"], "supplier_child", parent[0])
            child_asset_ids = {row["id"] for row in child_snapshot["assets"]}
            self.assertIn("delivery-assigned", child_asset_ids)
            self.assertNotIn("delivery-unassigned", child_asset_ids)
            child_delivery = next(row for row in child_snapshot["assets"] if row["id"] == "delivery-assigned")
            parent_delivery = next(
                row for row in store.state_for(parent[0], "supplier_parent")["assets"]
                if row["id"] == "delivery-assigned"
            )
            creator_delivery = next(
                row for row in store.state_for("admin-1", "admin")["assets"]
                if row["id"] == "delivery-assigned"
            )
            # 子账号看不到 #251，但同一素材仍必须保留权威序号 #252。
            self.assertEqual(child_delivery["pubSeq"], 252)
            self.assertEqual(parent_delivery["pubSeq"], child_delivery["pubSeq"])
            self.assertEqual(creator_delivery["pubSeq"], child_delivery["pubSeq"])

            updated, link, err = store.update_supplier_asset_published_link(
                "delivery-assigned", "https://www.xiaohongshu.com/explore/child-return", "", "", "",
                child["id"], "supplier_child",
            )
            self.assertIsNone(err)
            self.assertEqual(updated["publishedUpdatedBy"], child["id"])
            self.assertEqual(updated["status"], "已发布")
            self.assertEqual(updated["publishedUrl"], "https://www.xiaohongshu.com/explore/child-return")
            self.assertEqual(link["assetId"], "delivery-assigned")

            # 模拟旧页面在回传接口完成后才到达的整条 assets 后台回推。
            # 即使它的 updatedAt 较新，也不得清除服务端权威回传状态。
            store.upsert_docs("assets", [{
                **updated,
                "publishedUrl": "",
                "publishedAt": 0,
                "publishedUpdatedAt": 0,
                "status": "未下载",
                "updatedAt": updated["updatedAt"] + 10,
            }])

            # 即使绕过前端直接请求，后端仍拒绝未分配素材，作为越权防护兜底。
            denied, denied_link, err = store.update_supplier_asset_published_link(
                "delivery-unassigned", "https://www.xiaohongshu.com/explore/blocked", "", "", "",
                child["id"], "supplier_child",
            )
            self.assertIsNone(denied)
            self.assertIsNone(denied_link)
            self.assertEqual(err, "unassigned")

            # 刷新/重登后各角色都从服务端重拉快照，回传态和序号仍一致。
            refreshed_snapshots = [
                store.state_for("admin-1", "admin"),
                store.state_for(parent[0], "supplier_parent"),
                store.state_for(child["id"], "supplier_child", parent[0]),
            ]
            for snapshot in refreshed_snapshots:
                visible = next(row for row in snapshot["assets"] if row["id"] == "delivery-assigned")
                self.assertEqual(visible["publishedUrl"], updated["publishedUrl"])
                self.assertEqual(visible["status"], "已发布")
                self.assertEqual(visible["pubSeq"], 252)

    def test_legacy_delivery_sequence_projection_is_global_and_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            parent = store.add_member("供应商管理员", "legacy_seq_parent", "local-test-pin", "supplier_parent")
            child = store.create_supplier_children(parent[0], [{
                "name": "旧数据子账号", "username": "legacy_seq_child", "pin": "local-test-pin",
            }])[0]
            store.set_supplier_child_accounts(parent[0], child["id"], ["account-assigned"], parent[0])
            store.upsert_docs("accounts", [{
                "id": "account-assigned", "name": "已分配账号", "platform": "小红书", "mode": "图文", "updatedAt": 1,
            }, {
                "id": "account-hidden", "name": "未分配账号", "platform": "小红书", "mode": "图文", "updatedAt": 1,
            }])
            store.upsert_docs("assets", [{
                "id": "legacy-assigned", "accountId": "account-assigned", "name": "旧交付一",
                "delivered": True, "deliveredAt": 10, "updatedAt": 10,
            }, {
                "id": "legacy-hidden", "accountId": "account-hidden", "name": "旧交付二",
                "delivered": True, "deliveredAt": 20, "updatedAt": 20,
            }])

            snapshots = [
                store.state_for("admin-1", "admin"),
                store.state_for(parent[0], "supplier_parent"),
                store.state_for(child["id"], "supplier_child", parent[0]),
            ]
            sequences = []
            for snapshot in snapshots:
                item = next(row for row in snapshot["assets"] if row["id"] == "legacy-assigned")
                sequences.append(item["projectedSeq"])
                self.assertNotIn("pubSeq", item)
            self.assertEqual(len(set(sequences)), 1)
            self.assertEqual(
                {next(row for row in snapshot["assets"] if row["id"] == "legacy-assigned")["globalSeq"] for snapshot in snapshots},
                {1},
            )

            # projectedSeq 只是 /api/state 投影，不写回生产资产记录。
            conn = store._connect()
            try:
                raw = conn.execute(
                    "SELECT data FROM docs WHERE collection='assets' AND id='legacy-assigned'"
                ).fetchone()[0]
            finally:
                conn.close()
            self.assertNotIn("projectedSeq", __import__("json").loads(raw))

            # 客户端若把快照整条回推，服务端仍会丢弃只读投影字段。
            legacy_snapshot = next(
                row for row in snapshots[0]["assets"] if row["id"] == "legacy-assigned"
            )
            store.upsert_docs("assets", [{**legacy_snapshot, "updatedAt": 30}])
            conn = store._connect()
            try:
                raw = conn.execute(
                    "SELECT data FROM docs WHERE collection='assets' AND id='legacy-assigned'"
                ).fetchone()[0]
            finally:
                conn.close()
            self.assertNotIn("projectedSeq", __import__("json").loads(raw))

    def test_delivery_sequence_reconciliation_is_global_across_creators_and_suppliers(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            parent = store.add_member("供应商管理员", "sequence_parent", "local-test-pin", "supplier_parent")
            child = store.create_supplier_children(parent[0], [{
                "name": "供应商子账号", "username": "sequence_child", "pin": "local-test-pin",
            }])[0]
            store.set_supplier_child_accounts(parent[0], child["id"], ["account-assigned"], parent[0])
            store.upsert_docs("accounts", [{
                "id": "account-assigned", "name": "已分配账号", "platform": "小红书", "mode": "图文", "updatedAt": 1,
            }, {
                "id": "account-other", "name": "其他创作者账号", "platform": "视频号", "mode": "视频", "updatedAt": 1,
            }])
            # 历史数据模拟两个发布人各自从 #001 开始，且较新的记录错误写成 #274。
            store.upsert_docs("assets", [{
                "id": "first-delivery", "accountId": "account-assigned", "name": "先发布的内容",
                "delivered": True, "deliveredAt": 100, "pubSeq": 1,
                "publishedUrl": "https://example.test/first", "updatedAt": 100,
            }, {
                "id": "second-delivery", "accountId": "account-other", "name": "后发布的内容",
                "delivered": True, "deliveredAt": 200, "pubSeq": 274, "updatedAt": 200,
            }])

            migrated = store.reconcile_delivery_sequences()
            self.assertEqual(migrated, {"migrated": True, "updated": 1, "total": 2})
            self.assertEqual(
                store.reconcile_delivery_sequences(),
                {"migrated": False, "updated": 0, "total": 2},
            )

            admin_assets = {row["id"]: row for row in store.state_for("admin-1", "admin")["assets"]}
            parent_assets = {row["id"]: row for row in store.state_for(parent[0], "supplier_parent")["assets"]}
            child_assets = {row["id"]: row for row in store.state_for(child["id"], "supplier_child", parent[0])["assets"]}
            self.assertEqual(admin_assets["first-delivery"]["pubSeq"], 1)
            self.assertEqual(admin_assets["second-delivery"]["pubSeq"], 2)
            self.assertEqual(parent_assets["second-delivery"]["pubSeq"], 2)
            self.assertEqual(child_assets["first-delivery"]["pubSeq"], 1)
            self.assertEqual(parent_assets["second-delivery"]["globalSeq"], 2)
            self.assertEqual(child_assets["first-delivery"]["globalSeq"], 1)
            self.assertEqual(admin_assets["first-delivery"]["publishedUrl"], "https://example.test/first")

            # 校准后，旧前端即便携带了自己的大号计数，新交付也必须领到全局下一号。
            store.upsert_docs("assets", [{
                "id": "third-delivery", "accountId": "account-assigned", "name": "新交付",
                "delivered": True, "deliveredAt": 300, "pubSeq": 999, "updatedAt": 300,
            }])
            after_new = {row["id"]: row for row in store.state_for("admin-1", "admin")["assets"]}
            self.assertEqual(after_new["third-delivery"]["pubSeq"], 3)

    def test_state_projection_decodes_each_asset_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_docs("assets", [{
                "id": f"decode-once-{index}",
                "accountId": "account-1",
                "name": f"交付 {index}",
                "delivered": True,
                **({"pubSeq": index + 1} if index % 2 else {}),
                "updatedAt": index + 1,
            } for index in range(32)])

            real_loads = store.json.loads
            decoded_asset_ids = []

            def counting_loads(raw, *args, **kwargs):
                item = real_loads(raw, *args, **kwargs)
                if isinstance(item, dict) and str(item.get("id") or "").startswith("decode-once-"):
                    decoded_asset_ids.append(item["id"])
                return item

            store.json.loads = counting_loads
            try:
                snapshot = store.state_for("admin-1", "admin")
            finally:
                store.json.loads = real_loads

            self.assertEqual(len([row for row in snapshot["assets"] if row["id"].startswith("decode-once-")]), 32)
            self.assertEqual(len(decoded_asset_ids), 32)
            self.assertEqual(len(set(decoded_asset_ids)), 32)

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
