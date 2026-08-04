import { esc } from "../core/util.js";
import { currentMember, currentTeam } from "../core/store.js";
import { icon } from "../ui/icons.js";
import { openModal, toast } from "../ui/components.js?v=20260805-v140-platform-stability-1";

const PLANS = [
  {
    id: "personal-pro",
    name: "个人专业版",
    price: 149,
    points: "2,200",
    fast: "约 2.3 分钟",
    standard: "约 1.8 分钟",
    note: "适合刚开始稳定创作的个人用户",
    features: ["视频工坊与无限画布", "完整发布能力", "图片、语音与音效额度"],
  },
  {
    id: "personal-advanced",
    name: "个人高频版",
    price: 249,
    points: "3,600",
    fast: "约 3.75 分钟",
    standard: "约 3 分钟",
    note: "适合持续创作与高频迭代",
    featured: true,
    features: ["包含个人专业版全部能力", "更高月度点数", "优先任务队列"],
  },
  {
    id: "team",
    name: "团队版",
    price: 999,
    points: "9,000 共享点",
    fast: "约 9.4 分钟",
    standard: "约 7.5 分钟",
    note: "包含 5 个席位，团队共享额度",
    baseSeats: 5,
    maxSeats: 20,
    features: ["团队成员与权限管理", "共享项目及资产", "管理员成员额度设置"],
  },
  {
    id: "team-pro",
    name: "团队专业版",
    price: 1999,
    points: "20,000 共享点",
    fast: "约 20.8 分钟",
    standard: "约 16.7 分钟",
    note: "包含 10 个席位，适合商业内容团队",
    baseSeats: 10,
    maxSeats: 30,
    features: ["包含团队版全部能力", "更高共享点数", "优先支持与团队审计"],
  },
];

const TOP_UP_PACKS = [
  { id: "points-500", points: "500", price: 39, note: "少量补充，适合图片与语音生成" },
  { id: "points-1000", points: "1,000", price: 79, note: "适合一次完成轻量创作" },
  { id: "points-2000", points: "2,000", price: 159, note: "适合多个短视频或一轮批量生产" },
  { id: "points-5000", points: "5,000", price: 399, note: "适合连续创作和集中批量生产" },
  { id: "points-10000", points: "10,000", price: 759, note: "适合高频内容生产与多项目并行" },
  { id: "points-20000", points: "20,000", price: 1499, note: "适合商业级集中生产周期" },
];

const BILLING_CYCLES = [
  {
    id: "monthly",
    label: "连续包月",
    months: 1,
    periodLabel: "/ 月",
    note: "按月自动续费",
  },
  {
    id: "annual",
    label: "连续包年",
    months: 12,
    periodLabel: "/ 年",
    note: "全年额度按月发放，按年自动续费",
  },
  {
    id: "single",
    label: "单月订购",
    months: 1,
    periodLabel: "/ 次",
    note: "仅含一个月，不自动续费",
  },
];

let activeBillingCycleId = "monthly";
const selectedSeatsByPlan = new Map();

function activeBillingCycle() {
  return BILLING_CYCLES.find(cycle => cycle.id === activeBillingCycleId) || BILLING_CYCLES[0];
}

function monthlyPlanPrice(plan, seats = plan.baseSeats || 0) {
  return plan.price + Math.max(0, Number(seats || 0) - Number(plan.baseSeats || 0)) * 99;
}

function periodPlanPrice(plan, seats, cycle = activeBillingCycle()) {
  return monthlyPlanPrice(plan, seats) * cycle.months;
}

function formatPrice(value) {
  return `¥${Number(value || 0).toLocaleString("zh-CN")}`;
}

function billingNote(plan, seats, cycle = activeBillingCycle()) {
  const monthly = monthlyPlanPrice(plan, seats);
  if (cycle.id === "annual") {
    return `按月 ${formatPrice(monthly)} · ${cycle.note}`;
  }
  return cycle.note;
}

function subscriptionContext() {
  const member = currentMember();
  const team = currentTeam();
  const internalTeam = team?.name === "ACG市场部" || team?.kind === "internal";
  const rawPlan = String(member?.plan || member?.subscription || "").trim().toLowerCase();
  const planAliases = {
    pro: "personal-pro",
    professional: "personal-pro",
    advanced: "personal-advanced",
    "personal-pro": "personal-pro",
    "personal-advanced": "personal-advanced",
    team: "team",
    "team-pro": "team-pro",
    "team-professional": "team-pro",
  };
  // ACG 市场部是平台内部最高团队方案：无限积分只是结算策略，
  // 套餐身份仍应落在团队专业版，避免界面误标为第三档团队版。
  const currentPlanId = internalTeam ? "team-pro" : (planAliases[rawPlan] || "");
  return { internalTeam, currentPlanId, planLocked: internalTeam || Boolean(currentPlanId) };
}

function seatSelector(plan, { enabled, value = plan.baseSeats }) {
  if (!plan.baseSeats) return "";
  return `<div class="subscription-seats" data-seat-control>
    <label for="subscriptionSeats-${esc(plan.id)}">
      <span>席位数</span>
      <output data-seat-output>${value} 席位</output>
    </label>
    <input id="subscriptionSeats-${esc(plan.id)}" type="range" min="${plan.baseSeats}" max="${plan.maxSeats}" step="1" value="${value}" data-seat-range ${enabled ? "" : "disabled"} />
    <small><span>已含 ${plan.baseSeats} 席</span><span>超出部分 ¥99 / 席位 / 月</span></small>
  </div>`;
}

function planCard(plan, context, cycle) {
  const isCurrent = context.currentPlanId === plan.id;
  const disabled = context.planLocked;
  const initialSeats = selectedSeatsByPlan.get(plan.id) || plan.baseSeats || 0;
  const periodPrice = periodPlanPrice(plan, initialSeats, cycle);
  const currentCapacity = isCurrent && context.internalTeam ? "无限团队积分" : plan.points;
  const classes = [
    "subscription-plan",
    plan.featured ? "is-featured" : "",
    plan.id === "team" ? "is-team" : "",
    plan.id === "team-pro" ? "is-team-pro" : "",
    isCurrent ? "is-current" : "",
    isCurrent && context.internalTeam ? "is-internal-current" : "",
  ].filter(Boolean).join(" ");
  const planActionLabel = isCurrent ? "当前方案" : (disabled ? "已有生效方案" : "选择方案");
  return `<article class="${classes}" data-plan-card="${esc(plan.id)}" data-base-price="${plan.price}" data-base-seats="${plan.baseSeats || 0}">
    <header>
      <div><span>${isCurrent ? "当前方案" : (plan.featured ? "推荐" : "订阅")}</span><h3>${esc(plan.name)}</h3><p>${esc(plan.note)}</p></div>
      <div class="subscription-price"><b data-plan-price>${formatPrice(periodPrice)}</b><em data-plan-period>${esc(cycle.periodLabel)}</em></div>
      <small class="subscription-billing-note" data-plan-billing-note>${esc(billingNote(plan, initialSeats, cycle))}</small>
    </header>
    <div class="subscription-capacity">
      <strong>${esc(currentCapacity)}</strong>
      <span>Seedance Fast ${esc(plan.fast)}</span>
      <span>Seedance 标准 2.0 ${esc(plan.standard)}</span>
    </div>
    ${seatSelector(plan, { enabled: !disabled, value: initialSeats })}
    <ul>${plan.features.map(feature => `<li>${icon("check", 14)}${esc(feature)}</li>`).join("")}</ul>
    <button type="button" data-select-plan="${esc(plan.id)}" ${disabled ? "disabled aria-disabled=\"true\"" : ""}>${planActionLabel} ${isCurrent ? icon("check", 14) : icon("arrowRight", 14)}</button>
  </article>`;
}

function cycleIndex(cycleId = activeBillingCycleId) {
  return Math.max(0, BILLING_CYCLES.findIndex(cycle => cycle.id === cycleId));
}

function subscriptionContentMarkup() {
  const context = subscriptionContext();
  const cycle = activeBillingCycle();
  return `<div class="subscription-content" data-subscription-content="plans">
      <header class="subscription-hero">
        <div>
          <span>SUBSCRIPTION</span>
          <h1>订阅星阵，解锁更多能力！</h1>
          <p>月度点数可用于视频、图片、语音与音效生成。所有分钟数均为按当前公开价测算的约数。</p>
        </div>
        ${context.internalTeam
          ? `<aside class="is-premium">${icon("spark", 17)}<b>ACG 团队权益</b><span>当前内部团队默认无限积分，无需购买。</span></aside>`
          : ""}
      </header>

      <div class="subscription-toolbar">
        <div class="subscription-period" role="tablist" aria-label="订阅周期" style="--subscription-cycle-index:${cycleIndex(cycle.id)}">
          <i aria-hidden="true"></i>
        ${BILLING_CYCLES.map(item => `<button type="button" class="${item.id === cycle.id ? "is-active" : ""}" role="tab" aria-selected="${item.id === cycle.id ? "true" : "false"}" data-billing-cycle="${esc(item.id)}">${esc(item.label)}</button>`).join("")}
        </div>
        <button class="subscription-topup-trigger" type="button" data-topup-open>${icon("spark", 15)}<b>加量包</b>${icon("arrowRight", 14)}</button>
      </div>
      <div class="subscription-plans">${PLANS.map(plan => planCard(plan, context, cycle)).join("")}</div>
    </div>`;
}

function subscriptionMarkup() {
  return `<section class="subscription-page">${subscriptionContentMarkup()}</section>`;
}

function openTopUpModal() {
  const context = subscriptionContext();
  const options = TOP_UP_PACKS.map((pack, index) => `<label class="subscription-topup-option${index === 0 ? " is-selected" : ""}">
    <input type="radio" name="subscriptionTopUp" value="${esc(pack.id)}" ${index === 0 ? "checked" : ""} ${context.internalTeam ? "disabled" : ""} />
    <span><b>${esc(pack.points)} 点</b><small>${esc(pack.note)}</small></span>
    <strong>¥${pack.price}</strong>
  </label>`).join("");
  openModal(`<section class="subscription-topup-modal">
    <header class="mp-head"><div><span>POINTS PACK</span><b>购买加量包</b><p>${context.internalTeam ? "ACG 市场部当前为无限积分，无需加购。" : "加购点数进入当前账号或团队共享额度。"}</p></div><button class="icon-btn" type="button" data-close aria-label="关闭">${icon("x", 18)}</button></header>
    <div class="subscription-topup-options">${options}</div>
    <footer class="mp-foot"><button class="btn ghost" type="button" data-close>取消</button><button class="btn primary" type="button" data-topup-confirm ${context.internalTeam ? "disabled aria-disabled=\"true\"" : ""}>${context.internalTeam ? "内部团队无需加购" : "确认加量包"}</button></footer>
  </section>`, {
    onMount(panel, close) {
      panel.classList.add("subscription-topup-panel");
      panel.querySelectorAll("input[name=\"subscriptionTopUp\"]").forEach(input => {
        input.addEventListener("change", () => {
          panel.querySelectorAll(".subscription-topup-option").forEach(option => {
            option.classList.toggle("is-selected", option.contains(input));
          });
        });
      });
      panel.querySelector("[data-topup-confirm]")?.addEventListener("click", () => {
        if (context.internalTeam) return;
        const selectedId = panel.querySelector("input[name=\"subscriptionTopUp\"]:checked")?.value;
        const selected = TOP_UP_PACKS.find(pack => pack.id === selectedId);
        if (!selected) return;
        toast(`已选择 ${selected.points} 点加量包`);
        close();
      });
    },
  });
}

function updatePlanPricing(card, plan, cycle) {
  const range = card.querySelector("[data-seat-range]");
  const seats = Number(range?.value || selectedSeatsByPlan.get(plan.id) || plan.baseSeats || 0);
  const price = card.querySelector("[data-plan-price]");
  const period = card.querySelector("[data-plan-period]");
  const note = card.querySelector("[data-plan-billing-note]");
  if (price) price.textContent = formatPrice(periodPlanPrice(plan, seats, cycle));
  if (period) period.textContent = cycle.periodLabel;
  if (note) note.textContent = billingNote(plan, seats, cycle);
}

function applyBillingCycle(root, cycle) {
  const period = root.querySelector(".subscription-period");
  period?.style.setProperty("--subscription-cycle-index", String(cycleIndex(cycle.id)));
  root.querySelectorAll("[data-billing-cycle]").forEach(button => {
    const active = button.dataset.billingCycle === cycle.id;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  root.querySelectorAll("[data-plan-card]").forEach(card => {
    const plan = PLANS.find(item => item.id === card.dataset.planCard);
    if (plan) updatePlanPricing(card, plan, cycle);
  });
  const plans = root.querySelector(".subscription-plans");
  if (!plans) return;
  plans.classList.remove("is-cycle-updating");
  requestAnimationFrame(() => {
    plans.classList.add("is-cycle-updating");
    plans.addEventListener("animationend", () => plans.classList.remove("is-cycle-updating"), { once: true });
  });
}

function bindSubscription(root) {
  const context = subscriptionContext();
  root.querySelectorAll("[data-topup-open]").forEach(button => {
    button.addEventListener("click", () => {
      if (!button.disabled) openTopUpModal();
    });
  });
  root.querySelectorAll("[data-billing-cycle]").forEach(button => {
    button.addEventListener("click", () => {
      const nextCycle = BILLING_CYCLES.find(cycle => cycle.id === button.dataset.billingCycle);
      if (!nextCycle || nextCycle.id === activeBillingCycleId) return;
      activeBillingCycleId = nextCycle.id;
      applyBillingCycle(root, nextCycle);
    });
  });

  root.querySelectorAll("[data-seat-range]").forEach(range => {
    range.addEventListener("input", () => {
      const card = range.closest("[data-plan-card]");
      const seats = Number(range.value || card?.dataset.baseSeats || 0);
      const plan = PLANS.find(item => item.id === card?.dataset.planCard);
      if (!plan) return;
      selectedSeatsByPlan.set(plan.id, seats);
      const output = card?.querySelector("[data-seat-output]");
      if (output) output.textContent = `${seats} 席位`;
      updatePlanPricing(card, plan, activeBillingCycle());
    });
  });

  if (context.planLocked) return;
  root.querySelectorAll("[data-select-plan]").forEach(button => {
    button.addEventListener("click", () => {
      const selected = PLANS.find(plan => plan.id === button.dataset.selectPlan);
      if (!selected) return;
      root.querySelectorAll("[data-plan-card]").forEach(card => {
        card.classList.toggle("is-selected", card.dataset.planCard === selected.id);
      });
      toast(`已选择${selected.name}`);
    });
  });
}

export const subscriptionView = {
  title: "订阅管理",
  render(root) {
    root.innerHTML = subscriptionMarkup();
    bindSubscription(root);
  },
};
