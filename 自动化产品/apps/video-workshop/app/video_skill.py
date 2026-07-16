from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from .config import settings


SKILL_NAME = "video-production"
SLASH_COMMAND = "/视频制作"


@lru_cache(maxsize=1)
def director_context() -> str:
    workflow = settings.skills_dir / SKILL_NAME / "references" / "workflow.md"
    if not workflow.is_file():
        return ""
    return workflow.read_text(encoding="utf-8")[:8000]


def is_requested(message: str) -> bool:
    return message.lstrip().startswith(SLASH_COMMAND)


def strip_command(message: str) -> str:
    stripped = message.strip()
    if stripped.startswith(SLASH_COMMAND):
        stripped = stripped[len(SLASH_COMMAND) :].lstrip(" ：:")
    return stripped or "请根据我随后提供的内容开始定制视频制作"


def asset_path(project_id: str, item: dict) -> Path:
    return settings.uploads_dir / project_id / Path(str(item.get("url") or "")).name
