from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def load_environment() -> None:
    local_path = ROOT / ".env.local"
    local_values = _read_env(local_path)
    fallback_value = local_values.get("FALLBACK_ENV", "") or os.getenv("FALLBACK_ENV", "")
    if not fallback_value:
        bundled_main_env = ROOT.parents[1] / ".env.local"
        if bundled_main_env.is_file():
            fallback_value = str(bundled_main_env)
    if fallback_value:
        fallback_path = Path(fallback_value)
        if not fallback_path.is_absolute():
            fallback_path = (ROOT / fallback_path).resolve()
        for key, value in _read_env(fallback_path).items():
            os.environ.setdefault(key, value)
    for key, value in local_values.items():
        os.environ[key] = value


load_environment()


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _path(name: str, default: Path) -> Path:
    value = Path(os.getenv(name, str(default))).expanduser()
    if not value.is_absolute():
        value = ROOT / value
    return value.resolve()


@dataclass(frozen=True)
class Settings:
    root: Path = ROOT
    web_dir: Path = _path("VIDEO_WORKSHOP_WEB_DIR", ROOT / "web")
    projects_dir: Path = _path("VIDEO_WORKSHOP_PROJECTS_DIR", ROOT / "data" / "projects")
    outputs_dir: Path = _path("VIDEO_WORKSHOP_OUTPUT_DIR", ROOT / "outputs")
    uploads_dir: Path = _path("VIDEO_WORKSHOP_UPLOAD_DIR", ROOT / "uploads")
    skills_dir: Path = _path("VIDEO_WORKSHOP_SKILLS_DIR", ROOT / "skills")
    openmontage_root: Path = _path(
        "VIDEO_WORKSHOP_OPENMONTAGE_ROOT",
        ROOT / "vendor" / "OpenMontage",
    )

    llm_api_key: str = os.getenv("LLM_API_KEY", "")
    llm_base_url: str = os.getenv("LLM_BASE_URL", "https://api.minimaxi.com").rstrip("/")
    llm_endpoint: str = os.getenv("LLM_ENDPOINT", "https://api.minimaxi.com/v1/chat/completions")
    llm_model: str = os.getenv("LLM_MODEL", "MiniMax-M3")
    llm_thinking: str = os.getenv("LLM_THINKING", "adaptive")
    llm_max_completion_tokens: int = int(
        os.getenv(
            "LLM_MAX_COMPLETION_TOKENS",
            os.getenv("LLM_MAX_TOKENS", "16000"),
        )
        or "16000"
    )

    seedance_api_key: str = os.getenv("SEEDANCE_API_KEY", "")
    seedance_base_url: str = os.getenv("SEEDANCE_BASE_URL", "https://ark.cn-beijing.volces.com").rstrip("/")
    seedance_model: str = os.getenv("SEEDANCE_MODEL", "doubao-seedance-2-0-260128")
    seedance_resolution: str = os.getenv("SEEDANCE_RESOLUTION", "720p")

    minimax_api_key: str = os.getenv("MINIMAX_API_KEY", "")
    minimax_base_url: str = os.getenv("MINIMAX_BASE_URL", "https://api.minimaxi.com").rstrip("/")
    minimax_tts_model: str = os.getenv("MINIMAX_TTS_MODEL", "speech-2.8-hd")
    minimax_voice_id: str = os.getenv(
        "MINIMAX_VOICE_ID",
        "moss_audio_ce44fc67-7ce3-11f0-8de5-96e35d26fb85",
    )

    asr_model: str = os.getenv("ASR_MODEL", "small")
    asr_language: str = os.getenv("ASR_LANGUAGE", "zh")

    bgm_source: str = os.getenv("BGM_SOURCE", "platform").strip().lower()
    bgm_library_dir: Path = _path("BGM_LIBRARY_DIR", ROOT / "music_library")
    # In platform mode the sidecar only reads the main service's document DB
    # and upload directory. It never creates, migrates, deletes or rewrites
    # anything beneath either path.
    platform_data_db: Path = _path(
        "DATA_DB",
        ROOT.parents[1] / "server" / "data.sqlite",
    )
    platform_upload_dir: Path = _path(
        "UPLOAD_DIR",
        ROOT.parents[1] / "server" / "uploads",
    )

    outbound_proxy: str = os.getenv("OUTBOUND_PROXY", "")
    public_base_url: str = os.getenv("PUBLIC_BASE_URL", "").rstrip("/")
    live: bool = _bool("VIDEO_WORKSHOP_LIVE", True)
    # Keep the sidecar independent from the main service's generic HOST/PORT.
    # Production launchers commonly export PORT=8787 for the main FastAPI app;
    # inheriting that value here would either collide with the main process or
    # accidentally expose this unauthenticated loopback service publicly.
    host: str = os.getenv("VIDEO_WORKSHOP_HOST", "127.0.0.1")
    port: int = int(os.getenv("VIDEO_WORKSHOP_PORT", "8765") or "8765")


settings = Settings()
for directory in (settings.projects_dir, settings.outputs_dir, settings.uploads_dir):
    directory.mkdir(parents=True, exist_ok=True)
