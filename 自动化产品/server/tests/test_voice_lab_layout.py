import re
import unittest
from pathlib import Path

from server.main import _tts_payload, _voice_design_prompt


APP_DIR = Path(__file__).resolve().parents[2]


class VoiceLabLayoutContractTest(unittest.TestCase):
    def test_voice_design_preserves_lifestyle_and_emotional_semantics(self):
        prompt = "温柔、生活化、像朋友聊天，语速舒缓，适合日常分享"
        anchored = _voice_design_prompt(prompt, "female")
        self.assertIn("必须生成女性声线", anchored)
        for phrase in ("温柔", "生活化", "像朋友聊天", "语速舒缓", "日常分享"):
            self.assertIn(phrase, anchored)
        self.assertIn("完整保留并共同执行", anchored)

    def test_main_platform_tts_accepts_the_existing_one_point_two_speed(self):
        payload = _tts_payload("这是一段稳定性验证口播", "voice-id", speed=1.2)
        self.assertEqual(payload["voice_setting"]["speed"], 1.2)

    def test_mode_switch_lives_inside_editor_header_without_provider_caption(self):
        source = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles" / "views.css").read_text(encoding="utf-8")

        self.assertIn('class="vl-editor-head-actions"', source)
        self.assertIn('class="vl-mode-tabs vl-editor-mode-tabs"', source)
        self.assertIn('class="vl-mode-switch-label">切换模式', source)
        self.assertIn('<button class="btn primary sm" id="vlGenerate">', source)
        self.assertIn('wireVoiceDock($(".vl-editor-mode-tabs", root), stableRerender)', source)
        self.assertIn('const stableEditor = $(".vl-editor", root);', source)
        self.assertIn('if (stableEditor && nextEditor) nextEditor.replaceWith(stableEditor);', source)
        self.assertIn('const stableLibrary = nextMode ? $(".vl-library", root) : null;', source)
        self.assertIn('if (stableLibrary && nextLibrary) nextLibrary.replaceWith(stableLibrary);', source)
        self.assertNotIn('.vl-library.is-panel-switching-out', styles)
        self.assertIn('.vl-side-panel.is-panel-switching-in', styles)
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
