from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import main, media


class MediaSyncToleranceTests(unittest.IsolatedAsyncioTestCase):
    def test_container_rounding_does_not_block_delivery(self) -> None:
        media._assert_av_sync(92.600, 92.449, "变速成片")

    def test_few_seconds_of_audio_video_divergence_are_auto_accepted(self) -> None:
        media._assert_av_sync(92.600, 90.200, "变速成片")

    def test_visible_audio_video_divergence_still_fails(self) -> None:
        with self.assertRaisesRegex(media.MediaError, "音画时长不一致"):
            media._assert_av_sync(92.600, 86.000, "变速成片")

    async def test_visible_divergence_is_auto_repaired_against_narration(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "delivery.mp4"
            output.write_bytes(b"original")
            repaired_output = Path(tmp) / "delivery-sync-repair.mp4"
            probes = iter((
                {"duration": 92.6, "videoDuration": 92.6, "audioDuration": 86.0},
                {"duration": 86.0, "videoDuration": 86.0, "audioDuration": 86.0},
            ))
            commands = []

            async def fake_probe(_path):
                return next(probes)

            async def fake_run(command, _cwd=None):
                commands.append(command)
                repaired_output.write_bytes(b"repaired")

            with (
                patch.object(media, "probe", new=fake_probe),
                patch.object(media, "run", new=fake_run),
                patch.object(media, "_binary", side_effect=lambda value: value),
            ):
                result = await media._repair_av_sync(output, "成片")

            self.assertTrue(result["syncRepaired"])
            self.assertEqual(b"repaired", output.read_bytes())
            self.assertFalse(repaired_output.exists())
            self.assertIn("setpts=PTS/1.07674419", commands[0][commands[0].index("-filter_complex") + 1])
            self.assertIn("trim=duration=86.000000", commands[0][commands[0].index("-filter_complex") + 1])

    def test_finished_scenes_can_retry_from_recompose_stage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp)
            project_id = "sync-recompose"
            work_dir = output_root / project_id
            work_dir.mkdir(parents=True)
            (work_dir / "narration.mp3").write_bytes(b"audio")
            (work_dir / "scene-01.mp4").write_bytes(b"video")
            project = {
                "id": project_id,
                "error": "变速成片音画时长不一致：视频 92.600 秒，音频 92.449 秒",
                "plan": {"scenes": [{"title": "镜头 1"}]},
            }
            with patch.object(main, "settings", replace(main.settings, outputs_dir=output_root)):
                self.assertEqual(
                    {"type": "recompose", "sceneNumber": 1},
                    main._retry_info(project),
                )

    def test_historical_pipeline_error_remains_retryable_after_chat_replies(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            output_root = Path(tmp)
            project_id = "historical-sync-recompose"
            work_dir = output_root / project_id
            work_dir.mkdir(parents=True)
            (work_dir / "narration.mp3").write_bytes(b"audio")
            (work_dir / "scene-01.mp4").write_bytes(b"video")
            project = {
                "id": project_id,
                "status": "conversation",
                "error": "",
                "messages": [
                    {
                        "role": "assistant",
                        "kind": "error",
                        "content": "制作在当前步骤停住了：变速成片音画时长不一致：视频 92.600 秒，音频 92.449 秒",
                    },
                    {"role": "user", "kind": "message", "content": "没关系继续合成"},
                    {"role": "assistant", "kind": "question", "content": "我会继续按流程推进。"},
                    {"role": "user", "kind": "message", "content": "继续"},
                    {"role": "assistant", "kind": "question", "content": "继续按流程推进。"},
                ],
                "plan": {"scenes": [{"title": "镜头 1"}]},
            }
            with patch.object(main, "settings", replace(main.settings, outputs_dir=output_root)):
                self.assertEqual(
                    {"type": "recompose", "sceneNumber": 1},
                    main._retry_info(project),
                )
            self.assertTrue(main._is_continue_request("没关系继续合成"))
            self.assertTrue(main._is_continue_request("继续"))


class HistoricalRecomposeEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_retry_endpoint_schedules_recompose_from_conversation_shell(self) -> None:
        project = {
            "id": "old-conversation",
            "status": "conversation",
            "phase": "brief",
            "progress": 6,
            "error": "",
            "messages": [
                {
                    "role": "assistant",
                    "kind": "error",
                    "content": "变速成片音画时长不一致：视频 92.600 秒，音频 92.449 秒",
                },
                {"role": "assistant", "kind": "question", "content": "继续按流程推进。"},
            ],
            "plan": {"scenes": [{"title": "镜头 1"}]},
        }
        loaded = dict(project)
        scheduled = []

        def mutate(_project_id, callback):
            callback(loaded)
            return loaded

        with (
            patch.object(main, "load_project", side_effect=lambda _project_id: loaded),
            patch.object(main, "mutate_project", side_effect=mutate),
            patch.object(main, "add_event"),
            patch.object(main, "add_message"),
            patch.object(main, "_project_has_active_work", return_value=False),
            patch.object(
                main,
                "_retry_info",
                return_value={"type": "recompose", "sceneNumber": 1},
            ),
            patch.object(
                main,
                "_schedule",
                side_effect=lambda project_id, plan, **options: scheduled.append(
                    (project_id, plan, options)
                ) or True,
            ),
        ):
            response = await main.project_retry("old-conversation")

        self.assertEqual("running", loaded["status"])
        self.assertEqual("recovery", loaded["phase"])
        self.assertEqual([("old-conversation", project["plan"], {"recompose_only": True})], scheduled)
        self.assertEqual("old-conversation", response["id"])


if __name__ == "__main__":
    unittest.main()
