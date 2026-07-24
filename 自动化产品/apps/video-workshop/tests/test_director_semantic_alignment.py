from __future__ import annotations

import json
import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import main, media, pipeline, providers


class DirectorSemanticAlignmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_seedance_capacity_is_shared_across_concurrent_projects(self):
        active = 0
        peak = 0

        async def work():
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.02)
            active -= 1

        await asyncio.gather(
            pipeline._gather_bounded(
                *(work() for _ in range(7)), shared_seedance_slots=True
            ),
            pipeline._gather_bounded(
                *(work() for _ in range(7)), shared_seedance_slots=True
            ),
        )
        self.assertEqual(10, peak)

    def test_explicit_first_reference_and_other_materials_override_director_drift(self):
        assets = [
            {"asset_id": "a1", "label": "图1", "name": "logo.png", "media_type": "image", "mime": "image/png", "url": "/uploads/p/a1.png"},
            {"asset_id": "a2", "label": "图2", "name": "界面.png", "media_type": "image", "mime": "image/png", "url": "/uploads/p/a2.png"},
            {"asset_id": "a3", "label": "图3", "name": "步骤.png", "media_type": "image", "mime": "image/png", "url": "/uploads/p/a3.png"},
        ]
        plan = {
            "scenes": [{"visual_prompt": "scene"}],
            "asset_assignments": [
                {"asset_id": item["asset_id"], "label": item["label"], "role": "reference", "presentation": "pip"}
                for item in assets
            ],
        }
        main._apply_asset_plan(
            plan,
            assets,
            "图1的 Logo 作为视频参考，其他图片可以作为剪辑素材放到合适的地方。",
        )
        self.assertEqual(["a1"], [item["asset_id"] for item in plan["reference_images"]])
        self.assertEqual(["a2", "a3"], [item["asset_id"] for item in plan["material_assets"]])
        self.assertTrue(all(item["presentation"] == "pip" for item in plan["material_assets"]))

    def test_logo_can_be_semantic_reference_or_center_reveal_without_corner_override(self):
        assets = [{
            "asset_id": "logo-1", "label": "图1", "name": "百度搭子-logo.png",
            "media_type": "image", "mime": "image/png", "url": "/uploads/p/logo.png",
        }]
        plan = {
            "scenes": [{"visual_prompt": "口播提到百度搭子时展示品牌"}],
            "asset_assignments": [{
                "asset_id": "logo-1", "label": "图1", "role": "both",
                "presentation": "cutaway", "position": "center", "scale": 0.5,
                "scene_number": 1, "narration_anchor": "百度搭子",
            }],
        }
        main._apply_asset_plan(plan, assets, "做一条介绍百度搭子的视频，口播会提到百度搭子。")
        assignment = plan["asset_assignments"][0]
        self.assertEqual("cutaway", assignment["presentation"])
        self.assertEqual("center", assignment["position"])
        self.assertEqual(["logo-1"], [item["asset_id"] for item in plan["reference_images"]])
        self.assertEqual(["logo-1"], [item["asset_id"] for item in plan["material_assets"]])

    def test_explicit_corner_request_is_the_only_logo_corner_override(self):
        assets = [{
            "asset_id": "logo-1", "label": "图1", "name": "百度搭子-logo.png",
            "media_type": "image", "mime": "image/png", "url": "/uploads/p/logo.png",
        }]
        plan = {"scenes": [{"visual_prompt": "品牌提示"}], "asset_assignments": [{
            "asset_id": "logo-1", "label": "图1", "role": "material",
            "presentation": "cutaway", "position": "center", "scale": 0.52,
        }]}
        main._apply_asset_plan(plan, assets, "把图1作为右上角标显示。")
        assignment = plan["asset_assignments"][0]
        self.assertEqual("overlay", assignment["presentation"])
        self.assertEqual("top-right", assignment["position"])
        self.assertLessEqual(assignment["scale"], 0.3)

    def test_reference_images_are_scoped_to_director_selected_scene(self):
        with tempfile.TemporaryDirectory() as directory:
            uploads = Path(directory)
            project = uploads / "project-1"
            project.mkdir()
            (project / "first.png").write_bytes(b"first-image")
            (project / "second.png").write_bytes(b"second-image")
            plan = {
                "reference_images": [
                    {"url": "/uploads/project-1/first.png", "mime": "image/png", "scene_number": 1},
                    {"url": "/uploads/project-1/second.png", "mime": "image/png", "scene_number": 2},
                ]
            }
            with patch.object(pipeline, "settings", SimpleNamespace(uploads_dir=uploads)):
                first = pipeline.VideoPipeline._reference_images("project-1", plan, 1)
                second = pipeline.VideoPipeline._reference_images("project-1", plan, 2)
            self.assertEqual(1, len(first))
            self.assertEqual(1, len(second))
            self.assertNotEqual(first[0], second[0])

    def test_unassigned_images_do_not_become_implicit_global_references(self):
        assets = [
            {"asset_id": "a1", "label": "图1", "name": "随手截图.png", "media_type": "image", "mime": "image/png", "url": "/uploads/p/a1.png"},
        ]
        plan = {
            "scenes": [
                {"visual_prompt": "人物进入工作室"},
                {"visual_prompt": "产品操作结果"},
            ],
            "asset_assignments": [],
        }
        main._apply_asset_plan(plan, assets, "做一条产品体验视频")
        self.assertEqual([], plan["reference_images"])
        self.assertEqual("unused", plan["asset_assignments"][0]["role"])

    def test_explicit_reference_keeps_director_selected_scene_only(self):
        assets = [
            {"asset_id": "a1", "label": "图1", "name": "产品界面.png", "media_type": "image", "mime": "image/png", "url": "/uploads/p/a1.png"},
        ]
        plan = {
            "scenes": [
                {"visual_prompt": "人物提出问题"},
                {"visual_prompt": "产品界面完成操作"},
            ],
            "asset_assignments": [
                {"asset_id": "a1", "label": "图1", "role": "reference", "scene_number": 2, "reason": "只在产品操作镜头保持界面一致"},
            ],
        }
        main._apply_asset_plan(plan, assets, "需要时可以参考图1")
        self.assertEqual(2, plan["reference_images"][0]["scene_number"])

    async def test_numbered_image_and_video_roles_keep_director_selected_placement(self):
        narration = "先看到资料问题，再展示工具怎样把资料整理完成。"
        arguments = {
            "title": "附件用途测试",
            "input_mode": "script",
            "aspect_ratio": "9:16",
            "duration_sec": 10,
            "audience": "办公用户",
            "tone": "真实",
            "core_message": "展示整理过程",
            "narration": narration,
            "scenes": [
                {"title": "问题", "duration_sec": 5, "visual_prompt": "资料散落", "narration_excerpt": "先看到资料问题，", "purpose": "建立问题"},
                {"title": "结果", "duration_sec": 5, "visual_prompt": "资料整理完成", "narration_excerpt": "再展示工具怎样把资料整理完成。", "purpose": "展示结果"},
            ],
            "director_note": "按口播推进",
            "audio_design": {"bgm_enabled": False},
            "public_thoughts": [],
            "asset_assignments": [
                {"asset_id": "img-1", "label": "图1", "role": "material", "presentation": "pip", "scene_number": 2},
                {"asset_id": "video-1", "label": "视频1", "role": "unused", "presentation": "pip", "scene_number": 1},
            ],
        }
        payload = {"choices": [{"message": {"tool_calls": [{"function": {"name": "start_video_production", "arguments": json.dumps(arguments, ensure_ascii=False)}}]}}]}
        attachments = [
            {"asset_id": "img-1", "label": "图1", "name": "产品.png", "media_type": "image"},
            {"asset_id": "video-1", "label": "视频1", "name": "录屏.mp4", "media_type": "video"},
        ]
        with (
            patch.object(providers, "settings", SimpleNamespace(
                llm_api_key="test-key",
                llm_model="MiniMax-M3",
                llm_thinking="disabled",
                llm_max_completion_tokens=12000,
            )),
            patch.object(providers, "_post_llm_json_with_retry", AsyncMock(return_value=payload)),
        ):
            result = await providers.MiniMaxDirector().decide(
                [{"role": "user", "content": "图1作为生成参考，视频1作为剪辑素材放到第2镜头。"}],
                "9:16",
                attachments,
                "",
                [],
            )
        assignments = {item["asset_id"]: item for item in result["plan"]["asset_assignments"]}
        self.assertEqual("reference", assignments["img-1"]["role"])
        self.assertEqual("material", assignments["video-1"]["role"])
        self.assertEqual(2, assignments["video-1"]["scene_number"])
        self.assertEqual("pip", assignments["video-1"]["presentation"])

    async def test_topic_narration_uses_requested_duration_as_a_floor_and_never_regresses(self):
        def response(narration):
            arguments = {
                "title": "时长复核",
                "input_mode": "topic",
                "aspect_ratio": "9:16",
                "duration_sec": 30,
                "audience": "办公用户",
                "tone": "自然",
                "core_message": "展示真实工作流",
                "narration": narration,
                "scenes": [{
                    "title": "过程",
                    "duration_sec": 10,
                    "visual_prompt": "真实办公室里，人物整理纸质资料并完成清晰归档。",
                    "narration_excerpt": narration,
                    "purpose": "展示过程",
                }],
                "director_note": "按内容推进",
                "audio_design": {"bgm_enabled": False},
                "public_thoughts": [],
                "asset_assignments": [],
            }
            return {"choices": [{"message": {"tool_calls": [{"function": {"name": "start_video_production", "arguments": json.dumps(arguments, ensure_ascii=False)}}]}}]}

        short = "把资料交给搭子，马上整理完成。"
        regressed = "把资料给搭子，整理好就可以了。"
        corrected = "先把散落在聊天记录、文件夹和会议纪要里的资料集中起来，再让搭子按项目、日期和负责人逐项整理。它会把重复内容合并，把缺失信息单独标出来，还会给出一份能直接继续修改的清单。最后检查每个交付项，确认来源、负责人和截止时间都清楚，原本混乱的工作台就变成了一条可以照着执行的流程。这时再回到原始资料做一次抽查，从每个分类里选一条对照来源，确认内容没有在整理中被改写。复核通过后，下次只要换一批资料，这套流程就能直接复用，新加的人也能沿着同一份清单继续工作。如果某一条结果与原文不一致，只修正这一条并保留其他已确认内容，不用整批重来。"
        with (
            patch.object(providers, "settings", SimpleNamespace(
                llm_api_key="test-key",
                llm_model="MiniMax-M3",
                llm_thinking="disabled",
                llm_max_completion_tokens=12000,
            )),
            patch.object(
                providers,
                "_post_llm_json_with_retry",
                AsyncMock(side_effect=[response(short), response(regressed), response(corrected)]),
            ) as post,
        ):
            result = await providers.MiniMaxDirector().decide(
                [{"role": "user", "content": "做一条约30秒的资料整理视频"}],
                "9:16",
                [],
                "",
                [],
            )
        self.assertEqual(corrected, result["plan"]["narration"])
        self.assertEqual(3, post.await_count)

    def test_material_roles_reach_composition_timeline_at_director_selected_scene(self):
        cues = media._material_timeline(
            [
                {
                    "asset_id": "video-1",
                    "label": "视频1",
                    "path": "/tmp/recording.mp4",
                    "mime": "video/mp4",
                    "scene_number": 2,
                    "presentation": "cutaway",
                    "narration_anchor": "展示工具",
                    "duration_sec": 2.4,
                }
            ],
            "先看到资料问题，再展示工具怎样把资料整理完成。",
            10,
            [
                {"sceneNumber": 1, "sourceSceneNumber": 1, "start": 0, "end": 5},
                {"sceneNumber": 2, "sourceSceneNumber": 2, "start": 5, "end": 10},
            ],
        )
        self.assertEqual(1, len(cues))
        self.assertEqual(2, cues[0]["sceneNumber"])
        self.assertEqual("cutaway", cues[0]["presentation"])
        self.assertGreaterEqual(cues[0]["start"], 5)
        self.assertLessEqual(cues[0]["end"], 10)

    def test_material_anchor_is_mapped_inside_its_assigned_scene_excerpt(self):
        cues = media._material_timeline(
            [{
                "asset_id": "image-2",
                "scene_number": 2,
                "presentation": "cutaway",
                "narration_anchor": "展示工具",
                "scene_narration_excerpt": "先准备资料，再展示工具，最后确认结果。",
                "duration_sec": 2,
            }],
            "展示工具只是预告。第一段结束。先准备资料，再展示工具，最后确认结果。",
            20,
            [
                {"sceneNumber": 1, "sourceSceneNumber": 1, "start": 0, "end": 10},
                {"sceneNumber": 2, "sourceSceneNumber": 2, "start": 10, "end": 20},
            ],
        )
        self.assertEqual(1, len(cues))
        self.assertGreater(cues[0]["start"], 11.5)
        self.assertLessEqual(cues[0]["end"], 20)

    def test_executable_brief_does_not_require_optional_preferences(self):
        self.assertTrue(providers._director_request_has_executable_brief(
            [{"role": "user", "content": "做一条国产 Codex 百度搭子自动管理知识库的测评视频"}],
            [],
        ))
        self.assertFalse(providers._director_request_has_executable_brief(
            [{"role": "user", "content": "做个视频"}],
            [],
        ))

    def test_fallback_narration_spans_are_ordered_contiguous_and_complete(self):
        narration = "假如你是自媒体人、学生党、上班族，先把资料放进搭子。然后让它整理重点，最后输出结果。"
        spans = providers._partition_narration_excerpts(narration, 3)
        self.assertEqual(3, len(spans))
        self.assertEqual(narration, "".join(spans))
        self.assertTrue(all(span for span in spans))

    async def test_timed_visual_editor_uses_real_duration_and_pure_visual_prompts(self):
        narration = "第一段先展示混乱资料。第二段让创作者整理相机和采访素材。第三段展示清晰完成结果。"
        excerpts = providers._partition_narration_excerpts(narration, 3)
        arguments = {
            "scenes": [
                {
                    "title": "混乱",
                    "duration_sec": 10,
                    "visual_prompt": "俯拍桌面上散乱的便签、存储卡和录音设备，手掌快速翻找。",
                    "narration_excerpt": excerpts[0],
                    "visual_beats": [{"narration_anchor": excerpts[0][:4], "visual_action": "镜头掠过散落物件后停在空文件夹上"}],
                    "narrative_role": "建立问题",
                    "shot_intent": "让混乱可感知",
                    "visual_identity": "散乱实体媒介与寻找动作",
                    "purpose": "建立问题",
                },
                {
                    "title": "整理",
                    "duration_sec": 10,
                    "visual_prompt": "创作者在采光工作室把相机、录音笔和采访卡片按拍摄流程排成三列。",
                    "narration_excerpt": excerpts[1],
                    "visual_beats": [{"narration_anchor": excerpts[1][:4], "visual_action": "人物把不同设备依次接入同一工作流"}],
                    "narrative_role": "展示过程",
                    "shot_intent": "把方法变成动作",
                    "visual_identity": "工作室中的设备排序与连接",
                    "purpose": "展示方法",
                },
                {
                    "title": "完成",
                    "duration_sec": 10,
                    "visual_prompt": "清晨外景中创作者背起轻便设备离开工作室，桌面只留下整理好的成片硬盘。",
                    "narration_excerpt": excerpts[2],
                    "visual_beats": [{"narration_anchor": excerpts[2][:4], "visual_action": "人物轻松出发，镜头回望整洁桌面"}],
                    "narrative_role": "展示结果",
                    "shot_intent": "收束价值",
                    "visual_identity": "从室内完成态走向清晨外景",
                    "purpose": "完成收束",
                },
            ],
            "asset_placements": [],
            "public_summary": "已按真实时长完成视觉分镜。",
        }
        payload = {"choices": [{"message": {"tool_calls": [{"function": {
            "name": "lock_timed_visual_plan",
            "arguments": json.dumps(arguments, ensure_ascii=False),
        }}]}}]}
        llm = AsyncMock(return_value=payload)
        with (
            patch.object(providers, "settings", SimpleNamespace(
                llm_api_key="test-key",
                llm_model="MiniMax-M3",
                llm_thinking="disabled",
                llm_max_completion_tokens=12000,
            )),
            patch.object(providers, "_post_llm_json_with_retry", llm),
        ):
            result = await providers.MiniMaxDirector().lock_timed_visual_plan(
                {"title": "测试", "narration": narration, "scenes": []},
                30,
            )
        self.assertEqual(3, result["minimum_units"])
        self.assertEqual(narration, "".join(scene["narration_excerpt"] for scene in result["scenes"]))
        self.assertTrue(all("口播" not in scene["visual_prompt"] for scene in result["scenes"]))
        schema = llm.await_args.args[0]["tools"][0]["function"]["parameters"]
        self.assertEqual(3, schema["properties"]["scenes"]["minItems"])

    async def test_timed_visual_editor_fallback_does_not_duplicate_narration_tail(self):
        narration = "第一段建立问题。第二段展示转折。第三段完成收束。"
        arguments = {
            "scenes": [
                {
                    "title": f"镜头 {index}", "duration_sec": 8,
                    "visual_prompt": [
                        "暴雨中的通勤者收起湿透的雨伞，镜头跟随水珠滑落。",
                        "阳光画室里的学生把散落画稿铺成一条完整故事线。",
                        "清晨码头的工人启动货轮，广角镜头向海面拉远。",
                    ][index - 1],
                    "narration_excerpt": "模型改写后无法在原口播中定位",
                    "visual_beats": [], "narrative_role": "推进", "shot_intent": "推进",
                    "visual_identity": f"独立主体 {index}", "purpose": "推进",
                }
                for index in range(1, 4)
            ],
            "asset_placements": [], "public_summary": "已完成",
        }
        payload = {"choices": [{"message": {"tool_calls": [{"function": {
            "name": "lock_timed_visual_plan",
            "arguments": json.dumps(arguments, ensure_ascii=False),
        }}]}}]}
        with (
            patch.object(providers, "settings", SimpleNamespace(
                llm_api_key="test-key", llm_model="MiniMax-M3", llm_thinking="disabled",
                llm_max_completion_tokens=12000,
            )),
            patch.object(providers, "_post_llm_json_with_retry", AsyncMock(return_value=payload)),
        ):
            result = await providers.MiniMaxDirector().lock_timed_visual_plan(
                {"title": "测试", "narration": narration, "scenes": []}, 24,
            )
        self.assertEqual(narration, "".join(scene["narration_excerpt"] for scene in result["scenes"]))

    def test_visual_template_signature_catches_renamed_card_highlight_templates(self):
        left = "三张内容技能卡片并排排列，第一张卡片高亮放大，其他两张淡化。"
        right = "四张运营技能卡片网格排列，对应卡片依次高亮放大并同步亮起。"
        shared = providers._visual_template_signature(left) & providers._visual_template_signature(right)
        self.assertIn("card-grid", shared)
        self.assertIn("card-highlight", shared)

    def test_generic_ui_and_desk_signatures_do_not_override_distinct_scene_content(self):
        left = "自媒体人在居家工作台用电脑整理采访录音，镜头越过肩膀看到文件时间轴。"
        right = "学生在图书馆桌前用电脑检索论文，镜头俯拍书本与屏幕里的引用菜单。"
        self.assertLess(providers._visual_prompt_similarity(left, right), 0.28)

    def test_explicit_audience_enumeration_is_detected_without_general_shot_rules(self):
        self.assertEqual(
            ["自媒体人", "学生党", "上班族"],
            providers._explicit_audience_enumerations(
                "假如你是自媒体人、学生党、上班族，都会有零散资料。"
            ),
        )
        self.assertEqual([], providers._explicit_audience_enumerations("整体节奏更快一点，但不固定镜头数。"))

    def test_timeline_weights_follow_exact_narration_density_without_discarding_director_rhythm(self):
        weights = pipeline._scene_timeline_weights([
            {"duration_sec": 12, "narration_excerpt": "短句。"},
            {"duration_sec": 4, "narration_excerpt": "这里是一段明显更长的口播内容，需要画面承接更多信息和动作。"},
        ])
        self.assertGreater(weights[1], weights[0])

    def test_render_units_attach_only_the_relevant_semantic_beats(self):
        scene = {
            "duration_sec": 15,
            "visual_prompt": "真实办公室里的人物与产品界面自然推进。",
            "narration_excerpt": "假如你是自媒体人、学生党、上班族，都可以让搭子帮你整理资料。",
            "visual_beats": [
                {"narration_anchor": "自媒体人", "visual_action": "创作者剪辑素材", "pace": "flash", "shot_intent": "迅速建立第一类人群"},
                {"narration_anchor": "学生党", "visual_action": "学生整理课程资料", "pace": "quick", "transition_reason": "口播进入第二个列举项"},
                {"narration_anchor": "上班族", "visual_action": "职员汇总文档", "pace": "hold", "shot_intent": "让结果信息被看清"},
            ],
            "narrative_role": "列举受众并建立共鸣",
            "shot_intent": "让三类用户都被明确看见",
        }
        timeline = [
            {"sceneNumber": 1, "sourceSceneNumber": 1, "segmentNumber": 1, "segmentCount": 2, "duration": 7.5},
            {"sceneNumber": 2, "sourceSceneNumber": 1, "segmentNumber": 2, "segmentCount": 2, "duration": 7.5},
        ]
        with tempfile.TemporaryDirectory() as directory:
            units = pipeline._render_units([scene], timeline, Path(directory))
        first = units[0]["scene"]["visual_prompt"]
        second = units[1]["scene"]["visual_prompt"]
        self.assertIn("创作者剪辑素材", first)
        self.assertIn("学生整理课程资料", first)
        self.assertNotIn("职员汇总文档", first)
        self.assertIn("职员汇总文档", second)
        self.assertNotIn("学生整理课程资料", second)
        self.assertNotIn("本段对应口播原文", first + second)
        self.assertNotIn("自媒体人", first + second)
        self.assertNotIn("上班族", first + second)
        self.assertNotIn("口播", first + second)
        self.assertIn("内部镜头变化", first)
        self.assertIn("短促闪切", first)
        self.assertNotIn("2 到 4 秒", first + second)
        self.assertNotIn("真实办公室里的人物与产品界面自然推进。", first + second)
        self.assertIn("连续性背景", first)
        self.assertIn("连续性背景", second)

    def test_quality_signature_ignores_shared_continuity_but_keeps_unique_actions(self):
        first = "连续性背景：同一工作室\n- 光标点击设置按钮；近景；快速推进"
        second = "连续性背景：同一工作室\n- 技能卡片网格展开；全景；释放收束"
        repeated = "连续性背景：不同场景\n- 光标点击设置按钮；近景；快速推进"
        self.assertNotEqual(
            providers._render_action_signature(first),
            providers._render_action_signature(second),
        )
        self.assertEqual(
            providers._render_action_signature(first),
            providers._render_action_signature(repeated),
        )

    def test_director_prompt_uses_editorial_intent_without_fixed_cut_interval(self):
        prompt = providers.MiniMaxDirector()._system_prompt("9:16", "", [])
        self.assertIn("先做叙事镜头计划，再做内部剪辑决定", prompt)
        self.assertIn("一个技术片段可以通过清晰的时间结构包含多次内部镜头变化", prompt)
        self.assertIn("每一次切换都必须新增信息、情绪或视角", prompt)
        self.assertNotIn("2 到 4 秒", prompt)
        self.assertNotIn("一句口播两个镜头", prompt)

    def test_explicit_duration_guides_narration_length_without_fixing_visual_rhythm(self):
        prompt = providers.MiniMaxDirector()._system_prompt("9:16", "", [], 20)
        self.assertIn("最终成片不少于 20 秒", prompt)
        self.assertIn("至少预留约 120 个有效字符", prompt)
        self.assertIn("多 15–30 秒是允许的", prompt)
        self.assertIn("不规定镜头数、切镜间隔或叙事公式", prompt)

    def test_long_duration_floor_tapers_without_becoming_an_upper_cap(self):
        self.assertEqual(120, providers._duration_character_floor(20))
        self.assertEqual(360, providers._duration_character_floor(60))
        self.assertEqual(936, providers._duration_character_floor(180))

    async def test_real_tts_duration_revises_short_topic_before_visual_timeline(self):
        durations = iter((12.0, 30.0))

        async def fake_generate(text, output_path, **_kwargs):
            output_path.write_bytes(str(text).encode("utf-8"))
            return {"path": str(output_path), "model": "test", "speed": 1.0}

        async def fake_probe(_path):
            return {"duration": next(durations)}

        plan = {
            "title": "真实时长",
            "input_mode": "topic",
            "requested_duration_sec": 18,
            "narration": "这是偏短的初稿。",
        }
        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(pipeline.tts, "generate", side_effect=fake_generate),
                patch.object(pipeline, "probe", side_effect=fake_probe),
                patch.object(
                    pipeline.director,
                    "revise_narration_duration",
                    AsyncMock(return_value="这是根据真实音频时长补足有用信息后的完整口播。"),
                ),
            ):
                _tts_result, _probe, duration, revised_plan, attempts = (
                    await pipeline._generate_duration_aligned_tts(
                        plan,
                        Path(directory) / "narration.mp3",
                    )
                )
        self.assertEqual(30.0, duration)
        self.assertIn("完整口播", revised_plan["narration"])
        self.assertTrue(attempts[0]["accepted"])
        self.assertGreaterEqual(duration / pipeline.DEFAULT_DELIVERY_SPEED, 18)

    async def test_duration_revision_gives_real_audio_scaled_character_window(self):
        response = {
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "revise_narration_duration",
                            "arguments": json.dumps({"narration": "精简后的完整口播"}, ensure_ascii=False),
                        },
                    }],
                },
            }],
        }
        plan = {
            "title": "长片",
            "audience": "创作者",
            "tone": "真实",
            "core_message": "保持完整",
            "narration": "这是一段需要根据真实音频时长精简的口播内容。" * 40,
        }
        with (
            patch.object(providers, "settings", SimpleNamespace(
                llm_api_key="test-key",
                llm_model="MiniMax-M3",
                llm_thinking="disabled",
                llm_max_completion_tokens=12000,
            )),
            patch.object(providers, "_post_llm_json_with_retry", AsyncMock(return_value=response)) as mocked,
        ):
            revised = await providers.MiniMaxDirector().revise_narration_duration(
                plan,
                measured_duration=300,
                requested_duration=180,
                delivery_speed=1.2,
            )
        self.assertEqual("精简后的完整口播", revised)
        system = mocked.await_args.args[0]["messages"][0]["content"]
        self.assertIn("有效字符", system)
        self.assertIn("只校准总口播时长", system)
        self.assertIn("不得超过", system)

    def test_explicit_duration_understands_minutes(self):
        self.assertEqual(
            providers._explicit_duration_seconds([
                {"role": "user", "content": "来一条约3分钟的深度视频"},
            ]),
            180,
        )
        self.assertEqual(
            providers._explicit_duration_seconds([
                {"role": "user", "content": "制作一条约18秒的竖屏短片"},
            ]),
            18,
        )

    def test_input_mode_only_protects_user_declared_script(self):
        self.assertEqual(
            "topic",
            providers._explicit_input_mode([
                {"role": "user", "content": "做一条约35秒的新手教程，讲清楚怎么进入套件。"},
            ]),
        )
        self.assertEqual(
            "script",
            providers._explicit_input_mode([
                {"role": "user", "content": "口播原文：今天教你打开自媒体套件，请不要改写。"},
            ]),
        )

    def test_seedance_sanitizer_keeps_short_ui_copy_but_removes_caption_layer(self):
        cleaned = providers._sanitize_seedance_visual_text(
            "镜头推近主界面，一个深色图标按钮（写着设置工作区的占位样式）"
            "被光标点击，按钮写着「自媒体套件」，旁边显示『设置工作区』。"
            "画面底部跟随口播出现逐字字幕。"
        )
        self.assertIn("自媒体套件", cleaned)
        self.assertIn("设置工作区", cleaned)
        self.assertIsNone(providers._CAPTION_RENDER_CUE.search(cleaned))
        self.assertIn("光标点击", cleaned)

    async def test_director_normalizes_invalid_or_overlapping_spans_without_losing_visual_beats(self):
        narration = "第一段先展示真实问题。第二段列出自媒体人、学生党和上班族。第三段给出解决结果。"
        arguments = {
            "title": "语义分镜测试",
            "input_mode": "script",
            "aspect_ratio": "9:16",
            "duration_sec": 24,
            "audience": "办公用户",
            "tone": "真实、有节奏",
            "core_message": "画面跟随口播",
            "narration": narration,
            "scenes": [
                {
                    "title": "问题",
                    "duration_sec": 8,
                    "visual_prompt": "桌面资料堆积，人物快速翻找文件。",
                    "narration_excerpt": "不存在的改写句",
                    "visual_beats": [{"narration_anchor": "真实问题", "visual_action": "文件散落后被快速归拢"}],
                    "narrative_role": "建立问题",
                    "shot_intent": "让混乱变得可感知",
                    "purpose": "建立痛点",
                },
                {
                    "title": "人群",
                    "duration_sec": 8,
                    "visual_prompt": "三类用户在各自环境中使用同一工具。",
                    "narration_excerpt": "第二段列出自媒体人、学生党和上班族。",
                    "visual_beats": [{"narration_anchor": "自媒体人", "visual_action": "创作者、学生与职员依次出现"}],
                    "purpose": "具体化人群",
                },
                {
                    "title": "结果",
                    "duration_sec": 8,
                    "visual_prompt": "清晰结果卡片落定，人物轻松确认。",
                    "narration_excerpt": "第三段给出解决结果。",
                    "visual_beats": [],
                    "purpose": "收束",
                },
            ],
            "director_note": "按语义映射画面。",
            "audio_design": {"bgm_enabled": False, "bgm_mood": "克制", "bgm_track_id": "", "bgm_volume": 0.1, "sound_note": "口播优先"},
            "public_thoughts": [],
            "asset_assignments": [],
        }
        payload = {"choices": [{"message": {"tool_calls": [{"function": {"name": "start_video_production", "arguments": json.dumps(arguments, ensure_ascii=False)}}]}}]}
        with (
            patch.object(providers, "settings", SimpleNamespace(
                llm_api_key="test-key",
                llm_model="MiniMax-M3",
                llm_thinking="disabled",
                llm_max_completion_tokens=12000,
            )),
            patch.object(providers, "_post_llm_json_with_retry", AsyncMock(return_value=payload)),
        ):
            result = await providers.MiniMaxDirector().decide(
                [{"role": "user", "content": narration}], "9:16", [], "", []
            )
        scenes = result["plan"]["scenes"]
        self.assertEqual(narration, "".join(scene["narration_excerpt"] for scene in scenes))
        self.assertEqual("文件散落后被快速归拢", scenes[0]["visual_beats"][0]["visual_action"])
        self.assertEqual("建立问题", scenes[0]["narrative_role"])
        self.assertEqual("让混乱变得可感知", scenes[0]["shot_intent"])
        self.assertEqual(1.0, result["plan"]["director_alignment"]["narration_coverage_ratio"])

    async def test_director_self_corrects_optional_question_without_constraining_creative_plan(self):
        narration = "国产 Codex 百度搭子可以自动整理知识库，让零散资料变成可执行的流程。"
        ask_payload = {
            "choices": [{"message": {"tool_calls": [{"function": {
                "name": "ask_user",
                "arguments": json.dumps({
                    "question": "你更喜欢什么镜头语言？",
                    "missing": ["镜头偏好"],
                    "suggestions": ["真实", "科技"],
                }, ensure_ascii=False),
            }}]}}],
        }
        start_arguments = {
            "title": "百度搭子知识库测评",
            "input_mode": "topic",
            "aspect_ratio": "9:16",
            "duration_sec": 12,
            "audience": "知识工作者",
            "tone": "真实鲜明",
            "core_message": "资料变流程",
            "narration": narration,
            "scenes": [{
                "title": "从混乱到有序",
                "duration_sec": 12,
                "visual_prompt": "零散文档在真实桌面上被快速整理为清晰流程，镜头跟随信息流推进。",
                "narration_excerpt": narration,
                "visual_beats": [{
                    "narration_anchor": "零散资料",
                    "visual_action": "多个文档聚合成有序步骤",
                }],
                "purpose": "可视化价值",
            }],
            "director_note": "根据主题自主决定视觉语言。",
            "audio_design": {"bgm_enabled": False, "bgm_mood": "克制", "bgm_track_id": "", "bgm_volume": 0.1, "sound_note": "口播优先"},
            "public_thoughts": [],
            "asset_assignments": [],
        }
        start_payload = {
            "choices": [{"message": {"tool_calls": [{"function": {
                "name": "start_video_production",
                "arguments": json.dumps(start_arguments, ensure_ascii=False),
            }}]}}],
        }
        llm = AsyncMock(side_effect=[ask_payload, start_payload])
        with (
            patch.object(providers, "settings", SimpleNamespace(
                llm_api_key="test-key",
                llm_model="MiniMax-M3",
                llm_thinking="disabled",
                llm_max_completion_tokens=12000,
            )),
            patch.object(providers, "_post_llm_json_with_retry", llm),
        ):
            result = await providers.MiniMaxDirector().decide(
                [{"role": "user", "content": "做一条国产 Codex 百度搭子自动管理知识库的测评视频"}],
                "9:16",
                [],
                "",
                [],
            )
        self.assertEqual("produce", result["action"])
        self.assertEqual(2, llm.await_count)
        corrected_payload = llm.await_args_list[1].args[0]
        self.assertEqual("auto", corrected_payload["tool_choice"])
        self.assertEqual(1, len(corrected_payload["tools"]))
        self.assertEqual("start_video_production", corrected_payload["tools"][0]["function"]["name"])
        self.assertNotIn("固定镜头数", start_arguments["director_note"])

    async def test_director_self_corrects_plain_text_plan_without_tool_call(self):
        narration = "国产 Codex 百度搭子可以自动整理知识库，让零散资料变成可执行的流程。"
        plain_plan = {
            "choices": [{"message": {"content": (
                "我已经完成受众、结构、镜头与附件用途规划，接下来会按这个方案发起制作。"
            )}}],
        }
        start_arguments = {
            "title": "百度搭子知识库测评",
            "input_mode": "topic",
            "aspect_ratio": "9:16",
            "duration_sec": 12,
            "audience": "知识工作者",
            "tone": "真实鲜明",
            "core_message": "资料变流程",
            "narration": narration,
            "scenes": [{
                "title": "从混乱到有序",
                "duration_sec": 12,
                "visual_prompt": "零散文档在真实桌面上被快速整理为清晰流程，镜头跟随信息流推进。",
                "narration_excerpt": narration,
                "visual_beats": [{
                    "narration_anchor": "零散资料",
                    "visual_action": "多个文档聚合成有序步骤",
                }],
                "purpose": "可视化价值",
            }],
            "director_note": "根据主题自主决定视觉语言。",
            "audio_design": {"bgm_enabled": False, "bgm_mood": "克制", "bgm_track_id": "", "bgm_volume": 0.1, "sound_note": "口播优先"},
            "public_thoughts": [],
            "asset_assignments": [],
        }
        start_payload = {
            "choices": [{"message": {"tool_calls": [{"function": {
                "name": "start_video_production",
                "arguments": json.dumps(start_arguments, ensure_ascii=False),
            }}]}}],
        }
        llm = AsyncMock(side_effect=[plain_plan, start_payload])
        with (
            patch.object(providers, "settings", SimpleNamespace(
                llm_api_key="test-key",
                llm_model="MiniMax-M3",
                llm_thinking="disabled",
                llm_max_completion_tokens=12000,
            )),
            patch.object(providers, "_post_llm_json_with_retry", llm),
        ):
            result = await providers.MiniMaxDirector().decide(
                [{"role": "user", "content": "做一条国产 Codex 百度搭子自动管理知识库的测评视频"}],
                "9:16",
                [],
                "",
                [],
            )
        self.assertEqual("produce", result["action"])
        self.assertEqual(2, llm.await_count)
        corrected_payload = llm.await_args_list[1].args[0]
        self.assertEqual(1, len(corrected_payload["tools"]))
        self.assertEqual("start_video_production", corrected_payload["tools"][0]["function"]["name"])


if __name__ == "__main__":
    unittest.main()
