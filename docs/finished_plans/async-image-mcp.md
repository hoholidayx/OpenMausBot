# Maus 私聊接入 ComfyImageBridge 异步生图

2026-11-20 已完成三个实施阶段并通过隔离验收。在单所有者部署的 bot 私聊发送「画一张雨夜车站」，Maus 保存请求并显示排队卡。另一台获准设备可以在出图前继续问车次，图片完成后两台设备都能从第一问的原卡下载。ComfyImageBridge 直连、OpenAI 实图、强制重启和桌面窄屏的结果见[验收记录](../verification/async-image-mcp.md)。

上线所需配置见[生图设置](../image-generation.md)。实现由[后台任务](../../server/async-image-jobs.ts)、[持久化与额度](../../server/image-job-store.ts)及 [MCP 客户端](../../server/image-bridge.ts)负责。下文保留实施前的技术基线和设计约定，验收记录描述实际采用的路径。

## 系统分工与验证结论

| 项目 | 职责与复用方式 |
| --- | --- |
| ComfyImageBridge | 生图 MCP 服务端。Ubuntu 包提供 Streamable HTTP `/mcp`，保存远端任务、向 ComfyUI 派发工作、跟踪状态并返回结果。服务契约以这个项目为准。[工具契约](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/docs/mcp.md) · [服务入口](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/ubuntu/src/comfy_workflow_api/mcp_server.py) |
| Aion | 已有的 MCP 客户端。可参考它如何受理会话请求、后台跟踪、校验图片和交付给原会话。Maus 可独立运行。[Aion 会话任务](https://github.com/hoholidayx/AionCore/blob/ca864ba7ec790fe58ab0430ac6521a3b2ea78205/crates/aionui-conversation/src/image_jobs.rs) · [客户端协议实现](https://github.com/hoholidayx/AionCore/blob/ca864ba7ec790fe58ab0430ac6521a3b2ea78205/crates/aionui-conversation/src/image_jobs/protocol.rs) |
| Maus | 作为另一个 MCP 客户端直连 Bridge。Maus 负责聊天授权、本地受理、轮次结束后的恢复、原分支定位及附件可见性。现有 HTTP 客户端、消息存储、消息更新事件和附件保存可复用。[MCP 客户端](../../server/mcp-http.ts) · [消息更新](../../server/store.ts) · [附件](../../server/attachments.ts) |

最初的协议互通基线为 Maus `bd335937e`、Bridge `375a3b6`。2026-11-20 按本地 `main` 的代码基线 `5f952f3e9` 复核，同时核对了工作区继续清理旧账号逻辑后的配对和设备权限。期间 Maus 的 MCP HTTP 客户端和同步生图路由均无改动。

- **Maus → Bridge 已互通。** 用 Maus 的 `RemoteMcpClient` 直连回环端口上的真实 Bridge `create_app`、`ImageJobs` 和临时任务库，底层使用 Bridge 自带的 `FakeComfyUI`。发现三个工具，提交得到 `pending`。关闭客户端后重连，用原 UUID 和参数重放，底层 `/prompt` 总共收到一次提交。同号改提示词得到 `request_conflict`，排队时取图得到 `result_not_ready`。放行后查到 `completed`，取回 320 × 256 PNG（2002 字节），任务号、尺寸及 SHA-256 均与夹具相符。[任务夹具](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/ubuntu/tests/test_image_jobs.py)
- **Maus 私聊可在后台工作期间继续。** 隔离服务中，工作搭档被暂停时，同一私聊的第二个问题先得到回答。另两个用例覆盖切换分支后投回原分支、纯附件交付且能进入后续对话。三项定向用例均通过。[私聊异步用例](../../server/work-partner.e2e.test.ts)
- **聊天权限设备可以使用已配置的生图。** 在新版隔离 Maus 配对一台全权限设备和一台仅有 `client` 权限的设备。后者没有所有者 `userId`，修改图片配置返回 403。在可见 bot 的私聊中，它用现有 `generate_image` 成功生成并下载图片，模拟供应商收到一次请求。把同一 bot 改为仅管理员可见后，原附件对聊天设备返回 404，全权限设备仍读到 200。此项验证覆盖现有同步入口，异步入口应保留这套行为。[本地身份验证](../verification/local-owner.md) · [生图路由](../../server/routes/image-tools.ts) · [可见性实现](../../server/host/visibility-host.ts)

同步工具 `generate_image` 等待供应商后在原轮次挂载附件。新增的 `generate_image_async` 把一次本地受理、一个远端任务和一张原消息卡关联起来。上述早期 Bridge 基线使用模拟 ComfyUI。实施后的真实 OpenAI 请求由符合相同契约的独立适配器完成。[同步生图路由](../../server/routes/image-tools.ts) · [两条路径的端到端验收](../verification/async-image-mcp.md)

## 单所有者安装中的权限与归属

每个 Maus 安装都有持久的 `environment-id`，`SessionRegistry.userId` 由 `localUserId(environmentId)` 派生。桌面所有者和全权限配对设备共用这个身份，各配对设备的会话可以单独撤销。聊天专用设备和脚本令牌各按签发时的权限范围访问。受理时以本安装当前有效的授权为准，升级前的消息署名只用于展示。[所有者身份](../../server/person-key.ts) · [设备配对与迁移](../../server/sessions.ts) · [部署说明](../self-hosting.md#local-owner-and-paired-devices)

| 操作 | 首版约定 |
| --- | --- |
| 配置 Bridge | 在本安装的图片设置配置一次，由现有设置接口检查管理权限。设备共享这个选择。每个 bot 仍受自己的图片工具组、工具选择和 MCP 连接范围约束。 |
| 发起生图 | 允许本机可信的交互入口、在线的全权限配对设备，以及有权打开该 bot 的聊天设备，从手动私聊发起。受理时校验会话、bot 可见性、实际来源消息及本轮工具权限。脚本令牌即使有管理 scope，也只按其真实渠道识别。群聊、脚本自动调用、代所有者运行的 Bot API、搭档转派、定时任务和 webhook 均在首版手动入口之外。[请求鉴权](../../server/request-auth.ts) · [私聊入口](../../server/routes/bot-messages.ts) · [轮次来源](../../server/peer-provenance.ts) |
| 查看或续聊 | 任务归本安装的原 bot、原线程和原请求。每次访问历史、实时事件或下载附件时沿用当前设备对该 bot 和线程的可见性。另一台有权设备可以继续聊天、查看或重查原卡。设备标签、会话 ID、邮箱或消息署名都不作为持久任务的归属键。[线程与附件可见性](../../server/bot-visibility.ts) |

## 一次请求如何交付

1. **配置连接。** 在图片设置增加「异步 MCP」及专用连接名。复用注册表中由 Maus 宿主访问的 Streamable HTTP 连接，保留启停、连接限定的 bot 及 bot 的 `mcpServers` 选择语义（省略为继承，显式空列表为全部关闭）。当前工具目录及设置页使用的工具组可用性都取自同步供应商的 `imageGenerationReady(cfg)`，需增加 Bridge 就绪判断。异步入口遵守 `toolsOff` 的 `images` 组和 `toolScope`，切换方式时保留 bot 已显式禁用生图的选择。用途标记和通用挂载过滤需新增，使模型只见本地受理工具，已预热的引擎会话也应用此过滤。连接测试只握手和 `tools/list`。Bridge 在可信内网提供 HTTP，持任务号即可取图，远端调用集中在 Maus 宿主。[图片设置](../../src/components/ImageGenerationSettings.tsx) · [连接配置](../../server/config.ts) · [工具组](../../server/drivers/agents-tool-groups.ts) · [宿主接线](../../server/index.ts)
2. **受理后结束当轮。** 建议异步模式向模型提供 `generate_image_async(prompt, size?, image_index?)`。直接调用和 `use_tool` 共用处理器。宿主接收私聊消息时记录发起渠道，消息排队时保留这条记录。执行工具时核对活动轮次授权的 bot、线程和 generation，并从 `directRequestOwners` 取本轮来源消息 ID。已有同步入口的 `personTurn` 也接受部分群聊，单独检查它不足以识别首版私聊。以 `(environmentId, botId, threadId, sourceMessageId, image_index)` 去重。单图序号默认为 1，多图按每轮上限拆分。同键同参返回原卡，异参返回冲突。在 `messages.db` 一次事务内创建任务、原分支卡片并预占额度。提交成功即返回本地卡片回执，模型可以完成当轮回复。[工具目录](../../server/drivers/agents-catalog.ts) · [调用上下文](../../server/drivers/agents-call.ts) · [消息库](../../server/message-db.ts)
3. **后台调用 Bridge。** Maus 为每张图生成一次小写标准 UUID，持久化为 `jobId`，同时用作远端 `request_id`。worker 按下表提交和轮询。用户关闭网页、切换会话或停止下一轮对话，已受理的生图继续。聊天的停止按钮只结束当前聊天轮次，Bridge 此版本提供的三项工具均无取消语义。[到期任务调度](../../server/due-timer.ts)
4. **按卡片交付。** 出图后按原 `threadId` 和 `cardMessageId` 更新附件，以 `replyToId` 引用原请求。前端复用附件预览和下载，推送 `message.patch`，断线重连时从历史补读。用户正在另一条分支或下一轮已开始也按原卡更新。交付本身需要的额外模型调用为零。首版做私聊文生图，参考图编辑和群聊可另行扩展。[聊天渲染](../../src/components/ChatView.tsx) · [消息补丁](../../src/state/store.tsx) · [原分支交付先例](../verification/async-bot-partner.md)

### Bridge 的现有工具契约

| 工具 | Maus 发送 | Maus 处理 |
| --- | --- | --- |
| `image_submit` | 原 `request_id`、`prompt`，可选 `size`。首版沿用 Bridge 默认 `preset=fast`。文生图 `auto` 为 1024 × 1024，也可传支持的比例或每边为 32 的倍数、64–2048 的 `宽x高`。 | 在 `structuredContent` 检查 `task_id == request_id` 和 `state`。同号同参可重放。同号异参是 `request_conflict`。`queue_full` 和 `backend_unavailable` 是可识别的受理错误。 |
| `image_status` | 原 `task_id` | `pending`、`submitting`、`queued`、`running` 继续跟踪，`completed` 触发取图。`failed` 在原卡显示安全错误原因，`expired` 标记过期。`submission_uncertain` 显示「结果待确认」，继续用原号查证。 |
| `image_result` | 原 `task_id` | 成功返回一个 `ImageContent`，类型为 `image/png`。读取 `structuredContent.task_id/width/height/sha256/seed_used`，seed 保留十进制字符串。核验任务号、PNG 字节、实际尺寸、SHA-256 和 Maus 的 10 MiB 限额，再保存附件。`result_not_ready` 回到查状态，`result_expired` 结束取图。 |

三项调用都先检查 `isError`，业务错误从 `structuredContent.error_code` 读取。Bridge 按 `retention.max_tasks` 保留已结束任务的结果。过期后保留请求 ID 防止重提，Maus 应在查到完成后尽快取图，成功交付后从本地附件存储读取。[Bridge 任务存储与保留实现](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/ubuntu/src/comfy_workflow_api/image_jobs.py) · [Maus 有界解码](../../server/generated-image.ts)

## 持久化与故障恢复

任务记录保存上述唯一键、原轮次、远端请求 UUID、独立的本地附件 UUID、卡片 ID、连接注册名及配置指纹、规范化参数与摘要、阶段、下次查询时间和额度归属日。发起设备的会话只用于受理时核验资格，授权所用的令牌留在现有会话机制内。受理提交后由宿主履行任务，后台凭持久归属和当前 bot 设置执行。事务提交后再广播和唤醒 worker，重启时扫描本安装的到期记录，按阶段认领并回收过期认领。

| Maus 阶段 | 恢复规则 |
| --- | --- |
| `queued` 本地已受理 | 复核权限与原卡存在，先将阶段持久化为 `submitting`，再发网络请求。已知 Bridge 队列满时用原号有限退避，卡片显示正在等候。 |
| `submitting` 回执未知 | 先向已绑定的 Bridge 查原 UUID。查到任务即接续。首次提交回执丢失、原连接配置一致且返回 `task_not_found` 时可原号原参重放。已有远端回执后任务消失、连接被替换或怀疑任务库已重置时，转入待确认。 |
| `polling` 跟踪远端 | 只查询原号。网络故障逐步退避。Bridge 自行在其 `wait_timeout` 内查证 `submission_uncertain`，Maus 保留卡片并允许恢复查询。约定本地重试预算后可暂停自动查证，用户点「重新查询」时传本地卡片 ID，由宿主检查可见性并查原远端任务号。 |
| `fetching` 已完成待交付 | 以本地 `attachmentId` 调用 `saveImage(bytes, "image/png", attachmentId)`，幂等写入并用事务关联原卡、结算额度。该函数用传入的 UUID 命名文件，独立附件 ID 可避免下载路径暴露 Bridge 任务号。若落盘后崩溃，重启先用已记录的摘要校验文件，再补交。临时磁盘故障重试，永久超限、摘要错误或无本地副本且远端结果过期时在原卡提示原因。 |
| `done / failed / needs_review` | 成功保留附件引用，确定失败保留安全原因，待确认保留原号。用户明确发起新图时才生成新 UUID。 |

建议首版最多同时执行两次 MCP 调用，活动任务初始每 2 秒查一次，通信异常按 5 至 60 秒退避。取图时先记录摘要，交付中保留附件以免被清理，终态清除请求正文。下载只向有可见消息引用的设备开放。为异步产物增加待交付检查，文件与原卡关联提交前不对外提供，避免把既有附件路径对无引用上传的处理套到生成图上。[幂等保存附件](../../server/attachments.ts) · [附件可见性](../../server/bot-visibility.ts)

- **设备撤销与功能停用。** 建议以本地事务提交为界。受理前发起会话已被撤销则拒绝。受理后关闭页面或换设备，任务仍归原线程。此后撤销发起设备会收回它的后续访问，其他获准设备仍可接收结果。派发和发布时复核原 bot、线程、来源消息、卡及生图授权。原目标被删、bot 的生图权限撤回或专用连接被替换时，停止后续派发或发布，并按已知远端状态结算。已经发给 Bridge 的请求不能保证远端取消。单纯调整 bot 的可见范围时，结果仍归原卡，事件、历史和附件均按最新可见范围提供。
- **分叉与还原。** 切换分支按原卡 ID 更新。跨线程分叉可复制已交付图片的历史，待交付卡仅归原线程。工作区备份会携带消息数据库，恢复时保留目的安装的 `environment-id` 和设备会话。普通重启可以同号接续。快照恢复后先比对来源安装、bot、原卡及连接。异安装导入仅展示已有历史和本地附件，冻结未完成任务且不联系原 Bridge。[线程分叉](../../server/store-forks.ts) · [备份恢复](../../server/workspace-backup.ts)

额度沿用 Maus 每轮限制及**整个安装每日 50 张**。所有设备与 bot 共用每日账本。将同步、异步入口的在途预占纳入同一持久账本，迁移当天原计数。按受理日和任务唯一键结算一次，明确未出图时释放。已生成但交付失败或仍在查证时保留用量。卡片通过本地化文字及 `role="status"` 表达阶段，模型上下文只需简短状态与附件引用。[每日额度](../../server/image-daily-cap.ts) · [现有生图设置](../image-generation.md) · [界面规范](../../DESIGN.md)

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
