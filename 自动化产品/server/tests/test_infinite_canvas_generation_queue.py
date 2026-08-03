import json
import subprocess
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
CANVAS_ROOT = ROOT / "apps" / "infinite-canvas-source"


def run_node(script: str):
    result = subprocess.run(
        ["node", "--experimental-strip-types", "--input-type=module", "-e", script],
        cwd=CANVAS_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout


def test_ten_image_queue_is_bounded_ordered_and_failure_isolated():
    queue_module = (CANVAS_ROOT / "src" / "lib" / "concurrencyQueue.ts").resolve().as_uri()
    script = textwrap.dedent(
        f"""
        import assert from "node:assert/strict";
        const {{ runConcurrentQueue }} = await import({json.dumps(queue_module)});
        let active = 0;
        let maxActive = 0;
        const started = [];
        const settled = [];
        const jobs = Array.from({{ length: 10 }}, (_, index) => async () => {{
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 4 + (index % 3) * 3));
          active -= 1;
          if (index === 2 || index === 7) throw new Error(`failed-${{index}}`);
          return `image-${{index}}`;
        }});
        const results = await runConcurrentQueue(jobs, {{
          limit: 3,
          onStart(index, count) {{ started.push([index, count]); }},
          onSettled(index, count) {{ settled.push([index, count]); }},
        }});
        assert.equal(results.length, 10);
        assert.ok(maxActive <= 3, `max active was ${{maxActive}}`);
        assert.deepEqual(
          results.map((result, index) => result.status === "fulfilled" ? result.value : `failed-${{index}}`),
          Array.from({{ length: 10 }}, (_, index) => index === 2 || index === 7 ? `failed-${{index}}` : `image-${{index}}`),
        );
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 8);
        assert.equal(results.filter((result) => result.status === "rejected").length, 2);
        assert.equal(started.length, 10);
        assert.equal(settled.length, 10);
        assert.ok(started.every(([, count]) => count >= 1 && count <= 3));
        """
    )
    run_node(script)


def test_abort_timeout_499_and_413_are_recognizable():
    request_module = (CANVAS_ROOT / "src" / "lib" / "request.ts").resolve().as_uri()
    script = textwrap.dedent(
        f"""
        import assert from "node:assert/strict";
        const request = await import({json.dumps(request_module)});
        assert.equal(request.canvasHttpError(413, "", "图片").code, "payload-too-large");
        assert.match(request.canvasHttpError(413, "", "图片").message, /过大/);
        assert.equal(request.canvasHttpError(499, "", "图片").code, "cancelled");

        const caller = new AbortController();
        const cancelled = request.runAbortableRequest(
          (signal) => new Promise((resolve, reject) => {{
            signal.addEventListener("abort", () => reject(signal.reason), {{ once: true }});
            setTimeout(resolve, 200);
          }}),
          {{ signal: caller.signal, timeoutMs: 1000, label: "图片生成" }},
        );
        caller.abort();
        await assert.rejects(cancelled, (error) => error.code === "cancelled" && error.status === 499);

        const preCancelled = new AbortController();
        preCancelled.abort();
        let upstreamCalls = 0;
        await assert.rejects(
          request.runAbortableRequest(
            async () => {{ upstreamCalls += 1; return "should-not-run"; }},
            {{ signal: preCancelled.signal, timeoutMs: 1000, label: "图片生成" }},
          ),
          (error) => error.code === "cancelled" && error.status === 499,
        );
        assert.equal(upstreamCalls, 0);

        await assert.rejects(
          request.runAbortableRequest(
            (signal) => new Promise((resolve, reject) => {{
              signal.addEventListener("abort", () => reject(signal.reason), {{ once: true }});
              setTimeout(resolve, 200);
            }}),
            {{ timeoutMs: 5, label: "图片生成" }},
          ),
          (error) => error.code === "timeout" && /超时/.test(error.message),
        );
        """
    )
    run_node(script)


def test_pagehide_unmount_and_project_switch_abort_without_resuming_old_batch():
    lifecycle_module = (
        CANVAS_ROOT / "src" / "lib" / "requestLifecycle.ts"
    ).resolve().as_uri()
    script = textwrap.dedent(
        f"""
        import assert from "node:assert/strict";
        const lifecycleApi = await import({json.dumps(lifecycle_module)});
        const target = new EventTarget();
        const lifecycle = new lifecycleApi.CanvasRequestLifecycle();
        const unbind = lifecycleApi.bindCanvasPageLifecycle(lifecycle, target);

        const pageBatchSignal = lifecycle.signal;
        target.dispatchEvent(new Event("pagehide"));
        assert.equal(pageBatchSignal.aborted, true);
        assert.equal(pageBatchSignal.reason?.name, "AbortError");

        // Returning from the back-forward cache creates a fresh caller signal,
        // but the signal captured by the old paid batch stays aborted.
        target.dispatchEvent(new Event("pageshow"));
        const resumedSignal = lifecycle.signal;
        assert.notStrictEqual(resumedSignal, pageBatchSignal);
        assert.equal(resumedSignal.aborted, false);
        assert.equal(pageBatchSignal.aborted, true);

        // Component cleanup unbinds page events and aborts its live operation.
        unbind();
        target.dispatchEvent(new Event("pagehide"));
        assert.equal(resumedSignal.aborted, false);
        lifecycle.dispose("project switch");
        assert.equal(resumedSignal.aborted, true);

        // A switched project owns a separate lifecycle and cannot revive or
        // inherit the old project's cancellation state.
        const nextProject = new lifecycleApi.CanvasRequestLifecycle();
        assert.equal(nextProject.signal.aborted, false);
        const disposedSignal = lifecycle.signal;
        lifecycle.resume();
        assert.notStrictEqual(lifecycle.signal, disposedSignal);
        assert.equal(lifecycle.signal.aborted, false);
        assert.equal(disposedSignal.aborted, true);
        nextProject.dispose("unmount");
        assert.equal(nextProject.signal.aborted, true);
        """
    )
    run_node(script)


def test_pagehide_cancels_active_and_queued_generation_without_auto_retry():
    queue_module = (CANVAS_ROOT / "src" / "lib" / "concurrencyQueue.ts").resolve().as_uri()
    request_module = (CANVAS_ROOT / "src" / "lib" / "request.ts").resolve().as_uri()
    lifecycle_module = (
        CANVAS_ROOT / "src" / "lib" / "requestLifecycle.ts"
    ).resolve().as_uri()
    script = textwrap.dedent(
        f"""
        import assert from "node:assert/strict";
        const {{ runConcurrentQueue }} = await import({json.dumps(queue_module)});
        const request = await import({json.dumps(request_module)});
        const {{ CanvasRequestLifecycle }} = await import({json.dumps(lifecycle_module)});
        const lifecycle = new CanvasRequestLifecycle();
        const batchSignal = lifecycle.signal;
        let upstreamStarted = 0;
        let active = 0;
        let maxActive = 0;

        const jobs = Array.from({{ length: 10 }}, (_, index) => async () =>
          request.runAbortableRequest(async (signal) => {{
            if (signal.aborted) throw signal.reason;
            upstreamStarted += 1;
            active += 1;
            maxActive = Math.max(maxActive, active);
            try {{
              await new Promise((resolve, reject) => {{
                const timer = setTimeout(resolve, 200);
                signal.addEventListener("abort", () => {{
                  clearTimeout(timer);
                  reject(signal.reason);
                }}, {{ once: true }});
              }});
              return `image-${{index}}`;
            }} finally {{
              active -= 1;
            }}
          }}, {{ signal: batchSignal, timeoutMs: 1_000, label: "图片生成" }})
        );

        const batch = runConcurrentQueue(jobs, {{ limit: 3 }});
        setTimeout(() => lifecycle.interrupt("pagehide"), 8);
        const results = await batch;
        assert.ok(maxActive <= 3);
        assert.equal(upstreamStarted, 3, "queued jobs must not start a paid upstream request");
        assert.equal(results.length, 10);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 0);
        assert.ok(results.every(
          (result) => result.status === "rejected" && request.isCanvasRequestCancelled(result.reason),
        ));
        assert.equal(active, 0);
        """
    )
    run_node(script)


def test_hydration_repairs_old_loading_without_touching_mixed_results():
    persistence_module = (
        CANVAS_ROOT / "src" / "lib" / "canvasPersistence.ts"
    ).resolve().as_uri()
    script = textwrap.dedent(
        f"""
        import assert from "node:assert/strict";
        const persistence = await import({json.dumps(persistence_module)});
        const now = 1_000_000;
        const old = now - 20_000;
        const fresh = now - 500;
        const base = {{
          projectId: "p", position: {{ x: 0, y: 0 }},
          size: {{ width: 100, height: 100 }}, z: 1,
          naturalWidth: 100, naturalHeight: 100,
          mode: "final", quality: "low", provenance: {{}},
        }};
        const state = {{
          items: [
            {{ ...base, id: "old-loading", type: "generation", assetUrl: "", jobId: "a", createdAt: old, loading: true }},
            {{ ...base, id: "old-done-image", type: "generation", assetUrl: "/api/custom-canvas/blobs/" + "a".repeat(64), jobId: "b", createdAt: old, loading: true }},
            {{ ...base, id: "mixed-done", type: "generation", assetUrl: "/api/custom-canvas/blobs/" + "b".repeat(64), jobId: "c", createdAt: old, loading: false, generationStatus: "done" }},
            {{ ...base, id: "fresh-loading", type: "generation", assetUrl: "", jobId: "d", createdAt: fresh, loading: true }},
          ],
          messages: [
            {{ id: "thinking", role: "agent", text: "", createdAt: old, status: "thinking" }},
            {{ id: "partial", role: "agent", text: "", createdAt: old, status: "thinking", resultItemIds: ["mixed-done"] }},
            {{ id: "done", role: "agent", text: "ok", createdAt: old, status: "done", resultItemIds: ["mixed-done"] }},
          ],
        }};
        const recovered = persistence.recoverInterruptedCanvasState(state, now, 5_000);
        assert.equal(recovered.changed, true);
        const byId = Object.fromEntries(recovered.state.items.map((item) => [item.id, item]));
        assert.equal(byId["old-loading"].loading, false);
        assert.equal(byId["old-loading"].generationStatus, "interrupted");
        assert.equal(byId["old-loading"].error, "任务已中断，可重试");
        assert.equal(byId["old-done-image"].generationStatus, "done");
        assert.equal(byId["old-done-image"].assetUrl, state.items[1].assetUrl);
        assert.strictEqual(byId["mixed-done"], state.items[2]);
        assert.strictEqual(byId["fresh-loading"], state.items[3]);
        assert.equal(recovered.state.messages[0].status, "error");
        assert.equal(recovered.state.messages[0].text, "任务已中断，可重试");
        assert.equal(recovered.state.messages[1].status, "partial");
        assert.strictEqual(recovered.state.messages[2], state.messages[2]);

        // A full page reload has no live generation promise. First hydration
        // therefore repairs even a recently persisted marker immediately.
        const firstHydration = persistence.recoverInterruptedCanvasState(state, now, 0);
        const firstById = Object.fromEntries(firstHydration.state.items.map((item) => [item.id, item]));
        assert.equal(firstById["fresh-loading"].loading, false);
        assert.equal(firstById["fresh-loading"].generationStatus, "interrupted");
        """
    )
    run_node(script)


def test_generation_source_contract_persists_progressive_results():
    source = (
        CANVAS_ROOT / "src" / "components" / "workspace" / "useStudioActions.ts"
    ).read_text(encoding="utf-8")
    assert "runConcurrentQueue" in source
    assert "limit: 3" in source
    assert "persistCanvasBlob(image.dataUrl, id, {" in source
    assert "generationReceipt: image.generationReceipt" in source
    assert "idempotencyKey: id" in source
    assert "idempotencyKey: job.id" in source
    assert "await flushCanvasProjectLocal(projectId)" in source
    assert 'generationStatus: cancelled ? "interrupted" : "failed"' in source
    assert "new CanvasRequestLifecycle(projectId)" in source
    assert "bindCanvasPageLifecycle(requestLifecycle, window)" in source
    assert "requestLifecycle.dispose()" in source
    assert "const requestSignal = requestLifecycle.signal" in source
    assert "if (!cancelled) recordFailure(projectId)" in source
    assert 'status: done.length === count ? "done" : done.length > 0 ? "partial" : "error"' in source
    assert "Promise.allSettled" not in source


def load_tests(loader, tests, pattern):
    del loader, tests, pattern
    suite = unittest.TestSuite()
    for test in (
        test_ten_image_queue_is_bounded_ordered_and_failure_isolated,
        test_abort_timeout_499_and_413_are_recognizable,
        test_pagehide_unmount_and_project_switch_abort_without_resuming_old_batch,
        test_pagehide_cancels_active_and_queued_generation_without_auto_retry,
        test_hydration_repairs_old_loading_without_touching_mixed_results,
        test_generation_source_contract_persists_progressive_results,
    ):
        suite.addTest(unittest.FunctionTestCase(test))
    return suite


if __name__ == "__main__":
    unittest.main()
