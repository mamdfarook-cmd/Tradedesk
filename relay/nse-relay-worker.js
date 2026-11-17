/* TradeDesk NSE relay - a free Cloudflare Worker.
   NSE refuses Render's (cloud) address; this worker asks NSE from Cloudflare's address and returns NSE's answer.
   Only NSE's own data API (/api/...) can be asked, and only with your secret key, so nobody else can use it.

   Setup (once, free): see relay/RELAY-SETUP.txt.
     Worker variable (Settings -> Variables and Secrets, type Secret):  RELAY_KEY = a long random text
     Render environment:  NSE_RELAY_URL = https://<your-worker>.workers.dev   NSE_RELAY_KEY = the same text

   The TradeDesk server asks NSE at most a handful of times a day (10:00, 15:05, the evening FII / DII), so the
   worker stays far inside Cloudflare's free 100,000 requests a day. */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
let COOKIE = { v: '', ts: 0 };   /* NSE session cookie, kept while this worker instance lives (30 min at most) */

function same(a, b) {   /* constant-time compare of the key */
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function cookiesFrom(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return list.map(c => String(c).split(';')[0]).filter(c => c.includes('=')).join('; ');
}

export default {
  async fetch(request, env) {
    const reply = (status, body, extra = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store', ...extra } });
    if (!env.RELAY_KEY || !same(request.headers.get('x-relay-key') || '', env.RELAY_KEY)) return reply(401, 'wrong key', { 'x-relay': 'bad-key' });
    if (request.method !== 'GET') return reply(405, 'GET only');

    const u = new URL(request.url), path = u.searchParams.get('path') || '';
    if (!/^\/api\/[A-Za-z0-9-]+(\?[A-Za-z0-9=&%._-]*)?$/.test(path)) return reply(400, 'only NSE /api/ paths');
    let base = 'https://www.nseindia.in';
    try { const b = new URL(u.searchParams.get('base') || base); if (/^www\.nseindia\.(com|in|co\.in|org)$/i.test(b.hostname) && b.protocol === 'https:') base = b.origin; } catch {}

    const hdr = c => ({ 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'en-US,en;q=0.9',
      Referer: base + '/option-chain', ...(c ? { Cookie: c } : {}) });
    const ask = c => fetch(base + path, { headers: hdr(c), redirect: 'follow' });

    let res = await ask(COOKIE.v && Date.now() - COOKIE.ts < 30 * 60e3 ? COOKIE.v : '');
    if (res.status === 401 || res.status === 403) {
      /* NSE wants a session: its option-chain page sets the cookies, then the same request once more. */
      const page = await fetch(base + '/option-chain', { headers: { ...hdr(''), Accept: 'text/html' }, redirect: 'follow' });
      await page.arrayBuffer();
      const c = cookiesFrom(page);
      if (c) { COOKIE = { v: c, ts: Date.now() }; res = await ask(c); }
    }
    return new Response(await res.text(), { status: res.status, headers: {
      'content-type': res.headers.get('content-type') || 'application/json', 'cache-control': 'no-store', 'x-relay': 'nse', 'x-nse-status': String(res.status) } });
  },
};
