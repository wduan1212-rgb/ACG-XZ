import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = relativePath => readFileSync(resolve(appRoot, relativePath), "utf8");

const indexHtml = read("index.html");
const baseCss = read("styles/base.css");
const mainJs = read("js/main.js");
const iconsJs = read("js/ui/icons.js");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing section start: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing section end: ${endMarker}`);
  return source.slice(start, end);
}

test("left context list scrolls while its scrollbar remains hidden", () => {
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.wsctx-groups\s*\{[^}]*overflow-y\s*:\s*auto\s*;[^}]*overflow-x\s*:\s*hidden\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.wsctx-groups\s*\{[^}]*scrollbar-width\s*:\s*none\s*;[^}]*-ms-overflow-style\s*:\s*none\s*;/s,
  );
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.wsctx-groups::-(?:webkit|Webkit)-scrollbar\s*\{[^}]*display\s*:\s*none\s*;[^}]*width\s*:\s*0\s*;/s,
  );
});

test("workspace v2 removes the legacy black primary navigation rail", () => {
  assert.match(
    baseCss,
    /body\.workspace-shell-v2\s+\.nav-rail\s*\{[^}]*display\s*:\s*none\s*!important\s*;/s,
  );
});

test("single-account workspace lists every account group without a 40-account cap", () => {
  const studioRows = section(mainJs, 'if (zone === "studio") {', 'if (zone === "agent") {');
  assert.doesNotMatch(studioRows, /\.slice\(\s*0\s*,\s*40\s*\)/);
  assert.match(studioRows, /title:\s*"图文组"/);
  assert.match(studioRows, /title:\s*"真人数字人"/);
  assert.match(studioRows, /title:\s*"素材无数字人"/);
  assert.match(studioRows, /title:\s*"已停用账号"/);
  assert.match(studioRows, /\.filter\(isAccountDisabled\)/);
});

test("batch-session context rows open the selected real session", () => {
  const routeHandler = section(
    mainJs,
    'const routeButton = event.target.closest("[data-ws-go]");',
    'panel.addEventListener("keydown"',
  );
  assert.match(routeHandler, /targetZone\s*===\s*"agent"/);
  assert.match(routeHandler, /openAgentSession\s*\(\s*targetId\s*\)/);
});

test("workspace v2 never moves the studio chain stepper into the floating topbar", () => {
  const renderTopbar = section(mainJs, "function renderTopbar()", "function paletteCommands()");
  const legacyGuard = renderTopbar.indexOf("if (!workspaceShellEnabled())");
  const insertion = renderTopbar.indexOf("topbar.insertBefore(studioStepper, actions)");
  assert.ok(legacyGuard >= 0, "chain-stepper relocation must be guarded by legacy-shell mode");
  assert.ok(insertion > legacyGuard, "chain-stepper relocation escaped the legacy-shell guard");
  assert.match(
    renderTopbar.slice(insertion),
    /else\s*\{\s*topbar\?\.classList\.remove\("studio-topbar-active"\)/s,
  );
});

test("all modified workspace-shell resources use a v120 cache marker", () => {
  assert.match(indexHtml, /styles\/base\.css\?v=20260727-v120[^"]*/);
  assert.match(indexHtml, /styles\/views\.css\?v=20260727-v120[^"]*/);
  assert.match(indexHtml, /styles\/agent\.css\?v=20260727-v120[^"]*/);
  assert.match(indexHtml, /js\/main\.js\?v=20260727-v120[^"]*/);
  assert.match(mainJs, /from\s+"\.\/views\/overview\.js\?v=20260727-v120[^"]*"/);
  assert.match(mainJs, /from\s+"\.\/agent\/view\.js\?v=20260727-v120[^"]*"/);
  assert.match(mainJs, /from\s+"\.\/ui\/icons\.js\?v=20260727-v120[^"]*"/);
});

test("dark batch workspace selects the white brand logo", () => {
  const switcher = section(mainJs, "function renderWorkspaceSwitcher()", "function workspaceItemHint");
  assert.match(switcher, /zone\s*===\s*"agent"/);
  assert.match(switcher, /["']dark["']/);
  assert.match(switcher, /workspaceBrandGlyph\s*\(/);
  assert.match(
    iconsJs,
    /normalizedTone\s*===\s*"dark"\s*\?\s*"white"\s*:\s*"black"/,
  );
});
