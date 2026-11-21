# Maus 移动端 API v1 设计

目标是让 Novia 的原生半屏与 Maus Web 打开同一条真实私聊。在半屏发一句、收起、从原有 bot 入口打开完整会话，应该看到同样的消息和回复。手机切换线程或网络后，消息仍归到发送时选中的线程。

**建议由 OpenMausBot 维护一份移动契约，首版只新增一个 HTTP 资源 `GET /api/mobile/v1/bootstrap`。** 配对、分页、发消息和 SSE 沿用已有处理器，将手机依赖的输入、输出和行为纳入同一份契约测试。所有请求进入原服务的 HTTPS origin，部署沿用原进程和端口。第一期目标是自托管 fork 加 Novia 原生客户端。下文的 bootstrap 和版本字段均为提案。

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
| 配对、恢复、退出 | 现有 `POST /api/auth/pair`、`GET /api/auth/session`、`POST /api/auth/logout` | 用户从自托管实例获取受限配对码。兑换使用 `{code, label, attemptId, cookie: true}`，同一次配对重试沿用同一 attemptId。仅在确认的 HTTPS origin 处理服务端会话 Cookie。原生和 Web 应读到相同的 session ID、environmentId 和授权范围。 |
| 取得可见伙伴 | **拟新增** `GET /api/mobile/v1/bootstrap` | 返回当前会话可见的 bot 列表和各自可用的私聊入口。首屏不加载聊天历史、群数据、队列、电脑控制状态或模型配置。 |
| 定位并读一条私聊 | 现有 `GET /api/bots/:botId?messages=0`（按需）、`GET /api/threads/:threadId/messages?limit=50&before=…` | 网页已在看的线程可能与服务端选中线程不同。有歧义时按单 bot 的可见任务核对归属。首屏只取当前线程最新一页，向上翻时传最早一行的消息 ID。保留 `id`、`parentId`、`activeLeafId` 和 `hasMore`。 |
| 发送普通文本 | 现有 `POST /api/bots/:botId/messages` | 移动契约必传 `{threadId, sendId, text}`。业务层在首次发送前生成 UUID，重试保留三个值。沿用服务端对 bot/线程的权限、排队和实际派发。 |
| 看回复和恢复 | 现有 `GET /api/events?screens=off` | 原生和网页可独立订阅。原生先处理 hello、消息新增/更新、分支变化、队列变化和助手正文增量。原始 SSE 仍包含其他已授权事件，`frames=thread` 只改变部分 bot 帧的形状，不会把订阅限于一个线程。 |

**bootstrap 的建议响应**（示例值）

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

复用现有助手排序、可见范围和成员视图，投影后只给出上面这些字段。头像引用同源已授权资源。没有可见私聊时 `selectedThreadId` 为 null，有效会话可以返回空列表。这个 ID 用于首次进入。网页明确选中另一条有权访问的私聊时，以网页里的 `botId + threadId` 为准。缓存和草稿按实例、设备会话及线程隔离。群聊、无权访问或归属尚未确认时收起半屏入口。

建议给现有 `GET /api/auth/session` 的已配对响应加可选字段 `mobileApiVersions: [1]`，与 bootstrap 同批发布。新 App 确认 `kind=session`、实例和会话身份后，选双方支持的主版本。远端返回 `kind=loopback` 视为部署配置错误。旧自托管版本登录成功但缺少版本字段时，仍可使用完整 Maus Web。已声明 v1 的服务返回 401/403 时处理登录或权限问题。旧服务对未知路径默认要求 admin，单凭 403/404 探测版本容易误判。[作用域规则](../../server/request-auth.ts)

## 需要冻结的行为

- **发送回执。** `202` 表示已受理。普通发送可能返回 `message`（可带 `steered`），也可能返回 `queued: true, queueId`。手机以 `queueId` 对照队列、以 `sendId` 对照落库消息，并保存二者的对应关系。重连仍有待确认的发送时，可用 `GET /api/bots?messages=0` 中的可见队列与当前历史核对。普通文本因丢失回执仍未对上时，重试沿用原线程、正文和 `sendId`。服务端检查已记录的消息或队列，合并同键并发请求。相同键改正文会冲突。已取消的排队项必须由用户重新发起。卡片应答和其他写操作各自定义重试语义。[去重逻辑](../../server/send-idempotency.ts) · [固定线程](../../server/routes/pinned-client-thread.ts) · [队列快照](../../server/steer-queue.ts)
- **历史与卡片。** 分页按服务端顺序，`before` 不含锚点。页面可能含其他分支，按活动叶节点及父链显示当前对话，不能确定祖先关系时补页或打开完整会话。正文和卡片保留原消息 ID。半屏不认识的卡片提供“打开完整会话”，审批与附件继续接受网页原有的逐项授权。Web 当前支持 `?thread=<threadId>&bot=<botId>` 定位会话。[分页实现](../../server/host/message-pages.ts) · [Web 会话链接](../../src/lib/thread-refs.ts)
- **断线和竞争。** 每个会话单独保存已应用的 SSE 游标。有效游标用 `Last-Event-ID` 恢复。`hello.resumed=true` 时逐帧应用重放，不能先跳到 hello 报告的尾游标。`resumed=false` 时保持流打开、暂存新帧，刷新可见伙伴与当前历史，按消息 ID 和事件游标合并，再提交恢复点。权限过滤会造成序号跳跃。助手的 `content.delta` 仅取 `assistant_text`，最终以落库消息校正。切换账号或撤权时关闭订阅并丢弃相应缓存。[现有手机恢复语义](../ios-companion.md#stream-and-state-model)
- **错误与兼容。** UI 以 HTTP 状态、已有的 `code` 或 `errorKey` 分支，缺码时保留通用错误展示。400 检查输入，401 处理会话失效，403 显示权限限制，404 重新核对资源，409 按操作区分冲突，配对 429 遵守冷却时间。后续需要区分新的冲突原因时给原处理器加稳定码。v1 可追加可选字段与可忽略的事件种类，改变已承诺的必填字段、游标或重试语义时提供新主版本。

## 在哪里维护

1. **Maus 持有契约。** 建议在 `packages/phone-protocol/src/mobile-v1.ts` 登记操作、方法/路径、请求、成功及失败形状和 SSE 子集。复用现有 wire 类型，只为 bootstrap 和当前缺少的公开发送回执定义新类型。对沿用的路由，契约列出客户端可以依赖的字段，服务端仍可能返回其他已授权字段。Swift 在 `Novia/MausAPI` 提供配对、伙伴、历史、发送与订阅接口。Connectivity 提供已配置的传输。WKWebView 继续运行随 Maus 发布的现有网页。
2. **只提取需要的查询。** 新 bootstrap 处理器拟放在 `server/routes/mobile.ts`，经现有鉴权和 [RouteContext](../../server/routes/table.ts) 调用与 `threads.ts` 共用的可见伙伴查询。摘要查询不读消息页。按精确 method/path 登记 client 作用域，并检查当前身份、bot 和 thread 的可见性。不能用空的路径匹配结果代替权限判断。Tailscale 负责可达性，最终授权来自 Maus。后续若确需新增写操作，先从现有 handler 提取**带权限和前置校验**的应用操作，两种入口用相同身份调用。避免再经本机 HTTP 转发时落入 loopback 信任。
3. **一套可复验的样例。** 从隔离自托管服务采集脱敏 JSON/SSE，覆盖空列表、受限 bot、多线程、已落库和排队两种回执、未知卡片及两种恢复结果。Maus CI 让候选服务跑已发布 v1 的契约断言。Novia 固定样例来源提交，用 Swift Codable 解码并测试合并。新版 App 对旧服务测版本缺省，旧解码器对新服务测附加字段。同步脚本目前按提交复制 TS，Swift 所需的自托管样例须纳入同步清单。现有 [companion 样例采集](../../scripts/capture-companion-fixtures.mjs) 继续验证桌面 sidecar 的接口。

## 已验证与实施顺序

2026-11-21，针对服务端 `9070bd286`，用 [隔离启动器](../../scripts/control-omb.ts)、假引擎和仅有 `client` scope 的设备做 HTTP 验证。该轮使用回环测试实例，Bearer 和 Cookie 为两种 HTTP 调用方式。iPhone、WKWebView 及真实 tailnet 联验留给接入阶段。

| 隔离探针 | 结果 |
| --- | --- |
| 一次配对、两种凭据呈现 | 原生拟用的 Bearer 和网页拟用的 Cookie 返回相同 session ID。撤销后两者均为 401，已打开的 SSE 关闭。 |
| 同一文本跨入口重试 | 首次及重试均为 202，返回相同消息 ID，历史只有一条对应 `sendId` 的记录。改正文沿用同键为 409。 |
| 历史与恢复 | 分页排除 `before` 锚点。有效游标重放同一消息，异代游标返回 `resumed=false`。 |
| 首屏与版本发现 | 当前一个测试 bot 的 `/api/bots?messages=0` 返回了 6 个顶层字段，包括队列、群组和电脑控制。当前会话响应没有版本声明，访问拟议 bootstrap 的 client 请求为 403。 |

另跑通过 5 个现有测试文件、34 项用例，涉及[配对设备的线程绑定](../../server/paired-thread-targets-api.test.ts)、[可见性联验](../../server/bot-visibility.e2e.test.ts)、[发送去重](../../server/send-idempotency.test.ts)、[事件重放缓冲](../../server/host/sse-replay.test.ts)和[companion 协议](../../companion/test/phone-protocol.test.ts)。

**下一个可独立交付的改动**是会话版本声明、bootstrap、它们的契约类型与隔离测试。用可见和隐藏的 bot/线程对照旧接口，确保摘要只返回获准的身份与资源，旧 Web 和手机调用仍通过。Connectivity 可以同时用现有会话接口验证私网和凭据。随后接 Swift 半屏，做一次“半屏发、网页收，网页回、半屏接”的联验，加上断网重试和双端撤权。只有实际出现带宽瓶颈，或第二个原生功能也需要同一份投影时，再考虑新增轻量历史页或窄化事件流。
