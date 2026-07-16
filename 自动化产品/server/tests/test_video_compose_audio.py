import unittest
from pathlib import Path

from server.main import _clean_transcript_text, _compose_audio_command, _correct_whisper_text


class VideoComposeAudioTest(unittest.TestCase):
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

    def test_transcript_guard_drops_box_glyphs_and_hallucinations(self):
        self.assertEqual(_clean_transcript_text("□ □ 真正的口播�"), "真正的口播")
        self.assertEqual(_correct_whisper_text("字幕由 Amara.org 提供", "真实口播内容"), "")
        self.assertEqual(_correct_whisper_text("字幕 by 李宗智", "真实口播内容"), "")
        self.assertEqual(_correct_whisper_text("完全无关的模型幻觉", "真实口播内容"), "")
        self.assertEqual(_correct_whisper_text("这是实际口播内容", "这是实际口播内容"), "这是实际口播内容")


if __name__ == "__main__":
    unittest.main()
