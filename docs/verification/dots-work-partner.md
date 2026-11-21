# Dots 工作端接入与验收

一个专用的 Dots 本地收件箱对应 Maus 的一个私有工作端。Maus 既可以从已绑定的主会话派活，也可以在 Dots 固定私聊接收主动来信及直接答复。两种入口共用远端 Dot 的上下文。

## 使用

1. 在要派活的主会话中点顶部的 bot 名称，再点齿轮 **机器人设置 → 工作搭档 → Dots · 工作端**。来源 bot 的可见范围为「仅管理员」。高级模式在权限设置中选择工作搭档。
2. 在原输入框写任务并附上所需文件。点击「已发送给 Dots」可以查看工作线程。Dots 会在原消息所在分支署名给出结果，文件就绪后可在同一条结果中下载。
3. 在侧栏打开 Dots 私聊即可连续发送。每条消息在本机保存后就可以发下一条。Dots 的进度和答复引用各自的原消息，主动来信单独显示。编辑消息会另开分支，旧答复仍会回到原分支。
   解除绑定请回原先派活的主会话操作。已受理的任务保持原归属，交付时再检查权限。
4. 在工作搭档设置中可以看到本地连通、宿主授权和远端订阅状态。订阅需要有一个匹配的目标。宿主凭据被撤销后，更换凭据文件即可恢复收件。

## 本机安装

前提是同一台机器已运行 Dots 本地服务，且 Maus 工作区只有一个所有者。Maus 读取其数据目录下的 `providers/dots/connection.json`，通过回环 HTTP 访问本地服务。默认端口为 18767，默认从同目录的 `host.token` 读取宿主凭据。也可用 `tokenFile` 指定宿主凭据的绝对路径。凭据文件、收件记录和出站队列均在服务器的 `providers/` 下。复制源码或导出 Maus 配置时，须在目标机器单独配置连接。

以下命令适用于 Novia 工作区的 macOS 自托管部署。先构建并检查版本，再由管理员执行正式接管。接管命令要求输出路径尚不存在，会立即吊销旧宿主凭据，保留正式收件游标。日后用 Dots 管理 CLI 查看状态或收件时请传入新 token 文件。

```sh
# 在 OpenMausBot 根目录
pnpm build
pnpm build:server
umask 077
dots_provider="${OPENMAUSBOT_DATA_DIR:-$HOME/.openmausbot}/providers/dots"
mkdir -p "$dots_provider"
../dots-bridge/local-service/.venv/bin/dots-local --data ../local/dots-local-service host takeover --output "$dots_provider/host.token"
printf '%s\n' '{"port":18767}' > "$dots_provider/connection.json"
./manage.py restart
./manage.py status
```

Maus 启动时登记固定的 Dots 私聊。管理员可读 `GET /api/dots/status` 查看服务、授权和订阅。工作搭档绑定与当前会话一起保存。仅所有者的私聊请求能授权发件。Maus 会核对工作区的单所有者身份，更换管理员身份后原绑定暂停。系统提示、对话历史、工具和宿主凭据均留在本机。Dots 服务接受正文与本次明确传递的原件，每次最多四个文件，每个最多 20 MiB。下载再次核验所有者、原消息及文件关联。[Dots 本地服务宿主接口](https://github.com/hoholidayx/dots-bridge/blob/0c6f34709f42cc3cd2e83c43c8a18670d4b7e531/local-service/README.md)

## 真实 Dot 往返

2026-11-19 在隔离的 Maus 工作区、独立的本地服务数据库和宿主凭据下，通过现有的 NAS HTTPS 桥接连接已订阅的真实 Dot。Atlas 使用可重复的脚本驱动，Chrome 从工作搭档选择器绑定 Dots，再从聊天输入框派活。正式宿主的消费游标独立于验收收件箱。

| 检查 | 观测结果 |
| --- | --- |
| 派活与进度 | Atlas 发起一个回合，Dots 的工作线程收到真实进度事件。 |
| 回执与归属 | 校验码只写在上传的文件里。Dots 读出 `MAUS-41DA5469BF`，在原消息下署名交付一次。Atlas 的额外回合为零。 |
| 附件内容 | 从原会话的结果链接下载 `acceptance.txt`，58 字节与上传内容逐字节相同。SHA-256 为 `e87aafea7661c17ba2ff74b839f0102f908a718c2d1cd366efa8b9cf109ae0af`。 |
| 界面 | 桌面和 390 像素窄屏 Chrome 均显示 Dots 作者、原消息引用、校验码和可下载原件。 |

[桌面实拍](assets/dots/desktop.png) · [窄屏实拍](assets/dots/mobile.png)

## 异步收发验收

2026-11-21 使用隔离的 Maus 服务、受控的 Dots 本地接口和 Chrome 验证了以下场景。

- 私聊有两条请求同时在途时，第二条先得到答复，第一条稍后得到进度和答复。两条都引用自己的原消息，主动推送单独出现。桌面和 390 像素窄屏均可连续发送，刷新后聊天和侧栏都隐藏旧版首响超时提示。[桌面截图](assets/dots/async-desktop.png) · [窄屏截图](assets/dots/async-mobile.png)
- 主会话先后委派两个任务，同时向 Dots 私聊发消息。停止第二个委派后，第一个委派仍在原消息下署名交付，私聊答复回到收件箱。主 bot 总共执行两个派活回合。
- 暂停第一条私聊的附件上传，再发送第二条消息。停止第一条请求后，第二条消息在上传接口恢复前送达 Dots。
- 通过旧版运行记录和排队记录模拟升级。旧请求沿用已提交的发件键，两条待发消息分别投递。重复提交相同发送 ID 只生成一条用户消息。编辑、停止和宿主重启后，迟到答复保留原归属。

```sh
pnpm exec vitest run server/dots/host.e2e.test.ts server/runtime/runtime.test.ts
OMB_UI_E2E=1 pnpm exec vitest run scripts/testing/dots-ui.e2e.test.ts
```

## 故障与权限回归

运行 `pnpm exec vitest run server/dots/host.e2e.test.ts`。测试启动独立的真实 Maus HTTP 服务及受控的 Dots 宿主接口，覆盖以下行为。

- 两个委派交错、主动推送、普通问句直答、解绑、宿主进程被强制终止，以及重启后向原请求补交一次结果。
- 提交响应和 ACK 丢失时复用发件键和事件 ID。另一个来源无法抢占绑定，未知回执进入受保护的记录。
- 从已授权消息中只交接主 bot 明确选择的文件。直接私聊支持纯附件及迟到回复。归档延迟时原消息原地更新，跨消息或跨会话的下载被拒绝。
- 收件凭据撤销、远端任务过期、取消后迟到，以及来源可见范围扩大时的交付行为。

2026-11-19 的接入验收通过 80 个 Maus 用例和 13 个 Dots 本地服务用例。TypeScript、lint、语言目录、Web 构建和服务端打包均通过。

2026-11-20 在隔离工作区追加验证了三个恢复场景。

- 隐藏 Dots 时，正在等待的轮询收到事件也会保留原收件游标。在隐藏状态下重启 Maus，再显示 Dots，隐藏期间的两条推送按顺序各送达一次。
- 删除唯一派活来源的私聊会释放绑定，所有者可以从另一段私聊重新选择 Dots。删除同一 bot 的其他会话会保留原绑定。升级时会清理指向已删除会话的旧绑定。
- 协作运行时清理已结束的任务记录后，延迟归档的附件仍会在原回执上变为可下载。将来源私聊改为公开后，原下载链接返回 404。

停止尚未提交的请求会取消发件。已提交的请求仍可能在远端执行，私聊迟到的答复会引用原消息，已停止的委派会保留其迟到回执并停止向主会话交付。重启后，待发请求沿用原发件键重试，已提交的请求继续接收回执。上游返回 `needs_review` 时保留该终态，供管理员核对。
