from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .config import settings


@dataclass(frozen=True)
class SoundEffect:
    id: str
    name: str
    filename: str
    duration: float

    @property
    def path(self) -> Path:
        return settings.web_dir / "assets" / "sfx" / self.filename

    def public(self) -> dict[str, str | float]:
        return {
            "id": self.id,
            "name": self.name,
            "url": f"assets/sfx/{self.filename}",
            "duration": self.duration,
            "license": "CC0 1.0",
            "source": "Kenney Impact Sounds / UI Audio",
        }


_CATALOG = (
    SoundEffect("kenney-click", "轻触提示", "kenney-click1.ogg", 0.3),
    SoundEffect("kenney-switch", "切换提示", "kenney-switch1.ogg", 0.32),
    SoundEffect("kenney-impact-light", "轻微强调", "kenney-impact-light.ogg", 0.3),
    SoundEffect("kenney-impact-soft", "柔和落点", "kenney-impact-soft.ogg", 0.51),
    SoundEffect("kenney-bell", "清脆提示", "kenney-bell.ogg", 1.48),
)


class BundledSoundEffectLibrary:
    def catalog(self) -> list[dict[str, str | float]]:
        return [item.public() for item in _CATALOG if item.path.is_file()]

    def resolve(self, effect_id: str) -> SoundEffect | None:
        effect = next((item for item in _CATALOG if item.id == str(effect_id or "")), None)
        if effect is None or not effect.path.is_file():
            return None
        try:
            root = (settings.web_dir / "assets" / "sfx").resolve(strict=True)
            candidate = effect.path.resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if not candidate.is_relative_to(root) or not candidate.is_file():
            return None
        return effect


sfx_library = BundledSoundEffectLibrary()
