from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
from pathlib import Path
from typing import Any

import httpx

from app.config import settings
from app.media import probe


APP_DIR = Path(__file__).resolve().parents[3]
OUTPUTS_DIR = Path(
    os.getenv("VIDEO_WORKSHOP_OUTPUT_DIR")
    or (
        APP_DIR / "runtime" / "video-workshop" / "outputs"
        if (APP_DIR / "runtime" / "video-workshop" / "outputs").is_dir()
        else settings.outputs_dir
    )
).expanduser().resolve()


CASES = [
    ("清晨咖啡", "制作12秒静态视频，用2到3张图片讲清晨第一杯咖啡带来的秩序感；口播自然克制，16:9。"),
    ("文件整理", "制作12秒静态视频，用2到3张图片展示散乱文件变成可交付清单；真实办公室，不要赛博感，16:9。"),
    ("旅行相册", "制作12秒静态视频，用2到3张图片讲AI帮普通人重新发现旅行相册里的记忆；温暖真实，16:9。"),
    ("旧衣循环", "制作12秒静态视频，用2到3张图片讲一件旧外套从衣柜到再次使用；不卖惨，16:9。"),
    ("夜班编辑", "制作12秒静态视频，用2到3张图片讲夜班编辑整理硬盘素材并完成交付；纪录片质感，16:9。"),
    ("会议资料", "制作12秒静态视频，用2到3张图片展示会议录音、截图和表格被整理成纪要；证据明确，16:9。"),
    ("茶馆记账", "制作12秒静态视频，用2到3张图片讲老茶馆手艺人第一次用AI记账；生活气息真实，16:9。"),
    ("通勤耳机", "制作12秒静态视频，用2到3张图片表达白色降噪耳机带来的通勤安静感；不堆参数，16:9。"),
    ("五分钟收尾", "制作12秒静态视频，用2到3张图片讲下班前把三个待办收束为一个清晰下一步；轻喜剧，16:9。"),
    ("学生复盘", "制作12秒静态视频，用2到3张图片讲学生把零散笔记整理成复习路径；自然、不幼稚，16:9。"),
]


async def fetch_project(
    client: httpx.AsyncClient,
    project_id: str,
    *,
    timeout: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    retried = False
    transport_failures = 0
    while time.monotonic() < deadline:
        try:
            response = await client.get(f"/api/projects/{project_id}")
        except httpx.TransportError:
            transport_failures += 1
            if transport_failures > 18:
                raise
            await asyncio.sleep(min(12, 2 + transport_failures))
            continue
        transport_failures = 0
        response.raise_for_status()
        project = response.json()
        status = str(project.get("status") or "")
        event_text = "\n".join(
            f"{event.get('title') or ''} {event.get('detail') or ''}"
            for event in (project.get("events") or [])
        )
        if "seedance" in event_text.lower():
            try:
                await client.post(f"/api/projects/{project_id}/cancel")
            finally:
                raise RuntimeError("静态任务误入 Seedance，已立即停止")
        if status == "succeeded":
            return project
        if status in {"failed", "stopped"}:
            if not retried and project.get("retryable"):
                retry_response = await client.post(f"/api/projects/{project_id}/retry")
                retry_response.raise_for_status()
                retried = True
                await asyncio.sleep(3)
                continue
            raise RuntimeError(str(project.get("error") or f"项目状态={status}"))
        if status == "conversation" and any(
            message.get("kind") == "question"
            for message in (project.get("messages") or [])[-2:]
        ):
            raise RuntimeError("导演错误追问了已完整提供的短片需求")
        await asyncio.sleep(4)
    raise TimeoutError(f"项目 {project_id} 在 {timeout:.0f} 秒内未完成")


async def validate_project(
    client: httpx.AsyncClient,
    project: dict[str, Any],
) -> list[str]:
    issues: list[str] = []
    project_id = str(project.get("id") or "")
    plan = project.get("plan") or {}
    if plan.get("creation_mode") != "static":
        issues.append("计划不是 static")
    if plan.get("aspect_ratio") != "16:9":
        issues.append(f"计划画幅={plan.get('aspect_ratio')}")
    scenes = list(plan.get("scenes") or [])
    if len(scenes) < 2:
        issues.append(f"静态分镜不足:{len(scenes)}")
    event_text = "\n".join(
        f"{event.get('title') or ''} {event.get('detail') or ''}"
        for event in (project.get("events") or [])
    )
    if "Seedance" in event_text or "seedance" in event_text:
        issues.append("静态事件中出现 Seedance")
    static_scene_events = {
        str(event.get("title") or "")
        for event in (project.get("events") or [])
        if str(event.get("title") or "").startswith("正在生成静态分镜 ")
    }
    if (
        "图片分镜正在并行生成" not in event_text
        and len(static_scene_events) < min(2, len(scenes))
    ):
        issues.append("缺少图片并发生成证据")
    outputs = list(project.get("outputs") or [])
    if not outputs:
        issues.append("没有成片输出")
        return issues
    output = outputs[0]
    if output.get("aspectRatio") != "16:9":
        issues.append(f"成片画幅={output.get('aspectRatio')}")
    output_url = str(output.get("url") or "")
    if not output_url:
        issues.append("成片 URL 缺失")
        return issues
    response = await client.get(output_url)
    response.raise_for_status()
    if len(response.content) < 20_000:
        issues.append(f"成片文件过小:{len(response.content)}")
    filename = Path(output_url).name
    output_path = OUTPUTS_DIR / project_id / filename
    if not output_path.is_file():
        issues.append("本地成片文件不存在")
        return issues
    info = await probe(output_path)
    width = int(info.get("width") or 0)
    height = int(info.get("height") or 0)
    if not width or not height or abs((width / height) - (16 / 9)) > 0.03:
        issues.append(f"实际尺寸不是16:9:{width}x{height}")
    if float(info.get("duration") or 0) < 4:
        issues.append(f"成片时长异常:{info.get('duration')}")
    scene_files = list((OUTPUTS_DIR / project_id).glob("scene-*.mp4"))
    if len(scene_files) < len(scenes):
        issues.append(f"静态片段文件不足:{len(scene_files)}/{len(scenes)}")
    render_plan_path = OUTPUTS_DIR / project_id / "render-plan.json"
    if not render_plan_path.is_file():
        issues.append("缺少真实渲染计划")
    else:
        render_plan = json.loads(render_plan_path.read_text(encoding="utf-8"))
        units = list(render_plan.get("units") or [])
        if not units:
            issues.append("真实渲染计划没有图片节拍")
    return issues


def cadence_report(project_id: str) -> dict[str, Any]:
    render_plan_path = OUTPUTS_DIR / project_id / "render-plan.json"
    render_plan = json.loads(render_plan_path.read_text(encoding="utf-8"))
    durations = [
        round(float(unit.get("target_duration") or 0), 3)
        for unit in (render_plan.get("units") or [])
    ]
    return {
        "durations": durations,
        "average": round(sum(durations) / len(durations), 3) if durations else 0,
        "maximum": max(durations, default=0),
        "overFiveCount": sum(1 for duration in durations if duration > 5.0),
        "note": "仅记录节奏，不作硬性失败；以口播语义完整性为先。",
    }


async def run_case(
    index: int,
    case: tuple[str, str],
    semaphore: asyncio.Semaphore,
    base_url: str,
    timeout: float,
) -> dict[str, Any]:
    name, prompt = case
    async with semaphore:
        async with httpx.AsyncClient(
            base_url=base_url,
            timeout=httpx.Timeout(60.0, connect=10.0),
            trust_env=False,
        ) as client:
            try:
                response = await client.post(
                    "/api/chat",
                    json={
                        "projectId": "",
                        "message": prompt,
                        "aspectRatio": "",
                        "creationMode": "static",
                        "voiceId": "",
                        "attachments": [],
                    },
                )
                response.raise_for_status()
                project_id = str(response.json().get("id") or "")
                if not project_id:
                    raise RuntimeError("启动响应没有项目 ID")
                project = await fetch_project(client, project_id, timeout=timeout)
                issues = await validate_project(client, project)
                result = {
                    "index": index,
                    "name": name,
                    "ok": not issues,
                    "issues": issues,
                    "projectId": project_id,
                    "sceneCount": len((project.get("plan") or {}).get("scenes") or []),
                    "renderUnitCount": len(
                        json.loads(
                            (
                                OUTPUTS_DIR
                                / project_id
                                / "render-plan.json"
                            ).read_text(encoding="utf-8")
                        ).get("units") or []
                    ),
                    "cadence": cadence_report(project_id),
                    "output": ((project.get("outputs") or [{}])[0]).get("url"),
                }
            except Exception as exc:
                result = {
                    "index": index,
                    "name": name,
                    "ok": False,
                    "issues": [f"{type(exc).__name__}: {exc}"],
                }
            print(
                f"[{index:02d}/{len(CASES)}] {'PASS' if result['ok'] else 'FAIL'} "
                f"{name} {result.get('projectId') or ''} {result.get('issues') or ''}",
                flush=True,
            )
            return result


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("--timeout", type=float, default=1800)
    parser.add_argument("--indices", default="")
    parser.add_argument(
        "--existing-project",
        default="",
        help="只复验一个已成功项目，不重新生成媒体。",
    )
    parser.add_argument(
        "--report",
        default="/private/tmp/v123-static-media-report.json",
    )
    args = parser.parse_args()
    if args.existing_project:
        async with httpx.AsyncClient(
            base_url=args.base_url,
            timeout=httpx.Timeout(60.0, connect=10.0),
            trust_env=False,
        ) as client:
            response = await client.get(f"/api/projects/{args.existing_project}")
            response.raise_for_status()
            project = response.json()
            issues = await validate_project(client, project)
            results = [{
                "index": 1,
                "name": str(project.get("name") or "既有静态项目"),
                "ok": not issues,
                "issues": issues,
                "projectId": args.existing_project,
                "sceneCount": len((project.get("plan") or {}).get("scenes") or []),
                "renderUnitCount": len(cadence_report(args.existing_project)["durations"]),
                "cadence": cadence_report(args.existing_project),
                "output": ((project.get("outputs") or [{}])[0]).get("url"),
                "reused": True,
            }]
    else:
        requested = {
        int(value)
        for value in args.indices.split(",")
        if value.strip().isdigit()
        }
        selected = [
            (index, case)
            for index, case in enumerate(CASES, 1)
            if not requested or index in requested
        ]
        semaphore = asyncio.Semaphore(max(1, min(3, args.concurrency)))
        results = await asyncio.gather(
            *[
                run_case(index, case, semaphore, args.base_url, args.timeout)
                for index, case in selected
            ]
        )
    summary = {
        "total": len(results),
        "passed": sum(1 for result in results if result["ok"]),
        "failed": sum(1 for result in results if not result["ok"]),
        "results": results,
    }
    report_path = Path(args.report)
    report_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "total": summary["total"],
                "passed": summary["passed"],
                "failed": summary["failed"],
                "report": str(report_path),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
