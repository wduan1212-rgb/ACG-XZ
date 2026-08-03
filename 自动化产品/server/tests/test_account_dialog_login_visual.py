from pathlib import Path
import unittest


APP_ROOT = Path(__file__).resolve().parents[2]


class AccountDialogAndLoginVisualContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dialog = (APP_ROOT / "js/views/accountDialog.js").read_text(encoding="utf-8")
        cls.login = (APP_ROOT / "js/ui/loginBeams.js").read_text(encoding="utf-8")
        cls.components = (APP_ROOT / "styles/components.css").read_text(encoding="utf-8")

    def test_platform_and_content_choices_expose_clear_semantics(self):
        self.assertIn('class="seg-group ad-choice-group" id="adPlat"', self.dialog)
        self.assertIn('class="seg-group ad-choice-group" id="adMode"', self.dialog)
        self.assertIn('data-choice-help="${help}"', self.dialog)
        self.assertIn('aria-pressed="${draft.platform === v ? "true" : "false"}"', self.dialog)
        self.assertIn('aria-pressed="${draft.mode === v ? "true" : "false"}"', self.dialog)
        self.assertIn('x.setAttribute("aria-pressed", selected ? "true" : "false")', self.dialog)

    def test_account_dialog_has_legible_cancel_and_small_screen_layout(self):
        self.assertIn("account-dialog-cancel", self.dialog)
        self.assertIn(".mp-foot .account-dialog-cancel", self.components)
        self.assertIn("max-height: min(900px, calc(100dvh - 32px));", self.components)
        self.assertIn("@media (max-width: 720px)", self.components)
        responsive = self.components.split("@media (max-width: 720px)", 1)[1]
        self.assertIn(".ad-grid", responsive)
        self.assertIn("grid-template-columns: minmax(0, 1fr);", responsive)

    def test_login_uses_original_grainy_cyan_blue_violet_shader(self):
        self.assertIn("float fbm(vec2 p)", self.login)
        self.assertIn("vec3 cyan", self.login)
        self.assertIn("vec3 blue", self.login)
        self.assertIn("vec3 violet", self.login)
        self.assertIn("uResolution", self.login)
        self.assertIn('matchMedia("(prefers-reduced-motion: reduce)")', self.login)
        self.assertIn("webglcontextlost", self.login)
        self.assertIn(".login-gate.beams-fallback .lg-visual", self.components)


if __name__ == "__main__":
    unittest.main()
