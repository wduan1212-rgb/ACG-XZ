from __future__ import annotations

import json
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import settings


_lock = threading.RLock()
_summary_cache: dict[str, tuple[int, int, dict[str, Any]]] = {}


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _path(project_id: str) -> Path:
    safe = "".join(ch for ch in project_id if ch.isalnum() or ch in "-_")
    return settings.projects_dir / f"{safe}.json"


def create_project() -> dict[str, Any]:
    project_id = uuid.uuid4().hex[:12]
    project = {
        "id": project_id,
        "name": "新会话",
        "status": "conversation",
        "phase": "brief",
        "progress": 0,
        "createdAt": _now(),
        "updatedAt": _now(),
        "messages": [],
        "events": [],
        "attachments": [],
        "assets": [],
        "plan": None,
        "outputs": [],
        "deliveries": [],
        "error": "",
    }
    save_project(project)
    return project


def _project_summary(project: dict[str, Any], fallback_id: str) -> dict[str, Any]:
    first_user = next(
        (
            str(item.get("content") or "").strip()
            for item in project.get("messages", [])
            if item.get("role") == "user"
        ),
        "",
    )
    fallback_name = str(
        (project.get("plan") or {}).get("title") or first_user or "新会话"
    ).strip()
    return {
        "id": project.get("id") or fallback_id,
        "name": str(project.get("name") or fallback_name)[:60],
        "status": project.get("status") or "conversation",
        "updatedAt": project.get("updatedAt") or project.get("createdAt") or "",
    }


def list_project_summaries(project_ids: set[str] | None = None) -> list[dict[str, Any]]:
    summaries: list[dict[str, Any]] = []
    live_cache_keys: set[str] = set()
    requested_ids = {
        "".join(ch for ch in str(project_id or "") if ch.isalnum() or ch in "-_")
        for project_id in (project_ids or set())
        if str(project_id or "").strip()
    }
    with _lock:
        paths = (
            [_path(project_id) for project_id in sorted(requested_ids)]
            if project_ids is not None
            else list(settings.projects_dir.glob("*.json"))
        )
        for path in paths:
            if not path.is_file():
                continue
            cache_key = str(path.resolve())
            try:
                stat = path.stat()
            except OSError:
                continue
            signature = (stat.st_mtime_ns, stat.st_size)
            live_cache_keys.add(cache_key)
            cached = _summary_cache.get(cache_key)
            if cached and cached[:2] == signature:
                summaries.append(dict(cached[2]))
                continue
            try:
                project = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                _summary_cache.pop(cache_key, None)
                continue
            summary = _project_summary(project, path.stem)
            _summary_cache[cache_key] = (*signature, summary)
            summaries.append(dict(summary))

        if project_ids is None:
            for cache_key in tuple(_summary_cache):
                if cache_key not in live_cache_keys:
                    _summary_cache.pop(cache_key, None)
    return sorted(summaries, key=lambda item: item["updatedAt"], reverse=True)


def load_project(project_id: str) -> dict[str, Any] | None:
    path = _path(project_id)
    if not path.is_file():
        return None
    with _lock:
        return json.loads(path.read_text(encoding="utf-8"))


def save_project(project: dict[str, Any]) -> dict[str, Any]:
    project["updatedAt"] = _now()
    path = _path(project["id"])
    tmp = path.with_suffix(".tmp")
    with _lock:
        tmp.write_text(json.dumps(project, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
        stat = path.stat()
        _summary_cache[str(path.resolve())] = (
            stat.st_mtime_ns,
            stat.st_size,
            _project_summary(project, path.stem),
        )
    return deepcopy(project)


def mutate_project(project_id: str, mutator) -> dict[str, Any]:
    with _lock:
        project = load_project(project_id)
        if project is None:
            raise KeyError(project_id)
        mutator(project)
        return save_project(project)


def add_message(project_id: str, role: str, content: str, **extra: Any) -> dict[str, Any]:
    def mutate(project: dict[str, Any]) -> None:
        message = {"id": uuid.uuid4().hex[:10], "role": role, "content": content, "at": _now()}
        message.update(extra)
        project["messages"].append(message)

    return mutate_project(project_id, mutate)


def add_event(
    project_id: str,
    title: str,
    detail: str,
    status: str = "running",
    progress: int | None = None,
    phase: str | None = None,
) -> dict[str, Any]:
    def mutate(project: dict[str, Any]) -> None:
        project["events"].append(
            {
                "id": uuid.uuid4().hex[:10],
                "title": title,
                "detail": detail,
                "status": status,
                "at": _now(),
            }
        )
        project["events"] = project["events"][-80:]
        if progress is not None:
            project["progress"] = max(0, min(100, int(progress)))
        if phase is not None:
            project["phase"] = phase

    return mutate_project(project_id, mutate)
