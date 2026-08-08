import hashlib
import io
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from server import production_recovery, store
from server.scripts import runtime_snapshot
from server.tests.test_runtime_bootstrap_safety import (
    current_backup_binding,
    current_runtime_snapshot_binding,
    logical_database_dump,
)


PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010804000000b51c0c02"
    "0000000b4944415478da6364f80f00010501012718e3660000000049454e44ae426082"
)


class ProductionRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_upload_dir = store.PRIVATE_MEDIA_UPLOAD_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = self.root / "data.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = self.root / "canvas_blobs"
        store.PRIVATE_MEDIA_UPLOAD_DIR = self.root / "uploads"
        store._initialized = False
        store._ensure_db()
        self._mark_data_migrations()

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store.PRIVATE_MEDIA_UPLOAD_DIR = self.previous_upload_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _mark_data_migrations(self):
        now = int(time.time() * 1000)
        with store._connect() as conn:
            for version, name, checksum in (
                (
                    store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
                    store.RESOURCE_SCOPE_DATA_MIGRATION_NAME,
                    store.RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM,
                ),
                (
                    store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                    store.PRIVATE_MEDIA_DATA_MIGRATION_NAME,
                    store.PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM,
                ),
            ):
                conn.execute(
                    "INSERT OR REPLACE INTO schema_migrations("
                    "version,name,checksum,app_version,started_at,finished_at,"
                    "status,summary) VALUES(?,?,?,?,?,?,?,?)",
                    (version, name, checksum, "test", now, now, "success", "{}"),
                )
            conn.commit()

    def _bindings(self):
        return (
            store._database_identity(store.DB_PATH),
            current_backup_binding(store, store.DB_PATH),
            current_runtime_snapshot_binding(store),
        )

    def _call(self, function, **kwargs):
        identity, backup, snapshot = self._bindings()
        with patch.dict(
            os.environ,
            {
                "ACG_ALLOW_PRODUCTION_RECOVERY": "1",
                "ACG_ALLOW_CANVAS_BLOB_RECOVERY": "1",
                "ACG_ALLOW_INCIDENT_ADJUDICATION": "1",
            },
            clear=False,
        ):
            return function(
                expected_identity=identity,
                expected_schema_version=store.LATEST_SCHEMA_MIGRATION_VERSION,
                backup_binding=backup,
                runtime_snapshot_binding=snapshot,
                created_by="test-operator",
                **kwargs,
            )

    def _member(self, member_id, *, role="user"):
        now = int(time.time() * 1000)
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO members(id,name,username,username_key,pin_hash,role,"
                "parent_id,created_at) VALUES(?,?,?,?,?,?,NULL,?)",
                (
                    member_id, member_id, member_id, member_id,
                    store.DEFAULT_ADMIN_PIN_HASH, role, now,
                ),
            )
            conn.commit()

    def _insert_scoped_doc(self, collection, resource_id, owner_id, payload,
                           *, scope_type="member", scope_id=None,
                           captured_at=None):
        now = int(captured_at or time.time() * 1000)
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                "VALUES(?,?,?,?,?)",
                (
                    collection, resource_id, owner_id, now,
                    json.dumps(payload, ensure_ascii=False),
                ),
            )
            conn.execute(
                "INSERT INTO resource_scopes("
                "resource_kind,resource_id,scope_type,scope_id,owner_id,"
                "provenance,captured_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                (
                    store._doc_resource_kind(collection), resource_id,
                    scope_type, scope_id or owner_id, owner_id,
                    "test-fixture", now, now,
                ),
            )
            conn.commit()

    def test_resource_scope_incremental_settlement_is_exact_and_idempotent(self):
        self._member("resource-user")
        self._insert_scoped_doc(
            "customProjects", "canvas-project", "resource-user",
            {"id": "canvas-project", "ownerId": "resource-user"},
        )
        job_id = "canvas-job-missing-scope"
        payload = {
            "id": job_id,
            "jobId": "client-job",
            "ownerId": "resource-user",
            "sourceProjectId": "canvas-project",
            "requestFingerprint": "a" * 64,
            "status": "succeeded",
            "images": [],
        }
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                "VALUES(?,?,?,?,?)",
                (
                    store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
                    job_id, "resource-user", 100, json.dumps(payload),
                ),
            )
            conn.commit()

        preview = self._call(
            production_recovery.settle_resource_scopes_incremental,
            dry_run=True,
        )
        self.assertEqual(1, preview["missingRows"])
        self.assertEqual(1, preview["plannedRows"])
        result = self._call(
            production_recovery.settle_resource_scopes_incremental,
            dry_run=False,
        )
        self.assertTrue(result["applied"])
        self.assertEqual(1, result["insertedRows"])
        with store._connect() as conn:
            scope = conn.execute(
                "SELECT scope_type,scope_id,owner_id,provenance FROM resource_scopes "
                "WHERE resource_kind=? AND resource_id=?",
                (store._doc_resource_kind(
                    store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION
                ), job_id),
            ).fetchone()
        self.assertEqual(
            ("member", "resource-user", "resource-user",
             "v140008-canvas-job-incremental"),
            scope,
        )
        before = logical_database_dump(store.DB_PATH)
        replay = self._call(
            production_recovery.settle_resource_scopes_incremental,
            dry_run=False,
        )
        self.assertFalse(replay["applied"])
        self.assertEqual(0, replay["insertedRows"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

    def test_historical_team_adoption_moves_only_prejoin_personal_rows(self):
        self._member("adoption-user", role="editor")
        joined_at = int(time.time() * 1000) + 60_000
        captured_at = joined_at - 1_000
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at) "
                "VALUES('team-adopt','收编团队','team-adopt','customer','active',"
                "'team','shared',?)",
                (captured_at,),
            )
            conn.execute(
                "INSERT INTO team_members(team_id,member_id,team_role,status,"
                "joined_at,added_by) VALUES('team-adopt','adoption-user','creator',"
                "'active',?,'owner')",
                (joined_at,),
            )
            payload = {
                "id": "prejoin-asset", "ownerId": "adoption-user",
                "name": "加入团队前的资产",
            }
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                "VALUES('assets','prejoin-asset','adoption-user',?,?)",
                (captured_at, json.dumps(payload, ensure_ascii=False)),
            )
            conn.execute(
                "INSERT INTO resource_scopes(resource_kind,resource_id,scope_type,"
                "scope_id,owner_id,provenance,captured_at,updated_at) "
                "VALUES('doc:assets','prejoin-asset','member','adoption-user',"
                "'adoption-user','historical-personal',?,?)",
                (captured_at, captured_at),
            )
            conn.execute(
                "INSERT INTO private_media_registry(media_kind,media_key,owner_id,"
                "team_id,provenance_kind,provenance_id,created_at,updated_at) "
                "VALUES('upload','adoption-user--prejoin.png','adoption-user','',"
                "'server-asset','prejoin-asset',?,?)",
                (captured_at, captured_at),
            )
            conn.commit()

        preview = self._call(
            production_recovery.settle_tenant_adoptions, dry_run=True,
        )
        self.assertEqual(1, preview["plannedMembers"])
        self.assertEqual(2, preview["plannedRows"])
        result = self._call(
            production_recovery.settle_tenant_adoptions, dry_run=False,
        )
        self.assertEqual(2, result["appliedRows"])
        with store._connect() as conn:
            scope = conn.execute(
                "SELECT scope_type,scope_id FROM resource_scopes "
                "WHERE resource_kind='doc:assets' AND resource_id='prejoin-asset'"
            ).fetchone()
            media_team = conn.execute(
                "SELECT team_id FROM private_media_registry "
                "WHERE media_kind='upload' AND media_key='adoption-user--prejoin.png'"
            ).fetchone()[0]
        self.assertEqual(("team", "team-adopt"), scope)
        self.assertEqual("team-adopt", media_team)
        before = logical_database_dump(store.DB_PATH)
        replay = self._call(
            production_recovery.settle_tenant_adoptions, dry_run=False,
        )
        self.assertFalse(replay["applied"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

    def _historical_evidence(self, owner_id, media_key, stored_name):
        snapshot_root = self.root / "historical-snapshot"
        restore_root = self.root / "historical-restore"
        snapshot_root.mkdir()
        (restore_root / "canvas-blobs" / Path(stored_name).parent).mkdir(
            parents=True
        )
        source_path = restore_root / "canvas-blobs" / stored_name
        source_path.write_bytes(PNG_BYTES)

        historical_db = snapshot_root / "database.sqlite"
        with sqlite3.connect(historical_db) as conn:
            conn.execute(
                "CREATE TABLE custom_canvas_blobs("
                "owner_id TEXT,content_hash TEXT,mime TEXT,size INTEGER,"
                "stored_name TEXT)"
            )
            conn.execute(
                "INSERT INTO custom_canvas_blobs VALUES(?,?,?,?,?)",
                (owner_id, media_key, "image/png", len(PNG_BYTES), stored_name),
            )
            conn.commit()
        shutil.copyfile(historical_db, restore_root / "database")
        db_manifest = snapshot_root / "database.manifest.json"
        db_manifest.write_text("{}\n", "utf-8")

        canvas_tar = snapshot_root / "canvas-blobs.tar"
        entry = {
            "path": stored_name,
            "bytes": len(PNG_BYTES),
            "sha256": hashlib.sha256(PNG_BYTES).hexdigest(),
            "mode": 0o600,
            "mtimeNs": 1,
        }
        with tarfile.open(canvas_tar, "w") as archive:
            info = tarfile.TarInfo(stored_name)
            info.size = len(PNG_BYTES)
            info.mode = 0o600
            archive.addfile(info, io.BytesIO(PNG_BYTES))

        components = []
        for name in sorted(production_recovery.HISTORICAL_COMPLETE_COMPONENTS_V140):
            kind, required, _path, _outside, _dereference = (
                runtime_snapshot.PRODUCTION_COMPLETE_COMPONENTS[name]
            )
            if name == "database":
                components.append({
                    "name": name,
                    "type": kind,
                    "state": "present",
                    "artifact": historical_db.name,
                    "artifactBytes": historical_db.stat().st_size,
                    "artifactSha256": runtime_snapshot._sha256(historical_db),
                    "databaseManifest": db_manifest.name,
                    "databaseManifestSha256": runtime_snapshot._sha256(db_manifest),
                })
            elif name == "canvas-blobs":
                components.append({
                    "name": name,
                    "type": kind,
                    "state": "present",
                    "artifact": canvas_tar.name,
                    "artifactBytes": canvas_tar.stat().st_size,
                    "artifactSha256": runtime_snapshot._sha256(canvas_tar),
                    "files": [entry],
                })
            elif required:
                item = {"name": name, "type": kind, "state": "present"}
                if kind == "directory":
                    item["files"] = []
                components.append(item)
            else:
                components.append({"name": name, "type": kind, "state": "absent"})
        media_digest = runtime_snapshot._media_inventory_digest_from_components(
            components
        )
        manifest = {
            "format": runtime_snapshot.SNAPSHOT_FORMAT,
            "profile": runtime_snapshot.PRODUCTION_COMPLETE_PROFILE,
            "snapshotId": "historical-evidence",
            "releaseId": "599c576-test",
            "components": components,
        }
        manifest_raw = (
            json.dumps(manifest, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        manifest_sha = hashlib.sha256(manifest_raw).hexdigest()
        (snapshot_root / "snapshot.manifest.json").write_bytes(manifest_raw)
        (snapshot_root / "snapshot.manifest.sha256").write_text(
            manifest_sha + "\n", "ascii"
        )
        restored_components = []
        for item in components:
            if item["state"] == "absent":
                restored_components.append({"name": item["name"], "state": "absent"})
            else:
                restored_components.append({
                    "name": item["name"], "type": item["type"]
                })
        report = {
            "format": runtime_snapshot.RESTORE_FORMAT,
            "snapshotId": "historical-evidence",
            "releaseId": "599c576-test",
            "snapshotManifestSha256": manifest_sha,
            "components": restored_components,
            "ok": True,
        }
        report_raw = (
            json.dumps(report, sort_keys=True, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        report_sha = hashlib.sha256(report_raw).hexdigest()
        (restore_root / "restore.report.json").write_bytes(report_raw)
        (restore_root / "restore.report.sha256").write_text(
            report_sha + "\n", "ascii"
        )
        return {
            "id": "historical-599c576",
            "snapshotRoot": str(snapshot_root),
            "snapshotManifestSha256": manifest_sha,
            "restoreRoot": str(restore_root),
            "restoreReportSha256": report_sha,
            "mode": "historical-media-evidence-v1",
            "verifiedByRelease": "599c576-test",
            "verifiedComponentCount": len(components),
            "verifiedMediaInventoryDigest": media_digest,
        }

    def test_verified_historical_canvas_recovery_is_no_overwrite_and_replays_fresh(self):
        owner = "community-owner"
        self._member(owner)
        media_key = hashlib.sha256(b"image/png\0" + PNG_BYTES).hexdigest()
        stored_name = store._custom_canvas_blob_relative_path(
            owner, media_key, "image/png"
        )
        post_id = "recover-community-post"
        media_url = f"/api/custom-canvas/blobs/{media_key}"
        now = int(time.time() * 1000)
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO community_posts("
                "id,author_id,author_name,team_id,source_kind,source_id,title,"
                "copy_text,prompt_text,category,media_json,cover_json,identity_key,"
                "status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    post_id, owner, owner, "", "canvas", "source", "恢复社区图",
                    "", "", "视觉设计",
                    json.dumps([{"url": media_url, "type": "image"}]),
                    "{}", "recover-identity", "published", now, now,
                ),
            )
            conn.commit()
        evidence_set = self._historical_evidence(owner, media_key, stored_name)
        identity, _backup, snapshot = self._bindings()
        plan = {
            "format": production_recovery.CANVAS_RECOVERY_PLAN_FORMAT,
            "databaseIdentity": identity,
            "snapshotManifestSha256": snapshot["manifestSha256"],
            "snapshotMediaInventoryDigest": snapshot["mediaInventoryDigest"],
            "evidenceSets": [evidence_set],
            "entries": [{
                "mediaKey": media_key,
                "ownerId": owner,
                "mime": "image/png",
                "size": len(PNG_BYTES),
                "storedName": stored_name,
                "sourceEvidenceId": evidence_set["id"],
                "sourceRelativePath": f"canvas-blobs/{stored_name}",
                "historicalRows": [{
                    "evidenceId": evidence_set["id"],
                    "databaseRelativePath": "database",
                }],
                "currentReference": {
                    "resourceKind": "community-post", "resourceId": post_id,
                },
                "evidence": "Verified historical database owner and semantic image hash.",
            }],
            "reviewedBy": "test-operator",
            "reviewedAt": int(time.time() * 1000),
        }
        plan_sha = production_recovery.canonical_sha256(plan)
        result = self._call(
            production_recovery.recover_canvas_blobs_reviewed,
            plan=plan, plan_sha256=plan_sha, dry_run=False,
        )
        self.assertTrue(result["applied"])
        recovered, error = store.get_custom_canvas_blob(owner, media_key)
        self.assertIsNone(error)
        self.assertEqual(PNG_BYTES, recovered["path"].read_bytes())
        before = logical_database_dump(store.DB_PATH)
        fresh_snapshot = current_runtime_snapshot_binding(store)
        fresh_snapshot["manifestSha256"] = "d" * 64
        with patch.dict(
            os.environ, {"ACG_ALLOW_CANVAS_BLOB_RECOVERY": "1"}, clear=False,
        ):
            replay = production_recovery.recover_canvas_blobs_reviewed(
                plan=plan, plan_sha256=plan_sha,
                expected_identity=store._database_identity(store.DB_PATH),
                expected_schema_version=store.LATEST_SCHEMA_MIGRATION_VERSION,
                backup_binding=current_backup_binding(store, store.DB_PATH),
                runtime_snapshot_binding=fresh_snapshot,
                created_by="test-operator", dry_run=False,
            )
        self.assertFalse(replay["applied"])
        self.assertEqual(0, replay["recoveredRows"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

    def test_incident_adjudication_requires_exact_business_set_and_never_unblocks(self):
        owner = "incident-owner"
        self._member(owner)
        community_key = "1" * 64
        job_key = "2" * 64
        upload_key = f"{owner}--lost-upload.png"
        now = int(time.time() * 1000)
        self._insert_scoped_doc(
            store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
            "lost-job", owner,
            {
                "id": "lost-job", "ownerId": owner, "status": "succeeded",
                "images": [{
                    "assetUrl": f"/api/custom-canvas/blobs/{job_key}"
                }],
            },
        )
        self._insert_scoped_doc(
            "assets", "lost-upload-asset", owner,
            {
                "id": "lost-upload-asset", "ownerId": owner,
                "serverFileName": upload_key,
                "fileUrl": f"/api/files/{upload_key}",
                "hasBlob": True,
            },
        )
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO community_posts("
                "id,author_id,author_name,team_id,source_kind,source_id,title,"
                "copy_text,prompt_text,category,media_json,cover_json,identity_key,"
                "status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "lost-community", owner, owner, "", "canvas", "source",
                    "丢失社区媒体", "", "", "视觉设计",
                    json.dumps([{
                        "url": f"/api/custom-canvas/blobs/{community_key}",
                        "type": "image",
                    }]),
                    "{}", "lost-community-identity", "published", now, now,
                ),
            )
            conn.commit()
        with store._connect(read_only=True) as conn:
            media_plan = store._private_media_plan_locked(
                conn, include_issue_identities=True
            )
        missing = sorted(
            (row["mediaKind"], row["mediaKey"])
            for row in media_plan["_issueIdentities"]["missingReferencedFiles"]
        )
        self.assertEqual(
            sorted([
                ("canvas-blob", community_key),
                ("canvas-blob", job_key),
                ("upload", upload_key),
            ]),
            missing,
        )
        identity, _backup, snapshot = self._bindings()
        entries = []
        with store._connect(read_only=True) as conn:
            for kind, key in missing:
                business_class = production_recovery._missing_media_business_class_locked(
                    conn, kind, key
                )
                evidence = f"No verified recovery evidence remains for {kind}:{key}."
                entries.append({
                    "domain": "missing-media",
                    "targetKind": kind,
                    "targetId": key,
                    "disposition": "no-verified-recovery-evidence",
                    "evidence": evidence,
                    "evidenceSha256": hashlib.sha256(
                        evidence.encode("utf-8")
                    ).hexdigest(),
                    "businessClass": business_class,
                })
        plan = {
            "format": production_recovery.INCIDENT_ADJUDICATION_PLAN_FORMAT,
            "databaseIdentity": identity,
            "snapshotManifestSha256": snapshot["manifestSha256"],
            "snapshotMediaInventoryDigest": snapshot["mediaInventoryDigest"],
            "entries": entries,
            "reviewedBy": "test-operator",
            "reviewedAt": int(time.time() * 1000),
        }
        incomplete = {**plan, "entries": entries[:-1]}
        with self.assertRaisesRegex(
            production_recovery.ProductionRecoveryError, "exact_set"
        ):
            self._call(
                production_recovery.record_incident_adjudications,
                plan=incomplete,
                plan_sha256=production_recovery.canonical_sha256(incomplete),
                dry_run=False,
            )
        result = self._call(
            production_recovery.record_incident_adjudications,
            plan=plan,
            plan_sha256=production_recovery.canonical_sha256(plan),
            dry_run=False,
        )
        self.assertTrue(result["applied"])
        self.assertTrue(result["readinessUnchanged"])
        before = logical_database_dump(store.DB_PATH)
        fresh_snapshot = current_runtime_snapshot_binding(store)
        fresh_snapshot["manifestSha256"] = "e" * 64
        with patch.dict(
            os.environ, {"ACG_ALLOW_INCIDENT_ADJUDICATION": "1"}, clear=False,
        ):
            replay = production_recovery.record_incident_adjudications(
                plan=plan,
                plan_sha256=production_recovery.canonical_sha256(plan),
                expected_identity=store._database_identity(store.DB_PATH),
                expected_schema_version=store.LATEST_SCHEMA_MIGRATION_VERSION,
                backup_binding=current_backup_binding(store, store.DB_PATH),
                runtime_snapshot_binding=fresh_snapshot,
                created_by="test-operator", dry_run=False,
            )
        self.assertFalse(replay["applied"])
        self.assertEqual(0, replay["insertedRows"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))


if __name__ == "__main__":
    unittest.main()
