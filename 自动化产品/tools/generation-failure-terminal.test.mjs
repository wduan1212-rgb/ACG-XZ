import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TERMINAL_FAILURE_MARKER,
  normalizeLegacyInputFallbackState,
  productionAllowsJobProcessing,
  productionCanAutoGenerate,
} from "../js/domain/productionFailureState.js";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => readFileSync(resolve(appRoot, relativePath), "utf8");

function legacyWorkspace(count = 11) {
  const productions = Array.from({ length: count }, (_, index) => {
    const subType = index % 2 === 0 ? "数字人" : "真人";
    return {
      id: `person-${index}`,
      mode: "视频",
      subType,
      stage: "workshop",
      stageStatus: "needs_input",
      artifacts: {
        audio: { lastError: subType === "真人" ? "真人站内成片生成失败" : "" },
        boards: {
          items: [{ assetId: null, status: "idle", error: "" }],
          digitalHuman: { error: subType === "数字人" ? "数字人口播或角色形象生成失败" : "" },
        },
      },
    };
  });
  return {
    productions,
    batches: [{ id: "batch-real", phase: "awaiting_input", emitted: { awaiting_input: true } }],
    sessions: [{ id: "session-real", messages: [{ type: "need_input", payload: { batchId: "batch-real" } }] }],
    jobs: productions.flatMap(production => [
      { id: `${production.id}-queued`, productionId: production.id, status: "queued", progress: 0 },
      { id: `${production.id}-failed`, productionId: production.id, status: "failed", progress: 0 },
    ]),
  };
}

test("eleven legacy real-person and digital-human upload fallbacks become stable failed terminals", () => {
  const workspace = legacyWorkspace();
  const first = normalizeLegacyInputFallbackState(workspace);
  assert.deepEqual(first, { productions: 11, batches: 1, sessions: 1, jobs: 11 });
  assert.equal(workspace.productions.length, 11);
  workspace.productions.forEach(production => {
    assert.equal(production.stageStatus, "failed");
    assert.equal(production.failureTerminalMarker, TERMINAL_FAILURE_MARKER);
    assert.match(production.error, /数字人|真人/);
    assert.equal(production.artifacts.boards.items[0].status, "failed");
    assert.equal(productionCanAutoGenerate(production), false);
    assert.equal(productionAllowsJobProcessing(production), false);
  });
  assert.equal(workspace.batches[0].phase, "review");
  assert.deepEqual(workspace.sessions[0].messages, []);
  assert.equal(workspace.jobs.filter(job => job.status === "queued").length, 0);

  const afterRefresh = normalizeLegacyInputFallbackState(workspace);
  assert.deepEqual(afterRefresh, { productions: 0, batches: 0, sessions: 0, jobs: 0 });
  assert.ok(workspace.productions.every(production => production.stageStatus === "failed"));
});

test("only an explicit pending production can auto-enter generation", () => {
  assert.equal(productionCanAutoGenerate({ stageStatus: "pending" }), true);
  for (const status of ["failed", "running", "done", "needs_input", ""]) {
    assert.equal(productionCanAutoGenerate({ stageStatus: status }), false);
  }
});

test("runtime removes upload fallback cards, routing, mappings and refresh retry", () => {
  const orchestrator = read("js/agent/orchestrator.js");
  const cards = read("js/agent/cards.js");
  const view = read("js/agent/view.js");
  const productions = read("js/domain/productions.js");
  const migrate = read("js/core/migrate.js");
  const jobs = read("js/api/jobs.js");
  const digitalHumanQueue = orchestrator.slice(
    orchestrator.indexOf("async function queueBatchDigitalHuman"),
    orchestrator.indexOf("function staticAgentAuthHeaders"),
  );

  assert.doesNotMatch(orchestrator, /set(?:Stage|Status)\([^\n]*"needs_input"/);
  assert.doesNotMatch(orchestrator, /batch\.phase\s*=\s*"awaiting_input"/);
  assert.doesNotMatch(orchestrator, /export async function routeMediaFiles/);
  assert.doesNotMatch(cards, /need_input\(m\)|等待补图|站内生成失败或需要人工补图/);
  assert.doesNotMatch(view, /routeMediaFiles|等待上传的任务/);
  assert.doesNotMatch(productions, /needs_input:\s*"等待上传"|stageStatus === "needs_input"/);
  assert.doesNotMatch(migrate, /stageStatus\s*=\s*"needs_input"/);
  assert.match(orchestrator, /p\.stageStatus === "pending"/);
  assert.match(digitalHumanQueue, /setStage\(p, "workshop", "failed"\)/);
  assert.match(digitalHumanQueue, /setStatus\(p, "failed", prepared\.error\)/);
  assert.doesNotMatch(
    orchestrator.slice(orchestrator.indexOf("export function resumeActiveBatches"), orchestrator.indexOf("export function contextSummary")),
    /p\.stageStatus === "failed"/,
  );
  assert.match(jobs, /if \(!productionAllowsJobProcessing\(productionById\(j\.productionId\)\)\)/);
});
