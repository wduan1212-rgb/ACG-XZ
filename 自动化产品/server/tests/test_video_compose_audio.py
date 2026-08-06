import tempfile
import unittest
from pathlib import Path

from server.main import (
    ComposeClip,
    ComposeSubtitle,
    ComposeSubtitleStyle,
    StaticComposeReq,
    _compose_audio_command,
    _compose_clip_preprocess_command,
    _write_static_ass,
)


APP_DIR = Path(__file__).resolve().parents[2]


class VideoComposeAudioTest(unittest.TestCase):
    def test_static_compose_defaults_to_landscape_and_uses_animated_bottom_captions(self):
        request = StaticComposeReq(frames=[])
        self.assertEqual(request.aspectRatio, "16:9")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "captions.ass"
            written = _write_static_ass(
                path,
                [ComposeSubtitle(start=0, end=2.4, text="测试字幕")],
                width=1920,
                height=1080,
                style=ComposeSubtitleStyle(size=13, stroke=1, bottom=20),
            )
            content = path.read_text(encoding="utf-8")
        self.assertTrue(written)
        self.assertIn("PlayResX: 1920", content)
        self.assertIn("PlayResY: 1080", content)
        self.assertIn(r"\fad(110,130)", content)
        self.assertIn(r"\t(0,180,\fscx100\fscy100)", content)
        self.assertIn(",58,1", content)

    def test_digital_human_bgm_keeps_base_voice_and_loops_music(self):
        command = _compose_audio_command(
            "ffmpeg",
            Path("base.mp4"),
            Path("mixed.mp4"),
            30.0,
            Path("narration.mp3"),
            Path("bgm.mp3"),
            has_base_audio=True,
            has_narr=True,
            has_bgm=True,
            preserve_clip_audio=True,
            narration_volume=1.0,
            bgm_volume=0.25,
        )
        joined = " ".join(command)
        self.assertIn("[0:a]volume=1.0[voice]", joined)
        self.assertIn("[2:a]volume=0.25[music]", joined)
        self.assertIn("amix=inputs=2:duration=longest", joined)
        self.assertIn("-stream_loop -1", joined)
        self.assertNotIn("-shortest", command)

    def test_compose_preprocess_respects_trim_and_duration(self):
        command = _compose_clip_preprocess_command(
            "ffmpeg",
            Path("raw.mp4"),
            Path("trimmed.mp4"),
            ComposeClip(url="https://example.com/raw.mp4", trimIn=2.25, dur=7.5),
        )
        joined = " ".join(command)
        self.assertIn("-ss 2.250", joined)
        self.assertIn("-t 7.500", joined)
        self.assertIn("-map 0:a:0?", joined)
        self.assertIn("-c:v libx264", joined)

    def test_main_subtitle_path_has_no_whisper_or_audio_timing_endpoint(self):
        main_source = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        cut_source = (APP_DIR / "js/views/chainCut.js").read_text(encoding="utf-8")
        self.assertNotIn("whisper.cpp", main_source.lower())
        self.assertNotIn("_transcribe_with_whisper", main_source)
        self.assertNotIn('/api/video/audio-timing', main_source)
        self.assertNotIn('/api/video/audio-timing', cut_source)
        self.assertFalse((APP_DIR / "tools/install_whisper_cpp.sh").exists())

    def test_optional_legacy_bgm_cannot_fail_static_video(self):
        main_source = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        marker = "[static-compose] optional BGM skipped"
        self.assertIn(marker, main_source)
        bgm_block = main_source[main_source.index("elif req.bgmUrl:"):main_source.index(marker) + len(marker)]
        self.assertIn("except HTTPException", bgm_block)
        self.assertIn("_write_video_source", bgm_block)

    def test_workshop_upload_transcription_stays_isolated(self):
        """Removing main-platform subtitle ASR must not break workshop audio uploads."""
        workshop = (APP_DIR / "apps/video-workshop/app/transcription.py").read_text(encoding="utf-8")
        self.assertIn("faster_whisper", workshop)
        self.assertIn("transcribe", workshop)


if __name__ == "__main__":
    unittest.main()
