/* 链路 · 提示词页（视频）：脚本 → 每场景两段独立 15s 提示词 */

import { $, $$, esc } from "../core/util.js";
import { icon } from "../ui/icons.js";
import { save, accountById } from "../core/store.js";
import { AI } from "../api/ai.js";
import { setStage } from "../domain/productions.js";
import { toast, withLoading } from "../ui/components.js";
import { go } from "../core/router.js";
import { stepperHtml, wireStepper } from "./studio.js";

export function renderPromptsPage(root, p) {
  const acc = accountById(p.accountId);
  const prompts = p.artifacts.prompts || [];

  root.innerHTML = `
    ${stepperHtml(p, "prompts")}
    <div class="chain-page">
      <div class="chain-main">
        <div class="page-head">
          <div><div class="eyebrow">视频链路 · 提示词</div>
          <h2>口播 + 画面拆成两段独立 15s 提示词</h2></div>
          <button class="btn primary" id="cpNext">下一步：进入生成台 ${icon("arrowRight", 14)}</button>
        </div>
        <div class="inhouse-controls">
          <button class="btn gen" id="cpGen">${icon("list", 15)} 生成分段提示词</button>
          ${prompts.length ? `<span class="src-note">已生成 ${prompts.length} 个场景 × 前后两段</span>` : ""}
        </div>
        <div id="cpCards">
          ${prompts.length ? prompts.map((sc, i) => `
            <div class="prompt-card card">
              <div class="pc-header"><span class="pc-num">${i + 1}</span><b>${esc(sc.name)}</b>
                ${sc.ui ? `<span class="tag warn">${icon("alert", 11)} 含 UI 镜头 · 建议绑定截图参考</span>` : ""}
                <button class="btn ghost sm" data-toseg="${i}">在生成台打开 ${icon("arrowRight", 12)}</button>
              </div>
              <div class="pc-body">
                <div class="pc-block"><div class="pb-label"><span class="t-tag front">第一段 · 0-15s</span>独立生成</div>
                  <div class="pb-text" contenteditable="true" data-pedit="${i}:front">${esc(sc.front || "")}</div></div>
                ${sc.back ? `<div class="pc-block"><div class="pb-label"><span class="t-tag back">第二段 · 0-15s</span>独立生成 · 共享同一参考</div>
                  <div class="pb-text" contenteditable="true" data-pedit="${i}:back">${esc(sc.back)}</div></div>` : ""}
              </div>
            </div>`).join("")
          : `<div class="empty-state slim">${icon("list", 22)}<b>点击「生成分段提示词」</b><p>按分镜表和 15s 两段规则拆出每段完整提示词（数字人/无数字人自动套不同框架）</p></div>`}
        </div>
      </div>
      <aside class="chain-side">
        <div class="side-card card">
          <h3>提示词结构</h3>
          <div class="struct-tmpl">
            <div class="struct-row"><span class="t-tag front">第一段 0-15s</span>独立 15s · ${p.subType === "无数字人" ? "场景/界面混剪" : "数字人 + 产品演示"}</div>
            <div class="struct-row"><span class="t-tag back">第二段 0-15s</span>独立 15s · 共享同一参考保持一致</div>
          </div>
        </div>
        <div class="side-card card hint">
          <h3>为什么两段</h3>
          <p>30 秒成片 = 两段各自独立生成的 15s 拼接；两段共享 @角色版 / @产品界面 / @声线 参考，保证人物、声线、风格一致。</p>
        </div>
      </aside>
    </div>`;

  wireStepper(root);

  $("#cpGen", root).addEventListener("click", e => withLoading(e.currentTarget, async () => {
    const shots = p.artifacts.script.shots || [];
    if (!shots.length) { toast("先回脚本页生成脚本"); return; }
    const res = await AI.generatePrompts({ shots, duration: 30, account: acc });
    p.artifacts.prompts = res.prompts || [];
    save("productions");
    renderPromptsPage(root, p);
    toast(AI.sourceNote(`DeepSeek 已生成 ${res.prompts.length} 个场景提示词`));
  }, "生成中…"));

  $$("[data-pedit]", root).forEach(el => el.addEventListener("blur", () => {
    const [i, part] = el.dataset.pedit.split(":");
    const sc = p.artifacts.prompts[+i];
    if (sc) { sc[part] = el.textContent.trim(); save("productions"); }
  }));

  $$("[data-toseg]", root).forEach(b => b.addEventListener("click", () => {
    advance();
    go("studio", "render");
  }));

  $("#cpNext", root).addEventListener("click", () => {
    if (!(p.artifacts.prompts || []).length) { toast("先生成提示词"); return; }
    advance();
    go("studio", "render");
  });

  function advance() {
    if (p.stage === "prompts" || p.stage === "boards") setStage(p, "render", "pending");
  }
}
