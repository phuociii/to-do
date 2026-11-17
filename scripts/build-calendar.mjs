// Chạy trong GitHub Actions: tải các lịch .ics (secret ICS_URLS), mã hoá AES-256-GCM
// bằng CAL_PASSPHRASE và ghi ra file JSON để web app tự giải mã.
// Dùng: ICS_URLS="..." CAL_PASSPHRASE="..." node scripts/build-calendar.mjs _site/calendar.enc.json
import { webcrypto as crypto } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const out = process.argv[2] || 'calendar.enc.json';
const pass = process.env.CAL_PASSPHRASE || '';
const lines = (process.env.ICS_URLS || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
if (!pass || !lines.length) {
  console.log('Chưa đặt ICS_URLS / CAL_PASSPHRASE — bỏ qua.');
  process.exit(0);
}

const calendars = [];
for (const [i, line] of lines.entries()) {
  // định dạng: "Tên | url" hoặc chỉ "url"
  const parts = line.split('|').map((s) => s.trim());
  const url = (parts.length > 1 ? parts[1] : parts[0]).replace(/^webcals?:\/\//i, 'https://');
  const name = parts.length > 1 ? parts[0] : `Lịch ${i + 1}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (calendar-sync)' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ics = await res.text();
    if (!ics.includes('BEGIN:VCALENDAR')) throw new Error('không phải dữ liệu lịch');
    calendars.push({ name, ics });
    console.log(`✓ ${name}: ${ics.length} bytes`);
  } catch (e) {
    console.log(`✗ ${name}: ${e.message}`);
  }
}
if (!calendars.length) {
  console.log('Không tải được lịch nào — không ghi file.');
  process.exit(0);
}

const iter = 150000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const iv = crypto.getRandomValues(new Uint8Array(12));
const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
  keyMat, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
);
const plain = new TextEncoder().encode(JSON.stringify({ generatedAt: Date.now(), calendars }));
const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
const b64 = (u8) => Buffer.from(u8).toString('base64');
writeFileSync(out, JSON.stringify({ v: 1, iter, salt: b64(salt), iv: b64(iv), data: b64(data) }));
console.log(`Đã ghi ${out} (${calendars.length} lịch)`);
