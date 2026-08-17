import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PRODUCT_CATALOG_SEED,
  PRODUCT_CATALOG_VERSION,
  catalogProductForText,
  mergeProductCatalog,
} from "../js/data/productCatalogSeed.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tokenPlan = PRODUCT_CATALOG_SEED.find(product => product.id === "token-plan");

test("Token Plan official product identity recognizes short and full names", () => {
  assert.ok(tokenPlan);
  assert.equal(tokenPlan.name, "百度千帆 Token Plan");
  assert.equal(tokenPlan.shortName, "Token Plan");
  assert.equal(tokenPlan.officialDisplayName, "百度千帆 Token Plan");
  assert.equal(tokenPlan.contentCategoryLabel, "AI 模型订阅与算力套餐");
  assert.deepEqual(tokenPlan.contentAliases, ["Token Plan", "AI 模型订阅", "算力套餐", "这个套餐"]);
  assert.match(PRODUCT_CATALOG_VERSION, /token-plan-night/);

  for (const text of [
    "Token Plan 夜间怎么省额度",
    "百度千帆 Token Plan 适合哪些 Agent",
    "百度千帆Token Plan 企业版",
    "TokenPlan 个人版",
    "夜享计划支持什么模型",
    "夜享 Tokens 加赠计划",
  ]) {
    assert.equal(catalogProductForText(PRODUCT_CATALOG_SEED, text)?.id, "token-plan", text);
  }
  assert.notEqual(catalogProductForText(PRODUCT_CATALOG_SEED, "make a plan for token accounting")?.id, "token-plan");
});

test("Token Plan knowledge keeps the source facts and explicit claim boundaries", () => {
  const body = [
    tokenPlan.brief,
    ...(tokenPlan.coreFeatures || []),
    ...(tokenPlan.verifiedFacts || []),
    ...(tokenPlan.forbiddenClaims || []),
  ].join("\n");
  for (const fact of [
    "每日 21:00 至次日 08:00",
    "GLM-5.2",
    "DeepSeek-V4-Flash-0731",
    "DeepSeek-V4-Pro",
    "DeepSeek-V4-Flash-0423",
    "1000 万 Token",
    "4200 万 Token",
    "2.3 亿 Token",
    "7 亿 Token",
    "席位制 + 企业共享积分包",
    "100 万 Token 上下文",
    "不使用用户数据进行模型训练与服务优化",
    "不得写第一、榜首或冠军",
  ]) assert.match(body, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), fact);
  assert.deepEqual(
    tokenPlan.verifiedFacts[1].match(/GLM-5\.2|DeepSeek-V4-Flash-0731|DeepSeek-V4-Pro|DeepSeek-V4-Flash-0423/g),
    ["GLM-5.2", "DeepSeek-V4-Flash-0731", "DeepSeek-V4-Pro", "DeepSeek-V4-Flash-0423"],
  );
});

test("managed catalog refresh replaces stale Token Plan facts but preserves custom products", () => {
  const merged = mergeProductCatalog([
    { id: "token-plan", name: "旧名称", brief: "旧知识", updatedAt: 1 },
    { id: "custom-product", owner: "ours", name: "自定义产品", brief: "自定义事实" },
  ]);
  const refreshed = merged.find(product => product.id === "token-plan");
  assert.equal(refreshed.name, "百度千帆 Token Plan");
  assert.match(refreshed.brief, /夜享 Tokens 加赠计划/);
  assert.equal(merged.find(product => product.id === "custom-product")?.brief, "自定义事实");
});

test("repository keeps the exact imported Markdown source and full-word alias matching", async () => {
  const sourcePath = resolve(appRoot, "docs/product-knowledge/Token Plan夜享计划-产品知识库.md");
  const source = await readFile(sourcePath);
  assert.equal(createHash("sha256").update(source).digest("hex"), tokenPlan.sourceDigest);
  assert.match(source.toString("utf8"), /^# 百度千帆 Token Plan「夜享计划」产品事实知识库/m);

  const aiSource = await readFile(resolve(appRoot, "js/api/ai.js"), "utf8");
  assert.match(aiSource, /Keep multi-word product names intact/);
  assert.doesNotMatch(aiSource, /split\(\/\[\\\/｜\|、\\s\]\+\//);
  assert.match(aiSource, /product\?\.contentCategoryLabel/);
  assert.match(aiSource, /p\.contentAliases/);
  assert.match(aiSource, /product\?\.officialDisplayName/);
});

test("generated Token Plan copy uses the official full name on first mention", async () => {
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  globalThis.location = { origin: "http://127.0.0.1:8787", hash: "" };
  globalThis.window = { location: globalThis.location, addEventListener() {}, dispatchEvent() {}, __toast() {} };
  globalThis.document = { querySelector() { return null; }, querySelectorAll() { return []; } };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({
      copy: "Token Plan 个人版按 Token 抵扣，企业版按 Credits 积分结算。\\n#TokenPlan #AI模型订阅 #算力套餐 #开发者工具",
    }) } }] }),
    text: async () => "",
  });
  const llm = await import("../js/api/llm.js?v=20260727-v118-7");
  llm.LLM_CONFIG.apiKey = "server-managed";
  llm.LLM_CONFIG.endpoint = "/api/chat/completions";
  llm.LLM_CONFIG.serverManaged = true;
  const { state } = await import("../js/core/store.js");
  state.products = mergeProductCatalog([]);
  const { AI } = await import("../js/api/ai.js?official-token-plan-test");
  const result = await AI.generateImageCopyFromTitle({
    title: "百度千帆 Token Plan：个人版 Token 和企业版 Credits 怎么选？",
    account: {},
  });
  assert.match(result.copy, /^百度千帆 Token Plan/);
  assert.doesNotMatch(result.copy, /桌面智能体/);
});
