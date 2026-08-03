from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import main


class ReadOnlyRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_sidecar_blocks_mutating_routes_and_reports_contract(self) -> None:
        with patch.dict(os.environ, {"ACG_READ_ONLY": "1"}, clear=False):
            transport = httpx.ASGITransport(app=main.app)
            async with httpx.AsyncClient(
                transport=transport,
                base_url="http://video-workshop.test",
            ) as client:
                blocked = await client.post("/api/projects")
                health = await client.get("/api/health")

        self.assertEqual(503, blocked.status_code)
        self.assertEqual("60", blocked.headers.get("retry-after"))
        self.assertEqual(200, health.status_code)
        payload = health.json()
        self.assertTrue(payload["readOnly"])
        self.assertEqual("deny-mutations", payload["writePolicy"])
        self.assertEqual(main.VIDEO_WORKSHOP_CONTRACT_VERSION, payload["contractVersion"])

    async def test_project_list_does_not_recover_orphaned_work_in_read_only_mode(self) -> None:
        project = {"id": "orphaned", "status": "running"}
        with (
            patch.dict(os.environ, {"ACG_READ_ONLY": "true"}, clear=False),
            patch.object(main, "list_project_summaries", return_value=[project]),
            patch.object(main, "_mark_orphaned_running_project") as recover,
        ):
            result = await main.project_list()

        self.assertEqual([project], result["items"])
        recover.assert_not_called()

    async def test_project_detail_does_not_recover_or_resume_in_read_only_mode(self) -> None:
        project = {
            "id": "orphaned",
            "name": "只读项目",
            "status": "running",
            "phase": "production",
            "messages": [],
            "events": [],
        }
        with (
            patch.dict(os.environ, {"ACG_READ_ONLY": "on"}, clear=False),
            patch.object(main, "load_project", return_value=project),
            patch.object(main, "_mark_orphaned_running_project") as recover,
            patch.object(
                main,
                "_auto_resume_restart_project",
                new=AsyncMock(return_value=project),
            ) as resume,
        ):
            result = await main.project_detail(project["id"])

        self.assertEqual(project["id"], result["id"])
        recover.assert_not_called()
        resume.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
