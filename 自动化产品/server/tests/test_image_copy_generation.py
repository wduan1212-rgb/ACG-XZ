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


class ImageCopyGenerationTest(unittest.TestCase):
    def test_server_managed_llm_cannot_be_overridden_by_stale_browser_key(self):
        result = run_node(
            r"""
globalThis.window = {};
const { LLM_CONFIG, applyKeyOverrides } = await import('./js/api/llm.js?v=server-priority-test');
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.model = 'server-model';
LLM_CONFIG.serverManaged = true;
const changed = applyKeyOverrides([{
  type: 'language',
  secret: 'stale-browser-key',
  provider: 'https://stale.example/v1/chat/completions',
  model: 'stale-model'
}]);
console.log(JSON.stringify({
  changed,
  endpoint: LLM_CONFIG.endpoint,
  apiKey: LLM_CONFIG.apiKey,
  model: LLM_CONFIG.model,
  serverManaged: LLM_CONFIG.serverManaged
}));
"""
        )
        self.assertFalse(result["changed"])
        self.assertEqual("/api/chat/completions", result["endpoint"])
        self.assertEqual("server-managed", result["apiKey"])
        self.assertEqual("server-model", result["model"])
        self.assertTrue(result["serverManaged"])

    def test_title_copy_is_reported_as_real_llm_output(self):
        result = run_node(
            r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: '{"copy":"先给结论：整理前先明确文件范围和最终交付物。\\n执行时按来源分组，再检查缺失项和重复项；最后保留一份可复用清单，下一次直接按同一顺序核对。\\n#资料整理 #办公方法 #效率工具 #实测复盘"}' } }]
  }),
  text: async () => ''
});
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260723-v117-2');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260723-v117-2');
const out = await AI.generateImageCopyFromTitle({
  title: '资料整理怎么避免漏文件',
  account: { tone: '专业、清楚、有具体信息' }
});
console.log(JSON.stringify({
  source: out.source,
  lastSource: AI.lastSource,
  note: AI.sourceNote('正文生成成功'),
  hasBody: out.copy.includes('整理前先明确文件范围')
}));
"""
        )
        self.assertEqual("llm-title-copy", result["source"])
        self.assertEqual("llm-title-copy", result["lastSource"])
        self.assertEqual("正文生成成功", result["note"])
        self.assertTrue(result["hasBody"])

    def test_title_copy_uses_selected_product_only_as_a_fact_boundary(self):
        result = run_node(
            r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
let request = {};
globalThis.fetch = async (_url, options = {}) => {
  request = JSON.parse(options.body || '{}');
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"copy":"先核对资料范围，再按字段逐项检查遗漏。\\n#资料整理 #工作方法 #复核清单 #办公技巧"}' } }]
    }),
    text: async () => ''
  };
};
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260723-v117-2');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260723-v117-2');
await AI.generateImageCopyFromTitle({
  title: '资料整理怎么避免漏文件',
  account: { tone: '专业、清楚、有具体信息' },
  product: { id: 'product-a', name: '产品甲', shortName: '甲工具' }
});
const userPrompt = String(request.messages?.[1]?.content || '');
console.log(JSON.stringify({
  includesSelectedProduct: userPrompt.includes('所选产品：甲工具'),
  includesBoundary: userPrompt.includes('标题没有谈到该产品时不得强行植入'),
  includesTitle: userPrompt.includes('资料整理怎么避免漏文件')
}));
"""
        )
        self.assertTrue(result["includesSelectedProduct"])
        self.assertTrue(result["includesBoundary"])
        self.assertTrue(result["includesTitle"])

    def test_title_driven_prompt_generation_does_not_silently_use_template(self):
        result = run_node(
            r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
globalThis.fetch = async () => ({
  ok: false,
  status: 503,
  text: async () => 'temporary upstream failure'
});
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260723-v117-2');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260723-v117-2');
let error = '';
try {
  await AI.generateImagePrompts({
    script: '图1｜核对文件范围｜图上文案：先定范围',
    account: { styleProfile: '白底清晰信息卡' },
    imageCount: 1,
    topic: '资料整理怎么避免漏文件',
    copy: {
      title: '资料整理怎么避免漏文件',
      body: '整理前先明确文件范围，再按清单核对缺失项。'
    },
    requireLlm: true
  });
} catch (err) {
  error = err.message || String(err);
}
console.log(JSON.stringify({ error, lastSource: AI.lastSource }));
"""
        )
        self.assertIn("图卡提示词模型生成失败：HTTP 503", result["error"])
        self.assertEqual("error", result["lastSource"])

    def test_title_body_and_multi_image_prompts_run_in_order_and_stay_balanced(self):
        result = run_node(
            r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
const requests = [];
globalThis.fetch = async (_url, options = {}) => {
  const request = JSON.parse(options.body || '{}');
  requests.push(request);
  const system = String(request.messages?.[0]?.content || '');
  const content = system.includes('小红书图文正文写手')
    ? JSON.stringify({ copy: '先确定访谈目标和受访者范围。\\n访谈时按问题、证据、原话三列记录。\\n整理阶段合并重复观点并标记分歧。\\n最后输出结论、证据和下一步行动。\\n#用户访谈 #研究方法 #报告整理 #工作流程' })
    : JSON.stringify({ shots: [
        { title:'先看最终目标', prompt:'主标题完整显示，访谈目标和受访者范围作为简洁入口。', ui:true },
        { title:'三列记录', prompt:'问题、证据、原话三列记录卡片，层级清楚。', ui:true },
        { title:'合并重复观点', prompt:'相同观点汇聚，保留不同证据来源。', ui:true },
        { title:'标记真实分歧', prompt:'分歧观点左右对照并标记证据。', ui:true },
        { title:'形成行动报告', prompt:'结论、证据、下一步行动组成最终报告。', ui:true }
      ] });
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => ''
  };
};
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260723-v117-2');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260723-v117-2');
const generated = await AI.generateImageCopyFromTitle({
  title: '客户访谈怎么整理成可复用报告',
  account: { tone: '专业、清楚、有具体信息' }
});
const prompts = await AI.generateImagePrompts({
  script: '按最终正文拆成五张图',
  account: { styleProfile: '白底清晰信息卡' },
  imageCount: 5,
  topic: generated.title,
  copy: { title: generated.title, body: generated.copy },
  requireLlm: true
});
const promptTexts = prompts.shots.map(item => item.prompt || '');
console.log(JSON.stringify({
  requestCount: requests.length,
  secondContainsGeneratedBody: JSON.stringify(requests[1] || {}).includes('访谈时按问题、证据、原话三列记录'),
  secondRequestsDenseInnerCards: JSON.stringify(requests[1] || {}).includes('2—4 个来自该页正文信息的具体支撑模块'),
  shotCount: prompts.shots.length,
  firstPromptIncludesTitle: promptTexts[0].includes('客户访谈怎么整理成可复用报告'),
  coverStaysLight: !promptTexts[0].includes('2—4 个层级分明的信息模块'),
  denseInnerCount: promptTexts.slice(1).filter(text => text.includes('2—4 个层级分明的信息模块')).length,
  uniquePromptCount: new Set(promptTexts).size,
  minLength: Math.min(...promptTexts.map(text => text.length)),
  maxLength: Math.max(...promptTexts.map(text => text.length))
}));
"""
        )
        self.assertEqual(2, result["requestCount"])
        self.assertTrue(result["secondContainsGeneratedBody"])
        self.assertTrue(result["secondRequestsDenseInnerCards"])
        self.assertEqual(5, result["shotCount"])
        self.assertTrue(result["firstPromptIncludesTitle"])
        self.assertTrue(result["coverStaysLight"])
        self.assertEqual(4, result["denseInnerCount"])
        self.assertEqual(5, result["uniquePromptCount"])
        self.assertGreater(result["minLength"], 35)
        self.assertLess(result["maxLength"], 700)

    def test_workshop_tracks_manual_and_generated_copy_sources(self):
        boards = (APP_DIR / "js/views/chainBoards.js").read_text(encoding="utf-8")
        self.assertIn('p.artifacts.copy.source = "manual"', boards)
        self.assertIn("const shouldGenerateBody =", boards)
        self.assertIn('Boolean(body) && !bodySource', boards)
        self.assertIn("bodyWasTemplateGenerated", boards)
        self.assertIn("generatedCopy.source || AI.lastSource", boards)
        self.assertIn("requireLlm: true", boards)

        drawer = (APP_DIR / "js/views/prodDrawer.js").read_text(encoding="utf-8")
        self.assertIn('p.artifacts.copy.source = "manual"', drawer)


if __name__ == "__main__":
    unittest.main()
