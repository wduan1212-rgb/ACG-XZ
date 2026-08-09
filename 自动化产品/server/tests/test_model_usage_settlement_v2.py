import hashlib
import json
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from server import main, model_usage_settlement_v2, store
from server.tests.test_runtime_bootstrap_safety import (
    current_backup_binding,
    current_runtime_snapshot_binding,
    logical_database_dump,
)


class ModelUsageSettlementV2Test(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "usage-settlement-v2.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.team_id = store.INTERNAL_TEAM_ID
        self.member = store.add_member(
            "结算测试创作者", "usage-settlement-v2-editor", "123456", "editor",
            team_id=self.team_id, team_role="creator",
        )
        self.rows = {}
        self.sidecars = {}
        self._add_central_unknown(
            "main-provider:asset-image-timeout", source="main-provider",
            usage_kind="image", error="ReadTimeout while awaiting provider response",
        )
        self._add_central_unknown(
            "custom-canvas:generation-timeout", source="custom-canvas",
            usage_kind="image",
            error="HTTPException;status=502;evidence_sha256=" + "a" * 64,
        )
        self._add_sidecar(
            "video-workshop:project-a:director:success", usage_kind="llm",
            status="succeeded", provider_ref="provider-success-1",
            input_tokens=12, output_tokens=8, total_tokens=20,
        )
        self._add_sidecar(
            "video-workshop:project-a:image:unknown", usage_kind="image",
            status="unknown",
        )
        self._add_sidecar(
            "video-workshop:project-a:image:submitted", usage_kind="image",
            status="submitted",
        )

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _begin(self, operation_id, *, source, usage_kind, feature, provider, model,
               fingerprint="request-fingerprint"):
        receipt = store.begin_model_usage_receipt(
            self.member[0], surface=(
                "video-workshop" if source == "video-workshop-sidecar" else "studio"
            ), feature=feature, usage_kind=usage_kind, operation="provider-call",
            operation_id=operation_id, idempotency_key=operation_id,
            request_fingerprint=fingerprint, source=source,
            provider=provider, model=model,
        )
        self.rows[operation_id] = receipt["receiptId"]
        return receipt

    def _add_central_unknown(self, operation_id, *, source, usage_kind, error):
        receipt = self._begin(
            operation_id, source=source, usage_kind=usage_kind,
            feature="站内图片生成", provider="central-provider",
            model="central-image-model",
        )
        store.mark_model_usage_receipt_unknown(receipt["receiptId"], error)

    def _add_sidecar(self, operation_id, *, usage_kind, status, provider_ref="",
                     input_tokens=0, output_tokens=0, total_tokens=0):
        feature = "视频工坊导演理解" if usage_kind == "llm" else "静态分镜图片生成"
        provider = "minimax" if usage_kind == "llm" else "tencent-maas"
        model = "MiniMax-M3" if usage_kind == "llm" else "image-model"
        unit_label = "次" if usage_kind == "llm" else "张"
        immutable = {
            "schemaVersion": 1, "surface": "video-workshop",
            "projectId": "project-a", "operationId": operation_id,
            "usageKind": usage_kind, "feature": feature, "provider": provider,
            "model": model, "unitLabel": unit_label,
        }
        receipt = self._begin(
            operation_id, source="video-workshop-sidecar", usage_kind=usage_kind,
            feature=feature, provider=provider, model=model,
            fingerprint=store._canonical_json_sha256(immutable),
        )
        if status == "unknown":
            store.mark_model_usage_receipt_unknown(
                receipt["receiptId"], "ReadTimeout after sidecar provider request",
            )
        self.sidecars[operation_id] = {
            **immutable,
            # Production legacy error paths retained the recorder default
            # after central intent had already frozen the typed image unit.
            "unitLabel": (
                "次"
                if usage_kind == "image" and status in {"unknown", "submitted"}
                else unit_label
            ),
            "providerRef": provider_ref,
            "status": status,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
            "usageObserved": bool(total_tokens),
            "outputUnits": 0,
            "occurredAt": "2026-08-09T10:00:00+08:00",
            "reconcileState": "pending",
        }

    def _plan(self):
        receipt_ids = sorted(self.rows.values())
        evidence = store.model_usage_settlement_v2_evidence(receipt_ids)
        central = {entry["receiptId"]: entry for entry in evidence["entries"]}
        snapshot = current_runtime_snapshot_binding(store)
        entries = []
        for operation_id, receipt_id in self.rows.items():
            row = central[receipt_id]
            source = row["source"]
            if source in model_usage_settlement_v2.CENTRAL_SOURCES:
                resolution = "central-attempt-outcome-unknown"
                sidecar_sha = ""
            else:
                status = self.sidecars[operation_id]["status"]
                resolution = {
                    "succeeded": "sidecar-succeeded",
                    "unknown": "sidecar-attempt-outcome-unknown",
                    "submitted": "sidecar-submitted-indeterminate",
                }[status]
                sidecar_sha = model_usage_settlement_v2.canonical_sha256(
                    self.sidecars[operation_id]
                )
            entries.append({
                "receiptId": receipt_id,
                "source": source,
                "operationId": operation_id,
                "centralReceiptSha256": row["centralReceiptSha256"],
                "sidecarReceiptSha256": sidecar_sha,
                "resolution": resolution,
                "operatorReviewed": True,
                "reviewNote": "Operator reviewed immutable receipt evidence; no provider retry is authorized.",
            })
        entries.sort(key=lambda entry: entry["receiptId"])
        plan = {
            "format": model_usage_settlement_v2.PLAN_FORMAT,
            "databaseIdentity": evidence["databaseIdentity"],
            "snapshotManifestSha256": snapshot["manifestSha256"],
            "snapshotMediaInventoryDigest": snapshot["mediaInventoryDigest"],
            "reviewedBy": "test-operator",
            "reviewedAt": "2026-08-09T12:00:00+08:00",
            "entries": entries,
        }
        return plan, model_usage_settlement_v2.canonical_sha256(plan), snapshot

    def _apply(self, plan, plan_sha256, snapshot, *, dry_run=False):
        selected_sidecars = {
            entry["operationId"]: self.sidecars[entry["operationId"]]
            for entry in plan["entries"]
            if entry["source"] == model_usage_settlement_v2.SIDECAR_SOURCE
        }
        with patch.dict(
            os.environ, {"ACG_ALLOW_MODEL_USAGE_SETTLEMENT_V2": "1"}, clear=False,
        ):
            return store.settle_model_usage_receipts_reviewed_v2(
                plan=plan, plan_sha256=plan_sha256,
                sidecar_receipts=selected_sidecars,
                expected_identity=store._database_identity(store.DB_PATH),
                expected_schema_version=(
                    store.MODEL_USAGE_SETTLEMENT_V2_SCHEMA_MIGRATION_VERSION
                ),
                backup_binding=current_backup_binding(store, store.DB_PATH),
                runtime_snapshot_binding=snapshot,
                created_by="test-operator", dry_run=dry_run,
            )

    def test_mixed_source_exact_set_is_terminal_and_replays_zero_write(self):
        plan, plan_sha256, snapshot = self._plan()
        preview = self._apply(plan, plan_sha256, snapshot, dry_run=True)
        self.assertEqual(5, preview["plannedRows"])
        self.assertEqual(1, preview["indeterminateRows"])

        result = self._apply(plan, plan_sha256, snapshot)
        self.assertTrue(result["applied"])
        self.assertEqual(5, result["insertedRows"])
        self.assertEqual(4, result["projectedRows"])
        self.assertEqual(1, result["indeterminateRows"])
        self.assertEqual(0, result["unresolved"])

        with sqlite3.connect(store.DB_PATH) as conn:
            receipts = conn.execute(
                "SELECT operation_id,call_status,calls,total_tokens,output_units,error "
                "FROM model_usage_receipts ORDER BY operation_id"
            ).fetchall()
            outbox = dict(conn.execute(
                "SELECT r.operation_id,o.state FROM model_usage_receipts r "
                "JOIN model_usage_outbox o ON o.receipt_id=r.receipt_id"
            ).fetchall())
            api_events = conn.execute(
                "SELECT api_type,calls,output_units FROM api_usage_events ORDER BY id"
            ).fetchall()
            llm_events = conn.execute(
                "SELECT total_tokens FROM llm_usage_events"
            ).fetchall()
        by_operation = {row[0]: row[1:] for row in receipts}
        self.assertEqual(
            ("succeeded", 1, 0, 0, "ReadTimeout while awaiting provider response"),
            by_operation["main-provider:asset-image-timeout"],
        )
        self.assertEqual(
            (
                "succeeded", 1, 0, 0,
                "HTTPException;status=502;evidence_sha256=" + "a" * 64,
            ),
            by_operation["custom-canvas:generation-timeout"],
        )
        submitted = "video-workshop:project-a:image:submitted"
        self.assertEqual("indeterminate", by_operation[submitted][0])
        self.assertEqual(0, by_operation[submitted][1])
        self.assertEqual("ignored", outbox[submitted])
        self.assertEqual(3, len(api_events))
        self.assertTrue(all(event[1:] == (1, 0) for event in api_events))
        self.assertEqual([(20,)], llm_events)

        project = {
            "id": "project-a",
            "name": "受保护用量双跑",
            "status": "failed",
            "phase": "delivery",
            "progress": 100,
            "updatedAt": "2026-08-09T10:00:00+08:00",
            "plan": {"title": "受保护用量双跑", "aspect_ratio": "9:16"},
            "outputs": [],
            "modelUsageReceipts": [
                self.sidecars["video-workshop:project-a:image:unknown"],
                self.sidecars["video-workshop:project-a:image:submitted"],
            ],
        }
        mapped, error = store.sync_custom_video_project(self.member[0], project)
        self.assertIsNone(error)
        self.assertTrue(mapped)
        project_root = Path(self.temp.name) / "video-projects"
        project_root.mkdir()
        (project_root / "project-a.json").write_text(
            json.dumps(project, ensure_ascii=False), encoding="utf-8",
        )

        before_replay = logical_database_dump(store.DB_PATH)
        replay_summary = main._reconcile_video_workshop_usage_receipts(
            {"id": self.member[0], "teamId": self.team_id}, project,
        )
        self.assertEqual(2, replay_summary["reconciled"])
        self.assertEqual(1, replay_summary["indeterminate"])
        self.assertEqual(0, replay_summary["pending"])
        self.assertEqual(0, replay_summary["conflicts"])
        self.assertEqual(before_replay, logical_database_dump(store.DB_PATH))

        audit = store.video_workshop_usage_readiness(project_root)
        self.assertTrue(audit["ok"], audit)
        self.assertEqual(2, audit["receiptRows"])
        self.assertEqual(2, audit["rawPendingRows"])
        self.assertEqual(2, audit["terminalRows"])
        self.assertEqual(2, audit["settledRows"])
        self.assertEqual(0, audit["effectivePendingRows"])
        self.assertEqual(0, audit["conflictRows"])

        tampered = json.loads(json.dumps(project))
        tampered["modelUsageReceipts"][0]["outputUnits"] = 1
        before_conflict = logical_database_dump(store.DB_PATH)
        conflict = main._reconcile_video_workshop_usage_receipts(
            {"id": self.member[0], "teamId": self.team_id}, tampered,
        )
        self.assertEqual(1, conflict["conflicts"])
        self.assertEqual(1, conflict["pending"])
        self.assertEqual(before_conflict, logical_database_dump(store.DB_PATH))
        (project_root / "project-a.json").write_text(
            json.dumps(tampered, ensure_ascii=False), encoding="utf-8",
        )
        drift = store.video_workshop_usage_readiness(project_root)
        self.assertFalse(drift["ok"])
        self.assertEqual(1, drift["conflictRows"])

        with self.assertRaises(store.ModelUsageReceiptConflict):
            store.complete_model_usage_receipt(
                self.rows[submitted], provider="tencent-maas", model="image-model",
            )

        before = logical_database_dump(store.DB_PATH)
        fresh_snapshot = current_runtime_snapshot_binding(store)
        fresh_snapshot["manifestSha256"] = "d" * 64
        replay = self._apply(plan, plan_sha256, fresh_snapshot)
        self.assertFalse(replay["applied"])
        self.assertTrue(replay["reused"])
        self.assertEqual(0, replay["insertedRows"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

    def test_central_unknown_error_accepts_exact_5xx_status_only(self):
        self.assertTrue(store._model_usage_central_unknown_error_allowed(
            "HTTPException;status=502;evidence_sha256=" + "b" * 64,
        ))
        self.assertTrue(store._model_usage_central_unknown_error_allowed(
            "HTTPException;status=599;evidence_sha256=" + "c" * 64,
        ))
        for error in (
            "HTTPException;status=401;evidence_sha256=" + "d" * 64,
            "HTTPException;evidence_sha256=" + "e" * 64,
            "HTTPException;xstatus=502;evidence_sha256=" + "f" * 64,
            "HTTPException;status=5020;evidence_sha256=" + "0" * 64,
            "provider returned an arbitrary error",
        ):
            with self.subTest(error=error):
                self.assertFalse(
                    store._model_usage_central_unknown_error_allowed(error)
                )

    def test_production_binding_accepts_20_and_rejects_legacy_18(self):
        plan, plan_sha256, current = self._plan()
        self.assertEqual(20, len(current["componentNames"]))
        with patch.dict(
            os.environ,
            {"ACG_RUNTIME_MODE": "production", "ACG_READ_ONLY": "1"},
            clear=False,
        ):
            preview = self._apply(
                plan, plan_sha256, current, dry_run=True,
            )
            self.assertEqual(5, preview["plannedRows"])

            legacy_current_binding = {
                **current,
                "componentNames": sorted(
                    set(current["componentNames"])
                    - {"systemd-main-dropins", "systemd-video-dropins"}
                ),
            }
            with self.assertRaisesRegex(
                store.StoreNotReadyError,
                "production runtime snapshot component set is incomplete",
            ):
                self._apply(
                    plan, plan_sha256, legacy_current_binding, dry_run=True,
                )

    def test_missing_extra_or_changed_hash_fails_closed(self):
        plan, _plan_sha256, snapshot = self._plan()
        missing = {**plan, "entries": plan["entries"][:-1]}
        with self.assertRaisesRegex(store.StoreNotReadyError, "exactly cover"):
            self._apply(
                missing, model_usage_settlement_v2.canonical_sha256(missing), snapshot,
            )

        changed = {**plan, "entries": [dict(entry) for entry in plan["entries"]]}
        changed["entries"][0]["centralReceiptSha256"] = "f" * 64
        before = logical_database_dump(store.DB_PATH)
        with self.assertRaisesRegex(store.StoreNotReadyError, "hash mismatch"):
            self._apply(
                changed, model_usage_settlement_v2.canonical_sha256(changed), snapshot,
            )
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

    def test_review_plan_loader_binds_raw_bytes_and_rejects_source_mismatch(self):
        plan, _plan_sha256, _snapshot = self._plan()
        path = Path(self.temp.name) / "usage-plan-v2.json"
        raw = (json.dumps(
            plan, ensure_ascii=False, sort_keys=True, indent=2,
        ) + "\n").encode("utf-8")
        path.write_bytes(raw)
        loaded, digest = model_usage_settlement_v2.load_review_plan(
            path, expected_sha256=hashlib.sha256(raw).hexdigest(),
        )
        self.assertEqual(plan, loaded)
        self.assertEqual(hashlib.sha256(raw).hexdigest(), digest)

        invalid = {**plan, "entries": [dict(item) for item in plan["entries"]]}
        sidecar = next(
            item for item in invalid["entries"]
            if item["source"] == model_usage_settlement_v2.SIDECAR_SOURCE
        )
        sidecar["source"] = "main-provider"
        invalid_raw = (json.dumps(
            invalid, ensure_ascii=False, sort_keys=True, indent=2,
        ) + "\n").encode("utf-8")
        path.write_bytes(invalid_raw)
        with self.assertRaisesRegex(
            model_usage_settlement_v2.SettlementPlanV2Error,
            "central_source|sidecar_source",
        ):
            model_usage_settlement_v2.load_review_plan(
                path, expected_sha256=hashlib.sha256(invalid_raw).hexdigest(),
            )


class VideoWorkshopUsageRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_path = store.DB_PATH
        self.previous_blob_dir = store.CUSTOM_CANVAS_BLOB_DIR
        self.previous_initialized = store._initialized
        store.DB_PATH = Path(self.temp.name) / "video-usage-recovery.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = Path(self.temp.name) / "canvas-blobs"
        store._initialized = False
        self.project_root = Path(self.temp.name) / "video-projects"
        self.project_root.mkdir()
        self.member = store.add_member(
            "视频恢复测试", "video-usage-recovery-editor", "123456", "editor",
            team_id=store.INTERNAL_TEAM_ID, team_role="creator",
        )
        self.operation_id = "video-workshop:recovery-project:video:confirmed"
        immutable = {
            "schemaVersion": 1,
            "surface": "video-workshop",
            "projectId": "recovery-project",
            "operationId": self.operation_id,
            "usageKind": "video",
            "feature": "动态分镜视频生成",
            "provider": "seedance",
            "model": "seedance-2.0",
            "unitLabel": "秒",
        }
        self.sidecar = {
            **immutable,
            "providerRef": "provider-recovery-confirmed-1",
            "status": "confirmed",
            "inputTokens": 0,
            "outputTokens": 0,
            "totalTokens": 0,
            "usageObserved": True,
            "outputUnits": 8,
            "occurredAt": "2026-08-09T13:00:00+08:00",
            "reconcileState": "pending",
        }
        self.project = {
            "id": "recovery-project",
            "name": "视频用量恢复",
            "status": "succeeded",
            "phase": "delivery",
            "progress": 100,
            "updatedAt": "2026-08-09T13:00:00+08:00",
            "plan": {"title": "视频用量恢复", "aspect_ratio": "9:16"},
            "outputs": [],
            "modelUsageReceipts": [self.sidecar],
        }
        mapped, error = store.sync_custom_video_project(
            self.member[0], self.project,
        )
        self.assertIsNone(error)
        self.assertTrue(mapped)
        (self.project_root / "recovery-project.json").write_text(
            json.dumps(self.project, ensure_ascii=False), encoding="utf-8",
        )

    def tearDown(self):
        store.DB_PATH = self.previous_path
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous_blob_dir
        store._initialized = self.previous_initialized
        self.temp.cleanup()

    def _evidence(self):
        snapshot = current_runtime_snapshot_binding(store)
        evidence = store.video_workshop_usage_recovery_evidence(
            self.project_root,
            expected_identity=store._database_identity(store.DB_PATH),
            expected_schema_version=(
                store.MODEL_USAGE_SETTLEMENT_V2_SCHEMA_MIGRATION_VERSION
            ),
            backup_binding=current_backup_binding(store, store.DB_PATH),
            runtime_snapshot_binding=snapshot,
        )
        return evidence, snapshot

    def _plan(self):
        evidence, snapshot = self._evidence()
        plan = {
            "format": evidence["format"],
            "authorization": evidence["authorization"],
            "databaseIdentity": evidence["databaseIdentity"],
            "snapshotManifestSha256": evidence["snapshotManifestSha256"],
            "snapshotMediaInventoryDigest": evidence[
                "snapshotMediaInventoryDigest"
            ],
            "reviewedBy": "test-operator",
            "reviewedAt": int(time.time() * 1000),
            "entries": evidence["entries"],
        }
        return plan, store._canonical_json_sha256(plan), snapshot

    def _apply(self, plan, plan_sha256, snapshot, *, dry_run=False):
        environment = {
            "ACG_ALLOW_VIDEO_WORKSHOP_USAGE_RECOVERY": "1",
            "ACG_READ_ONLY": "0",
        }
        with patch.dict(os.environ, environment, clear=False):
            return store.recover_video_workshop_usage_reviewed(
                plan=plan,
                plan_sha256=plan_sha256,
                sidecar_receipts={self.operation_id: self.sidecar},
                project_root=self.project_root,
                expected_identity=store._database_identity(store.DB_PATH),
                expected_schema_version=(
                    store.MODEL_USAGE_SETTLEMENT_V2_SCHEMA_MIGRATION_VERSION
                ),
                backup_binding=current_backup_binding(store, store.DB_PATH),
                runtime_snapshot_binding=snapshot,
                created_by="test-operator",
                dry_run=dry_run,
            )

    def test_exact_missing_central_completion_imports_and_replays_zero_write(self):
        plan, plan_sha256, snapshot = self._plan()
        self.assertEqual(1, len(plan["entries"]))
        preview = self._apply(plan, plan_sha256, snapshot, dry_run=True)
        self.assertEqual(1, preview["plannedRows"])
        self.assertEqual(0, preview["insertedRows"])

        first = self._apply(plan, plan_sha256, snapshot)
        self.assertTrue(first["applied"])
        self.assertEqual(1, first["insertedRows"])
        with sqlite3.connect(store.DB_PATH) as conn:
            receipt = conn.execute(
                "SELECT call_status,calls,output_units,unit_label,provider_ref "
                "FROM model_usage_receipts WHERE operation_id=?",
                (self.operation_id,),
            ).fetchone()
            outbox = conn.execute(
                "SELECT state FROM model_usage_outbox o JOIN model_usage_receipts r "
                "ON r.receipt_id=o.receipt_id WHERE r.operation_id=?",
                (self.operation_id,),
            ).fetchone()[0]
            event = conn.execute(
                "SELECT api_type,calls,output_units,unit_label FROM api_usage_events"
            ).fetchone()
        self.assertEqual(
            ("succeeded", 1, 8, "秒", "provider-recovery-confirmed-1"), receipt,
        )
        self.assertEqual("projected", outbox)
        self.assertEqual(("video", 1, 8, "秒"), event)
        audit = store.video_workshop_usage_readiness(self.project_root)
        self.assertTrue(audit["ok"], audit)
        self.assertEqual(1, audit["terminalRows"])

        before = logical_database_dump(store.DB_PATH)
        second = self._apply(plan, plan_sha256, snapshot)
        self.assertFalse(second["applied"])
        self.assertTrue(second["reused"])
        self.assertEqual(0, second["insertedRows"])
        self.assertEqual(before, logical_database_dump(store.DB_PATH))

        tampered = dict(self.sidecar)
        tampered["providerRef"] = "provider-recovery-tampered"
        before_tamper = logical_database_dump(store.DB_PATH)
        with self.assertRaisesRegex(
            store.StoreNotReadyError, "replay drift",
        ):
            with patch.dict(
                os.environ,
                {
                    "ACG_ALLOW_VIDEO_WORKSHOP_USAGE_RECOVERY": "1",
                    "ACG_READ_ONLY": "0",
                },
                clear=False,
            ):
                store.recover_video_workshop_usage_reviewed(
                    plan=plan,
                    plan_sha256=plan_sha256,
                    sidecar_receipts={self.operation_id: tampered},
                    project_root=self.project_root,
                    expected_identity=store._database_identity(store.DB_PATH),
                    expected_schema_version=(
                        store.MODEL_USAGE_SETTLEMENT_V2_SCHEMA_MIGRATION_VERSION
                    ),
                    backup_binding=current_backup_binding(store, store.DB_PATH),
                    runtime_snapshot_binding=snapshot,
                )
        self.assertEqual(before_tamper, logical_database_dump(store.DB_PATH))


if __name__ == "__main__":
    unittest.main()
