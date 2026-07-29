import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR.parent))

from server import store


class TeamAuthorizationStoreTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "team-auth.sqlite"
        store._initialized = False

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _admin(self):
        return store.get_member_by_username(store.DEFAULT_ADMIN_USERNAME)

    def test_new_personal_user_only_has_base_features_and_no_team_accounts(self):
        admin = self._admin()
        store.upsert_member_collection(admin[0], "admin", "accounts", [{
            "id": "account-acg",
            "name": "ACG 内容账号",
            "platform": "小红书",
            "updatedAt": 100,
        }])
        personal = store.add_member("个人用户", "personal-user", "123456", "user")
        public = store.member_public(personal)
        self.assertIsNone(public["team"])
        self.assertEqual("personal", public["plan"])
        self.assertEqual(set(store.PERSONAL_FEATURES), set(public["entitlements"]))

        snapshot = store.state_for(personal[0], "user")
        self.assertEqual([], snapshot["accounts"])
        self.assertEqual([], snapshot["products"])

    def test_team_join_requires_request_and_manager_approval(self):
        owner = self._admin()
        personal = store.add_member("申请加入者", "join-user", "123456", "user")
        request, error = store.add_team_join_request(
            personal[0], store.INTERNAL_TEAM_NAME, "申请加入市场部"
        )
        self.assertIsNone(error)
        self.assertEqual("pending", request["status"])
        listed = store.list_team_join_requests(owner[0], "pending")
        self.assertEqual([request["id"]], [item["id"] for item in listed])

        approved, error = store.review_team_join_request(
            request["id"], owner[0], True
        )
        self.assertIsNone(error)
        self.assertEqual("editor", approved["role"])
        self.assertEqual(store.INTERNAL_TEAM_ID, approved["teamId"])
        self.assertEqual("creator", approved["teamRole"])
        self.assertEqual(set(store.TEAM_FEATURES), set(approved["entitlements"]))

    def test_internal_owner_membership_is_repaired_after_migration_marker_exists(self):
        owner = self._admin()
        with store._lock:
            conn = store._connect()
            try:
                conn.execute(
                    "DELETE FROM team_members WHERE team_id=? AND member_id=?",
                    (store.INTERNAL_TEAM_ID, owner[0]),
                )
                conn.execute(
                    "INSERT OR REPLACE INTO meta(k,v) "
                    "VALUES('internal_team_members_migrated_v1','already-ran')"
                )
                store._ensure_internal_team_locked(conn)
                conn.commit()
            finally:
                conn.close()

        repaired = store.member_public(store.get_member(owner[0]))
        self.assertEqual(store.INTERNAL_TEAM_ID, repaired["teamId"])
        self.assertEqual(store.INTERNAL_TEAM_NAME, repaired["team"]["name"])
        self.assertEqual("owner", repaired["teamRole"])
        self.assertEqual("team", repaired["plan"])
        self.assertEqual(set(store.TEAM_FEATURES), set(repaired["entitlements"]))

    def test_team_supplier_login_identity_is_visible_without_exposing_or_reusing_hashes(self):
        owner = self._admin()
        supplier = store.add_member(
            "ACG 供应商管理员",
            "acg-supplier-admin",
            "old-secret",
            "supplier_parent",
        )
        with store._lock:
            conn = store._connect()
            try:
                conn.execute(
                    "INSERT INTO team_suppliers(team_id,supplier_parent_id,created_at,added_by) "
                    "VALUES(?,?,?,?)",
                    (store.INTERNAL_TEAM_ID, supplier[0], int(time.time() * 1000), owner[0]),
                )
                conn.commit()
            finally:
                conn.close()

        identities = store.team_supplier_accounts(store.INTERNAL_TEAM_ID)
        identity = next(
            item for item in identities
            if item["username"] == "acg-supplier-admin"
        )
        self.assertEqual(supplier[0], identity["id"])
        self.assertNotIn("pin", identity)
        self.assertNotIn("hash", identity)

        reset = store.reset_team_supplier_pin(
            store.INTERNAL_TEAM_ID,
            supplier[0],
            "new-safe-secret",
        )
        self.assertEqual(supplier[0], reset["id"])
        stored = store.get_member(supplier[0])
        self.assertTrue(store.verify_pin("new-safe-secret", stored[3]))
        self.assertFalse(store.verify_pin("old-secret", stored[3]))
        self.assertIsNone(
            store.reset_team_supplier_pin("team-other", supplier[0], "blocked-secret")
        )

    def test_first_migration_only_adopts_preexisting_members_and_resources(self):
        conn = sqlite3.connect(store.DB_PATH)
        conn.executescript(store.SCHEMA)
        now = int(time.time() * 1000)
        members = [
            ("owner", "主管理员", store.DEFAULT_ADMIN_USERNAME, "hash", "admin", None, now),
            ("admin-2", "另一位管理员", "admin-two", "hash", "admin", None, now + 1),
            ("creator-1", "创作者", "creator-one", "hash", "editor", None, now + 2),
            ("supplier-1", "供应商", "supplier-one", "hash", "supplier_parent", None, now + 3),
        ]
        conn.executemany(
            "INSERT INTO members(id,name,username,pin_hash,role,parent_id,created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            members,
        )
        conn.execute(
            "INSERT INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
            (
                "accounts", "account-old", "owner", now,
                json.dumps({"id": "account-old", "name": "既有账号"}),
            ),
        )
        store._ensure_internal_team_locked(conn)
        conn.commit()

        roles = dict(conn.execute(
            "SELECT member_id,team_role FROM team_members WHERE team_id=?",
            (store.INTERNAL_TEAM_ID,),
        ).fetchall())
        self.assertEqual("owner", roles["owner"])
        self.assertEqual("admin", roles["admin-2"])
        self.assertEqual("creator", roles["creator-1"])
        self.assertEqual(
            store.INTERNAL_TEAM_ID,
            conn.execute(
                "SELECT team_id FROM team_suppliers WHERE supplier_parent_id='supplier-1'"
            ).fetchone()[0],
        )
        self.assertEqual(
            store.INTERNAL_TEAM_ID,
            conn.execute(
                "SELECT team_id FROM team_accounts WHERE account_id='account-old'"
            ).fetchone()[0],
        )

        conn.execute(
            "INSERT INTO members(id,name,username,pin_hash,role,parent_id,created_at) "
            "VALUES(?,?,?,?,?,?,?)",
            ("supplier-later", "后建供应商", "supplier-later", "hash", "supplier_parent", None, now + 10),
        )
        conn.execute(
            "INSERT INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
            (
                "accounts", "account-later", "owner", now + 10,
                json.dumps({"id": "account-later", "name": "后建账号"}),
            ),
        )
        store._ensure_internal_team_locked(conn)
        conn.commit()
        self.assertIsNone(conn.execute(
            "SELECT team_id FROM team_suppliers WHERE supplier_parent_id='supplier-later'"
        ).fetchone())
        self.assertIsNone(conn.execute(
            "SELECT team_id FROM team_accounts WHERE account_id='account-later'"
        ).fetchone())
        conn.close()

    def test_team_account_visibility_and_management_are_tenant_scoped(self):
        owner = self._admin()
        store.upsert_member_collection(owner[0], "admin", "accounts", [{
            "id": "account-acg",
            "name": "ACG 账号",
            "platform": "视频号",
            "updatedAt": 100,
        }])
        external = store.add_member("外部团队管理员", "external-admin", "123456", "editor")
        now = int(time.time() * 1000)
        with store._lock:
            conn = store._connect()
            try:
                conn.execute(
                    "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at,created_by) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        "team-external", "外部团队", "external-team", "customer",
                        "active", "team", "metered", now, external[0],
                    ),
                )
                conn.execute(
                    "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                    "VALUES(?,?,?,?,?,?)",
                    ("team-external", external[0], "admin", "active", now, external[0]),
                )
                conn.commit()
            finally:
                conn.close()

        result = store.upsert_member_collection(external[0], "editor", "accounts", [{
            "id": "account-external",
            "name": "外部团队账号",
            "platform": "小红书",
            "updatedAt": 200,
        }])
        self.assertEqual(1, result["written"])
        external_snapshot = store.state_for(external[0], "editor")
        self.assertEqual(
            ["account-external"],
            [item["id"] for item in external_snapshot["accounts"]],
        )
        owner_snapshot = store.state_for(owner[0], "admin")
        self.assertEqual(
            ["account-acg"],
            [item["id"] for item in owner_snapshot["accounts"]],
        )

        store.upsert_member_collection(owner[0], "admin", "productions", [{
            "id": "production-acg",
            "accountId": "account-acg",
            "title": "ACG 生产记录",
            "stage": "draft",
            "updatedAt": 100,
        }])
        with self.assertRaises(PermissionError):
            store.upsert_member_collection(external[0], "editor", "accounts", [{
                "id": "account-acg",
                "name": "试图覆盖 ACG 账号",
                "platform": "视频号",
                "updatedAt": 300,
            }])
        with self.assertRaises(PermissionError):
            store.upsert_member_collection(external[0], "editor", "productions", [{
                "id": "production-acg",
                "accountId": "account-acg",
                "title": "试图覆盖 ACG 生产记录",
                "stage": "draft",
                "updatedAt": 300,
            }])
        with self.assertRaises(PermissionError):
            store.delete_member_doc(
                "accounts", "account-acg", external[0], "editor"
            )


if __name__ == "__main__":
    unittest.main()
