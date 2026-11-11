# 架构说明 · Architecture

---

## 中文

### 1. 三个角色

```
DSH（agent、人格、会话、记忆）
  │
  └── dsh-onebot-qq（插件：会话映射、命令、拆分、限流）
        │  反向 WebSocket，只接受一个客户端
        ├── NapCat（真 QQ）
        └── 鲸屋（本项目）
```

DSH 和插件都不知道外面是 QQ 还是鲸屋——它们只认 OneBot 11 的包裹格式。

### 2. 反向 WebSocket

插件是**服务端**，客户端主动连上去：

```
ws://127.0.0.1:8644/ws
Authorization: Bearer <accessToken>
```

token 不对会被 `4401 unauthorized` 关闭。

连上之后是**全双工**：

| 方向 | 帧 |
|---|---|
| 插件 → 鲸屋 | `{ action, params, echo }` |
| 鲸屋 → 插件 | `{ post_type: "message", ... }` |

### 3. 收到的消息事件

```json
{
  "post_type": "message",
  "message_type": "private",
  "self_id": 10001,
  "user_id": 10000,
  "message_id": "uuid",
  "time": 1794239559,
  "message": [
    { "type": "text", "data": { "text": "hello" } }
  ],
  "raw_message": "hello",
  "sender": { "nickname": "YourName", "card": "" }
}
```

- `self_id`：收信的那个机器人
- `user_id`：发信人
- 群聊时额外有 `group_id`、`group_name`
- 段落类型：`text` / `image` / `at` / `face` / `reply` / `node`

### 4. 发出的动作

```json
{ "action": "send_msg", "params": { "user_id": 10000, "message": [...] }, "echo": "uuid" }
```

必须回应：

```json
{ "status": "ok", "retcode": 0, "data": { "message_id": "..." }, "echo": "uuid" }
```

`echo` 必须原样带回。

已实现的动作：

| action | 用途 |
|---|---|
| `send_msg` / `send_private_msg` / `send_group_msg` | 发消息 |
| `send_forward_msg` / `send_private_forward_msg` | 合并转发 |
| `delete_msg` | 撤回 |
| `get_group_msg_history` | 群历史 |
| `get_msg` | 查单条 |
| `get_login_info` / `get_group_list` / `get_friend_list` | 基础信息 |
| `get_status` / `get_version_info` | 健康检查 |

未实现的动作会记一行日志并返回空对象。

### 5. 消息流向

**进**（人 → agent）：

```
浏览器 → POST /api/send 或 WS {t:"send"}
      → 落库 SQLite
      → 组装 OneBot 事件
      → 推给对应机器人的 WebSocket
      → 插件唤醒 agent
```

**出**（agent → 人）：

```
插件 action=send_msg
      → 按连接归属识别是哪个机器人发的
      → 落库
      → 广播给所有浏览器
```

### 6. 会话 id 为什么必须保持一致

DSH 的会话文件名按聊天对象生成：

```
onebot-private-<对方id>
onebot-group-<群号>
```

鲸屋伪造事件时 `user_id` / `group_id` 原样照抄真实号码，插件算出的会话 id
与之前完全一致 → 打开同一个会话文件 → 上下文与记忆连续。

**一旦改了这些 id，就等于换了一个人。**

### 7. 群聊分发

- 人发言 → 推给群里**所有**机器人（每个 `self_id` 不同）
- 机器人发言 → 落库后推给群里的**其他**机器人，不推回自己

`@` 打成 `{ "type": "at", "data": { "qq": "<目标id>" } }`，插件的点名识别直接可用。

### 8. 存储

```
data/
├── chat.db     SQLite：conversations / messages
└── media/      图片，随机文件名
```

```sql
conversations(id, kind, title)
messages(id, conv, sender_id, sender_name, role, segments, ts, deleted)
```

`segments` 是 OneBot 段落数组的 JSON 字符串。

### 9. 安全

- token 留空时首次启动自动生成并写回 `config.json`
- 未登录访问 `/` 时返回登录页，不吐聊天窗口
- 口令只提交一次：服务端校验后种 `HttpOnly` + `SameSite=Lax` 的 cookie，
  再 302 到干净的 `/`。地址栏、浏览器历史、截图里都不会留下口令
- `/api/*` 和 `/ws` 接受三种凭证：cookie / `X-JW-Token` 头 / `?k=` 参数
  （`?k=` 主要留给脚本和调试）
- 默认明文 HTTP，仅适合局域网；公网请套 TLS 或走 ZeroTier / frp

---

## English

**Roles.** DSH → `dsh-onebot-qq` (plugin, owns session mapping and commands) →
a reverse WebSocket client. That client is normally NapCat; here it is Jingwu.

**Transport.** The plugin *listens* on `ws://127.0.0.1:<port>/ws`; Jingwu dials
in with `Authorization: Bearer <accessToken>`. Only one client may be attached
at a time (last wins), which is why NapCat and Jingwu cannot run together.

**Frames.** Plugin → Jingwu: `{action, params, echo}`. Jingwu → plugin:
`{post_type:"message", message_type, self_id, user_id, group_id?, message, ...}`.
Every action must be answered with `{status, retcode, data, echo}` echoing the
same `echo` value.

**Session continuity.** DSH derives session ids from the peer id
(`onebot-private-<id>`, `onebot-group-<id>`). Jingwu reuses the same ids, so the
plugin resolves to the same session file and the agent keeps its memory.
Changing these ids breaks continuity — treat them as an immutable contract.

**Fan-out.** A human message in a group is delivered to every bot in the group
with that bot's own `self_id`. A bot's reply is stored, shown in the browser,
and delivered to the *other* bots in the group — never echoed back to itself.

**Storage.** SQLite (`node:sqlite`) with two tables; images live under
`data/media/` and are served at `/media/<name>`.

**Security.** The token is generated on first run and written back to
`config.json`. Unauthenticated visits to `/` get a login page, never the chat
UI. A successful login sets an `HttpOnly; SameSite=Lax` cookie and redirects to
a clean `/`, so the token stays out of the address bar, history and
screenshots. `/api/*` and `/ws` accept a cookie, an `X-JW-Token` header, or a
`?k=` query parameter (the last one mainly for scripts and debugging).
Plain HTTP; intended for LAN use. Put TLS in front if exposed.
