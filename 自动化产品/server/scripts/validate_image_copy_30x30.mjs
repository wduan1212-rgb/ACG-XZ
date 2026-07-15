#!/usr/bin/env node

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {}
};
globalThis.window = {
  location: { protocol: "http:", hostname: "127.0.0.1", port: process.env.ACG_TEST_PORT || "4173" }
};

const { enableServerProxyIfConfigured } = await import("../../js/api/llm.js?v=20260715-v83-2");
const { AI } = await import("../../js/api/ai.js");

if (!await enableServerProxyIfConfigured()) {
  throw new Error("本地语言模型代理未就绪");
}

const account = {
  name: "图文专业表达验证账号",
  platform: "小红书",
  styleProfile: "白底简洁、低噪点、信息层级清楚、少量蓝色强调；表达专业、克制、有具体依据"
};

const cases = [
  ["百度搭子学习搭子匹配实测：标签怎么填更有效", ["百度搭子", "学习", "标签"], "review"],
  ["第一次用百度搭子约 citywalk，完整流程和避坑", ["百度搭子", "citywalk", "流程"], "tutorial"],
  ["百度搭子适合找拍照搭子吗？三天体验结论", ["百度搭子", "拍照", "体验"], "review"],
  ["秒哒做活动报名页：从空白到上线的 5 个步骤", ["秒哒", "报名页", "步骤"], "tutorial"],
  ["秒哒做作品集网站值不值得用？优缺点实测", ["秒哒", "作品集", "实测"], "review"],
  ["不会写代码也能做问卷工具：秒哒上手指南", ["秒哒", "问卷", "指南"], "recommend"],
  ["Codex 批量改文案前必须做的 4 项检查", ["codex", "批量", "检查"], "tutorial"],
  ["Codex 修复旧项目白屏：一套可复用的排查顺序", ["codex", "白屏", "排查"], "tutorial"],
  ["Codex 大规模重构好不好用？效率与风险实测", ["codex", "重构", "风险"], "review"],
  ["Obsidian 周报自动归档：不丢素材的设置方法", ["obsidian", "周报", "归档"], "tutorial"],
  ["Obsidian 素材库越用越乱？这套去重方法有效", ["obsidian", "素材库", "去重"], "recommend"],
  ["Obsidian 和 Codex 怎么分工整理知识库", ["obsidian", "codex", "知识库"], "tutorial"],
  ["WorkBuddy 自动汇总会议待办：真实效果与边界", ["workbuddy", "会议", "待办"], "review"],
  ["WorkBuddy 帮新人接手项目：上下文整理教程", ["workbuddy", "新人", "上下文"], "tutorial"],
  ["WorkBuddy 项目日报自动生成值得用吗？", ["workbuddy", "日报", "自动"], "review"],
  ["百度搭子和豆瓣小组找同伴，使用体验对比", ["百度搭子", "同伴", "对比"], "review"],
  ["秒哒做毕业展网站：最容易忽略的三件事", ["秒哒", "毕业展", "网站"], "tutorial"],
  ["Codex 先读测试再改代码，到底能少踩多少坑", ["codex", "测试", "代码"], "review"],
  ["会议记录变成可执行 SOP：Obsidian 整理方法", ["obsidian", "会议记录", "sop"], "tutorial"],
  ["WorkBuddy 和 Codex 联动处理需求的正确边界", ["workbuddy", "codex", "边界"], "tutorial"],
  ["百度搭子考研同频伙伴怎么筛选更靠谱", ["百度搭子", "考研", "筛选"], "recommend"],
  ["秒哒做面试作品集：页面结构与内容顺序", ["秒哒", "面试", "作品集"], "tutorial"],
  ["Codex 接手陌生仓库：30 分钟检查清单", ["codex", "仓库", "清单"], "tutorial"],
  ["Obsidian 做个人知识库，哪些功能最值得先配", ["obsidian", "知识库", "功能"], "recommend"],
  ["WorkBuddy 自动整理需求：适合谁、不适合谁", ["workbuddy", "需求", "适合"], "review"],
  ["百度搭子周末运动搭子匹配：实际体验复盘", ["百度搭子", "运动", "匹配"], "review"],
  ["秒哒做小型数据看板：新手操作教程", ["秒哒", "数据看板", "教程"], "tutorial"],
  ["Codex 改老项目如何控制回滚风险", ["codex", "老项目", "回滚"], "tutorial"],
  ["Obsidian 从零搭建项目资料库：最小配置方案", ["obsidian", "项目", "资料库"], "recommend"],
  ["WorkBuddy 会议纪要转任务：一周实测报告", ["workbuddy", "会议纪要", "任务"], "review"]
];

const bannedTone = /兄弟们|家人们|姐妹们|宝子们|老铁们|集美们|亲们|各位宝宝|各位宝子|朋友们|冲就完了|闭眼入|无脑冲|绝绝子|狠狠爱了|听我一句劝/i;
const badEncoding = /\\n|\\r|\u0000|�/;
const internalPrompt = /本张只展开|围绕正文分配信息|信息密度按|不重复封面|不提前讲后续|正文第\d+部分|本图只负责|生成提示词的需求|用户要求图片数量|内部规划/;
const usefulLanguage = /步骤|先|再|建议|适合|不适合|实测|对比|注意|结果|使用|场景|选择|方法|原因|边界|准备|避免|可以|体验|检查|风险/;

function normalize(value = "") {
  return String(value || "").replace(/\\r\\n|\\n|\\r/g, "\n").toLowerCase();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withTransientRetry(task, attempts = 2) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");
      if (attempt >= attempts || !/超时|timeout|temporar|network|fetch/i.test(message)) throw error;
    }
  }
  throw lastError;
}

function expectedProductTag(keys) {
  const product = keys[0].toLowerCase();
  if (product === "百度搭子") return "#百度搭子";
  if (product === "秒哒") return "#秒哒";
  if (product === "codex") return "#codex";
  if (product === "obsidian") return "#obsidian";
  if (product === "workbuddy") return "#workbuddy";
  return "";
}

function containsTopicKey(output, key) {
  const variants = {
    "同伴": ["同伴", "同好", "搭子", "伙伴"],
    "对比": ["对比", "区别", "差异", "相比", "更适合"],
    "自动": ["自动", "自动化", "自动生成"],
    "适合": ["适合", "不适合", "适用"],
    "指南": ["指南", "教程", "步骤", "方法"]
  }[key.toLowerCase()] || [key];
  return variants.some(value => output.includes(value.toLowerCase()));
}

function assertProfessionalCopy(copy, keys, index) {
  const output = normalize(copy);
  assert(output.length >= 120, `第 ${index + 1} 组文案过短`);
  assert(!badEncoding.test(copy), `第 ${index + 1} 组文案包含转义乱码`);
  assert(!bannedTone.test(copy), `第 ${index + 1} 组文案包含直播式或夸张话术`);
  assert(usefulLanguage.test(copy), `第 ${index + 1} 组文案缺少测评/教学/建议信息`);
  const relevant = keys.filter(key => containsTopicKey(output, key));
  assert(relevant.length >= 2, `第 ${index + 1} 组文案与标题相关性不足：${keys.join("/")}`);
  const tags = [...copy.matchAll(/#[^\s#]+/g)].map(match => match[0].toLowerCase());
  assert(tags.length >= 4 && tags.length <= 8, `第 ${index + 1} 组标签数量异常：${tags.length}`);
  const productTag = expectedProductTag(keys);
  assert(!productTag || tags.includes(productTag), `第 ${index + 1} 组缺少产品标签 ${productTag}`);
}

function assertMultiPrompts(shots, expectedCount, keys, index) {
  assert(shots.length === expectedCount, `第 ${index + 1} 组图数错误：期望 ${expectedCount}，实际 ${shots.length}`);
  const prompts = shots.map(item => String(item.prompt || "").trim());
  prompts.forEach((prompt, shotIndex) => {
    assert(prompt.length >= 80, `第 ${index + 1} 组第 ${shotIndex + 1} 张提示词过短`);
    assert(!badEncoding.test(prompt), `第 ${index + 1} 组第 ${shotIndex + 1} 张包含转义乱码`);
    assert(!internalPrompt.test(prompt), `第 ${index + 1} 组第 ${shotIndex + 1} 张泄漏内部规划文本`);
    assert(!/#(?:AI办公|效率工具|工作流|AI工具|小红书|种草|测评)(?=\s|$)/i.test(prompt), `第 ${index + 1} 组第 ${shotIndex + 1} 张误用了发布标签`);
  });
  const joined = normalize(prompts.join(" "));
  const relevant = keys.filter(key => containsTopicKey(joined, key));
  assert(relevant.length >= 2, `第 ${index + 1} 组提示词与标题/文案相关性不足：${keys.join("/")}`);
  const unique = new Set(prompts.map(item => normalize(item).replace(/\s+/g, " ")));
  assert(unique.size >= Math.max(2, expectedCount - 1), `第 ${index + 1} 组多图提示词重复度过高`);
}

async function runPool(name, inputs, worker, concurrency = 5) {
  let next = 0;
  let passed = 0;
  const failures = [];
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = next++;
      if (index >= inputs.length) return;
      try {
        await worker(inputs[index], index);
        passed++;
      } catch (error) {
        failures.push({ index: index + 1, error: error?.message || String(error) });
      }
      const done = passed + failures.length;
      if (done % 5 === 0 || done === inputs.length) process.stdout.write(`${name}: ${done}/${inputs.length}\n`);
    }
  });
  await Promise.all(runners);
  return { name, total: inputs.length, passed, failed: failures.length, failures };
}

const generatedCopies = new Array(cases.length);
const single = await runPool("单图文案", cases, async ([title, keys], index) => {
  const result = await withTransientRetry(() => AI.generateImageCopyFromTitle({ title, account }));
  assertProfessionalCopy(result.copy, keys, index);
  generatedCopies[index] = result.copy;
});

const multiInputs = cases.map(([title, keys, kind], index) => ({
  title,
  keys,
  kind,
  copy: generatedCopies[index],
  count: 2 + (index % 7)
}));

const multi = await runPool("多图提示词", multiInputs, async ({ title, keys, copy, count }, index) => {
  assert(copy, `第 ${index + 1} 组缺少上一步生成文案`);
  const result = await withTransientRetry(() => AI.generateImagePrompts({
    script: "",
    account,
    style: account.styleProfile,
    imageCount: count,
    topic: title,
    copy: { title, body: copy }
  }));
  assertMultiPrompts(result.shots || [], count, keys, index);
});

const summary = {
  generatedAt: new Date().toISOString(),
  total: single.total + multi.total,
  passed: single.passed + multi.passed,
  failed: single.failed + multi.failed,
  groups: [single, multi]
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.failed) process.exitCode = 1;
