const $ = s => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ---------------------------------------------------------------- 登录态
// 口令由服务端下发的 HttpOnly cookie 携带，前端不接触它，
// 也就不会留在地址栏、浏览器历史或截图里。
const withToken = p => p;

const state = {
  me: { id: '', name: '' },
  bots: [],
  convs: [],
  current: null,
  messages: [],
  pendingImages: [],
  lastDay: '',
  lastText: {},
  unread: {},
  mention: { open: false, items: [], index: 0, start: 0 },
};

// ---------------------------------------------------------------- 工具
const fmtTime = ts => {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
};
const fmtDay = ts => {
  const d = new Date(ts);
  const t = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, t)) return '今天';
  if (same(d, new Date(t.getTime() - 86400000))) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
};

const botOf = id => state.bots.find(b => b.id === id);
const convOf = id => state.convs.find(c => c.id === id);
const preview = segs => (segs ?? []).map(s =>
  s.type === 'text' ? (s.data?.text ?? '')
    : s.type === 'at' ? '@' + (botOf(s.data?.qq)?.name ?? '')
      : s.type === 'image' ? '[图片]' : '').join('').slice(0, 30);

function updateTitle() {
  const total = Object.values(state.unread).reduce((a, b) => a + b, 0);
  document.title = total > 0 ? `(${total}) 鲸屋` : '鲸屋';
}

// ---------------------------------------------------------------- 侧栏
function convAvatar(conv) {
  const n = el('div', 'avatar');
  if (conv.kind === 'group') { n.classList.add('group'); n.textContent = '家'; return n; }
  if (conv.id.startsWith('botdm:')) { n.classList.add('botdm'); n.textContent = '↔'; return n; }
  const botId = conv.id.slice(3);
  const idx = state.bots.findIndex(b => b.id === botId);
  n.classList.add('bot-' + (idx < 0 ? 0 : idx));
  n.textContent = (botOf(botId)?.name ?? '?').slice(0, 1);
  return n;
}

function renderConvList() {
  const list = $('#convList');
  list.replaceChildren();
  for (const c of state.convs) {
    const li = el('li', 'conv' + (state.current === c.id ? ' active' : ''));
    li.dataset.id = c.id;
    li.append(convAvatar(c));
    const meta = el('div', 'meta');
    meta.append(el('div', 'name', c.title));
    meta.append(el('div', 'last', state.lastText[c.id] ?? (c.kind === 'group' ? '群聊' : '私聊')));
    li.append(meta);
    const n = state.unread[c.id] ?? 0;
    if (n > 0) li.append(el('span', 'badge', n > 99 ? '99+' : String(n)));
    li.onclick = () => openConv(c.id);
    list.append(li);
  }
  updateTitle();
}

function renderPresence() {
  const box = $('#presence');
  box.replaceChildren();
  for (const b of state.bots) {
    const d = el('span', 'dot' + (b.online ? ' on' : ''));
    d.title = b.name + (b.online ? ' 在线' : ' 离线');
    box.append(d);
  }
}

// ---------------------------------------------------------------- 渲染
function segmentNodes(msg) {
  const frag = document.createDocumentFragment();
  for (const s of msg.segments ?? []) {
    if (s.type === 'text') {
      frag.append(document.createTextNode(s.data?.text ?? ''));
    } else if (s.type === 'at') {
      frag.append(el('span', 'at', '@' + (botOf(s.data?.qq)?.name ?? s.data?.qq ?? '')));
    } else if (s.type === 'image') {
      const url = s.data?.url ?? '';
      if (url === '') { frag.append(document.createTextNode('[图片]')); continue; }
      const img = document.createElement('img');
      img.src = url;
      img.loading = 'lazy';
      img.onclick = () => window.open(url, '_blank');
      frag.append(img);
    } else if (s.type === 'face') {
      frag.append(document.createTextNode('[表情]'));
    } else if (s.type === 'node') {
      const nodes = s.data?.nodes ?? [];
      const lines = nodes.map(n => (n.data?.name ? n.data.name + '：' : '') +
        (n.data?.content ?? []).map(c => c.data?.text ?? '').join('')).join('\n');
      frag.append(document.createTextNode(lines || '[合并转发]'));
    }
  }
  return frag;
}

function messageRow(msg) {
  const row = el('div', 'row' + (msg.role === 'owner' ? ' mine' : ''));
  const body = el('div');
  if (msg.role !== 'owner') body.append(el('div', 'who', msg.senderName));
  const bubble = el('div', 'bubble');
  bubble.append(segmentNodes(msg));
  bubble.append(el('span', 'time', fmtTime(msg.ts)));
  body.append(bubble);
  row.append(body);
  return row;
}

function appendMessage(msg) {
  const log = $('#log');
  const day = fmtDay(msg.ts);
  if (day !== state.lastDay) {
    state.lastDay = day;
    log.append(el('div', 'day', day));
  }
  const empty = log.querySelector('.empty');
  if (empty) empty.remove();
  log.append(messageRow(msg));
  log.scrollTop = log.scrollHeight;
  state.messages.push(msg);
  state.lastText[msg.conv] = preview(msg.segments);

  const viewing = msg.conv === state.current && !document.hidden;
  if (msg.role !== 'owner' && !viewing) {
    state.unread[msg.conv] = (state.unread[msg.conv] ?? 0) + 1;
  }
  renderConvList();
}

// ---------------------------------------------------------------- 对话
async function openConv(id) {
  state.current = id;
  state.lastDay = '';
  state.unread[id] = 0;
  const conv = convOf(id);
  $('#chatTitle').textContent = conv?.title ?? id;
  const online = state.bots.filter(b => b.online).length;
  $('#chatSub').textContent = conv?.kind === 'group'
    ? `群聊 · ${online}/${state.bots.length} 在线`
    : (botOf(id.slice(3))?.online ? '在线' : '离线');
  document.body.classList.add('chat-open');
  renderConvList();

  const log = $('#log');
  log.replaceChildren(el('div', 'empty', '加载中…'));
  const r = await fetch(withToken('/api/history?conv=' + encodeURIComponent(id) + '&limit=200'));
  if (r.status === 401) { log.replaceChildren(el('div', 'empty', '登录已过期。\n刷新页面，重新输入口令。')); return; }
  const data = await r.json();
  state.messages = [];
  log.replaceChildren();
  if (data.messages.length === 0) {
    log.append(el('div', 'empty', '还没有消息。\n说点什么吧。'));
  } else {
    for (const m of data.messages) {
      const day = fmtDay(m.ts);
      if (day !== state.lastDay) { state.lastDay = day; log.append(el('div', 'day', day)); }
      log.append(messageRow(m));
    }
    log.scrollTop = log.scrollHeight;
    for (const m of data.messages) state.lastText[m.conv] = preview(m.segments);
  }
  renderConvList();
  $('#input').focus();
}

// ---------------------------------------------------------------- @ 提醒
function mentionCandidates(prefix) {
  const conv = convOf(state.current);
  if (conv?.kind !== 'group') return [];
  return (conv.members ?? [])
    .filter(m => m.id !== state.me.id)
    .filter(m => prefix === '' || m.name.includes(prefix) || m.id.includes(prefix));
}

function closeMention() {
  state.mention.open = false;
  $('#mentions').classList.remove('show');
}

function renderMention() {
  const box = $('#mentions');
  box.replaceChildren();
  if (!state.mention.open) { box.classList.remove('show'); return; }
  box.classList.add('show');
  state.mention.items.forEach((m, i) => {
    const item = el('button', 'mention-item' + (i === state.mention.index ? ' on' : ''));
    item.type = 'button';
    item.textContent = '@' + m.name;
    item.onmousedown = e => { e.preventDefault(); pickMention(m); };
    box.append(item);
  });
}

function pickMention(m) {
  const input = $('#input');
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, state.mention.start);
  const after = input.value.slice(pos);
  const text = before + '@' + m.name + ' ' + after;
  input.value = text;
  const caret = before.length + m.name.length + 2;
  input.setSelectionRange(caret, caret);
  closeMention();
  input.focus();
}

function updateMention() {
  const input = $('#input');
  const conv = convOf(state.current);
  if (conv?.kind !== 'group') { closeMention(); return; }
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos);
  const m = /(^|[\s@])@([^\s@]{0,12})$/.exec(before);
  if (m === null) { closeMention(); return; }
  const items = mentionCandidates(m[2]);
  if (items.length === 0) { closeMention(); return; }
  state.mention = { open: true, items, index: 0, start: m.index + m[1].length };
  renderMention();
}

/** 把带 @名字 的文字切成 OneBot 段落。 */
function toSegments(text) {
  const conv = convOf(state.current);
  if (conv?.kind !== 'group') return [{ type: 'text', data: { text } }];
  const members = (conv.members ?? []).filter(m => m.id !== state.me.id)
    .slice().sort((a, b) => b.name.length - a.name.length);
  const segs = [];
  let i = 0;
  let buf = '';
  while (i < text.length) {
    if (text[i] === '@') {
      const hit = members.find(m => text.startsWith('@' + m.name, i));
      if (hit !== undefined) {
        if (buf !== '') { segs.push({ type: 'text', data: { text: buf } }); buf = ''; }
        segs.push({ type: 'at', data: { qq: hit.id } });
        i += 1 + hit.name.length;
        continue;
      }
    }
    buf += text[i++];
  }
  if (buf !== '') segs.push({ type: 'text', data: { text: buf } });
  return segs.length > 0 ? segs : [{ type: 'text', data: { text } }];
}

// ---------------------------------------------------------------- 发送
async function send(text) {
  if (state.current === null) return;
  const body = {
    conv: state.current,
    segments: toSegments(text),
    images: state.pendingImages.slice(),
  };
  state.pendingImages = [];
  const r = await fetch(withToken('/api/send'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const log = $('#log');
    log.append(el('div', 'empty', '发送失败（' + r.status + '）'));
  }
}

// ---------------------------------------------------------------- 图片
async function readAsDataUrl(file) {
  return new Promise(res => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result));
    fr.readAsDataURL(file);
  });
}

$('#file').onchange = async e => {
  for (const f of [...(e.target.files ?? [])]) {
    const url = await readAsDataUrl(f);
    state.pendingImages.push(url);
    const log = $('#log');
    const row = el('div', 'row mine');
    const bubble = el('div', 'bubble');
    const img = document.createElement('img');
    img.src = url;
    img.style.opacity = '.6';
    bubble.append(img);
    bubble.append(el('span', 'time', '待发送'));
    row.append(bubble);
    log.append(row);
    log.scrollTop = log.scrollHeight;
  }
  e.target.value = '';
};

// ---------------------------------------------------------------- 输入
const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(160, input.scrollHeight) + 'px';
  updateMention();
});
input.addEventListener('keydown', e => {
  if (state.mention.open) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = state.mention.items.length;
      state.mention.index = (state.mention.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      renderMention();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pickMention(state.mention.items[state.mention.index]);
      return;
    }
    if (e.key === 'Escape') { closeMention(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').onsubmit = async e => {
  e.preventDefault();
  const text = input.value.trim();
  if (text === '' && state.pendingImages.length === 0) return;
  input.value = '';
  input.style.height = 'auto';
  closeMention();
  await send(text);
};

$('#attach').onclick = () => $('#file').click();
$('#backBtn').onclick = () => document.body.classList.remove('chat-open');

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.current !== null) {
    state.unread[state.current] = 0;
    renderConvList();
  }
});

// ---------------------------------------------------------------- 启动
async function boot() {
  const r = await fetch(withToken('/api/bootstrap'));
  if (r.status === 401) {
    document.body.replaceChildren(el('div', 'empty', '登录已过期。\n刷新页面，重新输入口令。'));
    return;
  }
  const data = await r.json();
  state.me = data.me;
  state.bots = data.bots;
  state.convs = data.convs;
  renderPresence();
  renderConvList();

  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onmessage = ev => {
    let f;
    try { f = JSON.parse(ev.data); } catch { return; }
    if (f.t === 'status') {
      state.bots = f.bots;
      renderPresence();
    } else if (f.t === 'msg') {
      if (f.msg.conv === state.current) appendMessage(f.msg);
      else {
        state.lastText[f.msg.conv] = preview(f.msg.segments);
        if (f.msg.role !== 'owner') {
          state.unread[f.msg.conv] = (state.unread[f.msg.conv] ?? 0) + 1;
        }
        renderConvList();
      }
    } else if (f.t === 'deleted') {
      if (f.conv === state.current) openConv(state.current);
    }
  };
  ws.onclose = () => setTimeout(boot, 2000);
}

boot();
