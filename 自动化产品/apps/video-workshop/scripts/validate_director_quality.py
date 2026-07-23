from __future__ import annotations

import argparse
import asyncio
import base64
import json
import math
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


APP_ROOT = Path(__file__).resolve().parents[3]
WORKSHOP_ROOT = Path(__file__).resolve().parents[1]

# This executable is local QA only.  Mirror start.command's safe env-file
# parser without echoing credentials or embedding them in the report.
env_file = APP_ROOT / ".env.local"
if env_file.is_file():
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        os.environ.setdefault(key, value.strip().strip('"\''))

if str(WORKSHOP_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSHOP_ROOT))

from app.bgm import bgm_library
from app.media import build_scene_timeline
from app.openmontage_bridge import openmontage
from app.pipeline import (
    DEFAULT_DELIVERY_SPEED,
    DURATION_MEASUREMENT_EPSILON,
    DURATION_OVERRUN_ALLOWANCE,
    _generate_duration_aligned_tts,
    _render_units,
    _scene_timeline_weights,
)
from app.providers import (
    _CAPTION_RENDER_CUE,
    _READABLE_TEXT_CUE,
    _SEEDANCE_TEXT_NEGATIVE,
    _explicit_duration_seconds,
    _render_action_signature,
    _seedance_prompt,
    _visual_prompt_similarity,
    _visual_template_signature,
    director,
)


CASES = [
    {
        "name": "01-long-skills-assets",
        "message": "来一条约3分钟、主题为‘用百度搭子做自媒体，必装的10个Skill（新手友好版）’的视频。图1的Logo作为视频生成参考，其他图片作为剪辑素材，按口播语义放到最合适的位置。",
        "aspect": "9:16",
        "assets": "all",
    },
    {
        "name": "02-emotional-night-shift",
        "message": "制作一条约18秒的竖屏短片：深夜下班的人回到家，用百度搭子把明天的待办整理好。情绪从疲惫转为松弛，画面真实克制。",
        "aspect": "9:16",
    },
    {
        "name": "03-screen-tutorial-cutaway",
        "message": "做一条约35秒的新手教程，讲清楚如何从百度搭子主界面进入自媒体套件。图1只作品牌参考，图2、图3、图4是步骤证据，要在讲到对应步骤时看清；不要把它们一直缩在角落。",
        "aspect": "9:16",
        "assets": "all",
    },
    {
        "name": "04-three-audiences",
        "message": "做一条约30秒的视频：如果你是自媒体人、学生党、上班族，百度搭子分别能怎样帮你处理资料。三类人的处境要有明显差异，但最后自然汇合。",
        "aspect": "9:16",
    },
    {
        "name": "05-horizontal-brand-story",
        "message": "制作一条约45秒的横屏品牌故事，从一张混乱的桌面开始，讲百度搭子怎样让一个人的创作流程逐渐成形。图1只作Logo和品牌气质参考，其他图按证据素材使用。",
        "aspect": "16:9",
        "assets": "all",
    },
    {
        "name": "06-list-without-card-template",
        "message": "来一条约50秒的实用视频，主题是‘新手做自媒体最容易踩的5个坑’。不要做成五张卡片轮流高亮，要用真实人物行为、场景变化和结果对比来讲。",
        "aspect": "9:16",
    },
    {
        "name": "07-product-review-evidence",
        "message": "做一条约60秒的百度搭子深度测评：先提出质疑，再用真实操作证据验证，最后说清适合谁、不适合谁。图1是品牌参考，图2到图5是操作证据，按论点匹配。",
        "aspect": "9:16",
        "assets": "all",
    },
    {
        "name": "08-calm-interview-rhythm",
        "message": "制作一条约40秒的沉浸式人物短片：自由职业者讲自己如何从手忙脚乱变得有节奏。允许有情绪长镜头，不要为了快而等间隔切镜头。",
        "aspect": "9:16",
    },
    {
        "name": "09-fast-event-promo",
        "message": "做一条约20秒的活动预告，主题是‘今晚8点，现场拆解百度搭子自动化工作流’。开场要有冲击力，中段快速给证据，结尾明确收束，但画面里不要生成任何字。",
        "aspect": "9:16",
    },
    {
        "name": "10-metaphor-knowledge-base",
        "message": "制作一条约55秒的创意科普片：国产Codex百度搭子怎样自动管理你的知识库。不要连续拍电脑界面，用档案室、线索墙、流水线等可见隐喻把抽象过程讲明白。",
        "aspect": "9:16",
    },
]


def _vision_assets() -> list[dict[str, Any]]:
    source = APP_ROOT / "runtime/video-workshop/uploads/2a9eba497e42"
    files = [
        ("图1", "logo百度搭子.png", "3f7fe8a309.png"),
        ("图2", "视频生成思考过程.png", "6998449799.png"),
        ("图3", "自媒体套件.png", "d22086083b.png"),
        ("图4", "主界面.png", "d954ade747.png"),
        ("图5", "技能1.png", "e4fa198f11.png"),
    ]
    assets: list[dict[str, Any]] = []
    for index, (label, name, filename) in enumerate(files, start=1):
        path = source / filename
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        assets.append({
            "asset_id": f"validation-image-{index}",
            "label": label,
            "name": name,
            "media_type": "image",
            "mime": "image/png",
            "visionDataUrl": "data:image/png;base64," + encoded,
        })
    return assets


def _long_narration_leaks(narration: str, prompt: str) -> list[str]:
    normalized = re.sub(r"\s+", "", narration)
    leaks: list[str] = []
    # Short product/brand names and explicitly requested UI labels may appear
    # on screen. Only flag sentence-length spoken copy leaking into prompts.
    for size in (20, 16, 14):
        for index in range(0, max(0, len(normalized) - size + 1), max(1, size // 2)):
            fragment = normalized[index:index + size]
            compact_prompt = re.sub(r"\s+", "", prompt)
            position = compact_prompt.find(fragment) if fragment else -1
            local_context = compact_prompt[max(0, position - 24):position + len(fragment) + 8]
            # Short, explicit UI labels are legitimate product evidence. They
            # are not spoken captions even when a few words overlap narration.
            explicit_ui_label = bool(
                position >= 0
                and re.search(r"按钮|标签|菜单|字段|指标|状态|标题|列名|输入框|占位文字|字样|卡片", local_context)
                and re.search(r"[\"“”「」『』：:]|为|写着|显示|分别|占位|字样|点亮", local_context)
            )
            if fragment and position >= 0 and not explicit_ui_label:
                leaks.append(fragment)
        if leaks:
            break
    return leaks[:5]


async def _validate_case(
    case: dict[str, Any],
    output_root: Path,
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    async with semaphore:
        case_root = output_root / case["name"]
        case_root.mkdir(parents=True, exist_ok=True)
        assets = _vision_assets() if case.get("assets") else []
        decision = await director.decide(
            [{"role": "user", "content": case["message"]}],
            case["aspect"],
            assets,
            skill_context=openmontage.director_context(),
            bgm_catalog=bgm_library.catalog(),
        )
        if decision.get("action") != "produce":
            raise RuntimeError(f"导演没有进入生产计划：{decision}")
        initial_plan = decision["plan"]
        audio_path = case_root / "narration.mp3"
        (
            tts_result,
            audio_probe,
            narration_duration,
            initial_plan,
            duration_alignment,
        ) = await _generate_duration_aligned_tts(initial_plan, audio_path)
        narration_text = str(initial_plan["narration"])
        timed = await director.lock_timed_visual_plan(initial_plan, narration_duration)
        plan = {
            **initial_plan,
            "scenes": timed["scenes"],
            "duration_sec": narration_duration,
        }
        scene_timeline, _ = build_scene_timeline(
            _scene_timeline_weights(plan["scenes"]),
            narration_duration,
        )
        render_units = _render_units(plan["scenes"], scene_timeline, case_root)
        visual_prompts = [str(unit["scene"].get("visual_prompt") or "") for unit in render_units]
        submitted_prompts = [_seedance_prompt(item) for item in visual_prompts]
        duplicate_pairs: list[dict[str, Any]] = []
        for right_index, right in enumerate(visual_prompts):
            for left_index, left in enumerate(visual_prompts[:right_index]):
                left_action = _render_action_signature(left)
                right_action = _render_action_signature(right)
                similarity = _visual_prompt_similarity(left_action, right_action)
                shared = sorted(
                    _visual_template_signature(left_action)
                    & _visual_template_signature(right_action)
                )
                if similarity >= 0.68 or (len(shared) >= 2 and similarity >= 0.6):
                    duplicate_pairs.append({
                        "left": left_index + 1,
                        "right": right_index + 1,
                        "similarity": round(similarity, 4),
                        "sharedTemplates": shared,
                    })
        caption_violations = [
            index + 1 for index, prompt in enumerate(visual_prompts)
            if _CAPTION_RENDER_CUE.search(prompt)
        ]
        readable_ui_units = [
            index + 1 for index, prompt in enumerate(visual_prompts)
            if _READABLE_TEXT_CUE.search(prompt)
        ]
        narration_leaks = [
            {"unit": index + 1, "fragments": fragments}
            for index, prompt in enumerate(visual_prompts)
            if (fragments := _long_narration_leaks(str(plan["narration"]), prompt))
        ]
        unique_count = len(set(visual_prompts))
        # This is only the provider's technical coverage floor. Editorial
        # rhythm remains free to add more internal beats or hold longer shots.
        expected_minimum = max(1, math.ceil(narration_duration / 15.0))
        requested_duration = _explicit_duration_seconds([
            {"role": "user", "content": case["message"]}
        ])
        # Published workshop deliveries default to 1.2x. The requested length
        # is a floor and natural content may run up to 30 seconds longer.
        estimated_delivery_duration = narration_duration / DEFAULT_DELIVERY_SPEED
        duration_tolerance = DURATION_OVERRUN_ALLOWANCE + DURATION_MEASUREMENT_EPSILON
        checks = {
            "narrationCovered": "".join(scene["narration_excerpt"] for scene in plan["scenes"]) == plan["narration"],
            # One logical scene may legitimately contain several independent
            # Seedance submissions. Judge actual visual coverage by those
            # technical units, not by the director's higher-level scene count.
            "enoughTimedScenes": len(render_units) >= expected_minimum,
            "renderPromptsUnique": unique_count == len(visual_prompts),
            "noDuplicateVisualGrammar": not duplicate_pairs,
            "noCaptionInstructions": not caption_violations,
            "noNarrationLeak": not narration_leaks,
            "negativeAppliedOnce": all(
                prompt.count(_SEEDANCE_TEXT_NEGATIVE) == 1
                for prompt in submitted_prompts
            ),
            "explicitDurationHonored": (
                requested_duration is None
                or (
                    estimated_delivery_duration >= requested_duration
                    and estimated_delivery_duration <= requested_duration + duration_tolerance
                )
            ),
        }
        result = {
            "case": case,
            "status": "passed" if all(checks.values()) else "failed",
            "checks": checks,
            "estimatedNarrationDuration": round(narration_duration, 3),
            "estimatedDeliveryDurationAt1_2x": round(estimated_delivery_duration, 3),
            "durationSource": "minimax-tts-ffprobe",
            "requestedDuration": requested_duration,
            "durationTolerance": duration_tolerance if requested_duration else None,
            "tts": {
                "model": str(tts_result.get("model") or ""),
                "voiceId": str(tts_result.get("voiceId") or ""),
                "speed": tts_result.get("speed"),
                "audioFile": audio_path.name,
                "probeDuration": narration_duration,
            },
            "durationAlignment": duration_alignment,
            "narrationChars": len(str(plan["narration"])),
            "initialSceneCount": len(initial_plan.get("scenes") or []),
            "timedSceneCount": len(plan["scenes"]),
            "renderUnitCount": len(render_units),
            "expectedMinimum": expected_minimum,
            "duplicatePairs": duplicate_pairs,
            "captionViolations": caption_violations,
            "readableUiUnits": readable_ui_units,
            "narrationLeaks": narration_leaks,
            "assetAssignments": plan.get("asset_assignments") or [],
            "assetPlacements": timed.get("asset_placements") or [],
            "narration": plan["narration"],
            "timedScenes": plan["scenes"],
            "renderPrompts": visual_prompts,
            "submittedPrompts": submitted_prompts,
        }
        (case_root / "quality-report.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        return result


async def main(concurrency: int, case_names: list[str] | None = None) -> int:
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    output_root = APP_ROOT / "runtime/video-workshop/validation" / f"v113-{stamp}"
    output_root.mkdir(parents=True, exist_ok=True)
    semaphore = asyncio.Semaphore(max(1, min(2, concurrency)))
    async def run_case(case: dict[str, Any]) -> dict[str, Any]:
        try:
            return await _validate_case(case, output_root, semaphore)
        except Exception as exc:
            result = {
                "case": case,
                "status": "failed",
                "checks": {},
                "error": str(exc),
                "estimatedNarrationDuration": 0.0,
                "timedSceneCount": 0,
                "renderUnitCount": 0,
            }
            case_root = output_root / case["name"]
            case_root.mkdir(parents=True, exist_ok=True)
            (case_root / "quality-report.json").write_text(
                json.dumps(result, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return result

    selected_cases = (
        [case for case in CASES if case["name"] in set(case_names)]
        if case_names
        else CASES
    )
    if not selected_cases:
        raise RuntimeError("没有匹配的验证样例")
    total_cases = len(selected_cases)
    tasks = [asyncio.create_task(run_case(case)) for case in selected_cases]
    results: list[dict[str, Any]] = []
    for task in asyncio.as_completed(tasks):
        result = await task
        results.append(result)
        print(
            f"[{len(results):02d}/{total_cases:02d}] {result['case']['name']}: {result['status']} | "
            f"{result['estimatedNarrationDuration']:.1f}s | {result['timedSceneCount']} scenes | "
            f"{result['renderUnitCount']} render units",
            flush=True,
        )
    results.sort(key=lambda item: item["case"]["name"])
    summary = {
        "version": "v113",
        "createdAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "finalVideoGenerationCalled": False,
        "passed": sum(item["status"] == "passed" for item in results),
        "failed": sum(item["status"] != "passed" for item in results),
        "results": results,
    }
    (output_root / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    lines = [
        "# v113 视频工坊导演质量验证",
        "",
        f"- 通过：{summary['passed']}/10",
        "- 最终视频生成：未调用",
        "- 验证范围：导演计划、MiniMax 真实口播与 FFprobe 时长、二阶段时序分镜、附件角色、素材锚点、Seedance 最终提示词。",
        "",
    ]
    for item in results:
        lines.append(
            f"- {item['case']['name']}：{item['status']}，"
            f"估算 {item['estimatedNarrationDuration']:.1f}s，{item['timedSceneCount']} 个时序分镜，"
            f"{item['renderUnitCount']} 个提交单元"
        )
    (output_root / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"REPORT={output_root}", flush=True)
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--case", action="append", dest="case_names")
    args = parser.parse_args()
    raise SystemExit(asyncio.run(main(args.concurrency, args.case_names)))
