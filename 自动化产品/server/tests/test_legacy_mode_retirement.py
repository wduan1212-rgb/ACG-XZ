import json
import subprocess
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


class LegacyModeRetirementTest(unittest.TestCase):
    def test_old_mode_switches_and_routes_are_retired(self):
        workshop = (APP_DIR / "js/views/chainWorkshop.js").read_text(encoding="utf-8")
        studio = (APP_DIR / "js/views/studio.js").read_text(encoding="utf-8")
        productions = (APP_DIR / "js/domain/productions.js").read_text(encoding="utf-8")
        main = (APP_DIR / "js/main.js").read_text(encoding="utf-8")

        self.assertNotIn("data-dh-mode", workshop)
        self.assertNotIn("data-material-mode", workshop)
        self.assertNotIn("Seedance 模式沿用视频模型直接生成", workshop)
        self.assertNotIn("renderPromptsPage", studio)
        self.assertNotIn("renderRenderPage", studio)
        self.assertNotIn("renderScriptPage", studio)
        self.assertIn('workshop: { label: "视频制作"', productions)
        self.assertIn('p.subType === "数字人" ? "数字人制作" : "信息流制作"', studio)
        self.assertIn('acc.subType === "数字人" ? "数字人制作" : "信息流制作"', main)
        for retired in ("chainScript.js", "chainPrompts.js", "chainRender.js"):
            self.assertFalse((APP_DIR / "js/views" / retired).exists(), retired)

    def test_prompts_module_only_keeps_live_product_facts(self):
        prompts = (APP_DIR / "js/api/prompts.js").read_text(encoding="utf-8")
        ai = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        self.assertIn("export const DUMATE_BRIEF", prompts)
        for retired in (
            "PROMPT_FRAMEWORK",
            "NO_DH_FRAMEWORK",
            "MATERIAL_VIDEO_NEG",
            "MATERIAL_IMAGE_NEG",
            "CHAR_DIR_POOL",
            "buildCharBoardPrompt",
            "generateShotVideoPrompts",
            "generatePrompts({",
            "_mockPrompts",
        ):
            self.assertNotIn(retired, prompts + ai)

    def test_supported_modes_and_batch_digital_tts_are_real(self):
        script = r"""
globalThis.localStorage = { getItem:()=>null, setItem:()=>{}, removeItem:()=>{} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener:()=>{}, dispatchEvent:()=>{}, __toast:()=>{} };
globalThis.document = { querySelector:()=>null, querySelectorAll:()=>[], body:{ dataset:{} } };
const { state } = await import('./js/core/store.js');
const { createProduction, enforceSupportedVideoMode } = await import('./js/domain/productions.js');
const { createUnitVideoJobs, prepareBatchDigitalHuman } = await import('./js/agent/orchestrator.js?v=20260718-v94-1');
state.accounts = [
  { id:'dh', name:'数字人账号', mode:'视频', subType:'数字人', platform:'视频号', voiceId:'voice-test', charBoardAssetId:'char-1' },
  { id:'material', name:'素材账号', mode:'视频', subType:'无数字人', platform:'视频号' }
];
state.assets = [{ id:'char-1', accountId:'dh', type:'图片', name:'角色版', tags:['角色版'] }];
state.productions = [];
const digital = createProduction({ accountId:'dh', topic:'测试数字人' });
const material = createProduction({ accountId:'material', topic:'测试信息流' });
digital.artifacts.script.shots = [
  { line:'第一段口播内容要自然清楚。' },
  { line:'第二段继续解释真实功能和结果。' },
  { line:'第三段完成收束。' }
];
digital.artifacts.boards.generationMode = 'seedance';
material.artifacts.boards.generationMode = 'seedance';
material.artifacts.boards.materialMode = 'standard';
enforceSupportedVideoMode(digital);
enforceSupportedVideoMode(material);
let calls = 0;
const prepared = await prepareBatchDigitalHuman(digital, state.accounts[0], {
  ttsConfigured: true,
  assetExists: id => state.assets.some(asset => asset.id === id),
  synthesize: async ({ text, voiceId }) => {
    calls++;
    return { audioDataUrl:'data:audio/mp3;base64,ZmFrZQ==', duration:Math.max(3, text.length / 5), voiceId };
  },
  storeAudio: async ({ index, dataUrl }) => {
    const asset = { id:`audio-${index + 1}`, accountId:'dh', type:'音频', name:`口播${index + 1}`, dataUrl };
    state.assets.push(asset);
    return asset;
  }
});
const queued = createUnitVideoJobs(digital);
console.log(JSON.stringify({
  digitalMode:digital.artifacts.boards.generationMode,
  digitalLegacy:digital.artifacts.boards.legacyGenerationMode,
  materialMode:material.artifacts.boards.generationMode,
  materialUiMode:material.artifacts.boards.materialMode,
  materialLegacy:material.artifacts.boards.legacyMaterialMode,
  prepared,
  calls,
  queued,
  jobs:state.jobs.map(job => ({ model:job.model, refs:job.refAssetIds, duration:job.duration })),
  segments:digital.artifacts.boards.digitalHuman.segments.map(segment => ({
    dur:segment.dur,
    audioAssetId:segment.audioAssetId,
    characterRefAssetId:segment.characterRefAssetId,
    prompt:segment.videoPrompt
  })),
  audioSource:digital.artifacts.audio.source
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", script],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        data = json.loads(result.stdout.strip())
        self.assertEqual(data["digitalMode"], "digitalHuman")
        self.assertEqual(data["digitalLegacy"], "seedance")
        self.assertEqual(data["materialMode"], "infoFlow")
        self.assertEqual(data["materialUiMode"], "infoFlow")
        self.assertEqual(data["materialLegacy"], "standard")
        self.assertTrue(data["prepared"]["ready"])
        self.assertGreater(data["calls"], 0)
        self.assertGreater(data["queued"], 0)
        self.assertTrue(all(job["model"] == "__digital_human__" for job in data["jobs"]))
        self.assertTrue(all(len(job["refs"]) == 2 for job in data["jobs"]))
        self.assertEqual(data["audioSource"], "tts-segments")
        self.assertTrue(all(segment["dur"] <= 30 for segment in data["segments"]))
        self.assertTrue(all(segment["audioAssetId"] for segment in data["segments"]))
        self.assertTrue(all(segment["characterRefAssetId"] == "char-1" for segment in data["segments"]))
        self.assertTrue(all(segment["prompt"] for segment in data["segments"]))


if __name__ == "__main__":
    unittest.main()
