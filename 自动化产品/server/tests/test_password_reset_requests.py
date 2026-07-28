import tempfile
import unittest
from pathlib import Path

from server import main, store


class PasswordResetRequestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "password-reset.sqlite"
        store._initialized = False

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def test_public_request_is_durable_and_deduplicated(self):
        first = main.password_reset_request_create(main.PasswordResetReq(name="  王 小明  "))
        second = main.password_reset_request_create(main.PasswordResetReq(name="王 小明"))

        self.assertTrue(first["ok"])
        self.assertTrue(second["ok"])
        rows = store.list_password_reset_requests("pending")
        self.assertEqual(1, len(rows))
        self.assertEqual("王 小明", rows[0]["name"])

    def test_admin_list_returns_pending_requests(self):
        store.add_password_reset_request("测试成员")

        rows = main.password_reset_requests_list({"id": "admin", "role": "admin"})

        self.assertEqual(1, len(rows))
        self.assertEqual("测试成员", rows[0]["name"])
        self.assertEqual("pending", rows[0]["status"])


if __name__ == "__main__":
    unittest.main()
