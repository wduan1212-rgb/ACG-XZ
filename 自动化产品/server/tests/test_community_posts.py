import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path


SERVER_DIR = Path(__file__).resolve().parents[1]


def load_isolated_store(tmpdir):
    os.environ["DATA_DB"] = str(Path(tmpdir) / "community.sqlite")
    os.environ["CUSTOM_CANVAS_BLOB_DIR"] = str(Path(tmpdir) / "canvas-blobs")
    sys.modules.pop("store", None)
    if str(SERVER_DIR) not in sys.path:
        sys.path.insert(0, str(SERVER_DIR))
    return importlib.import_module("store")


class CommunityPostsTest(unittest.TestCase):
    def test_create_list_filter_and_soft_delete(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            visual = store.create_community_post(
                "member-a", "创作者 A", "team-a", "canvas", "canvas-1",
                "海报灵感", "文案", "蓝金流星提示词", "视觉设计",
                [{"url": f"/api/custom-canvas/blobs/{'a' * 64}", "type": "image", "width": 2048, "height": 1152}],
            )
            video = store.create_community_post(
                "member-b", "创作者 B", "", "video", "video-1",
                "视频灵感", "视频文案", "", "视频灵感",
                [{"url": "/custom-video/outputs/project-a/final.mp4", "type": "video", "width": 1920, "height": 1080}],
            )

            page = store.list_community_posts(limit=20)
            self.assertEqual(2, len(page["items"]))
            self.assertEqual({visual["id"], video["id"]}, {item["id"] for item in page["items"]})
            visual_page = store.list_community_posts(category="视觉设计", limit=20)
            self.assertEqual([visual["id"]], [item["id"] for item in visual_page["items"]])
            self.assertEqual(2048, visual_page["items"][0]["media"][0]["width"])

            self.assertTrue(store.delete_community_post(visual["id"]))
            self.assertIsNone(store.get_community_post(visual["id"]))
            self.assertEqual("deleted", store.get_community_post(visual["id"], include_non_published=True)["status"])

    def test_rejects_ephemeral_base64_and_external_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            for url in ("data:image/png;base64,AAAA", "blob:https://example.test/id", "https://example.test/x.png"):
                with self.assertRaisesRegex(ValueError, "community_media_required"):
                    store.create_community_post(
                        "member-a", "A", "", "canvas", "canvas-1", "不应公开", "", "", "视觉设计",
                        [{"url": url, "type": "image"}],
                    )

    def test_media_allowlist_rejects_ambiguous_or_traversal_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            valid = (
                f"/api/custom-canvas/blobs/{'b' * 64}",
                "/api/files/member-a--asset.png",
                "/api/video/composed/final-cut.mp4",
                "/custom-video/outputs/project-a/final.mp4",
            )
            self.assertEqual(list(valid), [store.normalize_community_media_url(url) for url in valid])
            invalid = (
                "/api/files/../private.env",
                "/api/files/final.mp4?token=secret",
                "/api/files/folder/file.png",
                "/api/files/%2e%2e/private.env",
                "/api/video/composed/../other.mp4",
                "/custom-video/outputs/project-a/../other/final.mp4",
                "https://example.test/api/files/a.png",
            )
            self.assertEqual(["" for _ in invalid], [store.normalize_community_media_url(url) for url in invalid])

    def test_share_is_idempotent_and_favorites_are_member_scoped(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            media = [{"url": f"/api/custom-canvas/blobs/{'d' * 64}", "type": "image"}]
            first = store.create_community_post(
                "member-a", "创作者 A", "team-a", "canvas", "canvas-1",
                "不重复的灵感", "", "", "视觉设计", media,
            )
            second = store.create_community_post(
                "member-a", "创作者 A", "team-a", "canvas", "canvas-1",
                "不重复的灵感", "", "", "视觉设计", media,
            )
            self.assertEqual(first["id"], second["id"])
            self.assertTrue(store.community_post_status(
                "member-a", "canvas", "canvas-1", media,
            )["shared"])

            store.set_community_reaction(first["id"], "viewer-a", favorited=True)
            self.assertEqual(
                [first["id"]],
                [item["id"] for item in store.list_community_favorites("viewer-a")["items"]],
            )
            self.assertEqual([], store.list_community_favorites("viewer-b")["items"])


if __name__ == "__main__":
    unittest.main()
