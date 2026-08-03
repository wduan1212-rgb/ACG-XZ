from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
from pathlib import Path
from typing import Any

from app.providers import _client, _find_task_id, _json_error, seedance
from tools.video_intent_acceptance import SCENARIOS


def latest_passed_results(report_paths: list[Path]) -> dict[int, dict[str, Any]]:
    latest: dict[int, dict[str, Any]] = {}
    for path in report_paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        for result in payload.get("results") or []:
            index = int(result.get("index") or 0)
            if index and result.get("ok"):
                latest[index] = result
    return latest


async def submit_one(
    index: int,
    result: dict[str, Any],
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    case = SCENARIOS[index - 1]
    prompts = [str(prompt or "").strip() for prompt in (result.get("prompts") or [])]
    prompt = next((prompt for prompt in prompts if prompt), "")
    if not prompt:
        return {
            "index": index,
            "name": case["name"],
            "ok": False,
            "error": "导演报告没有可提交的视频提示词",
        }
    payload = seedance.build_payload(
        prompt,
        case["ratio"],
        reference_images=[],
        duration_sec=4,
    )
    async with semaphore:
        try:
            async with _client(180) as client:
                response = await client.post(
                    seedance.submit_url,
                    json=payload,
                    headers={
                        "Authorization": f"Bearer {seedance_api_key()}",
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                    },
                )
            if response.status_code >= 400:
                raise RuntimeError(
                    f"HTTP {response.status_code}: {_json_error(response)}"
                )
            task_id = _find_task_id(response.json())
            if not task_id:
                raise RuntimeError("真实提交没有返回任务 ID")
            submitted = {
                "index": index,
                "name": case["name"],
                "ok": True,
                "taskId": task_id,
                "ratio": case["ratio"],
                "duration": 4,
                "promptSha256": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
            }
        except Exception as exc:
            submitted = {
                "index": index,
                "name": case["name"],
                "ok": False,
                "error": f"{type(exc).__name__}: {exc}",
            }
        print(
            f"[{index:02d}/{len(SCENARIOS)}] "
            f"{'SUBMITTED' if submitted['ok'] else 'FAIL'} "
            f"{case['name']} {submitted.get('taskId') or submitted.get('error') or ''}",
            flush=True,
        )
        return submitted


def seedance_api_key() -> str:
    # Keep the secret inside the configured provider boundary; reports and
    # console output only contain task IDs and prompt hashes.
    from app.config import settings

    if not settings.seedance_api_key:
        raise RuntimeError("Seedance API Key 未配置")
    return settings.seedance_api_key


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument(
        "--indices",
        default="",
        help="只提交指定序号，避免重复消耗已验收场景的额度，例如 21,22,23。",
    )
    parser.add_argument(
        "--reports",
        nargs="+",
        required=True,
    )
    parser.add_argument(
        "--report",
        default="/private/tmp/v123-video-submission-report.json",
    )
    args = parser.parse_args()
    passed = latest_passed_results([Path(value) for value in args.reports])
    requested = {
        int(value)
        for value in args.indices.split(",")
        if value.strip().isdigit()
    }
    selected = [
        index
        for index in range(1, len(SCENARIOS) + 1)
        if not requested or index in requested
    ]
    missing = [index for index in selected if index not in passed]
    if missing:
        raise RuntimeError(f"以下普通视频场景没有通过导演验收：{missing}")
    semaphore = asyncio.Semaphore(max(1, min(3, args.concurrency)))
    results = await asyncio.gather(
        *[
            submit_one(index, passed[index], semaphore)
            for index in selected
        ]
    )
    summary = {
        "total": len(results),
        "submitted": sum(1 for result in results if result["ok"]),
        "failed": sum(1 for result in results if not result["ok"]),
        "polled": False,
        "note": "验收到真实计费提交边界；按要求不等待或下载普通视频成片。",
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
                "submitted": summary["submitted"],
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
