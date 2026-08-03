from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

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


if __name__ == "__main__":
    unittest.main()
