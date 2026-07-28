import hashlib
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


APP_DIR = Path(__file__).resolve().parents[2]
VIDEO_DIR = APP_DIR / "apps" / "video-workshop"
if str(VIDEO_DIR) not in sys.path:
    sys.path.insert(0, str(VIDEO_DIR))

from app import bgm as bgm_module


def _make_asset_db(path: Path, assets: list[dict]) -> None:
    connection = sqlite3.connect(path)
    try:
        connection.execute(
            """
            CREATE TABLE docs(
              collection TEXT NOT NULL,
              id TEXT NOT NULL,
              owner_id TEXT,
              updated_at INTEGER NOT NULL DEFAULT 0,
              data TEXT NOT NULL,
              PRIMARY KEY(collection, id)
            )
            """
        )
        for index, asset in enumerate(assets, start=1):
            connection.execute(
                "INSERT INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
                (
                    "assets",
                    str(asset.get("id") or f"asset-{index}"),
                    asset.get("ownerId"),
                    index,
                    json.dumps(asset, ensure_ascii=False),
                ),
            )
        connection.execute(
            "INSERT INTO docs(collection,id,owner_id,updated_at,data) VALUES(?,?,?,?,?)",
            ("accounts", "ignored", None, 1, "{}"),
        )
        connection.commit()
    finally:
        connection.close()


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class VideoWorkshopPlatformBgmTest(unittest.TestCase):
    def test_relevant_candidates_are_stably_randomized_per_project(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            tracks = [
                bgm_module.BgmTrack("light-a", "轻快办公节奏 A", root / "a.mp3", "platform", "轻快 明亮"),
                bgm_module.BgmTrack("light-b", "轻快办公节奏 B", root / "b.mp3", "platform", "轻快 明亮"),
                bgm_module.BgmTrack("calm", "沉稳叙事钢琴", root / "c.mp3", "platform", "沉稳 克制"),
            ]
            plan = {
                "title": "轻松的办公效率短片",
                "tone": "明亮轻快",
                "audio_design": {"bgm_mood": "轻快"},
            }
            first = bgm_module._pick_track("same-project", plan, tracks)
            self.assertEqual(first, bgm_module._pick_track("same-project", plan, tracks))
            selected = {
                bgm_module._pick_track(f"project-{index}", plan, tracks).id
                for index in range(32)
            }
            self.assertEqual(selected, {"light-a", "light-b"})
            self.assertNotIn("calm", selected)

    def _settings(self, database: Path, uploads: Path) -> SimpleNamespace:
        return SimpleNamespace(
            platform_data_db=database,
            platform_upload_dir=uploads,
        )

    def test_catalog_reads_only_shared_platform_bgm_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            uploads = root / "uploads"
            uploads.mkdir()
            (uploads / "bgm-one.mp3").write_bytes(b"first-track")
            (uploads / "bgm-two.wav").write_bytes(b"second-track")
            (uploads / "voice.mp3").write_bytes(b"voice")
            (uploads / "not-audio.png").write_bytes(b"image")

            outside = root / "outside.mp3"
            outside.write_bytes(b"must-not-be-readable")
            symlink = uploads / "escaped.mp3"
            try:
                symlink.symlink_to(outside)
            except OSError:
                symlink = None

            assets = [
                {
                    "id": "bgm-one",
                    "type": "音频",
                    "name": "轻快办公 BGM",
                    "tags": ["音乐"],
                    "serverFileName": "bgm-one.mp3",
                },
                {
                    "id": "bgm-two",
                    "type": "音频",
                    "name": "清晨氛围",
                    "tags": ["音乐库", "配乐"],
                    "fileUrl": "/api/files/bgm-two.wav",
                },
                {
                    "id": "voice-named-bgm",
                    "type": "音频",
                    "name": "语音_070435",
                    "tags": ["BGM", "音乐"],
                    "serverFileName": "bgm-one.mp3",
                },
                {
                    "id": "voice",
                    "type": "音频",
                    "name": "数字人口播 BGM",
                    "tags": ["BGM", "语音", "TTS"],
                    "serverFileName": "voice.mp3",
                },
                {
                    "id": "image",
                    "type": "图片",
                    "name": "BGM 封面",
                    "tags": ["音乐库"],
                    "serverFileName": "not-audio.png",
                },
                {
                    "id": "traversal",
                    "type": "音频",
                    "name": "危险配乐",
                    "tags": ["BGM"],
                    "serverFileName": "../outside.mp3",
                    "fileUrl": "/api/files/%2e%2e%2foutside.mp3",
                },
                {
                    "id": "absolute-url",
                    "type": "音频",
                    "name": "外部 BGM",
                    "tags": ["BGM"],
                    "fileUrl": "https://example.com/api/files/outside.mp3",
                },
            ]
            if symlink is not None:
                assets.append({
                    "id": "symlink",
                    "type": "音频",
                    "name": "越界配乐",
                    "tags": ["BGM"],
                    "serverFileName": symlink.name,
                })

            database = root / "data.sqlite"
            _make_asset_db(database, assets)
            before_db = _sha256(database)
            before_uploads = {
                item.name: _sha256(item)
                for item in uploads.iterdir()
                if item.is_file() and not item.is_symlink()
            }

            library = bgm_module.PlatformBgmLibrary()
            with patch.object(
                bgm_module,
                "settings",
                self._settings(database, uploads),
            ):
                catalog = library.catalog()

            self.assertEqual(
                {item["id"] for item in catalog},
                {
                    "platform:bgm-one",
                    "platform:bgm-two",
                    "platform:voice-named-bgm",
                },
            )
            self.assertTrue(all(item["source"] == "platform" for item in catalog))
            self.assertTrue(all("path" not in item for item in catalog))
            self.assertEqual(_sha256(database), before_db)
            self.assertEqual({
                item.name: _sha256(item)
                for item in uploads.iterdir()
                if item.is_file() and not item.is_symlink()
            }, before_uploads)

    def test_resolve_honors_requested_track_and_empty_library_is_optional(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            uploads = root / "uploads"
            uploads.mkdir()
            (uploads / "one.mp3").write_bytes(b"one")
            (uploads / "two.mp3").write_bytes(b"two")
            database = root / "data.sqlite"
            _make_asset_db(database, [
                {
                    "id": "one",
                    "type": "音频",
                    "name": "第一首 BGM",
                    "tags": ["BGM"],
                    "serverFileName": "one.mp3",
                },
                {
                    "id": "two",
                    "type": "音频",
                    "name": "第二首配乐",
                    "tags": ["配乐"],
                    "fileUrl": "/api/files/two.mp3",
                },
            ])

            library = bgm_module.PlatformBgmLibrary()
            with patch.object(
                bgm_module,
                "settings",
                self._settings(database, uploads),
            ):
                self.assertIsNone(library.resolve("project-a", {
                    "audio_design": {"bgm_enabled": False},
                }))
                selected = library.resolve("project-a", {
                    "title": "测试视频",
                    "audio_design": {
                        "bgm_enabled": True,
                        "bgm_track_id": "platform:two",
                    },
                })
                fallback_one = library.resolve("project-a", {
                    "title": "测试视频",
                    "audio_design": {
                        "bgm_enabled": True,
                        "bgm_track_id": "",
                        "bgm_mood": "轻快",
                    },
                })
                fallback_two = library.resolve("project-a", {
                    "title": "测试视频",
                    "audio_design": {
                        "bgm_enabled": True,
                        "bgm_track_id": "",
                        "bgm_mood": "轻快",
                    },
                })

            self.assertIsNotNone(selected)
            self.assertEqual(selected.id, "platform:two")
            self.assertEqual(selected.path, (uploads / "two.mp3").resolve())
            self.assertEqual(fallback_one, fallback_two)

            missing_database = root / "missing.sqlite"
            with patch.object(
                bgm_module,
                "settings",
                self._settings(missing_database, uploads),
            ):
                self.assertEqual(library.catalog(), [])
                self.assertIsNone(library.resolve("project-a", {
                    "audio_design": {"bgm_enabled": True},
                }))


if __name__ == "__main__":
    unittest.main()
