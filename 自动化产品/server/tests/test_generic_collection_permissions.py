import tempfile
import unittest
import sys
import importlib
import asyncio
from pathlib import Path

TEST_DIR = Path(__file__).resolve().parent
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))
from test_store_tombstone import load_isolated_store


def stored_doc(store, collection, doc_id):
    row = store._fetchone(
        "SELECT owner_id,data FROM docs WHERE collection=? AND id=?",
        (collection, doc_id),
    )
    if not row:
        return None
    import json
    return row[0], json.loads(row[1])


class GenericCollectionPermissionTest(unittest.TestCase):
    def test_session_creator_can_delete_legacy_owner_drift_and_batch_is_detached(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_member_collection("editor-a", "editor", "sessions", [{
                "id": "session-a", "title": "本人会话", "updatedAt": 100,
            }])
            store.upsert_member_collection("editor-a", "editor", "batches", [{
                "id": "batch-a", "sessionId": "session-a", "topic": "保留批次", "updatedAt": 110,
            }])
            # Reproduce the historical mismatch: docs drifted, but the immutable
            # resource registry still identifies the exact original creator.
            conn = store._connect()
            try:
                conn.execute(
                    "UPDATE docs SET owner_id='legacy-owner' WHERE collection='sessions' AND id='session-a'"
                )
                conn.commit()
            finally:
                conn.close()
            store.delete_member_doc("sessions", "session-a", "editor-a", "editor")
            self.assertIsNone(stored_doc(store, "sessions", "session-a"))
            batch = stored_doc(store, "batches", "batch-a")[1]
            self.assertEqual(batch["sessionId"], "")
            self.assertEqual(batch["archivedSessionId"], "session-a")
            self.assertGreater(batch["sessionDeletedAt"], 0)

    def test_generic_api_returns_403_for_editor_account_write_and_allows_admin(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            sys.modules.pop("main", None)
            # 部分音视频测试会关闭默认 loop；main 模块初始化 semaphore 前显式补一个。
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                main = importlib.import_module("main")
                account = {
                    "id": "account-api",
                    "name": "API 共享账号",
                    "platform": "小红书",
                    "mode": "图文",
                    "updatedAt": 100,
                }
                with self.assertRaises(main.HTTPException) as denied:
                    main.api_put(
                        "accounts",
                        main.PutReq(items=[account]),
                        me={"id": "editor-a", "role": "editor"},
                    )
                self.assertEqual(denied.exception.status_code, 403)
                result = main.api_put(
                    "accounts",
                    main.PutReq(items=[account]),
                    me={"id": "admin-a", "role": "admin"},
                )
                self.assertEqual(result["n"], 1)
                self.assertIsNotNone(stored_doc(store, "accounts", "account-api"))
                with self.assertRaises(main.HTTPException) as delete_denied:
                    main.api_del(
                        "accounts",
                        "account-api",
                        me={"id": "editor-a", "role": "editor"},
                    )
                self.assertEqual(delete_denied.exception.status_code, 403)
                self.assertIsNotNone(stored_doc(store, "accounts", "account-api"))
            finally:
                sys.modules.pop("main", None)
                loop.close()
                asyncio.set_event_loop(None)

    def test_accounts_are_admin_only_for_generic_put_and_delete(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            account = {
                "id": "account-shared",
                "name": "共享账号",
                "platform": "小红书",
                "mode": "图文",
                "updatedAt": 100,
            }
            with self.assertRaises(PermissionError):
                store.upsert_member_collection("editor-a", "editor", "accounts", [account])

            result = store.upsert_member_collection("admin-a", "admin", "accounts", [account])
            self.assertEqual(result["written"], 1)
            with self.assertRaises(PermissionError):
                store.delete_member_doc("accounts", account["id"], "editor-a", "editor")
            self.assertIsNotNone(stored_doc(store, "accounts", account["id"]))

            store.delete_member_doc("accounts", account["id"], "admin-a", "admin")
            self.assertIsNone(stored_doc(store, "accounts", account["id"]))

    def test_editor_can_sync_own_production_but_not_overwrite_or_delete_another(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            own = {
                "id": "prod-a",
                "ownerId": "forged-owner",
                "title": "A 初稿",
                "updatedAt": 100,
            }
            other = {
                "id": "prod-b",
                "ownerId": "editor-b",
                "title": "B 初稿",
                "updatedAt": 100,
            }
            result = store.upsert_member_collection("editor-a", "editor", "productions", [own])
            self.assertEqual(result["written"], 1)
            self.assertEqual(stored_doc(store, "productions", "prod-a")[0], "editor-a")
            self.assertEqual(stored_doc(store, "productions", "prod-a")[1]["ownerId"], "editor-a")
            store.upsert_docs("productions", [other])

            # 正常前端整集合快照：本人更新 + 未变化的外部记录可以同批同步。
            own_update = {
                **stored_doc(store, "productions", "prod-a")[1],
                "title": "A 已更新",
                "updatedAt": 200,
            }
            other_snapshot = stored_doc(store, "productions", "prod-b")[1]
            result = store.upsert_member_collection(
                "editor-a", "editor", "productions", [own_update, other_snapshot]
            )
            self.assertEqual(result["written"], 1)
            self.assertEqual(result["unchanged"], 1)
            self.assertEqual(stored_doc(store, "productions", "prod-a")[1]["title"], "A 已更新")

            with self.assertRaises(PermissionError):
                store.upsert_member_collection("editor-a", "editor", "productions", [{
                    **other_snapshot,
                    "ownerId": "editor-a",
                    "title": "A 试图覆盖 B",
                    "updatedAt": 300,
                }])
            self.assertEqual(stored_doc(store, "productions", "prod-b")[1]["title"], "B 初稿")
            with self.assertRaises(PermissionError):
                store.delete_member_doc("productions", "prod-b", "editor-a", "editor")
            self.assertIsNotNone(stored_doc(store, "productions", "prod-b"))

    def test_jobs_follow_production_owner_and_cannot_be_rebound(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_member_collection("editor-a", "editor", "productions", [{
                "id": "prod-a", "title": "A", "updatedAt": 100,
            }])
            store.upsert_member_collection("editor-b", "editor", "productions", [{
                "id": "prod-b", "title": "B", "updatedAt": 100,
            }])
            job = {
                "id": "job-a",
                "productionId": "prod-a",
                "status": "queued",
                "updatedAt": 110,
            }
            store.upsert_member_collection("editor-a", "editor", "jobs", [job])
            self.assertEqual(stored_doc(store, "jobs", "job-a")[0], "editor-a")

            with self.assertRaises(PermissionError):
                store.upsert_member_collection("editor-a", "editor", "jobs", [{
                    "id": "job-forged",
                    "productionId": "prod-b",
                    "status": "queued",
                    "updatedAt": 120,
                }])
            with self.assertRaises(PermissionError):
                store.upsert_member_collection("editor-a", "editor", "jobs", [{
                    **stored_doc(store, "jobs", "job-a")[1],
                    "productionId": "prod-b",
                    "updatedAt": 130,
                }])
            # 即使脏数据里伪造了 ownerId，production 仍是现存的权限事实来源。
            store.upsert_docs("jobs", [{
                "id": "job-inconsistent",
                "ownerId": "editor-a",
                "productionId": "prod-b",
                "status": "queued",
                "updatedAt": 140,
            }])
            with self.assertRaises(PermissionError):
                store.delete_member_doc("jobs", "job-inconsistent", "editor-a", "editor")

            # 删除 production 会在同一权限域中清理 jobs，避免并发 DELETE 留孤儿。
            store.delete_member_doc("productions", "prod-a", "editor-a", "editor")
            self.assertIsNone(stored_doc(store, "productions", "prod-a"))
            self.assertIsNone(stored_doc(store, "jobs", "job-a"))

    def test_editor_analytics_chain_remains_writable_only_for_own_delivery(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            store.upsert_member_collection("editor-a", "editor", "productions", [{
                "id": "prod-a", "title": "A", "updatedAt": 100,
            }])
            store.upsert_member_collection("editor-b", "editor", "productions", [{
                "id": "prod-b", "title": "B", "updatedAt": 100,
            }])
            store.upsert_member_assets("editor-a", "editor", [{
                "id": "delivery-a",
                "productionId": "prod-a",
                "byMemberId": "editor-a",
                "delivered": True,
                "updatedAt": 110,
            }])
            store.upsert_member_assets("editor-b", "editor", [{
                "id": "delivery-b",
                "productionId": "prod-b",
                "byMemberId": "editor-b",
                "delivered": True,
                "updatedAt": 110,
            }])

            link = {
                "id": "link-a",
                "assetId": "delivery-a",
                "productionId": "prod-a",
                "url": "https://example.com/a",
                "updatedAt": 120,
            }
            snapshot = {
                "id": "snapshot-a",
                "linkId": "link-a",
                "metrics": {"views": 10},
                "updatedAt": 130,
            }
            report = {
                "id": "report-a",
                "linkedSnapshotIds": ["snapshot-a"],
                "summary": "A 的复盘",
                "updatedAt": 140,
            }
            memory = {
                "id": "memory-a",
                "sourceReportId": "report-a",
                "rule": "A 的创作规则",
                "updatedAt": 150,
            }
            for collection, item in (
                ("analyticsLinks", link),
                ("metricSnapshots", snapshot),
                ("insightReports", report),
                ("creativeMemory", memory),
            ):
                result = store.upsert_member_collection("editor-a", "editor", collection, [item])
                self.assertEqual(result["written"], 1, collection)
                self.assertEqual(stored_doc(store, collection, item["id"])[0], "editor-a")

            with self.assertRaises(PermissionError):
                store.upsert_member_collection("editor-a", "editor", "analyticsLinks", [{
                    "id": "link-b",
                    "assetId": "delivery-b",
                    # 即使同时塞入本人 productionId，也不能掩盖他人的交付资产关联。
                    "productionId": "prod-a",
                    "url": "https://example.com/forged",
                    "updatedAt": 160,
                }])
            self.assertIsNone(stored_doc(store, "analyticsLinks", "link-b"))


if __name__ == "__main__":
    unittest.main()
