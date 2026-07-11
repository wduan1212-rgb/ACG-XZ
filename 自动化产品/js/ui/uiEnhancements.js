import { icon } from "./icons.js";

const RANGE_ICON_RULES = [
  { match: /speed|语速/i, left: "clock", right: "pulse" },
  { match: /volume|vol|音量|bgm|配乐|旁白|口播/i, left: "music", right: "music" },
  { match: /pitch|声调/i, left: "arrowLeft", right: "arrowRight" },
  { match: /size|字号/i, left: "type", right: "type" },
  { match: /stroke|描边/i, left: "edit", right: "edit" },
  { match: /bottom|位置/i, left: "arrowLeft", right: "arrowRight" },
  { match: /count|图数|数量/i, left: "image", right: "layers" }
];

function rangeIcons(input) {
  const context = `${input.id || ""} ${input.name || ""} ${input.closest("label")?.textContent || ""}`;
  return RANGE_ICON_RULES.find(rule => rule.match.test(context)) || { left: "arrowLeft", right: "arrowRight" };
}

function syncRange(input) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const value = Number(input.value || min);
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  input.style.setProperty("--range-percent", `${Math.max(0, Math.min(100, percent))}%`);
}

function decorateRange(input) {
  if (!(input instanceof HTMLInputElement) || input.type !== "range" || input.dataset.elasticReady === "1") return;
  input.dataset.elasticReady = "1";
  const icons = rangeIcons(input);
  const wrapper = document.createElement("span");
  wrapper.className = "elastic-range";
  wrapper.innerHTML = `<span class="elastic-range-icon is-low">${icon(icons.left, 13)}</span><span class="elastic-range-track"></span><span class="elastic-range-icon is-high">${icon(icons.right, 13)}</span>`;
  input.parentNode.insertBefore(wrapper, input);
  wrapper.querySelector(".elastic-range-track").appendChild(input);
  syncRange(input);

  const settle = () => {
    wrapper.classList.remove("is-dragging");
    wrapper.classList.add("is-settling");
    wrapper.style.setProperty("--elastic-offset", "0px");
    window.setTimeout(() => wrapper.classList.remove("is-settling"), 360);
  };

  input.addEventListener("input", () => syncRange(input));
  input.addEventListener("pointerdown", event => {
    wrapper.classList.add("is-dragging");
    input.setPointerCapture?.(event.pointerId);
  });
  input.addEventListener("pointermove", event => {
    if (!wrapper.classList.contains("is-dragging")) return;
    const rect = input.getBoundingClientRect();
    const overflow = event.clientX < rect.left ? event.clientX - rect.left : event.clientX > rect.right ? event.clientX - rect.right : 0;
    wrapper.style.setProperty("--elastic-offset", `${Math.max(-10, Math.min(10, overflow * 0.28))}px`);
  });
  ["pointerup", "pointercancel", "lostpointercapture"].forEach(type => input.addEventListener(type, settle));
}

function decorateRanges(root = document) {
  root.querySelectorAll?.('input[type="range"]').forEach(decorateRange);
}

const PILL_SELECTOR = [
  ".btn.primary", ".btn.gen", ".top-btn.top-primary", ".btn.ghost", ".chip",
  ".seg-group button", ".mode-tab", ".vl-tabs button", ".vl-mode-tabs button", ".asset-library-tabs button",
  ".supplier-filter-chips button"
].join(",");

function decoratePillButton(button) {
  if (!(button instanceof HTMLButtonElement) || button.dataset.pillReady === "1") return;
  button.dataset.pillReady = "1";
  [...button.childNodes].forEach(node => {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return;
    const label = document.createElement("span");
    label.className = "pill-label-content";
    label.textContent = node.textContent;
    button.replaceChild(label, node);
  });
}

function decoratePills(root = document) {
  if (root.matches?.(PILL_SELECTOR)) decoratePillButton(root);
  root.querySelectorAll?.(PILL_SELECTOR).forEach(decoratePillButton);
}

function installDockMotion() {
  const dock = document.querySelector(".nav-rail");
  if (!dock) return;
  const reset = () => dock.querySelectorAll(".rail-item").forEach(item => item.style.setProperty("--dock-scale", "1"));
  window.addEventListener("view:rendered", reset);
  dock.addEventListener("click", reset);
  dock.addEventListener("pointermove", event => {
    if (!document.body.classList.contains("role-supplier")) return;
    dock.querySelectorAll(".rail-item:not([hidden])").forEach(item => {
      if (getComputedStyle(item).display === "none") return;
      const rect = item.getBoundingClientRect();
      const distance = Math.abs(event.clientX - (rect.left + rect.width / 2));
      const influence = Math.max(0, 1 - distance / 110);
      item.style.setProperty("--dock-scale", String(1 + influence * 0.14));
    });
  });
  dock.addEventListener("pointerleave", reset);
}

function installViewMotion() {
  window.addEventListener("view:rendered", () => {
    const root = document.querySelector("#viewRoot");
    if (!root) return;
    root.classList.remove("view-motion-in");
    void root.offsetWidth;
    root.classList.add("view-motion-in");
  });
}

export function installUIEnhancements() {
  decorateRanges();
  decoratePills();
  const observer = new MutationObserver(entries => {
    entries.forEach(entry => entry.addedNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches?.('input[type="range"]')) decorateRange(node);
        decorateRanges(node);
        decoratePills(node);
      }
    }));
  });
  observer.observe(document.body, { childList: true, subtree: true });
  installDockMotion();
  installViewMotion();
}
