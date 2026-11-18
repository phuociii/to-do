// Tải và đọc lịch .ics (Apple iCloud / Google / bất kỳ nguồn iCalendar nào).
/* global ICAL */

// Proxy công cộng (dự phòng). Không ổn định — cách chắc chắn là đồng bộ qua GitHub.
const PUBLIC_PROXIES = [
  { name: 'allorigins', make: (u) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
  { name: 'allorigins-json', make: (u) => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`, json: 'contents' },
  { name: 'codetabs', make: (u) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(u)}` },
  { name: 'cors.lol', make: (u) => `https://api.cors.lol/?url=${encodeURIComponent(u)}` },
  { name: 'whateverorigin', make: (u) => `https://whateverorigin.org/get?url=${encodeURIComponent(u)}`, json: 'contents' },
];

export function normalizeUrl(raw) {
  let u = String(raw || '').trim();
  if (!u) return '';
  u = u.replace(/^webcals?:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u;
}

/** Cảnh báo nếu link không phải link lịch công khai (.ics) */
export function urlWarning(raw) {
  const u = normalizeUrl(raw);
  if (/icloud\.com\/calendar\//i.test(u) || /icloud\.com\/(#|share)/i.test(u)) {
    return 'Đây là link mời chia sẻ, không phải link “Lịch công khai”. Hãy bật “Lịch công khai” rồi sao chép link bắt đầu bằng webcal://';
  }
  if (/icloud\.com/i.test(u) && !/\/published\//i.test(u)) {
    return 'Link iCloud công khai thường có dạng webcal://pXX-caldav.icloud.com/published/2/…';
  }
  return '';
}

async function fetchText(url, timeoutMs, jsonField) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store', redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    if (jsonField) {
      const j = await res.json();
      return String(j[jsonField] || '');
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function looksLikeIcs(text) {
  return typeof text === 'string' && text.indexOf('BEGIN:VCALENDAR') !== -1;
}

const errMsg = (e) => (e && e.name === 'AbortError' ? 'quá thời gian' : (e && e.message) || String(e));

/**
 * Tải nội dung .ics. Trả về { text, via }.
 * Thử tất cả cách cùng lúc, lấy kết quả hợp lệ đầu tiên.
 * opts: { mode: 'auto'|'direct'|'custom', customProxy, log }
 */
export async function fetchIcs(rawUrl, opts = {}) {
  const url = normalizeUrl(rawUrl);
  const log = opts.log || (() => {});
  const direct = { name: 'trực tiếp', make: (u) => u, timeout: 10000 };
  let candidates;
  if (opts.mode === 'custom' && opts.customProxy) {
    const tpl = opts.customProxy.trim();
    candidates = [{
      name: 'proxy riêng',
      make: (u) => (tpl.includes('{url}') ? tpl.replace('{url}', encodeURIComponent(u)) : tpl + encodeURIComponent(u)),
    }];
  } else if (opts.mode === 'direct') {
    candidates = [direct];
  } else {
    candidates = [direct, ...PUBLIC_PROXIES];
  }
  const attempts = candidates.map(async (c) => {
    try {
      const text = await fetchText(c.make(url), c.timeout || 25000, c.json);
      if (!looksLikeIcs(text)) throw new Error(/<html/i.test(text) ? 'trả về trang web, không phải lịch' : 'không phải dữ liệu lịch');
      log(`✓ ${c.name}`);
      return { text, via: c.name };
    } catch (e) {
      log(`✗ ${c.name}: ${errMsg(e)}`);
      throw new Error(`${c.name}: ${errMsg(e)}`);
    }
  });
  try {
    return await Promise.any(attempts);
  } catch (agg) {
    const msgs = (agg.errors || []).map((e) => e.message);
    const warn = urlWarning(rawUrl);
    throw new Error((warn ? warn + ' — ' : '') + 'Không tải được lịch (' + msgs.join('; ') + ')');
  }
}

/** Tên lịch trong file (X-WR-CALNAME) */
export function calendarName(text) {
  const m = /X-WR-CALNAME[^:]*:(.*)/i.exec(text || '');
  return m ? m[1].trim().replace(/\\,/g, ',') : '';
}

/**
 * Đọc .ics và trả về các lần xuất hiện sự kiện trong khoảng [rangeStart, rangeEnd).
 * Mỗi phần tử: { id, uid, title, start, end, allDay, location, notes }
 */
export function parseIcs(text, rangeStart, rangeEnd) {
  const jcal = ICAL.parse(text);
  const vcal = new ICAL.Component(jcal);

  for (const tz of vcal.getAllSubcomponents('vtimezone')) {
    try {
      const tzid = tz.getFirstPropertyValue('tzid');
      if (tzid && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(tz);
    } catch (_) { /* bỏ qua múi giờ lỗi */ }
  }

  const vevents = vcal.getAllSubcomponents('vevent');
  const masters = new Map();
  const exceptions = [];
  for (const ve of vevents) {
    const uid = ve.getFirstPropertyValue('uid') || Math.random().toString(36).slice(2);
    if (ve.hasProperty('recurrence-id')) exceptions.push(ve);
    else masters.set(uid, new ICAL.Event(ve));
  }
  for (const ex of exceptions) {
    const uid = ex.getFirstPropertyValue('uid');
    const master = masters.get(uid);
    if (master) {
      try { master.relateException(ex); } catch (_) { /* ignore */ }
    } else {
      masters.set(uid + '#' + Math.random(), new ICAL.Event(ex));
    }
  }

  const out = [];
  const startMs = rangeStart.getTime();
  const endMs = rangeEnd.getTime();

  const push = (ev, startTime, endTime, uid, idKey, recurring = false) => {
    if (!startTime) return;
    const status = (ev.component.getFirstPropertyValue('status') || '').toString().toUpperCase();
    if (status === 'CANCELLED') return;
    const allDay = startTime.isDate;
    const s = startTime.toJSDate().getTime();
    let e = endTime ? endTime.toJSDate().getTime() : s + (allDay ? 86400000 : 0);
    if (e < s) e = s;
    // sự kiện giao với khoảng thời gian
    if (s >= endMs) return;
    if (Math.max(e, s + 1) <= startMs) return;
    out.push({
      id: `${uid}@${idKey || startTime.toString()}`,
      uid,
      title: (ev.summary || '(Không tiêu đề)').trim(),
      start: s,
      end: e,
      allDay,
      location: ev.location || '',
      recurring,
    });
  };

  for (const [key, ev] of masters) {
    const uid = ev.uid || key;
    try {
      if (ev.isRecurring()) {
        const it = ev.iterator();
        let next;
        let guard = 0;
        while ((next = it.next()) && guard++ < 5000) {
          const nextMs = next.toJSDate().getTime();
          if (nextMs >= endMs) break;
          const d = ev.getOccurrenceDetails(next);
          // bỏ qua lần xuất hiện quá xa trong quá khứ (để nhanh)
          if (d.endDate && d.endDate.toJSDate().getTime() < startMs - 86400000) continue;
          push(d.item, d.startDate, d.endDate, uid, d.recurrenceId && d.recurrenceId.toString(), true);
        }
      } else {
        push(ev, ev.startDate, ev.endDate, uid);
      }
    } catch (e) {
      console.warn('Lỗi đọc sự kiện', uid, e);
    }
  }
  return out;
}
