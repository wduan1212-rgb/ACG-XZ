from __future__ import annotations

import json
import asyncio
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from starlette.requests import Request


APP_DIR = Path(__file__).resolve().parents[2]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from server import main


def get_request(path: str) -> Request:
    return Request({
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("utf-8"),
        "query_string": b"",
        "headers": [],
        "client": ("127.0.0.1", 1234),
        "server": ("test", 80),
    })


class ReadOnlyVideoIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_project_list_uses_existing_mapping_without_sync_or_billing_writes(self):
        source = {"id": "workshop-1", "name": "历史项目", "status": "succeeded"}
        mapped = {
            "id": "custom-1",
            "workshopProjectId": "workshop-1",
            "publishedDeliveryId": "delivery-1",
            "publishedAt": 123,
            "publishedCount": 1,
            "projectState": {"publishedVideoOutputs": {}},
        }
        upstream = SimpleNamespace(
            status_code=200,
            json=lambda: {
                "items": [source],
                "total": 1,
                "page": 1,
                "pageSize": 60,
                "hasMore": False,
            },
        )
        with (
            patch.object(main.runtime_config, "is_read_only", return_value=True),
            patch.object(main, "_video_workshop_project_index", return_value={"workshop-1": mapped}),
            patch.object(main, "_video_workshop_request", new=AsyncMock(return_value=upstream)),
            patch.object(main, "_sync_video_workshop_project") as sync_project,
        ):
            response = await main.custom_video_api(
                "projects",
                get_request("/custom-video/api/projects"),
                me={"id": "member-1", "role": "editor"},
            )

        sync_project.assert_not_called()
        payload = json.loads(response.body.decode("utf-8"))
        self.assertEqual("custom-1", payload["items"][0]["_integration"]["customProjectId"])
        self.assertEqual("workshop-1", payload["items"][0]["_integration"]["workshopProjectId"])

    def test_read_only_session_post_is_explicitly_allowlisted(self):
        self.assertIn("/api/custom-video/session", main._READ_ONLY_ALLOWED_POST_PATHS)

    async def test_owner_scoped_finalizer_reuses_sync_until_terminal_checkpoint(self):
        active = {"id": "workshop-finalize", "status": "generating"}
        terminal = {"id": "workshop-finalize", "status": "succeeded"}
        loader = MagicMock(side_effect=[(active, "a" * 64), (terminal, "b" * 64)])
        sync_project = MagicMock(return_value={"ok": True})
        with (
            patch.object(main, "_video_workshop_project_payload", loader),
            patch.object(main, "_sync_video_workshop_project", sync_project),
            patch.object(main.asyncio, "sleep", new=AsyncMock(return_value=None)),
            patch.dict("os.environ", {"VIDEO_WORKSHOP_FINALIZE_SECONDS": "1"}),
        ):
            await main._video_workshop_project_finalizer(
                {"id": "member-1", "teamId": "team-1"},
                "workshop-finalize",
            )

        self.assertEqual(2, loader.call_count)
        self.assertEqual(
            [active, terminal],
            [call.args[1] for call in sync_project.call_args_list],
        )

    async def test_owner_scoped_finalizer_is_deduplicated_per_member_project(self):
        blocker = asyncio.Event()

        async def wait_for_stop(*_args, **_kwargs):
            await blocker.wait()

        source = {"id": "workshop-deduplicated", "status": "generating"}
        with (
            patch.object(main.runtime_config, "is_read_only", return_value=False),
            patch.object(
                main, "_video_workshop_project_finalizer",
                side_effect=wait_for_stop,
            ),
        ):
            first = main._schedule_video_workshop_project_finalizer(
                {"id": "member-1"}, source,
            )
            second = main._schedule_video_workshop_project_finalizer(
                {"id": "member-1"}, source,
            )
            self.assertIs(first, second)
            self.assertEqual(1, len(main._VIDEO_WORKSHOP_PROJECT_FINALIZERS))
            await main._stop_video_workshop_project_finalizers()
            self.assertEqual({}, main._VIDEO_WORKSHOP_PROJECT_FINALIZERS)


if __name__ == "__main__":
    unittest.main()
