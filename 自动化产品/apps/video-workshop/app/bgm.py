from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import quote, unquote, urlsplit

from .config import settings
from .video_skill import asset_path


SUPPORTED_AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg"}
PLATFORM_BGM_MARKERS = ("bgm", "音乐库", "配乐")
PLATFORM_BGM_EXCLUDES = ("口播", "语音", "tts", "数字人", "声线参考")


@dataclass(frozen=True)
class BgmTrack:
    id: str
    name: str
    path: Path
    source: str
    search_text: str = ""

    def public(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "source": self.source}


class BgmLibrary(Protocol):
    def catalog(self) -> list[dict[str, str]]: ...

    def resolve(self, project_id: str, plan: dict[str, Any]) -> BgmTrack | None: ...


_MOOD_GROUPS = (
    ("轻快", "欢快", "活泼", "明亮", "轻松", "清新", "阳光", "办公"),
    ("温暖", "温柔", "治愈", "舒缓", "柔和", "暖", "清晨"),
    ("沉稳", "克制", "冷静", "商务", "专业", "知识", "叙事"),
    ("科技", "未来", "电子", "数字", "节奏", "动感"),
    ("紧张", "悬疑", "压迫", "危机", "冲突"),
    ("高级", "质感", "杂志", "电影", "氛围"),
)


def _selection_context(plan: dict[str, Any]) -> str:
    audio_design = plan.get("audio_design") if isinstance(plan.get("audio_design"), dict) else {}
    return " ".join(
        str(value or "").lower()
        for value in (
            audio_design.get("bgm_mood"),
            audio_design.get("sound_note"),
            plan.get("tone"),
            plan.get("title"),
            plan.get("core_message"),
        )
    )


def _track_score(track: BgmTrack, context: str) -> int:
    haystack = f"{track.name} {track.search_text}".lower()
    score = 0
    for group in _MOOD_GROUPS:
        if any(word in context for word in group):
            score += sum(3 for word in group if word in haystack)
    # Names/tags often contain the exact requested mood (for example “轻快办公”).
    for token in re.findall(r"[a-z0-9]{2,}|[\u4e00-\u9fff]{2,4}", context):
        if token in haystack:
            score += 1
    return score


def _pick_track(project_id: str, plan: dict[str, Any], tracks: list[BgmTrack]) -> BgmTrack:
    context = _selection_context(plan)
    scored = [(track, _track_score(track, context)) for track in tracks]
    best_score = max((score for _, score in scored), default=0)
    candidates = [track for track, score in scored if score == best_score]
    seed = f"{project_id}|{plan.get('title')}|{context}"
    index = int(hashlib.sha1(seed.encode("utf-8")).hexdigest()[:8], 16) % len(candidates)
    return candidates[index]


class LocalBgmLibrary:
    def _tracks(self) -> list[BgmTrack]:
        root = settings.bgm_library_dir
        if not root.is_dir():
            return []
        tracks = []
        for path in sorted(root.iterdir(), key=lambda item: item.name.casefold()):
            if path.is_file() and path.suffix.lower() in SUPPORTED_AUDIO:
                digest = hashlib.sha1(str(path.resolve()).encode("utf-8")).hexdigest()[:12]
                tracks.append(BgmTrack(f"local:{digest}", path.stem, path, "local"))
        return tracks

    def catalog(self) -> list[dict[str, str]]:
        return [track.public() for track in self._tracks()]

    def resolve(self, project_id: str, plan: dict[str, Any]) -> BgmTrack | None:
        uploaded = list(plan.get("bgm_assets") or [])
        if uploaded:
            item = uploaded[0]
            path = asset_path(project_id, item)
            if path.is_file():
                return BgmTrack(
                    f"upload:{item.get('asset_id') or path.stem}",
                    str(item.get("name") or path.stem),
                    path,
                    "upload",
                )

        audio_design = plan.get("audio_design") or {}
        if not audio_design.get("bgm_enabled", False):
            return None
        tracks = self._tracks()
        if not tracks:
            return None
        requested_id = str(audio_design.get("bgm_track_id") or "")
        requested = next((track for track in tracks if track.id == requested_id), None)
        if requested:
            return requested
        return _pick_track(project_id, plan, tracks)


class PlatformBgmLibrary:
    """Read the main product's shared BGM assets without mutating its storage.

    Only files already uploaded through the main service's `/api/files/` route
    are accepted. Absolute paths, nested paths, traversal and symlinks escaping
    the configured upload directory are all rejected.
    """

    @staticmethod
    def _is_bgm_asset(item: dict[str, Any]) -> bool:
        if str(item.get("type") or "") != "音频":
            return False
        raw_tags = item.get("tags") or []
        tags = raw_tags if isinstance(raw_tags, list) else [raw_tags]
        tag_text = " ".join(str(tag or "") for tag in tags).lower()
        explicit_bgm = any(marker in tag_text for marker in PLATFORM_BGM_MARKERS)
        explicit_voice = any(marker in tag_text for marker in PLATFORM_BGM_EXCLUDES)
        if explicit_bgm:
            return not explicit_voice
        name = str(item.get("name") or "").lower()
        text = f"{tag_text} {name}"
        return (
            any(marker in name for marker in PLATFORM_BGM_MARKERS)
            and not any(marker in text for marker in PLATFORM_BGM_EXCLUDES)
        )

    @staticmethod
    def _safe_server_filename(item: dict[str, Any]) -> str:
        candidates: list[str] = []
        server_filename = str(item.get("serverFileName") or "").strip()
        if server_filename:
            candidates.append(server_filename)

        file_url = str(item.get("fileUrl") or "").strip()
        if file_url:
            parsed = urlsplit(file_url)
            prefix = "/api/files/"
            if (
                not parsed.scheme
                and not parsed.netloc
                and not parsed.query
                and not parsed.fragment
                and parsed.path.startswith(prefix)
            ):
                candidates.append(unquote(parsed.path[len(prefix):]))

        for filename in candidates:
            if (
                not filename
                or filename in {".", ".."}
                or "/" in filename
                or "\\" in filename
                or "\x00" in filename
                or Path(filename).name != filename
                or Path(filename).suffix.lower() not in SUPPORTED_AUDIO
            ):
                continue
            return filename
        return ""

    @classmethod
    def _asset_path(cls, item: dict[str, Any]) -> Path | None:
        filename = cls._safe_server_filename(item)
        if not filename:
            return None
        try:
            root = settings.platform_upload_dir.resolve(strict=True)
            candidate = (root / filename).resolve(strict=True)
            if not candidate.is_relative_to(root) or not candidate.is_file():
                return None
        except (OSError, RuntimeError):
            return None
        return candidate

    def _tracks(self) -> list[BgmTrack]:
        database = settings.platform_data_db
        if not database.is_file():
            return []
        connection: sqlite3.Connection | None = None
        try:
            uri = f"file:{quote(str(database.resolve()), safe='/')}?mode=ro"
            connection = sqlite3.connect(uri, uri=True, timeout=2)
            connection.execute("PRAGMA query_only=ON")
            rows = connection.execute(
                "SELECT id,data FROM docs WHERE collection='assets'"
            ).fetchall()
        except (OSError, sqlite3.Error):
            return []
        finally:
            if connection is not None:
                connection.close()

        tracks: list[BgmTrack] = []
        seen: set[str] = set()
        for document_id, raw_data in rows:
            try:
                item = json.loads(raw_data)
            except (TypeError, json.JSONDecodeError):
                continue
            if not isinstance(item, dict) or not self._is_bgm_asset(item):
                continue
            asset_id = str(item.get("id") or document_id or "").strip()
            if not asset_id or asset_id in seen:
                continue
            path = self._asset_path(item)
            if path is None:
                continue
            seen.add(asset_id)
            raw_tags = item.get("tags") or []
            tags = raw_tags if isinstance(raw_tags, list) else [raw_tags]
            tracks.append(BgmTrack(
                id=f"platform:{asset_id}",
                name=str(item.get("name") or path.stem),
                path=path,
                source="platform",
                search_text=" ".join(str(tag or "") for tag in tags),
            ))
        return sorted(tracks, key=lambda track: (track.name.casefold(), track.id))

    def catalog(self) -> list[dict[str, str]]:
        return [track.public() for track in self._tracks()]

    def resolve(self, project_id: str, plan: dict[str, Any]) -> BgmTrack | None:
        uploaded = list(plan.get("bgm_assets") or [])
        if uploaded:
            item = uploaded[0]
            path = asset_path(project_id, item)
            if path.is_file():
                return BgmTrack(
                    f"upload:{item.get('asset_id') or path.stem}",
                    str(item.get("name") or path.stem),
                    path,
                    "upload",
                )

        audio_design = plan.get("audio_design") or {}
        if not audio_design.get("bgm_enabled", False):
            return None
        tracks = self._tracks()
        if not tracks:
            return None
        requested_id = str(audio_design.get("bgm_track_id") or "")
        requested = next((track for track in tracks if track.id == requested_id), None)
        if requested:
            return requested
        return _pick_track(project_id, plan, tracks)


bgm_library: BgmLibrary = PlatformBgmLibrary() if settings.bgm_source == "platform" else LocalBgmLibrary()
