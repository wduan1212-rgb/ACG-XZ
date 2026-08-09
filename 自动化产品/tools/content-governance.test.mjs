import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  PRODUCT_CATALOG_SEED,
  PRODUCT_CATALOG_VERSION,
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
  assert.ok(baige.forbiddenClaims.some(claim => claim.includes("LoongForge")));

  const aiSource = readFileSync(new URL("../js/api/ai.js", import.meta.url), "utf8");
  assert.match(aiSource, /function primaryProductForText/);
  assert.match(aiSource, /product = primaryProductForText\(sourceTitle, product\)/);
  assert.match(aiSource, /禁止外推/);
});
