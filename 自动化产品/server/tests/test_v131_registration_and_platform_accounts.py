import sys
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR.parent))

from server import main, store


class RegistrationAndPlatformAccountsApiTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "registration.sqlite"
        store._initialized = False
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def test_direct_registration_logs_in_and_duplicate_username_is_rejected(self):
        payload = {"name": "直接注册用户", "username": "direct-user", "pin": "123456"}
        response = self.client.post("/api/auth/register", json=payload)
        self.assertEqual(200, response.status_code)
        data = response.json()
        self.assertTrue(data["token"])
        self.assertEqual("personal", data["member"]["plan"])
        self.assertEqual(70, data["member"]["dailyPoints"])
        self.assertEqual(
            409,
            self.client.post("/api/auth/register", json=payload).status_code,
        )
        me = self.client.get("/api/auth/me", headers={"Authorization": f"Bearer {data['token']}"})
        self.assertEqual(200, me.status_code)
        self.assertEqual("direct-user", me.json()["username"])

    def test_usernames_are_trimmed_case_insensitive_and_blank_is_rejected(self):
        created = self.client.post("/api/auth/register", json={
            "name": "Alice", "username": "  Alice  ", "pin": "123456",
        })
        self.assertEqual(200, created.status_code)
        self.assertEqual("Alice", created.json()["member"]["username"])

        duplicate = self.client.post("/api/auth/register", json={
            "name": "Another Alice", "username": "alice", "pin": "123456",
        })
        self.assertEqual(409, duplicate.status_code)

        login = self.client.post("/api/auth/login", json={
            "username": "  aLiCe  ", "pin": "123456",
        })
        self.assertEqual(200, login.status_code)
        self.assertEqual(created.json()["member"]["id"], login.json()["member"]["id"])

        blank = self.client.post("/api/auth/register", json={
            "name": "Blank", "username": " \t\n ", "pin": "123456",
        })
        self.assertEqual(400, blank.status_code)

    def test_pending_and_direct_registration_share_the_same_username_namespace(self):
        pending = self.client.post("/api/member-requests", json={
            "name": "待审批", "username": " PendingUser ", "pin": "123456",
        })
        self.assertEqual(200, pending.status_code)
        self.assertEqual("PendingUser", pending.json()["request"]["username"])

        direct = self.client.post("/api/auth/register", json={
            "name": "直接注册", "username": "pendinguser", "pin": "123456",
        })
        self.assertEqual(409, direct.status_code)
        second_pending = self.client.post("/api/member-requests", json={
            "name": "重复申请", "username": "PENDINGUSER", "pin": "123456",
        })
        self.assertEqual(409, second_pending.status_code)

        registered = self.client.post("/api/auth/register", json={
            "name": "已注册", "username": "RegisteredUser", "pin": "123456",
        })
        self.assertEqual(200, registered.status_code)
        pending_after_registration = self.client.post("/api/member-requests", json={
            "name": "已注册的变体", "username": " registereduser ", "pin": "123456",
        })
        self.assertEqual(409, pending_after_registration.status_code)

    def test_legacy_case_collisions_are_backfilled_without_unique_migration_failure(self):
        self.client.close()
        conn = sqlite3.connect(store.DB_PATH)
        try:
            conn.executescript("""
                CREATE TABLE members(
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  username TEXT NOT NULL UNIQUE,
                  pin_hash TEXT NOT NULL,
                  role TEXT NOT NULL,
                  parent_id TEXT,
                  avatar_url TEXT,
                  created_at INTEGER NOT NULL
                );
                CREATE TABLE member_requests(
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  username TEXT NOT NULL,
                  pin_hash TEXT NOT NULL,
                  role TEXT NOT NULL,
                  status TEXT NOT NULL,
                  message TEXT,
                  created_at INTEGER NOT NULL,
                  reviewed_at INTEGER,
                  reviewed_by TEXT
                );
            """)
            conn.execute(
                "INSERT INTO members VALUES(?,?,?,?,?,?,?,?)",
                ("legacy-a", "Legacy A", "Alice", store.hash_pin("123456"), "user", None, None, 1),
            )
            conn.execute(
                "INSERT INTO members VALUES(?,?,?,?,?,?,?,?)",
                ("legacy-b", "Legacy B", "alice", store.hash_pin("654321"), "user", None, None, 2),
            )
            conn.execute(
                "INSERT INTO member_requests VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    "legacy-pending", "Legacy Pending", " ALICE ", store.hash_pin("123456"),
                    "user", "pending", "", 3, None, None,
                ),
            )
            conn.commit()
        finally:
            conn.close()

        store._initialized = False
        resolved = store.get_member_by_username(" ALICE ")
        self.assertEqual("legacy-a", resolved[0])
        self.assertEqual("legacy-a", store.get_member_by_username("Alice")[0])
        self.assertEqual("legacy-b", store.get_member_by_username("alice")[0])
        self.assertTrue(store.username_has_pending_request("alice"))

        conn = sqlite3.connect(store.DB_PATH)
        try:
            keys = conn.execute(
                "SELECT username_key FROM members WHERE id IN ('legacy-a','legacy-b') ORDER BY id"
            ).fetchall()
            index = {
                row[1]: row[2]
                for row in conn.execute("PRAGMA index_list(members)").fetchall()
            }
        finally:
            conn.close()
        self.assertEqual([("alice",), ("alice",)], keys)
        self.assertEqual(0, index["idx_members_username_key"])
        with self.assertRaises(sqlite3.IntegrityError):
            store.add_member("Third Alice", "aLiCe", "123456", "user")

    def test_supplier_children_use_the_same_canonical_username_namespace(self):
        supplier = store.get_member_by_username(store.DEFAULT_SUPPLIER_USERNAME)
        self.assertIsNotNone(supplier)

        created = store.create_supplier_children(supplier[0], [{
            "name": "Supplier Child",
            "username": "  ChildUser  ",
            "pin": "123456",
        }])
        self.assertEqual("ChildUser", created[0]["username"])
        self.assertEqual(created[0]["id"], store.get_member_by_username(" childuser ")[0])

        with self.assertRaisesRegex(ValueError, "username_exists"):
            store.create_supplier_children(supplier[0], [{
                "name": "Duplicate Child",
                "username": "CHILDUSER",
                "pin": "123456",
            }])

        pending = store.add_member_request(
            "Pending Supplier Child", " PendingChild ", "123456", "user"
        )
        self.assertEqual("PendingChild", pending[2])
        with self.assertRaisesRegex(ValueError, "username_exists"):
            store.create_supplier_children(supplier[0], [{
                "name": "Conflicts With Pending",
                "username": "pendingchild",
                "pin": "123456",
            }])

    def test_platform_summary_is_limited_to_internal_team_managers(self):
        registered = [
            route for route in main.app.routes
            if getattr(route, "path", "") == "/api/platform/accounts"
        ]
        self.assertEqual(1, len(registered))
        self.assertIn("GET", registered[0].methods)
        self.assertEqual(401, self.client.get("/api/platform/accounts").status_code)

        admin = store.get_member_by_username(store.DEFAULT_ADMIN_USERNAME)
        token = store.make_token(admin[0])
        store.add_member("独立用户", "summary-personal", "123456", "user")
        allowed = self.client.get(
            "/api/platform/accounts", headers={"Authorization": f"Bearer {token}"}
        )
        self.assertEqual(200, allowed.status_code)
        rows = allowed.json()["personal"]
        self.assertTrue(any(item["username"] == "summary-personal" for item in rows))
        self.assertFalse(any("pin" in item or "hash" in item for item in rows))

        outsider = store.add_member("外部管理员", "summary-outsider", "123456", "editor")
        denied = self.client.get(
            "/api/platform/accounts",
            headers={"Authorization": f"Bearer {store.make_token(outsider[0])}"},
        )
        self.assertEqual(403, denied.status_code)


if __name__ == "__main__":
    unittest.main()
