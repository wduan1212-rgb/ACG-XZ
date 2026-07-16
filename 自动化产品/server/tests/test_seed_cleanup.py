import json
import subprocess
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


def run_node(script: str) -> dict:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=APP_DIR,
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout.strip())


class SeedCleanupTest(unittest.TestCase):
    def test_redundant_account_seed_is_removed_and_profile_seed_is_smaller(self):
        self.assertFalse((APP_DIR / "js/data/xhsAccountsSeed.js").exists())
        source = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (APP_DIR / "js").rglob("*.js")
        )
        self.assertNotIn("xhsAccountsSeed", source)

        result = run_node(
            r"""
const { ACCOUNT_PROFILE_SEED } = await import('./js/data/accountProfilesSeed.js');
console.log(JSON.stringify({
  count: ACCOUNT_PROFILE_SEED.length,
  xhsCount: ACCOUNT_PROFILE_SEED.filter(x => x.platform === '小红书').length,
  videoCount: ACCOUNT_PROFILE_SEED.filter(x => x.platform === '视频号').length,
  positionCount: ACCOUNT_PROFILE_SEED.filter(x => Object.hasOwn(x, 'position')).length,
  hasVoiceConfig: ACCOUNT_PROFILE_SEED.some(x => x.voiceId || x.voiceName)
}));
"""
        )
        self.assertEqual(80, result["count"])
        self.assertEqual(50, result["xhsCount"])
        self.assertEqual(30, result["videoCount"])
        self.assertEqual(0, result["positionCount"])
        self.assertTrue(result["hasVoiceConfig"])

    def test_existing_accounts_are_never_reconciled_to_seed(self):
        main = (APP_DIR / "js/main.js").read_text(encoding="utf-8")
        self.assertIn("async function bootstrapAccountProfilesIfEmpty", main)
        self.assertIn("if ((state.accounts || []).length || state.ui.accountProfileVersion) return 0;", main)
        self.assertNotIn("cleanupNonSeedAccounts", main)
        self.assertNotIn("applyAccountProfileSeed", main)
        self.assertNotIn("preserveManualStyle", main)
        self.assertNotIn('remote.deleteDoc("accounts"', main)
        self.assertNotIn("ensureXhsSeedAccounts", main)

    def test_batch_creation_has_no_automatic_topic_fallback(self):
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        self.assertNotIn("pickDefaultCreativeTopic", orchestrator)
        self.assertNotIn("existingBatchTopics", orchestrator)
        self.assertNotIn('"自定义文案创作"', orchestrator)
        self.assertNotIn('plan.topicMode === "random"', orchestrator)
        self.assertIn('setStatus(p, "failed", "请先填写标题")', orchestrator)
        self.assertIn("if (customCopyMode && !customCopyTitle)", orchestrator)
        self.assertIn('setStatus(p, "failed", isImg ? "图文组图请先填写标题" : "视频生产请先填写标题")', orchestrator)

    def test_trend_library_only_structures_a_user_supplied_topic(self):
        ai = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        trend = (APP_DIR / "js/data/xhsTrendLibrary.js").read_text(encoding="utf-8")
        self.assertIn('import { buildTrendGuide, buildTrendPrep } from "../data/xhsTrendLibrary.js";', ai)
        self.assertNotIn("xhsTrendLibrary", orchestrator)
        self.assertIn("export function buildTrendPrep", trend)
        self.assertNotIn("pickDefaultCreativeTopic", trend)
        self.assertNotIn("DEFAULT_CREATIVE_DIRECTIONS", trend)
        self.assertNotIn("defaultTopicsForDirection", trend)
        self.assertNotIn("没有用户明确内容时", ai)
        result = run_node(
            r"""
const { buildTrendPrep } = await import('./js/data/xhsTrendLibrary.js');
const short = buildTrendPrep({ topic: '周报相关' });
console.log(JSON.stringify({
  shortTopic: short.creativeContent,
  shortGuide: short.guide,
  emptyTopic: buildTrendPrep({ topic: '' }).creativeContent
}));
"""
        )
        self.assertEqual("周报相关", result["shortTopic"])
        self.assertIn("用户主题：周报相关", result["shortGuide"])
        self.assertNotIn("预制标题", result["shortGuide"])
        self.assertNotIn("文案骨架", result["shortGuide"])
        self.assertEqual("", result["emptyTopic"])

    def test_empty_title_is_rejected_before_any_model_request(self):
        result = run_node(
            r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error('empty title must not reach fetch');
};
const { AI } = await import('./js/api/ai.js?v=seed-cleanup-test');
const errors = [];
try {
  await AI.generateCreativeBrief({ userText: '', account: {} });
} catch (error) {
  errors.push(error.message || String(error));
}
try {
  await AI.generateScript({ topic: '', account: {}, image: true });
} catch (error) {
  errors.push(error.message || String(error));
}
console.log(JSON.stringify({ fetchCalls, errors }));
"""
        )
        self.assertEqual(0, result["fetchCalls"])
        self.assertEqual(
            ["请先填写发布标题或创作内容", "请先填写发布标题或创作内容"],
            result["errors"],
        )

    def test_short_user_title_is_kept_verbatim_without_model_selection(self):
        result = run_node(
            r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls += 1;
  throw new Error('short title must not reach fetch');
};
const { AI } = await import('./js/api/ai.js?v=seed-cleanup-short-title-test');
const title = '用户自己写的标题';
const out = await AI.generateCreativeBrief({ userText: title, account: {} });
console.log(JSON.stringify({ out, fetchCalls, source: AI.lastSource }));
"""
        )
        self.assertEqual("用户自己写的标题", result["out"])
        self.assertEqual(0, result["fetchCalls"])
        self.assertEqual("llm", result["source"])


if __name__ == "__main__":
    unittest.main()
