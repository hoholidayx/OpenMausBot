# Maus 私聊接入 ComfyImageBridge 异步生图

2026-11-20 已完成三个实施阶段并通过隔离验收。在单所有者部署的 bot 私聊发送「画一张雨夜车站」，Maus 保存请求并显示排队卡。另一台获准设备可以在出图前继续问车次，图片完成后两台设备都能从第一问的原卡下载。ComfyImageBridge 直连、OpenAI 实图、强制重启和桌面窄屏的结果见[验收记录](../verification/async-image-mcp.md)。

部署步骤见[生图设置](../image-generation.md)。下表记录组件分工及早期互通基线，后文记录已交付的权限、任务阶段和恢复规则。[后台任务](../../server/async-image-jobs.ts) · [持久化与额度](../../server/image-job-store.ts) · [MCP 客户端](../../server/image-bridge.ts)

## 系统分工与验证结论

| 项目 | 职责与复用方式 |
| --- | --- |
| ComfyImageBridge | 生图 MCP 服务端。Ubuntu 包提供 Streamable HTTP `/mcp`，保存远端任务、向 ComfyUI 派发工作、跟踪状态并返回结果。服务契约以这个项目为准。[工具契约](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/docs/mcp.md) · [服务入口](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/ubuntu/src/comfy_workflow_api/mcp_server.py) |
| Aion | 已有的 MCP 客户端。可参考它如何受理会话请求、后台跟踪、校验图片和交付给原会话。Maus 可独立运行。[Aion 会话任务](https://github.com/hoholidayx/AionCore/blob/ca864ba7ec790fe58ab0430ac6521a3b2ea78205/crates/aionui-conversation/src/image_jobs.rs) · [客户端协议实现](https://github.com/hoholidayx/AionCore/blob/ca864ba7ec790fe58ab0430ac6521a3b2ea78205/crates/aionui-conversation/src/image_jobs/protocol.rs) |
| Maus | 作为另一个 MCP 客户端直连 Bridge。Maus 负责聊天授权、本地受理、轮次结束后的恢复、原分支定位及附件可见性。现有 HTTP 客户端、消息存储、消息更新事件和附件保存可复用。[MCP 客户端](../../server/mcp-http.ts) · [消息更新](../../server/store.ts) · [附件](../../server/attachments.ts) |

最初的协议互通基线为 Maus `bd335937e`、Bridge `375a3b6`。2026-11-20 按本地 `main` 的代码基线 `5f952f3e9` 复核，同时核对了工作区继续清理旧账号逻辑后的配对和设备权限。期间 Maus 的 MCP HTTP 客户端和同步生图路由均无改动。

- **Maus → Bridge 已互通。** 用 Maus 的 `RemoteMcpClient` 直连回环端口上的真实 Bridge `create_app`、`ImageJobs` 和临时任务库，底层使用 Bridge 自带的 `FakeComfyUI`。发现三个工具，提交得到 `pending`。关闭客户端后重连，用原 UUID 和参数重放，底层 `/prompt` 总共收到一次提交。同号改提示词得到 `request_conflict`，排队时取图得到 `result_not_ready`。放行后查到 `completed`，取回 320 × 256 PNG（2002 字节），任务号、尺寸及 SHA-256 均与夹具相符。[任务夹具](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/ubuntu/tests/test_image_jobs.py)
- **Maus 私聊可在后台工作期间继续。** 隔离服务中，工作搭档被暂停时，同一私聊的第二个问题先得到回答。另两个用例覆盖切换分支后投回原分支、纯附件交付且能进入后续对话。三项定向用例均通过。[私聊异步用例](../../server/work-partner.e2e.test.ts)
- **聊天权限设备可以使用已配置的生图。** 在新版隔离 Maus 配对一台全权限设备和一台仅有 `client` 权限的设备。后者没有所有者 `userId`，修改图片配置返回 403。在可见 bot 的私聊中，它用现有 `generate_image` 成功生成并下载图片，模拟供应商收到一次请求。把同一 bot 改为仅管理员可见后，原附件对聊天设备返回 404，全权限设备仍读到 200。此项验证覆盖同步入口，异步私聊和附件的同类检查已在独立用例通过。[本地身份验证](../verification/local-owner.md) · [生图路由](../../server/routes/image-tools.ts) · [可见性实现](../../server/host/visibility-host.ts)

同步工具 `generate_image` 等待供应商后在原轮次挂载附件。新增的 `generate_image_async` 把一次本地受理、一个远端任务和一张原消息卡关联起来。上述早期 Bridge 基线使用模拟 ComfyUI。实施后的真实 OpenAI 请求由符合相同契约的独立适配器完成。[同步生图路由](../../server/routes/image-tools.ts) · [两条路径的端到端验收](../verification/async-image-mcp.md)

## 单所有者安装中的权限与归属

每个 Maus 安装都有持久的 `environment-id`，`SessionRegistry.userId` 由 `localUserId(environmentId)` 派生。桌面所有者和全权限配对设备共用这个身份，各配对设备的会话可以单独撤销。聊天专用设备和脚本令牌各按签发时的权限范围访问。受理时以本安装当前有效的授权为准，升级前的消息署名只用于展示。[所有者身份](../../server/person-key.ts) · [设备配对与迁移](../../server/sessions.ts) · [部署说明](../self-hosting.md#local-owner-and-paired-devices)

| 操作 | 首版约定 |
| --- | --- |
| 配置 Bridge | 在本安装的图片设置配置一次，由现有设置接口检查管理权限。设备共享这个选择。每个 bot 仍受自己的图片工具组、工具选择和 MCP 连接范围约束。 |
| 发起生图 | 允许本机可信的交互入口、在线的全权限配对设备，以及有权打开该 bot 的聊天设备，从手动私聊发起。受理时校验会话、bot 可见性、实际来源消息及本轮工具权限。脚本令牌即使有管理 scope，也只按其真实渠道识别。群聊、脚本自动调用、代所有者运行的 Bot API、搭档转派、定时任务和 webhook 均在首版手动入口之外。[请求鉴权](../../server/request-auth.ts) · [私聊入口](../../server/routes/bot-messages.ts) · [轮次来源](../../server/peer-provenance.ts) |
| 查看或续聊 | 任务归本安装的原 bot、原线程和原请求。每次访问历史、实时事件或下载附件时沿用当前设备对该 bot 和线程的可见性。另一台有权设备可以继续聊天、查看或重查原卡。设备标签、会话 ID、邮箱或消息署名都不作为持久任务的归属键。[线程与附件可见性](../../server/bot-visibility.ts) |

## 一次请求如何交付

1. **配置连接。** 管理员在「应用 → MCP 服务器」启用本机可访问的 Streamable HTTP 连接，在「设置 → AI → 图片 → 私聊生图」选中它。设置页通过握手和分页 `tools/list` 检查三个生图工具，并保存 `imageGen.asyncMcp` 及连接的 `purpose: "async_image"`。专用连接与注册表内同 URL 的别名都从通用挂载中移除。Bot 继承或显式选择的 `mcpServers`、`toolsOff` 和 `toolScope` 共同决定是否提供本地受理工具。[图片设置](../../src/components/ImageGenerationSettings.tsx) · [连接配置](../../server/config.ts) · [宿主接线](../../server/index.ts)
2. **受理后结束当轮。** 手动私聊可以直接或通过 `use_tool` 调用 `generate_image_async(prompt, size?, image_index?)`。排队的消息保留发起渠道，实际受理时宿主再次核验设备、bot、线程、活动轮次及 `directRequestOwners` 记录的来源消息。以 `(environmentId, botId, threadId, sourceMessageId, image_index)` 去重。单图序号默认为 1，同键同参返回原卡，异参返回冲突。本地事务同时创建任务和原卡并预占额度，随即返回受理回执。[工具目录](../../server/drivers/agents-catalog.ts) · [受理逻辑](../../server/async-image-jobs.ts) · [消息库](../../server/message-db.ts)
3. **后台调用 Bridge。** Maus 为每张图生成一次小写标准 UUID，持久化为 `jobId`，同时用作远端 `request_id`。worker 按下表提交和轮询。用户关闭网页、切换会话或停止下一轮对话，已受理的生图继续。聊天的停止按钮只结束当前聊天轮次，Bridge 此版本提供的三项工具均无取消语义。[到期任务调度](../../server/due-timer.ts)
4. **按卡片交付。** 出图后按原 `threadId` 和 `cardMessageId` 更新附件，以 `replyToId` 引用原请求。前端复用附件预览和下载，推送 `message.patch`，断线重连时从历史补读。用户正在另一条分支或下一轮已开始也按原卡更新。交付本身需要的额外模型调用为零。首版做私聊文生图，参考图编辑和群聊可另行扩展。[聊天渲染](../../src/components/ChatView.tsx) · [消息补丁](../../src/state/store.tsx) · [原分支交付先例](../verification/async-bot-partner.md)

### Bridge 的现有工具契约

| 工具 | Maus 发送 | Maus 处理 |
| --- | --- | --- |
| `image_submit` | 原 `request_id`、`prompt`，可选 `size`。首版沿用 Bridge 默认 `preset=fast`。Maus 在 `auto` 时省略尺寸，ComfyImageBridge 当前默认 1024 × 1024，也可传支持的比例或每边为 32 的倍数、64–2048 的 `宽x高`。 | 在 `structuredContent` 检查 `task_id == request_id` 和 `state`。同号同参可重放。同号异参是 `request_conflict`。`queue_full` 和 `backend_unavailable` 是可识别的受理错误。 |
| `image_status` | 原 `task_id` | `pending`、`submitting`、`queued`、`running` 继续跟踪，`completed` 触发取图。`failed` 在原卡显示安全错误原因，`expired` 标记过期。`submission_uncertain` 显示「结果待确认」，继续用原号查证。 |
| `image_result` | 原 `task_id` | 成功返回一个 `ImageContent`，类型为 `image/png`。读取 `structuredContent.task_id/width/height/sha256/seed_used`，seed 保留十进制字符串。核验任务号、PNG 字节、实际尺寸、SHA-256 和 Maus 的 10 MiB 限额，再保存附件。`result_not_ready` 回到查状态，`result_expired` 结束取图。 |

三项调用都先检查 `isError`，业务错误从 `structuredContent.error_code` 读取。Bridge 按 `retention.max_tasks` 保留已结束任务的结果。过期后保留请求 ID 防止重提，Maus 查到完成即调度取图，成功交付后从本地附件存储读取。[Bridge 任务存储与保留实现](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/ubuntu/src/comfy_workflow_api/image_jobs.py) · [Maus 有界解码](../../server/generated-image.ts)

## 持久化与故障恢复

任务记录保存上述唯一键、原轮次、远端请求 UUID、独立的本地附件 UUID、卡片 ID、连接注册名及配置指纹、规范化参数与摘要、阶段、下次查询时间和额度归属日。发起设备的会话只用于受理时核验资格，授权所用的令牌留在现有会话机制内。受理提交后由宿主履行任务，后台凭持久归属和当前 bot 设置执行。事务提交后再广播和唤醒 worker，重启时扫描本安装的到期记录，按阶段认领并回收过期认领。

| Maus 阶段 | 恢复规则 |
| --- | --- |
| `queued` 本地已受理 | 复核权限与原卡存在，先将阶段持久化为 `submitting`，再发网络请求。已知 Bridge 队列满时用原号有限退避，卡片显示正在等候。 |
| `submitting` 回执未知 | 先向已绑定的 Bridge 查原 UUID。查到任务即接续。只有此阶段查得 `task_not_found` 才自动用原号原参重放。远端已确认过接单的任务只会继续查询。连接被替换、停用或原私聊授权被收回时，结束本地交付并在原卡显示原因。 |
| `polling` 跟踪远端 | 正常每 2 秒查询一次原号。远端状态不确定或通信失败时以 5–60 秒退避，持续 20 分钟后暂停自动查询。用户可在原卡点「重新查询」继续跟踪同一任务。 |
| `fetching` 已完成待交付 | 校验 PNG 后先持久化摘要，再按独立的 `attachmentId` 幂等落盘并关联原卡。重启或手动重查时，先尝试从已校验的本地副本补交，副本可用时即使远端已经过期也能完成。已知远端过期且没有本地副本时在原卡显示原因。 |
| `done / failed / review` | 原卡分别保留附件、安全错误或重新查询入口。暂停人工查证时保留任务号和已有摘要，清除生成提示词。 |

宿主最多同时执行两次 MCP 操作。落盘待交付、以及已记录摘要且暂停查证的文件都受附件清理保护。发布后以当前可见的消息引用授权下载。原卡不可见时，有权设备仍可从保留了这张图的分支下载。[幂等保存附件](../../server/attachments.ts) · [文件保留与可见性](../../server/image-job-store.ts)

- **设备撤销与功能停用。** 本地受理事务决定后续交付责任。受理前发起会话已被撤销则拒绝。受理后关闭页面或换设备，任务仍归原线程。此后撤销发起设备会收回它的后续访问，其他获准设备仍可接收结果。派发和发布时复核原 bot、线程、来源消息、卡及生图授权。原目标被删、bot 的生图权限撤回或专用连接被替换时，停止后续派发或发布，并按已知远端状态结算。已经发给 Bridge 的请求不能保证远端取消。单纯调整 bot 的可见范围时，结果仍归原卡，事件、历史和附件均按最新可见范围提供。
- **分叉与还原。** 切换分支按原卡 ID 更新。跨线程分叉可复制已交付图片的历史，待交付卡仅归原线程。工作区备份会携带消息数据库，恢复时保留目的安装的 `environment-id` 和设备会话。普通重启可以同号接续。快照恢复后先比对来源安装、bot、原卡及连接。异安装导入仅展示已有历史和本地附件，冻结未完成任务且不联系原 Bridge。[线程分叉](../../server/store-forks.ts) · [备份恢复](../../server/workspace-backup.ts)

每轮上限由设置控制。安装每日共用 50 张额度，按本地受理日记账，包含同步与异步生图。首次使用新账本时承接原先保存的当日用量。异步任务确定未出图时释放预占，已生成但未交付、回复丢失或远端失败原因未知时保留预占。查证和重复交付沿用原记录。卡片通过本地化文字及 `role="status"` 表达阶段。[每日额度](../../server/image-daily-cap.ts) · [额度账本](../../server/image-job-store.ts) · [生图设置](../image-generation.md)

## 实施顺序与验收

| 阶段 | 交付与通过条件 |
| --- | --- |
| 1 · 私聊可续聊 | 隔离 Maus 使用模拟聊天引擎、真实 Bridge 和可暂停的模拟 ComfyUI。设备 A 提交图片后关闭页面。暂停出图期间，设备 B 在同一私聊发第二问并得到答案。放行后 B 看到图片，A 重连后也在第一问下看到同一张卡，下载 PNG 一致，交付未触发额外模型轮次。 |
| 2 · 重启与去重 | 分别在受理后、远端接单但回执丢失、文件落盘但卡片未更新时重启。每案断言一次底层 `/prompt`、一个附件、一张原卡、一次额度结算。覆盖同键异参、多图乱序、跨设备与跨 bot 共用日限额、跨午夜及额度用尽。把备份恢复到另一安装，确认已交付图可读、在途任务对 Bridge 的调用数为零。 |
| 3 · 设备、分支与异常 | 仅有 `client` 权限的设备可在可见 bot 私聊手动发起，修改设置返回 403，bot 改为仅管理员可见后，事件流、历史及附件均按新范围过滤。分别在受理前后撤销设备 A，验证拒绝新请求及已受理任务对设备 B 的交付。覆盖脚本、Bot API、群聊和转派入口，切分支、删来源、停用生图及换连接。模拟队列满、待确认转完成、结果过期及摘要错误。桌面与窄屏验收预览、下载和键盘操作，回归同步生图与头像入口。 |

在本仓库可用以下命令复跑身份与宿主异步基线。图片专用端到端用例、浏览器复验命令及真实图片摘要见[生图验收](../verification/async-image-mcp.md)。端到端用例各自启动隔离 Maus。[隔离验证入口](../verification/README.md)

```sh
pnpm exec vitest run server/local-identity.e2e.test.ts server/sessions.test.ts server/person-key.test.ts
pnpm exec vitest run server/work-partner.e2e.test.ts -t 'continues the original chat while a bound worker runs|delivers a requested relay to its original branch|delivers an attachment-only result'
```
