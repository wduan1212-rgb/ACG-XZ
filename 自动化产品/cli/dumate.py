#!/usr/bin/env python3
# =========================================================
# dumate-cli —— 平台命令行接口（给人用，也给 agent 用）
# 依赖：pip install requests
# 配置：export DUMATE_API=http://localhost:8787   （部署后换成云端地址）
# 示例：
#   python dumate.py health
#   python dumate.py accounts list
#   python dumate.py accounts create --name "测试号" --platform 小红书 --mode 图文 --position "办公效率教程"
#   python dumate.py script generate --account-id abc123 --topic "一键整理混乱文件夹"
#   python dumate.py assets list --platform 视频号
#   python dumate.py assets download --id xyz789
# agent 接入：直接读 ${DUMATE_API}/openapi.json 即可获得全部接口定义，
#            或把本 CLI 包装成 MCP server / shell 工具给 agent 调用。
# =========================================================
import argparse
import json
import os
import sys

import requests

API = os.getenv("DUMATE_API", "http://localhost:8787").rstrip("/")


def out(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))


def main():
    p = argparse.ArgumentParser(prog="dumate", description="ACG 视频工具 CLI")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("health", help="服务健康检查")

    acc = sub.add_parser("accounts", help="账号管理").add_subparsers(dest="sub", required=True)
    acc.add_parser("list", help="列出全部账号")
    c = acc.add_parser("create", help="创建账号")
    c.add_argument("--name", required=True)
    c.add_argument("--platform", default="小红书", choices=["小红书", "视频号", "抖音", "公众号"])
    c.add_argument("--mode", default="视频", choices=["视频", "图文"])
    c.add_argument("--sub-type", default="", choices=["", "数字人", "无数字人"])
    c.add_argument("--position", default="")
    d = acc.add_parser("delete", help="删除账号")
    d.add_argument("--id", required=True)

    sc = sub.add_parser("script", help="脚本生成").add_subparsers(dest="sub", required=True)
    g = sc.add_parser("generate", help="按账号定位生成分镜脚本")
    g.add_argument("--account-id", required=True)
    g.add_argument("--topic", required=True)
    g.add_argument("--direction", default="")

    ast = sub.add_parser("assets", help="素材管理").add_subparsers(dest="sub", required=True)
    al = ast.add_parser("list", help="列出素材（供应商视角）")
    al.add_argument("--platform", default=None)
    al.add_argument("--tag", default=None)
    ad = ast.add_parser("download", help="标记素材已下载")
    ad.add_argument("--id", required=True)

    a = p.parse_args()

    if a.cmd == "health":
        out(requests.get(f"{API}/api/health").json())

    elif a.cmd == "accounts":
        if a.sub == "list":
            out(requests.get(f"{API}/api/accounts").json())
        elif a.sub == "create":
            out(requests.post(f"{API}/api/accounts", json={
                "name": a.name, "platform": a.platform, "mode": a.mode,
                "subType": a.sub_type, "position": a.position,
            }).json())
        elif a.sub == "delete":
            out(requests.delete(f"{API}/api/accounts/{a.id}").json())

    elif a.cmd == "script":
        accounts = requests.get(f"{API}/api/accounts").json()
        target = next((x for x in accounts if x["id"] == a.account_id), None)
        if not target:
            sys.exit(f"账号 {a.account_id} 不存在")
        sysmsg = (
            "你是资深短视频编剧。按账号定位输出30秒分镜脚本，正好8个镜头，"
            '只输出 JSON：{"title":"...","shots":[{"time":"0-3s","idea":"...","visual":"...","line":"..."}]}'
        )
        usermsg = (f"账号定位：{target.get('position','')}\n平台：{target['platform']}\n"
                   f"人群方向：{a.direction or '不限'}\n主题：{a.topic}")
        r = requests.post(f"{API}/api/llm", json={
            "messages": [{"role": "system", "content": sysmsg}, {"role": "user", "content": usermsg}],
            "json_mode": True,
        })
        r.raise_for_status()
        out(json.loads(r.json()["content"]))

    elif a.cmd == "assets":
        if a.sub == "list":
            params = {k: v for k, v in {"platform": a.platform, "tag": a.tag}.items() if v}
            out(requests.get(f"{API}/api/assets", params=params).json())
        elif a.sub == "download":
            out(requests.post(f"{API}/api/assets/{a.id}/download").json())


if __name__ == "__main__":
    main()
