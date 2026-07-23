from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import main


class BackgroundDirectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_policy_rejection_is_rewritten_and_resumed_without_user_confirmation(self):
        project = {
            "id": "auto-policy-rewrite",
            "status": "running",
            "phase": "production",
            "progress": 42,
            "messages": [],
            "events": [],
            "plan": {
                "title": "自动恢复",
                "scenes": [{"duration_sec": 5, "visual_prompt": "受保护角色风格"}],
            },
        }

        def mutate(_project_id, callback):
            callback(project)
            return project

        async def run_pipeline(_project_id, plan, retry_scene_number=None, **_kwargs):
            if retry_scene_number is None:
                project["status"] = "failed"
                project["retryable"] = {"type": "safe_rewrite", "sceneNumber": 1, "reason": "copyright"}
                project["error"] = "镜头 1 未通过版权风险审核"
            else:
                self.assertEqual(1, retry_scene_number)
                self.assertEqual("原创中性办公场景", plan["scenes"][0]["visual_prompt"])
                project["status"] = "succeeded"
                project["retryable"] = None

        with (
            patch.object(main, "load_project", return_value=project),
            patch.object(main, "mutate_project", side_effect=mutate),
            patch.object(main, "add_event"),
            patch.object(main, "add_message") as add_message,
            patch.object(main.pipeline, "run", side_effect=run_pipeline) as pipeline_run,
            patch.object(main.director, "rewrite_scene_for_safety", AsyncMock(return_value={
                "visual_prompt": "原创中性办公场景",
                "change_summary": "移除受保护形象",
                "public_thought": "保留原叙事作用。",
            })) as rewrite,
        ):
            await main._run_pipeline_with_auto_policy(project["id"], project["plan"])

        self.assertEqual("succeeded", project["status"])
        self.assertEqual(2, pipeline_run.await_count)
        rewrite.assert_awaited_once()
        self.assertEqual(1, len(project["autoPolicyRewrites"]))
        self.assertIn("无需手动确认", add_message.call_args.args[2])

    async def test_chat_acknowledges_before_director_and_pipeline_finish(self):
        project = {
            "id": "background-director",
            "name": "新会话",
            "status": "conversation",
            "phase": "brief",
            "progress": 0,
            "messages": [],
            "events": [],
            "assets": [],
            "plan": None,
            "outputs": [],
            "deliveries": [],
            "error": "",
        }
        director_started = asyncio.Event()
        release_director = asyncio.Event()

        def mutate(_project_id, callback):
            callback(project)
            return project

        def add_message(_project_id, role, content, **extra):
            project["messages"].append({"role": role, "content": content, **extra})
            return project

        def add_event(_project_id, title, detail, status="running", progress=None, phase=None):
            project["events"].append({"title": title, "detail": detail, "status": status})
            if progress is not None:
                project["progress"] = progress
            if phase is not None:
                project["phase"] = phase
            return project

        async def decide(*_args, **_kwargs):
            director_started.set()
            await release_director.wait()
            return {
                "action": "produce",
                "plan": {
                    "title": "后台继续制作",
                    "narration": "页面切走以后，制作仍然继续。",
                    "aspect_ratio": "9:16",
                    "scenes": [{"duration_sec": 5, "visual_prompt": "流动的工作台"}],
                },
            }

        pipeline_run = AsyncMock()
        with (
            patch.object(main, "create_project", return_value=project),
            patch.object(main, "load_project", return_value=project),
            patch.object(main, "mutate_project", side_effect=mutate),
            patch.object(main, "add_message", side_effect=add_message),
            patch.object(main, "add_event", side_effect=add_event),
            patch.object(main, "_decode_attachments", return_value=[]),
            patch.object(main, "_enrich_saved_attachments", AsyncMock(return_value=[])),
            patch.object(main, "_transcribe_candidate", AsyncMock(return_value="")),
            patch.object(main, "_hydrate_assets_for_director", return_value=[]),
            patch.object(main.director, "decide", side_effect=decide),
            patch.object(main.pipeline, "run", pipeline_run),
            patch.object(main, "director_context", return_value=""),
            patch.object(main.bgm_library, "catalog", return_value=[]),
        ):
            accepted = await main.chat(main.ChatRequest(message="制作一条后台视频"))
            await asyncio.wait_for(director_started.wait(), timeout=1)

            self.assertEqual("running", accepted["status"])
            self.assertEqual("brief", accepted["phase"])
            self.assertFalse(main._project_tasks[project["id"]].done())
            self.assertFalse(pipeline_run.await_count)

            # This models the browser discarding the acknowledged response and
            # navigating away.  The only owner of the remaining work is the
            # server task registry.
            accepted = None
            release_director.set()
            await main._project_tasks[project["id"]]

        pipeline_run.assert_awaited_once()
        self.assertEqual("后台继续制作", project["plan"]["title"])

    async def test_create_project_endpoint_returns_immediate_durable_conversation(self):
        created = {
            "id": "new-history-row",
            "name": "新会话",
            "status": "conversation",
            "phase": "brief",
            "progress": 0,
            "messages": [],
            "events": [],
            "assets": [],
            "outputs": [],
            "deliveries": [],
        }
        with patch.object(main, "create_project", return_value=created):
            result = await main.project_create()

        self.assertEqual("new-history-row", result["id"])
        self.assertEqual("新会话", result["name"])


if __name__ == "__main__":
    unittest.main()
