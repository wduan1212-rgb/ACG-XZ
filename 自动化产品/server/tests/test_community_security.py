import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from server import main, store


class CommunitySecurityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_db = store.DB_PATH
        self.previous_initialized = store._initialized
        self.previous_composed = main.COMPOSED_DIR
        store.DB_PATH = Path(self.temp.name) / "community-security.sqlite"
        store._initialized = False
        main.COMPOSED_DIR = Path(self.temp.name) / "composed"
        main.COMPOSED_DIR.mkdir(parents=True, exist_ok=True)
        main._VIDEO_PROJECT_INDEX_CACHE.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        main._VIDEO_PROJECT_INDEX_CACHE.clear()
        main.COMPOSED_DIR = self.previous_composed
        store.DB_PATH = self.previous_db
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def test_delete_scope_is_author_platform_admin_or_same_team_manager_only(self):
        post = {"authorId": "author-a", "teamId": "team-a"}
        self.assertTrue(main._can_delete_community_post(post, {"id": "author-a", "role": "user"}))
        self.assertTrue(main._can_delete_community_post(post, {"id": "platform", "role": "admin"}))
        for role in ("owner", "admin"):
            self.assertTrue(main._can_delete_community_post(post, {
                "id": f"manager-{role}", "role": "editor", "teamId": "team-a",
                "team": {"role": role},
            }))
        self.assertFalse(main._can_delete_community_post(post, {
            "id": "other-team-admin", "role": "editor", "teamId": "team-b",
            "team": {"role": "admin"},
        }))
        self.assertFalse(main._can_delete_community_post(post, {
            "id": "same-team-creator", "role": "editor", "teamId": "team-a",
            "team": {"role": "creator"},
        }))

    def test_composed_media_must_be_referenced_by_members_own_video_project(self):
        author = store.add_member("作者", "community-author", "123456", "user")
        attacker = store.add_member("其他用户", "community-attacker", "123456", "user")
        url = "/api/video/composed/author-final.mp4"
        (main.COMPOSED_DIR / "author-final.mp4").write_bytes(b"video")
        project, error = store.sync_custom_video_project(author[0], {
            "id": "project-author",
            "name": "作者视频",
            "status": "succeeded",
            "outputs": [{"id": "out-a", "url": url, "downloadUrl": url}],
        })
        self.assertIsNone(error)
        self.assertTrue(project)
        main._VIDEO_PROJECT_INDEX_CACHE.clear()

        media = [{"url": url, "type": "video"}]
        clean = main._validate_community_media_owner(
            store.member_public(author), media, "video", "project-author",
        )
        self.assertEqual(url, clean[0]["url"])
        with self.assertRaises(HTTPException) as denied:
            main._validate_community_media_owner(
                store.member_public(attacker), media, "video", "project-author",
            )
        self.assertEqual(403, denied.exception.status_code)

    def test_guests_can_read_but_cannot_create_or_delete(self):
        post = store.create_community_post(
            "member-a", "创作者 A", "", "canvas", "canvas-1", "公开灵感",
            "", "", "视觉设计",
            [{"url": f"/api/custom-canvas/blobs/{'c' * 64}", "type": "image"}],
        )
        self.assertEqual(200, self.client.get("/api/community/posts").status_code)
        self.assertEqual(200, self.client.get(f"/api/community/posts/{post['id']}").status_code)
        create = self.client.post("/api/community/posts", json={
            "sourceKind": "canvas", "sourceId": "canvas-1", "title": "越权发布",
            "category": "视觉设计",
            "media": [{"url": f"/api/custom-canvas/blobs/{'c' * 64}", "type": "image"}],
        })
        self.assertEqual(401, create.status_code)
        self.assertEqual(401, self.client.delete(f"/api/community/posts/{post['id']}").status_code)

    def test_team_manager_may_share_for_member_but_keeps_original_author(self):
        manager = {
            "id": "manager-a", "role": "editor", "teamId": "team-a",
            "team": {"id": "team-a", "name": "ACG市场部", "role": "admin"},
        }
        author = {
            "id": "author-a", "name": "原创作者", "role": "editor", "teamId": "team-a",
            "team": {"id": "team-a", "name": "ACG市场部", "role": "creator"},
        }
        with patch.object(store, "get_member", return_value=("author-row",)), patch.object(
            store, "member_public", return_value=author,
        ):
            delegated = main._community_share_author(manager, "author-a")
        self.assertEqual("author-a", delegated["id"])
        self.assertEqual("原创作者", delegated["name"])
        self.assertEqual("team-a", delegated["teamId"])

    def test_ordinary_member_cannot_share_another_members_work(self):
        creator = {
            "id": "creator-a", "role": "editor", "teamId": "team-a",
            "team": {"id": "team-a", "name": "ACG市场部", "role": "creator"},
        }
        author = {
            "id": "author-a", "name": "原创作者", "role": "editor", "teamId": "team-a",
            "team": {"id": "team-a", "name": "ACG市场部", "role": "creator"},
        }
        with patch.object(store, "get_member", return_value=("author-row",)), patch.object(
            store, "member_public", return_value=author,
        ):
            with self.assertRaises(HTTPException) as denied:
                main._community_share_author(creator, "author-a")
        self.assertEqual(403, denied.exception.status_code)


if __name__ == "__main__":
    unittest.main()
