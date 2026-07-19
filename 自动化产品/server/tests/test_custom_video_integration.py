import tempfile
import unittest
import sys
import json
import subprocess
from pathlib import Path

APP_DIR = Path(__file__).resolve().parents[2]
VIDEO_WORKSHOP_DIR = APP_DIR / "apps" / "video-workshop"
TEST_DIR = Path(__file__).resolve().parent
if str(TEST_DIR) not in sys.path:
    sys.path.insert(0, str(TEST_DIR))

from test_store_tombstone import load_isolated_store


class CustomVideoIntegrationTest(unittest.TestCase):
    def test_video_outputs_keep_independent_publish_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            project, error = store.save_custom_project("creator-a", {
                "kind": "video",
                "title": "多成片独立发布",
                "projectState": {
                    "integration": "video-workshop",
                    "workshopProjectId": "workshop-independent",
                },
            })
            self.assertIsNone(error)
            store.upsert_docs("accounts", [{
                "id": "account-video",
                "name": "视频账号",
                "mode": "视频",
                "monthlyDone": 0,
                "exportSeq": 0,
                "updatedAt": 1,
            }])

            def bundle(suffix):
                delivery_id = f"delivery-{suffix}"
                source_id = f"source-{suffix}"
                cover_id = f"cover-{suffix}"
                delivery = {
                    "id": delivery_id,
                    "ownerId": "creator-a",
                    "accountId": "account-video",
                    "type": "视频",
                    "title": suffix,
                    "delivered": True,
                    "customProjectId": project["id"],
                    "byMemberId": "creator-a",
                    "sourceAssetId": source_id,
                    "coverAssetId": cover_id,
                    "videoUrl": f"/api/files/{source_id}",
                    "sourceDeliveryId": f"workshop-delivery-{suffix}",
                    "sourceOutputId": f"workshop-output-{suffix}",
                }
                return {
                    "deliveryId": delivery_id,
                    "delivery": delivery,
                    "assets": [
                        delivery,
                        {"id": source_id, "ownerId": "creator-a", "accountId": "account-video", "type": "视频"},
                        {"id": cover_id, "ownerId": "creator-a", "accountId": "account-video", "type": "图片"},
                    ],
                    "account": {"id": "account-video"},
                }

            first_bundle = bundle("first")
            second_bundle = bundle("second")
            first, first_error = store.publish_custom_project_bundle(
                project["id"], "creator-a", first_bundle,
            )
            second, second_error = store.publish_custom_project_bundle(
                project["id"], "creator-a", second_bundle,
            )
            self.assertIsNone(first_error)
            self.assertIsNone(second_error)
            published = second["project"]["projectState"]["publishedVideoOutputs"]
            self.assertEqual(set(published), {
                "workshop-output-first", "workshop-output-second",
            })
            self.assertEqual(
                published["workshop-output-first"]["deliveryId"],
                first_bundle["deliveryId"],
            )
            self.assertEqual(
                published["workshop-output-second"]["deliveryId"],
                second_bundle["deliveryId"],
            )

            retracted, retract_error = store.unpublish_custom_project_delivery(
                project["id"], "creator-a", second_bundle["deliveryId"],
            )
            self.assertIsNone(retract_error)
            remaining = retracted["project"]["projectState"]["publishedVideoOutputs"]
            self.assertEqual(set(remaining), {"workshop-output-first"})

    def test_workshop_project_mapping_is_owner_scoped_and_metadata_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = load_isolated_store(tmp)
            workshop_project = {
                "id": "workshop-project-1",
                "name": "产品演示视频",
                "status": "succeeded",
                "phase": "delivery",
                "progress": 100,
                "updatedAt": "2026-07-16T12:00:00+08:00",
                "plan": {"title": "产品演示", "aspect_ratio": "9:16"},
                "messages": [{"role": "user", "content": "不应写入主平台映射"}],
                "outputs": [{
                    "label": "9:16 成片",
                    "aspectRatio": "9:16",
                    "url": "/outputs/workshop-project-1/final-9x16.mp4",
                    "downloadUrl": "/outputs/workshop-project-1/final-9x16.mp4",
                    "probe": {"duration": 18.2, "width": 1080, "height": 1920},
                }],
            }

            mapped, error = store.sync_custom_video_project("creator-a", workshop_project)
            self.assertIsNone(error)
            self.assertEqual(mapped["ownerId"], "creator-a")
            self.assertEqual(
                mapped["projectState"]["workshopProjectId"],
                "workshop-project-1",
            )
            self.assertNotIn("messages", mapped["projectState"])
            self.assertEqual(
                mapped["projectState"]["latestOutput"]["url"],
                "/custom-video/outputs/workshop-project-1/final-9x16.mp4",
            )
            self.assertEqual(
                store.list_custom_video_project_ids("creator-a"),
                ["workshop-project-1"],
            )
            self.assertEqual(store.list_custom_video_project_ids("creator-b"), [])
            self.assertIsNone(
                store.find_custom_video_project("creator-b", "workshop-project-1")
            )

            outputs = store._fetchall(
                "SELECT data FROM docs WHERE collection='customOutputs' AND owner_id=?",
                ("creator-a",),
            )
            self.assertEqual(len(outputs), 1)
            self.assertNotIn("base64", outputs[0][0].lower())

            store.upsert_docs("assets", [{
                "id": "delivery-video-1",
                "ownerId": "creator-a",
                "delivered": True,
                "customProjectId": mapped["id"],
                "byMemberId": "creator-a",
                "accountId": "video-account",
                "updatedAt": 5,
            }])
            published, publish_error = store.mark_custom_project_published(
                mapped["id"], "creator-a", "delivery-video-1",
            )
            self.assertIsNone(publish_error)
            self.assertEqual(published["status"], "published")
            self.assertEqual(published["publishedCount"], 1)

            workshop_project["updatedAt"] = "2026-07-16T12:05:00+08:00"
            workshop_project["progress"] = 99
            resynced, resync_error = store.sync_custom_video_project(
                "creator-a", workshop_project,
            )
            self.assertIsNone(resync_error)
            self.assertEqual(resynced["status"], "published")
            self.assertEqual(resynced["publishedDeliveryId"], "delivery-video-1")
            self.assertEqual(resynced["publishedCount"], 1)

            denied, denied_error = store.sync_custom_video_project(
                "creator-b",
                workshop_project,
            )
            self.assertIsNone(denied)
            self.assertEqual(denied_error, "forbidden")

    def test_sidecar_proxy_and_postmessage_contract_are_present(self):
        backend = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        integration = (
            APP_DIR / "js/views/customVideoIntegration.js"
        ).read_text(encoding="utf-8")

        self.assertIn('VIDEO_WORKSHOP_URL = os.getenv(', backend)
        self.assertIn(
            'os.getenv("VIDEO_WORKSHOP_ROOT", FRONTEND_DIR / "apps" / "video-workshop")',
            backend,
        )
        self.assertIn('@app.post("/api/custom-video/session")', backend)
        self.assertIn('@app.get("/custom-video/")', backend)
        self.assertIn('"/custom-video/api/{api_path:path}"', backend)
        self.assertIn("_video_workshop_project_index", backend)
        self.assertIn("store.sync_custom_video_project", backend)
        self.assertIn('"custom-video:output"', backend)
        self.assertIn('data-platform-embedded="true"', backend)
        self.assertNotIn("from 视频工坊产品试验", backend)

        self.assertIn("export function mountCustomVideo(", integration)
        self.assertIn('const entryUrl = "/custom-video/?embed=1&start=home"', integration)
        self.assertIn("frame.src = entryUrl", integration)
        self.assertIn('frame.src = entryUrl + "&ts="', integration)
        self.assertIn("getLatestOutput:", integration)
        self.assertIn("onOutput(listener)", integration)
        self.assertIn("markPublished(", integration)
        self.assertIn("publishedCount", integration)
        self.assertIn("(retry|cancel)", backend)
        for field in (
            "kind: \"video\"",
            "projectId",
            "title",
            "videoUrl",
            "downloadUrl",
            "aspectRatio",
            "plan",
            "project",
        ):
            self.assertIn(field, integration)

    def test_embedded_workshop_hides_duplicate_header_and_guards_ime_enter(self):
        html = (VIDEO_WORKSHOP_DIR / "web/index.html").read_text(encoding="utf-8")
        css = (
            VIDEO_WORKSHOP_DIR / "web/assets/styles.css"
        ).read_text(encoding="utf-8")
        javascript = (
            VIDEO_WORKSHOP_DIR / "web/assets/app.js"
        ).read_text(encoding="utf-8")

        self.assertIn("styles.css?v=20260719-17", html)
        self.assertIn("app.js?v=20260719-17", html)
        self.assertIn(
            '<h1 class="brand-kicker brand-title" id="startTitle">'
            "XINGZHEN VIDEO WORKSHOP</h1>",
            html,
        )
        self.assertNotIn('<h1 id="startTitle">视频导演台</h1>', html)
        self.assertIn(".start-core .brand-title", css)
        self.assertIn("text-align: center", css)
        self.assertIn(
            'new URLSearchParams(window.location.search).get("embed") === "1"',
            html,
        )
        self.assertIn(
            'document.documentElement.dataset.platformEmbedded = "true"',
            html,
        )
        self.assertIn('id="serviceStateText"', html)
        self.assertIn('id="publishOutputButton"', html)
        self.assertIn(">发布成片<", html)
        self.assertIn(
            'html[data-platform-embedded="true"] .studio-header',
            css,
        )
        self.assertIn(
            'html[data-platform-embedded="true"] .studio-view',
            css,
        )
        self.assertIn("grid-template-rows: minmax(0, 1fr)", css)
        self.assertIn("display: none", css)

        for token in (
            'input.addEventListener("compositionstart"',
            'input.addEventListener("compositionend"',
            "event.isComposing",
            "event.keyCode === 229",
            "event.which === 229",
            "keepCompositionEnterLocal(event, textarea)",
            "keepCompositionEnterLocal(event, input)",
            'event.key === "Enter" && !event.shiftKey',
            'type: "custom-video:publish-request"',
            "selectedPublishPayload()",
            'project?.status !== "succeeded"',
            'document.documentElement.dataset.platformEmbedded === "true"',
            'message.type !== "custom-video:published"',
            "publishedOutputBadge",
            "assistantText(",
            "publishedCountFor(",
            "deliveryToggleButton",
            "stopProject(",
            "/cancel",
            "pendingScrollMessageId",
            'scrollIntoView({ block: "center", behavior: "smooth" })',
        ):
            self.assertIn(token, javascript)
        self.assertIn("history-published-badge", css)
        self.assertIn("published-output-badge", css)
        self.assertIn('id="historyDeliveryButton"', html)
        self.assertIn('id="historyDeliveryFilter"', html)
        self.assertIn("publishedOutputMap(project)", javascript)
        self.assertIn("sourceOutputId", javascript)
        self.assertIn("delivery-toggle-button", css)
        self.assertIn("stop-production-button", css)
        self.assertIn('id="deliveryToggleButton"', html)

        helper_start = javascript.index("const compositionStates = new WeakMap();")
        helper_end = javascript.index("function publicText", helper_start)
        helper_source = javascript[helper_start:helper_end]
        behavior_check = f"""
global.window = {{ setTimeout: () => 0 }};
{helper_source}
function fakeInput() {{
  const listeners = {{}};
  return {{
    listeners,
    addEventListener(name, callback) {{ listeners[name] = callback; }},
  }};
}}
const composing = fakeInput();
trackComposition(composing);
composing.listeners.compositionstart();
if (!enterConfirmsComposition({{
  key: "Enter", isComposing: false, keyCode: 13, which: 13,
}}, composing)) throw new Error("active composition Enter was not guarded");
composing.listeners.compositionend();
let prevented = false;
if (!keepCompositionEnterLocal({{
  key: "Enter",
  isComposing: false,
  keyCode: 13,
  which: 13,
  preventDefault() {{ prevented = true; }},
}}, composing) || !prevented) throw new Error("post-composition Enter was not contained");
const normal = fakeInput();
trackComposition(normal);
if (enterConfirmsComposition({{
  key: "Enter", isComposing: false, keyCode: 13, which: 13,
}}, normal)) throw new Error("normal Enter was incorrectly blocked");
if (!enterConfirmsComposition({{
  key: "Enter", isComposing: false, keyCode: 229, which: 229,
}}, normal)) throw new Error("keyCode 229 fallback was not guarded");
"""
        subprocess.run(
            ["node", "-e", behavior_check],
            cwd=VIDEO_WORKSHOP_DIR,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_workshop_start_composer_is_slightly_shifted_left_and_up(self):
        css = (
            VIDEO_WORKSHOP_DIR / "web/assets/styles.css"
        ).read_text(encoding="utf-8")
        desktop = css.split(".start-core {", 1)[1].split("}", 1)[0]
        tablet = css.split("@media (max-width: 900px)", 1)[1]
        mobile = css.split("@media (max-width: 560px)", 1)[1]

        self.assertIn("top: -36px;", desktop)
        self.assertIn("left: -18px;", desktop)
        self.assertIn("width: min(680px, calc(100% - 48px));", desktop)
        self.assertIn(".start-core {\n    grid-column: 1;\n    left: 0;", tablet)
        self.assertIn(".start-core {\n    width: 100%;\n    top: -18px;", mobile)

    def test_assistant_markdown_is_rendered_as_safe_plain_text(self):
        javascript = (
            VIDEO_WORKSHOP_DIR / "web/assets/app.js"
        ).read_text(encoding="utf-8")
        helper_start = javascript.index("function publicText")
        helper_end = javascript.index("function refreshIcons", helper_start)
        helper_source = javascript[helper_start:helper_end]
        behavior_check = f"""
{helper_source}
const value = assistantText(
  "## 说明\\n1. **这个目标是什么？**\\n- `重点` <img src=x onerror=alert(1)>"
);
if (value.includes("**") || value.includes("##") || value.includes("`")) {{
  throw new Error(`markdown marker leaked: ${{value}}`);
}}
if (!value.includes("这个目标是什么？") || !value.includes("重点")) {{
  throw new Error(`plain content was lost: ${{value}}`);
}}
if (!value.includes("<img src=x onerror=alert(1)>")) {{
  throw new Error("sanitizer unexpectedly interpreted HTML instead of returning text");
}}
"""
        subprocess.run(
            ["node", "-e", behavior_check],
            cwd=VIDEO_WORKSHOP_DIR,
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertIn("content.textContent =", javascript)
        self.assertNotIn("content.innerHTML =", javascript)

    def test_embedded_entry_starts_on_home_without_erasing_history_selection(self):
        integration = (
            APP_DIR / "js/views/customVideoIntegration.js"
        ).read_text(encoding="utf-8")
        javascript = (
            VIDEO_WORKSHOP_DIR / "web/assets/app.js"
        ).read_text(encoding="utf-8")
        self.assertIn('const entryUrl = "/custom-video/?embed=1&start=home"', integration)
        self.assertIn(
            'new URLSearchParams(window.location.search).get("start") === "home"',
            javascript,
        )
        self.assertIn(
            'projectId: START_ON_HOME ? "" : localStorage.getItem(PROJECT_STORAGE_KEY) || ""',
            javascript,
        )
        self.assertIn("localStorage.setItem(PROJECT_STORAGE_KEY, project.id)", javascript)
        self.assertIn("loadProject(project.id)", javascript)

        bootstrap = javascript[:javascript.index("const dom =")]
        home_check = f"""
global.window = {{
  __XINGZHEN_VIDEO_PROJECT_KEY__: "member-project-key",
  location: {{ search: "?embed=1&start=home" }},
}};
global.localStorage = {{
  getItem(key) {{
    if (key !== "member-project-key") throw new Error("wrong storage key");
    return "remembered-project";
  }},
}};
{bootstrap}
if (state.projectId !== "") {{
  throw new Error(`embedded entry restored ${{state.projectId}} instead of home`);
}}
"""
        subprocess.run(
            ["node", "-e", home_check],
            cwd=VIDEO_WORKSHOP_DIR,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_output_ratio_reselection_does_not_reload_the_same_video(self):
        javascript = (
            VIDEO_WORKSHOP_DIR / "web/assets/app.js"
        ).read_text(encoding="utf-8")
        helper_start = javascript.index("function selectOutput(index,")
        helper_end = javascript.index("function selectedPublishPayload", helper_start)
        helper_source = javascript[helper_start:helper_end]
        behavior_check = f"""
let loadCount = 0;
global.document = {{
  createElement() {{ return {{ textContent: "" }}; }},
}};
const buttons = [
  {{ classList: {{ toggle() {{}} }} }},
];
const outputVideo = {{
  dataset: {{}},
  src: "",
  getAttribute(name) {{ return name === "src" ? this.src : ""; }},
  load() {{ loadCount += 1; }},
}};
const outputMeta = {{
  items: [],
  replaceChildren() {{ this.items = []; }},
  append(item) {{ this.items.push(item); }},
}};
const state = {{
  outputIndex: 0,
  project: {{
    outputs: [{{
      url: "/outputs/final-9x16.mp4",
      downloadUrl: "/outputs/final-9x16.mp4",
      aspectRatio: "9:16",
      probe: {{ width: 1080, height: 1920, duration: 12, hasAudio: true }},
    }}],
  }},
}};
const dom = {{
  outputTabs: {{ querySelectorAll() {{ return buttons; }} }},
  outputVideo,
  outputMeta,
  downloadButton: {{}},
}};
{helper_source}
selectOutput(0);
selectOutput(0);
if (loadCount !== 1) throw new Error(`same output reloaded ${{loadCount}} times`);
if (outputVideo.dataset.outputUrl !== "/outputs/final-9x16.mp4") {{
  throw new Error("selected output URL was not memoized");
}}
"""
        subprocess.run(
            ["node", "-e", behavior_check],
            cwd=VIDEO_WORKSHOP_DIR,
            check=True,
            capture_output=True,
            text=True,
        )

    def test_health_distinguishes_required_services_from_optional_capabilities(self):
        code = """
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch
import app.main as module

module.settings = SimpleNamespace(
    live=True,
    llm_api_key="configured",
    llm_model="root-model",
    llm_thinking="adaptive",
    seedance_api_key="configured",
    seedance_model="video-model",
    minimax_api_key="configured",
    minimax_tts_model="voice-model",
    minimax_voice_id="voice-id",
    asr_model="small",
    bgm_source="platform",
)
module.bgm_library = SimpleNamespace(catalog=lambda: [])
module.transcriber = SimpleNamespace(available=False)
module.openmontage = SimpleNamespace(available=True)
with patch.object(module.shutil, "which", return_value="/usr/bin/tool"):
    degraded = asyncio.run(module.health())
module.settings.llm_api_key = ""
with patch.object(module.shutil, "which", return_value="/usr/bin/tool"):
    incomplete = asyncio.run(module.health())
print(json.dumps({"degraded": degraded, "incomplete": incomplete}, ensure_ascii=False))
"""
        result = subprocess.run(
            [sys.executable, "-c", code],
            cwd=VIDEO_WORKSHOP_DIR,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)
        degraded = payload["degraded"]
        self.assertTrue(degraded["ready"])
        self.assertEqual(degraded["status"], "degraded")
        self.assertEqual(degraded["missingRequired"], [])
        self.assertEqual(
            degraded["optionalUnavailable"],
            ["口播音频转写", "共享 BGM"],
        )
        self.assertTrue(degraded["services"]["director"]["configured"])
        self.assertTrue(degraded["services"]["director"]["required"])
        self.assertFalse(degraded["services"]["transcription"]["required"])

        incomplete = payload["incomplete"]
        self.assertFalse(incomplete["ready"])
        self.assertEqual(incomplete["status"], "incomplete")
        self.assertEqual(incomplete["missingRequired"], ["导演语言模型"])

    def test_sidecar_reads_root_environment_names_without_exposing_secrets(self):
        config = (
            VIDEO_WORKSHOP_DIR / "app/config.py"
        ).read_text(encoding="utf-8")
        self.assertIn(
            'bundled_main_env = ROOT.parents[1] / ".env.local"',
            config,
        )
        self.assertIn('os.getenv("LLM_MODEL", "MiniMax-M3")', config)
        self.assertIn('os.getenv("LLM_THINKING", "adaptive")', config)
        self.assertIn('os.getenv("LLM_MAX_TOKENS", "16000")', config)
        self.assertNotIn("sk-", config)

    def test_video_publish_requires_live_llm_and_prefers_shared_designed_voice(self):
        ai = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        publish = (APP_DIR / "js/views/customPublish.js").read_text(encoding="utf-8")
        backend = (APP_DIR / "server/main.py").read_text(encoding="utf-8")
        store = (APP_DIR / "server/store.py").read_text(encoding="utf-8")
        config = (VIDEO_WORKSHOP_DIR / "app/config.py").read_text(encoding="utf-8")

        self.assertIn("requireLlm: true", publish)
        self.assertIn("if (requireLlm)", ai)
        self.assertIn("throw lastError instanceof Error", ai)
        self.assertIn("retryableModelOutput", ai)
        self.assertIn("def list_voice_presets():", store)
        self.assertIn("def _video_workshop_preferred_voice(me):", backend)
        self.assertIn('"preferredVoice": _video_workshop_preferred_voice(me)', backend)
        self.assertIn(
            'payload["voiceId"] = _video_workshop_preferred_voice(me)["voiceId"]',
            backend,
        )
        self.assertIn('"presenter_female"', config)
        self.assertNotIn("sk-api-", ai + publish + backend + store + config)

    def test_video_publish_cover_is_locked_to_three_by_four(self):
        workshop = (APP_DIR / "js/views/chainWorkshop.js").read_text(
            encoding="utf-8"
        )
        ensure_cover = workshop.split(
            "export async function ensureVideoCover(p)", 1
        )[1].split("\nexport ", 1)[0]

        self.assertIn('const ratio = "3:4";', ensure_cover)
        self.assertIn("coverPromptFromCopy({", ensure_cover)
        self.assertIn("ratio,", ensure_cover)
        self.assertIn("provider.submit({", ensure_cover)
        self.assertIn("provider.poll(submitted.providerRef)", ensure_cover)

    def test_video_publish_llm_does_not_silently_replace_invalid_copy(self):
        code = r"""
globalThis.localStorage = { getItem(){ return null; }, setItem(){}, removeItem(){} };
globalThis.location = { origin:'http://127.0.0.1:8787', hash:'' };
globalThis.window = { addEventListener(){}, dispatchEvent(){}, __toast(){} };
globalThis.document = { querySelector(){ return null; }, querySelectorAll(){ return []; } };
const modelReplies = [
  {
    title: '国产codex百度搭子自动管理你的知识库！',
    copy: '想要宣传这个产品，画面风格高级。'
  },
  {
    title: '国产codex百度搭子自动管理你的知识库！',
    copy: '我把 Obsidian 里的项目资料交给桌面智能体读取，再按文件来源整理成可复核的知识卡片。实际使用时，我会保留原文链接和更新时间，方便检查遗漏，而不是让模型凭空补内容。\n#Obsidian #知识库 #AI工具 #百度搭子'
  },
  {
    title: '国产codex百度搭子自动管理你的知识库！',
    copy: '想要宣传这个产品，画面风格高级。'
  },
  {
    title: '国产codex百度搭子自动管理你的知识库！',
    copy: '想要宣传这个产品，画面风格高级。'
  },
  {
    title: '国产codex百度搭子自动管理你的知识库！',
    copy: '想要宣传这个产品，画面风格高级。'
  }
];
let requestCount = 0;
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: JSON.stringify(modelReplies[requestCount++]) } }]
  }),
  text: async () => ''
});
const { LLM_CONFIG } = await import('./js/api/llm.js?v=20260718-v94-1');
LLM_CONFIG.apiKey = 'server-managed';
LLM_CONFIG.endpoint = '/api/chat/completions';
LLM_CONFIG.serverManaged = true;
const { AI } = await import('./js/api/ai.js?v=20260718-v94-1');
const request = {
  topic: '国产codex百度搭子自动管理你的知识库！',
  shots: [],
  account: { platform: '小红书', name: '视频账号', styleProfile: '专业、克制、可复核' },
  kind: 'video',
  product: { id: 'dumate', name: '百度搭子', shortName: '百度搭子' }
};
const valid = await AI.generateCopy({ ...request, requireLlm: true });
const validSource = AI.lastSource;
let strictError = '';
try {
  await AI.generateCopy({ ...request, requireLlm: true });
} catch (error) {
  strictError = error.message || String(error);
}
const strictSource = AI.lastSource;
const legacy = await AI.generateCopy({ ...request, requireLlm: false });
console.log(JSON.stringify({
  valid,
  validSource,
  strictError,
  strictSource,
  legacy,
  legacySource: AI.lastSource,
  requestCount
}));
"""
        result = subprocess.run(
            ["node", "--input-type=module", "-e", code],
            cwd=APP_DIR,
            text=True,
            capture_output=True,
            check=True,
        )
        payload = json.loads(result.stdout)
        self.assertEqual("llm", payload["validSource"])
        self.assertIn("Obsidian 里的项目资料", payload["valid"]["copy"])
        self.assertNotIn("很多 AI 办公内容写得太满", payload["valid"]["copy"])
        self.assertIn("模型返回的发布文案无效", payload["strictError"])
        self.assertEqual("error", payload["strictSource"])
        self.assertIn("很多 AI 办公内容写得太满", payload["legacy"]["copy"])
        self.assertEqual("llm", payload["legacySource"])
        self.assertEqual(5, payload["requestCount"])

        publish = (APP_DIR / "js/views/customPublish.js").read_text(encoding="utf-8")
        self.assertIn("const previousCopy = copyInput.value", publish)
        self.assertIn("copyInput.value = previousCopy", publish)
        self.assertIn("文案生成失败，已保留原文案。", publish)

    def test_bundled_sidecar_contains_only_deployable_runtime(self):
        expected = (
            "run.py",
            "requirements.txt",
            "app/main.py",
            "app/config.py",
            "web/index.html",
            "web/assets/app.js",
            "web/assets/xingzhen-logo-white.png",
            "skills/video-production/SKILL.md",
            "vendor/OpenMontage/LICENSE",
            "vendor/OpenMontage/tools/base_tool.py",
            "vendor/OpenMontage/tools/analysis/audio_probe.py",
            "vendor/OpenMontage/tools/analysis/composition_validator.py",
            "vendor/OpenMontage/tools/analysis/visual_qa.py",
            "vendor/OpenMontage/skills/core/subtitle-sync.md",
            "THIRD_PARTY_NOTICES.md",
        )
        for relative in expected:
            self.assertTrue((VIDEO_WORKSHOP_DIR / relative).is_file(), relative)

        forbidden = (
            ".env.local",
            ".playwright-cli",
            "vendor/OpenMontage/.git",
        )
        for relative in forbidden:
            self.assertFalse((VIDEO_WORKSHOP_DIR / relative).exists(), relative)

        # The sidecar launcher intentionally creates a local virtualenv in this
        # directory.  Deployment safety is defined by the packaging boundary,
        # not by requiring every developer checkout to delete its runtime.
        sidecar_gitignore = (VIDEO_WORKSHOP_DIR / ".gitignore").read_text(
            encoding="utf-8"
        )
        self.assertIn(".venv/", sidecar_gitignore)
        self.assertEqual(
            list((VIDEO_WORKSHOP_DIR / "data" / "projects").glob("*.json")),
            [],
        )
        self.assertEqual(
            [path for path in (VIDEO_WORKSHOP_DIR / "outputs").rglob("*") if path.is_file() and path.name != ".gitkeep"],
            [],
        )
        self.assertEqual(
            [path for path in (VIDEO_WORKSHOP_DIR / "uploads").rglob("*") if path.is_file() and path.name != ".gitkeep"],
            [],
        )


if __name__ == "__main__":
    unittest.main()
