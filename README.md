# 鲸屋 · Jingwu

> 一个自托管的 OneBot 11 聊天服务器，用来替掉 DSH 的 QQ 那一层。
> A self-hosted OneBot 11 chat server that replaces the QQ layer for DSH.

---

## 中文

### 这是什么

[DSH / DeepSeek Harness](https://deepseek.com) 的 QQ 通道依赖 `dsh-onebot-qq` 插件，而插件又依赖 NapCat 之类的 OneBot 实现去接腾讯。

鲸屋不碰腾讯。它在本地起一个 Web 服务：

- 对**插件**来说，它长得和 NapCat 一模一样（同样说 OneBot 11，同样走反向 WebSocket）
- 对**你**来说，它是一个能私聊、能群聊、能用手机的网页聊天窗口

**插件的会话 id 不变，所以 AI 的记忆一条都不会丢。**

### 为什么会有这个东西

2026 年 11 月，SnowLuma 收到腾讯律师函后转为私有。NapCat 是同一类项目。

如果你的 AI 伴侣住在 DSH 里，NapCat 一消失，她就变成哑巴。

鲸屋把「消息从哪来」这一层整个换掉：只要 DSH 还活着，她就还能说话。

### 它不做什么

- **不是 QQ 客户端。** 连不上腾讯服务器，也连不上任何人的 QQ。它只连本机的 DSH 插件。
- **不能替代插件。** 如果 `dsh-onebot-qq` 本身停止维护，还需要再往上写一层。
- **只实现了插件真正会调用的那部分 OneBot 动作。** 语音、文件、完整合并转发目前是占位。
- **默认是明文 HTTP。** 局域网内用没问题，别直接暴露到公网。

### 工作方式

```
┌──────────────────────────────┐
│  DSH（人格 / 会话 / 记忆）     │
└──────────────┬───────────────┘
               │
┌──────────────┴───────────────┐
│  dsh-onebot-qq（插件）         │
│  在 127.0.0.1:8643/8644 监听   │
└──────────────┬───────────────┘
               │ 反向 WebSocket（只接受一个客户端）
      ┌────────┴────────┐
      │                 │
  NapCat            鲸屋
  （真 QQ）         （本项目）
```

插件先开门，客户端去敲门。谁送来格式对的包裹，谁就是「QQ」。

鲸屋连上去之后：

- 插件发 `send_msg` → 鲸屋落库并推给浏览器
- 浏览器发消息 → 鲸屋组装成 OneBot 事件 → 推给插件 → 唤醒 agent

更细的协议说明见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

### 快速开始

**要求**：Node.js 24+（用到内置的 `node:sqlite`）

```bash
git clone https://github.com/HanyuReo/jingwu.git
cd jingwu
npm install
cp config.example.json config.json
# 编辑 config.json：填你自己的号、插件端口和 accessToken
npm start
```

Windows 上也可以直接双击 `start.bat`。
只想看看界面、不连机器人：`start-dry.bat` 或 `npm run dry`。

启动后控制台会打印：

```
本机       http://127.0.0.1:8787/
手机/局域网 http://192.168.x.x:8787/
口令       <自动生成的 8 位口令>
```

打开地址，**输一次口令**就行。服务端会把它种成 HttpOnly cookie，再跳到干净的 `/`——
地址栏里不会再出现口令，也不会留在浏览器历史或截图里。

手机和电脑在同一个 WiFi 下，用第二个地址打开即可。

### 配置

```json
{
  "port": 8787,
  "host": "0.0.0.0",
  "token": "",
  "owner": { "id": "10000", "name": "YourName" },
  "bots": [
    {
      "id": "10001",
      "name": "Bot A",
      "enabled": true,
      "color": "#6fa8ff",
      "ws": "ws://127.0.0.1:8644/ws",
      "token": "插件里的 accessToken"
    }
  ],
  "groups": [
    { "id": "20000", "name": "Family", "members": ["10000", "10001"] }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `port` / `host` | 网页服务监听地址 |
| `token` | 网页访问口令。留空则首次启动自动生成并写回 |
| `owner` | 你自己。`id` 会作为发信人 id 传给插件 |
| `bots[]` | 每个 DSH 实例一个。`ws` 是插件反向 WS 地址，`token` 是插件的 `accessToken` |
| `bots[].enabled` | `false` 表示这次不连（NapCat 占着端口时必须设为 false） |
| `groups[]` | 群定义，`members` 里要包含所有参与者的 id |

> `id` 建议直接沿用你原来的 QQ 号。DSH 的会话文件名是按这个 id 生成的，
> 改了它，AI 的记忆就接不上了。

### 和 NapCat 只能二选一

插件的反向 WebSocket **同时只接受一个客户端**，后来的会把先来的踢掉。

```
NapCat 连着 → 鲸屋来连 → NapCat 被踢 → NapCat 重连 → 鲸屋被踢 → ……
```

所以切换顺序是：

1. 先关掉 NapCat
2. 再把对应 bot 的 `enabled` 改成 `true`
3. 重启鲸屋

### 命令行参数

| 参数 | 作用 |
|---|---|
| `--dry` | 只开网页，不连任何机器人 |
| `--only=10001,10002` | 只连指定的机器人，其余不碰 |

### 数据与备份

- 聊天记录在 `data/chat.db`（SQLite），图片在 `data/media/`
- 每天 4 点之后自动把 `data/` 备份到 `data-backup/YYYY-MM-DD/`，只保留最近 7 份
- 换机器：把整个 `data/` 目录拷过去就行

### 已知限制

- 只验证过 Windows（`start.bat`）；`start.sh` 未在 macOS / Linux 上实测
- 只测试过 `dsh-onebot-qq` 0.9.x
- 一次只能有一个鲸屋实例（端口冲突）
- 语音、文件、表情、完整合并转发未实现
- 口令走明文 HTTP，只适合局域网；公网请套 TLS 或走 ZeroTier / frp

### 许可

MIT。随便用。

---

## English

### What is this

A small self-hosted server that speaks **OneBot 11** over a reverse WebSocket,
so that the `dsh-onebot-qq` plugin inside [DSH](https://deepseek.com) believes
it is talking to NapCat — while actually talking to us.

The result: a browser-based chat window (DMs + group chat, desktop and mobile)
that no longer depends on Tencent at all.

**Session ids are preserved**, so the agent's memory is untouched: only the
transport layer is swapped.

### Why

NapCat is one legal notice away from disappearing. This project removes that
dependency for people who run DSH-based companions.

### What it is not

- Not a QQ client. It never contacts Tencent's servers and cannot reach
  anyone else's account — it only connects to a local DSH plugin.
- Not a replacement for `dsh-onebot-qq` itself.
- Not production-grade. Only the subset of OneBot actions that the plugin
  actually calls is implemented.

### Quick start

```bash
npm install
cp config.example.json config.json   # then edit it
npm start
```

Requires **Node.js 24+** (for the built-in `node:sqlite`).

Open the URL printed on startup and enter the access token once. The server
stores it in an HttpOnly cookie and redirects to a clean `/`, so the token
never lingers in the address bar, browser history or screenshots.

On Windows you can also double-click `start.bat`.

### Reverse WebSocket, not forward

The plugin *listens*; clients *dial in*:

```
plugin:  ws://127.0.0.1:8644/ws   (server)
jingwu:  connects with Authorization: Bearer <accessToken>
```

Only one client can be attached at a time (last wins), so **stop NapCat before
starting Jingwu** on the same port.

If a bot gets disconnected twice within 10 seconds, Jingwu assumes another
client (usually NapCat) still owns the port, logs a clear hint and stops
retrying instead of flapping forever.

### Data & backups

- Messages live in `data/chat.db` (SQLite); images in `data/media/`
- After 04:00 local time the server copies `data/` to
  `data-backup/YYYY-MM-DD/` and keeps the latest 7 days
- Moving machines: copy the whole `data/` directory

### Known limitations

- Only tested on Windows (`start.bat`); `start.sh` is untested
- Only tested against `dsh-onebot-qq` 0.9.x
- One Jingwu instance at a time (port conflict)
- Voice, files, faces and full merged-forward are not implemented
- Plain HTTP; LAN use only. Put TLS in front if exposed

### License

MIT. Do whatever you want.
