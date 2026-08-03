import importlib
import os
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
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

    def test_url_fallback_ignores_client_media_type_and_keeps_twenty_items(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            twenty = [
                {"url": f"/api/files/member-a--gallery-{index:02d}.png", "type": "image"}
                for index in range(20)
            ]
            self.assertEqual(20, len(store.normalize_community_media(twenty)))

            url = "/api/files/member-a--same-output.bin"
            first = store.create_community_post(
                "member-a", "A", "", "delivery", "delivery-image",
                "同一文件", "", "", "视觉设计", [{"url": url, "type": "image"}],
            )
            relabelled = store.create_community_post(
                "member-a", "A", "", "delivery", "delivery-video",
                "不应重复", "", "", "视频灵感", [{"url": url, "type": "video"}],
            )
            self.assertEqual(first["id"], relabelled["id"])
            self.assertTrue(relabelled["alreadyShared"])

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
            self.assertTrue(second["alreadyShared"])
            self.assertTrue(store.community_post_status(
                "member-a", "canvas", "canvas-1", media,
            )["shared"])

            # 同一持久化成果从另一产品入口（例如发布清单）发起时，
            # 仍应命中原帖，不能因 sourceKind/sourceId 不同重复发布。
            cross_surface = store.create_community_post(
                "member-a", "创作者 A", "team-a", "delivery", "asset-1",
                "来自发布清单", "", "", "视觉设计", media,
            )
            self.assertEqual(first["id"], cross_surface["id"])
            self.assertTrue(cross_surface["alreadyShared"])
            self.assertTrue(store.community_post_status(
                "member-a", "delivery", "asset-1", media,
            )["shared"])

            store.set_community_reaction(first["id"], "viewer-a", favorited=True)
            self.assertEqual(
                [first["id"]],
                [item["id"] for item in store.list_community_favorites("viewer-a")["items"]],
            )
            self.assertEqual([], store.list_community_favorites("viewer-b")["items"])

    def test_cross_surface_identity_ignores_dimensions_alt_cover_and_gallery_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            first_url = f"/api/custom-canvas/blobs/{'e' * 64}"
            second_url = "/api/files/member-a--second.png"
            original = [
                {"url": first_url, "type": "image", "width": 1200, "height": 1600, "alt": "画布"},
                {"url": second_url, "type": "image", "width": 1600, "height": 1200},
            ]
            post = store.create_community_post(
                "member-a", "创作者 A", "team-a", "canvas", "canvas-2",
                "多图成果", "", "", "视觉设计", original,
                cover={"url": first_url, "type": "image"},
            )

            # 发布清单会补全另一套尺寸、标题和封面，并可能调整图集顺序；
            # 只要媒体本体相同，就必须返回原帖并阻止二次分享。
            delivery_variant = [
                {"url": second_url, "type": "image", "width": 0, "height": 0, "alt": "发布图 2"},
                {"url": first_url, "type": "image", "width": 2048, "height": 2732, "alt": "发布图 1"},
            ]
            repeated = store.create_community_post(
                "member-a", "创作者 A", "team-a", "delivery", "delivery-2",
                "不同入口标题", "不同入口文案", "", "视觉设计", delivery_variant,
                cover={"url": second_url, "type": "image"},
            )
            self.assertEqual(post["id"], repeated["id"])
            self.assertTrue(repeated["alreadyShared"])
            self.assertTrue(store.community_post_status(
                "member-a", "delivery", "delivery-2", delivery_variant,
                cover={"url": second_url, "type": "image"},
            )["shared"])

    def test_gallery_and_single_item_provenance_are_idempotent_in_both_directions(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            project_id = "custom-canvas-gallery"
            gallery_identity = {
                "kind": "canvas",
                "projectId": project_id,
                "sourceItemIds": ["item-a", "item-b"],
            }
            gallery = store.create_community_post(
                "member-gallery", "图集作者", "team-a", "delivery", "delivery-gallery",
                "A+B 图集", "", "", "视觉设计",
                [
                    {"url": f"/api/custom-canvas/blobs/{'1' * 64}", "type": "image"},
                    {"url": f"/api/custom-canvas/blobs/{'2' * 64}", "type": "image"},
                ],
                source_identity=gallery_identity,
            )
            for item_id, suffix in (("item-a", "a"), ("item-b", "b")):
                single_identity = {
                    "kind": "canvas",
                    "projectId": project_id,
                    "sourceItemIds": [item_id],
                }
                materialized = [{
                    "url": f"/api/files/member-gallery--materialized-{suffix}.png",
                    "type": "image",
                }]
                self.assertTrue(store.community_post_status(
                    "member-gallery", "canvas", project_id, materialized,
                    source_identity=single_identity,
                )["shared"])
                repeated = store.create_community_post(
                    "member-gallery", "图集作者", "team-a", "canvas", project_id,
                    f"单图 {suffix}", "", "", "视觉设计", materialized,
                    source_identity=single_identity,
                )
                self.assertEqual(gallery["id"], repeated["id"])

            # Reverse direction: either individual item makes an overlapping
            # gallery resolve to that existing post, even under new media URLs.
            for index, first_item in enumerate(("item-a", "item-b"), start=1):
                author = f"member-reverse-{index}"
                reverse_project = f"custom-canvas-reverse-{index}"
                single = store.create_community_post(
                    author, "单图作者", "team-a", "canvas", reverse_project,
                    "先分享单图", "", "", "视觉设计",
                    [{"url": f"/api/files/{author}--single.png", "type": "image"}],
                    source_identity={
                        "kind": "canvas",
                        "projectId": reverse_project,
                        "sourceItemIds": [first_item],
                    },
                )
                reverse_gallery_identity = {
                    "kind": "canvas",
                    "projectId": reverse_project,
                    "sourceItemIds": ["item-a", "item-b"],
                }
                reverse_media = [
                    {"url": f"/api/files/{author}--gallery-a.png", "type": "image"},
                    {"url": f"/api/files/{author}--gallery-b.png", "type": "image"},
                ]
                self.assertTrue(store.community_post_status(
                    author, "delivery", f"delivery-reverse-{index}", reverse_media,
                    source_identity=reverse_gallery_identity,
                )["shared"])
                repeated = store.create_community_post(
                    author, "单图作者", "team-a", "delivery", f"delivery-reverse-{index}",
                    "后分享图集", "", "", "视觉设计", reverse_media,
                    source_identity=reverse_gallery_identity,
                )
                self.assertEqual(single["id"], repeated["id"])

    def test_verified_provenance_reuses_post_across_different_media_urls(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            identity = {
                "kind": "video",
                "projectId": "custom-video-project-a",
                "sourceOutputId": "output-a",
            }
            workshop = store.create_community_post(
                "member-a", "创作者 A", "team-a", "video", "workshop-project-a",
                "工坊成片", "", "", "视频灵感",
                [{"url": "/custom-video/outputs/project-a/final.mp4", "type": "video"}],
                source_identity=identity,
            )
            delivery = store.create_community_post(
                "member-a", "创作者 A", "team-a", "delivery", "delivery-a",
                "物化后的发布成片", "", "", "视频灵感",
                [{"url": "/api/video/composed/materialized-final.mp4", "type": "video"}],
                source_identity=identity,
            )
            self.assertEqual(workshop["id"], delivery["id"])
            self.assertTrue(delivery["alreadyShared"])
            self.assertTrue(store.community_post_status(
                "member-a", "delivery", "delivery-a",
                [{"url": "/api/video/composed/materialized-final.mp4", "type": "video"}],
                source_identity=identity,
            )["shared"])

            # 幂等仍按原创作者隔离；管理员代分享不会把署名归到管理员。
            another_author = store.create_community_post(
                "member-b", "创作者 B", "team-a", "delivery", "delivery-b",
                "另一位原创作者", "", "", "视频灵感",
                [{"url": "/api/video/composed/materialized-final.mp4", "type": "video"}],
                source_identity=identity,
            )
            self.assertNotEqual(workshop["id"], another_author["id"])
            self.assertEqual("member-b", another_author["authorId"])

    def test_legacy_url_only_post_is_still_detected_by_new_source_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            media = [{"url": f"/api/custom-canvas/blobs/{'f' * 64}", "type": "image"}]
            legacy = store.create_community_post(
                "member-a", "创作者 A", "team-a", "canvas", "legacy-canvas",
                "旧 URL 帖子", "", "", "视觉设计", media,
            )
            # v133/v134 rows stored the unprefixed SHA-256 identity.
            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "UPDATE community_posts SET identity_key=? WHERE id=?",
                        (store.community_media_fingerprint(media), legacy["id"]),
                    )
                    conn.execute(
                        "DELETE FROM community_post_identities WHERE post_id=?",
                        (legacy["id"],),
                    )
                    conn.commit()
                finally:
                    conn.close()
            recovered = store.create_community_post(
                "member-a", "创作者 A", "team-a", "delivery", "delivery-new",
                "新来源身份", "", "", "视觉设计", media,
                source_identity={
                    "kind": "canvas",
                    "projectId": "custom-canvas-a",
                    "sourceItemIds": ["item-a"],
                },
            )
            self.assertEqual(legacy["id"], recovered["id"])
            self.assertTrue(recovered["alreadyShared"])

            # The legacy match must bind the verified primary source key.  A
            # later surface may materialize the same output under another URL.
            moved = store.create_community_post(
                "member-a", "创作者 A", "team-a", "canvas", "canvas-new",
                "同来源异 URL", "", "", "视觉设计",
                [{"url": "/api/files/member-a--legacy-materialized.png", "type": "image"}],
                source_identity={
                    "kind": "canvas",
                    "projectId": "custom-canvas-a",
                    "sourceItemIds": ["item-a"],
                },
            )
            self.assertEqual(legacy["id"], moved["id"])
            self.assertTrue(moved["alreadyShared"])

    def test_stale_identity_aliases_do_not_block_reshare(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            for mode in ("deleted", "missing"):
                author = f"member-{mode}"
                identity = {
                    "kind": "video",
                    "projectId": f"project-{mode}",
                    "sourceOutputId": "output-a",
                }
                original = store.create_community_post(
                    author, "作者", "", "video", f"workshop-{mode}",
                    "原帖", "", "", "视频灵感",
                    [{"url": f"/custom-video/outputs/{mode}/original.mp4", "type": "video"}],
                    source_identity=identity,
                )
                with store._lock:
                    conn = store._connect()
                    try:
                        if mode == "deleted":
                            conn.execute(
                                "UPDATE community_posts SET status='deleted' WHERE id=?",
                                (original["id"],),
                            )
                        else:
                            conn.execute(
                                "DELETE FROM community_posts WHERE id=?",
                                (original["id"],),
                            )
                        aliases = conn.execute(
                            "SELECT COUNT(*) FROM community_post_identities WHERE post_id=?",
                            (original["id"],),
                        ).fetchone()[0]
                        conn.commit()
                    finally:
                        conn.close()
                self.assertGreater(aliases, 0)

                replacement = store.create_community_post(
                    author, "作者", "", "delivery", f"delivery-{mode}",
                    "重新分享", "", "", "视频灵感",
                    [{"url": f"/api/video/composed/{mode}-replacement.mp4", "type": "video"}],
                    source_identity=identity,
                )
                self.assertNotEqual(original["id"], replacement["id"])
                self.assertFalse(replacement.get("alreadyShared", False))

    def test_two_independent_store_connections_cannot_create_duplicate_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            first_store = load_isolated_store(tmp)
            first_store._ensure_db()
            second_store = load_isolated_store(tmp)
            second_store._ensure_db()
            barrier = threading.Barrier(2)
            identity = {
                "kind": "video",
                "projectId": "custom-video-concurrent",
                "sourceOutputId": "output-concurrent",
            }

            def submit(module, source_kind, source_id, url):
                barrier.wait(timeout=5)
                return module.create_community_post(
                    "member-a", "创作者 A", "team-a", source_kind, source_id,
                    "并发分享", "", "", "视频灵感",
                    [{"url": url, "type": "video"}],
                    source_identity=identity,
                )

            with ThreadPoolExecutor(max_workers=2) as pool:
                results = list(pool.map(
                    lambda args: submit(*args),
                    [
                        (first_store, "video", "workshop-a", "/custom-video/outputs/a/final.mp4"),
                        (second_store, "delivery", "delivery-a", "/api/video/composed/final-a.mp4"),
                    ],
                ))
            self.assertEqual(results[0]["id"], results[1]["id"])
            self.assertEqual(1, len(first_store.list_community_posts(limit=10)["items"]))


if __name__ == "__main__":
    unittest.main()
