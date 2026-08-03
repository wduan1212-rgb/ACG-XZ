from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app import main


CONTINUE_CASES = [
    "继续",
    "请继续制作",
    "没关系继续",
    "不用管，继续生成",
    "确认继续",
    "继续执行",
    "继续完成",
    "无所谓，请继续合成",
    "这个误差没关系继续合成",
    "按这个做",
]

REVISION_CASES: list[tuple[str, str | None, int | None]] = [
    ("只修改镜头1的人物表情，其他不动", "scene", 1),
    ("第二个镜头动作不自然，调整一下", "scene", 2),
    ("视频3有瑕疵，替换这个画面", "scene", 3),
    ("把第4个片段的背景换成清晨办公室", "scene", 4),
    ("镜头九不对，只修这个", "invalid_scene", 9),
    ("字幕太大而且太靠下，缩小并上移", "subtitle_layout", None),
    ("把字幕文字改成另一段和口播不同的文案", "subtitle_text", None),
    ("字幕改成白色并加一点描边", "subtitle_layout", None),
    ("字幕和口播对不上，修改字幕内容", "subtitle_text", None),
    ("去掉结尾静止帧，重新补一下镜头", "motion_recompose", None),
    ("修复卡帧但保留已经完成的声音", "motion_recompose", None),
    ("画面不动，解决后继续原成片", "motion_recompose", None),
    ("修改镜头2的口播和时长", "timeline_change", 2),
    ("第三个镜头改成8秒并换配音", "timeline_change", 3),
    ("只调整镜头1的机位，不改口播", "scene", 1),
    ("第2个镜头换一下情绪色彩和构图", "scene", 2),
    ("再做一条新视频，主题换成城市夜跑", None, None),
    ("你觉得这个叙事自然吗", None, None),
    ("保留结尾定格，不要删除", None, None),
]


def build_plan(mode: str) -> dict[str, Any]:
    return {
        "title": f"{mode} continuation acceptance",
        "creation_mode": mode,
        "narration": "完整口播保持不变。",
        "aspect_ratio": "16:9" if mode == "static" else "9:16",
        "scenes": [
            {
                "title": f"镜头 {index}",
                "duration_sec": 5,
                "visual_prompt": f"{mode} 原计划镜头 {index}",
                "image_prompt": f"{mode} 原计划静态分镜 {index}" if mode == "static" else "",
            }
            for index in range(1, 5)
        ],
    }


def digest(plan: dict[str, Any]) -> str:
    payload = json.dumps(plan, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def run_mode(mode: str) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for index, message in enumerate(CONTINUE_CASES, start=1):
        plan = build_plan(mode)
        before = digest(plan)
        project = {
            "id": f"{mode}-continue-{index}",
            "status": "failed",
            "phase": "stopped",
            "plan": plan,
            "retryable": {"type": "resume_plan", "sceneNumber": 2},
            "messages": [
                {"role": "user", "content": "沿用这个方案制作"},
                {"role": "assistant", "content": "制作已停止"},
                {"role": "user", "content": message},
            ],
        }
        retry = main._retry_info(project)
        ok = (
            main._is_continue_request(message)
            and retry == {"type": "resume_plan", "sceneNumber": 2}
            and digest(plan) == before
        )
        results.append({
            "mode": mode,
            "index": index,
            "name": f"中断后续作 · {message}",
            "ok": ok,
            "route": "resume_plan" if retry else None,
            "samePlan": digest(plan) == before,
        })

    for offset, (message, expected_type, expected_scene) in enumerate(
        REVISION_CASES,
        start=len(CONTINUE_CASES) + 1,
    ):
        plan = build_plan(mode)
        before = digest(plan)
        revision = main._local_revision_request(message, plan, [])
        actual_type = str((revision or {}).get("type") or "") or None
        actual_scene = (revision or {}).get("sceneNumber")
        ok = (
            actual_type == expected_type
            and (expected_scene is None or actual_scene == expected_scene)
            and digest(plan) == before
        )
        results.append({
            "mode": mode,
            "index": offset,
            "name": f"对话修改 · {message}",
            "ok": ok,
            "expectedType": expected_type,
            "actualType": actual_type,
            "expectedScene": expected_scene,
            "actualScene": actual_scene,
            "samePlanBeforeExecution": digest(plan) == before,
        })

    # The final case verifies a context-free “继续” recovers the latest
    # meaningful local edit instead of being sent to the director as a new job.
    plan = build_plan(mode)
    project = {
        "id": f"{mode}-recover-revision",
        "status": "conversation",
        "plan": plan,
        "messages": [
            {"role": "user", "content": "修改第二个镜头的人物动作"},
            {"role": "assistant", "content": "当前服务暂时未返回"},
            {"role": "user", "content": "继续"},
        ],
    }
    recovered = main._revision_message_for_continuation(project, "继续")
    results.append({
        "mode": mode,
        "index": 30,
        "name": "失败后继续最近一次局部修改",
        "ok": recovered == "修改第二个镜头的人物动作",
        "recovered": recovered,
    })
    return results


def main_cli() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--report",
        default="/private/tmp/v123-continuation-acceptance.json",
    )
    args = parser.parse_args()
    results = [*run_mode("static"), *run_mode("video")]
    summary = {
        "total": len(results),
        "passed": sum(1 for item in results if item["ok"]),
        "failed": sum(1 for item in results if not item["ok"]),
        "byMode": {
            mode: {
                "total": sum(1 for item in results if item["mode"] == mode),
                "passed": sum(1 for item in results if item["mode"] == mode and item["ok"]),
            }
            for mode in ("static", "video")
        },
        "results": results,
    }
    Path(args.report).write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps({
        "total": summary["total"],
        "passed": summary["passed"],
        "failed": summary["failed"],
        "byMode": summary["byMode"],
        "report": args.report,
    }, ensure_ascii=False))
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main_cli())
