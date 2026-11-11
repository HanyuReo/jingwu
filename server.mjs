/**
 * 鲸屋 · 自己的聊天窗口
 * ------------------------------------------------------------------
 * 它扮演「QQ」这一层的角色：对 DSH 的 dsh-onebot-qq 插件来说，它就是
 * NapCat。插件照旧连 ws://127.0.0.1:8643|8644/ws，会话 id 不变，
 * 记忆一条不丢。
 *
 * 浏览器这边是真正的聊天窗口：左列表、右聊天、支持私聊和群聊。
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(ROOT, 'config.json');
// 第一次运行：没有 config.json，就用同目录的 config.example.json 复制一份
if (!fs.existsSync(CONFIG_PATH)) {
    const example = path.join(ROOT, 'config.example.json');
    if (!fs.existsSync(example)) {
        console.error('缺少 config.json，也找不到 config.example.json');
        process.exit(1);
    }
    fs.copyFileSync(example, CONFIG_PATH);
    console.log('已根据 config.example.json 生成 config.json，按需修改后重新启动。');
}
const CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const DRY = process.argv.includes('--dry');
/** --only=10001,10002 只连指定的机器人（其余留空，不去抢端口） */
const ONLY = (process.argv.find(a => a.startsWith('--only=')) ?? '').slice(7).split(',').map(s => s.trim()).filter(Boolean);
const linkEnabled = id => (ONLY.length > 0 ? ONLY.includes(id) : botById.get(id)?.enabled !== false);

// 访问口令：没写就生成一个，写回配置文件。手机连的时候要带上它。
if (typeof CFG.token !== 'string' || CFG.token.trim() === '') {
    CFG.token = crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(CFG, null, 2), 'utf8');
}
const TOKEN = CFG.token.trim();

const COOKIE_NAME = 'jw_token';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i < 0) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

function tokenOk(req, url) {
    if (url !== undefined) {
        const fromQuery = url.searchParams.get('k');
        if (fromQuery !== null && fromQuery === TOKEN) return true;
    }
    if (req.headers['x-jw-token'] === TOKEN) return true;
    if (parseCookies(req)[COOKIE_NAME] === TOKEN) return true;
    return false;
}

function setTokenCookie(res) {
    res.setHeader('set-cookie',
        `${COOKIE_NAME}=${encodeURIComponent(TOKEN)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`);
}
const DATA = path.join(ROOT, 'data');
const MEDIA = path.join(DATA, 'media');
fs.mkdirSync(MEDIA, { recursive: true });

const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN'), ...a);

// ---------------------------------------------------------------- 数据库
const db = new DatabaseSync(path.join(DATA, 'chat.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  id    TEXT PRIMARY KEY,
  kind  TEXT NOT NULL,
  title TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT PRIMARY KEY,
  conv       TEXT NOT NULL,
  sender_id  TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  role       TEXT NOT NULL,
  segments   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS i_msg ON messages(conv, ts);
`);

const qInsertConv = db.prepare('INSERT OR IGNORE INTO conversations(id,kind,title) VALUES(?,?,?)');
const qInsertMsg = db.prepare(
    'INSERT INTO messages(id,conv,sender_id,sender_name,role,segments,ts) VALUES(?,?,?,?,?,?,?)');
const qListMsg = db.prepare(
    'SELECT * FROM messages WHERE conv=? AND deleted=0 ORDER BY ts DESC LIMIT ?');
const qGetMsg = db.prepare('SELECT * FROM messages WHERE id=?');
const qDelete = db.prepare('UPDATE messages SET deleted=1 WHERE id=?');
const qConvs = db.prepare('SELECT * FROM conversations ORDER BY id');

// ---------------------------------------------------------------- 账户
const owner = CFG.owner;
const botList = CFG.bots;
const botById = new Map(botList.map(b => [b.id, b]));
const groupById = new Map((CFG.groups ?? []).map(g => [g.id, g]));
const ownerName = owner.name;

for (const b of botList) qInsertConv.run('dm:' + b.id, 'dm', b.name);
for (const g of CFG.groups ?? []) qInsertConv.run('group:' + g.id, 'group', g.name);

function convTitle(id) {
    const row = qConvs.all().find(r => r.id === id);
    if (row !== undefined) return row.title;
    if (id.startsWith('botdm:')) {
        const [a, b] = id.slice(6).split('-');
        return `${botById.get(a)?.name ?? a} ↔ ${botById.get(b)?.name ?? b}`;
    }
    return id;
}

function ensureConv(id, kind, title) {
    qInsertConv.run(id, kind, title);
}

// ---------------------------------------------------------------- 媒体
function sniffExt(buf) {
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return '.png';
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
    if (buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49) return '.gif';
    if (buf.length > 12 && buf.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
    if (buf.length > 4 && buf[0] === 0x52 && buf[1] === 0x49) return '.webp';
    return '.bin';
}

async function saveImageBuffer(buf) {
    const name = crypto.randomBytes(8).toString('hex') + sniffExt(buf);
    await fsp.writeFile(path.join(MEDIA, name), buf);
    return '/media/' + name;
}

function readDataUrl(url) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (m === null) return undefined;
    return Buffer.from(m[2], 'base64');
}

/** 把插件发来的图片段落到本地，换成浏览器能看的 url。 */
async function normalizeSegment(seg) {
    const type = String(seg?.type ?? '');
    const d = seg?.data ?? {};
    if (type === 'image') {
        let buf;
        if (typeof d.file === 'string' && d.file.startsWith('base64://')) {
            buf = Buffer.from(d.file.slice(9), 'base64');
        } else if (typeof d.file === 'string' && d.file.startsWith('file://')) {
            try { buf = fs.readFileSync(decodeURIComponent(d.file.slice(7).replace(/^\//, ''))); } catch { /* ignore */ }
        } else if (typeof d.file === 'string' && /^[A-Za-z]:[\\/]|^\//.test(d.file) && fs.existsSync(d.file)) {
            try { buf = fs.readFileSync(d.file); } catch { /* ignore */ }
        } else if (typeof d.url === 'string' && d.url.startsWith('data:')) {
            buf = readDataUrl(d.url);
        }
        if (buf !== undefined && buf.length > 0) {
            return { type: 'image', data: { url: await saveImageBuffer(buf) } };
        }
        const remote = typeof d.url === 'string' && /^https?:/.test(d.url) ? d.url : '';
        return { type: 'image', data: remote !== '' ? { url: remote } : { url: '', text: String(d.file ?? '') } };
    }
    if (type === 'text') return { type: 'text', data: { text: String(d.text ?? '') } };
    if (type === 'at') return { type: 'at', data: { qq: String(d.qq ?? '') } };
    if (type === 'reply') return { type: 'reply', data: { id: String(d.id ?? '') } };
    if (type === 'face') return { type: 'face', data: { id: String(d.id ?? '') } };
    if (type === 'node') return { type: 'node', data: { name: String(d.name ?? ''), content: d.content ?? [] } };
    return { type: type === '' ? 'text' : type, data: d };
}

async function normalizeSegments(segs) {
    const out = [];
    for (const s of Array.isArray(segs) ? segs : []) out.push(await normalizeSegment(s));
    return out;
}

/** 发给插件时，把本地图片还原成 base64。 */
function toBotSegments(segs) {
    return segs.map(s => {
        if (s.type === 'image' && typeof s.data?.url === 'string' && s.data.url.startsWith('/media/')) {
            const p = path.join(MEDIA, path.basename(s.data.url));
            try {
                return { type: 'image', data: { file: 'base64://' + fs.readFileSync(p).toString('base64') } };
            } catch { /* fallthrough */ }
        }
        if (s.type === 'node') {
            return { type: 'node', data: { uin: String(s.data?.uin ?? owner.id), name: String(s.data?.name ?? ''), content: s.data?.content ?? [] } };
        }
        return s;
    });
}

function plainText(segs) {
    const parts = [];
    for (const s of segs) {
        if (s.type === 'text') parts.push(s.data.text);
        else if (s.type === 'at') parts.push('@' + s.data.qq);
        else if (s.type === 'image') parts.push('[图片]');
        else if (s.type === 'face') parts.push('[表情]');
        else if (s.type === 'node') parts.push('[合并转发]');
    }
    return parts.join('');
}

// ---------------------------------------------------------------- 消息入库
const browsers = new Set();

function pushBrowsers(payload) {
    const raw = JSON.stringify(payload);
    for (const ws of browsers) {
        if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    }
}

function recordMessage({ conv, senderId, senderName, role, segments, ts }) {
    const id = crypto.randomUUID();
    const at = ts ?? Date.now();
    qInsertMsg.run(id, conv, senderId, senderName, role, JSON.stringify(segments), at);
    const msg = { id, conv, senderId, senderName, role, segments, ts: at };
    pushBrowsers({ t: 'msg', msg });
    return msg;
}

// ---------------------------------------------------------------- OneBot 客户端
class BotLink {
    constructor(cfg) {
        this.cfg = cfg;
        this.ws = undefined;
        this.ready = false;
        this.retry = 0;
        this.pending = new Map();
        this.timer = undefined;
        /** 最近被踢的时间点，用来识别「端口和 NapCat 撞了」 */
        this.recentCloses = [];
        this.giveUp = false;
    }
    get id() { return this.cfg.id; }
    start() { this.connect(); }
    connect() {
        const ws = new WebSocket(this.cfg.ws, {
            headers: { Authorization: 'Bearer ' + this.cfg.token },
            handshakeTimeout: 8000,
        });
        this.ws = ws;
        ws.on('open', () => {
            this.ready = true;
            this.retry = 0;
            log(`[${this.cfg.name}] 已连上 ${this.cfg.ws}`);
            pushBrowsers({ t: 'status', bots: statusList() });
        });
        ws.on('message', raw => this.onFrame(raw));
        ws.on('close', (code, reason) => {
            if (this.ready) {
                log(`[${this.cfg.name}] 断开 (${code} ${String(reason ?? '')})`);
                const now = Date.now();
                this.recentCloses = this.recentCloses.filter(t => now - t < 10_000);
                this.recentCloses.push(now);
                // 别的客户端（通常是 NapCat）在抢同一个端口：再重连也是互踢
                if (this.recentCloses.length >= 2 && !this.giveUp) {
                    this.giveUp = true;
                    log(`[${this.cfg.name}] 10 秒内被踢两次——${this.cfg.ws} 很可能还被 NapCat 占着。`);
                    log(`[${this.cfg.name}] 先关掉 NapCat，或把 config.json 里这一项的 enabled 改成 false，再重启鲸屋。`);
                }
            }
            this.ready = false;
            this.ws = undefined;
            for (const [, p] of this.pending) p.reject(new Error('disconnected'));
            this.pending.clear();
            pushBrowsers({ t: 'status', bots: statusList() });
            this.schedule();
        });
        ws.on('error', () => { /* close 会跟着来 */ });
    }
    schedule() {
        if (this.giveUp || this.timer !== undefined) return;
        const delay = Math.min(15000, 1000 * Math.pow(1.6, this.retry++));
        this.timer = setTimeout(() => { this.timer = undefined; this.connect(); }, delay);
    }
    onFrame(raw) {
        let f;
        try { f = JSON.parse(raw.toString()); } catch { return; }
        if (f.echo !== undefined) {
            const p = this.pending.get(f.echo);
            if (p === undefined) return;
            this.pending.delete(f.echo);
            if (f.retcode === 0 || f.status === 'ok') p.resolve(f.data ?? {});
            else p.reject(new Error(f.wording || ('retcode ' + f.retcode)));
            return;
        }
        if (f.post_type === 'meta_event') return;
        void this.onEvent(f);
    }
    call(action, params) {
        if (!this.ready || this.ws === undefined) return Promise.reject(new Error('not connected'));
        const echo = crypto.randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(echo);
                reject(new Error('timeout'));
            }, 15000);
            this.pending.set(echo, {
                resolve: d => { clearTimeout(timer); resolve(d); },
                reject: e => { clearTimeout(timer); reject(e); },
            });
            try {
                this.ws.send(JSON.stringify({ action, params, echo }));
            } catch (e) {
                clearTimeout(timer);
                this.pending.delete(echo);
                reject(e);
            }
        });
    }
    push(event) {
        if (!this.ready || this.ws === undefined) return false;
        try { this.ws.send(JSON.stringify(event)); return true; } catch { return false; }
    }
    async onEvent(ev) {
        if (ev.post_type !== 'message' && ev.post_type !== 'message_sent') return;
        const from = String(ev.user_id ?? '');
        const selfId = String(ev.self_id ?? this.cfg.id);
        if (from === '' || from === selfId) return;
        const segs = await normalizeSegments(ev.message);
        const nickname = String(ev.sender?.card || ev.sender?.nickname || from);
        const ts = Number(ev.time ?? 0) > 0 ? Number(ev.time) * 1000 : Date.now();

        if (ev.message_type === 'private') {
            // 收信人是我们自己（owner）还是另一个 bot？
            if (from === owner.id) {
                recordMessage({ conv: 'dm:' + selfId, senderId: from, senderName: ownerName, role: 'owner', segments: segs, ts });
            } else {
                const a = String(from), b = String(selfId);
                const conv = 'botdm:' + [a, b].sort().join('-');
                ensureConv(conv, 'dm', convTitle(conv));
                recordMessage({ conv, senderId: a, senderName: botById.get(a)?.name ?? nickname, role: 'bot', segments: segs, ts });
            }
            return;
        }

        const gid = String(ev.group_id ?? '');
        if (gid === '') return;
        const conv = 'group:' + gid;
        ensureConv(conv, 'group', groupById.get(gid)?.name ?? gid);
        recordMessage({
            conv,
            senderId: from,
            senderName: from === owner.id ? ownerName : (botById.get(from)?.name ?? nickname),
            role: from === owner.id ? 'owner' : 'bot',
            segments: segs,
            ts,
        });
    }
}

const links = new Map(botList.map(b => [b.id, new BotLink(b)]));

function statusList() {
    return botList.map(b => ({ id: b.id, name: b.name, color: b.color ?? '#888', online: links.get(b.id)?.ready === true }));
}

// ---------------------------------------------------------------- 投递
function eventFor(targetBotId, { convId, senderId, senderName, segments, messageId, ts }) {
    const isGroup = convId.startsWith('group:');
    const base = {
        post_type: 'message',
        self_id: Number(targetBotId),
        time: Math.floor((ts ?? Date.now()) / 1000),
        message_id: messageId,
        message: segments,
        raw_message: plainText(segments),
        sender: { user_id: Number(senderId), nickname: senderName, card: '' },
    };
    if (isGroup) {
        const gid = convId.slice(6);
        return { ...base, message_type: 'group', group_id: Number(gid), user_id: Number(senderId), group_name: groupById.get(gid)?.name ?? '' };
    }
    return { ...base, message_type: 'private', user_id: Number(senderId) };
}

/** owner 在窗口里发了一条，转发给该对话里的机器人们。 */
function deliverFromOwner(convId, segments, ts) {
    const msg = recordMessage({
        conv: convId,
        senderId: owner.id,
        senderName: ownerName,
        role: 'owner',
        segments,
        ts,
    });
    const botSegs = toBotSegments(segments);
    if (convId.startsWith('group:')) {
        const gid = convId.slice(6);
        const g = groupById.get(gid);
        const members = g?.members ?? [];
        for (const m of members) {
            if (!botById.has(m)) continue;
            links.get(m)?.push(eventFor(m, {
                convId, senderId: owner.id, senderName: ownerName, segments: botSegs, messageId: msg.id, ts: msg.ts,
            }));
        }
    } else if (convId.startsWith('dm:')) {
        const botId = convId.slice(3);
        links.get(botId)?.push(eventFor(botId, {
            convId, senderId: owner.id, senderName: ownerName, segments: botSegs, messageId: msg.id, ts: msg.ts,
        }));
    }
    return msg;
}

// ---------------------------------------------------------------- 动作分发
async function handleAction(botId, action, params) {
    const link = links.get(botId);
    const bot = botById.get(botId);

    if (action === 'send_msg' || action === 'send_private_msg' || action === 'send_group_msg') {
        const segs = await normalizeSegments(params.message);
        const ts = Date.now();
        const gid = params.group_id !== undefined ? String(params.group_id) : '';
        const uid = params.user_id !== undefined ? String(params.user_id) : '';

        if (gid !== '') {
            const conv = 'group:' + gid;
            ensureConv(conv, 'group', groupById.get(gid)?.name ?? gid);
            const msg = recordMessage({
                conv, senderId: botId, senderName: bot?.name ?? botId, role: 'bot', segments: segs, ts,
            });
            const botSegs = toBotSegments(segs);
            for (const m of (groupById.get(gid)?.members ?? [])) {
                if (m === botId || !botById.has(m)) continue;
                links.get(m)?.push(eventFor(m, {
                    convId: conv, senderId: botId, senderName: bot?.name ?? botId, segments: botSegs, messageId: msg.id, ts,
                }));
            }
            return { message_id: msg.id };
        }

        if (uid === owner.id) {
            const conv = 'dm:' + botId;
            const msg = recordMessage({
                conv, senderId: botId, senderName: bot?.name ?? botId, role: 'bot', segments: segs, ts,
            });
            return { message_id: msg.id };
        }
        if (botById.has(uid)) {
            const conv = 'botdm:' + [botId, uid].sort().join('-');
            ensureConv(conv, 'dm', convTitle(conv));
            const msg = recordMessage({
                conv, senderId: botId, senderName: bot?.name ?? botId, role: 'bot', segments: segs, ts,
            });
            links.get(uid)?.push(eventFor(uid, {
                convId: conv, senderId: botId, senderName: bot?.name ?? botId, segments: toBotSegments(segs), messageId: msg.id, ts,
            }));
            return { message_id: msg.id };
        }
        return { message_id: crypto.randomUUID() };
    }

    if (action === 'send_forward_msg' || action === 'send_private_forward_msg') {
        const nodes = Array.isArray(params.messages) ? params.messages : [];
        const segs = [{ type: 'node', data: { nodes: await normalizeSegments(nodes) } }];
        return handleAction(botId, 'send_msg', {
            group_id: params.group_id,
            user_id: params.user_id,
            message: segs,
        });
    }

    if (action === 'delete_msg') {
        const id = String(params.message_id ?? '');
        const row = qGetMsg.get(id);
        if (row !== undefined) {
            qDelete.run(id);
            pushBrowsers({ t: 'deleted', id, conv: row.conv });
        }
        return {};
    }

    if (action === 'get_group_msg_history') {
        const gid = String(params.group_id ?? '');
        const count = Math.min(Number(params.count ?? 20) || 20, 100);
        const rows = qListMsg.all('group:' + gid, count).reverse();
        const groupName = groupById.get(gid)?.name ?? gid;
        return rows.map(r => {
            const segs = JSON.parse(r.segments);
            return {
                message_id: r.id,
                time: Math.floor(r.ts / 1000),
                message_type: 'group',
                group_id: Number(gid),
                group_name: groupName,
                user_id: Number(r.sender_id),
                sender: { user_id: Number(r.sender_id), nickname: r.sender_name, card: '' },
                message: segs,
                raw_message: plainText(segs),
            };
        });
    }

    if (action === 'get_msg') {
        const row = qGetMsg.get(String(params.message_id ?? ''));
        if (row === undefined) return { message_id: String(params.message_id ?? '') };
        const segs = JSON.parse(row.segments);
        return {
            message_id: row.id,
            time: Math.floor(row.ts / 1000),
            user_id: Number(row.sender_id),
            sender: { user_id: Number(row.sender_id), nickname: row.sender_name },
            message: segs,
            raw_message: plainText(segs),
        };
    }

    if (action === 'get_login_info') {
        return { user_id: Number(botId), nickname: bot?.name ?? botId };
    }
    if (action === 'get_group_list') {
        return (CFG.groups ?? []).map(g => ({
            group_id: Number(g.id), group_name: g.name, member_count: g.members.length,
        }));
    }
    if (action === 'get_friend_list') {
        return botList.filter(b => b.id !== botId).map(b => ({ user_id: Number(b.id), nickname: b.name }));
    }
    if (action === 'get_status' || action === 'get_version_info') {
        return { online: true, good: true, app_name: 'jingwu', app_version: '1.0.0' };
    }

    log(`[${bot?.name ?? botId}] 未实现的动作: ${action}`);
    return {};
}

// ---------------------------------------------------------------- HTTP
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
};

function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
}

function sendHtml(res, code, html) {
    const body = Buffer.from(html, 'utf8');
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'content-length': body.length });
    res.end(body);
}

/** 没有有效 cookie 时给的登录页。口令只输一次，之后靠 HttpOnly cookie。 */
const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>鲸屋 · 口令</title>
<style>
*{box-sizing:border-box}
body{margin:0;height:100dvh;display:grid;place-items:center;background:#0b1018;color:#d8e2f0;
font:15px/1.6 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif}
.card{width:min(92vw,340px)}
h1{font-size:19px;font-weight:700;letter-spacing:3px;margin:0 0 6px;
background:linear-gradient(100deg,#7fb6ff,#4c8dff 45%,#9b7bff);-webkit-background-clip:text;
background-clip:text;color:transparent}
p{color:#7f8ea6;font-size:13px;margin:0 0 18px}
input{width:100%;padding:12px 14px;border-radius:12px;border:1px solid #1e2b40;
background:#111825;color:#d8e2f0;font:inherit;outline:none}
input:focus{border-color:#2f5fae}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:12px;
background:linear-gradient(135deg,#4c8dff,#2f6bd8);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#e5484d;font-size:12.5px;margin-top:10px;min-height:18px}
</style></head>
<body><div class="card">
<h1>鲸屋</h1>
<p>输入启动窗口里打印的口令。只需要输一次。</p>
<form method="post" action="/api/login">
<input name="token" autocomplete="current-password" autofocus placeholder="口令">
<button type="submit">进入</button>
</form>
<div class="err">__ERR__</div>
</div></body></html>`;

function readBody(req, limit = 40 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', c => {
            size += c.length;
            if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

/** 把浏览器发来的内容（文字 / @ / 图片）变成 OneBot 段落。 */
async function segmentsFromBody(body) {
    const out = [];
    if (Array.isArray(body.segments)) {
        for (const s of body.segments) {
            if (s?.type === 'text') out.push({ type: 'text', data: { text: String(s.data?.text ?? '') } });
            else if (s?.type === 'at') out.push({ type: 'at', data: { qq: String(s.data?.qq ?? '') } });
        }
    } else {
        const text = String(body.text ?? '');
        if (text !== '') out.push({ type: 'text', data: { text } });
    }
    for (const img of Array.isArray(body.images) ? body.images : []) {
        const buf = readDataUrl(String(img));
        if (buf === undefined) continue;
        out.push({ type: 'image', data: { url: await saveImageBuffer(buf) } });
    }
    return out;
}

function messageRow(r) {
    return {
        id: r.id,
        conv: r.conv,
        senderId: r.sender_id,
        senderName: r.sender_name,
        role: r.role,
        segments: JSON.parse(r.segments),
        ts: r.ts,
    };
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const p = url.pathname;

        // 登录：接受 JSON 或表单，正确就种 cookie 回首页
        if (p === '/api/login' && req.method === 'POST') {
            const raw = (await readBody(req)).toString('utf8');
            let token = '';
            if (String(req.headers['content-type'] ?? '').includes('application/json')) {
                try { token = String(JSON.parse(raw).token ?? ''); } catch { token = ''; }
            } else {
                token = String(new URLSearchParams(raw).get('token') ?? '');
            }
            if (token.trim() === TOKEN) {
                setTokenCookie(res);
                res.writeHead(302, { location: '/' });
                res.end();
                return;
            }
            res.writeHead(302, { location: '/?e=1' });
            res.end();
            return;
        }

        if (p.startsWith('/api/') && !tokenOk(req, url)) {
            return sendJson(res, 401, { error: 'unauthorized' });
        }

        if (p === '/api/bootstrap') {
            return sendJson(res, 200, {
                me: { id: owner.id, name: ownerName },
                bots: statusList(),
                convs: qConvs.all().map(c => {
                    const out = { id: c.id, kind: c.kind, title: c.title };
                    if (c.kind === 'group' && c.id.startsWith('group:')) {
                        const g = groupById.get(c.id.slice(6));
                        if (g !== undefined) {
                            out.members = g.members.map(id => ({
                                id,
                                name: id === owner.id ? ownerName : (botById.get(id)?.name ?? id),
                            }));
                        }
                    }
                    return out;
                }),
            });
        }

        if (p === '/api/history') {
            const conv = url.searchParams.get('conv') ?? '';
            const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 500);
            const rows = qListMsg.all(conv, limit).reverse();
            return sendJson(res, 200, { messages: rows.map(messageRow) });
        }

        if (p === '/api/send' && req.method === 'POST') {
            const body = JSON.parse((await readBody(req)).toString('utf8'));
            const conv = String(body.conv ?? '');
            const segments = await segmentsFromBody(body);
            if (segments.length === 0) return sendJson(res, 400, { error: 'empty' });
            const msg = deliverFromOwner(conv, segments, Date.now());
            return sendJson(res, 200, { ok: true, id: msg.id });
        }

        if (p.startsWith('/media/')) {
            const name = path.basename(p);
            const file = path.join(MEDIA, name);
            if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
            const ext = path.extname(file).toLowerCase();
            res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
            fs.createReadStream(file).pipe(res);
            return;
        }

        // 带 ?k= 打开时：种 cookie，然后跳到不带口令的干净地址
        if ((p === '/' || p === '/index.html') && url.searchParams.get('k') === TOKEN) {
            setTokenCookie(res);
            res.writeHead(302, { location: p });
            res.end();
            return;
        }

        // 没有任何凭证：给登录页，不把聊天窗口吐出去
        if ((p === '/' || p === '/index.html') && !tokenOk(req, url)) {
            return sendHtml(res, 401, LOGIN_PAGE.replace('__ERR__',
                url.searchParams.get('e') === '1' ? '口令不对，再试一次。' : ''));
        }

        const rel = p === '/' ? '/index.html' : p;
        const file = path.join(ROOT, 'public', path.normalize(rel).replace(/^([/\\])+/, ''));
        if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file)) {
            res.writeHead(404); res.end('not found'); return;
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    } catch (e) {
        log('HTTP 错误:', e.message);
        try { sendJson(res, 500, { error: e.message }); } catch { /* ignore */ }
    }
});

// ---------------------------------------------------------------- 浏览器 WS
const wss = new WebSocketServer({ noServer: true });

// 在握手阶段就挡掉未登录的连接，而不是先连上再关
server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/ws') {
        socket.destroy();
        return;
    }
    const allowed = u.searchParams.get('k') === TOKEN
        || parseCookies(req)[COOKIE_NAME] === TOKEN
        || req.headers['x-jw-token'] === TOKEN;
    if (!allowed) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});

wss.on('connection', ws => {
    browsers.add(ws);
    ws.send(JSON.stringify({ t: 'status', bots: statusList() }));
    ws.on('close', () => browsers.delete(ws));
    ws.on('error', () => browsers.delete(ws));
    ws.on('message', async raw => {
        try {
            const f = JSON.parse(raw.toString());
            if (f.t === 'send') {
                const conv = String(f.conv ?? '');
                const segments = await segmentsFromBody(f);
                if (segments.length > 0) deliverFromOwner(conv, segments, Date.now());
            }
        } catch { /* ignore */ }
    });
});

// ---------------------------------------------------------------- 自动备份
const BACKUP_DIR = path.join(ROOT, 'data-backup');

function backupDay() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 把 data/ 里的话本子拷一份到 data-backup/YYYY-MM-DD/，只留最近 7 天。 */
function runBackup() {
    try {
        const day = backupDay();
        const dest = path.join(BACKUP_DIR, day);
        if (fs.existsSync(dest)) return;
        fs.mkdirSync(dest, { recursive: true });
        const dbFile = path.join(DATA, 'chat.db');
        if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, path.join(dest, 'chat.db'));
        if (fs.existsSync(MEDIA)) fs.cpSync(MEDIA, path.join(dest, 'media'), { recursive: true });
        const days = fs.readdirSync(BACKUP_DIR).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
        while (days.length > 7) fs.rmSync(path.join(BACKUP_DIR, days.shift()), { recursive: true, force: true });
        log('已备份到 data-backup/' + day);
    } catch (e) {
        log('备份失败: ' + e.message);
    }
}

// 每天 4 点之后跑一次；用「目录是否已存在」判重，重启也不会重复备份
const backupTick = () => { if (new Date().getHours() >= 4) runBackup(); };
setTimeout(backupTick, 15_000).unref();
setInterval(backupTick, 30 * 60 * 1000).unref();

// ---------------------------------------------------------------- 启动
server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        log(`端口 ${CFG.port} 已经被占用——多半是鲸屋已经开着了。`);
        log('先关掉原来那个窗口（或在任务管理器里结束 node.exe），再启动这一个。');
        process.exit(1);
    }
    log('服务器出错: ' + err.message);
    process.exit(1);
});
wss.on('error', () => { /* 交给 server 的 error 处理 */ });

server.listen(CFG.port, CFG.host, () => {
    const show = host => `http://${host}:${CFG.port}/`;
    log('鲸屋已开:');
    log('  本机     ' + show('127.0.0.1'));
    for (const list of Object.values(os.networkInterfaces())) {
        for (const nic of list ?? []) {
            if (nic.family === 'IPv4' && !nic.internal) log('  手机/局域网 ' + show(nic.address));
        }
    }
    log('  口令     ' + TOKEN);
    if (DRY) log('--dry：不连接 DSH，只跑窗口本身');
    else {
        for (const link of links.values()) {
            if (linkEnabled(link.id)) link.start();
            else log(`[${link.cfg.name}] 跳过（${ONLY.length > 0 ? '--only 未包含' : 'config 里 enabled=false'}）`);
        }
    }
});

process.on('SIGINT', () => {
    log('收工');
    for (const link of links.values()) { try { link.ws?.close(); } catch { /* ignore */ } }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
});
