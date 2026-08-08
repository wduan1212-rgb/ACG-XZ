import importlib.util
import os
import sys
import tempfile
import unittest
import uuid
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1]
TEST_DIR = Path(__file__).resolve().parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))


def load_isolated_store_without_global_module(tmpdir):
    previous_db = os.environ.get("DATA_DB")
    previous_blobs = os.environ.get("CUSTOM_CANVAS_BLOB_DIR")
    os.environ["DATA_DB"] = str(Path(tmpdir) / "data.sqlite")
    os.environ["CUSTOM_CANVAS_BLOB_DIR"] = str(Path(tmpdir) / "canvas_blobs")
    try:
        name = f"partial_state_store_{uuid.uuid4().hex}"
        spec = importlib.util.spec_from_file_location(name, SERVER_DIR / "store.py")
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        return module
    finally:
        if previous_db is None:
            os.environ.pop("DATA_DB", None)
        else:
            os.environ["DATA_DB"] = previous_db
        if previous_blobs is None:
            os.environ.pop("CUSTOM_CANVAS_BLOB_DIR", None)
        else:
            os.environ["CUSTOM_CANVAS_BLOB_DIR"] = previous_blobs


class PartialStateBootstrapTest(unittest.TestCase):
    def test_store_returns_only_requested_collections_and_keeps_full_compatibility(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store_without_global_module(tmp)
            store.upsert_docs("accounts", [{"id": "account-1", "name": "账号"}])
            store.upsert_docs("products", [{"id": "product-1", "name": "产品"}])
            store.upsert_docs("productions", [{
                "id": "production-1", "ownerId": "creator-a", "stage": "script",
            }])
            store.upsert_docs("assets", [{
                "id": "asset-1", "ownerId": "creator-a", "productionId": "production-1",
            }])
            store.upsert_docs("jobs", [{
                "id": "job-1", "productionId": "production-1", "ownerId": "creator-a",
            }])

            partial = store.state_for(
                "creator-a",
                "editor",
                collections={"accounts", "products", "voicePresets"},
            )
            self.assertEqual(set(partial), {"accounts", "products", "voicePresets"})
            self.assertEqual(partial["accounts"][0]["id"], "account-1")
            self.assertNotIn("assets", partial)
            self.assertNotIn("productions", partial)
            self.assertNotIn("jobs", partial)

            jobs_only = store.state_for(
                "creator-a", "editor", collections={"jobs"}
            )
            self.assertEqual(set(jobs_only), {"jobs"})
            self.assertEqual([item["id"] for item in jobs_only["jobs"]], ["job-1"])

            full = store.state_for("creator-a", "editor")
            self.assertIn("assets", full)
            self.assertIn("productions", full)
            self.assertIn("jobs", full)

    def test_http_collections_query_is_partial_and_members_are_explicit(self):
        source = (SERVER_DIR / "main.py").read_text(encoding="utf-8")
        endpoint = source.split('@app.get("/api/state")', 1)[1].split(
            "def _require_custom_creator", 1
        )[0]
        self.assertIn('collections: str = ""', endpoint)
        self.assertIn("requested_collections if filtered else None", endpoint)
        self.assertIn('if not filtered or "members" in requested_names:', endpoint)
        self.assertIn('X-Xingzhen-State-Mode', endpoint)

    def test_state_scope_filter_is_one_indexed_join_not_one_check_per_document(self):
        source = (SERVER_DIR / "store.py").read_text(encoding="utf-8")
        state_for = source.split("def state_for(", 1)[1].split(
            "# ---------- 社区灵感", 1
        )[0]
        self.assertIn("scopes_enforced = _resource_scopes_enforced_locked(conn)", state_for)
        self.assertIn("actor_scope = (", state_for)
        self.assertIn("JOIN resource_scopes AS rs", state_for)
        self.assertIn("rs.scope_type=? AND rs.scope_id=?", state_for)
        self.assertNotIn("_resource_scope_allows_actor_locked(", state_for)

    def test_supplier_bootstrap_returns_assets_with_source_time_without_leaking_productions(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store_without_global_module(tmp)
            store.upsert_docs("accounts", [{"id": "account-1", "name": "账号"}])
            store.upsert_docs("productions", [{
                "id": "production-1",
                "ownerId": "creator-a",
                "accountId": "account-1",
                "stage": "delivered",
                "createdAt": 1784300000000,
            }])
            store.upsert_docs("assets", [{
                "id": "asset-1",
                "ownerId": "creator-a",
                "accountId": "account-1",
                "productionId": "production-1",
                "delivered": True,
                "createdAt": 1784301000000,
            }])
            store.assign_team_accounts(store.INTERNAL_TEAM_ID, ["account-1"])
            parent_id = store.get_member_by_username(store.DEFAULT_SUPPLIER_USERNAME)[0]

            partial = store.state_for(
                parent_id,
                "supplier_parent",
                collections={"accounts", "products", "assets"},
            )
            self.assertEqual(set(partial), {"accounts", "products", "assets"})
            self.assertEqual([item["id"] for item in partial["assets"]], ["asset-1"])
            self.assertEqual(partial["assets"][0]["sourceCreatedAt"], 1784300000000)
            self.assertNotIn("productions", partial)


if __name__ == "__main__":
    unittest.main()
