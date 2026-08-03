import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from server.tests.test_runtime_bootstrap_safety import (
    current_backup_binding,
    load_isolated_store,
    logical_database_dump,
    protected_fixture_rows,
    runtime_environment,
    seed_acg_legacy_fixture,
)


class ResourceScopeMigrationTest(unittest.TestCase):
    def _environment(self, database, tmp, *, mode="test"):
        return runtime_environment(
            DATA_DB=database,
            CUSTOM_CANVAS_BLOB_DIR=Path(tmp) / "blobs",
            ACG_RUNTIME_MODE=mode,
            ACG_READ_ONLY="0",
            ACG_REQUIRE_INTERNAL_TEAM="1",
            ACG_REQUIRE_RESOURCE_SCOPES="1",
            ACG_RELEASE_ID="test-release",
            ACG_ALLOW_SCHEMA_MIGRATION="1",
            ACG_ALLOW_ACG_TEAM_MIGRATION="1",
            ACG_ALLOW_RESOURCE_SCOPE_MIGRATION="1",
            AUTH_SECRET="test-secret",
        )

    @staticmethod
    def _seed_external_and_reference_docs(store, database):
        now = 1_800_000_000_000
        with sqlite3.connect(database) as conn:
            conn.execute(
                "INSERT INTO members("
                "id,name,username,username_key,pin_hash,role,parent_id,created_at"
                ") VALUES(?,?,?,?,?,?,?,?)",
                (
                    "external-member", "External", "external-member",
                    "external-member", "pin-external", "user", None, now,
                ),
            )
            conn.execute(
                "INSERT INTO teams("
                "id,name,slug,kind,status,plan,quota_mode,created_at,created_by"
                ") VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    "external-team", "External team", "external-team", "customer",
                    "active", "team", "metered", now, "external-member",
                ),
            )
            conn.execute(
                "INSERT INTO team_members("
                "team_id,member_id,team_role,status,joined_at,added_by"
                ") VALUES(?,?,?,?,?,?)",
                (
                    "external-team", "external-member", "owner", "active", now,
                    "external-member",
                ),
            )
            conn.execute(
                "INSERT INTO team_accounts(team_id,account_id,created_at,added_by) "
                "VALUES(?,?,?,?)",
                ("external-team", "external-account", now, "external-member"),
            )
            rows = [
                (
                    "productions", "production-acg", "editor", now,
                    {"id": "production-acg", "ownerId": "editor"},
                ),
                (
                    "jobs", "job-acg", None, now + 1,
                    {"id": "job-acg", "productionId": "production-acg"},
                ),
                (
                    "assets", "asset-acg", "editor", now + 2,
                    {
                        "id": "asset-acg",
                        "ownerId": "editor",
                        "productionId": "production-acg",
                    },
                ),
                (
                    "products", "product-global", None, now + 3,
                    {"id": "product-global", "name": "legacy global"},
                ),
                (
                    "accounts", "external-account", "external-member", now + 4,
                    {
                        "id": "external-account",
                        "ownerId": "external-member",
                    },
                ),
                (
                    "productions", "production-external", "external-member", now + 5,
                    {
                        "id": "production-external",
                        "ownerId": "external-member",
                        "accountId": "external-account",
                    },
                ),
                (
                    "assets", "asset-external", "external-member", now + 6,
                    {
                        "id": "asset-external",
                        "ownerId": "external-member",
                        "accountId": "external-account",
                    },
                ),
                (
                    "assets", "asset-personal", "user", now + 7,
                    {"id": "asset-personal", "ownerId": "user"},
                ),
            ]
            conn.executemany(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                "VALUES(?,?,?,?,?)",
                [
                    (collection, item_id, owner_id, updated_at, json.dumps(payload))
                    for collection, item_id, owner_id, updated_at, payload in rows
                ],
            )

    @staticmethod
    def _apply_acg(store, database, identity):
        confirmation = {
            "expected_identity": identity,
            "owner_username": store.DEFAULT_ADMIN_USERNAME,
            "team_id": store.INTERNAL_TEAM_ID,
            "expected_schema_version": store.SCHEMA_MIGRATION_VERSION,
        }
        return store.apply_acg_internal_team_migration(
            **confirmation,
            backup_binding=current_backup_binding(store, database),
        )

    @staticmethod
    def _write_override_manifest(
        store,
        path,
        identity,
        resources,
        *,
        backup_binding=None,
        manifest_overrides=None,
        **entry_overrides,
    ):
        backup_binding = backup_binding or current_backup_binding(
            store, store.DB_PATH,
        )
        entries = []
        for resource in resources:
            entry = {
                "resourceKind": resource["resourceKind"],
                "resourceId": resource["resourceId"],
                "scopeType": "team",
                "scopeId": store.INTERNAL_TEAM_ID,
                "reason": "orphaned legacy document retained without rewriting business JSON",
                "evidence": (
                    "reviewed frozen v120 copy; no trustworthy live owner or extant "
                    "reference remains"
                ),
            }
            entry.update(entry_overrides)
            entries.append(entry)
        payload = {
            "format": store.RESOURCE_SCOPE_OVERRIDE_MANIFEST_FORMAT,
            "databaseIdentity": identity,
            "databasePathSha256": backup_binding["sourcePathSha256"],
            "databaseLogicalSha256": backup_binding["sourceLogicalSha256"],
            "schemaVersion": backup_binding["sourceSchemaVersion"],
            "userVersion": backup_binding["sourceUserVersion"],
            "backupManifestSha256": backup_binding["manifestSha256"],
            "resourceScopeSchemaVersion": store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
            "resourceScopeDataVersion": store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
            "entries": entries,
        }
        payload.update(manifest_overrides or {})
        encoded = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        path.write_bytes(encoded)
        return hashlib.sha256(encoded).hexdigest(), backup_binding

    def test_explicit_order_double_run_and_cross_tenant_runtime_guards(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
                conn.execute("INSERT INTO legacy_record(id) VALUES('preserve-me')")
            with self._environment(database, tmp):
                store = load_isolated_store()
                identity = store._database_identity(database)

                first_schema = store.apply_schema_migrations(
                    expected_identity=identity,
                    migration_version=store.SCHEMA_MIGRATION_VERSION,
                )
                self.assertEqual(
                    first_schema["appliedVersions"], [store.SCHEMA_MIGRATION_VERSION]
                )
                seed_acg_legacy_fixture(store, database)
                self._apply_acg(store, database, identity)
                usage_schema = store.apply_schema_migrations(
                    expected_identity=identity,
                    migration_version=store.MODEL_USAGE_SCHEMA_MIGRATION_VERSION,
                )
                scope_schema = store.apply_schema_migrations(
                    expected_identity=identity,
                    migration_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                self.assertEqual(
                    usage_schema["appliedVersions"],
                    [store.MODEL_USAGE_SCHEMA_MIGRATION_VERSION],
                )
                self.assertEqual(
                    scope_schema["appliedVersions"],
                    [store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION],
                )

                self._seed_external_and_reference_docs(store, database)
                protected_identities = protected_fixture_rows(database)[:2]
                docs_before = protected_fixture_rows(database)[2]
                preflight = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                self.assertTrue(preflight["ok"])
                self.assertEqual(
                    preflight["counts"]["documents"],
                    preflight["counts"]["scoped"],
                )
                first = store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                second = store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                self.assertTrue(first["applied"])
                self.assertFalse(second["applied"])
                self.assertEqual(protected_fixture_rows(database)[:2], protected_identities)
                self.assertEqual(protected_fixture_rows(database)[2], docs_before)

                with sqlite3.connect(database) as conn:
                    scopes = {
                        (kind, resource_id): (scope_type, scope_id)
                        for kind, resource_id, scope_type, scope_id in conn.execute(
                            "SELECT resource_kind,resource_id,scope_type,scope_id "
                            "FROM resource_scopes"
                        )
                    }
                    self.assertEqual(
                        conn.execute("SELECT id FROM legacy_record").fetchone()[0],
                        "preserve-me",
                    )
                self.assertEqual(
                    scopes[("doc:jobs", "job-acg")],
                    ("team", store.INTERNAL_TEAM_ID),
                )
                self.assertEqual(
                    scopes[("doc:assets", "asset-external")],
                    ("team", "external-team"),
                )
                self.assertEqual(
                    scopes[("doc:assets", "asset-personal")],
                    ("member", "user"),
                )

                store.apply_schema_migrations(
                    expected_identity=identity,
                    migration_version=store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                )
                acg_assets = {
                    item.get("id")
                    for item in store.state_for("owner", "admin", collections={"assets"})[
                        "assets"
                    ]
                }
                external_assets = {
                    item["id"]
                    for item in store.state_for(
                        "external-member", "user", collections={"assets"}
                    )["assets"]
                }
                personal_assets = {
                    item["id"]
                    for item in store.state_for("user", "user", collections={"assets"})[
                        "assets"
                    ]
                }
                self.assertIn("asset-acg", acg_assets)
                self.assertNotIn("asset-external", acg_assets)
                self.assertNotIn("asset-personal", acg_assets)
                self.assertEqual(external_assets, {"asset-external"})
                self.assertEqual(personal_assets, {"asset-personal"})

                with self.assertRaisesRegex(PermissionError, "resource_scope_conflict"):
                    store.upsert_member_collection(
                        "owner",
                        "admin",
                        "productions",
                        [{
                            "id": "production-external",
                            "ownerId": "external-member",
                            "accountId": "external-account",
                            "name": "cross-tenant mutation",
                            "updatedAt": 2_000_000_000_000,
                        }],
                    )
                with self.assertRaisesRegex(PermissionError, "forbidden"):
                    store.delete_member_doc(
                        "productions", "production-external", "owner", "admin"
                    )
                for field, value, error in (
                    ("ownerId", "external-member", "resource_scope_conflict"),
                    ("byMemberId", "external-member", "resource_scope_conflict"),
                    ("createdBy", "missing-member", "resource_member_scope_missing"),
                ):
                    with self.subTest(member_field=field), self.assertRaisesRegex(
                        PermissionError, error
                    ):
                        store.upsert_member_collection(
                            "owner",
                            "admin",
                            "productions",
                            [{
                                "id": f"forged-{field}",
                                field: value,
                                "updatedAt": 2_000_000_000_001,
                            }],
                        )
                # Existing same-tenant scope rows must not bypass the member
                # fields on an update either.
                with self.assertRaisesRegex(
                    PermissionError, "resource_scope_conflict"
                ):
                    store.upsert_member_collection(
                        "owner",
                        "admin",
                        "productions",
                        [{
                            "id": "production-acg",
                            "ownerId": "external-member",
                            "updatedAt": 2_000_000_000_002,
                        }],
                    )
                same_team = store.upsert_member_collection(
                    "owner",
                    "admin",
                    "productions",
                    [{
                        "id": "same-team-provenance",
                        "ownerId": "owner",
                        "byMemberId": "editor",
                        "updatedAt": 2_000_000_000_003,
                    }],
                )
                self.assertEqual(same_team["written"], 1)
                store.upsert_voice_presets("owner", "admin", [{
                    "id": "voice-acg", "voiceId": "voice-acg",
                    "name": "ACG voice", "updatedAt": 2_000_000_000_004,
                }])
                store.upsert_voice_presets("external-member", "user", [{
                    "id": "voice-external", "voiceId": "voice-external",
                    "name": "External voice", "updatedAt": 2_000_000_000_005,
                }])
                self.assertEqual(
                    {item["id"] for item in store.list_voice_presets("owner")},
                    {"voice-acg"},
                )
                self.assertEqual(
                    {
                        item["id"]
                        for item in store.list_voice_presets("external-member")
                    },
                    {"voice-external"},
                )
                tag_acg = store.create_publish_tag("租户内标签", "owner")
                tag_external = store.create_publish_tag(
                    "租户内标签", "external-member"
                )
                self.assertNotEqual(tag_acg["id"], tag_external["id"])
                self.assertEqual(
                    {item["id"] for item in store.list_publish_tags("editor")},
                    {tag_acg["id"]},
                )
                self.assertEqual(
                    {
                        item["id"]
                        for item in store.list_publish_tags("external-member")
                    },
                    {tag_external["id"]},
                )

                # Scope authorization and deletion are one write transaction.
                # Even an out-of-band scope drift on a cascading child must
                # abort without deleting the already-authorized parent.
                store.upsert_member_collection(
                    "editor", "editor", "productions", [{
                        "id": "production-delete-atomic",
                        "ownerId": "editor",
                        "updatedAt": 2_000_000_000_006,
                    }],
                )
                store.upsert_member_collection(
                    "editor", "editor", "jobs", [{
                        "id": "job-delete-atomic",
                        "productionId": "production-delete-atomic",
                        "updatedAt": 2_000_000_000_007,
                    }],
                )
                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "UPDATE resource_scopes SET scope_id=? "
                        "WHERE resource_kind='doc:jobs' AND resource_id=?",
                        ("external-team", "job-delete-atomic"),
                    )
                drifted = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=(
                        store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                    ),
                )
                self.assertFalse(drifted["ok"])
                self.assertIn("resource_scope_reference_drift", drifted["issues"])
                with self.assertRaisesRegex(
                    PermissionError, "resource_scope_conflict"
                ):
                    store.delete_member_doc(
                        "productions", "production-delete-atomic", "editor", "editor"
                    )
                with sqlite3.connect(database) as conn:
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM docs WHERE collection='productions' "
                            "AND id='production-delete-atomic'"
                        ).fetchone()[0],
                        1,
                    )
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM docs WHERE collection='jobs' "
                            "AND id='job-delete-atomic'"
                        ).fetchone()[0],
                        1,
                    )
                    conn.execute(
                        "UPDATE resource_scopes SET scope_id=? "
                        "WHERE resource_kind='doc:jobs' AND resource_id=?",
                        (store.INTERNAL_TEAM_ID, "job-delete-atomic"),
                    )
                store.delete_member_doc(
                    "productions", "production-delete-atomic", "editor", "editor"
                )
                with sqlite3.connect(database) as conn:
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM docs WHERE "
                            "(collection='productions' AND id='production-delete-atomic') "
                            "OR (collection='jobs' AND id='job-delete-atomic')"
                        ).fetchone()[0],
                        0,
                    )
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM resource_scopes WHERE "
                            "(resource_kind='doc:productions' "
                            "AND resource_id='production-delete-atomic') OR "
                            "(resource_kind='doc:jobs' "
                            "AND resource_id='job-delete-atomic')"
                        ).fetchone()[0],
                        0,
                    )
                store.upsert_member_collection(
                    "owner", "admin", "productions", [{
                        "id": "production-admin-delete",
                        "ownerId": "owner",
                        "updatedAt": 2_000_000_000_008,
                    }],
                )
                store.upsert_member_collection(
                    "owner", "admin", "jobs", [{
                        "id": "job-admin-delete",
                        "ownerId": "owner",
                        "productionId": "production-admin-delete",
                        "updatedAt": 2_000_000_000_009,
                    }],
                )
                store.delete_member_doc(
                    "productions", "production-admin-delete", "owner", "admin"
                )
                with sqlite3.connect(database) as conn:
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM docs WHERE "
                            "id IN ('production-admin-delete','job-admin-delete')"
                        ).fetchone()[0],
                        0,
                    )
                    self.assertEqual(
                        conn.execute(
                            "SELECT COUNT(*) FROM resource_scopes WHERE "
                            "resource_id IN "
                            "('production-admin-delete','job-admin-delete')"
                        ).fetchone()[0],
                        0,
                    )

    def test_unknown_or_ambiguous_resources_fail_closed_without_writes(self):
        for case in ("unknown", "ambiguous"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as tmp:
                database = Path(tmp) / "data.sqlite"
                with sqlite3.connect(database) as conn:
                    conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
                with self._environment(database, tmp):
                    store = load_isolated_store()
                    identity = store._database_identity(database)
                    store.apply_schema_migrations(expected_identity=identity)
                    seed_acg_legacy_fixture(store, database)
                    self._apply_acg(store, database, identity)
                    with sqlite3.connect(database) as conn:
                        if case == "unknown":
                            payload = {"id": "unknown-production"}
                        else:
                            conn.execute(
                                "INSERT INTO members("
                                "id,name,username,username_key,pin_hash,role,parent_id,created_at"
                                ") VALUES(?,?,?,?,?,?,?,?)",
                                (
                                    "external-member", "External", "external-member",
                                    "external-member", "pin", "user", None, 1,
                                ),
                            )
                            conn.execute(
                                "INSERT INTO teams("
                                "id,name,slug,kind,status,plan,quota_mode,created_at,created_by"
                                ") VALUES(?,?,?,?,?,?,?,?,?)",
                                (
                                    "external-team", "External", "external", "customer",
                                    "active", "team", "metered", 1, "external-member",
                                ),
                            )
                            conn.execute(
                                "INSERT INTO team_members("
                                "team_id,member_id,team_role,status,joined_at,added_by"
                                ") VALUES(?,?,?,?,?,?)",
                                (
                                    "external-team", "external-member", "owner", "active",
                                    1, "external-member",
                                ),
                            )
                            conn.execute(
                                "INSERT INTO team_accounts("
                                "team_id,account_id,created_at,added_by"
                                ") VALUES(?,?,?,?)",
                                ("external-team", "external-account", 1, "external-member"),
                            )
                            payload = {
                                "id": "ambiguous-production",
                                "ownerId": "editor",
                                "accountId": "external-account",
                            }
                        conn.execute(
                            "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                            "VALUES('productions',?,?,?,?)",
                            (
                                payload["id"], payload.get("ownerId"), 1,
                                json.dumps(payload),
                            ),
                        )
                    before = logical_database_dump(database)
                    preflight = store.resource_scope_migration_preflight(
                        expected_identity=identity,
                        expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    )
                    self.assertFalse(preflight["ok"])
                    self.assertIn(
                        "resource_scope_unresolved"
                        if case == "unknown"
                        else "resource_scope_ambiguous",
                        preflight["issues"],
                    )
                    with self.assertRaisesRegex(
                        store.StoreNotReadyError, "preflight failed"
                    ):
                        store.apply_resource_scope_migration(
                            expected_identity=identity,
                            expected_schema_version=(
                                store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                            ),
                        )
                    self.assertEqual(before, logical_database_dump(database))

    def test_archived_reference_and_stale_secondary_references_are_audited(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with self._environment(database, tmp):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(expected_identity=identity)
                seed_acg_legacy_fixture(store, database)
                self._apply_acg(store, database, identity)
                self._seed_external_and_reference_docs(store, database)
                now = 1_800_000_100_000
                with sqlite3.connect(database) as conn:
                    rows = [
                        (
                            "analyticsLinks", "link-acg", "editor", now,
                            {
                                "id": "link-acg", "ownerId": "editor",
                                "assetId": "asset-acg",
                            },
                        ),
                        (
                            "metricSnapshots", "snapshot-archived", None, now + 1,
                            {
                                "id": "snapshot-archived",
                                "linkId": "archived:link-acg:1800000100000",
                                "archivedLinkId": "link-acg",
                            },
                        ),
                        (
                            "batches", "batch-stale-reference", "editor", now + 2,
                            {
                                "id": "batch-stale-reference", "ownerId": "editor",
                                "productionIds": ["deleted-production"],
                            },
                        ),
                    ]
                    conn.executemany(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES(?,?,?,?,?)",
                        [
                            (collection, item_id, owner, updated_at, json.dumps(payload))
                            for collection, item_id, owner, updated_at, payload in rows
                        ],
                    )
                preflight = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                self.assertTrue(preflight["ok"])
                self.assertEqual(preflight["issues"], [])
                self.assertIn("resource_reference_stale", preflight["warnings"])
                self.assertGreaterEqual(preflight["counts"]["staleReferences"], 2)
                applied = store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                self.assertTrue(applied["applied"])
                with sqlite3.connect(database) as conn:
                    scope = conn.execute(
                        "SELECT scope_type,scope_id FROM resource_scopes "
                        "WHERE resource_kind='doc:metricSnapshots' AND resource_id=?",
                        ("snapshot-archived",),
                    ).fetchone()
                self.assertEqual(scope, ("team", store.INTERNAL_TEAM_ID))

    def test_late_cross_tenant_reference_is_not_frozen_from_owner_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with self._environment(database, tmp):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(expected_identity=identity)
                seed_acg_legacy_fixture(store, database)
                self._apply_acg(store, database, identity)
                self._seed_external_and_reference_docs(store, database)
                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('assets','asset-order-conflict','editor',?,?)",
                        (
                            1_900_000_000_000,
                            json.dumps({
                                "id": "asset-order-conflict",
                                "ownerId": "editor",
                                "productionId": "production-external",
                            }),
                        ),
                    )
                before = logical_database_dump(database)
                preflight = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                self.assertFalse(preflight["ok"])
                self.assertIn("resource_scope_ambiguous", preflight["issues"])
                self.assertIn(
                    {
                        "resourceKind": "doc:assets",
                        "resourceId": "asset-order-conflict",
                    },
                    preflight["ambiguousResources"],
                )
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "preflight failed"
                ):
                    store.apply_resource_scope_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                        ),
                    )
                self.assertEqual(before, logical_database_dump(database))

    def test_override_manifest_is_exact_identity_bound_and_audited(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with self._environment(database, tmp):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(expected_identity=identity)
                seed_acg_legacy_fixture(store, database)
                self._apply_acg(store, database, identity)
                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('jobs','orphan-job',NULL,1,?)",
                        (json.dumps({
                            "id": "orphan-job",
                            "productionId": "deleted-production",
                        }),),
                    )

                missing = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                self.assertFalse(missing["ok"])
                self.assertIn("resource_scope_override_missing", missing["issues"])
                resources = missing["unresolvedResources"]
                self.assertEqual(
                    resources,
                    [{"resourceKind": "doc:jobs", "resourceId": "orphan-job"}],
                )

                manifest = Path(tmp) / "overrides.json"
                digest, override_backup = self._write_override_manifest(
                    store, manifest, identity, resources
                )
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "sha256 mismatch"
                ):
                    store.resource_scope_migration_preflight(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                        ),
                        override_manifest_path=manifest,
                        expected_override_manifest_sha256="0" * 64,
                        backup_binding=override_backup,
                    )

                wrong_database = Path(tmp) / "wrong-database.json"
                wrong_database_digest, wrong_database_backup = self._write_override_manifest(
                    store, wrong_database, "wrong-database", resources
                )
                before = logical_database_dump(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "database identity mismatch"
                ):
                    store.apply_resource_scope_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                        ),
                        override_manifest_path=wrong_database,
                        expected_override_manifest_sha256=wrong_database_digest,
                        backup_binding=wrong_database_backup,
                    )
                self.assertEqual(before, logical_database_dump(database))

                for field, value, error in (
                    ("databasePathSha256", "f" * 64, "database path mismatch"),
                    ("schemaVersion", override_backup["sourceSchemaVersion"] + 1, "schema version mismatch"),
                    ("userVersion", override_backup["sourceUserVersion"] + 1, "user version mismatch"),
                ):
                    with self.subTest(frozen_field=field):
                        frozen_manifest = Path(tmp) / f"wrong-{field}.json"
                        frozen_digest, frozen_backup = self._write_override_manifest(
                            store,
                            frozen_manifest,
                            identity,
                            resources,
                            backup_binding=override_backup,
                            manifest_overrides={field: value},
                        )
                        before = logical_database_dump(database)
                        with self.assertRaisesRegex(store.StoreNotReadyError, error):
                            store.apply_resource_scope_migration(
                                expected_identity=identity,
                                expected_schema_version=(
                                    store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                                ),
                                backup_binding=frozen_backup,
                                override_manifest_path=frozen_manifest,
                                expected_override_manifest_sha256=frozen_digest,
                            )
                        self.assertEqual(before, logical_database_dump(database))

                extra_manifest = Path(tmp) / "extra.json"
                extra_digest, extra_backup = self._write_override_manifest(
                    store,
                    extra_manifest,
                    identity,
                    [
                        *resources,
                        {"resourceKind": "doc:jobs", "resourceId": "not-present"},
                    ],
                )
                extra = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    override_manifest_path=extra_manifest,
                    expected_override_manifest_sha256=extra_digest,
                    backup_binding=extra_backup,
                )
                self.assertFalse(extra["ok"])
                self.assertIn("resource_scope_override_extra", extra["issues"])

                invalid_target = Path(tmp) / "invalid-target.json"
                invalid_target_digest, invalid_target_backup = self._write_override_manifest(
                    store,
                    invalid_target,
                    identity,
                    resources,
                    scopeId="missing-team",
                )
                invalid = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    override_manifest_path=invalid_target,
                    expected_override_manifest_sha256=invalid_target_digest,
                    backup_binding=invalid_target_backup,
                )
                self.assertFalse(invalid["ok"])
                self.assertIn(
                    "resource_scope_override_target_invalid", invalid["issues"]
                )

                approved = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    override_manifest_path=manifest,
                    expected_override_manifest_sha256=digest,
                    backup_binding=override_backup,
                )
                self.assertTrue(approved["ok"])
                self.assertEqual(approved["overrideManifestSha256"], digest)
                self.assertEqual(
                    approved["databaseLogicalSha256"],
                    override_backup["sourceLogicalSha256"],
                )
                self.assertEqual(
                    approved["databasePathSha256"],
                    override_backup["sourcePathSha256"],
                )
                self.assertEqual(
                    approved["backupManifestSha256"],
                    override_backup["manifestSha256"],
                )
                docs_before = protected_fixture_rows(database)[2]
                applied = store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    override_manifest_path=manifest,
                    expected_override_manifest_sha256=digest,
                    backup_binding=override_backup,
                )
                self.assertTrue(applied["applied"])
                self.assertEqual(protected_fixture_rows(database)[2], docs_before)
                with sqlite3.connect(database) as conn:
                    scope = conn.execute(
                        "SELECT scope_type,scope_id,provenance FROM resource_scopes "
                        "WHERE resource_kind='doc:jobs' AND resource_id='orphan-job'"
                    ).fetchone()
                    summary = json.loads(conn.execute(
                        "SELECT summary FROM schema_migrations WHERE version=?",
                        (store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,),
                    ).fetchone()[0])
                self.assertEqual(scope[:2], ("team", store.INTERNAL_TEAM_ID))
                self.assertTrue(scope[2].startswith("v140-explicit-override:"))
                self.assertEqual(summary["overrideManifestSha256"], digest)
                self.assertEqual(summary["overrideEntries"], 1)
                self.assertEqual(
                    summary["overrideDatabaseLogicalSha256"],
                    override_backup["sourceLogicalSha256"],
                )
                self.assertEqual(
                    summary["overrideBackupManifestSha256"],
                    override_backup["manifestSha256"],
                )
                second = store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                self.assertFalse(second["applied"])

    def test_real_v120_snapshot_copy_closes_with_reviewed_dynamic_overrides(self):
        configured = str(os.getenv("ACG_RESOURCE_SCOPE_REAL_SNAPSHOT") or "").strip()
        snapshot = (
            Path(configured)
            if configured
            else Path(__file__).resolve().parents[2]
            / "服务器数据"
            / "核心数据_数据库与配置"
            / "data.sqlite"
        )
        if not snapshot.is_file():
            self.skipTest("ignored read-only v120 snapshot is not present")
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            shutil.copy2(snapshot, database)
            with self._environment(database, tmp):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(expected_identity=identity)
                self._apply_acg(store, database, identity)
                initial = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                )
                self.assertFalse(initial["ok"])
                self.assertEqual(initial["counts"]["documents"], 7044)
                self.assertEqual(initial["counts"]["unresolved"], 5)
                self.assertEqual(
                    {item["resourceKind"] for item in initial["unresolvedResources"]},
                    {"doc:jobs", "doc:sessions"},
                )
                self.assertIn("resource_reference_stale", initial["warnings"])

                manifest = Path(tmp) / "reviewed-overrides.json"
                digest, override_backup = self._write_override_manifest(
                    store,
                    manifest,
                    identity,
                    initial["unresolvedResources"],
                )
                approved = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    override_manifest_path=manifest,
                    expected_override_manifest_sha256=digest,
                    backup_binding=override_backup,
                )
                self.assertTrue(approved["ok"])
                self.assertEqual(approved["counts"]["scoped"], 7044)
                with store._connect(read_only=True) as conn:
                    docs_before = store._acg_protected_digests_locked(conn)["docs"]
                applied = store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    override_manifest_path=manifest,
                    expected_override_manifest_sha256=digest,
                    backup_binding=override_backup,
                )
                self.assertTrue(applied["applied"])
                with store._connect(read_only=True) as conn:
                    docs_after = store._acg_protected_digests_locked(conn)["docs"]
                    scoped = conn.execute(
                        "SELECT COUNT(*) FROM resource_scopes WHERE resource_kind LIKE 'doc:%'"
                    ).fetchone()[0]
                self.assertEqual(docs_after, docs_before)
                self.assertEqual(scoped, 7044)

    def test_production_resource_apply_requires_current_backup_binding(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
            with self._environment(database, tmp, mode="production"):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                seed_acg_legacy_fixture(store, database)
                self._apply_acg(store, database, identity)
                before_missing = logical_database_dump(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "backup manifest binding is required"
                ):
                    store.apply_resource_scope_migration(
                        expected_identity=identity,
                        expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    )
                self.assertEqual(before_missing, logical_database_dump(database))

                stale_binding = current_backup_binding(store, database)
                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('products','after-backup',NULL,1,?)",
                        (json.dumps({"id": "after-backup"}),),
                    )
                before_stale = logical_database_dump(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "changed after verified backup"
                ):
                    store.apply_resource_scope_migration(
                        expected_identity=identity,
                        expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                        backup_binding=stale_binding,
                    )
                self.assertEqual(before_stale, logical_database_dump(database))
                with sqlite3.connect(database) as conn:
                    ledger = conn.execute(
                        "SELECT 1 FROM schema_migrations WHERE version=?",
                        (store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,),
                    ).fetchone()
                self.assertIsNone(ledger)

                applied = store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                    backup_binding=current_backup_binding(store, database),
                )
                self.assertTrue(applied["applied"])

    def test_production_override_requires_exact_manifest_and_fresh_v2_backup(self):
        """Exercise the complete operator path, not its gates in isolation."""

        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "data.sqlite"
            with sqlite3.connect(database) as conn:
                conn.execute("CREATE TABLE legacy_record(id TEXT PRIMARY KEY)")
                conn.execute("INSERT INTO legacy_record(id) VALUES('before-backup')")
            with self._environment(database, tmp, mode="production"):
                store = load_isolated_store()
                identity = store._database_identity(database)
                store.apply_schema_migrations(
                    expected_identity=identity,
                    backup_binding=current_backup_binding(store, database),
                )
                seed_acg_legacy_fixture(store, database)
                self._apply_acg(store, database, identity)
                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "INSERT INTO docs(collection,id,owner_id,updated_at,data) "
                        "VALUES('jobs','production-orphan-job',NULL,1,?)",
                        (json.dumps({
                            "id": "production-orphan-job",
                            "productionId": "deleted-production",
                        }),),
                    )

                unresolved = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=(
                        store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                    ),
                )
                self.assertFalse(unresolved["ok"])
                self.assertEqual(
                    unresolved["unresolvedResources"],
                    [{
                        "resourceKind": "doc:jobs",
                        "resourceId": "production-orphan-job",
                    }],
                )
                manifest = Path(tmp) / "production-overrides.json"
                digest, reviewed_backup = self._write_override_manifest(
                    store,
                    manifest,
                    identity,
                    unresolved["unresolvedResources"],
                )

                # A fresh backup cannot compensate for a missing or mistyped
                # reviewed override. Both rejects leave the complete DB intact.
                for case, override_args, error in (
                    ("missing", {}, "preflight failed"),
                    (
                        "wrong-sha",
                        {
                            "override_manifest_path": manifest,
                            "expected_override_manifest_sha256": "0" * 64,
                        },
                        "sha256 mismatch",
                    ),
                ):
                    with self.subTest(case=case):
                        before = logical_database_dump(database)
                        with self.assertRaisesRegex(store.StoreNotReadyError, error):
                            store.apply_resource_scope_migration(
                                expected_identity=identity,
                                expected_schema_version=(
                                    store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                                ),
                                backup_binding=current_backup_binding(store, database),
                                **override_args,
                            )
                        self.assertEqual(before, logical_database_dump(database))

                stale_binding = reviewed_backup
                with sqlite3.connect(database) as conn:
                    conn.execute(
                        "INSERT INTO legacy_record(id) VALUES('after-stale-backup')"
                    )
                before_stale = logical_database_dump(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError, "changed after verified backup"
                ):
                    store.apply_resource_scope_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                        ),
                        backup_binding=stale_binding,
                        override_manifest_path=manifest,
                        expected_override_manifest_sha256=digest,
                    )
                self.assertEqual(before_stale, logical_database_dump(database))

                # The inode is intentionally unchanged. A new valid backup of
                # the changed DB must not make an override reviewed against the
                # old logical state valid again.
                self.assertEqual(identity, store._database_identity(database))
                fresh_changed_binding = {
                    **current_backup_binding(store, database),
                    "manifestSha256": "c" * 64,
                }
                before_fresh_old_override = logical_database_dump(database)
                with self.assertRaisesRegex(
                    store.StoreNotReadyError,
                    "database logical state mismatch|backup manifest mismatch",
                ):
                    store.apply_resource_scope_migration(
                        expected_identity=identity,
                        expected_schema_version=(
                            store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                        ),
                        backup_binding=fresh_changed_binding,
                        override_manifest_path=manifest,
                        expected_override_manifest_sha256=digest,
                    )
                self.assertEqual(
                    before_fresh_old_override, logical_database_dump(database)
                )

                # Re-review and reseal the same unresolved mapping against the
                # fresh backup/current logical state before any write is allowed.
                digest, reviewed_backup = self._write_override_manifest(
                    store,
                    manifest,
                    identity,
                    unresolved["unresolvedResources"],
                    backup_binding=fresh_changed_binding,
                )
                approved = store.resource_scope_migration_preflight(
                    expected_identity=identity,
                    expected_schema_version=(
                        store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                    ),
                    backup_binding=reviewed_backup,
                    override_manifest_path=manifest,
                    expected_override_manifest_sha256=digest,
                )
                self.assertTrue(approved["ok"])

                applied = store.apply_resource_scope_migration(
                    expected_identity=identity,
                    expected_schema_version=(
                        store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION
                    ),
                    backup_binding=reviewed_backup,
                    override_manifest_path=manifest,
                    expected_override_manifest_sha256=digest,
                )
                self.assertTrue(applied["applied"])
                self.assertEqual(applied["overrideManifestSha256"], digest)
                with sqlite3.connect(database) as conn:
                    scope = conn.execute(
                        "SELECT scope_type,scope_id,provenance FROM resource_scopes "
                        "WHERE resource_kind='doc:jobs' AND resource_id=?",
                        ("production-orphan-job",),
                    ).fetchone()
                    ledger = json.loads(conn.execute(
                        "SELECT summary FROM schema_migrations WHERE version=?",
                        (store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,),
                    ).fetchone()[0])
                self.assertEqual(scope[:2], ("team", store.INTERNAL_TEAM_ID))
                self.assertTrue(scope[2].startswith("v140-explicit-override:"))
                self.assertEqual(ledger["overrideManifestSha256"], digest)
                self.assertEqual(ledger["overrideEntries"], 1)
                self.assertEqual(
                    ledger["overrideDatabaseLogicalSha256"],
                    reviewed_backup["sourceLogicalSha256"],
                )
                self.assertEqual(
                    ledger["overrideBackupManifestSha256"],
                    reviewed_backup["manifestSha256"],
                )


if __name__ == "__main__":
    unittest.main()
