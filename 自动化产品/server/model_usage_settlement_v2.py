"""Strict reviewed plans for multi-source model-usage settlement.

Version 2 names every central receipt directly.  Video-workshop entries also
bind the unique sidecar receipt from a verified complete snapshot; main and
custom-canvas timeout entries deliberately have no sidecar evidence.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

from . import model_usage_settlement


PLAN_FORMAT = "acg-model-usage-settlement-plan-v2"
PLAN_MAX_BYTES = 2 * 1024 * 1024
MAX_ENTRIES = 200
HEX_16_RE = re.compile(r"[0-9a-f]{16}")
HEX_64_RE = re.compile(r"[0-9a-f]{64}")
ID_RE = re.compile(r"[A-Za-z0-9._:/+\-]{1,220}")
CENTRAL_SOURCES = {"main-provider", "custom-canvas"}
SIDECAR_SOURCE = "video-workshop-sidecar"
RESOLUTIONS = {
    "central-attempt-outcome-unknown",
    "sidecar-attempt-outcome-unknown",
    "sidecar-succeeded",
    "sidecar-submitted-indeterminate",
}
PLAN_KEYS = {
    "format", "databaseIdentity", "snapshotManifestSha256",
    "snapshotMediaInventoryDigest", "reviewedBy", "reviewedAt", "entries",
}
ENTRY_KEYS = {
    "receiptId", "source", "operationId", "centralReceiptSha256",
    "sidecarReceiptSha256", "resolution", "operatorReviewed", "reviewNote",
}


class SettlementPlanV2Error(ValueError):
    pass


def canonical_json_bytes(value: Any) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    ).encode("utf-8")


def canonical_sha256(value: Any) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise SettlementPlanV2Error(f"duplicate_plan_key:{key}")
        result[key] = value
    return result


def _text(value, *, field, limit, required=True):
    text = str(value or "").strip()
    if required and not text:
        raise SettlementPlanV2Error(f"{field}_required")
    if len(text) > limit:
        raise SettlementPlanV2Error(f"{field}_too_long")
    return text


def load_review_plan(path: Path, *, expected_sha256: str):
    expected = str(expected_sha256 or "").strip().lower()
    if not HEX_64_RE.fullmatch(expected):
        raise SettlementPlanV2Error("plan_sha256_confirmation_invalid")
    raw = Path(path).read_bytes()
    if not raw or len(raw) > PLAN_MAX_BYTES:
        raise SettlementPlanV2Error("plan_size_invalid")
    actual = hashlib.sha256(raw).hexdigest()
    if actual != expected:
        raise SettlementPlanV2Error("plan_sha256_confirmation_mismatch")
    try:
        plan = json.loads(raw.decode("utf-8"), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise SettlementPlanV2Error("plan_json_invalid") from exc
    if not isinstance(plan, dict) or set(plan) != PLAN_KEYS:
        raise SettlementPlanV2Error("plan_fields_invalid")
    if plan.get("format") != PLAN_FORMAT:
        raise SettlementPlanV2Error("plan_format_invalid")
    identity = str(plan.get("databaseIdentity") or "").strip().lower()
    if not HEX_16_RE.fullmatch(identity):
        raise SettlementPlanV2Error("plan_database_identity_invalid")
    plan["databaseIdentity"] = identity
    for field in ("snapshotManifestSha256", "snapshotMediaInventoryDigest"):
        digest = str(plan.get(field) or "").strip().lower()
        if not HEX_64_RE.fullmatch(digest):
            raise SettlementPlanV2Error(f"plan_{field}_invalid")
        plan[field] = digest
    plan["reviewedBy"] = _text(
        plan.get("reviewedBy"), field="reviewedBy", limit=120,
    )
    reviewed_at = _text(
        plan.get("reviewedAt"), field="reviewedAt", limit=64,
    )
    try:
        parsed = datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise SettlementPlanV2Error("reviewedAt_invalid") from exc
    if parsed.tzinfo is None:
        raise SettlementPlanV2Error("reviewedAt_timezone_required")
    plan["reviewedAt"] = reviewed_at
    entries = plan.get("entries")
    if not isinstance(entries, list) or not entries or len(entries) > MAX_ENTRIES:
        raise SettlementPlanV2Error("plan_entries_invalid")
    normalized = []
    seen = set()
    for raw_entry in entries:
        if not isinstance(raw_entry, dict) or set(raw_entry) != ENTRY_KEYS:
            raise SettlementPlanV2Error("plan_entry_fields_invalid")
        receipt_id = str(raw_entry.get("receiptId") or "").strip()
        operation_id = str(raw_entry.get("operationId") or "").strip()
        source = str(raw_entry.get("source") or "").strip()
        resolution = str(raw_entry.get("resolution") or "").strip()
        if not ID_RE.fullmatch(receipt_id) or not ID_RE.fullmatch(operation_id):
            raise SettlementPlanV2Error("plan_entry_identity_invalid")
        if receipt_id in seen:
            raise SettlementPlanV2Error("plan_receipt_id_duplicate")
        seen.add(receipt_id)
        if resolution not in RESOLUTIONS:
            raise SettlementPlanV2Error("plan_resolution_invalid")
        if resolution.startswith("central-"):
            if source not in CENTRAL_SOURCES:
                raise SettlementPlanV2Error("plan_central_source_invalid")
        elif source != SIDECAR_SOURCE:
            raise SettlementPlanV2Error("plan_sidecar_source_invalid")
        central_sha = str(
            raw_entry.get("centralReceiptSha256") or ""
        ).strip().lower()
        sidecar_sha = str(
            raw_entry.get("sidecarReceiptSha256") or ""
        ).strip().lower()
        if not HEX_64_RE.fullmatch(central_sha):
            raise SettlementPlanV2Error("plan_central_receipt_sha256_invalid")
        if resolution.startswith("central-"):
            if sidecar_sha:
                raise SettlementPlanV2Error("plan_central_sidecar_hash_forbidden")
        elif not HEX_64_RE.fullmatch(sidecar_sha):
            raise SettlementPlanV2Error("plan_sidecar_receipt_sha256_invalid")
        if raw_entry.get("operatorReviewed") is not True:
            raise SettlementPlanV2Error("plan_operator_review_required")
        note = _text(
            raw_entry.get("reviewNote"), field="reviewNote", limit=800,
        )
        if len(note) < 12:
            raise SettlementPlanV2Error("plan_review_note_too_short")
        normalized.append({
            "receiptId": receipt_id,
            "source": source,
            "operationId": operation_id,
            "centralReceiptSha256": central_sha,
            "sidecarReceiptSha256": sidecar_sha,
            "resolution": resolution,
            "operatorReviewed": True,
            "reviewNote": note,
        })
    if [entry["receiptId"] for entry in normalized] != sorted(seen):
        raise SettlementPlanV2Error("plan_entries_must_be_sorted_by_receipt_id")
    plan["entries"] = normalized
    return plan, actual


def extract_and_verify_sidecars(snapshot_root: Path, plan: dict):
    sidecar_entries = [
        entry for entry in plan.get("entries") or []
        if entry["source"] == SIDECAR_SOURCE
    ]
    operation_ids = [entry["operationId"] for entry in sidecar_entries]
    if len(operation_ids) != len(set(operation_ids)):
        raise SettlementPlanV2Error("plan_sidecar_operation_duplicate")
    if not operation_ids:
        return {}
    try:
        receipts = model_usage_settlement.extract_sidecar_receipts(
            snapshot_root, operation_ids,
        )
    except model_usage_settlement.SettlementPlanError as exc:
        raise SettlementPlanV2Error(str(exc)) from exc
    for entry in sidecar_entries:
        receipt = receipts.get(entry["operationId"])
        if canonical_sha256(receipt) != entry["sidecarReceiptSha256"]:
            raise SettlementPlanV2Error(
                f"snapshot_sidecar_receipt_hash_mismatch:{entry['operationId']}"
            )
    return receipts
