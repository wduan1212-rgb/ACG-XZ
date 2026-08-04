from __future__ import annotations

import re
import uuid
from contextlib import contextmanager
from contextvars import ContextVar, Token
from datetime import datetime, timezone
from typing import Any, Iterator, Mapping

from .store import mutate_project


_project_id: ContextVar[str] = ContextVar("video_workshop_usage_project_id", default="")
_VALID_STATUSES = {"submitted", "unknown", "failed", "confirmed", "succeeded"}
_VALID_USAGE_KINDS = {"llm", "image", "video", "voice"}
_IMMUTABLE_RECEIPT_FIELDS = {
    "schemaVersion",
    "operationId",
    "surface",
    "projectId",
    "feature",
    "usageKind",
    "provider",
    "model",
    "unitLabel",
}


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _clean(value: Any, limit: int = 180) -> str:
    return re.sub(r"[^a-zA-Z0-9._:/+-]+", "-", str(value or "").strip())[:limit]


@contextmanager
def project_usage_scope(project_id: str) -> Iterator[None]:
    """Attach provider calls in this async task to one durable project.

    Context variables are copied into child asyncio tasks, so concurrent video
    projects cannot write receipts into each other's JSON snapshots.
    """

    token = bind_project_usage(project_id)
    try:
        yield
    finally:
        reset_project_usage(token)


def bind_project_usage(project_id: str) -> Token[str]:
    return _project_id.set(_clean(project_id, 120))


def reset_project_usage(token: Token[str]) -> None:
    _project_id.reset(token)


def new_operation_id(feature: str) -> str:
    project_id = _project_id.get()
    if not project_id:
        return ""
    feature_key = _clean(feature, 80) or "provider-call"
    # The random call identity is allocated before contacting the provider and
    # then persisted. It stays stable for status upgrades and reconciliation,
    # while a genuine retry receives a different identity and is not lost.
    return f"video-workshop:{project_id}:{feature_key}:{uuid.uuid4().hex}"


def _safe_non_negative_int(value: Any) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def token_usage(data: Any) -> dict[str, int]:
    usage = data.get("usage") if isinstance(data, dict) else None
    if not isinstance(usage, dict):
        usage = {}
    input_tokens = _safe_non_negative_int(
        usage.get("input_tokens")
        or usage.get("prompt_tokens")
        or usage.get("inputTokens")
        or usage.get("promptTokens")
    )
    output_tokens = _safe_non_negative_int(
        usage.get("output_tokens")
        or usage.get("completion_tokens")
        or usage.get("outputTokens")
        or usage.get("completionTokens")
    )
    total_tokens = _safe_non_negative_int(
        usage.get("total_tokens") or usage.get("totalTokens")
    )
    if not total_tokens and (input_tokens or output_tokens):
        total_tokens = input_tokens + output_tokens
    return {
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "totalTokens": total_tokens,
    }


def provider_reference(data: Any = None, headers: Mapping[str, Any] | None = None) -> str:
    normalized_headers = {
        str(key).lower(): str(value)
        for key, value in dict(headers or {}).items()
        if value is not None
    }
    for key in (
        "x-request-id",
        "request-id",
        "x-trace-id",
        "trace-id",
        "x-tt-logid",
    ):
        if normalized_headers.get(key):
            return _clean(normalized_headers[key], 180)
    if isinstance(data, dict):
        candidates = (
            data.get("request_id"),
            data.get("requestId"),
            data.get("trace_id"),
            data.get("traceId"),
            data.get("id"),
            (data.get("base_resp") or {}).get("trace_id")
            if isinstance(data.get("base_resp"), dict)
            else "",
        )
        for value in candidates:
            if value and not isinstance(value, (dict, list)):
                return _clean(value, 180)
    return ""


def record_model_usage_receipt(
    operation_id: str,
    *,
    feature: str,
    usage_kind: str,
    provider: str,
    model: str,
    status: str,
    provider_ref: str = "",
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: int = 0,
    output_units: int = 0,
    unit_label: str = "次",
) -> None:
    """Idempotently persist a prompt-free provider receipt in the project.

    The receipt is deliberately an outbox item: provider execution never
    depends on the central platform database being writable, and the main
    service can reconcile the same operation repeatedly without duplication.
    """

    project_id = _project_id.get()
    operation_id = _clean(operation_id, 260)
    if not project_id or not operation_id:
        return
    normalized_status = status if status in _VALID_STATUSES else "unknown"
    normalized_usage_kind = str(usage_kind or "").strip().lower()
    if normalized_usage_kind not in _VALID_USAGE_KINDS:
        raise ValueError("video_workshop_usage_kind_invalid")
    input_count = _safe_non_negative_int(input_tokens)
    output_count = _safe_non_negative_int(output_tokens)
    total_count = _safe_non_negative_int(total_tokens)
    if not total_count and (input_count or output_count):
        total_count = input_count + output_count
    occurred_at = _now()
    receipt = {
        "schemaVersion": 1,
        "operationId": operation_id,
        "surface": "video-workshop",
        "projectId": project_id,
        "feature": str(feature or "模型调用")[:80],
        "usageKind": normalized_usage_kind,
        "provider": _clean(provider, 80),
        "providerRef": _clean(provider_ref, 180),
        "model": _clean(model, 120),
        "status": normalized_status,
        "inputTokens": input_count,
        "outputTokens": output_count,
        "totalTokens": total_count,
        "usageObserved": bool(input_count or output_count or total_count),
        "outputUnits": _safe_non_negative_int(output_units),
        "unitLabel": str(unit_label or "次")[:20],
        "occurredAt": occurred_at,
        "reconcileState": "pending",
    }

    def append_or_upgrade(project: dict[str, Any]) -> None:
        receipts = [
            item
            for item in list(project.get("modelUsageReceipts") or [])
            if isinstance(item, dict)
        ]
        existing = next(
            (item for item in receipts if str(item.get("operationId") or "") == operation_id),
            None,
        )
        if existing is None:
            receipts.append(receipt)
        else:
            previous_status = str(existing.get("status") or "unknown")
            previous_reconcile = str(existing.get("reconcileState") or "pending")
            previous_reconciled_at = str(existing.get("reconciledAt") or "")
            for key, value in receipt.items():
                if key in {"occurredAt", "reconcileState"}:
                    continue
                if key in _IMMUTABLE_RECEIPT_FIELDS:
                    if not existing.get(key) and value:
                        existing[key] = value
                    continue
                if key == "status":
                    # `submitted` is durably written before the HTTP call to
                    # close the crash window. A later observation must be able
                    # to replace it with unknown/failed/confirmed. Only the two
                    # evidence-bearing terminal states are monotonic.
                    if previous_status == "succeeded" and normalized_status != "succeeded":
                        continue
                    if previous_status == "confirmed" and normalized_status not in {"confirmed", "succeeded"}:
                        continue
                if key == "providerRef" and not value:
                    continue
                if key in {"inputTokens", "outputTokens", "totalTokens", "outputUnits"}:
                    existing[key] = max(_safe_non_negative_int(existing.get(key)), value)
                    continue
                existing[key] = value
            existing["usageObserved"] = bool(
                existing.get("inputTokens")
                or existing.get("outputTokens")
                or existing.get("totalTokens")
            )
            existing["reconcileState"] = previous_reconcile
            if previous_reconciled_at:
                existing["reconciledAt"] = previous_reconciled_at
        project["modelUsageReceipts"] = receipts

    mutate_project(project_id, append_or_upgrade)
