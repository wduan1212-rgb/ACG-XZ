import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class LoginLoadingStateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.index = (APP_DIR / "index.html").read_text(encoding="utf-8")
        cls.main = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        cls.css = (APP_DIR / "styles/base.css").read_text(encoding="utf-8")

    def test_login_title_exposes_accessible_phase_and_error_feedback(self):
        self.assertIn('id="lgModeTitle" class="lg-mode-title" role="status" aria-live="polite" aria-atomic="true"', self.index)
        self.assertIn('id="lgGateError" role="alert"', self.index)
        self.assertNotIn('id="lgProgress"', self.index)
        self.assertNotIn('class="lg-login-spark"', self.index)

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

    def test_login_title_has_short_process_copy_and_recovers_by_mode(self):
        self.assertIn('title: "正在验证账号权限…"', self.main)
        self.assertIn('title: "正在进入星阵…"', self.main)
        self.assertIn('title: "正在提交申请…"', self.main)
        phase = self.main.split("function setGatePhase", 1)[1].split("function setGateBusy", 1)[0]
        self.assertIn('title.classList.add("is-phase-entering")', phase)
        restore = self.main.split("function applyGateModeContent", 1)[1].split("function setGateMode", 1)[0]
        self.assertIn('title.classList.remove("is-phase-entering")', restore)
        self.assertIn('title.textContent = apply ? "申请" : "登录";', restore)

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
        waiting = self.css.split("登录等待态", 1)[1].split("@media (prefers-reduced-motion", 1)[0]
        self.assertIn(".lg-mode-title.is-phase-entering", waiting)
        self.assertIn("height: 29px", waiting)
        self.assertIn("@keyframes lgTitlePhaseIn", waiting)
        self.assertNotIn("lg-progress", waiting)
        self.assertNotIn("lg-login-spark", waiting)
        self.assertNotIn("lgButtonSheen", waiting)
        reduced = self.css.split("@media (prefers-reduced-motion: reduce)", 1)[1]
        self.assertIn(".lg-mode-title.is-phase-entering", reduced)
        self.assertNotIn("url(", waiting)

    def test_login_content_has_no_full_panel_frame(self):
        frame = self.css.split("登录内容直接悬浮在背景上", 1)[1].split("登录等待态", 1)[0]
        self.assertIn(".login-gate .lg-card", frame)
        self.assertIn("background: transparent", frame)
        self.assertIn("border-color: transparent", frame)
        self.assertIn("box-shadow: none", frame)
        self.assertIn("overflow: visible", frame)
        self.assertIn("backdrop-filter: none", frame)
        self.assertIn(".login-gate .lg-card::before", frame)
        self.assertIn("display: none", frame)
        busy = self.css.split(".lg-card.is-authenticating {", 1)[1].split("}", 1)[0]
        self.assertIn("border-color: transparent", busy)
        self.assertIn("box-shadow: none", busy)

    def test_login_error_does_not_reflow_centered_content(self):
        form = self.css.split(".lg-form { position: relative; }", 1)
        self.assertEqual(len(form), 2)
        error = form[1].split(".lg-gate-error {", 1)[1].split("}", 1)[0]
        self.assertIn("position: absolute", error)
        self.assertIn("top: calc(100% + 9px)", error)
        self.assertIn("left: 0", error)
        self.assertIn("right: 0", error)
        error_motion = self.css.split("@keyframes lgErrorIn", 1)[1].split("}", 1)[0]
        self.assertNotIn("transform", error_motion)


if __name__ == "__main__":
    unittest.main()
