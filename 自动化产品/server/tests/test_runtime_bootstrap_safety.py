import asyncio
import importlib.util
import json
import os
import sqlite3
import sys
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch


SERVER_DIR = Path(__file__).resolve().parents[1]
APP_DIR = SERVER_DIR.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

import config as runtime_config


@contextmanager
def runtime_environment(**values):
    names = {
        "DATA_DB",
        "CUSTOM_CANVAS_BLOB_DIR",
        "UPLOAD_DIR",
        "COMPOSED_DIR",
        "VIDEO_WORKSHOP_OUTPUT_DIR",
        "VIDEO_WORKSHOP_UPLOAD_DIR",
        "ACG_RUNTIME_MODE",
        "ACG_DB_BOOTSTRAP_MODE",
        "ACG_READ_ONLY",
        "ACG_REQUIRE_INTERNAL_TEAM",
        "ACG_REQUIRE_RESOURCE_SCOPES",
        "ACG_RELEASE_ID",
        "ACG_ALLOW_SCHEMA_MIGRATION",
        "ACG_ALLOW_ACG_TEAM_MIGRATION",
        "ACG_ALLOW_RESOURCE_SCOPE_MIGRATION",
        "ACG_ALLOW_PRIVATE_MEDIA_MIGRATION",
        "ACG_ALLOW_PRIVATE_MEDIA_SETTLEMENT",
        "ACG_ALLOW_MODEL_USAGE_SETTLEMENT",
        "AUTH_SECRET",
    }
    previous = {name: os.environ.get(name) for name in names}
    try:
        for name in names:
            os.environ.pop(name, None)
        for name, value in values.items():
            if value is not None:
                os.environ[name] = str(value)
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def load_isolated_store():
    name = f"runtime_safety_store_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SERVER_DIR / "store.py")
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def seed_acg_legacy_fixture(store, database):
    """Create a small v120-like identity/resource set after the schema expand."""

    now = 1_700_000_000_000
    members = [
        ("owner", "Owner", store.DEFAULT_ADMIN_USERNAME, "", "pin-owner", "admin", None, now),
        ("admin-2", "Admin 2", "admin-two", "", "pin-admin-2", "admin", None, now + 1),
        ("editor", "Editor", "editor-one", "", "pin-editor", "editor", None, now + 2),
        ("supplier", "Supplier", "supplier-one", "", "pin-supplier", "supplier", None, now + 3),
        (
            "supplier-child", "Supplier Child", "supplier-child", "", "pin-child",
            "supplier_child", "supplier", now + 4,
        ),
        ("user", "User", "external-user", "", "pin-user", "user", None, now + 5),
    ]
    with sqlite3.connect(database) as conn:
        conn.executemany(
            "INSERT INTO members(id,name,username,username_key,pin_hash,role,parent_id,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            members,
        )
        conn.execute(
            "INSERT INTO member_requests("
            "id,name,username,username_key,pin_hash,role,status,message,created_at"
            ") VALUES(?,?,?,?,?,?,?,?,?)",
            (
                "request-1", "Pending", "pending-user", "", "pin-request", "user",
                "pending", "preserve request", now + 6,
            ),
        )
        conn.executemany(
            "INSERT INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
            [
                ("accounts", "account-1", "owner", now, '{"name":"account one"}'),
                ("accounts", "account-2", "admin-2", now + 1, '{"name":"account two"}'),
                ("assets", "asset-1", "editor", now + 2, '{"url":"/preserve.png"}'),
            ],
        )


def protected_fixture_rows(database):
    with sqlite3.connect(database) as conn:
        members = conn.execute(
            "SELECT id,name,username,pin_hash,parent_id,avatar_url,created_at "
            "FROM members ORDER BY id"
        ).fetchall()
        requests = conn.execute(
            "SELECT id,name,username,pin_hash,role,status,message,created_at,"
            "reviewed_at,reviewed_by FROM member_requests ORDER BY id"
        ).fetchall()
        docs = conn.execute(
            "SELECT collection,id,owner_id,updated_at,data FROM docs ORDER BY collection,id"
        ).fetchall()
    return members, requests, docs


def logical_database_dump(database):
    """Stable logical snapshot used to prove a rejected migration wrote nothing."""

    with sqlite3.connect(database) as conn:
        return "\n".join(conn.iterdump())


def current_backup_binding(store, database):
    """Represent a manifest already byte-verified by the migration CLI."""

    with sqlite3.connect(database) as conn:
        conn.execute("BEGIN")
        try:
            logical_sha256 = store._database_logical_digest_locked(conn)
            schema_version = int(conn.execute("PRAGMA schema_version").fetchone()[0])
            user_version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        finally:
            conn.rollback()
    return {
        "format": "acg-sqlite-backup-v2",
        "verified": True,
        "manifestSha256": "a" * 64,
        "sourceDatabase": Path(database).name,
        "sourceIdentity": store._database_identity(database),
        "sourcePathSha256": store._database_path_digest(database),
        "sourceLogicalSha256": logical_sha256,
        "sourceSchemaVersion": schema_version,
        "sourceUserVersion": user_version,
        "backupSha256": "b" * 64,
    }


def current_runtime_snapshot_binding(store):
    return {
        "format": "acg-runtime-snapshot-binding-v1",
        "verified": True,
        "profile": "acg-production-complete-v1",
        "manifestSha256": "c" * 64,
        "componentNames": sorted(
            store.PRIVATE_MEDIA_RUNTIME_SNAPSHOT_COMPLETE_COMPONENTS
        ),
        "mediaInventoryDigest": store._private_media_live_inventory_digest(),
    }


class RuntimeBootstrapSafetyTest(unittest.TestCase):
    def test_production_cannot_disable_internal_team_readiness(self):
        with runtime_environment(
            ACG_RUNTIME_MODE="production",
            ACG_REQUIRE_INTERNAL_TEAM="0",
        ):
            self.assertTrue(runtime_config.require_internal_team())
        with runtime_environment(
            ACG_RUNTIME_MODE="test",
            ACG_REQUIRE_INTERNAL_TEAM="0",
        ):
            self.assertFalse(runtime_config.require_internal_team())

    def test_video_sidecar_url_requires_literal_loopback_origin_and_matching_port(self):
        accepted = (
            "http://127.0.0.1:8765",
            "http://[::1]:8765/",
        )
        rejected = (
            "https://127.0.0.1:8765",
            "http://localhost:8765",
            "http://127.0.0.1:8766",
            "http://127.0.0.1:8765/api/health",
            "http://user:pass@127.0.0.1:8765",
            "http://203.0.113.10:8765",
            "http://127.0.0.1:8765?target=external",
        )
        for value in accepted:
            with self.subTest(value=value):
                self.assertTrue(runtime_config.loopback_http_url_status(
                    value,
                    expected_port=8765,
                )["ok"])
        for value in rejected:
            with self.subTest(value=value):
                self.assertFalse(runtime_config.loopback_http_url_status(
                    value,
                    expected_port=8765,
                )["ok"])

    def test_main_loads_environment_before_importing_store(self):
        source = (SERVER_DIR / "main.py").read_text("utf-8")
        environment_offset = source.index("runtime_config.load_environment()")
        store_offset = source.index("from . import store")
        self.assertLess(environment_offset, store_offset)

    def test_environment_parser_keeps_existing_process_values(self):
        name = "ACG_TEST_BOOTSTRAP_VALUE"
        previous = os.environ.get(name)
        try:
            with tempfile.TemporaryDirectory() as tmp:
                Path(tmp, ".env.local").write_text(f"{name}=from-file\n", "utf-8")
                os.environ[name] = "from-process"
                runtime_config.load_environment(Path(tmp))
                self.assertEqual(os.environ[name], "from-process")
        finally:
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous

    def test_production_validation_does_not_create_missing_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "missing.sqlite"
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_DB_BOOTSTRAP_MODE="auto",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                self.assertEqual(runtime_config.db_bootstrap_mode(), "validate")
                with self.assertRaises(store.StoreNotReadyError):
                    store._ensure_db()
                self.assertFalse(database.exists())

    def test_explicit_schema_migration_does_not_seed_or_rewrite_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
                conn.execute("INSERT INTO legacy_record(id) VALUES('preserve-me')")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                first = store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                second = store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                self.assertTrue(first["applied"])
                self.assertEqual(store.LATEST_SCHEMA_MIGRATION_VERSION, first["version"])
                self.assertEqual(
                    [
                        store.SCHEMA_MIGRATION_VERSION,
                        store.MODEL_USAGE_SCHEMA_MIGRATION_VERSION,
                        store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                        store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                        store.VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION,
                        store.MEMBER_CONTROL_SCHEMA_MIGRATION_VERSION,
                        store.MODEL_USAGE_SETTLEMENT_SCHEMA_MIGRATION_VERSION,
                        store.PRODUCTION_RECOVERY_SCHEMA_MIGRATION_VERSION,
                        store.MODEL_USAGE_SETTLEMENT_V2_SCHEMA_MIGRATION_VERSION,
                    ],
                    first["appliedVersions"],
                )
                self.assertFalse(second["applied"])
                with sqlite3.connect(database) as conn:
                    self.assertEqual(
                        conn.execute("SELECT COUNT(*) FROM members").fetchone()[0], 0
                    )
                    self.assertEqual(
                        conn.execute("SELECT id FROM legacy_record").fetchone()[0],
                        "preserve-me",
                    )
                    ledger = conn.execute(
                        "SELECT checksum,status FROM schema_migrations WHERE version=?",
                        (store.SCHEMA_MIGRATION_VERSION,),
                    ).fetchone()
                    usage_ledger = conn.execute(
                        "SELECT checksum,status FROM schema_migrations WHERE version=?",
                        (store.MODEL_USAGE_SCHEMA_MIGRATION_VERSION,),
                    ).fetchone()
                    usage_tables = conn.execute(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' "
                        "AND name IN ('model_usage_receipts','model_usage_outbox')"
                    ).fetchone()[0]
                self.assertEqual(ledger, (store.SCHEMA_MIGRATION_CHECKSUM, "success"))
                self.assertEqual(
                    usage_ledger,
                    (store.MODEL_USAGE_SCHEMA_MIGRATION_CHECKSUM, "success"),
                )
                self.assertEqual(2, usage_tables)

    def test_failed_schema_expand_rolls_back_every_new_business_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
                conn.execute("INSERT INTO legacy_record(id) VALUES('preserve-me')")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                with (
                    patch.object(
                        store,
                        "_record_schema_migration_locked",
                        side_effect=RuntimeError("forced-ledger-failure"),
                    ),
                    self.assertRaisesRegex(RuntimeError, "forced-ledger-failure"),
                ):
                    store.apply_schema_migrations(
                        expected_identity=identity,
                        backup_binding=current_backup_binding(store, database),
                    )

                with sqlite3.connect(database) as conn:
                    tables = {
                        row[0] for row in conn.execute(
                            "SELECT name FROM sqlite_master WHERE type='table'"
                        ).fetchall()
                    }
                    self.assertIn("legacy_record", tables)
                    self.assertIn("schema_migrations", tables)
                    self.assertNotIn("members", tables)
                    self.assertNotIn("docs", tables)
                    self.assertEqual(
                        conn.execute("SELECT id FROM legacy_record").fetchone()[0],
                        "preserve-me",
                    )
                    migration = conn.execute(
                        "SELECT status FROM schema_migrations WHERE version=?",
                        (store.SCHEMA_MIGRATION_VERSION,),
                    ).fetchone()
                self.assertEqual(migration, ("failed",))

    def test_explicit_migration_refuses_a_wrong_missing_database_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "wrong-target.sqlite"
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                with self.assertRaises(store.StoreNotReadyError):
                    store.apply_schema_migrations(expected_identity="wrong")
                self.assertFalse(database.exists())

    def test_explicit_schema_migration_requires_store_level_authorization(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "authorization",
                ):
                    store.apply_schema_migrations(expected_identity=identity)
                with sqlite3.connect(database) as conn:
                    self.assertIsNone(conn.execute(
                        "SELECT 1 FROM sqlite_master "
                        "WHERE type='table' AND name='schema_migrations'"
                    ).fetchone())

    def test_production_migration_requires_verified_backup_without_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
                conn.execute("INSERT INTO legacy_record(id) VALUES('preserve-me')")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                before = logical_database_dump(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "verified backup manifest binding",
                ):
                    store.apply_schema_migrations(expected_identity=identity)
                self.assertEqual(before, logical_database_dump(database))
                with sqlite3.connect(database) as conn:
                    self.assertIsNone(conn.execute(
                        "SELECT 1 FROM sqlite_master "
                        "WHERE type='table' AND name='schema_migrations'"
                    ).fetchone())

    def test_production_migration_rejects_changes_after_verified_backup(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
                conn.execute("INSERT INTO legacy_record(id) VALUES('before-backup')")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                binding = current_backup_binding(store, database)
                with sqlite3.connect(database) as conn:
                    conn.execute("INSERT INTO legacy_record(id) VALUES('after-backup')")
                before_rejected_apply = logical_database_dump(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "changed after verified backup",
                ):
                    store.apply_schema_migrations(
                        expected_identity=identity,
                        backup_binding=binding,
                    )
                self.assertEqual(before_rejected_apply, logical_database_dump(database))
                with sqlite3.connect(database) as conn:
                    self.assertIsNone(conn.execute(
                        "SELECT 1 FROM sqlite_master "
                        "WHERE type='table' AND name='schema_migrations'"
                    ).fetchone())

    def test_production_migration_rejects_backup_for_another_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                binding = current_backup_binding(store, database)
                binding["sourcePathSha256"] = "c" * 64
                with self.assertRaisesRegex(store.StoreNotReadyError, "path mismatch"):
                    store.apply_schema_migrations(
                        expected_identity=identity,
                        backup_binding=binding,
                    )
                with sqlite3.connect(database) as conn:
                    self.assertIsNone(conn.execute(
                        "SELECT 1 FROM sqlite_master "
                        "WHERE type='table' AND name='schema_migrations'"
                    ).fetchone())

    def test_private_media_apply_reuses_backup_gate_before_any_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            database = root / "data.sqlite"
            media_paths = {
                "CUSTOM_CANVAS_BLOB_DIR": root / "blobs",
                "UPLOAD_DIR": root / "uploads",
                "COMPOSED_DIR": root / "composed",
                "VIDEO_WORKSHOP_OUTPUT_DIR": root / "video-outputs",
                "VIDEO_WORKSHOP_UPLOAD_DIR": root / "video-uploads",
            }
            for path in media_paths.values():
                path.mkdir()
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
                conn.execute("INSERT INTO legacy_record(id) VALUES('before-backup')")
            with runtime_environment(
                DATA_DB=database,
                **media_paths,
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_PRIVATE_MEDIA_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                before = logical_database_dump(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "verified backup manifest binding",
                ):
                    store.apply_private_media_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                        ),
                        runtime_snapshot_binding=current_runtime_snapshot_binding(
                            store
                        ),
                    )
                self.assertEqual(before, logical_database_dump(database))

                binding = current_backup_binding(store, database)
                with sqlite3.connect(database) as conn:
                    conn.execute("INSERT INTO legacy_record(id) VALUES('after-backup')")
                changed = logical_database_dump(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "changed after verified backup",
                ):
                    store.apply_private_media_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                        ),
                        backup_binding=binding,
                        runtime_snapshot_binding=current_runtime_snapshot_binding(
                            store
                        ),
                    )
                self.assertEqual(changed, logical_database_dump(database))
                with sqlite3.connect(database) as conn:
                    self.assertIsNone(conn.execute(
                        "SELECT 1 FROM sqlite_master "
                        "WHERE type='table' AND name='schema_migrations'"
                    ).fetchone())

    def test_private_media_140004_apply_is_bound_and_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            database = root / "data.sqlite"
            paths = {
                "CUSTOM_CANVAS_BLOB_DIR": root / "canvas",
                "UPLOAD_DIR": root / "uploads",
                "COMPOSED_DIR": root / "composed",
                "VIDEO_WORKSHOP_OUTPUT_DIR": root / "video-outputs",
                "VIDEO_WORKSHOP_UPLOAD_DIR": root / "video-uploads",
            }
            for path in paths.values():
                path.mkdir()
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with runtime_environment(
                DATA_DB=database,
                **paths,
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_REQUIRE_INTERNAL_TEAM="1",
                ACG_REQUIRE_RESOURCE_SCOPES="1",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                ACG_ALLOW_ACG_TEAM_MIGRATION="1",
                ACG_ALLOW_RESOURCE_SCOPE_MIGRATION="1",
                ACG_ALLOW_PRIVATE_MEDIA_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                seed_acg_legacy_fixture(store, database)
                store.apply_acg_internal_team_migration(
                    expected_identity=identity,
                    owner_username=store.DEFAULT_ADMIN_USERNAME,
                    team_id=store.INTERNAL_TEAM_ID,
                    expected_schema_version=store.SCHEMA_MIGRATION_VERSION,
                    backup_binding=current_backup_binding(store, database),
                )
                store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=(
                        store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                    ),
                    backup_binding=current_backup_binding(store, database),
                )
                dry_run = store.private_media_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=(
                        store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                    ),
                )
                self.assertTrue(dry_run["readyForApply"])
                self.assertFalse(dry_run["dataMigration"])

                first = store.apply_private_media_migration(
                    expected_identity=identity,
                    expected_schema_version=(
                        store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                    ),
                    backup_binding=current_backup_binding(store, database),
                    runtime_snapshot_binding=current_runtime_snapshot_binding(
                        store
                    ),
                )
                self.assertTrue(first["applied"])
                self.assertTrue(first["ok"])
                self.assertEqual(
                    store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
                    first["dataMigrationVersion"],
                )
                second = store.apply_private_media_migration(
                    expected_identity=identity,
                    expected_schema_version=(
                        store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION
                    ),
                    backup_binding=current_backup_binding(store, database),
                    runtime_snapshot_binding=current_runtime_snapshot_binding(
                        store
                    ),
                )
                self.assertFalse(second["applied"])
                self.assertTrue(store.database_readiness()["ok"])

    def test_local_auto_mode_keeps_existing_bootstrap_compatibility(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="test",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                store._ensure_db()
                with sqlite3.connect(database) as conn:
                    self.assertGreaterEqual(
                        conn.execute("SELECT COUNT(*) FROM members").fetchone()[0], 2
                    )
                    self.assertEqual(
                        conn.execute(
                            "SELECT status FROM schema_migrations WHERE version=?",
                            (store.SCHEMA_MIGRATION_VERSION,),
                        ).fetchone()[0],
                        "success",
                    )

    def test_read_only_connection_rejects_sqlite_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="test",
                ACG_READ_ONLY="0",
                ACG_RELEASE_ID="test-release",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                store._ensure_db()
                before = database.read_bytes()
                os.environ["ACG_READ_ONLY"] = "1"
                conn = store._connect()
                try:
                    with self.assertRaises(sqlite3.OperationalError):
                        conn.execute("INSERT INTO meta(k,v) VALUES('forbidden','1')")
                finally:
                    conn.close()
                self.assertEqual(database.read_bytes(), before)

    def test_read_only_login_projection_and_state_heal_are_zero_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="test",
                ACG_READ_ONLY="0",
                ACG_REQUIRE_INTERNAL_TEAM="0",
                ACG_RELEASE_ID="test-release",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                user = store.add_member("Personal", "personal-safe", "123456", "user")
                store.upsert_docs("productions", [{
                    "id": "production-stale",
                    "ownerId": user[0],
                    "updatedAt": 1,
                    "artifacts": {"boards": {"infoFlow": {
                        "status": "storyboarding",
                        "updatedAt": 0,
                        "segments": [],
                    }}},
                }])
                with sqlite3.connect(database) as conn:
                    raw_before = conn.execute(
                        "SELECT data FROM docs WHERE collection='productions' AND id=?",
                        ("production-stale",),
                    ).fetchone()[0]
                os.environ["ACG_READ_ONLY"] = "1"
                store._initialized = False
                public = store.member_public(store.get_member(user[0]))
                state = store.state_for(user[0], "user")
                self.assertTrue(public["generationQuota"]["projected"])
                self.assertEqual(
                    state["productions"][0]["artifacts"]["boards"]["infoFlow"]["status"],
                    "failed",
                )
                with sqlite3.connect(database) as conn:
                    raw_after = conn.execute(
                        "SELECT data FROM docs WHERE collection='productions' AND id=?",
                        ("production-stale",),
                    ).fetchone()[0]
                    quota_rows = conn.execute(
                        "SELECT COUNT(*) FROM personal_daily_quotas WHERE member_id=?",
                        (user[0],),
                    ).fetchone()[0]
                self.assertEqual(json.loads(raw_after), json.loads(raw_before))
                self.assertEqual(quota_rows, 0)

    def test_acg_migration_is_idempotent_and_preserves_protected_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_REQUIRE_INTERNAL_TEAM="1",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                ACG_ALLOW_ACG_TEAM_MIGRATION="1",
                ACG_ALLOW_RESOURCE_SCOPE_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                seed_acg_legacy_fixture(store, database)
                protected_before = protected_fixture_rows(database)

                confirmation = {
                    "expected_identity": identity,
                    "owner_username": store.DEFAULT_ADMIN_USERNAME,
                    "team_id": store.INTERNAL_TEAM_ID,
                    "expected_schema_version": store.SCHEMA_MIGRATION_VERSION,
                }
                dry_run = store.acg_internal_team_migration_preflight(**confirmation)
                self.assertTrue(dry_run["ok"])
                self.assertTrue(dry_run["dryRun"])
                self.assertEqual(dry_run["counts"]["membersCaptured"], 3)
                self.assertEqual(dry_run["counts"]["suppliersCaptured"], 1)
                self.assertEqual(dry_run["counts"]["accountsCaptured"], 2)

                first = store.apply_acg_internal_team_migration(
                    **confirmation,
                    backup_binding=current_backup_binding(store, database),
                )
                self.assertTrue(first["applied"])
                self.assertTrue(first["ok"])
                self.assertEqual(protected_fixture_rows(database), protected_before)
                store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    backup_binding=current_backup_binding(store, database),
                )
                self.assertTrue(store.database_readiness()["ok"])

                with sqlite3.connect(database) as conn:
                    team = conn.execute(
                        "SELECT name,slug,kind,status,plan,quota_mode FROM teams WHERE id=?",
                        (store.INTERNAL_TEAM_ID,),
                    ).fetchone()
                    mapped_roles = dict(conn.execute(
                        "SELECT member_id,team_role FROM team_members WHERE team_id=?",
                        (store.INTERNAL_TEAM_ID,),
                    ).fetchall())
                    supplier_role = conn.execute(
                        "SELECT role FROM members WHERE id='supplier'"
                    ).fetchone()[0]
                    supplier_parent = conn.execute(
                        "SELECT parent_id FROM members WHERE id='supplier-child'"
                    ).fetchone()[0]
                    member_keys = conn.execute(
                        "SELECT username,username_key FROM members"
                    ).fetchall()
                    request_keys = conn.execute(
                        "SELECT username,username_key FROM member_requests"
                    ).fetchall()
                    counts_after_first = {
                        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                        for table in (
                            "members", "member_requests", "docs", "teams", "team_members",
                            "team_suppliers", "team_accounts", "acg_internal_migration_scope",
                        )
                    }
                self.assertEqual(
                    team,
                    ("ACG市场部", "acg-marketing", "internal", "active", "team-pro", "unlimited"),
                )
                self.assertEqual(
                    mapped_roles,
                    {"owner": "owner", "admin-2": "admin", "editor": "creator"},
                )
                self.assertNotIn("supplier-child", mapped_roles)
                self.assertNotIn("user", mapped_roles)
                self.assertEqual(supplier_role, "supplier_parent")
                self.assertEqual(supplier_parent, "supplier")
                self.assertTrue(all(
                    username_key == store.canonical_username(username)
                    for username, username_key in member_keys + request_keys
                ))

                second = store.apply_acg_internal_team_migration(
                    **confirmation,
                    backup_binding=current_backup_binding(store, database),
                )
                self.assertFalse(second["applied"])
                with sqlite3.connect(database) as conn:
                    counts_after_second = {
                        table: conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                        for table in counts_after_first
                    }
                    conn.execute(
                        "INSERT INTO members("
                        "id,name,username,username_key,pin_hash,role,parent_id,created_at"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            "future-editor", "Future", "future-editor", "future-editor",
                            "pin-future", "editor", None, 1_800_000_000_000,
                        ),
                    )
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('accounts','future-account','future-editor',?,?)",
                        (1_800_000_000_000, '{"name":"future"}'),
                    )
                self.assertEqual(counts_after_second, counts_after_first)

                third = store.apply_acg_internal_team_migration(
                    **confirmation,
                    backup_binding=current_backup_binding(store, database),
                )
                self.assertFalse(third["applied"])
                with sqlite3.connect(database) as conn:
                    future_scoped = conn.execute(
                        "SELECT COUNT(*) FROM acg_internal_migration_scope "
                        "WHERE resource_id IN ('future-editor','future-account')"
                    ).fetchone()[0]
                    future_mapped = conn.execute(
                        "SELECT COUNT(*) FROM team_members WHERE member_id='future-editor'"
                    ).fetchone()[0] + conn.execute(
                        "SELECT COUNT(*) FROM team_accounts WHERE account_id='future-account'"
                    ).fetchone()[0]
                self.assertEqual(future_scoped, 0)
                self.assertEqual(future_mapped, 0)

    def test_acg_migration_rejects_wrong_confirmations_and_external_bindings(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_REQUIRE_INTERNAL_TEAM="1",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                ACG_ALLOW_ACG_TEAM_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                seed_acg_legacy_fixture(store, database)
                confirmation = {
                    "expected_identity": identity,
                    "owner_username": store.DEFAULT_ADMIN_USERNAME,
                    "team_id": store.INTERNAL_TEAM_ID,
                    "expected_schema_version": store.SCHEMA_MIGRATION_VERSION,
                }
                with self.assertRaisesRegex(store.StoreNotReadyError, "identity"):
                    store.acg_internal_team_migration_preflight(
                        **{**confirmation, "expected_identity": "wrong"}
                    )
                wrong_owner = store.acg_internal_team_migration_preflight(
                    **{**confirmation, "owner_username": "admin-two"}
                )
                self.assertFalse(wrong_owner["ok"])
                self.assertIn("owner_confirmation_mismatch", wrong_owner["issues"])

                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "INSERT INTO teams("
                        "id,name,slug,kind,status,plan,quota_mode,created_at,created_by"
                        ") VALUES('external-team','External','external','customer','active',"
                        "'team','metered',1,'owner')"
                    )
                    conn.execute(
                        "INSERT INTO team_members("
                        "team_id,member_id,team_role,status,joined_at,added_by"
                        ") VALUES('external-team','editor','creator','active',1,'owner')"
                    )
                conflict = store.acg_internal_team_migration_preflight(**confirmation)
                self.assertFalse(conflict["ok"])
                self.assertIn("external_team_binding_conflict", conflict["issues"])
                with self.assertRaisesRegex(store.StoreNotReadyError, "preflight failed"):
                    store.apply_acg_internal_team_migration(
                        **confirmation,
                        backup_binding=current_backup_binding(store, database),
                    )
                with sqlite3.connect(database) as conn:
                    target_team = conn.execute(
                        "SELECT 1 FROM teams WHERE id=?", (store.INTERNAL_TEAM_ID,)
                    ).fetchone()
                    data_ledger = conn.execute(
                        "SELECT 1 FROM schema_migrations WHERE version=?",
                        (store.ACG_DATA_MIGRATION_VERSION,),
                    ).fetchone()
                self.assertIsNone(target_team)
                self.assertIsNone(data_ledger)

    def test_acg_migration_blocks_canonical_identity_conflicts_without_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_REQUIRE_INTERNAL_TEAM="1",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                ACG_ALLOW_ACG_TEAM_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                seed_acg_legacy_fixture(store, database)
                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "INSERT INTO members("
                        "id,name,username,username_key,pin_hash,role,parent_id,created_at"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            "member-case-conflict", "Case conflict", "ADMIN-TWO", "",
                            "pin-case", "user", None, 1_700_000_000_100,
                        ),
                    )
                    conn.executemany(
                        "INSERT INTO member_requests("
                        "id,name,username,username_key,pin_hash,role,status,message,created_at"
                        ") VALUES(?,?,?,?,?,?,?,?,?)",
                        [
                            (
                                "request-case-a", "Request A", "RequestDup", "",
                                "pin-a", "user", "pending", "", 1_700_000_000_101,
                            ),
                            (
                                "request-case-b", "Request B", "requestdup", "",
                                "pin-b", "user", "pending", "", 1_700_000_000_102,
                            ),
                            (
                                "request-cross", "Request Cross", "EDITOR-ONE", "",
                                "pin-cross", "user", "pending", "", 1_700_000_000_103,
                            ),
                        ],
                    )

                confirmation = {
                    "expected_identity": identity,
                    "owner_username": store.DEFAULT_ADMIN_USERNAME,
                    "team_id": store.INTERNAL_TEAM_ID,
                    "expected_schema_version": store.SCHEMA_MIGRATION_VERSION,
                }
                before = logical_database_dump(database)
                dry_run = store.acg_internal_team_migration_preflight(**confirmation)
                self.assertFalse(dry_run["ok"])
                self.assertIn(
                    "member_canonical_username_conflict", dry_run["issues"]
                )
                self.assertIn(
                    "request_canonical_username_conflict", dry_run["issues"]
                )
                self.assertIn(
                    "cross_identity_canonical_username_conflict", dry_run["issues"]
                )
                self.assertEqual(dry_run["counts"]["memberCanonicalCollisionKeys"], 1)
                self.assertEqual(dry_run["counts"]["memberCanonicalCollisionRows"], 2)
                self.assertEqual(dry_run["counts"]["requestCanonicalCollisionKeys"], 1)
                self.assertEqual(dry_run["counts"]["requestCanonicalCollisionRows"], 2)
                self.assertEqual(
                    dry_run["counts"]["crossIdentityCanonicalCollisionKeys"], 1
                )

                with self.assertRaisesRegex(store.StoreNotReadyError, "preflight failed"):
                    store.apply_acg_internal_team_migration(
                        **confirmation,
                        backup_binding=current_backup_binding(store, database),
                    )
                self.assertEqual(before, logical_database_dump(database))
                with sqlite3.connect(database) as conn:
                    data_ledger = conn.execute(
                        "SELECT 1 FROM schema_migrations WHERE version=?",
                        (store.ACG_DATA_MIGRATION_VERSION,),
                    ).fetchone()
                    scope_table = conn.execute(
                        "SELECT 1 FROM sqlite_master WHERE type='table' "
                        "AND name='acg_internal_migration_scope'"
                    ).fetchone()
                self.assertIsNone(data_ledger)
                self.assertIsNone(scope_table)

    def test_acg_migration_blocks_supplier_orphans_without_writes(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_REQUIRE_INTERNAL_TEAM="1",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                ACG_ALLOW_ACG_TEAM_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                seed_acg_legacy_fixture(store, database)
                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "INSERT INTO members("
                        "id,name,username,username_key,pin_hash,role,parent_id,created_at"
                        ") VALUES(?,?,?,?,?,?,?,?)",
                        (
                            "orphan-child", "Orphan child", "orphan-child", "",
                            "pin-orphan", "supplier_child", "missing-parent",
                            1_700_000_000_100,
                        ),
                    )
                    conn.executemany(
                        "INSERT INTO supplier_account_bindings("
                        "parent_id,child_id,account_id,created_at,created_by"
                        ") VALUES(?,?,?,?,?)",
                        [
                            (
                                "supplier", "supplier-child", "missing-account",
                                1_700_000_000_101, "owner",
                            ),
                            (
                                "supplier", "user", "account-1",
                                1_700_000_000_102, "owner",
                            ),
                        ],
                    )

                confirmation = {
                    "expected_identity": identity,
                    "owner_username": store.DEFAULT_ADMIN_USERNAME,
                    "team_id": store.INTERNAL_TEAM_ID,
                    "expected_schema_version": store.SCHEMA_MIGRATION_VERSION,
                }
                before = logical_database_dump(database)
                dry_run = store.acg_internal_team_migration_preflight(**confirmation)
                self.assertFalse(dry_run["ok"])
                self.assertIn("supplier_child_parent_orphan", dry_run["issues"])
                self.assertIn("supplier_account_binding_orphan", dry_run["issues"])
                self.assertEqual(dry_run["counts"]["supplierChildParentOrphans"], 1)
                self.assertEqual(
                    dry_run["counts"]["supplierAccountBindingOrphans"], 2
                )

                with self.assertRaisesRegex(store.StoreNotReadyError, "preflight failed"):
                    store.apply_acg_internal_team_migration(
                        **confirmation,
                        backup_binding=current_backup_binding(store, database),
                    )
                self.assertEqual(before, logical_database_dump(database))
                with sqlite3.connect(database) as conn:
                    data_ledger = conn.execute(
                        "SELECT 1 FROM schema_migrations WHERE version=?",
                        (store.ACG_DATA_MIGRATION_VERSION,),
                    ).fetchone()
                    scope_table = conn.execute(
                        "SELECT 1 FROM sqlite_master WHERE type='table' "
                        "AND name='acg_internal_migration_scope'"
                    ).fetchone()
                self.assertIsNone(data_ledger)
                self.assertIsNone(scope_table)

    def test_acg_readiness_guards_all_captured_members_and_resources(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with runtime_environment(
                DATA_DB=database,
                CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
                ACG_RUNTIME_MODE="production",
                ACG_READ_ONLY="0",
                ACG_REQUIRE_INTERNAL_TEAM="1",
                ACG_RELEASE_ID="test-release",
                ACG_ALLOW_SCHEMA_MIGRATION="1",
                ACG_ALLOW_ACG_TEAM_MIGRATION="1",
                ACG_ALLOW_RESOURCE_SCOPE_MIGRATION="1",
                AUTH_SECRET="test-secret",
            ):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                seed_acg_legacy_fixture(store, database)
                confirmation = {
                    "expected_identity": identity,
                    "owner_username": store.DEFAULT_ADMIN_USERNAME,
                    "team_id": store.INTERNAL_TEAM_ID,
                    "expected_schema_version": store.SCHEMA_MIGRATION_VERSION,
                }
                store.apply_acg_internal_team_migration(
                    **confirmation,
                    backup_binding=current_backup_binding(store, database),
                )
                store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    backup_binding=current_backup_binding(store, database),
                )
                self.assertTrue(store.database_readiness()["ok"])

                with sqlite3.connect(database) as conn:
                    conn.execute("DELETE FROM team_members WHERE member_id='admin-2'")
                    conn.execute(
                        "UPDATE team_members SET team_role='viewer',status='inactive' "
                        "WHERE member_id='editor'"
                    )
                member_drift = store.database_readiness()
                self.assertFalse(member_drift["ok"])
                self.assertFalse(member_drift["acgMigration"])

                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "INSERT INTO team_members("
                        "team_id,member_id,team_role,status,joined_at,added_by"
                        ") VALUES(?,?,?,?,?,?)",
                        (store.INTERNAL_TEAM_ID, "admin-2", "admin", "active", 1, "owner"),
                    )
                    conn.execute(
                        "UPDATE team_members SET team_role='creator',status='active' "
                        "WHERE member_id='editor'"
                    )

                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "UPDATE team_members SET team_role='admin' WHERE member_id='owner'"
                    )
                owner_drift = store.database_readiness()
                self.assertFalse(owner_drift["ok"])
                self.assertFalse(owner_drift["acgMigration"])
                self.assertGreater(owner_drift["acgMigrationDrift"], 0)

                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "UPDATE team_members SET team_role='owner',status='active' "
                        "WHERE member_id='owner'"
                    )
                    conn.execute("DELETE FROM team_accounts WHERE account_id='account-1'")
                resource_drift = store.database_readiness()
                self.assertFalse(resource_drift["ok"])
                self.assertFalse(resource_drift["acgMigration"])

    def test_incomplete_video_sidecar_keeps_readiness_at_503(self):
        if str(APP_DIR) not in sys.path:
            sys.path.insert(0, str(APP_DIR))
        from server import main as server_main

        incomplete = server_main._video_sidecar_health_summary(200, {
            "ok": True,
            "ready": False,
            "status": "degraded",
            "missingRequired": ["provider token", "../../secret"],
        })
        self.assertFalse(incomplete["ok"])
        self.assertFalse(incomplete["ready"])
        self.assertEqual(incomplete["missingRequiredCount"], 2)
        self.assertNotIn("/", "".join(incomplete["missingRequired"]))

        complete_payload = {
            "ok": True,
            "ready": True,
            "status": "ready",
            "missingRequired": [],
            "contractVersion": "video-workshop-v137-read-only-1",
            "buildId": server_main.runtime_config.release_id(),
            "readOnly": False,
            "writePolicy": "normal",
        }
        with patch.object(server_main.runtime_config, "is_read_only", return_value=False):
            self.assertTrue(
                server_main._video_sidecar_health_summary(200, complete_payload)["ok"]
            )
        with patch.object(server_main.runtime_config, "is_read_only", return_value=True):
            self.assertFalse(
                server_main._video_sidecar_health_summary(200, complete_payload)["ok"]
            )
            protected = server_main._video_sidecar_health_summary(200, {
                **complete_payload,
                "readOnly": True,
                "writePolicy": "deny-mutations",
            })
        self.assertTrue(protected["ok"])
        self.assertTrue(protected["readOnly"])
        self.assertEqual(protected["writePolicy"], "deny-mutations")

        wrong_contract = server_main._video_sidecar_health_summary(200, {
            **complete_payload,
            "contractVersion": "video-workshop-old-but-nonempty",
        })
        self.assertFalse(wrong_contract["ok"])
        wrong_build = server_main._video_sidecar_health_summary(200, {
            **complete_payload,
            "buildId": "another-release",
        })
        self.assertFalse(wrong_build["ok"])

        healthy = {"ok": True}
        with (
            patch.object(server_main.runtime_config, "readiness_token", return_value=""),
            patch.object(server_main.runtime_config, "is_production", return_value=False),
            patch.object(server_main.runtime_config, "release_id", return_value="test-release"),
            patch.object(server_main.runtime_config, "runtime_mode", return_value="test"),
            patch.object(server_main.runtime_config, "is_read_only", return_value=False),
            patch.object(server_main.runtime_config, "db_bootstrap_mode", return_value="validate"),
            patch.object(server_main.store, "database_readiness", return_value=healthy),
            patch.object(server_main, "_runtime_path_readiness", return_value=healthy),
            patch.object(
                server_main, "_private_media_registry_readiness", return_value=healthy,
            ),
            patch.object(server_main, "_canvas_manifest_readiness", return_value=healthy),
            patch.object(
                server_main, "_video_sidecar_readiness",
                new=AsyncMock(return_value=incomplete),
            ),
        ):
            response = asyncio.run(server_main.readiness("", ""))
        self.assertEqual(response.status_code, 503)
        payload = json.loads(response.body)
        self.assertFalse(payload["ok"])
        self.assertFalse(payload["checks"]["sidecar"]["ok"])

    def test_video_sidecar_proxy_rechecks_loopback_before_forwarding(self):
        if str(APP_DIR) not in sys.path:
            sys.path.insert(0, str(APP_DIR))
        from server import main as server_main

        with (
            patch.object(server_main, "VIDEO_WORKSHOP_URL", "http://192.0.2.8:8765"),
            patch.object(server_main, "VIDEO_WORKSHOP_PORT", 8765),
            patch.object(server_main.httpx, "AsyncClient") as client,
        ):
            sidecar = asyncio.run(server_main._video_sidecar_readiness())
            self.assertFalse(sidecar["ok"])
            self.assertEqual(sidecar["configuration"], "loopback-required")
            client.assert_not_called()

            with self.assertRaises(server_main.HTTPException) as raised:
                asyncio.run(server_main._video_workshop_request(
                    object(),
                    "projects",
                ))
            self.assertEqual(getattr(raised.exception, "status_code", None), 503)
            client.assert_not_called()

    def test_v140_production_write_contract_requires_verified_startup(self):
        if str(APP_DIR) not in sys.path:
            sys.path.insert(0, str(APP_DIR))
        from server import main as server_main

        with (
            patch.object(server_main.runtime_config, "runtime_mode", return_value="production"),
            patch.object(server_main.runtime_config, "is_production", return_value=True),
            patch.object(server_main.runtime_config, "is_read_only", return_value=False),
            patch.object(
                server_main.runtime_config,
                "read_only_mode_status",
                return_value={"ok": True, "readOnly": False},
            ),
        ):
            read_write = server_main._production_write_contract_readiness()
        self.assertFalse(read_write["ok"])
        self.assertEqual(read_write["mode"], "read-write")
        self.assertEqual(
            ["startup-contract-unverified"],
            read_write["writeEnableBlockers"],
        )

        with (
            patch.object(server_main.runtime_config, "runtime_mode", return_value="production"),
            patch.object(server_main.runtime_config, "is_production", return_value=True),
            patch.object(server_main.runtime_config, "is_read_only", return_value=True),
            patch.object(
                server_main.runtime_config,
                "read_only_mode_status",
                return_value={"ok": True, "readOnly": True},
            ),
        ):
            protected = server_main._production_write_contract_readiness()
        self.assertTrue(protected["ok"])
        self.assertFalse(protected["writeReady"])
        self.assertEqual(protected["mode"], "read-only")

    def test_deploy_launcher_uses_validation_and_readiness_gate(self):
        source = (APP_DIR / "deploy" / "start_server.sh").read_text("utf-8")
        self.assertIn('ACG_RUNTIME_MODE="${ACG_RUNTIME_MODE:-production}"', source)
        self.assertIn('if [ "$ACG_RUNTIME_MODE" != "production" ]; then', source)
        self.assertNotIn("local|test)", source)
        self.assertIn('ACG_DB_BOOTSTRAP_MODE="${ACG_DB_BOOTSTRAP_MODE:-validate}"', source)
        self.assertIn("must be enabled in production", source)
        self.assertIn("verify_production_write_gate", source)
        self.assertIn('validate_sidecar_url("VIDEO_WORKSHOP_URL"', source)
        self.assertIn('validate_sidecar_url("VIDEO_WORKSHOP_HEALTH_URL"', source)
        self.assertIn('"http://127.0.0.1:${PORT}/api/ready"', source)
        self.assertIn('request.add_header("X-Readiness-Token", ready_token)', source)
        self.assertIn('release.get("id") == release_id', source)
        self.assertIn(
            'data.get("contractVersion") == "video-workshop-v137-read-only-1"',
            source,
        )


if __name__ == "__main__":
    unittest.main()
