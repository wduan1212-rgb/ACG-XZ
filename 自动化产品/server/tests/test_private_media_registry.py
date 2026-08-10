import importlib
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from unittest.mock import patch

from starlette.requests import Request

from server.tests.test_runtime_bootstrap_safety import (
    current_backup_binding,
    logical_database_dump,
)


SERVER_DIR = Path(__file__).resolve().parents[1]


def load_media_store(tmpdir):
    root = Path(tmpdir)
    paths = {
        "DATA_DB": root / "data.sqlite",
        "UPLOAD_DIR": root / "uploads",
        "COMPOSED_DIR": root / "composed",
        "CUSTOM_CANVAS_BLOB_DIR": root / "canvas-blobs",
        "VIDEO_WORKSHOP_ROOT": root / "video-workshop",
        "VIDEO_WORKSHOP_OUTPUT_DIR": root / "video-workshop" / "outputs",
        "VIDEO_WORKSHOP_UPLOAD_DIR": root / "video-workshop" / "uploads",
    }
    for name, value in paths.items():
        os.environ[name] = str(value)
    for name in ("UPLOAD_DIR", "COMPOSED_DIR", "CUSTOM_CANVAS_BLOB_DIR", "VIDEO_WORKSHOP_OUTPUT_DIR", "VIDEO_WORKSHOP_UPLOAD_DIR"):
        paths[name].mkdir(parents=True, exist_ok=True)
    sys.modules.pop("store", None)
    if str(SERVER_DIR) not in sys.path:
        sys.path.insert(0, str(SERVER_DIR))
    store = importlib.import_module("store")
    store._ensure_db()
    with store._lock:
        conn = store._connect()
        try:
            now = 1
            conn.execute(
                "INSERT OR IGNORE INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at,created_by) "
                "VALUES('team-a','A','a','external','active','team','subscription',1,'owner-a')"
            )
            conn.execute(
                "INSERT OR IGNORE INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at,created_by) "
                "VALUES('team-b','B','b','external','active','team','subscription',1,'admin-b')"
            )
            for member_id, role in (("owner-a", "editor"), ("peer-a", "editor"), ("admin-b", "admin")):
                conn.execute(
                    "INSERT OR IGNORE INTO members(id,name,username,username_key,pin_hash,role,parent_id,created_at) "
                    "VALUES(?,?,?,?,?,?,NULL,?)",
                    (member_id, member_id, member_id, member_id, store.DEFAULT_ADMIN_PIN_HASH, role, now),
                )
            conn.execute(
                "INSERT OR IGNORE INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                "VALUES('team-a','owner-a','owner','active',1,'owner-a')"
            )
            conn.execute(
                "INSERT OR IGNORE INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                "VALUES('team-a','peer-a','creator','active',1,'owner-a')"
            )
            conn.execute(
                "INSERT OR IGNORE INTO team_members(team_id,member_id,team_role,status,joined_at,added_by) "
                "VALUES('team-b','admin-b','owner','active',1,'admin-b')"
            )
            conn.commit()
        finally:
            conn.close()
    return store, paths


def request_with_range(value="bytes=1-3"):
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": [(b"range", value.encode("ascii"))],
        "query_string": b"",
        "scheme": "http",
        "server": ("test", 80),
        "client": ("test", 1),
    })


def runtime_snapshot_binding(digest, media_inventory_digest):
    return {
        "format": "acg-runtime-snapshot-binding-v1",
        "verified": True,
        "profile": "acg-production-complete-v1",
        "manifestSha256": digest,
        "componentNames": sorted({
            "database", "legacy-data", "uploads", "composed", "canvas-blobs",
            "model-usage-spool", "server-logs", "video-projects",
            "video-uploads", "video-outputs", "bgm-library", "model-cache",
            "runtime-env-public", "runtime-env-private", "runtime-env-v140",
            "systemd-main", "systemd-video", "systemd-main-dropins",
            "systemd-video-dropins", "nginx-site",
        }),
        "mediaInventoryDigest": media_inventory_digest,
    }


def write_media_override(
    store,
    path,
    identity,
    backup_binding,
    inventory_digest,
    snapshot_digest,
    snapshot_media_digest,
    entries,
    *,
    manifest_overrides=None,
):
    payload = {
        "format": store.PRIVATE_MEDIA_OVERRIDE_MANIFEST_FORMAT,
        "databaseIdentity": identity,
        "databasePathSha256": backup_binding["sourcePathSha256"],
        "databaseLogicalSha256": backup_binding["sourceLogicalSha256"],
        "schemaVersion": backup_binding["sourceSchemaVersion"],
        "userVersion": backup_binding["sourceUserVersion"],
        "backupManifestSha256": backup_binding["manifestSha256"],
        "privateMediaSchemaVersion": store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
        "privateMediaDataVersion": store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
        "inventoryDigest": inventory_digest,
        "snapshotManifestSha256": snapshot_digest,
        "snapshotMediaInventoryDigest": snapshot_media_digest,
        "entries": entries,
    }
    payload.update(manifest_overrides or {})
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    path.write_bytes(encoded)
    return hashlib.sha256(encoded).hexdigest()


class PrivateMediaRegistryTest(unittest.TestCase):
    def test_provider_media_url_is_signed_registered_and_range_readable(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            name = "owner-a--digital-human-reference.png"
            (paths["UPLOAD_DIR"] / name).write_bytes(b"reference-image")
            store.register_private_media(
                "upload",
                name,
                "owner-a",
                team_id="team-a",
                provenance_kind="asset",
                provenance_id="digital-human-reference",
            )

            main = importlib.import_module("main")
            with patch.object(main, "store", store), patch.object(
                main, "UPLOAD_DIR", paths["UPLOAD_DIR"]
            ), patch.object(main, "PUBLIC_BASE_URL", "https://media.example.test"):
                signed_url = main._ref_url(main.VideoRef(
                    url=f"/api/files/{name}?asset_rev=9",
                ))
                parsed = urlparse(signed_url)
                query = parse_qs(parsed.query)
                self.assertEqual("media.example.test", parsed.netloc)
                self.assertEqual(
                    f"/api/provider-media/upload/{name}",
                    unquote(parsed.path),
                )
                self.assertNotIn("asset_rev", query)
                self.assertEqual(1, len(query.get("expires", [])))
                self.assertEqual(1, len(query.get("sig", [])))

                response = main.provider_upload_get(
                    name,
                    request_with_range("bytes=0-8"),
                    expires=int(query["expires"][0]),
                    sig=query["sig"][0],
                )
                self.assertEqual(206, response.status_code)
                self.assertEqual("bytes 0-8/15", response.headers["content-range"])
                with self.assertRaises(Exception):
                    main.provider_upload_get(
                        name,
                        request_with_range("bytes=0-8"),
                        expires=int(query["expires"][0]),
                        sig="tampered",
                    )

    def test_supplier_delivery_linked_reads_are_exact_and_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            parent = store.add_member(
                "A supplier", "delivery_media_parent", "local-test-pin", "supplier_parent"
            )
            other_parent = store.add_member(
                "B supplier", "delivery_media_other", "local-test-pin", "supplier_parent"
            )
            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "INSERT INTO team_suppliers(team_id,supplier_parent_id,created_at,added_by) "
                        "VALUES('team-a',?,?,?)",
                        (parent[0], 1, "owner-a"),
                    )
                    conn.execute(
                        "INSERT INTO team_suppliers(team_id,supplier_parent_id,created_at,added_by) "
                        "VALUES('team-b',?,?,?)",
                        (other_parent[0], 1, "admin-b"),
                    )
                    conn.commit()
                finally:
                    conn.close()
            child = store.create_supplier_children(parent[0], [{
                "name": "A child",
                "username": "delivery_media_child",
                "pin": "local-test-pin",
            }])[0]
            unbound_child = store.create_supplier_children(parent[0], [{
                "name": "A unbound child",
                "username": "delivery_media_unbound",
                "pin": "local-test-pin",
            }])[0]

            store.upsert_member_collection("owner-a", "editor", "accounts", [{
                "id": "account-delivery-a",
                "name": "Delivery account",
                "mode": "图文",
                "updatedAt": 1,
            }])
            pack_name = "owner-a--delivery-pack.png"
            unrelated_name = "owner-a--private-other.png"
            composed_name = "delivery-final.mp4"
            workshop_key = "workshop-a/delivery-final.mp4"
            store.upsert_docs("assets", [
                {
                    "id": "pack-asset-a",
                    "ownerId": "owner-a",
                    "accountId": "account-delivery-a",
                    "type": "图片",
                    "serverFileName": pack_name,
                    "fileUrl": f"/api/files/{pack_name}",
                    "updatedAt": 1,
                },
                {
                    "id": "private-asset-a",
                    "ownerId": "owner-a",
                    "accountId": "account-delivery-a",
                    "type": "图片",
                    "serverFileName": unrelated_name,
                    "fileUrl": f"/api/files/{unrelated_name}",
                    "updatedAt": 1,
                },
                {
                    "id": "delivery-images-a",
                    "ownerId": "owner-a",
                    "byMemberId": "owner-a",
                    "accountId": "account-delivery-a",
                    "type": "图集",
                    "delivered": True,
                    "coverAssetId": "pack-asset-a",
                    "packAssetIds": ["pack-asset-a"],
                    "updatedAt": 1,
                },
                {
                    "id": "delivery-video-a",
                    "ownerId": "owner-a",
                    "byMemberId": "owner-a",
                    "accountId": "account-delivery-a",
                    "type": "视频",
                    "delivered": True,
                    "videoUrl": f"/api/video/composed/{composed_name}",
                    "updatedAt": 1,
                },
                {
                    "id": "delivery-workshop-video-a",
                    "ownerId": "owner-a",
                    "byMemberId": "owner-a",
                    "accountId": "account-delivery-a",
                    "type": "视频",
                    "delivered": True,
                    "videoUrl": f"/custom-video/outputs/{workshop_key}",
                    "updatedAt": 1,
                },
            ])
            self.assertTrue(store.set_supplier_child_accounts(
                parent[0], child["id"], ["account-delivery-a"], parent[0], include_all=True,
            ))

            (paths["UPLOAD_DIR"] / pack_name).write_bytes(b"pack-image")
            (paths["UPLOAD_DIR"] / unrelated_name).write_bytes(b"private-image")
            (paths["COMPOSED_DIR"] / composed_name).write_bytes(b"final-video")
            workshop_output = paths["VIDEO_WORKSHOP_OUTPUT_DIR"] / workshop_key
            workshop_output.parent.mkdir(parents=True, exist_ok=True)
            workshop_output.write_bytes(b"workshop-video")
            store.register_private_media(
                "upload", pack_name, "owner-a", team_id="team-a",
                provenance_kind="asset", provenance_id="pack-asset-a",
            )
            store.register_private_media(
                "upload", unrelated_name, "owner-a", team_id="team-a",
                provenance_kind="asset", provenance_id="private-asset-a",
            )
            store.register_private_media(
                "composed", composed_name, "owner-a", team_id="team-a",
                provenance_kind="video-compose", provenance_id="compose-delivery-a",
            )
            store.register_private_media(
                "video-output", workshop_key, "owner-a", team_id="team-a",
                provenance_kind="video-workshop-project", provenance_id="workshop-a",
            )

            for requester in (parent[0], child["id"]):
                image, image_error = store.private_media_access(
                    "upload", pack_name, requester, "delivery-images-a"
                )
                self.assertIsNone(image_error)
                self.assertEqual("supplier-delivery", image["accessVia"])
                video, video_error = store.private_media_access(
                    "composed", composed_name, requester, "delivery-video-a"
                )
                self.assertIsNone(video_error)
                self.assertEqual("supplier-delivery", video["accessVia"])
                workshop, workshop_error = store.private_media_access(
                    "video-output", workshop_key, requester,
                    "delivery-workshop-video-a",
                )
                self.assertIsNone(workshop_error)
                self.assertEqual("supplier-delivery", workshop["accessVia"])

            self.assertEqual(
                "forbidden",
                store.private_media_access("upload", pack_name, parent[0])[1],
            )
            self.assertEqual(
                "forbidden",
                store.private_media_access(
                    "upload", unrelated_name, parent[0], "delivery-images-a"
                )[1],
            )
            self.assertEqual(
                "forbidden",
                store.private_media_access(
                    "upload", pack_name, unbound_child["id"], "delivery-images-a"
                )[1],
            )
            self.assertEqual(
                "forbidden",
                store.private_media_access(
                    "upload", pack_name, other_parent[0], "delivery-images-a"
                )[1],
            )
            with patch.dict(os.environ, {
                "PUBLIC_BASE_URL": "https://media.example.test",
            }, clear=False):
                store.upsert_docs("assets", [{
                    "id": "delivery-approved-origin-a",
                    "ownerId": "owner-a",
                    "byMemberId": "owner-a",
                    "accountId": "account-delivery-a",
                    "type": "视频",
                    "delivered": True,
                    "videoUrl": (
                        "https://media.example.test/api/video/composed/"
                        f"{composed_name}"
                    ),
                    "updatedAt": 2,
                }])
                approved, approved_error = store.private_media_access(
                    "composed", composed_name, parent[0],
                    "delivery-approved-origin-a",
                )
                self.assertIsNone(approved_error)
                self.assertEqual("supplier-delivery", approved["accessVia"])
            store.upsert_docs("assets", [{
                "id": "delivery-forged-origin-a",
                "ownerId": "owner-a",
                "byMemberId": "owner-a",
                "accountId": "account-delivery-a",
                "type": "视频",
                "delivered": True,
                "videoUrl": (
                    "https://attacker.example/api/video/composed/"
                    f"{composed_name}"
                ),
                "updatedAt": 3,
            }])
            self.assertEqual(
                "forbidden",
                store.private_media_access(
                    "composed", composed_name, parent[0],
                    "delivery-forged-origin-a",
                )[1],
            )
            self.assertFalse(store.can_write_asset_file(
                "pack-asset-a", parent[0], "supplier_parent"
            ))

            main = importlib.import_module("main")
            with patch.object(main, "store", store), patch.object(
                main, "UPLOAD_DIR", paths["UPLOAD_DIR"]
            ), patch.object(
                main, "COMPOSED_DIR", paths["COMPOSED_DIR"]
            ), patch.object(
                main, "VIDEO_WORKSHOP_OUTPUT_DIR", paths["VIDEO_WORKSHOP_OUTPUT_DIR"]
            ):
                image_response = main.file_get(
                    pack_name,
                    request_with_range("bytes=0-3"),
                    deliveryId="delivery-images-a",
                    me={"id": child["id"], "role": "supplier_child"},
                )
                video_response = main.composed_file(
                    composed_name,
                    request_with_range("bytes=0-4"),
                    deliveryId="delivery-video-a",
                    me={"id": parent[0], "role": "supplier_parent"},
                )
                workshop_response = main.custom_video_output(
                    workshop_key,
                    request_with_range("bytes=0-7"),
                    deliveryId="delivery-workshop-video-a",
                    me={"id": child["id"], "role": "supplier_child"},
                )
            self.assertEqual(206, image_response.status_code)
            self.assertEqual("bytes 0-3/10", image_response.headers["content-range"])
            self.assertEqual(206, video_response.status_code)
            self.assertEqual("bytes 0-4/11", video_response.headers["content-range"])
            self.assertEqual(206, workshop_response.status_code)
            self.assertEqual("bytes 0-7/14", workshop_response.headers["content-range"])

    def test_owner_and_same_team_allowed_external_admin_denied(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, _paths = load_media_store(tmp)
            created = store.register_private_media(
                "upload", "owner-a--asset.png", "owner-a",
                team_id="team-a", provenance_kind="asset", provenance_id="asset-1",
            )
            self.assertTrue(created["created"])
            self.assertIsNone(store.private_media_access("upload", "owner-a--asset.png", "owner-a")[1])
            self.assertIsNone(store.private_media_access("upload", "owner-a--asset.png", "peer-a")[1])
            self.assertEqual(
                "forbidden",
                store.private_media_access("upload", "owner-a--asset.png", "admin-b")[1],
            )
            self.assertEqual(
                "unregistered",
                store.private_media_access("upload", "missing.png", "owner-a")[1],
            )
            with self.assertRaisesRegex(ValueError, "owner_conflict"):
                store.register_private_media(
                    "upload", "owner-a--asset.png", "admin-b",
                    team_id="team-b", provenance_kind="asset", provenance_id="asset-2",
                )

    def test_private_range_and_community_public_exception(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            name = "owner-a--clip.mp4"
            (paths["UPLOAD_DIR"] / name).write_bytes(b"0123456789")
            store.register_private_media(
                "upload", name, "owner-a", team_id="team-a",
                provenance_kind="asset", provenance_id="clip",
            )
            post = store.create_community_post(
                "owner-a", "A", "team-a", "delivery", "delivery-1",
                "公开", "", "", "视频灵感", [{"url": f"/api/files/{name}", "type": "video"}],
            )
            main = importlib.import_module("main")
            with patch.object(main, "store", store), patch.object(main, "UPLOAD_DIR", paths["UPLOAD_DIR"]):
                private = main.file_get(name, request_with_range(), me={"id": "peer-a"})
                public = main.community_post_media(post["id"], 0, request_with_range())
                with self.assertRaises(Exception):
                    main.file_get(name, request_with_range(), me={"id": "admin-b"})
            self.assertEqual(206, private.status_code)
            self.assertEqual("bytes 1-3/10", private.headers["content-range"])
            self.assertEqual("private, max-age=300", private.headers["cache-control"])
            self.assertEqual(206, public.status_code)

    def test_deterministic_plan_blocks_ambiguity_and_maps_workshop_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            upload = paths["UPLOAD_DIR"] / "owner-a--asset.png"
            upload.write_bytes(b"png")
            output = paths["VIDEO_WORKSHOP_OUTPUT_DIR"] / "workshop-a" / "final.mp4"
            output.parent.mkdir(parents=True)
            output.write_bytes(b"video")
            payload = {
                "id": "custom-project-a",
                "ownerId": "owner-a",
                "projectState": {
                    "integration": "video-workshop",
                    "workshopProjectId": "workshop-a",
                    "output": "/custom-video/outputs/workshop-a/final.mp4",
                },
            }
            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                        ("customProjects", "custom-project-a", "owner-a", 1, json.dumps(payload)),
                    )
                    conn.commit()
                finally:
                    conn.close()
            status = store.private_media_registry_status()
            self.assertTrue(status["readyForApply"])
            self.assertEqual(2, status["counts"]["pendingRows"])

            shared = paths["COMPOSED_DIR"] / "shared.mp4"
            shared.write_bytes(b"x")
            with store._lock:
                conn = store._connect()
                try:
                    for owner in ("owner-a", "admin-b"):
                        conn.execute(
                            "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                            ("assets", f"asset-{owner}", owner, 1, json.dumps({"url": "/api/video/composed/shared.mp4"})),
                        )
                    conn.commit()
                finally:
                    conn.close()
            blocked = store.private_media_registry_status()
            self.assertFalse(blocked["readyForApply"])
            self.assertEqual(1, blocked["counts"]["ambiguousFiles"])

    def test_completed_migration_keeps_unique_registry_owner_for_shared_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            shared = paths["COMPOSED_DIR"] / "shared-after-migration.mp4"
            shared.write_bytes(b"video")
            store.register_private_media(
                "composed", shared.name, "owner-a",
                team_id="team-a", provenance_kind="production",
                provenance_id="production-a",
            )
            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,status,summary"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_NAME,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM,
                            "test", 1, 1, "success", "{}",
                        ),
                    )
                    for owner in ("owner-a", "peer-a"):
                        conn.execute(
                            "INSERT OR REPLACE INTO docs("
                            "collection,id,owner_id,updated_at,data"
                            ") VALUES(?,?,?,?,?)",
                            (
                                "assets", f"shared-{owner}", owner, 1,
                                json.dumps({
                                    "url": f"/api/video/composed/{shared.name}",
                                }),
                            ),
                        )
                    conn.commit()
                finally:
                    conn.close()

            status = store.private_media_registry_status()
            self.assertTrue(status["readyForApply"])
            self.assertEqual(0, status["counts"]["ambiguousFiles"])
            self.assertEqual(0, status["counts"]["pendingRows"])

            prefixed = paths["UPLOAD_DIR"] / "peer-a--conflict.png"
            prefixed.write_bytes(b"png")
            store.register_private_media(
                "upload", prefixed.name, "owner-a",
                team_id="team-a", provenance_kind="asset",
                provenance_id="asset-conflict",
            )
            conflict = store.private_media_registry_status()
            self.assertFalse(conflict["readyForApply"])
            self.assertEqual(1, conflict["counts"]["ambiguousFiles"])

    def test_completed_migration_allows_bound_supplier_to_manage_team_asset_media(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            supplier = store.add_member(
                "Supplier", "media_supplier", "local-test-pin", "supplier_parent"
            )
            other_supplier = store.add_member(
                "Other supplier", "other_media_supplier", "local-test-pin", "supplier_parent"
            )
            uploaded = paths["UPLOAD_DIR"] / f"{supplier[0]}--managed.png"
            uploaded.write_bytes(b"png")
            store.register_private_media(
                "upload", uploaded.name, supplier[0],
                provenance_kind="supplier-account-asset",
                provenance_id="asset-supplier-managed",
            )
            asset = {
                "id": "asset-supplier-managed",
                "accountId": "account-a",
                "fileUrl": f"/api/files/{uploaded.name}",
                "url": f"/api/files/{uploaded.name}",
                "supplierManagedBy": supplier[0],
            }
            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "INSERT INTO team_suppliers(team_id,supplier_parent_id,created_at,added_by) "
                        "VALUES('team-a',?,?,?)",
                        (supplier[0], 1, "owner-a"),
                    )
                    conn.execute(
                        "INSERT OR REPLACE INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES(?,?,?,?,?)",
                        (
                            "assets", asset["id"], "owner-a", 1,
                            json.dumps(asset),
                        ),
                    )
                    conn.execute(
                        "INSERT INTO resource_scopes("
                        "resource_kind,resource_id,scope_type,scope_id,owner_id,"
                        "provenance,captured_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store._doc_resource_kind("assets"), asset["id"],
                            "team", "team-a", "owner-a",
                            "test", 1, 1,
                        ),
                    )
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,status,summary"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_NAME,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM,
                            "test", 1, 1, "success", "{}",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()

            status = store.private_media_registry_status()
            self.assertTrue(status["readyForApply"])
            self.assertEqual(0, status["counts"]["ambiguousFiles"])

            asset["supplierManagedBy"] = other_supplier[0]
            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "UPDATE docs SET data=?,updated_at=? "
                        "WHERE collection='assets' AND id=?",
                        (json.dumps(asset), 2, asset["id"]),
                    )
                    conn.commit()
                finally:
                    conn.close()
            blocked = store.private_media_registry_status()
            self.assertFalse(blocked["readyForApply"])
            self.assertEqual(1, blocked["counts"]["ambiguousFiles"])

    def test_post_140004_video_outputs_register_on_hydration_and_settle_independently(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            project_id = "workshop-post-140004"
            project = {
                "id": project_id,
                "name": "迁移后成片",
                "status": "succeeded",
                "outputs": [],
            }
            mapped, error = store.sync_custom_video_project("owner-a", project)
            self.assertIsNone(error)
            self.assertEqual(project_id, mapped["projectState"]["workshopProjectId"])
            output_dir = paths["VIDEO_WORKSHOP_OUTPUT_DIR"] / project_id
            output_dir.mkdir(parents=True)
            for index in range(114):
                (output_dir / f"delivery-{index:03d}.mp4").write_bytes(
                    f"video-{index}".encode("ascii")
                )
            with store._lock:
                conn = store._connect()
                try:
                    now = 1
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,status,summary"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_NAME,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM,
                            "test", now, now, "success", "{}",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()
            pending = store.private_media_registry_status()
            self.assertTrue(pending["readyForApply"])
            self.assertEqual(114, pending["counts"]["pendingRows"])

            backup = current_backup_binding(store, store.DB_PATH)
            snapshot = runtime_snapshot_binding(
                "c" * 64, store._private_media_live_inventory_digest(),
            )
            with patch.dict(os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT": "1"}):
                first = store.settle_private_media_registry_incremental(
                    expected_identity=store._database_identity(store.DB_PATH),
                    expected_schema_version=store.MEMBER_CONTROL_SCHEMA_MIGRATION_VERSION,
                    backup_binding=backup,
                    runtime_snapshot_binding=snapshot,
                    created_by="test-deployer",
                )
            self.assertTrue(first["applied"])
            self.assertEqual(114, first["insertedRows"])
            self.assertEqual(0, store.private_media_registry_status()["counts"]["pendingRows"])
            before_second = logical_database_dump(store.DB_PATH)
            with patch.dict(os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT": "1"}):
                second = store.settle_private_media_registry_incremental(
                    expected_identity=store._database_identity(store.DB_PATH),
                    expected_schema_version=store.MEMBER_CONTROL_SCHEMA_MIGRATION_VERSION,
                    backup_binding=current_backup_binding(store, store.DB_PATH),
                    runtime_snapshot_binding=snapshot,
                    created_by="test-deployer",
                )
            self.assertFalse(second["applied"])
            self.assertTrue(second["reused"])
            self.assertEqual(before_second, logical_database_dump(store.DB_PATH))

            # A subsequent sidecar hydration now performs the same owner-scoped
            # registration for new regular files, without another settlement.
            new_output = output_dir / "delivery-114.mp4"
            new_output.write_bytes(b"video-114")
            main = importlib.import_module("main")
            with patch.object(main, "store", store), patch.object(
                main, "VIDEO_WORKSHOP_OUTPUT_DIR", paths["VIDEO_WORKSHOP_OUTPUT_DIR"],
            ):
                main._register_video_workshop_media(
                    project,
                    {"id": "owner-a", "teamId": "team-a"},
                    project_id,
                )
            self.assertEqual(0, store.private_media_registry_status()["counts"]["pendingRows"])
            access, access_error = store.private_media_access(
                "video-output", f"{project_id}/delivery-114.mp4", "peer-a",
            )
            self.assertIsNone(access_error)
            self.assertEqual("owner-a", access["ownerId"])

    def test_incremental_settlement_restores_reviewed_isolation_baseline(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            project_id = "workshop-after-isolation"
            project = {
                "id": project_id,
                "name": "隔离后成片",
                "status": "succeeded",
                "outputs": [],
            }
            mapped, error = store.sync_custom_video_project("owner-a", project)
            self.assertIsNone(error)
            self.assertEqual(
                project_id, mapped["projectState"]["workshopProjectId"],
            )
            with store._lock:
                conn = store._connect()
                try:
                    now = 1
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,status,summary"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_NAME,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM,
                            "test", now, now, "success", "{}",
                        ),
                    )
                    conn.execute(
                        "INSERT INTO media_isolation_settlements("
                        "settlement_id,plan_sha256,database_identity,"
                        "snapshot_manifest_sha256,snapshot_media_digest,"
                        "isolated_rows,raw_pending_rows,public_avatar_exemptions,"
                        "created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (
                            "reviewed-empty-baseline", "a" * 64,
                            store._database_identity(store.DB_PATH),
                            "b" * 64, "c" * 64, 0, 0, 0, now, "test",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()

            output = paths["VIDEO_WORKSHOP_OUTPUT_DIR"] / project_id / "final.mp4"
            output.parent.mkdir(parents=True)
            output.write_bytes(b"reviewed-video")
            drifted = store.private_media_registry_status()
            self.assertEqual(1, drifted["counts"]["pendingRows"])
            self.assertEqual(1, drifted["counts"]["effectivePendingRows"])
            self.assertEqual(1, drifted["counts"]["mediaIsolationAuditDrift"])
            self.assertFalse(drifted["ok"])

            snapshot = runtime_snapshot_binding(
                "d" * 64, store._private_media_live_inventory_digest(),
            )
            with patch.dict(
                os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT": "1"},
            ):
                first = store.settle_private_media_registry_incremental(
                    expected_identity=store._database_identity(store.DB_PATH),
                    expected_schema_version=store.MEMBER_CONTROL_SCHEMA_MIGRATION_VERSION,
                    backup_binding=current_backup_binding(store, store.DB_PATH),
                    runtime_snapshot_binding=snapshot,
                    created_by="test-deployer",
                )
            self.assertTrue(first["applied"])
            self.assertEqual(1, first["plannedRows"])
            self.assertEqual(1, first["insertedRows"])
            self.assertEqual(1, first["rawPendingRowsBefore"])
            self.assertEqual(0, first["rawPendingRowsAfter"])
            settled = store.private_media_registry_status()
            self.assertTrue(settled["ok"])
            self.assertEqual(0, settled["counts"]["effectivePendingRows"])
            self.assertEqual(0, settled["counts"]["mediaIsolationAuditDrift"])

            before_replay = logical_database_dump(store.DB_PATH)
            with patch.dict(
                os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT": "1"},
            ):
                replay = store.settle_private_media_registry_incremental(
                    expected_identity=store._database_identity(store.DB_PATH),
                    expected_schema_version=store.MEMBER_CONTROL_SCHEMA_MIGRATION_VERSION,
                    backup_binding=current_backup_binding(store, store.DB_PATH),
                    runtime_snapshot_binding=snapshot,
                    created_by="test-deployer",
                )
            self.assertFalse(replay["applied"])
            self.assertTrue(replay["reused"])
            self.assertEqual(0, replay["insertedRows"])
            self.assertEqual(before_replay, logical_database_dump(store.DB_PATH))

            with store._connect() as conn:
                conn.execute(
                    "DELETE FROM private_media_registry "
                    "WHERE media_kind='video-output' AND media_key=?",
                    (f"{project_id}/final.mp4",),
                )
                conn.commit()
            with patch.dict(
                os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT": "1"},
            ):
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "immutable replay drift",
                ):
                    store.settle_private_media_registry_incremental(
                        expected_identity=store._database_identity(store.DB_PATH),
                        expected_schema_version=(
                            store.MEMBER_CONTROL_SCHEMA_MIGRATION_VERSION
                        ),
                        backup_binding=current_backup_binding(store, store.DB_PATH),
                        runtime_snapshot_binding=snapshot,
                        created_by="test-deployer",
                    )

    def test_incremental_settlement_only_registers_post_isolation_video_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            project_id = "workshop-runtime-delta"
            project = {
                "id": project_id,
                "name": "隔离基线后的成片",
                "status": "succeeded",
                "outputs": [],
            }
            mapped, error = store.sync_custom_video_project("owner-a", project)
            self.assertIsNone(error)
            self.assertEqual(project_id, mapped["projectState"]["workshopProjectId"])

            output_dir = paths["VIDEO_WORKSHOP_OUTPUT_DIR"] / project_id
            output_dir.mkdir(parents=True)
            historical = output_dir / "historical.mp4"
            historical.write_bytes(b"historical")
            os.utime(historical, ns=(5_000_000_000, 5_000_000_000))
            avatar = paths["UPLOAD_DIR"] / "member-avatar-baseline.png"
            avatar.write_bytes(b"avatar")

            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,status,summary"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_NAME,
                            store.PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM,
                            "test", 10_000, 10_000, "success", "{}",
                        ),
                    )
                    conn.execute(
                        "INSERT INTO media_isolation_settlements("
                        "settlement_id,plan_sha256,database_identity,"
                        "snapshot_manifest_sha256,snapshot_media_digest,"
                        "isolated_rows,raw_pending_rows,public_avatar_exemptions,"
                        "created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
                        (
                            "reviewed-runtime-baseline", "a" * 64,
                            store._database_identity(store.DB_PATH),
                            "b" * 64, "c" * 64, 0, 1, 1, 10_000, "test",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()

            current = output_dir / "current.mp4"
            current.write_bytes(b"current")
            os.utime(current, ns=(15_000_000_000, 15_000_000_000))
            drifted = store.private_media_registry_status()
            self.assertEqual(2, drifted["counts"]["pendingRows"])
            self.assertEqual(1, drifted["counts"]["effectivePendingRows"])
            self.assertEqual(1, drifted["counts"]["mediaIsolationAuditDrift"])

            snapshot = runtime_snapshot_binding(
                "d" * 64, store._private_media_live_inventory_digest(),
            )
            with patch.dict(
                os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT": "1"},
            ):
                result = store.settle_private_media_registry_incremental(
                    expected_identity=store._database_identity(store.DB_PATH),
                    expected_schema_version=store.MEMBER_CONTROL_SCHEMA_MIGRATION_VERSION,
                    backup_binding=current_backup_binding(store, store.DB_PATH),
                    runtime_snapshot_binding=snapshot,
                    created_by="test-deployer",
                )
            self.assertTrue(result["applied"])
            self.assertEqual(1, result["plannedRows"])
            self.assertEqual(1, result["insertedRows"])
            self.assertEqual(1, result["rawPendingRowsAfter"])
            with store._connect(read_only=True) as conn:
                keys = {
                    str(row[0])
                    for row in conn.execute(
                        "SELECT media_key FROM private_media_registry "
                        "WHERE media_kind='video-output' AND media_key LIKE ?",
                        (f"{project_id}/%",),
                    ).fetchall()
                }
            self.assertEqual({f"{project_id}/current.mp4"}, keys)
            settled = store.private_media_registry_status()
            self.assertTrue(settled["ok"])
            self.assertEqual(0, settled["counts"]["effectivePendingRows"])
            self.assertEqual(0, settled["counts"]["mediaIsolationAuditDrift"])

    def test_nonempty_data_migration_is_atomic_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            (paths["UPLOAD_DIR"] / "owner-a--asset.png").write_bytes(b"png")
            with store._lock:
                conn = store._connect()
                try:
                    now = 1
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,status,summary"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_NAME,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
                            "test",
                            now,
                            now,
                            "success",
                            "{}",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()
            identity = store._database_identity(store.DB_PATH)
            with patch.object(
                store,
                "_private_media_live_inventory_digest",
                wraps=store._private_media_live_inventory_digest,
            ) as content_digest:
                with patch.dict(
                    os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_MIGRATION": "1"}
                ):
                    first = store.apply_private_media_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                        ),
                    )
                    second = store.apply_private_media_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                        ),
                    )
            self.assertGreaterEqual(content_digest.call_count, 2)
            self.assertTrue(first["applied"])
            self.assertTrue(first["ok"])
            self.assertFalse(second["applied"])
            self.assertIsNone(
                store.private_media_access(
                    "upload", "owner-a--asset.png", "peer-a",
                )[1]
            )

    def test_unreferenced_disk_file_is_quarantined_not_attributed(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            unknown = paths["COMPOSED_DIR"] / "legacy-unknown.mp4"
            unknown.write_bytes(b"preserve-me")
            first = store.private_media_registry_status()
            second = store.private_media_registry_status()
            self.assertTrue(first["readyForApply"])
            self.assertEqual(1, first["counts"]["quarantinedFiles"])
            self.assertIn("quarantinedFiles", first["warnings"])
            self.assertNotIn("quarantinedFiles", first["issues"])
            self.assertEqual(first["inventoryDigest"], second["inventoryDigest"])
            self.assertTrue(unknown.is_file())
            self.assertEqual(
                "unregistered",
                store.private_media_access(
                    "composed", "legacy-unknown.mp4", "owner-a",
                )[1],
            )

    def test_registry_status_never_reads_full_media_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            (paths["COMPOSED_DIR"] / "large-placeholder.mp4").write_bytes(
                b"preserve"
            )
            with patch.object(
                store,
                "_private_media_live_inventory_digest",
                side_effect=AssertionError("readiness must not hash media bytes"),
            ) as content_digest:
                status = store.private_media_registry_status()
            content_digest.assert_not_called()
            self.assertTrue(status["readyForApply"])
            self.assertEqual("", status["mediaInventoryDigest"])

    def test_live_media_digest_matches_runtime_snapshot_algorithm(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            samples = {
                "uploads": paths["UPLOAD_DIR"] / "sample.bin",
                "composed": paths["COMPOSED_DIR"] / "sample.bin",
                "canvas-blobs": paths["CUSTOM_CANVAS_BLOB_DIR"] / "sample.bin",
                "video-uploads": paths["VIDEO_WORKSHOP_UPLOAD_DIR"] / "sample.bin",
                "video-outputs": paths["VIDEO_WORKSHOP_OUTPUT_DIR"] / "sample.bin",
            }
            for index, path in enumerate(samples.values()):
                path.write_bytes(f"sample-{index}".encode("ascii"))
            script = SERVER_DIR / "scripts" / "runtime_snapshot.py"
            spec = importlib.util.spec_from_file_location(
                f"runtime_snapshot_digest_{id(store)}", script,
            )
            runtime_snapshot = importlib.util.module_from_spec(spec)
            assert spec.loader is not None
            spec.loader.exec_module(runtime_snapshot)
            components = []
            for name, path in sorted(samples.items()):
                info = path.stat()
                components.append({
                    "name": name,
                    "type": "directory",
                    "files": [{
                        "path": path.name,
                        "bytes": info.st_size,
                        "mtimeNs": info.st_mtime_ns,
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    }],
                })
            self.assertEqual(
                runtime_snapshot._media_inventory_digest_from_components(
                    components
                ),
                store._private_media_live_inventory_digest(),
            )

    def test_snapshot_restore_preserves_live_media_digest_at_nanosecond_precision(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            media_roots = {
                "uploads": paths["UPLOAD_DIR"],
                "composed": paths["COMPOSED_DIR"],
                "canvas-blobs": paths["CUSTOM_CANVAS_BLOB_DIR"],
                "video-uploads": paths["VIDEO_WORKSHOP_UPLOAD_DIR"],
                "video-outputs": paths["VIDEO_WORKSHOP_OUTPUT_DIR"],
            }
            expected_mtimes = {}
            for index, (name, media_root) in enumerate(sorted(media_roots.items())):
                sample = media_root / "nested" / f"sample-{index}.bin"
                sample.parent.mkdir(parents=True, exist_ok=True)
                sample.write_bytes(f"sample-{index}".encode("ascii"))
                requested_mtime = 1_700_000_000_123_456_789 + (index * 137)
                os.utime(
                    sample,
                    ns=(requested_mtime, requested_mtime),
                    follow_symlinks=False,
                )
                actual_mtime = sample.stat().st_mtime_ns
                self.assertNotEqual(0, actual_mtime % 1_000)
                expected_mtimes[(name, sample.relative_to(media_root).as_posix())] = (
                    actual_mtime
                )

            script = SERVER_DIR / "scripts" / "runtime_snapshot.py"
            spec = importlib.util.spec_from_file_location(
                f"runtime_snapshot_restore_{id(store)}", script,
            )
            runtime_snapshot = importlib.util.module_from_spec(spec)
            assert spec.loader is not None
            spec.loader.exec_module(runtime_snapshot)

            plan_path = Path(tmp) / "complete-plan.json"
            components = [{
                "name": "database",
                "type": "sqlite",
                "path": str(paths["DATA_DB"]),
            }]
            components.extend({
                "name": name,
                "type": "directory",
                "path": str(media_root),
            } for name, media_root in sorted(media_roots.items()))
            plan_path.write_text(
                json.dumps({
                    "format": runtime_snapshot.PLAN_FORMAT,
                    "profile": runtime_snapshot.PRODUCTION_COMPLETE_PROFILE,
                    "releaseId": "mtime-restore-test",
                    "components": components,
                }),
                encoding="utf-8",
            )
            contract = {
                "database": (
                    "sqlite", True, str(paths["DATA_DB"]), False, False,
                ),
                **{
                    name: (
                        "directory", True, str(media_root), False, False,
                    )
                    for name, media_root in media_roots.items()
                },
            }
            with patch.object(
                runtime_snapshot, "PRODUCTION_COMPLETE_COMPONENTS", contract
            ):
                snapshot = Path(tmp) / "snapshot"
                runtime_snapshot.create_snapshot(
                    plan_path, Path(tmp), snapshot
                )
                manifest_sha256 = (
                    snapshot / "snapshot.manifest.sha256"
                ).read_text("ascii").strip()
                verified = runtime_snapshot.verify_snapshot(
                    snapshot,
                    expected_manifest_sha256=manifest_sha256,
                )
                restored = Path(tmp) / "restored"
                runtime_snapshot.restore_drill(
                    snapshot,
                    restored,
                    expected_manifest_sha256=manifest_sha256,
                )

                restored_roots = {
                    name: restored / name for name in media_roots
                }
                with patch.multiple(
                    store,
                    PRIVATE_MEDIA_UPLOAD_DIR=restored_roots["uploads"],
                    PRIVATE_MEDIA_COMPOSED_DIR=restored_roots["composed"],
                    CUSTOM_CANVAS_BLOB_DIR=restored_roots["canvas-blobs"],
                    PRIVATE_MEDIA_VIDEO_UPLOAD_DIR=restored_roots["video-uploads"],
                    PRIVATE_MEDIA_VIDEO_OUTPUT_DIR=restored_roots["video-outputs"],
                ):
                    self.assertEqual(
                        verified["mediaInventoryDigest"],
                        store._private_media_live_inventory_digest(),
                    )

                for (name, relative), expected_mtime in expected_mtimes.items():
                    restored_file = restored_roots[name] / relative
                    self.assertFalse(restored_file.is_symlink())
                    self.assertEqual(
                        expected_mtime, restored_file.stat().st_mtime_ns
                    )

                rounded_root = Path(tmp) / "rounded"
                rounded_root.mkdir()
                rounded_file = rounded_root / "sample.bin"
                rounded_file.write_bytes(b"rounded")
                rounded_mtime = 1_700_000_000_987_654_321
                original_utime = runtime_snapshot.os.utime

                def round_one_nanosecond(path, *args, **kwargs):
                    atime_ns, mtime_ns = kwargs["ns"]
                    kwargs["ns"] = (atime_ns - 1, mtime_ns - 1)
                    return original_utime(path, *args, **kwargs)

                with patch.object(
                    runtime_snapshot.os,
                    "utime",
                    side_effect=round_one_nanosecond,
                ):
                    with self.assertRaisesRegex(
                        runtime_snapshot.SnapshotError,
                        "restored_directory_mtime_mismatch",
                    ):
                        runtime_snapshot._restore_directory_mtimes(
                            rounded_root,
                            [{"path": "sample.bin", "mtimeNs": rounded_mtime}],
                        )

    def test_referenced_file_with_missing_owner_is_a_hard_blocker(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            referenced = paths["COMPOSED_DIR"] / "legacy-orphan.mp4"
            referenced.write_bytes(b"preserve-me")
            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('assets','orphan-media','deleted-owner',1,?)",
                        (
                            '{"id":"orphan-media","ownerId":"deleted-owner",'
                            '"url":"/api/video/composed/legacy-orphan.mp4"}',
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()

            status = store.private_media_registry_status()
            self.assertFalse(status["readyForApply"])
            self.assertEqual(1, status["counts"]["missingReferenceOwners"])
            self.assertEqual(0, status["counts"]["quarantinedFiles"])
            self.assertIn("missingReferenceOwners", status["issues"])
            self.assertNotIn("quarantinedFiles", status["warnings"])
            self.assertTrue(referenced.is_file())

    def test_reviewed_override_binds_inventory_snapshot_backup_and_double_run(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            media_key = "reviewed-orphan.mp4"
            (paths["COMPOSED_DIR"] / media_key).write_bytes(b"preserve-me")
            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('assets','reviewed-media','deleted-owner',1,?)",
                        (json.dumps({
                            "id": "reviewed-media",
                            "url": f"/api/video/composed/{media_key}",
                        }),),
                    )
                    conn.execute(
                        "INSERT INTO resource_scopes(resource_kind,resource_id,scope_type,"
                        "scope_id,owner_id,provenance,captured_at,updated_at) "
                        "VALUES('doc:assets','reviewed-media','team','team-a','',"
                        "'test-reviewed-scope',1,1)"
                    )
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,status,summary"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_NAME,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
                            "test", 1, 1, "success", "{}",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()

            blocked = store.private_media_migration_preflight(
                expected_identity=store._database_identity(store.DB_PATH),
                expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
            )
            self.assertFalse(blocked["readyForApply"])
            self.assertEqual(1, blocked["counts"]["missingReferenceOwners"])
            snapshot_digest = "c" * 64
            snapshot_media_digest = blocked["mediaInventoryDigest"]
            review_backup = current_backup_binding(store, store.DB_PATH)
            reviewed = store.private_media_migration_preflight(
                expected_identity=store._database_identity(store.DB_PATH),
                expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                backup_binding=review_backup,
            )
            manifest = Path(tmp) / "media-overrides.json"
            manifest_digest = write_media_override(
                store,
                manifest,
                store._database_identity(store.DB_PATH),
                review_backup,
                reviewed["inventoryDigest"],
                snapshot_digest,
                snapshot_media_digest,
                [{
                    "mediaKind": "composed",
                    "mediaKey": media_key,
                    "ownerId": "owner-a",
                    "reason": "operator-reviewed legacy orphan",
                    "evidence": "frozen v120 business record and complete composed inventory",
                }],
            )
            confirmation = {
                "expected_identity": store._database_identity(store.DB_PATH),
                "expected_schema_version": store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                "override_manifest_path": manifest,
                "expected_override_manifest_sha256": manifest_digest,
                "runtime_snapshot_binding": runtime_snapshot_binding(
                    snapshot_digest, snapshot_media_digest,
                ),
                "backup_binding": review_backup,
            }
            ready = store.private_media_migration_preflight(**confirmation)
            self.assertTrue(ready["readyForApply"])
            self.assertEqual(0, ready["counts"]["missingReferenceOwners"])
            self.assertEqual(1, ready["counts"]["overrideEntries"])

            with patch.dict(os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_MIGRATION": "1"}):
                first = store.apply_private_media_migration(**confirmation)
                frozen_after_first = logical_database_dump(store.DB_PATH)
                fresh_backup = current_backup_binding(store, store.DB_PATH)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "database logical state mismatch"
                ):
                    store.apply_private_media_migration(
                        **{**confirmation, "backup_binding": fresh_backup}
                    )
                self.assertEqual(
                    frozen_after_first, logical_database_dump(store.DB_PATH)
                )
                second = store.apply_private_media_migration(
                    expected_identity=confirmation["expected_identity"],
                    expected_schema_version=confirmation[
                        "expected_schema_version"
                    ],
                    backup_binding=fresh_backup,
                    runtime_snapshot_binding=confirmation[
                        "runtime_snapshot_binding"
                    ],
                )
            self.assertTrue(first["applied"])
            self.assertTrue(first["ok"])
            self.assertFalse(second["applied"])
            self.assertIsNone(
                store.private_media_access("composed", media_key, "peer-a")[1]
            )
            with store._connect(read_only=True) as conn:
                summary = json.loads(conn.execute(
                    "SELECT summary FROM schema_migrations WHERE version=?",
                    (store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,),
                ).fetchone()[0])
            self.assertEqual(manifest_digest, summary["overrideManifestSha256"])
            self.assertEqual(1, summary["overrideEntries"])
            self.assertEqual(
                snapshot_media_digest,
                summary["snapshotMediaInventoryDigest"],
            )
            self.assertEqual(
                review_backup["sourceLogicalSha256"],
                summary["overrideDatabaseLogicalSha256"],
            )
            self.assertEqual(
                review_backup["manifestSha256"],
                summary["overrideBackupManifestSha256"],
            )
            self.assertNotIn(media_key, json.dumps(summary))

    def test_override_rejects_wrong_hash_digest_coverage_scope_and_missing_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, paths = load_media_store(tmp)
            for key in ("orphan-a.mp4", "orphan-b.mp4"):
                (paths["COMPOSED_DIR"] / key).write_bytes(b"preserve")
            with store._lock:
                conn = store._connect()
                try:
                    for index, key in enumerate(("orphan-a.mp4", "orphan-b.mp4")):
                        resource_id = f"orphan-{index}"
                        conn.execute(
                            "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                            "VALUES('assets',?,'deleted-owner',1,?)",
                            (resource_id, json.dumps({
                                "id": resource_id,
                                "url": f"/api/video/composed/{key}",
                            })),
                        )
                        conn.execute(
                            "INSERT INTO resource_scopes(resource_kind,resource_id,scope_type,"
                            "scope_id,owner_id,provenance,captured_at,updated_at) "
                            "VALUES('doc:assets',?,'team','team-a','','test',1,1)",
                            (resource_id,),
                        )
                    conn.execute(
                        "INSERT OR REPLACE INTO schema_migrations("
                        "version,name,checksum,app_version,started_at,finished_at,status,summary"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_NAME,
                            store.RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
                            "test", 1, 1, "success", "{}",
                        ),
                    )
                    conn.commit()
                finally:
                    conn.close()
            identity = store._database_identity(store.DB_PATH)
            blocked = store.private_media_migration_preflight(
                expected_identity=identity,
                expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
            )
            snapshot_digest = "d" * 64
            snapshot_media_digest = blocked["mediaInventoryDigest"]
            review_backup = current_backup_binding(store, store.DB_PATH)
            base_entries = [{
                "mediaKind": "composed",
                "mediaKey": key,
                "ownerId": "owner-a",
                "reason": "reviewed",
                "evidence": "complete inventory review",
            } for key in ("orphan-a.mp4", "orphan-b.mp4")]

            manifest = Path(tmp) / "negative-overrides.json"
            digest = write_media_override(
                store, manifest, identity, review_backup,
                blocked["inventoryDigest"], snapshot_digest,
                snapshot_media_digest, base_entries,
            )
            before = logical_database_dump(store.DB_PATH)
            with self.assertRaisesRegex(
                store.StoreNotReadyError, "sha256 mismatch"
            ):
                store.private_media_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                    override_manifest_path=manifest,
                    expected_override_manifest_sha256="e" * 64,
                    runtime_snapshot_binding=runtime_snapshot_binding(
                        snapshot_digest, snapshot_media_digest,
                    ),
                    backup_binding=review_backup,
                )
            self.assertEqual(before, logical_database_dump(store.DB_PATH))

            partial_digest = write_media_override(
                store, manifest, identity, review_backup,
                blocked["inventoryDigest"], snapshot_digest,
                snapshot_media_digest, base_entries[:1],
            )
            partial = store.private_media_migration_preflight(
                expected_identity=identity,
                expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                override_manifest_path=manifest,
                expected_override_manifest_sha256=partial_digest,
                runtime_snapshot_binding=runtime_snapshot_binding(
                    snapshot_digest, snapshot_media_digest,
                ),
                backup_binding=review_backup,
            )
            self.assertEqual(1, partial["counts"]["overrideMissing"])

            cross_entries = [dict(entry) for entry in base_entries]
            cross_entries[0]["ownerId"] = "admin-b"
            cross_digest = write_media_override(
                store, manifest, identity, review_backup,
                blocked["inventoryDigest"], snapshot_digest,
                snapshot_media_digest, cross_entries,
            )
            cross = store.private_media_migration_preflight(
                expected_identity=identity,
                expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                override_manifest_path=manifest,
                expected_override_manifest_sha256=cross_digest,
                runtime_snapshot_binding=runtime_snapshot_binding(
                    snapshot_digest, snapshot_media_digest,
                ),
                backup_binding=review_backup,
            )
            self.assertEqual(1, cross["counts"]["overrideScopeConflicts"])

            stale_digest = write_media_override(
                store, manifest, identity, review_backup,
                "f" * 64, snapshot_digest, snapshot_media_digest, base_entries,
            )
            stale = store.private_media_migration_preflight(
                expected_identity=identity,
                expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                override_manifest_path=manifest,
                expected_override_manifest_sha256=stale_digest,
                runtime_snapshot_binding=runtime_snapshot_binding(
                    snapshot_digest, snapshot_media_digest,
                ),
                backup_binding=review_backup,
            )
            self.assertEqual(1, stale["counts"]["overrideInventoryMismatch"])

            stale_database_digest = write_media_override(
                store, manifest, identity, review_backup,
                blocked["inventoryDigest"], snapshot_digest,
                snapshot_media_digest, base_entries,
                manifest_overrides={"databaseLogicalSha256": "0" * 64},
            )
            with self.assertRaisesRegex(
                store.StoreNotReadyError, "database logical state mismatch"
            ):
                store.private_media_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                    override_manifest_path=manifest,
                    expected_override_manifest_sha256=stale_database_digest,
                    runtime_snapshot_binding=runtime_snapshot_binding(
                        snapshot_digest, snapshot_media_digest,
                    ),
                    backup_binding=review_backup,
                )
            with patch.dict(os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_MIGRATION": "1"}):
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "database logical state mismatch"
                ):
                    store.apply_private_media_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                        ),
                        backup_binding=review_backup,
                        override_manifest_path=manifest,
                        expected_override_manifest_sha256=stale_database_digest,
                        runtime_snapshot_binding=runtime_snapshot_binding(
                            snapshot_digest, snapshot_media_digest,
                        ),
                    )
            self.assertEqual(before, logical_database_dump(store.DB_PATH))

            stale_snapshot_media = "0" * 64
            stale_snapshot_digest = write_media_override(
                store, manifest, identity, review_backup,
                blocked["inventoryDigest"], snapshot_digest,
                stale_snapshot_media, base_entries,
            )
            stale_snapshot = store.private_media_migration_preflight(
                expected_identity=identity,
                expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                override_manifest_path=manifest,
                expected_override_manifest_sha256=stale_snapshot_digest,
                runtime_snapshot_binding=runtime_snapshot_binding(
                    snapshot_digest, stale_snapshot_media,
                ),
                backup_binding=review_backup,
            )
            self.assertEqual(
                1, stale_snapshot["counts"]["snapshotInventoryMismatch"]
            )
            with patch.dict(os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_MIGRATION": "1"}):
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "preflight failed"
                ):
                    store.apply_private_media_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                        ),
                        backup_binding=review_backup,
                        override_manifest_path=manifest,
                        expected_override_manifest_sha256=stale_snapshot_digest,
                        runtime_snapshot_binding=runtime_snapshot_binding(
                            snapshot_digest, stale_snapshot_media,
                        ),
                    )
            self.assertEqual(before, logical_database_dump(store.DB_PATH))

            old_override_digest = write_media_override(
                store, manifest, identity, review_backup,
                blocked["inventoryDigest"], snapshot_digest,
                snapshot_media_digest, base_entries,
            )
            replaced = paths["COMPOSED_DIR"] / "orphan-a.mp4"
            original_stat = replaced.stat()
            replaced.write_bytes(b"mutation")
            os.utime(
                replaced,
                ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
            )
            before_content_drift_apply = logical_database_dump(store.DB_PATH)
            with patch.dict(os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_MIGRATION": "1"}):
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "preflight failed"
                ):
                    store.apply_private_media_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                        ),
                        backup_binding=review_backup,
                        override_manifest_path=manifest,
                        expected_override_manifest_sha256=old_override_digest,
                        runtime_snapshot_binding=runtime_snapshot_binding(
                            snapshot_digest, snapshot_media_digest,
                        ),
                    )
            self.assertEqual(
                before_content_drift_apply, logical_database_dump(store.DB_PATH)
            )
            replaced.write_bytes(b"preserve")
            os.utime(
                replaced,
                ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns),
            )
            self.assertEqual(
                snapshot_media_digest,
                store._private_media_live_inventory_digest(),
            )
            missing_key = "missing-on-disk.mp4"
            with store._lock:
                conn = store._connect()
                try:
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('assets','missing-file','deleted-owner',1,?)",
                        (json.dumps({"url": f"/api/video/composed/{missing_key}"}),),
                    )
                    conn.execute(
                        "INSERT INTO resource_scopes(resource_kind,resource_id,scope_type,"
                        "scope_id,owner_id,provenance,captured_at,updated_at) "
                        "VALUES('doc:assets','missing-file','team','team-a','','test',1,1)"
                    )
                    conn.commit()
                finally:
                    conn.close()
            after_same_inode_drift = logical_database_dump(store.DB_PATH)
            refreshed_backup = current_backup_binding(store, store.DB_PATH)
            with patch.dict(os.environ, {"ACG_ALLOW_PRIVATE_MEDIA_MIGRATION": "1"}):
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "database logical state mismatch"
                ):
                    store.apply_private_media_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                        ),
                        backup_binding=refreshed_backup,
                        override_manifest_path=manifest,
                        expected_override_manifest_sha256=old_override_digest,
                        runtime_snapshot_binding=runtime_snapshot_binding(
                            snapshot_digest, snapshot_media_digest,
                        ),
                    )
            self.assertEqual(
                after_same_inode_drift, logical_database_dump(store.DB_PATH)
            )
            refreshed = store.private_media_migration_preflight(
                expected_identity=identity,
                expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                backup_binding=refreshed_backup,
            )
            extra_entries = [*base_entries, {
                "mediaKind": "composed", "mediaKey": missing_key,
                "ownerId": "owner-a", "reason": "reviewed",
                "evidence": "file is absent and must not be overrideable",
            }]
            extra_digest = write_media_override(
                store, manifest, identity, refreshed_backup,
                refreshed["inventoryDigest"], snapshot_digest,
                refreshed["mediaInventoryDigest"], extra_entries,
            )
            extra = store.private_media_migration_preflight(
                expected_identity=identity,
                expected_schema_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                override_manifest_path=manifest,
                expected_override_manifest_sha256=extra_digest,
                runtime_snapshot_binding=runtime_snapshot_binding(
                    snapshot_digest, refreshed["mediaInventoryDigest"],
                ),
                backup_binding=refreshed_backup,
            )
            self.assertGreaterEqual(extra["counts"]["overrideExtra"], 1)
            self.assertGreaterEqual(extra["counts"]["missingReferencedFiles"], 1)

    def test_relative_media_reference_ignores_cache_busting_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, _paths = load_media_store(tmp)
            self.assertEqual(
                ("upload", "owner-a--asset.png"),
                store._private_media_reference(
                    "/api/files/owner-a--asset.png?asset_rev=revision-1"
                ),
            )
            with patch.dict(
                os.environ,
                {"PUBLIC_BASE_URL": "https://platform.example"},
                clear=False,
            ):
                self.assertEqual(
                    ("upload", "owner-a--asset.png"),
                    store._private_media_reference(
                        "https://platform.example/api/files/owner-a--asset.png?asset_rev=revision-2"
                    ),
                )
                self.assertEqual(
                    ("invalid", ""),
                    store._private_media_reference(
                        "https://attacker.example/api/files/owner-a--asset.png"
                    ),
                )


if __name__ == "__main__":
    unittest.main()
