/* 客户端分发入口：只负责版本清单、下载引导与桌面壳刷新。
   不读写业务 store，不调用账号 / 创作 / 发布接口。 */

import { esc } from "../core/util.js";
import { icon } from "./icons.js";
import { openModal } from "./components.js?v=20260812-v1426-supplier-avatar-copy-limit-1";

const MANIFEST_URL = "/downloads/client/manifest.json";
const SAFE_DOWNLOAD_PREFIX = "/downloads/client/";

const FALLBACK_MANIFEST = Object.freeze({
  latestVersion: "0.2.0",
  releasedAt: "2026-07-27",
  platforms: {
    macos: {
      label: "macOS",
      filename: "星阵_0.2.0_universal.dmg",
      downloadUrl: "/downloads/client/0.2.0/%E6%98%9F%E9%98%B5_0.2.0_universal.dmg",
      sha256: "d9d8e9b9f0e0585aaa409b91dc5e078e1fa903dea384f0a119fd09757d06b632",
      compatibility: "Intel macOS 10.15+；Apple Silicon macOS 11+",
      signature: "ad-hoc 签名，未公证",
      installGuide: "首次打开若被系统拦截，请进入“系统设置 → 隐私与安全性”，在安全提示处点击“仍要打开”。"
    },
    windows: {
      label: "Windows",
      filename: "星阵_0.2.0_x64-setup.exe",
      downloadUrl: "/downloads/client/0.2.0/%E6%98%9F%E9%98%B5_0.2.0_x64-setup.exe",
      sha256: "2c3668c1d5e4f5c5dd49cb2374e330056203464c95cf125e1308885d7d1e477f",
      compatibility: "Windows 10 / 11 x64",
      signature: "未代码签名",
      installGuide: "若 Windows SmartScreen 提示保护电脑，请点击“更多信息”，确认发布包名称后选择“仍要运行”。"
    }
  }
});

function cleanVersion(value = "") {
  return String(value || "").trim().replace(/^v/i, "").split(/[+-]/)[0];
}

export function compareClientVersions(left = "", right = "") {
  const a = cleanVersion(left).split(".").map(value => Number.parseInt(value, 10) || 0);
  const b = cleanVersion(right).split(".").map(value => Number.parseInt(value, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

export function detectDesktopClient(source = globalThis) {
  const marker = source?.__ACG_XZ_DESKTOP__;
  if (marker && typeof marker === "object") {
    return {
      isDesktop: true,
      version: cleanVersion(marker.version || ""),
      platform: String(marker.platform || "").toLowerCase()
    };
  }
  if (source?.__ACG_XZ_DESKTOP_GUARD__ === true) {
    return { isDesktop: true, version: "", platform: "" };
  }
  return { isDesktop: false, version: "", platform: "" };
}

export function resolveClientEntryState(manifest = FALLBACK_MANIFEST, desktop = detectDesktopClient()) {
  if (!desktop.isDesktop) {
    return { action: "download", label: "客户端", title: "下载星阵客户端" };
  }
  const latest = cleanVersion(manifest?.latestVersion || "");
  if (desktop.version && latest && compareClientVersions(latest, desktop.version) > 0) {
    return { action: "update", label: "发现新版本", title: `更新客户端至 ${latest}` };
  }
  return { action: "refresh", label: "刷新平台", title: "刷新平台到最新页面" };
}

function selectedSystem(desktop = detectDesktopClient()) {
  if (desktop.platform.includes("win")) return "windows";
  if (desktop.platform.includes("mac")) return "macos";
  const platform = String(navigator.userAgentData?.platform || navigator.platform || "").toLowerCase();
  return platform.includes("win") ? "windows" : "macos";
}

function normalizeManifest(value) {
  if (!value || typeof value !== "object" || !value.platforms) return FALLBACK_MANIFEST;
  const next = structuredClone(FALLBACK_MANIFEST);
  next.latestVersion = cleanVersion(value.latestVersion || next.latestVersion);
  next.releasedAt = String(value.releasedAt || next.releasedAt);
  for (const key of ["macos", "windows"]) {
    const source = value.platforms[key];
    if (!source || typeof source !== "object") continue;
    for (const field of ["label", "filename", "sha256", "compatibility", "signature", "installGuide"]) {
      if (source[field]) next.platforms[key][field] = String(source[field]);
    }
    const url = String(source.downloadUrl || "");
    if (url.startsWith(SAFE_DOWNLOAD_PREFIX)) next.platforms[key].downloadUrl = url;
  }
  return next;
}

async function loadManifest() {
  try {
    const response = await fetch(MANIFEST_URL, { cache: "no-store" });
    if (!response.ok) return FALLBACK_MANIFEST;
    return normalizeManifest(await response.json());
  } catch {
    return FALLBACK_MANIFEST;
  }
}

function guideMarkup(manifest, system, desktop) {
  const pkg = manifest.platforms[system] || manifest.platforms.macos;
  const detected = selectedSystem(desktop) === system;
  return `
    <section class="client-guide" data-client-selected="${esc(system)}">
      <div class="client-guide-close-row">
        <button class="icon-btn ghost" type="button" data-close aria-label="关闭">${icon("x", 16)}</button>
      </div>
      <div class="client-guide-steps">
        <section class="client-guide-step">
          <i>1</i><div><b>选择系统</b><em>${detected ? `已自动识别为 ${esc(pkg.label)}` : "也可以手动切换"}</em>
            <div class="client-system-tabs" role="tablist" aria-label="客户端系统">
              <button type="button" role="tab" data-guide-os="macos" aria-selected="${system === "macos"}" class="${system === "macos" ? "is-active" : ""}">macOS</button>
              <button type="button" role="tab" data-guide-os="windows" aria-selected="${system === "windows"}" class="${system === "windows" ? "is-active" : ""}">Windows</button>
            </div>
          </div>
        </section>
        <section class="client-guide-step">
          <i>2</i><div><b>确认版本与兼容性</b><em>版本 ${esc(manifest.latestVersion)} · 发布于 ${esc(manifest.releasedAt)}</em>
            <p>${esc(pkg.compatibility)}</p>
          </div>
        </section>
        <section class="client-guide-step">
          <i>3</i><div><b>下载安装包</b><em>必须点击后才会开始下载；若失败，直接再次点击即可。</em>
            <a class="btn primary client-download-action" href="${esc(pkg.downloadUrl)}" download="${esc(pkg.filename)}" data-client-download="${esc(system)}">${icon("download", 14)} 下载 ${esc(pkg.label)} 安装包</a>
            <span class="client-download-state" role="status" aria-live="polite"></span>
          </div>
        </section>
        <section class="client-guide-step is-warning">
          <i>4</i><div><b>首次安装放行说明</b><em>${esc(pkg.signature)}，当前不是商业签名 / 公证版本。</em><p>${esc(pkg.installGuide)}</p></div>
        </section>
      </div>
    </section>`;
}

function openClientGuide(manifest, system, desktop) {
  let selected = manifest.platforms[system] ? system : selectedSystem(desktop);
  const modal = openModal(guideMarkup(manifest, selected, desktop), {
    wide: true,
    onMount(panel) {
      panel.classList.add("client-guide-panel");
      panel.addEventListener("click", event => {
        const systemButton = event.target.closest("[data-guide-os]");
        if (systemButton) {
          selected = systemButton.dataset.guideOs;
          panel.innerHTML = guideMarkup(manifest, selected, desktop);
          return;
        }
        const download = event.target.closest("[data-client-download]");
        if (!download) return;
        const status = panel.querySelector(".client-download-state");
        if (status) status.textContent = "已开始下载；若浏览器没有响应，可再次点击下载按钮。";
      });
    }
  });
  requestAnimationFrame(() => modal.el.querySelector("[data-guide-os][aria-selected='true']")?.focus());
}

export function initClientDistribution() {
  const entry = document.querySelector("#clientRailEntry");
  const button = document.querySelector("#clientRailButton");
  const label = document.querySelector("#clientRailLabel");
  if (!entry || !button || !label || entry.dataset.ready === "1") return;
  entry.dataset.ready = "1";

  const desktop = detectDesktopClient();
  let manifest = FALLBACK_MANIFEST;
  let state = resolveClientEntryState(manifest, desktop);

  const applyState = () => {
    state = resolveClientEntryState(manifest, desktop);
    entry.dataset.clientAction = state.action;
    label.textContent = state.label;
    document.querySelectorAll("[data-client-entry-label]").forEach(node => {
      node.textContent = state.label;
    });
    button.title = state.title;
    button.setAttribute("aria-haspopup", state.action === "refresh" ? "false" : "dialog");
  };
  applyState();

  entry.addEventListener("focusin", () => button.setAttribute("aria-expanded", state.action === "refresh" ? "false" : "true"));
  entry.addEventListener("focusout", event => {
    if (!entry.contains(event.relatedTarget)) button.setAttribute("aria-expanded", "false");
  });
  button.addEventListener("click", () => {
    if (state.action === "refresh") {
      location.reload();
      return;
    }
    openClientGuide(manifest, selectedSystem(desktop), desktop);
  });
  document.addEventListener("client-distribution:open", () => {
    if (state.action === "refresh") {
      location.reload();
      return;
    }
    openClientGuide(manifest, selectedSystem(desktop), desktop);
  });
  entry.querySelectorAll("[data-client-os]").forEach(systemButton => {
    systemButton.addEventListener("click", event => {
      event.stopPropagation();
      openClientGuide(manifest, systemButton.dataset.clientOs, desktop);
    });
  });

  loadManifest().then(value => {
    manifest = value;
    applyState();
  });
}
