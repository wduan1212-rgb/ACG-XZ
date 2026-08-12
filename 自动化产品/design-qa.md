# v142.1 无限画布同步与统一侧栏 Design QA

- source visual truth:
  - 画布重复收起按钮：`/var/folders/l6/1m22n40x5g1fr2cd39v0jj2h0000gn/T/codex-clipboard-09a7625a-aa75-406f-87c6-53f697dce469.png`。
  - 工作区菜单“无限画布”换行：`/var/folders/l6/1m22n40x5g1fr2cd39v0jj2h0000gn/T/codex-clipboard-cc8221c2-0563-4893-8e35-4527c68eb677.png`。
  - 采用服务器版本后再次出现冲突：`/var/folders/l6/1m22n40x5g1fr2cd39v0jj2h0000gn/T/codex-clipboard-949059ec-2917-4f71-af9a-68b372d8d9d9.png`。
- implementation screenshots:
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/artifacts/design-qa/v1421-infinite-canvas-final.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/artifacts/design-qa/v1421-infinite-canvas-collapsed-final.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/artifacts/design-qa/v1421-menu-reference-vs-final.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/artifacts/design-qa/v1421-collapse-reference-vs-final.png`
- implementation state: `http://127.0.0.1:8787/?qa=v1421-qianfan-workspace-controls-4#/custom/canvas/project_mrumr58w3cbb085c83dc`。
- viewport: `1680×1050` CSS px。

## Full-view comparison evidence

- 展开状态只保留平台统一的“收起左侧栏”；旧画布专属箭头、父页面 ViewportControls portal 和为其预留的上下文区均已移除。小地图、缩放和适应内容控件完整保留在画布左下角。
- 收起后是白色 `56px` 图标 rail，顺序为“首页 → 视频工坊 → 无限画布 → 批量生产 → 整体资产 → 发布清单 → 账号数据”，只有无限画布高亮；底部为当前用户头像。展开按钮与图标入口互不覆盖。
- Logo 下拉菜单同样按上述顺序显示；“无限画布”在窄菜单内保持单行，没有文字挤压或换行。两组并排比较图分别把用户原问题图与最终真实页面放在同一画面中复核，而不是只凭最终截图判断。
- 真实恢复画布连续三次刷新均未出现“服务器与本地都出现了新编辑”“采用服务器版本”或同步失败横幅；实际画布保存请求返回 `200`。历史社区缺失图片仍保持缺失，没有因本次 UI/同步修复被删除或伪造。

## Validation and findings

- 无限画布草稿与集成测试 `85/85` 通过；Node 工作区烟测覆盖统一 rail、菜单单行、无旧 portal 与左下角 ViewportControls。浏览器分别验证展开、收起和重复刷新状态。
- 根因是无关历史社区缺失媒体让同事务全量 GC 抛错并回滚当前保存；修复只把已知历史阻断隔离到 GC savepoint，当前草稿仍在 GC 前执行严格 Blob 校验，真实并发冲突仍 fail closed。
- boundary: 未删除/移动历史引用，未伪造媒体，未放宽未来缺失门禁；没有真实生成、发布、供应商回传、生产连接、Git 提交、推送或部署。

final result: passed

---

# v142.0 生成稳定性、视频会话续开与供应商媒体 Design QA

- source visual truth:
  - 视频工坊错误与落底问题：`/var/folders/l6/1m22n40x5g1fr2cd39v0jj2h0000gn/T/codex-clipboard-3719809b-5c9d-4cc8-a33c-165cf84d297f.png`。
  - 供应商图片不可用：`/var/folders/l6/1m22n40x5g1fr2cd39v0jj2h0000gn/T/codex-clipboard-7aefe0ce-99a0-46c5-a0c4-eddbd8099b92.png`。
  - 新任务错误显示旧合成事件：`/var/folders/l6/1m22n40x5g1fr2cd39v0jj2h0000gn/T/codex-clipboard-d638a667-791b-4a23-8d84-20ae72156954.png`。
  - 运行中会话菜单撑高卡片：`/var/folders/l6/1m22n40x5g1fr2cd39v0jj2h0000gn/T/codex-clipboard-f077baf1-62a2-4cb7-aae4-2af9c575f035.png`。
- implementation screenshots:
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1419-video-scroll.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1419-supplier-media.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1419-video-comparison.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1419-supplier-comparison.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1419-greeting-thinking-final-9.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1419-greeting-final-9.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1419-running-scope-menu-final-15.png`
- implementation state: `http://127.0.0.1:8787/?qa=v1420-generation-resilience-1#/custom/video/d2bbf44b8928`，加载资源身份 `20260812-v1425-batch-media-recovery-1`。
- viewport: 两个最终页面均在 `1280×720` CSS px 验证；单页截图均为 `1280×720` px。

## Full-view comparison evidence

- 视频会话打开并等待媒体稳定后，内部 `.conversation-column` 的 `scrollTop=10660.5`、`scrollHeight=11380`、`clientHeight=720`，距底部约 `-0.5px`（舍入后为 `0px`）；修复前同一路径距底部 `571px`。最终画面直接显示最新交付卡、操作区和输入框，没有停在“快到底部”的中间位置。
- 初始化固定使用即时落底，不出现平滑动画与延迟媒体共同造成的二次跳动；短时锁结束后仍保留原有用户阅读位置保护。
- 同一原会话真实发送 `hi` 后，公开进度只显示“识别当前消息”，没有出现“等待媒体任务”“补充关键信息”或上一轮制作步骤；原项目 URL 全程未改变。pending 时距底部 `0px`，最终长回复完成后的 `0/250/750/1500/3000ms` 五次采样均约为 `-0.5px`（浏览器半像素舍入），证明新回复增高和后续重绘都没有把窗口留在旧位置。
- 最终消息计算样式为 `animation-name: none / duration: 0s`；历史消息 DOM 更新不再重播入场动画，思考状态点和省略号也不循环闪烁。
- 在同一历史会话启动新的“规则怪谈”生产后，项目耐久状态确认导演方案、口播和新图片分镜均属于本轮请求；展示区按 `runStartedAt` 排除了上一轮合成/质检事件，只显示本轮“连续性参考设定 / 图片分镜并行生成 / 提交静态图片分镜”三个不同步骤。该验收没有暂停、重启或改变两条正在运行的本地生产任务。
- 左侧当前运行会话打开三点菜单后，浏览器计算样式为 `position:absolute / display:grid`，菜单高度 `173px`，会话 shell 打开前后保持 `35px`；菜单不再撑高卡片或盖住后续历史行。
- 供应商样例交付 `7ina9kyz` 的两张图片均完成浏览器解码，`naturalWidth=1152`、`naturalHeight=1536`，错误占位隐藏。对应 delivery-scoped 文件 URL 返回 JPEG `200`；没有修改交付引用或媒体授权。
- 对比图逐项核对用户错误截图与最终真实页面：视频工坊最新消息和输入框完整可见；供应商缩略图区域显示实际百舸图片而不是“图片暂不可用”。未发现剩余 P0/P1/P2 视觉回归。

## Validation and findings

- 视频工坊 Web `12/12`、工作区 Node `38/38` 及主平台集成定向测试通过；JavaScript/Python 语法、资源身份、runtime manifest 和 `git diff --check` 通过。新增 Web 行为测试证明 running 只读取本轮开始后的事件、旧合成事件不进入显示、相同当前事件去重且原事件数组不改写；工作区烟测证明运行态通配定位不能再覆盖菜单绝对定位。
- 本地使用已配置导演链路对原项目执行了最小真实文本问候验收；只产生普通文字回复，没有触发图片、视频或语音生成。另按项目精确收口了 `05cbfcf2769f` 的 `3` 条历史 sidecar submitted receipt，fresh backup/snapshot 绑定、apply 与二跑零写均通过；其他项目 `20` 条真实未决证据保持不变。没有发布、供应商回传、生产连接、Git 提交、推送或部署。
- 供应商问题属于本地恢复运行参数错配；修复是把恢复数据库重新绑定到同一恢复点的媒体根目录，不是放宽缺失媒体门禁。

final result: passed

---

# v141.8 账号数据首屏与视频运行进度 Design QA

- source visual truth: 用户提出重排要求的截图 `/var/folders/l6/1m22n40x5g1fr2cd39v0jj2h0000gn/T/codex-clipboard-7c1955a2-b512-4b84-b165-83c540ff1a52.png`，原图 `2572×1550` px；目标是把环图和发布沟通放在首屏上层、折线图放在下层，并消除中部大块空白。
- implementation screenshots:
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1418-account-data-overview-final.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1418-content-data-collapsed.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1418-content-data-expanded-link.png`
- implementation state: `http://127.0.0.1:8787/?qa=v1418-final#/overview`，加载资源身份 `20260810-v1418-dashboard-thinking-2`。
- viewport: `1440×900` CSS px，device scale factor `1`；三张实现截图均为 `1440×900` px。
- comparison method: 同一次视觉比较输入先放用户问题截图，再放最终账号数据全页截图，核对上层三卡比例、下层折线图高度、左右工作区关系和空白分配；内容明细再分别截取默认折叠与展开真实回链账号两种状态。

## Full-view comparison evidence

- 上层使用播放量环图、发布量环图和发布沟通预览三列；下层折线图独占整行。最终浏览器测量上层高度约 `270px`、下层约 `602px`，不再为已移除的同步区和账号轮播保留空白行。
- 顶栏没有“同步数据”按钮；两张环图中心总数都保持真实可点击入口。右侧星阵数据助手仍为只读问答区，没有被图表挤压或覆盖。
- 内容数据弹窗首次打开得到 `6` 个账号组，`6/6` 均为关闭状态；用户主动展开后才渲染逐条曝光、播放、赞藏评分享、创作人与链接列，满足默认“按账号折叠”。
- 当前恢复数据中只有 `1` 条真实回传 URL，因此只出现 `1` 个“跳转链接”；链接使用 `target=_blank` 与 `noopener noreferrer`，没有 URL 的内容显示空值，不猜测地址。展开该账号后按钮在桌面窗口内完整可见。
- 从左栏进入真实账号 `#01 老刘来测测` 后，账号工作台顶部保留“数据看板”；点击可返回 `#/overview`，没有改变原 studio 路由和生产链路。

## Video workshop verification

- 运行状态条的头像外框、冗余留白和大块导演侧栏已移除；公开进度区只呈现项目已有事件和制作阶段，不展示隐藏推理。
- 项目从非运行态进入 `running` 时写入同一项目 JSON 的 `runStartedAt`；页面离开只停止前端 interval，不清空起始时间，重新进入继续按服务端时间计算。旧项目缺字段时使用当前成员和项目隔离的本地兜底，终态后清除。
- 恢复目录当前没有仍在运行的项目，且本地未配置真实导演、视频和语音 provider；因此未为视觉验收伪造运行任务，也未触发付费调用。状态布局与续时分别由 Web/Store 定向测试覆盖。

## Validation and findings

- 视频工坊定向测试 `15/15`、工作区 Node 烟测 `67/67`、账号数据与前端身份服务端测试 `12/12` 通过；三个修改 JavaScript 文件语法检查、`store.py` 编译和 `git diff --check` 通过。
- 浏览器验证默认折叠、真实回链、studio 返回、资源身份和页面控制台。服务重启窗口留下两条 `Failed to fetch` 历史 warning；重启完成后的页面导航、展开与返回没有新增 error/warning。
- earlier P2: 首版上层仍占接近半屏，导致趋势图区显得空；已把主网格比例收敛为 `minmax(210px, .62fr) / minmax(260px, 1.38fr)`。最终比较未发现剩余 P0/P1/P2。
- boundary: 没有同步真实数据、生成视频、发布、供应商回传、提交 Git、推送或部署；生产仍是 v141.3。

final result: passed

---

# v141.7 账号数据与剪辑台预览 Design QA

- implementation state: `http://127.0.0.1:8787/?qa=v1417-final#/overview`。
- viewport: `1440×900` CSS px。
- verified layout: 左侧“账号数据”以“数据看板 + 所有账号”两组呈现；右侧顶部合并观看、曝光和互动入口，发布分布饼图与发布趋势位于下方，不再出现账号轮播。内容数据弹窗在桌面端一行容纳平台、时间、账号、创作人和播放量范围，并逐条显示账号、创作人、曝光、播放、赞、藏、评、分享。
- verified interactions: 最低播放量输入 `1000` 后点击“筛选”，当前真实样例从 `6` 个账号收敛为 `2` 个，低播放量内容不再残留。账号左栏保持原 studio 跳转语义；本轮未写交付数据、未调用同步接口。
- editor contract: 监看器增加历史烧录字幕的局部替换遮罩，只保留当前可编辑字幕；播放头、进度条与时间码使用单一 rAF 时钟。最终成片仍由分段源只写一次 ASS 字幕，已用 Web 与字幕渲染定向测试覆盖；没有点击历史项目的提交重渲染。
- boundary: 供应商筛选续存由 scope 化源码契约验证，未借用其他人的供应商登录态；真实刷新体验留给用户本地账号验收。没有生成、发布、回传、提交 Git、推送或部署。

final result: passed

---

# v141.6 剪辑台拖放与音轨 Design QA

- implementation state: `http://127.0.0.1:8787/?qa=v1416-editor-drop-audio-1#/custom/video/05cbfcf2769f`，恢复后的校园规则怪谈历史成片，18 个主轨片段、13 项项目素材。
- viewport: `1280×720` CSS px。
- verified layout: 左侧真实项目素材、中间成片监看器、右侧克制检查器、底部 V2/V1/T/A1/A2/A3 七行标尺；关闭按钮无外框，选中态不再使用刺眼蓝色粗描边。
- verified interactions: 单条字幕块可点击并只显示对应字幕编辑；A1 口播和 A2 BGM 可独立选中并显示各自音量；A3 音效轨与 5 个 Kenney CC0 内置音效可见。剪辑台弹窗在代码和 Web 契约层优先截断文件 drop，明确落到 V1 才替换，否则视觉素材默认画中画、音频默认音效，不再交给聊天附件区。
- boundary: 未点击提交重渲染、发布、试听或生成；浏览器没有向历史项目上传测试文件。真实外部文件拖放留给用户在当前本地页面手动验收。

final result: passed

---

# v141.5 多轨剪辑台 Design QA

- source visual truth: 用户问题截图 `/var/folders/l6/1m22n40x5g1fr2cd39v0jj2h0000gn/T/codex-clipboard-2bcc0b89-af4c-44a1-a45f-98d82ebc21e1.png`（字幕与原生进度条重叠、画中画只能靠参数调整），以及 [OpenReel Video](https://openreel.video/) 的多轨空间关系；实现结构也交叉参考 [OpenCut Classic](https://github.com/OpenCut-app/opencut-classic)。
- implementation state: `http://127.0.0.1:8787/?qa=v1415-editor-5#/custom/video/05cbfcf2769f`，恢复后的校园规则怪谈历史成片，18 个主轨片段、13 项项目素材。
- viewport: `1280×720` CSS px，device scale factor `1`。
- comparison method: 在同一次视觉比较输入中先放用户问题截图、再放 `1280×720` 星阵剪辑台截图，直接核对字幕/进度条、素材区、监看器、检查器和多轨关系；OpenReel 只用于验证编辑器空间结构，不要求复制其品牌样式。

## Full-view comparison evidence

- 参考产品的核心不是某组颜色，而是“素材池 + 监看器 + 属性面板 + 多轨时间线”的空间关系。星阵实现保持现有深色成片工作区视觉，但复刻这四区关系；没有把外部项目整包嵌入，也没有引入第二套导航或品牌语言。
- V2 画中画按实际视觉叠放关系位于 V1 主画面上方，T 字幕、A1 口播与 A2 配乐共享同一时间标尺；V1 显示真实 18 个镜头块及各自时长。六行轨道已收细，播放头、缩放、裁剪手柄、分割、删除、撤销/重做仍在同一操作面上可见。
- 左侧显示当前项目真实图片缩略图，不使用占位图；中间直接预览当前历史成片；右侧只显示当前选中 clip 或 overlay 的属性，非当前字段不会因 CSS 覆盖 `hidden` 而同时露出。
- 监看器不是装饰占位：替换 V1 素材会立即显示真实图片/视频层，加入图片或视频画中画后会在播放到其时间段时同步真实素材帧；画中画可直接拖动、由右下角手柄缩放。当前片段字幕在主画面和画中画之上保持可读，独立进度条位于监看器下方，不再和字幕浮在同一层。边框改为低对比明暗分区，仍保留素材池、监看器、检查器和时间线的清晰关系。
- 页面保持主平台左侧历史会话可见，剪辑台覆盖视频工坊内容区而不破坏首页、其他工作区或主导航布局。

## Interaction verification

1. 从校园规则怪谈成片点击“剪辑台”，owner-scoped 主平台代理成功返回 18 个镜头和 13 项素材；页面加载的是 `20260810-v1416-editor-drop-audio-1`。
2. 点击真实素材的“画中画”后，V2 新增真实素材块；暂停在入场起点时监看器也会立即显示素材。画中画从右上角拖到自定义位置后 `position=custom`，再拖右下角手柄把比例从 `0.32` 调到 `0.48`，监看器尺寸随之变化；相同 DOM 与 FFmpeg 分支同时支持 `video/*` 素材并同步播放头。
3. 把项目素材替换到选中 V1 片段后，真实替换预览层立即出现且片段标记为“已替换”；外部素材使用独立 owner-scoped 上传接口，定向测试确认视频素材只追加到当前项目且不调用导演。
4. 选择 A2 的“不使用 BGM”后，独立配乐轨即时显示“无配乐”；撤销后恢复“原配乐 · BGM2”。T 字幕可按单个片段选择，右侧编辑框写入该片段字幕并由渲染契约传给 ASS，不再把整轨文字绑死。
5. 连续撤销恢复到打开剪辑台时的原状态且撤销禁用；没有点击“提交修改并重渲染”，未触发真实生成、重渲染、发布或 provider 调用。为装载最新 Python 路由而主动重启本地 8787/8765 的窗口内留下 1 条 `Failed to fetch` 历史 warning；重载后等待期间没有新增 error / warning。`1280×720` 下素材池、监看器、检查器和时间线无水平溢出。

## Implementation checklist

- [x] 真实项目素材与成片预览。
- [x] V1/V2/T/A1/A2 多轨与统一标尺。
- [x] 排序、裁剪、播放头分割、删除、撤销/重做。
- [x] 项目/外部素材真实替换，外部图片/视频直接拖到 V1/V2，外部音频拖到 A2。
- [x] 图片和视频画中画实时预览、画布内拖动/缩放、入场/出场基础效果与逐片段基础转场。
- [x] 单条字幕内容编辑，口播与 BGM 分轨及 BGM 替换。
- [x] V2 在 V1 上方、字幕在监看器最上层，且整体减少层层描边。
- [x] owner-scoped 主平台代理和非破坏性版本输出。
- [x] 无第三方源码复制、无新增依赖、无主页面布局回归。

final result: passed

---

# v141.4 声音工作台 Design QA

- source visual truth: `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1414-voice-workbench-before.png`
- implementation screenshots:
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1414-voice-workbench-generate-menu.png`
  - `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1414-voice-workbench-design.png`
- combined comparison: `/Users/macbookpro/.codex/worktrees/052d/codex自动化产品2/自动化产品/output/design-qa/v1414-voice-workbench-comparison.png`
- viewport: `1280×720` CSS px, device scale factor `1`
- state: ACG 管理员使用恢复后的本地会话进入视频工坊；分别验收“语音生成”展开声线菜单和“音色设计”表单。

## Full-view comparison evidence

- 改造前右栏只有“口播声线 / 语音生成”两栏，语音生成依赖口播页先选声线，音色设计入口缺失；改造后声音工具固定为紧凑三栏，入口和内容都保持在同一 `320px` 右侧工作台内。
- “语音生成”拥有独立声线选择器。实测展开后可搜索名称或 voice ID，真实 MiniMax 系统音色按列表展示，每一项包含单独的“试听音色”按钮；没有点击试听或生成，避免产生真实付费调用。
- “音色设计”实测可见音色名称、描述、试听文本和生成试听音色按钮；生成成功后的候选会复用现有音色设计/保存接口，不新增装饰性假数据。
- 恢复后的历史会话在左侧正常可见；右栏、主对话区和底部输入区均未出现水平溢出或被遮挡。

## Required fidelity surfaces

- fonts and typography: 沿用视频工坊现有 Inter / PingFang SC 栈；标题、字段标签、选中项和辅助说明保持既有层级，不引入第二套字体或异常放大。
- spacing and layout rhythm: 右栏内边距压缩为 `16–20px`，主要区块间距收敛为 `10–12px`；三栏 segmented control、输入框和按钮共享同一紧凑节奏。
- colors and tokens: 沿用平台白、浅灰、深灰和浅蓝 focus 语义；活动标签和主按钮使用现有深色，不复用会泄漏蓝色舞台底板的动画容器。
- image quality and assets: 未新增图片资产；平台 Logo 与既有 Lucide 图标继续复用，试听使用现成音频控件和真实 TTS 返回。
- copy and content: “口播声线 / 语音生成 / 音色设计”与实际功能一一对应；声线菜单按收藏、我的设计、团队设计、MiniMax 系统音色组织，当前恢复库没有自定义音色行时只展示真实系统音色。

## Interaction verification

1. 点击“语音生成”，独立声线选择器、口播文本和生成按钮正常出现。
2. 展开生成声线菜单，搜索框、真实音色选项和逐项试听按钮均可访问；菜单在右栏内独立滚动。
3. 点击“音色设计”，完整设计表单出现且生成结果区默认隐藏；未触发真实设计调用。
4. 口播声线的随机/固定策略与语音生成选择分别保存，切换工具不要求用户来回改同一选择器。

## Comparison history

1. Earlier pass: 原生 `select` 与平台不一致，并且搜索结果的 `[hidden]` 会被 grid 样式覆盖；已改为平台自定义菜单并显式隐藏非命中项。
2. Current pass: 语音生成最初复用口播声线选择，且工作台没有音色设计入口；已拆为独立生成声线状态，并复用现有 `/api/tts/voice/design` 与 scope 内 `voicePresets` 保存链路。
3. Final browser pass: 三栏均可切换，生成菜单和设计表单在 `1280×720` 下完整可见，没有剩余 P0 / P1 / P2 可执行问题。

## Implementation checklist

- [x] 紧凑三栏声音工作台。
- [x] 语音生成独立选择声线。
- [x] 自定义声线菜单支持逐项试听。
- [x] 音色设计入口、试听生成和保存链路。
- [x] 收藏优先、我的/团队设计与真实 MiniMax 系统音色分组。
- [x] 恢复数据环境下无水平溢出，未触发真实付费调用。

final result: passed
