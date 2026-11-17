// Proxy riêng (tuỳ chọn) trên Cloudflare Workers — miễn phí, riêng tư hơn proxy công cộng.
// 1) dash.cloudflare.com → Workers & Pages → Create → Hello World → Edit code → dán file này → Deploy.
// 2) Trong app: Cài đặt → Kết nối → Proxy riêng: https://<ten-worker>.<ban>.workers.dev/?url={url}
const ALLOWED_HOSTS = [/\.icloud\.com$/i, /^calendar\.google\.com$/i, /^outlook\.(office365|live)\.com$/i];

export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('missing ?url=', { status: 400, headers: cors });
    let u;
    try { u = new URL(target.replace(/^webcals?:\/\//i, 'https://')); } catch { return new Response('bad url', { status: 400, headers: cors }); }
    if (!ALLOWED_HOSTS.some((re) => re.test(u.hostname))) return new Response('host not allowed', { status: 403, headers: cors });
    const res = await fetch(u.toString(), { headers: { 'User-Agent': 'Mozilla/5.0' }, cf: { cacheTtl: 120 } });
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
