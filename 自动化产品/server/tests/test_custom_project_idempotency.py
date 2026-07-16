import importlib.util
import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


TEST_DIR = Path(__file__).resolve().parent
SERVER_DIR = TEST_DIR.parent
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_store_tombstone import load_isolated_store


class CustomProjectIdempotencyTest(unittest.TestCase):
    def test_same_owner_kind_and_source_returns_existing_without_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            first, first_error = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "title": "原项目",
                "projectState": {
                    "integration": "infinite-canvas",
                    "sourceProjectId": "canvas-source-1",
                },
            })
            second, second_error = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "title": "并发标签页中的旧标题",
                "projectState": {
                    "integration": "infinite-canvas",
                    "sourceProjectId": "canvas-source-1",
                },
            })

            self.assertIsNone(first_error)
            self.assertIsNone(second_error)
            self.assertEqual(second["id"], first["id"])
            self.assertEqual(second["title"], "原项目")
            self.assertEqual(len(store.list_custom_projects("creator-a", "canvas")), 1)

    def test_workshop_and_source_keys_share_the_same_nonempty_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            mapped, mapped_error = store.save_custom_project("creator-a", {
                "kind": "video",
                "title": "视频工坊映射",
                "projectState": {"workshopProjectId": "workshop-42"},
            })
            retried, retry_error = store.save_custom_project("creator-a", {
                "kind": "video",
                "title": "发布页补建",
                "projectState": {"sourceProjectId": "workshop-42"},
            })

            self.assertIsNone(mapped_error)
            self.assertIsNone(retry_error)
            self.assertEqual(retried["id"], mapped["id"])
            self.assertEqual(len(store.list_custom_projects("creator-a", "video")), 1)

    def test_identity_does_not_cross_owner_or_kind_and_empty_source_is_not_deduplicated(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            canvas_a, _ = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "projectState": {"sourceProjectId": "shared-local-id"},
            })
            video_a, _ = store.save_custom_project("creator-a", {
                "kind": "video",
                "projectState": {"sourceProjectId": "shared-local-id"},
            })
            canvas_b, _ = store.save_custom_project("creator-b", {
                "kind": "canvas",
                "projectState": {"sourceProjectId": "shared-local-id"},
            })
            blank_a, _ = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "projectState": {"sourceProjectId": "  "},
            })
            blank_b, _ = store.save_custom_project("creator-a", {
                "kind": "canvas",
                "projectState": {},
            })

            self.assertEqual(len({canvas_a["id"], video_a["id"], canvas_b["id"]}), 3)
            self.assertNotEqual(blank_a["id"], blank_b["id"])
            self.assertEqual(len(store.list_custom_projects("creator-a", "canvas")), 3)
            self.assertEqual(len(store.list_custom_projects("creator-b", "canvas")), 1)

    def test_concurrent_creates_are_serialized_into_one_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ["DATA_DB"] = str(Path(tmp) / "data.sqlite")

            def load_store_copy(name):
                spec = importlib.util.spec_from_file_location(name, SERVER_DIR / "store.py")
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                return module

            # 两个模块实例拥有不同的 Python Lock，模拟两个服务进程共享同一个
            # SQLite 文件；最终只能依靠 BEGIN IMMEDIATE 串行化查询与插入。
            stores = [
                load_store_copy("custom_project_store_a"),
                load_store_copy("custom_project_store_b"),
            ]
            stores[0]._ensure_db()
            stores[1]._ensure_db()
            barrier = threading.Barrier(8)

            def create(index):
                barrier.wait(timeout=5)
                return stores[index % 2].save_custom_project("creator-a", {
                    "kind": "canvas",
                    "title": f"标签页 {index}",
                    "projectState": {"sourceProjectId": "canvas-concurrent"},
                })

            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(create, range(8)))

            self.assertTrue(all(error is None for _, error in results))
            self.assertEqual(len({item["id"] for item, _ in results}), 1)
            self.assertEqual(len(stores[0].list_custom_projects("creator-a", "canvas")), 1)


if __name__ == "__main__":
    unittest.main()
