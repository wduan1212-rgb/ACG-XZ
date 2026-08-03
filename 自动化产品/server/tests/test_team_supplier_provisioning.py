import sqlite3
import sys
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR.parent) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR.parent))

from server import main, store


class TeamSupplierProvisioningTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "team-supplier.sqlite"
        store._initialized = False
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _external_team(self, *, status="active", plan="team-pro"):
        owner = store.add_member("外部团队所有者", "external-team-owner", "123456", "editor")
        manager = store.add_member("外部团队管理员", "external-team-manager", "123456", "editor")
        now = int(time.time() * 1000)
        with store._lock:
            conn = store._connect()
            try:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(
                    "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at,created_by) "
                    "VALUES(?,?,?,?,?,?,?,?,?)",
                    (
                        "team-external-pro", "外部专业团队", "external-pro", "customer",
                        status, plan, "metered", now, owner[0],
                    ),
                )
                conn.executemany(
                    "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                    "VALUES(?,?,?,?,?,?)",
                    [
                        ("team-external-pro", owner[0], "owner", "active", now, owner[0]),
                        ("team-external-pro", manager[0], "admin", "active", now, owner[0]),
                    ],
                )
                conn.commit()
            finally:
                conn.close()
        return owner, manager

    def test_owner_provisions_once_and_bootstrap_password_is_not_persisted(self):
        owner, _manager = self._external_team()
        headers = {"Authorization": f"Bearer {store.make_token(owner[0])}"}

        created = self.client.post(
            "/api/teams/current/supplier-accounts/provision", headers=headers,
        )
        self.assertEqual(200, created.status_code)
        self.assertEqual("no-store", created.headers.get("cache-control"))
        first = created.json()
        self.assertTrue(first["created"])
        self.assertTrue(first["temporaryPassword"])
        supplier_id = first["account"]["id"]
        stored = store.get_member(supplier_id)
        self.assertEqual("supplier_parent", stored[4])
        self.assertTrue(store.verify_pin(first["temporaryPassword"], stored[3]))

        with sqlite3.connect(store.DB_PATH) as conn:
            serialized = "\n".join(
                str(value)
                for table in ("members", "team_suppliers", "meta")
                for row in conn.execute(f"SELECT * FROM {table}").fetchall()
                for value in row
            )
        self.assertNotIn(first["temporaryPassword"], serialized)

        repeated = self.client.post(
            "/api/teams/current/supplier-accounts/provision", headers=headers,
        )
        self.assertEqual(200, repeated.status_code)
        second = repeated.json()
        self.assertFalse(second["created"])
        self.assertNotIn("temporaryPassword", second)
        self.assertEqual(supplier_id, second["account"]["id"])
        self.assertEqual(1, len(store.team_supplier_accounts("team-external-pro")))

        listed = self.client.get(
            "/api/teams/current/supplier-accounts", headers=headers,
        ).json()["items"]
        self.assertEqual(first["account"]["username"], listed[0]["username"])
        self.assertNotIn("pin", listed[0])
        self.assertNotIn("hash", listed[0])

        reset = self.client.put(
            f"/api/teams/current/supplier-accounts/{supplier_id}/password",
            headers=headers,
            json={"pin": "owner-reset-secret"},
        )
        self.assertEqual(200, reset.status_code)
        self.assertTrue(store.verify_pin("owner-reset-secret", store.get_member(supplier_id)[3]))
        self.assertFalse(store.verify_pin(first["temporaryPassword"], store.get_member(supplier_id)[3]))

    def test_team_admin_cannot_provision_and_ineligible_team_is_not_mutated(self):
        _owner, manager = self._external_team()
        denied = self.client.post(
            "/api/teams/current/supplier-accounts/provision",
            headers={"Authorization": f"Bearer {store.make_token(manager[0])}"},
        )
        self.assertEqual(403, denied.status_code)
        self.assertEqual([], store.team_supplier_accounts("team-external-pro"))

        self.client.close()
        store.DB_PATH = Path(self.temp.name) / "inactive-team.sqlite"
        store._initialized = False
        self.client = TestClient(main.app)
        owner, _manager = self._external_team(status="pending", plan="team-pro")
        blocked = self.client.post(
            "/api/teams/current/supplier-accounts/provision",
            headers={"Authorization": f"Bearer {store.make_token(owner[0])}"},
        )
        # Inactive teams are not exposed as active membership, so auth rejects
        # the request before the provisioning function can write anything.
        self.assertEqual(403, blocked.status_code)
        with sqlite3.connect(store.DB_PATH) as conn:
            count = conn.execute("SELECT COUNT(*) FROM team_suppliers").fetchone()[0]
        self.assertEqual(1, count)  # only the protected default ACG supplier mapping

    def test_concurrent_provisioning_creates_exactly_one_supplier(self):
        owner, _manager = self._external_team()
        with ThreadPoolExecutor(max_workers=8) as pool:
            outcomes = list(pool.map(
                lambda _index: store.provision_team_supplier_admin(
                    "team-external-pro", owner[0]
                ),
                range(8),
            ))
        self.assertTrue(all(error is None for _result, error in outcomes))
        results = [result for result, _error in outcomes]
        self.assertEqual(1, sum(bool(item["created"]) for item in results))
        self.assertEqual(1, sum("temporaryPassword" in item for item in results))
        self.assertEqual(1, len({item["account"]["id"] for item in results}))
        self.assertEqual(1, len(store.team_supplier_accounts("team-external-pro")))

    def test_non_team_plan_is_rejected_without_creating_credentials(self):
        owner, _manager = self._external_team(plan="personal")
        result, error = store.provision_team_supplier_admin(
            "team-external-pro", owner[0]
        )
        self.assertIsNone(result)
        self.assertEqual("plan_not_eligible", error)
        self.assertEqual([], store.team_supplier_accounts("team-external-pro"))

    def test_internal_team_relationship_is_never_synthesized_or_replaced(self):
        admin = store.get_member_by_username(store.DEFAULT_ADMIN_USERNAME)
        before = store.team_supplier_accounts(store.INTERNAL_TEAM_ID)
        response = self.client.post(
            "/api/teams/current/supplier-accounts/provision",
            headers={"Authorization": f"Bearer {store.make_token(admin[0])}"},
        )
        # Existing ACG supplier mapping is returned idempotently; if a legacy
        # database has none, the protected-team guard rejects creation.
        if before:
            self.assertEqual(200, response.status_code)
            self.assertFalse(response.json()["created"])
        else:
            self.assertEqual(409, response.status_code)
        self.assertEqual(before, store.team_supplier_accounts(store.INTERNAL_TEAM_ID))


if __name__ == "__main__":
    unittest.main()
