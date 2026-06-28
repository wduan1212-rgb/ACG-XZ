# 云平台部署 + CLI 接入方案

> 2026-06 · 配合本目录 `server/`（最小后端）与 `cli/`（命令行工具）使用。此文档替代 md文档 内的旧指南。

## 现状与思路

目前是纯前端原型（index.html + app.js + styles.css），数据在内存里、DeepSeek Key 写死在前端。要让团队和供应商都能用，必须解决三件事：把 Key 移到服务端、让数据持久化、有一个所有人都能访问的地址。`server/main.py` 就是为此准备的最小后端：托管前端页面、代理模型请求（解决 CORS 与 Key 泄露）、提供账号 / 素材 REST 接口，并自动产出 OpenAPI 文档供 CLI 和 agent 对接。

**⚠ 安全提醒：app.js 里现在写死了一个 DeepSeek Key（CONFIG.apiKey）。部署前务必删除并在该平台作废这个 Key，统一改走后端 `/api/llm` 代理（环境变量 LLM_API_KEY）。**

## 三步走

**第一步 · 本地跑通（今天就能做）**

```bash
cd server
pip install -r requirements.txt
export LLM_API_KEY=sk-你的新Key
uvicorn main:app --host 0.0.0.0 --port 8787
# 浏览器打开 http://localhost:8787 即是工作台
# http://localhost:8787/docs 是自动生成的 API 文档
```

**第二步 · 云端部署（团队可用）**

最省事的路径是 Docker 单容器：

```bash
docker build -t acg-video-tool -f server/Dockerfile .
docker run -d -p 8787:8787 -e LLM_API_KEY=sk-xxx acg-video-tool
```

部署目标按公司情况选其一：百度智能云 BCC 一台最低配（前端+后端一个容器足够，内网或绑域名+HTTPS）；或者容器服务 CCE / 轻量应用服务器。素材文件（视频成片）不要存容器里，接 BOS 对象存储，`/api/assets` 的 `url` 字段已预留。账号体系上云后建议加最简单的登录（飞书 / 如流扫码或固定口令），创作端、供应商端各一个口令即可起步——前端登录分流页已经做好了。

**第三步 · 数据升级（量大之后）**

`data.json` 文件存储够 10 人团队起步用；任务多了换 SQLite（一行代码换连接），再大上 Postgres。前端 app.js 里 DumateAPI 各方法把 `fetch(CONFIG.endpoint…)` 换成 `fetch("/api/llm"…)` 即完成对接（接口已对齐）。

## CLI / Agent 接入

`cli/dumate.py` 是给人和 agent 共用的命令行：

```bash
export DUMATE_API=http://你的服务器:8787
python cli/dumate.py health
python cli/dumate.py accounts list
python cli/dumate.py accounts create --name "测试号" --platform 小红书 --mode 图文 --position "办公效率教程"
python cli/dumate.py script generate --account-id <id> --topic "一键整理混乱文件夹"
python cli/dumate.py assets list --platform 视频号
python cli/dumate.py assets download --id <素材id>
```

Agent 自动化有三条路，从易到难：① 直接让 agent 调这个 CLI（Claude Code / 搭子类 agent 天然会用 shell）；② 让 agent 读 `http://服务器:8787/openapi.json`，按 OpenAPI 直接发 HTTP 请求；③ 后续把 CLI 包成 MCP server，注册成工具给团队所有 agent 用。建议先 ①，零开发成本。

## 后续扩展位

视频生成 API（即梦 / Seedance / 千帆）接入时同样走后端代理，前端 CONFIG.video 不再存 Key；供应商下载行为已有 `/api/assets/{id}/download` 打点，月度创作计数在 `/api/assets` 创建时自动 +1，和前端进度展示同一口径。
