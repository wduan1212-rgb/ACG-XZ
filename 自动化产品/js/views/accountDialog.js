/* 创建 / 编辑账号对话框：平台/形式/类型/创作风格 + md 批量导入 + 角色形象 */

import { $, $$, esc, fileToDataUrl, todayStamp, wireDropZone } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, persistNow, accountById, canManageAccounts } from "../core/store.js";
import { platformCode, createAccount, updateAccount, normalizeHomepageUrl, productionAssets } from "../domain/accounts.js";
import { accountAvatarUrl, addAssetFromDataUrl, urlFor } from "../domain/assets.js";
import { AI } from "../api/ai.js?v=20260813-v1432-publish-export-1";
import { defaultTtsVoiceId, lookupTtsVoice } from "../api/providers.js";
import { findVoiceOption, voicePickerGroups } from "../domain/voices.js";
import { openModal, toast } from "../ui/components.js?v=20260813-v1432-publish-export-1";
import { go, render as routerRender } from "../core/router.js";
import * as remote from "../core/remote.js";

export function openAccountDialog(accountId = null) {
  const isSupplierManager = ["supplier", "supplier_parent"].includes(state.role);
  if (!canManageAccounts() && !isSupplierManager) {
    toast("仅管理员可创建或编辑账号", "error");
    return;
  }
  const editing = accountId ? accountById(accountId) : null;
  const draft = {
    name: editing?.name || "",
    platform: editing?.platform || "小红书",
    mode: editing?.mode || "视频",
    subType: editing?.subType || "数字人",
    styleProfile: editing?.styleProfile || "",
    homepageUrl: editing?.homepageUrl || "",
    voiceName: editing?.voiceName || "",
    voiceId: editing?.voiceId || "",
    voiceLookup: "",
    seedanceVoiceRefAssetId: editing?.voiceRefAssetId || editing?.seedanceVoiceRefAssetId || "",
    seedanceVoiceRefDataUrl: null,
    seedanceVoiceRefName: "",
    avatarDataUrl: null,
    imagePromptTemplate: editing?.imagePromptTemplate || "",
    charDataUrl: null,
    assets: [] // [{name, dataUrl}]
  };

  openModal(`<div id="adRoot"></div>`, {
    wide: true,
    onMount(panel, close) {
      panel.classList.add("account-dialog-panel");
      const root = panel.querySelector("#adRoot");

      const draw = () => {
        const previousBody = $(".ad-body", root);
        const previousScrollTop = previousBody?.scrollTop || 0;
        const previousHeight = root.getBoundingClientRect().height;
        if (previousHeight > 0) root.style.minHeight = `${Math.round(previousHeight)}px`;
        const isVideo = draft.mode === "视频";
        const isDH = isVideo;
        const avatarUrl = draft.avatarDataUrl || (editing ? accountAvatarUrl(editing) : "");
        const voiceGroups = voicePickerGroups({ selectedId: draft.voiceId, selectedName: draft.voiceName });
        const referenceAudioAssets = productionAssets(editing?.id || "__new_account__")
          .filter(a => a.type === "音频" && (a.tags || []).some(t => /参考音频库|语音素材库|音色试听|口播/i.test(t)))
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        root.innerHTML = `
          <div class="mp-head">
            <div><div class="eyebrow">${editing ? "编辑账号" : "创建账号"}</div><b style="font-size:16px">${editing ? esc(editing.name) : "新建内容账号"}</b></div>
            <button class="icon-btn" data-close>${icon("x", 16)}</button>
          </div>
          <div class="ad-body">
            ${editing || isSupplierManager ? "" : `
            <div class="ad-batch" id="adBatch">
              <div class="adb-drop-core">${icon("fileText", 20)}</div>
              <div class="adb-drop-text">
                <b>批量建号 · 拖入 md 文档</b>
                <em>一个账号一段（名称 / 平台 / 形式 / 类型 / 风格 / 标签），AI 自动识别 · 或点击选择</em>
              </div>
              <input type="file" accept=".md,.txt,.markdown" hidden id="adImportMd" />
            </div>
            <div class="ad-or"><span>或手动新建一个</span></div>`}
            <div class="ad-grid">
              <label class="field">账号名称<input class="input" id="adName" value="${esc(draft.name)}" placeholder="例如：百度搭子图文教程 02" /></label>
              <label class="field ad-choice-field">平台 <em class="ad-choice-guidance">选择内容实际发布的平台</em>
                <div class="seg-group ad-choice-group" id="adPlat" role="group" aria-label="选择发布平台">
                  ${[
                    ["视频号", "面向视频号的发布与交付规格"],
                    ["小红书", "面向小红书的笔记、封面与发布规格"]
                  ].map(([v, help]) => `<button type="button" class="ad-choice-button ${draft.platform === v ? "is-active" : ""}" data-v="${v}" data-choice-help="${help}" aria-pressed="${draft.platform === v ? "true" : "false"}" aria-label="${v}：${help}"><i class="seg-dot ${platformCode(v).toLowerCase()}"></i><span>${v}</span></button>`).join("")}
                </div>
              </label>
              <label class="field ad-choice-field">内容形式 <em class="ad-choice-guidance">决定该账号进入的创作链路</em>
                <div class="seg-group ad-choice-group" id="adMode" role="group" aria-label="选择内容形式">
                  ${[
                    ["视频", "film", "使用分镜、口播、剪辑与成片交付链路"],
                    ["图文", "image", "使用标题、文案、逐图生成与笔记交付链路"]
                  ].map(([v, ic, help]) => `<button type="button" class="ad-choice-button ${draft.mode === v ? "is-active" : ""}" data-v="${v}" data-choice-help="${help}" aria-pressed="${draft.mode === v ? "true" : "false"}" aria-label="${v}：${help}">${icon(ic, 14)}<span>${v}</span></button>`).join("")}
                </div>
              </label>
              ${isVideo ? `<div class="field ad-choice-field"><span>视频创作能力</span><em class="ad-choice-guidance">该视频号可在批量任务中自由选择“数字人”或“创意视频”，账号本身不再绑定单一链路。</em></div>` : ""}
              ${!isSupplierManager ? `<label class="field full">创作风格 <em class="muted" style="font-weight:500">账号自带的固定风格：量产/随机主题时自动使用，不必每次填</em>
                <input class="input" id="adStyle" value="${esc(draft.styleProfile)}" placeholder="例如：白底极简种草风 / 口播犀利有梗 / 深度测评冷静叙事" /></label>
              ` : ""}
              <label class="field full">账号主页链接 <em class="muted" style="font-weight:500">创作端与供应商端共享同一链接</em>
                <div class="ad-homepage-row"><input class="input" id="adHomepageUrl" value="${esc(draft.homepageUrl)}" placeholder="https://..." /><button class="btn ghost sm" type="button" id="adHomepageView">${icon("link", 13)} 查看主页</button></div>
              </label>
              <div class="field full">
                <span>账号头像 <em class="muted">管理员可维护，可点击或拖图替换</em></span>
                <label class="ad-image-drop avatar ${avatarUrl ? "has-image" : ""}" id="adAvatarDrop">
                  <span class="ad-avatar-preview">
                    ${avatarUrl ? `<img src="${avatarUrl}" alt="账号头像" />` : `<i class="account-avatar-fallback">${icon("user", 18)}</i>`}
                    ${avatarUrl ? `<i class="ad-avatar-ready" aria-label="头像已选择">${icon("check", 10)}</i>` : ""}
                  </span>
                  <span class="ad-avatar-copy">
                    <b>${avatarUrl ? "已选择头像 · 点击或拖入替换" : "拖入 / 上传头像"}</b>
                    <em>${avatarUrl ? "保存修改后同步到创作与交付页" : "支持 PNG、JPG、WebP 或 GIF"}</em>
                  </span>
                  <input type="file" accept="image/*" hidden id="adAvatarUp" />
                </label>
              </div>
              ${draft.mode === "图文" && !isSupplierManager ? `
              <label class="field full">图文提示词模板 <em class="muted" style="font-weight:500">站内逐图提示词会优先参考；产品名、主题、各图内容会按本次创作自动替换</em>
                <textarea class="input" id="adImgTpl" rows="8" placeholder="粘贴你的图文模板提示词，例如：请独立分别生成6张独立图片……">${esc(draft.imagePromptTemplate)}</textarea>
              </label>` : ""}
              ${isVideo && !isSupplierManager ? `
              <div class="field full ad-voice-config">
                <span>${isDH ? "固定口播声线" : "口播声线"}</span>
                <div class="ad-voice-row">
                  <select class="input" id="adVoicePreset">
                    <option value="">默认平台声线${defaultTtsVoiceId() ? `（${esc(defaultTtsVoiceId())}）` : ""}</option>
                    ${voiceGroups.map(g => `<optgroup label="${esc(g.title)}">${(g.items || []).filter(v => v.voiceId).map(v => `<option value="${esc(v.voiceId)}" ${draft.voiceId === v.voiceId ? "selected" : ""}>${esc(v.name)} · ${esc(v.voiceId)}</option>`).join("")}</optgroup>`).join("")}
                  </select>
                  <div class="input-with-action">
                    <input class="input" id="adVoiceId" value="${esc(draft.voiceId)}" placeholder="识别已有 voice_id" />
                    <button type="button" class="btn ghost sm" id="adVoiceLookup">${icon("search", 13)} 识别</button>
                  </div>
                </div>
                ${draft.voiceLookup ? `<em class="voice-lookup-note">${esc(draft.voiceLookup)}</em>` : ""}
              </div>
              <div class="field full ad-reference-audio">
                <span>Seedance 总参考音频 <em class="muted">每一段视频共用同一条音色参考</em></span>
                <div class="ad-reference-audio-row">
                  <select class="input" id="adReferenceAudio">
                    <option value="">不使用参考音频</option>
                    ${referenceAudioAssets.map(a => `<option value="${esc(a.id)}" ${draft.seedanceVoiceRefAssetId === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
                  </select>
                  <label class="btn ghost sm">${icon("upload", 13)} 拖入总参考音频<input type="file" accept="audio/*" hidden id="adReferenceAudioUp" /></label>
                </div>
                ${draft.seedanceVoiceRefName ? `<em class="voice-lookup-note">待加入总参考音频库：${esc(draft.seedanceVoiceRefName)}</em>` : ""}
              </div>
              ` : ""}
            </div>

            ${isDH && !isSupplierManager ? `
            <div class="ad-block">
              <div class="adb-head"><b>数字人角色版</b><em class="muted">拖入账号角色图；只用于锁定该数字人的固定人物形象</em></div>
              <div class="ad-char-row">
                <label class="btn ghost sm ad-char-drop" id="adCharDrop">${draft.charDataUrl || (editing && editing.charBoardAssetId) ? "✓ 已有角色形象 · 点击更换 / 可拖图" : "+ 上传角色形象 / 可拖图"}<input type="file" accept="image/*" hidden id="adCharUp" /></label>
                ${draft.charDataUrl ? `<img class="ad-char-prev" src="${draft.charDataUrl}"/>` : ""}
              </div>
            </div>` : ""}

            ${!isSupplierManager ? `<div class="ad-block">
              <div class="adb-head"><b>账号图片资产</b><em class="muted">创建即绑定，生成时可 @ 调用</em>
                <label class="btn ghost sm">+ 添加图片<input type="file" accept="image/*" multiple hidden id="adAssets" /></label>
              </div>
              <div class="ad-asset-grid" id="adAssetGrid">${draft.assets.map((a, i) => `<div class="ad-thumb"><img src="${a.dataUrl}"/><button class="ref-x" data-ax="${i}">${icon("x", 10)}</button></div>`).join("")}</div>
            </div>` : ""}

            <div class="ad-naming">素材命名规则：<b>${platformCode(draft.platform)}-${esc((draft.name || "账号名").replace(/\s+/g, ""))}-${draft.mode === "视频" ? "视频" : "图文"}-001-${todayStamp()}</b></div>
          </div>
          <div class="mp-foot">
            <button class="btn ghost account-dialog-cancel" data-close>取消</button>
            <button class="btn primary" id="adConfirm">${editing ? "保存修改" : "创建并进入创作空间"}</button>
          </div>`;
        wire();
        const nextBody = $(".ad-body", root);
        if (nextBody) nextBody.scrollTop = previousScrollTop;
        requestAnimationFrame(() => { root.style.minHeight = ""; });
      };

      const wire = () => {
        $("#adName", root).addEventListener("input", e => { draft.name = e.target.value; refreshNaming(); });
        $("#adStyle", root)?.addEventListener("input", e => { draft.styleProfile = e.target.value; });
        $("#adHomepageUrl", root)?.addEventListener("input", e => { draft.homepageUrl = e.target.value; });
        $("#adHomepageView", root)?.addEventListener("click", () => {
          try {
            const url = normalizeHomepageUrl($("#adHomepageUrl", root)?.value || draft.homepageUrl);
            if (!url) { toast("请先填写主页链接"); return; }
            window.open(url, "_blank", "noopener,noreferrer");
          } catch (err) { toast(err.message || "主页链接格式不正确", "error"); }
        });
        const imgTpl = $("#adImgTpl", root);
        if (imgTpl) imgTpl.addEventListener("input", e => { draft.imagePromptTemplate = e.target.value; });
        const voiceId = $("#adVoiceId", root);
        if (voiceId) voiceId.addEventListener("input", e => { draft.voiceId = e.target.value; draft.voiceLookup = ""; });
        const voiceLookup = $("#adVoiceLookup", root);
        if (voiceLookup) voiceLookup.addEventListener("click", async () => {
          const id = ($("#adVoiceId", root)?.value || "").trim();
          if (!id) { toast("请先填写 voice_id"); return; }
          voiceLookup.disabled = true;
          voiceLookup.textContent = "识别中…";
          try {
            const res = await lookupTtsVoice(id, { test: true });
            draft.voiceId = id;
            if (res.name) {
              draft.voiceName = res.name;
            }
            const usedBy = (res.accounts || []).map(x => x.account).filter(Boolean).slice(0, 3).join("、");
            const local = res.name ? `识别为：${res.name}${usedBy ? `（用于 ${usedBy}${(res.accounts || []).length > 3 ? " 等账号" : ""}）` : ""}` : "本地未命名，按自定义声线 ID 保存";
            const remote = res.valid === true ? "上游测试有效" : res.valid === false ? "上游返回无效" : (res.configured ? "上游未能确认" : "本地未配置 TTS，暂未上游测试");
            draft.voiceLookup = `${local} · ${remote}${res.detail ? `：${res.detail.slice(0, 120)}` : ""}`;
            draw();
          } catch (err) {
            draft.voiceLookup = err.message || "声线识别失败";
            draw();
          }
        });
        const voicePreset = $("#adVoicePreset", root);
        if (voicePreset) voicePreset.addEventListener("change", e => {
          const id = e.target.value || "";
          const preset = id ? findVoiceOption(id) : null;
          draft.voiceId = id;
          draft.voiceName = preset?.name || draft.voiceName || "";
          const idInput = $("#adVoiceId", root);
          if (idInput) idInput.value = id;
        });
        $("#adReferenceAudio", root)?.addEventListener("change", e => {
          draft.seedanceVoiceRefAssetId = e.currentTarget.value || "";
          draft.seedanceVoiceRefDataUrl = null;
          draft.seedanceVoiceRefName = "";
        });
        const setReferenceAudio = async file => {
          if (!file || !file.type.startsWith("audio/")) { toast("请拖入音频文件", "error"); return; }
          draft.seedanceVoiceRefDataUrl = await fileToDataUrl(file);
          draft.seedanceVoiceRefName = file.name.replace(/\.[^.]+$/, "");
          draft.seedanceVoiceRefAssetId = "";
          draw();
          toast("已准备加入总参考音频库");
        };
        const referenceAudioUp = $("#adReferenceAudioUp", root);
        if (referenceAudioUp) {
          referenceAudioUp.addEventListener("change", e => setReferenceAudio(e.target.files[0]));
          const label = referenceAudioUp.closest("label");
          wireDropZone(label, files => setReferenceAudio(Array.from(files).find(f => f.type.startsWith("audio/"))), { filesOnly: true });
        }
        const segWire = (sel, key, redraw = false) => {
          const box = $(sel, root); if (!box) return;
          box.addEventListener("click", e => {
            const b = e.target.closest("button[data-v]"); if (!b) return;
            draft[key] = b.dataset.v;
            if (redraw) {
              draw();
              requestAnimationFrame(() => $$(sel + " button", root).find(x => x.dataset.v === draft[key])?.focus());
              return;
            }
            $$(sel + " button", root).forEach(x => {
              const selected = x.dataset.v === draft[key];
              x.classList.toggle("is-active", selected);
              x.setAttribute("aria-pressed", selected ? "true" : "false");
            });
            refreshNaming();
          });
        };
        segWire("#adPlat", "platform");
        segWire("#adMode", "mode", true);
        segWire("#adSub", "subType", true);
        function refreshNaming() {
          const el = root.querySelector(".ad-naming");
          if (el) el.innerHTML = `素材命名规则：<b>${platformCode(draft.platform)}-${esc((draft.name || "账号名").replace(/\s+/g, ""))}-${draft.mode === "视频" ? "视频" : "图文"}-001-${todayStamp()}</b>`;
        }

        async function setCharBoard(file, msg = "已选择角色形象") {
          if (!file || !file.type.startsWith("image/")) return;
          draft.charDataUrl = await fileToDataUrl(file);
          draw();
          toast(msg);
        }
        async function setAvatar(file) {
          if (!file) return;
          if (!file.type.startsWith("image/")) { toast("请选择图片文件", "error"); return; }
          draft.avatarDataUrl = await fileToDataUrl(file);
          draw();
          requestAnimationFrame(() => $("#adAvatarDrop", root)?.classList.add("has-selection-feedback"));
          toast("头像已选择，保存修改后生效");
        }
        const avatarUp = $("#adAvatarUp", root);
        if (avatarUp) avatarUp.addEventListener("change", e => setAvatar(e.target.files[0]));
        const avatarDrop = $("#adAvatarDrop", root);
        if (avatarDrop) {
          avatarDrop.addEventListener("click", event => {
            if (event.target === avatarUp) return;
            event.preventDefault();
            avatarUp?.click();
          });
          wireDropZone(avatarDrop, files => setAvatar(Array.from(files).find(f => f.type.startsWith("image/"))), { filesOnly: true });
        }
        const charUp = $("#adCharUp", root);
        if (charUp) charUp.addEventListener("change", e => setCharBoard(e.target.files[0]));
        const charDrop = $("#adCharDrop", root);
        if (charDrop) wireDropZone(charDrop, files => setCharBoard(Array.from(files).find(f => f.type.startsWith("image/")), "已拖入角色形象"), { filesOnly: true });

        $("#adAssets", root)?.addEventListener("change", async e => {
          for (const f of Array.from(e.target.files)) draft.assets.push({ name: f.name.replace(/\.[^.]+$/, ""), dataUrl: await fileToDataUrl(f) });
          draw();
        });
        $$("[data-ax]", root).forEach(b => b.addEventListener("click", () => { draft.assets.splice(+b.dataset.ax, 1); draw(); }));

        async function importMd(file) {
          if (!file) return;
          toast("AI 解析 md 中…");
          let accs = [];
          try { accs = await AI.parseAccountsMd(await file.text()); } catch (err) { toast("读取文件失败"); return; }
          if (!accs.length) { toast("没有识别到账号信息，检查 md 格式"); return; }
          let created = 0;
          accs.forEach(x => {
            if (!x.name || state.accounts.some(a => a.name === x.name)) return;
            createAccount(x); created++;
          });
          close();
          toast(`已批量创建 ${created} 个账号${accs.length - created ? `（${accs.length - created} 个重名跳过）` : ""}`);
          routerRender();
        }
        const batchZone = $("#adBatch", root);
        if (batchZone) {
          batchZone.addEventListener("click", () => $("#adImportMd", root).click());
          $("#adImportMd", root).addEventListener("change", e => importMd(e.target.files[0]));
          ["dragenter", "dragover"].forEach(ev => batchZone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); batchZone.classList.add("drag-over"); }));
          ["dragleave", "drop"].forEach(ev => batchZone.addEventListener(ev, e => { e.preventDefault(); e.stopPropagation(); batchZone.classList.remove("drag-over"); }));
          batchZone.addEventListener("drop", e => { if (e.dataTransfer.files[0]) importMd(e.dataTransfer.files[0]); });
        }

        $("#adConfirm", root).addEventListener("click", async () => {
          const confirmButton = $("#adConfirm", root);
          const name = draft.name.trim();
          if (!name) { toast("请填写账号名称"); return; }
          let homepageUrl = "";
          try { homepageUrl = normalizeHomepageUrl(draft.homepageUrl); }
          catch (err) { toast(err.message || "主页链接格式不正确", "error"); return; }
          const isDH = draft.mode === "视频";
          const accountSnapshot = editing ? JSON.parse(JSON.stringify(editing)) : null;
          const beforeAssetIds = new Set(state.assets.map(asset => asset.id));
          // 供应商账号走专用 API。先拦住通用集合的延迟回写，避免它在专用请求
          // 成功后又以旧快照触发一次无权限的 /api/db/accounts 请求。
          const releaseSupplierCollectionSync = isSupplierManager && remote.isOn()
            ? remote.holdCollectionSync(["accounts", "assets"])
            : null;
          confirmButton.disabled = true;
          confirmButton.textContent = editing ? "正在保存…" : "正在创建…";
          let acc = null;
          try {
            let seedanceVoiceRefAssetId = draft.seedanceVoiceRefAssetId || "";
            if (draft.seedanceVoiceRefDataUrl) {
              const ref = await addAssetFromDataUrl(null, {
                name: draft.seedanceVoiceRefName || `${name} 参考音频`,
                type: "音频",
                tags: ["参考音频库", "声线参考"],
                dataUrl: draft.seedanceVoiceRefDataUrl
              });
              seedanceVoiceRefAssetId = ref.id;
            }
            const patch = {
              name, platform: draft.platform, mode: draft.mode,
              // 保留旧字段供历史任务读取；新任务的数字人/创意视频模式在任务板选择。
              subType: draft.mode === "图文" ? "" : (editing?.subType || "数字人"),
              position: "", styleProfile: isSupplierManager ? (editing?.styleProfile || "") : draft.styleProfile.trim(),
              styleEditedAt: isSupplierManager ? (editing?.styleEditedAt || Date.now()) : Date.now(), voiceName: isSupplierManager ? (editing?.voiceName || "") : draft.voiceName.trim(),
              voiceId: isSupplierManager ? (editing?.voiceId || "") : draft.voiceId.trim(),
              voiceRefAssetId: isSupplierManager ? (editing?.voiceRefAssetId || editing?.seedanceVoiceRefAssetId || null) : (seedanceVoiceRefAssetId || null),
              imagePromptTemplate: isSupplierManager ? (editing?.imagePromptTemplate || "") : draft.imagePromptTemplate.trim(), homepageUrl,
              status: editing?.status === "disabled" ? "disabled" : "active",
            };
            acc = editing ? updateAccount(editing.id, patch) : createAccount(patch);
            if (draft.avatarDataUrl) {
              const aa = await addAssetFromDataUrl(acc.id, {
                name: name + " 账号头像",
                tags: ["头像"],
                dataUrl: draft.avatarDataUrl,
                deferRemoteDocument: isSupplierManager && remote.isOn(),
              });
              acc.avatarAssetId = aa.id;
            }
            if (draft.charDataUrl && draft.mode === "视频") {
              const ca = await addAssetFromDataUrl(acc.id, { name: name + " 角色形象", tags: ["角色形象", "角色版"], dataUrl: draft.charDataUrl });
              acc.charBoardAssetId = ca.id;
            }
            if (!isSupplierManager) for (const a of draft.assets) {
              await addAssetFromDataUrl(acc.id, { name: a.name, tags: [], dataUrl: a.dataUrl });
            }
            save("accounts");
            if (isSupplierManager && remote.isOn()) {
              const newAssets = state.assets.filter(asset => !beforeAssetIds.has(asset.id));
              const result = editing
                ? await remote.supplier.updateAccount(acc.id, acc, newAssets)
                : await remote.supplier.createAccount(acc, newAssets);
              Object.assign(acc, result.account || {});
              (result.assets || []).forEach(serverAsset => {
                const local = state.assets.find(asset => asset.id === serverAsset.id);
                if (local) Object.assign(local, serverAsset);
              });
              save("accounts", "assets");
            }
            // 把本地快照落盘时仍保持同步拦截；供应商端的数据已经由上面的
            // 显式 API 确认，不能再走通用集合写入。
            if (releaseSupplierCollectionSync) await persistNow();
            state.ui.activeAccountId = acc.id;
            save("meta");
            close();
            toast(`账号「${name}」${editing ? "已更新" : "已创建"}`);
            if (!isSupplierManager) go("studio");
            routerRender();
          } catch (error) {
            if (editing && accountSnapshot) Object.assign(editing, accountSnapshot);
            if (!editing && acc) state.accounts = state.accounts.filter(item => item.id !== acc.id);
            state.assets = state.assets.filter(asset => beforeAssetIds.has(asset.id));
            save("accounts", "assets");
            if (releaseSupplierCollectionSync) await persistNow();
            confirmButton.disabled = false;
            confirmButton.textContent = editing ? "保存修改" : "创建并进入创作空间";
            toast(error?.message || "账号保存失败", "error");
          } finally {
            // 专用 API 已负责服务器同步；释放时丢弃被拦截的通用整集合快照，
            // 以免覆盖其它账号或制造一次无权限写入。
            releaseSupplierCollectionSync?.({ flush: false });
          }
        });
      };

      draw();
    }
  });
}

/* 全局开口：团队管理员与供应商管理员共用同一完整账号编辑器。 */
document.addEventListener("open-account-dialog", e => {
  if (!canManageAccounts() && !["supplier", "supplier_parent"].includes(state.role)) { toast("只有团队管理员可以创建 / 编辑账号"); return; }
  openAccountDialog(e.detail?.accountId || null);
});
