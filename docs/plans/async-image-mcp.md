# Maus 私聊接入 ComfyImageBridge 异步生图

状态为待实施。首版面向用户主动发起的 bot 私聊。用户发「画一张雨夜车站」，Maus 持久保存请求并立即回「图片已排队」。生成期间用户可以在同一私聊问车次，图片完成后更新第一条请求下的卡片。

## 系统分工与验证结论

| 项目 | 职责与复用方式 |
| --- | --- |
| ComfyImageBridge | 生图 MCP 服务端。Ubuntu 包提供 Streamable HTTP `/mcp`，保存远端任务、向 ComfyUI 派发工作、跟踪状态并返回结果。服务契约以这个项目为准。[工具契约](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/docs/mcp.md) · [服务入口](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/ubuntu/src/comfy_workflow_api/mcp_server.py) |
| Aion | 已有的 MCP 客户端。可参考它如何受理会话请求、后台跟踪、校验图片和交付给原会话。Maus 可独立运行。[Aion 会话任务](https://github.com/hoholidayx/AionCore/blob/ca864ba7ec790fe58ab0430ac6521a3b2ea78205/crates/aionui-conversation/src/image_jobs.rs) · [客户端协议实现](https://github.com/hoholidayx/AionCore/blob/ca864ba7ec790fe58ab0430ac6521a3b2ea78205/crates/aionui-conversation/src/image_jobs/protocol.rs) |
| Maus | 作为另一个 MCP 客户端直连 Bridge。Maus 负责聊天授权、本地受理、轮次结束后的恢复、原分支定位及附件可见性。现有 HTTP 客户端、消息存储、消息更新事件和附件保存可复用。[MCP 客户端](../../server/mcp-http.ts) · [消息更新](../../server/store.ts) · [附件](../../server/attachments.ts) |

2026-11-20，分别验证了以下两段。Maus 代码基线为 `bd335937e`，Bridge 为 `375a3b6`。

- **Maus → Bridge 已互通。** 用 Maus 的 `RemoteMcpClient` 直连回环端口上的真实 Bridge `create_app`、`ImageJobs` 和临时任务库，底层使用 Bridge 自带的 `FakeComfyUI`。发现三个工具，提交得到 `pending`。关闭客户端后重连，用原 UUID 和参数重放，底层 `/prompt` 总共收到一次提交。同号改提示词得到 `request_conflict`，排队时取图得到 `result_not_ready`。放行后查到 `completed`，取回 320 × 256 PNG（2002 字节），任务号、尺寸及 SHA-256 均与夹具相符。[任务夹具](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/ubuntu/tests/test_image_jobs.py)
- **Maus 私聊可在后台工作期间继续。** 隔离服务中，工作搭档被暂停时，同一私聊的第二个问题先得到回答。另两个用例覆盖切换分支后投回原分支、纯附件交付且能进入后续对话。三项定向用例均通过。[私聊异步用例](../../server/work-partner.e2e.test.ts)

现有 `generate_image` 仍会等图片生成，并要求原轮次保持活动才能挂载附件。需要新增的是把**一次本地受理、一个 Bridge 任务、一张原消息卡**连起来的 Maus 客户端流程。完整私聊生图以阶段 1 的端到端用例验收。本次 Bridge 互通未使用真实 GPU。此前 3 × 2 PNG 的测试连接的是另一个服务 `aion-openai-image-mcp`，上面的 Bridge 结论来自单独的直连测试。[现有生图路由](../../server/routes/image-tools.ts)

## 一次请求如何交付

1. **配置连接。** 在图片设置里选择「异步 MCP」和一个 Maus 宿主可达的 Bridge 连接。复用 MCP 注册表和 bot 授权，将该连接标为生图专用，从通用工具透传和已预热的引擎会话中排除。连接测试只握手和 `tools/list`，检查以下三项及输入 schema。Bridge 默认部署在可信内网，端点使用 HTTP、无凭据，持任务号即可取图。由 Maus 宿主访问该连接，网页通过既有消息与附件授权读取结果。[图片设置](../../src/components/ImageGenerationSettings.tsx) · [注册表](../../server/mcp-registry.ts) · [按 bot 解析连接](../../server/host/mcp-servers-host.ts)
2. **受理后结束当轮。** 建议异步模式仅向模型提供 `generate_image_async(prompt, size?, image_index?)`。直接调用和 `use_tool` 共用处理器。Maus 从已授权轮次解析 bot、所有者、线程和来源消息，以 `(threadId, botId, sourceMessageId, image_index)` 去重。单图默认序号 1，批量请求按每轮上限拆为每图一项。同键同参返回原卡，异参返回冲突。在 `messages.db` 一次事务内创建任务、原分支卡片并预占额度。提交成功即向模型返回本地受理回执，模型可以完成当轮回复。后续问答按普通私聊调度。[工具目录](../../server/drivers/agents-catalog.ts) · [调用上下文](../../server/drivers/agents-call.ts) · [消息库](../../server/message-db.ts)
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

任务记录保存本地唯一键、UUID、来源用户/轮次、卡片 ID、连接注册名及配置指纹、规范化参数与摘要、阶段、下次查询时间和额度归属日。轮次标识用于追溯，后台授权按任务归属检查。事务提交后再广播和唤醒 worker，重启时扫描到期记录，按阶段条件认领并回收过期认领。

| Maus 阶段 | 恢复规则 |
| --- | --- |
| `queued` 本地已受理 | 复核权限与原卡存在，先将阶段持久化为 `submitting`，再发网络请求。已知 Bridge 队列满时用原号有限退避，卡片显示正在等候。 |
| `submitting` 回执未知 | 先向已绑定的 Bridge 查原 UUID。查到任务即接续。首次提交回执丢失、原连接配置一致且返回 `task_not_found` 时可原号原参重放。已有远端回执后任务消失、连接被替换或怀疑任务库已重置时，转入待确认。 |
| `polling` 跟踪远端 | 只查询原号。网络故障逐步退避。Bridge 自行在其 `wait_timeout` 内查证 `submission_uncertain`，Maus 保留卡片并允许恢复查询。约定本地重试预算后可暂停自动查证，用户点「重新查询」仍查原号。 |
| `fetching` 已完成待交付 | 以 `saveImage(bytes, "image/png", jobId)` 幂等写附件，用事务补齐原卡和额度结算。若附件落盘后崩溃，重启先按已记录的摘要校验本地文件，再补交。临时磁盘故障重试，永久超限、摘要错误或无本地副本且远端结果过期时在原卡提示原因。 |
| `done / failed / needs_review` | 成功保留附件引用，确定失败保留安全原因，待确认保留原号。用户明确发起新图时才生成新 UUID。 |

建议首版最多同时执行两次 MCP 调用，活动任务初始每 2 秒查一次，通信异常按 5 至 60 秒退避。这些是 Maus 可调整的参数。取图时先记录结果摘要，交付中保留附件以免被清理，终态清除请求正文。首次受理和实际派发分别核验权限，派发后绑定原连接。交付前按原会话、来源消息、卡片和当前受众复核，删除来源或撤权则停止交付。跨线程分叉及跨工作区备份恢复时，运行中的任务只归原目标所有。[幂等保存附件](../../server/attachments.ts) · [线程分叉](../../server/store-forks.ts)

额度沿用 Maus 每轮限制及每日 50 张。将同步、异步入口的在途预占纳入同一持久账本，迁移当天原计数。按受理日和任务唯一键结算一次，明确未出图时释放。已生成但交付失败或仍在查证时保留用量。卡片通过本地化文字及 `role="status"` 表达阶段，模型上下文只需简短状态与附件引用。[每日额度](../../server/image-daily-cap.ts) · [现有生图设置](../image-generation.md) · [界面规范](../../DESIGN.md)

## 实施顺序与验收

| 阶段 | 交付与通过条件 |
| --- | --- |
| 1 · 私聊可续聊 | 接通专用连接、受理事务、worker 和原卡。隔离 Maus 使用模拟聊天引擎，连接真实 Bridge 和可暂停的模拟 ComfyUI。先提交图片，暂停出图，确认同一私聊第二问已得到答案。放行后，第一问的卡片出现可下载的正确 PNG，第二问保持原样，模型调用记录显示交付未触发额外轮次。 |
| 2 · 重启与去重 | 分别在本地受理后、远端接单但回执丢失、文件落盘但卡片未更新时重启隔离 Maus。每案断言一次底层 `/prompt`、一个附件、一张原卡、一次额度结算。覆盖同键异参、多图乱序、跨午夜与额度用尽。 |
| 3 · 分支、权限与异常 | 切分支、换会话、断网重连、删来源、撤权、换连接，逐项核对原卡及附件可见性。模拟 Bridge 队列满、待确认转完成、结果过期和摘要不符。桌面与窄屏验收续聊、预览、下载及键盘操作，并回归同步生图与头像入口。 |

在本仓库可用以下命令复跑现有宿主异步基线，测试会启动隔离 Maus。阶段 1 需另加上述图片专用端到端用例。[隔离验证入口](../verification/README.md) · [聊天 UI 验证](../verification/chat-ui.md)

```sh
pnpm exec vitest run server/work-partner.e2e.test.ts -t 'continues the original chat while a bound worker runs|delivers a requested relay to its original branch|delivers an attachment-only result'
```
