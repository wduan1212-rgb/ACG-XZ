from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP_JS = ROOT / "web" / "assets" / "app.js"
INDEX_HTML = ROOT / "web" / "index.html"
STYLES_CSS = ROOT / "web" / "assets" / "styles.css"


def run_node(script: str) -> dict:
    result = subprocess.run(
        ["node", "--input-type=module"],
        input=script,
        cwd=ROOT,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        raise AssertionError(result.stderr or result.stdout)
    return json.loads(result.stdout.strip())


class WebClientRuntimeTest(unittest.TestCase):
    def test_sending_pins_the_latest_message_without_a_smooth_scroll_race(self):
        source = APP_JS.read_text(encoding="utf-8")
        styles = STYLES_CSS.read_text(encoding="utf-8")
        self.assertIn("if (pendingScrollId || hasActiveBottomLock) {", source)
        self.assertIn("conversationBottomLockUntil", source)
        self.assertIn("conversationBottomLockProjectId", source)
        self.assertIn("? 12000", source)
        self.assertIn("stabilizeConversationBottom(", source)
        self.assertIn("durationMs = 900", source)
        self.assertIn("smooth: false", source)
        self.assertIn('`${pendingToken}-assistant`', source)
        self.assertNotIn("smooth: Boolean(pendingScrollId)", source)
        message_rule = styles.split(".message {", 1)[1].split("}", 1)[0]
        self.assertIn("animation: none", message_rule)

    def test_pending_thoughts_only_show_the_current_request_events(self):
        source = APP_JS.read_text(encoding="utf-8")
        self.assertIn('pendingMessageId.endsWith("-assistant")', source)
        self.assertIn('startsWith(`${pendingToken}-event`)', source)
        self.assertIn('const waitingId = `${token}-event-waiting`', source)
        self.assertIn("pendingThoughtStagesFor(message, attachments)", source)
        self.assertIn("已识别为普通问候", source)
        self.assertIn("不会启动图片、视频或语音任务", source)
        self.assertIn("不沿用上一轮制作步骤", source)
        self.assertIn("function previousConversationSubject(message)", source)
        self.assertIn("function contextualRequestFor(message)", source)
        self.assertIn("识别为承接请求", source)
        self.assertIn("正在承接当前会话中的", source)
        self.assertIn("只从本轮指定的位置继续", source)
        self.assertIn("publicProgressSubject(message)", source)
        self.assertIn("typePublicProgress(pendingText", source)
        self.assertIn("typePublicProgress(title", source)
        self.assertIn("typePublicProgress(detail", source)
        self.assertIn("prefers-reduced-motion: reduce", source)
        self.assertIn("window.setTimeout(revealNext, delay)", source)
        self.assertIn("startPendingThoughts(pendingId, attachments, message)", source)
        self.assertNotIn("const pendingThoughtStages =", source)
        self.assertIn("advancePublicThoughts();", source)
        self.assertIn("window.setInterval(advancePublicThoughts, 1800)", source)
        self.assertIn("currentEvents.find(event => event.id === stageId)", source)
        self.assertIn('details.closest(".message")?.classList.contains("pending")', source)
        self.assertIn("function uniqueLivePublicEvents(events, limit = 3)", source)
        self.assertIn("function currentRunPublicEvents(project, events", source)
        self.assertIn("isLegacyGenericPublicEvent(event)", source)
        self.assertIn("? scopedEvents.slice(-1)", source)
        self.assertIn(": uniqueLivePublicEvents(currentRunPublicEvents(project, scopedEvents))", source)
        self.assertIn("liveProductionTitle(project, events)", source)
        self.assertIn("title?.remove()", source)
        self.assertNotIn("stages[index % stages.length]", source)
        self.assertNotIn("Math.floor(index / stages.length)", source)

    def test_public_progress_inherits_context_only_for_explicit_continuations(self):
        source = APP_JS.read_text(encoding="utf-8")
        script = f"""
import vm from "node:vm";
const appSource = {json.dumps(source)};
const start = appSource.indexOf("const simpleGreetingPattern");
const end = appSource.indexOf("function stopPendingThoughts");
const context = vm.createContext({{
  state: {{ project: {{
    name: "校园规则怪谈",
    messages: [
      {{ role: "user", content: "帮我做一个校园规则怪谈的视频" }},
      {{ role: "assistant", content: "好的" }},
    ],
  }} }},
  assistantText: (value) => String(value || ""),
}});
vm.runInContext(appSource.slice(start, end) + "\\nthis.stagesFor = pendingThoughtStagesFor;", context);
const greeting = context.stagesFor("你好", []);
const continuation = context.stagesFor("继续上一条内容", []);
const edit = context.stagesFor("把字幕缩短一点", []);
const newTask = context.stagesFor("帮我做一个产品介绍视频", []);
console.log(JSON.stringify({{ greeting, continuation, edit, newTask }}));
"""
        result = run_node(script)
        self.assertEqual(result["greeting"][0][0], "识别问候意图")
        self.assertNotIn("校园规则怪谈", result["greeting"][0][1])
        self.assertEqual(result["continuation"][0][0], "识别为承接请求")
        self.assertIn("校园规则怪谈", result["continuation"][0][1])
        self.assertEqual(result["edit"][1][0], "定位本轮修改范围")
        self.assertIn("把字幕缩短一点", result["edit"][1][1])
        self.assertEqual(result["newTask"][0][0], "提取本轮制作要求")
        self.assertNotIn("校园规则怪谈", result["newTask"][0][1])

    def test_running_progress_hides_legacy_placeholders_and_deduplicates_display_only(self):
        source = APP_JS.read_text(encoding="utf-8")
        script = f"""
import vm from "node:vm";
const appSource = {json.dumps(source)};
const start = appSource.indexOf("function isLegacyGenericPublicEvent");
const end = appSource.indexOf("function createLiveProductionIndicator");
const context = vm.createContext({{
  assistantText: (value) => String(value || ""),
  publicProgressSubject: (value) => String(value || "").trim(),
}});
vm.runInContext(
  appSource.slice(start, end)
    + "\\nthis.currentEvents = currentRunPublicEvents; this.uniqueEvents = uniqueLivePublicEvents; this.liveTitle = liveProductionTitle;",
  context,
);
const legacyThinking = {{
  id: "legacy-thinking",
  title: "正在思考",
  detail: "正在理解这条消息，并判断应当回答、追问还是开始制作。",
}};
const legacyQuestion = {{
  id: "legacy-question",
  title: "等待补充关键信息",
  detail: "导演只保留了一个会显著影响成片的问题。",
}};
const current = {{
  id: "current",
  at: "2026-08-10T20:00:02+08:00",
  title: "正在核对本轮要求",
  detail: "只处理本轮校园规则怪谈视频。",
}};
const staleFinished = {{
  id: "stale-finished",
  at: "2026-08-10T19:40:00+08:00",
  title: "成片与画幅质检完成",
  detail: "这是上一轮已经完成的事件。",
}};
const events = [staleFinished, legacyThinking, legacyQuestion, legacyThinking, current, {{ ...current, id: "current-copy" }}];
const project = {{
  runStartedAt: "2026-08-10T20:00:00+08:00",
  messages: [{{ role: "user", content: "校园规则怪谈" }}],
}};
console.log(JSON.stringify({{
  scoped: context.currentEvents(project, events),
  visible: context.uniqueEvents(context.currentEvents(project, events)),
  visibleTitle: context.liveTitle(project, events),
  fallbackTitle: context.liveTitle(project, [{{ ...legacyThinking, at: "2026-08-10T20:00:00+08:00" }}]),
  untouchedCount: events.length,
}}));
"""
        result = run_node(script)
        self.assertNotIn("成片与画幅质检完成", [event["title"] for event in result["scoped"]])
        self.assertEqual(1, len(result["visible"]))
        self.assertEqual("正在核对本轮要求", result["visible"][0]["title"])
        self.assertEqual("正在核对本轮要求", result["visibleTitle"])
        self.assertEqual('正在处理“校园规则怪谈”', result["fallbackTitle"])
        self.assertEqual(6, result["untouchedCount"])

    def test_ordinary_http_without_random_uuid_keeps_attachments_and_chat_retryable(self):
        source = APP_JS.read_text(encoding="utf-8")
        script = f"""
import vm from "node:vm";

const appSource = {json.dumps(source)};
const bootMarker = 'dom.startForm.addEventListener("submit"';
const bootIndex = appSource.indexOf(bootMarker);
if (bootIndex < 0) throw new Error("video workshop boot marker missing");

class FakeClassList {{
  constructor() {{ this.values = new Set(); }}
  add(...items) {{ items.forEach((item) => this.values.add(item)); }}
  remove(...items) {{ items.forEach((item) => this.values.delete(item)); }}
  toggle(item, force) {{
    const enabled = force === undefined ? !this.values.has(item) : Boolean(force);
    if (enabled) this.values.add(item); else this.values.delete(item);
    return enabled;
  }}
  contains(item) {{ return this.values.has(item); }}
}}

class FakeStyle {{
  constructor() {{ this.values = {{}}; this.height = ""; }}
  setProperty(key, value) {{ this.values[key] = value; }}
}}

class FakeElement {{
  constructor(tagName = "div") {{
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = {{}};
    this.classList = new FakeClassList();
    this.style = new FakeStyle();
    this.dataset = {{}};
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.submitButton = null;
  }}
  append(...items) {{ this.children.push(...items); }}
  replaceChildren(...items) {{ this.children = [...items]; }}
  addEventListener(type, handler) {{
    (this.listeners[type] ||= []).push(handler);
  }}
  setAttribute(name, value) {{ this[name] = String(value); }}
  querySelector(selector) {{
    if (selector === "button[type='submit']" || selector === 'button[type="submit"]') {{
      return this.submitButton;
    }}
    return null;
  }}
  querySelectorAll() {{ return []; }}
  closest() {{ return null; }}
  focus() {{}}
  scrollIntoView() {{}}
  scrollTo() {{}}
}}
class HTMLVideoElement extends FakeElement {{ constructor() {{ super("video"); }} }}
class HTMLAudioElement extends FakeElement {{ constructor() {{ super("audio"); }} }}

const elements = new Map();
const elementFor = (selector) => {{
  if (!elements.has(selector)) elements.set(selector, new FakeElement());
  return elements.get(selector);
}};
const startForm = elementFor("#startForm");
const chatForm = elementFor("#chatForm");
startForm.submitButton = new FakeElement("button");
chatForm.submitButton = new FakeElement("button");
const attachmentStrip = new FakeElement();
const startLine = elementFor(".start-input-line");

const document = {{
  body: new FakeElement("body"),
  querySelector(selector) {{ return elementFor(selector); }},
  querySelectorAll(selector) {{
    return selector === "[data-attachment-strip]" ? [attachmentStrip] : [];
  }},
  createElement(tagName) {{
    if (tagName === "video") return new HTMLVideoElement();
    if (tagName === "audio") return new HTMLAudioElement();
    return new FakeElement(tagName);
  }},
}};

class FileReader {{
  readAsDataURL(file) {{
    queueMicrotask(() => {{
      if (file.fail) {{
        this.onerror?.(new Error("simulated file read failure"));
        return;
      }}
      this.result = file.dataUrl || "data:image/png;base64,AA==";
      this.onload?.();
    }});
  }}
}}

const windowObject = {{
  __XINGZHEN_VIDEO_PROJECT_KEY__: "video-test-project",
  location: {{ search: "", origin: "http://ordinary-http.test" }},
  parent: null,
  lucide: null,
  addEventListener() {{}},
  setTimeout(callback) {{ if (typeof callback === "function") callback(); return 1; }},
  clearTimeout() {{}},
  setInterval() {{ return 1; }},
  clearInterval() {{}},
  requestAnimationFrame(callback) {{ callback(); }},
}};
windowObject.parent = windowObject;

const context = vm.createContext({{
  console,
  document,
  window: windowObject,
  localStorage: {{ getItem() {{ return ""; }}, setItem() {{}}, removeItem() {{}} }},
  URLSearchParams,
  FileReader,
  HTMLVideoElement,
  HTMLAudioElement,
  queueMicrotask,
  crypto: {{
    calls: 0,
    getRandomValues(bytes) {{
      this.calls += 1;
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index + this.calls;
      return bytes;
    }},
    // randomUUID intentionally absent: ordinary HTTP / older embedded browser.
  }},
  fetch: async () => {{ throw new Error("fetch not installed"); }},
}});

const testExports = `
renderConversation = (project) => {{ globalThis.__lastConversation = project; }};
renderEvents = (project) => {{ globalThis.__lastEvents = project.events || []; }};
renderProject = (project) => {{ state.project = project; state.projectId = project.id || state.projectId; }};
upsertHistoryProject = () => {{}};
loadHistory = async () => [];
loadProject = async () => state.project;
enterStudio = () => {{}};
refreshIcons = () => {{}};
globalThis.__hooks = {{
  state, dom, createClientId, addFiles, renderAttachments, isolatePendingAttachments,
  renderPendingRequest, sendMessage,
  attachmentStrip: document.querySelectorAll("[data-attachment-strip]")[0],
  failNextPendingRequest() {{
    const originalRenderPendingRequest = renderPendingRequest;
    renderPendingRequest = (...args) => {{
      renderPendingRequest = originalRenderPendingRequest;
      throw new Error("simulated synchronous preparation failure");
    }};
  }},
}};
`;
vm.runInContext(appSource.slice(0, bootIndex) + testExports, context);
const hooks = context.__hooks;

const firstId = hooks.createClientId();
const secondId = hooks.createClientId();
if (!firstId || firstId === secondId) throw new Error("fallback client IDs are not unique");

hooks.state.projectId = "project-with-history";
hooks.state.project = {{
  id: "project-with-history",
  assets: Array.from({{ length: 8 }}, (_, index) => ({{
    asset_id: `old-${{index + 1}}`,
    label: `旧图${{index + 1}}`,
    mime: "image/png",
  }})),
}};

const goodFile = {{
  name: "reference.png",
  type: "image/png",
  size: 128,
  dataUrl: "data:image/png;base64,AAAA",
}};
const added = await hooks.addFiles([goodFile]);
if (added !== 1 || hooks.state.attachments.length !== 1) throw new Error("attachment was not added");
if (hooks.attachmentStrip.children.length !== 1) throw new Error("attachment preview was not rendered");
if (!hooks.state.attachments[0].id) throw new Error("attachment client ID missing");

const failingFile = {{ ...goodFile, name: "broken.png", fail: true }};
const failedAdd = await hooks.addFiles([failingFile]);
if (failedAdd !== 0) throw new Error("failed file unexpectedly added");
if (!hooks.dom.toast.textContent.includes("读取失败")) throw new Error("file error was not toasted");
failingFile.fail = false;
const retryAdd = await hooks.addFiles([failingFile]);
if (retryAdd !== 1) throw new Error("failed attachment could not be retried");

const fillFiles = Array.from({{ length: 6 }}, (_, index) => ({{
  ...goodFile,
  name: `reference-${{index + 3}}.png`,
}}));
const filled = await hooks.addFiles(fillFiles);
if (filled !== 6 || hooks.state.attachments.length !== 8) {{
  throw new Error("historical project assets incorrectly consumed the per-message attachment limit");
}}
if (hooks.state.attachments[0].label !== "图1" || hooks.state.attachments[7].label !== "图8") {{
  throw new Error("per-message attachment labels did not start from 图1");
}}
const ninth = await hooks.addFiles([{{ ...goodFile, name: "reference-9.png" }}]);
if (ninth !== 0 || hooks.state.attachments.length !== 8) {{
  throw new Error("ninth attachment was not rejected for the current message");
}}

const pendingId = hooks.renderPendingRequest("先预览 pending", [...hooks.state.attachments]);
if (!pendingId || !hooks.state.project.messages.some((item) => item.kind === "pending")) {{
  throw new Error("optimistic pending request was not rendered");
}}

hooks.state.project = null;
hooks.state.projectId = "";
hooks.state.attachments = [hooks.state.attachments[0]];
const chatCalls = [];
context.fetch = async (url, options) => {{
  chatCalls.push({{ url, options }});
  return {{
    ok: true,
    async json() {{
      return {{
        id: "project-success",
        status: "waiting",
        messages: [],
        events: [],
        outputs: [],
        assets: Array.from({{ length: 8 }}, (_, index) => ({{ asset_id: `saved-${{index + 1}}` }})),
      }};
    }},
  }};
}};
await hooks.sendMessage("创建一条测试视频", true);
if (chatCalls.length !== 1 || chatCalls[0].url !== "/api/chat") throw new Error("/api/chat was not requested");
const sent = JSON.parse(chatCalls[0].options.body);
if (sent.attachments.length !== 1 || sent.message !== "创建一条测试视频") throw new Error("chat payload is incomplete");
if (hooks.state.busy) throw new Error("busy remained locked after success");
if (hooks.state.attachments.length !== 0) throw new Error("successful request did not clear its attachment queue");

hooks.state.projectId = "project-with-pending-usage";
hooks.state.project = {{
  id: "project-with-pending-usage",
  status: "succeeded",
  messages: [],
  events: [],
  outputs: [],
}};
const protectedConversationCalls = [];
context.fetch = async (url, options) => {{
  protectedConversationCalls.push({{ url, options }});
  return {{
    ok: false,
    status: 409,
    async json() {{
      return {{ detail: {{ code: "video_workshop_usage_pending", message: "历史用量待处理" }} }};
    }},
  }};
}};
await hooks.sendMessage("在原会话保留", false);
if (protectedConversationCalls.map(item => item.url).join(",") !== "/api/chat") {{
  throw new Error("pending usage unexpectedly created or retried another conversation");
}}
if (hooks.state.projectId !== "project-with-pending-usage") {{
  throw new Error("pending usage changed the active conversation");
}}
if (!hooks.dom.toast.textContent.includes("可切换其他会话正常使用")) {{
  throw new Error("same-conversation preservation was not explained to the user");
}}
if (hooks.state.busy) throw new Error("busy remained locked after preserving the current conversation");

const freshAdded = await hooks.addFiles([{{ ...goodFile, name: "next-round.png" }}]);
if (freshAdded !== 1 || hooks.state.attachments[0].label !== "图1") {{
  throw new Error("next message did not restart attachment numbering from 图1");
}}
const nextRoundAttachment = hooks.state.attachments[0];
const isolatedCount = hooks.isolatePendingAttachments("project-other");
if (isolatedCount !== 1 || hooks.state.attachments.length !== 0) {{
  throw new Error("pending attachments crossed project boundaries");
}}

hooks.state.attachments = [{{ ...nextRoundAttachment, id: hooks.createClientId() }}];
context.fetch = async () => {{ throw new Error("simulated chat network failure"); }};
await hooks.sendMessage("失败后可重试", false);
if (hooks.state.busy) throw new Error("busy remained locked after failure");
if (hooks.dom.chatInput.disabled || hooks.dom.chatForm.submitButton.disabled) {{
  throw new Error("composer remained disabled after failure");
}}
if (hooks.dom.chatInput.value !== "失败后可重试") throw new Error("failed message draft was not restored");
if (hooks.state.attachments.length !== 1) throw new Error("failed request attachments were not restored");
if (!hooks.dom.toast.textContent.includes("simulated chat network failure")) {{
  throw new Error("chat failure was not toasted");
}}
const networkRetryDraft = hooks.dom.chatInput.value;
const networkRestoredAttachments = hooks.state.attachments.length;

const fetchCallsBeforeSyncFailure = chatCalls.length;
hooks.state.project = null;
hooks.state.projectId = "";
hooks.state.attachments = [{{ ...sent.attachments[0], id: hooks.createClientId() }}];
hooks.dom.startInput.value = "";
hooks.failNextPendingRequest();
await hooks.sendMessage("同步准备失败后可重试", true);
if (chatCalls.length !== fetchCallsBeforeSyncFailure) {{
  throw new Error("synchronous preparation failure unexpectedly reached /api/chat");
}}
if (hooks.state.busy) throw new Error("busy remained locked after synchronous preparation failure");
if (hooks.dom.startInput.disabled || hooks.dom.startForm.submitButton.disabled) {{
  throw new Error("start composer remained disabled after synchronous preparation failure");
}}
if (hooks.dom.startInput.value !== "同步准备失败后可重试") {{
  throw new Error("synchronous failure draft was not restored");
}}
if (hooks.state.attachments.length !== 1) {{
  throw new Error("synchronous failure attachments were not restored");
}}
if (!hooks.dom.toast.textContent.includes("simulated synchronous preparation failure")) {{
  throw new Error("synchronous preparation failure was not toasted");
}}

console.log(JSON.stringify({{
  firstId,
  secondId,
  previewCount: hooks.attachmentStrip.children.length,
  pendingId,
  chatCalls: chatCalls.length,
  busyRecovered: hooks.state.busy === false,
  retryDraft: networkRetryDraft,
  restoredAttachments: networkRestoredAttachments,
  currentMessageLimit: filled + 2,
  protectedConversationCalls: protectedConversationCalls.length,
  nextRoundLabel: nextRoundAttachment.label,
  isolatedCount,
  syncFailureDraft: hooks.dom.startInput.value,
  syncFailureRecovered: hooks.state.busy === false,
}}));
"""
        result = run_node(script)
        self.assertNotEqual(result["firstId"], result["secondId"])
        self.assertGreaterEqual(result["previewCount"], 1)
        self.assertTrue(result["pendingId"])
        self.assertEqual(result["chatCalls"], 1)
        self.assertTrue(result["busyRecovered"])
        self.assertEqual(result["retryDraft"], "失败后可重试")
        self.assertEqual(result["restoredAttachments"], 1)
        self.assertEqual(result["currentMessageLimit"], 8)
        self.assertEqual(result["protectedConversationCalls"], 1)
        self.assertEqual(result["nextRoundLabel"], "图1")
        self.assertEqual(result["isolatedCount"], 1)
        self.assertEqual(result["syncFailureDraft"], "同步准备失败后可重试")
        self.assertTrue(result["syncFailureRecovered"])

    def test_all_client_ids_use_fallback_helper_and_event_paths_report_errors(self):
        source = APP_JS.read_text(encoding="utf-8")
        index = INDEX_HTML.read_text(encoding="utf-8")

        self.assertIn("function createClientId()", source)
        self.assertNotIn("crypto.randomUUID()", source)
        self.assertEqual(source.count("id: createClientId()"), 2)
        self.assertEqual(source.count("const pendingId = createClientId()"), 1)
        self.assertIn('document.addEventListener("drop", async (event) => {', source)
        self.assertIn('textarea.addEventListener("paste", async (event) => {', source)
        self.assertIn('dom.fileInput.addEventListener("change", async () => {', source)
        self.assertGreaterEqual(source.count("showAttachmentError(error)"), 4)
        self.assertIn("app.js?v=20260813-v1432-publish-export-1", index)
        self.assertIn("styles.css?v=20260813-v1432-publish-export-1", index)
        self.assertIn(
            'VIDEO_WORKSHOP_BUILD_ID = "20260813-v1432-publish-export-1"',
            (ROOT / "app" / "main.py").read_text(encoding="utf-8"),
        )
        self.assertIn("projectAssetsButton", index)
        self.assertNotIn("projectAssetsModal", index)
        self.assertNotIn("projectAsset:", source)
        self.assertIn("createChatDeliveryCard", source)
        self.assertIn('document.documentElement.classList.remove("app-booting")', source)
        self.assertIn('type: "custom-video:project"', source)
        self.assertIn("bootstrapApplication", source)
        self.assertIn("else if (WORKSPACE_MODE && !historyItems.length)", source)
        self.assertIn("await createNewConversation();", source)
        self.assertIn('chatSubmitButton.classList.toggle("is-stop", running)', source)
        self.assertIn('chatSubmitButton.dataset.runningStop = running ? "true" : "false"', source)
        self.assertIn('chatAttachmentButton.disabled = running', source)
        self.assertIn('data?.detail?.code === "video_workshop_usage_pending"', source)
        self.assertIn('"该旧会话仍在安全收口；已保留输入，可切换其他会话正常使用"', source)
        self.assertIn('dom.toast.textContent.includes("安全收口")', source)
        self.assertIn('Number(reconciliation?.pending || 0) === 0', source)
        self.assertIn('Number(reconciliation?.conflicts || 0) === 0', source)
        self.assertNotIn('fetch("/api/projects"', source.split("async function sendMessage", 1)[1].split("async function retryProject", 1)[0])
        self.assertIn("function apiErrorMessage(data, fallback)", source)
        self.assertIn('detail.message || detail.detail', source)

    def test_editor_layers_pip_above_main_video_and_previews_real_subtitles(self):
        source = APP_JS.read_text(encoding="utf-8")
        index = INDEX_HTML.read_text(encoding="utf-8")
        styles = STYLES_CSS.read_text(encoding="utf-8")

        label_order = index.index("V2 画中画"), index.index("V1 主画面")
        track_order = index.index('id="videoEditorOverlayTrack"'), index.index('id="videoEditorVideoTrack"')
        self.assertLess(*label_order)
        self.assertLess(*track_order)
        self.assertLess(index.index("A1 口播"), index.index("A2 配乐"))
        self.assertLess(index.index("A2 配乐"), index.index("A3 音效"))
        self.assertLess(index.index('id="videoEditorAudioTrack"'), index.index('id="videoEditorBgmTrack"'))
        self.assertLess(index.index('id="videoEditorBgmTrack"'), index.index('id="videoEditorSfxTrack"'))
        self.assertIn('id="videoEditorOverlayPreviewLayer"', index)
        self.assertIn('id="videoEditorReplacementPreviewLayer"', index)
        self.assertIn('id="videoEditorSubtitleReplaceMask"', index)
        self.assertIn('id="videoEditorSubtitlePreview"', index)
        self.assertNotIn('id="videoEditorPreview" playsinline preload="metadata" controls', index)
        self.assertIn('id="videoEditorScrubber"', index)
        self.assertIn('id="videoEditorSubtitleText"', index)
        self.assertIn('id="videoEditorBgm"', index)
        self.assertIn("function renderVideoEditorPreviewLayers()", source)
        self.assertIn("function startEditorPipCanvasDrag(", source)
        self.assertIn("function startEditorPipCanvasResize(", source)
        self.assertIn("function replaceEditorClipAsset(", source)
        self.assertIn("function editorExternalFiles(", source)
        self.assertIn("async function uploadEditorFiles(", source)
        self.assertIn("async function importEditorFiles(", source)
        self.assertIn('async function importEditorFiles(fileList, { target = "overlay"', source)
        self.assertIn("function installVideoEditorDropZone()", source)
        self.assertIn('dom.videoEditorModal.addEventListener("drop"', source)
        self.assertIn('fetch(`/api/projects/${state.project.id}/assets`', source)
        self.assertIn('types.includes("Files")', source)
        self.assertIn('target: "overlay"', source)
        self.assertIn('target: "clip"', source)
        self.assertIn('target: "bgm"', source)
        self.assertIn('target: "sfx"', source)
        self.assertIn('asset.mime || "").startsWith("video/") ? "video" : "img"', source)
        self.assertIn("syncEditorOverlayVideo(media, overlay, draft)", source)
        self.assertIn('block.classList.add("is-drop-target")', source)
        self.assertIn('item.positionX ?? 1', source)
        self.assertIn('positionX: Number(item.positionX ?? 1)', source)
        self.assertIn('subtitle: String(clip.subtitle || "")', source)
        self.assertIn('bgmSelection: String(draft.bgmSelection || "keep")', source)
        self.assertIn('draft.selected = { type: "subtitle", id: clip.id }', source)
        self.assertIn('draft.selected = { type: "narration", id: "narration" }', source)
        self.assertIn('draft.selected = { type: "bgm", id: "bgm" }', source)
        self.assertIn('dataTransfer.setData("application/x-xingzhen-sfx"', source)
        self.assertIn('draft.subtitleEffect === "去掉字幕"', source)
        self.assertIn("editorSubtitleText(activeRow?.clip)", source)
        self.assertIn("dom.videoEditorSubtitleReplaceMask.hidden = !subtitleText", source)
        self.assertIn("function startVideoEditorPlaybackClock()", source)
        self.assertIn("window.requestAnimationFrame(tick)", source)
        self.assertIn("function stopVideoEditorPlaybackClock()", source)
        self.assertIn('id="videoEditorOverlayEntry"', index)
        self.assertIn('id="videoEditorOverlayExit"', index)
        self.assertNotIn('id="videoEditorClipTransition"', index)
        self.assertNotIn('id="videoEditorClipDuration"', index)
        self.assertNotIn('id="videoEditorClipTrim"', index)
        self.assertIn('id="videoEditorTrackVolume"', index)
        self.assertIn('id="videoEditorSfx"', index)
        self.assertIn('class="video-editor-close"', index)
        self.assertIn("applyEditorPipPreviewEffect", source)
        self.assertIn("showPausedBoundary", source)
        self.assertIn("!showPausedBoundary && elapsed < windowSize", source)
        self.assertIn("transition: String(clip.transition || \"fade\")", source)
        self.assertIn("z-index: 3", styles.split(".video-editor-overlay-preview-layer", 1)[1].split("}", 1)[0])
        self.assertIn("z-index: 2", styles.split(".video-editor-replacement-preview-layer", 1)[1].split("}", 1)[0])
        self.assertIn("z-index: 5", styles.split(".video-editor-subtitle-preview", 1)[1].split("}", 1)[0])
        self.assertIn("background: #000", styles.split(".video-editor-subtitle-replace-mask", 1)[1].split("}", 1)[0])

    def test_timeline_revision_rebuilds_one_canonical_subtitle_track(self):
        media = (ROOT / "app" / "media.py").read_text(encoding="utf-8")
        pipeline = (ROOT / "app" / "pipeline.py").read_text(encoding="utf-8")

        self.assertEqual(media.count("cues = write_ass("), 1)
        self.assertIn("manual_cues=manual_caption_cues", media)
        self.assertIn('[str(unit.get("subtitle") or "") for unit in render_units]', pipeline)

    def test_new_conversation_is_created_and_inserted_into_history_immediately(self):
        source = APP_JS.read_text(encoding="utf-8")

        self.assertIn('const response = await fetch("/api/projects", {', source)
        self.assertIn('method: "POST"', source)
        self.assertIn("upsertHistoryProject(project);", source)
        self.assertIn(
            'dom.historyNewButton.addEventListener("click", createNewConversation);',
            source,
        )
        self.assertIn("historyLoadEpoch", source)

    def test_static_video_mode_is_explicit_and_persists_per_project(self):
        source = APP_JS.read_text(encoding="utf-8")
        index = INDEX_HTML.read_text(encoding="utf-8")
        styles = STYLES_CSS.read_text(encoding="utf-8")

        self.assertEqual(2, index.count('data-creation-mode="static"'))
        self.assertEqual(2, index.count(">动态</button>"))
        self.assertEqual(2, index.count(">静态</button>"))
        self.assertNotIn(">动态视频</button>", index)
        self.assertNotIn(">静态视频</button>", index)
        self.assertIn('creationMode: "video"', source)
        self.assertIn("creationMode: state.creationMode", source)
        self.assertIn("project.creationMode", source)
        self.assertIn("project.plan?.creation_mode", source)
        self.assertIn('syncCreationMode(button.dataset.creationMode', source)
        self.assertIn('state.ratio = mode === "static" ? "16:9" : "9:16"', source)
        self.assertIn(".creation-mode-switch", styles)
        self.assertIn(".creation-mode-switch button.active", styles)
        self.assertIn("message-agent-avatar", source)
        self.assertIn('"/assets/brand/starmatrix-mascot-transparent.png"', source)
        self.assertIn('image.src = "assets/xingzhen-logo-white.png"', source)

    def test_production_heartbeat_uses_one_owner_and_rolls_only_the_stage_copy(self):
        source = APP_JS.read_text(encoding="utf-8")
        styles = STYLES_CSS.read_text(encoding="utf-8")
        render_events = source.split("function renderEvents(project)", 1)[1].split(
            "function selectOutput", 1
        )[0]
        heartbeat = source.split("const productionHeartbeatStages", 1)[1].split(
            "function renderProject", 1
        )[0]

        self.assertIn('className = "production-live-title"', source)
        self.assertIn('className = "production-live-stage-window"', source)
        self.assertIn('className = "production-live-elapsed"', source)
        self.assertNotIn("liveText.textContent", render_events)
        self.assertIn("rotateProductionHeartbeatStage", heartbeat)
        self.assertNotIn('querySelector(".production-live-title")', heartbeat)
        self.assertIn("Math.floor((elapsed - 1) / 6)", heartbeat)
        self.assertIn("window.setInterval(tick, 1000)", heartbeat)
        self.assertIn("productionRunStartedAt(project)", heartbeat)
        self.assertIn("project?.runStartedAt", heartbeat)
        self.assertIn("localStorage.setItem(key, String(startedAt))", heartbeat)
        self.assertIn("productionElapsedLabel(elapsed)", heartbeat)
        self.assertIn("clearProductionRunClock(project.id)", source)
        self.assertIn("details.open = true", source)
        self.assertIn("正在梳理执行步骤", source)
        self.assertIn(".production-live-stage.is-leaving", styles)
        self.assertIn("font-variant-numeric: tabular-nums", styles)
        avatar_css = styles.split(".message-agent-avatar {", 1)[1].split("}", 1)[0]
        self.assertIn("border: 0", avatar_css)
        self.assertIn("background: transparent", avatar_css)
        thinking_css = styles.split(".live-thinking-summary > summary {", 1)[1].split("}", 1)[0]
        self.assertIn("width: fit-content", thinking_css)
        self.assertIn("justify-content: flex-start", thinking_css)
        thinking_events_css = styles.split(".live-thinking-events {", 1)[1].split("}", 1)[0]
        self.assertIn("border: 0", thinking_events_css)
        self.assertIn("background: transparent", thinking_events_css)
        self.assertIn("padding: 2px 0", thinking_events_css)
        thinking_event_row_css = styles.split(".live-thinking-events > div {", 1)[1].split("}", 1)[0]
        self.assertIn("border: 0", thinking_event_row_css)
        self.assertIn("display: flex", thinking_event_row_css)
        working_avatar_css = styles.split(".message-agent-avatar.is-working {", 1)[1].split("}", 1)[0]
        self.assertIn("animation: none", working_avatar_css)
        activity_css = styles.split(".activity-ring {", 1)[1].split("}", 1)[0]
        self.assertIn("animation: none", activity_css)
        self.assertIn("existingItems", render_events)
        self.assertNotIn("list.replaceChildren()", render_events)

    def test_progress_poll_does_not_reload_unchanged_delivery_media(self):
        source = APP_JS.read_text(encoding="utf-8")
        render_delivery = source.split("function renderDelivery(project)", 1)[1].split(
            "const productionHeartbeatStages", 1
        )[0]
        media_signature = render_delivery.split(
            "const mediaSignature =", 1
        )[1].split("const mediaChanged", 1)[0]

        self.assertNotIn("project.updatedAt", media_signature)
        for output_field in (
            'item.id || ""',
            "item.url",
            "item.aspectRatio",
            "item.probe?.duration",
            'item.updatedAt || ""',
        ):
            self.assertIn(output_field, render_delivery)
        self.assertIn("const mediaChanged = mediaSignature !== state.outputMediaSignature", render_delivery)
        self.assertIn("{ forceReload: mediaChanged }", render_delivery)


if __name__ == "__main__":
    unittest.main()
