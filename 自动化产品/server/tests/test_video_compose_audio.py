import unittest
from pathlib import Path

from server.main import (
    AudioTimingHint,
    _align_known_hint,
    _clean_transcript_text,
    _compose_audio_command,
    _correct_whisper_text,
    _whisper_timed_chars,
)


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

    def test_full_whisper_tokens_align_only_to_known_narration(self):
        payload = {
            "transcription": [{
                "text": "先把任务说清楚",
                "offsets": {"from": 1000, "to": 3000},
                "tokens": [
                    {"text": char, "offsets": {"from": 1000 + index * 200, "to": 1180 + index * 200}}
                    for index, char in enumerate("先把任务说清楚")
                ],
            }]
        }
        timed = _whisper_timed_chars(payload, 5.0)
        cues = _align_known_hint(
            AudioTimingHint(text="先把任务说清楚", start=0.8, end=3.4),
            timed,
            5.0,
            strict=True,
        )
        self.assertTrue(cues)
        self.assertEqual("".join(cue["text"] for cue in cues), "先把任务说清楚")
        self.assertTrue(all(0.8 <= cue["start"] < cue["end"] <= 3.4 for cue in cues))
        self.assertTrue(all(cue["precise"] for cue in cues))

    def test_strict_info_flow_alignment_rejects_unspoken_prompt_text(self):
        timed = [
            {"char": char, "start": 1.0 + index * 0.2, "end": 1.16 + index * 0.2}
            for index, char in enumerate("这是完全不同的口播")
        ]
        cues = _align_known_hint(
            AudioTimingHint(text="禁止字幕不要二维码", start=0, end=4),
            timed,
            4.0,
            strict=True,
        )
        self.assertEqual(cues, [])


if __name__ == "__main__":
    unittest.main()
