#!/usr/bin/env node

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};
globalThis.window = {
  location: { protocol: "http:", hostname: "localhost", port: "4173" }
};

const { enableServerProxyIfConfigured } = await import("../../js/api/llm.js");
const { AI } = await import("../../js/api/ai.js");
const { resizeImageSlots } = await import("../../js/views/chainBoards.js");

if (!await enableServerProxyIfConfigured()) {
  throw new Error("本地语言模型代理未就绪");
}

const account = {
  name: "链路验证账号",
  platform: "小红书",
  styleProfile: "白底简洁、低噪点、大字标题、层级清晰，少量蓝色强调"
};

const titleCases = [
  ["百度搭子怎么找到同频学习搭子", ["百度搭子", "学习", "同频"]],
  ["秒哒做一个活动报名页的完整过程", ["秒哒", "报名页", "活动"]],
  ["Codex 批量修改项目文案的安全方法", ["codex", "批量", "文案"]],
  ["Obsidian 和 Codex 如何分工整理知识库", ["obsidian", "codex", "知识库"]],
  ["WorkBuddy 自动汇总会议待办的实测", ["workbuddy", "会议", "待办"]],
  ["用百度搭子约一个 citywalk 同伴", ["百度搭子", "citywalk", "同伴"]],
  ["秒哒做毕业展网站时最容易忽略的三件事", ["秒哒", "毕业展", "网站"]],
  ["Codex 为什么要先读测试再改代码", ["codex", "测试", "代码"]],
  ["Obsidian 周报自动归档不丢素材的做法", ["obsidian", "周报", "归档"]],
  ["WorkBuddy 和 Codex 联动处理需求的边界", ["workbuddy", "codex", "需求"]],
  ["百度搭子考研标签怎么填才更容易匹配", ["百度搭子", "考研", "标签"]],
  ["秒哒做面试作品集的页面结构", ["秒哒", "面试", "作品集"]],
  ["Codex 修复旧项目白屏时的排查顺序", ["codex", "白屏", "排查"]],
  ["Obsidian 从会议记录到可复用 SOP", ["obsidian", "会议记录", "sop"]],
  ["WorkBuddy 帮新人梳理项目上下文", ["workbuddy", "新人", "上下文"]],
  ["百度搭子周末拍照搭子匹配小技巧", ["百度搭子", "拍照", "匹配"]],
  ["秒哒做一个小型问卷工具需要几步", ["秒哒", "问卷", "工具"]],
  ["Codex 做大批量重构时如何控制风险", ["codex", "重构", "风险"]],
  ["Obsidian 素材库如何避免重复收集", ["obsidian", "素材库", "重复"]],
  ["WorkBuddy 自动生成项目日报的真实效果", ["workbuddy", "项目日报", "效果"]]
];

const manualBodies = titleCases.map(([title, keys], index) => ({
  title,
  keys,
  body: `我这次专门围绕${keys[0]}做了一次实测。先处理${keys[1]}的准备材料，再记录${keys[2]}过程中的关键变化。第一步先明确目标和输入，第二步按顺序执行，第三步用可复核的结果做收尾。这套方法最有用的地方是每个阶段都能找到上一步的依据，遇到问题也能快速回滚。#测试标签${index} #不应入图${index}`
}));

function normalize(text = "") {
  return String(text || "").replace(/\\r\\n|\\n|\\r/g, "\n").toLowerCase();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const seededSlots = [{ title: "封面", prompt: "keep" }, { title: "内页", prompt: "keep-2" }, { title: "旧尾页", prompt: "remove" }];
const twoSlots = resizeImageSlots(seededSlots, 2);
assert(twoSlots.length === 2 && twoSlots[0] === seededSlots[0] && twoSlots[1] === seededSlots[1], "图片数量缩减没有同步真实槽位");
const sevenSlots = resizeImageSlots(twoSlots, 7);
assert(sevenSlots.length === 7 && sevenSlots[0] === seededSlots[0] && sevenSlots[6].title === "图片7", "图片数量扩展没有同步真实槽位");
assert(resizeImageSlots(sevenSlots, 1).length === 1, "单图模式没有收敛为一个槽位");

function outputGuards(shots, { expectedCount, keys = [], forbiddenTags = [] } = {}) {
  assert(shots.length === expectedCount, `数量错误：期望 ${expectedCount}，实际 ${shots.length}`);
  const prompts = shots.map(item => normalize(item.prompt));
  prompts.forEach((prompt, index) => {
    assert(prompt.length > 40, `第 ${index + 1} 张提示词过短`);
    assert(!/\\n|\\r|\u0000|�/.test(prompt), `第 ${index + 1} 张包含转义乱码`);
    assert(!/本张只展开|围绕正文分配信息|信息密度按|不重复封面|不提前讲后续|正文第\d+部分/.test(prompt), `第 ${index + 1} 张泄漏内部规划语句`);
    forbiddenTags.forEach(tag => assert(!prompt.includes(tag.toLowerCase()), `第 ${index + 1} 张识别了应忽略的标签 ${tag}`));
  });
  const joined = prompts.join(" ");
  assert(keys.some(key => joined.includes(key.toLowerCase())), `提示词与主题关键词无交集：${keys.join("/")}`);
  return prompts;
}

async function makePrompts(title, body, count) {
  const result = await AI.generateImagePrompts({
    script: "",
    account,
    style: account.styleProfile,
    imageCount: count,
    topic: title,
    copy: { title, body }
  });
  return result.shots || [];
}

async function runPool(name, cases, worker, concurrency = 4) {
  let next = 0;
  let passed = 0;
  const failures = [];
  const runners = Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= cases.length) return;
      try {
        await worker(cases[index], index);
        passed++;
      } catch (error) {
        failures.push({ index: index + 1, error: error?.message || String(error) });
      }
      if ((passed + failures.length) % 5 === 0 || passed + failures.length === cases.length) {
        process.stdout.write(`${name}: ${passed + failures.length}/${cases.length}\n`);
      }
    }
  });
  await Promise.all(runners);
  return { name, total: cases.length, passed, failed: failures.length, failures };
}

const results = [];

results.push(await runPool("标题生文案再生多图", titleCases, async ([title, keys]) => {
  const copy = await AI.generateImageCopyFromTitle({ title, account });
  const cleanCopy = normalize(copy.copy);
  assert(keys.some(key => cleanCopy.includes(key.toLowerCase())), "生成文案与标题弱相关");
  const shots = await makePrompts(title, copy.copy, 4);
  outputGuards(shots, { expectedCount: 4, keys });
}));

results.push(await runPool("标题加文案直接生多图", manualBodies, async ({ title, body, keys }, index) => {
  const tagA = `#测试标签${index}`;
  const tagB = `#不应入图${index}`;
  const shots = await makePrompts(title, body, 4);
  outputGuards(shots, { expectedCount: 4, keys, forbiddenTags: [tagA, tagB] });
}));

const shortCases = Array.from({ length: 10 }, (_, index) => ({
  title: `短文案扩展测试 ${index + 1}：百度搭子学习匹配`,
  body: `先填学习方向和每周时间，再用百度搭子匹配同频伙伴。`,
  keys: ["百度搭子", "学习", "匹配"]
}));
results.push(await runPool("短文案多图扩展", shortCases, async ({ title, body, keys }) => {
  const shots = await makePrompts(title, body, 8);
  const prompts = outputGuards(shots, { expectedCount: 8, keys });
  assert(new Set(prompts).size >= 6, "8 张图的内容扩展重复度过高");
}));

const longCases = Array.from({ length: 10 }, (_, index) => ({
  title: `长文案压缩测试 ${index + 1}：Codex 重构检查清单`,
  body: `这次用 Codex 处理一次老项目重构。第一步先锁定真实入口和构建命令，不急着改代码。第二步用搜索查清模块依赖和数据边界，把用户已有修改单独标记。第三步先写最小回归测试，再拆成可回滚的小提交。第四步检查白屏、权限串数据、缓存版本和旧数据兼容。第五步在本地执行语法、单测和关键接口烟测，记录失败输入。第六步审核 diff，只精确添加本轮文件，不带入数据库、上传目录和环境文件。第七步在交接记录里写清验证结果、数据影响和回滚点。最后只有在用户验收后才允许推送，不能用本地空状态覆盖现网数据。`
}));
results.push(await runPool("长文案多图压缩", longCases, async ({ title, body }) => {
  const shots = await makePrompts(title, body, 4);
  const prompts = outputGuards(shots, { expectedCount: 4, keys: ["codex", "重构", "测试"] });
  assert(prompts.every(prompt => prompt.length < 1800), "长文案未压缩，单张提示词过长");
}));

results.push(await runPool("单图标题生文案与标签", titleCases, async ([title, keys]) => {
  const copy = await AI.generateImageCopyFromTitle({ title, account });
  const output = normalize(copy.copy);
  assert(keys.some(key => output.includes(key.toLowerCase())), "单图文案与标题弱相关");
  const product = keys[0].toLowerCase();
  const expectedTag = product === "百度搭子" ? "#百度搭子"
    : product === "秒哒" ? "#秒哒"
    : product === "codex" ? "#codex"
    : product === "obsidian" ? "#obsidian"
    : product === "workbuddy" ? "#workbuddy"
    : "";
  assert(!expectedTag || output.includes(expectedTag), `缺少产品标签 ${expectedTag}`);
  assert(!/\\n|\\r|\u0000|�/.test(output), "单图文案包含转义乱码");
}));

const batchCases = [
  { mode: "copy", count: 2, ...manualBodies[0] },
  { mode: "copy", count: 4, ...manualBodies[2] },
  { mode: "copy", count: 7, ...manualBodies[4] },
  { mode: "single", title: titleCases[0][0], keys: titleCases[0][1] },
  { mode: "single", title: titleCases[1][0], keys: titleCases[1][1] },
  { mode: "single", title: titleCases[2][0], keys: titleCases[2][1] }
];
results.push(await runPool("批量图文账号模式与图数路由", batchCases, async item => {
  if (item.mode === "single") {
    const copy = await AI.generateImageCopyFromTitle({ title: item.title, account });
    const output = normalize(copy.copy);
    assert(item.keys.some(key => output.includes(key.toLowerCase())), "批量单图文案与标题弱相关");
    return;
  }
  const shots = await makePrompts(item.title, item.body, item.count);
  outputGuards(shots, { expectedCount: item.count, keys: item.keys });
}));

const summary = {
  generatedAt: new Date().toISOString(),
  total: results.reduce((sum, item) => sum + item.total, 0),
  passed: results.reduce((sum, item) => sum + item.passed, 0),
  failed: results.reduce((sum, item) => sum + item.failed, 0),
  groups: results
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.failed) process.exitCode = 1;
