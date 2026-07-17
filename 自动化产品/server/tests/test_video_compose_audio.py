import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from server.main import (
    AudioTimingClip,
    AudioTimingHint,
    AudioTimingReq,
    ComposeClip,
    _align_known_hint,
    _align_known_hints,
    _clean_transcript_text,
    _compose_clip_preprocess_command,
    _compose_audio_command,
    _correct_whisper_text,
    _effective_media_duration,
    _transcribe_with_whisper,
    _vad_analysis_command,
    _whisper_timed_chars,
    video_audio_timing,
)


class VideoComposeAudioTest(unittest.TestCase):
    def test_digital_human_bgm_keeps_base_voice_and_loops_music(self):
        command = _compose_audio_command(
            "ffmpeg",
            Path("base.mp4"),
            Path("mixed.mp4"),
            30.0,
            Path("narration.mp3"),
            Path("bgm.mp3"),
            has_base_audio=True,
            has_narr=True,
            has_bgm=True,
            preserve_clip_audio=True,
            narration_volume=1.0,
            bgm_volume=0.25,
        )
        joined = " ".join(command)
        self.assertIn("[0:a]volume=1.0[voice]", joined)
        self.assertIn("[2:a]volume=0.25[music]", joined)
        self.assertIn("amix=inputs=2:duration=longest", joined)
        self.assertIn("-stream_loop -1", joined)
        self.assertNotIn("-shortest", command)

    def test_transcript_guard_drops_box_glyphs_and_hallucinations(self):
        self.assertEqual(_clean_transcript_text("□ □ 真正的口播�"), "真正的口播")
        self.assertEqual(_correct_whisper_text("字幕由 Amara.org 提供", "真实口播内容"), "")
        self.assertEqual(_correct_whisper_text("字幕 by 李宗智", "真实口播内容"), "")
        self.assertEqual(_correct_whisper_text("完全无关的模型幻觉", "真实口播内容"), "")
        self.assertEqual(_correct_whisper_text("这是实际口播内容", "这是实际口播内容"), "这是实际口播内容")

    def test_full_whisper_tokens_align_only_to_known_narration(self):
        payload = {
            "transcription": [{
                "text": "先把任务说清楚",
                "offsets": {"from": 1000, "to": 3000},
                "tokens": [
                    {"text": char, "offsets": {"from": 1000 + index * 200, "to": 1180 + index * 200}}
                    for index, char in enumerate("先把任务说清楚")
                ],
            }]
        }
        timed = _whisper_timed_chars(payload, 5.0)
        cues = _align_known_hint(
            AudioTimingHint(text="先把任务说清楚", start=0.8, end=3.4),
            timed,
            5.0,
            strict=True,
        )
        self.assertTrue(cues)
        self.assertEqual("".join(cue["text"] for cue in cues), "先把任务说清楚")
        self.assertTrue(all(0.8 <= cue["start"] < cue["end"] <= 3.4 for cue in cues))
        self.assertTrue(all(cue["precise"] for cue in cues))

    def test_strict_info_flow_alignment_rejects_unspoken_prompt_text(self):
        timed = [
            {"char": char, "start": 1.0 + index * 0.2, "end": 1.16 + index * 0.2}
            for index, char in enumerate("这是完全不同的口播")
        ]
        cues = _align_known_hint(
            AudioTimingHint(text="禁止字幕不要二维码", start=0, end=4),
            timed,
            4.0,
            strict=True,
        )
        self.assertEqual(cues, [])

    def test_twenty_percent_anchor_does_not_spread_full_digital_script(self):
        timed = [
            {"char": char, "start": 0.4 + index * 0.12, "end": 0.5 + index * 0.12}
            for index, char in enumerate("今天天气完全不同")
        ]
        cues = _align_known_hint(
            AudioTimingHint(text="今天我们一起学习如何精准对齐字幕", start=0, end=5),
            timed,
            5.0,
            strict=False,
        )
        self.assertEqual(cues, [])

    def test_strict_alignment_only_emits_chunks_with_real_tokens(self):
        spoken = "这是已经真实说出口的一整段内容"
        timed = [
            {"char": char, "start": 0.5 + index * 0.13, "end": 0.61 + index * 0.13}
            for index, char in enumerate(spoken)
        ]
        cues = _align_known_hint(
            AudioTimingHint(text=spoken + "，禁止出现二维码。", start=0, end=6),
            timed,
            6.0,
            strict=True,
        )
        self.assertTrue(cues)
        self.assertNotIn("二维码", "".join(item["text"] for item in cues))

    def test_separate_spoken_hints_never_overlap_on_one_caption_lane(self):
        timed = [
            {"char": char, "start": index * 0.2, "end": index * 0.2 + 0.18}
            for index, char in enumerate("这是第一句话这是第二句话")
        ]
        cues = _align_known_hints(
            [
                AudioTimingHint(text="这是第一句话"),
                AudioTimingHint(text="这是第二句话"),
            ],
            timed,
            4.0,
            strict=True,
        )
        self.assertEqual(len(cues), 2)
        self.assertGreaterEqual(cues[1]["start"], cues[0]["end"])

    def test_audio_timing_clip_accepts_direct_audio_without_video_url(self):
        clip = AudioTimingClip(
            clipId="digital-1",
            audioUrl="/api/files/narration.mp3",
            trimIn=1.25,
            duration=8.5,
            text="清晰口播",
        )
        self.assertEqual(clip.url, "")
        self.assertEqual(clip.audioUrl, "/api/files/narration.mp3")
        self.assertEqual(clip.clipId, "digital-1")
        self.assertEqual(clip.trimIn, 1.25)
        self.assertEqual(clip.duration, 8.5)

    def test_effective_duration_respects_trim_and_requested_duration(self):
        self.assertEqual(_effective_media_duration(12, 2, 4), 4)
        self.assertEqual(_effective_media_duration(5, 2, 8), 3)
        self.assertEqual(_effective_media_duration(5, 8, 4), 0)
        self.assertEqual(_effective_media_duration(9, 1, None), 8)

    def test_whisper_uses_no_script_prompt_and_crops_clean_audio(self):
        payload = {
            "transcription": [{
                "text": "清晰口播内容",
                "offsets": {"from": 200, "to": 2200},
                "tokens": [
                    {"text": char, "offsets": {"from": 200 + index * 250, "to": 420 + index * 250}}
                    for index, char in enumerate("清晰口播内容")
                ],
            }]
        }
        commands = []

        def fake_run(command, **kwargs):
            commands.append(command)
            if command[0] == "ffmpeg":
                Path(command[-1]).write_bytes(b"wav")
                return SimpleNamespace(returncode=0, stderr="Duration: 00:00:12.00", stdout="")
            prefix = Path(command[command.index("-of") + 1])
            prefix.with_suffix(".json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            return SimpleNamespace(returncode=0, stderr="", stdout="")

        with tempfile.TemporaryDirectory() as td, patch(
            "server.main._whisper_cpp_paths",
            return_value=(Path("/tmp/whisper-cli"), Path("/tmp/ggml-base.bin")),
        ), patch("server.main.subprocess.run", side_effect=fake_run):
            cues, duration = _transcribe_with_whisper(
                "ffmpeg",
                Path("/tmp/narration.mp3"),
                Path(td),
                0,
                "清晰口播内容",
                [AudioTimingHint(text="清晰口播内容")],
                strict=True,
                trim_in=2,
                duration_limit=4,
            )
        self.assertTrue(cues)
        self.assertEqual(duration, 4)
        self.assertIn("-ss", commands[0])
        self.assertIn("2.000", commands[0])
        self.assertIn("-t", commands[0])
        self.assertIn("4.000", commands[0])
        self.assertIn("-l", commands[1])
        self.assertIn("zh", commands[1])
        self.assertNotIn("--prompt", commands[1])
        self.assertNotIn("清晰口播内容", commands[1])

    def test_whisper_gpu_failure_retries_real_cpu_inference_once(self):
        payload = {
            "transcription": [{
                "text": "真实口播",
                "offsets": {"from": 100, "to": 1600},
                "tokens": [
                    {"text": char, "offsets": {"from": 100 + index * 300, "to": 350 + index * 300}}
                    for index, char in enumerate("真实口播")
                ],
            }]
        }
        whisper_commands = []

        def fake_run(command, **kwargs):
            if command[0] == "ffmpeg":
                Path(command[-1]).write_bytes(b"wav")
                return SimpleNamespace(returncode=0, stderr="Duration: 00:00:02.00", stdout="")
            whisper_commands.append(command)
            if len(whisper_commands) == 1:
                return SimpleNamespace(returncode=-11, stderr="segmentation fault", stdout="")
            prefix = Path(command[command.index("-of") + 1])
            prefix.with_suffix(".json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            return SimpleNamespace(returncode=0, stderr="", stdout="")

        with tempfile.TemporaryDirectory() as td, patch.dict(
            "server.main.os.environ",
            {"ACG_WHISPER_FORCE_CPU": "false"},
            clear=False,
        ), patch(
            "server.main._whisper_cpp_paths",
            return_value=(Path("/tmp/whisper-cli"), Path("/tmp/ggml-base.bin")),
        ), patch("server.main.subprocess.run", side_effect=fake_run):
            cues, duration = _transcribe_with_whisper(
                "ffmpeg",
                Path("/tmp/narration.mp3"),
                Path(td),
                0,
                "真实口播",
                [AudioTimingHint(text="真实口播")],
                strict=True,
            )
        self.assertTrue(cues)
        self.assertEqual(duration, 2)
        self.assertEqual(len(whisper_commands), 2)
        self.assertNotIn("-ng", whisper_commands[0])
        self.assertIn("-ng", whisper_commands[1])

    def test_vad_and_compose_commands_apply_trim_and_duration(self):
        vad = _vad_analysis_command(
            "ffmpeg",
            Path("voice.mp3"),
            trim_in=1.5,
            duration_limit=6,
            threshold="-31dB",
        )
        self.assertIn("atrim=start=1.500:duration=6.000", " ".join(vad))
        self.assertIn("asetpts=PTS-STARTPTS", " ".join(vad))

        compose = _compose_clip_preprocess_command(
            "ffmpeg",
            Path("raw.mp4"),
            Path("trimmed.mp4"),
            ComposeClip(url="https://example.com/raw.mp4", trimIn=2.25, dur=7.5),
        )
        joined = " ".join(compose)
        self.assertIn("-ss 2.250", joined)
        self.assertIn("-t 7.500", joined)
        self.assertIn("-map 0:a:0?", joined)
        self.assertIn("-c:v libx264", joined)

class VideoAudioTimingEndpointTest(unittest.IsolatedAsyncioTestCase):
    async def test_direct_audio_response_reports_real_whisper_engine(self):
        req = AudioTimingReq(clips=[
            AudioTimingClip(
                clipId="clean-mp3",
                audioUrl="/api/files/clean.mp3",
                duration=3,
                text="真实口播",
            )
        ])
        with patch("server.main._ffmpeg_bin", return_value="ffmpeg"), patch(
            "server.main._write_audio_timing_source",
            new=AsyncMock(return_value="direct-audio"),
        ), patch(
            "server.main._transcribe_with_whisper",
            return_value=([{"start": 0.2, "end": 1.4, "text": "真实口播", "precise": True}], 3.0),
        ), patch("server.main._whisper_cpp_paths", return_value=(Path("whisper-cli"), Path("ggml-base.bin"))):
            result = await video_audio_timing(req)
        self.assertEqual(result["engine"], "whisper.cpp")
        self.assertEqual(result["source"], "whisper-post-align-v2-direct-audio")
        self.assertEqual(result["cues"][0]["clipId"], "clean-mp3")
        self.assertEqual(result["cues"][0]["inputSource"], "direct-audio")

    async def test_multi_clip_offsets_follow_video_timeline_not_short_audio(self):
        req = AudioTimingReq(clips=[
            AudioTimingClip(
                clipId="segment-1",
                audioUrl="/api/files/one.mp3",
                duration=5,
                text="第一段",
            ),
            AudioTimingClip(
                clipId="segment-2",
                audioUrl="/api/files/two.mp3",
                duration=4,
                text="第二段",
            ),
        ])
        with patch("server.main._ffmpeg_bin", return_value="ffmpeg"), patch(
            "server.main._write_audio_timing_source",
            new=AsyncMock(return_value="direct-audio"),
        ), patch(
            "server.main._transcribe_with_whisper",
            side_effect=[
                ([{"start": 0.2, "end": 2.8, "text": "第一段", "precise": True}], 3.0),
                ([{"start": 0.1, "end": 1.8, "text": "第二段", "precise": True}], 2.0),
            ],
        ), patch("server.main._whisper_cpp_paths", return_value=(Path("whisper-cli"), Path("ggml-base.bin"))):
            result = await video_audio_timing(req)
        self.assertEqual([(cue["start"], cue["end"]) for cue in result["cues"]], [(0.2, 2.8), (5.1, 6.8)])
        self.assertEqual(result["duration"], 9.0)

    async def test_whisper_binary_presence_does_not_fake_engine_after_quality_reject(self):
        req = AudioTimingReq(clips=[
            AudioTimingClip(
                clipId="reject",
                audioDataUrl="data:audio/mp3;base64,ZmFrZQ==",
                duration=4,
                text="真实口播",
            )
        ])
        vad_result = SimpleNamespace(returncode=0, stderr="Duration: 00:00:08.00", stdout="")
        with patch("server.main._ffmpeg_bin", return_value="ffmpeg"), patch(
            "server.main._write_audio_timing_source",
            new=AsyncMock(return_value="direct-audio"),
        ), patch(
            "server.main._transcribe_with_whisper",
            return_value=([], 4.0),
        ), patch(
            "server.main._whisper_cpp_paths",
            return_value=(Path("whisper-cli"), Path("ggml-base.bin")),
        ), patch("server.main.subprocess.run", return_value=vad_result):
            result = await video_audio_timing(req)
        self.assertEqual(result["engine"], "none")
        self.assertEqual(result["cues"], [])
        self.assertEqual(result["source"], "no-aligned-speech-v2-direct-audio")
        self.assertEqual(result["clipSources"][0]["attemptedEngine"], "whisper.cpp")

    async def test_trusted_digital_segment_uses_vad_when_whisper_has_no_anchor(self):
        req = AudioTimingReq(clips=[
            AudioTimingClip(
                clipId="digital-segment-1",
                audioDataUrl="data:audio/mp3;base64,ZmFrZQ==",
                duration=4,
                text="第一句清晰口播，第二句继续说明。",
                hints=[AudioTimingHint(text="第一句清晰口播，第二句继续说明。", start=0, end=4)],
                strict=False,
                trustedNarration=True,
            )
        ])
        vad_result = SimpleNamespace(
            returncode=0,
            stderr=(
                "Duration: 00:00:04.00\n"
                "[silencedetect] silence_start: 0\n"
                "[silencedetect] silence_end: 0.35\n"
                "[silencedetect] silence_start: 3.30\n"
            ),
            stdout="",
        )
        with patch("server.main._ffmpeg_bin", return_value="ffmpeg"), patch(
            "server.main._write_audio_timing_source",
            new=AsyncMock(return_value="direct-audio"),
        ), patch(
            "server.main._transcribe_with_whisper",
            return_value=([], 4.0),
        ), patch(
            "server.main._whisper_cpp_paths",
            return_value=(Path("whisper-cli"), Path("ggml-base.bin")),
        ), patch("server.main.subprocess.run", return_value=vad_result):
            result = await video_audio_timing(req)
        self.assertEqual(result["engine"], "ffmpeg-segment-vad")
        self.assertEqual(result["source"], "digital-segment-vad-v1-direct-audio")
        self.assertTrue(result["cues"])
        self.assertEqual("".join(cue["text"] for cue in result["cues"]), "第一句清晰口播，第二句继续说明。")
        self.assertTrue(all(0.35 <= cue["start"] < cue["end"] <= 3.30 for cue in result["cues"]))


if __name__ == "__main__":
    unittest.main()
