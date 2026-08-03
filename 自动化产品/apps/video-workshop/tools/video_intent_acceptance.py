from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from app.main import bgm_library, director, director_context


def image(asset_id: str, label: str, name: str) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "label": label,
        "name": name,
        "media_type": "image",
        "mime": "image/png",
    }


def video(asset_id: str, label: str, name: str, duration: float = 8.0) -> dict[str, Any]:
    return {
        "asset_id": asset_id,
        "label": label,
        "name": name,
        "media_type": "video",
        "mime": "video/mp4",
        "duration": duration,
    }


def audio(asset_id: str, label: str, name: str, transcript: str = "") -> dict[str, Any]:
    item: dict[str, Any] = {
        "asset_id": asset_id,
        "label": label,
        "name": name,
        "media_type": "audio",
        "mime": "audio/mpeg",
        "duration": 18.0,
    }
    if transcript:
        item["transcript"] = {"text": transcript}
    return item


SCENARIOS = [
    {
        "name": "海外App宣传",
        "prompt": "生成30秒App海外宣传视频，目标平台TikTok，年轻但不浮夸，镜头由你自动拆分。",
        "ratio": "9:16",
    },
    {
        "name": "嘛嘛档旅行",
        "prompt": "15秒马来西亚嘛嘛档视频：店员问Where to，顾客依次回答Penang、Sabah、KL，每次端出当地美食并自然联想到目的地，最后一句Your trip is served. One app.",
        "ratio": "9:16",
    },
    {
        "name": "行李箱贴纸",
        "prompt": "0-3秒空白行李箱，3-7秒贴Pulau Tioman贴纸进入海岛，7-11秒贴Pulau Pangkor贴纸进入渔村，11-15秒贴Pulau Pinang贴纸进入槟城，结尾出现旅行App，轻快BGM。",
        "ratio": "9:16",
    },
    {
        "name": "普通人解释Agent",
        "prompt": "面向第一次接触AI的普通人，用一个真实办公任务解释Agent和聊天机器人的区别，不做绝对排名。",
        "ratio": "16:9",
    },
    {
        "name": "五人群列举",
        "prompt": "开发者、运营、设计师、行政和学生五类人，各用一个真实场景讲清AI能替他们做什么；每类都要被画面明确看到。",
        "ratio": "16:9",
    },
    {
        "name": "保留长口播",
        "prompt": "以下口播原文不要改：很多时候让人疲惫的不是难题，而是文件命名、资料搬运、进度追问这些重复动作。把它们交给能执行的AI之后，人终于可以把注意力放回判断和创造。请按语义做视频。",
        "ratio": "16:9",
    },
    {
        "name": "品牌Logo参考",
        "prompt": "介绍百度搭子能把资料整理成可交付结果。图1是唯一真实Logo，只在品牌被提到和结尾中心揭示时作为生成参考，不要做右上角水印。",
        "ratio": "16:9",
        "attachments": [image("logo-1", "图1", "百度搭子真实Logo.png")],
        "roles": {"logo-1": {"reference", "both"}},
    },
    {
        "name": "人物形象参考",
        "prompt": "图1是主人公形象参考，保持她的脸型、发型和衣服一致；讲她从凌晨加班到清晨完成交付的过程。",
        "ratio": "16:9",
        "attachments": [image("person-1", "图1", "女主角定妆照.png")],
        "roles": {"person-1": {"reference"}},
    },
    {
        "name": "截图剪辑素材",
        "prompt": "图1是产品结果截图，不用于重绘；请作为需要看清的全屏剪辑素材，放在口播说到最终结果的位置。",
        "ratio": "16:9",
        "attachments": [image("screen-1", "图1", "产品结果截图.png")],
        "roles": {"screen-1": {"material", "both"}},
    },
    {
        "name": "视频素材插入",
        "prompt": "视频1是实际操作录屏，作为剪辑素材放在讲执行步骤的镜头，保留主要界面证据，不要缩成角落小窗。",
        "ratio": "16:9",
        "attachments": [video("record-1", "视频1", "真实操作录屏.mp4")],
        "roles": {"record-1": {"material"}},
    },
    {
        "name": "视频不作参考",
        "prompt": "视频1只是我随手拍的氛围参考，不需要剪进成片，也不能作为生成参考；主题是AI整理周报。",
        "ratio": "16:9",
        "attachments": [video("mood-1", "视频1", "办公室随手拍.mp4")],
        "roles": {"mood-1": {"unused"}},
    },
    {
        "name": "音频作为口播",
        "prompt": "音频1就是最终口播，原声作为主时间线，不重新配音；按转写内容规划画面。",
        "ratio": "16:9",
        "attachments": [audio("voice-1", "音频1", "最终口播.mp3", "整理资料不是目的，让团队随时知道下一步才是目的。")],
        "roles": {"voice-1": {"narration"}},
    },
    {
        "name": "音频作为BGM",
        "prompt": "做一条关于夜班编辑的短片，音频1只作为BGM，不是口播，画面节奏跟音乐但不能压住解说。",
        "ratio": "21:9",
        "attachments": [audio("bgm-1", "音频1", "夜间氛围音乐.mp3")],
        "roles": {"bgm-1": {"bgm"}},
    },
    {
        "name": "图视频分工",
        "prompt": "图1作为主人公外形参考，视频1作为中段真实操作素材；两者用途不要互换，主题是自由职业者如何整理客户资料。",
        "ratio": "16:9",
        "attachments": [
            image("person-2", "图1", "主人公参考.png"),
            video("record-2", "视频1", "整理客户资料录屏.mp4"),
        ],
        "roles": {
            "person-2": {"reference"},
            "record-2": {"material"},
        },
    },
    {
        "name": "多图语义分配",
        "prompt": "图1是人物，图2是耳机产品，图3是结果界面。人物和产品只作对应镜头生成参考，结果界面作为结尾全屏剪辑证据。",
        "ratio": "16:9",
        "attachments": [
            image("person-3", "图1", "人物定妆.png"),
            image("product-1", "图2", "白色耳机产品.png"),
            image("result-1", "图3", "结果界面.png"),
        ],
        "roles": {
            "person-3": {"reference"},
            "product-1": {"reference"},
            "result-1": {"material", "both"},
        },
    },
    {
        "name": "纪录片夜班",
        "prompt": "21:9纪录片短片：夜班编辑面对硬盘、素材和截止时间，最后得到一条清晰的交付链路；不要广告腔。",
        "ratio": "21:9",
    },
    {
        "name": "信息流冲突",
        "prompt": "前3秒几十个待办压向一个人，随后用真实操作证据讲AI如何拆目标、责任人和截止时间，结尾给出会议纪要、周报和客户资料三份交付物。",
        "ratio": "9:16",
    },
    {
        "name": "克制公益",
        "prompt": "讲旧衣从家庭衣柜到清洗、分类、再次使用的过程，不卖惨、不道德绑架，画面真实克制。",
        "ratio": "16:9",
    },
    {
        "name": "抽象概念具象化",
        "prompt": "把任务依赖讲清楚，允许用厨房备菜做开场隐喻，但中段必须回到真实项目管理动作和结果。",
        "ratio": "16:9",
    },
    {
        "name": "暂停后继续语义",
        "prompt": "这是同一条任务的补充要求：如果我中途暂停后说继续，应沿用已经确认的导演计划和完成素材，从缺失镜头接着做，不要重新策划。现在先按这个原则做一条15秒流程演示。",
        "ratio": "16:9",
    },
    {
        "name": "方形餐饮纪录",
        "prompt": "做一条1:1餐饮纪录短片：凌晨备料、午间高峰、收档盘点三个阶段都要真实可见，不要网红探店腔，也不要虚构顾客评价。",
        "ratio": "1:1",
    },
    {
        "name": "三比四非遗人物",
        "prompt": "3:4人物短片，讲一位木版年画手艺人如何判断线条、套色和废版。开头不要宏大旁白，从沾在手指上的颜料切入，结尾不煽情。",
        "ratio": "3:4",
    },
    {
        "name": "双语原句锁定",
        "prompt": "以下中英双语口播原句都不要改：先把问题说清楚。Make the problem visible. 再让每个人知道下一步。Then make the next move obvious. 画面不要直接生成这些句子的字幕。",
        "ratio": "16:9",
    },
    {
        "name": "图片明确不用",
        "prompt": "图1是上一次项目的旧海报，本轮不要重绘、不要剪入、也不要作为风格参考。本轮主题是社区图书馆如何整理读者归还的书。",
        "ratio": "16:9",
        "attachments": [image("old-poster-1", "图1", "旧项目海报.png")],
        "roles": {"old-poster-1": {"unused"}},
    },
    {
        "name": "人物与Logo分时",
        "prompt": "图1只作为主持人外形参考；图2是真实Logo，只在最后品牌揭示时居中出现，不要全程角标。主题是普通人如何用AI整理家庭照片。",
        "ratio": "9:16",
        "attachments": [
            image("host-4", "图1", "主持人定妆.png"),
            image("logo-4", "图2", "品牌Logo.png"),
        ],
        "roles": {
            "host-4": {"reference"},
            "logo-4": {"reference", "both"},
        },
    },
    {
        "name": "音效而非配乐",
        "prompt": "音频1只是一声打印机完成提示音，作为结尾音效使用，不是口播也不是BGM。做一条从混乱表格到清晰发票归档的16:9短片。",
        "ratio": "16:9",
        "attachments": [audio("sfx-2", "音频1", "打印机完成音.mp3")],
        "roles": {"sfx-2": {"sfx"}},
    },
    {
        "name": "视频仅供理解",
        "prompt": "视频1只帮助你理解仓库现场长什么样，不要直接剪进成片。请重新生成一条讲拣货员如何发现错放箱子的短片，保留真实劳动感。",
        "ratio": "21:9",
        "attachments": [video("warehouse-1", "视频1", "仓库勘景.mp4")],
        "roles": {"warehouse-1": {"unused"}},
    },
    {
        "name": "克制产品对比",
        "prompt": "把纸质清单、普通聊天助手和能执行的Agent放进同一个报销任务里做过程对比，只讲各自适合什么，不下绝对排名，不贬低任何一方。",
        "ratio": "16:9",
    },
    {
        "name": "一分钟科学解释",
        "prompt": "做一条至少60秒的16:9科普视频，向没有技术背景的人解释大语言模型为什么会一本正经地说错话。用导航、记忆和核对三个生活类比，但最终必须回到真实使用边界和核验方法。",
        "ratio": "16:9",
    },
    {
        "name": "修改意图不重开",
        "prompt": "这是同一轮方案里的修改：保留已确认的前半段办公室叙事，只把结尾从产品发布改成团队复盘；不要把这句话理解成重开新项目。现在请给出一条完整可执行的视频计划。",
        "ratio": "16:9",
    },
]


BANNED_PROMPT_FRAGMENTS = (
    "根据需要",
    "可以选择",
    "适用于seedance",
    "保留用户原分镜",
    "当前创作主题",
    "卖点表达",
)


def validate(case: dict[str, Any], decision: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    if decision.get("action") != "produce":
        return [f"未进入生产，action={decision.get('action')}"]
    plan = decision.get("plan") or {}
    if plan.get("aspect_ratio") != case["ratio"]:
        issues.append(f"画幅 {plan.get('aspect_ratio')} != {case['ratio']}")
    narration = str(plan.get("narration") or "").strip()
    if len(narration) < 12:
        issues.append("口播不足")
    scenes = list(plan.get("scenes") or [])
    if not scenes:
        issues.append("没有分镜")
    prompts: list[str] = []
    excerpts: list[str] = []
    for index, scene in enumerate(scenes, 1):
        prompt = str(scene.get("visual_prompt") or "").strip()
        if len(prompt) < 40:
            issues.append(f"分镜{index}提示词过短")
        hits = [item for item in BANNED_PROMPT_FRAGMENTS if item in prompt.lower()]
        if hits:
            issues.append(f"分镜{index}含占位词:{'/'.join(hits)}")
        duration = int(scene.get("duration_sec") or 0)
        if not 4 <= duration <= 15:
            issues.append(f"分镜{index}技术时长越界:{duration}")
        prompts.append(prompt)
        excerpts.append(str(scene.get("narration_excerpt") or ""))
    if len(set(prompts)) != len(prompts):
        issues.append("存在完全重复提示词")
    if "".join(excerpts) != narration:
        issues.append("口播没有被连续完整覆盖")
    assignments = {
        str(item.get("asset_id") or ""): str(item.get("role") or "")
        for item in (plan.get("asset_assignments") or [])
    }
    for asset_id, accepted_roles in (case.get("roles") or {}).items():
        if assignments.get(asset_id) not in accepted_roles:
            issues.append(
                f"附件{asset_id}用途={assignments.get(asset_id)!r}, "
                f"期望={sorted(accepted_roles)}"
            )
    return issues


async def run_case(
    index: int,
    case: dict[str, Any],
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    async with semaphore:
        try:
            decision = await director.decide(
                [{"role": "user", "content": case["prompt"]}],
                case["ratio"],
                list(case.get("attachments") or []),
                skill_context=director_context(),
                bgm_catalog=bgm_library.catalog(),
                creation_mode="video",
            )
            issues = validate(case, decision)
            plan = decision.get("plan") or {}
            result = {
                "index": index,
                "name": case["name"],
                "ok": not issues,
                "issues": issues,
                "title": plan.get("title"),
                "duration": plan.get("duration_sec"),
                "sceneCount": len(plan.get("scenes") or []),
                "assetAssignments": plan.get("asset_assignments") or [],
                "prompts": [
                    scene.get("visual_prompt")
                    for scene in (plan.get("scenes") or [])
                ],
            }
        except Exception as exc:
            result = {
                "index": index,
                "name": case["name"],
                "ok": False,
                "issues": [f"{type(exc).__name__}: {exc}"],
            }
        print(
            f"[{index:02d}/{len(SCENARIOS)}] {'PASS' if result['ok'] else 'FAIL'} "
            f"{case['name']} {result.get('issues') or ''}",
            flush=True,
        )
        return result


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--indices", default="")
    parser.add_argument(
        "--report",
        default="/private/tmp/v123-video-intent-report.json",
    )
    args = parser.parse_args()
    requested = {
        int(value)
        for value in args.indices.split(",")
        if value.strip().isdigit()
    }
    selected = [
        (index, case)
        for index, case in enumerate(SCENARIOS, 1)
        if not requested or index in requested
    ]
    semaphore = asyncio.Semaphore(max(1, min(6, args.concurrency)))
    results = await asyncio.gather(
        *[run_case(index, case, semaphore) for index, case in selected]
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
