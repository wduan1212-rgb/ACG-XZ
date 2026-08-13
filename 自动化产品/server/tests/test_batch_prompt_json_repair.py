import json
import subprocess
import unittest
from pathlib import Path


APP_DIR = Path(__file__).resolve().parents[2]


def run_node(source: str) -> dict:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", source],
        cwd=APP_DIR,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr or result.stdout)
    return json.loads(result.stdout)


class BatchPromptJsonRepairTest(unittest.TestCase):
    def test_concurrent_boards_use_one_scoped_format_repair_before_image_submit(self):
        payload = run_node(r'''
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', protocol:'http:', hostname:'127.0.0.1', port:'8787', hash:'' };
globalThis.window = { location:globalThis.location, addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };

const requests = [];
let imageSubmits = 0;
let boardAOriginalCalls = 0;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/api/image/generate')) imageSubmits += 1;
  const request = JSON.parse(options.body || '{}');
  requests.push(request);
  const system = String(request.messages?.[0]?.content || '');
  const user = String(request.messages?.at?.(-1)?.content || '');
  let content;
  if (system.includes('严格 JSON 格式修复器')) {
    content = '{"shots":[{"title":"甲任务","prompt":"甲任务的真实图卡计划","ui":true}]}';
  } else if (user.includes('并发甲')) {
    boardAOriginalCalls += 1;
    content = '{"shots":[{"title":"甲任务","prompt":"甲任务的真实图卡计划","ui":true}]';
  } else {
    content = '{"shots":[{"title":"乙任务","prompt":"乙任务的真实图卡计划","ui":true}]}';
  }
  return {
    ok:true,
    status:200,
    headers:{ get(){ return null; } },
    text:async()=>'',
    json:async()=>({ choices:[{ message:{ content } }] })
  };
};

const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260813-v1432-publish-export-1');
const completedTask = { id:'done', stage:'review', images:[{ id:'kept' }] };
const completedBefore = JSON.stringify(completedTask);
const requestFor = topic => AI.generateImagePrompts({
  script:`${topic} 的既定正文`,
  account:{ styleProfile:'白底清晰信息卡' },
  imageCount:1,
  topic,
  copy:{ title:topic, body:`${topic} 的正文事实` },
  requireLlm:true
});
const [boardA, boardB] = await Promise.all([
  requestFor('并发甲'),
  requestFor('并发乙')
]);
const repairRequests = requests.filter(request => String(request.messages?.[0]?.content || '').includes('严格 JSON 格式修复器'));
console.log(JSON.stringify({
  aCount:boardA.shots.length,
  bCount:boardB.shots.length,
  aPrompt:boardA.shots[0].prompt,
  bPrompt:boardB.shots[0].prompt,
  requestCount:requests.length,
  repairCount:repairRequests.length,
  repairTemperature:repairRequests[0]?.temperature,
  repairContainsFirstAnswer:JSON.stringify(repairRequests[0] || {}).includes('甲任务的真实图卡计划'),
  boardAOriginalCalls,
  imageSubmits,
  completedUntouched:completedBefore === JSON.stringify(completedTask)
}));
''')
        self.assertEqual(1, payload["aCount"])
        self.assertEqual(1, payload["bCount"])
        self.assertIn("并发甲", payload["aPrompt"])
        self.assertNotIn("并发乙", payload["aPrompt"])
        self.assertIn("并发乙", payload["bPrompt"])
        self.assertNotIn("并发甲", payload["bPrompt"])
        self.assertEqual(3, payload["requestCount"])
        self.assertEqual(1, payload["repairCount"])
        self.assertEqual(0, payload["repairTemperature"])
        self.assertTrue(payload["repairContainsFirstAnswer"])
        self.assertEqual(1, payload["boardAOriginalCalls"])
        self.assertEqual(0, payload["imageSubmits"])
        self.assertTrue(payload["completedUntouched"])

    def test_irreparable_model_output_fails_before_image_submit(self):
        payload = run_node(r'''
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', protocol:'http:', hostname:'127.0.0.1', port:'8787', hash:'' };
globalThis.window = { location:globalThis.location, addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
let calls = 0;
let imageSubmits = 0;
globalThis.fetch = async (url, options = {}) => {
  if (String(url).includes('/api/image/generate')) imageSubmits += 1;
  const request = JSON.parse(options.body || '{}');
  const repair = String(request.messages?.[0]?.content || '').includes('严格 JSON 格式修复器');
  calls += 1;
  const content = repair ? '{"__json_repair_failed__":true}' : '这份回答没有 JSON，也没有任何可验证图卡字段';
  return {
    ok:true,
    status:200,
    headers:{ get(){ return null; } },
    text:async()=>'',
    json:async()=>({ choices:[{ message:{ content } }] })
  };
};
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260727-v118-7');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260813-v1432-publish-export-1');
let error = '';
try {
  await AI.generateImagePrompts({
    script:'不可修复任务正文',
    account:{ styleProfile:'白底清晰信息卡' },
    imageCount:1,
    topic:'不可修复任务',
    copy:{ title:'不可修复任务', body:'只有已确认的正文事实' },
    requireLlm:true
  });
} catch (caught) {
  error = caught?.message || String(caught);
}
console.log(JSON.stringify({ calls, imageSubmits, error }));
''')
        self.assertEqual(2, payload["calls"])
        self.assertEqual(0, payload["imageSubmits"])
        self.assertIn("无法在不补写业务内容的前提下修复 JSON", payload["error"])


if __name__ == "__main__":
    unittest.main()
