import asyncio
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


APP_DIR = Path(__file__).resolve().parents[2]
VIDEO_WORKSHOP_DIR = APP_DIR / "apps" / "video-workshop"
if str(VIDEO_WORKSHOP_DIR) not in sys.path:
    sys.path.insert(0, str(VIDEO_WORKSHOP_DIR))

from app import main as workshop_main
from app import store as workshop_store


class VideoWorkshopRestartRecoveryTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.projects_dir = root / "projects"
        self.outputs_dir = root / "outputs"
        self.projects_dir.mkdir()
        self.outputs_dir.mkdir()
        self.original_main_settings = workshop_main.settings
        self.original_store_settings = workshop_store.settings
        workshop_main.settings = SimpleNamespace(outputs_dir=self.outputs_dir)
        workshop_store.settings = SimpleNamespace(projects_dir=self.projects_dir)
        workshop_main._tasks.clear()
        workshop_main._project_tasks.clear()
        workshop_main._launching_projects.clear()

    async def asyncTearDown(self):
        tasks = list(workshop_main._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        workshop_main._tasks.clear()
        workshop_main._project_tasks.clear()
        workshop_main._launching_projects.clear()
        workshop_main.settings = self.original_main_settings
        workshop_store.settings = self.original_store_settings
        self.temp_dir.cleanup()

    def save_running_project(self, project_id="restart-project"):
        return workshop_store.save_project(
            {
                "id": project_id,
                "name": "重启恢复测试",
                "status": "running",
                "phase": "production",
                "progress": 38,
                "createdAt": "2026-07-16T10:00:00+08:00",
                "updatedAt": "2026-07-16T10:01:00+08:00",
                "messages": [],
                "events": [],
                "assets": [],
                "plan": {
                    "title": "重启恢复测试",
                    "scenes": [
                        {"visual_prompt": "镜头一"},
                        {"visual_prompt": "镜头二"},
                        {"visual_prompt": "镜头三"},
                    ],
                },
                "outputs": [],
                "error": "",
            }
        )

    async def test_active_running_project_is_not_misclassified(self):
        project = self.save_running_project("active-project")
        gate = asyncio.Event()

        async def active_work():
            await gate.wait()

        task = asyncio.create_task(active_work())
        workshop_main._tasks.add(task)
        workshop_main._project_tasks[project["id"]] = task
        try:
            response = await workshop_main.project_detail(project["id"])
            persisted = workshop_store.load_project(project["id"])
            self.assertEqual(response["status"], "running")
            self.assertEqual(persisted["status"], "running")
            self.assertFalse(
                any(
                    event.get("recoveryType") == "service-restart"
                    for event in persisted["events"]
                )
            )
        finally:
            gate.set()
            await task
            workshop_main._tasks.discard(task)
            workshop_main._project_tasks.pop(project["id"], None)

    async def test_orphaned_running_project_becomes_retryable_once(self):
        project = self.save_running_project()
        work_dir = self.outputs_dir / project["id"]
        work_dir.mkdir()
        (work_dir / "narration.mp3").write_bytes(b"narration")
        (work_dir / "scene-01.mp4").write_bytes(b"scene-one")

        listed = await workshop_main.project_list()
        first = await workshop_main.project_detail(project["id"])
        second = await workshop_main.project_detail(project["id"])
        persisted = workshop_store.load_project(project["id"])

        self.assertEqual(first["status"], "failed")
        self.assertEqual(first["phase"], "error")
        self.assertEqual(
            first["retryable"],
            {"type": "resume_missing", "sceneNumber": 2},
        )
        self.assertFalse((work_dir / "scene-02.mp4").exists())
        self.assertFalse((work_dir / "scene-03.mp4").exists())
        self.assertIn("服务重启，已保留素材，可继续缺失镜头", first["error"])
        self.assertIn(
            "从缺失镜头 2 开始继续所有未完成镜头",
            first["error"],
        )
        self.assertEqual(second["status"], "failed")
        self.assertEqual(
            next(
                item["status"]
                for item in listed["items"]
                if item["id"] == project["id"]
            ),
            "failed",
        )
        self.assertEqual(persisted["status"], "failed")
        self.assertEqual(persisted["phase"], "error")
        self.assertEqual(
            persisted["retryable"],
            {"type": "resume_missing", "sceneNumber": 2},
        )
        restart_events = [
            event
            for event in persisted["events"]
            if event.get("recoveryType") == "service-restart"
        ]
        restart_messages = [
            message
            for message in persisted["messages"]
            if message.get("recoveryType") == "service-restart"
        ]
        self.assertEqual(len(restart_events), 1)
        self.assertEqual(len(restart_messages), 1)
        self.assertIn(
            "从缺失镜头 2 开始继续所有未完成镜头",
            restart_events[0]["detail"],
        )
        self.assertIn(
            "从缺失镜头 2 开始继续所有未完成镜头",
            restart_messages[0]["content"],
        )

        scheduled = []

        def record_schedule(project_id, plan, retry_scene_number=None):
            scheduled.append((project_id, retry_scene_number))

        with patch.object(
            workshop_main,
            "_schedule",
            side_effect=record_schedule,
        ):
            retry_response = await workshop_main.project_retry(project["id"])

        self.assertEqual(retry_response["status"], "running")
        self.assertEqual(scheduled, [(project["id"], 2)])

    async def test_schedule_maps_project_and_ignores_duplicate_submission(self):
        gate = asyncio.Event()
        starts = 0

        async def fake_run(project_id, plan, retry_scene_number=None):
            nonlocal starts
            starts += 1
            await gate.wait()

        with patch.object(workshop_main.pipeline, "run", new=fake_run):
            workshop_main._schedule("same-project", {"scenes": [{}]})
            first_task = workshop_main._project_tasks["same-project"]
            workshop_main._schedule("same-project", {"scenes": [{}]})
            self.assertIs(
                workshop_main._project_tasks["same-project"],
                first_task,
            )
            await asyncio.sleep(0)
            self.assertEqual(starts, 1)
            gate.set()
            await first_task
            await asyncio.sleep(0)

        self.assertNotIn("same-project", workshop_main._project_tasks)
        self.assertNotIn(first_task, workshop_main._tasks)

    async def test_cancel_endpoint_really_cancels_active_task_and_is_idempotent(self):
        project = self.save_running_project("cancel-project")
        started = asyncio.Event()

        async def active_work():
            started.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(active_work())
        workshop_main._tasks.add(task)
        workshop_main._project_tasks[project["id"]] = task
        await started.wait()

        response = await workshop_main.project_cancel(project["id"])
        persisted = workshop_store.load_project(project["id"])

        self.assertTrue(task.cancelled())
        self.assertEqual(response["status"], "stopped")
        self.assertEqual(persisted["status"], "stopped")
        self.assertEqual(persisted["phase"], "stopped")
        self.assertIsNone(persisted["retryable"])
        self.assertIn("不伪装为可无损暂停", persisted["messages"][-1]["content"])
        self.assertEqual(persisted["events"][-1]["title"], "制作已停止")

        repeated = await workshop_main.project_cancel(project["id"])
        self.assertEqual(repeated["status"], "stopped")
        self.assertEqual(
            len([
                item
                for item in workshop_store.load_project(project["id"])["events"]
                if item["title"] == "制作已停止"
            ]),
            1,
        )


if __name__ == "__main__":
    unittest.main()
