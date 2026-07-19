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
                {"title": "镜头一", "visual_prompt": "原镜头一", "duration_sec": 5},
                {"title": "镜头二", "visual_prompt": "原镜头二", "duration_sec": 5},
                {"title": "镜头三", "visual_prompt": "原镜头三", "duration_sec": 5},
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
