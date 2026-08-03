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
        self.previous_upload = main.UPLOAD_DIR
        store.DB_PATH = Path(self.temp.name) / "community-security.sqlite"
        store._initialized = False
        main.COMPOSED_DIR = Path(self.temp.name) / "composed"
        main.UPLOAD_DIR = Path(self.temp.name) / "uploads"
        main.COMPOSED_DIR.mkdir(parents=True, exist_ok=True)
        main.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        main._VIDEO_PROJECT_INDEX_CACHE.clear()
        self.client = TestClient(main.app)

    def tearDown(self):
        self.client.close()
        main._VIDEO_PROJECT_INDEX_CACHE.clear()
        main.COMPOSED_DIR = self.previous_composed
        main.UPLOAD_DIR = self.previous_upload
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
        store.register_private_media(
            "composed",
            "author-final.mp4",
            author[0],
            provenance_kind="test-composed",
            provenance_id="project-author",
        )
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

    def test_media_registry_allows_same_team_but_denies_external_admin(self):
        store._ensure_db()
        with store._lock:
            conn = store._connect()
            try:
                for team_id, created_by in (
                    ("community-team-a", "community-owner-a"),
                    ("community-team-b", "community-admin-b"),
                ):
                    conn.execute(
                        "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at,created_by) "
                        "VALUES(?,?,?,?,?,?,?,?,?)",
                        (
                            team_id, team_id, team_id, "external", "active",
                            "team", "subscription", 1, created_by,
                        ),
                    )
                for member_id, role in (
                    ("community-owner-a", "editor"),
                    ("community-peer-a", "editor"),
                    ("community-admin-b", "admin"),
                ):
                    conn.execute(
                        "INSERT INTO members(id,name,username,username_key,pin_hash,role,parent_id,created_at) "
                        "VALUES(?,?,?,?,?,?,NULL,?)",
                        (
                            member_id, member_id, member_id, member_id,
                            store.DEFAULT_ADMIN_PIN_HASH, role, 1,
                        ),
                    )
                for team_id, member_id, team_role in (
                    ("community-team-a", "community-owner-a", "owner"),
                    ("community-team-a", "community-peer-a", "creator"),
                    ("community-team-b", "community-admin-b", "admin"),
                ):
                    conn.execute(
                        "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                        "VALUES(?,?,?,'active',1,?)",
                        (team_id, member_id, team_role, member_id),
                    )
                conn.commit()
            finally:
                conn.close()

        name = "community-owner-a--asset.png"
        (main.UPLOAD_DIR / name).write_bytes(b"image")
        store.register_private_media(
            "upload",
            name,
            "community-owner-a",
            provenance_kind="test-upload",
            provenance_id="asset-a",
        )
        media = [{"url": f"/api/files/{name}", "type": "image"}]
        owner = {"id": "community-owner-a", "role": "editor"}
        peer = {"id": "community-peer-a", "role": "editor"}
        external_admin = {"id": "community-admin-b", "role": "admin"}
        self.assertEqual(
            media[0]["url"],
            main._validate_community_media_owner(owner, media)[0]["url"],
        )
        self.assertEqual(
            media[0]["url"],
            main._validate_community_media_owner(peer, media)[0]["url"],
        )
        with self.assertRaises(HTTPException) as denied:
            main._validate_community_media_owner(external_admin, media)
        self.assertEqual(403, denied.exception.status_code)

        # Every private community-media namespace must reject the same
        # cross-tenant platform administrator before any source fallback can
        # accidentally act as a role-level bypass.
        for kind, key, url, media_type in (
            (
                "composed",
                "community-owner-a-final.mp4",
                "/api/video/composed/community-owner-a-final.mp4",
                "video",
            ),
            (
                "video-output",
                "project-a/final.mp4",
                "/custom-video/outputs/project-a/final.mp4",
                "video",
            ),
            (
                "canvas-blob",
                "a" * 64,
                f"/api/custom-canvas/blobs/{'a' * 64}",
                "image",
            ),
        ):
            store.register_private_media(
                kind,
                key,
                "community-owner-a",
                provenance_kind="test-private-media",
                provenance_id=key,
            )
            with self.subTest(kind=kind), self.assertRaises(HTTPException) as denied:
                main._validate_community_media_owner(
                    external_admin,
                    [{"url": url, "type": media_type}],
                )
            self.assertEqual(403, denied.exception.status_code)

    def test_local_legacy_media_fallback_is_owner_evidence_only(self):
        owner = {"id": "legacy-owner", "role": "editor"}
        outsider = {"id": "legacy-outsider", "role": "admin"}
        with patch.object(
            main.store, "private_media_access", return_value=(None, "unregistered"),
        ), patch.object(main, "_private_media_registry_enforced", return_value=False):
            legacy = main._private_media_access_or_404(
                "upload",
                "legacy-owner--asset.png",
                owner,
                legacy_authorizer=lambda: True,
            )
            self.assertTrue(legacy["legacy"])
            with self.assertRaises(HTTPException) as denied:
                main._private_media_access_or_404(
                    "upload",
                    "legacy-owner--asset.png",
                    outsider,
                    legacy_authorizer=lambda: False,
                )
            self.assertEqual(404, denied.exception.status_code)

        with patch.object(
            main.store, "private_media_access", return_value=(None, "unregistered"),
        ), patch.object(main, "_private_media_registry_enforced", return_value=True):
            with self.assertRaises(HTTPException) as strict:
                main._private_media_access_or_404(
                    "upload",
                    "legacy-owner--asset.png",
                    owner,
                    legacy_authorizer=lambda: True,
                )
            self.assertEqual(404, strict.exception.status_code)

    def test_private_media_readiness_is_audit_only_locally_and_strict_when_required(self):
        audit = {
            "ok": False,
            "dataMigration": False,
            "warnings": ["quarantinedFiles"],
        }
        with patch.object(
            main.store, "private_media_registry_status", return_value=audit,
        ), patch.object(
            main.runtime_config, "require_private_media_registry", return_value=False,
        ):
            local = main._private_media_registry_readiness()
        self.assertTrue(local["ok"])
        self.assertFalse(local["auditOk"])
        self.assertFalse(local["required"])
        self.assertFalse(local["dataMigration"])

        with patch.object(
            main.store, "private_media_registry_status", return_value=audit,
        ), patch.object(
            main.runtime_config, "require_private_media_registry", return_value=True,
        ):
            strict = main._private_media_registry_readiness()
        self.assertFalse(strict["ok"])
        self.assertFalse(strict["auditOk"])
        self.assertTrue(strict["required"])

    def test_file_delete_uses_registry_owner_and_restores_on_unregister_failure(self):
        manager = {"id": "team-manager", "role": "editor"}
        record = {"ownerId": "original-owner", "legacy": False}

        allowed = main.UPLOAD_DIR / "original-owner--allowed.png"
        allowed.write_bytes(b"asset")
        with patch.object(
            main, "_private_media_access_or_404", return_value=record,
        ), patch.object(
            main.store, "can_delete_asset_file", return_value=True,
        ), patch.object(
            main.store, "unregister_private_media", return_value=True,
        ) as unregister:
            self.assertTrue(main.file_delete(allowed.name, manager)["ok"])
        unregister.assert_called_once_with("upload", allowed.name, "original-owner")
        self.assertFalse(allowed.exists())

        external = main.UPLOAD_DIR / "original-owner--external.png"
        external.write_bytes(b"asset")
        with patch.object(
            main,
            "_private_media_access_or_404",
            side_effect=HTTPException(404, "媒体不存在或无权访问"),
        ):
            with self.assertRaises(HTTPException) as denied:
                main.file_delete(external.name, {"id": "external-admin", "role": "admin"})
        self.assertEqual(404, denied.exception.status_code)
        self.assertTrue(external.exists())

        recoverable = main.UPLOAD_DIR / "original-owner--recoverable.png"
        recoverable.write_bytes(b"asset")
        with patch.object(
            main, "_private_media_access_or_404", return_value=record,
        ), patch.object(
            main.store, "can_delete_asset_file", return_value=True,
        ), patch.object(
            main.store,
            "unregister_private_media",
            side_effect=RuntimeError("database busy"),
        ):
            with self.assertRaises(HTTPException) as failed:
                main.file_delete(recoverable.name, manager)
        self.assertEqual(503, failed.exception.status_code)
        self.assertTrue(recoverable.exists())

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

    def test_delivery_provenance_uses_authoritative_custom_source_fields(self):
        author = {"id": "author-a", "role": "editor", "teamId": "team-a"}
        request = main.CommunityPostReq(
            sourceKind="delivery",
            sourceId="delivery-a",
            # Client values are deliberately wrong; delivery/store data wins.
            sourceProjectId="spoofed-project",
            sourceOutputId="spoofed-output",
            sourceItemIds=["spoofed-item"],
        )
        delivery = {
            "id": "delivery-a",
            "delivered": True,
            "customOutputKind": "video",
            "customProjectId": "custom-project-a",
            "sourceOutputId": "output-a",
        }
        project = {"id": "custom-project-a", "ownerId": "author-a", "kind": "video"}
        with patch.object(
            store, "get_delivery_asset_for_member", return_value=(delivery, None),
        ), patch.object(
            store, "get_custom_project", return_value=(project, None),
        ), patch.object(
            store, "get_custom_output_by_source",
            return_value=({"sourceOutputId": "output-a"}, None),
        ):
            identity = main._community_verified_source_identity(author, request)
        self.assertEqual({
            "kind": "video",
            "projectId": "custom-project-a",
            "sourceOutputId": "output-a",
            "sourceItemIds": [],
        }, identity)

    def test_direct_video_and_canvas_sources_resolve_to_server_project_identity(self):
        author = {"id": "author-a", "role": "editor", "teamId": "team-a"}
        video_request = main.CommunityPostReq(
            sourceKind="video",
            sourceId="workshop-project-a",
            sourceProjectId="workshop-project-a",
            sourceOutputId="output-a",
            media=[{"url": "/custom-video/outputs/workshop-project-a/final.mp4", "type": "video"}],
        )
        with patch.object(
            main, "_video_workshop_owned_project",
            return_value={"id": "custom-video-a", "kind": "video"},
        ), patch.object(
            store, "get_custom_output_by_source",
            return_value=({
                "sourceOutputId": "output-a",
                "url": "/custom-video/outputs/workshop-project-a/final.mp4",
            }, None),
        ):
            video_identity = main._community_verified_source_identity(author, video_request)
        self.assertEqual("custom-video-a", video_identity["projectId"])
        self.assertEqual("output-a", video_identity["sourceOutputId"])

        canvas_request = main.CommunityPostReq(
            sourceKind="canvas",
            sourceId="canvas-source-a",
            sourceProjectId="canvas-source-a",
            sourceItemIds=["item-a"],
            # Direct sharing persists a newly flattened PNG.  Its content hash
            # need not equal the source image URL stored in the draft.
            media=[{"url": f"/api/custom-canvas/blobs/{'b' * 64}", "type": "image"}],
        )
        canvas_draft = {
            "project": {"customProjectId": "custom-canvas-a"},
            "state": {"items": [{
                "id": "item-a",
                "type": "image",
                "assetUrl": f"/api/custom-canvas/blobs/{'a' * 64}",
            }]},
        }
        with patch.object(
            store, "get_custom_canvas_draft", return_value=(canvas_draft, None),
        ):
            canvas_identity = main._community_verified_source_identity(author, canvas_request)
        self.assertEqual({
            "kind": "canvas",
            "projectId": "custom-canvas-a",
            "sourceOutputId": "",
            "sourceItemIds": ["item-a"],
        }, canvas_identity)

    def test_direct_provenance_rejects_media_from_another_owned_output(self):
        author = {"id": "author-a", "role": "editor", "teamId": "team-a"}
        request = main.CommunityPostReq(
            sourceKind="video",
            sourceId="workshop-project-a",
            sourceProjectId="workshop-project-a",
            sourceOutputId="output-a",
            media=[{"url": "/custom-video/outputs/workshop-project-a/other.mp4", "type": "video"}],
        )
        with patch.object(
            main, "_video_workshop_owned_project",
            return_value={"id": "custom-video-a", "kind": "video"},
        ), patch.object(
            store, "get_custom_output_by_source",
            return_value=({
                "sourceOutputId": "output-a",
                "url": "/custom-video/outputs/workshop-project-a/final.mp4",
            }, None),
        ):
            with self.assertRaises(HTTPException) as denied:
                main._community_verified_source_identity(author, request)
        self.assertEqual(400, denied.exception.status_code)

    def test_delivery_rejects_unknown_output_and_unrelated_media(self):
        author = {"id": "author-a", "role": "editor", "teamId": "team-a"}
        delivery = {
            "id": "delivery-a",
            "delivered": True,
            "customOutputKind": "video",
            "customProjectId": "custom-project-a",
            "sourceOutputId": "output-a",
            "sourceAssetId": "asset-video-a",
        }
        project = {"id": "custom-project-a", "ownerId": "author-a", "kind": "video"}

        unknown = main.CommunityPostReq(
            sourceKind="delivery",
            sourceId="delivery-a",
            media=[{"url": "/api/files/author-a--expected.mp4", "type": "video"}],
        )
        with patch.object(
            store, "get_delivery_asset_for_member", return_value=(delivery, None),
        ), patch.object(
            store, "get_custom_project", return_value=(project, None),
        ), patch.object(
            store, "get_custom_output_by_source", return_value=(None, "not_found"),
        ):
            with self.assertRaises(HTTPException) as denied:
                main._community_verified_source_identity(author, unknown)
        self.assertEqual(400, denied.exception.status_code)

        unrelated = main.CommunityPostReq(
            sourceKind="delivery",
            sourceId="delivery-a",
            media=[{"url": "/api/files/author-a--unrelated.mp4", "type": "video"}],
        )
        with patch.object(
            store, "get_delivery_asset_for_member", return_value=(delivery, None),
        ), patch.object(
            store, "get_custom_project", return_value=(project, None),
        ), patch.object(
            store, "get_custom_output_by_source",
            return_value=({"sourceOutputId": "output-a"}, None),
        ), patch.object(
            store, "community_delivery_media_urls",
            return_value={"/api/files/author-a--expected.mp4"},
        ):
            with self.assertRaises(HTTPException) as denied:
                main._community_verified_source_identity(author, unrelated)
        self.assertEqual(400, denied.exception.status_code)

    def test_supplier_cannot_share_delivery_to_community(self):
        supplier = store.add_member(
            "供应商", "community-supplier", "123456", "supplier_parent",
        )
        token = store.make_token(supplier[0])
        payload = {
            "sourceKind": "delivery",
            "sourceId": "delivery-a",
            "title": "不应分享",
            "category": "视频灵感",
            "media": [{
                "url": "/api/video/composed/supplier-visible.mp4",
                "type": "video",
            }],
        }
        for path in ("/api/community/status", "/api/community/posts"):
            response = self.client.post(
                path,
                headers={"Authorization": f"Bearer {token}"},
                json=payload,
            )
            self.assertEqual(403, response.status_code, path)

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
