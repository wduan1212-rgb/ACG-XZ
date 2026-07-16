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
        "error": "",
    }
    save_project(project)
    return project


def list_project_summaries() -> list[dict[str, Any]]:
    summaries = []
    for path in settings.projects_dir.glob("*.json"):
        try:
            project = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        first_user = next(
            (str(item.get("content") or "").strip() for item in project.get("messages", []) if item.get("role") == "user"),
            "",
        )
        fallback_name = str((project.get("plan") or {}).get("title") or first_user or "新会话").strip()
        summaries.append(
            {
                "id": project.get("id") or path.stem,
                "name": str(project.get("name") or fallback_name)[:60],
                "status": project.get("status") or "conversation",
                "updatedAt": project.get("updatedAt") or project.get("createdAt") or "",
            }
        )
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
