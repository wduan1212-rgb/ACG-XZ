import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => readFileSync(resolve(appRoot, relativePath), "utf8");

const baseCss = read("styles/base.css");
const mainJs = read("js/main.js");
const workshopCss = read("apps/video-workshop/web/assets/styles.css");
const workshopJs = read("apps/video-workshop/web/assets/app.js");

function cssBlock(source, selector) {
  const start = source.indexOf(selector);
  assert.notEqual(start, -1, `missing selector: ${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

test("infinite canvas keeps its complete workspace suffix visible", () => {
  assert.match(mainJs, /key:\s*"custom-canvas",\s*label:\s*"无限画布"/);
  assert.match(
    cssBlock(baseCss, ".workspace-context-brand .workspace-switch-button"),
    /grid-template-columns:\s*76px\s+minmax\(48px,\s*1fr\)\s+auto/,
  );
  assert.match(cssBlock(baseCss, ".workspace-brand-lockup"), /width:\s*76px/);
});

test("video workshop reserves space for a growing composer and keeps speed text legible", () => {
  assert.match(cssBlock(workshopCss, ".conversation-pane"), /--chat-composer-safe-space:\s*126px/);
  assert.match(
    cssBlock(workshopCss, ".conversation-column"),
    /padding:[^;]*var\(--chat-composer-safe-space\)/,
  );
  assert.match(workshopJs, /function syncChatComposerSafeSpace\(\)/);
  assert.match(workshopJs, /new ResizeObserver\(syncChatComposerSafeSpace\)/);
  assert.match(
    workshopCss,
    /html\[data-platform-workspace="true"\] \.chat-delivery-card \.chat-delivery-actions \.delivery-speed-menu summary\s*\{[^}]*color:\s*#f1f1ee/s,
  );
});
