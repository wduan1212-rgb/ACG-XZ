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
  setTimeout() {{ return 1; }},
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
        self.assertEqual(result["nextRoundLabel"], "图1")
        self.assertEqual(result["isolatedCount"], 1)
        self.assertEqual(result["syncFailureDraft"], "同步准备失败后可重试")
        self.assertTrue(result["syncFailureRecovered"])

    def test_all_client_ids_use_fallback_helper_and_event_paths_report_errors(self):
        source = APP_JS.read_text(encoding="utf-8")
        index = INDEX_HTML.read_text(encoding="utf-8")

        self.assertIn("function createClientId()", source)
        self.assertNotIn("crypto.randomUUID()", source)
        self.assertEqual(source.count("id: createClientId()"), 1)
        self.assertEqual(source.count("const pendingId = createClientId()"), 1)
        self.assertIn('document.addEventListener("drop", async (event) => {', source)
        self.assertIn('textarea.addEventListener("paste", async (event) => {', source)
        self.assertIn('dom.fileInput.addEventListener("change", async () => {', source)
        self.assertGreaterEqual(source.count("showAttachmentError(error)"), 4)
        self.assertIn("app.js?v=20260727-v120-shell-6", index)
        self.assertIn("styles.css?v=20260727-v120-shell-6", index)

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
        self.assertIn(".production-live-stage.is-leaving", styles)
        self.assertIn("font-variant-numeric: tabular-nums", styles)

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
