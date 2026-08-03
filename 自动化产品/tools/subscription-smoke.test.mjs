import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = path => readFile(new URL(path, root), "utf8");

test("subscription keeps existing ACG team plans read-only", async () => {
  const source = await read("js/views/subscription.js");

  assert.match(source, /internalTeam \? "team-pro"/);
  assert.match(source, /planLocked: internalTeam \|\| Boolean\(currentPlanId\)/);
  assert.match(source, /disabled aria-disabled=/);
  assert.match(source, /if \(context\.planLocked\) return/);
  assert.match(source, /\u5f53\u524d\u65b9\u6848/);
  assert.match(source, /ACG \u56e2\u961f\u6743\u76ca/);
  assert.match(source, /\u8ba2\u9605\u661f\u9635，\u89e3\u9501\u66f4\u591a\u80fd\u529b！/);
  assert.match(source, /is-internal-current/);
  assert.doesNotMatch(source, /\u5f53\u524d\u4e3a\u672c\u5730\u65b9\u6848\u9884\u89c8/);
  assert.doesNotMatch(source, /Fast \u4e0e\u6807\u51c6 2\.0 \u7684\u53ef\u751f\u6210\u65f6\u957f/);
});

test("subscription is a plans-only page with one six-tier top-up modal", async () => {
  const [source, styles] = await Promise.all([
    read("js/views/subscription.js"),
    read("styles/views.css"),
  ]);

  assert.match(source, /function openTopUpModal\(\)/);
  assert.match(source, /subscription-topup-modal/);
  assert.equal([...source.matchAll(/id: "points-[0-9]+"/g)].length, 6);
  assert.match(source, /points-500/);
  assert.match(source, /points-1000/);
  assert.match(source, /points-2000/);
  assert.match(source, /points-5000/);
  assert.match(source, /points-10000/);
  assert.match(source, /points-20000/);
  assert.match(source, /class="subscription-topup-trigger"[^>]*data-topup-open/);
  assert.doesNotMatch(source, /subscription-local-nav/);
  assert.doesNotMatch(source, /data-subscription-panel=/);
  assert.doesNotMatch(source, /subscription-topup-page/);
  assert.doesNotMatch(source, /normalizePanel/);
  assert.match(source, /data-subscription-content="plans"/);
  assert.doesNotMatch(source, /subscription-details/);
  assert.doesNotMatch(source, /subscription-footnote/);
  assert.match(styles, /data-zone="subscription"[^}]*\.view-root\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.subscription-page\s*\{[^}]*display:\s*block[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.subscription-content\s*\{[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\)/s);
  assert.doesNotMatch(styles, /\.subscription-content\.is-topup/);
  assert.doesNotMatch(styles, /\.subscription-topup-page/);
  assert.doesNotMatch(styles, /\.subscription-local-nav/);
  assert.doesNotMatch(styles, /\.subscription-page\s*\{[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.subscription-plans\s*\{[^}]*overflow-x:\s*auto[^}]*overflow-y:\s*hidden/s);
  assert.doesNotMatch(styles, /\.subscription-details/);
  assert.doesNotMatch(styles, /\.subscription-footnote/);
});

test("billing cycle switches in place with a sliding indicator and stable cards", async () => {
  const [source, styles] = await Promise.all([
    read("js/views/subscription.js"),
    read("styles/views.css"),
  ]);

  assert.match(source, /function applyBillingCycle\(root, cycle\)/);
  assert.match(source, /style\.setProperty\("--subscription-cycle-index"/);
  assert.match(source, /updatePlanPricing\(card, plan, cycle\)/);
  assert.match(source, /root\.innerHTML = subscriptionMarkup\(\)/);
  assert.doesNotMatch(source, /replaceWith\(/);
  assert.doesNotMatch(source, /redraw\(/);
  assert.match(styles, /\.subscription-period > i\s*\{[^}]*transition:\s*transform 300ms/s);
  assert.match(styles, /translateX\(calc\(var\(--subscription-cycle-index, 0\) \* 100%\)\)/);
  assert.match(styles, /\.subscription-plans\.is-cycle-updating/);
  assert.match(styles, /@keyframes subscriptionCycleRefresh/);
});

test("subscription hero remains centered while ACG entitlement stays aside", async () => {
  const styles = await read("styles/views.css");

  assert.match(styles, /\.subscription-hero\s*\{[^}]*display:\s*block[^}]*text-align:\s*center/s);
  assert.match(styles, /\.subscription-hero > div\s*\{[^}]*margin:\s*0 auto[^}]*text-align:\s*center/s);
  assert.match(styles, /\.subscription-hero aside\s*\{[^}]*position:\s*absolute[^}]*right:\s*0/s);
  assert.match(styles, /\.subscription-toolbar\s*\{[^}]*place-items:\s*center/s);
});

test("team plans expose seat sliders with approved incremental pricing", async () => {
  const source = await read("js/views/subscription.js");

  assert.match(source, /baseSeats: 5/);
  assert.match(source, /baseSeats: 10/);
  assert.match(source, /type="range"/);
  assert.match(source, /Math\.max\(0, Number\(seats \|\| 0\) - Number\(plan\.baseSeats \|\| 0\)\) \* 99/);
  assert.match(source, /\u00a599 \/ \u5e2d\u4f4d \/ \u6708/);
  assert.match(source, /selectedSeatsByPlan\.set\(plan\.id, seats\)/);
  assert.match(source, /seatSelector\(plan, \{ enabled: !disabled, value: initialSeats \}\)/);
});

test("billing cycles use approved monthly prices without annual model-credit discount", async () => {
  const source = await read("js/views/subscription.js");

  assert.match(source, /label: "\u8fde\u7eed\u5305\u6708"[\s\S]*?months: 1/);
  assert.match(source, /label: "\u8fde\u7eed\u5305\u5e74"[\s\S]*?months: 12/);
  assert.match(source, /label: "\u5355\u6708\u8ba2\u8d2d"[\s\S]*?months: 1/);
  assert.match(source, /\u5168\u5e74\u989d\u5ea6\u6309\u6708\u53d1\u653e，\u6309\u5e74\u81ea\u52a8\u7eed\u8d39/);
  assert.match(source, /\u4ec5\u542b\u4e00\u4e2a\u6708，\u4e0d\u81ea\u52a8\u7eed\u8d39/);
  assert.match(source, /monthlyPlanPrice\(plan, seats\) \* cycle\.months/);
  assert.doesNotMatch(source, /\u4e24\u4e2a\u6708\u514d\u8d39|2 \u4e2a\u6708\u514d\u8d39|annualDiscount|discountRate/);
});
