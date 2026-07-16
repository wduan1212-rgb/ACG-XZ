# 星阵视频工坊 Sidecar

这是主平台内置的可部署视频工坊副本。它仍作为独立 FastAPI sidecar
运行，避免 `faster-whisper`、新版 FastAPI / Pydantic 等依赖与主服务
运行时相互覆盖。主平台通过 `/custom-video/` 同源桥接调用它。

## 安装与启动

需要 Python 3.10+、FFmpeg 和 ffprobe。首次部署：

```bash
cd 自动化产品/apps/video-workshop
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python run.py
```

默认监听 `127.0.0.1:8765`。sidecar 使用
`VIDEO_WORKSHOP_HOST` / `VIDEO_WORKSHOP_PORT`，不会继承主服务的通用
`HOST` / `PORT`，从而避免与 `8787` 冲突。主服务默认连接
`http://127.0.0.1:8765`，可用 `VIDEO_WORKSHOP_URL` 覆盖。

本副本不会携带 `.env.local`。它会自动尝试读取主产品根目录的
`.env.local`，生产环境也可以直接注入环境变量，或用
`FALLBACK_ENV` 指向服务器上的私密配置。

## 运行数据

以下目录启动时自动创建，内容被 Git 忽略，部署时应映射到持久卷：

- `data/projects/`：项目 JSON
- `outputs/`：生成中间文件与最终成片
- `uploads/`：用户上传附件

对应路径可通过 `VIDEO_WORKSHOP_PROJECTS_DIR`、
`VIDEO_WORKSHOP_OUTPUT_DIR`、`VIDEO_WORKSHOP_UPLOAD_DIR` 覆盖。主平台
读取输出和附件时应使用相同的后两个变量。

项目部署脚本默认把三类数据映射到主产品
`runtime/video-workshop/`，把 faster-whisper 模型缓存映射到
`runtime/model-cache/`。这些目录均不得被代码同步覆盖。

默认 `BGM_SOURCE=platform`。sidecar 通过与主服务相同的 `DATA_DB` 和
`UPLOAD_DIR` 只读查询共享 BGM：只接受 `type=音频`，且名称或标签含
`BGM`、`音乐库`、`配乐`，同时排除口播、语音、TTS、数字人和声线参考。
只会解析主服务生成的 `/api/files/<文件名>` / `serverFileName`，不会读取
资产文档里的任意绝对路径，也不会复制、删除或覆盖主平台资产。共享库为空时
仍可正常生成无 BGM 成片。若要单独运行旧式目录曲库，需显式改为
`BGM_SOURCE=local` 并设置 `BGM_LIBRARY_DIR`。

`ASR_MODEL=small` 会在第一次转写时下载模型。无外网环境应提前放置本地
CTranslate2 模型，并把 `ASR_MODEL` 指向该绝对路径。Linux 服务器还应安装
`fonts-noto-cjk`，避免 FFmpeg 烧录中文字幕时缺少字形。

## 部署边界

- 不包含原试验目录的 `.venv`、`.env.local`、项目记录、输出、上传、
  日志、Playwright 截图或缓存。
- 不依赖原试验目录；删除或移动原目录不会影响本副本启动。
- `vendor/OpenMontage` 只保留当前运行实际调用的质量检查器、基础类和
  三份导演规则，不包含上游 `.git`、示例、Remotion 工程或其他工具。
- FFmpeg / ffprobe 是系统依赖，不打包进仓库。
- 真实 `.env.local` 与密钥必须由服务器环境注入，不能复制到代码包或镜像。
- sidecar 没有独立公网鉴权层，`VIDEO_WORKSHOP_HOST` 必须保持回环地址，
  生产防火墙和反向代理不得暴露 `8765`。

第三方许可证和来源见
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
