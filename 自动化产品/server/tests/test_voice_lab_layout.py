import re
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class VoiceLabLayoutContractTest(unittest.TestCase):
    def test_mode_switch_lives_inside_editor_header_without_provider_caption(self):
        source = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")

        self.assertIn('class="vl-editor-head-actions"', source)
        self.assertIn('class="vl-mode-tabs vl-editor-mode-tabs"', source)
        self.assertIn('wireVoiceDock($(".vl-editor-mode-tabs", root), stableRerender)', source)
        self.assertNotIn("vl-embedded-dock", source)
        self.assertNotIn("vl-mini-status", source)
        self.assertNotIn("voice_design / t2a_v2", source)
        self.assertNotIn("ttsProviderLabel", source)

    def test_voice_card_has_only_one_preview_action_and_layout_reserves_its_row(self):
        source = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")
        motion = (APP_DIR / "styles" / "ui-motion.css").read_text(encoding="utf-8")
        card_match = re.search(
            r"function voiceCard\(.*?\n}\n\nfunction classifyVoice",
            source,
            flags=re.DOTALL,
        )

        self.assertIsNotNone(card_match)
        self.assertEqual(card_match.group(0).count('data-vl-preview="'), 1)
        self.assertIn("position: static;", motion)
        self.assertIn("justify-self: end;", motion)
        self.assertIn("transform: none;", motion)

    def test_voice_ids_stay_copyable_without_being_rendered_in_cards(self):
        source = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")
        motion = (APP_DIR / "styles" / "ui-motion.css").read_text(encoding="utf-8")
        card_match = re.search(
            r"function voiceCard\(.*?\n}\n\nfunction classifyVoice",
            source,
            flags=re.DOTALL,
        )

        self.assertIsNotNone(card_match)
        self.assertNotIn("<em>${esc(v.voiceId)}</em>", card_match.group(0))
        self.assertIn('data-vl-copy="${esc(v.voiceId)}"', card_match.group(0))
        self.assertIn("copyText(action.dataset.vlCopy)", source)
        self.assertNotIn("中间写口播，右侧调参数，左侧选音色", source)
        self.assertIn("grid-template-columns: minmax(0, 1fr) auto;", motion)
        self.assertIn(".vl-voice-actions .icon-btn.tiny", motion)
        self.assertIn("width: 25px;", motion)


if __name__ == "__main__":
    unittest.main()
