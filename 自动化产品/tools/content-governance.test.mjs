import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRODUCT_CATALOG_SEED,
  PRODUCT_CATALOG_VERSION,
  catalogProductForText,
} from "../js/data/productCatalogSeed.js";
import {
  publishTextLength,
  validatePublishText,
} from "../js/domain/publishRules.js";

test("publish rules count punctuation and reject video-channel punctuation", () => {
  assert.equal(publishTextLength("标题！"), 3);
  assert.equal(validatePublishText({
    platform: "小红书",
    title: "标".repeat(21),
    copy: "合规文案",
  }).ok, false);
  assert.equal(validatePublishText({
    platform: "小红书",
    title: "合规标题",
    copy: "文".repeat(1001),
  }).ok, false);
  assert.equal(validatePublishText({
    platform: "视频号",
    title: "没有标点标题！",
  }).errors.includes("视频号标题不能包含标点符号"), true);
  assert.equal(validatePublishText({
    platform: "视频号",
    title: "十六字以内标题",
  }).ok, true);
});

test("Baige catalog carries verified facts and explicit-title routing", () => {
  assert.match(PRODUCT_CATALOG_VERSION, /baige/);
  const baige = PRODUCT_CATALOG_SEED.find(product => product.id === "baige");
  assert.ok(baige);
  assert.ok(baige.verifiedFacts.some(fact => fact.includes("32%")));
  assert.ok(baige.verifiedFacts.some(fact => fact.includes("40%+")));
  assert.ok(baige.forbiddenClaims.some(claim => claim.includes("不得把某一模型")));
  assert.match(baige.toneRule, /LoongForge/);
  const fallback = PRODUCT_CATALOG_SEED.find(product => product.id === "dumate");
  assert.equal(catalogProductForText(PRODUCT_CATALOG_SEED, "做一期百舸工具链", fallback)?.id, "baige");
  assert.equal(catalogProductForText(PRODUCT_CATALOG_SEED, "百度百舸 6.0", fallback)?.id, "baige");

  const aiSource = readFileSync(new URL("../js/api/ai.js", import.meta.url), "utf8");
  assert.match(aiSource, /function primaryProductForText/);
  assert.match(aiSource, /\.\.\.\(product\?\.keywords \|\| \[\]\)/);
  assert.match(aiSource, /product = primaryProductForText\(sourceTitle, product\)/);
  assert.match(aiSource, /imagePromptProductBrief\(product\)/);
  assert.match(aiSource, /禁止外推/);

  const orchestrator = readFileSync(new URL("../js/agent/orchestrator.js", import.meta.url), "utf8");
  assert.match(orchestrator, /catalogProductForText\(/);
  assert.match(orchestrator, /p\.artifacts\.script\.productId = productId/);
});

test("account quota counts scheduled publishes by plan date and never blocks draft creation", () => {
  const quota = readFileSync(new URL("../js/domain/productionQuota.js", import.meta.url), "utf8");
  const productions = readFileSync(new URL("../js/domain/productions.js", import.meta.url), "utf8");
  const delivery = readFileSync(new URL("../js/domain/delivery.js", import.meta.url), "utf8");
  assert.match(quota, /state\.assets\.filter\(asset =>/);
  assert.doesNotMatch(quota, /state\.productions\.filter/);
  assert.match(quota, /delivery\.quotaPublishedAt \|\| delivery\.deliveredAt/);
  assert.match(quota, /delivery\.planDate/);
  assert.match(quota, /remote\.accountPublishQuotas\(needed, selectedDay\)/);
  assert.match(quota, /window\.addEventListener\("focus", refreshVisible\)/);
  assert.match(quota, /setInterval\(refreshVisible, AUTO_REFRESH_MS\)/);
  assert.doesNotMatch(productions, /validateAccountCreationRequests/);
  assert.match(delivery, /dayKey: planDate/);
  assert.match(delivery, /accountPublishAvailable\(acc\.id, 1, planDate\)/);
  const planView = readFileSync(new URL("../js/agent/view.js", import.meta.url), "utf8");
  assert.doesNotMatch(planView, /accountPublishAvailable/);
});
