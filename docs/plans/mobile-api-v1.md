# Maus 移动端 API v1 设计

第一版的调用方是 Novia 的 Swift 数据层。用 iOS 测试进程与隔离 Maus 验证配对、私聊读写、消息一致性与 SSE 恢复。以后接入原生半屏和完整网页时，两者消费同一条真实私聊。每轮的客户端交付、测试入口与通过条件见同工作区的[跨仓迭代计划](../../../docs/ios-mobile-api-iterations.md)。

**前两轮已交付设备身份、可见伙伴和指定私聊读写。** 自托管 Maus 在原进程和端口提供版本声明及 `GET /api/mobile/v1/bootstrap`。Swift 通过已有历史、发送和队列接口完成分页与对账，后续验证 SSE 订阅与恢复。[v1 类型](../../packages/phone-protocol/src/mobile-v1.ts) · [隔离契约测试](../../server/mobile-api-v1.test.ts)

## 现有服务端已经提供什么

| 入口 | 目前的维护位置 | 对移动端的影响 |
| --- | --- | --- |
| 自托管服务 | [HTTP 入口](../../server/index.ts)、[会话与作用域](../../server/request-auth.ts)、[配对注册表](../../server/sessions.ts) | `/api/auth/pair` 支持 Cookie，`/api/pair` 返回官方手机使用的 token/device 结构。两者在自托管服务上复用同一个配对码兑换逻辑。现有 WKWebView 方案可以一次配对，两端使用同一个会话。 |
| 桌面 companion 和 relay | [手机路由白名单](../../companion/src/routes.ts)、[代理与过滤](../../companion/src/proxy.ts)、[两种部署的 relay](../phone-relay-server.md) | 桌面 sidecar 持有自己的设备 token，按方法和路径放行并过滤 JSON/SSE。自托管 relay 将流交给自托管服务处理。接入 Novia v1 无需扩大 sidecar 白名单或增设 relay。 |
| 对话与事件 | [助手及历史](../../server/routes/threads.ts)、[发送入口](../../server/routes/bot-messages.ts)、[直接发送回执](../../server/direct-send.ts)、[事件缓冲](../../server/host/sse-replay.ts) | 已处理线程归属、受理或排队、重复发送、实时事件与补读。fork 的 Dots 收件、记忆和异步生图还依赖这个发送入口传递的设备上下文。 |
| 跨客户端协议 | [手机响应](../../packages/phone-protocol/src/responses.ts)、[消息和事件](../../packages/phone-protocol/src/wire.ts)、[按提交同步的脚本](../../scripts/sync-phone-protocol.mjs) | 已有服务端与手机客户端共用的 TypeScript 包。缺的是按移动端用例定义的操作清单、首屏摘要，以及能让 Swift 独立验证的样例。 |

另有对外集成的 Bot API。它用每个 bot 的专用密钥，只能续接由该 API 开启的线程。Novia 要延续用户在网页里的私聊，应使用设备会话。[Bot API 契约](../bot-api.md)

## 首版操作与 HTTP 映射

| 手机操作 | HTTP 入口 | 契约承诺 |
| --- | --- | --- |
| 配对、恢复、退出 | 现有 `POST /api/auth/pair`、`GET /api/auth/session`、`POST /api/auth/logout` | 用户从自托管实例获取受限配对码。兑换使用 `{code, label, attemptId, cookie: true}`，重试沿用同一 attemptId。此模式在 `Set-Cookie` 返回凭据，JSON 包含 session 与 environment。Swift 仅在已确认的 HTTPS origin 接受对应设备 Cookie。用其值作 Bearer 与单独使用 Cookie 应读到相同的 session ID、environmentId 和授权范围。 |
| 取得可见伙伴 | `GET /api/mobile/v1/bootstrap` | 按现有 bot 顺序返回设备获准查看的伙伴，略过已归档或从侧栏隐藏的 bot。每行只包含身份、外观与一个可见私聊入口。 |
| 定位并读一条私聊 | 现有 `GET /api/bots/:botId?messages=0`（按需）、`GET /api/threads/:threadId/messages?limit=50&before=…` | 网页已在看的线程可能与服务端选中线程不同。有歧义时按单 bot 的可见任务核对归属。首屏只取当前线程最新一页，向上翻时传最早一行的消息 ID。保留 `id`、`parentId`、`activeLeafId` 和 `hasMore`。 |
| 发送普通文本 | 现有 `POST /api/bots/:botId/messages` | 移动契约必传 `{threadId, sendId, text}`。业务层在首次发送前生成 UUID，重试保留三个值。沿用服务端对 bot/线程的权限、排队和实际派发。 |
| 看回复和恢复 | 现有 `GET /api/events?screens=off` | 原生和网页可独立订阅。原生先处理 hello、消息新增/更新、分支变化、队列变化和助手正文增量。原始 SSE 仍包含其他已授权事件，`frames=thread` 只改变部分 bot 帧的形状，不会把订阅限于一个线程。 |

**bootstrap 响应示例**

```json
{
  "version": 1,
  "bots": [
    {
      "id": "bot_example",
      "name": "小诺",
      "color": "purple",
      "avatarUrl": null,
      "selectedThreadId": "th_example"
    }
  ]
}
```

复用现有助手排序、可见范围和成员视图，投影后只给出上面这些字段。头像引用同源已授权资源。没有可见私聊时 `selectedThreadId` 为 null，有效会话可以返回空列表。这个 ID 用于首次选择。调用方明确选中另一条有权访问的私聊时，以选中的 `botId + threadId` 为准。缓存和草稿按实例、设备会话及线程隔离。群聊、无权访问或归属尚未确认时，数据层返回没有可操作的私聊。

`GET /api/auth/session` 的已登录响应声明 `mobileApiVersions: [1]`。Swift 核对 `kind=session`、实例和会话 ID，再请求双方支持的 v1。远端返回 `kind=loopback` 表示配置有误。旧版本缺少该可选字段时，数据层返回版本不支持。已声明 v1 的服务返回 401/403 时分别处理凭据失效与权限拒绝。[作用域规则](../../server/request-auth.ts)

## 需要冻结的行为

- **发送回执。** `202` 表示已受理。普通发送可能返回 `message`（可带 `steered`），也可能返回 `queued: true, queueId`。手机以 `queueId` 对照队列、以 `sendId` 对照落库消息，并保存二者的对应关系。重连仍有待确认的发送时，可用 `GET /api/bots?messages=0` 中的可见队列与当前历史核对。普通文本因丢失回执仍未对上时，重试沿用原线程、正文和 `sendId`。服务端检查已记录的消息或队列，合并同键并发请求。相同键改正文会冲突。已取消的排队项必须由用户重新发起。卡片应答和其他写操作各自定义重试语义。[去重逻辑](../../server/send-idempotency.ts) · [固定线程](../../server/routes/pinned-client-thread.ts) · [队列快照](../../server/steer-queue.ts)
- **历史与卡片。** 分页按服务端顺序，`before` 不含锚点。页面可能含其他分支，按活动叶节点及父链识别当前对话，不能确定祖先关系时补页。未知卡片保留原线程与消息引用，后续展示层据此打开完整会话。审批和附件使用各自的授权。Web 当前支持 `?thread=<threadId>&bot=<botId>` 定位会话。[分页实现](../../server/host/message-pages.ts) · [Web 会话链接](../../src/lib/thread-refs.ts)
- **断线和竞争。** 每个会话单独保存已应用的 SSE 游标。有效游标用 `Last-Event-ID` 恢复。`hello.resumed=true` 时逐帧应用重放，不能先跳到 hello 报告的尾游标。`resumed=false` 时保持流打开、暂存新帧，刷新可见伙伴与当前历史，按消息 ID 和事件游标合并，再提交恢复点。权限过滤会造成序号跳跃。助手的 `content.delta` 仅取 `assistant_text`，最终以落库消息校正。切换账号或撤权时关闭订阅并丢弃相应缓存。[现有手机恢复语义](../ios-companion.md#stream-and-state-model)
- **错误与兼容。** Swift 按 HTTP 状态、已有的 `code` 或 `errorKey` 返回业务错误，缺码时保留通用错误。400 检查输入，401 处理会话失效，403 表示权限限制，404 重新核对资源，409 按操作区分冲突，配对 429 遵守冷却时间。后续需要区分新的冲突原因时给原处理器加稳定码。v1 可追加可选字段与可忽略的事件种类，改变已承诺的必填字段、游标或重试语义时提供新主版本。

## 在哪里维护

1. **Maus 持有契约。** v1 定义版本、伙伴、摘要、有界历史页、固定线程的文本请求及两种 202 回执。直接发送处理器使用同一回执类型。已配对会话的版本字段对旧客户端可选。第三轮补充 SSE 子集。前三轮 Swift 使用普通 URLSession，第四轮由 Connectivity 注入代理传输。[移动契约](../../packages/phone-protocol/src/mobile-v1.ts) · [会话类型](../../packages/phone-protocol/src/responses.ts)
2. **伙伴摘要。** 线程路由将现有的排序、当前身份可见范围交给移动摘要查询，只读 bot 和任务元数据。路由要求已登录的设备会话，原有权限表按精确方法和路径放行。若以后新增写操作，复用带身份、权限和前置校验的服务端操作。[摘要查询](../../server/routes/mobile.ts) · [HTTP 入口](../../server/routes/threads.ts)
3. **脱敏样例。** 隔离服务的契约测试用实际 HTTP 响应核对身份、伙伴、文本发送、直接回执与排队。Swift 检出保存对应 Git 提交的样例，历史样例另含分支和卡片。第三轮扩展到事件。[私聊样例](../../packages/phone-protocol/fixtures/mobile-v1/chat.json) · [身份样例](../../packages/phone-protocol/fixtures/mobile-v1/identity.json) · [同步工具](../../scripts/sync-phone-protocol.mjs)

## 已验证与实施顺序

2026-11-21，针对服务端 `9070bd286`，用 [隔离启动器](../../scripts/control-omb.ts)、假引擎和仅有 `client` scope 的设备做 HTTP 验证。该轮使用回环测试实例，Bearer 和 Cookie 为两种 HTTP 调用方式。iPhone、WKWebView 及真实 tailnet 联验留给接入阶段。

| 隔离探针 | 结果 |
| --- | --- |
| 一次配对、两种凭据呈现 | 原生拟用的 Bearer 和网页拟用的 Cookie 返回相同 session ID。撤销后两者均为 401，已打开的 SSE 关闭。 |
| 同一文本跨入口重试 | 首次及重试均为 202，返回相同消息 ID，历史只有一条对应 `sendId` 的记录。改正文沿用同键为 409。 |
| 历史与恢复 | 分页排除 `before` 锚点。有效游标重放同一消息，异代游标返回 `resumed=false`。 |
| 旧版首屏与版本发现 | 在这次评估的提交上，一个测试 bot 的 `/api/bots?messages=0` 返回了 6 个顶层字段，包括队列、群组和电脑控制。当时没有版本声明，访问 bootstrap 的 client 请求为 403。 |

另跑通过 5 个现有测试文件、34 项用例，涉及[配对设备的线程绑定](../../server/paired-thread-targets-api.test.ts)、[可见性联验](../../server/bot-visibility.e2e.test.ts)、[发送去重](../../server/send-idempotency.test.ts)、[事件重放缓冲](../../server/host/sse-replay.test.ts)和[companion 协议](../../companion/test/phone-protocol.test.ts)。

**第一轮已验收。** iOS 模拟器经临时 HTTPS 入口完成一次受限配对，两种凭据呈现返回相同设备身份和伙伴列表。Keychain 恢复、隐藏资源、无凭据 403 和撤权后 401 均通过。独立运行服务端契约用 `corepack pnpm exec vitest run server/mobile-api-v1.test.ts`，跨仓复跑用工作区的 `node demo/mobile-api/verify.mjs`。

**第二轮已验收。** 受限 iOS 会话向 A 发送、切换到 B，隔离测试网关在服务端返回 202 后丢弃原响应。重建 Swift 客户端从 A 的历史找回原消息，重复原请求返回同一消息 ID，A 有一条、B 为零。原键改正文返回 409。假引擎占用 A 时，第二条文本取得队列 ID，放行引擎后在 A 历史中核对到同一 sendId 和 queueId。服务端复跑用 `corepack pnpm exec vitest run server/mobile-api-v1.test.ts server/mobile-text-api.test.ts`。下一轮在同一套测试上增加 SSE 补读。[服务端读写用例](../../server/mobile-text-api.test.ts)
