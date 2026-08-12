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
        check=False,
    )
    if result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return json.loads(result.stdout.strip())


class ImageCopyGenerationTest(unittest.TestCase):
    def test_title_copy_is_generated_under_limit_without_truncation(self):
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
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      copy: '文'.repeat(850) + '完整收尾。\n#批量图文 #标题生文案'
    }) } }] }),
    text: async () => ''
  };
};
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=copy-limit-test');
const out = await AI.generateImageCopyFromTitle({ title:'批量图文如何稳定生成', account:{} });
console.log(JSON.stringify({
  length: [...out.copy].length,
  endsComplete: out.copy.includes('完整收尾。'),
  requestCount: requests.length,
  tags: [...out.copy.matchAll(/#[^\s#]+/g)].map(match => match[0]),
  promptHasGenerationBudget: String(requests[0]?.messages?.[0]?.content || '').includes('900 个 Unicode 字符以内')
}));
"""
        )
        self.assertLess(result["length"], 1000)
        self.assertTrue(result["endsComplete"])
        self.assertEqual(1, result["requestCount"])
        self.assertGreaterEqual(len(result["tags"]), 4)
        self.assertIn("#批量图文", result["tags"])
        self.assertTrue(result["promptHasGenerationBudget"])

    def test_title_copy_over_limit_fails_without_truncation_or_rewrite(self):
        result = run_node(
            r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
let requestCount = 0;
globalThis.fetch = async () => {
  requestCount += 1;
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      copy: '文'.repeat(1100) + '不可丢失的完整末句。\\n#批量图文 #标题生文案'
    }) } }] }),
    text: async () => ''
  };
};
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=copy-no-truncate-test');
let error = '';
try {
  await AI.generateImageCopyFromTitle({ title:'批量图文如何稳定生成', account:{} });
} catch (err) {
  error = err.message || String(err);
}
console.log(JSON.stringify({ error, requestCount }));
"""
        )
        self.assertIn("超过 1000 字", result["error"])
        self.assertEqual(1, result["requestCount"])

    def test_single_image_title_copy_removes_duplicate_title_and_markdown(self):
        result = run_node(
            r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify({
    copy:'# 百度搭子你的好伙伴\\n**百度搭子你的好伙伴**\\n- 先整理资料，再核对交付结果。\\n- 保留真实边界，不夸大能力。\\n#百度搭子 #效率工具 #实测'
  }) } }] }),
  text: async () => ''
});
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=single-copy-clean-test');
const out = await AI.generateImageCopyFromTitle({ title:'百度搭子你的好伙伴', account:{} });
console.log(JSON.stringify({ copy:out.copy }));
"""
        )
        self.assertNotIn("**", result["copy"])
        self.assertNotIn("\n", result["copy"])
        self.assertFalse(result["copy"].startswith("百度搭子你的好伙伴"))
        self.assertIn("先整理资料", result["copy"])

    def test_generated_copy_removes_only_exact_repeated_product_parentheses(self):
        result = run_node(
            r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify({
      copy:'百度搭子（百度搭子）可以整理资料；百度搭子（桌面端）仍保留有意义的说明。\\n#百度搭子 #效率工具'
    }) } }]
  }),
  text: async () => ''
});
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=copy-dedupe-test');
const out = await AI.generateImageCopyFromTitle({
  title:'桌面智能体真实体验',
  account:{ tone:'自然真实' },
  product:{ id:'dumate', name:'百度搭子', shortName:'百度搭子' }
});
console.log(JSON.stringify({ copy:out.copy }));
"""
        )
        self.assertIn("百度搭子可以整理资料", result["copy"])
        self.assertNotIn("百度搭子（百度搭子）", result["copy"])
        self.assertIn("百度搭子（桌面端）", result["copy"])

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
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260727-v118-7');
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
const requests = [];
globalThis.fetch = async (_url, options = {}) => {
  const request = JSON.parse(options.body || '{}');
  requests.push(request);
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"copy":"先核对资料范围，再按字段逐项检查遗漏。\\n#资料整理 #工作方法 #复核清单 #办公技巧"}' } }]
    }),
    text: async () => ''
  };
};
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260727-v118-7');
await AI.generateImageCopyFromTitle({
  title: '资料整理怎么避免漏文件',
  account: { tone: '专业、清楚、有具体信息' },
  product: { id: 'product-a', name: '产品甲', shortName: '甲工具' }
});
const userPrompt = String(requests[0]?.messages?.[1]?.content || '');
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
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260727-v118-7');
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
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260727-v118-7');
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

    def test_title_copy_uses_short_vision_context_without_repeating_all_reference_names_in_prompts(self):
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
  const content = system.includes('小红书笔记配图的图片提示词设计师')
    ? JSON.stringify({ shots:[{ title:'封面', prompt:'清晰的工作台流程卡片，主标题置于上方。' }] })
    : JSON.stringify({ copy:'把资料放进工作台后，先确认目标，再按步骤生成初版。\n#内容工作流 #AI工具 #创作方法 #百度搭子' });
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => ''
  };
};
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=reference-copy-context-test');
const out = await AI.generateImageCopyFromTitle({
  title: '百度搭子怎么把创作流程跑起来',
  account: { tone: '清楚、专业' },
  referenceContext: '可围绕创作工作台中从资料输入、任务推进到成片输出的连续流程组织正文。'
});
const prompts = await AI.generateImagePrompts({
  script: '图1｜封面｜图上文案：跑通创作流程',
  account: { styleProfile: '清晰卡片' }, imageCount: 1,
  copy: { title: out.title, body: out.copy },
  referencePlans: [{ index:0, referenceIds:['r1'], instruction:'将附件1作为中部产品操作证据，旁边保留标题。' }],
  styleRefName: 'logo、主界面、自媒体套件、视频生成过程', requireLlm: true
});
console.log(JSON.stringify({
  copyUsesContext: String(requests[0]?.messages?.[1]?.content || '').includes('从资料输入、任务推进到成片输出'),
  promptDoesNotRepeatAllNames: !String(prompts.shots?.[0]?.prompt || '').includes('logo、主界面、自媒体套件、视频生成过程'),
  promptKeepsPlacement: String(prompts.shots?.[0]?.prompt || '').includes('附件使用：将附件1作为中部产品操作证据')
}));
"""
        )
        self.assertTrue(result["copyUsesContext"])
        self.assertTrue(result["promptDoesNotRepeatAllNames"])
        self.assertTrue(result["promptKeepsPlacement"])


if __name__ == "__main__":
    unittest.main()
