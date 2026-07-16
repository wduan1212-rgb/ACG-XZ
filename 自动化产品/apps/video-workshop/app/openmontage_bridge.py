from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from .config import settings


class OpenMontageBridge:
    """Small, replaceable bridge to upstream OpenMontage analysis tools."""

    def __init__(self) -> None:
        self.root = settings.openmontage_root

    @property
    def available(self) -> bool:
        return (self.root / "tools" / "analysis" / "visual_qa.py").is_file()

    def director_context(self) -> str:
        files = [
            self.root / "skills" / "pipelines" / "explainer" / "idea-director.md",
            self.root / "skills" / "pipelines" / "explainer" / "edit-director.md",
            self.root / "skills" / "core" / "subtitle-sync.md",
        ]
        sections = []
        for path in files:
            if not path.is_file():
                continue
            text = path.read_text(encoding="utf-8")
            selected = [
                line.strip()
                for line in text.splitlines()
                if line.strip().startswith(("- **", "- [ ]", "- Max ", "- Subtitle", "- Cue "))
            ]
            if selected:
                sections.append(f"[{path.name}]\n" + "\n".join(selected[:16]))
        return "\n\n".join(sections)[:7000]

    def _prepare_import(self) -> None:
        root = str(self.root)
        if root not in sys.path:
            sys.path.insert(0, root)

    @staticmethod
    def _result(result: Any) -> dict[str, Any]:
        return {
            "success": bool(getattr(result, "success", False)),
            "data": getattr(result, "data", None) or {},
            "error": getattr(result, "error", None) or "",
            "artifacts": getattr(result, "artifacts", None) or [],
        }

    def validate_composition(self, composition_path: Path, assets_root: Path) -> dict[str, Any]:
        if not self.available:
            return {"success": False, "error": "本地质量检查器不可用", "data": {}}
        self._prepare_import()
        from tools.analysis.composition_validator import CompositionValidator

        result = CompositionValidator().execute(
            {
                "composition_path": str(composition_path),
                "assets_root": str(assets_root),
                "render_runtime": "ffmpeg",
            }
        )
        return self._result(result)

    def inspect_video(
        self,
        video_path: Path,
        width: int,
        height: int,
        review_dir: Path,
        expected_duration: float,
    ) -> dict[str, Any]:
        if not self.available:
            return {"success": False, "error": "本地质量检查器不可用", "data": {}}
        self._prepare_import()
        from tools.analysis.visual_qa import VisualQA

        tool = VisualQA()
        duration = max(0.5, float(expected_duration or 0.5))
        timestamps = [
            round(duration * 0.15, 3),
            round(duration * 0.35, 3),
            round(duration * 0.55, 3),
            round(duration * 0.75, 3),
            round(max(0.1, duration - 0.35), 3),
        ]
        probe = tool.execute(
            {
                "operation": "probe",
                "input_path": str(video_path),
                "expected": {
                    "width": width,
                    "height": height,
                    "min_duration": max(0.1, duration - 1.0),
                    "max_duration": duration + 1.0,
                    "pixel_format": "yuv420p",
                    "has_audio": True,
                },
            }
        )
        review = tool.execute(
            {
                "operation": "review",
                "input_path": str(video_path),
                "timestamps": timestamps,
                "output_dir": str(review_dir),
            }
        )
        return {"success": bool(probe.success and review.success), "probe": self._result(probe), "review": self._result(review)}

    def write_manifest(self, path: Path, data: dict[str, Any]) -> None:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


openmontage = OpenMontageBridge()
