from __future__ import annotations

import asyncio
import json
import math
import re
import shutil
import subprocess
import unicodedata
from pathlib import Path
from typing import Any


ASPECTS: dict[str, tuple[int, int]] = {
    "9:16": (720, 1280),
    "16:9": (1280, 720),
    "1:1": (960, 960),
    "4:3": (960, 720),
    "3:4": (720, 960),
    "21:9": (1260, 540),
}
AV_SYNC_BASE_TOLERANCE_SECONDS = 3.0
AV_SYNC_MAX_TOLERANCE_SECONDS = 5.0
AV_SYNC_RELATIVE_TOLERANCE = 0.03
AV_SYNC_AUTO_REPAIR_MIN_VIDEO_RATE = 0.25
AV_SYNC_AUTO_REPAIR_MAX_VIDEO_RATE = 4.0


class MediaError(RuntimeError):
    pass


def _assert_av_sync(video_duration: float, audio_duration: float, label: str) -> None:
    """Allow bounded encoding drift while still rejecting a visibly broken timeline."""
    longest = max(video_duration, audio_duration, 0.0)
    tolerance = min(
        AV_SYNC_MAX_TOLERANCE_SECONDS,
        max(AV_SYNC_BASE_TOLERANCE_SECONDS, longest * AV_SYNC_RELATIVE_TOLERANCE),
    )
    if audio_duration <= 0 or abs(video_duration - audio_duration) > tolerance:
        raise MediaError(
            f"{label}音画时长不一致：视频 {video_duration:.3f} 秒，音频 {audio_duration:.3f} 秒"
            f"（允许误差 {tolerance:.3f} 秒）"
        )


async def _repair_av_sync(path: Path, label: str) -> dict[str, Any]:
    """Keep narration as the source of truth and repair a mismatched picture track once."""
    current = await probe(path)
    video_duration = float(current.get("videoDuration") or current.get("duration") or 0)
    audio_duration = float(current.get("audioDuration") or 0)
    try:
        _assert_av_sync(video_duration, audio_duration, label)
        current["syncRepaired"] = False
        return current
    except MediaError as original_error:
        video_rate = video_duration / audio_duration if audio_duration > 0 else 0
        if not (AV_SYNC_AUTO_REPAIR_MIN_VIDEO_RATE <= video_rate <= AV_SYNC_AUTO_REPAIR_MAX_VIDEO_RATE):
            raise MediaError(
                f"{original_error}；已尝试按口播重校画面，但源片轨道比例超出安全修复范围"
            ) from original_error
        repaired_path = path.with_name(f"{path.stem}-sync-repair{path.suffix}")
        try:
            await run(
                [
                    _binary("ffmpeg"), "-y", "-i", str(path),
                    "-filter_complex",
                    (
                        f"[0:v]setpts=PTS/{video_rate:.8f},fps=30,"
                        f"trim=duration={audio_duration:.6f}[v];"
                        f"[0:a]asetpts=PTS-STARTPTS,apad,"
                        f"atrim=duration={audio_duration:.6f}[a]"
                    ),
                    "-map", "[v]", "-map", "[a]",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                    "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
                    "-movflags", "+faststart", str(repaired_path),
                ]
            )
            repaired = await probe(repaired_path)
            repaired_video = float(repaired.get("videoDuration") or repaired.get("duration") or 0)
            repaired_audio = float(repaired.get("audioDuration") or 0)
            _assert_av_sync(repaired_video, repaired_audio, label)
            repaired_path.replace(path)
            repaired["syncRepaired"] = True
            return repaired
        finally:
            if repaired_path.exists():
                repaired_path.unlink()


def _finite_number(value: Any, default: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return result if math.isfinite(result) else default


def _binary(name: str) -> str:
    value = shutil.which(name)
    if not value:
        raise MediaError(f"缺少 {name}，无法完成本地视频处理")
    return value


def _run_sync(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    process = subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        text=True,
        capture_output=True,
        check=False,
    )
    if process.returncode != 0:
        detail = (process.stderr or process.stdout)[-2400:]
        raise MediaError(f"媒体处理失败：{detail}")
    return process


async def run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return await asyncio.to_thread(_run_sync, command, cwd)


async def probe(path: Path) -> dict[str, Any]:
    result = await run(
        [
            _binary("ffprobe"),
            "-v",
            "error",
            "-show_entries",
            "format=duration,size:stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,sample_rate,channels,duration,start_time",
            "-of",
            "json",
            str(path),
        ]
    )
    data = json.loads(result.stdout)
    streams = data.get("streams") or []
    video = next((item for item in streams if item.get("codec_type") == "video"), {})
    audio = next((item for item in streams if item.get("codec_type") == "audio"), {})
    return {
        "duration": round(float((data.get("format") or {}).get("duration") or 0), 3),
        "videoDuration": round(float(video.get("duration") or 0), 3) if video else 0,
        "audioDuration": round(float(audio.get("duration") or 0), 3) if audio else 0,
        "size": int((data.get("format") or {}).get("size") or 0),
        "width": video.get("width"),
        "height": video.get("height"),
        "pixelFormat": video.get("pix_fmt"),
        "videoCodec": video.get("codec_name"),
        "frameRate": video.get("r_frame_rate"),
        "hasAudio": bool(audio),
        "audioCodec": audio.get("codec_name"),
        "sampleRate": audio.get("sample_rate"),
    }


async def extract_video_preview(source: Path, output: Path) -> dict[str, Any]:
    info = await probe(source)
    duration = float(info.get("duration") or 0)
    seek = min(max(0.0, duration * 0.28), 3.0)
    await run(
        [
            _binary("ffmpeg"),
            "-y",
            "-ss",
            f"{seek:.3f}",
            "-i",
            str(source),
            "-frames:v",
            "1",
            "-vf",
            "scale=960:960:force_original_aspect_ratio=decrease",
            "-q:v",
            "3",
            str(output),
        ]
    )
    return info


async def normalize_narration(source: Path, output: Path) -> dict[str, Any]:
    await run(
        [
            _binary("ffmpeg"),
            "-y",
            "-i",
            str(source),
            "-vn",
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    return await probe(output)


def _ass_time(seconds: float) -> str:
    centiseconds = max(0, int(round(seconds * 100)))
    hours, remainder = divmod(centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    secs, cs = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{cs:02d}"


def _caption_chunks(text: str, max_chars: int) -> list[str]:
    compact = re.sub(r"\s+", "", text.strip())
    raw_phrases = [item for item in re.split(r"[，。！？；：、,.!?;:…]+", compact) if item]
    phrases = [
        "".join(character for character in phrase if not unicodedata.category(character).startswith("P"))
        for phrase in raw_phrases
    ]
    phrases = [phrase for phrase in phrases if phrase]
    clean = "".join(phrases)
    chunks: list[str] = []
    for phrase in phrases:
        while len(phrase) > max_chars:
            chunks.append(phrase[:max_chars])
            phrase = phrase[max_chars:]
        if phrase:
            chunks.append(phrase)
    return chunks or [clean]


def write_ass(
    text: str,
    path: Path,
    aspect_ratio: str,
    speech_duration: float,
    subtitle_style: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    width, height = ASPECTS[aspect_ratio]
    if aspect_ratio == "9:16":
        font_size, outline, margin_v, max_chars = 48, 1.4, 330, 14
    elif aspect_ratio == "16:9":
        font_size, outline, margin_v, max_chars = 38, 1.25, 58, 24
    else:
        font_size, outline, margin_v, max_chars = 42, 1.35, 88, 18
    style = subtitle_style if isinstance(subtitle_style, dict) else {}
    font_scale = max(0.7, min(1.4, _finite_number(style.get("font_scale"), 1.0)))
    font_size = max(22, min(72, int(round(font_size * font_scale))))
    requested_max_chars = int(_finite_number(style.get("max_chars"), max_chars))
    max_chars = max(7, min(32, requested_max_chars))
    vertical_position = str(style.get("vertical_position") or "default")
    if vertical_position == "higher":
        margin_v = min(height - 120, margin_v + max(36, int(height * 0.075)))
    elif vertical_position == "lower":
        margin_v = max(36, margin_v - max(28, int(height * 0.06)))
    animation_mode = str(style.get("animation") or "dynamic")
    chunks = _caption_chunks(text, max_chars)
    weights = [max(2, len(item)) for item in chunks]
    total_weight = sum(weights)
    usable_duration = max(0.5, _finite_number(speech_duration, 0.5))
    minimum_cue = min(0.55, usable_duration / len(chunks))
    flexible_duration = max(0.0, usable_duration - minimum_cue * len(chunks))
    cue_durations = [minimum_cue + flexible_duration * weight / total_weight for weight in weights]
    cues = []
    cursor = 0.0
    for index, (chunk, duration) in enumerate(zip(chunks, cue_durations)):
        if index == len(chunks) - 1:
            end = usable_duration
        else:
            end = min(usable_duration, cursor + duration)
        if end <= cursor:
            break
        safe_text = "".join(
            character
            for character in chunk.replace("{", "").replace("}", "").replace("\\", "")
            if not unicodedata.category(character).startswith("P")
        )
        cues.append({"start": cursor, "end": end, "text": safe_text})
        cursor = end

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding
Style: Caption,PingFang SC,{font_size},&H00FFFFFF,&H00FFFFFF,&H94000000,&H00000000,-1,0,0,0,100,100,0,0,1,{outline},0.25,2,46,46,{margin_v},1

[Events]
Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text
"""
    lines = [header]
    for index, cue in enumerate(cues):
        if animation_mode == "minimal":
            animation = r"{\fad(80,70)}"
        elif aspect_ratio == "9:16" and index % 3 == 1:
            baseline = height - margin_v
            animation = (
                r"{\an2\fad(100,85)"
                f"\\move({width // 2},{baseline + 12},{width // 2},{baseline},0,220)"
                r"\fscx99\fscy99\t(0,220,\fscx100\fscy100)}"
            )
        elif index % 3 == 2:
            animation = r"{\fad(105,85)\fsp3\t(0,240,\fsp0)}"
        else:
            animation = r"{\fad(110,90)\fscx96\fscy96\t(0,170,\fscx104\fscy104)\t(170,310,\fscx100\fscy100)}"
        lines.append(
            "Dialogue: 0,%s,%s,Caption,,0,0,0,,%s%s\n"
            % (_ass_time(cue["start"]), _ass_time(cue["end"]), animation, cue["text"])
        )
    path.write_text("".join(lines), encoding="utf-8")
    return cues


def build_scene_timeline(
    planned_durations: list[float | int],
    total_duration: float,
) -> tuple[list[dict[str, Any]], float]:
    if not planned_durations:
        raise MediaError("导演计划没有可用于合成的镜头")
    total = max(0.5, _finite_number(total_duration, 0.5))
    source_weights = [max(0.1, _finite_number(value, 1.0)) for value in planned_durations]
    part_counts = [1] * len(source_weights)
    # Keep the director's semantic scene plan intact, but never stretch one
    # generated source past Seedance's native 15-second window.  Longer real
    # narration windows become independent visual beats downstream instead of
    # replaying or slowing a single generated clip.
    maximum_window = 15.0

    # Split only the technical render windows.  The logical director scenes and
    # their relative rhythm stay untouched, while every Seedance-sized window
    # remains producible after the real narration duration is known.
    while True:
        fragments = [
            {
                "sourceSceneNumber": source_index + 1,
                "segmentNumber": segment_index + 1,
                "segmentCount": part_counts[source_index],
                "weight": source_weights[source_index] / part_counts[source_index],
            }
            for source_index in range(len(source_weights))
            for segment_index in range(part_counts[source_index])
        ]
        count = len(fragments)
        weight_sum = sum(float(item["weight"]) for item in fragments)
        if count == 1:
            transition = 0.0
        else:
            transition = min(0.35, max(0.0, total / (count * 3)))
            # Crossfades consume overlapping source time.  Reduce the transition
            # before splitting a scene whose only excess is that overlap.
            largest_weight = max(float(item["weight"]) for item in fragments)
            capacity_transition = (
                maximum_window * weight_sum / largest_weight - total
            ) / (count - 1)
            if capacity_transition >= 0:
                transition = min(transition, capacity_transition)
        available = total + transition * (count - 1)
        durations = [available * float(item["weight"]) / weight_sum for item in fragments]
        offenders = {
            int(item["sourceSceneNumber"]) - 1
            for item, duration in zip(fragments, durations)
            if duration > maximum_window + 1e-6
        }
        if not offenders:
            break
        for source_index in offenders:
            part_counts[source_index] += 1

    durations[-1] = available - sum(durations[:-1])
    timeline: list[dict[str, Any]] = []
    start = 0.0
    for index, (fragment, duration) in enumerate(zip(fragments, durations)):
        end = start + duration
        timeline.append(
            {
                "sceneNumber": index + 1,
                "sourceSceneNumber": fragment["sourceSceneNumber"],
                "segmentNumber": fragment["segmentNumber"],
                "segmentCount": fragment["segmentCount"],
                "start": start,
                "end": end,
                "duration": duration,
            }
        )
        start = end - transition
    timeline[-1]["end"] = total
    timeline[-1]["duration"] = total - timeline[-1]["start"]
    return timeline, transition


async def _normalize_clip(
    source: Path,
    output: Path,
    width: int,
    height: int,
    target_duration: float,
    source_duration: float | None = None,
) -> None:
    measured_duration = _finite_number(source_duration, 0.0)
    if measured_duration <= 0:
        measured_duration = float((await probe(source)).get("duration") or 0)
    if measured_duration <= 0:
        raise MediaError(f"镜头 {source.name} 没有可用时长")
    required_duration = max(0.1, _finite_number(target_duration, 0.1))
    shortfall = required_duration - measured_duration
    filters = [
        f"scale={width}:{height}:force_original_aspect_ratio=increase",
        f"crop={width}:{height}",
    ]
    if shortfall > 0:
        # Keep every frame moving.  A generated clip that is slightly shorter
        # than its real narration window is slowed continuously instead of
        # cloning the last frame or failing the production.
        filters.append(
            f"setpts={required_duration / measured_duration:.8f}*(PTS-STARTPTS)"
        )
    else:
        filters.append("setpts=PTS-STARTPTS")
    filters.extend(
        [
            "fps=30",
            f"trim=duration={required_duration:.6f}",
            "format=yuv420p",
        ]
    )
    filter_graph = ",".join(filters)
    await run(
        [
            _binary("ffmpeg"),
            "-y",
            "-i",
            str(source),
            "-vf",
            filter_graph,
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "21",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )


async def retime_video(
    source: Path,
    output: Path,
    speed: float,
) -> dict[str, Any]:
    """Create a new final-video version by retiming existing picture and audio."""
    rate = max(1.0, min(2.0, _finite_number(speed, 1.0)))
    source = source.resolve()
    output = output.resolve()
    if not source.is_file():
        raise MediaError("找不到需要变速的成片")
    output.parent.mkdir(parents=True, exist_ok=True)
    source_info = await probe(source)
    source_video_duration = float(
        source_info.get("videoDuration") or source_info.get("duration") or 0
    )
    source_audio_duration = float(source_info.get("audioDuration") or 0)
    if source_video_duration <= 0 or source_audio_duration <= 0:
        raise MediaError("原成片缺少可用的视频轨或音频轨")
    target_duration = source_audio_duration / rate
    # 口播是最终时间轴。视频轨按自己的实测时长做极小比例校正，
    # 避免 AAC / MP4 尾帧舍入累计成可见的音画差，也不靠静止尾帧补齐。
    video_rate = source_video_duration / target_duration
    await run(
        [
            _binary("ffmpeg"),
            "-y",
            "-i",
            str(source),
            "-filter_complex",
            (
                f"[0:v]setpts=PTS/{video_rate:.8f},fps=30,"
                f"trim=duration={target_duration:.6f}[v];"
                f"[0:a]atempo={rate:.6f},apad,"
                f"atrim=duration={target_duration:.6f}[a]"
            ),
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    return await _repair_av_sync(output, "变速成片")


def _material_timeline(
    assets: list[dict[str, Any]],
    narration_text: str,
    narration_duration: float,
    scene_timeline: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    timeline: list[dict[str, Any]] = []
    total_duration = max(0.5, _finite_number(narration_duration, 0.5))
    text_length = max(1, len(narration_text))
    scene_count = max(
        1,
        max(
            (int(_finite_number(item.get("sourceSceneNumber"), item.get("sceneNumber") or 1)) for item in scene_timeline),
            default=1,
        ),
    )
    for index, asset in enumerate(assets):
        scene_number = max(1, min(scene_count, int(_finite_number(asset.get("scene_number"), 1))))
        scene_fragments = [
            item
            for item in scene_timeline
            if int(_finite_number(item.get("sourceSceneNumber"), item.get("sceneNumber") or 1))
            == scene_number
        ]
        if not scene_fragments:
            continue
        scene_start = max(0.0, min(float(item["start"]) for item in scene_fragments))
        scene_end = min(total_duration, max(float(item["end"]) for item in scene_fragments))
        scene_window = max(0.25, scene_end - scene_start)
        padding = min(0.35, scene_window * 0.08)
        requested_duration = max(0.5, _finite_number(asset.get("duration_sec"), 3.6))
        duration = min(requested_duration, max(0.25, scene_window - padding * 2))
        anchor = str(asset.get("narration_anchor") or "").strip()
        scene_excerpt = str(asset.get("scene_narration_excerpt") or "").strip()
        local_anchor_index = scene_excerpt.find(anchor) if anchor and scene_excerpt else -1
        if local_anchor_index >= 0:
            local_ratio = local_anchor_index / max(1, len(scene_excerpt))
            start = scene_start + scene_window * local_ratio - 0.25
        else:
            anchor_index = narration_text.find(anchor) if anchor else -1
            if anchor_index >= 0:
                start = total_duration * anchor_index / text_length - 0.35
            else:
                same_scene_count = sum(1 for item in timeline if item["sceneNumber"] == scene_number)
                start = scene_start + padding + same_scene_count * (duration + 0.3)
        start = max(scene_start + padding, min(scene_end - padding - duration, start))
        same_scene = [item for item in timeline if item["sceneNumber"] == scene_number]
        if same_scene and start < same_scene[-1]["end"] + 0.3:
            start = min(scene_end - padding - duration, same_scene[-1]["end"] + 0.3)
        if start < scene_start or start + duration > scene_end + 0.01 or duration < 0.25:
            continue
        timeline.append(
            {
                **asset,
                "index": index + 1,
                "sceneNumber": scene_number,
                "start": round(start, 3),
                "end": round(start + duration, 3),
                "duration": round(duration, 3),
                "presentation": str(asset.get("presentation") or "auto"),
                "position": str(asset.get("position") or "top-right"),
                "scale": max(0.1, min(0.65, _finite_number(asset.get("scale"), 0.36))),
                "positionExplicit": asset.get("position") is not None,
                "scaleExplicit": asset.get("scale") is not None,
            }
        )
    return sorted(timeline, key=lambda item: item["start"])


def _material_still_zoom_filter(
    width: int,
    height: int,
    duration: float,
    *,
    fps: int = 30,
) -> tuple[int, str]:
    """Keep the pre-v136 motion path used by dynamic-video image cutaways."""
    safe_width = max(2, int(width))
    safe_height = max(2, int(height))
    safe_duration = max(0.1, _finite_number(duration, 0.1))
    safe_fps = max(1, int(fps))
    frames = max(1, int(round(safe_duration * safe_fps)))
    last_frame = max(0, frames - 1)
    denominator = max(1, last_frame)
    supersample = 4
    canvas_width = safe_width * supersample
    canvas_height = safe_height * supersample
    zoom_delta = min(0.05, max(0.008, safe_duration * 0.006))
    progress = f"min(on,{last_frame})/{denominator}"
    zoom = f"1+{zoom_delta:.6f}*{progress}"
    even_center_x = "2*trunc((iw-iw/zoom)/4)"
    even_center_y = "2*trunc((ih-ih/zoom)/4)"
    filters = (
        f"scale={canvas_width}:{canvas_height}:force_original_aspect_ratio=increase:"
        "flags=lanczos+accurate_rnd+full_chroma_int,"
        f"crop={canvas_width}:{canvas_height},"
        f"zoompan=z='{zoom}':x='{even_center_x}':y='{even_center_y}':"
        f"d=1:s={safe_width}x{safe_height}:fps={safe_fps},"
        "setsar=1,format=yuv420p"
    )
    return frames, filters


def _still_zoom_filter(
    width: int,
    height: int,
    duration: float,
    *,
    fps: int = 30,
) -> tuple[int, str]:
    """Build one continuous, centered Ken Burns move for a still storyboard frame.

    The still is first supersampled so ``zoompan`` has enough sub-pixel detail.  Its
    crop origin is then snapped to an even high-resolution pixel instead of being
    rounded differently on adjacent frames.  This keeps the optical centre stable
    while the zoom progresses monotonically for the whole shot and resets only when
    the next storyboard clip starts.
    """
    safe_width = max(2, int(width))
    safe_height = max(2, int(height))
    safe_duration = max(0.1, _finite_number(duration, 0.1))
    safe_fps = max(1, int(fps))
    frames = max(1, int(round(safe_duration * safe_fps)))
    last_frame = max(0, frames - 1)
    denominator = max(1, last_frame)
    # Render the source at 4x and let zoompan produce a 2x delivery canvas
    # before the final Lanczos downsample.  A one-pixel crop-origin step is
    # therefore only 1/4 of a delivered pixel and the last downsample blends it
    # instead of exposing the familiar left/right vibration of still zooms.
    # Four times is deliberate: eight times creates 10K intermediate frames for
    # 16:9 delivery and can exhaust memory when a batch renders several stills.
    supersample = 4
    output_supersample = 2
    canvas_width = safe_width * supersample
    canvas_height = safe_height * supersample
    zoom_width = safe_width * output_supersample
    zoom_height = safe_height * output_supersample

    # Narration remains the timing source of truth.  Longer semantic beats move a
    # little farther, but every single still remains a slow continuous push-in.
    zoom_delta = min(0.05, max(0.008, safe_duration * 0.006))
    progress = f"min(on,{last_frame})/{denominator}"
    zoom = f"1+{zoom_delta:.6f}*{progress}"
    center_x = "trunc((iw-iw/zoom)/2)"
    center_y = "trunc((ih-ih/zoom)/2)"
    filters = (
        f"scale={canvas_width}:{canvas_height}:force_original_aspect_ratio=increase:"
        "flags=lanczos+accurate_rnd+full_chroma_int,"
        f"crop={canvas_width}:{canvas_height},"
        f"zoompan=z='{zoom}':x='{center_x}':y='{center_y}':"
        f"d=1:s={zoom_width}x{zoom_height}:fps={safe_fps},"
        f"scale={safe_width}:{safe_height}:flags=lanczos+accurate_rnd+full_chroma_int,"
        "setsar=1,format=yuv420p"
    )
    return frames, filters


async def _prepare_material_clip(
    source: Path,
    mime: str,
    output: Path,
    width: int,
    height: int,
    duration: float,
    source_start: float,
    *,
    storyboard_motion: bool = False,
) -> None:
    common_output = [
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output),
    ]
    if mime.startswith("image/"):
        zoom_filter = _still_zoom_filter if storyboard_motion else _material_still_zoom_filter
        frames, filters = zoom_filter(width, height, duration)
        await run(
            [
                _binary("ffmpeg"),
                "-y",
                "-loop",
                "1",
                "-framerate",
                "30",
                "-i",
                str(source),
                "-t",
                f"{duration:.3f}",
                "-frames:v",
                str(frames),
                "-vf",
                filters,
                *common_output,
            ]
        )
        return

    filters = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},fps=30,"
        f"tpad=stop_mode=clone:stop_duration={duration:.3f},"
        f"trim=duration={duration:.3f},setpts=PTS-STARTPTS,setsar=1,format=yuv420p"
    )
    await run(
        [
            _binary("ffmpeg"),
            "-y",
            "-stream_loop",
            "-1",
            "-i",
            str(source),
            "-ss",
            f"{max(0.0, source_start):.3f}",
            "-t",
            f"{duration:.3f}",
            "-vf",
            filters,
            *common_output,
        ]
    )


async def render_still_clip(
    source: Path,
    output: Path,
    aspect_ratio: str,
    duration: float,
) -> dict[str, Any]:
    """Render a storyboard still as a centered, slowly enlarging video clip."""
    width, height = ASPECTS.get(aspect_ratio, ASPECTS["9:16"])
    await _prepare_material_clip(
        source,
        "image/jpeg",
        output,
        width,
        height,
        max(0.1, float(duration or 0.1)),
        0,
        storyboard_motion=True,
    )
    return await probe(output)


async def _apply_material_cutaways(
    picture: Path,
    assets: list[dict[str, Any]],
    narration_text: str,
    narration_duration: float,
    scene_timeline: list[dict[str, Any]],
    width: int,
    height: int,
    slug: str,
    work_dir: Path,
) -> tuple[Path, list[dict[str, Any]]]:
    timeline = [
        item
        for item in _material_timeline(assets, narration_text, narration_duration, scene_timeline)
        if Path(item["path"]).is_file()
    ]
    if not timeline:
        return picture, []

    for cue in timeline:
        name = str(cue.get("name") or "").lower()
        is_logo = str(cue.get("mime") or "").startswith("image/") and any(
            marker in name for marker in ("logo", "标志", "徽标", "角标", "水印", "icon")
        )
        if cue.get("presentation") == "auto":
            # Legacy/partial plans must not turn a filename containing "logo"
            # into a permanent corner bug.  Director-selected overlay survives;
            # otherwise a material is shown as a real semantic cutaway.
            cue["presentation"] = "cutaway"
        if is_logo and cue["presentation"] == "overlay":
            centered = cue.get("position") == "center"
            cue["scale"] = min(
                0.65 if centered else 0.3,
                max(
                    0.14,
                    _finite_number(cue.get("scale"), 0.42 if centered else 0.22)
                    if cue.get("scaleExplicit")
                    else (0.42 if centered else 0.22),
                ),
            )
            cue["position"] = (
                cue.get("position")
                if cue.get("positionExplicit")
                and cue.get("position") in {"top-left", "top-right", "bottom-left", "bottom-right", "center"}
                else "top-left"
            )

    cutaways = [cue for cue in timeline if cue.get("presentation") == "cutaway"]
    overlays = [cue for cue in timeline if cue.get("presentation") in {"overlay", "pip"}]
    current_picture = picture

    if cutaways:
        prepared: list[Path] = []
        for cue in cutaways:
            output = work_dir / f"material-{slug}-{cue['index']:02d}.mp4"
            await _prepare_material_clip(
                Path(cue["path"]),
                str(cue.get("mime") or ""),
                output,
                width,
                height,
                float(cue["duration"]),
                float(cue.get("source_start_sec") or 0),
            )
            prepared.append(output)

        cutaway_output = work_dir / f"picture-cutaways-{slug}.mp4"
        command = [_binary("ffmpeg"), "-y", "-i", str(current_picture)]
        for path in prepared:
            command.extend(["-i", str(path)])

        filters: list[str] = []
        base = "[0:v]"
        for index, cue in enumerate(cutaways, start=1):
            fade_duration = min(0.2, float(cue["duration"]) / 4)
            fade_out = max(fade_duration, float(cue["duration"]) - fade_duration)
            filters.append(
                f"[{index}:v]format=yuva420p,"
                f"fade=t=in:st=0:d={fade_duration:.3f}:alpha=1,"
                f"fade=t=out:st={fade_out:.3f}:d={fade_duration:.3f}:alpha=1,"
                f"setpts=PTS+{float(cue['start']):.3f}/TB[m{index}]"
            )
            output_label = f"[v{index}]"
            filters.append(
                f"{base}[m{index}]overlay=0:0:eof_action=pass:shortest=0:format=auto{output_label}"
            )
            base = output_label

        command.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                base,
                "-t",
                f"{narration_duration:.6f}",
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(cutaway_output),
            ]
        )
        await run(command)
        current_picture = cutaway_output

    if overlays:
        overlay_output = work_dir / f"picture-overlays-{slug}.mp4"
        command = [_binary("ffmpeg"), "-y", "-i", str(current_picture)]
        for cue in overlays:
            if str(cue.get("mime") or "").startswith("image/"):
                command.extend(["-loop", "1", "-i", str(Path(cue["path"]).resolve())])
            else:
                command.extend(["-stream_loop", "-1", "-i", str(Path(cue["path"]).resolve())])

        filters = []
        base = "[0:v]"
        margin = max(20, int(round(width * 0.045)))
        for index, cue in enumerate(overlays, start=1):
            duration = float(cue["duration"])
            start = float(cue["start"])
            fade_duration = min(0.18, duration / 4)
            fade_out = max(fade_duration, duration - fade_duration)
            scale = max(0.1, min(0.65, _finite_number(cue.get("scale"), 0.22)))
            target_width = max(72, int(round(width * scale)))
            target_height = max(72, int(round(height * (0.28 if cue.get("presentation") == "overlay" else 0.42))))
            trim = (
                f"trim=duration={duration:.3f}"
                if str(cue.get("mime") or "").startswith("image/")
                else f"trim=start={max(0.0, _finite_number(cue.get('source_start_sec'), 0.0)):.3f}:duration={duration:.3f}"
            )
            filters.append(
                f"[{index}:v]{trim},setpts=PTS-STARTPTS,"
                f"scale={target_width}:{target_height}:force_original_aspect_ratio=decrease,"
                "format=rgba,"
                f"fade=t=in:st=0:d={fade_duration:.3f}:alpha=1,"
                f"fade=t=out:st={fade_out:.3f}:d={fade_duration:.3f}:alpha=1,"
                f"setpts=PTS+{start:.3f}/TB[ov{index}]"
            )
            position = str(cue.get("position") or "top-right")
            coordinates = {
                "top-left": (str(margin), str(margin)),
                "top-right": (f"W-w-{margin}", str(margin)),
                "bottom-left": (str(margin), f"H-h-{margin}"),
                "bottom-right": (f"W-w-{margin}", f"H-h-{margin}"),
                "center": ("(W-w)/2", "(H-h)/2"),
            }
            x, y = coordinates.get(position, coordinates["top-right"])
            output_label = f"[vo{index}]"
            filters.append(
                f"{base}[ov{index}]overlay=x={x}:y={y}:"
                f"enable='between(t,{start:.3f},{float(cue['end']):.3f})':"
                f"eof_action=pass:shortest=0:format=auto{output_label}"
            )
            base = output_label

        command.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                base,
                "-t",
                f"{narration_duration:.6f}",
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(overlay_output),
            ]
        )
        await run(command)
        current_picture = overlay_output

    public_timeline = [
        {
            key: cue.get(key)
            for key in (
                "asset_id",
                "label",
                "name",
                "mime",
                "sceneNumber",
                "start",
                "end",
                "duration",
                "presentation",
                "position",
                "scale",
                "narration_anchor",
                "reason",
            )
        }
        for cue in timeline
    ]
    return current_picture, public_timeline


async def compose_variant(
    clip_paths: list[Path],
    narration_path: Path,
    narration_text: str,
    aspect_ratio: str,
    work_dir: Path,
    material_assets: list[dict[str, Any]] | None = None,
    scene_durations: list[float | int] | None = None,
    bgm_path: Path | None = None,
    bgm_volume: float = 0.12,
    sfx_assets: list[dict[str, Any]] | None = None,
    subtitle_style: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not clip_paths:
        raise MediaError("没有可用于合成的 Seedance 视频")
    work_dir = work_dir.resolve()
    clip_paths = [path.resolve() for path in clip_paths]
    narration_path = narration_path.resolve()
    width, height = ASPECTS[aspect_ratio]
    slug = aspect_ratio.replace(":", "x")
    audio_info = await probe(narration_path)
    narration_duration = float(audio_info.get("duration") or 0)
    if narration_duration <= 0:
        raise MediaError("口播音频没有可用时长")
    planned = list(scene_durations or [1] * len(clip_paths))
    if len(planned) != len(clip_paths):
        raise MediaError("镜头数量与导演时间计划不一致")
    scene_timeline, transition_duration = build_scene_timeline(planned, narration_duration)
    normalized = [work_dir / f"normalized-{slug}-{index + 1}.mp4" for index in range(len(clip_paths))]
    clip_infos = await asyncio.gather(*(probe(path) for path in clip_paths))
    normalization_targets = [
        max(
            float(scene["duration"])
            for scene in scene_timeline
            if int(scene.get("sourceSceneNumber") or scene["sceneNumber"]) == source_index + 1
        )
        for source_index in range(len(clip_paths))
    ]
    await asyncio.gather(
        *[
            _normalize_clip(
                source,
                target,
                width,
                height,
                target_duration,
                float(info.get("duration") or 0),
            )
            for source, target, target_duration, info in zip(
                clip_paths,
                normalized,
                normalization_targets,
                clip_infos,
            )
        ]
    )
    physical_clips = [
        normalized[int(scene.get("sourceSceneNumber") or scene["sceneNumber"]) - 1]
        for scene in scene_timeline
    ]

    if len(physical_clips) == 1:
        picture = physical_clips[0]
    else:
        picture = work_dir / f"picture-{slug}.mp4"
        command = [_binary("ffmpeg"), "-y"]
        for path in physical_clips:
            command.extend(["-i", str(path)])
        filters: list[str] = []
        if transition_duration <= 1e-6:
            current_label = "[vconcat]"
            filters.append(
                "".join(f"[{index}:v]" for index in range(len(physical_clips)))
                + f"concat=n={len(physical_clips)}:v=1:a=0{current_label}"
            )
        else:
            current_label = "[0:v]"
            current_duration = float(scene_timeline[0]["duration"])
            for index in range(1, len(physical_clips)):
                output_label = f"[vx{index}]"
                transition_offset = max(0.0, current_duration - transition_duration)
                filters.append(
                    f"{current_label}[{index}:v]xfade=transition=fade:"
                    f"duration={transition_duration:.6f}:offset={transition_offset:.6f}{output_label}"
                )
                current_label = output_label
                current_duration += float(scene_timeline[index]["duration"]) - transition_duration
        command.extend(
            [
                "-filter_complex",
                ";".join(filters),
                "-map",
                current_label,
                "-t",
                f"{narration_duration:.6f}",
                "-an",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "20",
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                str(picture),
            ]
        )
        await run(command)

    edited_picture, material_cues = await _apply_material_cutaways(
        picture,
        material_assets or [],
        narration_text,
        narration_duration,
        scene_timeline,
        width,
        height,
        slug,
        work_dir,
    )
    captions_path = work_dir / f"captions-{slug}.ass"
    cues = write_ass(
        narration_text,
        captions_path,
        aspect_ratio,
        audio_info["duration"],
        subtitle_style=subtitle_style,
    )
    sfx_cues = [
        item
        for item in _material_timeline(sfx_assets or [], narration_text, narration_duration, scene_timeline)
        if Path(str(item.get("path") or "")).is_file()
    ]
    final_path = work_dir / f"final-{slug}.mp4"
    command = [
        _binary("ffmpeg"),
        "-y",
        "-i",
        str(edited_picture),
        "-i",
        str(narration_path),
    ]
    filters = [
        f"[0:v]ass={captions_path.name}[v]",
        "[1:a]aresample=48000,loudnorm=I=-16:TP=-1.5:LRA=11,asetpts=PTS-STARTPTS[voicebase]",
    ]
    audio_labels = ["[voice]"]
    input_index = 2
    resolved_bgm = bgm_path.resolve() if bgm_path and bgm_path.is_file() else None
    if resolved_bgm:
        filters.append("[voicebase]asplit=2[voice][sidechain]")
        command.extend(["-stream_loop", "-1", "-i", str(resolved_bgm)])
        safe_bgm_volume = max(0.0, min(0.3, _finite_number(bgm_volume, 0.12)))
        filters.append(
            f"[{input_index}:a]aresample=48000,atrim=duration={narration_duration:.6f},"
            f"asetpts=PTS-STARTPTS,volume={safe_bgm_volume:.4f}[music]"
        )
        filters.append(
            "[music][sidechain]sidechaincompress=threshold=0.025:ratio=10:attack=15:release=500[ducked]"
        )
        audio_labels.append("[ducked]")
        input_index += 1
    else:
        filters.append("[voicebase]anull[voice]")

    for index, cue in enumerate(sfx_cues, start=1):
        command.extend(["-i", str(Path(str(cue["path"])).resolve())])
        source_start = max(0.0, _finite_number(cue.get("source_start_sec"), 0.0))
        duration = max(0.1, _finite_number(cue.get("duration"), 1.0))
        delay_ms = max(0, int(round(_finite_number(cue.get("start"), 0.0) * 1000)))
        volume = max(0.0, min(1.5, _finite_number(cue.get("volume"), 0.72)))
        label = f"[sfx{index}]"
        filters.append(
            f"[{input_index}:a]aresample=48000,atrim=start={source_start:.6f}:duration={duration:.6f},"
            f"asetpts=PTS-STARTPTS,volume={volume:.4f},adelay={delay_ms}:all=1{label}"
        )
        audio_labels.append(label)
        input_index += 1

    if len(audio_labels) == 1:
        filters.append("[voice]anull[a]")
    else:
        filters.append(
            "".join(audio_labels)
            + f"amix=inputs={len(audio_labels)}:duration=first:dropout_transition=0:normalize=0,"
            "alimiter=limit=0.95[a]"
        )
    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[v]",
            "-map",
            "[a]",
            "-t",
            f"{narration_duration:.6f}",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            str(final_path),
        ]
    )
    await run(command, cwd=work_dir)
    final_probe = await _repair_av_sync(final_path, "成片")
    return {
        "path": final_path,
        "aspectRatio": aspect_ratio,
        "width": width,
        "height": height,
        "captions": captions_path,
        "captionCues": cues,
        "materialCues": material_cues,
        "sfxCues": [
            {
                key: cue.get(key)
                for key in ("asset_id", "label", "name", "start", "end", "duration", "narration_anchor", "volume")
            }
            for cue in sfx_cues
        ],
        "bgm": str(resolved_bgm) if resolved_bgm else "",
        "sceneTimeline": [
            {
                key: (
                    scene[key]
                    if key in {"sceneNumber", "sourceSceneNumber", "segmentNumber", "segmentCount"}
                    else round(float(scene[key]), 3)
                )
                for key in (
                    "sceneNumber",
                    "sourceSceneNumber",
                    "segmentNumber",
                    "segmentCount",
                    "start",
                    "end",
                    "duration",
                )
            }
            for scene in scene_timeline
        ],
        "probe": final_probe,
    }
