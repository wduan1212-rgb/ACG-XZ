from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.media import write_ass


class SubtitleStyleRenderingTests(unittest.TestCase):
    def test_manual_clip_cues_preserve_selected_subtitle_text_and_timing(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "manual-captions.ass"
            cues = write_ass(
                "原始口播不应覆盖手动字幕",
                target,
                "16:9",
                6.0,
                manual_cues=[
                    {"start": 0.0, "end": 2.5, "text": "字幕一，保留标点！"},
                    {"start": 2.5, "end": 6.0, "text": "字幕二：可单独修改。"},
                ],
            )
            rendered = target.read_text(encoding="utf-8")

        self.assertEqual(cues[0]["text"], "字幕一，保留标点！")
        self.assertEqual(cues[1]["start"], 2.5)
        self.assertIn("字幕一，保留标点！", rendered)
        self.assertIn("字幕二：可单独修改。", rendered)

    def test_smaller_higher_minimal_style_changes_layout_without_overlapping_cues(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "captions.ass"
            cues = write_ass(
                "第一句口播内容，第二句口播内容，第三句口播内容。",
                target,
                "9:16",
                9.0,
                subtitle_style={
                    "font_scale": 0.7,
                    "vertical_position": "higher",
                    "max_chars": 7,
                    "animation": "minimal",
                },
            )
            rendered = target.read_text(encoding="utf-8")

        style_line = next(line for line in rendered.splitlines() if line.startswith("Style: Caption"))
        style_parts = style_line.split(",")
        self.assertEqual(style_parts[2], "34")
        self.assertEqual(style_parts[21], "426")
        dialogue_lines = [line for line in rendered.splitlines() if line.startswith("Dialogue:")]
        self.assertTrue(dialogue_lines)
        self.assertTrue(all(r"{\fad(80,70)}" in line for line in dialogue_lines))
        self.assertTrue(all("\\move(" not in line for line in dialogue_lines))
        self.assertAlmostEqual(cues[0]["start"], 0.0)
        self.assertAlmostEqual(cues[-1]["end"], 9.0)
        self.assertTrue(all(
            left["end"] <= right["start"]
            for left, right in zip(cues, cues[1:])
        ))


if __name__ == "__main__":
    unittest.main()
