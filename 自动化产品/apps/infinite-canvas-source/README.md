# 星阵无限画布：项目内可维护源码

这里保存主平台“定制创作 → 无限画布”的最小可重建源码。服务器实际托管的是
`../../vendor/infinite-canvas/`；运行时不读取本目录，也不依赖主项目之外的本机目录。

## 目录职责

- `src/`、`public/`：无限画布 UI 与浏览器端功能源码。
- `package.json`、`package-lock.json` 和构建配置：可复现依赖与静态导出。
- `../../vendor/infinite-canvas/`：FastAPI 在 `/XZ-Design` 托管的部署产物。
- `../../js/views/customCanvasIntegration.js`：主平台 iframe、鉴权预检和产出消息桥。
- `../../server/main.py` 中的 `/api/custom-canvas/*`：模型调用、权限和参考图回执。

主平台模式使用同源 iframe 隔离 React、Zustand 和 CSS。画布项目以当前成员 ID
作为浏览器存储命名空间；`localStorage` 只保存首页需要的项目摘要，完整
节点、消息、视口和图片保存到按成员分仓的 IndexedDB，进入项目时才加载。
历史 v2 数据会在浏览器内自动迁移；IndexedDB 不可用时保留完整旧数据兜底。
导出时通过 `postMessage` 发送
`xingzhen-canvas / output-ready`，再由主平台进入发布流程。

## 安装与验证

需要 Node.js 20 或更新版本。

```bash
npm ci
npm run lint
npm run typecheck
npm run build:embed
```

`build:embed` 会生成带 `/XZ-Design` base path 的静态目录 `out/`，并固定启用：

- `NEXT_PUBLIC_GITHUB_PAGES=1`：使用 hash 路由，刷新时不要求 FastAPI 处理子路由。
- `NEXT_PUBLIC_BASE_PATH=/XZ-Design`：静态资源走主平台同源路径。
- `NEXT_PUBLIC_PLATFORM_EMBED=1`：隐藏子应用 API Key UI，并把请求发送到
  `/api/custom-canvas/*`，附带主平台的 `dumate.token`。
- `--webpack`：避免 Turbopack 在隔离或符号链接依赖环境下越过项目根目录。

验证通过后，才可在主项目根目录同步部署产物：

```bash
npm run sync:vendor
npm run check:vendor
```

`sync:vendor` 会先在同级临时目录形成完整闭包并计算路径、大小与 SHA-256，
再切换 `vendor/infinite-canvas/` 并生成
`vendor/infinite-canvas.manifest.json`。不要手工拼接历史哈希，也不要直接对混杂目录执行
删除式同步；目录与 manifest 全部通过校验前会保留上一版，中途失败则恢复上一版。
同步后必须重新运行 `server/tests/test_custom_canvas_integration.py`。
不要只部署源码；生产环境需要同时携带 manifest 内列出的静态闭包。

## 安全边界

- 不提交或复制 `.env.local`、真实 API Key、浏览器 LocalStorage、用户项目缓存。
- 不纳入 `node_modules/`、`.next/`、`out/`、`.cache/` 或日志。
- 主平台嵌入构建不需要子应用模型密钥，模型密钥只由 FastAPI 环境管理。
- 不把客户端提供的 owner ID 当作服务端授权依据；所有模型接口继续使用主平台
  Bearer token 和创作角色校验。
- 参考图生成必须收到服务端完整使用回执；回执不完整时停止生成，不能静默转为文生图。

来源与本地适配记录见 [SOURCE_PROVENANCE.md](./SOURCE_PROVENANCE.md)，依赖许可映射见
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)。
