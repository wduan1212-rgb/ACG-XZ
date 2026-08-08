"""Fail-closed production recovery and post-migration settlement tools.

These entrypoints never replay 140002/140004.  Every apply is bound to the
current database identity, a fresh SQLite backup and a verified complete
runtime snapshot.  Reviewed plans contain exact targets and are immutable by
their byte SHA-256; no operation calls a provider or deletes a business
reference.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import sqlite3
import stat
import time
from pathlib import Path

from . import config as runtime_config
from . import store
from .scripts import runtime_snapshot


RESOURCE_SETTLEMENT_KIND = "resource-scope-incremental"
TENANT_SETTLEMENT_KIND = "tenant-adoption"
CANVAS_RECOVERY_KIND = "canvas-blob-recovery"
ADJUDICATION_KIND = "incident-adjudication"
CANVAS_RECOVERY_PLAN_FORMAT = "acg-canvas-blob-recovery-plan-v1"
INCIDENT_ADJUDICATION_PLAN_FORMAT = "acg-production-incident-adjudication-plan-v1"
MAX_PLAN_BYTES = 2 * 1024 * 1024
MAX_PLAN_ENTRIES = 10_000
HISTORICAL_COMPLETE_COMPONENTS_V140 = frozenset(
    set(runtime_snapshot.PRODUCTION_COMPLETE_COMPONENTS)
    - {"systemd-main-dropins", "systemd-video-dropins"}
)


class ProductionRecoveryError(ValueError):
    pass


def canonical_sha256(value) -> str:
    return hashlib.sha256(json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")).hexdigest()


def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ProductionRecoveryError(f"duplicate_plan_key:{key}")
        result[key] = value
    return result


def load_review_plan(path, *, expected_sha256: str, expected_format: str):
    plan_path = Path(path)
    expected = str(expected_sha256 or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ProductionRecoveryError("review_plan_sha256_invalid")
    try:
        size = plan_path.stat().st_size
        raw = plan_path.read_bytes()
    except OSError as exc:
        raise ProductionRecoveryError("review_plan_unavailable") from exc
    if size <= 0 or size > MAX_PLAN_BYTES:
        raise ProductionRecoveryError("review_plan_size_invalid")
    actual = hashlib.sha256(raw).hexdigest()
    if not hmac.compare_digest(actual, expected):
        raise ProductionRecoveryError("review_plan_sha256_mismatch")
    try:
        payload = json.loads(raw.decode("utf-8"), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError, ProductionRecoveryError) as exc:
        raise ProductionRecoveryError("review_plan_json_invalid") from exc
    if not isinstance(payload, dict) or payload.get("format") != expected_format:
        raise ProductionRecoveryError("review_plan_format_invalid")
    return payload, actual


def _require_runtime_binding(binding):
    return store._verify_runtime_snapshot_binding(binding, required=True)


def _require_operator_review(plan, prefix):
    reviewed_by = str(plan.get("reviewedBy") or "").strip()
    reviewed_at = plan.get("reviewedAt")
    if (
        not reviewed_by
        or len(reviewed_by) > 120
        or type(reviewed_at) is not int
        or reviewed_at <= 0
        or reviewed_at > int(time.time() * 1000) + 5 * 60 * 1000
    ):
        raise ProductionRecoveryError(f"{prefix}_operator_review_invalid")


def _require_locked_state(conn, *, expected_identity, expected_schema_version,
                          backup_binding, runtime_snapshot_binding):
    actual_identity = store._database_identity(store.DB_PATH)
    if not hmac.compare_digest(str(expected_identity or ""), actual_identity):
        raise store.StoreNotReadyError("recovery database identity mismatch")
    if int(expected_schema_version or 0) != store.LATEST_SCHEMA_MIGRATION_VERSION:
        raise store.StoreNotReadyError("recovery schema confirmation mismatch")
    snapshot = _require_runtime_binding(runtime_snapshot_binding)
    store._verify_migration_backup_binding_locked(conn, backup_binding)
    if str(conn.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
        raise store.StoreNotReadyError("recovery target failed SQLite quick_check")
    required_migrations = (
        (store.RESOURCE_SCOPE_DATA_MIGRATION_VERSION,
         store.RESOURCE_SCOPE_DATA_MIGRATION_CHECKSUM),
        (store.PRIVATE_MEDIA_DATA_MIGRATION_VERSION,
         store.PRIVATE_MEDIA_DATA_MIGRATION_CHECKSUM),
        (store.PRODUCTION_RECOVERY_SCHEMA_MIGRATION_VERSION,
         store.PRODUCTION_RECOVERY_SCHEMA_MIGRATION_CHECKSUM),
    )
    for version, checksum in required_migrations:
        row = conn.execute(
            "SELECT checksum,status FROM schema_migrations WHERE version=?",
            (version,),
        ).fetchone()
        if row != (checksum, "success"):
            raise store.StoreNotReadyError(
                f"recovery prerequisite {version} is not ready"
            )
    return actual_identity, snapshot


def _resource_incremental_plan_locked(conn):
    missing = conn.execute(
        "SELECT d.collection,d.id,d.owner_id,d.data FROM docs d "
        "LEFT JOIN resource_scopes s ON s.resource_kind=('doc:' || d.collection) "
        "AND s.resource_id=d.id WHERE s.resource_id IS NULL "
        "ORDER BY d.collection,d.id"
    ).fetchall()
    issues = []
    rows = []
    absent_source_projects = 0
    for collection, resource_id, owner_id, raw in missing:
        collection = str(collection)
        resource_id = str(resource_id)
        owner = str(owner_id or "")
        if collection != store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION:
            issues.append("unexpected_missing_resource_collection")
            continue
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            issues.append("canvas_job_payload_invalid")
            continue
        if not isinstance(payload, dict) or str(payload.get("id") or "") != resource_id:
            issues.append("canvas_job_identity_invalid")
            continue
        if not owner or str(payload.get("ownerId") or "") != owner:
            issues.append("canvas_job_owner_invalid")
            continue
        actor_scope = store._member_resource_scope_locked(conn, owner)
        if not actor_scope:
            issues.append("canvas_job_owner_scope_missing")
            continue
        project_id = str(payload.get("sourceProjectId") or "").strip()
        provenance = "v140008-canvas-job-incremental"
        if project_id:
            project_row = conn.execute(
                "SELECT owner_id,data FROM docs "
                "WHERE collection='customProjects' AND id=?",
                (project_id,),
            ).fetchone()
            project_scope = store._resource_scope_row_locked(
                conn, "customProjects", project_id,
            )
            if not project_row:
                if project_scope:
                    issues.append("canvas_job_absent_project_scope_conflict")
                    continue
                absent_source_projects += 1
                provenance = (
                    "v140008-canvas-job-incremental-"
                    "historical-source-project-absent"
                )
            else:
                project_owner = str(project_row[0] or "")
                try:
                    project_payload = json.loads(project_row[1])
                except (TypeError, json.JSONDecodeError):
                    issues.append("canvas_job_project_payload_invalid")
                    continue
                if (
                    not isinstance(project_payload, dict)
                    or str(project_payload.get("id") or "") != project_id
                ):
                    issues.append("canvas_job_project_identity_invalid")
                    continue
                if (
                    project_owner != owner
                    or str(project_payload.get("ownerId") or "") != owner
                ):
                    issues.append("canvas_job_project_owner_invalid")
                    continue
            if project_row:
                if not project_scope:
                    issues.append("canvas_job_project_scope_missing")
                    continue
                if str(project_scope[2] or "") != owner:
                    issues.append("canvas_job_project_scope_owner_conflict")
                    continue
                if (str(project_scope[0]), str(project_scope[1])) != actor_scope[:2]:
                    issues.append("canvas_job_project_scope_conflict")
                    continue
        rows.append({
            "resourceKind": store._doc_resource_kind(collection),
            "resourceId": resource_id,
            "scopeType": actor_scope[0],
            "scopeId": actor_scope[1],
            "ownerId": owner,
            "provenance": provenance,
        })
    invalid_targets = int(conn.execute(
        "SELECT COUNT(*) FROM resource_scopes s "
        "LEFT JOIN teams t ON s.scope_type='team' AND t.id=s.scope_id "
        "LEFT JOIN members m ON s.scope_type='member' AND m.id=s.scope_id "
        "WHERE (s.scope_type='team' AND (t.id IS NULL OR t.status<>'active')) "
        "OR (s.scope_type='member' AND (m.id IS NULL OR m.role<>'user'))"
    ).fetchone()[0] or 0)
    if invalid_targets:
        issues.append("tenant_adoption_required_first")
    return {
        "ok": not issues,
        "issues": sorted(set(issues)),
        "missingRows": len(missing),
        "plannedRows": len(rows),
        "historicalSourceProjectsAbsent": absent_source_projects,
        "invalidTargets": invalid_targets,
        "rows": rows,
    }


def settle_resource_scopes_incremental(*, expected_identity,
                                       expected_schema_version,
                                       backup_binding,
                                       runtime_snapshot_binding,
                                       created_by="deployment",
                                       dry_run=False):
    if not dry_run:
        if runtime_config.is_read_only():
            raise store.StoreNotReadyError("read-only runtime cannot settle resources")
        if str(os.getenv("ACG_ALLOW_PRODUCTION_RECOVERY", "")).strip() != "1":
            raise store.StoreNotReadyError("production recovery authorization is required")
    conn = store._connect_migration_target() if not dry_run else store._connect(read_only=True)
    try:
        conn.execute("BEGIN IMMEDIATE" if not dry_run else "BEGIN")
        actual_identity, snapshot = _require_locked_state(
            conn,
            expected_identity=expected_identity,
            expected_schema_version=expected_schema_version,
            backup_binding=backup_binding,
            runtime_snapshot_binding=runtime_snapshot_binding,
        )
        plan = _resource_incremental_plan_locked(conn)
        if not plan["ok"]:
            raise store.StoreNotReadyError(
                "resource incremental settlement failed: " + ",".join(plan["issues"])
            )
        if dry_run:
            conn.rollback()
            return {**{k: v for k, v in plan.items() if k != "rows"},
                    "dryRun": True, "databaseIdentity": actual_identity,
                    "snapshotManifestSha256": snapshot["manifestSha256"],
                    "snapshotMediaInventoryDigest": snapshot["mediaInventoryDigest"]}
        if not plan["rows"]:
            previous = conn.execute(
                "SELECT settlement_id,planned_rows,applied_rows FROM "
                "production_recovery_settlements WHERE settlement_kind=? "
                "ORDER BY created_at DESC LIMIT 1",
                (RESOURCE_SETTLEMENT_KIND,),
            ).fetchone()
            conn.rollback()
            return {
                "ok": True, "applied": False, "insertedRows": 0,
                "plannedRows": int(previous[1]) if previous else 0,
                "settlementId": str(previous[0]) if previous else "",
            }
        plan_sha = canonical_sha256(plan["rows"])
        settlement_id = hashlib.sha256(
            f"{RESOURCE_SETTLEMENT_KIND}:{actual_identity}:{plan_sha}".encode("utf-8")
        ).hexdigest()
        if conn.execute(
            "SELECT 1 FROM production_recovery_settlements WHERE settlement_id=?",
            (settlement_id,),
        ).fetchone():
            conn.rollback()
            return {"ok": True, "applied": False, "insertedRows": 0,
                    "plannedRows": len(plan["rows"]), "settlementId": settlement_id}
        now = int(time.time() * 1000)
        conn.executemany(
            "INSERT INTO resource_scopes(resource_kind,resource_id,scope_type,"
            "scope_id,owner_id,provenance,captured_at,updated_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            [
                (row["resourceKind"], row["resourceId"], row["scopeType"],
                 row["scopeId"], row["ownerId"], row["provenance"], now, now)
                for row in plan["rows"]
            ],
        )
        verification = _resource_incremental_plan_locked(conn)
        if not verification["ok"] or verification["missingRows"]:
            raise store.StoreNotReadyError("resource incremental verification failed")
        conn.execute(
            "INSERT INTO production_recovery_settlements("
            "settlement_id,settlement_kind,plan_sha256,database_identity,"
            "snapshot_manifest_sha256,snapshot_media_digest,planned_rows,"
            "applied_rows,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (settlement_id, RESOURCE_SETTLEMENT_KIND, plan_sha, actual_identity,
             snapshot["manifestSha256"], snapshot["mediaInventoryDigest"],
             len(plan["rows"]), len(plan["rows"]), now,
             str(created_by or "deployment")[:120]),
        )
        conn.executemany(
            "INSERT INTO production_recovery_entries("
            "settlement_id,entry_kind,target_kind,target_id,owner_id,before_value,"
            "after_value,evidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [
                (settlement_id, "resource-scope-insert", row["resourceKind"],
                 row["resourceId"], row["ownerId"], "",
                 f"{row['scopeType']}:{row['scopeId']}", row["provenance"], now)
                for row in plan["rows"]
            ],
        )
        conn.commit()
        store._initialized = False
        return {"ok": True, "applied": True, "insertedRows": len(plan["rows"]),
                "plannedRows": len(plan["rows"]), "settlementId": settlement_id}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _tenant_adoption_plan_locked(conn):
    candidate_members = sorted({
        str(row[0]) for row in conn.execute(
            "SELECT DISTINCT m.id FROM members m "
            "JOIN team_members tm ON tm.member_id=m.id AND tm.status='active' "
            "JOIN teams t ON t.id=tm.team_id AND t.status='active' "
            "LEFT JOIN resource_scopes rs ON rs.scope_type='member' AND rs.scope_id=m.id "
            "LEFT JOIN private_media_registry pm ON pm.owner_id=m.id AND pm.team_id='' "
            "WHERE m.role IN ('user','editor') AND (rs.resource_id IS NOT NULL OR pm.media_key IS NOT NULL)"
        ).fetchall()
    })
    members = []
    issues = []
    for member_id in candidate_members:
        teams = sorted({str(row[0]) for row in conn.execute(
            "SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id=tm.team_id "
            "WHERE tm.member_id=? AND tm.status='active' AND t.status='active'",
            (member_id,),
        ).fetchall()})
        if len(teams) != 1:
            issues.append("tenant_adoption_team_ambiguous")
            continue
        try:
            item = store._personal_tenant_adoption_plan_locked(
                conn, member_id, teams[0],
            )
        except store.StoreNotReadyError as exc:
            issues.append(str(exc))
            continue
        if item["personalScopes"] or item["personalMedia"]:
            members.append(item)
    media_plan = store._private_media_plan_locked(
        conn, include_issue_identities=True,
    )
    expected_conflicts = {
        (row["mediaKind"], row["mediaKey"], row["ownerId"], row["plannedTeamId"])
        for item in members for row in [
            {"mediaKind": kind, "mediaKey": key, "ownerId": item["memberId"],
             "plannedTeamId": item["teamId"]}
            for kind, key in item["personalMedia"]
        ]
    }
    actual_conflicts = {
        (row["mediaKind"], row["mediaKey"], row["ownerId"], row["plannedTeamId"])
        for row in (media_plan.get("_issueIdentities") or {}).get("registryConflicts") or []
    }
    if actual_conflicts - expected_conflicts:
        issues.append("unresolved_private_media_registry_conflict")
    planned_rows = sum(
        len(item["personalScopes"]) + len(item["personalMedia"])
        for item in members
    )
    return {"ok": not issues, "issues": sorted(set(issues)),
            "members": members, "plannedMembers": len(members),
            "plannedRows": planned_rows,
            "registryConflicts": len(actual_conflicts)}


def settle_tenant_adoptions(*, expected_identity, expected_schema_version,
                            backup_binding, runtime_snapshot_binding,
                            created_by="deployment", dry_run=False):
    if not dry_run:
        if runtime_config.is_read_only():
            raise store.StoreNotReadyError("read-only runtime cannot settle tenants")
        if str(os.getenv("ACG_ALLOW_PRODUCTION_RECOVERY", "")).strip() != "1":
            raise store.StoreNotReadyError("production recovery authorization is required")
    conn = store._connect_migration_target() if not dry_run else store._connect(read_only=True)
    try:
        conn.execute("BEGIN IMMEDIATE" if not dry_run else "BEGIN")
        actual_identity, snapshot = _require_locked_state(
            conn, expected_identity=expected_identity,
            expected_schema_version=expected_schema_version,
            backup_binding=backup_binding,
            runtime_snapshot_binding=runtime_snapshot_binding,
        )
        plan = _tenant_adoption_plan_locked(conn)
        if not plan["ok"]:
            raise store.StoreNotReadyError(
                "tenant adoption settlement failed: " + ",".join(plan["issues"])
            )
        if dry_run:
            conn.rollback()
            return {k: v for k, v in plan.items() if k != "members"} | {
                "dryRun": True, "databaseIdentity": actual_identity,
                "snapshotManifestSha256": snapshot["manifestSha256"],
                "snapshotMediaInventoryDigest": snapshot["mediaInventoryDigest"],
            }
        if not plan["members"]:
            conn.rollback()
            return {"ok": True, "applied": False, "appliedRows": 0,
                    "plannedRows": 0, "plannedMembers": 0}
        applied = 0
        settlement_ids = []
        now = int(time.time() * 1000)
        for item in plan["members"]:
            result = store._apply_personal_tenant_adoption_locked(
                conn, item["memberId"], item["teamId"], created_by=created_by,
                now=now, snapshot_manifest_sha256=snapshot["manifestSha256"],
                snapshot_media_digest=snapshot["mediaInventoryDigest"],
            )
            applied += int(result["appliedRows"])
            settlement_ids.append(result["settlementId"])
        verification = _tenant_adoption_plan_locked(conn)
        if not verification["ok"] or verification["plannedRows"]:
            raise store.StoreNotReadyError("tenant adoption verification failed")
        conn.commit()
        store._initialized = False
        return {"ok": True, "applied": bool(applied), "appliedRows": applied,
                "plannedRows": plan["plannedRows"],
                "plannedMembers": plan["plannedMembers"],
                "settlementIds": settlement_ids}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _safe_relative(root: Path, relative: str, *, regular=True) -> Path:
    rel = Path(str(relative or ""))
    if rel.is_absolute() or ".." in rel.parts or not rel.parts:
        raise ProductionRecoveryError("evidence_relative_path_invalid")
    base = root.resolve()
    unresolved = base / rel
    cursor = base
    for part in rel.parts:
        cursor = cursor / part
        try:
            info = cursor.lstat()
        except OSError as exc:
            raise ProductionRecoveryError("evidence_file_unavailable") from exc
        if stat.S_ISLNK(info.st_mode):
            raise ProductionRecoveryError("evidence_symlink_rejected")
    target = unresolved.resolve(strict=True)
    try:
        target.relative_to(base)
    except ValueError as exc:
        raise ProductionRecoveryError("evidence_path_escape") from exc
    if regular and not target.is_file():
        raise ProductionRecoveryError("evidence_file_invalid")
    return target


def _verify_historical_media_snapshot(snapshot_root, expected_sha256,
                                      *, component_count, media_digest):
    """Verify only immutable media evidence from an older complete snapshot.

    Old complete profiles predate the current systemd drop-in components and
    therefore cannot satisfy the *current* rollback contract.  Recovery only
    opens the manifest plus the ``database`` and ``canvas-blobs`` artifacts;
    environment, systemd and secret-bearing artifacts are never read.
    """

    root = Path(snapshot_root).resolve(strict=True)
    manifest_path = _safe_relative(root, "snapshot.manifest.json")
    digest_path = _safe_relative(root, "snapshot.manifest.sha256")
    raw = manifest_path.read_bytes()
    actual_sha = hashlib.sha256(raw).hexdigest()
    expected = str(expected_sha256 or "").strip().lower()
    if (
        not re.fullmatch(r"[0-9a-f]{64}", expected)
        or not hmac.compare_digest(actual_sha, expected)
        or not hmac.compare_digest(digest_path.read_text("ascii").strip().lower(), expected)
    ):
        raise ProductionRecoveryError("historical_snapshot_manifest_sha256_mismatch")
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProductionRecoveryError("historical_snapshot_manifest_invalid") from exc
    components = manifest.get("components") if isinstance(manifest, dict) else None
    if (
        manifest.get("format") != runtime_snapshot.SNAPSHOT_FORMAT
        or manifest.get("profile") != runtime_snapshot.PRODUCTION_COMPLETE_PROFILE
        or not isinstance(components, list)
        or len(components) != int(component_count or 0)
    ):
        raise ProductionRecoveryError("historical_snapshot_contract_invalid")
    names = [str(item.get("name") or "") for item in components if isinstance(item, dict)]
    if (
        len(names) != len(components)
        or len(names) != len(set(names))
        or set(names) != HISTORICAL_COMPLETE_COMPONENTS_V140
    ):
        raise ProductionRecoveryError("historical_snapshot_components_invalid")
    by_name = {str(item.get("name") or ""): item for item in components}
    if set(("database", "canvas-blobs")) - set(by_name):
        raise ProductionRecoveryError("historical_snapshot_media_components_missing")
    for name in HISTORICAL_COMPLETE_COMPONENTS_V140:
        expected_type, required, _path, _outside, _dereference = (
            runtime_snapshot.PRODUCTION_COMPLETE_COMPONENTS[name]
        )
        item = by_name[name]
        if str(item.get("type") or "") != expected_type:
            raise ProductionRecoveryError(
                f"historical_snapshot_component_type_invalid:{name}"
            )
        if required and item.get("state") == "absent":
            raise ProductionRecoveryError(
                f"historical_snapshot_required_component_absent:{name}"
            )
    computed_media_digest = runtime_snapshot._media_inventory_digest_from_components(
        components
    )
    expected_media_digest = str(media_digest or "").strip().lower()
    if (
        not re.fullmatch(r"[0-9a-f]{64}", expected_media_digest)
        or not hmac.compare_digest(computed_media_digest, expected_media_digest)
    ):
        raise ProductionRecoveryError("historical_snapshot_media_digest_mismatch")
    for name in ("database", "canvas-blobs"):
        item = by_name[name]
        if item.get("state") == "absent":
            raise ProductionRecoveryError(
                f"historical_snapshot_component_absent:{name}"
            )
        artifact_name = runtime_snapshot._safe_member_name(
            str(item.get("artifact") or "")
        )
        artifact = _safe_relative(root, artifact_name)
        if (
            artifact.stat().st_size != int(item.get("artifactBytes") or -1)
            or runtime_snapshot._sha256(artifact) != item.get("artifactSha256")
        ):
            raise ProductionRecoveryError(
                f"historical_snapshot_artifact_mismatch:{name}"
            )
        if name == "canvas-blobs":
            if item.get("type") != "directory":
                raise ProductionRecoveryError("historical_canvas_component_invalid")
            runtime_snapshot._verify_archive(artifact, item.get("files") or [])
        else:
            if item.get("type") != "sqlite":
                raise ProductionRecoveryError("historical_database_component_invalid")
            db_manifest_name = runtime_snapshot._safe_member_name(
                str(item.get("databaseManifest") or "")
            )
            db_manifest = _safe_relative(root, db_manifest_name)
            if runtime_snapshot._sha256(db_manifest) != item.get(
                "databaseManifestSha256"
            ):
                raise ProductionRecoveryError(
                    "historical_database_manifest_mismatch"
                )
            uri = "file:" + artifact.as_posix() + "?mode=ro&immutable=1"
            with sqlite3.connect(uri, uri=True) as conn:
                if str(conn.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
                    raise ProductionRecoveryError(
                        "historical_snapshot_database_corrupt"
                    )
    return {
        "manifestSha256": actual_sha,
        "mediaInventoryDigest": computed_media_digest,
        "componentCount": len(components),
        "componentNames": sorted(names),
        "releaseId": str(manifest.get("releaseId") or ""),
        "evidenceComponents": {
            "database": {
                "artifactSha256": str(by_name["database"].get("artifactSha256") or ""),
            },
            "canvas-blobs": {
                "files": {
                    str(item.get("path") or ""): {
                        "bytes": int(item.get("bytes") or 0),
                        "sha256": str(item.get("sha256") or ""),
                    }
                    for item in (by_name["canvas-blobs"].get("files") or [])
                    if isinstance(item, dict)
                },
            },
        },
    }


def _verify_evidence_sets(raw_sets):
    if not isinstance(raw_sets, list) or not raw_sets or len(raw_sets) > 500:
        raise ProductionRecoveryError("evidence_sets_invalid")
    result = {}
    required = {
        "id", "snapshotRoot", "snapshotManifestSha256",
        "restoreRoot", "restoreReportSha256", "mode",
        "verifiedByRelease", "verifiedComponentCount",
        "verifiedMediaInventoryDigest",
    }
    for raw in raw_sets:
        if not isinstance(raw, dict) or set(raw) != required:
            raise ProductionRecoveryError("evidence_set_fields_invalid")
        evidence_id = str(raw.get("id") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", evidence_id) or evidence_id in result:
            raise ProductionRecoveryError("evidence_set_id_invalid")
        snapshot_root = Path(str(raw.get("snapshotRoot") or ""))
        snapshot_sha = str(raw.get("snapshotManifestSha256") or "").lower()
        if raw.get("mode") != "historical-media-evidence-v1":
            raise ProductionRecoveryError("evidence_set_mode_invalid")
        verifier_release = str(raw.get("verifiedByRelease") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9._-]{7,120}", verifier_release):
            raise ProductionRecoveryError("evidence_set_verifier_release_invalid")
        verified = _verify_historical_media_snapshot(
            snapshot_root,
            snapshot_sha,
            component_count=raw.get("verifiedComponentCount"),
            media_digest=raw.get("verifiedMediaInventoryDigest"),
        )
        restore_root = Path(str(raw.get("restoreRoot") or "")).resolve(strict=True)
        report_path = _safe_relative(restore_root, "restore.report.json")
        report_raw = report_path.read_bytes()
        report_sha = hashlib.sha256(report_raw).hexdigest()
        expected_report = str(raw.get("restoreReportSha256") or "").lower()
        if not re.fullmatch(r"[0-9a-f]{64}", expected_report) or not hmac.compare_digest(
            report_sha, expected_report,
        ):
            raise ProductionRecoveryError("evidence_restore_report_sha256_mismatch")
        digest_file = _safe_relative(restore_root, "restore.report.sha256")
        if not hmac.compare_digest(digest_file.read_text("ascii").strip().lower(), report_sha):
            raise ProductionRecoveryError("evidence_restore_report_sidecar_mismatch")
        report = json.loads(report_raw.decode("utf-8"))
        if (
            report.get("format") != runtime_snapshot.RESTORE_FORMAT
            or not report.get("ok")
            or not hmac.compare_digest(
                str(report.get("snapshotManifestSha256") or "").lower(),
                str(verified.get("manifestSha256") or "").lower(),
            )
        ):
            raise ProductionRecoveryError("evidence_restore_report_invalid")
        restored_names = {
            str(item.get("name") or "")
            for item in (report.get("components") or [])
            if isinstance(item, dict)
        }
        if restored_names != HISTORICAL_COMPLETE_COMPONENTS_V140:
            raise ProductionRecoveryError("evidence_restore_media_components_missing")
        restored_database = _safe_relative(restore_root, "database")
        if not hmac.compare_digest(
            runtime_snapshot._sha256(restored_database),
            verified["evidenceComponents"]["database"]["artifactSha256"],
        ):
            raise ProductionRecoveryError("evidence_restore_database_mismatch")
        result[evidence_id] = {
            "snapshotRoot": snapshot_root, "snapshot": verified,
            "restoreRoot": restore_root, "restoreReportSha256": report_sha,
            "verifiedByRelease": verifier_release,
        }
    return result


def _contains_canvas_key(value, media_key):
    if isinstance(value, str):
        return value.strip() == f"/api/custom-canvas/blobs/{media_key}"
    if isinstance(value, list):
        return any(_contains_canvas_key(item, media_key) for item in value)
    if isinstance(value, dict):
        if value.get("$type") == store.CUSTOM_CANVAS_BLOB_REF_TYPE:
            return str(value.get("contentHash") or "") == media_key
        return any(_contains_canvas_key(item, media_key) for item in value.values())
    return False


def _current_canvas_references_locked(conn, media_key):
    matches = []
    for collection, resource_id, owner_id, raw in conn.execute(
        "SELECT collection,id,owner_id,data FROM docs WHERE data LIKE ? "
        "ORDER BY collection,id", (f"%{media_key}%",),
    ).fetchall():
        try:
            payload = json.loads(raw)
        except (TypeError, json.JSONDecodeError) as exc:
            raise ProductionRecoveryError(
                "current_canvas_reference_payload_invalid"
            ) from exc
        if not _contains_canvas_key(payload, media_key):
            continue
        owner = str(owner_id or payload.get("ownerId") or payload.get("byMemberId") or "")
        scope = store._resource_scope_row_locked(conn, str(collection), str(resource_id))
        if not owner or not scope:
            raise ProductionRecoveryError("current_canvas_reference_scope_missing")
        owner_scope = store._member_resource_scope_locked(conn, owner)
        if not owner_scope or owner_scope[:2] != (str(scope[0]), str(scope[1])):
            raise ProductionRecoveryError("current_canvas_reference_scope_conflict")
        matches.append({
            "resourceKind": store._doc_resource_kind(collection),
            "resourceId": str(resource_id), "ownerId": owner,
        })
    for post_id, author_id, team_id, raw_media, raw_cover in conn.execute(
        "SELECT id,author_id,team_id,media_json,cover_json FROM community_posts "
        "WHERE status='published' AND (media_json LIKE ? OR cover_json LIKE ?) "
        "ORDER BY id",
        (f"%{media_key}%", f"%{media_key}%"),
    ).fetchall():
        try:
            media = json.loads(raw_media or "[]")
            cover = json.loads(raw_cover or "null")
        except (TypeError, json.JSONDecodeError) as exc:
            raise ProductionRecoveryError(
                "current_community_reference_payload_invalid"
            ) from exc
        if not (_contains_canvas_key(media, media_key) or _contains_canvas_key(cover, media_key)):
            continue
        owner = str(author_id or "")
        owner_scope = store._member_resource_scope_locked(conn, owner)
        if not owner_scope:
            raise ProductionRecoveryError("current_community_reference_scope_missing")
        stored_team = str(team_id or "")
        if (
            (owner_scope[0] == "team" and stored_team != owner_scope[1])
            or (owner_scope[0] == "member" and stored_team)
        ):
            raise ProductionRecoveryError(
                "current_community_reference_scope_conflict"
            )
        matches.append({"resourceKind": "community-post", "resourceId": str(post_id),
                        "ownerId": owner})
    return matches


def _validate_canvas_plan(plan, *, plan_sha256, actual_identity,
                          reviewed_snapshot):
    required_top = {
        "format", "databaseIdentity", "snapshotManifestSha256",
        "snapshotMediaInventoryDigest", "evidenceSets", "entries",
        "reviewedBy", "reviewedAt",
    }
    if set(plan) != required_top:
        raise ProductionRecoveryError("canvas_recovery_plan_fields_invalid")
    _require_operator_review(plan, "canvas_recovery")
    if not hmac.compare_digest(str(plan.get("databaseIdentity") or ""), actual_identity):
        raise ProductionRecoveryError("canvas_recovery_database_identity_mismatch")
    if not hmac.compare_digest(
        str(plan.get("snapshotManifestSha256") or "").lower(),
        reviewed_snapshot["manifestSha256"],
    ) or not hmac.compare_digest(
        str(plan.get("snapshotMediaInventoryDigest") or "").lower(),
        reviewed_snapshot["mediaInventoryDigest"],
    ):
        raise ProductionRecoveryError("canvas_recovery_snapshot_binding_mismatch")
    entries = plan.get("entries")
    if not isinstance(entries, list) or not entries or len(entries) > MAX_PLAN_ENTRIES:
        raise ProductionRecoveryError("canvas_recovery_entries_invalid")
    evidence_sets = _verify_evidence_sets(plan.get("evidenceSets"))
    required_entry = {
        "mediaKey", "ownerId", "mime", "size", "storedName",
        "sourceEvidenceId", "sourceRelativePath", "historicalRows",
        "currentReference", "evidence",
    }
    normalized = []
    seen = set()
    for raw in entries:
        if not isinstance(raw, dict) or set(raw) != required_entry:
            raise ProductionRecoveryError("canvas_recovery_entry_fields_invalid")
        key = str(raw.get("mediaKey") or "").lower()
        owner = str(raw.get("ownerId") or "")
        mime = str(raw.get("mime") or "").lower()
        size = raw.get("size")
        stored_name = str(raw.get("storedName") or "")
        if (
            not re.fullmatch(r"[0-9a-f]{64}", key) or key in seen or not owner
            or mime not in store.CUSTOM_CANVAS_IMAGE_MIMES
            or type(size) is not int or size <= 0
            or stored_name != store._custom_canvas_blob_relative_path(owner, key, mime)
        ):
            raise ProductionRecoveryError("canvas_recovery_entry_invalid")
        seen.add(key)
        source_set = evidence_sets.get(str(raw.get("sourceEvidenceId") or ""))
        if not source_set:
            raise ProductionRecoveryError("canvas_recovery_source_evidence_missing")
        source_relative = str(raw.get("sourceRelativePath") or "")
        if not source_relative.startswith("canvas-blobs/"):
            raise ProductionRecoveryError("canvas_recovery_source_component_forbidden")
        source = _safe_relative(source_set["restoreRoot"], source_relative)
        data = source.read_bytes()
        historical_relative = source_relative.removeprefix("canvas-blobs/")
        inventory_entry = source_set["snapshot"]["evidenceComponents"][
            "canvas-blobs"
        ]["files"].get(historical_relative)
        if (
            not inventory_entry
            or int(inventory_entry["bytes"]) != len(data)
            or not hmac.compare_digest(
                str(inventory_entry["sha256"]), hashlib.sha256(data).hexdigest()
            )
        ):
            raise ProductionRecoveryError("canvas_recovery_source_inventory_mismatch")
        if len(data) != size or hashlib.sha256(mime.encode("ascii") + b"\0" + data).hexdigest() != key:
            raise ProductionRecoveryError("canvas_recovery_semantic_hash_mismatch")
        historical = raw.get("historicalRows")
        if not isinstance(historical, list) or not historical:
            raise ProductionRecoveryError("canvas_recovery_historical_rows_missing")
        matched_rows = 0
        historical_seen = set()
        for evidence in historical:
            if not isinstance(evidence, dict) or set(evidence) != {"evidenceId", "databaseRelativePath"}:
                raise ProductionRecoveryError("canvas_recovery_historical_row_invalid")
            evidence_id = str(evidence.get("evidenceId") or "")
            database_relative = str(evidence.get("databaseRelativePath") or "")
            if database_relative != "database":
                raise ProductionRecoveryError(
                    "canvas_recovery_database_component_forbidden"
                )
            marker = (evidence_id, database_relative)
            if marker in historical_seen:
                raise ProductionRecoveryError("canvas_recovery_historical_row_duplicate")
            historical_seen.add(marker)
            evidence_set = evidence_sets.get(evidence_id)
            if not evidence_set:
                raise ProductionRecoveryError("canvas_recovery_historical_evidence_missing")
            database = _safe_relative(evidence_set["restoreRoot"], database_relative)
            uri = "file:" + database.resolve().as_posix() + "?mode=ro&immutable=1"
            with sqlite3.connect(uri, uri=True) as history:
                if str(history.execute("PRAGMA quick_check").fetchone()[0]) != "ok":
                    raise ProductionRecoveryError("canvas_recovery_historical_database_corrupt")
                if not history.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='custom_canvas_blobs'"
                ).fetchone():
                    continue
                rows = history.execute(
                    "SELECT owner_id,mime,size,stored_name FROM custom_canvas_blobs "
                    "WHERE content_hash=?", (key,),
                ).fetchall()
                for row in rows:
                    matched_rows += 1
                    if tuple(map(str, (row[0], row[1], int(row[2]), row[3]))) != (
                        owner, mime, str(size), stored_name,
                    ):
                        raise ProductionRecoveryError("canvas_recovery_historical_owner_conflict")
        if matched_rows <= 0:
            raise ProductionRecoveryError("canvas_recovery_historical_owner_missing")
        reference = raw.get("currentReference")
        if not isinstance(reference, dict) or set(reference) != {"resourceKind", "resourceId"}:
            raise ProductionRecoveryError("canvas_recovery_current_reference_invalid")
        normalized.append({
            "mediaKey": key, "ownerId": owner, "mime": mime, "size": size,
            "storedName": stored_name, "data": data,
            "currentReference": {
                "resourceKind": str(reference.get("resourceKind") or ""),
                "resourceId": str(reference.get("resourceId") or ""),
            },
            "evidence": str(raw.get("evidence") or "")[:2000],
        })
    return normalized, evidence_sets


def recover_canvas_blobs_reviewed(*, plan, plan_sha256, expected_identity,
                                  expected_schema_version, backup_binding,
                                  runtime_snapshot_binding,
                                  created_by="deployment", dry_run=False):
    if not dry_run:
        if runtime_config.is_read_only():
            raise store.StoreNotReadyError("read-only runtime cannot recover media")
        if str(os.getenv("ACG_ALLOW_CANVAS_BLOB_RECOVERY", "")).strip() != "1":
            raise store.StoreNotReadyError("canvas blob recovery authorization is required")
    conn = store._connect_migration_target() if not dry_run else store._connect(read_only=True)
    created_files = []
    try:
        conn.execute("BEGIN IMMEDIATE" if not dry_run else "BEGIN")
        actual_identity, snapshot = _require_locked_state(
            conn, expected_identity=expected_identity,
            expected_schema_version=expected_schema_version,
            backup_binding=backup_binding,
            runtime_snapshot_binding=runtime_snapshot_binding,
        )
        existing_receipt = conn.execute(
            "SELECT settlement_id,database_identity,snapshot_manifest_sha256,"
            "snapshot_media_digest,planned_rows,applied_rows FROM "
            "production_recovery_settlements WHERE settlement_kind=? "
            "AND plan_sha256=?",
            (CANVAS_RECOVERY_KIND, plan_sha256),
        ).fetchone()
        reviewed_snapshot = snapshot if not existing_receipt else {
            "manifestSha256": str(existing_receipt[2]),
            "mediaInventoryDigest": str(existing_receipt[3]),
        }
        entries, _evidence_sets = _validate_canvas_plan(
            plan, plan_sha256=plan_sha256, actual_identity=actual_identity,
            reviewed_snapshot=reviewed_snapshot,
        )
        if existing_receipt and (
            str(existing_receipt[1]) != actual_identity
            or int(existing_receipt[4]) != len(entries)
            or int(existing_receipt[5]) != len(entries)
        ):
            raise ProductionRecoveryError("canvas_recovery_receipt_conflict")
        pending = []
        recovered = []
        for entry in entries:
            references = _current_canvas_references_locked(conn, entry["mediaKey"])
            expected_reference = {
                **entry["currentReference"], "ownerId": entry["ownerId"],
            }
            if references != [expected_reference]:
                raise ProductionRecoveryError("canvas_recovery_current_reference_conflict")
            target = store._custom_canvas_blob_path(entry["storedName"])
            row = conn.execute(
                "SELECT mime,size,stored_name FROM custom_canvas_blobs "
                "WHERE owner_id=? AND content_hash=?",
                (entry["ownerId"], entry["mediaKey"]),
            ).fetchone()
            if row:
                if tuple(map(str, (row[0], int(row[1]), row[2]))) != (
                    entry["mime"], str(entry["size"]), entry["storedName"],
                ) or not target.is_file():
                    raise ProductionRecoveryError("canvas_recovery_existing_target_conflict")
                data = target.read_bytes()
                if hashlib.sha256(entry["mime"].encode("ascii") + b"\0" + data).hexdigest() != entry["mediaKey"]:
                    raise ProductionRecoveryError("canvas_recovery_existing_target_hash_conflict")
                recovered.append(entry)
            else:
                if target.exists():
                    raise ProductionRecoveryError("canvas_recovery_target_exists_without_row")
                pending.append(entry)
        if dry_run:
            conn.rollback()
            return {"ok": True, "dryRun": True, "plannedRows": len(entries),
                    "pendingRows": len(pending), "recoveredRows": len(recovered),
                    "databaseIdentity": actual_identity,
                    "snapshotManifestSha256": snapshot["manifestSha256"],
                    "snapshotMediaInventoryDigest": snapshot["mediaInventoryDigest"]}
        if not pending:
            conn.rollback()
            return {"ok": True, "applied": False, "recoveredRows": 0,
                    "plannedRows": len(entries),
                    "settlementId": str(existing_receipt[0]) if existing_receipt else ""}
        if existing_receipt:
            raise ProductionRecoveryError("canvas_recovery_receipt_target_drift")
        now = int(time.time() * 1000)
        for entry in pending:
            store._persist_custom_canvas_blobs_locked(
                conn, entry["ownerId"],
                {entry["mediaKey"]: {
                    "contentHash": entry["mediaKey"], "mime": entry["mime"],
                    "size": entry["size"], "data": entry["data"],
                }},
                now, created_files,
            )
        settlement_id = hashlib.sha256(
            f"{CANVAS_RECOVERY_KIND}:{actual_identity}:{plan_sha256}".encode("utf-8")
        ).hexdigest()
        conn.execute(
            "INSERT INTO production_recovery_settlements("
            "settlement_id,settlement_kind,plan_sha256,database_identity,"
            "snapshot_manifest_sha256,snapshot_media_digest,planned_rows,"
            "applied_rows,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (settlement_id, CANVAS_RECOVERY_KIND, plan_sha256, actual_identity,
             snapshot["manifestSha256"], snapshot["mediaInventoryDigest"],
             len(entries), len(pending), now, str(created_by or "deployment")[:120]),
        )
        conn.executemany(
            "INSERT INTO production_recovery_entries("
            "settlement_id,entry_kind,target_kind,target_id,owner_id,before_value,"
            "after_value,evidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [
                (settlement_id, "canvas-blob-restore", "canvas-blob",
                 entry["mediaKey"], entry["ownerId"], "missing",
                 entry["storedName"], entry["evidence"], now)
                for entry in pending
            ],
        )
        conn.commit()
        store._initialized = False
        return {"ok": True, "applied": True, "recoveredRows": len(pending),
                "plannedRows": len(entries), "settlementId": settlement_id}
    except Exception:
        conn.rollback()
        if created_files:
            owner_by_hash = {
                entry["mediaKey"]: entry["ownerId"] for entry in entries
            } if "entries" in locals() else {}
            owners = sorted(set(owner_by_hash.values()))
            for owner in owners:
                owner_files = [
                    (content_hash, stored_name)
                    for content_hash, stored_name in created_files
                    if owner_by_hash.get(content_hash) == owner
                ]
                store._custom_canvas_cleanup_rolled_back_blobs_locked(
                    conn, owner, owner_files,
                )
        raise
    finally:
        conn.close()


def _validate_adjudication_plan(plan, *, actual_identity, reviewed_snapshot):
    required_top = {
        "format", "databaseIdentity", "snapshotManifestSha256",
        "snapshotMediaInventoryDigest", "entries", "reviewedBy", "reviewedAt",
    }
    if set(plan) != required_top:
        raise ProductionRecoveryError("adjudication_plan_fields_invalid")
    _require_operator_review(plan, "adjudication")
    if not hmac.compare_digest(str(plan.get("databaseIdentity") or ""), actual_identity):
        raise ProductionRecoveryError("adjudication_database_identity_mismatch")
    if not hmac.compare_digest(
        str(plan.get("snapshotManifestSha256") or "").lower(),
        reviewed_snapshot["manifestSha256"],
    ) or not hmac.compare_digest(
        str(plan.get("snapshotMediaInventoryDigest") or "").lower(),
        reviewed_snapshot["mediaInventoryDigest"],
    ):
        raise ProductionRecoveryError("adjudication_snapshot_binding_mismatch")
    entries = plan.get("entries")
    if not isinstance(entries, list) or not entries or len(entries) > MAX_PLAN_ENTRIES:
        raise ProductionRecoveryError("adjudication_entries_invalid")
    required_entry = {
        "domain", "targetKind", "targetId", "disposition", "evidence",
        "evidenceSha256", "businessClass",
    }
    normalized = []
    seen = set()
    allowed = {"missing-media": {"no-verified-recovery-evidence"}}
    business_classes = {
        "published-community",
        "server-asset-upload",
        "succeeded-canvas-generation-job",
    }
    for raw in entries:
        if not isinstance(raw, dict) or set(raw) != required_entry:
            raise ProductionRecoveryError("adjudication_entry_fields_invalid")
        domain = str(raw.get("domain") or "")
        target_kind = str(raw.get("targetKind") or "")
        target_id = str(raw.get("targetId") or "")
        disposition = str(raw.get("disposition") or "")
        evidence = str(raw.get("evidence") or "").strip()
        evidence_sha = str(raw.get("evidenceSha256") or "").lower()
        business_class = str(raw.get("businessClass") or "")
        identity = (domain, target_kind, target_id)
        if (
            domain not in allowed or disposition not in allowed[domain]
            or not target_kind or not target_id or identity in seen
            or not evidence or len(evidence) > 4000
            or not re.fullmatch(r"[0-9a-f]{64}", evidence_sha)
            or not hmac.compare_digest(
                hashlib.sha256(evidence.encode("utf-8")).hexdigest(), evidence_sha,
            )
            or business_class not in business_classes
        ):
            raise ProductionRecoveryError("adjudication_entry_invalid")
        seen.add(identity)
        normalized.append({
            "domain": domain, "targetKind": target_kind, "targetId": target_id,
            "disposition": disposition, "evidence": evidence,
            "evidenceSha256": evidence_sha, "businessClass": business_class,
        })
    return normalized


def _missing_media_business_class_locked(conn, media_kind, media_key):
    kind = str(media_kind or "")
    key = str(media_key or "")
    if kind == "canvas-blob":
        references = _current_canvas_references_locked(conn, key)
        if len(references) != 1:
            raise ProductionRecoveryError("adjudication_canvas_reference_ambiguous")
        reference = references[0]
        if reference["resourceKind"] == "community-post":
            return "published-community"
        if reference["resourceKind"] == store._doc_resource_kind(
            store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION
        ):
            row = conn.execute(
                "SELECT data FROM docs WHERE collection=? AND id=?",
                (store.CUSTOM_CANVAS_GENERATION_JOB_COLLECTION,
                 reference["resourceId"]),
            ).fetchone()
            try:
                payload = json.loads(row[0]) if row else None
            except (TypeError, json.JSONDecodeError) as exc:
                raise ProductionRecoveryError(
                    "adjudication_canvas_job_invalid"
                ) from exc
            if not isinstance(payload, dict) or payload.get("status") != "succeeded":
                raise ProductionRecoveryError(
                    "adjudication_canvas_job_not_succeeded"
                )
            return "succeeded-canvas-generation-job"
        raise ProductionRecoveryError("adjudication_canvas_reference_unsupported")
    if kind == "upload":
        matches = []
        for collection, resource_id, raw in conn.execute(
            "SELECT collection,id,data FROM docs WHERE data LIKE ? ORDER BY collection,id",
            (f"%{key}%",),
        ).fetchall():
            try:
                payload = json.loads(raw)
            except (TypeError, json.JSONDecodeError) as exc:
                raise ProductionRecoveryError("adjudication_upload_reference_invalid") from exc
            references = set()
            store._private_media_collect_references(payload, references)
            if ("upload", key) in references:
                matches.append((str(collection), str(resource_id)))
        if len(matches) != 1 or matches[0][0] != "assets":
            raise ProductionRecoveryError("adjudication_upload_reference_ambiguous")
        return "server-asset-upload"
    raise ProductionRecoveryError("adjudication_media_kind_unsupported")


def record_incident_adjudications(*, plan, plan_sha256, expected_identity,
                                  expected_schema_version, backup_binding,
                                  runtime_snapshot_binding,
                                  created_by="deployment", dry_run=False):
    if not dry_run:
        if runtime_config.is_read_only():
            raise store.StoreNotReadyError("read-only runtime cannot record adjudication")
        if str(os.getenv("ACG_ALLOW_INCIDENT_ADJUDICATION", "")).strip() != "1":
            raise store.StoreNotReadyError("incident adjudication authorization is required")
    conn = store._connect_migration_target() if not dry_run else store._connect(read_only=True)
    try:
        conn.execute("BEGIN IMMEDIATE" if not dry_run else "BEGIN")
        actual_identity, snapshot = _require_locked_state(
            conn, expected_identity=expected_identity,
            expected_schema_version=expected_schema_version,
            backup_binding=backup_binding,
            runtime_snapshot_binding=runtime_snapshot_binding,
        )
        existing = conn.execute(
            "SELECT settlement_id,database_identity,snapshot_manifest_sha256,"
            "snapshot_media_digest,planned_rows,applied_rows FROM "
            "production_recovery_settlements WHERE settlement_kind=? "
            "AND plan_sha256=?",
            (ADJUDICATION_KIND, plan_sha256),
        ).fetchone()
        reviewed_snapshot = snapshot if not existing else {
            "manifestSha256": str(existing[2]),
            "mediaInventoryDigest": str(existing[3]),
        }
        entries = _validate_adjudication_plan(
            plan, actual_identity=actual_identity,
            reviewed_snapshot=reviewed_snapshot,
        )
        if existing and (
            str(existing[1]) != actual_identity
            or int(existing[4]) != len(entries)
            or int(existing[5]) != len(entries)
        ):
            raise ProductionRecoveryError("adjudication_receipt_conflict")
        media_plan = store._private_media_plan_locked(
            conn, include_issue_identities=True,
        )
        missing_media = {
            (row["mediaKind"], row["mediaKey"])
            for row in (media_plan.get("_issueIdentities") or {}).get("missingReferencedFiles") or []
        }
        planned_media = {
            (entry["targetKind"], entry["targetId"]) for entry in entries
        }
        if planned_media != missing_media:
            raise ProductionRecoveryError(
                "adjudication_missing_media_exact_set_mismatch"
            )
        for entry in entries:
            if (entry["targetKind"], entry["targetId"]) not in missing_media:
                raise ProductionRecoveryError("adjudication_media_target_not_missing")
            actual_class = _missing_media_business_class_locked(
                conn, entry["targetKind"], entry["targetId"],
            )
            if actual_class != entry["businessClass"]:
                raise ProductionRecoveryError(
                    "adjudication_media_business_class_mismatch"
                )
        if dry_run:
            conn.rollback()
            return {"ok": True, "dryRun": True, "plannedRows": len(entries),
                    "missingMediaStillBlocking": len(missing_media),
                    "usageStillBlocking": 0,
                    "readinessUnchanged": True}
        if existing:
            conn.rollback()
            return {"ok": True, "applied": False, "insertedRows": 0,
                    "plannedRows": len(entries), "settlementId": str(existing[0]),
                    "readinessUnchanged": True}
        now = int(time.time() * 1000)
        settlement_id = hashlib.sha256(
            f"{ADJUDICATION_KIND}:{actual_identity}:{plan_sha256}".encode("utf-8")
        ).hexdigest()
        conn.execute(
            "INSERT INTO production_recovery_settlements("
            "settlement_id,settlement_kind,plan_sha256,database_identity,"
            "snapshot_manifest_sha256,snapshot_media_digest,planned_rows,"
            "applied_rows,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (settlement_id, ADJUDICATION_KIND, plan_sha256, actual_identity,
             snapshot["manifestSha256"], snapshot["mediaInventoryDigest"],
             len(entries), len(entries), now, str(created_by or "deployment")[:120]),
        )
        conn.executemany(
            "INSERT INTO production_recovery_entries("
            "settlement_id,entry_kind,target_kind,target_id,owner_id,before_value,"
            "after_value,evidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            [
                (settlement_id, f"{entry['businessClass']}-adjudication",
                 entry["targetKind"], entry["targetId"], "", "unresolved",
                 entry["disposition"],
                 f"sha256:{entry['evidenceSha256']} {entry['evidence']}", now)
                for entry in entries
            ],
        )
        conn.commit()
        store._initialized = False
        return {"ok": True, "applied": True, "insertedRows": len(entries),
                "plannedRows": len(entries), "settlementId": settlement_id,
                "readinessUnchanged": True}
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
