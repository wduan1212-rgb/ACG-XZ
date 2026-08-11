import re
import unittest
from pathlib import Path

from server.main import _tts_payload, _voice_design_prompt


APP_DIR = Path(__file__).resolve().parents[2]


class VoiceLabLayoutContractTest(unittest.TestCase):
    def test_embedded_voice_library_keeps_filters_and_names_visible(self):
        source = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles" / "custom-creation.css").read_text(encoding="utf-8")

        self.assertEqual(
            source.count('voiceQueryAll("[data-vl-tab]").forEach'),
            2,
        )
        self.assertIn(
            "grid-template-columns: repeat(2, minmax(0, 1fr));",
            styles,
        )
        self.assertIn(
            "body.workspace-shell-v2 .workspace-context-tool-host .vl-voice-core b",
            styles,
        )
        self.assertIn("flex: 1 1 auto;", styles)
        self.assertIn("min-height: 40px;", styles)
        self.assertIn("padding: 4px 5px 4px 7px;", styles)
        self.assertIn("font-size: 11.5px;", styles)
        self.assertIn("font-weight: 420;", styles)
        self.assertNotIn("padding: 7px 80px 7px 8px;", styles)
        self.assertNotIn("padding-right: 128px;", styles)

    def test_embedded_debug_console_expands_preview_and_pins_parameters(self):
        source = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles" / "custom-creation.css").read_text(encoding="utf-8")

        self.assertIn('class="vl-sliders vl-voice-parameters"', source)
        self.assertIn("min-height: clamp(270px, 42vh, 410px);", styles)
        self.assertIn("grid-template-rows: auto minmax(0, 1fr);", styles)
        self.assertIn(
            "body.workspace-shell-v2 .custom-tool-host.is-voice .vl-console .vl-voice-parameters",
            styles,
        )
        self.assertIn("margin-top: auto;", styles)
        self.assertIn("@keyframes vlOutputAmbient", styles)
        self.assertIn("@keyframes vlOutputIconBreathe", styles)
        self.assertIn("@keyframes vlOutputWaiting", styles)
        self.assertIn("@media (prefers-reduced-motion: reduce)", styles)
        self.assertRegex(
            styles,
            r"\.vl-output-slot\s*\{[^}]*border:\s*1px solid rgba\(15,\s*23,\s*42,\s*\.07\);[^}]*border-radius:\s*12px;",
        )
        self.assertRegex(
            styles,
            r"\.vl-output-empty,\s*\n[^{}]*\.vl-output-loading\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;",
        )
        self.assertRegex(
            styles,
            r"\.vl-output-slot \.vl-player\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;",
        )

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
        self.assertIn(
            '<button class="btn primary sm vl-generate-action" id="vlGenerate"><span>',
            source,
        )
        self.assertIn('生成音频 ${icon("arrowRight", 13)}</span></button>', source)
        self.assertIn(".vl-console .vl-section-head.compact .vl-generate-action", styles)
        self.assertRegex(
            styles,
            r"\.vl-console \.vl-section-head\.compact \.vl-generate-action\s*\{[^}]*margin-left:\s*auto;[^}]*margin-right:\s*0;",
        )
        self.assertIn('wireVoiceDock($(".vl-editor-mode-tabs", root), stableRerender)', source)
        self.assertIn('const stableEditor = $(".vl-editor", root);', source)
        self.assertIn('if (stableEditor && nextEditor) nextEditor.replaceWith(stableEditor);', source)
        self.assertIn('document.getElementById("workspaceContextToolHost")', source)
        self.assertIn('const stableLibrary = nextMode ? libraryNode() : null;', source)
        self.assertIn('if (stableLibrary && nextLibrary && stableLibrary !== nextLibrary) {', source)
        self.assertIn('nextLibrary.replaceWith(stableLibrary);', source)
        self.assertIn('workspaceLibraryHost.replaceChildren(renderedLibrary);', source)
        self.assertNotIn('.vl-library.is-panel-switching-out', styles)
        self.assertIn('.vl-side-panel.is-panel-switching-in', styles)
        self.assertNotIn("vl-embedded-dock", source)
        self.assertNotIn("vl-mini-status", source)
        self.assertNotIn("voice_design / t2a_v2", source)
        self.assertNotIn("ttsProviderLabel", source)

    def test_voice_card_exposes_only_three_dot_trigger_and_permission_aware_menu(self):
        source = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles" / "custom-creation.css").read_text(encoding="utf-8")
        card_match = re.search(
            r"function voiceCard\(.*?\n}\n\nfunction classifyVoice",
            source,
            flags=re.DOTALL,
        )

        self.assertIsNotNone(card_match)
        card = card_match.group(0)
        markup = card[card.index("return `<div"):]
        visible_markup, menu_markup = markup.split(
            '<span class="vl-voice-menu-popover"',
            1,
        )
        self.assertEqual(visible_markup.count("<button"), 1)
        self.assertEqual(card.count('data-vl-menu-toggle="'), 1)
        self.assertEqual(card.count('data-vl-preview="'), 1)
        self.assertIn('icon("more", 14)', visible_markup)
        self.assertIn('aria-haspopup="menu"', visible_markup)
        self.assertIn('role="menu"', menu_markup)
        for action in (
            "data-vl-preview",
            "data-vl-fav",
            "data-vl-rename",
            "data-vl-delete-voice",
            "data-vl-copy",
        ):
            self.assertIn(action, menu_markup if action not in {"data-vl-rename", "data-vl-delete-voice"} else card)
        self.assertIn("canManageCustomVoice(v)", card)
        self.assertIn('role="menuitemcheckbox"', card)
        self.assertIn(".vl-voice-menu-popover[hidden]", styles)
        self.assertIn("position: fixed;", styles)

    def test_voice_action_menu_supports_click_outside_escape_and_arrow_keys(self):
        source = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")

        self.assertIn('action?.matches("[data-vl-menu-toggle]")', source)
        self.assertIn('document.addEventListener("pointerdown", onPointerDown, true)', source)
        self.assertIn('document.addEventListener("focusin", onFocusIn, true)', source)
        self.assertIn('document.addEventListener("keydown", onKeyDown, true)', source)
        self.assertIn('if (event.key !== "Escape") return;', source)
        self.assertIn('["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)', source)
        self.assertIn('voiceList?.addEventListener("scroll", () => closeVoiceMenus()', source)

    def test_voice_ids_stay_copyable_without_being_rendered_in_cards(self):
        source = (APP_DIR / "js" / "views" / "voiceLab.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles" / "custom-creation.css").read_text(encoding="utf-8")
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
        self.assertIn(".vl-voice-menu-item", styles)
        self.assertIn("width: 176px;", styles)
        self.assertNotIn('class="vl-voice-actions"', card_match.group(0))


if __name__ == "__main__":
    unittest.main()
