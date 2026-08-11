import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class ChainWorkshopPrimaryActionsTest(unittest.TestCase):
    def test_next_action_is_unique_and_sits_beside_top_generate(self):
        workshop = (APP_DIR / "js/views/chainWorkshop.js").read_text(encoding="utf-8")

        self.assertEqual(workshop.count('id="wsNext"'), 1)
        self.assertIn('class="ws-topic-actions"', workshop)
        self.assertIn('class="btn gen sm"', workshop)
        self.assertIn(
            'A.materialMode === "creativeVideo" ? "data-creative-video-submit" : \'id="wsBriefGenerate"\'',
            workshop,
        )
        self.assertIn(
            'class="btn primary button-anthe" id="wsNext"><span>下一步：智能混剪',
            workshop,
        )

        actions_start = workshop.index('class="ws-topic-actions"')
        actions_end = workshop.index("</div>", actions_start)
        generate_at = workshop.index('class="btn gen sm"', actions_start, actions_end)
        next_at = workshop.index('id="wsNext"', actions_start, actions_end)
        self.assertLess(generate_at, next_at)

    def test_secondary_panels_do_not_own_the_next_action(self):
        workshop = (APP_DIR / "js/views/chainWorkshop.js").read_text(encoding="utf-8")

        digital_start = workshop.index('const digitalPlanHtml')
        digital_end = workshop.index('root.innerHTML =', digital_start)
        self.assertNotIn('id="wsNext"', workshop[digital_start:digital_end])

        info_start = workshop.index("function infoFlowPanel")
        info_end = workshop.index("function unitCard", info_start)
        self.assertNotIn('id="wsNext"', workshop[info_start:info_end])

    def test_restored_anthe_button_has_long_top_action_layout(self):
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")
        motion = (APP_DIR / "styles/ui-motion.css").read_text(encoding="utf-8")

        self.assertIn(".ws-topic-actions #wsNext", styles)
        self.assertIn("min-width: 220px", styles)
        self.assertIn("min-height: 42px", styles)
        self.assertIn(".btn.primary.button-anthe::before", motion)
        self.assertIn("transition: clip-path .4s", motion)
        self.assertIn(".btn.primary.button-anthe:hover::before", motion)


if __name__ == "__main__":
    unittest.main()
