from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any

from app.main import bgm_library, director, director_context


SCENARIOS = [
    ("生活相册", "做一条AI帮普通人整理旅行相册的静态视频，温暖真实，其他由你判断。", "16:9"),
    ("产品教程", "给完全不懂技术的人解释如何用百度搭子整理会议资料，20秒，步骤清楚但别像说明书。", "16:9"),
    ("反差职场", "静态视频：打工人下班前突然收到四个任务，最后靠AI把混乱变成可交付清单，轻喜剧。", "16:9"),
    ("复杂对比", "比较只会聊天的AI和能执行任务的AI，不做高低排名，用五个真实办公场景讲清边界。", "16:9"),
    ("中文口播保留", "口播原文不要改：我不是不会做，而是不想把时间浪费在重复整理上。请围绕它做15秒静态视频。", "16:9"),
    ("长脚本", "做一条45秒静态视频，主题是一个人如何从资料焦虑走到有序工作；需要开场、三个具体动作、结果和克制收束。", "16:9"),
    ("品牌克制", "介绍星阵视频工坊，品牌只在结尾自然出现一次，不要满屏Logo，不要赛博蓝光。", "16:9"),
    ("竖屏明确", "做一条9:16竖屏静态视频，讲独居年轻人周末整理房间时如何顺手整理数字文件。", "9:16"),
    ("方形明确", "做成1:1方形静态视频：三种最容易被AI自动化的重复办公动作，适合社交媒体信息流。", "1:1"),
    ("超宽明确", "21:9电影宽幅，做一个偏纪录片的静态视频，讲夜班编辑和他的素材硬盘。", "21:9"),
    ("极简留白", "用极简杂志摄影风格解释什么是Agent，不能出现机器人、芯片、代码雨和悬浮屏。", "16:9"),
    ("水墨融合", "静态视频讲中国茶馆里传统手艺人第一次使用AI记账，现代但不要破坏真实生活气息。", "16:9"),
    ("儿童科普", "面向10岁孩子解释AI为什么会犯错，用生活比喻，画面友好但不要幼稚卡通。", "16:9"),
    ("老年受众", "给父母辈讲清手机相册自动分类，字不进入生成图片，靠人物和物件说明。", "16:9"),
    ("数据抽象", "把每周数据复盘拍得可看：拒绝满屏图表，用真实门店、包裹、顾客和白板承接数字。", "16:9"),
    ("情绪治愈", "一位自由职业者从凌晨焦虑到清晨交付，静态视频，有呼吸感，结尾不要喊口号。", "16:9"),
    ("悬疑叙事", "用轻悬疑方式讲一个文件为什么总找不到，最终揭示是命名和归档流程问题，30秒。", "16:9"),
    ("美食旅游", "马来西亚嘛嘛档串联槟城、沙巴和吉隆坡三段旅行记忆，用美食做视觉线索。", "16:9"),
    ("多人物一致", "固定同一位28岁中国女性创业者，展示她在家、咖啡店和客户会议三个场景，人物外貌不能漂移。", "16:9"),
    ("双线并行", "一边是手忙脚乱的新员工，一边是有流程的老员工，最后在同一张任务板汇合；静态分镜要能看懂双线。", "16:9"),
    ("无界面证据", "讲AI自动整理文件，但不要用任何软件界面，全部用桌面、文件夹、便签和人物动作建立证据。", "16:9"),
    ("界面必要", "讲客服工单自动归类，关键状态可以出现很短的真实界面标签，但不要把口播做成大字卡。", "16:9"),
    ("产品摄影", "为一款白色降噪耳机做静态视频，卖点是通勤安静感；不要参数堆砌，不要悬浮爆炸图。", "16:9"),
    ("公益语气", "做一条关于旧衣循环的静态视频，不卖惨、不道德绑架，用一件外套的流转讲清过程。", "16:9"),
    ("古今对照", "古代驿站和现代任务协作做平行对照，解释信息传递为什么需要状态可见，但不要魔幻穿越。", "16:9"),
    ("冷静测评", "一条不站队的AI工具测评静态视频：准备材料、执行过程、结果复核、适用边界四部分。", "16:9"),
    ("密集列举", "明确呈现开发者、运营、设计师、行政、学生五类人如何各自使用Agent，每类必须是不同真实场景。", "16:9"),
    ("轻复古", "90年代家庭录像质感，但内容是今天的年轻人用AI做旅行计划；不能出现受版权保护角色。", "16:9"),
    ("具象隐喻", "把任务积压比作厨房备菜，但最后要回到真实办公动作，不能整条都停留在隐喻。", "16:9"),
    ("信息流开场", "前3秒要有强视觉冲突：几十个待办压向一个人；随后迅速讲清AI如何拆解，最终给出真实交付物。", "16:9"),
]


VIDEO_ONLY_MARKERS = (
    "seedance",
    "运镜",
    "镜头推进",
    "镜头移动",
    "镜头缓慢",
    "跟拍",
    "摇镜",
    "推镜",
    "拉镜",
    "转场",
    "连续动作",
    "动作过程",
    "视频模型",
    "镜头后拉",
    "镜头上移",
    "镜头下移",
    "镜头前移",
    "镜头摇",
    "依次出现",
    "最后镜头",
    "表情先是",
    "缓缓上移",
    "缓慢上移",
    "缓慢拉远",
    "缓慢摇",
    "缓推",
    "前推",
    "缓慢下落",
)


def validate(case: tuple[str, str, str], decision: dict[str, Any]) -> list[str]:
    name, _prompt, expected_ratio = case
    issues: list[str] = []
    if decision.get("action") != "produce":
        return [f"{name}: 未进入生产，action={decision.get('action')}"]
    plan = decision.get("plan") or {}
    if plan.get("creation_mode") != "static":
        issues.append("计划未标记 static")
    if plan.get("aspect_ratio") != expected_ratio:
        issues.append(f"画幅 {plan.get('aspect_ratio')} != {expected_ratio}")
    if len(str(plan.get("style_anchor") or "").strip()) < 20:
        issues.append("整片风格锚点不足")
    if len(str(plan.get("negative_constraints") or "").strip()) < 15:
        issues.append("负面约束不足")
    if name == "多人物一致" and not any(
        str(item.get("kind") or "") == "character"
        for item in (plan.get("continuity_anchors") or [])
        if isinstance(item, dict)
    ):
        issues.append("贯穿人物没有先规划角色一致性锚点")
    scenes = list(plan.get("scenes") or [])
    if len(scenes) < 2:
        issues.append("分镜少于2")
    prompts: list[str] = []
    for index, scene in enumerate(scenes, 1):
        image_prompt = str(scene.get("image_prompt") or "").strip()
        visual_prompt = str(scene.get("visual_prompt") or "").strip()
        if len(image_prompt) < 60:
            issues.append(f"分镜{index}图片提示词过短")
        if image_prompt != visual_prompt:
            issues.append(f"分镜{index}兼容提示词不一致")
        if not str(scene.get("narration_excerpt") or "").strip():
            issues.append(f"分镜{index}没有口播锚点")
        hits = [marker for marker in VIDEO_ONLY_MARKERS if marker in image_prompt.lower()]
        if hits:
            issues.append(f"分镜{index}混入视频指令:{'/'.join(hits)}")
        prompts.append(image_prompt)
    if len(set(prompts)) != len(prompts):
        issues.append("存在完全重复图片提示词")
    return issues


async def run_case(
    index: int,
    case: tuple[str, str, str],
    semaphore: asyncio.Semaphore,
) -> dict[str, Any]:
    name, prompt, ratio = case
    async with semaphore:
        try:
            decision = await director.decide(
                [{"role": "user", "content": prompt}],
                ratio,
                [],
                skill_context=director_context(),
                bgm_catalog=bgm_library.catalog(),
                creation_mode="static",
            )
            issues = validate(case, decision)
            plan = decision.get("plan") or {}
            result = {
                "index": index,
                "name": name,
                "ok": not issues,
                "issues": issues,
                "action": decision.get("action"),
                "title": plan.get("title"),
                "aspectRatio": plan.get("aspect_ratio"),
                "duration": plan.get("duration_sec"),
                "sceneCount": len(plan.get("scenes") or []),
                "styleAnchor": plan.get("style_anchor"),
                "negativeConstraints": plan.get("negative_constraints"),
                "continuityAnchors": plan.get("continuity_anchors") or [],
                "imagePrompts": [
                    scene.get("image_prompt")
                    for scene in (plan.get("scenes") or [])
                ],
            }
        except Exception as exc:
            result = {
                "index": index,
                "name": name,
                "ok": False,
                "issues": [f"{type(exc).__name__}: {exc}"],
            }
        print(
            f"[{index:02d}/{len(SCENARIOS)}] {'PASS' if result['ok'] else 'FAIL'} "
            f"{name} {result.get('issues') or ''}",
            flush=True,
        )
        return result


async def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument(
        "--indices",
        default="",
        help="Comma-separated 1-based scenario indices; empty runs all 30.",
    )
    parser.add_argument(
        "--report",
        default="/private/tmp/v123-static-intent-report.json",
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
        *[
            run_case(index, case, semaphore)
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
