import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const overviewSource = readFileSync(new URL("../js/views/overview.js", import.meta.url), "utf8");
const viewsCss = readFileSync(new URL("../styles/views.css", import.meta.url), "utf8");
const geometryStart = overviewSource.indexOf("function overviewTrendGeometry");
const geometryEnd = overviewSource.indexOf("\n}\n\nfunction overviewTrendModel", geometryStart) + 2;

assert.ok(geometryStart >= 0 && geometryEnd > geometryStart, "应能提取趋势图几何函数");

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

test("账号数据以双环图和沟通预览为上层，趋势图在下层", () => {
  assert.doesNotMatch(overviewSource, /overview-kpi-strip|overview-kpi-card/);
  assert.doesNotMatch(overviewSource, /data-overview-detail="todo"/);
  assert.match(overviewSource, /overview-summary-grid/);
  assert.match(overviewSource, /<b>播放量分布<\/b>/);
  assert.match(overviewSource, /<b>发布量分布<\/b>/);
  assert.match(overviewSource, /overview-remark-preview/);
  assert.ok(overviewSource.indexOf("overview-summary-grid") < overviewSource.indexOf("overview-trend-card"));
  assert.doesNotMatch(overviewSource, /overview-account-strip/);
});

test("账号数据使用统一白色基底和仅两层的满高排版", () => {
  assert.match(viewsCss, /body\[data-zone="overview"\] \.view-root \{[\s\S]*?background: #fff !important;/);
  assert.match(viewsCss, /\.overview\.overview-dashboard\.overview-integrated \{[\s\S]*?background: #fff;/);
  assert.match(viewsCss, /padding: 8px 0 10px 16px;/);
  assert.match(viewsCss, /--overview-data-gap: 10px;/);
  assert.match(viewsCss, /grid-template-rows: minmax\(210px, \.62fr\) minmax\(260px, 1\.38fr\);/);
  assert.match(viewsCss, /\.overview-summary-grid \{[^}]*grid-template-columns: minmax\(180px, \.7fr\) minmax\(180px, \.7fr\) minmax\(250px, 1\.25fr\);/);
  assert.match(viewsCss, /\.overview-trend-card \{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
  assert.doesNotMatch(viewsCss, /\.overview-kpi-card/);
});

test("播放与发布环图都使用可点击中心总数", () => {
  assert.match(overviewSource, /class="overview-donut-center" type="button" data-overview-detail="views"/);
  assert.match(overviewSource, /class="overview-donut-center" type="button" data-overview-detail="publishedPlatforms"/);
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

test("内容数据按账号默认折叠并仅对真实回传地址显示跳转链接", () => {
  assert.match(overviewSource, /<details class="overview-view-account">/);
  assert.doesNotMatch(overviewSource, /<details class="overview-view-account" open>/);
  assert.match(overviewSource, /const publishedUrl = String\(item\.link\?\.url \|\| item\.asset\?\.publishedUrl/);
  assert.match(overviewSource, /target="_blank" rel="noopener noreferrer">跳转链接<\/a>/);
  assert.match(overviewSource, /<span>链接<\/span><\/div>/);
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
