import io
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SERVER_DIR = Path(__file__).resolve().parents[1]
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import model_usage_recovery as recovery


BASE_SCHEMA = """
CREATE TABLE docs(
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  owner_id TEXT,
  updated_at INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  PRIMARY KEY(collection,id)
);
CREATE TABLE members(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE teams(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE team_members(
  team_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  team_role TEXT NOT NULL,
  status TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(team_id,member_id)
);
CREATE TABLE custom_canvas_generation_receipts(
  owner_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  points INTEGER NOT NULL,
  feature TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  charged_at INTEGER,
  PRIMARY KEY(owner_id,receipt_id)
);
CREATE TABLE llm_usage_events(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE api_usage_events(
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  api_type TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT,
  calls INTEGER NOT NULL DEFAULT 1,
  output_units INTEGER NOT NULL DEFAULT 1,
  unit_label TEXT NOT NULL DEFAULT '任务',
  created_at INTEGER NOT NULL
);
CREATE TABLE schema_migrations(
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  app_version TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE model_usage_receipts(
  receipt_id TEXT PRIMARY KEY,
  receipt_key TEXT NOT NULL UNIQUE,
  member_id TEXT NOT NULL,
  member_name TEXT NOT NULL,
  team_id TEXT NOT NULL DEFAULT '',
  surface TEXT NOT NULL,
  feature TEXT NOT NULL,
  usage_kind TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  operation TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL DEFAULT '',
  request_fingerprint TEXT NOT NULL,
  provider_ref TEXT NOT NULL DEFAULT '',
  call_status TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  output_units INTEGER NOT NULL DEFAULT 0,
  unit_label TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  event_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX idx_model_usage_receipts_member_idempotency
  ON model_usage_receipts(source,member_id,idempotency_key)
  WHERE idempotency_key<>'';
CREATE UNIQUE INDEX idx_model_usage_receipts_provider_ref
  ON model_usage_receipts(provider,provider_ref,usage_kind)
  WHERE provider<>'' AND provider_ref<>'';
CREATE TABLE model_usage_outbox(
  receipt_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  last_error TEXT NOT NULL DEFAULT '',
  legacy_event_kind TEXT NOT NULL DEFAULT '',
  legacy_event_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  projected_at INTEGER
);
CREATE INDEX idx_model_usage_outbox_state_available
  ON model_usage_outbox(state,available_at,created_at);
"""


class ModelUsageRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.database = self.root / "source.sqlite"
        self.projects = self.root / "projects"
        self.copies = self.root / "isolated-copies"
        self.projects.mkdir()
        self.copies.mkdir()
        self._create_database(self.database)

    def tearDown(self):
        self.temp.cleanup()

    def _create_database(self, path):
        with sqlite3.connect(path) as conn:
            conn.executescript(BASE_SCHEMA)
            conn.executemany(
                "INSERT INTO members(id,name) VALUES(?,?)",
                [("owner-1", "Owner One"), ("owner-2", "Owner Two")],
            )
            conn.execute("INSERT INTO teams(id,name) VALUES('team-1','Team One')")
            conn.executemany(
                "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at) "
                "VALUES(?,?,?,?,?)",
                [
                    ("team-1", "owner-1", "editor", "active", 100),
                    ("team-1", "owner-2", "editor", "active", 101),
                ],
            )
            conn.executemany(
                "INSERT INTO schema_migrations(version,name,checksum,app_version,"
                "started_at,finished_at,status,summary) VALUES(?,?,?,?,?,?,?,?)",
                [
                    (
                        version,
                        name,
                        recovery.REQUIRED_MIGRATION_CHECKSUMS[version],
                        "test",
                        1,
                        2,
                        "success",
                        "{}",
                    )
                    for version, name in recovery.REQUIRED_MIGRATIONS.items()
                ],
            )

    def _map_project(
        self, custom_id, project_id, owner_id="owner-1", source_only=False, **extra
    ):
        state = {
            "sourceProjectId" if source_only else "workshopProjectId": project_id
        }
        state.update(extra.pop("project_state", {}))
        data = {"id": custom_id, "kind": "video", "projectState": state, **extra}
        with sqlite3.connect(self.database) as conn:
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                "VALUES('customProjects',?,?,?,?)",
                (custom_id, owner_id, 1000, json.dumps(data)),
            )

    def _write_project(self, project_id, **values):
        payload = {
            "id": project_id,
            "status": "succeeded",
            "creationMode": "static",
            "createdAt": "2026-07-31T10:00:00+08:00",
            "updatedAt": "2026-07-31T10:05:00+08:00",
            "events": [],
            "billingUsage": {},
        }
        payload.update(values)
        (self.projects / f"{project_id}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )

    def _write_manifest(self, manifest, name="manifest.json"):
        path = self.root / name
        path.write_bytes(recovery._canonical_bytes(manifest) + b"\n")
        return path

    def _seed_complete_scan_fixture(self):
        with sqlite3.connect(self.database) as conn:
            conn.executemany(
                "INSERT INTO custom_canvas_generation_receipts("
                "owner_id,receipt_id,content_hash,points,feature,expires_at,created_at,charged_at"
                ") VALUES(?,?,?,?,?,?,?,?)",
                [
                    ("owner-1", "canvas-charged", "do-not-leak-content-hash", 5, "generate", 9, 10, 11),
                    ("owner-1", "canvas-unused", "unused-secret-hash", 5, "generate", 9, 10, None),
                ],
            )
        self._map_project("custom-static", "static-1")
        self._write_project(
            "static-1",
            billingUsage={"imageCount": 2, "ttsChars": 321},
            prompt="do-not-leak-prompt",
            apiKey="do-not-leak-api-key",
        )
        self._map_project("custom-static-failed", "static-failed")
        self._write_project(
            "static-failed",
            status="failed",
            billingUsage={"imageCount": 9, "ttsChars": 999},
        )
        # Legacy video mappings sometimes retained only sourceProjectId.
        self._map_project("custom-dynamic", "dynamic-1", source_only=True)
        self._write_project(
            "dynamic-1",
            status="failed",
            creationMode="video",
            events=[
                {
                    "id": "event-accepted",
                    "title": "\u955c\u5934 3 \u5df2\u8fdb\u5165 Seedance \u961f\u5217",
                    "at": "2026-07-31T11:00:00+08:00",
                    "detail": "potentially sensitive detail is excluded",
                },
                {
                    "id": "event-close-but-not-exact",
                    "title": "\u955c\u5934 3 \u5df2\u8fdb\u5165 Seedance \u961f\u5217\uff01",
                    "at": "2026-07-31T11:01:00+08:00",
                },
            ],
        )

    def test_scan_recovers_only_supported_evidence_and_redacts_sensitive_content(self):
        self._seed_complete_scan_fixture()
        manifest = recovery.scan_usage(self.database, self.projects)
        recovery.verify_manifest(manifest)

        self.assertEqual("ok", manifest["source"]["database"]["quickCheck"])
        self.assertEqual(recovery.sha256_file(self.database), manifest["source"]["database"]["sha256"])
        self.assertEqual(5, manifest["counts"]["observations"])
        self.assertEqual({"image": 3, "video": 1, "voice": 1}, manifest["counts"]["byUsageKind"])
        evidence_kinds = [item["evidence"]["kind"] for item in manifest["observations"]]
        self.assertEqual(1, evidence_kinds.count("canvas-charged-receipt"))
        self.assertEqual(2, evidence_kinds.count("static-video-success-billing"))
        self.assertEqual(1, evidence_kinds.count("static-video-success-tts-minimum"))
        self.assertEqual(1, evidence_kinds.count("seedance-queue-accepted-event"))
        voice = next(item for item in manifest["observations"] if item["usageKind"] == "voice")
        self.assertEqual(1, voice["calls"])
        self.assertEqual(321, voice["outputUnits"])
        self.assertFalse(voice["evidence"]["exactAttemptCountKnown"])
        self.assertTrue(any(item["kind"] == "director-llm" for item in manifest["unrecoverable"]))
        serialized = json.dumps(manifest, ensure_ascii=False)
        for forbidden in (
            "do-not-leak-content-hash",
            "unused-secret-hash",
            "do-not-leak-prompt",
            "do-not-leak-api-key",
            "potentially sensitive detail",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertFalse(any(item["usageKind"] == "llm" for item in manifest["observations"]))

    def test_scan_skips_owner_conflicts_missing_members_and_uncharged_canvas(self):
        self._map_project("conflict-a", "project-conflict", owner_id="owner-1")
        self._map_project("conflict-b", "project-conflict", owner_id="owner-2")
        self._write_project("project-conflict", billingUsage={"imageCount": 3})
        self._map_project("missing-member", "project-member-missing", owner_id="ghost-member")
        self._write_project("project-member-missing", billingUsage={"imageCount": 4})
        with sqlite3.connect(self.database) as conn:
            conn.executemany(
                "INSERT INTO custom_canvas_generation_receipts("
                "owner_id,receipt_id,content_hash,points,feature,expires_at,created_at,charged_at"
                ") VALUES(?,?,?,?,?,?,?,?)",
                [
                    ("ghost-member", "ghost-canvas", "secret-a", 5, "x", 9, 10, 11),
                    ("owner-1", "uncharged", "secret-b", 5, "x", 9, 10, None),
                ],
            )

        manifest = recovery.scan_usage(self.database, self.projects)
        self.assertEqual([], manifest["observations"])
        warning_codes = {item["code"] for item in manifest["warnings"]}
        self.assertIn("video_project_owner_conflict", warning_codes)
        self.assertIn("video_project_owner_mapping_missing", warning_codes)
        self.assertIn("video_project_owner_missing", warning_codes)
        self.assertIn("canvas_receipt_owner_missing", warning_codes)

    def test_apply_rejects_source_path_and_both_hash_mismatches(self):
        self._seed_complete_scan_fixture()
        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)
        source_sha = recovery.sha256_file(self.database)

        with self.assertRaisesRegex(recovery.RecoveryError, "distinct_copy"):
            recovery.apply_manifest(
                manifest_path,
                self.database,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=source_sha,
            )

        target = self.copies / "copy.sqlite"
        shutil.copy2(self.database, target)
        with self.assertRaisesRegex(recovery.RecoveryError, "confirm_manifest_sha256_mismatch"):
            recovery.apply_manifest(
                manifest_path,
                target,
                confirm_manifest_sha256="0" * 64,
                expected_db_sha256=source_sha,
            )
        with self.assertRaisesRegex(recovery.RecoveryError, "expected_db_sha256_mismatch"):
            recovery.apply_manifest(
                manifest_path,
                target,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256="1" * 64,
            )

        tampered = dict(manifest)
        tampered["counts"] = dict(manifest["counts"], observations=999)
        tampered_path = self._write_manifest(tampered, "tampered.json")
        with self.assertRaisesRegex(recovery.RecoveryError, "manifest_sha256_mismatch"):
            recovery.apply_manifest(
                tampered_path,
                target,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=source_sha,
            )

        resealed = recovery._seal_manifest(tampered)
        resealed_path = self._write_manifest(resealed, "tampered-resealed.json")
        with self.assertRaisesRegex(recovery.RecoveryError, "manifest_counts_mismatch"):
            recovery.apply_manifest(
                resealed_path,
                target,
                confirm_manifest_sha256=resealed["manifestSha256"],
                expected_db_sha256=source_sha,
            )

    def test_apply_mechanically_rejects_in_place_and_configured_live_targets(self):
        self._seed_complete_scan_fixture()
        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)

        same_directory = self.root / "same-directory-copy.sqlite"
        shutil.copy2(self.database, same_directory)
        with self.assertRaisesRegex(recovery.RecoveryError, "isolated_copy_directory"):
            recovery.apply_manifest(
                manifest_path,
                same_directory,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=recovery.sha256_file(same_directory),
            )

        configured_live = self.copies / "configured-live.sqlite"
        shutil.copy2(self.database, configured_live)
        with patch.dict(os.environ, {"DATA_DB": str(configured_live)}, clear=False):
            with self.assertRaisesRegex(recovery.RecoveryError, "configured_live_database"):
                recovery.apply_manifest(
                    manifest_path,
                    configured_live,
                    confirm_manifest_sha256=manifest["manifestSha256"],
                    expected_db_sha256=recovery.sha256_file(configured_live),
                )

        protected = self.copies / "production-persistent.sqlite"
        shutil.copy2(self.database, protected)
        with patch.dict(
            os.environ,
            {
                "ACG_RUNTIME_MODE": "production",
                "ACG_PERSISTENT_ROOT": str(self.copies),
                "DATA_DB": "",
            },
            clear=False,
        ):
            with self.assertRaisesRegex(recovery.RecoveryError, "production_persistent_root"):
                recovery.reconcile_copy(
                    manifest_path,
                    protected,
                    confirm_manifest_sha256=manifest["manifestSha256"],
                    expected_db_sha256=recovery.sha256_file(protected),
                )

    def test_scan_output_rejects_database_sidecars_projects_aliases_and_existing_files(self):
        self._seed_complete_scan_fixture()
        source_hash = recovery.sha256_file(self.database)
        project_path = self.projects / "static-1.json"
        project_bytes = project_path.read_bytes()
        hardlink = self.root / "source-hardlink.sqlite"
        os.link(self.database, hardlink)
        collisions = [
            self.database,
            Path(str(self.database) + "-wal"),
            Path(str(self.database) + "-shm"),
            Path(str(self.database) + "-journal"),
            project_path,
            hardlink,
        ]
        for collision in collisions:
            with self.subTest(collision=collision):
                with self.assertRaisesRegex(recovery.RecoveryError, "output_path_collides_with_input"):
                    recovery.scan_usage(
                        self.database,
                        self.projects,
                        output_path=collision,
                    )
                self.assertEqual(source_hash, recovery.sha256_file(self.database))
                self.assertEqual(project_bytes, project_path.read_bytes())

        existing = self.root / "existing-manifest.json"
        existing.write_text("sentinel", encoding="utf-8")
        with self.assertRaisesRegex(recovery.RecoveryError, "output_path_already_exists"):
            recovery.scan_usage(
                self.database,
                self.projects,
                output_path=existing,
            )
        self.assertEqual("sentinel", existing.read_text(encoding="utf-8"))

    def test_apply_output_collisions_and_existing_report_never_touch_target(self):
        self._seed_complete_scan_fixture()
        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)
        target = self.copies / "apply-output-guard.sqlite"
        shutil.copy2(self.database, target)
        target_hash = recovery.sha256_file(target)
        project_path = self.projects / "static-1.json"
        collisions = [
            manifest_path,
            self.database,
            Path(str(self.database) + "-wal"),
            Path(str(self.database) + "-shm"),
            Path(str(self.database) + "-journal"),
            target,
            Path(str(target) + "-wal"),
            Path(str(target) + "-shm"),
            Path(str(target) + "-journal"),
            project_path,
        ]
        for collision in collisions:
            with self.subTest(collision=collision):
                with self.assertRaisesRegex(recovery.RecoveryError, "output_path_collides_with_input"):
                    recovery.apply_manifest(
                        manifest_path,
                        target,
                        confirm_manifest_sha256=manifest["manifestSha256"],
                        expected_db_sha256=target_hash,
                        output_path=collision,
                    )
                self.assertEqual(target_hash, recovery.sha256_file(target))
                with sqlite3.connect(target) as conn:
                    self.assertEqual(
                        0,
                        conn.execute("SELECT COUNT(*) FROM model_usage_receipts").fetchone()[0],
                    )

        existing = self.root / "existing-apply-report.json"
        existing.write_text("sentinel", encoding="utf-8")
        with self.assertRaisesRegex(recovery.RecoveryError, "output_path_already_exists"):
            recovery.apply_manifest(
                manifest_path,
                target,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=target_hash,
                output_path=existing,
            )
        self.assertEqual("sentinel", existing.read_text(encoding="utf-8"))
        self.assertEqual(target_hash, recovery.sha256_file(target))

    def test_canonical_output_never_overwrites_and_cleans_failed_temporary_file(self):
        destination = self.root / "audit.json"
        destination.write_text("original", encoding="utf-8")
        with self.assertRaisesRegex(recovery.RecoveryError, "output_path_already_exists"):
            recovery._write_canonical_json(destination, {"ok": True})
        self.assertEqual("original", destination.read_text(encoding="utf-8"))

        destination.unlink()
        with patch.object(recovery.os, "link", side_effect=OSError("simulated-link-failure")):
            with self.assertRaisesRegex(OSError, "simulated-link-failure"):
                recovery._write_canonical_json(destination, {"ok": True})
        self.assertFalse(destination.exists())
        self.assertEqual([], list(self.root.glob("audit.json.*")))
        recovery._write_canonical_json(destination, {"z": 2, "a": 1})
        self.assertEqual(b'{"a":1,"z":2}\n', destination.read_bytes())
        with self.assertRaisesRegex(recovery.RecoveryError, "output_path_already_exists"):
            recovery._write_canonical_json(destination, {"replacement": True})
        self.assertEqual(b'{"a":1,"z":2}\n', destination.read_bytes())

    def test_cli_scan_output_collision_fails_before_touching_database(self):
        self._seed_complete_scan_fixture()
        source_hash = recovery.sha256_file(self.database)
        stderr = io.StringIO()
        with patch.object(recovery.sys, "stderr", stderr):
            result = recovery.main(
                [
                    "scan",
                    "--database",
                    str(self.database),
                    "--video-dir",
                    str(self.projects),
                    "--output",
                    str(self.database),
                ]
            )
        self.assertEqual(2, result)
        self.assertIn("output_path_collides_with_input", stderr.getvalue())
        self.assertEqual(source_hash, recovery.sha256_file(self.database))

    def test_apply_requires_all_three_successful_migrations_and_complete_schema(self):
        self._seed_complete_scan_fixture()
        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)
        target = self.copies / "missing-migration.sqlite"
        shutil.copy2(self.database, target)
        with sqlite3.connect(target) as conn:
            conn.execute("DELETE FROM schema_migrations WHERE version=139001")
        target_sha = recovery.sha256_file(target)
        with self.assertRaisesRegex(recovery.RecoveryError, "139001"):
            recovery.apply_manifest(
                manifest_path,
                target,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=target_sha,
            )

        incomplete = self.copies / "incomplete-schema.sqlite"
        shutil.copy2(self.database, incomplete)
        with sqlite3.connect(incomplete) as conn:
            conn.execute("DROP INDEX idx_model_usage_outbox_state_available")
        with self.assertRaisesRegex(recovery.RecoveryError, "indexes_incomplete"):
            recovery.apply_manifest(
                manifest_path,
                incomplete,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=recovery.sha256_file(incomplete),
            )

    def test_apply_requires_exact_frozen_migration_checksums(self):
        self._seed_complete_scan_fixture()
        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)
        target = self.copies / "wrong-migration-checksum.sqlite"
        shutil.copy2(self.database, target)
        with sqlite3.connect(target) as conn:
            conn.execute(
                "UPDATE schema_migrations SET checksum=? WHERE version=139001",
                ("f" * 64,),
            )
        with self.assertRaisesRegex(recovery.RecoveryError, "139001"):
            recovery.apply_manifest(
                manifest_path,
                target,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=recovery.sha256_file(target),
            )

    def test_scan_skips_evidence_without_a_real_event_time(self):
        with sqlite3.connect(self.database) as conn:
            conn.execute(
                "INSERT INTO custom_canvas_generation_receipts("
                "owner_id,receipt_id,content_hash,points,feature,expires_at,created_at,charged_at"
                ") VALUES('owner-1','bad-time','secret',5,'x',9,10,0)"
            )
        self._map_project("missing-time", "missing-time")
        self._write_project(
            "missing-time",
            createdAt="",
            updatedAt="",
            billingUsage={"imageCount": 2, "ttsChars": 100},
        )
        manifest = recovery.scan_usage(self.database, self.projects)
        self.assertEqual([], manifest["observations"])
        warning_codes = {item["code"] for item in manifest["warnings"]}
        self.assertIn("canvas_receipt_event_time_missing", warning_codes)
        self.assertIn("video_project_usage_event_time_missing", warning_codes)
        self.assertNotIn('"eventAt":0', json.dumps(manifest, separators=(",", ":")))

    def test_drifted_copy_cannot_receive_any_new_rows(self):
        self._seed_complete_scan_fixture()
        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)
        target = self.copies / "drifted.sqlite"
        shutil.copy2(self.database, target)
        with sqlite3.connect(target) as conn:
            conn.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                "VALUES('customProjects','unrelated-drift','owner-1',1,'{}')"
            )
        with self.assertRaisesRegex(recovery.RecoveryError, "drifted_new_inserts_forbidden"):
            recovery.apply_manifest(
                manifest_path,
                target,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=recovery.sha256_file(target),
            )
        with sqlite3.connect(target) as conn:
            self.assertEqual(0, conn.execute("SELECT COUNT(*) FROM model_usage_receipts").fetchone()[0])

    def test_append_only_apply_is_idempotent_and_preserves_existing_tables(self):
        self._seed_complete_scan_fixture()
        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)
        target = self.copies / "apply.sqlite"
        shutil.copy2(self.database, target)
        source_sha = recovery.sha256_file(self.database)
        with sqlite3.connect(target) as conn:
            before_docs = conn.execute("SELECT * FROM docs ORDER BY id").fetchall()
            before_members = conn.execute("SELECT * FROM members ORDER BY id").fetchall()
            before_canvas = conn.execute(
                "SELECT * FROM custom_canvas_generation_receipts ORDER BY owner_id,receipt_id"
            ).fetchall()

        first = recovery.apply_manifest(
            manifest_path,
            target,
            confirm_manifest_sha256=manifest["manifestSha256"],
            expected_db_sha256=source_sha,
        )
        self.assertEqual(5, first["counts"]["inserted"])
        self.assertEqual(0, first["counts"]["reused"])
        self.assertEqual(5, first["counts"]["pending"])
        self.assertEqual("append-only", first["mode"])

        reconcile = recovery.reconcile_copy(
            manifest_path,
            target,
            confirm_manifest_sha256=manifest["manifestSha256"],
            expected_db_sha256=recovery.sha256_file(target),
        )
        self.assertEqual(5, reconcile["counts"]["projected"])
        self.assertEqual(0, reconcile["counts"]["pending"])

        second_pre_hash = recovery.sha256_file(target)
        second = recovery.apply_manifest(
            manifest_path,
            target,
            confirm_manifest_sha256=manifest["manifestSha256"],
            expected_db_sha256=second_pre_hash,
        )
        self.assertEqual(0, second["counts"]["inserted"])
        self.assertEqual(5, second["counts"]["reused"])
        self.assertEqual(0, second["counts"]["pending"])
        self.assertEqual("reuse-only", second["mode"])
        self.assertFalse(second["committed"])
        self.assertEqual(second_pre_hash, recovery.sha256_file(target))

        reconcile_pre_hash = recovery.sha256_file(target)
        reconcile_again = recovery.reconcile_copy(
            manifest_path,
            target,
            confirm_manifest_sha256=manifest["manifestSha256"],
            expected_db_sha256=reconcile_pre_hash,
        )
        self.assertEqual(0, reconcile_again["counts"]["projected"])
        self.assertEqual(5, reconcile_again["counts"]["reused"])
        self.assertEqual(0, reconcile_again["counts"]["pending"])
        self.assertFalse(reconcile_again["committed"])
        self.assertEqual(reconcile_pre_hash, recovery.sha256_file(target))

        with sqlite3.connect(target) as conn:
            self.assertEqual(5, conn.execute("SELECT COUNT(*) FROM model_usage_receipts").fetchone()[0])
            self.assertEqual(
                [("projected", 5)],
                conn.execute(
                    "SELECT state,COUNT(*) FROM model_usage_outbox GROUP BY state"
                ).fetchall(),
            )
            self.assertEqual(5, conn.execute("SELECT COUNT(*) FROM api_usage_events").fetchone()[0])
            self.assertEqual(before_docs, conn.execute("SELECT * FROM docs ORDER BY id").fetchall())
            self.assertEqual(before_members, conn.execute("SELECT * FROM members ORDER BY id").fetchall())
            self.assertEqual(
                before_canvas,
                conn.execute(
                    "SELECT * FROM custom_canvas_generation_receipts ORDER BY owner_id,receipt_id"
                ).fetchall(),
            )

    def test_existing_conflict_rolls_back_entire_transaction(self):
        self._seed_complete_scan_fixture()
        first_manifest = recovery.scan_usage(self.database, self.projects)
        conflict_observation = first_manifest["observations"][0]
        values = list(recovery._receipt_values(conflict_observation, "Owner One", "team-1"))
        values[6] = "conflicting feature"
        with sqlite3.connect(self.database) as conn:
            placeholders = ",".join("?" for _ in recovery.RECEIPT_COLUMN_ORDER)
            conn.execute(
                "INSERT INTO model_usage_receipts("
                + ",".join(recovery.RECEIPT_COLUMN_ORDER)
                + f") VALUES({placeholders})",
                values,
            )
            conn.execute(
                "INSERT INTO model_usage_outbox(receipt_id,state,attempts,available_at,"
                "last_error,legacy_event_kind,legacy_event_id,created_at,updated_at,projected_at) "
                "VALUES(?,'pending',0,0,'','','',0,0,NULL)",
                (conflict_observation["receiptId"],),
            )

        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)
        target = self.copies / "conflict.sqlite"
        shutil.copy2(self.database, target)
        source_sha = recovery.sha256_file(self.database)
        with self.assertRaisesRegex(recovery.RecoveryConflict, "existing_model_usage_receipt_conflict"):
            recovery.apply_manifest(
                manifest_path,
                target,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=source_sha,
            )
        with sqlite3.connect(target) as conn:
            self.assertEqual(1, conn.execute("SELECT COUNT(*) FROM model_usage_receipts").fetchone()[0])
            self.assertEqual(1, conn.execute("SELECT COUNT(*) FROM model_usage_outbox").fetchone()[0])

    def test_closed_wal_mode_copy_is_checkpointed_after_append(self):
        self._seed_complete_scan_fixture()
        with sqlite3.connect(self.database) as conn:
            self.assertEqual("wal", conn.execute("PRAGMA journal_mode=WAL").fetchone()[0])
        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)
        target = self.copies / "wal-copy.sqlite"
        shutil.copy2(self.database, target)
        report = recovery.apply_manifest(
            manifest_path,
            target,
            confirm_manifest_sha256=manifest["manifestSha256"],
            expected_db_sha256=recovery.sha256_file(target),
        )
        self.assertEqual(5, report["counts"]["inserted"])
        wal = Path(str(target) + "-wal")
        self.assertFalse(wal.exists() and wal.stat().st_size > 0)
        with sqlite3.connect(f"file:{target}?mode=ro&immutable=1", uri=True) as conn:
            self.assertEqual(5, conn.execute("SELECT COUNT(*) FROM model_usage_receipts").fetchone()[0])

    def test_post_commit_checkpoint_error_is_explicit_and_replay_safe(self):
        self._seed_complete_scan_fixture()
        with sqlite3.connect(self.database) as conn:
            self.assertEqual("wal", conn.execute("PRAGMA journal_mode=WAL").fetchone()[0])
        manifest = recovery.scan_usage(self.database, self.projects)
        manifest_path = self._write_manifest(manifest)
        target = self.copies / "checkpoint-error-copy.sqlite"
        shutil.copy2(self.database, target)
        with patch.object(
            recovery,
            "_checkpoint_after_commit",
            side_effect=recovery.RecoveryError("simulated-checkpoint-error"),
        ):
            with self.assertRaises(recovery.RecoveryCommittedAfterError) as raised:
                recovery.apply_manifest(
                    manifest_path,
                    target,
                    confirm_manifest_sha256=manifest["manifestSha256"],
                    expected_db_sha256=recovery.sha256_file(target),
                )
        self.assertTrue(raised.exception.committed)
        self.assertTrue(raised.exception.replay_safe)
        self.assertIn("committed_after_error", str(raised.exception))
        with sqlite3.connect(target) as conn:
            self.assertEqual(5, conn.execute("SELECT COUNT(*) FROM model_usage_receipts").fetchone()[0])

        replay = recovery.apply_manifest(
            manifest_path,
            target,
            confirm_manifest_sha256=manifest["manifestSha256"],
            expected_db_sha256=recovery.sha256_file(target),
        )
        self.assertEqual("reuse-only", replay["mode"])
        self.assertEqual(0, replay["counts"]["inserted"])

    def test_ambiguous_team_without_explicit_team_fails_closed(self):
        with sqlite3.connect(self.database) as conn:
            conn.execute("INSERT INTO teams(id,name) VALUES('team-2','Team Two')")
            conn.execute(
                "INSERT INTO team_members(team_id,member_id,team_role,status,joined_at) "
                "VALUES('team-2','owner-1','editor','active',200)"
            )
            conn.execute(
                "INSERT INTO custom_canvas_generation_receipts("
                "owner_id,receipt_id,content_hash,points,feature,expires_at,created_at,charged_at"
                ") VALUES('owner-1','ambiguous-canvas','secret',5,'x',9,10,11)"
            )
        manifest = recovery.scan_usage(self.database, self.projects)
        self.assertTrue(
            any(item["code"] == "owner_team_ambiguous_apply_will_fail" for item in manifest["warnings"])
        )
        manifest_path = self._write_manifest(manifest)
        target = self.copies / "ambiguous.sqlite"
        shutil.copy2(self.database, target)
        with self.assertRaisesRegex(recovery.RecoveryConflict, "model_usage_team_ambiguous"):
            recovery.apply_manifest(
                manifest_path,
                target,
                confirm_manifest_sha256=manifest["manifestSha256"],
                expected_db_sha256=recovery.sha256_file(target),
            )

    def test_cli_help_documents_scan_and_copy_only_apply(self):
        parser = recovery.build_parser()
        help_text = parser.format_help()
        self.assertIn("scan", help_text)
        self.assertIn("apply", help_text)
        self.assertIn("reconcile-copy", help_text)
        self.assertIn("imports the application store", help_text)
        self.assertIn("database copy", recovery.__doc__)


if __name__ == "__main__":
    unittest.main()
