from __future__ import annotations

import json
import threading
import warnings
from pathlib import Path
from typing import Any

from .config import settings


class TranscriptionError(RuntimeError):
    pass


class LocalTranscriber:
    def __init__(self) -> None:
        self._model = None
        self._lock = threading.Lock()

    @property
    def available(self) -> bool:
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            return False
        return True

    def _get_model(self):
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise TranscriptionError("本地语音转写组件尚未安装") from exc
        self._model = WhisperModel(settings.asr_model, device="cpu", compute_type="int8")
        return self._model

    def transcribe(self, source: Path, output_dir: Path) -> dict[str, Any]:
        if not source.is_file():
            raise TranscriptionError("口播音频文件不存在")
        output_dir.mkdir(parents=True, exist_ok=True)
        with self._lock:
            try:
                with warnings.catch_warnings():
                    warnings.filterwarnings(
                        "ignore",
                        category=RuntimeWarning,
                        module=r"faster_whisper\.feature_extractor",
                    )
                    segments_iter, info = self._get_model().transcribe(
                        str(source),
                        language=settings.asr_language or None,
                        initial_prompt="请使用简体中文准确转写，保留专有名词和原始措辞。",
                        word_timestamps=True,
                        vad_filter=True,
                        vad_parameters={"min_silence_duration_ms": 350},
                    )
                    segments = []
                    words = []
                    for segment in segments_iter:
                        segment_words = []
                        for word in segment.words or []:
                            entry = {
                                "word": str(word.word).strip(),
                                "start": round(float(word.start), 3),
                                "end": round(float(word.end), 3),
                                "probability": round(float(word.probability), 3),
                            }
                            segment_words.append(entry)
                            words.append(entry)
                        segments.append(
                            {
                                "start": round(float(segment.start), 3),
                                "end": round(float(segment.end), 3),
                                "text": str(segment.text).strip(),
                                "words": segment_words,
                            }
                        )
            except Exception as exc:
                raise TranscriptionError(f"口播音频转写失败：{exc}") from exc

        text = "".join(item["text"] for item in segments).strip()
        if not text:
            raise TranscriptionError("没有从音频中识别到清晰口播")
        result = {
            "text": text,
            "segments": segments,
            "words": words,
            "language": str(getattr(info, "language", settings.asr_language) or settings.asr_language),
            "duration": round(float(getattr(info, "duration", 0) or 0), 3),
            "model": settings.asr_model,
        }
        (output_dir / f"{source.stem}-transcript.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return result


transcriber = LocalTranscriber()
