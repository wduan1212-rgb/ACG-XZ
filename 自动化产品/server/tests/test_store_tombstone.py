import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1]


def load_isolated_store(tmpdir):
    os.environ["DATA_DB"] = str(Path(tmpdir) / "data.sqlite")
    sys.modules.pop("store", None)
    if str(SERVER_DIR) not in sys.path:
        sys.path.insert(0, str(SERVER_DIR))
    return importlib.import_module("store")


def stored_ids(store, collection):
    rows = store._fetchall("SELECT id FROM docs WHERE collection=? ORDER BY id", (collection,))
    return [row[0] for row in rows]


class StoreTombstoneTest(unittest.TestCase):
    def test_deleted_docs_do_not_resurrect_from_stale_upsert(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            protected = ["productions", "jobs", "sessions", "batches", "assets", "accounts"]

            for collection in protected:
                stale = {
                    "id": f"{collection}-old",
                    "name": "old cached item",
                    "ownerId": "member-a",
                    "stage": "script",
                    "updatedAt": 1000,
                }
                store.upsert_docs(collection, [stale])
                self.assertIn(stale["id"], stored_ids(store, collection))

                store.delete_doc(collection, stale["id"])
                self.assertNotIn(stale["id"], stored_ids(store, collection))

                resurrected = dict(stale, updatedAt=999999)
                store.upsert_docs(collection, [resurrected])
                self.assertNotIn(stale["id"], stored_ids(store, collection))

                fresh = dict(stale, id=f"{collection}-fresh", updatedAt=1001)
                store.upsert_docs(collection, [fresh])
                self.assertIn(fresh["id"], stored_ids(store, collection))


if __name__ == "__main__":
    unittest.main()
