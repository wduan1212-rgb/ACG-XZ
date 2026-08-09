import hashlib
import io
import json
import os
import sqlite3
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import model_usage_settlement, store
from server.tests.test_runtime_bootstrap_safety import (
    current_backup_binding,
    current_runtime_snapshot_binding,
    logical_database_dump,
)


class ModelUsageSettlementTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "usage-settlement.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.member = store.add_member(
            "视频创作者", "usage-settlement-editor", "123456", "editor"
        )
        self.sidecars = {}
        self._add_operation(
            "video-workshop:project-a:director:operation-a",
            usage_kind="llm",
            status="succeeded",
            provider_ref="provider-request-a",
            input_tokens=12,
            output_tokens=8,
            total_tokens=20,
        )
        self._add_operation(
            "video-workshop:project-a:storyboard:operation-b",
            usage_kind="image",
            status="unknown",
        )

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _add_operation(
        self,
        operation_id,
        *,
        usage_kind,
        status,
        provider_ref="",
        input_tokens=0,
        output_tokens=0,
        total_tokens=0,
    ):
        feature = "视频工坊导演理解" if usage_kind == "llm" else "静态分镜图片生成"
        provider = "minimax" if usage_kind == "llm" else "tencent-maas"
        model = "MiniMax-M3" if usage_kind == "llm" else "custom-image-model"
        unit_label = "次" if usage_kind == "llm" else "张"
        sidecar = {
            "schemaVersion": 1,
            "operationId": operation_id,
            "surface": "video-workshop",
            "projectId": "project-a",
            "feature": feature,
            "usageKind": usage_kind,
            "provider": provider,
            "providerRef": provider_ref,
            "model": model,
            "status": status,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
            "usageObserved": bool(total_tokens),
            "outputUnits": 0,
            "unitLabel": unit_label,
            "occurredAt": "2026-08-04T10:00:00+08:00",
            "reconcileState": "pending",
        }
        immutable = {
            "schemaVersion": 1,
            "surface": "video-workshop",
            "projectId": "project-a",
            "operationId": operation_id,
            "usageKind": usage_kind,
            "feature": feature,
            "provider": provider,
            "model": model,
            "unitLabel": unit_label,
        }
        receipt = store.begin_model_usage_receipt(
            self.member[0],
            surface="video-workshop",
            feature=feature,
            usage_kind=usage_kind,
            operation="provider-call",
            operation_id=operation_id,
            idempotency_key=operation_id,
            request_fingerprint=store._canonical_json_sha256(immutable),
            source="video-workshop-sidecar",
            provider=provider,
            model=model,
        )
        if status == "unknown":
            store.mark_model_usage_receipt_unknown(
                receipt["receiptId"], "provider response was uncertain"
            )
        self.sidecars[operation_id] = sidecar

    def _plan(self):
        evidence = store.model_usage_settlement_evidence(sorted(self.sidecars))
        central = {item["operationId"]: item for item in evidence["entries"]}
        snapshot = current_runtime_snapshot_binding(store)
        entries = []
        for operation_id in sorted(self.sidecars):
            status = self.sidecars[operation_id]["status"]
            entries.append({
                "operationId": operation_id,
                "centralReceiptSha256": central[operation_id][
                    "centralReceiptSha256"
                ],
                "sidecarReceiptSha256": model_usage_settlement.canonical_sha256(
                    self.sidecars[operation_id]
                ),
                "resolution": (
                    "operator-confirmed-unknown"
                    if status == "unknown"
                    else "sidecar-succeeded"
                ),
                "operatorReviewed": True,
                "reviewNote": (
                    "Provider call was sent; billing and output remain unknowable."
                    if status == "unknown"
                    else ""
                ),
            })
        plan = {
            "format": model_usage_settlement.PLAN_FORMAT,
            "databaseIdentity": evidence["databaseIdentity"],
            "snapshotManifestSha256": snapshot["manifestSha256"],
            "snapshotMediaInventoryDigest": snapshot["mediaInventoryDigest"],
            "reviewedBy": "test-operator",
            "reviewedAt": "2026-08-04T12:00:00+08:00",
            "entries": entries,
        }
        return plan, model_usage_settlement.canonical_sha256(plan), snapshot

    def _apply(self, plan, plan_sha256, snapshot, *, dry_run=False):
        selected_sidecars = {
            entry["operationId"]: self.sidecars[entry["operationId"]]
            for entry in plan["entries"]
        }
        with patch.dict(
            os.environ,
            {"ACG_ALLOW_MODEL_USAGE_SETTLEMENT": "1"},
            clear=False,
        ):
            return store.settle_model_usage_receipts_reviewed(
                plan=plan,
                plan_sha256=plan_sha256,
                sidecar_receipts=selected_sidecars,
                expected_identity=store._database_identity(store.DB_PATH),
                expected_schema_version=(
                    store.MODEL_USAGE_SETTLEMENT_SCHEMA_MIGRATION_VERSION
                ),
                backup_binding=current_backup_binding(store, store.DB_PATH),
                runtime_snapshot_binding=snapshot,
                created_by="test-operator",
                dry_run=dry_run,
            )

    def test_exact_plan_atomically_resolves_projects_and_replays_zero_write(self):
        plan, plan_sha256, snapshot = self._plan()
        preflight = self._apply(plan, plan_sha256, snapshot, dry_run=True)
        self.assertTrue(preflight["dryRun"])
        self.assertEqual(2, preflight["plannedRows"])

        first = self._apply(plan, plan_sha256, snapshot)
        self.assertTrue(first["applied"])
        self.assertEqual(2, first["insertedRows"])
        self.assertEqual(0, first["unresolved"])
        self.assertEqual(0, first["outboxPending"])
        self.assertEqual("ok", first["quickCheck"])

        with sqlite3.connect(store.DB_PATH) as conn:
            rows = conn.execute(
                "SELECT operation_id,call_status,calls,total_tokens,output_units,error "
                "FROM model_usage_receipts ORDER BY operation_id"
            ).fetchall()
            outbox = conn.execute(
                "SELECT state FROM model_usage_outbox ORDER BY receipt_id"
            ).fetchall()
            llm = conn.execute(
                "SELECT total_tokens FROM llm_usage_events"
            ).fetchall()
            api = conn.execute(
                "SELECT api_type,calls,output_units FROM api_usage_events"
            ).fetchall()
            settlements = conn.execute(
                "SELECT COUNT(*) FROM model_usage_settlements"
            ).fetchone()[0]
            entries = conn.execute(
                "SELECT COUNT(*) FROM model_usage_settlement_entries"
            ).fetchone()[0]
        self.assertEqual("succeeded", rows[0][1])
        self.assertEqual((1, 20, 0, ""), rows[0][2:])
        self.assertEqual("succeeded", rows[1][1])
        self.assertEqual((1, 0, 0), rows[1][2:5])
        self.assertIn("operator-reviewed", rows[1][5])
        self.assertEqual([("projected",), ("projected",)], outbox)
        self.assertEqual([(20,)], llm)
        self.assertEqual([("image", 1, 0)], api)
        self.assertEqual(1, settlements)
        self.assertEqual(2, entries)

        unknown_operation = "video-workshop:project-a:storyboard:operation-b"
        status = store.video_workshop_usage_receipt_status(
            self.member[0], "", "project-a", self.sidecars[unknown_operation],
        )
        self.assertEqual("terminal", status["state"])
        self.assertEqual("settled-unknown", status["reason"])
        tampered_unknown = dict(self.sidecars[unknown_operation])
        tampered_unknown["feature"] = "tampered-feature"
        tampered_status = store.video_workshop_usage_receipt_status(
            self.member[0], "", "project-a", tampered_unknown,
        )
        self.assertEqual("conflict", tampered_status["state"])

        before = logical_database_dump(store.DB_PATH)
        second = self._apply(plan, plan_sha256, snapshot)
        self.assertFalse(second["applied"])
        self.assertTrue(second["reused"])
        self.assertEqual(0, second["insertedRows"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

        with sqlite3.connect(store.DB_PATH) as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute(
                    "UPDATE model_usage_settlements SET created_by='tampered'"
                )

    def test_hash_conflict_rolls_back_every_receipt_and_audit_row(self):
        plan, plan_sha256, snapshot = self._plan()
        plan["entries"][1]["centralReceiptSha256"] = "f" * 64
        plan_sha256 = model_usage_settlement.canonical_sha256(plan)
        before = logical_database_dump(store.DB_PATH)
        with self.assertRaises(store.StoreNotReadyError):
            self._apply(plan, plan_sha256, snapshot)
        self.assertEqual(before, logical_database_dump(store.DB_PATH))
        self.assertEqual(2, len(store.unresolved_model_usage_receipts()))

    def test_legacy_media_error_unit_is_normalized_without_weakening_identity(self):
        operation_id = "video-workshop:project-a:storyboard:operation-b"
        sidecar = self.sidecars[operation_id]
        sidecar["unitLabel"] = "次"
        plan, plan_sha256, snapshot = self._plan()

        first = self._apply(plan, plan_sha256, snapshot)
        self.assertTrue(first["applied"])
        with sqlite3.connect(store.DB_PATH) as conn:
            unit_label = conn.execute(
                "SELECT unit_label FROM model_usage_receipts WHERE operation_id=?",
                (operation_id,),
            ).fetchone()[0]
        self.assertEqual("张", unit_label)

    def test_legacy_unit_compatibility_rejects_other_identity_drift(self):
        operation_id = "video-workshop:project-a:storyboard:operation-b"
        sidecar = self.sidecars[operation_id]
        sidecar["unitLabel"] = "次"
        sidecar["feature"] = "不同任务"
        plan, plan_sha256, snapshot = self._plan()
        with self.assertRaisesRegex(
            store.StoreNotReadyError, "immutable identity mismatch",
        ):
            self._apply(plan, plan_sha256, snapshot)

    def test_plan_must_cover_the_entire_unresolved_set(self):
        plan, _plan_sha256, snapshot = self._plan()
        plan["entries"] = plan["entries"][:1]
        plan_sha256 = model_usage_settlement.canonical_sha256(plan)
        with self.assertRaisesRegex(
            store.StoreNotReadyError, "exactly cover unresolved"
        ):
            self._apply(plan, plan_sha256, snapshot)

    def test_plan_loader_and_snapshot_reader_require_exact_hashes(self):
        plan, _plan_sha256, _snapshot = self._plan()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan_path = root / "plan.json"
            raw_plan = model_usage_settlement.canonical_json_bytes(plan)
            plan_path.write_bytes(raw_plan)
            loaded, digest = model_usage_settlement.load_review_plan(
                plan_path,
                expected_sha256=hashlib.sha256(raw_plan).hexdigest(),
            )
            self.assertEqual(plan, loaded)
            self.assertEqual(hashlib.sha256(raw_plan).hexdigest(), digest)

            project = {
                "id": "project-a",
                "modelUsageReceipts": list(self.sidecars.values()),
            }
            archive = root / "components" / "video-projects.tar"
            archive.parent.mkdir()
            encoded = json.dumps(project).encode("utf-8")
            with tarfile.open(archive, "w") as bundle:
                info = tarfile.TarInfo("project-a.json")
                info.size = len(encoded)
                info.mode = 0o600
                bundle.addfile(info, io.BytesIO(encoded))
            (root / "snapshot.manifest.json").write_text(json.dumps({
                "components": [{
                    "name": "video-projects",
                    "type": "directory",
                    "artifact": "components/video-projects.tar",
                }],
            }), encoding="utf-8")
            extracted = model_usage_settlement.extract_sidecar_receipts(
                root, sorted(self.sidecars),
            )
            model_usage_settlement.verify_sidecar_hashes(plan, extracted)
            plan["entries"][0]["sidecarReceiptSha256"] = "0" * 64
            with self.assertRaisesRegex(
                model_usage_settlement.SettlementPlanError, "hash_mismatch"
            ):
                model_usage_settlement.verify_sidecar_hashes(plan, extracted)

            manifest_path = root / "snapshot.manifest.json"
            manifest_path.write_text(json.dumps({
                "components": [{
                    "name": "video-projects",
                    "type": "directory",
                    "artifact": "../video-projects.tar",
                }],
            }), encoding="utf-8")
            with self.assertRaisesRegex(
                model_usage_settlement.SettlementPlanError,
                "artifact_invalid",
            ):
                model_usage_settlement.extract_sidecar_receipts(
                    root, sorted(self.sidecars),
                )

            manifest_path.write_text(json.dumps({
                "components": [{
                    "name": "video-projects",
                    "type": "directory",
                    "artifact": "components/video-projects-link.tar",
                }],
            }), encoding="utf-8")
            link = root / "components" / "video-projects-link.tar"
            try:
                link.symlink_to(archive.name)
            except (OSError, NotImplementedError):
                pass
            else:
                with self.assertRaisesRegex(
                    model_usage_settlement.SettlementPlanError,
                    "artifact_invalid",
                ):
                    model_usage_settlement.extract_sidecar_receipts(
                        root, sorted(self.sidecars),
                    )

    def test_140008_through_140010_are_additive_for_140007_read_only_contract(self):
        before = logical_database_dump(store.DB_PATH)
        uri = f"file:{store.DB_PATH}?mode=ro"
        with sqlite3.connect(uri, uri=True) as conn:
            tables = {
                row[0] for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            previous_expected = set(store.EXPECTED_SCHEMA_TABLES) - {
                "production_recovery_settlements",
                "production_recovery_entries",
                "model_usage_settlements_v2",
                "model_usage_settlement_entries_v2",
                "media_isolation_settlements",
                "media_isolation_entries",
            }
            self.assertFalse(previous_expected - tables)
            known_versions = (
                store.SCHEMA_MIGRATION_VERSION,
                store.MODEL_USAGE_SCHEMA_MIGRATION_VERSION,
                store.RESOURCE_SCOPE_SCHEMA_MIGRATION_VERSION,
                store.PRIVATE_MEDIA_SCHEMA_MIGRATION_VERSION,
                store.VIDEO_COMPOSE_SCHEMA_MIGRATION_VERSION,
                store.MEMBER_CONTROL_SCHEMA_MIGRATION_VERSION,
                store.MODEL_USAGE_SETTLEMENT_SCHEMA_MIGRATION_VERSION,
            )
            for version in known_versions:
                self.assertEqual(
                    "success",
                    conn.execute(
                        "SELECT status FROM schema_migrations WHERE version=?",
                        (version,),
                    ).fetchone()[0],
                )
            self.assertEqual(
                0,
                conn.execute(
                    "SELECT COUNT(*) FROM schema_migrations WHERE status<>'success'"
                ).fetchone()[0],
            )
            self.assertEqual(0, conn.execute("PRAGMA user_version").fetchone()[0])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))


if __name__ == "__main__":
    unittest.main()
