import { fetchIcs, parseIcs, normalizeUrl, calendarName, urlWarning } from './calendar.js';

const APP_VERSION = '1.1.0';
const STORE_KEY = 'vieccve.state.v1';
const EVENTS_KEY = 'vieccve.events.v1';
const FILES_KEY = 'vieccve.files.v1';
const DEFAULT_SEGMENTS = ['5p TikTok', 'Chúc bạn may mắn lần sau', '5p đọc truyện', 'Chúc bạn may mắn lần sau'];
const SEG_COLORS = ['#ff5c8a', '#6d5dfc', '#20c997', '#4c6ef5', '#ffa94d', '#be4bdb', '#15aabf', '#fab005'];
const CAL_COLORS = ['#6d5dfc', '#ff5c8a', '#20c997', '#ffa94d', '#4c6ef5', '#be4bdb'];
const DAY = 86400000;

/* =========================================================
   STATE
   ========================================================= */
function defaultState() {
  return {
    settings: {
      calendars: [],           // {id, name, url, enabled, lastOk, lastErr, count}
      lookahead: 1,
      lookback: 2,
      includeAllDay: true,
      excludeWords: '',
      proxyMode: 'auto',
      customProxy: '',
      preferredProxy: '',
      autoSync: 15,
      passphrase: '',
      segments: DEFAULT_SEGMENTS.slice(),
    },
    tasks: {},                 // id -> {done, doneAt, awarded, hidden}
    manual: [],                // {id, title, date, createdAt}
    tickets: 0,
    stats: { completed: 0, spins: 0, wins: 0, ticketsEarned: 0 },
    history: [],               // {at, label, win}
    rotation: 0,
    lastSync: null,            // {at, ok, msg}
  };
}

function load(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch (_) { return fallback; }
}
function save(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { console.warn('save failed', e); }
}

const state = (() => {
  const d = defaultState();
  const s = load(STORE_KEY, null);
  if (!s) return d;
  return { ...d, ...s, settings: { ...d.settings, ...(s.settings || {}) }, stats: { ...d.stats, ...(s.stats || {}) } };
})();
let events = load(EVENTS_KEY, []);     // sự kiện đã đồng bộ
let files = load(FILES_KEY, []);       // {id, name, text}

const persist = () => save(STORE_KEY, state);

/* =========================================================
   HELPERS
   ========================================================= */
const $ = (s) => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const dateKey = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const keyToDate = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const hm = (ms) => new Date(ms).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
const WEEKDAYS = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
function dayLabel(key) {
  const d = keyToDate(key);
  const diff = Math.round((d - startOfDay(new Date())) / DAY);
  const base = `${WEEKDAYS[d.getDay()]}, ${d.getDate()}/${d.getMonth() + 1}`;
  if (diff === 0) return `Hôm nay · ${base}`;
  if (diff === 1) return `Ngày mai · ${base}`;
  if (diff === -1) return `Hôm qua · ${base}`;
  return base;
}
function relTime(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'vừa xong';
  if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
  if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
  return new Date(ms).toLocaleString('vi-VN');
}
function rand() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 4294967296;
}
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const logLines = [];
function log(msg) {
  const line = `[${new Date().toLocaleTimeString('vi-VN', { hour12: false })}] ${msg}`;
  logLines.push(line);
  if (logLines.length > 200) logLines.shift();
  const p = $('#syncLog');
  if (p) p.textContent = logLines.join('\n');
}
function haptic() { try { navigator.vibrate && navigator.vibrate(15); } catch (_) {} }

/* =========================================================
   TASKS
   ========================================================= */
function excludeList() {
  return state.settings.excludeWords.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function buildTasks() {
  const now = new Date();
  const today = startOfDay(now);
  const from = new Date(today.getTime() - state.settings.lookback * DAY);
  const to = new Date(today.getTime() + (state.settings.lookahead + 1) * DAY);
  const ex = excludeList();
  const list = [];

  for (const ev of events) {
    if (!state.settings.includeAllDay && ev.allDay) continue;
    if (ex.length && ex.some((w) => ev.title.toLowerCase().includes(w))) continue;
    if (ev.start >= to.getTime()) continue;
    if (ev.start < from.getTime() && ev.end <= from.getTime()) continue;
    // sự kiện lặp lại (vd: chạy bộ mỗi ngày) đã qua thì không tính là việc tồn đọng
    if (ev.recurring && ev.end <= today.getTime()) continue;
    let key = dateKey(ev.start);
    // sự kiện kéo dài nhiều ngày đã bắt đầu từ trước: gắn vào hôm nay nếu vẫn đang diễn ra
    if (ev.start < today.getTime() && ev.end > today.getTime()) key = dateKey(today);
    list.push({ ...ev, key, kind: 'cal' });
  }
  for (const m of state.manual) {
    const d = keyToDate(m.date);
    if (d < from || d >= to) {
      // việc thủ công cũ chưa xong vẫn hiển thị là quá hạn
      const st = state.tasks[m.id];
      if (!(d < from && !(st && st.done))) continue;
    }
    list.push({ id: m.id, title: m.title, start: d.getTime(), end: d.getTime() + DAY, allDay: true, key: m.date, kind: 'manual' });
  }
  return list;
}

function taskState(id) { return state.tasks[id] || {}; }

function setDone(task, done, node) {
  const st = state.tasks[task.id] || (state.tasks[task.id] = {});
  st.done = done;
  if (done) {
    st.doneAt = Date.now();
    state.stats.completed++;
    if (!st.awarded) {
      st.awarded = true;
      state.tickets++;
      state.stats.ticketsEarned++;
      toast('+1 vé 🎟️  Giỏi lắm!');
      bumpTicket();
      confettiBurst(node);
    } else {
      toast('Việc này đã nhận vé rồi');
    }
  }
  persist();
  haptic();
  renderTickets();
  renderTasks();
}

function hideTask(task, hidden) {
  const st = state.tasks[task.id] || (state.tasks[task.id] = {});
  st.hidden = hidden;
  persist();
  renderTasks();
  if (hidden) toast('Đã ẩn việc');
}

function deleteManual(task) {
  state.manual = state.manual.filter((m) => m.id !== task.id);
  delete state.tasks[task.id];
  persist();
  renderTasks();
}

function calColor(task) {
  if (task.kind === 'manual') return '#9c99b5';
  const gh = /^gh(\d+)$/.exec(task.calId || '');
  const idx = gh ? Number(gh[1]) : state.settings.calendars.findIndex((c) => c.id === task.calId);
  return CAL_COLORS[(idx < 0 ? 0 : idx) % CAL_COLORS.length];
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

function taskNode(task, { inHidden = false } = {}) {
  const st = taskState(task.id);
  const meta = [];
  if (task.kind === 'cal') {
    meta.push(el('span', {}, el('span', { class: 'dot', style: `background:${calColor(task)}` }), task.allDay ? 'Cả ngày' : `${hm(task.start)}–${hm(task.end)}`));
    if (task.location) meta.push(el('span', {}, '📍 ' + task.location.split('\n')[0]));
  } else {
    meta.push(el('span', {}, el('span', { class: 'dot', style: `background:${calColor(task)}` }), 'Việc thủ công'));
  }
  if (st.awarded) meta.push(el('span', { class: 'earned' }, '🎟️ đã nhận vé'));

  const node = el('div', { class: 'task' + (st.done ? ' done' : '') });
  const check = el('button', { class: 'check', 'aria-label': st.done ? 'Bỏ đánh dấu' : 'Hoàn thành', html: CHECK_SVG });
  check.addEventListener('click', () => {
    check.classList.add('pop');
    setDone(task, !st.done, check);
  });
  const actions = [];
  if (inHidden) {
    actions.push(el('button', { class: 'task-act', title: 'Hiện lại', 'aria-label': 'Hiện lại', onclick: () => hideTask(task, false) }, '↩︎'));
  } else if (task.kind === 'manual') {
    actions.push(el('button', { class: 'task-act', title: 'Xoá', 'aria-label': 'Xoá', onclick: () => { if (confirm(`Xoá “${task.title}”?`)) deleteManual(task); } }, '🗑'));
  } else {
    actions.push(el('button', { class: 'task-act', title: 'Ẩn (không phải việc cần làm)', 'aria-label': 'Ẩn', onclick: () => hideTask(task, true) }, '✕'));
  }
  node.append(check, el('div', { class: 'task-body' }, el('div', { class: 'task-title' }, task.title), el('div', { class: 'task-meta' }, meta)), ...actions);
  return node;
}

function renderTasks() {
  const all = buildTasks();
  const todayKey = dateKey(new Date());
  const visible = [];
  const hidden = [];
  for (const t of all) {
    const st = taskState(t.id);
    if (st.hidden) { hidden.push(t); continue; }
    // việc quá khứ đã xong thì không cần hiện nữa
    if (t.key < todayKey && st.done && dateKey(st.doneAt || 0) < todayKey) continue;
    visible.push(t);
  }
  const sorter = (a, b) => (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1) || a.start - b.start || a.title.localeCompare(b.title);
  const overdue = visible.filter((t) => t.key < todayKey).sort((a, b) => a.start - b.start);
  const byDay = new Map();
  for (const t of visible.filter((x) => x.key >= todayKey)) {
    if (!byDay.has(t.key)) byDay.set(t.key, []);
    byDay.get(t.key).push(t);
  }
  if (!byDay.has(todayKey)) byDay.set(todayKey, []);

  const list = $('#taskList');
  list.replaceChildren();
  if (overdue.length) {
    list.append(el('div', { class: 'group-title overdue' }, el('span', {}, '⏰ Chưa xong từ trước'), el('span', {}, String(overdue.length))));
    overdue.forEach((t) => list.append(taskNode(t)));
  }
  const keys = [...byDay.keys()].sort();
  for (const k of keys) {
    const items = byDay.get(k).sort(sorter);
    if (!items.length && k !== todayKey) continue;
    const doneN = items.filter((t) => taskState(t.id).done).length;
    list.append(el('div', { class: 'group-title' }, el('span', {}, dayLabel(k)), el('span', {}, items.length ? `${doneN}/${items.length}` : '')));
    if (!items.length) list.append(el('div', { class: 'task', style: 'justify-content:center;color:var(--muted);font-size:14px' }, 'Không có việc nào hôm nay 🎈'));
    items.forEach((t) => list.append(taskNode(t)));
  }

  // tiến độ hôm nay (+ quá hạn)
  const todays = (byDay.get(todayKey) || []).concat(overdue);
  const doneToday = todays.filter((t) => taskState(t.id).done).length;
  $('#progressNums').textContent = `${doneToday}/${todays.length} việc · ${state.stats.ticketsEarned} vé đã kiếm`;
  $('#progressFill').style.width = todays.length ? `${(doneToday / todays.length) * 100}%` : '0%';
  $('#progressLabel').textContent = todays.length && doneToday === todays.length ? 'Xong hết hôm nay! 🎉' : 'Tiến độ hôm nay';

  $('#emptyState').hidden = !(all.length === 0 && state.settings.calendars.length === 0 && files.length === 0 && !state.settings.passphrase);

  $('#hiddenWrap').hidden = hidden.length === 0;
  $('#hiddenCount').textContent = hidden.length;
  $('#hiddenList').replaceChildren(...hidden.sort((a, b) => a.start - b.start).map((t) => taskNode(t, { inHidden: true })));
}

/* =========================================================
   SYNC
   ========================================================= */
let syncing = false;

async function decryptBundle(pass) {
  const res = await fetch('calendar.enc.json?t=' + Date.now(), { cache: 'no-store' });
  if (res.status === 404) throw new Error('chưa có calendar.enc.json (GitHub Action chưa chạy hoặc chưa đặt secret)');
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64(j.salt), iterations: j.iter, hash: 'SHA-256' },
    keyMat, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(j.iv) }, key, b64(j.data));
  } catch (_) {
    throw new Error('sai mật khẩu giải mã');
  }
  return JSON.parse(new TextDecoder().decode(plain)); // {generatedAt, calendars:[{name, ics}]}
}

function syncRange() {
  const today = startOfDay(new Date());
  return [new Date(today.getTime() - (state.settings.lookback + 1) * DAY), new Date(today.getTime() + (state.settings.lookahead + 2) * DAY)];
}

async function syncAll({ silent = false } = {}) {
  if (syncing) return;
  const s = state.settings;
  const sources = s.calendars.filter((c) => c.enabled);
  if (!sources.length && !files.length && !s.passphrase) {
    events = [];
    save(EVENTS_KEY, events);
    renderTasks();
    renderSyncStatus();
    return;
  }
  syncing = true;
  $('#syncBtn').classList.add('spinning');
  $('#syncStatus').textContent = 'Đang đồng bộ…';
  $('#syncStatus').classList.remove('err');
  const [from, to] = syncRange();
  const next = [];
  const errs = [];
  let okCount = 0;
  let via = '';

  // 1) gói mã hoá từ GitHub Action (ổn định nhất). Nếu được thì không cần proxy.
  let ghOk = false;
  if (s.passphrase) {
    try {
      const bundle = await decryptBundle(s.passphrase);
      bundle.calendars.forEach((c, i) => {
        const cid = 'gh' + i;
        next.push(...parseIcs(c.ics, from, to).map((e) => ({ ...e, calId: cid, calName: c.name })));
      });
      ghOk = true;
      s.ghLastErr = '';
      okCount++;
      s.ghGeneratedAt = bundle.generatedAt;
      via = `GitHub · lịch lúc ${hm(bundle.generatedAt)}`;
      log(`GitHub: ${bundle.calendars.length} lịch (${bundle.calendars.map((c) => c.name).join(', ')}), tạo lúc ${new Date(bundle.generatedAt).toLocaleString('vi-VN')}`);
    } catch (e) {
      s.ghLastErr = e.message;
      errs.push('GitHub: ' + e.message);
      log('GitHub: LỖI ' + e.message);
      next.push(...events.filter((x) => String(x.calId).startsWith('gh')));
    }
  }

  // 2) link lịch qua proxy (chỉ khi chưa có GitHub)
  if (!ghOk) {
    await Promise.all(sources.map(async (cal) => {
      log(`Tải “${cal.name}”…`);
      try {
        const { text, via: v } = await fetchIcs(cal.url, {
          mode: s.proxyMode, customProxy: s.customProxy, log: (m) => log(`  ${cal.name}: ${m}`),
        });
        via = v;
        const evs = parseIcs(text, from, to).map((e) => ({ ...e, calId: cal.id }));
        if (!cal.name || cal.name === 'Lịch') cal.name = calendarName(text) || cal.name;
        next.push(...evs);
        cal.lastOk = Date.now(); cal.lastErr = ''; cal.count = evs.length;
        okCount++;
        log(`  ${cal.name}: ${evs.length} sự kiện trong khoảng`);
      } catch (e) {
        cal.lastErr = e.message;
        errs.push(`${cal.name}: ${e.message}`);
        log(`  ${cal.name}: LỖI ${e.message}`);
        next.push(...events.filter((x) => x.calId === cal.id));
      }
    }));
  } else {
    sources.forEach((cal) => { cal.lastErr = ''; });
  }

  // 3) file .ics đã nhập
  for (const f of files) {
    try {
      next.push(...parseIcs(f.text, from, to).map((e) => ({ ...e, calId: f.id })));
      okCount++;
    } catch (e) {
      errs.push(`${f.name}: ${e.message}`);
    }
  }

  // bỏ trùng (cùng sự kiện từ nhiều nguồn)
  const seen = new Set();
  events = next.filter((e) => (seen.has(e.id) ? false : seen.add(e.id)));
  save(EVENTS_KEY, events);
  state.lastSync = { at: Date.now(), ok: errs.length === 0, msg: errs.join(' | '), via, okCount };
  persist();
  syncing = false;
  $('#syncBtn').classList.remove('spinning');
  renderTasks();
  renderSyncStatus();
  renderSettings();
  if (!silent) toast(errs.length ? (ghOk ? 'Đồng bộ có lỗi — xem Cài đặt' : 'Không tải được lịch — dùng “Đồng bộ qua GitHub” trong Cài đặt') : `Đã đồng bộ ${events.length} sự kiện`, errs.length ? 4000 : 2200);
}

function renderSyncStatus() {
  const s = $('#syncStatus');
  const ls = state.lastSync;
  if (!ls) { s.textContent = state.settings.calendars.length ? 'Chưa đồng bộ' : 'Chưa kết nối lịch'; return; }
  s.classList.toggle('err', !ls.ok);
  s.textContent = ls.ok
    ? `Đồng bộ ${relTime(ls.at)}${ls.via ? ' · ' + ls.via : ''}`
    : `⚠️ Lỗi đồng bộ (${relTime(ls.at)}) — chạm để xem cách sửa`;
}

/* =========================================================
   TICKETS / WHEEL
   ========================================================= */
function renderTickets() {
  $('#ticketCount').textContent = state.tickets;
  const b = $('#tabBadge');
  b.hidden = state.tickets <= 0;
  b.textContent = state.tickets;
  const btn = $('#spinBtn');
  if (!spinning) btn.disabled = state.tickets <= 0;
  $('#wheelHint').textContent = spinning ? 'Đang quay…' : state.tickets > 0 ? `Bạn có ${state.tickets} vé — chạm QUAY!` : 'Hết vé rồi. Hoàn thành thêm việc để nhận vé nhé!';
}
function bumpTicket() {
  const p = $('#ticketPill');
  p.classList.remove('bump'); void p.offsetWidth; p.classList.add('bump');
}

function segments() {
  const s = (state.settings.segments || []).map((x) => String(x).trim()).filter(Boolean);
  return s.length >= 2 ? s : DEFAULT_SEGMENTS;
}
const isLose = (label) => /may mắn lần sau|trượt|không trúng|hụt/i.test(label);
const minutesOf = (label) => { const m = /^\s*(\d+)\s*(p|ph|phút|m|min)\b/i.exec(label); return m ? Number(m[1]) : 0; };
function emojiFor(label) {
  if (/tiktok/i.test(label)) return '📱';
  if (/truyện|đọc|sách/i.test(label)) return '📖';
  if (isLose(label)) return '🍀';
  return '🎁';
}

function drawWheel() {
  const c = $('#wheel');
  const ctx = c.getContext('2d');
  const segs = segments();
  const W = c.width, R = W / 2;
  ctx.clearRect(0, 0, W, W);
  const n = segs.length;
  const arc = (Math.PI * 2) / n;
  // màu: ô “may mắn lần sau” dùng tông tím, phần thưởng dùng màu nổi
  let rewardIdx = 0, loseIdx = 0;
  const loseColors = ['#6d5dfc', '#4c6ef5', '#7950f2', '#5c7cfa'];
  const rewardColors = ['#ff5c8a', '#20c997', '#ffa94d', '#be4bdb', '#15aabf', '#fab005'];
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i * arc;
    const color = isLose(segs[i]) ? loseColors[loseIdx++ % loseColors.length] : rewardColors[rewardIdx++ % rewardColors.length];
    ctx.beginPath();
    ctx.moveTo(R, R);
    ctx.arc(R, R, R - 6, a0, a0 + arc);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.9)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // chữ
    ctx.save();
    ctx.translate(R, R);
    ctx.rotate(a0 + arc / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    const label = segs[i];
    const maxW = R * 0.62;
    let size = n > 6 ? 26 : 32;
    ctx.font = `800 ${size}px -apple-system, system-ui, sans-serif`;
    const lines = wrapText(ctx, label, maxW);
    if (lines.length > 2) { size = 24; ctx.font = `800 ${size}px -apple-system, system-ui, sans-serif`; }
    const ls = wrapText(ctx, label, maxW).slice(0, 3);
    const lh = size * 1.1;
    ls.forEach((ln, j) => ctx.fillText(ln, R - 34, (j - (ls.length - 1) / 2) * lh));
    ctx.restore();
  }
  // viền
  ctx.beginPath();
  ctx.arc(R, R, R - 4, 0, Math.PI * 2);
  ctx.lineWidth = 8;
  ctx.strokeStyle = '#fff';
  ctx.stroke();
  // chấm đèn
  for (let i = 0; i < n * 3; i++) {
    const a = (i / (n * 3)) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(R + Math.cos(a) * (R - 14), R + Math.sin(a) * (R - 14), 4, 0, Math.PI * 2);
    ctx.fillStyle = i % 2 ? '#ffe066' : '#fff';
    ctx.fill();
  }
  c.style.transform = `rotate(${state.rotation}deg)`;

  // tỉ lệ
  const counts = new Map();
  segs.forEach((s) => counts.set(s, (counts.get(s) || 0) + 1));
  $('#odds').replaceChildren(...[...counts].map(([k, v]) => el('span', {}, `${emojiFor(k)} ${k}: ${v} ô · ${Math.round((v / n) * 100)}%`)));
}
function wrapText(ctx, text, maxW) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

let spinning = false;
function spin() {
  if (spinning) return;
  if (state.tickets <= 0) { toast('Hết vé! Hoàn thành việc để nhận vé 🎟️'); return; }
  const segs = segments();
  const n = segs.length;
  const idx = Math.floor(rand() * n);
  const seg = 360 / n;
  const jitter = (rand() - 0.5) * seg * 0.7;
  const target = ((360 - (idx * seg + seg / 2 + jitter)) % 360 + 360) % 360;
  const cur = state.rotation;
  const delta = ((target - (cur % 360)) + 360) % 360;
  const final = cur + 360 * (6 + Math.floor(rand() * 3)) + delta;

  // trừ vé ngay khi quay (tránh đóng app giữa chừng để gian lận)
  state.tickets--;
  state.stats.spins++;
  const label = segs[idx];
  const win = !isLose(label);
  if (win) state.stats.wins++;
  state.history.unshift({ at: Date.now(), label, win });
  state.history = state.history.slice(0, 50);
  state.rotation = final % 3600; // tránh số quá lớn (giữ đồng dư)
  const visualFinal = final;
  persist();

  spinning = true;
  $('#spinBtn').disabled = true;
  renderTickets();
  const c = $('#wheel');
  c.style.transition = 'none';
  c.style.transform = `rotate(${cur}deg)`;
  void c.offsetWidth;
  c.style.transition = 'transform 5.2s cubic-bezier(.12,.65,.08,1)';
  c.style.transform = `rotate(${visualFinal}deg)`;
  tickSound(5200);
  setTimeout(() => {
    c.style.transition = 'none';
    c.style.transform = `rotate(${state.rotation}deg)`;
    spinning = false;
    renderTickets();
    renderHistory();
    showResult(label, win);
  }, 5300);
}

function showResult(label, win) {
  const mins = minutesOf(label);
  $('#resultEmoji').textContent = win ? emojiFor(label) : '🍀';
  $('#resultTitle').textContent = win ? 'Trúng rồi! 🎉' : 'Tiếc quá!';
  $('#resultText').textContent = win ? `Phần thưởng: ${label}. Tận hưởng đi, bạn xứng đáng!` : `${label}. Làm thêm việc để có vé mới nhé 💪`;
  const tb = $('#startTimerBtn');
  tb.hidden = !(win && mins > 0);
  tb.textContent = `▶︎ Bắt đầu ${mins} phút`;
  tb.onclick = () => { closeModal('#resultModal'); startTimer(mins, label); };
  openModal('#resultModal');
  if (win) { confettiBurst(null, 160); chime(); }
}

function renderHistory() {
  const ul = $('#history');
  if (!state.history.length) { ul.replaceChildren(el('li', { class: 'none' }, 'Chưa quay lần nào')); return; }
  ul.replaceChildren(...state.history.slice(0, 20).map((h) =>
    el('li', { class: h.win ? 'win' : '' }, el('span', {}, `${h.win ? emojiFor(h.label) : '🍀'} ${h.label}`), el('span', { class: 'when' }, relTime(h.at)))));
}

/* ---------- timer ---------- */
let timer = null;
function startTimer(mins, label) {
  const endAt = Date.now() + mins * 60000;
  timer = { endAt, remaining: mins * 60000, paused: false, label };
  try { localStorage.setItem('vieccve.timer', JSON.stringify(timer)); } catch (_) {}
  $('#timerLabel').textContent = `${emojiFor(label)} ${label}`;
  $('#timerPauseBtn').textContent = 'Tạm dừng';
  openModal('#timerModal');
  tickTimer();
}
function tickTimer() {
  if (!timer) return;
  const left = timer.paused ? timer.remaining : Math.max(0, timer.endAt - Date.now());
  const s = Math.ceil(left / 1000);
  $('#timerDisplay').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  if (left <= 0) {
    stopTimer();
    chime(true);
    $('#resultEmoji').textContent = '⏰';
    $('#resultTitle').textContent = 'Hết giờ!';
    $('#resultText').textContent = 'Quay lại làm việc tiếp nào 💪 Làm xong lại có vé mới.';
    $('#startTimerBtn').hidden = true;
    openModal('#resultModal');
    return;
  }
  timer.raf = setTimeout(tickTimer, 250);
}
function stopTimer() {
  if (timer) clearTimeout(timer.raf);
  timer = null;
  try { localStorage.removeItem('vieccve.timer'); } catch (_) {}
  closeModal('#timerModal');
}
function resumeTimer() {
  const t = load('vieccve.timer', null);
  if (!t) return;
  if (!t.paused && t.endAt <= Date.now()) { localStorage.removeItem('vieccve.timer'); return; }
  timer = t;
  $('#timerLabel').textContent = `${emojiFor(t.label)} ${t.label}`;
  $('#timerPauseBtn').textContent = t.paused ? 'Tiếp tục' : 'Tạm dừng';
  openModal('#timerModal');
  tickTimer();
}

/* ---------- sound ---------- */
let audioCtx;
function ac() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch (_) {}
  return audioCtx;
}
function beep(freq, at, dur = 0.08, vol = 0.08, type = 'triangle') {
  const a = ac(); if (!a) return;
  const o = a.createOscillator(); const g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, a.currentTime + at);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + at + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + at); o.stop(a.currentTime + at + dur + 0.02);
}
function tickSound(totalMs) {
  // tiếng tách chậm dần theo vòng quay
  const n = 34;
  for (let i = 0; i < n; i++) {
    const p = i / n;
    const t = (1 - Math.pow(1 - p, 0.35)) * (totalMs / 1000) * 0.98;
    beep(900, t, 0.03, 0.04, 'square');
  }
}
function chime(long = false) {
  [523, 659, 784, 1046].forEach((f, i) => beep(f, i * 0.12, long ? 0.4 : 0.25, 0.09));
  if (long) [523, 659, 784, 1046].forEach((f, i) => beep(f, 0.7 + i * 0.12, 0.4, 0.09));
}

/* ---------- confetti ---------- */
let particles = [];
let confettiRunning = false;
function confettiBurst(node, count = 60) {
  let ox = innerWidth / 2, oy = innerHeight / 2.5;
  if (node && node.getBoundingClientRect) { const r = node.getBoundingClientRect(); ox = r.left + r.width / 2; oy = r.top + r.height / 2; }
  for (let i = 0; i < count; i++) {
    particles.push({
      x: ox, y: oy,
      vx: (Math.random() - 0.5) * 12, vy: -Math.random() * 11 - 3,
      s: Math.random() * 6 + 4, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4,
      c: SEG_COLORS[Math.floor(Math.random() * SEG_COLORS.length)], life: 0,
    });
  }
  if (confettiRunning) return;
  confettiRunning = true;
  const cv = $('#confetti');
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  (function loop() {
    if (cv.width !== innerWidth * dpr || cv.height !== innerHeight * dpr) { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of particles) {
      p.life++; p.vy += 0.35; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c; ctx.globalAlpha = Math.max(0, 1 - p.life / 90);
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore();
    }
    particles = particles.filter((p) => p.life < 90 && p.y < innerHeight + 40);
    if (particles.length) requestAnimationFrame(loop);
    else { ctx.clearRect(0, 0, innerWidth, innerHeight); confettiRunning = false; }
  })();
}

/* =========================================================
   MODALS / NAV
   ========================================================= */
function openModal(sel) { $(sel).hidden = false; }
function closeModal(sel) { $(sel).hidden = true; }

const TITLES = { tasks: 'Việc cần làm', wheel: 'Vòng quay', settings: 'Cài đặt' };
function go(view) {
  if (!TITLES[view]) view = 'tasks';
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + view));
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $('#pageTitle').textContent = TITLES[view];
  if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  if (view === 'wheel') { drawWheel(); renderHistory(); }
  if (view === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}

/* =========================================================
   SETTINGS UI
   ========================================================= */
function renderSettings() {
  const s = state.settings;
  const ul = $('#calList');
  ul.replaceChildren(...s.calendars.map((c, i) => {
    const toggle = el('input', { type: 'checkbox', 'aria-label': 'Bật/tắt' });
    toggle.checked = c.enabled;
    toggle.addEventListener('change', () => { c.enabled = toggle.checked; persist(); syncAll({ silent: true }); });
    const stateTxt = c.lastErr ? el('div', { class: 'cal-state err' }, '⚠️ ' + c.lastErr)
      : c.lastOk ? el('div', { class: 'cal-state ok' }, `✓ ${c.count ?? 0} sự kiện · ${relTime(c.lastOk)}`) : null;
    return el('li', {},
      toggle,
      el('div', { class: 'cal-info' },
        el('div', { class: 'cal-name' }, el('span', { class: 'dot', style: `display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${CAL_COLORS[i % CAL_COLORS.length]}` }), c.name),
        el('div', { class: 'cal-url' }, c.url), stateTxt),
      el('button', { class: 'task-act', title: 'Xoá lịch', 'aria-label': 'Xoá lịch', onclick: () => {
        if (!confirm(`Xoá lịch “${c.name}”?`)) return;
        s.calendars = s.calendars.filter((x) => x.id !== c.id);
        events = events.filter((e) => e.calId !== c.id);
        save(EVENTS_KEY, events); persist(); renderSettings(); renderTasks();
      } }, '🗑'));
  }));
  $('#fileList').replaceChildren(...files.map((f) => el('li', {},
    el('div', { class: 'cal-info' }, el('div', { class: 'cal-name' }, '📄 ' + f.name), el('div', { class: 'cal-url' }, `Nhập lúc ${new Date(f.at).toLocaleString('vi-VN')}`)),
    el('button', { class: 'task-act', title: 'Xoá', onclick: () => {
      files = files.filter((x) => x.id !== f.id); save(FILES_KEY, files);
      events = events.filter((e) => e.calId !== f.id); save(EVENTS_KEY, events);
      renderSettings(); renderTasks();
    } }, '🗑'))));

  const setVal = (id, v) => { const n = $(id); if (document.activeElement !== n) n.value = v; };
  setVal('#lookahead', s.lookahead);
  setVal('#lookback', s.lookback);
  $('#includeAllDay').checked = s.includeAllDay;
  setVal('#excludeWords', s.excludeWords);
  setVal('#proxyMode', s.proxyMode);
  setVal('#customProxy', s.customProxy);
  $('#customProxyRow').hidden = s.proxyMode !== 'custom';
  setVal('#autoSync', s.autoSync);
  setVal('#passphrase', s.passphrase);
  renderGithub();
  setVal('#segments', segments().join('\n'));
  $('#versionInfo').textContent = `Phiên bản ${APP_VERSION} · ${state.stats.completed} lần hoàn thành · ${state.stats.spins} lượt quay · ${state.stats.wins} lần trúng`;
  $('#syncLog').textContent = logLines.join('\n') || (state.lastSync && state.lastSync.msg) || 'Chưa có';
}

/* ---------- GitHub sync helper ---------- */
function repoInfo() {
  const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  if (m && repo) return { owner: m[1], repo };
  return { owner: 'phuociii', repo: 'to-do' };
}
function randomPass() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_');
}
function renderGithub() {
  const s = state.settings;
  const { owner, repo } = repoInfo();
  $('#ghSecretLink').href = `https://github.com/${owner}/${repo}/settings/secrets/actions/new`;
  $('#ghRunLink').href = `https://github.com/${owner}/${repo}/actions/workflows/pages.yml`;
  $('#ghUrls').value = s.calendars.map((c) => `${c.name} | ${c.url}`).join('\n');
  $('#ghPass').value = s.passphrase || '';
  const st = $('#ghStatus');
  const btn = $('#ghSetupBtn');
  if (!s.passphrase) {
    st.hidden = true;
    btn.textContent = 'Thiết lập (copy–dán 2 lần)';
    return;
  }
  st.hidden = false;
  if (s.ghLastErr === '' && s.ghGeneratedAt) {
    st.className = 'gh-status ok';
    st.textContent = `✓ Đang đồng bộ qua GitHub · lịch cập nhật lúc ${new Date(s.ghGeneratedAt).toLocaleString('vi-VN')}`;
    btn.textContent = 'Xem lại hướng dẫn / secret';
  } else if (s.ghLastErr && /mật khẩu/.test(s.ghLastErr)) {
    st.className = 'gh-status err';
    st.textContent = '⚠️ Sai mật khẩu: secret CAL_PASSPHRASE trên GitHub khác với mật khẩu trong app.';
    btn.textContent = 'Xem lại secret';
  } else {
    st.className = 'gh-status';
    st.textContent = '⏳ Chưa có dữ liệu từ GitHub. Làm các bước bên dưới rồi bấm “Đồng bộ ngay”.';
    btn.textContent = 'Xem lại hướng dẫn / secret';
    $('#ghSteps').hidden = false;
  }
}
async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const t = el('textarea', {}, text);
    document.body.append(t); t.select();
    try { document.execCommand('copy'); } catch (_) {}
    t.remove();
  }
  toast(`Đã copy ${label}`);
}
function bindGithub() {
  const s = state.settings;
  $('#ghSetupBtn').addEventListener('click', () => {
    if (!s.calendars.length) { toast('Thêm link lịch ở mục “Lịch Apple” trước'); $('#calUrl').focus(); return; }
    if (!s.passphrase) { s.passphrase = randomPass(); persist(); }
    renderGithub();
    $('#ghSteps').hidden = false;
    $('#ghSteps').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#ghSyncBtn').addEventListener('click', () => syncAll());
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => copyText(b.dataset.copy, 'tên')));
  document.querySelectorAll('[data-copy-from]').forEach((b) => b.addEventListener('click', () => copyText($('#' + b.dataset.copyFrom).value, 'giá trị')));
}

function bindSettings() {
  const s = state.settings;
  $('#calForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = normalizeUrl($('#calUrl').value);
    if (!/^https?:\/\/[^/]+\..+/.test(url) && !/^http:\/\/127/.test(url)) { toast('Link không hợp lệ'); return; }
    if (s.calendars.some((c) => normalizeUrl(c.url) === url)) { toast('Lịch này đã có rồi'); return; }
    const warn = urlWarning(url);
    if (warn && !confirm(warn + '\n\nVẫn thêm link này?')) return;
    s.calendars.push({ id: uid(), name: $('#calName').value.trim() || 'Lịch', url: $('#calUrl').value.trim(), enabled: true });
    $('#calName').value = ''; $('#calUrl').value = '';
    persist(); renderSettings();
    syncAll().then(() => { if (state.lastSync && state.lastSync.ok) go('tasks'); });
  });
  const num = (id, key, min, max) => $(id).addEventListener('change', () => {
    const v = Math.max(min, Math.min(max, parseInt($(id).value, 10) || 0));
    s[key] = v; $(id).value = v; persist();
    if (key === 'autoSync') scheduleAutoSync(); else syncAll({ silent: true });
  });
  num('#lookahead', 'lookahead', 0, 60);
  num('#lookback', 'lookback', 0, 60);
  num('#autoSync', 'autoSync', 0, 240);
  $('#includeAllDay').addEventListener('change', (e) => { s.includeAllDay = e.target.checked; persist(); renderTasks(); });
  $('#excludeWords').addEventListener('change', (e) => { s.excludeWords = e.target.value; persist(); renderTasks(); });
  $('#proxyMode').addEventListener('change', (e) => { s.proxyMode = e.target.value; persist(); renderSettings(); });
  $('#customProxy').addEventListener('change', (e) => { s.customProxy = e.target.value.trim(); persist(); });
  $('#passphrase').addEventListener('change', (e) => { s.passphrase = e.target.value; persist(); syncAll(); });
  $('#segments').addEventListener('change', (e) => {
    const lines = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) { toast('Cần ít nhất 2 ô'); renderSettings(); return; }
    s.segments = lines.slice(0, 16); persist(); toast('Đã lưu vòng quay');
  });
  $('#segReset').addEventListener('click', () => { s.segments = DEFAULT_SEGMENTS.slice(); persist(); renderSettings(); toast('Đã khôi phục'); });

  $('#icsFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    if (!text.includes('BEGIN:VCALENDAR')) { toast('File không phải lịch .ics'); return; }
    files.push({ id: 'f' + uid(), name: calendarName(text) || f.name, text, at: Date.now() });
    save(FILES_KEY, files);
    e.target.value = '';
    await syncAll();
    renderSettings();
  });

  $('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ app: 'viec-va-ve', version: APP_VERSION, state, files }, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `viec-va-ve-${dateKey(new Date())}.json` });
    document.body.append(a); a.click(); a.remove();
  });
  $('#importFile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!j.state) throw new Error('sai định dạng');
      if (!confirm('Nhập sao lưu sẽ ghi đè dữ liệu hiện tại. Tiếp tục?')) return;
      save(STORE_KEY, j.state); save(FILES_KEY, j.files || []);
      location.reload();
    } catch (err) { toast('Không đọc được file: ' + err.message); }
  });
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Xoá toàn bộ việc, vé, lịch đã lưu?')) return;
    [STORE_KEY, EVENTS_KEY, FILES_KEY, 'vieccve.timer'].forEach((k) => localStorage.removeItem(k));
    location.reload();
  });
}

/* =========================================================
   AUTO SYNC + INIT
   ========================================================= */
let autoTimer;
function scheduleAutoSync() {
  clearInterval(autoTimer);
  const m = state.settings.autoSync;
  if (m > 0) autoTimer = setInterval(() => { if (document.visibilityState === 'visible') syncAll({ silent: true }); }, m * 60000);
}

function maybeSyncOnFocus() {
  const ls = state.lastSync;
  const m = Math.max(1, state.settings.autoSync || 5);
  if (!ls || Date.now() - ls.at > m * 60000) syncAll({ silent: true });
  else { renderTasks(); renderSyncStatus(); }
}

function init() {
  // tabs
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.view)));
  document.querySelectorAll('[data-goto]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); go(a.dataset.goto); }));
  $('#ticketPill').addEventListener('click', () => go('wheel'));
  $('#syncBtn').addEventListener('click', () => syncAll());
  $('#syncStatus').addEventListener('click', () => {
    if (state.lastSync && !state.lastSync.ok) { go('settings'); setTimeout(() => $('#ghCard').scrollIntoView({ behavior: 'smooth' }), 50); }
  });

  // thêm việc thủ công
  $('#addDate').value = dateKey(new Date());
  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = $('#addTitle').value.trim();
    if (!title) return;
    state.manual.push({ id: 'm' + uid(), title, date: $('#addDate').value || dateKey(new Date()), createdAt: Date.now() });
    $('#addTitle').value = '';
    persist(); renderTasks(); toast('Đã thêm việc');
  });

  // wheel
  $('#spinBtn').addEventListener('click', () => { ac(); spin(); });
  $('#closeResultBtn').addEventListener('click', () => closeModal('#resultModal'));
  $('#timerStopBtn').addEventListener('click', () => { if (confirm('Kết thúc phần thưởng sớm?')) stopTimer(); });
  $('#timerPauseBtn').addEventListener('click', () => {
    if (!timer) return;
    if (timer.paused) { timer.endAt = Date.now() + timer.remaining; timer.paused = false; $('#timerPauseBtn').textContent = 'Tạm dừng'; }
    else { timer.remaining = Math.max(0, timer.endAt - Date.now()); timer.paused = true; $('#timerPauseBtn').textContent = 'Tiếp tục'; }
    try { const { raf, ...t } = timer; localStorage.setItem('vieccve.timer', JSON.stringify(t)); } catch (_) {}
  });

  bindSettings();
  bindGithub();
  renderTickets();
  renderTasks();
  renderSyncStatus();
  go((location.hash || '#tasks').slice(1));
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));
  resumeTimer();
  scheduleAutoSync();
  syncAll({ silent: true });

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') maybeSyncOnFocus(); });
  // đổi ngày lúc nửa đêm
  let lastDay = dateKey(new Date());
  setInterval(() => { const d = dateKey(new Date()); if (d !== lastDay) { lastDay = d; $('#addDate').value = d; syncAll({ silent: true }); } renderSyncStatus(); }, 60000);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
}

init();
