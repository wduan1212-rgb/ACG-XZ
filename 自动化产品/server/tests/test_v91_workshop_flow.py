import json
import subprocess
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class V91WorkshopFlowTest(unittest.TestCase):
    def test_infoflow_skips_storyboards_and_places_actions_in_panel(self):
        workshop = (APP_DIR / "js/views/chainWorkshop.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        ai = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")

        self.assertNotIn('id="wsInfoStoryboard"', workshop)
        self.assertNotIn('id="wsInfoStoryboardDrop"', workshop)
        self.assertNotIn("generateInfoFlowStoryboards", workshop)
        self.assertNotIn("generateBatchInfoFlowStoryboards", orchestrator)
        self.assertNotIn("模型未返回 B 面分镜图提示词", ai)
        self.assertNotIn("没有人声就明确写", ai)
        self.assertNotIn("每个时间段必须明确口播原话", ai)
        # 字幕只能旁路读取，不能重写或反向筛选原有创意提示词。
        self.assertNotIn("实际原话必须统一写成中文双引号", ai)
        self.assertNotIn(
            "normalizeInfoFlowDialogueQuotes(cleanInfoFlowDirectorText(front",
            ai,
        )
        self.assertNotIn("hasUnquotedInfoFlowDialogue(combined)", ai)
        self.assertIn("所选参考图直接随前后两段视频提交", workshop)
        self.assertIn('id="wsInfoPlan"', workshop)
        self.assertIn('id="wsInfoVideo"', workshop)
        self.assertIn('id="wsNext"', workshop)
        self.assertLess(
            workshop.index('class="ws-ratio-control"', workshop.index("function infoFlowPanel")),
            workshop.index('id="wsInfoPlan"', workshop.index("function infoFlowPanel")),
        )
        self.assertIn("const n = await prepareInfoFlowVideos();", workshop)

    def test_infoflow_units_receive_selected_refs_directly(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[] };
const { buildMaterialUnits } = await import('./js/domain/productions.js');
const p = {
  artifacts: {
    script: { shots: [] },
    audio: { perShot: [], duration: 0, source: '' },
    boards: {
      materialMode: 'infoFlow',
      sceneRefAssetIds: ['scene-1'],
      omniRefAssetIds: ['scene-1', 'scene-2'],
      characterRefAssetId: 'role-1',
      infoFlow: { segments: [
        { id:'front15', duration:15, videoPrompt:'front' },
        { id:'back15', duration:15, videoPrompt:'back' }
      ] }
    }
  }
};
console.log(JSON.stringify(buildMaterialUnits(p).map(unit => ({
  mode: unit.mode,
  needsImage: unit.needsImage,
  refs: unit.refAssetIds
}))));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        self.assertEqual(json.loads(result.stdout.strip()), [
            {"mode": "i2v", "needsImage": True, "refs": ["scene-1", "scene-2"]},
            {"mode": "i2v", "needsImage": True, "refs": ["scene-1", "scene-2"]},
        ])

    def test_role_board_uses_admin_managed_empty_modal(self):
        studio = (APP_DIR / "js/views/studio.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")

        self.assertIn("function openRoleRefModal()", studio)
        self.assertIn('data-role-drop', studio)
        self.assertIn("暂未设置角色版", studio)
        self.assertIn("只有管理员可以替换", studio)
        self.assertIn('if (kind === "role")', studio)
        self.assertNotIn('data-sh-ref="role" ${!charRefUrl && !admin ? "disabled"', studio)
        self.assertIn(".sh-role-drop.can-edit.drag-over", styles)

    def test_single_account_cover_has_distinct_drop_feedback(self):
        workshop = (APP_DIR / "js/views/chainWorkshop.js").read_text(encoding="utf-8")
        styles = (APP_DIR / "styles/views.css").read_text(encoding="utf-8")

        self.assertIn("wireDropZone(coverStage", workshop)
        self.assertIn("await uploadCoverImage(file)", workshop)
        self.assertIn("拖到右侧预览位可直接设为封面", workshop)
        self.assertIn(".ws-cover-inline .cover-frame.drag-over", styles)

    def test_video_creation_requires_user_written_title(self):
        workshop = (APP_DIR / "js/views/chainWorkshop.js").read_text(encoding="utf-8")

        self.assertIn('if (!customTitle) {', workshop)
        self.assertIn('toast("先填写发布标题，再生成文案和视频")', workshop)
        self.assertIn('const title = ($("#wsCopyTitle", root)?.value || "").trim()', workshop)
        self.assertNotIn("customTitle = customTitle || generated.title", workshop)


if __name__ == "__main__":
    unittest.main()
