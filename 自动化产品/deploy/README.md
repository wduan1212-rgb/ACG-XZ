# Dumate Studio / 星阵定制创作部署

生产目录建议为：

```bash
/opt/dumate-studio
```

本版本包含两个隔离运行的 Python 服务：

- 主平台 FastAPI：默认 `8787`，对外只暴露这一端口。
- 视频工坊 sidecar：默认 `127.0.0.1:8765`，只允许主平台通过回环地址访问，
  不得在安全组、Nginx 或 Docker 端口映射中直接公开。

无限画布不需要独立进程，生产静态产物位于
`vendor/infinite-canvas/`，由主平台在 `/XZ-Design` 同源托管。服务器运行
不读取 `apps/infinite-canvas-source/`；该目录用于后续重建静态产物。

## 服务器依赖

- Python 3.10 或更新版本。
- FFmpeg 与 ffprobe。
- 可显示中文字幕的字体；Ubuntu / Debian 建议安装 `fonts-noto-cjk`。
- 能访问所配置的 LLM、图片、Seedance、MiniMax 与模型下载地址。
- 足够的持久磁盘保存视频上传、成片、BGM 与 faster-whisper 模型缓存。

Ubuntu / Debian 示例：

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg fonts-noto-cjk python3 python3-venv
```

## 密钥与环境

真实 `.env`、`.env.local`、API Key、token 和账号凭据不能进入 Git、Docker
镜像或代码同步包。把生产配置保留在服务器
`/opt/dumate-studio/.env.local`，或由 systemd / 容器平台注入。

完整创作链路至少需要：

- 导演与文案：`LLM_API_KEY`、`LLM_ENDPOINT`（以及匹配的 `LLM_MODEL`）。
- 无限画布真实出图：`IMAGE_API_KEY`、`IMAGE_BASE_URL` /
  `IMAGE_ENDPOINT`、`IMAGE_MODEL`、`IMAGE_MODE`。
- 视频片段：`SEEDANCE_API_KEY`、`SEEDANCE_BASE_URL`、
  `SEEDANCE_MODEL`。
- 无上传口播时的配音：`MINIMAX_API_KEY`、`MINIMAX_BASE_URL`、
  `MINIMAX_TTS_MODEL`、`MINIMAX_VOICE_ID`；若平台设计音色使用了
  `MINIMAX_GROUP_ID`，视频工坊必须沿用相同 GroupId 才能调用该音色。

视频工坊会自动读取主产品根目录的 `.env.local`。进程和持久目录变量建议保持：

```bash
VIDEO_WORKSHOP_HOST=127.0.0.1
VIDEO_WORKSHOP_PORT=8765
VIDEO_WORKSHOP_URL=http://127.0.0.1:8765
VIDEO_WORKSHOP_DATA_ROOT=/opt/dumate-studio/runtime/video-workshop
BGM_SOURCE=platform
DATA_DB=/opt/dumate-studio/server/data.sqlite
UPLOAD_DIR=/opt/dumate-studio/server/uploads
HF_HOME=/opt/dumate-studio/runtime/model-cache
```

`BGM_SOURCE=platform` 时，视频工坊只读主平台 SQLite 的 `assets` 文档和
`UPLOAD_DIR` 中由 `/api/files/` 上传的真实音频，不复制、不删除也不覆盖
服务器资产。`DATA_DB`、`UPLOAD_DIR` 必须与主服务保持完全一致；共享库为空
时仍允许生成无 BGM 成片。只有需要切回独立目录曲库时才设置
`BGM_SOURCE=local` 和 `BGM_LIBRARY_DIR`。

`ASR_MODEL=small` 会在首次转写时下载 faster-whisper 模型并缓存到
`HF_HOME`。无外网服务器应提前把兼容的 CTranslate2 模型目录放到持久盘，
再把 `ASR_MODEL` 配成该绝对路径。不要把模型缓存放进代码目录。

## 非 Docker 启停

首次启动与每次代码更新后：

```bash
cd /opt/dumate-studio
chmod +x deploy/*.sh
deploy/start_server.sh
```

脚本会：

1. 分别创建主服务 `.venv` 与 `apps/video-workshop/.venv`，避免
   FastAPI / Pydantic 版本互相覆盖。
2. 校验 FFmpeg、无限画布静态产物和视频工坊运行副本。
3. 首次升级时把旧代码目录中的视频工坊数据非破坏性复制到 `runtime/`，
   目标已存在的文件不会被覆盖，旧目录也不会被删除。
4. 备份主平台数据库，以及视频工坊项目 JSON 与媒体清单。
5. 先启动并验证 `8765` sidecar，再启动并验证 `8787` 主服务。

停止与检查：

```bash
deploy/stop_server.sh
deploy/status_server.sh
```

状态脚本同时显示两个 PID、两个健康检查和两份日志。

## 数据保护与代码同步

升级时只能覆盖代码和静态资源。以下内容属于服务器数据或私密配置，不得从
本地空目录覆盖、删除或回传：

```text
.env
.env.local
.venv/
server/data.sqlite
server/data.sqlite-*
server/data.json
server/uploads/
server/composed/
runtime/
backups/
logs/
apps/video-workshop/.venv/
apps/video-workshop/data/projects/
apps/video-workshop/outputs/
apps/video-workshop/uploads/
```

兼容旧版本时，最后三项即使已经迁移到 `runtime/video-workshop/` 也继续
排除，避免误删尚未迁移的历史项目。不要使用 `--delete-excluded`。

安全同步示例（源目录为 `自动化产品/`）：

```bash
rsync -av --delete \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.venv/' \
  --exclude 'server/data.sqlite*' \
  --exclude 'server/data.json' \
  --exclude 'server/uploads/' \
  --exclude 'server/composed/' \
  --exclude 'runtime/' \
  --exclude 'backups/' \
  --exclude 'logs/' \
  --exclude 'apps/video-workshop/.venv/' \
  --exclude 'apps/video-workshop/data/projects/' \
  --exclude 'apps/video-workshop/outputs/' \
  --exclude 'apps/video-workshop/uploads/' \
  --exclude 'apps/infinite-canvas-source/node_modules/' \
  --exclude 'apps/infinite-canvas-source/.next/' \
  --exclude 'apps/infinite-canvas-source/out/' \
  ./ <ssh-target>:/opt/dumate-studio/
```

此次代码同步必须包含：

```text
apps/video-workshop/
vendor/infinite-canvas/
apps/infinite-canvas-source/   # 运行非必需，但建议随源码版本保存
deploy/
server/main.py
server/store.py
```

## Docker

从 `自动化产品/` 作为构建上下文：

```bash
docker build -f server/Dockerfile -t dumate-studio:latest .
docker run -d \
  --name dumate-studio \
  --env-file /opt/dumate-studio/.env.local \
  -p 8787:8787 \
  -v /opt/dumate-data:/data \
  dumate-studio:latest
```

镜像包含 `apps/video-workshop/`、`vendor/infinite-canvas/`、FFmpeg、
中文字幕字体和 sidecar 独立虚拟环境；不会复制真实 env、运行数据、模型缓存
或虚拟环境。只映射 `8787`，不要映射 `8765`。

## 发布前验收

```bash
curl -fsS http://127.0.0.1:8787/api/health
curl -fsS http://127.0.0.1:8765/api/health
```

还需在登录后的定制创作页面完成一次无限画布真实出图、一次视频工坊口播转写
和成片生成，并验证发布时能选择账号、生成文案/封面、填写发布时间与备注。

视频工坊内含 AGPL-3.0 的 OpenMontage 精简运行文件。公网部署前须落实
`apps/video-workshop/THIRD_PARTY_NOTICES.md` 中的许可证和网络交互源代码
提供义务。
