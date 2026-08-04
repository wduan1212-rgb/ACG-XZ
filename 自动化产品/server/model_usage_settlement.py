"""Validate one exact, operator-reviewed model-usage settlement plan.

The plan never discovers work to settle.  It names every operation explicitly
and binds both the central receipt and the authoritative video-workshop receipt
by SHA-256.  Sidecar evidence is read only from the already verified complete
runtime snapshot, never from the mutable live project directory.
"""

from __future__ import annotations

import hashlib
import json
import re
import tarfile
from datetime import datetime
from pathlib import Path
from typing import Any


PLAN_FORMAT = "acg-model-usage-settlement-plan-v1"
PLAN_MAX_BYTES = 1024 * 1024
PROJECT_MAX_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 100
OPERATION_RE = re.compile(r"[A-Za-z0-9._:/+\-]{1,180}")
HEX_16_RE = re.compile(r"[0-9a-f]{16}")
HEX_64_RE = re.compile(r"[0-9a-f]{64}")
RESOLUTIONS = {
    "sidecar-succeeded",
    "operator-confirmed-unknown",
}
PLAN_KEYS = {
    "format",
    "databaseIdentity",
    "snapshotManifestSha256",
    "snapshotMediaInventoryDigest",
    "reviewedBy",
    "reviewedAt",
    "entries",
}
ENTRY_KEYS = {
    "operationId",
    "centralReceiptSha256",
    "sidecarReceiptSha256",
    "resolution",
    "operatorReviewed",
    "reviewNote",
}


class SettlementPlanError(ValueError):
    """The reviewed plan or its snapshot evidence is not exact and safe."""


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _clean_text(value: Any, *, field: str, limit: int, required: bool = True) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise SettlementPlanError(f"{field}_required")
    if len(text) > limit:
        raise SettlementPlanError(f"{field}_too_long")
    return text


def _validated_reviewed_at(value: Any) -> str:
    text = _clean_text(value, field="reviewedAt", limit=64)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SettlementPlanError("reviewedAt_invalid") from exc
    if parsed.tzinfo is None:
        raise SettlementPlanError("reviewedAt_timezone_required")
    return text


def load_review_plan(path: Path, *, expected_sha256: str) -> tuple[dict, str]:
    expected = str(expected_sha256 or "").strip().lower()
    if not HEX_64_RE.fullmatch(expected):
        raise SettlementPlanError("plan_sha256_confirmation_invalid")
    raw = Path(path).read_bytes()
    if not raw or len(raw) > PLAN_MAX_BYTES:
        raise SettlementPlanError("plan_size_invalid")
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected:
        raise SettlementPlanError("plan_sha256_confirmation_mismatch")
    try:
        plan = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SettlementPlanError("plan_json_invalid") from exc
    if not isinstance(plan, dict) or set(plan) != PLAN_KEYS:
        raise SettlementPlanError("plan_fields_invalid")
    if plan.get("format") != PLAN_FORMAT:
        raise SettlementPlanError("plan_format_invalid")
    identity = str(plan.get("databaseIdentity") or "").strip().lower()
    if not HEX_16_RE.fullmatch(identity):
        raise SettlementPlanError("plan_database_identity_invalid")
    for field in ("snapshotManifestSha256", "snapshotMediaInventoryDigest"):
        digest = str(plan.get(field) or "").strip().lower()
        if not HEX_64_RE.fullmatch(digest):
            raise SettlementPlanError(f"plan_{field}_invalid")
        plan[field] = digest
    plan["databaseIdentity"] = identity
    plan["reviewedBy"] = _clean_text(
        plan.get("reviewedBy"), field="reviewedBy", limit=120,
    )
    plan["reviewedAt"] = _validated_reviewed_at(plan.get("reviewedAt"))
    entries = plan.get("entries")
    if not isinstance(entries, list) or not entries or len(entries) > MAX_ENTRIES:
        raise SettlementPlanError("plan_entries_invalid")
    normalized = []
    seen = set()
    for item in entries:
        if not isinstance(item, dict) or set(item) != ENTRY_KEYS:
            raise SettlementPlanError("plan_entry_fields_invalid")
        operation_id = str(item.get("operationId") or "").strip()
        if not OPERATION_RE.fullmatch(operation_id):
            raise SettlementPlanError("plan_operation_id_invalid")
        if operation_id in seen:
            raise SettlementPlanError("plan_operation_id_duplicate")
        seen.add(operation_id)
        resolution = str(item.get("resolution") or "").strip()
        if resolution not in RESOLUTIONS:
            raise SettlementPlanError("plan_resolution_invalid")
        if item.get("operatorReviewed") is not True:
            raise SettlementPlanError("plan_operator_review_required")
        note = _clean_text(
            item.get("reviewNote"), field="reviewNote", limit=500,
            required=resolution == "operator-confirmed-unknown",
        )
        if resolution == "operator-confirmed-unknown" and len(note) < 10:
            raise SettlementPlanError("plan_unknown_review_note_too_short")
        normalized_item = {
            "operationId": operation_id,
            "centralReceiptSha256": str(
                item.get("centralReceiptSha256") or ""
            ).strip().lower(),
            "sidecarReceiptSha256": str(
                item.get("sidecarReceiptSha256") or ""
            ).strip().lower(),
            "resolution": resolution,
            "operatorReviewed": True,
            "reviewNote": note,
        }
        for field in ("centralReceiptSha256", "sidecarReceiptSha256"):
            if not HEX_64_RE.fullmatch(normalized_item[field]):
                raise SettlementPlanError(f"plan_{field}_invalid")
        normalized.append(normalized_item)
    if [item["operationId"] for item in normalized] != sorted(seen):
        raise SettlementPlanError("plan_entries_must_be_sorted")
    plan["entries"] = normalized
    return plan, actual


def _snapshot_video_project_artifact(snapshot_root: Path) -> Path:
    manifest_path = Path(snapshot_root) / "snapshot.manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SettlementPlanError("snapshot_manifest_unreadable") from exc
    components = manifest.get("components") if isinstance(manifest, dict) else None
    matches = [
        item for item in list(components or [])
        if isinstance(item, dict) and item.get("name") == "video-projects"
    ]
    if len(matches) != 1:
        raise SettlementPlanError("snapshot_video_projects_component_invalid")
    component = matches[0]
    if component.get("type") != "directory" or component.get("state") == "absent":
        raise SettlementPlanError("snapshot_video_projects_component_unavailable")
    artifact_name = str(component.get("artifact") or "")
    if not re.fullmatch(r"[A-Za-z0-9._-]+", artifact_name):
        raise SettlementPlanError("snapshot_video_projects_artifact_invalid")
    artifact = Path(snapshot_root) / artifact_name
    if not artifact.is_file():
        raise SettlementPlanError("snapshot_video_projects_artifact_missing")
    return artifact


def extract_sidecar_receipts(
    snapshot_root: Path,
    operation_ids: list[str],
) -> dict[str, dict]:
    """Return only exact reviewed operation receipts from the verified archive."""

    requested = set(operation_ids)
    if not requested or len(requested) != len(operation_ids):
        raise SettlementPlanError("sidecar_operation_set_invalid")
    if any(not OPERATION_RE.fullmatch(str(item or "")) for item in requested):
        raise SettlementPlanError("sidecar_operation_id_invalid")
    found: dict[str, dict] = {}
    artifact = _snapshot_video_project_artifact(Path(snapshot_root))
    try:
        bundle = tarfile.open(artifact, "r")
    except (OSError, tarfile.TarError) as exc:
        raise SettlementPlanError("snapshot_video_projects_archive_invalid") from exc
    with bundle:
        for member in bundle:
            if member.issym() or member.islnk() or not (
                member.isfile() or member.isdir()
            ):
                raise SettlementPlanError("snapshot_video_projects_member_unsafe")
            if member.isdir() or not member.name.endswith(".json"):
                continue
            if member.size < 0 or member.size > PROJECT_MAX_BYTES:
                raise SettlementPlanError("snapshot_video_project_size_invalid")
            stream = bundle.extractfile(member)
            if stream is None:
                raise SettlementPlanError("snapshot_video_project_unreadable")
            raw = stream.read(PROJECT_MAX_BYTES + 1)
            if len(raw) != member.size or len(raw) > PROJECT_MAX_BYTES:
                raise SettlementPlanError("snapshot_video_project_size_mismatch")
            try:
                project = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise SettlementPlanError("snapshot_video_project_json_invalid") from exc
            if not isinstance(project, dict):
                raise SettlementPlanError("snapshot_video_project_invalid")
            project_id = str(project.get("id") or "").strip()
            receipts = project.get("modelUsageReceipts") or []
            if not isinstance(receipts, list):
                raise SettlementPlanError("snapshot_sidecar_receipts_invalid")
            for receipt in receipts:
                if not isinstance(receipt, dict):
                    raise SettlementPlanError("snapshot_sidecar_receipt_invalid")
                operation_id = str(receipt.get("operationId") or "").strip()
                if operation_id not in requested:
                    continue
                if operation_id in found:
                    raise SettlementPlanError("snapshot_sidecar_operation_duplicate")
                if (
                    str(receipt.get("surface") or "") != "video-workshop"
                    or not project_id
                    or str(receipt.get("projectId") or "") != project_id
                ):
                    raise SettlementPlanError("snapshot_sidecar_receipt_identity_invalid")
                found[operation_id] = receipt
    missing = sorted(requested - set(found))
    if missing:
        raise SettlementPlanError(
            "snapshot_sidecar_receipt_missing:" + ",".join(missing)
        )
    return found


def verify_sidecar_hashes(plan: dict, receipts: dict[str, dict]) -> None:
    for entry in plan.get("entries") or []:
        operation_id = entry["operationId"]
        receipt = receipts.get(operation_id)
        if receipt is None or canonical_sha256(receipt) != entry["sidecarReceiptSha256"]:
            raise SettlementPlanError(
                f"snapshot_sidecar_receipt_hash_mismatch:{operation_id}"
            )
