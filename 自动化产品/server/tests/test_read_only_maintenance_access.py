import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server.tests.testclient_compat import TestClient

from server import main, store


class ReadOnlyMaintenanceAccessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "read-only-maintenance.sqlite"
        store._initialized = False
        with (
            patch.object(store.runtime_config, "runtime_mode", return_value="local"),
            patch.object(store.runtime_config, "is_production", return_value=False),
            patch.object(store.runtime_config, "is_read_only", return_value=False),
            patch.object(store.runtime_config, "db_bootstrap_mode", return_value="auto"),
        ):
            self.member = store.add_member(
                "Read-only creator", "readonly-creator", "123456", "editor",
            )
            self.post = store.create_community_post(
                self.member[0], "Read-only creator", "", "delivery", "delivery-ro",
                "Existing inspiration", "copy", "", "视觉设计",
                [{"url": "/api/files/missing-after-publish.png", "type": "image"}],
            )
        store._initialized = False
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        main._clear_production_write_gate()
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def production_read_only(self):
        return (
            patch.object(main.runtime_config, "runtime_mode", return_value="production"),
            patch.object(main.runtime_config, "is_production", return_value=True),
            patch.object(main.runtime_config, "is_read_only", return_value=True),
            patch.object(
                main.runtime_config,
                "read_only_mode_status",
                return_value={"ok": True, "readOnly": True},
            ),
            patch.object(main.runtime_config, "db_bootstrap_mode", return_value="validate"),
        )

    def test_login_community_and_state_stay_readable_while_writes_are_frozen(self):
        degraded = {
            "ok": False,
            "exists": True,
            "quickCheck": "ok",
            "modelUsageUnresolved": 83,
            "modelUsageCompletionSpoolPending": 2,
            "modelUsageCompletionSpoolCorrupt": 0,
            "modelUsageCompletionSpoolConflicts": 0,
        }
        mode, production, read_only, mode_status, bootstrap = self.production_read_only()
        with (
            mode,
            production,
            read_only,
            mode_status,
            bootstrap,
            patch.object(store, "database_readiness", return_value=degraded),
            patch.dict(os.environ, {"AUTH_SECRET": "read-only-maintenance-test"}),
        ):
            login = self.client.post(
                "/api/auth/login",
                json={"username": "readonly-creator", "pin": "123456"},
            )
            self.assertEqual(200, login.status_code, login.text)
            headers = {"Authorization": f"Bearer {login.json()['token']}"}

            community = self.client.get("/api/community/posts?limit=10")
            self.assertEqual(200, community.status_code, community.text)
            self.assertEqual([self.post["id"]], [item["id"] for item in community.json()["items"]])

            state = self.client.get("/api/state?collections=sessions", headers=headers)
            self.assertEqual(200, state.status_code, state.text)
            self.assertEqual([], state.json()["sessions"])

            blocked = self.client.post(
                "/api/auth/register",
                json={"name": "Blocked", "username": "blocked", "pin": "123456"},
            )
            self.assertEqual(503, blocked.status_code)

    def test_read_only_integrity_contract_still_fails_closed(self):
        healthy_for_reads = {
            "ok": False,
            "exists": True,
            "quickCheck": "ok",
            "modelUsageCompletionSpoolCorrupt": 0,
            "modelUsageCompletionSpoolConflicts": 0,
        }
        self.assertTrue(store.read_only_database_operational(healthy_for_reads))
        for field, value in (
            ("exists", False),
            ("quickCheck", "corrupt"),
            ("modelUsageCompletionSpoolCorrupt", 1),
            ("modelUsageCompletionSpoolConflicts", 1),
            ("modelUsageCompletionSpoolError", "unreadable"),
        ):
            with self.subTest(field=field):
                self.assertFalse(store.read_only_database_operational({
                    **healthy_for_reads,
                    field: value,
                }))


if __name__ == "__main__":
    unittest.main()
