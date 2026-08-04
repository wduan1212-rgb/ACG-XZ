import asyncio
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from server import main, store


class VideoComposeIdempotencyTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.previous = {
            "db": store.DB_PATH,
            "blob": store.CUSTOM_CANVAS_BLOB_DIR,
            "uploads": store.PRIVATE_MEDIA_UPLOAD_DIR,
            "composed": store.PRIVATE_MEDIA_COMPOSED_DIR,
            "main_composed": main.COMPOSED_DIR,
            "initialized": store._initialized,
        }
        store.DB_PATH = self.root / "compose.sqlite"
        store.CUSTOM_CANVAS_BLOB_DIR = self.root / "canvas-blobs"
        store.PRIVATE_MEDIA_UPLOAD_DIR = self.root / "uploads"
        store.PRIVATE_MEDIA_COMPOSED_DIR = self.root / "composed"
        main.COMPOSED_DIR = self.root / "composed"
        store._initialized = False
        first = store.add_member("合成用户 A", "compose-a", "123456", "editor")
        second = store.add_member("合成用户 B", "compose-b", "123456", "editor")
        self.member_a = {"id": first[0], "role": "editor", "teamId": ""}
        self.member_b = {"id": second[0], "role": "editor", "teamId": ""}

    def tearDown(self):
        store.DB_PATH = self.previous["db"]
        store.CUSTOM_CANVAS_BLOB_DIR = self.previous["blob"]
        store.PRIVATE_MEDIA_UPLOAD_DIR = self.previous["uploads"]
        store.PRIVATE_MEDIA_COMPOSED_DIR = self.previous["composed"]
        main.COMPOSED_DIR = self.previous["main_composed"]
        store._initialized = self.previous["initialized"]
        self.temp.cleanup()

    @staticmethod
    def request(*, production_id="production-1", clip="/api/video/composed/clip-a.mp4"):
        return main.ComposeReq(
            productionId=production_id,
            title="批量成片",
            clips=[main.ComposeClip(url=clip, dur=5)],
            preserveClipAudio=True,
            subtitles=[main.ComposeSubtitle(start=0, end=2, text="字幕")],
        )

    async def test_two_concurrent_tabs_render_once_and_reuse_one_output(self):
        calls = 0

        async def render(_request, _member, out_name):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.08)
            main.COMPOSED_DIR.mkdir(parents=True, exist_ok=True)
            path = main.COMPOSED_DIR / out_name
            path.write_bytes(b"one-compose-output")
            return path

        with patch.object(main, "_video_compose_once", side_effect=render):
            first, second = await asyncio.gather(
                main.video_compose(self.request(), self.member_a),
                main.video_compose(self.request(), self.member_a),
            )

        self.assertEqual(1, calls)
        self.assertEqual(first["url"], second["url"])
        self.assertEqual({False, True}, {first["reused"], second["reused"]})
        self.assertEqual(1, len(list(main.COMPOSED_DIR.glob("*.mp4"))))
        with sqlite3.connect(store.DB_PATH) as conn:
            self.assertEqual(
                (1, 1),
                (
                    conn.execute("SELECT COUNT(*) FROM video_compose_operations").fetchone()[0],
                    conn.execute("SELECT COUNT(*) FROM private_media_registry WHERE media_kind='composed'").fetchone()[0],
                ),
            )
            row = conn.execute(
                "SELECT state,attempt,output_name FROM video_compose_operations"
            ).fetchone()
        self.assertEqual("succeeded", row[0])
        self.assertEqual(1, row[1])
        self.assertTrue(row[2].endswith(".mp4"))

    async def test_failed_attempt_is_retryable_and_success_then_replays(self):
        attempts = 0

        async def render(_request, _member, out_name):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise HTTPException(502, "ffmpeg 合成失败")
            main.COMPOSED_DIR.mkdir(parents=True, exist_ok=True)
            path = main.COMPOSED_DIR / out_name
            path.write_bytes(b"retry-output")
            return path

        with patch.object(main, "_video_compose_once", side_effect=render):
            with self.assertRaises(HTTPException) as raised:
                await main.video_compose(self.request(), self.member_a)
            self.assertEqual(502, raised.exception.status_code)
            success = await main.video_compose(self.request(), self.member_a)
            replay = await main.video_compose(self.request(), self.member_a)

        self.assertEqual(2, attempts)
        self.assertFalse(success["reused"])
        self.assertTrue(replay["reused"])
        self.assertEqual(success["url"], replay["url"])
        with sqlite3.connect(store.DB_PATH) as conn:
            row = conn.execute(
                "SELECT state,attempt,error FROM video_compose_operations"
            ).fetchone()
        self.assertEqual(("succeeded", 2, ""), row)

    async def test_same_production_and_timeline_remain_owner_isolated(self):
        calls = 0

        async def render(_request, _member, out_name):
            nonlocal calls
            calls += 1
            main.COMPOSED_DIR.mkdir(parents=True, exist_ok=True)
            path = main.COMPOSED_DIR / out_name
            path.write_bytes(f"owner-{calls}".encode())
            return path

        with patch.object(main, "_video_compose_once", side_effect=render):
            first, second = await asyncio.gather(
                main.video_compose(self.request(), self.member_a),
                main.video_compose(self.request(), self.member_b),
            )

        self.assertEqual(2, calls)
        self.assertNotEqual(first["url"], second["url"])
        with sqlite3.connect(store.DB_PATH) as conn:
            owners = conn.execute(
                "SELECT DISTINCT owner_id FROM video_compose_operations ORDER BY owner_id"
            ).fetchall()
        self.assertEqual(2, len(owners))

    def test_store_rejects_same_operation_key_with_different_fingerprint(self):
        first = store.begin_video_compose_operation(
            self.member_a["id"], "fixed-key", "production-1", "a" * 64,
        )
        self.assertTrue(first["claimed"])
        with self.assertRaises(store.VideoComposeOperationConflict):
            store.begin_video_compose_operation(
                self.member_a["id"], "fixed-key", "production-1", "b" * 64,
            )


if __name__ == "__main__":
    unittest.main()
