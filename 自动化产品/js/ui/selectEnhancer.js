/* 将原生 select 保留为数据源，用统一浮层替代不同系统的原生下拉外观。 */

let active = null;

const closeMenu = () => {
  if (!active) return;
  active.trigger.setAttribute("aria-expanded", "false");
  active.menu.remove();
  active = null;
};

const labelOf = select => select.options[select.selectedIndex]?.textContent?.trim() || "请选择";

function openMenu(select, trigger) {
  if (active?.select === select) return closeMenu();
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "smart-select-menu";
  menu.setAttribute("role", "listbox");
  [...select.options].forEach(option => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "smart-select-option" + (option.selected ? " is-active" : "");
    button.textContent = option.textContent;
    button.disabled = option.disabled;
    button.setAttribute("role", "option");
    button.setAttribute("aria-selected", option.selected ? "true" : "false");
    button.addEventListener("click", () => {
      if (select.value !== option.value) {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      trigger.querySelector("span").textContent = labelOf(select);
      closeMenu();
    });
    menu.appendChild(button);
  });
  document.body.appendChild(menu);
  const rect = trigger.getBoundingClientRect();
  const width = Math.max(rect.width, 176);
  const below = innerHeight - rect.bottom > Math.min(menu.scrollHeight, 320) + 12;
  menu.style.width = `${width}px`;
  menu.style.left = `${Math.min(rect.left, innerWidth - width - 10)}px`;
  menu.style.top = below ? `${rect.bottom + 6}px` : "auto";
  menu.style.bottom = below ? "auto" : `${innerHeight - rect.top + 6}px`;
  trigger.setAttribute("aria-expanded", "true");
  active = { select, trigger, menu };
}

function enhance(select) {
  if (!(select instanceof HTMLSelectElement) || select.multiple || select.dataset.nativeSelect === "true" || select.dataset.smartSelect) return;
  select.dataset.smartSelect = "1";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "smart-select-trigger";
  trigger.innerHTML = `<span></span><i aria-hidden="true"></i>`;
  trigger.querySelector("span").textContent = labelOf(select);
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.disabled = select.disabled;
  select.classList.add("smart-select-source");
  const existingShell = select.closest(".select-shell");
  if (existingShell) {
    existingShell.classList.add("has-smart-select");
    select.insertAdjacentElement("afterend", trigger);
  } else {
    const wrapper = document.createElement("span");
    wrapper.className = `smart-select-wrap${select.classList.contains("input") ? " input" : ""}`;
    select.parentNode.insertBefore(wrapper, select);
    wrapper.append(select, trigger);
  }
  trigger.addEventListener("click", e => { e.stopPropagation(); openMenu(select, trigger); });
  select.addEventListener("change", () => { trigger.querySelector("span").textContent = labelOf(select); });
}

export function installSelectEnhancer() {
  const scan = root => {
    if (root instanceof HTMLSelectElement) enhance(root);
    root.querySelectorAll?.("select").forEach(enhance);
  };
  scan(document);
  new MutationObserver(records => records.forEach(r => r.addedNodes.forEach(n => n.nodeType === 1 && scan(n))))
    .observe(document.body, { childList: true, subtree: true });
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
  window.addEventListener("resize", closeMenu, { passive: true });
  window.addEventListener("scroll", closeMenu, { passive: true, capture: true });
}
