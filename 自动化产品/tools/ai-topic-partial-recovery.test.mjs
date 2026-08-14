import assert from "node:assert/strict";
import test from "node:test";

import {
  aiTopicAccountIdsToGenerate,
  fillBlankAiTopicContent,
  mergeAiTopicDraft,
  normalizeAiTopicDraft,
  pruneAiTopicDraft,
} from "../js/domain/aiTopicDraft.js";

const accountIds = ["a1", "a2", "a3", "a4"];
const valid = item => Boolean(item?.title && item?.copy);
const item = (accountId, suffix = "") => ({
  accountId,
  accountName: accountId,
  platform: "小红书",
  title: `${accountId}${suffix}标题`,
  copy: `${accountId}${suffix}正文`,
  sourceIds: [1],
});

test("AI 选题部分成功草稿序列化后仍保留成功项和缺失账号", () => {
  const partial = mergeAiTopicDraft(null, {
    requestId: "first",
    references: [{ id: 1, title: "资料", url: "https://example.com" }],
    items: [item("a1"), item("a2")],
    missingAccountIds: ["a3", "a4"],
    errors: [{ accountId: "a4", message: "模型繁忙" }],
  }, accountIds, "AI 动态", "week");

  const restored = normalizeAiTopicDraft(JSON.parse(JSON.stringify(partial)), accountIds);
  assert.deepEqual(restored.items.map(row => row.accountId), ["a1", "a2"]);
  assert.deepEqual(restored.missingAccountIds, ["a3", "a4"]);
  assert.equal(restored.items[0].sources[0].title, "资料");
  assert.deepEqual(
    aiTopicAccountIdsToGenerate(restored, accountIds, "AI 动态", valid),
    ["a3", "a4"],
  );
});

test("补生成只合并新成功账号，不覆盖之前已经生成的文案", () => {
  const original = mergeAiTopicDraft(null, {
    items: [item("a1", "旧"), item("a2", "旧")],
  }, accountIds, "AI 动态", "week");
  const repaired = mergeAiTopicDraft(original, {
    requestId: "repair",
    items: [item("a3", "新")],
    errors: [{ accountId: "a4", message: "仍未完成" }],
  }, accountIds, "AI 动态", "week");

  assert.equal(repaired.items.find(row => row.accountId === "a1").title, "a1旧标题");
  assert.equal(repaired.items.find(row => row.accountId === "a3").title, "a3新标题");
  assert.deepEqual(repaired.missingAccountIds, ["a4"]);
  assert.deepEqual(
    aiTopicAccountIdsToGenerate(repaired, accountIds, "AI 动态", valid),
    ["a4"],
  );
});

test("先填成功项只补空白内容并保留人工标题正文", () => {
  const plan = {
    accountCopyTitles: { a1: "人工标题" },
    accountCopyBodies: { a2: "人工正文" },
    accountImageCreationModes: { a1: "single", a2: "single" },
    accountSingleImageTitles: { a2: "人工单图标题" },
  };
  const filled = fillBlankAiTopicContent(
    plan,
    [item("a1"), item("a2"), { accountId: "a3", title: "无正文", copy: "" }],
    accountIds,
    valid,
  );

  assert.equal(filled, 2);
  assert.equal(plan.accountCopyTitles.a1, "人工标题");
  assert.equal(plan.accountCopyBodies.a1, "a1正文");
  assert.equal(plan.accountSingleImageTitles.a1, "a1标题");
  assert.equal(plan.accountCopyTitles.a2, "a2标题");
  assert.equal(plan.accountCopyBodies.a2, "人工正文");
  assert.equal(plan.accountSingleImageTitles.a2, "人工单图标题");
  assert.equal(plan.accountCopyTitles.a3, undefined);
});

test("更换选题方向会重新生成全部账号，删除账号会裁剪草稿", () => {
  const oldDraft = mergeAiTopicDraft(null, {
    items: accountIds.map(accountId => item(accountId, "旧")),
  }, accountIds, "旧方向", "week");
  assert.deepEqual(
    aiTopicAccountIdsToGenerate(oldDraft, accountIds, "新方向", valid),
    accountIds,
  );

  const replaced = mergeAiTopicDraft(oldDraft, {
    items: [item("a1", "新")],
  }, accountIds, "新方向", "month");
  assert.deepEqual(replaced.items.map(row => row.accountId), ["a1"]);
  assert.deepEqual(replaced.missingAccountIds, ["a2", "a3", "a4"]);
  assert.equal(replaced.recency, "month");

  const pruned = pruneAiTopicDraft(replaced, ["a1", "a3"]);
  assert.deepEqual(pruned.items.map(row => row.accountId), ["a1"]);
  assert.deepEqual(pruned.missingAccountIds, ["a3"]);
});
