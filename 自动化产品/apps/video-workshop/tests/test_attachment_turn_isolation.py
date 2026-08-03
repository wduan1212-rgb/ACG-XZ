from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import main


IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgo="


def image_attachment(name: str) -> main.Attachment:
    return main.Attachment(
        label="图1",
        name=name,
        mime="image/png",
        dataUrl=IMAGE_DATA_URL,
    )


class AttachmentTurnIsolationTests(unittest.TestCase):
    def test_director_context_starts_after_latest_delivery_without_losing_current_qa(self):
        messages = [
            {
                "role": "user",
                "content": "上一轮使用秒哒IP形象和附件图1制作品牌视频",
                "attachments": [{"label": "图1", "name": "秒哒IP.png"}],
            },
            {
                "role": "assistant",
                "kind": "plan",
                "content": "上一轮会让秒哒IP贯穿全片。",
            },
            {
                "role": "assistant",
                "kind": "delivery",
                "content": "上一轮成片完成。",
            },
            {
                "role": "user",
                "content": "帮我做一个中式恐怖的盗墓短片。",
            },
            {
                "role": "assistant",
                "kind": "question",
                "content": "主角是单人还是盗墓团队？",
            },
            {
                "role": "user",
                "content": "四人团队，音色ID：grave_voice",
            },
            {
                "role": "assistant",
                "kind": "error",
                "content": "本轮导演请求暂时失败，可以继续。",
            },
            {
                "role": "user",
                "content": "继续按四人团队制作。",
            },
        ]

        current = main._director_messages_for_current_production(messages)

        self.assertEqual(5, len(current))
        current_text = "\n".join(str(item.get("content") or "") for item in current)
        self.assertNotIn("秒哒", current_text)
        self.assertNotIn("上一轮", current_text)
        self.assertIn("中式恐怖的盗墓短片", current_text)
        self.assertIn("主角是单人还是盗墓团队", current_text)
        self.assertIn("四人团队", current_text)
        self.assertIn("本轮导演请求暂时失败", current_text)
        self.assertIn("继续按四人团队制作", current_text)
        self.assertNotIn("grave_voice", current_text)

    def test_more_than_eight_attachments_is_rejected_instead_of_truncated(self):
        attachments = [image_attachment(f"image-{index}.png") for index in range(9)]

        with self.assertRaises(HTTPException) as context:
            main._decode_attachments(attachments)

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("每条消息最多", str(context.exception.detail))

        with self.assertRaises(HTTPException) as route_context:
            asyncio.run(main.chat(main.ChatRequest(message="制作一条视频", attachments=attachments)))
        self.assertEqual(route_context.exception.status_code, 400)

    def test_saved_attachment_labels_restart_for_each_message(self):
        first_decoded = main._decode_attachments(
            [image_attachment("first-a.png"), image_attachment("first-b.png")]
        )
        second_decoded = main._decode_attachments([image_attachment("second-a.png")])

        with tempfile.TemporaryDirectory() as temp_dir, patch.object(
            main,
            "settings",
            SimpleNamespace(uploads_dir=Path(temp_dir)),
        ):
            first = main._save_attachments("project-labels", first_decoded)
            second = main._save_attachments("project-labels", second_decoded)

        self.assertEqual([item["label"] for item in first], ["图1", "图2"])
        self.assertEqual([item["label"] for item in second], ["图1"])
        self.assertNotEqual(first[0]["asset_id"], second[0]["asset_id"])

    def test_static_plan_keeps_current_turn_images_as_generation_references_only(self):
        image = {
            "asset_id": "current-image",
            "label": "图1",
            "media_type": "image",
            "name": "current.png",
            "mime": "image/png",
            "url": "/uploads/project/current.png",
        }
        video = {
            "asset_id": "current-video",
            "label": "视频1",
            "media_type": "video",
            "name": "current.mp4",
            "mime": "video/mp4",
            "url": "/uploads/project/current.mp4",
        }
        plan = {
            "narration": "静态视频口播",
            "scenes": [{"duration_sec": 5, "image_prompt": "图片分镜"}],
        }

        summary = main._apply_static_reference_plan(plan, [image, video])

        self.assertEqual(["current-image"], [
            item["asset_id"] for item in plan["reference_images"]
        ])
        self.assertEqual([], plan["material_assets"])
        self.assertEqual(
            {"current-image": "reference", "current-video": "unused"},
            {
                item["asset_id"]: item["role"]
                for item in plan["asset_assignments"]
            },
        )
        self.assertIn("图1：静态分镜统一参考", summary)
        self.assertEqual(["图1"], plan["scenes"][0]["reference_labels"])
        self.assertIn("必须清晰呈现参考图 图1", plan["scenes"][0]["image_prompt"])


class ChatAttachmentScopeTests(unittest.IsolatedAsyncioTestCase):
    async def test_chat_keeps_history_but_only_injects_current_turn_assets(self):
        old_audio = {
            "asset_id": "old-audio",
            "label": "音频1",
            "media_type": "audio",
            "name": "old.mp3",
            "mime": "audio/mpeg",
            "url": "/uploads/turn-project/old.mp3",
        }
        current_image = {
            "asset_id": "current-image",
            "label": "图1",
            "media_type": "image",
            "name": "current.png",
            "mime": "image/png",
            "url": "/uploads/turn-project/current.png",
            "previewUrl": "/uploads/turn-project/current.png",
        }
        project = {
            "id": "turn-project",
            "name": "历史会话",
            "status": "conversation",
            "phase": "brief",
            "progress": 0,
            "messages": [
                {
                    "id": "old-message",
                    "role": "user",
                    "content": "上一轮用音频1制作",
                    "attachments": [old_audio],
                }
            ],
            "events": [],
            "assets": [old_audio],
            "plan": None,
            "outputs": [],
            "deliveries": [],
            "error": "",
        }

        def mutate(_project_id, callback):
            callback(project)
            return project

        def add_message(_project_id, role, content, **extra):
            project["messages"].append(
                {
                    "id": f"message-{len(project['messages']) + 1}",
                    "role": role,
                    "content": content,
                    **extra,
                }
            )
            return project

        def add_event(_project_id, title, detail, status="running", progress=None, phase=None):
            project["events"].append(
                {"id": f"event-{len(project['events']) + 1}", "title": title, "detail": detail, "status": status}
            )
            if progress is not None:
                project["progress"] = progress
            if phase is not None:
                project["phase"] = phase
            return project

        decision = {
            "action": "produce",
            "plan": {
                "title": "本轮附件隔离测试",
                "narration": "只使用本轮图片制作。",
                "aspect_ratio": "9:16",
                "scenes": [{"duration_sec": 5, "visual_prompt": "本轮图片场景"}],
                "asset_assignments": [{
                    "asset_id": "current-image",
                    "label": "图1",
                    "role": "reference",
                    "scene_number": 1,
                    "reason": "本轮指定图片只用于对应场景",
                }],
            },
        }
        transcription = AsyncMock(return_value="")
        director = AsyncMock(return_value=decision)

        with (
            patch.object(main, "load_project", return_value=project),
            patch.object(main, "mutate_project", side_effect=mutate),
            patch.object(main, "add_message", side_effect=add_message),
            patch.object(main, "add_event", side_effect=add_event),
            patch.object(main, "_decode_attachments", return_value=[(image_attachment("current.png"), "image/png", b"image")]),
            patch.object(main, "_save_attachments", return_value=[current_image]),
            patch.object(main, "_enrich_saved_attachments", AsyncMock(return_value=[current_image])),
            patch.object(main, "_transcribe_candidate", transcription),
            patch.object(main, "_hydrate_assets_for_director", side_effect=lambda _project_id, assets: list(assets)) as hydrate,
            patch.object(main, "_apply_asset_plan", wraps=main._apply_asset_plan) as apply_plan,
            patch.object(main.director, "decide", director),
            patch.object(main, "director_context", return_value=""),
            patch.object(main.bgm_library, "catalog", return_value=[]),
            patch.object(main.pipeline, "run", AsyncMock()),
        ):
            accepted = await main.chat(
                main.ChatRequest(
                    projectId="turn-project",
                    message="使用图1制作新版本",
                    attachments=[image_attachment("current.png")],
                )
            )
            self.assertEqual("running", accepted["status"])
            await main._project_tasks["turn-project"]
            result = project

        self.assertEqual(
            [item["asset_id"] for item in project["assets"]],
            ["old-audio", "current-image"],
        )
        self.assertEqual(
            [item["asset_id"] for item in project["messages"][1]["attachments"]],
            ["current-image"],
        )
        self.assertEqual(
            [item["asset_id"] for item in transcription.await_args.args[2]],
            ["current-image"],
        )
        self.assertEqual(
            [item["asset_id"] for item in hydrate.call_args.args[1]],
            ["current-image"],
        )
        self.assertEqual(
            [item["asset_id"] for item in director.await_args.args[2]],
            ["current-image"],
        )
        self.assertEqual(
            [item["asset_id"] for item in apply_plan.call_args.args[1]],
            ["current-image"],
        )
        self.assertEqual(
            [item["asset_id"] for item in result["plan"]["reference_images"]],
            ["current-image"],
        )
        self.assertRegex(result["plan"]["reference_scope_id"], r"^[0-9a-f]{32}$")
        self.assertNotIn("old-audio", str(result["plan"]))


if __name__ == "__main__":
    unittest.main()
