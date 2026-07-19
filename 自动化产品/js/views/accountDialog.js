/* 创建 / 编辑账号对话框：平台/形式/类型/创作风格 + md 批量导入 + 角色形象 */

import { $, $$, esc, fileToDataUrl, todayStamp, wireDropZone } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById } from "../core/store.js";
import { platformCode, createAccount, updateAccount, normalizeHomepageUrl, productionAssets } from "../domain/accounts.js";
import { addAssetFromDataUrl, urlFor } from "../domain/assets.js";
import { AI } from "../api/ai.js?v=20260718-v94-1";
import { defaultTtsVoiceId, lookupTtsVoice } from "../api/providers.js";
import { findVoiceOption, voicePickerGroups } from "../domain/voices.js";
import { openModal, toast } from "../ui/components.js";
import { go, render as routerRender } from "../core/router.js";

export function openAccountDialog(accountId = null) {
  if (state.role !== "admin") {
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
        const isDH = isVideo && draft.subType === "数字人";
        const avatarUrl = draft.avatarDataUrl || (editing?.avatarAssetId ? urlFor(editing.avatarAssetId) : "");
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
            ${editing ? "" : `
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
              <label class="field">平台
                <div class="seg-group" id="adPlat">
                  ${["视频号", "小红书"].map(v => `<button type="button" class="${draft.platform === v ? "is-active" : ""}" data-v="${v}"><i class="seg-dot ${platformCode(v).toLowerCase()}"></i>${v}</button>`).join("")}
                </div>
              </label>
              <label class="field">内容形式
                <div class="seg-group" id="adMode">
                  ${[["视频", "film"], ["图文", "image"]].map(([v, ic]) => `<button type="button" class="${draft.mode === v ? "is-active" : ""}" data-v="${v}">${icon(ic, 14)}${v}</button>`).join("")}
                </div>
              </label>
              ${isVideo ? `<label class="field">视频类型
                <div class="seg-group" id="adSub">
                  <button type="button" class="${draft.subType === "数字人" ? "is-active" : ""}" data-v="数字人">${icon("user", 14)}数字人<span class="seg-sub">固定出镜口播</span></button>
                  <button type="button" class="${draft.subType === "无数字人" ? "is-active" : ""}" data-v="无数字人">${icon("layers", 14)}无数字人<span class="seg-sub">场景/界面混剪</span></button>
                </div>
              </label>` : ""}
              <label class="field full">创作风格 <em class="muted" style="font-weight:500">账号自带的固定风格：量产/随机主题时自动使用，不必每次填</em>
                <input class="input" id="adStyle" value="${esc(draft.styleProfile)}" placeholder="例如：白底极简种草风 / 口播犀利有梗 / 深度测评冷静叙事" /></label>
              <label class="field full">账号主页链接 <em class="muted" style="font-weight:500">创作端与供应商端共享同一链接</em>
                <div class="ad-homepage-row"><input class="input" id="adHomepageUrl" value="${esc(draft.homepageUrl)}" placeholder="https://..." /><button class="btn ghost sm" type="button" id="adHomepageView">${icon("link", 13)} 查看主页</button></div>
              </label>
              <div class="field full">
                <span>账号头像 <em class="muted">仅管理员可维护，可点击或拖图替换</em></span>
                <label class="ad-image-drop avatar" id="adAvatarDrop">
                  ${avatarUrl ? `<img src="${avatarUrl}" alt="账号头像" />` : `<i class="account-avatar-fallback">${icon("user", 18)}</i>`}
                  <b>拖入 / 上传头像</b>
                  <input type="file" accept="image/*" hidden id="adAvatarUp" />
                </label>
              </div>
              ${draft.mode === "图文" ? `
              <label class="field full">图文提示词模板 <em class="muted" style="font-weight:500">站内逐图提示词会优先参考；产品名、主题、各图内容会按本次创作自动替换</em>
                <textarea class="input" id="adImgTpl" rows="8" placeholder="粘贴你的图文模板提示词，例如：请独立分别生成6张独立图片……">${esc(draft.imagePromptTemplate)}</textarea>
              </label>` : ""}
              ${isVideo ? `
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
              ${!isDH ? `<div class="field full ad-reference-audio">
                <span>Seedance 总参考音频 <em class="muted">每一段视频共用同一条音色参考</em></span>
                <div class="ad-reference-audio-row">
                  <select class="input" id="adReferenceAudio">
                    <option value="">不使用参考音频</option>
                    ${referenceAudioAssets.map(a => `<option value="${esc(a.id)}" ${draft.seedanceVoiceRefAssetId === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
                  </select>
                  <label class="btn ghost sm">${icon("upload", 13)} 拖入总参考音频<input type="file" accept="audio/*" hidden id="adReferenceAudioUp" /></label>
                </div>
                ${draft.seedanceVoiceRefName ? `<em class="voice-lookup-note">待加入总参考音频库：${esc(draft.seedanceVoiceRefName)}</em>` : ""}
              </div>` : ""}
              ` : ""}
            </div>

            ${isDH ? `
            <div class="ad-block">
              <div class="adb-head"><b>数字人角色版</b><em class="muted">拖入账号角色图；只用于锁定该数字人的固定人物形象</em></div>
              <div class="ad-char-row">
                <label class="btn ghost sm ad-char-drop" id="adCharDrop">${draft.charDataUrl || (editing && editing.charBoardAssetId) ? "✓ 已有角色形象 · 点击更换 / 可拖图" : "+ 上传角色形象 / 可拖图"}<input type="file" accept="image/*" hidden id="adCharUp" /></label>
                ${draft.charDataUrl ? `<img class="ad-char-prev" src="${draft.charDataUrl}"/>` : ""}
              </div>
            </div>` : ""}

            <div class="ad-block">
              <div class="adb-head"><b>账号图片资产</b><em class="muted">创建即绑定，生成时可 @ 调用</em>
                <label class="btn ghost sm">+ 添加图片<input type="file" accept="image/*" multiple hidden id="adAssets" /></label>
              </div>
              <div class="ad-asset-grid" id="adAssetGrid">${draft.assets.map((a, i) => `<div class="ad-thumb"><img src="${a.dataUrl}"/><button class="ref-x" data-ax="${i}">${icon("x", 10)}</button></div>`).join("")}</div>
            </div>

            <div class="ad-naming">素材命名规则：<b>${platformCode(draft.platform)}-${esc((draft.name || "账号名").replace(/\s+/g, ""))}-${draft.mode === "视频" ? esc(draft.subType) : "图文"}-001-${todayStamp()}</b></div>
          </div>
          <div class="mp-foot">
            <button class="btn ghost" data-close>取消</button>
            <button class="btn primary" id="adConfirm">${editing ? "保存修改" : "创建并进入创作空间"}</button>
          </div>`;
        wire();
        const nextBody = $(".ad-body", root);
        if (nextBody) nextBody.scrollTop = previousScrollTop;
        requestAnimationFrame(() => { root.style.minHeight = ""; });
      };

      const wire = () => {
        $("#adName", root).addEventListener("input", e => { draft.name = e.target.value; refreshNaming(); });
        $("#adStyle", root).addEventListener("input", e => { draft.styleProfile = e.target.value; });
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
            redraw ? draw() : ($$(sel + " button", root).forEach(x => x.classList.toggle("is-active", x.dataset.v === draft[key])), refreshNaming());
          });
        };
        segWire("#adPlat", "platform");
        segWire("#adMode", "mode", true);
        segWire("#adSub", "subType", true);
        function refreshNaming() {
          const el = root.querySelector(".ad-naming");
          if (el) el.innerHTML = `素材命名规则：<b>${platformCode(draft.platform)}-${esc((draft.name || "账号名").replace(/\s+/g, ""))}-${draft.mode === "视频" ? esc(draft.subType) : "图文"}-001-${todayStamp()}</b>`;
        }

        async function setCharBoard(file, msg = "已选择角色形象") {
          if (!file || !file.type.startsWith("image/")) return;
          draft.charDataUrl = await fileToDataUrl(file);
          draw();
          toast(msg);
        }
        async function setAvatar(file) {
          if (!file || !file.type.startsWith("image/")) return;
          draft.avatarDataUrl = await fileToDataUrl(file);
          draw();
          toast("已选择账号头像");
        }
        const avatarUp = $("#adAvatarUp", root);
        if (avatarUp) avatarUp.addEventListener("change", e => setAvatar(e.target.files[0]));
        const avatarDrop = $("#adAvatarDrop", root);
        if (avatarDrop) {
          avatarDrop.addEventListener("click", () => $("#adAvatarUp", root)?.click());
          wireDropZone(avatarDrop, files => setAvatar(Array.from(files).find(f => f.type.startsWith("image/"))), { filesOnly: true });
        }
        const charUp = $("#adCharUp", root);
        if (charUp) charUp.addEventListener("change", e => setCharBoard(e.target.files[0]));
        wireDropZone($("#adCharDrop", root), files => setCharBoard(Array.from(files).find(f => f.type.startsWith("image/")), "已拖入角色形象"), { filesOnly: true });

        $("#adAssets", root).addEventListener("change", async e => {
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
          const name = draft.name.trim();
          if (!name) { toast("请填写账号名称"); return; }
          let homepageUrl = "";
          try { homepageUrl = normalizeHomepageUrl(draft.homepageUrl); }
          catch (err) { toast(err.message || "主页链接格式不正确", "error"); return; }
          const isDH = draft.mode === "视频" && draft.subType === "数字人";
          if (isDH && !editing && !draft.charDataUrl) { toast("数字人账号请先上传角色形象"); return; }

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
          let acc;
          if (editing) {
            acc = updateAccount(editing.id, {
              name, platform: draft.platform, mode: draft.mode,
              subType: draft.mode === "图文" ? "" : draft.subType,
              position: "",
              styleProfile: draft.styleProfile.trim(),
              styleEditedAt: Date.now(),
              voiceName: draft.voiceName.trim(),
              voiceId: draft.voiceId.trim(),
              voiceRefAssetId: draft.subType === "无数字人" ? seedanceVoiceRefAssetId : null,
              imagePromptTemplate: draft.imagePromptTemplate.trim(),
              homepageUrl,
            });
          } else {
            acc = createAccount({
              name, platform: draft.platform, mode: draft.mode, subType: draft.subType,
              position: "", styleProfile: draft.styleProfile.trim(),
              styleEditedAt: Date.now(),
              voiceName: draft.voiceName.trim(), voiceId: draft.voiceId.trim(),
              voiceRefAssetId: draft.subType === "无数字人" ? seedanceVoiceRefAssetId : null,
              imagePromptTemplate: draft.imagePromptTemplate.trim(),
              homepageUrl,
            });
          }
          if (draft.avatarDataUrl) {
            const aa = await addAssetFromDataUrl(acc.id, { name: name + " 账号头像", tags: ["头像"], dataUrl: draft.avatarDataUrl });
            acc.avatarAssetId = aa.id;
            save("accounts");
          }
          if (draft.charDataUrl && draft.mode === "视频" && draft.subType === "数字人") {
            const ca = await addAssetFromDataUrl(acc.id, { name: name + " 角色形象", tags: ["角色形象", "角色版"], dataUrl: draft.charDataUrl });
            acc.charBoardAssetId = ca.id;
          }
          for (const a of draft.assets) await addAssetFromDataUrl(acc.id, { name: a.name, tags: [], dataUrl: a.dataUrl });
          save("accounts");
          state.ui.activeAccountId = acc.id;
          save("meta");
          close();
          toast(`账号「${name}」${editing ? "已更新" : "已创建"}`);
          go("studio");
          routerRender();
        });
      };

      draw();
    }
  });
}

/* 全局开口：任何视图 dispatch open-account-dialog 即可唤起（仅管理员） */
document.addEventListener("open-account-dialog", e => {
  if (state.role !== "admin") { toast("只有管理员可以创建 / 编辑账号"); return; }
  openAccountDialog(e.detail?.accountId || null);
});
