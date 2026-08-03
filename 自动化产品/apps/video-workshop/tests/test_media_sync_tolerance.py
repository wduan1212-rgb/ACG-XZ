from __future__ import annotations

import math
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from app import main, media


class MediaSyncToleranceTests(unittest.IsolatedAsyncioTestCase):
    async def test_static_frame_uses_one_monotonic_centered_zoom_without_resets(self) -> None:
        commands = []

        async def fake_run(command, _cwd=None):
            commands.append(command)

        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "frame.jpg"
            output = Path(tmp) / "frame.mp4"
            source.write_bytes(b"\xff\xd8\xffframe")
            with (
                patch.object(media, "run", new=fake_run),
                patch.object(media, "probe", return_value={"duration": 7.0}),
                patch.object(media, "_binary", side_effect=lambda value: value),
            ):
                await media.render_still_clip(source, output, "16:9", 7.0)

        command = commands[0]
        video_filter = command[command.index("-vf") + 1]
        self.assertIn("scale=5120:2880", video_filter)
        self.assertIn("min(on,209)", video_filter)
        self.assertIn("d=1:s=2560x1440:fps=30", video_filter)
        self.assertIn("x='trunc((iw-iw/zoom)/2)'", video_filter)
        self.assertIn("y='trunc((ih-ih/zoom)/2)'", video_filter)
        self.assertIn(
            "scale=1280:720:flags=lanczos+accurate_rnd+full_chroma_int",
            video_filter,
        )
        self.assertEqual("210", command[command.index("-frames:v") + 1])
        self.assertIn("-framerate", command)

    def test_static_zoom_path_is_monotonic_and_keeps_optical_center_stable(self) -> None:
        duration = 7.0
        frames, video_filter = media._still_zoom_filter(1280, 720, duration)
        self.assertEqual(210, frames)
        self.assertNotIn("sin(", video_filter)
        self.assertNotIn("mod(", video_filter)
        self.assertNotIn("pzoom", video_filter)

        canvas_width = 1280 * 4
        canvas_height = 720 * 4
        zoom_delta = min(0.05, max(0.008, duration * 0.006))
        samples: list[tuple[float, int, int]] = []
        center_errors: list[tuple[float, float]] = []
        for frame in range(frames):
            zoom = 1 + zoom_delta * frame / (frames - 1)
            x = math.trunc((canvas_width - canvas_width / zoom) / 2)
            y = math.trunc((canvas_height - canvas_height / zoom) / 2)
            samples.append((zoom, x, y))

            visible_width = canvas_width / zoom
            visible_height = canvas_height / zoom
            # Convert high-resolution source-pixel centre error back to the
            # delivered frame.  The 4x source and 2x zoompan output keep the
            # deterministic crop quantisation far below one delivered pixel.
            center_errors.append(
                (
                    (x + visible_width / 2 - canvas_width / 2) * 1280 / visible_width,
                    (y + visible_height / 2 - canvas_height / 2) * 720 / visible_height,
                )
            )

        self.assertTrue(all(current[0] >= previous[0] for previous, current in zip(samples, samples[1:])))
        self.assertTrue(all(current[1] >= previous[1] for previous, current in zip(samples, samples[1:])))
        self.assertTrue(all(current[2] >= previous[2] for previous, current in zip(samples, samples[1:])))
        self.assertLessEqual(max(abs(error) for pair in center_errors for error in pair), 0.26)
        self.assertAlmostEqual(1.042, samples[-1][0], places=6)

    def test_static_zoom_stays_slow_for_long_narration_beats(self) -> None:
        frames, video_filter = media._still_zoom_filter(1280, 720, 20.0)
        self.assertEqual(600, frames)
        self.assertIn("1+0.050000*min(on,599)/599", video_filter)

    def test_dynamic_image_cutaway_keeps_pre_v136_motion_filter(self) -> None:
        frames, video_filter = media._material_still_zoom_filter(1280, 720, 7.0)
        self.assertEqual(210, frames)
        self.assertIn("d=1:s=1280x720:fps=30", video_filter)
        self.assertIn("x='2*trunc((iw-iw/zoom)/4)'", video_filter)
        self.assertIn("y='2*trunc((ih-ih/zoom)/4)'", video_filter)
        self.assertNotIn("scale=1280:720:flags=lanczos", video_filter)

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
