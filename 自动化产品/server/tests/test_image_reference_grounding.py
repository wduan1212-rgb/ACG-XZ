import asyncio
import importlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


SERVER_DIR = Path(__file__).resolve().parents[1]
APP_DIR = SERVER_DIR.parent
if str(SERVER_DIR) not in sys.path:
    sys.path.insert(0, str(SERVER_DIR))

main = importlib.import_module("main")


class JsonLlmResponse:
    status_code = 200

    def __init__(self, payload):
        self.payload = payload

    def json(self):
        return {
            "model": "MiniMax-M3",
            "usage": {"prompt_tokens": 10, "completion_tokens": 6, "total_tokens": 16},
            "choices": [{"message": {"content": json.dumps(self.payload, ensure_ascii=False)}}],
        }


class ImageReferenceGroundingTest(unittest.TestCase):
    member = {"id": "creator-a", "name": "创作者", "role": "editor"}

    def _refs(self):
        # The server file-read and compacting boundaries are mocked below.  The
        # data URL still exercises the client/server request contract without
        # sending a real attachment or model request.
        return [
            main.ImageRef(id="logo", name="logo百度搭子", role="shared", dataUrl="data:image/png;base64,cG5n"),
            main.ImageRef(id="suite", name="自媒体套件", role="shared", dataUrl="data:image/png;base64,cG5n"),
            main.ImageRef(id="video", name="视频生成思考过程", role="shared", dataUrl="data:image/png;base64,cG5n"),
            main.ImageRef(id="home", name="主界面", role="shared", dataUrl="data:image/png;base64,cG5n"),
        ]

    def _collect_patch(self):
        async def collect(_client, refs):
            ref = refs[0]
            return [(f"{ref.name}.png", b"mock-png", "image/png")]
        return collect

    def test_ten_title_reference_copy_and_card_routing_rounds_use_m3_vision_fallback(self):
        cases = [
            ("这个桌面智能体我必须安利给所有人！都去试试！", "百度搭子的自媒体套件把主界面、视频生成思考和内容生产放在同一工作流里"),
            ("终于找到能把内容生产串起来的工具", "自媒体套件覆盖从创意梳理到视频生成的连续流程"),
            ("这套工作流让我少走很多弯路", "围绕百度搭子主界面中的自媒体套件说明真实使用路径"),
            ("做内容的人真的该看看这个", "用视频生成思考过程作为内容规划证据，再展示套件的衔接"),
            ("原来内容创作可以这样连起来", "百度搭子品牌下的自媒体套件串联图文与视频创作"),
            ("这不是又一个空泛的效率工具", "重点是自媒体套件中可见的内容生产与视频生成流程"),
            ("我的内容工作流终于顺了", "以百度搭子自媒体套件的主界面和创作流程为宣传主线"),
            ("想做自媒体的先把这条收好", "先讲套件如何把内容构思、界面操作和视频生成连成闭环"),
            ("一个套件把我常用的创作步骤收住了", "以自媒体套件及其视频生成思考过程解释核心价值"),
            ("这次安利的不是泛泛的桌面工具", "明确宣传百度搭子的自媒体套件及其真实创作流程"),
        ]
        refs = self._refs()
        required_terms = ["百度搭子", "自媒体套件", "视频生成"]
        cards = [
            main.ImageReferencePlanCard(index=index, title=f"图{index + 1}", prompt=f"围绕第{index + 1}个信息点展开")
            for index in range(4)
        ]
        with patch.object(main, "LLM_API_KEY", "test-key"), patch.object(main, "LLM_MODEL", "MiniMax-M3"), patch.object(main, "LLM_VISION_MODEL", ""), patch.object(main, "_collect_image_ref_files", new=self._collect_patch()), patch.object(main, "_compact_image_ref_files", side_effect=lambda files: (files, 0)):
            for round_index, (title, anchor) in enumerate(cases):
                with self.subTest(round=round_index + 1, stage="copy"):
                    with patch.object(main, "_call_llm", new=AsyncMock(return_value=JsonLlmResponse({
                        "brief": anchor,
                        "requiredTerms": required_terms,
                    }))) as call_llm:
                        brief = asyncio.run(main.llm_image_copy_reference_brief(
                            main.ImageCopyReferenceBriefReq(title=title, refs=refs), self.member
                        ))
                    self.assertEqual("vision", brief["source"])
                    self.assertEqual("MiniMax-M3", brief["model"])
                    self.assertEqual(anchor, brief["brief"])
                    self.assertEqual(required_terms, brief["requiredTerms"])
                    request_body = call_llm.await_args.args[0]
                    self.assertEqual("MiniMax-M3", request_body["model"])
                    self.assertEqual(5, len(request_body["messages"][1]["content"]))
                    self.assertIn("自媒体套件", request_body["messages"][1]["content"][0]["text"])

                # Intentionally reproduce the bad response from the reported
                # UI: a logo is repeatedly selected while two supplied shared
                # materials are completely omitted.  The server must repair it
                # into one primary home per shared reference before prompts or
                # image requests are allowed to continue.
                plan_payload = {
                    "cards": [
                        {
                            "index": index,
                            "referenceIds": ["logo"] if index < 3 else ["logo", "suite"],
                            "instruction": "参考图作为本页品牌或主素材放在画面中心。",
                        }
                        for index in range(4)
                    ]
                }
                with self.subTest(round=round_index + 1, stage="routing"):
                    with patch.object(main, "_call_llm", new=AsyncMock(return_value=JsonLlmResponse(plan_payload))) as call_llm:
                        plan = asyncio.run(main.llm_image_reference_plan(
                            main.ImageReferencePlanReq(title=title, body=f"正文主题锚点：{anchor}", cards=cards, refs=refs), self.member
                        ))
                    self.assertEqual("vision", plan["source"])
                    self.assertEqual(4, len(plan["cards"]))
                    assigned_ids = []
                    for index, card in enumerate(plan["cards"]):
                        self.assertEqual(index, card["index"])
                        self.assertTrue(card["referenceIds"])
                        assigned_ids.extend(card["referenceIds"])
                        for ref_id in card["referenceIds"]:
                            self.assertIn(next(ref.name for ref in refs if ref.id == ref_id), card["instruction"])
                        self.assertRegex(card["instruction"], r"中心|上半部|右侧|左侧|主体")
                    self.assertEqual(sorted(ref.id for ref in refs), sorted(assigned_ids))
                    request_body = call_llm.await_args.args[0]
                    self.assertEqual("MiniMax-M3", request_body["model"])
                    self.assertEqual(5, len(request_body["messages"][1]["content"]))

                # Fewer requested images must not make the extra uniform
                # references disappear.  This represents the concrete 2-card
                # / 5-reference case: one card may carry several materials,
                # but every attachment still needs an explicit role and place.
                five_refs = refs + [main.ImageRef(
                    id="evidence", name="内容生产流程证据", role="shared", dataUrl="data:image/png;base64,cG5n"
                )]
                two_cards = [
                    main.ImageReferencePlanCard(index=index, title=f"双图{index + 1}", prompt="围绕已确认主题展开")
                    for index in range(2)
                ]
                two_card_payload = {
                    "cards": [
                        {"index": 0, "referenceIds": ["logo"], "instruction": "Logo 放在画面角落。"},
                        {"index": 1, "referenceIds": ["logo"], "instruction": "Logo 放在画面角落。"},
                    ]
                }
                with self.subTest(round=round_index + 1, stage="two_cards_five_refs"):
                    with patch.object(main, "_call_llm", new=AsyncMock(return_value=JsonLlmResponse(two_card_payload))) as call_llm:
                        two_card_plan = asyncio.run(main.llm_image_reference_plan(
                            main.ImageReferencePlanReq(title=title, body=f"正文主题锚点：{anchor}", cards=two_cards, refs=five_refs), self.member
                        ))
                    self.assertEqual(2, len(two_card_plan["cards"]))
                    two_card_assigned = [ref_id for card in two_card_plan["cards"] for ref_id in card["referenceIds"]]
                    self.assertEqual(sorted(ref.id for ref in five_refs), sorted(two_card_assigned))
                    for card in two_card_plan["cards"]:
                        self.assertTrue(card["referenceIds"])
                        for ref_id in card["referenceIds"]:
                            ref_name = next(ref.name for ref in five_refs if ref.id == ref_id)
                            self.assertIn(ref_name, card["instruction"])
                        self.assertRegex(card["instruction"], r"中心|上半部|右侧|左侧|主体")
                    request_body = call_llm.await_args.args[0]
                    self.assertEqual(6, len(request_body["messages"][1]["content"]))

    def test_client_sequence_requires_real_reference_grounding_before_prompts(self):
        orchestrator = (APP_DIR / "js/agent/orchestrator.js").read_text(encoding="utf-8")
        ai = (APP_DIR / "js/api/ai.js").read_text(encoding="utf-8")
        server = (SERVER_DIR / "main.py").read_text(encoding="utf-8")
        start = orchestrator.index("/* 图文的顺序必须固定为")
        end = orchestrator.index("    const sres = material", start)
        image_pipeline = orchestrator[start:end]
        self.assertLess(image_pipeline.index("prepareBatchImageCopyReferenceContext"), image_pipeline.index("AI.generateImageCopyFromTitle"))
        self.assertLess(image_pipeline.index("AI.generateImageCopyFromTitle"), image_pipeline.index("buildBatchCustomCopyShots"))
        self.assertLess(image_pipeline.index("buildBatchCustomCopyShots"), image_pipeline.index("prepareBatchImageReferencePlan"))
        self.assertLess(image_pipeline.index("prepareBatchImageReferencePlan"), image_pipeline.index("AI.generateImagePrompts"))
        self.assertIn("referencePlans: imageReferencePlan.cards", image_pipeline)
        self.assertIn("requireLlm: true", image_pipeline)
        self.assertNotIn("AI.generateScript", image_pipeline)
        self.assertIn("参考图未完成视觉识别，已停止生成", ai)
        self.assertIn("统一参考图未完成内容识别，已停止按标题生成泛化文案", ai)
        self.assertIn("正文未覆盖统一参考图确认的核心主题", ai)
        self.assertIn("if re.fullmatch(r\"minimax[\\s_-]*m3\"", server)
        self.assertIn("非 Logo 的截图、产品图、海报", server)
        self.assertIn("每一张统一参考图都必须至少分配给一张图", server)

    def test_m3_compatibility_reply_without_json_terms_uses_named_theme_guard(self):
        refs = self._refs()
        summary = "百度搭子的自媒体套件把内容创作和视频生成流程串在一起，标题应宣传这套真实工作流。"
        brief, terms, source = main._copy_reference_brief_fields(
            json.dumps({"summary": summary}, ensure_ascii=False), refs
        )
        self.assertEqual(summary, brief)
        self.assertEqual("reference-name-fallback", source)
        self.assertIn("百度搭子", terms)
        self.assertIn("自媒体套件", terms)
        self.assertIn("视频生成", terms)

        raw_reply = "内容关联摘要：百度搭子的自媒体套件与视频生成能力是本次宣传主题。\n核心主题词：百度搭子、自媒体套件、视频生成"
        raw_brief, raw_terms, raw_source = main._copy_reference_brief_fields(raw_reply, refs)
        self.assertIn("自媒体套件", raw_brief)
        self.assertEqual(["百度搭子", "自媒体套件", "视频生成"], raw_terms)
        self.assertEqual("vision", raw_source)


if __name__ == "__main__":
    unittest.main()
