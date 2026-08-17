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

from server import main as server_main
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
        self.previous_composed_dir = store.PRIVATE_MEDIA_COMPOSED_DIR
        self.previous_video_output_dir = store.PRIVATE_MEDIA_VIDEO_OUTPUT_DIR
        self.previous_video_upload_dir = store.PRIVATE_MEDIA_VIDEO_UPLOAD_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = self.root / "data.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = self.root / "canvas_blobs"
        store.PRIVATE_MEDIA_UPLOAD_DIR = self.root / "uploads"
        store.PRIVATE_MEDIA_COMPOSED_DIR = self.root / "composed"
        store.PRIVATE_MEDIA_VIDEO_OUTPUT_DIR = self.root / "video-outputs"
        store.PRIVATE_MEDIA_VIDEO_UPLOAD_DIR = self.root / "video-uploads"
        for path in (
            store.CUSTOM_CANVAS_BLOB_DIR,
            store.PRIVATE_MEDIA_UPLOAD_DIR,
            store.PRIVATE_MEDIA_COMPOSED_DIR,
            store.PRIVATE_MEDIA_VIDEO_OUTPUT_DIR,
            store.PRIVATE_MEDIA_VIDEO_UPLOAD_DIR,
        ):
            path.mkdir(parents=True, exist_ok=True)
        store._initialized = False
        store._ensure_db()
        self._mark_data_migrations()

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store.PRIVATE_MEDIA_UPLOAD_DIR = self.previous_upload_dir
        store.PRIVATE_MEDIA_COMPOSED_DIR = self.previous_composed_dir
        store.PRIVATE_MEDIA_VIDEO_OUTPUT_DIR = self.previous_video_output_dir
        store.PRIVATE_MEDIA_VIDEO_UPLOAD_DIR = self.previous_video_upload_dir
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
                "ACG_ALLOW_MEDIA_ISOLATION": "1",
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

    def test_current_snapshot_contract_accepts_20_and_rejects_legacy_18(self):
        current_names = frozenset(runtime_snapshot.PRODUCTION_COMPLETE_COMPONENTS)
        legacy_names = production_recovery.HISTORICAL_COMPLETE_COMPONENTS_V140
        self.assertEqual(20, len(current_names))
        self.assertEqual(
            current_names,
            store.PRIVATE_MEDIA_RUNTIME_SNAPSHOT_COMPLETE_COMPONENTS,
        )
        self.assertEqual(
            current_names - {"systemd-main-dropins", "systemd-video-dropins"},
            legacy_names,
        )
        self.assertEqual(18, len(legacy_names))

        identity, backup, current = self._bindings()
        common = {
            "expected_identity": identity,
            "expected_schema_version": store.LATEST_SCHEMA_MIGRATION_VERSION,
            "backup_binding": backup,
            "created_by": "test-operator",
            "dry_run": True,
        }
        with patch.dict(
            os.environ,
            {"ACG_RUNTIME_MODE": "production", "ACG_READ_ONLY": "1"},
            clear=False,
        ):
            resource = production_recovery.settle_resource_scopes_incremental(
                runtime_snapshot_binding=current,
                **common,
            )
            tenant = production_recovery.settle_tenant_adoptions(
                runtime_snapshot_binding=current,
                **common,
            )
            self.assertTrue(resource["ok"])
            self.assertTrue(tenant["ok"])
            with self.assertRaisesRegex(
                production_recovery.ProductionRecoveryError,
                "canvas_recovery_plan_fields_invalid",
            ):
                production_recovery.recover_canvas_blobs_reviewed(
                    plan={}, plan_sha256="a" * 64,
                    runtime_snapshot_binding=current,
                    **common,
                )

            legacy_current_binding = {
                **current,
                "componentNames": sorted(legacy_names),
            }
            for function in (
                production_recovery.settle_resource_scopes_incremental,
                production_recovery.settle_tenant_adoptions,
            ):
                with self.assertRaisesRegex(
                    store.StoreNotReadyError,
                    "production runtime snapshot component set is incomplete",
                ):
                    function(
                        runtime_snapshot_binding=legacy_current_binding,
                        **common,
                    )
            with self.assertRaisesRegex(
                store.StoreNotReadyError,
                "production runtime snapshot component set is incomplete",
            ):
                production_recovery.recover_canvas_blobs_reviewed(
                    plan={}, plan_sha256="a" * 64,
                    runtime_snapshot_binding=legacy_current_binding,
                    **common,
                )

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
        self._member("resource-user", role="editor")
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at) "
                "VALUES('resource-team','资源团队','resource-team','customer',"
                "'active','team','shared',1)"
            )
            conn.execute(
                "INSERT INTO team_members(team_id,member_id,team_role,status,"
                "joined_at,added_by) VALUES('resource-team','resource-user',"
                "'creator','active',1,'owner')"
            )
            conn.commit()
        self._insert_scoped_doc(
            "customProjects", "canvas-project", "resource-user",
            {"id": "canvas-project", "ownerId": "resource-user"},
            scope_type="team", scope_id="resource-team",
        )
        jobs = {
            "canvas-job-absent-project": "browser-local-project",
            "canvas-job-matching-project": "canvas-project",
        }
        with store._connect() as conn:
            for index, (job_id, project_id) in enumerate(jobs.items(), 1):
                payload = {
                    "id": job_id,
                    "jobId": f"client-job-{index}",
                    "ownerId": "resource-user",
                    "sourceProjectId": project_id,
                    "requestFingerprint": f"{index}" * 64,
                    "status": "succeeded",
                    "images": [],
                }
                conn.execute(
                    "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                    "VALUES(?,?,?,?,?)",
                    (
                        store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
                        job_id, "resource-user", 100 + index,
                        json.dumps(payload),
                    ),
                )
            conn.commit()

        preview = self._call(
            production_recovery.settle_resource_scopes_incremental,
            dry_run=True,
        )
        self.assertEqual(2, preview["missingRows"])
        self.assertEqual(2, preview["plannedRows"])
        self.assertEqual(1, preview["historicalSourceProjectsAbsent"])
        result = self._call(
            production_recovery.settle_resource_scopes_incremental,
            dry_run=False,
        )
        self.assertTrue(result["applied"])
        self.assertEqual(2, result["insertedRows"])
        with store._connect() as conn:
            scopes = {
                row[0]: tuple(row[1:])
                for row in conn.execute(
                    "SELECT resource_id,scope_type,scope_id,owner_id,provenance "
                    "FROM resource_scopes WHERE resource_kind=? "
                    "AND resource_id IN (?,?) ORDER BY resource_id",
                    (
                        store._doc_resource_kind(
                            store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION
                        ),
                        *sorted(jobs),
                    ),
                ).fetchall()
            }
        self.assertEqual(
            (
                "team", "resource-team", "resource-user",
                "v140008-canvas-job-incremental-"
                "historical-source-project-absent",
            ),
            scopes["canvas-job-absent-project"],
        )
        self.assertEqual(
            (
                "team", "resource-team", "resource-user",
                "v140008-canvas-job-incremental",
            ),
            scopes["canvas-job-matching-project"],
        )
        before = logical_database_dump(store.DB_PATH)
        replay = self._call(
            production_recovery.settle_resource_scopes_incremental,
            dry_run=False,
        )
        self.assertFalse(replay["applied"])
        self.assertEqual(0, replay["insertedRows"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

    def test_resource_incremental_existing_project_scope_must_match(self):
        self._member("project-boundary-user")
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at) "
                "VALUES('conflicting-project-team','冲突团队','conflicting-project-team',"
                "'customer','active','team','shared',1)"
            )
            for project_id in ("project-no-scope", "project-wrong-scope"):
                project = {
                    "id": project_id, "ownerId": "project-boundary-user",
                }
                conn.execute(
                    "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                    "VALUES('customProjects',?,'project-boundary-user',1,?)",
                    (project_id, json.dumps(project)),
                )
                job_id = f"job-{project_id}"
                job = {
                    "id": job_id, "jobId": job_id,
                    "ownerId": "project-boundary-user",
                    "sourceProjectId": project_id,
                    "requestFingerprint": "a" * 64,
                    "status": "succeeded", "images": [],
                }
                conn.execute(
                    "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                    "VALUES(?,?,?,?,?)",
                    (
                        store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
                        job_id, "project-boundary-user", 2, json.dumps(job),
                    ),
                )
            conn.execute(
                "INSERT INTO resource_scopes(resource_kind,resource_id,scope_type,"
                "scope_id,owner_id,provenance,captured_at,updated_at) "
                "VALUES('doc:customProjects','project-wrong-scope','team',"
                "'conflicting-project-team','project-boundary-user','test',1,1)"
            )
            conn.commit()
        with store._connect(read_only=True) as conn:
            plan = production_recovery._resource_incremental_plan_locked(conn)
        self.assertFalse(plan["ok"])
        self.assertEqual(3, plan["missingRows"])
        self.assertEqual(0, plan["plannedRows"])
        self.assertEqual(
            {
                "canvas_job_project_scope_missing",
                "canvas_job_project_scope_conflict",
                "unexpected_missing_resource_collection",
            },
            set(plan["issues"]),
        )

    def test_resource_incremental_rejects_job_actor_and_project_identity_drift(self):
        self._member("resource-identity-user")
        self._member("other-project-owner")
        with store._connect() as conn:
            projects = {
                "project-owner-conflict": {
                    "dbOwner": "other-project-owner",
                    "payload": {
                        "id": "project-owner-conflict",
                        "ownerId": "other-project-owner",
                    },
                },
                "project-identity-conflict": {
                    "dbOwner": "resource-identity-user",
                    "payload": {
                        "id": "different-project-id",
                        "ownerId": "resource-identity-user",
                    },
                },
            }
            for project_id, project in projects.items():
                conn.execute(
                    "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                    "VALUES('customProjects',?,?,1,?)",
                    (
                        project_id, project["dbOwner"],
                        json.dumps(project["payload"]),
                    ),
                )
                conn.execute(
                    "INSERT INTO resource_scopes(resource_kind,resource_id,"
                    "scope_type,scope_id,owner_id,provenance,captured_at,updated_at) "
                    "VALUES('doc:customProjects',?,'member','resource-identity-user',"
                    "'resource-identity-user','test',1,1)",
                    (project_id,),
                )
                job_id = f"job-{project_id}"
                job = {
                    "id": job_id, "jobId": job_id,
                    "ownerId": "resource-identity-user",
                    "sourceProjectId": project_id,
                    "requestFingerprint": "b" * 64,
                    "status": "succeeded", "images": [],
                }
                conn.execute(
                    "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                    "VALUES(?,?,?,?,?)",
                    (
                        store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
                        job_id, "resource-identity-user", 2, json.dumps(job),
                    ),
                )
            invalid_owner_job = {
                "id": "job-owner-conflict", "jobId": "job-owner-conflict",
                "ownerId": "other-project-owner", "sourceProjectId": "",
                "requestFingerprint": "c" * 64,
                "status": "succeeded", "images": [],
            }
            missing_actor_job = {
                "id": "job-missing-actor", "jobId": "job-missing-actor",
                "ownerId": "missing-actor", "sourceProjectId": "",
                "requestFingerprint": "d" * 64,
                "status": "succeeded", "images": [],
            }
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                "VALUES(?,?,?,?,?)",
                (
                    store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
                    "job-owner-conflict", "resource-identity-user", 3,
                    json.dumps(invalid_owner_job),
                ),
            )
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                "VALUES(?,?,?,?,?)",
                (
                    store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
                    "job-missing-actor", "missing-actor", 4,
                    json.dumps(missing_actor_job),
                ),
            )
            conn.commit()
        with store._connect(read_only=True) as conn:
            plan = production_recovery._resource_incremental_plan_locked(conn)
        self.assertFalse(plan["ok"])
        self.assertEqual(4, plan["missingRows"])
        self.assertEqual(0, plan["plannedRows"])
        self.assertEqual(
            {
                "canvas_job_owner_invalid",
                "canvas_job_owner_scope_missing",
                "canvas_job_project_owner_invalid",
                "canvas_job_project_identity_invalid",
            },
            set(plan["issues"]),
        )

    def test_historical_team_adoption_moves_only_prejoin_personal_rows(self):
        self._member("adoption-user", role="editor")
        joined_at = int(time.time() * 1000) + 60_000
        captured_at = joined_at - 1_000
        post_join_at = joined_at + 1_000
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
            post_join_payload = {
                "id": "postjoin-team-asset", "ownerId": "adoption-user",
                "name": "加入团队后正常创建的团队资产",
            }
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                "VALUES('assets','postjoin-team-asset','adoption-user',?,?)",
                (
                    post_join_at,
                    json.dumps(post_join_payload, ensure_ascii=False),
                ),
            )
            conn.execute(
                "INSERT INTO resource_scopes(resource_kind,resource_id,scope_type,"
                "scope_id,owner_id,provenance,captured_at,updated_at) "
                "VALUES('doc:assets','postjoin-team-asset','team','team-adopt',"
                "'adoption-user','normal-team-write',?,?)",
                (post_join_at, post_join_at),
            )
            conn.execute(
                "INSERT INTO private_media_registry(media_kind,media_key,owner_id,"
                "team_id,provenance_kind,provenance_id,created_at,updated_at) "
                "VALUES('upload','adoption-user--postjoin.png','adoption-user',"
                "'team-adopt','server-asset','postjoin-team-asset',?,?)",
                (post_join_at, post_join_at),
            )
            conn.commit()

        with store._connect(read_only=True) as conn:
            member_plan = store._personal_tenant_adoption_plan_locked(
                conn, "adoption-user", "team-adopt",
            )
        self.assertEqual(
            [("doc:assets", "prejoin-asset")],
            member_plan["personalScopes"],
        )
        self.assertEqual(
            [("upload", "adoption-user--prejoin.png")],
            member_plan["personalMedia"],
        )
        self.assertEqual(
            [("doc:assets", "postjoin-team-asset")],
            member_plan["alreadyTeamScopes"],
        )
        self.assertEqual(
            [("upload", "adoption-user--postjoin.png")],
            member_plan["alreadyTeamMedia"],
        )
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
            post_join_scope = conn.execute(
                "SELECT scope_type,scope_id,provenance FROM resource_scopes "
                "WHERE resource_kind='doc:assets' "
                "AND resource_id='postjoin-team-asset'"
            ).fetchone()
            post_join_media = conn.execute(
                "SELECT team_id,provenance_kind FROM private_media_registry "
                "WHERE media_kind='upload' "
                "AND media_key='adoption-user--postjoin.png'"
            ).fetchone()
        self.assertEqual(("team", "team-adopt"), scope)
        self.assertEqual("team-adopt", media_team)
        self.assertEqual(
            ("team", "team-adopt", "normal-team-write"), post_join_scope,
        )
        self.assertEqual(("team-adopt", "server-asset"), post_join_media)
        before = logical_database_dump(store.DB_PATH)
        replay = self._call(
            production_recovery.settle_tenant_adoptions, dry_run=False,
        )
        self.assertFalse(replay["applied"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

    def test_historical_team_adoption_rejects_postjoin_personal_media(self):
        self._member("late-media-user", role="editor")
        joined_at = int(time.time() * 1000)
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at) "
                "VALUES('late-media-team','团队','late-media-team','customer',"
                "'active','team','shared',?)",
                (joined_at - 1,),
            )
            conn.execute(
                "INSERT INTO team_members(team_id,member_id,team_role,status,"
                "joined_at,added_by) VALUES('late-media-team','late-media-user',"
                "'creator','active',?,'owner')",
                (joined_at,),
            )
            conn.execute(
                "INSERT INTO private_media_registry(media_kind,media_key,owner_id,"
                "team_id,provenance_kind,provenance_id,created_at,updated_at) "
                "VALUES('upload','late-media-user--late.png','late-media-user','',"
                "'server-asset','late-media',?,?)",
                (joined_at + 1, joined_at + 1),
            )
            conn.commit()
        with store._connect(read_only=True) as conn:
            with self.assertRaisesRegex(
                store.StoreNotReadyError,
                "tenant adoption media was created after team join",
            ):
                store._personal_tenant_adoption_plan_locked(
                    conn, "late-media-user", "late-media-team",
                )

    def test_historical_team_adoption_rejects_wrong_team_resource_and_media(self):
        for suffix, wrong_kind in (("resource", "resource"), ("media", "media")):
            member_id = f"wrong-team-{suffix}-user"
            target_team = f"target-{suffix}-team"
            wrong_team = f"other-{suffix}-team"
            self._member(member_id, role="editor")
            joined_at = int(time.time() * 1000)
            with store._connect() as conn:
                for team_id in (target_team, wrong_team):
                    conn.execute(
                        "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,"
                        "created_at) VALUES(?,?,?,?, 'active','team','shared',?)",
                        (team_id, team_id, team_id, "customer", joined_at - 1),
                    )
                conn.execute(
                    "INSERT INTO team_members(team_id,member_id,team_role,status,"
                    "joined_at,added_by) VALUES(?,?, 'creator','active',?,'owner')",
                    (target_team, member_id, joined_at),
                )
                if wrong_kind == "resource":
                    payload = json.dumps(
                        {"id": f"wrong-{suffix}-asset", "ownerId": member_id},
                        ensure_ascii=False,
                    )
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('assets',?,?,?,?)",
                        (f"wrong-{suffix}-asset", member_id, joined_at + 1, payload),
                    )
                    conn.execute(
                        "INSERT INTO resource_scopes(resource_kind,resource_id,"
                        "scope_type,scope_id,owner_id,provenance,captured_at,updated_at) "
                        "VALUES('doc:assets',?,'team',?,?, 'wrong-team',?,?)",
                        (
                            f"wrong-{suffix}-asset", wrong_team, member_id,
                            joined_at + 1, joined_at + 1,
                        ),
                    )
                else:
                    conn.execute(
                        "INSERT INTO private_media_registry(media_kind,media_key,"
                        "owner_id,team_id,provenance_kind,provenance_id,created_at,"
                        "updated_at) VALUES('upload',?,?,?,'server-asset','wrong',?,?)",
                        (
                            f"{member_id}--wrong.png", member_id, wrong_team,
                            joined_at + 1, joined_at + 1,
                        ),
                    )
                conn.commit()
            expected = (
                "tenant adoption resource scope conflicts"
                if wrong_kind == "resource"
                else "tenant adoption private media team conflicts"
            )
            with self.subTest(kind=wrong_kind), store._connect(read_only=True) as conn:
                with self.assertRaisesRegex(store.StoreNotReadyError, expected):
                    store._personal_tenant_adoption_plan_locked(
                        conn, member_id, target_team,
                    )

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

    def test_temporary_and_unreferenced_registry_media_are_audit_only(self):
        owner = "registry-lifecycle-owner"
        self._member(owner, role="editor")
        video_root = store.PRIVATE_MEDIA_VIDEO_OUTPUT_DIR
        hidden = video_root / "project-1" / ".scene-01-work.candidate.mp4"
        hidden.parent.mkdir(parents=True)
        hidden.write_bytes(b"temporary-render")
        stale_key = f"{owner}--stale.png"
        now = int(time.time() * 1000)
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO private_media_registry(media_kind,media_key,owner_id,"
                "team_id,provenance_kind,provenance_id,created_at,updated_at) "
                "VALUES('upload',?,?, '', 'server-asset','retired-asset',?,?)",
                (stale_key, owner, now, now),
            )
            conn.commit()
        status = store.private_media_registry_status()
        self.assertTrue(status["ok"])
        self.assertEqual(1, status["counts"]["temporaryFiles"])
        self.assertEqual(1, status["counts"]["staleRegistryFiles"])
        self.assertEqual(0, status["counts"]["registryMissingFiles"])
        self.assertEqual(0, status["counts"]["unisolatedMissingReferencedFiles"])
        self.assertIn("temporaryFiles", status["warnings"])
        self.assertIn("staleRegistryFiles", status["warnings"])

    def test_business_reference_missing_file_still_blocks(self):
        owner = "referenced-registry-owner"
        self._member(owner, role="editor")
        media_key = f"{owner}--missing.png"
        now = int(time.time() * 1000)
        self._insert_scoped_doc(
            "assets", "referenced-missing-asset", owner,
            {
                "id": "referenced-missing-asset", "ownerId": owner,
                "serverFileName": media_key,
                "fileUrl": f"/api/files/{media_key}",
                "hasBlob": True,
            },
        )
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO private_media_registry(media_kind,media_key,owner_id,"
                "team_id,provenance_kind,provenance_id,created_at,updated_at) "
                "VALUES('upload',?,?, '', 'server-asset',?,?,?)",
                (media_key, owner, "referenced-missing-asset", now, now),
            )
            conn.commit()
        status = store.private_media_registry_status()
        self.assertFalse(status["ok"])
        self.assertEqual(1, status["counts"]["registryMissingFiles"])
        self.assertEqual(1, status["counts"]["unisolatedMissingReferencedFiles"])
        self.assertEqual(0, status["counts"]["staleRegistryFiles"])

    def test_migrated_registry_keeps_historical_team_scope(self):
        owner = "historical-team-owner"
        team_id = "historical-team"
        self._member(owner, role="editor")
        now = int(time.time() * 1000)
        media_key = f"{owner}--historical.png"
        store.PRIVATE_MEDIA_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        (store.PRIVATE_MEDIA_UPLOAD_DIR / media_key).write_bytes(PNG_BYTES)
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO teams(id,name,slug,kind,status,plan,quota_mode,created_at) "
                "VALUES(?,?,?,'customer','active','team','shared',?)",
                (team_id, team_id, team_id, now),
            )
            conn.execute(
                "INSERT INTO private_media_registry(media_kind,media_key,owner_id,"
                "team_id,provenance_kind,provenance_id,created_at,updated_at) "
                "VALUES('upload',?,?,?,'server-upload',?,?,?)",
                (media_key, owner, team_id, media_key, now, now),
            )
            conn.commit()
        status = store.private_media_registry_status()
        self.assertTrue(status["ok"])
        self.assertEqual(0, status["counts"]["registryConflicts"])

    def test_exact_46_media_isolation_preserves_history_and_fails_closed_on_drift(self):
        owner = "isolation-owner"
        self._member(owner)
        now = int(time.time() * 1000)
        job_keys = [f"{index:064x}" for index in range(1, 39)]
        upload_keys = [f"{owner}--lost-{index}.png" for index in range(1, 8)]
        community_key = "f" * 64
        for index, media_key in enumerate(job_keys, 1):
            self._insert_scoped_doc(
                store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
                f"isolated-job-{index}", owner,
                {
                    "id": f"isolated-job-{index}", "ownerId": owner,
                    "status": "succeeded",
                    "images": [{
                        "assetUrl": f"/api/custom-canvas/blobs/{media_key}",
                        "contentHash": media_key,
                    }],
                },
            )
        for index, media_key in enumerate(upload_keys, 1):
            self._insert_scoped_doc(
                "assets", f"isolated-asset-{index}", owner,
                {
                    "id": f"isolated-asset-{index}", "ownerId": owner,
                    "serverFileName": media_key,
                    "fileUrl": f"/api/files/{media_key}", "hasBlob": True,
                },
            )
        with store._connect() as conn:
            conn.execute(
                "INSERT INTO community_posts("
                "id,author_id,author_name,team_id,source_kind,source_id,title,"
                "copy_text,prompt_text,category,media_json,cover_json,identity_key,"
                "status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    "isolated-community", owner, owner, "", "canvas", "source",
                    "历史社区媒体", "", "", "视觉设计",
                    json.dumps([{
                        "url": f"/api/custom-canvas/blobs/{community_key}",
                        "type": "image",
                    }]),
                    "{}", "isolated-community-identity", "published", now, now,
                ),
            )
            conn.commit()

        identity, backup, snapshot = self._bindings()
        inspection = production_recovery.media_isolation_evidence(
            expected_identity=identity,
            expected_schema_version=store.LATEST_SCHEMA_MIGRATION_VERSION,
            backup_binding=backup,
            runtime_snapshot_binding=snapshot,
        )
        self.assertEqual(46, inspection["missingReferencedFiles"])

        adjudication_entries = []
        for entry in inspection["entries"]:
            evidence = (
                f"No verified recovery evidence remains for "
                f"{entry['mediaKind']}:{entry['mediaKey']}."
            )
            adjudication_entries.append({
                "domain": "missing-media",
                "targetKind": entry["mediaKind"],
                "targetId": entry["mediaKey"],
                "disposition": "no-verified-recovery-evidence",
                "evidence": evidence,
                "evidenceSha256": hashlib.sha256(evidence.encode()).hexdigest(),
                "businessClass": entry["businessClass"],
            })
        adjudication_plan = {
            "format": production_recovery.INCIDENT_ADJUDICATION_PLAN_FORMAT,
            "databaseIdentity": identity,
            "snapshotManifestSha256": snapshot["manifestSha256"],
            "snapshotMediaInventoryDigest": snapshot["mediaInventoryDigest"],
            "entries": adjudication_entries,
            "reviewedBy": "test-operator",
            "reviewedAt": int(time.time() * 1000),
        }
        self._call(
            production_recovery.record_incident_adjudications,
            plan=adjudication_plan,
            plan_sha256=production_recovery.canonical_sha256(adjudication_plan),
            dry_run=False,
        )

        identity, backup, snapshot = self._bindings()
        inspection = production_recovery.media_isolation_evidence(
            expected_identity=identity,
            expected_schema_version=store.LATEST_SCHEMA_MIGRATION_VERSION,
            backup_binding=backup,
            runtime_snapshot_binding=snapshot,
        )
        isolation_plan = {
            "format": production_recovery.MEDIA_ISOLATION_PLAN_FORMAT,
            "databaseIdentity": identity,
            "snapshotManifestSha256": snapshot["manifestSha256"],
            "snapshotMediaInventoryDigest": snapshot["mediaInventoryDigest"],
            "authorization": "user-approved-preserve-history-isolation",
            "rawPendingRows": inspection["rawPendingRows"],
            "publicAvatarExemptions": inspection["publicAvatarExemptions"],
            "entries": inspection["entries"],
            "reviewedBy": "test-operator",
            "reviewedAt": int(time.time() * 1000),
        }
        plan_sha = production_recovery.canonical_sha256(isolation_plan)
        incomplete = {**isolation_plan, "entries": isolation_plan["entries"][:-1]}
        with self.assertRaisesRegex(
            production_recovery.ProductionRecoveryError, "exact_set",
        ):
            self._call(
                production_recovery.isolate_missing_media_reviewed,
                plan=incomplete,
                plan_sha256=production_recovery.canonical_sha256(incomplete),
                dry_run=True,
            )
        changed = json.loads(json.dumps(isolation_plan))
        changed["entries"][0]["ownerId"] = "different-owner"
        with self.assertRaisesRegex(
            production_recovery.ProductionRecoveryError, "evidence_mismatch",
        ):
            self._call(
                production_recovery.isolate_missing_media_reviewed,
                plan=changed,
                plan_sha256=production_recovery.canonical_sha256(changed),
                dry_run=True,
            )
        changed_counts = {**isolation_plan, "rawPendingRows": isolation_plan["rawPendingRows"] + 1}
        with self.assertRaisesRegex(
            production_recovery.ProductionRecoveryError, "audit_counts_mismatch",
        ):
            self._call(
                production_recovery.isolate_missing_media_reviewed,
                plan=changed_counts,
                plan_sha256=production_recovery.canonical_sha256(changed_counts),
                dry_run=True,
            )
        applied = self._call(
            production_recovery.isolate_missing_media_reviewed,
            plan=isolation_plan, plan_sha256=plan_sha, dry_run=False,
        )
        self.assertTrue(applied["applied"])
        self.assertEqual(46, applied["insertedRows"])
        status = store.private_media_registry_status()
        self.assertEqual(46, status["counts"]["missingReferencedFiles"])
        self.assertEqual(46, status["counts"]["isolatedMissingReferencedFiles"])
        self.assertEqual(0, status["counts"]["unisolatedMissingReferencedFiles"])
        self.assertEqual(0, status["counts"]["effectivePendingRows"])
        with store._connect(read_only=True) as conn:
            self.assertEqual(
                46,
                conn.execute(
                    "SELECT COUNT(*) FROM media_isolation_entries"
                ).fetchone()[0],
            )
        isolated_upload, error = store.private_media_isolation_access(
            "upload", upload_keys[0], owner,
        )
        self.assertIsNone(error)
        self.assertEqual("isolated", isolated_upload["state"])
        self._member("outside-member")
        outside, outside_error = store.private_media_isolation_access(
            "upload", upload_keys[0], "outside-member",
        )
        self.assertIsNone(outside)
        self.assertEqual("forbidden", outside_error)
        self.assertIsNotNone(store.public_community_media_isolation(
            "canvas-blob", community_key, "isolated-community",
        ))
        isolation_map = store.community_media_isolation_identity_map([
            "isolated-community", "other-post",
        ])
        self.assertEqual(
            {("canvas-blob", community_key)},
            isolation_map["isolated-community"],
        )
        self.assertEqual(set(), isolation_map["other-post"])
        # Exact historical isolation must not make every later canvas save run
        # fail during its conservative GC pass.  The isolated owner's missing
        # references and another owner's same-hash namespace are both accepted
        # only through the still-valid immutable receipts; no reference, blob
        # or ownership row is rewritten.
        with store._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.assertEqual([], store._custom_canvas_gc_blobs_locked(conn, owner))
            conn.rollback()
        with store._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.assertEqual(
                [],
                store._custom_canvas_gc_blobs_locked(conn, "outside-member"),
            )
            conn.rollback()
        post = store.get_community_post("isolated-community")
        response = server_main._community_post_response(post)
        self.assertEqual("isolated", response["media"][0]["availability"])
        self.assertFalse(response["media"][0]["available"])
        with self.assertRaises(server_main.HTTPException) as media_error:
            server_main.community_post_media(
                "isolated-community", 0,
                type("Request", (), {"headers": {}})(),
            )
        self.assertEqual(410, media_error.exception.status_code)
        with self.assertRaises(server_main.HTTPException) as file_error:
            server_main.file_get(
                upload_keys[0],
                type("Request", (), {"headers": {}})(),
                me={"id": owner},
            )
        self.assertEqual(410, file_error.exception.status_code)
        with store._connect() as conn:
            existing = {
                "id": "isolated-asset-1", "ownerId": owner,
                "fileUrl": f"/api/files/{upload_keys[0]}",
            }
            store._private_media_new_reference_guard_locked(
                conn, existing, {**existing, "title": "metadata remains editable"},
            )
            with self.assertRaisesRegex(ValueError, "immutable"):
                store._private_media_new_reference_guard_locked(
                    conn, existing, {"id": "isolated-asset-1", "ownerId": owner},
                )
            with self.assertRaisesRegex(ValueError, "reference_missing"):
                store._private_media_new_reference_guard_locked(
                    conn, {}, {
                        "id": "new-missing", "ownerId": owner,
                        "fileUrl": f"/api/files/{owner}--future-missing.png",
                    },
                )

        before = logical_database_dump(store.DB_PATH)
        fresh_snapshot = current_runtime_snapshot_binding(store)
        fresh_snapshot["manifestSha256"] = "9" * 64
        with patch.dict(
            os.environ, {"ACG_ALLOW_MEDIA_ISOLATION": "1"}, clear=False,
        ):
            replay = production_recovery.isolate_missing_media_reviewed(
                plan=isolation_plan, plan_sha256=plan_sha,
                expected_identity=store._database_identity(store.DB_PATH),
                expected_schema_version=store.LATEST_SCHEMA_MIGRATION_VERSION,
                backup_binding=current_backup_binding(store, store.DB_PATH),
                runtime_snapshot_binding=fresh_snapshot,
                created_by="test-operator", dry_run=False,
            )
        self.assertFalse(replay["applied"])
        self.assertEqual(0, replay["insertedRows"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

        avatar = store.PRIVATE_MEDIA_UPLOAD_DIR / "member-avatar-drift.png"
        avatar.parent.mkdir(parents=True, exist_ok=True)
        avatar.write_bytes(b"avatar")
        audit_drift = store.private_media_registry_status()
        self.assertEqual(1, audit_drift["counts"]["mediaIsolationAuditDrift"])
        self.assertFalse(audit_drift["ok"])
        avatar.unlink()
        self.assertEqual(
            0,
            store.private_media_registry_status()["counts"]["mediaIsolationAuditDrift"],
        )

        future_key = "e" * 64
        self._insert_scoped_doc(
            store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
            "future-missing-job", owner,
            {
                "id": "future-missing-job", "ownerId": owner,
                "status": "succeeded",
                "images": [{"assetUrl": f"/api/custom-canvas/blobs/{future_key}"}],
            },
        )
        drifted = store.private_media_registry_status()
        self.assertEqual(1, drifted["counts"]["unisolatedMissingReferencedFiles"])
        self.assertFalse(drifted["ok"])


if __name__ == "__main__":
    unittest.main()
