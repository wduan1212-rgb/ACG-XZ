import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const ROOT = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(
  path.join(ROOT, "apps/video-workshop/web/assets/app.js"),
  "utf8",
);

function scrollHarness() {
  const start = source.indexOf("const CONVERSATION_BOTTOM_THRESHOLD");
  const end = source.indexOf("function createClientId()", start);
  assert.ok(start >= 0 && end > start, "conversation scroll helpers must remain discoverable");

  const frameCallbacks = [];
  const context = vm.createContext({
    window: {
      requestAnimationFrame(callback) {
        frameCallbacks.push(callback);
      },
    },
  });
  vm.runInContext(`${source.slice(start, end)}\nthis.api = { captureConversationScroll, scheduleConversationScroll };`, context);
  return {
    ...context.api,
    flushFrame() {
      const callback = frameCallbacks.shift();
      assert.ok(callback, "a container scroll frame should be scheduled");
      callback();
    },
  };
}

function column({ scrollHeight, scrollTop, clientHeight }) {
  return {
    scrollHeight,
    scrollTop,
    clientHeight,
    calls: [],
    scrollTo(options) {
      this.calls.push(options);
      this.scrollTop = options.top;
    },
  };
}

test("explicit send scrolls only the conversation container to show user and pending messages", () => {
  assert.doesNotMatch(source, /\.scrollIntoView\s*\(/);
  assert.match(source, /if \(pendingScrollId \|\| hasActiveBottomLock\)/);
  assert.match(source, /stabilizeConversationBottom\([\s\S]*?pendingScrollId[\s\S]*?12000/);

  const harness = scrollHarness();
  const conversationColumn = column({ scrollHeight: 1280, scrollTop: 260, clientHeight: 420 });
  const snapshot = harness.captureConversationScroll(conversationColumn);
  harness.scheduleConversationScroll(conversationColumn, snapshot, { forceBottom: true, smooth: true });
  harness.flushFrame();

  assert.equal(conversationColumn.scrollTop, 1280);
  assert.equal(conversationColumn.calls.length, 1);
  assert.equal(conversationColumn.calls[0].top, 1280);
  assert.equal(conversationColumn.calls[0].behavior, "smooth");
});

test("poll redraw preserves history position unless the reader was already near bottom", () => {
  const historyHarness = scrollHarness();
  const readingHistory = column({ scrollHeight: 1600, scrollTop: 240, clientHeight: 420 });
  const historySnapshot = historyHarness.captureConversationScroll(readingHistory);
  readingHistory.scrollTop = 0;
  readingHistory.scrollHeight = 1680;
  historyHarness.scheduleConversationScroll(readingHistory, historySnapshot);
  historyHarness.flushFrame();

  assert.equal(historySnapshot.wasNearBottom, false);
  assert.equal(readingHistory.scrollTop, 240);
  assert.deepEqual(readingHistory.calls, []);

  const bottomHarness = scrollHarness();
  const nearBottom = column({ scrollHeight: 1600, scrollTop: 1120, clientHeight: 420 });
  const bottomSnapshot = bottomHarness.captureConversationScroll(nearBottom);
  nearBottom.scrollHeight = 1740;
  bottomHarness.scheduleConversationScroll(nearBottom, bottomSnapshot);
  bottomHarness.flushFrame();

  assert.equal(bottomSnapshot.wasNearBottom, true);
  assert.equal(nearBottom.scrollTop, 1740);
  assert.equal(nearBottom.calls.length, 1);
  assert.equal(nearBottom.calls[0].top, 1740);
  assert.equal(nearBottom.calls[0].behavior, "auto");
});
