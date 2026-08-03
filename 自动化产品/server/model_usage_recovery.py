#!/usr/bin/env python3
"""Recover only model-usage facts that are supported by durable legacy evidence.

This module deliberately does **not** import :mod:`server.store`: importing the
application store can run bootstrap, schema, or seed work.  Recovery is instead
split into two explicit offline commands:

``scan``
    Opens an SQLite snapshot with ``mode=ro`` and ``query_only=ON``, verifies
    ``quick_check``, and emits a canonical JSON manifest.  It never changes the
    source database or video-workshop files.  Only evidence with a defensible
    lower bound is included; prompts, API keys, content hashes, and provider
    secrets are never copied into the manifest.

``apply``
    Appends the manifest to an already-migrated *database copy*.  The target
    must be a different file from the manifest source and, on the first apply,
    must have the exact same byte hash.  The manifest hash and target pre-write
    hash are both required on the command line.  Existing rows are never
    updated or deleted.  A replay is allowed only when every receipt is already
    byte-for-byte compatible, in which case it is a zero-write no-op.

``reconcile-copy``
    Projects only the manifest receipts from ``pending`` outbox rows into the
    unchanged legacy usage tables of the already-applied database copy.  It
    repeats the manifest, source/copy separation, schema, checksum, and
    ``quick_check`` gates and never opens the application store.  A second run
    is a zero-write no-op with zero pending manifest receipts.

Typical offline workflow::

    python server/model_usage_recovery.py scan \
      --database /snapshots/acg.sqlite \
      --video-dir /snapshots/video-workshop/projects \
      --output /snapshots/usage-recovery.json

    cp /snapshots/acg.sqlite /scratch/acg-recovery.sqlite
    python server/model_usage_recovery.py apply \
      --manifest /snapshots/usage-recovery.json \
      --target-database /scratch/acg-recovery.sqlite \
      --confirm-manifest-sha256 <manifestSha256> \
      --expected-db-sha256 <source database sha256> \
      --output /scratch/usage-recovery-apply.json

    python server/model_usage_recovery.py reconcile-copy \
      --manifest /snapshots/usage-recovery.json \
      --target-database /scratch/acg-recovery.sqlite \
      --confirm-manifest-sha256 <manifestSha256> \
      --expected-db-sha256 <post-apply database sha256> \
      --output /scratch/usage-recovery-reconcile.json

The explicit ``reconcile-copy`` step drains the manifest's outbox rows without
starting the application or touching a live database.  ``--output`` must always name a new file;
it is rejected when it aliases any database, SQLite sidecar, manifest, or video
project input.  Audit artifacts are never overwritten.  This tool never
contacts a server.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional
from urllib.parse import quote


MANIFEST_SCHEMA_VERSION = 1
APPLY_REPORT_SCHEMA_VERSION = 1
RECOVERY_SOURCE = "legacy-recovery"
MAX_STATIC_IMAGE_OBSERVATIONS = 10_000
REQUIRED_MIGRATIONS = {
    137003: "v137-schema-expand-final",
    139001: "v139-model-usage-receipt-outbox",
    137004: "v137-acg-internal-team-final",
}
REQUIRED_MIGRATION_CHECKSUMS = {
    137003: "181fffe9817b41e35f6092379c1316ef0d8d8c9bd652f948eb529b47bb1fdb24",
    139001: "5bfab662529c1a833ec5449b93e9f40c2b0b7a3a2fc277c3b382a4b7195a2795",
    137004: "8530819b8ef24675909cb0143136fe40007e1b071a683f3a5afe6f3ad62db448",
}
REQUIRED_RECEIPT_COLUMNS = {
    "receipt_id",
    "receipt_key",
    "member_id",
    "member_name",
    "team_id",
    "surface",
    "feature",
    "usage_kind",
    "provider",
    "model",
    "operation",
    "operation_id",
    "idempotency_key",
    "request_fingerprint",
    "provider_ref",
    "call_status",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "calls",
    "output_units",
    "unit_label",
    "source",
    "error",
    "event_at",
    "created_at",
    "updated_at",
    "completed_at",
}
REQUIRED_OUTBOX_COLUMNS = {
    "receipt_id",
    "state",
    "attempts",
    "available_at",
    "last_error",
    "legacy_event_kind",
    "legacy_event_id",
    "created_at",
    "updated_at",
    "projected_at",
}
REQUIRED_USAGE_INDEXES = {
    "idx_model_usage_receipts_member_idempotency",
    "idx_model_usage_receipts_provider_ref",
    "idx_model_usage_outbox_state_available",
}
SEEDANCE_ACCEPTED_TITLE = re.compile(
    r"^\u955c\u5934 ([1-9][0-9]*) \u5df2\u8fdb\u5165 Seedance \u961f\u5217$"
)
SAFE_SOURCE_ID = re.compile(r"^[A-Za-z0-9._:-]{1,120}$")
OBSERVATION_FIELDS = {
    "callStatus",
    "calls",
    "completionTokens",
    "eventAt",
    "evidence",
    "feature",
    "idempotencyKey",
    "model",
    "observationId",
    "operation",
    "operationId",
    "outputUnits",
    "ownerId",
    "promptTokens",
    "provider",
    "providerRef",
    "receiptId",
    "receiptKey",
    "requestFingerprint",
    "source",
    "surface",
    "teamId",
    "totalTokens",
    "unitLabel",
    "usageKind",
}
EVIDENCE_FIELDS = {
    "canvas-charged-receipt": {
        "kind", "receiptId", "confidence", "providerCallConfirmed",
        "tokenUsageKnown",
    },
    "static-video-success-billing": {
        "kind", "projectId", "ordinal", "reportedImageCount", "confidence",
        "providerCallConfirmed", "tokenUsageKnown",
    },
    "static-video-success-tts-minimum": {
        "kind", "projectId", "reportedTtsChars", "minimumConfirmedCalls",
        "exactAttemptCountKnown", "tokenUsageKnown", "confidence",
    },
    "seedance-queue-accepted-event": {
        "kind", "projectId", "eventId", "eventAt", "sceneNumber",
        "providerCallConfirmed", "finalOutputKnown", "tokenUsageKnown",
        "confidence",
    },
}


class RecoveryError(RuntimeError):
    """Raised when a recovery safety gate cannot be satisfied."""


class RecoveryConflict(RecoveryError):
    """Raised when append-only idempotency encounters incompatible data."""


class RecoveryCommittedAfterError(RecoveryError):
    """A transaction committed, but a post-commit durability check failed.

    Re-running the same manifest against the same copy is safe because receipt
    and legacy-event identities are deterministic and collision checked.
    """

    def __init__(self, phase: str, cause: BaseException):
        self.phase = str(phase or "post-commit-check")
        self.cause = cause
        self.committed = True
        self.replay_safe = True
        super().__init__(
            f"committed_after_error:{self.phase}:{type(cause).__name__};"
            "committed=true;replay_safe=true;verify_copy_before_replay"
        )


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: os.PathLike[str] | str) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolved_file(path: os.PathLike[str] | str, label: str) -> Path:
    resolved = Path(path).expanduser().resolve()
    if not resolved.is_file():
        raise RecoveryError(f"{label}_not_file:{resolved}")
    return resolved


def _resolved_dir(path: os.PathLike[str] | str, label: str) -> Path:
    resolved = Path(path).expanduser().resolve()
    if not resolved.is_dir():
        raise RecoveryError(f"{label}_not_directory:{resolved}")
    return resolved


def _sqlite_related_paths(path: os.PathLike[str] | str) -> tuple[Path, ...]:
    resolved = Path(path).expanduser().resolve()
    return (
        resolved,
        Path(str(resolved) + "-wal"),
        Path(str(resolved) + "-shm"),
        Path(str(resolved) + "-journal"),
    )


def _paths_alias(left: Path, right: Path) -> bool:
    if left == right:
        return True
    if not os.path.lexists(left) or not os.path.lexists(right):
        return False
    try:
        return os.path.samefile(left, right)
    except OSError:
        return False


def _validate_output_destination(
    output: os.PathLike[str] | str,
    *,
    protected_paths: Iterable[os.PathLike[str] | str],
    video_dir: os.PathLike[str] | str = "",
) -> Path:
    """Reject overwrite and every known input/output alias before any mutation."""

    raw_destination = Path(output).expanduser()
    destination = raw_destination.resolve()
    protected = [Path(item).expanduser().resolve() for item in protected_paths]
    if video_dir:
        projects_path = Path(video_dir).expanduser().resolve()
        protected.append(projects_path)
        if projects_path.is_dir():
            protected.extend(
                item.resolve()
                for item in projects_path.glob("*.json")
                if item.is_file() or item.is_symlink()
            )
    for item in protected:
        if _paths_alias(destination, item):
            raise RecoveryError(f"output_path_collides_with_input:{item}")
    if os.path.lexists(raw_destination) or os.path.lexists(destination):
        raise RecoveryError(f"output_path_already_exists:{destination}")
    return destination


def _sqlite_read_only(path: Path) -> sqlite3.Connection:
    # ``immutable=1`` prevents a closed WAL-mode backup from trying to create
    # fresh ``-shm`` state.  It is safe here because sidecars are rejected both
    # before and after the scan and the file hash is checked for drift.
    uri = "file:" + quote(str(path), safe="/") + "?mode=ro&immutable=1"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    if int(conn.execute("PRAGMA query_only").fetchone()[0]) != 1:
        conn.close()
        raise RecoveryError("sqlite_query_only_not_enabled")
    return conn


def _quick_check(conn: sqlite3.Connection) -> str:
    rows = [str(row[0]) for row in conn.execute("PRAGMA quick_check").fetchall()]
    result = "\n".join(rows)
    if rows != ["ok"]:
        raise RecoveryError(f"sqlite_quick_check_failed:{result[:300]}")
    return "ok"


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return bool(row)


def _reject_uncheckpointed_sidecars(path: Path) -> None:
    """A byte hash is unsafe if current rows live only in WAL/journal files."""

    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(path) + suffix)
        try:
            size = sidecar.stat().st_size
        except FileNotFoundError:
            continue
        if size > 0:
            raise RecoveryError(
                f"source_database_has_uncheckpointed_sidecar:{sidecar.name};"
                "use_a_closed_sqlite_online_backup"
            )


def _validate_copy_target(source_path: Path, target_path: Path) -> None:
    """Mechanically reject live or in-place databases before a writable open."""

    if target_path == source_path or os.path.samefile(target_path, source_path):
        raise RecoveryError("target_database_must_be_distinct_copy")
    if target_path.parent == source_path.parent:
        raise RecoveryError("target_database_requires_isolated_copy_directory")

    configured_live = str(os.getenv("DATA_DB", "")).strip()
    if configured_live:
        live_path = Path(configured_live).expanduser().resolve(strict=False)
        if target_path == live_path or (
            live_path.exists() and os.path.samefile(target_path, live_path)
        ):
            raise RecoveryError("target_database_matches_configured_live_database")

    persistent_root = str(os.getenv("ACG_PERSISTENT_ROOT", "")).strip()
    runtime_mode = str(os.getenv("ACG_RUNTIME_MODE", "")).strip().lower()
    if persistent_root and runtime_mode == "production":
        protected_root = Path(persistent_root).expanduser().resolve(strict=False)
        try:
            target_path.relative_to(protected_root)
        except ValueError:
            pass
        else:
            raise RecoveryError("target_database_inside_production_persistent_root")


def _safe_identifier(value: Any) -> str:
    text = str(value or "").strip()
    return text if SAFE_SOURCE_ID.fullmatch(text) else ""


def _nonnegative_int(value: Any) -> int:
    try:
        parsed = int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0
    return max(0, parsed)


def _timestamp_ms(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        raw = int(value)
        if raw <= 0:
            return None
        return raw * 1000 if raw < 10_000_000_000 else raw
    text = str(value).strip()
    if not text:
        return None
    if re.fullmatch(r"[0-9]+", text):
        return _timestamp_ms(int(text))
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0, int(parsed.timestamp() * 1000))


def _warning(code: str, entity_type: str = "", entity_id: str = "") -> dict[str, str]:
    item = {"code": code}
    if entity_type:
        item["entityType"] = entity_type
    if entity_id:
        item["entityId"] = entity_id
    return item


def _observation_identity(observation: Mapping[str, Any]) -> dict[str, Any]:
    keys = (
        "ownerId",
        "teamId",
        "surface",
        "feature",
        "usageKind",
        "provider",
        "model",
        "operation",
        "operationId",
        "calls",
        "outputUnits",
        "unitLabel",
        "eventAt",
        "evidence",
    )
    return {
        "schemaVersion": 1,
        "source": RECOVERY_SOURCE,
        **{key: observation.get(key) for key in keys},
    }


def _finalize_observation(base: Mapping[str, Any]) -> dict[str, Any]:
    observation = dict(base)
    owner_id = _safe_identifier(observation.get("ownerId"))
    operation_id = str(observation.get("operationId") or "").strip()
    if not owner_id or not operation_id or len(operation_id) > 180:
        raise RecoveryError("unsafe_observation_identity")
    observation["ownerId"] = owner_id
    observation["teamId"] = _safe_identifier(observation.get("teamId"))
    observation["source"] = RECOVERY_SOURCE
    observation["idempotencyKey"] = operation_id
    fingerprint = _sha256_bytes(_canonical_bytes(_observation_identity(observation)))
    receipt_key = _sha256_bytes(
        f"model-usage-v1|{RECOVERY_SOURCE}|{owner_id}|{operation_id}".encode("utf-8")
    )
    observation["requestFingerprint"] = fingerprint
    observation["observationId"] = "legacy_" + fingerprint[:24]
    observation["receiptKey"] = receipt_key
    observation["receiptId"] = "mur_" + receipt_key[:28]
    observation["callStatus"] = "succeeded"
    observation["promptTokens"] = 0
    observation["completionTokens"] = 0
    observation["totalTokens"] = 0
    observation["providerRef"] = ""
    return observation


def _resolve_team(
    owner_id: str,
    active_teams: Mapping[str, list[str]],
    explicit_team: str = "",
) -> tuple[str, Optional[str]]:
    teams = sorted(set(active_teams.get(owner_id, [])))
    explicit = _safe_identifier(explicit_team)
    if explicit:
        if explicit not in teams:
            return "", "owner_explicit_team_not_active"
        return explicit, None
    if len(teams) == 1:
        return teams[0], None
    if len(teams) > 1:
        return "", "owner_team_ambiguous_apply_will_fail"
    return "", None


def _project_owner_mapping(
    conn: sqlite3.Connection,
) -> tuple[dict[str, dict[str, str]], list[dict[str, str]]]:
    candidates: dict[str, dict[str, set[str]]] = defaultdict(
        lambda: {"owners": set(), "teams": set()}
    )
    warnings: list[dict[str, str]] = []
    for row in conn.execute(
        "SELECT id,owner_id,data FROM docs WHERE collection='customProjects' "
        "ORDER BY id"
    ):
        doc_id = _safe_identifier(row["id"])
        owner_id = _safe_identifier(row["owner_id"])
        if not doc_id or not owner_id:
            warnings.append(_warning("custom_project_invalid_identity", "customProject", doc_id))
            continue
        try:
            data = json.loads(row["data"])
        except (TypeError, json.JSONDecodeError):
            warnings.append(_warning("custom_project_invalid_json", "customProject", doc_id))
            continue
        if not isinstance(data, dict):
            warnings.append(_warning("custom_project_invalid_json", "customProject", doc_id))
            continue
        state = data.get("projectState")
        state = state if isinstance(state, dict) else {}
        project_ids = {
            _safe_identifier(state.get("workshopProjectId")),
            _safe_identifier(state.get("sourceProjectId")),
        }
        project_ids.discard("")
        explicit_team = _safe_identifier(data.get("teamId") or state.get("teamId"))
        for project_id in project_ids:
            candidates[project_id]["owners"].add(owner_id)
            if explicit_team:
                candidates[project_id]["teams"].add(explicit_team)

    resolved: dict[str, dict[str, str]] = {}
    for project_id in sorted(candidates):
        owners = sorted(candidates[project_id]["owners"])
        teams = sorted(candidates[project_id]["teams"])
        if len(owners) != 1:
            warnings.append(_warning("video_project_owner_conflict", "videoProject", project_id))
            continue
        if len(teams) > 1:
            warnings.append(_warning("video_project_team_conflict", "videoProject", project_id))
            continue
        resolved[project_id] = {
            "ownerId": owners[0],
            "explicitTeamId": teams[0] if teams else "",
        }
    return resolved, warnings


def _member_and_team_state(
    conn: sqlite3.Connection,
) -> tuple[set[str], dict[str, list[str]]]:
    members = {
        _safe_identifier(row[0])
        for row in conn.execute("SELECT id FROM members ORDER BY id")
        if _safe_identifier(row[0])
    }
    active_teams: dict[str, list[str]] = defaultdict(list)
    if _table_exists(conn, "team_members"):
        for row in conn.execute(
            "SELECT member_id,team_id FROM team_members WHERE status='active' "
            "ORDER BY member_id,team_id"
        ):
            member_id = _safe_identifier(row[0])
            team_id = _safe_identifier(row[1])
            if member_id and team_id:
                active_teams[member_id].append(team_id)
    return members, dict(active_teams)


def _canvas_observations(
    conn: sqlite3.Connection,
    members: set[str],
    active_teams: Mapping[str, list[str]],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    observations: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    if not _table_exists(conn, "custom_canvas_generation_receipts"):
        warnings.append(_warning("canvas_receipt_table_missing"))
        return observations, warnings
    rows = conn.execute(
        "SELECT owner_id,receipt_id,charged_at FROM custom_canvas_generation_receipts "
        "WHERE charged_at IS NOT NULL ORDER BY owner_id,receipt_id"
    ).fetchall()
    for row in rows:
        owner_id = _safe_identifier(row["owner_id"])
        receipt_id = _safe_identifier(row["receipt_id"])
        if not owner_id or not receipt_id:
            warnings.append(_warning("canvas_receipt_invalid_identity", "canvasReceipt", receipt_id))
            continue
        if owner_id not in members:
            warnings.append(_warning("canvas_receipt_owner_missing", "canvasReceipt", receipt_id))
            continue
        team_id, team_error = _resolve_team(owner_id, active_teams)
        if team_error:
            warnings.append(_warning(team_error, "member", owner_id))
        event_at = _timestamp_ms(row["charged_at"])
        if event_at is None:
            warnings.append(
                _warning("canvas_receipt_event_time_missing", "canvasReceipt", receipt_id)
            )
            continue
        operation_id = f"legacy:canvas:{receipt_id}"
        observations.append(
            _finalize_observation(
                {
                    "ownerId": owner_id,
                    "teamId": team_id,
                    "surface": "infinite-canvas",
                    "feature": "\u65e0\u9650\u753b\u5e03\u5386\u53f2\u5df2\u6263\u8d39\u751f\u6210",
                    "usageKind": "image",
                    "provider": "legacy-observed",
                    "model": "unknown",
                    "operation": "historical-recovery",
                    "operationId": operation_id,
                    "calls": 1,
                    "outputUnits": 1,
                    "unitLabel": "images",
                    "eventAt": event_at,
                    "evidence": {
                        "kind": "canvas-charged-receipt",
                        "receiptId": receipt_id,
                        "confidence": "high",
                        "providerCallConfirmed": True,
                        "tokenUsageKnown": False,
                    },
                }
            )
        )
    return observations, warnings


def _project_observations(
    video_dir: Path,
    owner_map: Mapping[str, Mapping[str, str]],
    members: set[str],
    active_teams: Mapping[str, list[str]],
) -> tuple[list[dict[str, Any]], list[dict[str, str]], int]:
    observations: list[dict[str, Any]] = []
    warnings: list[dict[str, str]] = []
    skipped_projects = 0
    seen_projects: set[str] = set()
    for path in sorted(video_dir.glob("*.json"), key=lambda item: item.name):
        if path.is_symlink() or not path.is_file():
            warnings.append(_warning("video_project_unsafe_file", "file", path.name))
            skipped_projects += 1
            continue
        try:
            before = path.stat()
            raw_project = path.read_text(encoding="utf-8")
            after = path.stat()
            if (
                before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
            ):
                warnings.append(_warning("video_project_changed_during_scan", "file", path.name))
                skipped_projects += 1
                continue
            project = json.loads(raw_project)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            warnings.append(_warning("video_project_invalid_json", "file", path.name))
            skipped_projects += 1
            continue
        if not isinstance(project, dict):
            warnings.append(_warning("video_project_invalid_json", "file", path.name))
            skipped_projects += 1
            continue
        project_id = _safe_identifier(project.get("id"))
        if not project_id or project_id != path.stem or project_id in seen_projects:
            warnings.append(_warning("video_project_invalid_identity", "file", path.name))
            skipped_projects += 1
            continue
        seen_projects.add(project_id)
        mapping = owner_map.get(project_id)
        if not mapping:
            warnings.append(_warning("video_project_owner_mapping_missing", "videoProject", project_id))
            skipped_projects += 1
            continue
        owner_id = _safe_identifier(mapping.get("ownerId"))
        if owner_id not in members:
            warnings.append(_warning("video_project_owner_missing", "videoProject", project_id))
            skipped_projects += 1
            continue
        team_id, team_error = _resolve_team(
            owner_id, active_teams, str(mapping.get("explicitTeamId") or "")
        )
        if team_error == "owner_explicit_team_not_active":
            warnings.append(_warning(team_error, "videoProject", project_id))
            skipped_projects += 1
            continue
        if team_error:
            warnings.append(_warning(team_error, "member", owner_id))

        creation_mode = str(project.get("creationMode") or "").strip().lower()
        status = str(project.get("status") or "").strip().lower()
        billing_usage = project.get("billingUsage")
        billing_usage = billing_usage if isinstance(billing_usage, dict) else {}
        project_at = _timestamp_ms(project.get("updatedAt")) or _timestamp_ms(
            project.get("createdAt")
        )

        if creation_mode == "static" and status == "succeeded" and project_at is None:
            if _nonnegative_int(billing_usage.get("imageCount")) > 0 or _nonnegative_int(
                billing_usage.get("ttsChars")
            ) > 0:
                warnings.append(
                    _warning(
                        "video_project_usage_event_time_missing",
                        "videoProject",
                        project_id,
                    )
                )
            # A project status proves an operation happened but not when.  Do
            # not fabricate epoch zero or silently move historical usage into
            # an arbitrary reporting day.
            continue

        if creation_mode == "static" and status == "succeeded":
            image_count = _nonnegative_int(billing_usage.get("imageCount"))
            if image_count > MAX_STATIC_IMAGE_OBSERVATIONS:
                warnings.append(
                    _warning("static_video_image_count_exceeds_safety_limit", "videoProject", project_id)
                )
            else:
                for ordinal in range(1, image_count + 1):
                    operation_id = f"legacy:video:{project_id}:static-image:{ordinal}"
                    observations.append(
                        _finalize_observation(
                            {
                                "ownerId": owner_id,
                                "teamId": team_id,
                                "surface": "video-workshop",
                                "feature": "\u9759\u6001\u89c6\u9891\u5386\u53f2\u5206\u955c\u56fe",
                                "usageKind": "image",
                                "provider": "legacy-observed",
                                "model": "unknown",
                                "operation": "historical-recovery",
                                "operationId": operation_id,
                                "calls": 1,
                                "outputUnits": 1,
                                "unitLabel": "images",
                                "eventAt": project_at,
                                "evidence": {
                                    "kind": "static-video-success-billing",
                                    "projectId": project_id,
                                    "ordinal": ordinal,
                                    "reportedImageCount": image_count,
                                    "confidence": "high",
                                    "providerCallConfirmed": True,
                                    "tokenUsageKnown": False,
                                },
                            }
                        )
                    )
            tts_chars = _nonnegative_int(billing_usage.get("ttsChars"))
            if tts_chars > 0:
                operation_id = f"legacy:video:{project_id}:tts-minimum"
                observations.append(
                    _finalize_observation(
                        {
                            "ownerId": owner_id,
                            "teamId": team_id,
                            "surface": "video-workshop",
                            "feature": "\u9759\u6001\u89c6\u9891\u5386\u53f2\u53e3\u64ad\u6700\u5c0f\u786e\u8ba4",
                            "usageKind": "voice",
                            "provider": "legacy-observed",
                            "model": "unknown",
                            "operation": "historical-recovery",
                            "operationId": operation_id,
                            "calls": 1,
                            "outputUnits": tts_chars,
                            "unitLabel": "chars",
                            "eventAt": project_at,
                            "evidence": {
                                "kind": "static-video-success-tts-minimum",
                                "projectId": project_id,
                                "reportedTtsChars": tts_chars,
                                "minimumConfirmedCalls": 1,
                                "exactAttemptCountKnown": False,
                                "tokenUsageKnown": False,
                                "confidence": "minimum-confirmed",
                            },
                        }
                    )
                )

        if creation_mode != "static":
            events = project.get("events")
            events = events if isinstance(events, list) else []
            seen_events: set[tuple[str, int]] = set()
            for event in events:
                if not isinstance(event, dict):
                    continue
                title = str(event.get("title") or "")
                title_match = SEEDANCE_ACCEPTED_TITLE.fullmatch(title)
                if not title_match:
                    continue
                event_id = _safe_identifier(event.get("id"))
                event_at = _timestamp_ms(event.get("at"))
                if not event_id or event_at is None:
                    warnings.append(_warning("seedance_event_missing_stable_identity", "videoProject", project_id))
                    continue
                event_key = (event_id, event_at)
                if event_key in seen_events:
                    warnings.append(_warning("seedance_event_duplicate", "videoProject", project_id))
                    continue
                seen_events.add(event_key)
                scene_number = int(title_match.group(1))
                event_identity = _sha256_bytes(
                    f"{event_id}|{event_at}".encode("utf-8")
                )[:24]
                operation_id = f"legacy:video:{project_id}:seedance:{event_identity}"
                observations.append(
                    _finalize_observation(
                        {
                            "ownerId": owner_id,
                            "teamId": team_id,
                            "surface": "video-workshop",
                            "feature": "Seedance \u5386\u53f2\u63d0\u4ea4\u5df2\u63a5\u53d7",
                            "usageKind": "video",
                            "provider": "seedance",
                            "model": "unknown",
                            "operation": "historical-recovery",
                            "operationId": operation_id,
                            "calls": 1,
                            "outputUnits": 0,
                            "unitLabel": "videos",
                            "eventAt": event_at,
                            "evidence": {
                                "kind": "seedance-queue-accepted-event",
                                "projectId": project_id,
                                "eventId": event_id,
                                "eventAt": event_at,
                                "sceneNumber": scene_number,
                                "providerCallConfirmed": True,
                                "finalOutputKnown": False,
                                "tokenUsageKnown": False,
                                "confidence": "provider-accepted",
                            },
                        }
                    )
                )
    return observations, warnings, skipped_projects


def _manifest_sha(payload: Mapping[str, Any]) -> str:
    without_sha = dict(payload)
    without_sha.pop("manifestSha256", None)
    return _sha256_bytes(_canonical_bytes(without_sha))


def _seal_manifest(payload: Mapping[str, Any]) -> dict[str, Any]:
    result = dict(payload)
    result["manifestSha256"] = _manifest_sha(result)
    return result


def _validate_observation_payload(item: Mapping[str, Any]) -> None:
    if set(item) != OBSERVATION_FIELDS:
        raise RecoveryError("manifest_observation_fields_invalid")
    if (
        not _safe_identifier(item.get("ownerId"))
        or str(item.get("teamId") or "") != _safe_identifier(item.get("teamId"))
        or item.get("source") != RECOVERY_SOURCE
        or item.get("operation") != "historical-recovery"
        or item.get("callStatus") != "succeeded"
        or item.get("model") != "unknown"
        or item.get("providerRef") != ""
        or item.get("calls") != 1
        or item.get("promptTokens") != 0
        or item.get("completionTokens") != 0
        or item.get("totalTokens") != 0
        or not isinstance(item.get("outputUnits"), int)
        or isinstance(item.get("outputUnits"), bool)
        or int(item.get("outputUnits")) < 0
    ):
        raise RecoveryError("manifest_observation_values_invalid")
    event_at = item.get("eventAt")
    if (
        not isinstance(event_at, int)
        or isinstance(event_at, bool)
        or event_at <= 0
    ):
        raise RecoveryError("manifest_observation_event_at_invalid")
    evidence = item.get("evidence")
    if not isinstance(evidence, dict):
        raise RecoveryError("manifest_observation_evidence_invalid")
    evidence_kind = str(evidence.get("kind") or "")
    if evidence_kind not in EVIDENCE_FIELDS or set(evidence) != EVIDENCE_FIELDS[evidence_kind]:
        raise RecoveryError("manifest_observation_evidence_fields_invalid")
    if evidence_kind == "canvas-charged-receipt":
        valid = (
            item.get("surface") == "infinite-canvas"
            and item.get("usageKind") == "image"
            and item.get("provider") == "legacy-observed"
            and item.get("feature") == "\u65e0\u9650\u753b\u5e03\u5386\u53f2\u5df2\u6263\u8d39\u751f\u6210"
            and item.get("unitLabel") == "images"
            and item.get("outputUnits") == 1
            and _safe_identifier(evidence.get("receiptId"))
            and evidence.get("confidence") == "high"
            and evidence.get("providerCallConfirmed") is True
            and evidence.get("tokenUsageKnown") is False
        )
    elif evidence_kind == "static-video-success-billing":
        ordinal = evidence.get("ordinal")
        reported = evidence.get("reportedImageCount")
        valid = (
            item.get("surface") == "video-workshop"
            and item.get("usageKind") == "image"
            and item.get("provider") == "legacy-observed"
            and item.get("feature") == "\u9759\u6001\u89c6\u9891\u5386\u53f2\u5206\u955c\u56fe"
            and item.get("unitLabel") == "images"
            and item.get("outputUnits") == 1
            and _safe_identifier(evidence.get("projectId"))
            and isinstance(ordinal, int)
            and not isinstance(ordinal, bool)
            and isinstance(reported, int)
            and not isinstance(reported, bool)
            and 1 <= ordinal <= reported <= MAX_STATIC_IMAGE_OBSERVATIONS
            and evidence.get("confidence") == "high"
            and evidence.get("providerCallConfirmed") is True
            and evidence.get("tokenUsageKnown") is False
        )
    elif evidence_kind == "static-video-success-tts-minimum":
        reported = evidence.get("reportedTtsChars")
        valid = (
            item.get("surface") == "video-workshop"
            and item.get("usageKind") == "voice"
            and item.get("provider") == "legacy-observed"
            and item.get("feature") == "\u9759\u6001\u89c6\u9891\u5386\u53f2\u53e3\u64ad\u6700\u5c0f\u786e\u8ba4"
            and item.get("unitLabel") == "chars"
            and isinstance(reported, int)
            and not isinstance(reported, bool)
            and reported > 0
            and item.get("outputUnits") == reported
            and _safe_identifier(evidence.get("projectId"))
            and evidence.get("minimumConfirmedCalls") == 1
            and evidence.get("exactAttemptCountKnown") is False
            and evidence.get("tokenUsageKnown") is False
            and evidence.get("confidence") == "minimum-confirmed"
        )
    else:
        evidence_at = evidence.get("eventAt")
        scene_number = evidence.get("sceneNumber")
        valid = (
            item.get("surface") == "video-workshop"
            and item.get("usageKind") == "video"
            and item.get("provider") == "seedance"
            and item.get("feature") == "Seedance \u5386\u53f2\u63d0\u4ea4\u5df2\u63a5\u53d7"
            and item.get("unitLabel") == "videos"
            and item.get("outputUnits") == 0
            and _safe_identifier(evidence.get("projectId"))
            and _safe_identifier(evidence.get("eventId"))
            and isinstance(evidence_at, int)
            and not isinstance(evidence_at, bool)
            and evidence_at > 0
            and item.get("eventAt") == evidence_at
            and isinstance(scene_number, int)
            and not isinstance(scene_number, bool)
            and scene_number > 0
            and evidence.get("providerCallConfirmed") is True
            and evidence.get("finalOutputKnown") is False
            and evidence.get("tokenUsageKnown") is False
            and evidence.get("confidence") == "provider-accepted"
        )
    if not valid:
        raise RecoveryError("manifest_observation_evidence_values_invalid")


def verify_manifest(manifest: Mapping[str, Any]) -> str:
    if set(manifest) != {
        "schemaVersion", "mode", "source", "counts", "warnings",
        "unrecoverable", "observations", "manifestSha256",
    }:
        raise RecoveryError("manifest_fields_invalid")
    if int(manifest.get("schemaVersion") or 0) != MANIFEST_SCHEMA_VERSION:
        raise RecoveryError("manifest_schema_version_unsupported")
    if manifest.get("mode") != "read-only-evidence-scan":
        raise RecoveryError("manifest_mode_invalid")
    claimed = str(manifest.get("manifestSha256") or "").strip().lower()
    actual = _manifest_sha(manifest)
    if not re.fullmatch(r"[0-9a-f]{64}", claimed) or claimed != actual:
        raise RecoveryError("manifest_sha256_mismatch")
    observations = manifest.get("observations")
    if not isinstance(observations, list):
        raise RecoveryError("manifest_observations_invalid")
    previous_id = ""
    for item in observations:
        if not isinstance(item, dict):
            raise RecoveryError("manifest_observation_invalid")
        _validate_observation_payload(item)
        recomputed = _finalize_observation(item)
        protected = (
            "observationId",
            "receiptId",
            "receiptKey",
            "requestFingerprint",
            "idempotencyKey",
            "source",
            "callStatus",
            "promptTokens",
            "completionTokens",
            "totalTokens",
            "providerRef",
        )
        if any(item.get(key) != recomputed.get(key) for key in protected):
            raise RecoveryError("manifest_observation_identity_mismatch")
        observation_id = str(item.get("observationId") or "")
        if previous_id and observation_id <= previous_id:
            raise RecoveryError("manifest_observations_not_canonical")
        previous_id = observation_id
    counts = manifest.get("counts")
    if not isinstance(counts, dict):
        raise RecoveryError("manifest_counts_invalid")
    by_kind = Counter(str(item.get("usageKind") or "") for item in observations)
    by_evidence = Counter(
        str((item.get("evidence") or {}).get("kind") or "") for item in observations
    )
    expected_kind = {key: by_kind[key] for key in sorted(by_kind)}
    expected_evidence = {key: by_evidence[key] for key in sorted(by_evidence)}
    if (
        int(counts.get("observations") or 0) != len(observations)
        or counts.get("byUsageKind") != expected_kind
        or counts.get("byEvidenceKind") != expected_evidence
    ):
        raise RecoveryError("manifest_counts_mismatch")
    return actual


def scan_usage(
    database: os.PathLike[str] | str,
    video_dir: os.PathLike[str] | str,
    *,
    output_path: os.PathLike[str] | str = "",
) -> dict[str, Any]:
    """Read a closed SQLite snapshot and return a sealed canonical manifest."""

    db_path = _resolved_file(database, "source_database")
    projects_path = _resolved_dir(video_dir, "video_directory")
    if output_path:
        _validate_output_destination(
            output_path,
            protected_paths=_sqlite_related_paths(db_path),
            video_dir=projects_path,
        )
    _reject_uncheckpointed_sidecars(db_path)
    before_stat = db_path.stat()
    before_sha = sha256_file(db_path)
    conn = _sqlite_read_only(db_path)
    try:
        quick_check = _quick_check(conn)
        if not _table_exists(conn, "docs") or not _table_exists(conn, "members"):
            raise RecoveryError("source_database_missing_owner_tables")
        members, active_teams = _member_and_team_state(conn)
        owner_map, mapping_warnings = _project_owner_mapping(conn)
        canvas, canvas_warnings = _canvas_observations(conn, members, active_teams)
        video, video_warnings, skipped_projects = _project_observations(
            projects_path, owner_map, members, active_teams
        )
    finally:
        conn.close()
    after_stat = db_path.stat()
    after_sha = sha256_file(db_path)
    _reject_uncheckpointed_sidecars(db_path)
    if (
        before_sha != after_sha
        or before_stat.st_size != after_stat.st_size
        or before_stat.st_mtime_ns != after_stat.st_mtime_ns
    ):
        raise RecoveryError("source_database_changed_during_scan")

    observations_by_id: dict[str, dict[str, Any]] = {}
    duplicate_warnings: list[dict[str, str]] = []
    for observation in canvas + video:
        key = str(observation["observationId"])
        existing = observations_by_id.get(key)
        if existing is not None and existing != observation:
            raise RecoveryConflict("observation_identity_collision")
        if existing is not None:
            duplicate_warnings.append(_warning("duplicate_observation_reused", "observation", key))
        observations_by_id[key] = observation
    observations = [observations_by_id[key] for key in sorted(observations_by_id)]
    warnings = mapping_warnings + canvas_warnings + video_warnings + duplicate_warnings
    warnings = sorted(
        {json.dumps(item, sort_keys=True, ensure_ascii=False): item for item in warnings}.values(),
        key=lambda item: _canonical_bytes(item),
    )
    by_kind = Counter(str(item["usageKind"]) for item in observations)
    by_evidence = Counter(str(item["evidence"]["kind"]) for item in observations)
    unrecoverable = [
        {
            "kind": "director-llm",
            "scope": "historical-video-workshop",
            "reason": "authoritative per-call token and provider usage was not durably retained",
            "recoveredObservations": 0,
        },
        {
            "kind": "static-video-tts-exact-attempts-and-tokens",
            "scope": "historical-video-workshop",
            "reason": "billingUsage proves characters and a minimum successful call, not exact attempts or tokens",
            "recoveredAs": "minimum-confirmed-only",
        },
    ]
    payload = {
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "mode": "read-only-evidence-scan",
        "source": {
            "database": {
                "path": str(db_path),
                "sha256": before_sha,
                "size": before_stat.st_size,
                "quickCheck": quick_check,
            },
            "videoDirectory": str(projects_path),
        },
        "counts": {
            "observations": len(observations),
            "byUsageKind": {key: by_kind[key] for key in sorted(by_kind)},
            "byEvidenceKind": {key: by_evidence[key] for key in sorted(by_evidence)},
            "warnings": len(warnings),
            "skippedVideoProjects": skipped_projects,
        },
        "warnings": warnings,
        "unrecoverable": unrecoverable,
        "observations": observations,
    }
    return _seal_manifest(payload)


def _load_manifest(path: os.PathLike[str] | str) -> tuple[dict[str, Any], Path]:
    manifest_path = _resolved_file(path, "manifest")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RecoveryError("manifest_json_invalid") from exc
    if not isinstance(manifest, dict):
        raise RecoveryError("manifest_json_invalid")
    verify_manifest(manifest)
    return manifest, manifest_path


def _require_hex_sha(value: str, label: str) -> str:
    normalized = str(value or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", normalized):
        raise RecoveryError(f"{label}_invalid")
    return normalized


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row[1]) for row in conn.execute(f"PRAGMA table_info({table})")}


def _validate_target_schema(conn: sqlite3.Connection) -> None:
    if not _table_exists(conn, "schema_migrations"):
        raise RecoveryError("target_schema_migrations_missing")
    placeholders = ",".join("?" for _ in REQUIRED_MIGRATIONS)
    rows = conn.execute(
        "SELECT version,name,checksum,status,finished_at FROM schema_migrations "
        f"WHERE version IN ({placeholders})",
        tuple(REQUIRED_MIGRATIONS),
    ).fetchall()
    found = {int(row[0]): row for row in rows}
    for version, expected_name in REQUIRED_MIGRATIONS.items():
        row = found.get(version)
        if (
            row is None
            or str(row[1]) != expected_name
            or str(row[2] or "").lower() != REQUIRED_MIGRATION_CHECKSUMS[version]
            or str(row[3]) != "success"
            or row[4] is None
        ):
            raise RecoveryError(f"target_required_migration_missing_or_dirty:{version}")
    if not _table_exists(conn, "members") or not _table_exists(conn, "team_members"):
        raise RecoveryError("target_model_usage_authority_schema_missing")
    if not _table_exists(conn, "model_usage_receipts") or not _table_exists(
        conn, "model_usage_outbox"
    ):
        raise RecoveryError("target_model_usage_schema_missing")
    if not REQUIRED_RECEIPT_COLUMNS.issubset(_columns(conn, "model_usage_receipts")):
        raise RecoveryError("target_model_usage_receipts_schema_incomplete")
    if not REQUIRED_OUTBOX_COLUMNS.issubset(_columns(conn, "model_usage_outbox")):
        raise RecoveryError("target_model_usage_outbox_schema_incomplete")
    indexes = {
        str(row[0])
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN "
            "('model_usage_receipts','model_usage_outbox')"
        )
    }
    if not REQUIRED_USAGE_INDEXES.issubset(indexes):
        raise RecoveryError("target_model_usage_indexes_incomplete")


def _validate_projection_schema(conn: sqlite3.Connection) -> None:
    required = {
        "llm_usage_events": {
            "id", "member_id", "member_name", "feature", "model",
            "prompt_tokens", "completion_tokens", "total_tokens", "created_at",
        },
        "api_usage_events": {
            "id", "member_id", "member_name", "api_type", "feature", "model",
            "calls", "output_units", "unit_label", "created_at",
        },
    }
    for table, columns in required.items():
        if not _table_exists(conn, table) or not columns.issubset(_columns(conn, table)):
            raise RecoveryError(f"target_legacy_usage_schema_incomplete:{table}")


def _legacy_event_id(receipt_id: str, usage_kind: str) -> str:
    digest = hashlib.sha256(
        f"legacy-model-usage-v1|{usage_kind}|{receipt_id}".encode("utf-8")
    ).hexdigest()
    return "mup_" + digest[:28]


def _checkpoint_after_commit(conn: sqlite3.Connection, journal_mode: str) -> None:
    if journal_mode != "wal":
        return
    checkpoint = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
    if checkpoint and int(checkpoint[0] or 0) != 0:
        raise RecoveryError("target_wal_checkpoint_busy_after_commit")


def _manifest_pending_count(
    conn: sqlite3.Connection, observations: Iterable[Mapping[str, Any]]
) -> int:
    receipt_ids = [str(item["receiptId"]) for item in observations]
    if not receipt_ids:
        return 0
    placeholders = ",".join("?" for _ in receipt_ids)
    return int(
        conn.execute(
            "SELECT COUNT(*) FROM model_usage_outbox WHERE state IN ('pending','retry') "
            f"AND receipt_id IN ({placeholders})",
            receipt_ids,
        ).fetchone()[0]
    )


def _verify_legacy_projection(
    conn: sqlite3.Connection,
    observation: Mapping[str, Any],
    values: tuple[Any, ...],
    *,
    insert: bool,
) -> tuple[str, str]:
    usage_kind = str(observation["usageKind"])
    receipt_id = str(observation["receiptId"])
    legacy_id = _legacy_event_id(receipt_id, usage_kind)
    # Values follow RECEIPT_COLUMN_ORDER.  Keeping projection based on these
    # authority-resolved values makes it byte-compatible with the application
    # reconciler while remaining independent from importing the store.
    if usage_kind == "llm" and int(values[18] or 0) > 0:
        expected = (
            values[2], values[3], values[6], str(values[9] or ""),
            int(values[16] or 0), int(values[17] or 0), int(values[18] or 0),
            int(values[24]),
        )
        if insert:
            conn.execute(
                "INSERT OR IGNORE INTO llm_usage_events("
                "id,member_id,member_name,feature,model,prompt_tokens,completion_tokens,"
                "total_tokens,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                (legacy_id, *expected),
            )
        stored = conn.execute(
            "SELECT member_id,member_name,feature,COALESCE(model,''),prompt_tokens,"
            "completion_tokens,total_tokens,created_at FROM llm_usage_events WHERE id=?",
            (legacy_id,),
        ).fetchone()
        if tuple(stored or ()) != expected:
            raise RecoveryConflict(f"legacy_usage_event_collision:{receipt_id}")
        return "llm_usage_events", legacy_id
    if usage_kind in {"image", "video", "voice"}:
        unit_label = str(values[21] or "任务")
        expected = (
            values[2], values[3], usage_kind, values[6], str(values[9] or ""),
            int(values[19] or 0), int(values[20] or 0), unit_label,
            int(values[24]),
        )
        if insert:
            conn.execute(
                "INSERT OR IGNORE INTO api_usage_events("
                "id,member_id,member_name,api_type,feature,model,calls,output_units,"
                "unit_label,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (legacy_id, *expected),
            )
        stored = conn.execute(
            "SELECT member_id,member_name,api_type,feature,COALESCE(model,''),calls,"
            "output_units,unit_label,created_at FROM api_usage_events WHERE id=?",
            (legacy_id,),
        ).fetchone()
        if tuple(stored or ()) != expected:
            raise RecoveryConflict(f"legacy_usage_event_collision:{receipt_id}")
        return "api_usage_events", legacy_id
    return "receipt_only", ""


def _authority(
    conn: sqlite3.Connection, member_id: str, requested_team_id: str
) -> tuple[str, str, str]:
    member = conn.execute(
        "SELECT id,name FROM members WHERE id=?", (member_id,)
    ).fetchone()
    if not member:
        raise RecoveryConflict(f"model_usage_member_not_found:{member_id}")
    teams = [
        str(row[0])
        for row in conn.execute(
            "SELECT team_id FROM team_members WHERE member_id=? AND status='active' "
            "ORDER BY team_id",
            (member_id,),
        )
        if str(row[0] or "")
    ]
    requested = str(requested_team_id or "").strip()
    if requested:
        if requested not in teams:
            raise RecoveryConflict(f"model_usage_team_mismatch:{member_id}")
        team_id = requested
    elif len(teams) > 1:
        raise RecoveryConflict(f"model_usage_team_ambiguous:{member_id}")
    else:
        team_id = teams[0] if teams else ""
    return str(member[0]), str(member[1] or "\u6210\u5458")[:120], team_id


def _receipt_values(
    observation: Mapping[str, Any], member_name: str, team_id: str
) -> tuple[Any, ...]:
    event_at = observation.get("eventAt")
    if (
        not isinstance(event_at, int)
        or isinstance(event_at, bool)
        or event_at <= 0
    ):
        raise RecoveryError("observation_event_at_required_for_apply")
    timestamp = int(event_at)
    return (
        observation["receiptId"],
        observation["receiptKey"],
        observation["ownerId"],
        member_name,
        team_id,
        observation["surface"],
        observation["feature"],
        observation["usageKind"],
        observation["provider"],
        observation["model"],
        observation["operation"],
        observation["operationId"],
        observation["idempotencyKey"],
        observation["requestFingerprint"],
        observation["providerRef"],
        observation["callStatus"],
        int(observation["promptTokens"]),
        int(observation["completionTokens"]),
        int(observation["totalTokens"]),
        int(observation["calls"]),
        int(observation["outputUnits"]),
        observation["unitLabel"],
        observation["source"],
        "",
        event_at,
        timestamp,
        timestamp,
        timestamp,
    )


RECEIPT_COLUMN_ORDER = (
    "receipt_id",
    "receipt_key",
    "member_id",
    "member_name",
    "team_id",
    "surface",
    "feature",
    "usage_kind",
    "provider",
    "model",
    "operation",
    "operation_id",
    "idempotency_key",
    "request_fingerprint",
    "provider_ref",
    "call_status",
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "calls",
    "output_units",
    "unit_label",
    "source",
    "error",
    "event_at",
    "created_at",
    "updated_at",
    "completed_at",
)


def _existing_receipt(
    conn: sqlite3.Connection, observation: Mapping[str, Any]
) -> Optional[sqlite3.Row]:
    rows = conn.execute(
        "SELECT " + ",".join(RECEIPT_COLUMN_ORDER) + " FROM model_usage_receipts "
        "WHERE receipt_id=? OR receipt_key=? OR "
        "(source=? AND member_id=? AND idempotency_key=?)",
        (
            observation["receiptId"],
            observation["receiptKey"],
            RECOVERY_SOURCE,
            observation["ownerId"],
            observation["idempotencyKey"],
        ),
    ).fetchall()
    if len(rows) > 1:
        raise RecoveryConflict(
            f"multiple_model_usage_receipt_identity_conflict:{observation['receiptId']}"
        )
    return rows[0] if rows else None


def _preflight_observations(
    conn: sqlite3.Connection, observations: Iterable[Mapping[str, Any]]
) -> tuple[list[tuple[Mapping[str, Any], tuple[Any, ...]]], int]:
    inserts: list[tuple[Mapping[str, Any], tuple[Any, ...]]] = []
    reused = 0
    for observation in observations:
        owner_id, member_name, team_id = _authority(
            conn,
            str(observation["ownerId"]),
            str(observation.get("teamId") or ""),
        )
        if owner_id != observation["ownerId"]:
            raise RecoveryConflict("model_usage_owner_mismatch")
        values = _receipt_values(observation, member_name, team_id)
        existing = _existing_receipt(conn, observation)
        if existing is None:
            inserts.append((observation, values))
            continue
        stored = tuple(existing[column] for column in RECEIPT_COLUMN_ORDER)
        if stored != values:
            raise RecoveryConflict(
                f"existing_model_usage_receipt_conflict:{observation['receiptId']}"
            )
        outbox = conn.execute(
            "SELECT receipt_id,state FROM model_usage_outbox WHERE receipt_id=?",
            (observation["receiptId"],),
        ).fetchone()
        if not outbox or str(outbox[0]) != observation["receiptId"]:
            raise RecoveryConflict(
                f"existing_model_usage_outbox_missing:{observation['receiptId']}"
            )
        if str(outbox[1]) not in {"pending", "retry", "projected", "conflict"}:
            raise RecoveryConflict(
                f"existing_model_usage_outbox_state_conflict:{observation['receiptId']}"
            )
        reused += 1
    return inserts, reused


def apply_manifest(
    manifest_path: os.PathLike[str] | str,
    target_database: os.PathLike[str] | str,
    *,
    confirm_manifest_sha256: str,
    expected_db_sha256: str,
    output_path: os.PathLike[str] | str = "",
) -> dict[str, Any]:
    """Append a verified manifest to a migrated SQLite copy.

    When the target hash has changed since the original snapshot, this function
    permits only a fully reused no-op.  It can therefore be run twice without
    weakening the first-apply byte-identity gate.
    """

    manifest, resolved_manifest_path = _load_manifest(manifest_path)
    source_metadata = manifest.get("source")
    source_metadata = source_metadata if isinstance(source_metadata, dict) else {}
    source_database_metadata = source_metadata.get("database")
    source_database_metadata = (
        source_database_metadata if isinstance(source_database_metadata, dict) else {}
    )
    if output_path:
        protected_paths: list[os.PathLike[str] | str] = [resolved_manifest_path]
        protected_paths.extend(
            _sqlite_related_paths(source_database_metadata.get("path") or "")
        )
        protected_paths.extend(_sqlite_related_paths(target_database))
        _validate_output_destination(
            output_path,
            protected_paths=protected_paths,
            video_dir=source_metadata.get("videoDirectory") or "",
        )
    actual_manifest_sha = str(manifest["manifestSha256"])
    confirmed_manifest_sha = _require_hex_sha(
        confirm_manifest_sha256, "confirm_manifest_sha256"
    )
    if confirmed_manifest_sha != actual_manifest_sha:
        raise RecoveryError("confirm_manifest_sha256_mismatch")
    expected_sha = _require_hex_sha(expected_db_sha256, "expected_db_sha256")

    source_meta = source_metadata
    database_meta = source_database_metadata
    source_path = _resolved_file(database_meta.get("path") or "", "manifest_source_database")
    source_sha = _require_hex_sha(database_meta.get("sha256") or "", "manifest_source_sha256")
    _reject_uncheckpointed_sidecars(source_path)
    try:
        declared_source_size = int(database_meta.get("size"))
    except (TypeError, ValueError, OverflowError) as exc:
        raise RecoveryError("manifest_source_database_size_invalid") from exc
    if source_path.stat().st_size != declared_source_size:
        raise RecoveryError("manifest_source_database_size_changed")
    if sha256_file(source_path) != source_sha:
        raise RecoveryError("manifest_source_database_sha256_changed")
    target_path = _resolved_file(target_database, "target_database")
    _validate_copy_target(source_path, target_path)
    _reject_uncheckpointed_sidecars(target_path)
    before_stat = target_path.stat()
    before_sha = sha256_file(target_path)
    if before_sha != expected_sha:
        raise RecoveryError("expected_db_sha256_mismatch")

    conn = sqlite3.connect(str(target_path), timeout=5)
    conn.row_factory = sqlite3.Row
    inserted = 0
    reused = 0
    mode = "append-only"
    committed = False
    pending = 0
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        journal_mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0] or "").lower()
        quick_before = _quick_check(conn)
        _validate_target_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        inserts, reused = _preflight_observations(conn, manifest["observations"])
        if before_sha != source_sha:
            if inserts:
                raise RecoveryError(
                    "target_database_drifted_new_inserts_forbidden;"
                    "only_an_exact_reuse_noop_is_allowed"
                )
            mode = "reuse-only"
            conn.rollback()
        else:
            placeholders = ",".join("?" for _ in RECEIPT_COLUMN_ORDER)
            insert_sql = (
                "INSERT INTO model_usage_receipts("
                + ",".join(RECEIPT_COLUMN_ORDER)
                + f") VALUES({placeholders})"
            )
            for observation, values in inserts:
                conn.execute(insert_sql, values)
                timestamp = int(observation["eventAt"])
                conn.execute(
                    "INSERT INTO model_usage_outbox("
                    "receipt_id,state,attempts,available_at,last_error,legacy_event_kind,"
                    "legacy_event_id,created_at,updated_at,projected_at"
                    ") VALUES(?,'pending',0,?,'','','',?,?,NULL)",
                    (observation["receiptId"], timestamp, timestamp, timestamp),
                )
                inserted += 1
            conn.commit()
            committed = True
            if inserted:
                _checkpoint_after_commit(conn, journal_mode)
        quick_after = _quick_check(conn)
        pending = _manifest_pending_count(conn, manifest["observations"])
    except Exception as exc:
        if conn.in_transaction:
            conn.rollback()
        if committed and not isinstance(exc, RecoveryCommittedAfterError):
            raise RecoveryCommittedAfterError("apply-post-commit", exc) from exc
        raise
    finally:
        conn.close()

    _reject_uncheckpointed_sidecars(target_path)
    after_stat = target_path.stat()
    after_sha = sha256_file(target_path)
    return {
        "schemaVersion": APPLY_REPORT_SCHEMA_VERSION,
        "mode": mode,
        "appendOnly": True,
        "committed": committed,
        "manifest": {
            "path": str(resolved_manifest_path),
            "sha256": actual_manifest_sha,
        },
        "targetDatabase": {
            "path": str(target_path),
            "sizeBefore": before_stat.st_size,
            "sha256Before": before_sha,
            "quickCheckBefore": quick_before,
            "sizeAfter": after_stat.st_size,
            "sha256After": after_sha,
            "quickCheckAfter": quick_after,
        },
        "counts": {
            "observations": len(manifest["observations"]),
            "inserted": inserted,
            "reused": reused,
            "pending": pending,
        },
    }


def reconcile_copy(
    manifest_path: os.PathLike[str] | str,
    target_database: os.PathLike[str] | str,
    *,
    confirm_manifest_sha256: str,
    expected_db_sha256: str,
    output_path: os.PathLike[str] | str = "",
) -> dict[str, Any]:
    """Project manifest receipts inside an explicitly verified database copy."""

    manifest, resolved_manifest_path = _load_manifest(manifest_path)
    source_metadata = manifest.get("source")
    source_metadata = source_metadata if isinstance(source_metadata, dict) else {}
    database_metadata = source_metadata.get("database")
    database_metadata = database_metadata if isinstance(database_metadata, dict) else {}
    if output_path:
        protected_paths: list[os.PathLike[str] | str] = [resolved_manifest_path]
        protected_paths.extend(_sqlite_related_paths(database_metadata.get("path") or ""))
        protected_paths.extend(_sqlite_related_paths(target_database))
        _validate_output_destination(
            output_path,
            protected_paths=protected_paths,
            video_dir=source_metadata.get("videoDirectory") or "",
        )
    actual_manifest_sha = str(manifest["manifestSha256"])
    if _require_hex_sha(
        confirm_manifest_sha256, "confirm_manifest_sha256"
    ) != actual_manifest_sha:
        raise RecoveryError("confirm_manifest_sha256_mismatch")
    expected_sha = _require_hex_sha(expected_db_sha256, "expected_db_sha256")

    source_path = _resolved_file(
        database_metadata.get("path") or "", "manifest_source_database"
    )
    source_sha = _require_hex_sha(
        database_metadata.get("sha256") or "", "manifest_source_sha256"
    )
    _reject_uncheckpointed_sidecars(source_path)
    if sha256_file(source_path) != source_sha:
        raise RecoveryError("manifest_source_database_sha256_changed")
    target_path = _resolved_file(target_database, "target_database")
    _validate_copy_target(source_path, target_path)
    _reject_uncheckpointed_sidecars(target_path)
    before_stat = target_path.stat()
    before_sha = sha256_file(target_path)
    if before_sha != expected_sha:
        raise RecoveryError("expected_db_sha256_mismatch")

    conn = sqlite3.connect(str(target_path), timeout=5)
    conn.row_factory = sqlite3.Row
    projected = 0
    reused = 0
    pending = 0
    committed = False
    mode = "project-copy"
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA busy_timeout=5000")
        journal_mode = str(conn.execute("PRAGMA journal_mode").fetchone()[0] or "").lower()
        quick_before = _quick_check(conn)
        _validate_target_schema(conn)
        _validate_projection_schema(conn)
        conn.execute("BEGIN IMMEDIATE")
        inserts, _ = _preflight_observations(conn, manifest["observations"])
        if inserts:
            raise RecoveryError("manifest_receipts_not_applied_to_target_copy")
        for observation in manifest["observations"]:
            _, member_name, team_id = _authority(
                conn,
                str(observation["ownerId"]),
                str(observation.get("teamId") or ""),
            )
            values = _receipt_values(observation, member_name, team_id)
            outbox = conn.execute(
                "SELECT state,legacy_event_kind,legacy_event_id FROM model_usage_outbox "
                "WHERE receipt_id=?",
                (observation["receiptId"],),
            ).fetchone()
            state = str(outbox[0] or "") if outbox else ""
            if state in {"pending", "retry"}:
                legacy_kind, legacy_id = _verify_legacy_projection(
                    conn, observation, values, insert=True
                )
                timestamp = int(observation["eventAt"])
                conn.execute(
                    "UPDATE model_usage_outbox SET state='projected',legacy_event_kind=?,"
                    "legacy_event_id=?,last_error='',updated_at=?,projected_at=? "
                    "WHERE receipt_id=? AND state IN ('pending','retry')",
                    (legacy_kind, legacy_id, timestamp, timestamp, observation["receiptId"]),
                )
                projected += 1
            elif state == "projected":
                legacy_kind, legacy_id = _verify_legacy_projection(
                    conn, observation, values, insert=False
                )
                if (str(outbox[1] or ""), str(outbox[2] or "")) != (
                    legacy_kind,
                    legacy_id,
                ):
                    raise RecoveryConflict(
                        f"existing_model_usage_projection_conflict:{observation['receiptId']}"
                    )
                reused += 1
            else:
                raise RecoveryConflict(
                    f"model_usage_outbox_not_reconcilable:{observation['receiptId']}:{state}"
                )
        if projected:
            conn.commit()
            committed = True
            _checkpoint_after_commit(conn, journal_mode)
        else:
            mode = "reuse-only"
            conn.rollback()
        quick_after = _quick_check(conn)
        pending = _manifest_pending_count(conn, manifest["observations"])
        if pending:
            raise RecoveryError("manifest_outbox_pending_after_reconcile")
    except Exception as exc:
        if conn.in_transaction:
            conn.rollback()
        if committed and not isinstance(exc, RecoveryCommittedAfterError):
            raise RecoveryCommittedAfterError("reconcile-post-commit", exc) from exc
        raise
    finally:
        conn.close()

    _reject_uncheckpointed_sidecars(target_path)
    after_stat = target_path.stat()
    after_sha = sha256_file(target_path)
    return {
        "schemaVersion": APPLY_REPORT_SCHEMA_VERSION,
        "mode": mode,
        "copyOnly": True,
        "appendOnlyLegacyEvents": True,
        "committed": committed,
        "manifest": {"path": str(resolved_manifest_path), "sha256": actual_manifest_sha},
        "targetDatabase": {
            "path": str(target_path),
            "sizeBefore": before_stat.st_size,
            "sha256Before": before_sha,
            "quickCheckBefore": quick_before,
            "sizeAfter": after_stat.st_size,
            "sha256After": after_sha,
            "quickCheckAfter": quick_after,
        },
        "counts": {
            "observations": len(manifest["observations"]),
            "projected": projected,
            "reused": reused,
            "pending": pending,
        },
    }


def _write_canonical_json(path: os.PathLike[str] | str, payload: Mapping[str, Any]) -> None:
    raw_destination = Path(path).expanduser()
    destination = raw_destination.resolve()
    if os.path.lexists(raw_destination) or os.path.lexists(destination):
        raise RecoveryError(f"output_path_already_exists:{destination}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    data = _canonical_bytes(payload) + b"\n"
    temporary: Optional[Path] = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", dir=destination.parent, prefix=destination.name + ".", delete=False
        ) as handle:
            temporary = Path(handle.name)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            # Linking a completed same-directory temporary file is atomic and,
            # unlike os.replace(), cannot overwrite a path created after the
            # preflight check.
            os.link(temporary, destination)
        except FileExistsError as exc:
            raise RecoveryError(f"output_path_already_exists:{destination}") from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _emit(payload: Mapping[str, Any], output: str = "") -> None:
    if output:
        _write_canonical_json(output, payload)
    sys.stdout.buffer.write(_canonical_bytes(payload) + b"\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Offline, evidence-only recovery of historical model usage. "
            "The tool never imports the application store or contacts a server."
        )
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    scan = subparsers.add_parser(
        "scan", help="read a closed SQLite snapshot and build a canonical manifest"
    )
    scan.add_argument("--database", required=True, help="read-only SQLite snapshot")
    scan.add_argument("--video-dir", required=True, help="video-workshop projects directory")
    scan.add_argument("--output", help="optional manifest output path")

    apply = subparsers.add_parser(
        "apply", help="append a confirmed manifest to a distinct migrated DB copy"
    )
    apply.add_argument("--manifest", required=True, help="canonical scan manifest")
    apply.add_argument("--target-database", required=True, help="distinct SQLite copy")
    apply.add_argument(
        "--confirm-manifest-sha256",
        required=True,
        help="exact manifestSha256 printed by scan",
    )
    apply.add_argument(
        "--expected-db-sha256",
        required=True,
        help="exact SHA-256 of the target immediately before this invocation",
    )
    apply.add_argument("--output", help="optional apply-report output path")
    reconcile = subparsers.add_parser(
        "reconcile-copy",
        help="project applied manifest receipts inside a distinct SQLite copy",
    )
    reconcile.add_argument("--manifest", required=True, help="canonical scan manifest")
    reconcile.add_argument("--target-database", required=True, help="distinct SQLite copy")
    reconcile.add_argument(
        "--confirm-manifest-sha256",
        required=True,
        help="exact manifestSha256 printed by scan",
    )
    reconcile.add_argument(
        "--expected-db-sha256",
        required=True,
        help="exact SHA-256 of the target immediately before this invocation",
    )
    reconcile.add_argument("--output", help="optional reconciliation-report output path")
    return parser


def main(argv: Optional[list[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "scan":
            payload = scan_usage(
                args.database,
                args.video_dir,
                output_path=str(args.output or ""),
            )
        elif args.command == "apply":
            payload = apply_manifest(
                args.manifest,
                args.target_database,
                confirm_manifest_sha256=args.confirm_manifest_sha256,
                expected_db_sha256=args.expected_db_sha256,
                output_path=str(args.output or ""),
            )
        else:
            payload = reconcile_copy(
                args.manifest,
                args.target_database,
                confirm_manifest_sha256=args.confirm_manifest_sha256,
                expected_db_sha256=args.expected_db_sha256,
                output_path=str(args.output or ""),
            )
        _emit(payload, str(args.output or ""))
        return 0
    except (RecoveryError, RecoveryConflict, sqlite3.Error, OSError) as exc:
        error_payload = {
            "ok": False,
            "error": exc.__class__.__name__,
            "detail": str(exc),
        }
        if isinstance(exc, RecoveryCommittedAfterError):
            error_payload.update({
                "committed": True,
                "replaySafe": True,
                "phase": exc.phase,
                "nextAction": "verify-copy-hash-and-quick-check-before-replay",
            })
        print(
            json.dumps(error_payload, ensure_ascii=False, sort_keys=True),
            file=sys.stderr,
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
