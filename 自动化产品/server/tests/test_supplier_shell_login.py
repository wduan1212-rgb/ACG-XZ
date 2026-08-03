import sys
import tempfile
import time
import unittest
from pathlib import Path

from server.tests.testclient_compat import TestClient


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR.parent))

from server import main, store


class SupplierShellLoginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "supplier-shell.sqlite"
        store._initialized = False
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _login(self, username, pin):
        response = self.client.post("/api/auth/login", json={"username": username, "pin": pin})
        self.assertEqual(200, response.status_code)
        payload = response.json()
        resumed = self.client.get(
            "/api/auth/me", headers={"Authorization": f"Bearer {payload['token']}"},
        )
        self.assertEqual(200, resumed.status_code)
        return payload["member"], resumed.json()

    def _map_supplier_parent(self, parent_id):
        store._ensure_db()
        with store._lock:
            conn = store._connect()
            try:
                conn.execute(
                    "INSERT INTO team_suppliers(team_id,supplier_parent_id,created_at,added_by) "
                    "VALUES(?,?,?,?)",
                    (store.INTERNAL_TEAM_ID, parent_id, int(time.time() * 1000), "test"),
                )
                conn.commit()
            finally:
                conn.close()

    def test_parent_first_login_and_refresh_keep_supplier_identity(self):
        store.add_member("供应商管理员", "shell_supplier_parent", "123456", "supplier_parent")
        logged_in, resumed = self._login("shell_supplier_parent", "123456")
        self.assertEqual("supplier_parent", logged_in["role"])
        self.assertEqual(["supplier"], logged_in["entitlements"])
        self.assertEqual("supplier_parent", resumed["role"])
        self.assertEqual(["supplier"], resumed["entitlements"])

    def test_child_first_login_and_refresh_keep_parent_binding(self):
        parent = store.add_member("供应商管理员", "shell_supplier_owner", "123456", "supplier_parent")
        self._map_supplier_parent(parent[0])
        child = store.create_supplier_children(parent[0], [{
            "name": "供应商子账号", "username": "shell_supplier_child", "pin": "123456",
        }])[0]
        logged_in, resumed = self._login("shell_supplier_child", "123456")
        self.assertEqual("supplier_child", logged_in["role"])
        self.assertEqual(parent[0], logged_in["parentId"])
        self.assertEqual("supplier_child", resumed["role"])
        self.assertEqual(parent[0], resumed["parentId"])
        self.assertEqual(["supplier"], resumed["entitlements"])

    def test_parent_dashboard_read_endpoints_settle_with_lists(self):
        parent = store.add_member("供应商管理员", "shell_supplier_dashboard", "123456", "supplier_parent")
        self._map_supplier_parent(parent[0])
        response = self.client.post(
            "/api/auth/login",
            json={"username": "shell_supplier_dashboard", "pin": "123456"},
        )
        self.assertEqual(200, response.status_code)
        headers = {"Authorization": f"Bearer {response.json()['token']}"}
        started_at = time.monotonic()
        for path in (
            "/api/supplier/children",
            "/api/supplier/members",
            "/api/supplier/bindings",
            "/api/supplier/activity",
        ):
            result = self.client.get(path, headers=headers)
            self.assertEqual(200, result.status_code, path)
            self.assertIsInstance(result.json(), list, path)
        self.assertLess(time.monotonic() - started_at, 2.0)


if __name__ == "__main__":
    unittest.main()
