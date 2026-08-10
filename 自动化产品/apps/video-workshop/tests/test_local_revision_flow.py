from __future__ import annotations

import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from app import main, providers


def _project() -> dict:
    return {
        "id": "revision-project",
        "name": "局部修订测试",
        "status": "succeeded",
        "phase": "delivery",
        "progress": 100,
        "messages": [],
        "events": [],
        "assets": [],
        "plan": {
            "title": "测试成片",
            "aspect_ratio": "9:16",
            "narration": "第一句口播。第二句口播。",
            "scenes": [
                {"title": "镜头一", "visual_prompt": "原镜头一", "narration_excerpt": "第一句口播。", "duration_sec": 5},
                {"title": "镜头二", "visual_prompt": "原镜头二", "narration_excerpt": "第二句口播。", "duration_sec": 5},
                {"title": "镜头三", "visual_prompt": "原镜头三", "narration_excerpt": "第三句口播。", "duration_sec": 5},
            ],
        },
    }


def _local_sources(root: str, project: dict) -> object:
    output_dir = Path(root)
    work_dir = output_dir / project["id"]
    work_dir.mkdir(parents=True, exist_ok=True)
    (work_dir / "narration.mp3").write_bytes(b"narration")
    for index, _scene in enumerate(project["plan"]["scenes"], start=1):
        (work_dir / f"scene-{index:02d}.mp4").write_bytes(b"video")
    return replace(main.settings, outputs_dir=output_dir)


class LocalRevisionRecognitionTests(unittest.TestCase):
    def test_video_editor_reads_delivery_composition_snapshot(self):
        project = _project()
        project["assets"] = [
            {
                "asset_id": "video-pip-asset",
                "label": "外部视频",
                "name": "pip.mp4",
                "mime": "video/mp4",
                "url": "/uploads/revision-project/pip.mp4",
            },
            {
                "asset_id": "audio-bgm-asset",
                "label": "外部配乐",
                "name": "bgm.mp3",
                "mime": "audio/mpeg",
                "url": "/uploads/revision-project/bgm.mp3",
            },
        ]
        project["outputs"] = [{
            "id": "delivery-1",
            "url": "/outputs/revision-project/delivery-1.mp4",
            "compositionFile": "delivery-1-composition.json",
        }]
        project["plan"]["timeline_edit"] = {
            "clips": [{
                "replacement_asset_id": "asset-replacement",
                "transition": "wipeleft",
                "subtitle": "这段字幕已单独修改。",
            }],
            "sound_effects": [{
                "id": "sfx-1",
                "source_type": "catalog",
                "source_id": "kenney-bell",
                "label": "清脆提示",
                "start": 1.2,
                "duration": 1.48,
                "volume": 0.64,
            }],
        }
        project["plan"]["audio_design"] = {
            "narration_volume": 0.8,
            "bgm_volume": 0.22,
        }
        with tempfile.TemporaryDirectory() as root:
            work_dir = Path(root) / project["id"]
            work_dir.mkdir(parents=True, exist_ok=True)
            scene = work_dir / "scene-production-a-01.mp4"
            scene.write_bytes(b"video")
            (work_dir / "delivery-1-composition.json").write_text(
                json.dumps({
                    "cuts": [{
                        "source": str(scene),
                        "directorSceneNumber": 1,
                        "segmentNumber": 1,
                        "in_seconds": 0,
                        "out_seconds": 4.5,
                    }]
                }),
                encoding="utf-8",
            )
            scoped_settings = replace(main.settings, outputs_dir=Path(root))
            with patch.object(main, "settings", scoped_settings):
                state = main._video_editor_state(project, "delivery-1")

        self.assertEqual(state["clips"][0]["sourceFile"], scene.name)
        self.assertEqual(state["clips"][0]["duration"], 4.5)
        self.assertEqual(state["clips"][0]["title"], "镜头一")
        self.assertEqual(state["clips"][0]["transition"], "wipeleft")
        self.assertEqual(state["clips"][0]["replacementAssetId"], "asset-replacement")
        self.assertEqual(state["clips"][0]["subtitle"], "这段字幕已单独修改。")
        self.assertEqual(state["assets"][0]["id"], "video-pip-asset")
        self.assertEqual(state["assets"][0]["mime"], "video/mp4")
        self.assertEqual(state["audioAssets"][0]["id"], "audio-bgm-asset")
        self.assertEqual(state["narrationVolume"], 0.8)
        self.assertEqual(state["bgmVolume"], 0.22)
        self.assertEqual(state["soundEffects"][0]["source_id"], "kenney-bell")
        self.assertTrue(any(item["id"] == "kenney-bell" for item in state["soundEffectCatalog"]))

    def test_bundled_sound_effect_catalog_resolves_only_shipped_cc0_files(self):
        catalog = main.sfx_library.catalog()

        self.assertGreaterEqual(len(catalog), 5)
        self.assertTrue(all(item["license"] == "CC0 1.0" for item in catalog))
        for item in catalog:
            effect = main.sfx_library.resolve(item["id"])
            self.assertIsNotNone(effect)
            self.assertTrue(effect.path.is_file())
            self.assertEqual(effect.path.suffix, ".ogg")

    def test_static_mode_defaults_to_landscape_but_keeps_explicit_user_ratio(self):
        self.assertEqual(main._infer_aspect_ratio("做一条静态视频", default="16:9"), "16:9")
        self.assertEqual(main._infer_aspect_ratio("改成竖屏静态视频", default="16:9"), "9:16")
        self.assertEqual(main._infer_aspect_ratio("先说横屏，最终还是 1:1", default="16:9"), "1:1")

    def test_stopped_plan_is_retryable_before_any_media_exists(self):
        project = _project()
        project["status"] = "failed"
        project["phase"] = "stopped"
        project["retryable"] = {"type": "resume_plan", "sceneNumber": 1}
        self.assertEqual(
            main._retry_info(project),
            {"type": "resume_plan", "sceneNumber": 1},
        )

    def test_retry_does_not_count_previous_production_scene_as_current(self):
        project = _project()
        project["status"] = "failed"
        project["error"] = "服务重启"
        project["plan"]["reference_scope_id"] = "current-campus-production"
        with tempfile.TemporaryDirectory() as root:
            work_dir = Path(root) / project["id"]
            work_dir.mkdir(parents=True, exist_ok=True)
            (work_dir / "narration.mp3").write_bytes(b"narration")
            (work_dir / "scene-previous-exhibition-01.mp4").write_bytes(b"old")
            scoped_settings = replace(main.settings, outputs_dir=Path(root))
            with patch.object(main, "settings", scoped_settings):
                retryable = main._retry_info(project)

        self.assertEqual(
            retryable,
            {"type": "resume_missing", "sceneNumber": 1},
        )

    def test_scene_video_and_subtitle_requests_are_separated(self):
        plan = _project()["plan"]
        self.assertEqual(
            main._local_revision_request("把镜头2重新生成，人物自然一点", plan, [])["sceneNumber"],
            2,
        )
        self.assertEqual(
            main._local_revision_request("视频1有瑕疵，修改一下", plan, [])["sceneNumber"],
            1,
        )
        self.assertEqual(
            main._local_revision_request("字幕太大了，调整小一点", plan, [])["type"],
            "subtitle_layout",
        )
        self.assertEqual(
            main._local_revision_request("把字幕文字改成另一句话", plan, [])["type"],
            "subtitle_text",
        )
        self.assertEqual(
            main._local_revision_request("字幕太大了", plan, [])["type"],
            "subtitle_layout",
        )
        self.assertEqual(
            main._local_revision_request("把字幕改成红色", plan, [])["type"],
            "subtitle_layout",
        )
        self.assertEqual(
            main._local_revision_request("字幕与口播不一致", plan, [])["type"],
            "subtitle_text",
        )
        self.assertEqual(
            main._local_revision_request("字幕内容跟口播不太一样", plan, [])["type"],
            "subtitle_text",
        )
        self.assertEqual(
            main._local_revision_request("让字幕恢复为原口播并重新合成", plan, [])["type"],
            "subtitle_layout",
        )
        self.assertEqual(
            main._local_revision_request("重新补一下镜头 现在有静止帧", plan, [])["type"],
            "motion_recompose",
        )
        numbered_motion = main._local_revision_request(
            "镜头2有静止帧，重做一下",
            plan,
            [],
        )
        self.assertEqual(numbered_motion["type"], "scene")
        self.assertEqual(numbered_motion["sceneNumber"], 2)
        self.assertIsNone(
            main._local_revision_request("保留结尾定格，不要删除", plan, [])
        )
        self.assertIsNone(
            main._local_revision_request("补镜头教程怎么做", plan, [])
        )
        self.assertIsNone(
            main._local_revision_request("重新补充镜头语言，做一条新视频", plan, [])
        )
        self.assertIsNone(
            main._local_revision_request("重新做一条3个镜头的视频", plan, [])
        )
        self.assertIsNone(
            main._local_revision_request("重新生成2个视频，做不同版本", plan, [])
        )
        self.assertEqual(
            main._local_revision_request("整个视频有静止尾帧，去掉它", plan, [])["type"],
            "motion_recompose",
        )

    def test_continue_recovers_the_latest_actionable_revision(self):
        project = _project()
        project["messages"] = [
            {"role": "user", "content": "重新补一下镜头 现在有静止帧"},
            {"role": "assistant", "content": "信息够了，我会重新处理。", "kind": "question"},
            {"role": "user", "content": "继续"},
        ]
        self.assertEqual(
            main._revision_message_for_continuation(project, "继续"),
            "重新补一下镜头 现在有静止帧",
        )

    def test_scene_background_change_is_local_and_negative_voice_clause_does_not_expand_scope(self):
        plan = _project()["plan"]
        background = main._local_revision_request(
            "把第4个片段的背景换成清晨办公室",
            plan,
            [],
        )
        camera = main._local_revision_request(
            "只调整镜头1的机位，不改口播",
            plan,
            [],
        )
        self.assertEqual(
            {"type": "invalid_scene", "sceneNumber": 4, "sceneCount": 3},
            background,
        )
        self.assertEqual("scene", camera["type"])
        self.assertEqual(1, camera["sceneNumber"])

    def test_context_free_followup_replays_user_intent_without_forcing_director(self):
        project = _project()
        project["messages"] = [
            {"role": "user", "content": "整体做一个新的自然版本，镜头由你判断"},
            {"role": "assistant", "content": "我会先说明方案。", "kind": "question"},
            {"role": "user", "content": "说啊"},
        ]
        self.assertEqual(
            main._revision_message_for_continuation(project, "说啊"),
            "整体做一个新的自然版本，镜头由你判断",
        )

    def test_chinese_and_natural_scene_numbers_are_recognized(self):
        plan = {
            **_project()["plan"],
            "scenes": [
                {"title": f"镜头{index}", "visual_prompt": f"画面{index}"}
                for index in range(1, 13)
            ],
        }
        self.assertEqual(
            main._local_revision_request("修改第二个镜头的人物动作", plan, [])["sceneNumber"],
            2,
        )
        self.assertEqual(
            main._local_revision_request("视频十二有瑕疵，换一下", plan, [])["sceneNumber"],
            12,
        )
        self.assertEqual(
            main._local_revision_request("第十一号片段不自然", plan, [])["sceneNumber"],
            11,
        )

    def test_current_turn_attachment_prevents_video_label_ambiguity(self):
        plan = _project()["plan"]
        result = main._local_revision_request(
            "修改视频1",
            plan,
            [{"label": "视频1", "mime": "video/mp4"}],
        )
        self.assertIsNone(result)

    def test_audio_or_duration_change_requires_full_timeline_replan(self):
        result = main._local_revision_request(
            "把镜头1改成8秒并更换口播",
            _project()["plan"],
            [],
        )
        self.assertEqual(result["type"], "timeline_change")


class LocalRevisionExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_editor_revision_persists_separate_audio_volumes_and_builtin_sfx(self):
        project = _project()
        project["outputs"] = [{"id": "delivery-1", "bgm": None}]
        editor_state = {
            "clips": [{
                "sourceFile": "scene-01.mp4",
                "sourceSceneNumber": 1,
            }],
            "assets": [],
            "audioAssets": [],
            "bgmCatalog": [],
            "soundEffectCatalog": main.sfx_library.catalog(),
            "currentBgm": None,
        }
        request = main.TimelineRevisionRequest(
            outputId="delivery-1",
            clips=[main.TimelineClipEdit(
                id="clip-1",
                sourceFile="scene-01.mp4",
                sourceSceneNumber=1,
                duration=4.0,
                subtitle="第一句口播。",
            )],
            soundEffects=[main.TimelineSoundEffectEdit(
                id="sfx-1",
                sourceType="catalog",
                sourceId="kenney-bell",
                label="清脆提示",
                start=1.25,
                duration=1.48,
                volume=0.66,
            )],
            bgmSelection="none",
            narrationVolume=0.82,
            bgmVolume=0.2,
        )

        def mutate(_project_id, callback):
            callback(project)
            return project

        with (
            patch.object(main, "load_project", return_value=project),
            patch.object(main, "_video_editor_state", return_value=editor_state),
            patch.object(main, "mutate_project", side_effect=mutate),
            patch.object(main, "add_event"),
            patch.object(main, "add_message"),
            patch.object(main, "_schedule", return_value=True),
        ):
            result = await main.project_timeline_revision(project["id"], request)

        self.assertTrue(result["ok"])
        self.assertEqual(project["plan"]["audio_design"]["narration_volume"], 0.82)
        self.assertEqual(project["plan"]["audio_design"]["bgm_volume"], 0.2)
        self.assertFalse(project["plan"]["audio_design"]["bgm_enabled"])
        self.assertEqual(project["plan"]["timeline_edit"]["sound_effects"][0]["source_id"], "kenney-bell")
        self.assertEqual(project["plan"]["sfx_assets"][0]["builtin_sfx_id"], "kenney-bell")
        self.assertTrue(project["plan"]["sfx_assets"][0]["editor_origin"])

    async def test_editor_asset_upload_persists_without_starting_director(self):
        project = _project()
        saved = {
            "asset_id": "video-editor-upload",
            "label": "视频1",
            "name": "external-pip.mp4",
            "mime": "video/mp4",
            "url": "/uploads/revision-project/external-pip.mp4",
        }

        def mutate(_project_id, callback):
            callback(project)
            return project

        request = main.ProjectAssetUploadRequest(
            attachments=[main.Attachment(
                label="external-pip.mp4",
                name="external-pip.mp4",
                mime="video/mp4",
                dataUrl="data:video/mp4;base64,AA==",
            )]
        )
        with (
            patch.object(main, "load_project", return_value=project),
            patch.object(main, "_decode_attachments", return_value=[(request.attachments[0], "video/mp4", b"video")]),
            patch.object(main, "_save_attachments", return_value=[saved]),
            patch.object(main, "_enrich_saved_attachments", AsyncMock(return_value=[saved])),
            patch.object(main, "mutate_project", side_effect=mutate),
            patch.object(main.director, "decide", AsyncMock()) as decide,
        ):
            result = await main.project_asset_upload(project["id"], request)

        self.assertTrue(result["ok"])
        self.assertEqual(project["assets"], [saved])
        decide.assert_not_awaited()

    async def test_static_director_route_persists_mode_before_pipeline(self):
        project = _project()
        project["status"] = "running"
        project["phase"] = "brief"

        def mutate(_project_id, callback):
            callback(project)
            return project

        plan = {
            **project["plan"],
            "title": "静态链路守门",
            "director_note": "用图片分镜承接口播。",
        }
        run_pipeline = AsyncMock()
        with (
            patch.object(main, "load_project", return_value=project),
            patch.object(main, "mutate_project", side_effect=mutate),
            patch.object(main, "add_message"),
            patch.object(main, "add_event"),
            patch.object(
                main.director,
                "decide",
                AsyncMock(return_value={"action": "produce", "plan": plan}),
            ) as decide,
            patch.object(
                main,
                "_run_pipeline_with_auto_policy",
                run_pipeline,
            ),
        ):
            await main._run_director_production(
                project["id"],
                aspect_ratio="16:9",
                creation_mode="static",
                director_assets=[],
                saved_attachments=[],
                revision_message="制作静态视频",
                original_message="制作静态视频",
                selected_voice_id="",
            )

        self.assertEqual("static", project["plan"]["creation_mode"])
        decide.assert_awaited_once()
        self.assertEqual("static", decide.await_args.kwargs["creation_mode"])
        run_pipeline.assert_awaited_once()
        self.assertEqual("static", run_pipeline.await_args.args[1]["creation_mode"])

    async def test_cancelled_planned_task_can_resume_the_same_plan(self):
        project = _project()
        project["status"] = "running"
        project["phase"] = "production"

        def mutate(_project_id, callback):
            callback(project)
            return project

        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(main, "settings", replace(main.settings, outputs_dir=Path(tmp))),
                patch.object(main, "load_project", return_value=project),
                patch.object(main, "mutate_project", side_effect=mutate),
                patch.object(main, "add_message"),
                patch.object(main, "add_event"),
            ):
                result = await main.project_cancel(project["id"])

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["phase"], "stopped")
        self.assertEqual(
            result["retryable"],
            {"type": "resume_plan", "sceneNumber": 1},
        )

    async def test_motion_quality_request_reuses_plan_and_all_original_sources(self):
        project = _project()

        def mutate(_project_id, callback):
            callback(project)
            return project

        original_plan = json.loads(json.dumps(project["plan"], ensure_ascii=False))
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(main, "settings", _local_sources(tmp, project)),
                patch.object(main, "load_project", return_value=project),
                patch.object(main, "mutate_project", side_effect=mutate),
                patch.object(main, "add_message"),
                patch.object(main, "add_event"),
                patch.object(main.director, "decide", AsyncMock()) as decide,
                patch.object(main.director, "revise_scene", AsyncMock()) as revise_scene,
                patch.object(main, "_schedule", return_value=True) as schedule,
            ):
                result = await main._handle_local_revision(
                    project,
                    "重新补一下镜头 现在有静止帧",
                    [],
                )

        self.assertEqual(result["plan"], original_plan)
        decide.assert_not_awaited()
        revise_scene.assert_not_awaited()
        schedule.assert_called_once()
        self.assertIsNone(schedule.call_args.kwargs["retry_scene_number"])
        self.assertTrue(schedule.call_args.kwargs["recompose_only"])
        self.assertEqual(project["revisionHistory"][0]["type"], "motion_timeline")

    async def test_scene_revision_schedules_only_the_requested_scene(self):
        project = _project()

        def mutate(_project_id, callback):
            callback(project)
            return project

        rewrite = {
            "visual_prompt": "修订后的镜头二",
            "title": "镜头二修订版",
            "purpose": "保持叙事只修正画面",
            "change_summary": "只调整第二个镜头",
        }
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(main, "settings", _local_sources(tmp, project)),
                patch.object(main, "load_project", return_value=project),
                patch.object(main, "mutate_project", side_effect=mutate),
                patch.object(main, "add_message"),
                patch.object(main, "add_event"),
                patch.object(main.director, "revise_scene", AsyncMock(return_value=rewrite)),
                patch.object(main, "_schedule") as schedule,
            ):
                result = await main._handle_local_revision(
                    project,
                    "视频2有瑕疵，修改一下人物动作",
                    [],
                )

        self.assertEqual(result["plan"]["scenes"][1]["visual_prompt"], "修订后的镜头二")
        self.assertEqual(result["plan"]["scenes"][0]["visual_prompt"], "原镜头一")
        self.assertEqual(result["plan"]["scenes"][2]["visual_prompt"], "原镜头三")
        schedule.assert_called_once()
        self.assertEqual(schedule.call_args.kwargs["retry_scene_number"], 2)
        self.assertFalse(schedule.call_args.kwargs["recompose_only"])

    async def test_subtitle_revision_only_recomposes_existing_audio_and_video(self):
        project = _project()

        def mutate(_project_id, callback):
            callback(project)
            return project

        style = {
            "font_scale": 0.9,
            "vertical_position": "higher",
            "max_chars": 11,
            "animation": "minimal",
            "public_summary": "字幕上移并缩小，每句更短。",
        }
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(main, "settings", _local_sources(tmp, project)),
                patch.object(main, "load_project", return_value=project),
                patch.object(main, "mutate_project", side_effect=mutate),
                patch.object(main, "add_message"),
                patch.object(main, "add_event"),
                patch.object(
                    main.director,
                    "revise_subtitle_style",
                    AsyncMock(return_value=style),
                ),
                patch.object(main, "_schedule") as schedule,
            ):
                result = await main._handle_local_revision(
                    project,
                    "字幕太大而且太靠下，重新编排短一点",
                    [],
                )

        self.assertEqual(result["plan"]["subtitle_style"], style)
        schedule.assert_called_once()
        self.assertIsNone(schedule.call_args.kwargs["retry_scene_number"])
        self.assertTrue(schedule.call_args.kwargs["recompose_only"])

    async def test_subtitle_text_change_does_not_start_a_render(self):
        project = _project()
        with (
            patch.object(main, "load_project", return_value=project),
            patch.object(main, "add_message") as add_message,
            patch.object(main, "_schedule") as schedule,
        ):
            result = await main._handle_local_revision(
                project,
                "把字幕文字改成一段和口播不同的新文案",
                [],
            )

        self.assertIs(result, project)
        schedule.assert_not_called()
        self.assertIn("字幕文字必须与原口播一致", add_message.call_args.args[2])

    async def test_missing_original_sources_blocks_local_revision_without_regeneration(self):
        project = _project()
        with tempfile.TemporaryDirectory() as tmp:
            work_dir = Path(tmp) / project["id"]
            work_dir.mkdir(parents=True)
            # Only the requested scene exists. A local revision must not use
            # this as permission to regenerate narration and the other scenes.
            (work_dir / "scene-02.mp4").write_bytes(b"video")
            with (
                patch.object(main, "settings", replace(main.settings, outputs_dir=Path(tmp))),
                patch.object(main, "load_project", return_value=project),
                patch.object(main, "add_message") as add_message,
                patch.object(main.director, "revise_scene", AsyncMock()) as revise_scene,
                patch.object(main, "_schedule") as schedule,
            ):
                result = await main._handle_local_revision(
                    project,
                    "修改镜头2的人物动作",
                    [],
                )

        self.assertIs(result, project)
        revise_scene.assert_not_awaited()
        schedule.assert_not_called()
        self.assertIn("不能安全执行局部修改", add_message.call_args.args[2])


class LocalRevisionProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_scene_revision_uses_llm_and_rejects_missing_fields_without_fallback(self):
        response = {
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "revise_one_scene",
                            "arguments": '{"visual_prompt":"这是足够长的完整镜头提示词，用于验证模型真实返回而非任何本地模板。"}',
                        }
                    }]
                }
            }]
        }
        with (
            patch.object(
                providers,
                "settings",
                replace(providers.settings, llm_api_key="test-key"),
            ),
            patch.object(
                providers,
                "_post_llm_json_with_retry",
                AsyncMock(return_value=response),
            ) as request,
        ):
            with self.assertRaisesRegex(providers.ProviderError, "字段不完整"):
                await providers.director.revise_scene(
                    _project()["plan"],
                    1,
                    "只修改镜头一",
                )
        request.assert_awaited_once()

    async def test_subtitle_revision_rejects_invalid_tool_data_without_defaults(self):
        response = {
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "function": {
                            "name": "revise_subtitle_style",
                            "arguments": json.dumps({
                                "font_scale": 0.9,
                                "vertical_position": "somewhere",
                                "max_chars": 10,
                                "animation": "minimal",
                                "public_summary": "字幕缩小并上移。",
                            }, ensure_ascii=False),
                        }
                    }]
                }
            }]
        }
        with (
            patch.object(
                providers,
                "settings",
                replace(providers.settings, llm_api_key="test-key"),
            ),
            patch.object(
                providers,
                "_post_llm_json_with_retry",
                AsyncMock(return_value=response),
            ) as request,
        ):
            with self.assertRaisesRegex(providers.ProviderError, "位置参数无效"):
                await providers.director.revise_subtitle_style(
                    _project()["plan"],
                    "字幕靠上一点",
                )
        request.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
