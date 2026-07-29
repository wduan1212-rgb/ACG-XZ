import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const overviewSource = readFileSync(new URL("../js/views/overview.js", import.meta.url), "utf8");
const viewsCss = readFileSync(new URL("../styles/views.css", import.meta.url), "utf8");
const performanceStart = overviewSource.indexOf("function overviewAccountPerformance");
const performanceEnd = overviewSource.indexOf("\n}\n\nconst dayKey", performanceStart) + 2;
const geometryStart = overviewSource.indexOf("function overviewTrendGeometry");
const geometryEnd = overviewSource.indexOf("\n}\n\nfunction overviewTrendModel", geometryStart) + 2;

assert.ok(performanceStart >= 0 && performanceEnd > performanceStart, "应能提取账号表现合并函数");
assert.ok(geometryStart >= 0 && geometryEnd > geometryStart, "应能提取趋势图几何函数");

const overviewAccountPerformance = Function(
  `"use strict"; ${overviewSource.slice(performanceStart, performanceEnd)}; return overviewAccountPerformance;`
)();
const overviewTrendGeometry = Function(
  `"use strict"; ${overviewSource.slice(geometryStart, geometryEnd)}; return overviewTrendGeometry;`
)();

const assertClose = (actual, expected, message) => {
  assert.ok(Math.abs(actual - expected) < 0.001, `${message}: ${actual} ≠ ${expected}`);
};

for (const pointCount of [7, 30]) {
  test(`${pointCount} 个趋势点与 CSS 网格单元中心精确对齐`, () => {
    const geometry = overviewTrendGeometry(pointCount);
    const expectedColumnWidth = (geometry.width - geometry.gap * (pointCount - 1)) / pointCount;

    assert.equal(geometry.positions.length, pointCount);
    geometry.positions.forEach((position, index) => {
      const expected = expectedColumnWidth / 2 + index * (expectedColumnWidth + geometry.gap);
      assertClose(position, expected, `第 ${index + 1} 个点`);
    });
    assert.equal(geometry.gridStart, geometry.positions[0]);
    assert.equal(geometry.gridEnd, geometry.positions.at(-1));
  });
}

test("单个趋势点居中且网格仍覆盖完整图表", () => {
  const geometry = overviewTrendGeometry(1);

  assert.deepEqual(geometry.positions, [geometry.width / 2]);
  assert.equal(geometry.gridStart, 0);
  assert.equal(geometry.gridEnd, geometry.width);
});

test("趋势图使用动态网格首尾并显式同步标签间距", () => {
  assert.doesNotMatch(overviewSource, /M24 18H540/);
  assert.match(overviewSource, /M\$\{trendGridStart\} 18H\$\{trendGridEnd\}/);
  assert.match(overviewSource, /style="gap:\$\{trendLabelGap\}px"/);
});

test("首页指标、图表与账号区域按新层级排列", () => {
  assert.doesNotMatch(overviewSource, /overview-kpi-strip|overview-kpi-card/);
  assert.doesNotMatch(overviewSource, /data-overview-detail="todo"/);
  assert.doesNotMatch(overviewSource, /data-overview-detail="dataQuality"|overview-action-icon is-link/);
  assert.match(overviewSource, /overview-action-icon is-views/);
  assert.match(overviewSource, /\$\{icon\("eye", 16\)\}/);
  assert.match(overviewSource, /const accountPageSize = 16/);
  assert.ok(overviewSource.indexOf("overview-action-grid") < overviewSource.indexOf("overview-viz-grid"));
  assert.ok(overviewSource.indexOf("overview-viz-grid") < overviewSource.indexOf("overview-account-strip"));
});

test("账号表现以真实账号为清单并合并已有分析快照", () => {
  const rows = overviewAccountPerformance(
    [
      { id: "a1", name: "账号一", monthlyDone: 3 },
      { id: "a2", name: "账号二", count: 5, monthlyDone: 2 },
      { id: "a3", name: "账号三" },
    ],
    [
      { name: "账号一", count: 2, engagement: 9, score: 88 },
      { name: "账号三", count: 1, engagement: 4, score: 70 },
      { name: "不存在的快照账号", count: 99, engagement: 99, score: 99 },
    ]
  );

  assert.equal(rows.length, 3);
  assert.deepEqual(new Set(rows.map(item => item.accountId)), new Set(["a1", "a2", "a3"]));
  assert.equal(rows.find(item => item.accountId === "a1").count, 2);
  assert.equal(rows.find(item => item.accountId === "a1").engagement, 9);
  assert.equal(rows.find(item => item.accountId === "a2").count, 5);
  assert.equal(rows.find(item => item.accountId === "a2").engagement, 0);
  assert.equal(rows.some(item => item.name === "不存在的快照账号"), false);
});

test("首页三栏使用统一白色基底并扩大账号表现区", () => {
  assert.match(viewsCss, /body\[data-zone="overview"\] \.view-root \{[\s\S]*?background: #fff !important;/);
  assert.match(viewsCss, /\.overview\.overview-dashboard\.overview-integrated \{[\s\S]*?background: #fff;/);
  assert.match(viewsCss, /padding: 8px 0 10px 16px;/);
  assert.match(viewsCss, /--overview-data-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(viewsCss, /--overview-data-gap: 10px;/);
  assert.match(viewsCss, /grid-template-rows: auto repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(viewsCss, /\.overview-action-grid \{[^}]*grid-template-columns: var\(--overview-data-columns\); gap: var\(--overview-data-gap\);/);
  assert.match(viewsCss, /\.overview-viz-grid \{[^}]*grid-template-columns: var\(--overview-data-columns\); gap: var\(--overview-data-gap\);/);
  assert.match(viewsCss, /\.overview-viz-grid > \.overview-donut-card \{ grid-column: 1; \}/);
  assert.match(viewsCss, /\.overview-viz-grid > \.overview-trend-card \{ grid-column: 2 \/ span 2; \}/);
  assert.match(viewsCss, /\.overview-account-strip \{ min-height: 0;/);
  assert.match(viewsCss, /\.overview-account-page \{ height: 100%;[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); grid-template-rows: repeat\(4, minmax\(0, 1fr\)\); grid-auto-rows: minmax\(0, 1fr\); align-content: stretch;/);
  assert.match(viewsCss, /\.overview-account-strip button \{[^}]*min-height: 0; height: auto;[^}]*align-self: stretch;/);
  assert.match(viewsCss, /\.overview-account-strip button:hover,[\s\S]*?color: #315fbe; border: 0; outline: none; background: transparent; transform: none;/);
  assert.doesNotMatch(viewsCss, /\.overview-kpi-card/);
});

test("发布分布保持左窄右宽且环图只保留中心总数", () => {
  assert.match(overviewSource, /<i><b>\$\{published\.length\}<\/b><em>已发布<\/em><\/i><\/span><\/div>/);
  assert.doesNotMatch(overviewSource, /小红书 <b>\$\{xhsCount\}<\/b>/);
  assert.doesNotMatch(overviewSource, /视频号 <b>\$\{videoCount\}<\/b>/);
  assert.doesNotMatch(viewsCss, /\.overview-donut-wrap > div|\.overview-donut-wrap p/);
  assert.match(viewsCss, /\.overview-donut > svg \{[^}]*overflow: hidden;/);
  assert.match(viewsCss, /\.supplier-donut > svg \{[^}]*overflow: hidden;/);
  assert.match(viewsCss, /\.overview-donut-segment:focus-visible \{[^}]*stroke-width: 16;/);
  assert.match(viewsCss, /\.supplier-donut-segment:hover,[^}]*\{[^}]*stroke-width: 20;/);
  assert.doesNotMatch(viewsCss, /\.overview-donut-segment[^}]*transform:\s*scale/);
  assert.doesNotMatch(viewsCss, /\.supplier-donut-segment[^}]*transform:\s*scale/);
});

test("数据助手删除建议问题并在空白区显示居中引导", () => {
  const messagesIndex = overviewSource.indexOf('class="ovc-msgs" id="ovcMsgs"');
  const inputIndex = overviewSource.indexOf('class="ovc-input"');

  assert.ok(messagesIndex >= 0);
  assert.ok(messagesIndex < inputIndex);
  assert.doesNotMatch(overviewSource, /CHAT_SUGS|data-ovq|ovc-prompt-dock/);
  assert.match(overviewSource, /<p class="ovc-empty-guide">可以直接询问发布、播放、互动或账号表现<\/p>/);
  assert.match(viewsCss, /grid-template-rows: auto minmax\(0, 1fr\) auto;/);
  assert.match(viewsCss, /\.overview-integrated \.ovc-msgs:has\(\.ovc-empty-guide\) \{ display: grid; place-items: center; \}/);
  assert.match(viewsCss, /\.overview-integrated \.ovc-empty-guide \{[\s\S]*?color: #a1a7af;[\s\S]*?text-align: center;/);
});
