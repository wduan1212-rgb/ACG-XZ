/* 链路 · 脚本页：主题/风格/张数 → AI 生成结构化脚本 → 行内编辑 → 优化 */

import { $, $$, esc, copyText, wireDropZone } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { state, save, accountById, productById, primaryProducts, primaryProductById } from "../core/store.js";
import { AI } from "../api/ai.js";
import { STYLE_CHIP_BASE } from "../api/prompts.js";
import { normalizeVideoTimes, setStage, isMaterial, estimateAudio } from "../domain/productions.js";
import { getCreativeMemoryContext } from "../domain/analytics.js";
import { defaultTtsVoiceId, lookupTtsVoice, synthesizeTts, ttsApiConfigured, ttsProviderLabel, ttsVoicePresets } from "../api/providers.js";
import { addAssetFromDataUrl, addAssetFromFile, urlFor } from "../domain/assets.js";
import { fmtTC } from "../core/util.js";
import { toast, withLoading, promptModal } from "../ui/components.js";
import { go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js?v=20260713-v74-1";

const DEFAULT_XHS_IMAGE_COUNT = 4;

function audioDurationOf(url) {
  return new Promise(res => {
    if (!url) return res(0);
    const el = new Audio();
    el.preload = "metadata";
    el.onloadedmetadata = () => res(isFinite(el.duration) ? el.duration : 0);
    el.onerror = () => res(0);
    el.src = url;
  });
}

export function renderScriptPage(root, p) {
  const acc = accountById(p.accountId);
  const isImg = p.mode === "图文";
  const material = isMaterial(p);
  const isVideo = !isImg;
  const A = p.artifacts.script;
  A.productId = A.productId || "dumate";
  A.direction = A.direction || "";
  const products = primaryProducts();
  const product = primaryProductById(A.productId || "dumate");
  A.productId = product?.id || "dumate";
  const memoryContext = getCreativeMemoryContext({ account: acc, platform: acc.platform });
  const audioUrl = p.artifacts.audio.assetId ? urlFor(p.artifacts.audio.assetId) : "";
  const imageStyleRef = isImg && acc.imageStyleAssetId ? state.assets.find(x => x.id === acc.imageStyleAssetId) : null;

  root.innerHTML = `
    ${stepperHtml(p, "script")}
    <div class="chain-page">
      <div class="chain-main">
        <div class="page-head">
          <div><div class="eyebrow">${material ? "素材链路 · 脚本" : STAGES_LABEL(isImg)}</div>
          <h2>${isImg ? "AI 按创作内容生成小红书笔记图卡" : material ? "AI 生成素材号口播脚本（可长可短 · 有深度/有梗）" : "AI 生成真人口播脚本（分段工坊出片）"}</h2></div>
          <button class="btn primary" id="csNext">下一步：${isImg ? "成图" : "文案分镜"} ${icon("arrowRight", 14)}</button>
        </div>

        <div class="brief card">
          <div class="brief-row">
            <label class="field grow">创作主题
              <div class="input-dice">
                <input class="input" id="csTopic" value="${esc(p.topic || "")}" placeholder="例如：百度搭子一键整理混乱文件夹" />
                <button class="dice" id="csTopicDice" title="AI 随机主题">${icon("dice", 15)}</button>
              </div>
            </label>
            <label class="field product-field">宣传产品
              <select class="input" id="csProduct">
                ${products.map(x => `<option value="${esc(x.id)}" ${A.productId === x.id ? "selected" : ""}>${esc(x.name)}</option>`).join("")}
              </select>
            </label>
            ${isImg ? `
            <div class="field count-field">
              <span>生成几张图 <em id="csCountVal">${A.imageCount || DEFAULT_XHS_IMAGE_COUNT} 张</em></span>
              <div class="count-slider"><span>1</span><input type="range" id="csCount" min="1" max="9" step="1" value="${A.imageCount || DEFAULT_XHS_IMAGE_COUNT}" /><span>9</span></div>
            </div>` : ""}
          </div>
          ${isImg ? `
          <div class="brief-row">
            <label class="field grow">创作内容
                <textarea class="input" id="csContent" rows="5" placeholder="把这次想做的笔记内容写具体一些：产品、痛点、使用场景、希望几张图分别讲什么。留空则从四个方向自动挑短选题。">${esc(A.direction || "")}</textarea>
            </label>
          </div>
          <div class="brief-row">
            <label class="field grow">图文总风格
              <div class="input-dice">
                <input class="input" id="csStyle" value="${esc(A.style || acc.lockedStyle || "")}" ${acc.lockedStyle ? "readonly" : ""} placeholder="整体视觉风格，点标签快速填入" />
                <button class="dice" id="csStyleDice" title="AI 随机风格">${icon("dice", 15)}</button>
                <button class="dice ${acc.lockedStyle ? "locked" : ""}" id="csStyleLock" title="${acc.lockedStyle ? "已固定，点击解锁" : "固定当前风格：该账号之后默认用它"}">${icon(acc.lockedStyle ? "lock" : "unlock", 15)}</button>
              </div>
              <div class="style-chips" id="csChips"></div>
            </label>
          </div>` : ""}
          <div class="brief-row">
            <button class="btn gen" id="csGen">${icon("spark", 15)} ${isImg ? "生成图卡脚本" : "生成视频脚本"}</button>
            ${A.source ? `<span class="src-note">${A.source === "llm" ? "✓ 模型真实生成" : "⚠ 本地模板（API 未通）"}</span>` : ""}
          </div>
        </div>

        <div class="table-head">
          <div><b>${isImg ? "笔记图卡内容（无口播）" : "分镜脚本"}</b><em class="muted">单元格可直接编辑</em></div>
          ${isImg ? "" : `<button class="btn ghost sm" id="csAddShot">${icon("plus", 13)} 添加镜头</button>`}
        </div>
        <div id="csTable"></div>

        <div class="optimize-bar card">
          <input class="input" id="csOptDir" placeholder="优化方向，例如：开头更有钩子 / 减少广告腔 / 突出批量重命名功能" />
          <button class="btn ghost" id="csOpt">${icon("wand", 14)} 优化脚本</button>
        </div>

        ${isVideo ? `
        <div class="card tts-card">
          <div class="card-head"><b>${icon("mic", 14)} 口播音频</b><em>${esc(ttsProviderLabel())}</em></div>
          ${p.artifacts.audio.lastError ? `<div class="tts-error">${icon("alert", 14)} <b>口播生成失败</b><span>${esc(p.artifacts.audio.lastError)}</span></div>` : ""}
          ${(p.artifacts.audio.perShot || []).length ? `
            <div class="tts-done ${p.artifacts.audio.source === "estimate" ? "estimate" : ""}">${icon(p.artifacts.audio.source === "tts" ? "checkCircle" : "clock", 15)} ${p.artifacts.audio.source === "tts" ? "口播音频已就绪" : "口播估时已就绪"}：<b>${fmtTC(p.artifacts.audio.duration)}</b> · ${p.artifacts.audio.perShot.length} 个镜头分段
              <span class="muted">${p.artifacts.audio.source === "tts" ? `Minimax 声线：${esc(p.artifacts.audio.voiceId || "默认")}` : "真实音频未生成，先按字数估时继续分镜"}</span></div>` : `
            <p class="muted" style="margin-bottom:10px">脚本满意后，把口播稿生成为音频备用：分镜与片段时长都会跟着音频走。</p>`}
          ${audioUrl ? `<div class="tts-audio">
            <audio src="${audioUrl}" controls preload="metadata"></audio>
            <button class="btn ghost sm" id="csAudioAsset">${icon("folder", 13)} 资产库</button>
          </div>` : ""}
          <div class="tts-controls">
            ${ttsVoicePresets().length ? `<label class="field compact preset">预设声线
              <select class="input" id="csVoicePreset">
                <option value="">手动 / 默认</option>
                ${ttsVoicePresets().map(v => `<option value="${esc(v.voiceId)}" ${(p.artifacts.audio.voiceId || acc.voiceId || defaultTtsVoiceId()) === v.voiceId ? "selected" : ""}>${esc(v.name)}</option>`).join("")}
              </select>
            </label>` : ""}
            <label class="field compact">声线 ID
              <div class="input-with-action">
                <input class="input" id="csVoiceId" value="${esc(p.artifacts.audio.voiceId || acc.voiceId || defaultTtsVoiceId())}" placeholder="例如 Chinese (Mandarin)_News_Anchor 或你的克隆声线 ID" />
                <button type="button" class="btn ghost sm" id="csVoiceLookup">${icon("search", 13)} 识别</button>
              </div>
            </label>
            <span class="muted">${acc.voiceName ? `账号固定声线：${esc(acc.voiceName)} · ` : ""}可指定 Minimax voice_id；留空则使用服务器默认声线。</span>
            ${p.artifacts.audio.voiceLookup ? `<span class="voice-lookup-note full">${esc(p.artifacts.audio.voiceLookup)}</span>` : ""}
          </div>
          <button class="btn ghost" id="csTts">${icon("mic", 14)} ${(p.artifacts.audio.perShot || []).length ? "重新生成口播音频" : "生成口播音频"}${ttsApiConfigured() ? "" : "（估时）"}</button>
          <div class="tts-actions" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:10px">
            <button class="btn ghost sm" id="csCopyLines">${icon("list", 13)} 一键复制所有口播</button>
            <label class="btn ghost sm">${icon("upload", 13)} 上传 / 回传口播音频<input type="file" accept="audio/*" hidden id="csAudioUp" /></label>
            <span class="muted">已有口播音频可拖到本卡片上传，按真实时长重排分镜</span>
          </div>
        </div>` : ""}
      </div>

      <aside class="chain-side">
        <div class="side-card card">
          <h3>账号创作风格</h3>
          <div class="pos-card">
            <div class="pc-row"><span>账号</span><b>${esc(acc.name)}</b></div>
            <div class="pc-row"><span>平台</span><b>${esc(acc.platform)}</b></div>
            <div class="pc-row"><span>模式</span><b>${esc(p.mode)}${p.subType ? " · " + esc(p.subType) : ""}</b></div>
            <div class="pc-row"><span>风格</span><b>${esc(acc.styleProfile || acc.lockedStyle || "未配置")}</b></div>
          </div>
        </div>
        ${memoryContext ? `<div class="side-card card hint">
          <h3>${icon("pulse", 13)} 数据记忆</h3>
          <p>${esc(memoryContext.replace(/^【历史数据复盘记忆】\n?/, "").split("\n").slice(0, 3).join("\n"))}</p>
        </div>` : ""}
        ${isImg ? "" : material ? `<div class="side-card card hint">
          <h3>素材号规则</h3>
          <p>口播稿是灵魂：按创作内容、口播风格参考和账号创作风格写出深度或节奏。可先生成/上传<b>口播音频</b>定时长；如果不上传音频，文案分镜会把口播逐句写进视频提示词里。</p>
        </div>` : `<div class="side-card card hint">
          <h3>结构规则</h3>
          <p>真人账号不再走两段式生成台：脚本后直接进入文案分镜，按口播时长自动拆成多个 15s 内片段，用统一参考图、角色锚点和固定声线保持一致。</p>
        </div>`}
        ${isImg && (acc.imagePromptTemplate || imageStyleRef) ? `<div class="side-card card hint">
          <h3>${icon("image", 13)} 图文模板</h3>
          <p>${acc.imagePromptTemplate ? "该账号已配置固定图文提示词模板；本次会按选择张数和创作内容替换变量。" : ""}${imageStyleRef ? `\n风格参考：${esc(imageStyleRef.name)}` : ""}</p>
        </div>` : ""}
        <div class="side-card card" id="csStruct"></div>
      </aside>
    </div>`;

  wireStepper(root);
  renderTable();
  renderStruct();
  if (isImg) renderChips();

  /* ---------- 表格 ---------- */
  function cols() {
    if (isImg) return [["idea", "核心思想"], ["visual", "画面描述"], ["line", "图上文案"]];
    if (material) return [["idea", "核心思想"], ["visual", "画面 / 分镜"], ["line", "画外音口播"]];
    return [["time", "时间"], ["idea", "核心思想"], ["visual", "画面 / 分镜"], ["line", "口播"]];
  }
  function renderTable() {
    const wrap = $("#csTable", root);
    const shots = A.shots || [];
    if (!shots.length) {
      wrap.innerHTML = `<div class="empty-state slim">${icon(isImg ? "image" : "film", 22)}<b>点击「${isImg ? "生成图卡脚本" : "生成视频脚本"}」</b><p>AI 会按${isImg ? "创作内容、产品信息和账号创作风格输出笔记图卡内容（核心思想 / 画面 / 图上文案）" : "创作内容、口播风格参考、账号创作风格和产品信息输出结构化分镜表（时间 / 思想 / 画面 / 口播）"}</p></div>`;
      return;
    }
    const C = cols();
    wrap.innerHTML = `<table class="script-table"><thead><tr><th class="c-idx">#</th>${C.map(c => `<th>${c[1]}</th>`).join("")}<th class="c-act"></th></tr></thead>
      <tbody>${shots.map((s, i) => `<tr>
        <td class="c-idx">${i + 1}</td>
        ${C.map(c => `<td class="c-edit" contenteditable="true" data-f="${c[0]}" data-i="${i}">${esc(s[c[0]] || "")}</td>`).join("")}
        <td class="c-act"><button class="row-del" data-del="${i}" title="删除">${icon("x", 12)}</button></td>
      </tr>`).join("")}</tbody></table>`;
    wrap.querySelectorAll(".c-edit").forEach(td => td.addEventListener("blur", () => {
      const s = A.shots[+td.dataset.i];
      if (s) { s[td.dataset.f] = td.textContent.trim(); save("productions"); }
    }));
    wrap.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
      A.shots.splice(+b.dataset.del, 1); save("productions"); renderTable(); renderStruct();
    }));
  }
  function renderStruct() {
    const el = $("#csStruct", root);
    const n = (A.shots || []).length;
    el.innerHTML = `<h3>${isImg ? "图卡结构" : "脚本结构"}</h3>` + (n
      ? (isImg
        ? `<div class="seg-mini">共 ${n} 张图卡：封面 → 步骤 → 收束。下一步逐张出图。</div>`
        : material
        ? `<div class="seg-mini"><div class="sm-top"><b>长视频</b><span>${(p.artifacts.audio.duration ? fmtTC(p.artifacts.audio.duration) : "约 " + Math.round(n * 5) + "s")}</span></div><div>${n} 个镜头 · 片段时长跟随口播音频</div></div>`
        : `<div class="seg-mini"><div class="sm-top"><b>文案分镜</b><span>≤60s</span></div><div>按口播时长自动拆成多个 15s 内片段</div></div><div class="muted" style="margin-top:6px">共 ${n} 个镜头</div>`)
      : `<div class="muted">生成脚本后显示结构概览</div>`);
  }
  function narrationText(shots) {
    return (shots || []).map(s => String(s.line || "").trim()).filter(Boolean).join("\n");
  }
  function audioPlanFromDuration(shots, duration) {
    const base = estimateAudio(shots);
    const total = Number(duration || base.duration || 0);
    if (!total || !base.duration) return base;
    const scale = total / base.duration;
    const perShot = base.perShot.map(x => ({ dur: Math.max(3, Math.round(x.dur * scale * 10) / 10) }));
    const diff = Math.round((total - perShot.reduce((a, x) => a + x.dur, 0)) * 10) / 10;
    if (perShot.length && Math.abs(diff) >= 0.1) perShot[perShot.length - 1].dur = Math.max(3, Math.round((perShot[perShot.length - 1].dur + diff) * 10) / 10);
    return { perShot, duration: Math.round(perShot.reduce((a, x) => a + x.dur, 0) * 10) / 10 };
  }
  function renderChips() {
    const box = $("#csChips", root); if (!box) return;
    const custom = acc.customStyleChips || [];
    const cur = ($("#csStyle", root).value || "").split(/[、,，]/).map(s => s.trim());
    box.innerHTML = STYLE_CHIP_BASE.map(s => `<button class="chip ${cur.includes(s) ? "on" : ""}" data-style="${esc(s)}">${esc(s)}</button>`).join("")
      + custom.map(s => `<button class="chip custom ${cur.includes(s) ? "on" : ""}" data-style="${esc(s)}">${esc(s)}<i data-x="${esc(s)}">×</i></button>`).join("")
      + `<button class="chip add" data-add-chip>+ 自定义</button>`;
  }

  /* ---------- 事件 ---------- */
  $("#csTopic", root).addEventListener("input", e => { p.topic = e.target.value; p.title = p.title || e.target.value; save("productions"); });
  const productSelect = $("#csProduct", root);
  if (productSelect) productSelect.addEventListener("change", e => {
    A.productId = e.target.value || "dumate";
    save("productions");
  });
  $("#csTopicDice", root).addEventListener("click", async e => {
    await withLoading(e.currentTarget, async () => {
      const t = await AI.randomPick({ kind: "topic", account: acc, product: productById((productSelect && productSelect.value) || A.productId || "dumate") });
      $("#csTopic", root).value = t; p.topic = t; save("productions");
      toast("已随机主题：" + t);
    }, "…");
  });

  if (isImg) {
    $("#csContent", root).addEventListener("input", e => {
      A.direction = e.target.value;
      save("productions");
    });
    $("#csCount", root).addEventListener("input", e => {
      A.imageCount = +e.target.value;
      $("#csCountVal", root).textContent = `${A.imageCount} 张${A.imageCount >= 9 ? "（小红书上限）" : ""}`;
      save("productions");
    });
    $("#csStyle", root).addEventListener("input", e => { A.style = e.target.value; save("productions"); renderChips(); });
    $("#csStyleDice", root).addEventListener("click", async e => {
      if (acc.lockedStyle) { toast("已锁定风格，先解锁"); return; }
      await withLoading(e.currentTarget, async () => {
        const v = await AI.randomPick({ kind: "style", account: acc });
        $("#csStyle", root).value = v; A.style = v; save("productions"); renderChips();
        toast((AI.lastSource === "llm" ? "AI 已随机风格：" : "已随机风格：") + v);
      }, "…");
    });
    $("#csStyleLock", root).addEventListener("click", () => {
      if (acc.lockedStyle) { acc.lockedStyle = null; toast("已解锁风格"); }
      else {
        const v = $("#csStyle", root).value.trim();
        if (!v) { toast("先填写或随机一个风格"); return; }
        acc.lockedStyle = v; A.style = v; toast(`已固定风格「${v}」`);
      }
      save("accounts", "productions");
      renderScriptPage(root, p);
    });
    $("#csChips", root).addEventListener("click", async e => {
      const x = e.target.closest("[data-x]");
      if (x) { acc.customStyleChips = (acc.customStyleChips || []).filter(s => s !== x.dataset.x); save("accounts"); renderChips(); return; }
      const add = e.target.closest("[data-add-chip]");
      if (add) {
        const v = await promptModal({ title: "自定义风格标签", placeholder: "例如：胶片质感风 / 奶油暖色风" });
        if (!v) return;
        acc.customStyleChips = acc.customStyleChips || [];
        if (!acc.customStyleChips.includes(v) && !STYLE_CHIP_BASE.includes(v)) acc.customStyleChips.push(v);
        save("accounts"); renderChips();
        return;
      }
      const c = e.target.closest("[data-style]");
      if (!c) return;
      if (acc.lockedStyle) { toast("已锁定风格，先解锁"); return; }
      const tag = c.dataset.style;
      const cur = $("#csStyle", root).value.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
      const i = cur.indexOf(tag);
      i >= 0 ? cur.splice(i, 1) : cur.push(tag);
      $("#csStyle", root).value = cur.join("、");
      A.style = cur.join("、"); save("productions");
      renderChips();
    });
  } else {
    $("#csAddShot", root).addEventListener("click", () => {
      A.shots = A.shots || [];
      const n = A.shots.length;
      A.shots.push({ time: `${n * 3}-${n * 3 + 3}s`, idea: "", visual: "", line: "" });
      save("productions"); renderTable(); renderStruct();
    });
  }

  $("#csGen", root).addEventListener("click", e => withLoading(e.currentTarget, async () => {
    const topic = $("#csTopic", root).value.trim() || `${product?.shortName || product?.name || "产品"} 功能演示`;
    p.topic = topic;
    const style = acc.styleProfile || (isImg ? ($("#csStyle", root)?.value.trim() || "") : "");
    const selectedProduct = productById(A.productId) || product;
    const contentBrief = isImg ? ($("#csContent", root)?.value.trim() || topic) : "";
    if (isImg) A.direction = contentBrief;
    const res = material
      ? await AI.generateMaterialScript({ topic, account: acc, style, product: selectedProduct })
      : await AI.generateScript({
        topic, duration: isImg ? 0 : 55, account: acc, image: isImg,
        direction: contentBrief,
        style, imageCount: A.imageCount || DEFAULT_XHS_IMAGE_COUNT, product: selectedProduct,
        imageTemplate: acc.imagePromptTemplate || "",
        styleRefName: imageStyleRef?.name || ""
      });
    A.shots = res.shots || [];
    A.title = res.title || topic;
    A.source = AI.lastSource;
    p.title = res.title || topic;
    if (!isImg) { Object.assign(p.artifacts.audio, { assetId: null, duration: 0, perShot: [], source: "", voiceId: acc.voiceId || p.artifacts.audio.voiceId || "", voiceRefAssetId: p.artifacts.audio.voiceRefDisabled ? null : (acc.voiceRefAssetId || p.artifacts.audio.voiceRefAssetId || null) }); }
    if (p.stage === "script") p.stageStatus = "done";
    save("productions");
    renderScriptPage(root, p);
    toast(AI.sourceNote(isImg ? "已生成笔记图卡脚本" : material ? "已生成长视频口播脚本" : "模型已生成分镜脚本"));
  }, "生成中…"));

  const tts = $("#csTts", root);
  if (tts) tts.addEventListener("click", e => withLoading(e.currentTarget, async () => {
    if (!(A.shots || []).length) { toast("先生成脚本"); return; }
    const voiceId = ($("#csVoiceId", root)?.value || "").trim() || acc.voiceId || defaultTtsVoiceId();
    p.artifacts.audio.voiceId = voiceId;
    if (ttsApiConfigured()) {
      const text = narrationText(A.shots);
      if (!text) { toast("没有可合成的口播文本"); return; }
      try {
        const out = await synthesizeTts({ text, voiceId, speed: 1.2 });
        const asset = await addAssetFromDataUrl(p.accountId, {
          name: `口播音频_${(p.title || p.topic || "素材号").slice(0, 10)}`,
          type: "音频",
          tags: ["口播音频", "Minimax"],
          dataUrl: out.audioDataUrl
        });
        Object.assign(p.artifacts.audio, audioPlanFromDuration(A.shots, out.duration), { assetId: asset.id, source: "tts", voiceId: out.voiceId || voiceId, lastError: "" });
      } catch (err) {
        Object.assign(p.artifacts.audio, estimateAudio(A.shots), { assetId: null, source: "estimate", voiceId, lastError: err.message || "Minimax TTS 生成失败" });
        save("productions");
        renderScriptPage(root, p);
        toast("Minimax 口播失败，已切换为估时备用", "error");
        return;
      }
    } else {
      await new Promise(r => setTimeout(r, 900));
      Object.assign(p.artifacts.audio, estimateAudio(A.shots), { assetId: null, source: "estimate", voiceId, lastError: "" });
    }
    save("productions");
    renderScriptPage(root, p);
    toast(`口播音频已就绪：${fmtTC(p.artifacts.audio.duration)} · ${p.artifacts.audio.perShot.length} 段（${ttsApiConfigured() ? "TTS 生成" : "估时，接 TTS API 后为真实音频"}）`);
  }, "合成中…"));
  const voiceInput = $("#csVoiceId", root);
  if (voiceInput) voiceInput.addEventListener("input", e => {
    p.artifacts.audio.voiceId = e.target.value.trim();
    p.artifacts.audio.voiceLookup = "";
    save("productions");
  });
  const voicePreset = $("#csVoicePreset", root);
  if (voicePreset) voicePreset.addEventListener("change", e => {
    if (!e.target.value) return;
    $("#csVoiceId", root).value = e.target.value;
    p.artifacts.audio.voiceId = e.target.value;
    p.artifacts.audio.voiceLookup = "";
    save("productions");
  });
  const voiceLookup = $("#csVoiceLookup", root);
  if (voiceLookup) voiceLookup.addEventListener("click", e => withLoading(e.currentTarget, async () => {
    const voiceId = ($("#csVoiceId", root)?.value || "").trim();
    if (!voiceId) { toast("请先填写 voice_id"); return; }
    const res = await lookupTtsVoice(voiceId, { test: true });
    p.artifacts.audio.voiceId = voiceId;
    const usedBy = (res.accounts || []).map(x => x.account).filter(Boolean).slice(0, 3).join("、");
    const local = res.name ? `识别为：${res.name}${usedBy ? `（用于 ${usedBy}${(res.accounts || []).length > 3 ? " 等账号" : ""}）` : ""}` : "本地未命名，按自定义声线 ID 使用";
    const remote = res.valid === true ? "上游测试有效" : res.valid === false ? "上游返回无效" : (res.configured ? "上游未能确认" : "本地未配置 TTS，暂未上游测试");
    p.artifacts.audio.voiceLookup = `${local} · ${remote}${res.detail ? `：${res.detail.slice(0, 120)}` : ""}`;
    if (acc && res.name) {
      acc.voiceId = voiceId;
      acc.voiceName = res.name;
      save("accounts");
    }
    save("productions");
    toast(res.valid === false ? "声线上游测试未通过" : "声线识别完成");
    renderScriptPage(root, p);
  }, "识别中…"));
  const audioAsset = $("#csAudioAsset", root);
  if (audioAsset) audioAsset.addEventListener("click", () => {
    state.ui.assetsFilterAccount = p.accountId;
    go("assets");
  });

  // 一键复制所有口播
  $("#csCopyLines", root)?.addEventListener("click", () => {
    const text = (A.shots || []).map(s => (s.line || "").trim()).filter(Boolean).join("\n");
    if (!text) { toast("脚本里还没有口播文案"); return; }
    copyText(text);
    toast("已复制全部口播文案");
  });
  // 上传 / 回传口播音频：按真实时长重排分镜（支持拖拽到卡片）
  const onAudioFile = async (file) => {
    if (!file) return;
    if (!file.type.startsWith("audio/")) { toast("请上传音频文件"); return; }
    if (!(A.shots || []).length) { toast("先生成脚本，再上传口播"); return; }
    const asset = await addAssetFromFile(p.accountId, file, { tags: ["口播音频", "上传"] });
    const realDur = await audioDurationOf(urlFor(asset));
    const plan = realDur > 0 ? audioPlanFromDuration(A.shots, realDur) : estimateAudio(A.shots);
    Object.assign(p.artifacts.audio, plan, { assetId: asset.id, source: "upload", lastError: "" });
    save("productions");
    renderScriptPage(root, p);
    toast(realDur > 0 ? `口播音频已上传 · ${fmtTC(p.artifacts.audio.duration)}，已按真实时长重排分镜` : "音频已上传（未读出时长，按估时）");
  };
  $("#csAudioUp", root)?.addEventListener("change", async e => { const f = e.target.files[0]; e.target.value = ""; await onAudioFile(f); });
  const ttsCard = root.querySelector(".tts-card");
  if (ttsCard) wireDropZone(ttsCard, files => onAudioFile(files && files[0]));

  $("#csOpt", root).addEventListener("click", e => withLoading(e.currentTarget, async () => {
    if (!(A.shots || []).length) { toast("先生成脚本"); return; }
    const direction = $("#csOptDir", root).value.trim();
    if (!direction) { toast("请填写优化方向"); return; }
    const res = await AI.optimizeScript({ shots: A.shots, direction, account: acc, image: isImg });
    A.shots = res.shots || A.shots;
    if (res.title) { A.title = res.title; p.title = res.title; }
    save("productions");
    renderTable(); renderStruct();
    $("#csOptDir", root).value = "";
    toast(AI.sourceNote("脚本已按方向优化"));
  }, "优化中…"));

  $("#csNext", root).addEventListener("click", () => {
    if (!(A.shots || []).length) { toast("先生成脚本再进入下一步"); return; }
    if (isVideo) {
      if (!(p.artifacts.audio.perShot || []).length) Object.assign(p.artifacts.audio, estimateAudio(A.shots), { source: "estimate" });
      if (!(p.artifacts.boards.items || []).length) {
        p.artifacts.boards.items = A.shots.map((s, i) => ({ title: s.idea || `镜头${i + 1}`, visual: s.visual || "", prompt: "", videoPrompt: "", assetId: null, status: "idle" }));
      }
      if (acc.voiceRefAssetId && !p.artifacts.audio.voiceRefAssetId && !p.artifacts.audio.voiceRefDisabled) p.artifacts.audio.voiceRefAssetId = acc.voiceRefAssetId;
      if (acc.voiceId && !p.artifacts.audio.voiceId) p.artifacts.audio.voiceId = acc.voiceId;
      if (p.stage === "script") setStage(p, "workshop", "pending");
      go("studio", "workshop");
      return;
    }
    const next = isImg ? "images" : "boards";
    if (p.stage === "script") {
      // 初始化槽位
      const key = isImg ? "images" : "boards";
      if (!(p.artifacts[key].items || []).length) {
        p.artifacts[key].items = A.shots.map((s, i) => ({ title: s.idea || `${isImg ? "图" : "分镜"}${i + 1}`, visual: s.visual || "", prompt: "", assetId: null, status: "idle" }));
      }
      setStage(p, next, "needs_input");
    }
    go("studio", next);
  });
}

const STAGES_LABEL = isImg => isImg ? "图文链路 · 脚本" : "视频链路 · 脚本";
