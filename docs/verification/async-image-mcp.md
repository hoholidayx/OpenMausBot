# 私聊异步生图验收

2026-11-20 在隔离的单所有者 Maus 安装完成验收。使用模拟聊天引擎和两个独立配对会话代表设备 A、B。设备 A 只有聊天权限，在私聊中要求画一只穿雨衣、提着灯的老鼠。Maus 在第一问下建立图片卡。生成期间，设备 B 在同一私聊问下一班车的时间，先收到了回答。图片随后出现在第一问的原卡上，两台设备下载的 PNG 逐字节一致。聊天引擎共处理两轮，交付图片由 Maus 后台完成。

## 生图服务与产物

| 验收路径 | 观测结果 |
| --- | --- |
| Maus → ComfyImageBridge → 模拟 ComfyUI | 真实 Bridge HTTP 服务、调度器与临时任务库。暂停底层出图直至第二问已答，放行后得到 320 × 256 PNG，2,002 字节。ComfyUI 的 `/prompt` 只收到一次派发。 |
| Maus → 独立 OpenAI Images MCP 适配器 → OpenAI | 适配器使用复制到 Maus 私有目录的凭据访问 `https://api.openai.com`。模型 `gpt-image-2.6-sunburst` 返回 1024 × 1024 PNG，1,973,272 字节。 |
| Maus → ComfyImageBridge → 固定图片回放 | 把上一步的 PNG 作为模拟 ComfyUI 输出，验证大图穿过真实 Bridge 的取图、消息交付及附件下载。底层派发一次，两台设备得到相同的 SHA-256。 |

实图 SHA-256 为 `41f6cc69d59dcb45b89b9302b9f9f7c1805fe98ece8d5cb135d206f535e17b41`。跨项目原始回执在本地工作区的 `novia/tmp/maus-async-image-accept/`，其中 `bridge-fi07n6/receipt.json` 对应真实 Bridge，`real-Ndtsj9/{receipt.json,image.png}` 对应真实供应商，`replay-9VXYoQ/receipt.json` 对应回放。Aion 应用未参与这些请求。OpenAI 路径采用 Bridge 项目记录的独立适配器，ComfyUI 路径使用可控制完成时机的测试后端。[Bridge 验收说明](https://github.com/hoholidayx/ComfyImageBridge/blob/375a3b65f3de23d8b905c248b35a4641bf2fb95c/docs/mcp-rollout.md)

## 重启、额度与设备

- 远端已接单、Maus 未取得有效回执时，对隔离 Maus 进程发送 `SIGKILL`。用同一数据目录重启后，后台查原任务号，原卡收到一个附件，每日账本只占一张。持久化用例另覆盖受理后尚未派发、文件已落盘尚未挂卡、同号不同参数、远端状态待确认、人工重查和多图乱序完成。[进程级测试](../../server/async-image-chat.e2e.test.ts) · [任务与额度测试](../../server/async-image-jobs.test.ts)
- 只有聊天权限的配对设备也能在可见 bot 的私聊中发起生图，修改图片设置则返回 403。脚本、群聊、定时任务、搭档转派和代所有者执行的 Bot API 无法使用这个工具。受理前撤销设备会阻止派发，受理后撤销会收回该设备的访问，其他获准设备仍能接收。收紧 bot 可见性后，只有全权限设备收到图片完成的实时事件，聊天设备也无法读取原会话历史和下载图片。[渠道权限测试](../../server/async-image-access.e2e.test.ts) · [设备与下载测试](../../server/async-image-chat.e2e.test.ts)
- 切换分支后图片交付到原分支。分叉只带走已交付图片。实际加密备份恢复到第二个安装后，已有图片可按消息权限下载，在途任务被冻结，远端调用数没有增加。队列满、远端过期、摘要错误、权限及连接变化也有对应断言。[分支、故障与备份测试](../../server/async-image-jobs.test.ts)
- 在 1200 × 900 桌面和 390 × 844 窄屏浏览器中，原卡自动由生成中更新为图片。键盘 Enter 可打开预览，Escape 可关闭。下载链接返回原图字节，页面无水平溢出。真实图片的四张截图保存在 `novia/tmp/maus-async-image-accept/ui-real/`。[界面验收用例](../../scripts/testing/async-image-ui.e2e.test.ts)

## 复验

在仓库根目录运行。下列用例自行创建临时数据目录、配对设备和本地模拟供应商。

```sh
pnpm exec vitest run server/async-image-chat.e2e.test.ts server/async-image-access.e2e.test.ts server/async-image-jobs.test.ts server/image-bridge.test.ts
pnpm exec vitest run server/image-generation.e2e.test.ts server/routes/image-tools.test.ts server/avatar-image.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/async-image-ui.e2e.test.ts
```

首次验收的 17 个相关测试文件共通过 277 项。一项备份文件名大小写测试因本机临时卷不区分大小写而跳过。当时代理工具套件有两项断言仍引用旧版房间协作文案，在实施前的 `115f05db8` 也可复现。发布前已按当前工具定义更新断言。

手动复验真实服务时，在隔离安装的侧栏「应用 → MCP 服务器」添加服务的 Streamable HTTP 地址。在高级模式的「设置 → AI → 图片 → 私聊生图」选择该连接。选择连接会执行握手和工具发现。配对两台设备，从 A 发起绘图，从 B 在同一私聊追问。最后在第一问的原卡下载图片并比较两端摘要。本机凭据副本保存在 Maus 的私有服务目录，文件权限为 `0600`。只有负责调用 OpenAI 的适配器读取它。[配置说明](../image-generation.md) · [已完成的实施方案](../finished_plans/async-image-mcp.md)

## 发布前复核

- 连接自检从分页工具目录找到三项图像工具，可与其他无参数工具并存。若提交工具只允许已列出的参数且省略 `size`，自检会提示连接不兼容。复验期间自检的生成调用数为零。关闭已保存的连接后，设置页显示该连接不可用。[协议测试](../../server/image-bridge.test.ts) · [设置测试](../../src/components/ImageGenerationSettings.test.ts)
- 模拟 PNG 已写入磁盘、原卡暂停交付、远端结果已过期。清理流程仍保留本地文件，手动重查从该副本恢复原卡，修复过程中远端调用数为零。另验证明确的供应商拒绝释放额度，输出丢失和未知失败保留额度，附件只按可见消息引用交付。[恢复与额度测试](../../server/async-image-jobs.test.ts)
- 在真实 ComfyImageBridge 服务上回放已验收的 OpenAI 实图，底层派发一次。两个配对会话在第一问下载的图片与原实图摘要一致，第二问在出图前得到回答。此次复核的本地回执为 `novia/tmp/maus-async-image-accept/replay-qFKMLJ/receipt.json`。
- 23 个测试文件通过 512 项，另有一项备份测试因临时卷不区分文件名大小写而跳过。代理工具套件的 161 项全部通过。独立浏览器用例在桌面和窄屏验证同一张实图，四张截图保存在 `novia/tmp/maus-async-image-accept/ui-review/`。手机消息协议、分叉入口、文件行数限制、类型检查、lint、语言目录检查、生产构建和文档站构建均通过。
