import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  batchNeedsHydrationEvaluation,
  classifyHydratedVideoSettlement,
  recoverableVideoUrl,
} from "../js/domain/productionFailureState.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => readFileSync(resolve(appRoot, relativePath), "utf8");

function production(overrides = {}) {
  return {
    id: "production-1",
    ownerId: "owner-a",
    batchId: null,
    mode: "视频",
    stage: "workshop",
    stageStatus: "running",
    artifacts: {
      finalVideoUrl: "",
      prompts: [],
      timeline: [],
      boards: {
        units: [
          { id: "unit-1", videoPrompt: "prompt-1" },
          { id: "unit-2", videoPrompt: "prompt-2" },
        ],
      },
    },
    ...overrides,
  };
}

function job(index, overrides = {}) {
  return {
    id: `job-${index}`,
    productionId: "production-1",
    kind: "video",
    segIndex: index,
    status: "succeeded",
    output: { url: `/api/video/output-${index}.mp4` },
    ...overrides,
  };
}

test("no-batch production with an existing final output settles directly to review", () => {
  const p = production({
    batchId: null,
    artifacts: { finalVideoUrl: "/api/video/composed/final.mp4", boards: { units: [] } },
  });
  assert.deepEqual(classifyHydratedVideoSettlement(p, []), {
    action: "review",
    reason: "final-output-present",
    mediaUrl: "/api/video/composed/final.mp4",
    expectedSegments: 0,
    effectiveJobs: 0,
  });
});

test("done-batch production with complete succeeded segments requests compose without provider retry", () => {
  const p = production({ batchId: "batch-done" });
  assert.deepEqual(classifyHydratedVideoSettlement(p, [
    job(0),
    job(1),
    job(1, { id: "old-failed", status: "failed", output: null, superseded: true }),
  ]), {
    action: "compose",
    reason: "all-segments-succeeded",
    expectedSegments: 2,
    effectiveJobs: 2,
  });
});

test("generating batch with review failed and delivered rows requires terminal evaluation", () => {
  const batch = { id: "batch-generating", phase: "generating", productionIds: ["review", "failed", "delivered"] };
  const productions = [
    { id: "review", stage: "review", stageStatus: "pending" },
    { id: "failed", stage: "workshop", stageStatus: "failed" },
    { id: "delivered", stage: "delivered", stageStatus: "done" },
  ];
  assert.equal(batchNeedsHydrationEvaluation(batch, productions), true);
  assert.equal(batchNeedsHydrationEvaluation(
    { ...batch, productionIds: [...batch.productionIds, "active"] },
    [...productions, { id: "active", stage: "workshop", stageStatus: "running" }],
  ), false);
});

test("succeeded segments must cover every planned unit and carry a real output", () => {
  const p = production();
  const incomplete = classifyHydratedVideoSettlement(p, [job(0)]);
  assert.equal(incomplete.action, "failed");
  assert.equal(incomplete.reason, "incomplete-succeeded-output-set");
  assert.match(incomplete.error, /第 2 个/);

  const missingOutput = classifyHydratedVideoSettlement(p, [job(0), job(1, { output: null })]);
  assert.equal(missingOutput.action, "failed");
  assert.equal(missingOutput.reason, "incomplete-succeeded-output-set");
});

test("status provider references and task ids are not mistaken for media URLs", () => {
  const p = production();
  const metadataOnly = classifyHydratedVideoSettlement(p, [
    job(0, { output: { status: "succeeded", providerRef: "provider-task-1" } }),
    job(1, { output: { data: { message: "done", taskId: "task-2" } } }),
  ]);
  assert.equal(metadataOnly.action, "failed");
  assert.equal(metadataOnly.reason, "incomplete-succeeded-output-set");

  const falseFinal = production({
    artifacts: {
      finalVideoUrl: { status: "succeeded", providerRef: "provider-final" },
      prompts: [],
      timeline: [],
      boards: { units: [] },
    },
  });
  assert.equal(classifyHydratedVideoSettlement(falseFinal, []).reason, "missing-recoverable-jobs");

  const structuredFinal = production({
    artifacts: {
      finalVideoUrl: { data: { url: "/api/video/composed/structured-final.mp4" } },
      prompts: [],
      timeline: [],
      boards: { units: [] },
    },
  });
  const structuredDecision = classifyHydratedVideoSettlement(structuredFinal, []);
  assert.equal(structuredDecision.action, "review");
  assert.equal(structuredDecision.mediaUrl, "/api/video/composed/structured-final.mp4");

  const knownContainer = classifyHydratedVideoSettlement(p, [
    job(0, { output: { data: { videoUrl: "/api/video/output-0.mp4" } } }),
    job(1, { output: { results: [{ url: "relative-output-1.mp4" }] } }),
  ]);
  assert.equal(knownContainer.action, "compose");
  assert.equal(recoverableVideoUrl({ output: { status: "succeeded", providerRef: "task-only" } }, true), "");
  assert.equal(recoverableVideoUrl({ result: { downloadUrl: "https://media.example/final.mp4" } }, true), "https://media.example/final.mp4");
});

test("failed terminal job wins over partial succeeded outputs and remains retryable", () => {
  const decision = classifyHydratedVideoSettlement(production(), [
    job(0),
    job(1, { status: "failed", output: null, error: "Seedance 任务失败" }),
  ]);
  assert.equal(decision.action, "failed");
  assert.equal(decision.reason, "terminal-job-failed");
  assert.equal(decision.error, "Seedance 任务失败");
});

test("active jobs and static-video recovery remain owned by their existing resume paths", () => {
  assert.equal(classifyHydratedVideoSettlement(production(), [job(0, { status: "running" })]).action, "none");
  assert.equal(classifyHydratedVideoSettlement(production({ staticVideo: true }), []).reason, "static-resume-owned");
});

test("runtime settlement is owner-scoped and cannot submit or recreate provider jobs", () => {
  const source = read("js/agent/orchestrator.js");
  const settlement = source.slice(
    source.indexOf("export function settleHydratedVideoProductions"),
    source.indexOf("function latestDigitalJob"),
  );
  assert.match(settlement, /state\.productions\.filter\(p => ownedBy\(p\)\)/);
  assert.match(settlement, /composeBatchFinalVideo\(p\)/);
  assert.doesNotMatch(settlement, /create(?:Job|UnitVideoJobs|RenderJobsFor)|provider\.submit|startGeneration/);
  assert.match(source, /dormantGeneratingIds\.forEach\(batchId => evaluate\(batchId\)\)/);
  assert.match(source, /p\.artifacts\.composingStartedAt = 0;\n\s*p\.artifacts\.composeError = "";/);
});

test("remote composing is display state while the server ledger remains the concurrency authority", () => {
  const source = read("js/agent/orchestrator.js");
  const settlement = source.slice(
    source.indexOf("export function settleHydratedVideoProductions"),
    source.indexOf("function latestDigitalJob"),
  );
  const compose = source.slice(
    source.indexOf("export async function composeBatchFinalVideo"),
    source.indexOf("function linkedOwnedBatch"),
  );
  assert.doesNotMatch(settlement, /上次完整成片合成在刷新时中断/);
  assert.doesNotMatch(compose, /if \(p\.artifacts\.composing\) return false/);
  assert.match(compose, /activeComposeRequests\.has\(key\)/);
  assert.match(compose, /productionId: String\(p\.id \|\| ""\)/);
  assert.match(compose, /data\.pending/);
  assert.match(compose, /return null/);
  assert.match(compose, /浏览器已停止等待，但服务器可能仍在合成/);
  const retry = source.slice(
    source.indexOf("export function retryFailedIn"),
    source.indexOf("/* ---------- 阶段评估"),
  );
  assert.match(retry, /composeRecovery\.action === "compose"/);
  assert.match(retry, /composeBatchFinalVideo\(p\)/);
});
