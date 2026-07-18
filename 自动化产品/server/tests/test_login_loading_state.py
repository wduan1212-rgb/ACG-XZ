import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class LoginLoadingStateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        cls.main = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        cls.css = (APP_DIR / "styles/base.css").read_text(encoding="utf-8")

    def test_login_card_exposes_accessible_phase_and_error_feedback(self):
        self.assertIn('id="lgProgress" role="status" aria-live="polite"', self.index)
        self.assertIn('id="lgProgressTitle">正在验证账号', self.index)
        self.assertIn('id="lgGateError" role="alert"', self.index)
        self.assertIn('class="lg-login-spark" aria-hidden="true"', self.index)

    def test_login_submission_is_guarded_and_always_unlocked(self):
        wire_gate = self.main.split("function wireGate()", 1)[1].split("function logout()", 1)[0]
        self.assertGreaterEqual(wire_gate.count("if (gateBusy) return;"), 3)
        self.assertIn('setGateBusy(true, "applying")', wire_gate)
        self.assertIn("setGateBusy(true, phase)", wire_gate)
        self.assertGreaterEqual(wire_gate.count("finally {\n      setGateBusy(false);\n    }"), 2)
        self.assertIn("loginBtn.disabled = gateBusy", self.main)
        self.assertIn("control.disabled = gateBusy", self.main)

    def test_remote_login_has_distinct_validation_and_workspace_sync_phases(self):
        wire_gate = self.main.split("function wireGate()", 1)[1].split("function logout()", 1)[0]
        login_call = wire_gate.index("await remote.login(username, pin)")
        sync_phase = wire_gate.index('phase = "syncing"', login_call)
        remote_entry = wire_gate.index("await enterRemote(member)", sync_phase)
        self.assertLess(login_call, sync_phase)
        self.assertLess(sync_phase, remote_entry)
        self.assertIn("账号已验证，但工作区同步失败", self.main)
        self.assertIn("登录请求超时，请检查网络后重试", self.main)
        remote_entry = self.main.split("async function enterRemote(member)", 1)[1].split("function shakeCard()", 1)[0]
        self.assertIn("const synced = await pullRemote();", remote_entry)
        self.assertIn('if (!synced) throw new Error("请检查网络后重试");', remote_entry)

    def test_failed_sync_revokes_half_finished_identity_and_auto_resume_stays_gated(self):
        self.assertIn('if (phase === "syncing" && remote.isOn()) await clearPendingRemoteIdentity();', self.main)
        clear_identity = self.main.split("async function clearPendingRemoteIdentity()", 1)[1].split("function applyGateModeContent", 1)[0]
        self.assertIn("remote.logout();", clear_identity)
        self.assertIn("state.role = null;", clear_identity)
        self.assertIn("state.ui.currentMemberId = null;", clear_identity)
        self.assertIn("await Promise.allSettled([", clear_identity)
        resume = self.main.split("if (remote.isOn() && remote.hasToken())", 1)[1].split("else if (!remote.isOn()", 1)[0]
        self.assertIn("const synced = await pullRemote();", resume)
        self.assertIn("if (synced) {", resume)
        self.assertGreaterEqual(resume.count("await clearPendingRemoteIdentity();"), 2)

    def test_motion_is_lightweight_and_reduced_motion_safe(self):
        self.assertIn(".lg-progress-orbit", self.css)
        self.assertIn(".lg-progress-line::after", self.css)
        reduced = self.css.split("@media (prefers-reduced-motion: reduce)", 1)[1]
        self.assertIn(".lg-progress-orbit", reduced)
        self.assertIn(".lg-login-spark", reduced)
        self.assertNotIn("url(", self.css.split("登录等待态", 1)[1].split("@media (prefers-reduced-motion", 1)[0])


if __name__ == "__main__":
    unittest.main()
