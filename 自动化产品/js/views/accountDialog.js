/* 创建 / 编辑账号对话框：平台/形式/类型/定位/标签 + md 批量导入 + 数字人身份板（AI 提示词流） */

import { $, $$, esc, copyText, fileToDataUrl, todayStamp, wireDropZone } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById } from "../core/store.js";
import { platformCode, createAccount, updateAccount } from "../domain/accounts.js";
import { addAssetFromDataUrl, addAssetFromFile, urlFor } from "../domain/assets.js";
import { AI } from "../api/ai.js";
import { CHAR_DIR_POOL, buildCharBoardPrompt } from "../api/prompts.js";
import { defaultTtsVoiceId, ttsVoicePresets } from "../api/providers.js";
import { openModal, toast } from "../ui/components.js";
import { go, render as routerRender } from "../core/router.js";

export function openAccountDialog(accountId = null) {
  const editing = accountId ? accountById(accountId) : null;
  const draft = {
    name: editing?.name || "",
    platform: editing?.platform || "小红书",
    mode: editing?.mode || "视频",
    subType: editing?.subType || "数字人",
    position: editing && editing.position !== "（待补充定位）" ? editing.position : "",
    styleProfile: editing?.styleProfile || "",
    voiceName: editing?.voiceName || "",
    voiceId: editing?.voiceId || "",
    voiceFile: null,
    avatarDataUrl: null,
    styleRefDataUrl: null,
    imagePromptTemplate: editing?.imagePromptTemplate || "",
    qtags: new Set(editing?.qtags || []),
    charDataUrl: null,
    assets: [] // [{name, dataUrl}]
  };

  openModal(`<div id="adRoot"></div>`, {
    wide: true,
    onMount(panel, close) {
      const root = panel.querySelector("#adRoot");

      const draw = () => {
        const isVideo = draft.mode === "视频";
        const isDH = isVideo && draft.subType === "数字人";
        const avatarUrl = draft.avatarDataUrl || (editing?.avatarAssetId ? urlFor(editing.avatarAssetId) : "");
        const styleRefUrl = draft.styleRefDataUrl || (editing?.imageStyleAssetId ? urlFor(editing.imageStyleAssetId) : "");
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
                <em>一个账号一段（名称 / 平台 / 形式 / 类型 / 定位 / 标签），AI 自动识别 · 或点击选择</em>
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
              <label class="field full">账号定位<input class="input" id="adPos" value="${esc(draft.position)}" placeholder="例如：办公效率教程 / 产品功能讲解（人群方向也写在这里）" /></label>
              <label class="field full">创作风格 <em class="muted" style="font-weight:500">账号自带的固定风格：量产/随机主题时自动使用，不必每次填</em>
                <input class="input" id="adStyle" value="${esc(draft.styleProfile)}" placeholder="例如：白底极简种草风 / 口播犀利有梗 / 深度测评冷静叙事" /></label>
              <div class="field full">
                <span>账号头像 <em class="muted">仅管理员可维护，可点击或拖图替换</em></span>
                <label class="ad-image-drop avatar" id="adAvatarDrop">
                  ${avatarUrl ? `<img src="${avatarUrl}" alt="账号头像" />` : `<i>${esc((draft.name || editing?.name || "号")[0])}</i>`}
                  <b>拖入 / 上传头像</b>
                  <input type="file" accept="image/*" hidden id="adAvatarUp" />
                </label>
              </div>
              ${draft.mode === "图文" ? `
              <div class="field full">
                <span>成图风格参考 <em class="muted">拖入小图作为该账号图文风格预览，生成提示词时会引用它的风格方向</em></span>
                <label class="ad-image-drop style-ref" id="adStyleRefDrop">
                  ${styleRefUrl ? `<img src="${styleRefUrl}" alt="图文风格参考" />` : `${icon("image", 18)}<b>拖入 / 上传风格参考图</b>`}
                  <input type="file" accept="image/*" hidden id="adStyleRefUp" />
                </label>
              </div>
              <label class="field full">图文提示词模板 <em class="muted" style="font-weight:500">站外整段提示词、站内逐图提示词都会优先参考；产品名、主题、各图内容会按本次创作自动替换</em>
                <textarea class="input" id="adImgTpl" rows="8" placeholder="粘贴你的图文模板提示词，例如：请独立分别生成6张独立图片……">${esc(draft.imagePromptTemplate)}</textarea>
              </label>` : ""}
              ${isVideo ? `
              <label class="field">固定声线名称
                <input class="input" id="adVoiceName" value="${esc(draft.voiceName)}" placeholder="例如：素材号男 / 素材号女 / 职场女声" />
              </label>
              <label class="field">Minimax voice_id
                <input class="input" id="adVoiceId" value="${esc(draft.voiceId)}" placeholder="留空则使用平台默认声线" />
              </label>
              ${ttsVoicePresets().length ? `<label class="field full">声线预设
                <select class="input" id="adVoicePreset">
                  <option value="">默认平台声线${defaultTtsVoiceId() ? `（${esc(defaultTtsVoiceId())}）` : ""}</option>
                  ${ttsVoicePresets().map(v => `<option value="${esc(v.voiceId)}" ${draft.voiceId === v.voiceId ? "selected" : ""}>${esc(v.name)} · ${esc(v.voiceId)}</option>`).join("")}
                </select>
              </label>` : ""}
              <div class="field full">
                <span>固定声线参考 <em class="muted">可上传一段参考音频；当前用于提示词/资产留存，后端支持克隆后可直接调用</em></span>
                <label class="btn ghost sm ad-voice-drop" id="adVoiceDrop">${draft.voiceFile || editing?.voiceRefAssetId ? "✓ 已有声线参考 · 点击更换 / 可拖音频" : "+ 上传声线参考 / 可拖音频"}<input type="file" accept="audio/*" hidden id="adVoiceUp" /></label>
              </div>` : ""}
            </div>

            ${isDH ? `
            <div class="ad-block">
              <div class="adb-head"><b>数字人参考</b><em class="muted">角色身份版用于生成时锁定人物形象</em></div>
              <div class="ad-char-row">
                <label class="btn ghost sm ad-char-drop" id="adCharDrop">${draft.charDataUrl || (editing && editing.charBoardAssetId) ? "✓ 已有角色版 · 点击更换 / 可拖图" : "+ 上传角色参考版 / 可拖图"}<input type="file" accept="image/*" hidden id="adCharUp" /></label>
                ${draft.charDataUrl ? `<img class="ad-char-prev" src="${draft.charDataUrl}"/>` : ""}
              </div>
              <div class="ad-ai-board">
                <div class="adb-head"><b>${icon("wand", 13)} 没有角色版？AI 生成一张身份板</b><em class="muted">随机方向 → 生成提示词 → 第三方出图 → 上传</em></div>
                <div class="ad-dir-row">
                  <button class="dice" id="adDirDice" title="随机角色风格方向">${icon("dice", 14)}</button>
                  <input class="input" id="adDirInput" placeholder="点骰子随机一个角色风格方向，可手改" />
                  <button class="btn ghost sm" id="adDirGo">生成提示词</button>
                </div>
                <pre class="ad-char-prompt" id="adCharPrompt" hidden></pre>
                <div class="head-actions" id="adCharActs" hidden>
                  <button class="btn ghost sm" id="adCharCopy">${icon("copy", 13)} 复制整段提示词</button>
                  <label class="btn primary sm ad-char-drop" id="adCharReturnDrop">${icon("upload", 13)} 上传身份版 / 可拖图<input type="file" accept="image/*" hidden id="adCharReturn" /></label>
                </div>
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
      };

      const wire = () => {
        $("#adName", root).addEventListener("input", e => { draft.name = e.target.value; refreshNaming(); });
        $("#adPos", root).addEventListener("input", e => { draft.position = e.target.value; });
        $("#adStyle", root).addEventListener("input", e => { draft.styleProfile = e.target.value; });
        const imgTpl = $("#adImgTpl", root);
        if (imgTpl) imgTpl.addEventListener("input", e => { draft.imagePromptTemplate = e.target.value; });
        const voiceName = $("#adVoiceName", root);
        if (voiceName) voiceName.addEventListener("input", e => { draft.voiceName = e.target.value; });
        const voiceId = $("#adVoiceId", root);
        if (voiceId) voiceId.addEventListener("input", e => { draft.voiceId = e.target.value; });
        const voicePreset = $("#adVoicePreset", root);
        if (voicePreset) voicePreset.addEventListener("change", e => {
          const id = e.target.value || "";
          const preset = ttsVoicePresets().find(v => v.voiceId === id);
          draft.voiceId = id;
          draft.voiceName = preset?.name || draft.voiceName || "";
          const idInput = $("#adVoiceId", root);
          const nameInput = $("#adVoiceName", root);
          if (idInput) idInput.value = id;
          if (preset && nameInput) nameInput.value = preset.name;
        });
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

        async function setCharBoard(file, msg = "已选择角色参考版") {
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
        async function setStyleRef(file) {
          if (!file || !file.type.startsWith("image/")) return;
          draft.styleRefDataUrl = await fileToDataUrl(file);
          draw();
          toast("已选择图文风格参考图");
        }
        const avatarUp = $("#adAvatarUp", root);
        if (avatarUp) avatarUp.addEventListener("change", e => setAvatar(e.target.files[0]));
        const avatarDrop = $("#adAvatarDrop", root);
        if (avatarDrop) {
          avatarDrop.addEventListener("click", () => $("#adAvatarUp", root)?.click());
          wireDropZone(avatarDrop, files => setAvatar(Array.from(files).find(f => f.type.startsWith("image/"))), { filesOnly: true });
        }
        const styleRefUp = $("#adStyleRefUp", root);
        if (styleRefUp) styleRefUp.addEventListener("change", e => setStyleRef(e.target.files[0]));
        const styleRefDrop = $("#adStyleRefDrop", root);
        if (styleRefDrop) {
          styleRefDrop.addEventListener("click", () => $("#adStyleRefUp", root)?.click());
          wireDropZone(styleRefDrop, files => setStyleRef(Array.from(files).find(f => f.type.startsWith("image/"))), { filesOnly: true });
        }
        function setVoiceFile(file, msg = "已选择声线参考") {
          if (!file || !file.type.startsWith("audio/")) return;
          draft.voiceFile = file;
          toast(msg);
          const el = $("#adVoiceDrop", root);
          if (el) el.childNodes[0].textContent = `✓ ${file.name} · 点击更换 / 可拖音频`;
        }
        const voiceUp = $("#adVoiceUp", root);
        if (voiceUp) voiceUp.addEventListener("change", e => setVoiceFile(e.target.files[0]));
        const voiceDrop = $("#adVoiceDrop", root);
        if (voiceDrop) wireDropZone(voiceDrop, files => setVoiceFile(Array.from(files).find(f => f.type.startsWith("audio/")), "已拖入声线参考"), { filesOnly: true });
        const charUp = $("#adCharUp", root);
        if (charUp) charUp.addEventListener("change", e => setCharBoard(e.target.files[0]));
        wireDropZone($("#adCharDrop", root), files => setCharBoard(Array.from(files).find(f => f.type.startsWith("image/")), "已拖入角色参考版"), { filesOnly: true });
        const dirDice = $("#adDirDice", root);
        if (dirDice) {
          dirDice.addEventListener("click", () => {
            const cur = $("#adDirInput", root).value;
            let pick = cur;
            while (pick === cur) pick = CHAR_DIR_POOL[Math.floor(Math.random() * CHAR_DIR_POOL.length)];
            $("#adDirInput", root).value = pick;
          });
          $("#adDirGo", root).addEventListener("click", () => {
            let dir = $("#adDirInput", root).value.trim();
            if (!dir) { dir = CHAR_DIR_POOL[Math.floor(Math.random() * CHAR_DIR_POOL.length)]; $("#adDirInput", root).value = dir; }
            $("#adCharPrompt", root).textContent = buildCharBoardPrompt(dir);
            $("#adCharPrompt", root).hidden = false;
            $("#adCharActs", root).hidden = false;
            toast("提示词已生成：复制去第三方出图，回来点「上传身份版」");
          });
          $("#adCharCopy", root).addEventListener("click", () => copyText($("#adCharPrompt", root).textContent, "已复制身份板提示词"));
          $("#adCharReturn", root).addEventListener("change", e => setCharBoard(e.target.files[0], "身份版已上传，将作为角色参考版"));
          wireDropZone($("#adCharReturnDrop", root), files => setCharBoard(Array.from(files).find(f => f.type.startsWith("image/")), "已拖入身份版，将作为角色参考版"), { filesOnly: true });
        }

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
          const isDH = draft.mode === "视频" && draft.subType === "数字人";
          if (isDH && !editing && !draft.charDataUrl) { toast("数字人账号请先上传或上传角色参考版"); return; }

          let acc;
          if (editing) {
            acc = updateAccount(editing.id, {
              name, platform: draft.platform, mode: draft.mode,
              subType: draft.mode === "图文" ? "" : draft.subType,
              position: draft.position.trim() || "（待补充定位）",
              styleProfile: draft.styleProfile.trim(),
              voiceName: draft.voiceName.trim(),
              voiceId: draft.voiceId.trim(),
              imagePromptTemplate: draft.imagePromptTemplate.trim(),
              qtags: [...draft.qtags]
            });
          } else {
            acc = createAccount({
              name, platform: draft.platform, mode: draft.mode, subType: draft.subType,
              position: draft.position.trim(), styleProfile: draft.styleProfile.trim(),
              voiceName: draft.voiceName.trim(), voiceId: draft.voiceId.trim(),
              imagePromptTemplate: draft.imagePromptTemplate.trim(),
              qtags: [...draft.qtags]
            });
          }
          if (draft.avatarDataUrl) {
            const aa = await addAssetFromDataUrl(acc.id, { name: name + " 账号头像", tags: ["头像"], dataUrl: draft.avatarDataUrl });
            acc.avatarAssetId = aa.id;
            save("accounts");
          }
          if (draft.styleRefDataUrl) {
            const sa = await addAssetFromDataUrl(acc.id, { name: name + " 图文风格参考", tags: ["图文风格参考"], dataUrl: draft.styleRefDataUrl });
            acc.imageStyleAssetId = sa.id;
            save("accounts");
          }
          if (draft.charDataUrl) {
            const ca = await addAssetFromDataUrl(acc.id, { name: name + " 角色身份版", tags: ["角色版"], dataUrl: draft.charDataUrl });
            acc.charBoardAssetId = ca.id;
          }
          for (const a of draft.assets) await addAssetFromDataUrl(acc.id, { name: a.name, tags: [], dataUrl: a.dataUrl });
          if (draft.voiceFile) {
            const va = await addAssetFromFile(acc.id, draft.voiceFile, { tags: ["声线参考", "口播音频"] });
            acc.voiceRefAssetId = va.id;
          }
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
