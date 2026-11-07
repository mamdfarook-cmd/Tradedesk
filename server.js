/**
 * TradeDesk Backend v1.0 — Render/GitHub ready release
 *
 * Uses ONLY v8/finance/chart (proven to work on Render.com)
 * v7/finance/quote removed — it gets blocked by Yahoo with 429/403.
 *
 * Day change algorithm (fixed):
 *   1. Fetch 2m chart for today → last bar = LIVE current price
 *   2. Fetch 1d chart for 5d   → C[dn-2] = YESTERDAY's official close
 *      NOTE: When market is open, Yahoo includes today's partial bar as
 *      C[dn-1], so we must use C[dn-2] as yesterday's true close.
 *   3. change = livePrice - prevClose  (exact, matches what Yahoo shows)
 *   4. If market closed/weekend (no intraday bars): use C[dn-1] vs C[dn-2]
 */

const http  = require('http');
const https = require('https');
const url   = require('url');
const zlib  = require('zlib');
const PORT  = process.env.PORT || 3000;
/* Shared with the browser (public/swing-plan.js): S/R levels, setup stop/target, setup choice, R:R,
   pullback volume rule and relative strength are computed by the same code in the screener and Overview. */
/* Start-up check: a GitHub web upload that misses the public/ sub-folders (picking files instead of dragging
   the folder, or an old PUBLIC/ folder - Linux is case-sensitive) used to end in a bare MODULE_NOT_FOUND.
   Name exactly what is missing and what the repository actually contains, then stop. */
(function checkDeployFiles() {
  const fs0 = require('fs'), p0 = require('path');
  const need = ['public/index.html', 'public/swing-plan.js', 'public/sw.js', 'public/js/app.js', 'public/css/base.css'];
  const missing = need.filter(f => !fs0.existsSync(p0.join(__dirname, f)));
  if (!missing.length) return;
  const list = d => { try { return fs0.readdirSync(p0.join(__dirname, d)).join(', ') || '(empty)'; } catch { return '(folder not found)'; } };
  console.error(`\nTradeDesk cannot start - these files are missing from the deployed code:\n  ${missing.join('\n  ')}\n` +
    `Top level of the repository: ${list('.')}\npublic/: ${list('public')}\n` +
    `Fix: upload the whole contents of the TradeDesk folder so the repository has public/ (lower case) with\n` +
    `index.html, swing-plan.js, sw.js and the css/ and js/ folders inside it, then redeploy.\n`);
  process.exit(1);
})();
const SwingPlan = require('./public/swing-plan.js');
const SETUP_KEY = { 'EMA20 Pullback':'emaPullback', 'EMA50 Deep Pullback':'ema50DeepPullback', 'Support Bounce':'supportBounce',
  'Pre-Breakout Watch':'preBreakoutWatch', 'Breakout with Volume':'breakoutVolume', 'Momentum Continuation':'momentumContinuation' };
const SETUP_NAMES = Object.keys(SETUP_KEY);

/* ── JSON RESPONSE HELPERS ──
   Defined before route handlers to avoid temporal-dead-zone/linter issues. */
const CORS={
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,OPTIONS',
  'Access-Control-Allow-Headers':'Content-Type',
  'Content-Type':'application/json',
  /* Live price endpoints must not be cached by Safari/proxies. Server-side TTL still controls Yahoo load. */
  'Cache-Control':'no-store, no-cache, must-revalidate, proxy-revalidate',
  'Pragma':'no-cache',
  'Expires':'0'
};
const send=(res,data,status=200)=>{ if(res.writableEnded) return; res.writeHead(status,CORS);res.end(JSON.stringify(data));};
/* 5xx replies are logged with the request path: a quote that failed with 500 right after a page load could not be
   traced before, because nothing recorded why. */
const err=(res,msg,status=500)=>{if(status>=500)console.warn(`HTTP ${status} ${res.req?.url||''}: ${msg}`);res.writeHead(status,CORS);res.end(JSON.stringify({error:msg}));};

/* ── SYMBOL MAP ── */
const YF_MAP = {
  /* NSE indices from uploaded "All Nse Indices.xlsx".
     LTP values from Excel are reference only; prices still come live from Yahoo/chart API. */
  'NSE:NIFTY':        '^NSEI',
  'NSE:BANKNIFTY':    '^NSEBANK',
  'NSE:NIFTYNXT50':   '^NSMIDCP',
  'NSE:NIFTYFMCG':    '^CNXFMCG',
  'NSE:NIFTYENERGY':  '^CNXENERGY',
  'NSE:NIFTYCONSDUR': 'NIFTY_CONSR_DURBL.NS',
  'NSE:NIFTYFINEXBANK':'FINIETF.NS', /* Yahoo ETF/proxy symbol; no stock-basket fallback */
  'NSE:NIFTYIT':      '^CNXIT',
  'NSE:NIFTYPVTBANK': 'NIFTY_PVT_BANK.NS',
  'NSE:NIFTYAUTO':    '^CNXAUTO',
  'NSE:FINNIFTY':     'NIFTY_FIN_SERVICE.NS',
  'NSE:NIFTYPHARMA':  '^CNXPHARMA',
  'NSE:NIFTYMID150':  'NIFTYMIDCAP150.NS',
  'NSE:NIFTYHEALTH':  'NIFTY_HEALTHCARE.NS',
  'NSE:NIFTYMETAL':   '^CNXMETAL',
  'NSE:NIFTYHOUSING': 'NIFTY_HOUSING.NS',
  'NSE:NIFTYCONSUMPTION':'^CNXCONSUM',
  'NSE:NIFTYOILGAS':  'NIFTY_OIL_AND_GAS.NS',
  'NSE:NIFTYPSE':     '^CNXPSE',
  'NSE:NIFTYCOMMODITIES':'^CNXCMDT',
  'NSE:NIFTYINFRA':   '^CNXINFRA',
  'NSE:NIFTYPSUBANK': '^CNXPSUBANK',
  'NSE:NIFTYDIGITAL': 'NIFTY_IND_DIGITAL.NS',
  'NSE:NIFTYTOURISM': 'NIFTY_IND_TOURISM.NS',
  'NSE:NIFTYMEDIA':   '^CNXMEDIA',
  'NSE:NIFTYREALTY':  '^CNXREALTY',

  /* Stock-level Yahoo overrides: these symbols are BSE-only / more reliable on Yahoo. */
  'NSE:ALTIUSINVIT': 'ALTIUSINVIT.BO',
  'NSE:KRT':         'KRT.BO',
  'NSE:MINDSPACE':   'MINDSPACE.BO',
  'NSE:NHIT':        'NHIT.BO',

  /* MCX mappings — kept unchanged */
  'MCX:GOLD':      'GC=F',
  'MCX:GOLDPETAL': 'GC=F',
  'MCX:SILVER':    'SI=F',
  'MCX:CRUDEOIL':  'CL=F',
  'MCX:NATURALGAS':'NG=F',
  'MCX:COPPER':    'HG=F',
};
const DATA_SOURCE_NOTES = {
  'NSE:NIFTYNXT50': 'Yahoo Finance uses ^NSMIDCP for Nifty Next 50.',
  'NSE:NIFTYCONSDUR': 'Consumer Durables direct Yahoo ticker may be unreliable; if Yahoo fails the app shows N/A.',
  'NSE:NIFTYFINEXBANK': 'Yahoo does not provide a clean Financial Services Ex-Bank index ticker; FINIETF.NS is used as the direct Yahoo symbol/proxy.',
  'NSE:NIFTYHEALTH': 'Healthcare direct Yahoo ticker may be unreliable; if Yahoo fails the app shows N/A.',
  'NSE:NIFTYHOUSING': 'Housing direct Yahoo ticker may be unreliable; if Yahoo fails the app shows N/A.',
  'NSE:NIFTYPVTBANK': 'Direct Yahoo ticker NIFTY_PVT_BANK.NS is used. No synthetic basket fallback.',
  'NSE:NIFTYOILGAS': 'Direct Yahoo ticker NIFTY_OIL_AND_GAS.NS is used. No synthetic basket fallback.',
  'NSE:NIFTYINFRA': 'Direct Yahoo ticker ^CNXINFRA is used. No synthetic basket fallback.',
  'NSE:NIFTYPSE': 'Direct Yahoo ticker ^CNXPSE is used. No synthetic basket fallback.',
  'NSE:NIFTYTOURISM': 'Direct Yahoo ticker NIFTY_IND_TOURISM.NS is used. No synthetic basket fallback.',
  'MCX:GOLD': 'Continuous proxy: COMEX Gold × USD/INR × 1.159 MCX factor converted to ₹/10g. Not official MCX feed; verify broker MCX price before orders.',
  'MCX:GOLDPETAL': 'Continuous proxy: COMEX Gold × USD/INR × 1.159 MCX factor converted to ₹/1g. Not official MCX feed; verify broker MCX price before orders.',
  'MCX:SILVER': 'Continuous proxy: COMEX Silver × USD/INR × 1.1885 MCX factor converted to ₹/kg. Not official MCX feed; verify broker MCX price before orders.',
  'MCX:CRUDEOIL': 'Continuous proxy: WTI Crude Oil × USD/INR. Not official MCX feed; verify broker MCX price before orders.',
  'MCX:NATURALGAS': 'Continuous proxy: US Natural Gas × USD/INR. Not official MCX feed; verify broker MCX price before orders.',
  'MCX:COPPER': 'Continuous proxy: COMEX Copper × USD/INR × 1.011 MCX factor converted to ₹/kg. Not official MCX feed; verify broker MCX price before orders.'
};

/* NSE index synthetic stock-basket logic removed intentionally.
   Only direct Yahoo tickers are used; failed/unsupported indices return N/A. */


const NSE_INDEX_CODES = new Set([
  'NIFTY','BANKNIFTY','NIFTYNXT50','NIFTYFMCG','NIFTYENERGY','NIFTYCONSDUR','NIFTYFINEXBANK',
  'NIFTYIT','NIFTYPVTBANK','NIFTYAUTO','FINNIFTY','NIFTYPHARMA','NIFTYMID150','NIFTYHEALTH',
  'NIFTYMETAL','NIFTYHOUSING','NIFTYCONSUMPTION','NIFTYOILGAS','NIFTYPSE','NIFTYCOMMODITIES',
  'NIFTYINFRA','NIFTYPSUBANK','NIFTYDIGITAL','NIFTYTOURISM','NIFTYMEDIA','NIFTYREALTY'
]);

/* MCX continuous proxy conversion.
   This is intentionally NOT official MCX market data and NOT Indian MCX session logic.
   It keeps moving whenever Yahoo's international futures and USD/INR move, even after
   MCX India is closed.

   Formula requested:
   - Gold      = COMEX Gold USD/oz ÷ 31.1035 × 10g × USDINR × MCX factor (1.159)
   - GoldPetal = COMEX Gold USD/oz ÷ 31.1035 × 1g  × USDINR × MCX factor (1.159)
   - Silver    = COMEX Silver USD/oz ÷ 31.1035 × 1000g × USDINR × MCX factor (1.1885)
   - Crude     = WTI Crude USD/barrel × USDINR
   - NatGas    = US Natural Gas USD/MMBtu × USDINR
   - Copper    = COMEX Copper USD/lb ÷ 0.453592 × USDINR × MCX factor (1.011)
*/
/* Factor from the international price (× USD/INR) to the real MCX contract. The 6% import duty alone left the
   proxy below the broker's MCX price, so each factor was set on 2 Nov 2026 to match the user's broker:
   gold +12,000/10g (and petal +1,200/g) -> 1.159, silver +20,000/kg -> 1.1885, copper +15/kg -> 1.011.
   Being a multiplier, the gap grows and shrinks with the price. Override one with e.g. MCX_FACTOR_GOLD=1.15
   (gold petal follows gold unless MCX_FACTOR_GOLDPETAL is set). */
const mcxFactorEnv = (k, def) => Number(process.env['MCX_FACTOR_' + k]) > 0.5 ? Number(process.env['MCX_FACTOR_' + k]) : def;
const MCX_FACTOR = {
  GOLD: mcxFactorEnv('GOLD', 1.159),
  SILVER: mcxFactorEnv('SILVER', 1.1885),
  COPPER: mcxFactorEnv('COPPER', 1.011),
};
MCX_FACTOR.GOLDPETAL = mcxFactorEnv('GOLDPETAL', MCX_FACTOR.GOLD);
const MCX_CONV = {
  'MCX:GOLD':       (p,r) => +(p / 31.1035 * 10   * r * MCX_FACTOR.GOLD).toFixed(2),
  'MCX:GOLDPETAL':  (p,r) => +(p / 31.1035        * r * MCX_FACTOR.GOLDPETAL).toFixed(2),
  'MCX:SILVER':     (p,r) => +(p / 31.1035 * 1000 * r * MCX_FACTOR.SILVER).toFixed(2),
  'MCX:CRUDEOIL':   (p,r) => +(p * r).toFixed(2),
  'MCX:NATURALGAS': (p,r) => +(p * r).toFixed(2),
  'MCX:COPPER':     (p,r) => +(p / 0.453592 * r * MCX_FACTOR.COPPER).toFixed(2),
};

const isMCX = s => s && s.startsWith('MCX:');
function getTicker(sym) {
  if (!sym) return sym;
  if (YF_MAP[sym]) return YF_MAP[sym];
  if (sym.startsWith('NSE:')) return sym.slice(4) + '.NS';
  return sym;
}
function conv(sym, p, r) {
  const f = MCX_CONV[sym]; return f ? f(p, r) : +p.toFixed(2);
}

/* ── HTTP GET ── */
const BASE_HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,*/*',
  'Accept-Encoding': 'gzip,deflate',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com',
  'Origin': 'https://finance.yahoo.com',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

/* Hard ceiling for any single outbound request. The socket `timeout` below is only an IDLE timeout,
   so a slow-dripping response could previously hang a caller forever. */
const HTTP_DEADLINE_MS = 20000;
/* Outbound request accounting per host (shown in /api/health) so call volume can be checked. */
const OUTBOUND = { since: Date.now(), byHost: {}, recent: [] };
function countOutbound(host, status) {
  const h = OUTBOUND.byHost[host] || (OUTBOUND.byHost[host] = { total: 0 });
  h.total++;
  OUTBOUND.recent.push({ t: Date.now(), host });
  const cut = Date.now() - 10 * 60 * 1000;
  while (OUTBOUND.recent.length && OUTBOUND.recent[0].t < cut) OUTBOUND.recent.shift();
}
function outboundStats() {
  const now = Date.now(), win = (ms) => { const o = {}; OUTBOUND.recent.filter(r => r.t > now - ms).forEach(r => { o[r.host] = (o[r.host] || 0) + 1; }); return o; };
  return { since: new Date(OUTBOUND.since).toISOString(), last1min: win(60000), last5min: win(300000), totals: OUTBOUND.byHost, protection: hostProtectionStats(), chartCache: CHART_CACHE.size };
}
/* ── POLITE OUTBOUND LAYER ──
   Personal-use app: never hammer a data source. Every request goes through a per-host queue that limits
   concurrency and spaces requests out, and a circuit breaker: a 429 (or 403/999 from Yahoo/NSE) pauses
   that host for 1 min, doubling up to 15 min, during which callers get an immediate error and the API
   layer serves its last cached value instead. */
const HOST_LIMITS = [
  { re: /(^|\.)finance\.yahoo\.com$/i,   max: 4, gapMs: 150, key: 'yahoo' },
  { re: /(^|\.)nseindia\.com$/i,         max: 1, gapMs: 2000, key: 'nse' },
  { re: /(^|\.)bseindia\.com$/i,         max: 1, gapMs: 1500, key: 'bse' },
  { re: /.*/,                            max: 2, gapMs: 500 },   /* news sites and other APIs */
];
const HOST_STATE = {};
/* One state per provider: query1 and query2.finance.yahoo.com share Yahoo's limit and pause (they used to get
   4 + 4 parallel requests and separate pauses); news sites keep one state per host. */
function hostState(host) {
  const lim = HOST_LIMITS.find(l => l.re.test(host)), key = lim.key || host;
  if (!HOST_STATE[key]) HOST_STATE[key] = { max: lim.max, gapMs: lim.gapMs, active: 0, lastStart: 0, queue: [], coolUntil: 0, strikes: 0 };
  return HOST_STATE[key];
}
function pumpHost(host) {
  const st = hostState(host);
  while (st.active < st.max && st.queue.length) {
    const wait = st.lastStart + st.gapMs - Date.now();
    if (wait > 0) { if (!st.timer) st.timer = setTimeout(() => { st.timer = null; pumpHost(host); }, wait); return; }
    const job = st.queue.shift();
    st.active++; st.lastStart = Date.now();
    job().finally(() => { st.active--; pumpHost(host); });
  }
}
function scheduleHost(host, fn) {
  return new Promise((resolve, reject) => {
    hostState(host).queue.push(() => fn().then(resolve, reject));
    pumpHost(host);
  });
}
function noteHostResult(host, status) {
  const st = hostState(host);
  /* NSE answers 401/403 when its session cookie has expired - the callers fetch a fresh cookie and retry, so it is
     not a rate limit (pausing NSE here blocked that retry and the option chain / indices / results for minutes). */
  const blocked = status === 429 || status === 999 || (status === 403 && /yahoo/i.test(host));
  if (blocked) {
    /* Replies to requests that were already in flight when the pause started do not add strikes: one burst
       of 429s used to escalate straight to the 15-minute maximum. */
    if (Date.now() < st.coolUntil) return;
    st.strikes = Math.min(st.strikes + 1, 5);
    st.coolUntil = Date.now() + Math.min(15 * 60000, 60000 * 2 ** (st.strikes - 1));
    console.warn(`Rate-limit protection: ${host} answered ${status}; pausing it until ${new Date(st.coolUntil).toISOString()}`);
  } else if (status >= 200 && status < 400) {
    st.strikes = 0;
  }
}
function get(targetUrl, extraHdrs = {}, body = null, method = 'GET') {
  const host = new URL(targetUrl).hostname;
  const st = hostState(host);
  if (Date.now() < st.coolUntil) {
    const er = new Error(`${host} paused after a rate-limit reply (until ${new Date(st.coolUntil).toISOString()})`);
    er.status = 429; er.cooldown = true;
    return Promise.reject(er);
  }
  return scheduleHost(host, () => pausedError(host) || rawGet(targetUrl, extraHdrs, body, method).then(r => { noteHostResult(host, r.status); return r; }));
}
/* Queued jobs re-check the pause when they reach the front: the pause used to be checked only when a request
   joined the queue, so ~300 queued screener calls kept hitting Yahoo after a 429. */
function pausedError(host) {
  const st = hostState(host);
  if (Date.now() >= st.coolUntil) return null;
  const er = new Error(`${host} paused after a rate-limit reply (until ${new Date(st.coolUntil).toISOString()})`);
  er.status = 429; er.cooldown = true;
  return Promise.reject(er);
}
function hostProtectionStats() {
  const o = {};
  for (const [h, st] of Object.entries(HOST_STATE)) o[h] = { queued: st.queue.length, active: st.active, pausedUntil: st.coolUntil > Date.now() ? new Date(st.coolUntil).toISOString() : null, strikes: st.strikes };
  return o;
}
function rawGet(targetUrl, extraHdrs = {}, body = null, method = 'GET') {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    countOutbound(u.hostname, 0);
    const postData = body ? Buffer.from(body, 'utf8') : null;
    const hdrs = { ...BASE_HDR, ...extraHdrs };
    if (postData) { hdrs['Content-Length'] = postData.length; }
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(deadline); fn(v); };
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: postData ? 'POST' : method,
      headers: hdrs,
      timeout: 15000,
    }, res => {
      const chunks = [];
      const enc = res.headers['content-encoding'];
      const stream = enc==='gzip' ? res.pipe(zlib.createGunzip())
        : enc==='deflate' ? res.pipe(zlib.createInflate()) : res;
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => done(resolve, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', er => done(reject, er));
      /* Errors/aborts on the raw response are not forwarded through pipe(), so listen on it directly. */
      if (stream !== res) res.on('error', er => done(reject, er));
      res.on('aborted', () => done(reject, new Error('Response aborted')));
    });
    const deadline = setTimeout(() => { req.destroy(); done(reject, new Error('Deadline exceeded')); }, HTTP_DEADLINE_MS);
    req.on('timeout', () => { req.destroy(); done(reject, new Error('Timeout')); });
    req.on('error', er => done(reject, er));
    if (postData) req.write(postData);
    req.end();
  });
}

/* Minimal GET that also returns response headers (used for the NSE cookie warm-up). */
function getWithHeaders(targetUrl, extraHdrs = {}) {
  const host = new URL(targetUrl).hostname;
  if (Date.now() < hostState(host).coolUntil) return Promise.reject(Object.assign(new Error(host + ' paused'), { status: 429 }));
  return scheduleHost(host, () => pausedError(host) || rawGetWithHeaders(targetUrl, extraHdrs).then(r => { noteHostResult(host, r.status); return r; }));
}
function rawGetWithHeaders(targetUrl, extraHdrs = {}) {
  countOutbound(new URL(targetUrl).hostname, 0);
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(deadline); fn(v); };
    const req = https.request({ hostname:u.hostname, path:u.pathname + u.search, method:'GET', headers:{ ...BASE_HDR, ...extraHdrs }, timeout:8000, maxHeaderSize:131072 }, res => {
      res.resume();
      res.on('end', () => done(resolve, { status:res.statusCode, headers:res.headers }));
      res.on('error', er => done(reject, er));
      res.on('aborted', () => done(reject, new Error('Response aborted')));
    });
    /* Hard deadline like rawGet: a slow drip used to keep NSE's single queue slot busy forever. */
    const deadline = setTimeout(() => { req.destroy(); done(reject, new Error('Deadline exceeded')); }, HTTP_DEADLINE_MS);
    req.on('timeout', () => { req.destroy(); done(reject, new Error('Timeout')); });
    req.on('error', er => done(reject, er));
    req.end();
  });
}

/* ── YAHOO v8 CHART ── */
/* Same chart requested again within its TTL is served from memory (Overview, screener, breadth, sidebar
   and Nifty regime often ask for the same series). Live-price charts are short-lived; history is not. */
const CHART_CACHE = new Map(), CHART_INFLIGHT = new Map();
function chartTtlMs(interval, range) {
  if (interval === '1mo') return 12 * 3600e3;
  if (interval === '1wk') return 6 * 3600e3;
  if (interval === '1h' || interval === '60m') return 5 * 60e3;
  if (interval === '1d' && /^(2y|5y|1y|6mo|3mo|1mo)$/.test(range)) return 10 * 60e3;
  return 30e3; /* live price series: 2m/1d, 1d/5d, 1d/1d */
}
async function yfChart(ticker, interval, range) {
  const key = `${ticker}|${interval}|${range}`, ttl = chartTtlMs(interval, range);
  const hit = CHART_CACHE.get(key);
  if (hit && Date.now() - hit.ts < ttl) return hit.value;
  if (CHART_INFLIGHT.has(key)) return CHART_INFLIGHT.get(key);
  const p = yfChartFetch(ticker, interval, range)
    .then(v => { CHART_CACHE.set(key, { value: v, ts: Date.now() }); return v; })
    .catch(er => { if (hit && er.status === 429) return hit.value; throw er; }) /* paused host: last good copy */
    .finally(() => CHART_INFLIGHT.delete(key));
  CHART_INFLIGHT.set(key, p);
  return p;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of CHART_CACHE) { const [, i, r] = k.split('|'); if (now - v.ts > Math.max(chartTtlMs(i, r) * 2, 30 * 60e3)) CHART_CACHE.delete(k); }
  if (CHART_CACHE.size > 2500) [...CHART_CACHE.keys()].slice(0, CHART_CACHE.size - 2500).forEach(k => CHART_CACHE.delete(k));
}, 5 * 60e3);
async function yfChartFetch(ticker, interval, range) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`;
  const r = await get(u);
  if (r.status !== 200) { const er = new Error(`Yahoo ${r.status} for ${ticker}`); er.status = r.status; throw er; }
  const d = JSON.parse(r.body);
  if (d?.chart?.error) throw new Error(d.chart.error.description || 'Yahoo error');
  const res = d?.chart?.result?.[0];
  if (!res) throw new Error('No chart data for ' + ticker);
  return res;
}

/* Parse chart result into clean OHLCV arrays */
function parseBars(result) {
  const q = result?.indicators?.quote?.[0] || {};
  const ts = result?.timestamp || [];
  const bars = (q.close || []).map((c, i) => ({
    t: ts[i], c, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], v: q.volume?.[i],
  })).filter(b => b.c != null && !isNaN(b.c) && b.o != null && b.h != null && b.l != null);
  return {
    T: bars.map(b => b.t || null),
    C: bars.map(b => +b.c.toFixed(4)),
    O: bars.map(b => +b.o.toFixed(4)),
    H: bars.map(b => +b.h.toFixed(4)),
    L: bars.map(b => +b.l.toFixed(4)),
    V: bars.map(b => Math.round(b.v || 0)),
    n: bars.length,
  };
}

function firstValidNumber(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}
function sameMarketDate(aTs, bTs, tz='Asia/Kolkata') {
  if (!aTs || !bTs) return false;
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' });
    return fmt.format(new Date(aTs * 1000)) === fmt.format(new Date(bTs * 1000));
  } catch { return false; }
}

function pickYahooLivePrev({ daily, intra, meta, intraMeta = null }) {
  const dn = daily?.n || 0;
  const inN = intra?.n || 0;
  if (dn === 0 && inN === 0) return { liveRaw:0, prevRaw:0 };

  /* Best source: Yahoo metadata. This avoids the common Yahoo issue where
     daily bars sometimes include today's partial candle and sometimes do not.
     Never treat previousClose as a live price when regularMarketPrice is absent. */
  const metaLive = firstValidNumber(meta?.regularMarketPrice);
  /* The 1d/5d daily chart usually has NO previousClose in meta, and for some NSE sector tickers it holds
     only today's bar, which made previous close = live price (exactly 0.00% change). The 2m/1d intraday
     meta carries the true previous session close (previousClose / chartPreviousClose for range=1d). */
  const metaPrev = firstValidNumber(meta?.regularMarketPreviousClose, meta?.previousClose,
    intraMeta?.regularMarketPreviousClose, intraMeta?.previousClose, intraMeta?.chartPreviousClose);

  const liveRaw = firstValidNumber(
    metaLive,
    inN > 0 ? intra.C[inN - 1] : null,
    dn > 0 ? daily.C[dn - 1] : null,
    metaPrev
  ) || 0;

  let prevRaw = metaPrev;
  /* NSE / BSE: take the previous close from the bars - the last session dated BEFORE the live price's session.
     Yahoo's previousClose / chartPreviousClose for NSE indices can lag a full day (e.g. on 29 Oct night it
     still held the 27 Oct close while the bars had 28 Oct), which made every index day-change wrong.
     MCX proxies (international futures) and crypto trade across midnight in other time zones, so they keep
     the metadata path below. */
  const exTz = meta?.exchangeTimezoneName || meta?.timezone || '';
  if (/Kolkata|Calcutta|^IST$/i.test(exTz)) {
    const dk = t => Number(t) > 0 ? istDateKey(Number(t) * 1000) : null;
    const liveDay = dk(meta?.regularMarketTime) || dk(inN > 0 ? intra.T?.[inN - 1] : null) || dk(dn > 0 ? daily.T?.[dn - 1] : null);
    const lastClose = {};   /* date -> last close of that date (intraday first, daily overrides) */
    for (let i = 0; i < inN; i++) { const d = dk(intra.T?.[i]); if (d && Number(intra.C[i]) > 0) lastClose[d] = +intra.C[i]; }
    for (let i = 0; i < dn; i++) { const d = dk(daily.T?.[i]); if (d && Number(daily.C[i]) > 0) lastClose[d] = +daily.C[i]; }
    const before = Object.keys(lastClose).filter(d => liveDay && d < liveDay).sort();
    if (before.length) prevRaw = lastClose[before[before.length - 1]];
  }
  if (!prevRaw) {
    const tz = meta?.exchangeTimezoneName || meta?.timezone || 'Asia/Kolkata';
    if (inN > 0 && dn > 0) {
      const dailyLastIsSameSession = sameMarketDate(daily.T?.[dn - 1], intra.T?.[inN - 1], tz);
      /* If daily last bar is today's partial bar, previous close is dn-2.
         If daily has not yet rolled to today, dn-1 itself is previous close. */
      prevRaw = firstValidNumber(dailyLastIsSameSession && dn >= 2 ? daily.C[dn - 2] : null, daily.C[dn - 1], liveRaw);
    } else {
      prevRaw = firstValidNumber(dn >= 2 ? daily.C[dn - 2] : null, dn === 1 ? daily.C[0] : null, liveRaw);
    }
  }
  return { liveRaw, prevRaw: prevRaw || liveRaw || 0 };
}

/* ── SAFE FETCH WITH RETRY (Yahoo WILL randomly fail) ── */
async function safeFetch(fn, retries = 2, attempt = 0) {
  try { return await fn(); }
  catch (e) {
    /* 4xx (bad symbol, 404, 429 rate-limit) will not fix itself on an immediate retry -
       retrying 429s only digs the rate-limit hole deeper. */
    const st = Number(e && e.status);
    if (st >= 400 && st < 500) throw e;
    if (retries > 0) {
      /* Jittered exponential backoff: ~250ms, ~500ms, ... */
      await new Promise(r => setTimeout(r, 250 * 2 ** attempt + Math.random() * 150));
      return safeFetch(fn, retries - 1, attempt + 1);
    }
    throw e;
  }
}

function withTimeout(promise, ms, label='operation') {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label + ' timeout')), ms); }),
  ]).finally(() => clearTimeout(t));
}

/* ══════════════════════════════════════════════════════════════════════
   Uses two chart fetches:
   A) 2m interval, 1d range  → today's intraday bars
      - Last bar close = CURRENT live price (exact)
      - Only exists during/after market session today
   B) 1d interval, 5d range  → daily bars
      - While market is OPEN:  C[dn-1] = today's partial bar (ignore!)
                               C[dn-2] = YESTERDAY's official close ✅
      - While market is CLOSED: C[dn-1] = most recent close
                                C[dn-2] = previous session close

   FIX: When intraday bars exist (market open), use C[dn-2] not C[dn-1]
   as prevRaw. Yahoo appends today's live/partial bar to the daily series,
   making C[dn-1] nearly equal to the live price → tiny/wrong day change.

   Change = A_last - B[dn-2]  (market open: correct yesterday close)
   Change = B[dn-1] - B[dn-2] (market closed/weekend/holiday)

   For MCX: all raw prices in USD, convert after computing change.
   Percentage change is currency-neutral (same in USD or INR).
══════════════════════════════════════════════════════════════════════ */
async function getPriceAndChange(ticker, symForBasis=null) {
  /* Fetch both in parallel for speed */
  const [intraR, dailyR] = await Promise.allSettled([
    safeFetch(() => yfChart(ticker, '2m', '1d')),
    safeFetch(() => yfChart(ticker, '1d', '5d')),
  ]);

  if (dailyR.status !== 'fulfilled') {
    throw new Error('Could not fetch price data for ' + ticker);
  }

  const daily = parseBars(dailyR.value);
  const dailyMeta = dailyR.value?.meta || {};
  const dn = daily.n;
  if (dn === 0) throw new Error('Empty daily data for ' + ticker);

  /* Parse intraday bars (may be empty outside market hours) */
  const intra = intraR.status === 'fulfilled' ? parseBars(intraR.value) : { C:[], O:[], H:[], L:[], V:[], n:0 };
  const intraN = intra.n;

  const picked = pickYahooLivePrev({ daily, intra, meta: dailyMeta, intraMeta: intraR.status === 'fulfilled' ? (intraR.value?.meta || null) : null });
  const liveRaw = picked.liveRaw;
  let prevRaw = picked.prevRaw;
  let changeBasis = 'previousClose';
  let basisTime = null;

  /* MCX symbols are continuous international futures × USD/INR proxies.
     Do not reset the change basis to Indian MCX 09:00 IST. Use Yahoo's own
     futures previous-close basis so the displayed proxy keeps moving even when
     MCX India is closed. */
  if (isMCX(symForBasis)) {
    changeBasis = 'continuousProxy';
    basisTime = null;
  }

  const rawChg = liveRaw - prevRaw;
  /* Fix: guard against prevRaw===undefined (NaN leak) */
  const rawPct = (prevRaw && prevRaw > 0) ? (rawChg / prevRaw) * 100 : 0;

  /* Today's session OHLV — from meta when available, else from intra/daily */
  const todayOpen = dailyMeta.regularMarketOpen
    || (intraN > 0 ? intra.O[0] : daily.O[dn - 1])
    || liveRaw;
  const todayHigh = dailyMeta.regularMarketDayHigh
    || (intraN > 0 && intra.H.length ? Math.max(...intra.H) : daily.H[dn - 1])
    || liveRaw;
  const todayLow  = dailyMeta.regularMarketDayLow
    || (intraN > 0 && intra.L.length ? Math.min(...intra.L) : daily.L[dn - 1])
    || liveRaw;
  const todayVol  = dailyMeta.regularMarketVolume
    || (intraN > 0 ? intra.V.reduce((a,b)=>a+b,0) : daily.V[dn-1])
    || 0;

  const marketTime = Number(dailyMeta.regularMarketTime) || null;
  return { liveRaw, prevRaw, rawChg, rawPct, todayOpen, todayHigh, todayLow, todayVol, changeBasis, basisTime, marketTime };
}


/* NSE's own index values (free /api/allIndices, same session cookie as the option chain). Backup for every
   NSE index when Yahoo fails, and the main source where Yahoo has no index ticker (Fin Services Ex-Bank: Yahoo
   only has the FINIETF ETF, which priced the index at ~31 instead of ~31,500). */
const NSE_INDEX_NAME = {
  'NSE:NIFTY':'NIFTY 50', 'NSE:BANKNIFTY':'NIFTY BANK', 'NSE:NIFTYNXT50':'NIFTY NEXT 50', 'NSE:NIFTYFMCG':'NIFTY FMCG',
  'NSE:NIFTYENERGY':'NIFTY ENERGY', 'NSE:NIFTYCONSDUR':'NIFTY CONSUMER DURABLES', 'NSE:NIFTYFINEXBANK':'NIFTY FINANCIAL SERVICES EX-BANK',
  'NSE:NIFTYIT':'NIFTY IT', 'NSE:NIFTYPVTBANK':'NIFTY PRIVATE BANK', 'NSE:NIFTYAUTO':'NIFTY AUTO', 'NSE:FINNIFTY':'NIFTY FINANCIAL SERVICES',
  'NSE:NIFTYPHARMA':'NIFTY PHARMA', 'NSE:NIFTYMID150':'NIFTY MIDCAP 150', 'NSE:NIFTYHEALTH':'NIFTY HEALTHCARE INDEX', 'NSE:NIFTYMETAL':'NIFTY METAL',
  'NSE:NIFTYHOUSING':'NIFTY HOUSING', 'NSE:NIFTYCONSUMPTION':'NIFTY INDIA CONSUMPTION', 'NSE:NIFTYOILGAS':'NIFTY OIL & GAS', 'NSE:NIFTYPSE':'NIFTY PSE',
  'NSE:NIFTYCOMMODITIES':'NIFTY COMMODITIES', 'NSE:NIFTYINFRA':'NIFTY INFRASTRUCTURE', 'NSE:NIFTYPSUBANK':'NIFTY PSU BANK',
  'NSE:NIFTYDIGITAL':'NIFTY INDIA DIGITAL', 'NSE:NIFTYTOURISM':'NIFTY INDIA TOURISM', 'NSE:NIFTYMEDIA':'NIFTY MEDIA', 'NSE:NIFTYREALTY':'NIFTY REALTY',
};
const NSE_INDEX_PRIMARY = new Set(['NSE:NIFTYFINEXBANK']);   /* Yahoo symbol is an ETF proxy, not the index */
let NSE_ALLIDX = null;
async function nseAllIndices() {
  if (NSE_ALLIDX && Date.now() - NSE_ALLIDX.ts < (istMarketHoursS() ? 60e3 : 600e3)) return NSE_ALLIDX.map;
  const j = await nseOcGet('/api/allIndices');
  const map = new Map((j.data || []).map(r => [String(r.index || '').toUpperCase(), r]));
  if (!map.size) throw new Error('NSE allIndices empty');
  NSE_ALLIDX = { map, ts: Date.now() };
  return map;
}
async function nseIndexPrice(sym) {
  const name = NSE_INDEX_NAME[sym];
  if (!name) throw new Error('No NSE index name for ' + sym);
  const r = (await nseAllIndices()).get(name);
  if (!r || !(+r.last > 0)) throw new Error('NSE has no value for ' + name);
  return { liveRaw:+r.last, prevRaw:+r.previousClose || +r.last, rawPct:+r.percentChange || 0, todayOpen:+r.open || +r.last,
    todayHigh:+r.high || +r.last, todayLow:+r.low || +r.last, todayVol:0, changeBasis:'previousClose', basisTime:null, source:'NSE' };
}
const NSE_PROXY_RATIO = {};   /* index / ETF price, learned whenever NSE answered (apiQuote) */
async function getIndexFallbackPrice(sym, ticker) {
  if (NSE_INDEX_PRIMARY.has(sym)) {
    try { return await withTimeout(nseIndexPrice(sym), 15000, 'NSE index'); }
    catch (e) {
      /* The Yahoo symbol is an ETF (~31 for an index at ~31,500): scale it by the last known ratio, or fail so the
         last good value is served - a raw ETF price fired every "below" alert on this index. */
      const k = NSE_PROXY_RATIO[sym];
      if (!(k > 0)) throw new Error(`${sym}: NSE index value unavailable (${e.message}) and Yahoo only has an ETF proxy`);
      const y = await getPriceAndChange(ticker, sym);
      return { ...y, liveRaw: y.liveRaw * k, prevRaw: y.prevRaw * k, todayOpen: y.todayOpen * k, todayHigh: y.todayHigh * k, todayLow: y.todayLow * k, source: 'ETFxRatio' };
    }
  }
  try { return await getPriceAndChange(ticker, sym); }
  catch (e) {
    if (!NSE_INDEX_NAME[sym]) throw e;
    /* Yahoo failed or is paused: NSE's own value instead of an error. */
    try { return await withTimeout(nseIndexPrice(sym), 15000, 'NSE index fallback'); } catch { throw e; }
  }
}


/* ── USD/INR ── */
let usdInrCache = { rate: 84.5, ts: 0 };
async function getRate(force=false) {
  if (!force && Date.now() - usdInrCache.ts < 30 * 1000) return usdInrCache.rate;
  try {
    /* Fix: lightweight fetch — just read meta.regularMarketPrice, avoids double yfChart */
    const r = await yfChart('USDINR=X', '1d', '1d');
    const liveRaw = r?.meta?.regularMarketPrice;
    if (liveRaw && liveRaw > 50) usdInrCache = { rate: +liveRaw.toFixed(4), ts: Date.now() };
  } catch { console.warn('USDINR fetch failed, using cached:', usdInrCache.rate); }
  if (!usdInrCache.ts) throw new Error('USD/INR rate not available yet');   /* never the built-in 84.5 */
  return usdInrCache.rate;
}


/* USD/INR live + previous-close basis for MCX proxy day-change.
   Critical: MCX proxy change must include currency movement too.
   Old code converted both current and previous commodity prices using the same live USD/INR,
   so Gold could show only COMEX +0.05% even when USD/INR added another ~0.30%.
*/
/* One USD/INR basis fetch serves every MCX request for FX_BASIS_TTL ms, concurrent callers share the
   in-flight fetch, and the whole thing is time-boxed. Previously every MCX quote ran getRate(true)
   plus getPriceAndChange('USDINR=X') (up to 7 Yahoo calls) outside any timeout. */
const FX_BASIS_TTL = 10 * 1000;
let fxBasisCache = null, fxBasisTs = 0, fxBasisInflight = null;
async function getRateBasis(force=false) {
  if (!force && fxBasisCache && Date.now() - fxBasisTs < FX_BASIS_TTL) return fxBasisCache;
  if (fxBasisInflight) return fxBasisInflight;
  fxBasisInflight = (async () => {
    const fallback = fxBasisCache || { live: usdInrCache.rate, prev: usdInrCache.rate };
    try {
      const fx = await withTimeout(getPriceAndChange('USDINR=X', null), 6000, 'USDINR basis');
      const live = fx?.liveRaw > 50 ? +fx.liveRaw.toFixed(4) : fallback.live;
      const prev = fx?.prevRaw > 50 ? +fx.prevRaw.toFixed(4) : live;
      usdInrCache = { rate: live, ts: Date.now() };
      fxBasisCache = { live, prev }; fxBasisTs = Date.now();
      return fxBasisCache;
    } catch(e) {
      /* No live rate has ever been fetched: refuse rather than price MCX at the built-in 84.5 (about 11% low
         against ~94.7 in Nov 2026). The quote then errors or serves its last good value. */
      if (!fxBasisCache && !usdInrCache.ts) throw new Error('USD/INR rate not available yet - MCX prices need it');
      console.warn('USDINR basis fetch failed, using cached:', e.message);
      return fallback;
    } finally { fxBasisInflight = null; }
  })();
  return fxBasisInflight;
}

/* ── RESPONSE CACHE + IN-FLIGHT DEDUPE ──
   Keeps the app responsive when the user switches stocks quickly.
   TTLs are intentionally short so prices stay near-live while duplicate Yahoo calls are avoided. */
const API_CACHE = new Map();
const INFLIGHT  = new Map();
const TTL = {
  quote: 20 * 1000,
  quick: 15 * 1000,
  mcx: 30 * 1000,
  vix: 60 * 1000,
  /* Global includes breadth + IV percentile, so keep it cached a bit longer. */
  global: 5 * 60 * 1000,
};

function cacheGet(key, ttl) {
  const hit = API_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttl) return null; /* expired, but kept for stale-on-error */
  return hit.value;
}

async function cacheWrap(key, ttl, producer) {
  const hit = cacheGet(key, ttl);
  if (hit) return { value: hit, cached: true };
  if (INFLIGHT.has(key)) {
    try { return { value: await INFLIGHT.get(key), cached: true }; }
    catch (er) {
      /* Same fallback as the first caller gets (it used to be a 500 for everyone else waiting on the fetch). */
      const old = API_CACHE.get(key);
      if (old && Date.now() - old.ts < 30 * 60 * 1000) return { value: { ...old.value, stale: true, staleAgeSec: Math.round((Date.now() - old.ts) / 1000) }, cached: true };
      throw er;
    }
  }
  const p = Promise.resolve()
    .then(producer)
    .then(value => { API_CACHE.set(key, { value, ts: Date.now() }); return value; })
    .finally(() => INFLIGHT.delete(key));
  INFLIGHT.set(key, p);
  try { return { value: await p, cached: false }; }
  catch (er) {
    /* Source failed or is paused: serve the last good value (up to 30 min old) rather than an error. */
    const old = API_CACHE.get(key);
    if (old && Date.now() - old.ts < 30 * 60 * 1000) return { value: { ...old.value, stale: true, staleAgeSec: Math.round((Date.now() - old.ts) / 1000) }, cached: true };
    throw er;
  }
}

/* Prevent long-running cache maps in always-on deployments */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of API_CACHE) if (now - v.ts > 30 * 60 * 1000) API_CACHE.delete(k);
}, 5 * 60 * 1000);

/* ── NEWS ENGINE v10 — RSS + GDELT + API backup + scoring ──
   Goal: avoid single-source failure. Every selected stock uses:
   cache → Indian RSS → Google RSS → Zerodha Pulse → GDELT → Marketaux → NewsData → Finnhub(global/gold)
   Then: relevance filter → duplicate removal → impact scoring → source-health response.
*/
const NEWS_CACHE = {};
const NEWS_INFLIGHT = new Map();
const NEWS_CACHE_MAX = 300;
const NEWS_TTL   = 15 * 60 * 1000;
/* Drop expired entries, then the oldest ones, so arbitrary sym/name values cannot grow memory without limit. */
function pruneNewsCache() {
  const now = Date.now();
  for (const k of Object.keys(NEWS_CACHE)) {
    const v = NEWS_CACHE[k];
    if (now - v.ts > Math.max(v.ttl || NEWS_TTL, NEWS_TTL) * 2) delete NEWS_CACHE[k];
  }
  const keys = Object.keys(NEWS_CACHE);
  if (keys.length > NEWS_CACHE_MAX) {
    keys.sort((a,b) => NEWS_CACHE[a].ts - NEWS_CACHE[b].ts)
        .slice(0, keys.length - NEWS_CACHE_MAX)
        .forEach(k => delete NEWS_CACHE[k]);
  }
}
setInterval(pruneNewsCache, 10 * 60 * 1000);
const EMPTY_NEWS_TTL = 5 * 60 * 1000;

/* Use Render/hosting env vars only. Do not hardcode API keys in GitHub. */
const MARKETAUX_KEY = process.env.MARKETAUX_KEY || '';
const FINNHUB_KEY   = process.env.FINNHUB_KEY   || '';
const NEWSDATA_KEY  = process.env.NEWSDATA_KEY  || '';

const NEWS_SOURCE_TTL = {
  rss: 12 * 60 * 1000,
  gdelt: 20 * 60 * 1000,
  api: 45 * 60 * 1000,
  gold: 30 * 60 * 1000,
};

const STOCK_ALIAS_OVERRIDES = {
  RELIANCE: ['reliance industries','ril','reliance','jio','reliance retail','mukesh ambani'],
  TCS: ['tcs','tata consultancy','tata consultancy services'],
  INFY: ['infosys','infy'],
  HDFCBANK: ['hdfc bank','hdfcbank'],
  ICICIBANK: ['icici bank','icicibank'],
  SBIN: ['state bank of india','sbi','sbin'],
  AXISBANK: ['axis bank'],
  KOTAKBANK: ['kotak mahindra bank','kotak bank'],
  LT: ['larsen & toubro','larsen and toubro','l&t'],
  M_M: ['mahindra & mahindra','mahindra and mahindra','m&m'],
  MANDM: ['mahindra & mahindra','mahindra and mahindra','m&m'],
  BAJFINANCE: ['bajaj finance'], BAJAJFINSV: ['bajaj finserv'],
  HINDUNILVR: ['hindustan unilever','hul'], ITC: ['itc'],
  TATAMOTORS: ['tata motors'], TATASTEEL: ['tata steel'], TATACONSUM: ['tata consumer'],
  ADANIENT: ['adani enterprises'], ADANIPORTS: ['adani ports'], ATGL: ['adani total gas'],
  BHARTIARTL: ['bharti airtel','airtel'],
  SUNPHARMA: ['sun pharma','sun pharmaceutical'], DRREDDY: ['dr reddy','dr reddy\'s'],
  NIFTY: ['nifty','nifty 50','nse nifty'],
  BANKNIFTY: ['bank nifty','nifty bank'],
  NIFTYNXT50: ['nifty next 50','next 50','niftyjr'],
  NIFTYFMCG: ['nifty fmcg','fmcg index'],
  NIFTYENERGY: ['nifty energy','energy index'],
  NIFTYCONSDUR: ['nifty consumer durables','consumer durable','consumer durables index'],
  NIFTYFINEXBANK: ['nifty financial services ex bank','fin services ex bank','financial services ex bank'],
  NIFTYIT: ['nifty it','it index'],
  NIFTYPVTBANK: ['nifty private bank','private bank index'],
  NIFTYAUTO: ['nifty auto','auto index'],
  FINNIFTY: ['finnifty','nifty financial services','financial services index'],
  NIFTYPHARMA: ['nifty pharma','pharma index'],
  NIFTYMID150: ['nifty midcap 150','midcap 150','nifty midcap index'],
  NIFTYHEALTH: ['nifty healthcare','healthcare index'],
  NIFTYMETAL: ['nifty metal','metal index'],
  NIFTYHOUSING: ['nifty housing','housing index'],
  NIFTYCONSUMPTION: ['nifty consumption','nifty india consumption','consumption index'],
  NIFTYOILGAS: ['nifty oil gas','nifty oil and gas','oil gas index'],
  NIFTYPSE: ['nifty pse','public sector index','pse index'],
  NIFTYCOMMODITIES: ['nifty commodities','commodities index'],
  NIFTYINFRA: ['nifty infra','nifty infrastructure','infra index'],
  NIFTYPSUBANK: ['nifty psu bank','psu bank index'],
  NIFTYDIGITAL: ['nifty india digital','digital index','india digital index'],
  NIFTYTOURISM: ['nifty india tourism','tourism index','india tourism index'],
  NIFTYMEDIA: ['nifty media','media index'],
  NIFTYREALTY: ['nifty realty','realty index'],
  GOLD: ['gold','mcx gold','comex gold','spot gold','bullion'], GOLDPETAL: ['gold petal','mcx gold petal','gold','mcx gold','comex gold','spot gold','bullion']
};

function newsClean(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    /* Remaining numeric entities (e.g. &#039; &#8217;) used to show up literally in headlines. */
    .replace(/&#(\d+);/g, (_, n) => { const c = +n; return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function newsNorm(s) { return newsClean(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
/* Duplicate key: first 12 words, ignoring a trailing " - Source" and currency words, so "add Rs.2 lakh cr ... -
   TradingView" and "add ₹2 lakh cr ..." (the same story from two feeds) count as one. */
function newsHash(s) {
  const t = newsClean(s).replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, '');
  return newsNorm(t).split(' ').filter(w => w && w !== 'rs' && w !== 'inr').slice(0, 12).join(' ');
}
function newsDateStr(ts) {
  const pubMs = Number.isFinite(ts) ? ts : Date.now();
  const ageHrs = Math.max(0, Math.round((Date.now() - pubMs) / 3600000));
  return ageHrs < 1 ? 'Just now' : ageHrs < 24 ? `${ageHrs}h ago` : `${Math.round(ageHrs/24)}d ago`;
}
function uniqueArr(a) { return Array.from(new Set((a || []).filter(Boolean))); }

/* MCX commodities other than gold: their own aliases, relevance words and search queries. Gold keeps its
   existing isGold path. ctx.isMacro = gold or one of these (market-wide news, not company news). */
const COMMODITY_NEWS = {
  CRUDEOIL:   { aliases:['crude oil','crude','brent','wti','oil prices','opec','oil inventories','mcx crude'],
                re:/\b(crude|brent|wti|oil price|oil prices|opec|barrel|eia|inventory|inventories|stockpiles|refiner|refinery)\b/,
                google:['crude oil price OPEC Brent WTI', 'crude oil inventories EIA oil prices'], gdelt:'("crude oil" OR "Brent crude" OR "WTI" OR "OPEC")' },
  SILVER:     { aliases:['silver','silver price','mcx silver','comex silver','precious metals','bullion'],
                re:/\b(silver|precious metal|precious metals|bullion|comex|dxy|dollar|federal reserve|fed)\b/,
                google:['silver price COMEX precious metals', 'silver gold prices Federal Reserve dollar'], gdelt:'("silver price" OR "COMEX silver" OR "precious metals")' },
  NATURALGAS: { aliases:['natural gas','henry hub','lng','gas prices','gas storage'],
                re:/\b(natural gas|henry hub|lng|gas storage|gas prices|heating demand|weather)\b/,
                google:['natural gas prices Henry Hub storage', 'LNG natural gas prices weather demand'], gdelt:'("natural gas" OR "Henry Hub" OR "LNG prices")' },
  COPPER:     { aliases:['copper','copper price','lme copper','comex copper','base metals'],
                re:/\b(copper|lme|base metal|base metals|smelter|china demand|china stimulus)\b/,
                google:['copper price LME COMEX China demand', 'base metals copper prices'], gdelt:'("copper price" OR "LME copper" OR "COMEX copper")' },
};
function buildNewsContext(stockName, sym) {
  const stockSym = String(sym || '').replace(/NSE:|MCX:|CRYPTO:/g,'').replace(/\.NS$|\.BO$/g,'').toUpperCase();
  const rawName = newsClean(stockName || stockSym);
  const baseName = rawName
    .replace(/\b(limited|ltd|india|corporation|corp|company|co\.?|services|service)\b/ig,' ')
    .replace(/\s+/g,' ').trim();
  const shortName = baseName.split(/\s+/).slice(0,2).join(' ');
  const firstWord = baseName.split(/\s+/)[0] || stockSym;
  const overrideKey = stockSym.replace(/&/g,'_').replace(/[^A-Z0-9_]/g,'');
  const isIndex = NSE_INDEX_CODES.has(stockSym);
  const isGold = /GOLD|GOLDPETAL/i.test(stockSym) || /gold/i.test(rawName);
  const genericBlock = new Set(['india','indian','limited','ltd','bank','finance','industries','industry','company','stock','share','market',
    'tata','bajaj','adani','mahindra','aditya','birla','godrej','jindal','jsw','hdfc','icici','bharat','hindustan','state','national','power','united','piramal','muthoot','torrent','apollo','max','sun']);
  const aliases = uniqueArr([
    stockSym, rawName, baseName, shortName,
    !genericBlock.has(firstWord.toLowerCase()) ? firstWord : '',
    ...(STOCK_ALIAS_OVERRIDES[overrideKey] || STOCK_ALIAS_OVERRIDES[stockSym] || []),
    ...(isIndex ? ['nifty','sensex','nse','bse','indian stock market'] : []),
    ...(isGold ? ['gold price','mcx gold','gold petal','comex gold','spot gold','usd inr','dxy','federal reserve','us treasury yields','inflation'] : [])
  ].map(a => newsNorm(a))).filter(a => a.length > 2);
  const commodity = !isGold && String(sym || '').startsWith('MCX:') && COMMODITY_NEWS[stockSym] ? stockSym : null;
  if (commodity) aliases.push(...COMMODITY_NEWS[commodity].aliases.map(a => newsNorm(a)));
  return { sym, stockSym, rawName, baseName, aliases: uniqueArr(aliases), isIndex, isGold, commodity, isMacro: isGold || !!commodity };
}

function newsRelevance(item, ctx) {
  const text = newsNorm(`${item.title || ''} ${item.desc || ''}`);
  if (!text) return 0;
  let score = 0;
  for (const a of ctx.aliases) {
    if (!a || a.length < 3) continue;
    const compactA = a.replace(/ /g,'');
    const compactT = text.replace(/ /g,'');
    if (text.includes(a)) score += a.split(' ').length >= 2 ? 35 : 18;
    else if (compactA.length >= 4 && compactT.includes(compactA)) score += 14;
  }
  if (ctx.isIndex && /\b(nifty|sensex|nse|bse|bank nifty|indian stock market)\b/.test(text)) score += 25;
  if (ctx.isGold && /\b(gold|bullion|comex|mcx|dxy|dollar|rupee|usd inr|federal reserve|treasury yields|inflation)\b/.test(text)) score += 30;
  if (ctx.commodity && COMMODITY_NEWS[ctx.commodity].re.test(text)) score += 30;
  /* Avoid bad broad matches: one generic word is not enough for company-specific news. */
  if (!ctx.isIndex && !ctx.isMacro && score < 18) return 0;
  return Math.min(100, score);
}

function normalizeNewsSentScore(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const t = v.toLowerCase();
    if (/bull|positive/.test(t)) return 0.5;
    if (/bear|negative/.test(t)) return -0.5;
    if (/neutral/.test(t)) return 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) <= 1) return +n.toFixed(2);
  if (Math.abs(n) <= 5) return +(n / 5).toFixed(2);
  return +Math.max(-1, Math.min(1, n / 100)).toFixed(2);
}

function classifyAndScoreNews(item, ctx) {
  const t = newsNorm(`${item.title || ''} ${item.desc || ''}`);
  /* The headline is scored first; the description is only used when the headline has no specific signal.
     Matching across title+description paired a "results" in the title with any "lower"/"loss" in the
     description ("stock jumps 7% after Q2 results" scored -30). */
  const tTitle = newsNorm(item.title || '');
  let cur = tTitle;
  let category = 'general';
  let impact = 0;

  const pos = (re, cat, points) => {
    if (!re.test(cur)) return;
    /* Equal-strength opposite signals (e.g. "profit falls despite revenue growth") are mixed, not positive
       just because the positive rule happened to be checked first. */
    if (Math.abs(points) === Math.abs(impact) && Math.sign(points) !== Math.sign(impact) && impact !== 0) { category = 'mixed'; impact = 0; return; }
    if (Math.abs(points) > Math.abs(impact)) { category = cat; impact = points; }
  };
  const rules = () => {
  pos(/\b(result|results|earnings|quarterly|q[1-4]|profit|revenue|margin|ebitda)\b.*\b(beat|beats|rise|rises|jumps|growth|strong|record)\b|\b(beat|beats)\b.*\b(estimates|profit|revenue)|\b(jump|jumps|rise|rises|surge|surges|rally|rallies|gain|gains|soar|soars|climb|climbs)\b.*\b(after|on|post)\b.*\b(results|earnings|q[1-4])\b/, 'result/earnings positive', +30);
  pos(/\b(result|results|earnings|quarterly|q[1-4]|profit|revenue|margin|ebitda)\b.*\b(miss|misses|fall|falls|decline|weak|loss|lower)\b|\b(miss|misses)\b.*\b(estimates|profit|revenue)|\b(fall|falls|slump|slumps|tank|tanks|plunge|plunges|drop|drops|slide|slides|tumble|tumbles)\b.*\b(after|on|post)\b.*\b(results|earnings|q[1-4])\b/, 'result/earnings negative', -30);
  pos(/\b(order win|wins order|bags order|contract win|large order|deal win|new contract|letter of award|loa)\b/, 'order win', +25);
  pos(/\b(sebi order|sebi bars|sebi bans|sebi notice|tax demand|tax notice|income tax raid|ed raid|ed summons|enforcement directorate|legal issue|lawsuit|court order against|penalty|fined|fine of|imposes fine|fraud|probe|investigation|raid|show cause)\b/, 'legal/regulatory risk', -30);
  pos(/\b(resigns|resignation|steps down|quit|quits|ceo exits|cfo exits|management exit)\b/, 'management resignation', -25);
  pos(/\b(dividend|bonus issue|stock split|split shares|buyback|record date)\b/, 'corporate action', +15);
  pos(/\b(upgrade|raises target|buy rating|initiates buy|outperform)\b/, 'broker upgrade', +10);
  pos(/\b(downgrade|cuts target|sell rating|underperform|reduce rating)\b/, 'broker downgrade', -10);
  pos(/\b(default|debt concern|credit rating downgrade|insolvency|nclt|bankruptcy)\b/, 'debt/credit risk', -35);
  pos(/\b(fire at|fire breaks|fire broke|major fire|shutdown|workers strike|labour strike|employees strike|plant shutdown|accident|blast|production halt)\b/, 'operational risk', -25);
  pos(/\b(acquisition|merger|stake sale|demerger|joint venture|jv)\b.*\b(approved|complete|buys|acquires)\b/, 'deal/corporate action', +10);
  };
  rules();
  if (impact === 0 && category !== 'mixed' && t !== tTitle) { cur = t; rules(); }

  /* Commodity supply / demand headlines (only when nothing more specific scored). */
  if (ctx.commodity === 'CRUDEOIL' && Math.abs(impact) < 20) {
    if (/\b(crude|oil|us) (stocks|inventories|stockpiles|supplies) (rise|rises|rose|climb|climbs|jump|jumps|increase|increases|build)\b/.test(t)) { category = 'crude bearish supply'; impact = -20; }
    else if (/\b(crude|oil|us) (stocks|inventories|stockpiles|supplies) (fall|falls|fell|drop|drops|decline|declines|draw)\b/.test(t)) { category = 'crude bullish supply'; impact = +20; }
    else if (/\b(output cut|production cut|supply cut|cuts output|inventory draw|inventories fell|stockpiles fell|crude draw|sanctions|supply disruption|outage|attack on|tensions escalate)\b/.test(t)) { category = 'crude bullish supply'; impact = +20; }
    else if (/\b(output hike|production increase|raise output|raises output|boost output|boosts output|inventory build|inventories rose|stockpiles rose|crude build|demand worries|demand concerns|ceasefire|surplus|glut)\b/.test(t)) { category = 'crude bearish supply'; impact = -20; }
  }
  if (ctx.commodity === 'NATURALGAS' && Math.abs(impact) < 20) {
    if (/\b(cold weather|colder|freeze|heating demand|storage draw|lng exports rise|supply disruption)\b/.test(t)) { category = 'gas bullish'; impact = +20; }
    else if (/\b(mild weather|mild winter|warmer|storage build|record production|record supply|supply growth|outpace demand|oversupply|surplus|el nino)\b/.test(t)) { category = 'gas bearish'; impact = -20; }
  }
  /* The commodity's own price move in the headline ("oil tops $116", "natgas prices climb"). The generic
     word count below is written for stock headlines ("Sensex lower as oil tops $116" read as bearish), so
     commodity headlines without a specific signal stay neutral. */
  if (ctx.commodity && Math.abs(impact) < 20) {
    const nm = { CRUDEOIL:'(?:crude|oil|brent|wti)', NATURALGAS:'(?:natural gas|natgas|gas|henry hub|lng)', SILVER:'(?:silver|precious metals|bullion)', COPPER:'(?:copper|base metals)' }[ctx.commodity];
    const up = new RegExp(`\\b${nm}\\b[^.;:]{0,40}?\\b(rise|rises|rose|jump|jumps|jumped|climb|climbs|climbed|surge|surges|surged|soar|soars|top|tops|gain|gains|rally|rallies|spike|spikes|higher|extends gains|hits? (?:a )?(?:\\w+ )?high)\\b`);
    const dn = new RegExp(`\\b${nm}\\b[^.;:]{0,40}?\\b(fall|falls|fell|drop|drops|dropped|decline|declines|declined|slip|slips|slipped|slump|slumps|slumping|slide|slides|ease|eases|eased|tumble|tumbles|plunge|plunges|crash|crashes|crashed|lose|loses|lower|sink|sinks|retreat|retreats|extends losses|hits? (?:a )?(?:\\w+ )?low)\\b`);
    for (const txt of [tTitle, t]) {
      /* Both directions in one headline ("copper slips ... premium hits decade high"): the verb closest to
         the commodity name wins. */
      const mu = up.exec(txt), md = dn.exec(txt);
      if (!mu && !md) continue;
      const u = mu && (!md || mu.index + mu[0].length < md.index + md[0].length);
      category = u ? `${ctx.commodity.toLowerCase()} price up` : `${ctx.commodity.toLowerCase()} price down`; impact = u ? +15 : -15; break;
    }
  }
  if (ctx.commodity === 'COPPER' && Math.abs(impact) < 20) {
    if (/\b(china stimulus|supply disruption|mine strike|mine closure|smelter cut|deficit)\b/.test(t)) { category = 'copper bullish'; impact = +20; }
    else if (/\b(china slowdown|weak china|demand worries|surplus|tariff)\b/.test(t)) { category = 'copper bearish'; impact = -20; }
  }
  if (ctx.isGold || ctx.commodity === 'SILVER') {
    /* Macro rules only apply when no stronger specific signal was found (a -30 legal story must not become +20). */
    if (Math.abs(impact) < 20 && /\b(rate cut|yields fall|yields drop|dxy falls|dollar weak|inflation fear|geopolitical|war|safe haven|fed dovish)\b/.test(t)) { category = 'gold bullish macro'; impact = +20; }
    else if (Math.abs(impact) < 20 && /\b(rate hike|yields rise|yields climb|dxy rises|dollar strong|fed hawkish|hot jobs|strong payrolls)\b/.test(t)) { category = 'gold bearish macro'; impact = -20; }
  }

  if (impact === 0 && category !== 'mixed' && !ctx.commodity) {
    /* Count market-direction words instead of a yes/no test: "crash", "bleeds", "slumps", "extends losses"
       are clearly bearish headlines but used to score only -5, which the label threshold treated as Neutral. */
    const hits = (txt) => [(txt.match(/\b(gain|gains|rise|rises|rally|rallies|surge|surges|soar|soars|jumps|climbs|rebound|rebounds|strong|positive|growth|record high|all time high|bull run|upbeat|buy)\b/g) || []).length,
    (txt.match(/\b(fall|falls|fell|drop|drops|loss|losses|decline|declines|weak|negative|slump|slumps|plunge|plunges|crash|crashes|tumble|tumbles|bleed|bleeds|sink|sinks|tank|tanks|sell off|selloff|wiped out|wipes out|rout|bloodbath|cuts|slip|slips|slipped|lowest)\b/g) || []).length];
    let [bullHits, bearHits] = hits(tTitle);
    if (!bullHits && !bearHits && t !== tTitle) [bullHits, bearHits] = hits(t);
    const net = bullHits - bearHits;
    impact = Math.max(-15, Math.min(15, net * 5));
    category = impact > 0 ? 'general positive' : impact < 0 ? 'general negative' : 'general';
  }

  const publishedAt = item.publishedAt || Date.now();
  const ageHrs = Math.max(0, (Date.now() - publishedAt) / 3600000);
  if (ageHrs > 72) impact *= 0.25;
  else if (ageHrs > 24) impact *= 0.5;

  const relevance = newsRelevance(item, ctx);
  const providerSentScore = 'providerSentScore' in item ? item.providerSentScore
    : normalizeNewsSentScore(item.sentScore ?? item.sentimentScore ?? item.sentiment);
  const normalizedSentScore = providerSentScore ?? +(Math.max(-1, Math.min(1, impact / 30))).toFixed(2);
  const s = impact >= 5 ? 'bull' : impact <= -5 ? 'bear' : 'neutral';
  return {
    ...item,
    symbol: ctx.stockSym,
    category,
    impactScore: Math.round(impact),
    relevanceScore: Math.round(relevance),
    duplicateHash: newsHash(item.title || item.link || ''),
    providerSentScore,
    sentScore: normalizedSentScore,
    s,
    date: item.date || newsDateStr(publishedAt),
  };
}

function finalizeNews(rawItems, ctx, opts = {}) {
  const seen = new Set();
  const out = [];
  const maxAgeHrs = opts.maxAgeHrs || 0;
  const minRelCompany = opts.minRelCompany ?? 18;
  const minRelGeneric = opts.minRelGeneric ?? 15;
  for (const raw of rawItems || []) {
    const title = newsClean(raw.title || '');
    if (title.length < 10) continue;
    const item = classifyAndScoreNews({ ...raw, title, desc: newsClean(raw.desc || raw.description || '') }, ctx);
    if (maxAgeHrs > 0) {
      const ageHrs = Math.max(0, (Date.now() - (item.publishedAt || Date.now())) / 3600000);
      if (ageHrs > maxAgeHrs) continue;
    }
    if (item.relevanceScore < minRelCompany && !ctx.isIndex && !ctx.isMacro) continue;
    if (item.relevanceScore < minRelGeneric && (ctx.isIndex || ctx.isMacro)) continue;
    const h = item.duplicateHash;
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(item);
  }
  return out.sort((a,b) => {
    /* Latest-first list. Relevance/impact only breaks ties inside the same freshness bucket. */
    const at = a.publishedAt || 0, bt = b.publishedAt || 0;
    const bucketA = Math.floor(at / (6*3600000));
    const bucketB = Math.floor(bt / (6*3600000));
    if (bucketA !== bucketB) return bucketB - bucketA;
    const scoreA = (a.relevanceScore || 0) + Math.abs(a.impactScore || 0);
    const scoreB = (b.relevanceScore || 0) + Math.abs(b.impactScore || 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    return bt - at;
  }).slice(0, 12);
}

function filterNewsAge(items, maxAgeHrs) {
  if (!maxAgeHrs) return items || [];
  const cutoff = Date.now() - maxAgeHrs * 3600000;
  return (items || []).filter(i => (i.publishedAt || Date.now()) >= cutoff);
}

async function fetchRssFeed(feed, ctx) {
  const r = await Promise.race([
    get(feed.url, {'Accept':'application/rss+xml,application/xml,text/xml,*/*'}),
    new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), feed.timeout || 4500)),
  ]);
  if (r.status !== 200) throw new Error(`RSS ${r.status}`);
  const items = [];
  const re = /<item[\s\S]*?>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(r.body)) !== null && items.length < 60) {
    const b = m[1];
    const title = newsClean(/<title[^>]*>([\s\S]*?)<\/title>/.exec(b)?.[1] || '');
    const link  = newsClean(/<link[^>]*>([\s\S]*?)<\/link>/.exec(b)?.[1] || '');
    const guid  = newsClean(/<guid[^>]*>([\s\S]*?)<\/guid>/.exec(b)?.[1] || '');
    const pub   = newsClean(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/.exec(b)?.[1] || '');
    const src   = newsClean(/<source[^>]*>([\s\S]*?)<\/source>/.exec(b)?.[1] || feed.src || 'RSS');
    const desc  = newsClean(/<description[^>]*>([\s\S]*?)<\/description>/.exec(b)?.[1] || '');
    const pubMs = pub ? new Date(pub).getTime() : Date.now();
    items.push({ title, source: src || feed.src, publishedAt: Number.isFinite(pubMs) ? pubMs : Date.now(), desc: desc.slice(0,220), link: link || guid, layer: feed.layer || 'rss' });
  }
  return items;
}

async function fetchNewsRSSLayer(ctx) {
  const qName = ctx.rawName;
  const qStock = ctx.stockSym;
  const feeds = [
    { url:'https://economictimes.indiatimes.com/markets/stocks/rssfeeds/2146842.cms', src:'Economic Times', layer:'rss' },
    { url:'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', src:'Economic Times Markets', layer:'rss' },
    { url:'https://www.moneycontrol.com/rss/marketsnews.xml', src:'Moneycontrol', layer:'rss' },
    { url:'https://www.moneycontrol.com/rss/business.xml', src:'Moneycontrol Business', layer:'rss' },
    { url:'https://www.business-standard.com/rss/markets-106.rss', src:'Business Standard Markets', layer:'rss' },
    { url:'https://www.livemint.com/rss/markets', src:'Livemint Markets', layer:'rss' },
    { url:'https://www.financialexpress.com/market/feed/', src:'Financial Express Markets', layer:'rss' },
    { url:'https://www.thehindubusinessline.com/markets/?service=rss', src:'BusinessLine Markets', layer:'rss' },
    { url:'https://www.zeebiz.com/market-news.xml', src:'Zee Business Markets', layer:'rss' },
    { url:'https://pulse.zerodha.com/feed.php', src:'Zerodha Pulse', layer:'rss' },
    { url:'https://www.bseindia.com/data/xml/notices.xml', src:'BSE Notices', layer:'rss', timeout:3200 },
    { url:'https://www.nseindia.com/rss/announcements.xml', src:'NSE Announcements', layer:'rss', timeout:3200 },
  ];
  const googleQueries = ctx.commodity ? COMMODITY_NEWS[ctx.commodity].google : ctx.isGold
    ? ['gold price India MCX COMEX DXY Federal Reserve', 'MCX gold USD INR rupee gold']
    : ctx.isIndex
      ? [`${qStock} Indian stock market NSE`, 'Nifty Sensex Indian stock market']
      : [`${qStock} NSE stock news`, `"${qName}" stock news`];
  for (const q of googleQueries) feeds.push({
    url:`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=en-IN&gl=IN&ceid=IN:en`,
    src:'Google News RSS', layer:'google-rss', timeout:3200
  });

  const settled = await Promise.all(feeds.map(async feed => {
    try {
      const items = await fetchRssFeed(feed, ctx);
      const relevant = finalizeNews(items, ctx);
      return { feed, relevant, ok:true };
    } catch(e) {
      return { feed, relevant:[], ok:false, error:e.message || 'failed' };
    }
  }));

  const all = [];
  const health = [];
  for (const r of settled) {
    if (r.ok) {
      health.push({source: r.feed.src, ok:true, found: r.relevant.length});
      all.push(...r.relevant.map(i => ({...i, source: i.source || r.feed.src, layer: r.feed.layer})));
    } else {
      health.push({source:r.feed.src, ok:false, error:r.error});
    }
  }
  return { items: finalizeNews(all, ctx), health };
}

async function fetchNewsGdelt(ctx) {
  const queries = ctx.commodity ? [COMMODITY_NEWS[ctx.commodity].gdelt] : ctx.isGold
    ? ['("gold price" OR "COMEX gold" OR "MCX gold" OR "DXY" OR "Federal Reserve")']
    : ctx.isIndex
      ? ['("Nifty" OR "Sensex" OR "Indian stock market")']
      : [`("${ctx.rawName}" OR "${ctx.stockSym}")`];
  const all = [];
  for (const q of queries) {
    try {
      const u = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&format=json&maxrecords=15&sort=HybridRel&timespan=7d`;
      const r = await Promise.race([get(u, {'Accept':'application/json'}), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),5000))]);
      if (r.status !== 200) continue;
      const d = JSON.parse(r.body);
      for (const a of (d.articles || [])) {
        const pubMs = a.seendate ? new Date(String(a.seendate).replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,'$1-$2-$3T$4:$5:$6Z')).getTime() : Date.now();
        all.push({ title:a.title, source:a.sourceCommonName || 'GDELT', publishedAt:Number.isFinite(pubMs)?pubMs:Date.now(), desc:a.seendate || '', link:a.url, layer:'gdelt' });
      }
    } catch(e) { /* keep chain alive */ }
  }
  return finalizeNews(all, ctx);
}

async function fetchNewsMarketauxLayer(ctx) {
  if (!MARKETAUX_KEY) return [];
  const after = new Date(Date.now() - 14*24*60*60*1000).toISOString().slice(0,16);
  const base = `filter_entities=true&language=en&limit=10&api_token=${encodeURIComponent(MARKETAUX_KEY)}&published_after=${after}`;
  const attempts = ctx.commodity
    ? [`https://api.marketaux.com/v1/news/all?search=${encodeURIComponent(COMMODITY_NEWS[ctx.commodity].google[0])}&${base}`]
    : ctx.isGold
    ? [`https://api.marketaux.com/v1/news/all?search=${encodeURIComponent('gold price OR bullion OR Federal Reserve')}&${base}`]
    : ctx.isIndex
      ? [`https://api.marketaux.com/v1/news/all?search=${encodeURIComponent('Indian stock market Nifty Sensex')}&countries=in&${base}`]
      : [
          `https://api.marketaux.com/v1/news/all?symbols=${encodeURIComponent(ctx.stockSym+'.NS')}&${base}`,
          `https://api.marketaux.com/v1/news/all?search=${encodeURIComponent('"'+ctx.rawName+'" stock')}&countries=in&${base}`,
          `https://api.marketaux.com/v1/news/all?search=${encodeURIComponent(ctx.stockSym+' NSE')}&countries=in&${base}`,
        ];
  const out=[];
  for (const u of attempts) {
    try {
      const r = await Promise.race([get(u, {'Accept':'application/json'}), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),5500))]);
      if (r.status === 429) break;
      if (r.status !== 200) continue;
      const d = JSON.parse(r.body);
      for (const a of (d.data || [])) {
        const ent = a.entities?.[0] || {};
        out.push({ title:a.title, source:a.source || 'Marketaux', publishedAt:a.published_at?new Date(a.published_at).getTime():Date.now(), desc:a.description || a.snippet || '', link:a.url, layer:'marketaux', providerSentScore: ent.sentiment_score ?? a.sentiment });
      }
      if (out.length) break;
    } catch(e) { }
  }
  return finalizeNews(out, ctx);
}

async function fetchNewsDataLayer(ctx) {
  if (!NEWSDATA_KEY) return [];
  const q = ctx.commodity ? COMMODITY_NEWS[ctx.commodity].aliases.slice(0, 4).join(' OR ') : ctx.isGold ? 'gold price OR MCX gold OR COMEX gold OR Federal Reserve OR DXY' : ctx.isIndex ? 'Nifty OR Sensex OR Indian stock market' : `"${ctx.rawName}" OR ${ctx.stockSym}`;
  const urls = [
    `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(NEWSDATA_KEY)}&q=${encodeURIComponent(q)}&language=en&category=business&size=10`,
    `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(NEWSDATA_KEY)}&q=${encodeURIComponent(q)}&language=en&country=in&size=10`,
  ];
  const out=[];
  for (const u of urls) {
    try {
      const r = await Promise.race([get(u, {'Accept':'application/json'}), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),5500))]);
      if (r.status !== 200) continue;
      const d = JSON.parse(r.body);
      for (const a of (d.results || [])) {
        out.push({ title:a.title, source:a.source_id || 'NewsData', publishedAt:a.pubDate?new Date(a.pubDate).getTime():Date.now(), desc:a.description || '', link:a.link, layer:'newsdata' });
      }
      if (out.length) break;
    } catch(e) { }
  }
  return finalizeNews(out, ctx);
}

async function fetchFinnhubLayer(ctx) {
  if (!FINNHUB_KEY) return [];
  /* Finnhub is best here for global/gold/macro. It is weak for Indian small stocks, so only use when gold/index/global-like. */
  if (!ctx.isMacro && !ctx.isIndex) return [];
  try {
    const from = new Date(Date.now() - 7*24*60*60*1000).toISOString().slice(0,10);
    const to = new Date().toISOString().slice(0,10);
    const u = `https://finnhub.io/api/v1/news?category=general&minId=0&token=${encodeURIComponent(FINNHUB_KEY)}`;
    const r = await Promise.race([get(u, {'Accept':'application/json'}), new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),5000))]);
    if (r.status !== 200) return [];
    const d = JSON.parse(r.body);
    const out = (Array.isArray(d) ? d : []).slice(0, 80).map(a => ({
      title:a.headline, source:a.source || 'Finnhub', publishedAt:a.datetime?a.datetime*1000:Date.now(), desc:a.summary || '', link:a.url, layer:'finnhub'
    }));
    return finalizeNews(out, ctx);
  } catch(e) { return []; }
}

function newsSummary(items, health, sourceUsed) {
  const totalImpact = (items || []).reduce((a,b)=>a+(b.impactScore||0),0);
  const bull = items.filter(i=>i.s==='bull').length;
  const bear = items.filter(i=>i.s==='bear').length;
  const topImpact = items.reduce((m,i)=>Math.abs(i.impactScore||0)>Math.abs(m.impactScore||0)?i:m,{impactScore:0});
  const healthOk = health.filter(h=>h.ok).length;
  return {
    sourceUsed, sourceHealth: health,
    newsScore: Math.max(-100, Math.min(100, totalImpact)),
    sentiment: totalImpact > 15 ? 'bull' : totalImpact < -15 ? 'bear' : 'neutral',
    counts: { total: items.length, bull, bear, neutral: items.length - bull - bear },
    healthLabel: items.length >= 5 ? 'Good' : items.length >= 2 ? 'Usable' : healthOk ? 'Weak' : 'Blocked/Empty',
    strongest: topImpact?.title ? { title: topImpact.title, impactScore: topImpact.impactScore, category: topImpact.category } : null,
  };
}

function withTimeoutFallback(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(fallback), ms))
  ]);
}

async function gatherAllNews(ctx) {
  const health = [];
  let sourceUsed = 'none';

  /* Layer 1: RSS/Google RSS/Pulse in parallel. Fast and free. */
  const rss = await withTimeoutFallback(fetchNewsRSSLayer(ctx), 6500, { items:[], health:[{source:'RSS layer', ok:false, error:'timeout'}] });
  health.push(...(rss.health || []));
  let items = finalizeNews(rss.items || [], ctx);
  if (items.length >= 4) sourceUsed = 'rss';

  /* Layer 2: only if RSS is weak. Run all backups in parallel so one slow API cannot freeze the tab. */
  if (items.length < 4) {
    const [gdelt, marketaux, newsdata, finnhub] = await Promise.all([
      withTimeoutFallback(fetchNewsGdelt(ctx), 6500, []),
      withTimeoutFallback(fetchNewsMarketauxLayer(ctx), 6500, []),
      withTimeoutFallback(fetchNewsDataLayer(ctx), 6500, []),
      (ctx.isMacro || ctx.isIndex) ? withTimeoutFallback(fetchFinnhubLayer(ctx), 6500, []) : Promise.resolve([]),
    ]);
    health.push({source:'GDELT', ok:true, found:gdelt.length});
    health.push({source:'Marketaux', ok:true, found:marketaux.length});
    health.push({source:'NewsData.io', ok:true, found:newsdata.length});
    if (ctx.isMacro || ctx.isIndex) health.push({source:'Finnhub', ok:true, found:finnhub.length});
    items = finalizeNews([...items, ...gdelt, ...marketaux, ...newsdata, ...finnhub], ctx);
    if (items.length) sourceUsed = items.some(i=>i.layer==='rss'||i.layer==='google-rss') ? 'mixed' : 'api-backup';
  }

  if (sourceUsed === 'none' && items.length) sourceUsed = 'mixed';
  return { items, health, sourceUsed };
}

async function apiNews(req, res, p) {
  /* Cap user-supplied inputs: the cache key is built from them and every miss fans out to ~14 feeds. */
  const sym  = String(p.get('sym')  || 'NSE:NIFTY').slice(0, 40);
  const raw  = String(p.get('name') || sym).slice(0, 80);
  const name = raw.replace(/MCX:|NSE:|CRYPTO:/g,'').replace(/[()]/g,'').trim();
  const ctx  = buildNewsContext(name, sym);
  const key  = `news_v13_${sym}_${newsHash(name)}`;

  if (NEWS_CACHE[key] && Date.now() - NEWS_CACHE[key].ts < (NEWS_CACHE[key].ttl || NEWS_TTL)) {
    return send(res, { ...NEWS_CACHE[key].payload, cached: true, updatedAt: new Date(NEWS_CACHE[key].ts).toISOString() });
  }

  try {
    /* Concurrent requests for the same key share one fetch instead of each fanning out. */
    let pending = NEWS_INFLIGHT.get(key);
    if (!pending) {
      pending = gatherAllNews(ctx).finally(() => NEWS_INFLIGHT.delete(key));
      NEWS_INFLIGHT.set(key, pending);
    }
    const all = await pending;
    const fresh24 = finalizeNews(filterNewsAge(all.items, 24), ctx, { maxAgeHrs: 24 });
    const week = finalizeNews(filterNewsAge(all.items, 168), ctx, { maxAgeHrs: 168 });
    const useFresh = fresh24.length >= 2;
    const finalItems = useFresh ? fresh24 : week;
    const sourceUsed = all.sourceUsed === 'none' && finalItems.length ? 'mixed' : all.sourceUsed;
    const payload = {
      items: finalItems,
      sym,
      source: sourceUsed,
      window: useFresh ? '24h' : '7d fallback',
      summary: newsSummary(finalItems, all.health, sourceUsed)
    };
    payload.summary.window = payload.window;
    const ttl = finalItems.length ? (ctx.isMacro ? NEWS_SOURCE_TTL.gold : NEWS_TTL) : EMPTY_NEWS_TTL;
    NEWS_CACHE[key] = { payload, ts: Date.now(), ttl };
    pruneNewsCache();
    send(res, { ...payload, updatedAt: new Date().toISOString() });
  } catch(e) {
    console.error('News engine error:', e.message);
    const fallback = NEWS_CACHE[key]?.payload || { items:[], sym, source:'cache', window:'error', summary:newsSummary([], [], 'cache') };
    send(res, { ...fallback, error: e.message, updatedAt: new Date().toISOString() });
  }
}

/* ── STOCK SEARCH ── */
const STOCK_NAMES = {
  /* NSE stocks only from uploaded Excel. Indices are intentionally excluded from Stock Search. */
  'RELIANCE':'Reliance Industries',
  'HDFCBANK':'HDFC Bank',
  'BHARTIARTL':'Bharti Airtel',
  'ICICIBANK':'ICICI Bank',
  'SBIN':'SBI',
  'TCS':'TCS',
  'BAJFINANCE':'Bajaj Finance',
  'LT':'Larsen & Toubro',
  'HINDUNILVR':'Hind. Unilever',
  'LICI':'Life Insurance',
  'INFY':'Infosys',
  'SUNPHARMA':'Sun Pharma.Inds.',
  'ADANIPOWER':'Adani Power',
  'MARUTI':'Maruti Suzuki',
  'ADANIPORTS':'Adani Ports',
  'ITC':'ITC',
  'AXISBANK':'Axis Bank',
  'M&M':'M & M',
  'KOTAKBANK':'Kotak Mah. Bank',
  'NTPC':'NTPC',
  'ONGC':'O N G C',
  'TITAN':'Titan Company',
  'ADANIENT':'Adani Enterp.',
  'ULTRACEMCO':'UltraTech Cem.',
  'HCLTECH':'HCL Technologies',
  'JSWSTEEL':'JSW Steel',
  'BEL':'Bharat Electron',
  'HAL':'Hind.Aeronautics',
  'BAJAJ-AUTO':'Bajaj Auto',
  'COALINDIA':'Coal India',
  'BAJAJFINSV':'Bajaj Finserv',
  'POWERGRID':'Power Grid Corpn',
  'DMART':'Avenue Super.',
  'NESTLEIND':'Nestle India',
  'HINDZINC':'Hindustan Zinc',
  'TATASTEEL':'Tata Steel',
  'ASIANPAINT':'Asian Paints',
  'ETERNAL':'Eternal',
  'HINDALCO':'Hindalco Inds.',
  'ADANIGREEN':'Adani Green',
  'SHRIRAMFIN':'Shriram Finance',
  'WIPRO':'Wipro',
  'GRASIM':'Grasim Inds',
  'IOC':'I O C L',
  'EICHERMOT':'Eicher Motors',
  'SBILIFE':'SBI Life Insuran',
  'DIVISLAB':'Divi\'s Lab.',
  'VBL':'Varun Beverages',
  'BSE':'BSE',
  'SOLARINDS':'Solar Industries',
  'INDIGO':'Interglobe Aviat',
  'ADANIENSOL':'Adani Energy Sol',
  'TVSMOTOR':'TVS Motor Co.',
  'JIOFIN':'Jio Financial',
  'ICICIAMC':'ICICI AMC',
  'TORNTPHARM':'Torrent Pharma.',
  'POWERINDIA':'Hitachi Energy',
  'PIDILITIND':'Pidilite Inds.',
  'IDEA':'Vodafone Idea',
  'CUMMINSIND':'Cummins India',
  'TRENT':'Trent',
  'HYUNDAI':'Hyundai Motor I',
  'TECHM':'Tech Mahindra',
  'DLF':'DLF',
  'PFC':'Power Fin.Corpn.',
  'BHEL':'B H E L',
  'TMCV':'Tata Motors',
  'MOTHERSON':'Samvardh. Mothe.',
  'POLYCAB':'Polycab India',
  'BANKBARODA':'Bank of Baroda',
  'ABB':'A B B',
  'TMPV':'Tata Motors PVeh',
  'MUTHOOTFIN':'Muthoot Finance',
  'TATAPOWER':'Tata Power Co.',
  'VEDL':'Vedanta',
  'HDFCLIFE':'HDFC Life Insur.',
  'BRITANNIA':'Britannia Inds.',
  'CGPOWER':'CG Power & Ind',
  'CHOLAFIN':'Cholaman.Inv.&Fn',
  'TATACAP':'Tata Capital',
  'IRFC':'I R F C',
  'SIEMENS':'Siemens',
  'LTIM':'LTM',
  'JINDALSTEL':'Jindal Steel',
  'BPCL':'B P C L',
  'UNIONBANK':'Union Bank (I)',
  'TATACONSUM':'Tata Consumer',
  'GROWW':'Billionbrains',
  'PNB':'Punjab Natl.Bank',
  'APOLLOHOSP':'Apollo Hospitals',
  'BAJAJHLDNG':'Bajaj Holdings',
  'CANBK':'Canara Bank',
  'CIPLA':'Cipla',
  'HDFCAMC':'HDFC AMC',
  'INDUSTOWER':'Indus Towers',
  'ENRIN':'Siemens Ener.Ind',
  'GVT&D':'GE Vernova T&D',
  'DRREDDY':'Dr Reddy\'s Labs',
  'INDIANB':'Indian Bank',
  'BOSCHLTD':'Bosch',
  'MARICO':'Marico',
  'AMBUJACEM':'Ambuja Cements',
  'LUPIN':'Lupin',
  'GODREJCP':'Godrej Consumer',
  'MAXHEALTH':'Max Healthcare',
  'MANKIND':'Mankind Pharma',
  'GAIL':'GAIL (India)',
  'LGEINDIA':'LG Electronics',
  'ZYDUSLIFE':'Zydus Lifesci.',
  'HEROMOTOCO':'Hero Motocorp',
  'GMRAIRPORT':'GMR Airports',
  'MAZDOCK':'Mazagon Dock',
  'UNITDSPR':'United Spirits',
  'LLOYDSME':'Lloyds Metals',
  'JSWENERGY':'JSW Energy',
  'INDHOTEL':'Indian Hotels Co',
  'ABCAPITAL':'Aditya Birla Cap',
  'ICICIGI':'ICICI Lombard',
  'NTPCGREEN':'NTPC Green Ene.',
  'LODHA':'Lodha Developers',
  'ASHOKLEY':'Ashok Leyland',
  'BHARATFORG':'Bharat Forge',
  'MEESHO':'Meesho',
  'SHREECEM':'Shree Cement',
  'RECLTD':'REC Ltd',
  'AUROPHARMA':'Aurobindo Pharma',
  'MCX':'Multi Comm. Exc.',
  'WAAREEENER':'Waaree Energies',
  'LENSKART':'Lenskart Solut.',
  'OFSS':'Oracle Fin.Serv.',
  'POLICYBZR':'PB Fintech.',
  'SAIL':'S A I L',
  'OIL':'Oil India',
  'BHARTIHEXA':'Bharti Hexacom',
  'DABUR':'Dabur India',
  'PERSISTENT':'Persistent Systems',
  'NHPC':'NHPC Ltd',
  'IDBI':'IDBI Bank',
  'HINDPETRO':'H P C L',
  'NMDC':'NMDC',
  'SRF':'SRF',
  'NYKAA':'FSN E-Commerce',
  'HAVELLS':'Havells India',
  'ICICIPRULI':'ICICI Pru Life',
  'TORNTPOWER':'Torrent Power',
  'NATIONALUM':'Natl. Aluminium',
  'AUBANK':'AU Small Finance',
  'LAURUSLABS':'Laurus Labs',
  'FORTIS':'Fortis Health.',
  'SUZLON':'Suzlon Energy',
  'SWIGGY':'Swiggy',
  'PAYTM':'One 97',
  'FEDERALBNK':'Federal Bank',
  'BAJAJHFL':'Bajaj Housing',
  'INDUSINDBK':'IndusInd Bank',
  'LTF':'L&T Finance Ltd',
  'BIOCON':'Biocon',
  'NAM-INDIA':'Nippon Life Ind.',
  'YESBANK':'Yes Bank',
  'ATGL':'Adani Total Gas',
  'GICRE':'General Insuranc',
  'GLENMARK':'Glenmark Pharma.',
  'DIXON':'Dixon Technolog.',
  'ALKEM':'Alkem Lab',
  'IOB':'I O B',
  'BANKINDIA':'Bank of India',
  'LINDEINDIA':'Linde India',
  'SCHAEFFLER':'Schaeffler India',
  'PHOENIXLTD':'Phoenix Mills',
  'JSL':'Jindal Stain.',
  'COFORGE':'Coforge',
  'UNOMINDA':'Uno Minda',
  'NAUKRI':'Info Edg.(India)',
  'MAHABANK':'Bank of Maha',
  'COLPAL':'Colgate-Palmoliv',
  'SBICARD':'SBI Cards',
  'PRESTIGE':'Prestige Estates',
  'BERGEPAINT':'Berger Paints',
  'ABBOTINDIA':'Abbott India',
  'OBEROIRLTY':'Oberoi Realty',
  'IDFCFIRSTB':'IDFC First Bank',
  'VMM':'Vishal Mega Mart',
  'RVNL':'Rail Vikas',
  'FACT':'F A C T',
  'HDBFS':'HDB FINANC SER',
  'TIINDIA':'Tube Investments',
  'JSWINFRA':'JSW Infrast',
  'MFSL':'Max Financial',
  'COROMANDEL':'Coromandel Inter',
  'HINDCOPPER':'Hindustan Copper',
  'MRF':'MRF',
  'UPL':'UPL',
  'THERMAX':'Thermax',
  'KRT':'Knowledge Realty',
  'APLAPOLLO':'APL Apollo Tubes',
  'GODREJPROP':'Godrej Propert.',
  'MOTILALOFS':'Motil.Oswal.Fin.',
  'PATANJALI':'Patanjali Foods',
  'ALTIUSINVIT':'Altius Telecom',
  'SUNDARMFIN':'Sundaram Finance',
  'NLCINDIA':'NLC India',
  'APARINDS':'Apar Inds.',
  'KEI':'KEI Industries',
  'RADICO':'Radico Khaitan',
  'BDL':'Bharat Dynamics',
  'PIIND':'P I Industries',
  'TATACOMM':'Tata Comm',
  'PREMIERENE':'Premier Energies',
  '360ONE':'360 ONE',
  'M&MFIN':'M & M Fin. Serv.',
  'ANTHEM':'Anthem Bioscienc',
  'PIRAMALFIN':'Piramal Finance.',
  'SUPREMEIND':'Supreme Inds.',
  'PAGEIND':'Page Industries',
  'VOLTAS':'Voltas',
  'MPHASIS':'Mphasis',
  'IRCTC':'I R C T C',
  'AIIL':'Authum Invest',
  'IPCALAB':'Ipca Labs.',
  'JKCEMENT':'J K Cements',
  'FLUOROCHEM':'Gujarat Fluoroch',
  'BALKRISIND':'Balkrishna Inds',
  'EMBASSY':'Embassy Off.REIT',
  'AJANTPHARM':'Ajanta Pharma',
  'GLAXO':'Glaxosmi. Pharma',
  'HUDCO':'H U D C O',
  'PETRONET':'Petronet LNG',
  'COCHINSHIP':'Cochin Shipyard',
  'ASTRAL':'Astral',
  'ASTERDM':'Aster DM Health.',
  'NH':'Narayana Hrudaya',
  'CONCOR':'Container Corpn.',
  'GODREJIND':'Godrej Industrie',
  'LTTS':'L&T Technology',
  'AIAENG':'AIA Engineering',
  'GLAND':'Gland Pharma',
  'GODFRYPHLP':'Godfrey Phillips',
  'NAVINFLUOR':'Navin Fluo.Intl.',
  'SONACOMS':'Sona BLW Precis.',
  '3MINDIA':'3M India',
  'IREDA':'Indian Renewable',
  'ENDURANCE':'Endurance Tech.',
  'UBL':'United Breweries',
  'POONAWALLA':'Poonawalla Fin',
  'KALYANKJIL':'Kalyan Jewellers',
  'ATHERENERG':'Ather Energy',
  'JBCHEPHARM':'J B Chemicals &',
  'BLUESTARCO':'Blue Star',
  'DELHIVERY':'Delhivery',
  'WELCORP':'Welspun Corp',
  'TATAINVEST':'Tata Inv.Corpn.',
  'MEDANTA':'Global Health',
  'KPRMILL':'K P R Mill Ltd',
  'EMCURE':'Emcure Pharma',
  'PWL':'Physicswallah',
  'ITCHOTELS':'ITC Hotels',
  'ESCORTS':'Escorts Kubota',
  'DALBHARAT':'Dalmia BharatLtd',
  'PGHH':'P & G Hygiene',
  'CHOLAHLDNG':'Chola Financial',
  'HEXT':'Hexaware Tech.',
  'JUBLFOOD':'Jubilant Food.',
  'MINDSPACE':'Mindspace Busine',
  'UCOBANK':'UCO Bank',
  'NHIT':'National High',
  'CENTRALBK':'Central Bank',
  'BANDHANBNK':'Bandhan Bank',
  'GRSE':'Garden Reach Sh.',
  'STARHEALTH':'Star Health Insu',
  'CRISIL':'CRISIL',
  'ABSLAMC':'Aditya AMC',
};

async function searchStocks(q) {
  const ql = q.toLowerCase();

  /* Local search — runs instantly from expanded list */
  const local = Object.entries(STOCK_NAMES)
    .filter(([s]) => !NSE_INDEX_CODES.has(s))
    .filter(([s,n]) => s.toLowerCase().includes(ql) || n.toLowerCase().includes(ql))
    .slice(0,8)
    .map(([s,n]) => ({
      symbol: s,
      name: n,
      exchange: NSE_INDEX_CODES.has(s) ? 'INDEX' : 'NSE',
      type: NSE_INDEX_CODES.has(s) ? 'INDEX' : 'EQUITY',
    }));

  /* If local already has 5+ matches, skip Yahoo to save time */
  if (local.length >= 5) return local;

  /* Try Yahoo Finance search as supplement — with short timeout */
  try {
    const r = await Promise.race([
      get(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&lang=en-IN&region=IN&quotesCount=8&newsCount=0`, {
        'Accept':'application/json',
      }),
      new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 4000)),
    ]);
    if (r.status === 200) {
      const d = JSON.parse(r.body);
      const yf = (d.quotes||[])
        .filter(s => (s.exchange==='NSI'||s.exchange==='BSI'||(s.symbol&&s.symbol.endsWith('.NS'))) && s.quoteType==='EQUITY')
        .slice(0,6)
        .map(s => ({
          symbol: (s.symbol||'').replace('.NS','').replace('.BO',''),
          name: s.shortname||s.longname||s.symbol||'',
          exchange: s.exchange==='BSI'?'BSE':'NSE',
          type: 'EQUITY',
        }))
        .filter(s => s.symbol && s.name);
      const seen = new Set(local.map(s => s.symbol));
      return [...local, ...yf.filter(s => !seen.has(s.symbol))].slice(0,8);
    }
  } catch { /* Yahoo blocked or timed out — use local only */ }

  return local;
}



/* ══════════════════════════════════════════════════════════════════════
   OPTIONS STRATEGY ENGINE  (v8.1)

   Endpoint: GET /api/strategy
   Params:
     sym      — underlying symbol, e.g. NSE:NIFTY  (default NSE:NIFTY)
     strategy — iron_condor | bull_call_spread | bear_put_spread |
                long_straddle | long_strangle | covered_call |
                protective_put | bull_put_spread | bear_call_spread
     spot     — current spot price (optional, fetched live if omitted)
     expiry   — days to expiry (default 30)
     iv       — implied volatility % (default 15 for NIFTY/BANKNIFTY)

   Each strategy returns:
     - legs[]          : each option leg (type, action, strike, premium est.)
     - maxProfit       : maximum profit potential (₹ per lot)
     - maxLoss         : maximum loss (₹ per lot, null = unlimited)
     - breakeven[]     : breakeven price(s)
     - profitZone      : description of profitable price range
     - Greeks (approx): delta, theta, vega for the combined position
     - payoff[]        : payoff table at ±10% spot range (for charting)
     - lotSize         : standard lot size for the symbol
     - margin          : approx margin required
══════════════════════════════════════════════════════════════════════ */

/* ── Black-Scholes helpers ── */
function cdf(x) {
  /* Normal CDF via erf approximation.
     Previous build used the erf coefficients directly on x and produced wrong deltas
     (example: N(1) ≈ 0.870 instead of 0.841). Correct formula is
     N(x) = 0.5 * (1 + erf(x / sqrt(2))). */
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1/(1+p*z);
  const erf = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-z*z);
  return 0.5*(1+sign*erf);
}

function bsPrice(S, K, T, r, sigma, type) {
  /* S=spot K=strike T=years r=riskfree sigma=IV type=C|P */
  if (T <= 0) return Math.max(0, type==='C' ? S-K : K-S);
  const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  if (type === 'C') return S*cdf(d1) - K*Math.exp(-r*T)*cdf(d2);
  return K*Math.exp(-r*T)*cdf(-d2) - S*cdf(-d1);
}

function bsGreeks(S, K, T, r, sigma, type) {
  if (T <= 0) return { delta: type==='C'?(S>K?1:0):(S<K?-1:0), gamma:0, theta:0, vega:0 };
  const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  const pdf1 = Math.exp(-0.5*d1*d1)/Math.sqrt(2*Math.PI);
  const delta = type==='C' ? cdf(d1) : cdf(d1)-1;
  const gamma = pdf1/(S*sigma*Math.sqrt(T));
  const theta = type==='C'
    ? (-(S*pdf1*sigma)/(2*Math.sqrt(T)) - r*K*Math.exp(-r*T)*cdf(d2))/365
    : (-(S*pdf1*sigma)/(2*Math.sqrt(T)) + r*K*Math.exp(-r*T)*cdf(-d2))/365;
  const vega  = S*pdf1*Math.sqrt(T)/100; /* per 1% IV move */
  return { delta:+delta.toFixed(4), gamma:+gamma.toFixed(6), theta:+theta.toFixed(2), vega:+vega.toFixed(2) };
}

/* Round strike to nearest standard interval */
function nearestStrike(price, interval) {
  return Math.round(price / interval) * interval;
}

function getStrikeInterval(sym, spot) {
  if (sym.includes('BANKNIFTY'))   return 100;
  if (sym.includes('FINNIFTY'))    return 50;
  if (sym.includes('NIFTY'))       return 50;
  if (sym.includes('SENSEX'))      return 100;
  /* For stocks: round to nearest clean interval based on price */
  if (spot >= 5000) return 50;
  if (spot >= 1000) return 20;
  if (spot >= 500)  return 10;
  if (spot >= 100)  return 5;
  return 2;
}

function getLotSize(sym) {
  /* NSE F&O lot sizes — VERIFIED from Dhan April 2026
     SEBI revised index lot sizes effective Jan 27 2026 (NSE Circular FAOP70616)
     NIFTY: 75→65, BANKNIFTY: 35→30, FINNIFTY: 65→60      */
  const lots = {
    /* ── INDICES (revised Jan 2026) ── */
    'NSE:NIFTY':65, 'NSE:BANKNIFTY':30,
    'NSE:FINNIFTY':60, 'NSE:NIFTYNXT50':25,

    /* ── STOCKS — verified April 2026 from Dhan ── */
    'NSE:360ONE':500,    'NSE:ABB':125,        'NSE:ABCAPITAL':3100,
    'NSE:ADANIENSOL':675,'NSE:ADANIENT':309,   'NSE:ADANIGREEN':600,
    'NSE:ADANIPORTS':475,'NSE:ADANIPOWER':3550,'NSE:ALKEM':125,
    'NSE:AMBER':100,     'NSE:AMBUJACEM':1050, 'NSE:ANGELONE':2500,
    'NSE:APLAPOLLO':350, 'NSE:APOLLOHOSP':125, 'NSE:ASHOKLEY':5000,
    'NSE:ASIANPAINT':250,'NSE:ASTRAL':425,      'NSE:AUBANK':1000,
    'NSE:AUROPHARMA':550,'NSE:AXISBANK':625,
    'NSE:BAJAJ-AUTO':75, 'NSE:BAJAJFINSV':250, 'NSE:BAJAJHLDNG':50,
    'NSE:BAJFINANCE':750,'NSE:BANDHANBNK':3600,'NSE:BANKBARODA':2925,
    'NSE:BANKINDIA':5200,'NSE:BDL':350,         'NSE:BEL':1425,
    'NSE:BHARATFORG':500,'NSE:BHARTIARTL':475, 'NSE:BHEL':2625,
    'NSE:BIOCON':2500,   'NSE:BLUESTARCO':325, 'NSE:BOSCHLTD':25,
    'NSE:BPCL':1975,     'NSE:BRITANNIA':125,  'NSE:BSE':375,
    'NSE:CAMS':750,      'NSE:CANBK':6750,     'NSE:CDSL':475,
    'NSE:CGPOWER':850,   'NSE:CHOLAFIN':625,   'NSE:CIPLA':375,
    'NSE:COALINDIA':1350,'NSE:COCHINSHIP':400, 'NSE:COFORGE':375,
    'NSE:COLPAL':225,    'NSE:CONCOR':1250,    'NSE:CROMPTON':1800,
    'NSE:CUMMINSIND':200,'NSE:DABUR':1250,     'NSE:DALBHARAT':325,
    'NSE:DELHIVERY':2075,'NSE:DIVISLAB':100,   'NSE:DIXON':50,
    'NSE:DLF':825,       'NSE:DMART':150,      'NSE:DRREDDY':625,
    'NSE:EICHERMOT':100, 'NSE:ETERNAL':2425,   'NSE:EXIDEIND':1800,
    'NSE:FEDERALBNK':5000,'NSE:FORCEMOT':25,   'NSE:FORTIS':775,
    'NSE:GAIL':3150,     'NSE:GLENMARK':375,   'NSE:GMRAIRPORT':6975,
    'NSE:GODREJCP':500,  'NSE:GODREJPROP':275, 'NSE:GRASIM':250,
    'NSE:HAL':150,       'NSE:HAVELLS':500,    'NSE:HCLTECH':350,
    'NSE:HDFCAMC':300,   'NSE:HDFCBANK':550,   'NSE:HDFCLIFE':1100,
    'NSE:HEROMOTOCO':150,'NSE:HINDALCO':700,   'NSE:HINDPETRO':2025,
    'NSE:HINDUNILVR':300,'NSE:HINDZINC':1225,  'NSE:HUDCO':2775,
    'NSE:HYUNDAI':275,   'NSE:ICICIBANK':700,  'NSE:ICICIGI':325,
    'NSE:ICICIPRULI':2000,'NSE:IDFCFIRSTB':7500,'NSE:IEX':3750,
    'NSE:INDHOTEL':1500, 'NSE:INDIGO':325,     'NSE:INDUSINDBK':500,
    'NSE:INFY':400,      'NSE:IOC':5000,       'NSE:IRCTC':325,
    'NSE:IRFC':4000,     'NSE:ITC':1600,       'NSE:JINDALSTEL':625,
    'NSE:JSL':3000,      'NSE:JSWENERGY':750,  'NSE:JSWSTEEL':675,
    'NSE:JUBLFOOD':750,  'NSE:KALYANKJIL':1375,'NSE:KAYNES':75,
    'NSE:KEI':175,       'NSE:KPITTECH':500,   'NSE:KOTAKBANK':400,
    'NSE:LT':175,        'NSE:LTIM':150,       'NSE:LTTS':100,
    'NSE:LICHSGFIN':1250,'NSE:LICI':700,       'NSE:LODHA':1125,
    'NSE:LUPIN':425,     'NSE:M&M':175,        'NSE:M&MFIN':2000,
    'NSE:MARICO':1250,   'NSE:MARUTI':65,      'NSE:MAXHEALTH':375,
    'NSE:MCX':125,       'NSE:MFSL':1125,      'NSE:MOTHERSON':4350,
    'NSE:MPHASIS':275,   'NSE:MRF':15,         'NSE:MUTHOOTFIN':350,
    'NSE:NATIONALUM':3750,'NSE:NAUKRI':75,     'NSE:NESTLEIND':50,
    'NSE:NHPC':6500,     'NSE:NMDC':2500,      'NSE:NTPC':2250,
    'NSE:OBEROIRLTY':325,'NSE:OFSS':50,        'NSE:ONGC':1925,
    'NSE:PAGEIND':15,    'NSE:PATANJALIFOODS':375,'NSE:PERSISTENT':125,
    'NSE:PFC':2300,      'NSE:PHOENIXLTD':500, 'NSE:PIDILITIND':250,
    'NSE:PIIND':250,     'NSE:POLYCAB':125,    'NSE:POWERGRID':2900,
    'NSE:PRESTIGE':625,  'NSE:PVRINOX':1000,   'NSE:RECLTD':2300,
    'NSE:RELIANCE':250,  'NSE:SAIL':5850,      'NSE:SBICARD':1500,
    'NSE:SBILIFE':750,   'NSE:SBIN':1500,      'NSE:SHRIRAMFIN':350,
    'NSE:SIEMENS':100,   'NSE:SJVN':7000,      'NSE:SONACOMS':1500,
    'NSE:SRF':175,       'NSE:SUNPHARMA':350,  'NSE:SUNTV':1500,
    'NSE:SUPREMEIND':175,'NSE:SUZLON':7000,    'NSE:TATACOMM':500,
    'NSE:TATACONSUM':875,'NSE:TATAMOTORS':550, 'NSE:TATAPOWER':2700,
    'NSE:TATASTEEL':550, 'NSE:TCS':175,        'NSE:TECHM':600,
    'NSE:TIINDIA':250,   'NSE:TITAN':375,      'NSE:TORNTPHARM':250,
    'NSE:TORNTPOWER':375,'NSE:TRENT':175,      'NSE:TVSMOTOR':350,
    'NSE:ULTRACEMCO':100,'NSE:UNIONBANK':5400, 'NSE:UPL':2500,
    'NSE:VEDL':1375,     'NSE:VOLTAS':500,     'NSE:WIPRO':1500,
    'NSE:YESBANK':40000, 'NSE:ZOMATO':2425,    'NSE:ZYDUSLIFE':600,
  };
  return lots[sym] || null; /* return null if unknown — caller uses fallback */
}

/* Estimate premium using BS with a slight IV skew */
function estimatePremium(S, K, T, iv, type) {
  const r = 0.065; /* India risk-free ~6.5% */
  /* Equity/index skew is downside-heavy: strikes BELOW spot (OTM puts) trade at higher IV, strikes
     above spot (OTM calls) slightly lower. The old symmetric bump made OTM calls too expensive.
     Approximation: about +3 vol-% per 1% below spot (x base IV), -1 per 1% above, clamped. */
  const down = Math.max(0, (S - K) / S), up = Math.max(0, (K - S) / S);
  const skewAdj = Math.min(1.6, Math.max(0.75, 1 + 3.0 * down - 1.0 * up));
  return Math.max(0.5, bsPrice(S, K, T, r, iv * skewAdj, type));
}

/* Build payoff table — spot range ±12% in 25 steps */
function buildPayoff(spot, legs, lotSize) {
  const lo = spot * 0.88, hi = spot * 1.12;
  const step = (hi - lo) / 40;
  const points = [];
  for (let s = lo; s <= hi + step/2; s += step) {
    const S = +s.toFixed(0);
    let pl = 0;
    for (const leg of legs) {
      let legPL = 0;
      if (leg.type === 'STOCK') {
        /* Underlying leg payoff. premium = entry price. */
        legPL = leg.action==='BUY' ? (S - leg.premium) * lotSize : (leg.premium - S) * lotSize;
      } else {
        const intrinsic = leg.type==='C' ? Math.max(0, S-leg.strike) : Math.max(0, leg.strike-S);
        legPL = leg.action==='BUY'
          ? (intrinsic - leg.premium) * lotSize
          : (leg.premium - intrinsic) * lotSize;
      }
      pl += legPL;
    }
    points.push({ spot: S, pl: +pl.toFixed(0) });
  }
  return points;
}

/* Exact expiry statistics for any set of legs.
   Expiry P&L is piecewise-linear with kinks only at strikes, so max/min and breakevens can be
   found exactly from the P&L at S=0, at each strike, and from the slope above the highest strike.
   Returns maxProfit/maxLoss in ₹ per position (null = unlimited) and breakevens in price. */
function expiryPL(S, legs, lotSize) {
  let pl = 0;
  for (const leg of legs) {
    if (leg.type === 'STOCK') pl += (leg.action==='BUY' ? S - leg.premium : leg.premium - S) * lotSize;
    else {
      const intrinsic = leg.type==='C' ? Math.max(0, S-leg.strike) : Math.max(0, leg.strike-S);
      pl += (leg.action==='BUY' ? intrinsic - leg.premium : leg.premium - intrinsic) * lotSize;
    }
  }
  return pl;
}
function expiryStats(legs, lotSize) {
  const strikes = [...new Set(legs.map(l => +l.strike).filter(Number.isFinite))].sort((a,b)=>a-b);
  const pts = [0, ...strikes.filter(k => k > 0)];
  const top = pts[pts.length-1];
  /* Slope of P&L (per ₹1 of spot) above the highest strike: calls and stock are live there, puts are not. */
  const slope = legs.reduce((a,l) => a + ((l.type==='C' || l.type==='STOCK') ? (l.action==='BUY' ? 1 : -1) * lotSize : 0), 0);
  const vals = pts.map(S => expiryPL(S, legs, lotSize));
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const maxProfit = slope > 0 ? null : +hi.toFixed(0);
  const maxLoss   = slope < 0 ? null : +Math.max(0, -lo).toFixed(0);
  /* Breakevens: zero crossings on each linear segment, plus the open-ended segment above the top strike. */
  const be = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const a = vals[i], b = vals[i+1];
    if (a === 0 && i > 0) be.push(pts[i]);
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) be.push(pts[i] + (pts[i+1]-pts[i]) * (-a / (b - a)));
  }
  const vTop = vals[vals.length-1];
  if (vTop === 0 && pts.length > 1) be.push(top);
  if (slope !== 0 && ((vTop < 0 && slope > 0) || (vTop > 0 && slope < 0))) be.push(top - vTop / slope);
  const breakeven = [...new Set(be.map(x => +x.toFixed(0)))].filter(x => x > 0);
  /* Describe where the position is profitable at expiry. */
  const bounds = [0, ...breakeven, Infinity];
  const zones = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i+1];
    const mid = b === Infinity ? a + Math.max(1, a) : (a + b) / 2;
    if (expiryPL(mid, legs, lotSize) > 0) zones.push(a === 0 ? `Below ${b}` : b === Infinity ? `Above ${a}` : `${a} – ${b}`);
  }
  return { maxProfit, maxLoss, breakeven, profitZone: zones.join(' OR ') || 'No profitable zone at expiry' };
}

/* Strike distance from the expected move. A fixed "2 strikes OTM" ignored IV and expiry: on NIFTY at
   VIX 17 with 30 days left that put iron-condor shorts ~0.45% from spot while the 1-sigma move is
   ~5%, giving a flattering max-profit/max-loss ratio with a very low chance of profit.
   distance = mult x S x sigma x sqrt(T), rounded to the strike interval, never below minSteps strikes. */
function emDist(S, iv, T, si, mult, minSteps = 1) {
  const em = S * iv * Math.sqrt(Math.max(T, 1/365));
  return Math.max(minSteps * si, Math.round(mult * em / si) * si);
}

/* Probability that the position is profitable at expiry, under a lognormal model with the same IV
   (risk-neutral drift r). Shown next to max profit/loss so a lopsided payoff cannot mislead. */
function probProfit(legs, lotSize, S, iv, T, r = 0.065) {
  const sd = iv * Math.sqrt(Math.max(T, 1/365));
  const mu = Math.log(S) + (r - 0.5 * iv * iv) * T;
  const steps = 800, zMax = 5;
  let p = 0;
  for (let i = 0; i < steps; i++) {
    const z = -zMax + (i + 0.5) * (2 * zMax / steps);
    const ST = Math.exp(mu + sd * z);
    if (expiryPL(ST, legs, lotSize) > 0) p += Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI) * (2 * zMax / steps);
  }
  return +(Math.min(1, p) * 100).toFixed(1);
}

/* ── Strategy builders ── */

function ironCondor(S, iv, T, si, lot) {
  /* Sell OTM strangle + buy further OTM wings */
  const shortDist = emDist(S, iv, T, si, 1.0, 2);   /* ~1 sigma, roughly 16-delta shorts */
  const wing      = emDist(S, iv, T, si, 0.4, 2);
  const sellCall = nearestStrike(S + shortDist, si);
  const buyCall  = sellCall + wing;
  const sellPut  = nearestStrike(S - shortDist, si);
  const buyPut   = sellPut  - wing;

  const scPrem = estimatePremium(S, sellCall, T, iv, 'C');
  const bcPrem = estimatePremium(S, buyCall,  T, iv, 'C');
  const spPrem = estimatePremium(S, sellPut,  T, iv, 'P');
  const bpPrem = estimatePremium(S, buyPut,   T, iv, 'P');

  const netCredit = scPrem + spPrem - bcPrem - bpPrem;
  const wingWidth = wing;
  const maxProfit = +(netCredit * lot).toFixed(0);
  const maxLoss   = +((wingWidth - netCredit) * lot).toFixed(0);

  const legs = [
    { action:'SELL', type:'C', strike:sellCall, premium:+scPrem.toFixed(2), label:`Sell ${sellCall} CE` },
    { action:'BUY',  type:'C', strike:buyCall,  premium:+bcPrem.toFixed(2), label:`Buy  ${buyCall}  CE` },
    { action:'SELL', type:'P', strike:sellPut,  premium:+spPrem.toFixed(2), label:`Sell ${sellPut} PE` },
    { action:'BUY',  type:'P', strike:buyPut,   premium:+bpPrem.toFixed(2), label:`Buy  ${buyPut}  PE` },
  ];

  /* Combined Greeks (sell = negative contribution) */
  const r=0.065;
  const gk = (K,type,sign) => { const g=bsGreeks(S,K,T,r,iv,type); return {delta:g.delta*sign,gamma:g.gamma*sign,theta:g.theta*sign,vega:g.vega*sign}; };
  const allG = [gk(sellCall,'C',-1),gk(buyCall,'C',1),gk(sellPut,'P',-1),gk(buyPut,'P',1)];
  const netDelta = +allG.reduce((a,g)=>a+g.delta,0).toFixed(4);
  const netTheta = +allG.reduce((a,g)=>a+g.theta,0).toFixed(2);
  const netVega  = +allG.reduce((a,g)=>a+g.vega ,0).toFixed(2);

  return {
    strategy:'Iron Condor', description:'Range-bound strategy. Profit if spot stays between the two short strikes at expiry.',
    legs, netCredit:+netCredit.toFixed(2),
    maxProfit, maxLoss,
    breakeven:[ +(sellPut - netCredit).toFixed(0), +(sellCall + netCredit).toFixed(0) ],
    profitZone:`${sellPut} – ${sellCall} (${((sellCall-sellPut)/S*100).toFixed(1)}% wide)`,
    greeks:{ delta:netDelta, gamma:+allG.reduce((a,g)=>a+(g.gamma||0),0).toFixed(6), theta:netTheta, vega:netVega },
    payoff: buildPayoff(S, legs, lot),
    lotSize:lot,
  };
}

function bullCallSpread(S, iv, T, si, lot) {
  const buyStrike  = nearestStrike(S, si);                       /* ATM */
  const sellStrike = buyStrike + emDist(S, iv, T, si, 0.75, 2);  /* ~0.75 sigma OTM */
  const buyPrem    = estimatePremium(S, buyStrike,  T, iv, 'C');
  const sellPrem   = estimatePremium(S, sellStrike, T, iv, 'C');
  const netDebit   = buyPrem - sellPrem;
  const width      = sellStrike - buyStrike;
  const maxProfit  = +((width - netDebit) * lot).toFixed(0);
  const maxLoss    = +(netDebit * lot).toFixed(0);
  const legs = [
    { action:'BUY',  type:'C', strike:buyStrike,  premium:+buyPrem.toFixed(2),  label:`Buy  ${buyStrike}  CE` },
    { action:'SELL', type:'C', strike:sellStrike, premium:+sellPrem.toFixed(2), label:`Sell ${sellStrike} CE` },
  ];
  const r=0.065;
  const g1=bsGreeks(S,buyStrike,T,r,iv,'C'), g2=bsGreeks(S,sellStrike,T,r,iv,'C');
  return {
    strategy:'Bull Call Spread', description:'Moderately bullish. Profit if spot rises above buy strike. Risk capped at net debit paid.',
    legs, netDebit:+netDebit.toFixed(2),
    maxProfit, maxLoss,
    breakeven:[ +(buyStrike + netDebit).toFixed(0) ],
    profitZone:`Above ${+(buyStrike+netDebit).toFixed(0)} up to ${sellStrike}`,
    greeks:{ delta:+(g1.delta-g2.delta).toFixed(4), gamma:+(g1.gamma-g2.gamma).toFixed(6), theta:+(g1.theta-g2.theta).toFixed(2), vega:+(g1.vega-g2.vega).toFixed(2) },
    payoff: buildPayoff(S, legs, lot),
  };
}

function bearPutSpread(S, iv, T, si, lot) {
  const buyStrike  = nearestStrike(S, si);
  const sellStrike = buyStrike - emDist(S, iv, T, si, 0.75, 2);  /* ~0.75 sigma OTM */
  const buyPrem    = estimatePremium(S, buyStrike,  T, iv, 'P');
  const sellPrem   = estimatePremium(S, sellStrike, T, iv, 'P');
  const netDebit   = buyPrem - sellPrem;
  const width      = buyStrike - sellStrike;
  const maxProfit  = +((width - netDebit) * lot).toFixed(0);
  const maxLoss    = +(netDebit * lot).toFixed(0);
  const legs = [
    { action:'BUY',  type:'P', strike:buyStrike,  premium:+buyPrem.toFixed(2),  label:`Buy  ${buyStrike}  PE` },
    { action:'SELL', type:'P', strike:sellStrike, premium:+sellPrem.toFixed(2), label:`Sell ${sellStrike} PE` },
  ];
  const r=0.065;
  const g1=bsGreeks(S,buyStrike,T,r,iv,'P'), g2=bsGreeks(S,sellStrike,T,r,iv,'P');
  return {
    strategy:'Bear Put Spread', description:'Moderately bearish. Profit if spot falls below buy strike. Risk capped at net debit.',
    legs, netDebit:+netDebit.toFixed(2),
    maxProfit, maxLoss,
    breakeven:[ +(buyStrike - netDebit).toFixed(0) ],
    profitZone:`Below ${+(buyStrike-netDebit).toFixed(0)} down to ${sellStrike}`,
    greeks:{ delta:+(g1.delta-g2.delta).toFixed(4), gamma:+(g1.gamma-g2.gamma).toFixed(6), theta:+(g1.theta-g2.theta).toFixed(2), vega:+(g1.vega-g2.vega).toFixed(2) },
    payoff: buildPayoff(S, legs, lot),
  };
}

function longStraddle(S, iv, T, si, lot) {
  const strike  = nearestStrike(S, si);
  const callPrem= estimatePremium(S, strike, T, iv, 'C');
  const putPrem = estimatePremium(S, strike, T, iv, 'P');
  const totalDebit = callPrem + putPrem;
  const legs = [
    { action:'BUY', type:'C', strike, premium:+callPrem.toFixed(2), label:`Buy ${strike} CE` },
    { action:'BUY', type:'P', strike, premium:+putPrem.toFixed(2),  label:`Buy ${strike} PE` },
  ];
  const r=0.065;
  const g1=bsGreeks(S,strike,T,r,iv,'C'), g2=bsGreeks(S,strike,T,r,iv,'P');
  return {
    strategy:'Long Straddle', description:'Buy volatility. Profit on large move in either direction. Loss limited to total premium paid.',
    legs, netDebit:+totalDebit.toFixed(2),
    maxProfit:null, maxLoss:+(totalDebit*lot).toFixed(0),
    breakeven:[ +(strike-totalDebit).toFixed(0), +(strike+totalDebit).toFixed(0) ],
    profitZone:`Below ${+(strike-totalDebit).toFixed(0)} OR above ${+(strike+totalDebit).toFixed(0)}`,
    greeks:{ delta:+(g1.delta+g2.delta).toFixed(4), gamma:+(g1.gamma+g2.gamma).toFixed(6), theta:+(g1.theta+g2.theta).toFixed(2), vega:+(g1.vega+g2.vega).toFixed(2) },
    payoff: buildPayoff(S, legs, lot),
  };
}

function longStrangle(S, iv, T, si, lot) {
  const callStrike = nearestStrike(S + emDist(S, iv, T, si, 0.5), si);
  const putStrike  = nearestStrike(S - emDist(S, iv, T, si, 0.5), si);
  const callPrem   = estimatePremium(S, callStrike, T, iv, 'C');
  const putPrem    = estimatePremium(S, putStrike,  T, iv, 'P');
  const totalDebit = callPrem + putPrem;
  const legs = [
    { action:'BUY', type:'C', strike:callStrike, premium:+callPrem.toFixed(2), label:`Buy ${callStrike} CE` },
    { action:'BUY', type:'P', strike:putStrike,  premium:+putPrem.toFixed(2),  label:`Buy ${putStrike}  PE` },
  ];
  const r=0.065;
  const g1=bsGreeks(S,callStrike,T,r,iv,'C'), g2=bsGreeks(S,putStrike,T,r,iv,'P');
  return {
    strategy:'Long Strangle', description:'Cheaper than straddle. Profit on large move. Needs bigger move to break even.',
    legs, netDebit:+totalDebit.toFixed(2),
    maxProfit:null, maxLoss:+(totalDebit*lot).toFixed(0),
    breakeven:[ +(putStrike-totalDebit).toFixed(0), +(callStrike+totalDebit).toFixed(0) ],
    profitZone:`Below ${+(putStrike-totalDebit).toFixed(0)} OR above ${+(callStrike+totalDebit).toFixed(0)}`,
    greeks:{ delta:+(g1.delta+g2.delta).toFixed(4), gamma:+(g1.gamma+g2.gamma).toFixed(6), theta:+(g1.theta+g2.theta).toFixed(2), vega:+(g1.vega+g2.vega).toFixed(2) },
    payoff: buildPayoff(S, legs, lot),
  };
}

function coveredCall(S, iv, T, si, lot) {
  const sellStrike = nearestStrike(S + emDist(S, iv, T, si, 0.5), si);  /* ~30-delta call */
  const callPrem   = estimatePremium(S, sellStrike, T, iv, 'C');
  /* Leg 1 = long underlying (represented as synthetic) */
  const legs = [
    { action:'BUY',  type:'STOCK', strike:+S.toFixed(0), premium:+S.toFixed(2), label:`Buy Underlying @ ${S.toFixed(0)}` },
    { action:'SELL', type:'C',     strike:sellStrike,     premium:+callPrem.toFixed(2), label:`Sell ${sellStrike} CE` },
  ];
  const r=0.065;
  const g=bsGreeks(S,sellStrike,T,r,iv,'C');
  const effectiveCost = S - callPrem;
  return {
    strategy:'Covered Call', description:'Hold stock, sell OTM call. Earn premium income. Upside capped at sell strike.',
    legs, netDebit:+effectiveCost.toFixed(2),
    maxProfit:+((sellStrike - effectiveCost)*lot).toFixed(0),
    maxLoss:+(effectiveCost*lot).toFixed(0),
    breakeven:[ +effectiveCost.toFixed(0) ],
    profitZone:`Above ${+effectiveCost.toFixed(0)} (premium reduces cost basis)`,
    greeks:{ delta:+(1-g.delta).toFixed(4), gamma:+(-g.gamma).toFixed(6), theta:+(-g.theta).toFixed(2), vega:+(-g.vega).toFixed(2) },
    payoff: buildPayoff(S, [
      { action:'BUY',  type:'STOCK', strike:+S.toFixed(0), premium:+S.toFixed(2), label:'Long underlying' },
      { action:'SELL', type:'C', strike:sellStrike, premium:callPrem, label:`Sell ${sellStrike} CE` },
    ], lot),
  };
}

function bullPutSpread(S, iv, T, si, lot) {
  /* Sell higher strike put, buy lower strike put — net credit */
  const sellStrike = nearestStrike(S - emDist(S, iv, T, si, 0.5), si);  /* ~30-delta put */
  const buyStrike  = sellStrike - emDist(S, iv, T, si, 0.4, 2);
  const sellPrem   = estimatePremium(S, sellStrike, T, iv, 'P');
  const buyPrem    = estimatePremium(S, buyStrike,  T, iv, 'P');
  const netCredit  = sellPrem - buyPrem;
  const width      = sellStrike - buyStrike;
  const maxProfit  = +(netCredit * lot).toFixed(0);
  const maxLoss    = +((width - netCredit) * lot).toFixed(0);
  const legs = [
    { action:'SELL', type:'P', strike:sellStrike, premium:+sellPrem.toFixed(2), label:`Sell ${sellStrike} PE` },
    { action:'BUY',  type:'P', strike:buyStrike,  premium:+buyPrem.toFixed(2),  label:`Buy  ${buyStrike}  PE` },
  ];
  const r=0.065;
  const g1=bsGreeks(S,sellStrike,T,r,iv,'P'), g2=bsGreeks(S,buyStrike,T,r,iv,'P');
  return {
    strategy:'Bull Put Spread', description:'Mildly bullish. Collect credit. Profit if spot stays above sell strike.',
    legs, netCredit:+netCredit.toFixed(2),
    maxProfit, maxLoss,
    breakeven:[ +(sellStrike - netCredit).toFixed(0) ],
    profitZone:`Above ${+(sellStrike-netCredit).toFixed(0)}`,
    greeks:{ delta:+(g2.delta-g1.delta).toFixed(4), gamma:+(g2.gamma-g1.gamma).toFixed(6), theta:+(g2.theta-g1.theta).toFixed(2), vega:+(g2.vega-g1.vega).toFixed(2) },
    payoff: buildPayoff(S, legs, lot),
  };
}

function bearCallSpread(S, iv, T, si, lot) {
  /* Sell lower strike call, buy higher strike call — net credit */
  const sellStrike = nearestStrike(S + emDist(S, iv, T, si, 0.5), si);  /* ~30-delta call */
  const buyStrike  = sellStrike + emDist(S, iv, T, si, 0.4, 2);
  const sellPrem   = estimatePremium(S, sellStrike, T, iv, 'C');
  const buyPrem    = estimatePremium(S, buyStrike,  T, iv, 'C');
  const netCredit  = sellPrem - buyPrem;
  const width      = buyStrike - sellStrike;
  const maxProfit  = +(netCredit * lot).toFixed(0);
  const maxLoss    = +((width - netCredit) * lot).toFixed(0);
  const legs = [
    { action:'SELL', type:'C', strike:sellStrike, premium:+sellPrem.toFixed(2), label:`Sell ${sellStrike} CE` },
    { action:'BUY',  type:'C', strike:buyStrike,  premium:+buyPrem.toFixed(2),  label:`Buy  ${buyStrike}  CE` },
  ];
  const r=0.065;
  const g1=bsGreeks(S,sellStrike,T,r,iv,'C'), g2=bsGreeks(S,buyStrike,T,r,iv,'C');
  return {
    strategy:'Bear Call Spread', description:'Mildly bearish. Collect credit. Profit if spot stays below sell strike.',
    legs, netCredit:+netCredit.toFixed(2),
    maxProfit, maxLoss,
    breakeven:[ +(sellStrike + netCredit).toFixed(0) ],
    profitZone:`Below ${+(sellStrike+netCredit).toFixed(0)}`,
    greeks:{ delta:+(g2.delta-g1.delta).toFixed(4), gamma:+(g2.gamma-g1.gamma).toFixed(6), theta:+(g2.theta-g1.theta).toFixed(2), vega:+(g2.vega-g1.vega).toFixed(2) },
    payoff: buildPayoff(S, legs, lot),
  };
}

const STRATEGY_MAP = {
  iron_condor:      ironCondor,
  bull_call_spread: bullCallSpread,
  bear_put_spread:  bearPutSpread,
  long_straddle:    longStraddle,
  long_strangle:    longStrangle,
  covered_call:     coveredCall,
  bull_put_spread:  bullPutSpread,
  bear_call_spread: bearCallSpread,
};

/* ── /api/strategy ── */
async function apiStrategy(req, res, p) {
  const sym      = p.get('sym')      || 'NSE:NIFTY';
  const strat    = (p.get('strategy')|| 'iron_condor').toLowerCase().replace(/ /g,'_');
  const expiryIn = +(p.get('expiry') || 30);
  let expiry     = Math.max(1, Math.min(90, Number.isFinite(expiryIn) ? expiryIn : 30));
  const ivParam  = p.get('iv')  ? +p.get('iv')  / 100 : null;
  const spotParam= p.get('spot') && +p.get('spot') > 0 ? +p.get('spot') : null;
  const lotParam = p.get('lot') ? +p.get('lot')  : null;   /* user-overridden lot size */

  /* Optional per-leg strike overrides: strikes=25000,25200,24800,24600 (comma-separated) */
  const strikesParam = p.get('strikes') ? p.get('strikes').split(',').map(Number).filter(n=>n>0) : null;

  const fn = STRATEGY_MAP[strat];
  if (!fn) {
    return err(res, `Unknown strategy "${strat}". Available: ${Object.keys(STRATEGY_MAP).join(', ')}`, 400);
  }

  try {
    /* Fetch live spot if not provided */
    let spot = spotParam;
    if (!spot) {
      const ticker = getTicker(sym);
      const { liveRaw } = await withTimeout(getPriceAndChange(ticker, sym), 8000, ticker + ' strategy spot');
      const rate = isMCX(sym) ? await getRate() : 1;
      spot = conv(sym, liveRaw, rate);
    }

    /* Default IV: NIFTY ~14%, BANKNIFTY ~18%, others ~20% */
    let iv = ivParam;
    if (!iv || iv <= 0) {
      if (sym.includes('BANKNIFTY')) iv = 0.18;
      else if (sym.includes('NIFTY') || sym.includes('SENSEX')) iv = 0.14;
      else iv = 0.20;
    }
    /* Guardrails: Black-Scholes breaks with zero/negative IV and becomes useless with extreme IV. */
    iv = Math.max(0.01, Math.min(2.00, iv));

    /* Live NSE premiums for the index option legs (Nifty / Bank Nifty / FinNifty): the NSE expiry closest to the
       chosen days. Strikes, estimates, Greeks and the probability then use THAT expiry too (Bank Nifty has monthly
       expiries only: 7 days asked can mean 18 days priced). */
    let chain = null;
    const expiryAsked = expiry;
    if (OC_SYMBOLS[sym] && p.get('live') !== '0') {
      const want = new Date(Date.now() + 5.5 * 3600000 + expiry * 86400000).toISOString().slice(0, 10);
      chain = await withTimeout(getOptionChain(sym, want), 20000, 'option chain').catch(() => null);
      if (chain?.expiry) expiry = Math.max(1, Math.round((Date.parse(chain.expiry + 'T15:30:00+05:30') - Date.now()) / 86400000));
    }
    const T   = expiry / 365;
    const si  = getStrikeInterval(sym, spot);
    /* Never guess a lot size: a silent default of 50 made every ₹ figure wrong for unknown symbols. */
    const lot = (lotParam > 0 ? lotParam : null) || getLotSize(sym);
    if (!lot) return err(res, `Lot size for ${sym} is not known. Pass &lot=<contract lot size> (check NSE/BSE contract specs).`, 400);

    /* Build result, then optionally override strikes if user provided them */
    let result = fn(spot, iv, T, si, lot);
    if ((result.legs || []).some(l => l.type !== 'STOCK' && !(+l.strike > 0))) {
      return err(res, `IV ${(iv*100).toFixed(0)}% with ${expiry} days gives a strike at or below zero for ${strat}. Lower the IV or the expiry.`, 400);
    }

    const livePrem = (k, t) => chain ? SwingPlan.ocPremium(chain, k, t) : null;

    /* Apply user-supplied strike overrides — recalculate premiums & payoff */
    if (chain || (strikesParam && strikesParam.length === result.legs.length)) {
      const useStrikes = strikesParam && strikesParam.length === result.legs.length;
      const r0 = 0.065;
      result.legs = result.legs.map((leg, i) => {
        if (leg.type === 'STOCK') {
          return { ...leg, strike:+spot.toFixed(0), premium:+spot.toFixed(2), label:`${leg.action==='BUY'?'Buy':'Sell'} Underlying @ ${spot.toFixed(0)}` };
        }
        const newStrike = useStrikes ? strikesParam[i] : leg.strike;
        const lp = livePrem(newStrike, leg.type);
        const newPrem   = lp != null ? lp : +estimatePremium(spot, newStrike, T, iv, leg.type).toFixed(2);
        return { ...leg, strike: newStrike, premium: newPrem, live: lp != null,
                 label: `${leg.action==='BUY'?'Buy ':'Sell'} ${newStrike} ${leg.type==='C'?'CE':'PE'}` };
      });
      /* Recalculate net credit/debit for EVERY strategy (straddle/strangle have no sell legs,
         so the old "sell && buy legs" condition left their debit stale). */
      const credits = result.legs.reduce((a,l) => a + (l.action==='SELL'?l.premium:-l.premium), 0);
      delete result.netCredit; delete result.netDebit;
      if (credits > 0) result.netCredit = +credits.toFixed(2);
      else result.netDebit = +Math.abs(credits).toFixed(2);
      /* Rebuild payoff, max profit/loss, breakevens and profit zone from the new legs. */
      result.payoff = buildPayoff(spot, result.legs, lot);
      const st = expiryStats(result.legs, lot);
      result.maxProfit  = st.maxProfit;
      result.maxLoss    = st.maxLoss;
      result.breakeven  = st.breakeven;
      result.profitZone = st.profitZone;
      /* Greeks for the overridden strikes (same IV as the premiums' base IV, sign by side). */
      const g = result.legs.reduce((acc, l) => {
        if (l.type === 'STOCK') { acc.delta += l.action==='BUY' ? 1 : -1; return acc; }
        const x = bsGreeks(spot, l.strike, T, r0, iv, l.type), sg = l.action==='BUY' ? 1 : -1;
        acc.delta += x.delta*sg; acc.gamma += x.gamma*sg; acc.theta += x.theta*sg; acc.vega += x.vega*sg;
        return acc;
      }, {delta:0, gamma:0, theta:0, vega:0});
      result.greeks = { delta:+g.delta.toFixed(4), gamma:+g.gamma.toFixed(6), theta:+g.theta.toFixed(2), vega:+g.vega.toFixed(2) };
    }

    /* Strip margin from output */
    delete result.margin;
    result.pop = probProfit(result.legs, lot, spot, iv, T);
    result.expectedMove = +(spot * iv * Math.sqrt(T)).toFixed(0);

    if (chain) {
      const liveLegs = result.legs.filter(l => l.live).length, optLegs = result.legs.filter(l => l.type !== 'STOCK').length;
      result.priceSource = liveLegs ? `NSE live premiums (${liveLegs}/${optLegs} legs) · expiry ${chain.expiry}${chain.stale ? ' · saved quote' : ''}` : 'Black-Scholes estimate (no NSE quote for these strikes)';
      result.oi = { pcr: chain.pcr, maxPain: chain.maxPain, callWalls: chain.callWalls, putWalls: chain.putWalls, expiry: chain.expiry, nseSpot: chain.spot };
    }
    send(res, {
      sym, spot:+spot.toFixed(2), expiry, expiryAsked, iv:+(iv*100).toFixed(1),
      strikeInterval:si, lotSize:lot, ...result,
      updatedAt: new Date().toISOString(),
    });
  } catch(e) { err(res, e.message); }
}

/* ── /api/strategy/list ── */
function apiStrategyList(req, res) {
  send(res, {
    strategies: [
      { id:'iron_condor',      name:'Iron Condor',       outlook:'Neutral / Range-bound', type:'Credit',  risk:'Limited' },
      { id:'bull_call_spread', name:'Bull Call Spread',  outlook:'Moderately Bullish',    type:'Debit',   risk:'Limited' },
      { id:'bear_put_spread',  name:'Bear Put Spread',   outlook:'Moderately Bearish',    type:'Debit',   risk:'Limited' },
      { id:'long_straddle',    name:'Long Straddle',     outlook:'High Volatility',       type:'Debit',   risk:'Limited' },
      { id:'long_strangle',    name:'Long Strangle',     outlook:'High Volatility',       type:'Debit',   risk:'Limited' },
      { id:'covered_call',     name:'Covered Call',      outlook:'Neutral to Bullish',    type:'Credit',  risk:'Limited' },
      { id:'bull_put_spread',  name:'Bull Put Spread',   outlook:'Moderately Bullish',    type:'Credit',  risk:'Limited' },
      { id:'bear_call_spread', name:'Bear Call Spread',  outlook:'Moderately Bearish',    type:'Credit',  risk:'Limited' },
    ],
    usage: 'GET /api/strategy?sym=NSE:NIFTY&strategy=iron_condor&expiry=30&iv=15',
    params: {
      sym:      'Symbol (default: NSE:NIFTY)',
      strategy: 'Strategy ID from list above',
      expiry:   'Days to expiry (1-90, default: 30)',
      iv:       'Implied volatility % (e.g. 15 = 15%, optional — auto-estimated if omitted)',
      spot:     'Override spot price (optional — fetched live if omitted)',
    },
  });
}

/* ══════════════════════════════════════════════════════════════════════
   STOCK SCREENER — User Excel NSE stock universe by market cap
   Filters:
   MarketCap >35000 Cr, Price <1000, Price>DMA200, Price>DMA50, DMA50>DMA200,
   MACD>0, RSI>50, RSI<65, 1M return>0
   Returns all bullish base-screen matches ranked by composite score, plus separate buy-alert status
══════════════════════════════════════════════════════════════════════ */

/* Top NSE stocks by market cap from user Excel (Yahoo tickers).
   Source file: LIST OF STOCKS - NSE SYMBOLS FILLED.xlsx.
   Note: the uploaded sheet marks 271 rows as TOP 250, so this universe follows the sheet exactly. */
/* Screener universe from Excel TOP 250 YES rows. */
const TOP250_TICKERS = [
  'RELIANCE.NS','HDFCBANK.NS','BHARTIARTL.NS','ICICIBANK.NS','SBIN.NS',
  'TCS.NS','BAJFINANCE.NS','LT.NS','HINDUNILVR.NS','LICI.NS',
  'INFY.NS','SUNPHARMA.NS','ADANIPOWER.NS','MARUTI.NS','ADANIPORTS.NS',
  'ITC.NS','AXISBANK.NS','M&M.NS','KOTAKBANK.NS','NTPC.NS',
  'ONGC.NS','TITAN.NS','ADANIENT.NS','ULTRACEMCO.NS','HCLTECH.NS',
  'JSWSTEEL.NS','BEL.NS','HAL.NS','BAJAJ-AUTO.NS','COALINDIA.NS',
  'BAJAJFINSV.NS','POWERGRID.NS','DMART.NS','NESTLEIND.NS','HINDZINC.NS',
  'TATASTEEL.NS','ASIANPAINT.NS','ETERNAL.NS','HINDALCO.NS','ADANIGREEN.NS',
  'SHRIRAMFIN.NS','WIPRO.NS','GRASIM.NS','IOC.NS','EICHERMOT.NS',
  'SBILIFE.NS','DIVISLAB.NS','VBL.NS','BSE.NS','SOLARINDS.NS',
  'INDIGO.NS','ADANIENSOL.NS','TVSMOTOR.NS','JIOFIN.NS','ICICIAMC.NS',
  'TORNTPHARM.NS','POWERINDIA.NS','PIDILITIND.NS','IDEA.NS','CUMMINSIND.NS',
  'TRENT.NS','HYUNDAI.NS','TECHM.NS','DLF.NS','PFC.NS',
  'BHEL.NS','TMCV.NS','MOTHERSON.NS','POLYCAB.NS','BANKBARODA.NS',
  'ABB.NS','TMPV.NS','MUTHOOTFIN.NS','TATAPOWER.NS','VEDL.NS',
  'HDFCLIFE.NS','BRITANNIA.NS','CGPOWER.NS','CHOLAFIN.NS','TATACAP.NS',
  'IRFC.NS','SIEMENS.NS','LTIM.NS','JINDALSTEL.NS','BPCL.NS',
  'UNIONBANK.NS','TATACONSUM.NS','GROWW.NS','PNB.NS','APOLLOHOSP.NS',
  'BAJAJHLDNG.NS','CANBK.NS','CIPLA.NS','HDFCAMC.NS','INDUSTOWER.NS',
  'ENRIN.NS','GVT&D.NS','DRREDDY.NS','INDIANB.NS','BOSCHLTD.NS',
  'MARICO.NS','AMBUJACEM.NS','LUPIN.NS','GODREJCP.NS','MAXHEALTH.NS',
  'MANKIND.NS','GAIL.NS','LGEINDIA.NS','ZYDUSLIFE.NS','HEROMOTOCO.NS',
  'GMRAIRPORT.NS','MAZDOCK.NS','UNITDSPR.NS','LLOYDSME.NS','JSWENERGY.NS',
  'INDHOTEL.NS','ABCAPITAL.NS','ICICIGI.NS','NTPCGREEN.NS','LODHA.NS',
  'ASHOKLEY.NS','BHARATFORG.NS','MEESHO.NS','SHREECEM.NS','RECLTD.NS',
  'AUROPHARMA.NS','MCX.NS','WAAREEENER.NS','LENSKART.NS','OFSS.NS',
  'POLICYBZR.NS','SAIL.NS','OIL.NS','BHARTIHEXA.NS','DABUR.NS',
  'PERSISTENT.NS','NHPC.NS','IDBI.NS','HINDPETRO.NS','NMDC.NS',
  'SRF.NS','NYKAA.NS','HAVELLS.NS','ICICIPRULI.NS','TORNTPOWER.NS',
  'NATIONALUM.NS','AUBANK.NS','LAURUSLABS.NS','FORTIS.NS','SUZLON.NS',
  'SWIGGY.NS','PAYTM.NS','FEDERALBNK.NS','BAJAJHFL.NS','INDUSINDBK.NS',
  'LTF.NS','BIOCON.NS','NAM-INDIA.NS','YESBANK.NS','ATGL.NS',
  'GICRE.NS','GLENMARK.NS','DIXON.NS','ALKEM.NS','IOB.NS',
  'BANKINDIA.NS','LINDEINDIA.NS','SCHAEFFLER.NS','PHOENIXLTD.NS','JSL.NS',
  'COFORGE.NS','UNOMINDA.NS','NAUKRI.NS','MAHABANK.NS','COLPAL.NS',
  'SBICARD.NS','PRESTIGE.NS','BERGEPAINT.NS','ABBOTINDIA.NS','OBEROIRLTY.NS',
  'IDFCFIRSTB.NS','VMM.NS','RVNL.NS','FACT.NS','HDBFS.NS',
  'TIINDIA.NS','JSWINFRA.NS','MFSL.NS','COROMANDEL.NS','HINDCOPPER.NS',
  'MRF.NS','UPL.NS','THERMAX.NS','KRT.BO','APLAPOLLO.NS',
  'GODREJPROP.NS','MOTILALOFS.NS','PATANJALI.NS','ALTIUSINVIT.BO','SUNDARMFIN.NS',
  'NLCINDIA.NS','APARINDS.NS','KEI.NS','RADICO.NS','BDL.NS',
  'PIIND.NS','TATACOMM.NS','PREMIERENE.NS','360ONE.NS','M&MFIN.NS',
  'ANTHEM.NS','PIRAMALFIN.NS','SUPREMEIND.NS','PAGEIND.NS','VOLTAS.NS',
  'MPHASIS.NS','IRCTC.NS','AIIL.NS','IPCALAB.NS','JKCEMENT.NS',
  'FLUOROCHEM.NS','BALKRISIND.NS','EMBASSY.NS','AJANTPHARM.NS','GLAXO.NS',
  'HUDCO.NS','PETRONET.NS','COCHINSHIP.NS','ASTRAL.NS','ASTERDM.NS',
  'NH.NS','CONCOR.NS','GODREJIND.NS','LTTS.NS','AIAENG.NS',
  'GLAND.NS','GODFRYPHLP.NS','NAVINFLUOR.NS','SONACOMS.NS','3MINDIA.NS',
  'IREDA.NS','ENDURANCE.NS','UBL.NS','POONAWALLA.NS','KALYANKJIL.NS',
  'ATHERENERG.NS','JBCHEPHARM.NS','BLUESTARCO.NS','DELHIVERY.NS','WELCORP.NS',
  'TATAINVEST.NS','MEDANTA.NS','KPRMILL.NS','EMCURE.NS','PWL.NS',
  'ITCHOTELS.NS','ESCORTS.NS','DALBHARAT.NS','PGHH.NS','CHOLAHLDNG.NS',
  'HEXT.NS','JUBLFOOD.NS','MINDSPACE.BO','UCOBANK.NS','NHIT.BO',
  'CENTRALBK.NS','BANDHANBNK.NS','GRSE.NS','STARHEALTH.NS','CRISIL.NS',
  'ABSLAMC.NS',
];

/* Screener safety universe: only show larger stocks for swing-trade picks.
   Market cap is from the uploaded Excel, in ₹ crore.
   Whitelist is kept only as a reference list; live screener does NOT bypass market-cap floor. */
const MIN_SCREENER_MCAP_CR = 35000;
const SCREENER_MCAP_35K = {
  'RELIANCE.NS':1790886.81,
  'HDFCBANK.NS':1173985.37,
  'BHARTIARTL.NS':1165948.17,
  'ICICIBANK.NS':889716.35,
  'SBIN.NS':875241.98,
  'TCS.NS':841596.54,
  'BAJFINANCE.NS':575216.58,
  'LT.NS':539241.21,
  'HINDUNILVR.NS':524477.36,
  'LICI.NS':508117.26,
  'INFY.NS':485460.05,
  'SUNPHARMA.NS':451769.05,
  'ADANIPOWER.NS':422604.72,
  'MARUTI.NS':407379.1,
  'ADANIPORTS.NS':406289.64,
  'ITC.NS':388789.4,
  'AXISBANK.NS':384827.64,
  'M&M.NS':384592.55,
  'KOTAKBANK.NS':380002.22,
  'NTPC.NS':378270.1,
  'ONGC.NS':373005.28,
  'TITAN.NS':364117.49,
  'ADANIENT.NS':354430.53,
  'ULTRACEMCO.NS':335310.32,
  'HCLTECH.NS':319993.85,
  'JSWSTEEL.NS':314338.37,
  'BEL.NS':309094.64,
  'HAL.NS':289796.93,
  'BAJAJ-AUTO.NS':285223.35,
  'COALINDIA.NS':281697.32,
  'BAJAJFINSV.NS':279976.4,
  'POWERGRID.NS':277809.71,
  'DMART.NS':276372.15,
  'NESTLEIND.NS':275884.02,
  'HINDZINC.NS':267251.69,
  'TATASTEEL.NS':261093.44,
  'ASIANPAINT.NS':249577.91,
  'ETERNAL.NS':238714.65,
  'HINDALCO.NS':235699.85,
  'ADANIGREEN.NS':227055.74,
  'SHRIRAMFIN.NS':218306.65,
  'WIPRO.NS':204838.25,
  'GRASIM.NS':199757.21,
  'IOC.NS':190578.88,
  'EICHERMOT.NS':188865.05,
  'SBILIFE.NS':188641.67,
  'DIVISLAB.NS':183544.24,
  'VBL.NS':173865.67,
  'BSE.NS':170690.9,
  'SOLARINDS.NS':163892.22,
  'INDIGO.NS':163561.35,
  'ADANIENSOL.NS':159722.55,
  'TVSMOTOR.NS':156092.08,
  'JIOFIN.NS':154124.21,
  'ICICIAMC.NS':153264.11,
  'TORNTPHARM.NS':150922.57,
  'POWERINDIA.NS':148871.33,
  'PIDILITIND.NS':148229.06,
  'IDEA.NS':146025.58,
  'CUMMINSIND.NS':145639.51,
  'TRENT.NS':144665.59,
  'HYUNDAI.NS':144648.58,
  'TECHM.NS':143723.84,
  'DLF.NS':142899.57,
  'PFC.NS':142498.7,
  'BHEL.NS':139700.9,
  'TMCV.NS':139284.79,
  'MOTHERSON.NS':138888.24,
  'POLYCAB.NS':137964.79,
  'BANKBARODA.NS':134739.79,
  'ABB.NS':134021.73,
  'TMPV.NS':133066.09,
  'MUTHOOTFIN.NS':132649.28,
  'TATAPOWER.NS':132590.19,
  'VEDL.NS':132074.64,
  'HDFCLIFE.NS':131702.42,
  'BRITANNIA.NS':130543.96,
  'CGPOWER.NS':129042.34,
  'CHOLAFIN.NS':128811.88,
  'TATACAP.NS':128534.63,
  'IRFC.NS':127065.03,
  'SIEMENS.NS':126490.61,
  'LTIM.NS':126057.94,
  'JINDALSTEL.NS':125083.25,
  'BPCL.NS':124254.36,
  'UNIONBANK.NS':121183.63,
  'TATACONSUM.NS':119845.51,
  'GROWW.NS':116926.59,
  'PNB.NS':116353.34,
  'APOLLOHOSP.NS':115392.93,
  'BAJAJHLDNG.NS':114776.14,
  'CANBK.NS':114426.26,
  'CIPLA.NS':113851.79,
  'HDFCAMC.NS':113776.36,
  'INDUSTOWER.NS':113652.04,
  'ENRIN.NS':112704.75,
  'GVT&D.NS':112179.17,
  'DRREDDY.NS':111426.66,
  'INDIANB.NS':110046.84,
  'BOSCHLTD.NS':109501.34,
  'MARICO.NS':107934.6,
  'AMBUJACEM.NS':107294.5,
  'LUPIN.NS':104555.7,
  'GODREJCP.NS':104446.89,
  'MAXHEALTH.NS':104015.43,
  'MANKIND.NS':102874.8,
  'GAIL.NS':102663.27,
  'LGEINDIA.NS':102519.38,
  'ZYDUSLIFE.NS':102514.84,
  'HEROMOTOCO.NS':100214.73,
  'GMRAIRPORT.NS':99465.65,
  'MAZDOCK.NS':97780.91,
  'UNITDSPR.NS':94948.09,
  'LLOYDSME.NS':93777.81,
  'JSWENERGY.NS':93681.19,
  'INDHOTEL.NS':92957.54,
  'ABCAPITAL.NS':92043.02,
  'ICICIGI.NS':90974.93,
  'NTPCGREEN.NS':90777.27,
  'LODHA.NS':89156.67,
  'ASHOKLEY.NS':88912.53,
  'BHARATFORG.NS':88786.01,
  'MEESHO.NS':88469.82,
  'SHREECEM.NS':88123.27,
  'RECLTD.NS':88041.89,
  'AUROPHARMA.NS':87796.38,
  'MCX.NS':87116.3,
  'WAAREEENER.NS':86258.01,
  'LENSKART.NS':85580.17,
  'OFSS.NS':84003.66,
  'POLICYBZR.NS':83451.95,
  'SAIL.NS':82273.6,
  'OIL.NS':81631.11,
  'BHARTIHEXA.NS':80615.32,
  'DABUR.NS':80259.93,
  'PERSISTENT.NS':79924.12,
  'NHPC.NS':79416.05,
  'IDBI.NS':79197.23,
  'HINDPETRO.NS':78876.28,
  'NMDC.NS':78256.07,
  'SRF.NS':78193.89,
  'NYKAA.NS':77616.07,
  'HAVELLS.NS':75792.23,
  'ICICIPRULI.NS':75669.52,
  'TORNTPOWER.NS':74636.93,
  'NATIONALUM.NS':73263.28,
  'AUBANK.NS':72744.69,
  'LAURUSLABS.NS':72613.51,
  'FORTIS.NS':72517.51,
  'SUZLON.NS':71945.03,
  'SWIGGY.NS':71834.16,
  'PAYTM.NS':71830.65,
  'FEDERALBNK.NS':70645.09,
  'BAJAJHFL.NS':69916.63,
  'INDUSINDBK.NS':69726.47,
  'LTF.NS':69663.99,
  'BIOCON.NS':69415.45,
  'NAM-INDIA.NS':69264.36,
  'YESBANK.NS':68922.41,
  'ATGL.NS':68568.02,
  'GICRE.NS':68272.65,
  'GLENMARK.NS':67878.74,
  'DIXON.NS':67188.58,
  'ALKEM.NS':65358.42,
  'IOB.NS':64509.42,
  'BANKINDIA.NS':63104.5,
  'LINDEINDIA.NS':62783.6,
  'SCHAEFFLER.NS':62232.9,
  'PHOENIXLTD.NS':61632.15,
  'JSL.NS':60994.05,
  'COFORGE.NS':60650.43,
  'UNOMINDA.NS':60606.46,
  'NAUKRI.NS':60595.42,
  'MAHABANK.NS':60193.75,
  'COLPAL.NS':59475.76,
  'SBICARD.NS':59332.62,
  'PRESTIGE.NS':59284.95,
  'BERGEPAINT.NS':59231.84,
  'ABBOTINDIA.NS':59058.14,
  'OBEROIRLTY.NS':59007.62,
  'IDFCFIRSTB.NS':58321.21,
  'VMM.NS':56798.42,
  'RVNL.NS':56628.95,
  'FACT.NS':56291.89,
  'HDBFS.NS':56081.01,
  'TIINDIA.NS':55982.34,
  'JSWINFRA.NS':55974.33,
  'MFSL.NS':55790.83,
  'COROMANDEL.NS':55332.02,
  'HINDCOPPER.NS':55086.24,
  'MRF.NS':53767.37,
  'UPL.NS':53385.92,
  'THERMAX.NS':52649.34,
  'KRT.BO':51807.14,
  'APLAPOLLO.NS':51703.27,
  'GODREJPROP.NS':51618.67,
  'MOTILALOFS.NS':51249.42,
  'PATANJALI.NS':51232.55,
  'ALTIUSINVIT.BO':51196.32,
  'SUNDARMFIN.NS':50755.67,
  'NLCINDIA.NS':49797.39,
  'APARINDS.NS':49591.99,
  'KEI.NS':48564.66,
  'RADICO.NS':48222.98,
  'BDL.NS':48083.83,
  'PIIND.NS':47401.25,
  'TATACOMM.NS':46987.24,
  'PREMIERENE.NS':44641.54,
  '360ONE.NS':44625.45,
  'M&MFIN.NS':44437.44,
  'ANTHEM.NS':44164.96,
  'PIRAMALFIN.NS':43876.67,
  'SUPREMEIND.NS':43825.42,
  'PAGEIND.NS':43147.89,
  'VOLTAS.NS':43114.81,
  'MPHASIS.NS':42404.7,
  'IRCTC.NS':42372.05,
  'AIIL.NS':42321.39,
  'IPCALAB.NS':42019.77,
  'JKCEMENT.NS':41912.46,
  'FLUOROCHEM.NS':41235.94,
  'BALKRISIND.NS':41137.9,
  'EMBASSY.NS':40695.58,
  'AJANTPHARM.NS':40620.14,
  'GLAXO.NS':40487.19,
  'HUDCO.NS':40422.22,
  'PETRONET.NS':39757.51,
  'COCHINSHIP.NS':39184.63,
  'ASTRAL.NS':38919.69,
  'ASTERDM.NS':38809.79,
  'NH.NS':38467.54,
  'CONCOR.NS':38449.95,
  'GODREJIND.NS':38131.08,
  'LTTS.NS':37664.23,
  'AIAENG.NS':37356.26,
  'GLAND.NS':37043.66,
  'GODFRYPHLP.NS':36499.75,
  'NAVINFLUOR.NS':36271.4,
  'SONACOMS.NS':36043.04,
  '3MINDIA.NS':35904.29,
  'IREDA.NS':35870.93,
  'ENDURANCE.NS':35804.34,
  'UBL.NS':35670.82,
  'POONAWALLA.NS':35634.56,
  'KALYANKJIL.NS':35531.49,
  'ATHERENERG.NS':34889.73,
  'JBCHEPHARM.NS':34874.31,
  'BLUESTARCO.NS':34593.93,
  'DELHIVERY.NS':34399.86,
  'WELCORP.NS':33777.16,
  'TATAINVEST.NS':33564.91,
  'MEDANTA.NS':33347.05,
  'KPRMILL.NS':32755.31,
  'EMCURE.NS':32440.92,
  'PWL.NS':32432.33,
  'ITCHOTELS.NS':32427.29,
  'ESCORTS.NS':32306.28,
  'DALBHARAT.NS':32140.37,
  'PGHH.NS':31566.79,
  'CHOLAHLDNG.NS':31401.93,
  'HEXT.NS':31262.83,
  'JUBLFOOD.NS':31217.51,
  'MINDSPACE.BO':31143.52,
  'UCOBANK.NS':31073.08,
  'NHIT.BO':31008.98,
  'CENTRALBK.NS':30820.09,
  'BANDHANBNK.NS':30810,
  'GRSE.NS':30469.58,
  'STARHEALTH.NS':30402.01,
  'CRISIL.NS':30051.43,
  'ABSLAMC.NS':30012.88,
};
/* ══════════════════════════════════════════════════════════════════════
   LIVE SCREENER UNIVERSE - independent of the Excel list
   Once a week the server rebuilds the universe from NSE alone:
     1. NSE's Nifty Total Market constituent list (~750 stocks) + every NSE EQ stock listed in the last
        2 years (NSE EQUITY_L.csv), so a new large IPO is scanned before it joins an index
     2. shares outstanding from Yahoo fundamentals (cached 7 days, last known value kept if a fetch fails)
        × live price = live market cap
     3. keep market cap >= ₹30,000 Cr (a buffer); the scan itself applies the live > ₹35,000 Cr rule, so a
        stock that crosses ₹35,000 Cr during the week is picked up without waiting for the rebuild.
   Saved to data/universe.json. If a rebuild fails the last good universe is kept; the old Excel list is
   only a first-start fallback when no universe has ever been built.
══════════════════════════════════════════════════════════════════════ */
let LIVE_UNIVERSE = null;          /* {generatedAt, source, rows, added, dropped, stats} */
let SHARES_CACHE = {};             /* ticker -> {shares, asOf, ts} */
let UNIVERSE_INFLIGHT = null;
const UNIVERSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   /* rebuilt weekly */
const UNIVERSE_KEEP_MCAP_CR = 30000;                      /* stored with a buffer below the ₹35,000 Cr rule */
const SHARES_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function universeFile() { return require('path').join(__dirname, 'data', 'universe.json'); }
function loadUniverseFromDisk() {
  try {
    const j = JSON.parse(require('fs').readFileSync(universeFile(), 'utf8'));
    if (j?.universe?.rows?.length) LIVE_UNIVERSE = j.universe;
    if (j?.shares && typeof j.shares === 'object') SHARES_CACHE = j.shares;
    if (j?.breadth?.pct != null) LAST_BREADTH = j.breadth;
    if (j?.sectorStrength?.map) LAST_SECTOR_STRENGTH = j.sectorStrength;
    if (Array.isArray(j?.resultsCal?.rows)) RESULTS_CAL_LAST_GOOD = j.resultsCal;
  } catch {}
}
function saveUniverseToDisk() {
  try {
    const fsm = require('fs'), dir = require('path').dirname(universeFile());
    fsm.mkdirSync(dir, { recursive: true });
    fsm.writeFileSync(universeFile(), JSON.stringify({ universe: LIVE_UNIVERSE, shares: SHARES_CACHE, breadth: LAST_BREADTH, sectorStrength: LAST_SECTOR_STRENGTH, resultsCal: RESULTS_CAL_LAST_GOOD }));
  } catch (er) { console.warn('Universe save failed:', er.message); }
}
/* NSE industry (from the official index constituent list) -> the app's sector names, which map to the
   sector indices used in scoring. Banks are split out of Financial Services by name. */
function industryToSector(industry, sym, name) {
  const ind = String(industry || '').toLowerCase(), txt = `${sym} ${name}`.toUpperCase();
  if (ind.includes('financial')) return /BANK|\bBNK\b/.test(txt) && !/BANKING FIN|FINSERV|FINANCE/.test(txt) ? 'Banking' : 'Finance';
  if (ind.includes('information technology')) return 'IT';
  if (ind.includes('automobile')) return 'Auto';
  if (ind.includes('fast moving')) return 'FMCG';
  if (ind.includes('healthcare')) return 'Healthcare';
  if (ind.includes('metals')) return 'Metal';
  if (ind.includes('oil gas')) return 'Energy';
  if (ind === 'power') return 'Power';
  if (ind.includes('realty')) return 'Realty';
  if (ind.includes('construction materials')) return 'Cement';
  if (ind.includes('capital goods') || ind === 'construction' || ind === 'services') return 'Infra';
  if (ind.includes('consumer durables')) return 'ConsumerDurables';
  if (ind.includes('consumer services') || ind.includes('textiles')) return 'Consumer';
  if (ind.includes('media')) return 'Media';
  if (ind.includes('telecommunication')) return 'Telecom';
  if (ind.includes('chemicals') || ind.includes('forest')) return 'Chemicals';
  if (ind.includes('diversified')) return 'Diversified';
  return null;
}
function sectorInfoFor(sym) {
  const code = String(sym || '').toUpperCase().replace(/^NSE:/, '').replace(/\.(NS|BO)$/, '');
  const x = LIVE_UNIVERSE?.industry?.[code];
  return x ? { industry: x.industry, sector: x.sector } : null;
}
function parseNseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];
  const split = l => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map(c => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  const head = split(lines[0]).map(h => h.toLowerCase());
  const iName = head.findIndex(h => h.includes('company')), iSym = head.indexOf('symbol'), iSer = head.indexOf('series'), iInd = head.indexOf('industry');
  return lines.slice(1).map(split).filter(c => c[iSym]).map(c => ({ sym: c[iSym].toUpperCase(), name: c[iName] || c[iSym], industry: c[iInd] || '', series: (c[iSer] || '').toUpperCase() }))
    .filter(x => !x.series || x.series === 'EQ');
}
async function fetchNseIndexList(file) {
  const r = await withTimeout(get('https://nsearchives.nseindia.com/content/indices/' + file, { Accept:'text/csv,*/*', Referer:'https://www.nseindia.com/', Origin:'https://www.nseindia.com' }), 15000, 'NSE index list');
  if (r.status !== 200) throw new Error('NSE list HTTP ' + r.status);
  const rows = parseNseCsv(r.body);
  if (rows.length < 100) throw new Error('NSE list too short');
  return rows;
}
/* NSE EQ stocks listed within `days` (EQUITY_L.csv: SYMBOL, NAME OF COMPANY, SERIES, DATE OF LISTING, ...). */
async function fetchNseRecentListings(days = 730) {
  const r = await withTimeout(get('https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv', { Accept:'text/csv,*/*', Referer:'https://www.nseindia.com/', Origin:'https://www.nseindia.com' }), 20000, 'NSE equity list');
  if (r.status !== 200) throw new Error('NSE equity list HTTP ' + r.status);
  const lines = String(r.body || '').split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',').map(h => h.trim().toUpperCase());
  const iSym = head.indexOf('SYMBOL'), iName = head.indexOf('NAME OF COMPANY'), iSer = head.indexOf('SERIES'), iDate = head.indexOf('DATE OF LISTING');
  if (iSym < 0 || iDate < 0) throw new Error('NSE equity list: unexpected columns');
  const cutoff = Date.now() - days * 86400000, out = [];
  for (const l of lines.slice(1)) {
    const c = l.split(',').map(x => x.trim());   /* company names in this file carry no commas */
    if ((c[iSer] || '').toUpperCase() !== 'EQ') continue;
    const t = Date.parse((c[iDate] || '').replace(/-/g, ' '));
    if (Number.isFinite(t) && t >= cutoff) out.push({ sym: c[iSym].toUpperCase(), name: c[iName] || c[iSym], industry: '', series: 'EQ', listedOn: c[iDate] });
  }
  return out;
}
async function fetchSharesOutstanding(ticker) {
  const c = SHARES_CACHE[ticker];
  if (c && Date.now() - c.ts < SHARES_TTL_MS) return c.shares;
  const now = Math.floor(Date.now() / 1000);
  const u = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(ticker)}?type=quarterlyOrdinarySharesNumber,annualOrdinarySharesNumber&period1=${now - 3*365*86400}&period2=${now + 86400}`;
  let r;
  try { r = await withTimeout(get(u, { Accept:'application/json' }), 8000, ticker + ' shares'); }
  catch (er) { if (c?.shares) return c.shares; throw er; }   /* share counts change rarely: an old value beats none */
  if (r.status !== 200) { if (c?.shares) return c.shares; const er = new Error('shares HTTP ' + r.status); er.status = r.status; throw er; }
  const j = JSON.parse(r.body);
  let best = null;
  for (const s of (j?.timeseries?.result || [])) {
    const k = s?.meta?.type?.[0]; const arr = (k && s[k]) || [];
    for (const p of arr) { const v = +p?.reportedValue?.raw; if (v > 0 && (!best || p.asOfDate > best.asOf)) best = { shares: v, asOf: p.asOfDate }; }
  }
  if (!best) return null;
  SHARES_CACHE[ticker] = { ...best, ts: Date.now() };
  return best.shares;
}
async function mapLimit(items, limit, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
function refreshUniverse(force = false) {
  if (!force && LIVE_UNIVERSE && LIVE_UNIVERSE.industry && Date.now() - Date.parse(LIVE_UNIVERSE.generatedAt) < UNIVERSE_MAX_AGE_MS) return Promise.resolve(LIVE_UNIVERSE);
  if (UNIVERSE_INFLIGHT) return UNIVERSE_INFLIGHT;
  UNIVERSE_INFLIGHT = buildUniverse().catch(er => { console.warn('Universe refresh failed:', er.message); return LIVE_UNIVERSE; })
    .finally(() => { UNIVERSE_INFLIGHT = null; });
  return UNIVERSE_INFLIGHT;
}
async function buildUniverse() {
  const started = Date.now();
  let listed = [], source = '';
  try { listed = await fetchNseIndexList('ind_niftytotalmarket_list.csv'); source = 'NSE Nifty Total Market'; }
  catch (er) { listed = await fetchNseIndexList('ind_nifty500list.csv'); source = 'NSE Nifty 500'; }
  /* New listings (IPOs) are not in the index lists yet; without them a ₹50,000 Cr IPO would be missed. */
  let recent = [];
  try { recent = await fetchNseRecentListings(730); } catch (er) { console.warn('NSE recent listings:', er.message); }
  const inIndex = new Set(listed.map(x => x.sym));
  const newOnes = recent.filter(x => !inIndex.has(x.sym));
  if (newOnes.length) source += ` + ${newOnes.length} NSE listings from the last 2 years`;
  const nameOf = {}; [...listed, ...newOnes].forEach(x => { nameOf[x.sym + '.NS'] = x.name; });
  const industry = {}; listed.forEach(x => { const sec = industryToSector(x.industry, x.sym, x.name); if (x.industry) industry[x.sym] = { industry: x.industry, sector: sec }; });
  /* A recent listing keeps the industry it had in the previous universe (if any). */
  newOnes.forEach(x => { const old = LIVE_UNIVERSE?.industry?.[x.sym]; if (old) industry[x.sym] = old; });
  const tickers = uniqueTickersS([...listed, ...newOnes].map(x => x.sym + '.NS'));
  const rows = [], failed = [];
  await mapLimit(tickers, 8, async t => {
    try {
      const [shares, chart] = await Promise.all([
        fetchSharesOutstanding(t).catch(() => null),
        withTimeout(yfChart(t, '1d', '5d'), 8000, t + ' universe price'),
      ]);
      const price = firstValidNumber(chart?.meta?.regularMarketPrice);
      if (!price) throw new Error('no price');
      const mcapCr = shares ? shares * price / 1e7 : null;
      const symOnly = t.replace(/\.(NS|BO)$/, '');
      rows.push({ ticker:t, sym:symOnly, name:nameOf[t] || chart?.meta?.longName || chart?.meta?.shortName || symOnly,
        industry: industry[symOnly]?.industry || null, sector: industry[symOnly]?.sector || null,
        mcapCr: mcapCr ? Math.round(mcapCr) : null, price:+price.toFixed(2), shares: shares || null, mcapSource: mcapCr ? 'live' : 'none' });
    } catch (er) { failed.push(t); }
  });
  const kept = rows.filter(r => r.mcapCr >= UNIVERSE_KEEP_MCAP_CR).sort((a,b) => b.mcapCr - a.mcapCr);
  const eligibleCount = kept.filter(r => r.mcapCr > MIN_SCREENER_MCAP_CR).length;
  /* Sanity guard: a data outage must not shrink the universe to a handful of stocks. */
  if (eligibleCount < 100) throw new Error(`only ${eligibleCount} eligible stocks - keeping previous universe`);
  LIVE_UNIVERSE = {
    generatedAt: new Date().toISOString(), source,
    rows: kept, industry,
    stats: { listed: listed.length, recentListings: newOnes.length, checked: tickers.length, priced: rows.length, failed: failed.length,
      eligible: eligibleCount, buffer: kept.length - eligibleCount, seconds: Math.round((Date.now() - started) / 1000) }
  };
  saveUniverseToDisk();
  console.log(`Universe: ${eligibleCount} stocks > ₹35,000 Cr (+${kept.length - eligibleCount} in the ₹30-35k buffer) from ${source} in ${LIVE_UNIVERSE.stats.seconds}s`);
  return LIVE_UNIVERSE;
}
/* Usable for 14 days, so one failed weekly rebuild never drops the screener back to the fallback list. */
function liveUniverseUsable() { return !!(LIVE_UNIVERSE?.rows?.length && Date.now() - Date.parse(LIVE_UNIVERSE.generatedAt) < 14 * 24 * 60 * 60 * 1000); }
function universeSummary() {
  if (!liveUniverseUsable()) return { mode:'fallback', source:'Built-in fallback list', note:'The NSE universe has not been built yet (first start) - using the built-in list until the rebuild completes.' };
  const u = LIVE_UNIVERSE;
  const nextAt = new Date(Date.parse(u.generatedAt) + UNIVERSE_MAX_AGE_MS).toISOString();
  return { mode:'live', source:u.source, generatedAt:u.generatedAt, nextRebuildAt:nextAt,
    eligible: u.stats?.eligible ?? u.rows.filter(r => r.mcapCr > MIN_SCREENER_MCAP_CR).length, stats:u.stats };
}
/* Live market cap at scan time: shares × the scan's own live price; falls back to the universe/Excel value. */
function screenerMcapNow(ticker, price) {
  const sh = SHARES_CACHE[ticker]?.shares;
  if (sh && Number.isFinite(+price) && +price > 0) return Math.round(sh * price / 1e7);
  return getScreenerMcapCr(ticker);
}
function getScreenerMcapCr(ticker) {
  if (liveUniverseUsable()) { const r = LIVE_UNIVERSE.rows.find(x => x.ticker === ticker); if (r) return r.mcapCr; }
  return SCREENER_MCAP_35K[ticker] || 0;
}
/* User Excel whitelist: stocks marked YES in "WHITE LIST STOCK FOR SCREENER". */
const SCREENER_FORCE_INCLUDE = new Set([
  'HDFCBANK.NS','SBIN.NS','BAJFINANCE.NS','LICI.NS','ADANIPOWER.NS',
  'ITC.NS','KOTAKBANK.NS','NTPC.NS','ONGC.NS','BEL.NS',
  'COALINDIA.NS','POWERGRID.NS','HINDZINC.NS','TATASTEEL.NS','ETERNAL.NS',
  'HINDALCO.NS','SHRIRAMFIN.NS','WIPRO.NS','IOC.NS','VBL.NS',
  'JIOFIN.NS','DLF.NS','PFC.NS','BHEL.NS','TMCV.NS',
  'MOTHERSON.NS','BANKBARODA.NS','TMPV.NS','TATAPOWER.NS','VEDL.NS',
  'HDFCLIFE.NS','CGPOWER.NS','TATACAP.NS','IRFC.NS','BPCL.NS',
  'UNIONBANK.NS','GROWW.NS','PNB.NS','CANBK.NS','INDUSTOWER.NS',
  'INDIANB.NS','MARICO.NS','AMBUJACEM.NS','GODREJCP.NS','MAXHEALTH.NS',
  'GAIL.NS','ZYDUSLIFE.NS','GMRAIRPORT.NS','JSWENERGY.NS','INDHOTEL.NS',
  'ABCAPITAL.NS','NTPCGREEN.NS','LODHA.NS','ASHOKLEY.NS','MEESHO.NS',
  'RECLTD.NS','LENSKART.NS','SAIL.NS','OIL.NS','DABUR.NS',
  'NHPC.NS','IDBI.NS','HINDPETRO.NS','NMDC.NS','NYKAA.NS',
  'ICICIPRULI.NS','NATIONALUM.NS','AUBANK.NS','FORTIS.NS','SWIGGY.NS',
  'FEDERALBNK.NS','BAJAJHFL.NS','INDUSINDBK.NS','LTF.NS','BIOCON.NS',
  'NAM-INDIA.NS','ATGL.NS','GICRE.NS','BANKINDIA.NS','JSL.NS',
  'UNOMINDA.NS','NAUKRI.NS','MAHABANK.NS','SBICARD.NS','BERGEPAINT.NS',
  'VMM.NS','RVNL.NS','FACT.NS','HDBFS.NS','JSWINFRA.NS',
  'HINDCOPPER.NS','UPL.NS','KRT.BO','MOTILALOFS.NS','PATANJALI.NS',
  'ALTIUSINVIT.BO','NLCINDIA.NS','PREMIERENE.NS','360ONE.NS','M&MFIN.NS',
  'ANTHEM.NS','IRCTC.NS','AIIL.NS','EMBASSY.NS','HUDCO.NS',
  'PETRONET.NS','ASTERDM.NS','CONCOR.NS','SONACOMS.NS','IREDA.NS',
  'POONAWALLA.NS','KALYANKJIL.NS','ATHERENERG.NS','DELHIVERY.NS','TATAINVEST.NS',
  'KPRMILL.NS','PWL.NS','ITCHOTELS.NS','HEXT.NS','JUBLFOOD.NS',
  'MINDSPACE.BO','NHIT.BO','BANDHANBNK.NS','STARHEALTH.NS','ABSLAMC.NS',
]);
function isScreenerMcapEligible(ticker) {
  /* Live Ready/Watchlist screener uses one simple universe rule only:
     market cap above the configured minimum. The old force-include list is kept
     above as an import/reference list, but it is NOT used as a hidden bypass.
     This prevents UI confusion where a stock is counted in the scan and then
     rejected later by the hard market-cap gate. */
  return getScreenerMcapCr(ticker) > MIN_SCREENER_MCAP_CR;
}
function uniqueTickersS(arr) { return [...new Set((arr || []).filter(Boolean))]; }

function approxSamePriceS(a, b, pct = 0.002) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return false;
  return Math.abs(x - y) <= Math.max(0.05, Math.max(x, y) * pct);
}

/* Typical NSE intraday volume profile: cumulative share of a full day's volume traded by N minutes
   after 09:15 IST (U-shaped: heavy open and close). Used to project today's partial volume to a
   full-day estimate before comparing it with full-day averages. Same curve as the frontend. */
const NSE_VOLUME_CURVE = [[0,0],[15,0.08],[30,0.14],[60,0.22],[120,0.35],[180,0.47],[240,0.58],[300,0.70],[345,0.80],[360,0.86],[375,1.0]];
function nseSessionShare(nowMs = Date.now()) {
  const ist = new Date(nowMs + 330 * 60000);
  const dow = ist.getUTCDay();
  if (dow === 0 || dow === 6) return 1;
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes() - (9 * 60 + 15);
  if (mins <= 0 || mins >= 375) return 1; /* before open or after close: nothing to project */
  for (let i = 1; i < NSE_VOLUME_CURVE.length; i++) {
    const [m1, s1] = NSE_VOLUME_CURVE[i], [m0, s0] = NSE_VOLUME_CURVE[i-1];
    if (mins <= m1) return Math.max(0.08, s0 + (s1 - s0) * (mins - m0) / (m1 - m0));
  }
  return 1;
}

function enrichDailyForLiveScreenerS(daily, meta) {
  /* Align screener with Overview data flow.
     Yahoo 1D bars are inconsistent during market hours: sometimes the last daily bar
     is today's live/partial candle, sometimes it is still yesterday's completed candle.
     The Overview tab repairs this using live quote/meta; screener must do the same or
     it can show stale price/EMA/RR versus the opened stock page. */
  if (!daily || !Array.isArray(daily.C) || !daily.C.length) return daily;
  const out = {
    T:[...(daily.T || [])], C:[...(daily.C || [])], O:[...(daily.O || [])],
    H:[...(daily.H || [])], L:[...(daily.L || [])], V:[...(daily.V || [])],
    n: daily.n || daily.C.length,
    _liveAdjusted: false,
    _liveAppended: false,
    _prevSessionIdx: null,
    _liveSessionIdx: null,
  };
  const live = firstValidNumber(meta?.regularMarketPrice, out.C[out.C.length - 1]);
  if (!Number.isFinite(live) || live <= 0) return out;
  const pc = firstValidNumber(meta?.regularMarketPreviousClose, meta?.previousClose);
  const last = out.C.length - 1;
  const o = firstValidNumber(meta?.regularMarketOpen, out.O[last], live) || live;
  const h = firstValidNumber(meta?.regularMarketDayHigh, out.H[last], Math.max(o, live)) || Math.max(o, live);
  const l = firstValidNumber(meta?.regularMarketDayLow, out.L[last], Math.min(o, live)) || Math.min(o, live);
  const v = firstValidNumber(meta?.regularMarketVolume, out.V[last], 0) || 0;
  const bar = {
    T: Number(meta?.regularMarketTime) || Math.floor(Date.now() / 1000),
    O: +Number(o).toFixed(4),
    H: +Math.max(Number(h), Number(o), Number(live)).toFixed(4),
    L: +Math.min(Number(l), Number(o), Number(live)).toFixed(4),
    C: +Number(live).toFixed(4),
    V: Math.round(v),
  };
  /* A NEW bar for today must not fall back to the last bar's open/high/low/volume - that is yesterday's
     candle (chart meta has no regularMarketOpen), and yesterday's low folded into today faked a support test. */
  const oN = firstValidNumber(meta?.regularMarketOpen, live) || live;
  const hN = firstValidNumber(meta?.regularMarketDayHigh, Math.max(oN, live)) || Math.max(oN, live);
  const lN = firstValidNumber(meta?.regularMarketDayLow, Math.min(oN, live)) || Math.min(oN, live);
  const newBar = { T: bar.T, O: +Number(oN).toFixed(4), H: +Math.max(hN, oN, live).toFixed(4), L: +Math.min(lN, oN, live).toFixed(4),
    C: bar.C, V: Math.round(firstValidNumber(meta?.regularMarketVolume, 0) || 0) };

  /* Decide by DATE, not price: is Yahoo's last daily bar from the same session as the live quote?
     The old "last close ≈ previous close (0.2%)" test misfired on flat days (duplicated today's
     candle) and on gap days (overwrote yesterday's completed candle). Price test is only a fallback
     when Yahoo gives no regularMarketTime. */
  const tz = meta?.exchangeTimezoneName || meta?.timezone || 'Asia/Kolkata';
  const liveTs = Number(meta?.regularMarketTime);
  const lastIsPrevSession = (Number.isFinite(liveTs) && liveTs > 0 && out.T[last])
    ? !sameMarketDate(out.T[last], liveTs, tz)
    : (Number.isFinite(pc) && approxSamePriceS(out.C[last], pc));
  if (lastIsPrevSession) {
    out._prevSessionIdx = last;
    out._liveSessionIdx = last + 1;
    out._liveAppended = true;
    out.T.push(newBar.T); out.O.push(newBar.O); out.H.push(newBar.H); out.L.push(newBar.L); out.C.push(newBar.C); out.V.push(newBar.V);
  } else {
    out._prevSessionIdx = last >= 1 ? last - 1 : last;
    out._liveSessionIdx = last;
    out.T[last] = out.T[last] || bar.T;
    out.O[last] = bar.O; out.H[last] = bar.H; out.L[last] = bar.L; out.C[last] = bar.C;
    if (out.V.length) out.V[last] = bar.V || out.V[last];
  }
  /* Project today's partial volume to a full-day estimate so volume ratios are not biased low all
     morning (a normal stock at 10:30 used to read as ~25% volume). Only for today's live NSE session. */
  const liveIdx = out._liveSessionIdx;
  const todayKey = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const liveKey = Number.isFinite(liveTs) && liveTs > 0 ? new Date(liveTs * 1000 + 330 * 60000).toISOString().slice(0, 10) : null;
  const share = nseSessionShare();
  if (liveIdx != null && liveKey === todayKey && share < 1 && Number.isFinite(out.V[liveIdx])) {
    out._rawTodayVol = out.V[liveIdx];
    out.V[liveIdx] = Math.round(out.V[liveIdx] / share);
    out._volProjected = true;
  }
  out.n = out.C.length;
  out._liveAdjusted = true;
  return out;
}

function screenerEligibleUniverseS() {
  /* Live universe (NSE list × live market cap) when available; otherwise the Excel list. */
  if (liveUniverseUsable()) return LIVE_UNIVERSE.rows.map(r => r.ticker);
  /* De-dupe first so aliases/duplicates cannot distort screener counts. */
  return uniqueTickersS(TOP250_TICKERS).filter(isScreenerMcapEligible);
}
function stockWeekAlertFromStrategyS(strategyScores) {
  const strategies = [
    strategyScores?.emaPullback,
    strategyScores?.ema50DeepPullback,
    strategyScores?.supportBounce,
    strategyScores?.breakoutVolume,
    strategyScores?.momentumContinuation,
  ].filter(Boolean);
  const active = strategies
    .filter(x => x.active === true && (x.action === 'READY' || x.action === 'CONFIRM'))
    .sort((a,b) => (+b.score || 0) - (+a.score || 0))[0] || null;
  const best = active || strategyScores?.best || strategies.sort((a,b)=>(+b.score || 0)-(+a.score || 0))[0] || null;
  return {
    buyAlert: !!active,
    alertAction: active?.action || 'WATCH',
    alertSetup: best?.name || 'No active setup',
    alertScore: Number.isFinite(+best?.score) ? Math.round(+best.score) : null,
    alertReason: active ? 'Strategy gate passed' : 'Legacy base screen passed, but no strategy gate is READY/CONFIRM',
  };
}

/* ── Screener indicator math (server-side, mirrors frontend) ── */
function emaS(arr, period) {
  if (arr.length < period) return null;
  const k = 2 / (period + 1);
  let e = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

/* Screener.com DMA uses a simple daily moving average of closing prices. */
function dmaS(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function rsiS(C, p = 14) {
  if (C.length < p + 2) return null;
  const d = C.slice(1).map((c, i) => c - C[i]);
  let g = d.slice(0, p).reduce((a, b) => a + Math.max(0, b), 0) / p;
  let l = d.slice(0, p).reduce((a, b) => a + Math.max(0, -b), 0) / p;
  for (let i = p; i < d.length; i++) {
    g = (g * (p - 1) + Math.max(0, d[i])) / p;
    l = (l * (p - 1) + Math.max(0, -d[i])) / p;
  }
  if (l === 0 && g === 0) return 50;
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function macdS(C) {
  if (!Array.isArray(C) || C.length < 35) return null;
  function emaAligned(arr, p) {
    if (!Array.isArray(arr) || arr.length < p) return arr.map(() => null);
    const k = 2 / (p + 1);
    let e = arr.slice(0, p).reduce((a,b)=>a+b,0) / p;
    const out = new Array(p - 1).fill(null);
    out.push(e);
    for (let i = p; i < arr.length; i++) {
      e = arr[i] * k + e * (1 - k);
      out.push(e);
    }
    return out;
  }
  const e12 = emaAligned(C, 12), e26 = emaAligned(C, 26);
  const macdLine = e12.map((v,i) => v != null && e26[i] != null ? v - e26[i] : null).filter(v => Number.isFinite(v));
  if (macdLine.length < 9) return null;
  const sig = emaAligned(macdLine, 9).filter(v => Number.isFinite(v));
  const macd = macdLine[macdLine.length - 1];
  const signal = sig[sig.length - 1];
  if (![macd, signal].every(Number.isFinite)) return null;
  return { macd, signal, hist: macd - signal };
}




/* ── Qualified Screener scoring helpers — mirrors the website Swing Decision logic without AI calls ── */
function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sigClassScore(c) { return ({'strong-bull':2,bull:1,neutral:0,bear:-1,'strong-bear':-2,na:0}[c] ?? 0); }
function sigRecS(v) { if(v==null) return {c:'na'}; if(v>=.5) return {c:'strong-bull'}; if(v>=.1) return {c:'bull'}; if(v>-.1) return {c:'neutral'}; if(v>-.5) return {c:'bear'}; return {c:'strong-bear'}; }
function sigRsiClass(v){ if(v==null) return {c:'na'}; if(v>=80) return {c:'strong-bear'}; if(v>=70) return {c:'bear'}; if(v<=20) return {c:'strong-bull'}; if(v<=30) return {c:'bull'}; return v>50?{c:'bull'}:{c:'bear'}; }
function sigMacdClass(m){ if(!m) return {c:'na'}; if(m.hist>0) return {c:m.macd>0?'bull':'neutral'}; return {c:m.macd<0?'bear':'neutral'}; }
function sigEmaClass(price,e20,e50,e200){
  const vals=[e20,e50,e200].filter(v=>v!=null && Number.isFinite(v));
  if(!vals.length) return {c:'na'};
  const above=vals.filter(v=>price>v).length;
  if(above===vals.length) return {c:'strong-bull'};
  if(above===0) return {c:'strong-bear'};
  return above>vals.length/2?{c:'bull'}:{c:'bear'};
}
function sigVolClass(todayVol, avgVol, priceChg){
  if(!todayVol || !avgVol) return {c:'na'};
  const r=todayVol/avgVol;
  if(priceChg>0 && r>1.2) return {c:'bull'};
  if(priceChg<0 && r>1.2) return {c:'bear'};
  return {c:'neutral'};
}
function calcAdxS(C,H,L,p=14){
  if(!Array.isArray(C)||!Array.isArray(H)||!Array.isArray(L)||C.length<p*2+2||H.length<C.length||L.length<C.length) return null;
  const tr=[], pdm=[], ndm=[];
  for(let i=1;i<C.length;i++){
    const up=H[i]-H[i-1], down=L[i-1]-L[i];
    pdm.push(up>down && up>0 ? up : 0);
    ndm.push(down>up && down>0 ? down : 0);
    tr.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
  }
  const wilderAvg=(arr)=>{
    if(arr.length<p) return [];
    let v=arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
    const out=[v];
    for(let i=p;i<arr.length;i++){ v = v - (v/p) + (arr[i]/p); out.push(v); }
    return out;
  };
  const trS=wilderAvg(tr), pS=wilderAvg(pdm), nS=wilderAvg(ndm);
  const pdi=pS.map((v,i)=>trS[i]?100*v/trS[i]:0);
  const ndi=nS.map((v,i)=>trS[i]?100*v/trS[i]:0);
  const dx=pdi.map((v,i)=>{ const sum=v+ndi[i]; return sum?100*Math.abs(v-ndi[i])/sum:0; });
  const adxA=wilderAvg(dx);
  const last=adxA.length-1, off=pdi.length-adxA.length;
  if(last<0) return null;
  return {adx:adxA[last], pdi:pdi[last+off] ?? pdi[pdi.length-1] ?? 0, ndi:ndi[last+off] ?? ndi[ndi.length-1] ?? 0};
}

function sigAdxClass(adx){ if(!adx) return {c:'na'}; return adx.pdi>adx.ndi ? {c:adx.adx>25?'bull':'neutral'} : {c:adx.adx>25?'bear':'neutral'}; }
function recommendationValueS(C,H,L,V){
  const n=C.length, price=C[n-1], prev=C[n-2]||price;
  const e20=emaS(C,20), e50=emaS(C,50), e200=emaS(C,200);
  const rsi=rsiS(C), macd=macdS(C), adx=calcAdxS(C,H,L);
  const volEnd=Math.max(0, Math.min(V.length, n)-1);
  const volBase20=V.slice(Math.max(0, volEnd-20), volEnd);
  const avgVol=volBase20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase20.length);
  const rows=[
    {sig:sigEmaClass(price,e20,e50,e200), w:3},
    {sig:sigRsiClass(rsi), w:2},
    {sig:sigMacdClass(macd), w:2},
    {sig:sigAdxClass(adx), w:1},
    {sig:sigVolClass(V[n-1]||0, avgVol, price-prev), w:1},
  ];
  const total=rows.reduce((a,r)=>a+r.w,0)*2;
  const raw=rows.reduce((a,r)=>a+sigClassScore(r.sig.c)*r.w,0);
  return total ? raw/total : 0;
}
function atrS(C,H,L,p=14){
  if(C.length<p+2) return Math.max((C[C.length-1]||1)*0.015, 1);
  const tr=[];
  for(let i=1;i<C.length;i++) tr.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
  let atr=tr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<tr.length;i++) atr=(atr*(p-1)+tr[i])/p;
  return atr || Math.max((C[C.length-1]||1)*0.015, 1);
}
function swingRRS({bias, price, e20, e50, r1, r2, s1, s2, C, H, L, atr}){
  const valid=v=>Number.isFinite(+v)&&+v>0;
  const recentHigh=Math.max(...H.slice(Math.max(0,H.length-21), Math.max(0,H.length-1)).filter(valid), 0);
  const lows=L.slice(Math.max(0,L.length-21), Math.max(0,L.length-1)).filter(valid);
  const recentLow=lows.length?Math.min(...lows):0;
  const minReward=Math.max(atr*0.75, price*0.008);
  if(bias==='Bullish'){
    /* Stop = nearest structure that is at least 0.75 ATR below price, minus a 0.25 ATR buffer (same idea as
       the Strategy-tab cards). The old rule put the stop ON the closest level (often EMA20 just under price),
       which normal noise hits and which inflated screener RR versus the Overview plan. */
    const stopCandidates=[s1,s2,e20,e50,recentLow].filter(v=>valid(v)&&+v<=price-atr*0.75).map(Number).sort((a,b)=>b-a);
    const stop=stopCandidates.length ? stopCandidates[0]-atr*0.25 : price-atr*1.5;
    const risk=Math.max(price-stop, atr*0.75);
    const targets=[r1,r2,recentHigh,price+atr*2].filter(v=>valid(v)&&+v>price).map(Number);
    const meaningful=targets.filter(v=>v-price>=minReward).sort((a,b)=>a-b);
    const target=meaningful[0] || (targets.length?Math.max(...targets):price+atr*1.5);
    const reward=Math.max(target-price,0);
    return {rr:risk>0&&reward>0?+(reward/risk).toFixed(2):0, stop, target, stopAtr:+(risk/atr).toFixed(2)};
  }
  if(bias==='Bearish'){
    const stopCandidates=[r1,r2,e20,e50,recentHigh].filter(v=>valid(v)&&+v>=price+atr*0.75).map(Number).sort((a,b)=>a-b);
    const stop=stopCandidates.length ? stopCandidates[0]+atr*0.25 : price+atr*1.5;
    const risk=Math.max(stop-price, atr*0.75);
    const targets=[s1,s2,recentLow,price-atr*2].filter(v=>valid(v)&&+v<price).map(Number);
    const meaningful=targets.filter(v=>price-v>=minReward).sort((a,b)=>b-a);
    const target=meaningful[0] || (targets.length?Math.min(...targets):price-atr*1.5);
    const reward=Math.max(price-target,0);
    return {rr:risk>0&&reward>0?+(reward/risk).toFixed(2):0, stop, target, stopAtr:+(risk/atr).toFixed(2)};
  }
  return {rr:0, stop:null, target:null, stopAtr:null};
}

/* ── Independent 4-strategy scoring modules ──
   These modules READ the already-calculated EMA, RSI, MACD, ATR and S/R values.
   They do not change existing formulas, support/resistance levels or indicator calculations. */
function pctDistS(a, b) {
  a = Number(a); b = Number(b);
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? Math.abs(a - b) / Math.abs(b) * 100 : 999;
}
function recentHighLowS(H, L, days = 10) {
  const valid = v => Number.isFinite(+v) && +v > 0;
  const hs = (H || []).slice(Math.max(0, H.length - days), H.length).filter(valid).map(Number);
  const ls = (L || []).slice(Math.max(0, L.length - days), L.length).filter(valid).map(Number);
  return { high: hs.length ? Math.max(...hs) : null, low: ls.length ? Math.min(...ls) : null };
}

function completedSwingLevelsS(H, L) {
  const valid = v => Number.isFinite(+v) && +v > 0;
  const h = (H || []).map(Number).filter(valid);
  const l = (L || []).map(Number).filter(valid);
  /* Screener breakout/support levels must match website S&R logic:
     R1/S1 = completed 7D high/low, R2/S2 = completed 14D high/low.
     Exclude the latest candle so today's price can genuinely break yesterday's range. */
  const endH = Math.max(0, h.length - 1);
  const endL = Math.max(0, l.length - 1);
  const hi = (arr, days, end) => {
    const x = arr.slice(Math.max(0, end - days), end);
    return x.length ? Math.max(...x) : null;
  };
  const lo = (arr, days, end) => {
    const x = arr.slice(Math.max(0, end - days), end);
    return x.length ? Math.min(...x) : null;
  };
  return {
    r1: hi(h, 7, endH),  s1: lo(l, 7, endL),
    r2: hi(h, 14, endH), s2: lo(l, 14, endL),
    r3: hi(h, 21, endH), s3: lo(l, 21, endL),
  };
}

function rrLongS(price, stop, target) {
  price = Number(price); stop = Number(stop); target = Number(target);
  if (![price, stop, target].every(Number.isFinite) || !(target > price) || !(price > stop)) return 0;
  return +((target - price) / (price - stop)).toFixed(2);
}
function scoreEMASetupS({price,e20,e50,e200,rsi,volBlend,rrBull,macd,C,H,L,atr,r1,r2,pv}){
  const trendOk = price > e50 && e50 > e200;
  const stackOk = price > e20 && e20 > e50 && e50 > e200;
  const dist20 = pctDistS(price, e20), dist50 = pctDistS(price, e50);
  const macdOk = !!(macd && macd.hist >= 0);
  const n = Array.isArray(C) ? C.length : 0;
  const close = Number(C?.[n-1] ?? price), prev = Number(C?.[n-2] ?? close);
  const bullishClose = close >= prev;
  const highSelling = !bullishClose && volBlend >= 1.10;
  let score = 0;
  if (stackOk) score += 25; else if (trendOk) score += 20;
  if (dist20 <= 2.5) score += 25; else if (dist50 <= 3.5) score += 18;
  if (rsi >= 45 && rsi <= 68) score += 20; else if (rsi >= 40 && rsi < 72) score += 12;
  /* Pullback volume: quiet pullback (+4) and a green bounce day on >=1.0x volume (+8). */
  if (pv?.bounceOk) score += 8; if (pv?.quietPullback) score += 4;
  if (highSelling) score -= 8;
  if (rrBull >= 1.5) score += 12; else if (rrBull >= 1.25) score += 8; else if (rrBull >= 1.0) score += 5;
  if (macdOk) score += 6;
  score = clampNum(Math.round(score), 0, 100);
  const gateShapeOk = !!(price >= e20 && e20 > e50 && e50 > e200 && dist20 <= 2.5 && !highSelling);
  return {
    name:'EMA Pullback',
    score,
    distancePct:Number.isFinite(+dist20) ? +dist20.toFixed(2) : 999,
    active:score>=70 && gateShapeOk,
    action:(score>=80 && gateShapeOk)?'READY':(score>=70?'CONFIRM':score>=55?'WATCH':'WAIT')
  };
}

function scoreEMA50DeepPullbackS({price,e20,e50,e200,rsi,volBlend,rrBull,macd,adx,C,H,L,atr,r1,r2,pv}){
  const trendOk = price > e200 && e50 > e200;
  const dist50Signed = e50 ? ((price - e50) / e50) * 100 : 999;
  const nearE50 = dist50Signed >= -2.0 && dist50Signed <= 5.0;
  const macdOk = !!(macd && macd.hist >= 0);
  const adxVal = Number(adx?.adx || adx || 0);
  const adxOk = !adxVal || adxVal >= 16;
  const n=C.length, close=C[n-1], prev=C[n-2]||close, low=L[n-1];
  const bullishClose = close >= prev;
  const highSelling = !bullishClose && volBlend >= 1.10;
  const bounce = nearE50 && low <= e50 * 1.015 && close >= e50 && close > prev;
  let score = 0;
  if (trendOk) score += 25;
  if (nearE50) score += 25;
  if (bounce) score += 15;
  if (rsi >= 45 && rsi <= 62) score += 14; else if (rsi >= 40 && rsi <= 66) score += 8;
  if (pv?.bounceOk) score += 6; if (pv?.quietPullback) score += 3;
  if (highSelling) score -= 6;
  if (rrBull >= 1.5) score += 7; else if (rrBull >= 1.25) score += 5; else if (rrBull >= 1.0) score += 3;
  if (macdOk) score += 3;
  if (adxOk) score += 2;
  score = clampNum(Math.round(score), 0, 100);
  return {
    name:'EMA50 Deep Pullback',
    score,
    distancePct:Number.isFinite(+dist50Signed) ? +Math.abs(dist50Signed).toFixed(2) : 999,
    active:score>=70 && trendOk && nearE50 && bounce && price >= e50 && !highSelling,
    action:(score>=80 && trendOk && nearE50 && bounce && price >= e50 && !highSelling)?'READY':(score>=70?'CONFIRM':score>=55?'WATCH':'WAIT')
  };
}
function scoreSupportBounceS({price,e20,e50,e200,rsi,volBlend,rrBull,C,H,L,atr,s1,s2,r1,r2,pv}){
  const n=C.length, close=C[n-1], prev=C[n-2]||close, low=L[n-1];
  const trendOk = price > e50 && e50 > e200;
  const levels = [s1,s2].filter(v=>Number.isFinite(+v) && +v > 0 && +v <= price * 1.01).map(Number);
  const nearest = levels.sort((a,b)=>Math.abs(price-a)-Math.abs(price-b))[0] || null;
  const dist = nearest ? pctDistS(price, nearest) : 999;
  const nearSupport = !!nearest && dist <= 1.5;
  const rejectedSupport = nearSupport && low <= nearest * 1.003 && close > nearest;
  const bullishClose = close > prev;
  const rsiOk = rsi >= 35 && rsi <= 58;
  let stop = nearest ? nearest - atr * 0.35 : null;
  const target = [r1,r2].filter(v=>Number.isFinite(+v)&&+v>price).map(Number).sort((a,b)=>a-b)[0] || price + atr*2;
  const rr = stop ? rrLongS(price, stop, target) : 0;
  let score = 0;
  if (trendOk) score += 18;
  if (nearSupport) score += 25;
  if (rejectedSupport) score += 25;
  if (bullishClose) score += 10;
  if (rsiOk) score += 12;
  if (pv?.bounceOk) score += 5; if (pv?.quietPullback) score += 2;
  if (rr >= 1.25 || rrBull >= 1.25) score += 3;
  score = clampNum(Math.round(score), 0, 100);
  const bounceConfirmed = !!(rejectedSupport && bullishClose);
  return {
    name:'Support / Resistance Bounce',
    score,
    distancePct:Number.isFinite(+dist) ? +dist.toFixed(2) : 999,
    active:score>=70 && bounceConfirmed,
    action:(score>=80 && bounceConfirmed)?'READY':(score>=70?'CONFIRM':score>=55?'WATCH':'WAIT'),
    support:nearest, rr, bounceConfirmed
  };
}
function scoreBreakoutS({price,e20,e50,e200,rsi,volBlend,rrBull,macd,C,H,L,atr,r1,r2}){
  const trendOk = price > e50 && e50 > e200;
  const brokeR1 = Number.isFinite(+r1) && +r1 > 0 && price > +r1 * 1.002;
  const notExtended = e20 ? pctDistS(price, e20) <= 6.0 : true;
  const macdOk = !!(macd && macd.macd > macd.signal && macd.hist > 0);
  const volumeOk = volBlend >= 1.1;
  let score = 0;
  if (trendOk) score += 20;
  if (brokeR1) score += 30;
  if (volumeOk) score += 18; else if (volBlend >= 0.9) score += 8;
  if (macdOk) score += 12;
  if (rsi >= 50 && rsi < 70) score += 12; else if (rsi >= 45 && rsi < 75) score += 6;
  if (notExtended) score += 5;
  if (rrBull >= 1.25) score += 3;
  score = clampNum(Math.round(score), 0, 100);
  return {name:'Breakout with Volume', score, active:score>=70, action:score>=80?'READY':score>=70?'CONFIRM':score>=55?'WATCH':'WAIT'};
}
function scorePreBreakoutS({price,e20,e50,e200,rsi,volBlend,rrBull,macd,C,H,L,atr,r1,r2}){
  const trendOk = price > e50 && e50 > e200;
  const resistance = Number(r1);
  const nearBreakout = Number.isFinite(resistance) && resistance > price && ((resistance - price) / price * 100) <= 2.0;
  const notExtended = e20 ? pctDistS(price, e20) <= 6.5 : true;
  const macdOk = !!(macd && macd.macd >= macd.signal && macd.hist >= 0);
  const volumeOk = volBlend >= 0.75;
  const trigger = Number.isFinite(resistance) ? resistance : price;
  const stop = Number.isFinite(+e20) && e20 < trigger ? e20 - Math.max(atr*0.25, trigger*0.0025) : trigger - Math.max(atr*1.4, trigger*0.015);
  const target = [r2, trigger + atr*2, trigger*1.03].filter(v=>Number.isFinite(+v)&&+v>trigger).map(Number).sort((a,b)=>a-b)[0];
  const plannedRR = rrLongS(trigger, stop, target);
  let score = 0;
  if (trendOk) score += 22;
  if (nearBreakout) score += 28;
  if (volumeOk) score += 12; else if (volBlend >= 0.6) score += 6;
  if (macdOk) score += 12;
  if (rsi >= 48 && rsi <= 68) score += 16; else if (rsi >= 45 && rsi <= 72) score += 8;
  if (notExtended) score += 7;
  if (plannedRR >= 1.25 || rrBull >= 1.25) score += 3;
  score = clampNum(Math.round(score), 0, 100);
  return {name:'Pre-Breakout Watch', score, active:score>=70, action:'WATCH', plannedRR, distancePct:Number.isFinite(resistance)?+(((resistance-price)/price)*100).toFixed(2):999};
}
function scoreMomentumS({price,e20,e50,e200,rsi,volBlend,rrBull,macd,C,H,L,atr,r1}){
  const n=C.length;
  const stackOk = price > e20 && e20 > e50 && e50 > e200;
  const macdOk = !!(macd && macd.macd > macd.signal && macd.hist > 0);
  const high5 = n > 6 ? Math.max(...H.slice(n-6,n-1).filter(v=>Number.isFinite(+v)).map(Number),0) : 0;
  const nearHigh = high5 ? price >= high5 * 0.985 : false;
  const ret5 = n > 6 && C[n-6] ? (price - C[n-6]) / C[n-6] * 100 : 0;
  const notTooExtended = e20 ? pctDistS(price, e20) <= 7.0 : true;
  let score = 0;
  if (stackOk) score += 25;
  if (macdOk) score += 18;
  if (volBlend >= 1.0) score += 14; else if (volBlend >= 0.8) score += 7;
  if (rsi >= 55 && rsi <= 70) score += 16; else if (rsi >= 50 && rsi < 75) score += 8;
  if (nearHigh) score += 12;
  if (ret5 >= 1 && ret5 <= 8) score += 10;
  if (notTooExtended) score += 5;
  score = clampNum(Math.round(score), 0, 100);
  /* Watch-only (never READY): momentum entries buy strength after the move, with the weakest R:R of the six
     setups. Use it to watch for the next EMA20 pullback or a fresh breakout instead. */
  return {name:'Momentum Continuation', score, active:score>=72, action:score>=55?'WATCH':'WAIT', watchOnly:true};
}

function readyGateStrategyS(name, obj, ctx){
  const reasons=[];
  const add=t=>{ if(t && !reasons.includes(t)) reasons.push(t); };
  const {price,e20,e50,e200,rsi,volBlend,rrBull,adx,r1,s1,s2,macd,C=[],L=[]} = ctx;
  const distE20 = pctDistS(price, e20);
  const adxVal = Number(adx?.adx || adx || 0);
  const nm = String(name || obj?.name || '').toLowerCase();

  const n0 = Array.isArray(C) ? C.length : 0;
  const close0 = Number(C?.[n0-1] ?? price), prev0 = Number(C?.[n0-2] ?? close0);
  const highSelling0 = close0 < prev0 && volBlend >= 1.10;
  if(!(rrBull >= 1.25)) add('RR below 1.25');
  const isPullbackSetup = /ema|deep|support|bounce/.test(nm) && !/breakout|momentum/.test(nm);
  if (isPullbackSetup) { const vr = SwingPlan.setupVolumeReason('pullback', volBlend, ctx.pv); if (vr) add(vr); }
  else if(volBlend < 0.75) add('Weak volume');
  if(highSelling0) add('High selling volume');

  if(nm.includes('ema50') || nm.includes('deep')){
    const distE50Signed = e50 ? ((price - e50) / e50) * 100 : 999;
    const n = Array.isArray(C) ? C.length : 0;
    const close = Number(C?.[n-1] ?? price), prev = Number(C?.[n-2] ?? close), low = Number(L?.[n-1] ?? close);
    const bounceConfirmed = !!(Number.isFinite(+e50) && distE50Signed >= 0 && distE50Signed <= 5 && low <= +e50 * 1.015 && close >= +e50 && close > prev);
    if(!(price > e200 && e50 > e200)) add('EMA50/EMA200 trend not bullish');
    if(!(price >= e50)) add('Price below EMA50');
    if(!(distE50Signed >= 0 && distE50Signed <= 5)) add('Not near EMA50 pullback zone');
    if(!bounceConfirmed) add('EMA50 bounce not confirmed');
    if(!(rsi >= 45 && rsi <= 62)) add('RSI outside EMA50 pullback zone');
    if(adxVal && adxVal < 16) add('Weak ADX for EMA50 trend');
  } else if(nm.includes('ema')){
    if(distE20 > 2.5) add('Late from EMA20');
    if(!(price >= e20)) add('Price below EMA20');
    if(!(e20 > e50)) add('EMA20 is not above EMA50');
    if(!(price > e50)) add('Price below EMA50');
    if(!(rsi >= 45 && rsi <= 68)) add('RSI outside EMA pullback zone');
    if(adxVal && adxVal < 18) add('Weak ADX for EMA trend');
  } else if(nm.includes('support')){
    const supportLevels = [s1,s2].filter(v=>Number.isFinite(+v) && +v>0 && +v <= price * 1.01).map(Number);
    const nearestSupport = supportLevels.sort((a,b)=>Math.abs(price-a)-Math.abs(price-b))[0] || null;
    const nearSupport = nearestSupport ? Math.abs(price-nearestSupport)/price*100 : 999;
    const n = C.length;
    const close = Number(C[n-1] || price), prev = Number(C[n-2] || close), low = Number(L[n-1] || close);
    const bounceConfirmed = !!(nearestSupport && nearSupport <= 1.5 && low <= nearestSupport * 1.005 && close > nearestSupport && close > prev);
    if(nearSupport > 1.5) add('Not near support');
    if(!bounceConfirmed) add('No confirmed support bounce/rejection');
    if(!(rsi >= 40 && rsi <= 60)) add('RSI outside support-bounce zone');
  } else if(nm.includes('pre-breakout') || nm.includes('pre breakout')){
    const resistance = Number(r1);
    const nearBreakout = Number.isFinite(resistance) && resistance > price && ((resistance - price) / price * 100) <= 2.0;
    if(!nearBreakout) add('Not within 2% below breakout resistance');
    if(!(volBlend >= 0.75)) add('Pre-breakout volume below 0.75x');
    if(distE20 > 6.5) add('Pre-breakout extended from EMA20');
    if(!(rsi >= 48 && rsi <= 68)) add('RSI outside pre-breakout zone');
    if(adxVal && adxVal < 14) add('Weak ADX for pre-breakout');
  } else if(nm.includes('breakout')){
    if(!(rrBull >= 1.25)) add('Breakout RR below 1.25');
    if(!(volBlend >= 1.1)) add('Breakout volume below 1.1x');
    if(distE20 > 6.5) add('Breakout extended from EMA20');
    if(!(rsi >= 52 && rsi <= 72)) add('RSI outside breakout zone');
    if(adxVal && adxVal < 16) add('Weak ADX for breakout');
    if(!(Number.isFinite(+r1) && price > +r1 * 1.002)) add('No clean close above resistance');
  } else if(nm.includes('momentum')){
    if(!(rrBull >= 1.25)) add('Momentum RR below 1.25');
    if(adxVal && adxVal < 18) add('Weak ADX for momentum');
    if(distE20 > 7) add('Momentum entry late');
    if(!(rsi >= 55 && rsi <= 72)) add('RSI outside healthy momentum zone');
  }

  const gatePassed = reasons.length === 0;
  const score = Math.round(+obj.score || 0);
  return {
    ...obj,
    score,
    readyGate: {passed: gatePassed, reasons, label: gatePassed ? 'PASSED' : 'FAILED'},
    active: !!obj.active && gatePassed,
    action: gatePassed ? obj.action : (score >= 70 ? 'WAIT' : obj.action)
  };
}

function scoreFourStrategiesS(ctx) {
  /* Each setup is judged with ITS OWN stop/target R:R (shared engine), not one generic R:R. */
  const c = name => ({ ...ctx, rrBull: ctx.rrBy && Number.isFinite(ctx.rrBy[name]) ? ctx.rrBy[name] : ctx.rrBull });
  const raw = {
    emaPullback: scoreEMASetupS(c('EMA20 Pullback')),
    ema50DeepPullback: scoreEMA50DeepPullbackS(c('EMA50 Deep Pullback')),
    supportBounce: scoreSupportBounceS(c('Support Bounce')),
    preBreakoutWatch: scorePreBreakoutS(c('Pre-Breakout Watch')),
    breakoutVolume: scoreBreakoutS(c('Breakout with Volume')),
    momentumContinuation: scoreMomentumS(c('Momentum Continuation')),
  };
  const out = {
    emaPullback: readyGateStrategyS('EMA Pullback', raw.emaPullback, c('EMA20 Pullback')),
    ema50DeepPullback: readyGateStrategyS('EMA50 Deep Pullback', raw.ema50DeepPullback, c('EMA50 Deep Pullback')),
    supportBounce: readyGateStrategyS('Support / Resistance Bounce', raw.supportBounce, c('Support Bounce')),
    preBreakoutWatch: readyGateStrategyS('Pre-Breakout Watch', raw.preBreakoutWatch, c('Pre-Breakout Watch')),
    breakoutVolume: readyGateStrategyS('Breakout with Volume', raw.breakoutVolume, c('Breakout with Volume')),
    momentumContinuation: readyGateStrategyS('Momentum Continuation', raw.momentumContinuation, c('Momentum Continuation')),
  };
  /* Main screener best setup now includes the missing swing styles:
     pullback/bounce, pre-breakout watch, breakout with volume, and momentum continuation. */
  const priority = [out.emaPullback, out.ema50DeepPullback, out.supportBounce, out.preBreakoutWatch, out.breakoutVolume, out.momentumContinuation].filter(Boolean);
  const sorter = (a,b) => {
    const ap = a.active ? 1 : 0, bp = b.active ? 1 : 0;
    if(ap !== bp) return bp - ap;
    const ad = Number.isFinite(+a.distancePct) ? +a.distancePct : 999;
    const bd = Number.isFinite(+b.distancePct) ? +b.distancePct : 999;
    if(Math.abs(ad-bd) > 0.15) return ad - bd;
    return (+b.score || 0) - (+a.score || 0);
  };
  const best = priority.slice().sort(sorter)[0];
  return { ...out, best };
}

function qualifiedMetricsS({C,H,L,V,weekly,marketCapCr,prevIdx}){
  const n=C.length, price=C[n-1], prev=C[n-2]||price;
  const e20=emaS(C,20), e50=emaS(C,50), e200=emaS(C,200);
  const dma50=dmaS(C,50), dma200=dmaS(C,200);
  const rsi=rsiS(C), macd=macdS(C), adx=calcAdxS(C,H,L);
  /* Use completed candles for the baseline. Including today's volume inside
     the 20D/3D average made the server screener disagree with the Overview tab. */
  const volEnd = Math.max(0, Math.min(V.length, n) - 1);
  const volBase20 = V.slice(Math.max(0, volEnd - 20), volEnd);
  const volBase3  = V.slice(Math.max(0, volEnd - 3),  volEnd);
  const avgVol=volBase20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase20.length);
  const avgVol3=volBase3.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase3.length);
  const volRatio=avgVol?(Number(V[n-1])||0)/avgVol:1;
  const volBlend=(volRatio||0)*0.6 + ((avgVol&&volBase3.length?avgVol3/avgVol:volRatio)||0)*0.4;
  const ph=H[n-2]||H[n-1], pl=L[n-2]||L[n-1], pc=C[n-2]||C[n-1];
  const pp=(ph+pl+pc)/3;
  /* Levels from the shared engine (same completed-session S/R as the Overview). */
  const spSr = SwingPlan.srLevels({ H, L, C, i: Number.isInteger(prevIdx) ? prevIdx : n - 2, price });
  const {r1, s1, r2, s2} = spSr;
  const weekChg=n>6?+((price-C[n-6])/C[n-6]*100).toFixed(2):0;
  const monthChg=n>23?+((price-C[n-23])/C[n-23]*100).toFixed(2):0;

  const emaBull=price>e20 && e20>e50 && e50>e200;
  const emaBullBase=price>e50 && e50>e200;
  /* Choppy (inside the 7-day range, RSI 42-58, ADX under 16) is Sideways - the Overview's rule, so the screener no
     longer lists a stock the Overview calls Sideways (IPCALAB, 4 Nov 2026). */
  const choppy = SwingPlan.isChoppy({ price, r1, s1, rsi, adx });
  const bias=choppy ? 'Sideways' : emaBullBase ? 'Bullish' : (price<e50 && e50<e200 ? 'Bearish' : 'Sideways');
  const atr=atrS(C,H,L,14);
  /* Setup choice, stop, target and current-price R:R from the shared engine - identical to the Overview plan. */
  const spAtr = SwingPlan.atrWilder(C, H, L, price, spSr.r1, spSr.s1);
  const spCards = SwingPlan.longSetups({ price, e20, e50, sr: spSr, atr: spAtr });
  const pv = SwingPlan.pullbackVolume(V, C);
  const rrBy = {}; SETUP_NAMES.forEach(k => { rrBy[k] = SwingPlan.setupRR(k, price, spCards[k]); });
  const picked = bias === 'Bullish' ? SwingPlan.pickLongSetup({ price, e20, e50, e200, sr: spSr, rsi, macd, adx, volBlend, C, L, rrOf: k => rrBy[k] }) : null;
  const rrBull = picked ? rrBy[picked] : 0;
  const rrInfo = picked
    ? { rr: rrBull, stop: spCards[picked].stop, target: spCards[picked].target, stopAtr: spAtr ? +((price - spCards[picked].stop) / spAtr).toFixed(2) : null }
    : { rr: 0, stop: null, target: null, stopAtr: null };
  const nearRes=r1 && Math.abs(price-r1)/price*100<0.75;

  let trendPts=6;
  if(emaBull) trendPts=20;
  else if(emaBullBase) trendPts=16;
  else if(price>e50) trendPts=11;
  else if(price<e50 && e50<e200) trendPts=9;

  let setup='No Clear Setup', setupPts=5;
  const distE20=e20?Math.abs(price-e20)/e20*100:99;
  const distE50=e50?Math.abs(price-e50)/e50*100:99;
  const macdBull=!!(macd && macd.macd>macd.signal && macd.hist>0);
  const strategyScores = scoreFourStrategiesS({price,e20,e50,e200,rsi,adx,volBlend,rrBull,rrBy,pv,macd,C,H,L,atr,r1,r2,s1,s2});
  if(bias==='Bullish'){
    const candidates = [
      {obj:strategyScores.emaPullback, min:70, ready:80, confirmPts:22, readyPts:25},
      {obj:strategyScores.ema50DeepPullback, min:70, ready:80, confirmPts:21, readyPts:24},
      {obj:strategyScores.supportBounce, min:70, ready:80, confirmPts:21, readyPts:24},
      {obj:strategyScores.preBreakoutWatch, min:70, ready:999, confirmPts:18, readyPts:18},
      {obj:strategyScores.breakoutVolume, min:70, ready:80, confirmPts:21, readyPts:24},
      {obj:strategyScores.momentumContinuation, min:72, ready:999, confirmPts:18, readyPts:18},
    ].filter(x => Number.isFinite(+x.obj?.score));
    const active = candidates.filter(x => x.obj?.active === true && +x.obj.score >= x.min).sort((a,b)=>+b.obj.score-+a.obj.score)[0];
    const best = strategyScores.best || {score:0,name:'Bullish Watchlist'};
    if(active){ setup=active.obj.name; setupPts=+active.obj.score>=active.ready?active.readyPts:active.confirmPts; }
    else if(best.score>=55){ setup=best.name + ' Watchlist'; setupPts=nearRes?16:15; }
    else { setup=nearRes?'Pre-Breakout Watchlist':'Bullish Watchlist'; setupPts=nearRes?14:13; }
  }

  const currentCandleBullish = price >= prev;
  const highSellingVolume = price < prev && volBlend >= 1.10;
  let volumePts = currentCandleBullish
    ? (volBlend>=1.25?10:volBlend>=1.0?8:volBlend>=0.75?5:3)
    : (highSellingVolume ? 2 : (volBlend>=0.75?4:3));
  const marketPts=8; // server scan has no live A/D/sector context; neutral only, never bullish credit
  let rrPts=rrBull>=2?20:rrBull>=1.5?17:rrBull>=1.25?14:rrBull>=1?9:rrBull>0?4:2;
  if(rrBull>0 && rrInfo.stopAtr && rrInfo.stopAtr<0.75) rrPts-=3;
  if(rrBull>0 && rrInfo.stopAtr && rrInfo.stopAtr>3.5) rrPts-=2;
  rrPts=Math.max(0,rrPts);

  const warnings=[];
  if(rsi>72) warnings.push('RSI overbought');
  if(e20 && Math.abs(price-e20)/e20*100>8) warnings.push('Late entry risk');
  if(volBlend<0.7) warnings.push('Weak volume');
  if(highSellingVolume) warnings.push('High selling volume');
  if(nearRes) warnings.push('Near resistance');
  const riskPts=6; // no server-side news/result calendar: neutral, not safe/full credit

  const decisionScore=Math.round(trendPts+setupPts+volumePts+marketPts+rrPts+riskPts);
  /* Pullback that only misses on price: the buy-limit where R:R reaches 1.25, and the score it would have
     there (only the R:R points change - same scale as above). */
  const limit = picked ? SwingPlan.limitEntry(picked, price, spCards[picked]) : null;
  const rrPtsOf = r => r>=2?20:r>=1.5?17:r>=1.25?14:r>=1?9:r>0?4:2;
  const decisionScoreAtLimit = limit ? decisionScore - rrPts + rrPtsOf(limit.rr) : null;
  const score10=clampNum(Math.round(decisionScore/10),1,10);
  const grade=decisionScore>=80?'A+':decisionScore>=70?'A':decisionScore>=55?'B':decisionScore>=40?'C':'Avoid';
  const swingQuality=decisionScore;
  const finalQualification=decisionScore;
  const validityScore=decisionScore; // kept only for old local cache compatibility
  const dailyRec=recommendationValueS(C,H,L,V), weeklyRec=dailyRec;
  const rows=[sigEmaClass(price,e20,e50,e200), sigVolClass(V[n-1]||0,avgVol,price-prev), sigRsiClass(rsi), sigMacdClass(macd), sigAdxClass(adx)];
  const bullCt=rows.filter(r=>sigClassScore(r.c)>0).length;
  const bearCt=rows.filter(r=>sigClassScore(r.c)<0).length;
  return {price,e20,e50,e200,dma50,dma200,rsi,macd,adx,volRatio:volBlend,rawVolRatio:volRatio,rrBull,dailyRec,weeklyRec,score10,bullCt,bearCt,bias,validityScore,swingQuality,finalQualification,decisionScore,grade,setup,strategyScores,weekChg,monthChg,marketCapCr,atr,r1,s1,rrStop:rrInfo.stop,rrTarget:rrInfo.target,picked,rrBy,pv,plan:picked?spCards[picked]:null,limit,decisionScoreAtLimit,currentCandleBullish,highSellingVolume,priceChangePct:prev?+(((price-prev)/prev)*100).toFixed(2):0};
}





/* ── /api/my-trade-screener — ONE eligible large-cap scan, TWO SEPARATE SCREENS
   Screener 1: Screener Match = pre-filter READY candidates only.
   Screener 2: Need Confirmation = near-ready names only, never buy-now.
   A symbol can be in only one screen. Ready wins; confirmation screen excludes all Screener Match symbols.
   No second Yahoo scan is needed for the confirmation screen. */
let MY_TRADE_SCREENER_CACHE = null, MY_TRADE_SCREENER_TS = 0;
const MY_TRADE_SCREENER_TTL = 30 * 60 * 1000; /* 30 min server cache to reduce Yahoo load */

function softScreenerGateReasonsS(reasons) {
  /* Final alignment fix: Screener Match must not be presented as final trade confirmation.
     Earlier versions ignored RSI/ADX/late-entry warnings here, so Screener could show READY
     while Overview showed CONFIRM/WAIT. Now every selected-strategy gate reason blocks READY. */
  return (reasons || []).filter(Boolean);
}

/* Setups that can be shown and alerted on, but are never a READY (buy-now) signal. */
const WATCH_ONLY_SETUPS = new Set(['Pre-Breakout Watch', 'Momentum Continuation', 'Breakout with Volume']);   /* = SwingPlan.WATCH_ONLY */
/* Same wording as the Overview's Ready Gate. */
const NIFTY_TREND_WHY = 'Nifty not in an uptrend (needs Nifty above its EMA50 and EMA20 above EMA50) - no fresh swing longs';
/* Daily bars that are complete: today's bar is still forming between 09:15 and 15:35 IST (same rule as the
   Overview's getConfirmedDailyIndex). */
function completedLenS(T) {
  const n = (T || []).length; if (!n) return 0;
  const { m, key } = istNowParts();
  return istDateKeyS(T[n - 1]) === key && m >= 9 * 60 + 15 && m < 15 * 60 + 35 ? n - 1 : n;
}
function selectedFromStrategyS(x) {
  const reasons = x?.readyGate?.reasons || [];
  return { name: x.name, score: Math.round(+x.score || 0), action: WATCH_ONLY_SETUPS.has(x.name) ? 'WATCH' : (x.readyGate?.passed ? (x.action === 'READY' || +x.score >= 80 ? 'READY' : 'CONFIRM') : 'WATCH'),
    gatePassed: !!x.readyGate?.passed && Math.round(+x.score || 0) >= 70, gateReasons: reasons, hardGateReasons: reasons, softGateOnly: false };
}
function bestReadyStrategyS(strategyScores) {
  /* Screener qualification now includes pullback/bounce plus the missing swing modules:
     Pre-Breakout Watch, Breakout with Volume, and Momentum Continuation. */
  const list = [
    strategyScores?.emaPullback,
    strategyScores?.ema50DeepPullback,
    strategyScores?.supportBounce,
    strategyScores?.preBreakoutWatch,
    strategyScores?.breakoutVolume,
    strategyScores?.momentumContinuation,
  ].filter(Boolean);

  const enriched = list.map(x => {
    const reasons = x?.readyGate?.reasons || [];
    const hardReasons = softScreenerGateReasonsS(reasons);
    const score = Math.round(+x.score || 0);
    const overviewAlignedPass = Number.isFinite(score) && score >= 70 && hardReasons.length === 0;
    return {
      raw:x,
      score,
      reasons,
      hardReasons,
      overviewAlignedPass,
      distancePct:Number.isFinite(+x.distancePct) ? +x.distancePct : 999,
      rank:(overviewAlignedPass ? 1000 : 0) + score
    };
  });

  const byActiveDistanceThenScore = (a,b) => {
    if(a.overviewAlignedPass !== b.overviewAlignedPass) return (b.overviewAlignedPass?1:0) - (a.overviewAlignedPass?1:0);
    if(Math.abs(a.distancePct-b.distancePct) > 0.15) return a.distancePct-b.distancePct;
    return b.score-a.score;
  };
  const active = enriched
    .filter(x => x.overviewAlignedPass)
    .sort(byActiveDistanceThenScore)[0] || null;
  const bestWrap = active || enriched.sort(byActiveDistanceThenScore)[0] || null;
  if (!bestWrap) return null;
  const best = bestWrap.raw;
  return {
    name: best.name || 'Strategy setup',
    score: bestWrap.score,
    action: active ? (WATCH_ONLY_SETUPS.has(best.name) ? 'WATCH' : (best.action === 'READY' ? 'READY' : (bestWrap.score >= 80 ? 'READY' : 'CONFIRM'))) : 'WATCH',
    gatePassed: !!active,
    gateReasons: bestWrap.reasons,
    hardGateReasons: bestWrap.hardReasons,
    softGateOnly: !!active && bestWrap.reasons.length > 0 && bestWrap.hardReasons.length === 0
  };
}

/* The stock-level READY checks, in one place: the live scan and the backtest call this, so the backtest
   measures exactly the rules the screener applies. Results dates and the sector-strength gate are applied by
   the caller (the backtest has no historical results calendar). */
const LIMIT_FIXABLE = new Set(['RR below 1.25', 'Late from EMA20']);
function readyChecksS(m, T, C) {
  const pickedObj = m.picked ? m.strategyScores[SETUP_KEY[m.picked]] : null;
  const selected = pickedObj ? selectedFromStrategyS(pickedObj) : bestReadyStrategyS(m.strategyScores);
  const wk = SwingPlan.weeklyTrend(T, C);
  const weeklyOk = !wk || wk.up;   /* weekly close above a rising 20-week EMA */
  const volOk = m.picked ? SwingPlan.setupVolumeOk(m.picked, m.volRatio, m.pv) : false;   /* pullback: bounce-day volume; breakout: 1.1x */
  const baseTrendOk = !!(m.price > m.e200 && m.e50 > m.e200);
  const readyCore = !!(baseTrendOk && m.picked && !SwingPlan.WATCH_ONLY.has(m.picked) &&
    selected && selected.gatePassed && selected.score >= 70 && m.decisionScore >= 70 && m.rrBull >= 1.25 &&
    volOk && !m.highSellingVolume && weeklyOk);
  /* Ready on limit: a pullback that fails only on price (R:R, late from EMA20); everything else as READY. */
  const limitCore = !!(m.limit && !readyCore && baseTrendOk && selected && selected.score >= 70 &&
    (selected.gateReasons || []).length && (selected.gateReasons || []).every(r => LIMIT_FIXABLE.has(r)) &&
    m.decisionScoreAtLimit >= 70 && volOk && !m.highSellingVolume && weeklyOk);
  return { selected, wk, weeklyOk, volOk, baseTrendOk, readyCore, limitCore };
}

function watchReasonS({m, selected, emaGap, resistanceRoom, slRisk}) {
  const reasons = [];
  if (!selected || selected.score < 70) reasons.push('Needs stronger setup score');
  if (selected?.name === 'Pre-Breakout Watch') reasons.push('Buy only after close above resistance with volume');
  if (selected?.name === 'Momentum Continuation') reasons.push('Momentum is watch-only: wait for an EMA20 pullback or a fresh breakout');
  if (selected && !selected.gatePassed) reasons.push((selected.gateReasons || [])[0] || 'Ready gate not passed');
  if (m.volRatio < 0.8) reasons.push('Needs volume');
  if (m.rrBull < 1.25 && !reasons.some(r => /^RR /i.test(r))) reasons.push('RR not enough');
  if (emaGap > 8) reasons.push('Entry late from EMA20');
  if (emaGap < -2) reasons.push('Below EMA20');
  if (Number.isFinite(resistanceRoom) && resistanceRoom < 2) reasons.push('Too close to resistance');
  if (Number.isFinite(slRisk) && slRisk > 8) reasons.push('SL risk high');
  if (m.rsi < 48) reasons.push('RSI still weak');
  return reasons.slice(0,3).join(' · ') || 'Near-ready watchlist candidate';
}

function screenerCardPayloadS({ticker, m, selected, status, reason, rankScore, emaGap, resistanceRoom, slRisk}) {
  const sym = ticker.replace(/\.(NS|BO)$/,''); /* .BO trusts are opened as NSE:SYM (mapped back to .BO) */
  const isReady = status === 'READY';
  const action = isReady ? selected.action : 'CONFIRM';
  return {
    ticker, sym,
    screenerNo: isReady ? 1 : 2,
    screenerName: isReady ? 'Screener Match' : 'Watchlist',
    confirmationRequired: !isReady,
    duplicatePolicy: 'Screener Match symbols are excluded from Watchlist',
    marketCapCr: m.marketCapCr,
    price:+m.price.toFixed(2),
    selectedStrategy:selected?.name || m.setup || 'Bullish Setup',
    selectedStrategyScore:selected?.score || Math.round(+m.finalQualification || 0),
    selectedAction: action,
    tradeStatus: status,
    watchReason: reason || '',
    confirmationNeeded: !isReady ? (reason || 'Needs one more confirmation before entry') : '',
    score10:m.score10,
    finalQualification:m.finalQualification,
    decisionScore:m.decisionScore,
    swingQuality:m.swingQuality,
    validityScore:m.validityScore,
    grade:m.grade,
    setup:selected?.name || m.setup,
    bias:m.bias,
    isStrictQualified: status === 'READY',
    readyGate: selected?.gatePassed ? 'PASS' : 'FAIL',
    readyGateReasons: selected?.gateReasons || [],
    hardGateReasons: selected?.hardGateReasons || [],
    softGateOnly: !!selected?.softGateOnly,
    strategyScores:m.strategyScores,
    emaPullScore:Math.round(+(m.strategyScores?.emaPullback?.score || 0)),
    ema50DeepScore:Math.round(+(m.strategyScores?.ema50DeepPullback?.score || 0)),
    srBounceScore:Math.round(+(m.strategyScores?.supportBounce?.score || 0)),
    rsi:m.rsi?+m.rsi.toFixed(1):null,
    macd:m.macd?+m.macd.macd.toFixed(3):null,
    macdHist:m.macd?+m.macd.hist.toFixed(3):null,
    volPressure:+m.volRatio.toFixed(2),
    currentCandleBullish:!!m.currentCandleBullish,
    highSellingVolume:!!m.highSellingVolume,
    priceChangePct:Number.isFinite(+m.priceChangePct)?+m.priceChangePct:null,
    rr:+m.rrBull.toFixed(2),
    weekChg:m.weekChg,
    monthChg:m.monthChg,
    dma50:m.dma50?+m.dma50.toFixed(2):null,
    dma200:m.dma200?+m.dma200.toFixed(2):null,
    e20:m.e20?+m.e20.toFixed(2):null,
    e50:m.e50?+m.e50.toFixed(2):null,
    e200:m.e200?+m.e200.toFixed(2):null,
    adx:m.adx?+Number(m.adx.adx || m.adx).toFixed(2):null,
    emaGap:+emaGap.toFixed(2),
    resistanceRoom:Number.isFinite(resistanceRoom)?+resistanceRoom.toFixed(2):null,
    slRisk:Number.isFinite(slRisk)?+slRisk.toFixed(2):null,
    rankScore:+rankScore.toFixed(2),
    checklist: {
      bias: {
        label: 'Bias',
        value: m.bias,
        pass: m.bias === 'Bullish',
        rule: 'Bullish only: price above EMA50 and EMA50 above EMA200'
      },
      setup: {
        label: 'Setup',
        value: selected?.name || m.setup || 'No selected setup',
        pass: !!selected && selected.score >= (status === 'READY' ? 70 : 55),
        rule: 'Only EMA20 Pullback, EMA50 Deep Pullback, or Support Bounce'
      },
      finalAction: {
        label: 'Final Action',
        value: status === 'READY' ? 'BUY candidate' : 'WAIT / watch only',
        pass: status === 'READY',
        rule: 'Ready requires RR≥1.25 and volume≥0.8x'
      },
      entryStatus: {
        label: 'Entry Status',
        value: status === 'READY' ? 'Fresh entry score passed' : (reason || 'Near-ready only'),
        pass: status === 'READY',
        rule: 'Strategy score ≥70 for Ready; ≥55 can enter Watchlist'
      },
      readyGate: {
        label: 'Ready Gate',
        value: selected?.gatePassed ? 'PASS' : 'FAIL',
        pass: !!selected?.gatePassed,
        rule: 'Hard setup gate from the selected strategy'
      }
    }
  };
}

/* ══════════════════════════════════════════════════════════════════
   BACKTEST - the screener's own READY / Ready-on-limit rules (readyChecksS) replayed day by day over the last
   ~15 months of the current universe, on the same 2-year daily candles the scan uses (chart cache, so a scan
   just before costs no extra Yahoo calls).
   Trade rules: signal at a day's close; READY buys the next open; Ready-on-limit buys if the next 3 days trade
   down to the limit. Exit at the setup's SL or T1, or at the close of day 10. A day that touches both SL and T1
   counts as a stop (conservative). One open trade per stock. R = result / (entry - SL). No charges.
   Not replayed: results-date blocks and the sector part of the strength gate (no history for them); the
   relative-strength part (beats Nifty over 3 months) is applied.
══════════════════════════════════════════════════════════════════ */
const BACKTEST_FILE = require('path').join(__dirname, 'data', 'backtest.json');   /* fs / path are declared further down */
let BACKTEST_CACHE = null, BACKTEST_INFLIGHT = null;
try { BACKTEST_CACHE = JSON.parse(require('fs').readFileSync(BACKTEST_FILE, 'utf8')); } catch {}
function simulateTradeS(bars, i0, entry, stop, target, maxDays = 10) {
  const { O, H, L, C } = bars, risk = entry - stop;
  if (!(risk > 0) || !(target > entry)) return null;
  for (let j = i0, d = 1; j < C.length && d <= maxDays; j++, d++) {
    const o = j === i0 ? entry : O[j];
    if (L[j] <= stop) { const px = Math.min(o, stop); return { exit: px, r: (px - entry) / risk, days: d, how: 'SL', exitIdx: j }; }
    if (H[j] >= target) { const px = Math.max(o, target); return { exit: px, r: (px - entry) / risk, days: d, how: 'T1', exitIdx: j }; }
    if (d === maxDays) return { exit: C[j], r: (C[j] - entry) / risk, days: d, how: 'Time', exitIdx: j };
  }
  return null;   /* still open at the end of the data */
}
async function runBacktestS() {
  const started = Date.now();
  const universe = screenerEligibleUniverseS();
  const niftyRaw = await safeFetch(() => yfChart('^NSEI', '1d', '2y'), 1);
  const nifty = niftyRaw ? parseBars(niftyRaw) : null;
  if (nifty) { const cl = completedLenS(nifty.T); if (cl < nifty.T.length) ['T', 'O', 'H', 'L', 'C', 'V'].forEach(k => { nifty[k] = nifty[k].slice(0, cl); }); }
  const niftyByT = nifty ? new Map(nifty.T.map((t, k) => [istDateKeyS(t), k])) : new Map();
  /* Nifty trend (READY gate) and 200-day average (Quick Bounce) for every date, as the live scan uses them. */
  const nEma = p => { if (!nifty) return []; const k = 2 / (p + 1), o = []; nifty.C.forEach((v, i) => o.push(i ? v * k + o[i - 1] * (1 - k) : v)); return o; };
  const nE20 = nEma(20), nE50 = nEma(50);
  const nUp = k => k != null && nifty.C[k] > nE50[k] && nE20[k] > nE50[k];
  const nAbove200 = k => k != null && k >= 199 && nifty.C[k] > nifty.C.slice(k - 199, k + 1).reduce((a, b) => a + b, 0) / 200;
  const trades = [];
  let stocks = 0;
  for (const ticker of universe) {
    let raw = null;
    try { raw = await withTimeout(safeFetch(() => yfChart(ticker, '1d', '2y'), 1), 20000, ticker + ' backtest'); } catch {}
    const bars = raw ? parseBars(raw) : null;
    if (bars) { const cl = completedLenS(bars.T); if (cl < bars.T.length) ['T', 'O', 'H', 'L', 'C', 'V'].forEach(k => { bars[k] = bars[k].slice(0, cl); }); }
    if (!bars || bars.C.length < 320) continue;
    stocks++;
    let busyUntil = -1;
    const n = bars.C.length;
    for (let i = 250; i < n - 1; i++) {
      if (i <= busyUntil) continue;
      const sl = k => bars[k].slice(0, i + 1);
      const C = sl('C'), H = sl('H'), L = sl('L'), V = sl('V'), T = sl('T');
      const nk = niftyByT.get(istDateKeyS(T[T.length - 1]));
      /* Quick Bounce (RSI-2): signal at the close, buy the next open, sell at the first close above the 5-day
         average or day 10, stop 2.5 ATR under the signal close. */
      const qb = SwingPlan.quickBounce({ C, H, L });
      if (qb?.ok && nifty && nAbove200(nk)) {
        const entry = bars.O[i + 1];
        if (entry > qb.stop) {
          let t = null;
          for (let j = i + 1, d = 1; j < n && d <= 10; j++, d++) {
            const o = j === i + 1 ? entry : bars.O[j];
            if (bars.L[j] <= qb.stop) { const px = Math.min(o, qb.stop); t = { exit: px, days: d, how: 'SL', exitIdx: j }; break; }
            const s5 = bars.C.slice(j - 4, j + 1).reduce((a, b) => a + b, 0) / 5;
            if (bars.C[j] > s5 || d === 10) { t = { exit: bars.C[j], days: d, how: bars.C[j] > s5 ? 'SMA5' : 'Time', exitIdx: j }; break; }
          }
          if (t) {
            const risk = entry - qb.stop;
            trades.push({ sym: ticker.replace(/\.(NS|BO)$/, ''), date: istDateKeyS(T[T.length - 1]), setup: 'Quick Bounce (RSI-2)', kind: 'Quick',
              r: +((t.exit - entry) / risk).toFixed(2), days: t.days, how: t.how, entry: +entry.toFixed(2), entryDate: istDateKeyS(bars.T[i + 1]),
              stop: qb.stop, target: null, exit: +t.exit.toFixed(2), exitDate: istDateKeyS(bars.T[t.exitIdx]) });
            busyUntil = t.exitIdx;
            continue;
          }
        }
      }
      const m = qualifiedMetricsS({ C, H, L, V, weekly: null, marketCapCr: null, prevIdx: i - 1 });
      if (m.bias !== 'Bullish' || !m.picked) continue;
      const chk = readyChecksS(m, T, C);
      if (!chk.readyCore && !chk.limitCore) continue;
      if (nifty && !nUp(nk)) continue;   /* Nifty trend gate, as the live scan */
      if (nifty) {   /* relative strength (3 months) as the strength gate's measurable half */
        const ni = nk;
        const rs = ni != null ? SwingPlan.relStrength(C, nifty.C.slice(0, ni + 1)) : null;
        if (rs && Number.isFinite(rs.rs3m) && rs.rs3m <= 0) continue;
      }
      const date = istDateKeyS(T[T.length - 1]), plan = m.plan;
      let t = null, kind, entryPx = null, entryIdx = null;
      if (chk.readyCore) {
        kind = 'READY';
        const entry = bars.O[i + 1];
        if (entry > plan.stop && entry < plan.target) { t = simulateTradeS(bars, i + 1, entry, plan.stop, plan.target); entryPx = entry; entryIdx = i + 1; }
      } else {
        kind = 'Limit';
        for (let j = i + 1; j <= Math.min(n - 1, i + 3); j++) {
          if (bars.L[j] <= m.limit.price) { const fill = Math.min(bars.O[j], m.limit.price); if (fill > plan.stop) { t = simulateTradeS(bars, j, fill, plan.stop, plan.target); entryPx = fill; entryIdx = j; } break; }
        }
        if (!t) continue;   /* limit never filled: no trade */
      }
      if (!t) continue;
      trades.push({ sym: ticker.replace(/\.(NS|BO)$/, ''), date, setup: m.picked, kind, r: +t.r.toFixed(2), days: t.days, how: t.how,
        entry: +entryPx.toFixed(2), entryDate: istDateKeyS(bars.T[entryIdx]), stop: plan.stop, target: plan.target, exit: +t.exit.toFixed(2), exitDate: istDateKeyS(bars.T[t.exitIdx]) });
      busyUntil = t.exitIdx;
    }
    await new Promise(r => setImmediate(r));   /* keep the server responsive */
  }
  const stat = list => {
    const wins = list.filter(t => t.r > 0), losses = list.filter(t => t.r <= 0);
    const sum = list.reduce((a, t) => a + t.r, 0);
    let streak = 0, worst = 0; list.slice().sort((a, b) => a.date < b.date ? -1 : 1).forEach(t => { streak = t.r <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); });
    return { trades: list.length, winPct: list.length ? Math.round(wins.length / list.length * 100) : null,
      avgR: list.length ? +(sum / list.length).toFixed(2) : null, totalR: +sum.toFixed(1),
      avgWinR: wins.length ? +(wins.reduce((a, t) => a + t.r, 0) / wins.length).toFixed(2) : null,
      avgLossR: losses.length ? +(losses.reduce((a, t) => a + t.r, 0) / losses.length).toFixed(2) : null,
      avgDays: list.length ? +(list.reduce((a, t) => a + t.days, 0) / list.length).toFixed(1) : null,
      byExit: { T1: list.filter(t => t.how === 'T1' || t.how === 'SMA5').length, SL: list.filter(t => t.how === 'SL').length, Time: list.filter(t => t.how === 'Time').length },   /* SMA5 = Quick Bounce's target exit */
      worstLosingStreak: worst };
  };
  const groups = {};
  trades.forEach(t => { const k = `${t.setup}${t.kind === 'Limit' ? ' (limit)' : ''}`; (groups[k] = groups[k] || []).push(t); });
  const dates = trades.map(t => t.date).sort();
  const out = { generatedAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), stocks,
    from: dates[0] || null, to: dates[dates.length - 1] || null,
    all: stat(trades), ready: stat(trades.filter(t => t.kind === 'READY')), limit: stat(trades.filter(t => t.kind === 'Limit')), quick: stat(trades.filter(t => t.kind === 'Quick')),
    bySetup: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, stat(v)]).sort((a, b) => b[1].trades - a[1].trades)),
    recent: trades.slice().sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 40),
    rules: 'Signal at the close; READY buys the next open, Ready-on-limit buys when the next 3 days reach the limit. Exit at SL, T1 or the day-10 close; SL and T1 on the same day counts as SL. Quick Bounce buys the next open and sells at the first close above the 5-day average or day 10. One trade per stock at a time. No charges (about 0.25% a round trip for delivery). Nifty trend, 3-month relative strength and breakout watch-only are replayed; results dates and sector strength are not.' };
  BACKTEST_CACHE = out;
  try { require('fs').mkdirSync(require('path').dirname(BACKTEST_FILE), { recursive: true }); require('fs').writeFileSync(BACKTEST_FILE, JSON.stringify(out)); } catch {}
  return out;
}
function istDateKeyS(unixSec) { return new Date(unixSec * 1000 + 5.5 * 3600000).toISOString().slice(0, 10); }
async function apiBacktest(req, res, p) {
  const fresh = p.get('refresh') === '1';
  if (!fresh && BACKTEST_CACHE) return send(res, { ...BACKTEST_CACHE, cached: true, ageHours: +((Date.now() - Date.parse(BACKTEST_CACHE.generatedAt)) / 3600000).toFixed(1) });
  if (!fresh) return send(res, { none: true });
  if (!BACKTEST_INFLIGHT) BACKTEST_INFLIGHT = runBacktestS().finally(() => { BACKTEST_INFLIGHT = null; });
  try { send(res, await BACKTEST_INFLIGHT); } catch (e) { err(res, 'Backtest failed: ' + e.message); }
}

/* ── Nifty market regime ──
   Swing longs work best when the index trend supports them. READY is allowed only while Nifty holds
   above its EMA50; below EMA50 every candidate is shown as Watchlist with the regime as the reason.
   If Nifty data cannot be loaded the filter is skipped (and says so) rather than blocking everything. */
let NIFTY_REGIME_CACHE = null, NIFTY_REGIME_TS = 0, NIFTY_CLOSES = null;
/* Breadth = % of the scanned universe trading above its 50-day average (updated by every screener scan). */
let LAST_BREADTH = null; /* {pct, above, total, ts} */
/* Sector strength from the last screener scan: average 1-month return of the universe stocks in each sector
   (3+ stocks). {ts, map:{sector:{rank, ret, of, n}}}. Used by the Ready Gate (Overview and screener). */
let LAST_SECTOR_STRENGTH = null;
function sectorStrengthFor(code) {
  const sec = sectorInfoFor(code)?.sector, sp = sec && LAST_SECTOR_STRENGTH?.map?.[sec];
  return sp ? { sector: sec, ret1m: sp.ret, rank: sp.rank, of: sp.of, n: sp.n, at: new Date(LAST_SECTOR_STRENGTH.ts).toISOString() } : (sec ? { sector: sec, ret1m: null } : null);
}
/* Market regime from index trend AND breadth:
   - Nifty above EMA50 with breadth >= 40%  -> longs allowed (BULL if breadth >= 55% and Nifty above EMA20)
   - Nifty above EMA50 but breadth < 40%    -> NARROW: index held up by a few stocks, no fresh longs
   - Nifty below EMA50 but breadth >= 60%   -> RECOVERY: broad strength returning, longs allowed
   - otherwise                              -> CORRECTION / BEAR, no fresh longs
   Without a recent breadth reading the Nifty-only rule is used. */
function marketRegime(nifty) {
  const b = LAST_BREADTH && Date.now() - LAST_BREADTH.ts < 18 * 3600e3 ? LAST_BREADTH : null; /* breadth only changes in market hours */
  if (!nifty || nifty.status === 'UNKNOWN') return { ...(nifty || {}), status:'UNKNOWN', allowReady:true, breadth: b, note:'Nifty data unavailable - regime filter skipped; check the market manually' };
  const above50 = nifty.nifty > nifty.ema50, above200 = nifty.nifty > nifty.ema200;
  if (!b) return { ...nifty, breadth:null, note: nifty.note + ' (breadth not measured yet - run a screener scan)' };
  const pct = b.pct;
  let status, allowReady, note;
  if (above50 && pct >= 40) { status = pct >= 55 && nifty.nifty >= nifty.ema20 ? 'BULL' : 'CAUTION'; allowReady = true; note = `Nifty above EMA50 and ${pct}% of stocks above their 50-DMA - fresh swing longs allowed${status === 'CAUTION' ? ' (smaller size)' : ''}`; }
  else if (above50) { status = 'NARROW'; allowReady = false; note = `Nifty above EMA50 but only ${pct}% of stocks above their 50-DMA - narrow market, no fresh longs`; }
  else if (pct >= 60) { status = 'RECOVERY'; allowReady = true; note = `Nifty below EMA50 but ${pct}% of stocks above their 50-DMA - broad recovery, longs allowed with smaller size`; }
  else { status = above200 ? 'CORRECTION' : 'BEAR'; allowReady = false; note = `Nifty below EMA50 and ${pct}% of stocks above their 50-DMA - no fresh swing longs`; }
  return { ...nifty, status, allowReady, breadth: b, note };
}
async function getNiftyRegime() {
  if (NIFTY_REGIME_CACHE && Date.now() - NIFTY_REGIME_TS < 10 * 60 * 1000) return NIFTY_REGIME_CACHE;
  try {
    const raw = await withTimeout(safeFetch(() => yfChart('^NSEI', '1d', '2y'), 1), 8000, 'Nifty regime');
    const d = enrichDailyForLiveScreenerS(parseBars(raw), raw?.meta || {});
    const C = d.C, n = C.length;
    if (n < 200) throw new Error('short Nifty history');
    const price = C[n-1], e20 = emaS(C, 20), e50 = emaS(C, 50), e200 = emaS(C, 200);
    let status, allowReady, note;
    if (price > e50 && e50 > e200 && price >= e20) { status = 'BULL'; allowReady = true; note = 'Nifty above EMA20/50/200 - fresh swing longs allowed'; }
    else if (price > e50) { status = 'CAUTION'; allowReady = true; note = 'Nifty above EMA50 but losing momentum - longs allowed, use smaller size'; }
    else if (price > e200) { status = 'CORRECTION'; allowReady = false; note = 'Nifty below EMA50 - no fresh swing longs; candidates shown as Watchlist'; }
    else { status = 'BEAR'; allowReady = false; note = 'Nifty below EMA200 - downtrend; no fresh swing longs'; }
    /* trendUp: the READY gate (backtest 7 Nov 2026 - pullbacks went from break-even to +0.3% a trade with it).
       aboveSma200: the Quick Bounce (RSI-2) market filter. */
    const sma200 = C.slice(n - 200).reduce((a, b) => a + b, 0) / 200;
    NIFTY_REGIME_CACHE = { status, allowReady, nifty:+price.toFixed(2), ema20:+e20.toFixed(2), ema50:+e50.toFixed(2), ema200:+e200.toFixed(2), note,
      trendUp: price > e50 && e20 > e50, sma200: +sma200.toFixed(2), aboveSma200: price > sma200 };
    NIFTY_CLOSES = C.slice();
    NIFTY_REGIME_TS = Date.now();
    return NIFTY_REGIME_CACHE;
  } catch (er) {
    console.warn('Nifty regime fetch failed:', er.message);
    return { status:'UNKNOWN', allowReady:true, nifty:null, ema20:null, ema50:null, ema200:null, trendUp:null, sma200:null, aboveSma200:null, note:'Nifty data unavailable - regime filter skipped; check the market trend manually' };
  }
}

/* ── Results (earnings) calendar ──
   NSE's corporate event calendar lists board meetings for financial results. A stock with results today or
   within the next 5 trading days is not a fresh swing entry (gap risk). The manual EARNINGS_DATES list is
   merged in. If NSE cannot be reached (it sometimes blocks cloud hosts) nothing is blocked and the
   response says the check was unavailable. Exchange holidays are not excluded from the trading-day count. */
const RESULTS_BLOCK_TRADING_DAYS = 5;
let RESULTS_CAL_CACHE = null, RESULTS_CAL_TS = 0;
/* Last successful NSE results list ({ts, rows:[[sym, date, purpose]]}), also saved to disk. A failed fetch used
   to replace the calendar with the manual list only, so a stock reporting in 3 days showed READY in that scan. */
let RESULTS_CAL_LAST_GOOD = null;
function nseDateParam(ms) {
  const d = new Date(ms + 330 * 60000);
  return `${String(d.getUTCDate()).padStart(2,'0')}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${d.getUTCFullYear()}`;
}
function parseNseDateKey(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const mon = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(m[2].toLowerCase()) + 1;
  return mon ? `${m[3]}-${String(mon).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}` : null;
}
function tradingDaysUntil(fromKey, toKey) {
  /* Weekdays strictly after fromKey up to and including toKey (0 = today). Negative when toKey is past. */
  if (toKey === fromKey) return 0;
  const step = toKey > fromKey ? 1 : -1;
  let d = Date.parse(fromKey + 'T00:00:00Z'), count = 0;
  const end = Date.parse(toKey + 'T00:00:00Z');
  while ((step > 0 && d < end) || (step < 0 && d > end)) {
    d += step * 86400000;
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) count += step;
  }
  /* Results on a weekend are priced in on the next session, so count that session. */
  const endDow = new Date(end).getUTCDay();
  if (step > 0 && (endDow === 0 || endDow === 6)) count += 1;
  return count;
}
let RESULTS_CAL_INFLIGHT = null;
async function getResultsCalendar() {
  if (RESULTS_CAL_CACHE && Date.now() - RESULTS_CAL_TS < 60 * 60 * 1000) return RESULTS_CAL_CACHE;
  if (RESULTS_CAL_INFLIGHT) return RESULTS_CAL_INFLIGHT;
  RESULTS_CAL_INFLIGHT = loadResultsCalendar().finally(() => { RESULTS_CAL_INFLIGHT = null; });
  return RESULTS_CAL_INFLIGHT;
}
async function loadResultsCalendar() {
  const bySym = new Map();
  const add = (sym, date, purpose) => {
    if (!sym || !date) return;
    const k = String(sym).toUpperCase();
    if (!bySym.has(k)) bySym.set(k, []);
    bySym.get(k).push({ date, purpose });
  };
  let ok = false, source = 'manual list only', error = null;
  try {
    const u = `https://www.nseindia.com/api/event-calendar?index=equities&from_date=${nseDateParam(Date.now() - 3 * 86400000)}&to_date=${nseDateParam(Date.now() + 12 * 86400000)}`;
    const hdr = { Accept:'application/json', Referer:'https://www.nseindia.com/companies-listing/corporate-filings-event-calendar', Origin:'https://www.nseindia.com' };
    /* 15 s: the time includes the wait in the NSE queue (one request at a time, 2 s apart). */
    let r = await withTimeout(get(u, hdr), 15000, 'NSE event calendar');
    if (r.status === 401 || r.status === 403) {
      /* Some hosts need NSE session cookies: take them from the event-calendar page and retry once. */
      const page = await withTimeout(getWithHeaders('https://www.nseindia.com/companies-listing/corporate-filings-event-calendar', { Accept:'text/html' }), 15000, 'NSE cookie warm-up');
      const cookie = (page.headers['set-cookie'] || []).map(c => String(c).split(';')[0]).join('; ');
      if (cookie) r = await withTimeout(get(u, { ...hdr, Cookie: cookie }), 15000, 'NSE event calendar (cookie)');
    }
    if (r.status !== 200) throw new Error('NSE HTTP ' + r.status);
    const rows = JSON.parse(r.body);
    if (!Array.isArray(rows)) throw new Error('unexpected NSE response');
    const good = [];
    rows.forEach(x => { if (/result/i.test(`${x.purpose || ''} ${x.bm_desc || ''}`)) { const d = parseNseDateKey(x.date); add(x.symbol, d, x.purpose || 'Financial Results'); good.push([x.symbol, d, x.purpose || 'Financial Results']); } });
    ok = true; source = 'NSE event calendar';
    RESULTS_CAL_LAST_GOOD = { ts: Date.now(), rows: good }; saveUniverseToDisk();
  } catch (er) {
    error = er.message; console.warn('Results calendar fetch failed:', er.message);
    /* Use the last good NSE list (up to 3 days old; it covers 12 days ahead) instead of none. */
    if (RESULTS_CAL_LAST_GOOD?.rows && Date.now() - RESULTS_CAL_LAST_GOOD.ts < 3 * 86400000) {
      RESULTS_CAL_LAST_GOOD.rows.forEach(([sym, d, p]) => add(sym, d, p));
      ok = true; source = `NSE event calendar (saved ${new Date(RESULTS_CAL_LAST_GOOD.ts).toLocaleString('en-IN', { timeZone:'Asia/Kolkata', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' })} - live fetch failed)`;
    }
  }
  EARNINGS_DATES.forEach(x => add(String(x.sym).replace('NSE:',''), x.date, 'Results (manual list)'));
  RESULTS_CAL_CACHE = { bySym, ok, source, error, fetchedAt: new Date().toISOString() };
  /* Retry a failed fetch after ~10 minutes instead of an hour. */
  RESULTS_CAL_TS = ok && !error ? Date.now() : Date.now() - 50 * 60 * 1000;   /* saved-list fallback also retries soon */
  return RESULTS_CAL_CACHE;
}
function resultsCheckFor(sym, cal, todayKey) {
  const list = cal?.bySym?.get(String(sym).toUpperCase());
  if (!list || !list.length) return null;
  const upcoming = list.filter(x => x.date >= todayKey).sort((a,b) => a.date.localeCompare(b.date))[0];
  const pick = upcoming || list.sort((a,b) => b.date.localeCompare(a.date))[0];
  const tradingDays = tradingDaysUntil(todayKey, pick.date);
  return { date: pick.date, purpose: pick.purpose, tradingDays, block: tradingDays >= 0 && tradingDays <= RESULTS_BLOCK_TRADING_DAYS, recent: tradingDays < 0 && tradingDays >= -2 };
}

let MY_TRADE_SCREENER_INFLIGHT = null;
async function apiMyTradeScreener(req, res) {
  const q = url.parse(req.url, true).query || {};
  /* A forced rescan (~250 Yahoo calls) is allowed at most every 5 minutes; inside that, the fresh result is reused. */
  const forceRefresh = (q.refresh === '1' || q.force === '1' || q.nocache === '1') && !(MY_TRADE_SCREENER_CACHE && Date.now() - MY_TRADE_SCREENER_TS < 5 * 60 * 1000);
  if (!forceRefresh && MY_TRADE_SCREENER_CACHE && Date.now() - MY_TRADE_SCREENER_TS < MY_TRADE_SCREENER_TTL) return send(res, MY_TRADE_SCREENER_CACHE);
  /* A full scan is ~150 Yahoo calls. Concurrent requests (several tabs, refresh clicks) now share the
     scan already running instead of each starting another one. */
  if (!MY_TRADE_SCREENER_INFLIGHT) {
    MY_TRADE_SCREENER_INFLIGHT = runMyTradeScreenerScan().finally(() => { MY_TRADE_SCREENER_INFLIGHT = null; });
  }
  try { send(res, await MY_TRADE_SCREENER_INFLIGHT); }
  catch (e) { err(res, e.message); }
}

/* One line: what exactly has to happen (and at what price) for this stock to become READY. */
function triggerTextS({ m, rs, rsOk, volOk, weeklyOk, wk, readyCore, selected }) {
  const f = v => Number.isFinite(+v) ? '₹' + (+v).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '--';
  if (readyCore) return 'All stock checks pass';
  const p = m.picked, plan = m.plan;
  if (!weeklyOk && wk) return wk.close <= wk.ema20 ? `Weekly close needs to get back above the 20-week EMA ${f(wk.ema20)}` : `Weekly trend needs the 10-week EMA (${f(wk.ema10)}) back above the 20-week EMA (${f(wk.ema20)})`;
  if (!p) return `No setup in play: wait for a pullback to EMA20 ${f(m.e20)} or a close above ${f(m.r1)} on 1.1x+ volume`;
  if (p === 'Pre-Breakout Watch') return `Alert: buy only on a close above ${f(plan?.entry)} with 1.1x+ volume`;
  if (p === 'Momentum Continuation') return `Alert only: wait for a pullback to EMA20 ${f(m.e20)}`;
  if (m.highSellingVolume) return 'High-volume red day: wait for the selling to stop';
  if (!volOk) {
    if (p === 'Breakout with Volume') return `Above ${f(plan?.entry)}: the close needs 1.1x+ volume (now ${(+m.volRatio || 0).toFixed(2)}x)`;
    if (m.pv?.heavyPullback) return `Heavy selling into the pullback (${m.pv.dryRatio}x): wait for volume to dry up`;
    const lvl = p === 'EMA20 Pullback' ? 'EMA20' : p === 'EMA50 Deep Pullback' ? 'EMA50' : 'support';
    return `Needs a green close above ${lvl} ${f(plan?.entry)} on 1.0x+ volume (now ${(+m.pv?.todayRatio || 0).toFixed(2)}x)`;
  }
  if (!(m.rrBull >= 1.25) && plan && Number.isFinite(+plan.stop) && Number.isFinite(+plan.target)) {
    const better = (+plan.target + 1.25 * +plan.stop) / 2.25;   /* price where R:R = 1.25 */
    return better < m.price ? `R:R ${(+m.rrBull || 0).toFixed(2)}: buy nearer ${f(better)} (R:R 1.25 there)` : `R:R ${(+m.rrBull || 0).toFixed(2)} is below 1.25`;
  }
  if (!rsOk) return `Needs to outperform Nifty (3M RS ${Number.isFinite(rs.rs3m) ? rs.rs3m + '%' : 'n/a'})`;
  const g = selected?.readyGate?.reasons?.[0];
  if (g) return g;
  if (!(m.decisionScore >= 70)) return `Score ${m.decisionScore}/100 needs 70`;
  return 'Needs one more confirmation';
}

/* Per-stock outcome of the last scan (every eligible stock, not just the top 20) - for /api/screener-diag. */
let LAST_SCAN_DIAG = { ts: 0, rows: [] };
async function runMyTradeScreenerScan() {
  const scanDiag = [], sectorRet = [];

  /* Market regime (Nifty vs EMA20/50/200) and the results calendar are loaded once per scan. */
  const [niftyTrend, resultsCal] = await Promise.all([getNiftyRegime(), getResultsCalendar()]);
  const niftyCloses = NIFTY_CLOSES;
  const todayKey = istDateKey();
  let resultsBlockedCount = 0, regimeBlockedCount = 0;

  const universe = screenerEligibleUniverseS();
  const universeInfo = universeSummary();
  const universeStatsBase = {
    universeStocks: universe.length,
    marketCapEligible: universeInfo.eligible ?? universe.length,
    marketCapRule: 'Live market cap (shares × live price) > ₹35,000Cr at scan time',
    universeSource: universeInfo.source,
    priceRule: 'Live current price > ₹10 (no upper price cap)',
    whitelistUsed: false
  };
  const startedAt = Date.now();
  const maxScanMs = 85000;
  const BATCH = 20;
  let timedOut = false;
  let scannedAttempted = 0;
  let dataOkCount = 0, aboveSma50Count = 0;
  const failedTickers = [], shortHistory = [];
  let priceEligibleCount = 0;
  let biasEligibleCount = 0;
  const ready = [];
  const watch = [];
  const quickCands = [];

  for (let i = 0; i < universe.length; i += BATCH) {
    if (Date.now() - startedAt > maxScanMs) { timedOut = true; break; }
    const batch = universe.slice(i, i + BATCH);
    scannedAttempted += batch.length;
    /* No batch-level timeout: each ticker is bounded by its own 8s timeout, and the old 10s batch
       fallback discarded every finished result in the batch when a single ticker was slow. */
    const results = await Promise.allSettled(batch.map(async ticker => {
      try {
        /* 2y so EMA200 is properly warmed up (1y left it ~60% its SMA seed). */
        /* 20 s: the polite outbound queue means a request may wait its turn before it starts. */
        const dailyRaw = await withTimeout(safeFetch(() => yfChart(ticker, '1d', '2y'), 1), 20000, ticker + ' ready/watchlist screener history');
        if (!dailyRaw) { failedTickers.push(ticker + ' (no data)'); return null; }
        const daily = enrichDailyForLiveScreenerS(parseBars(dailyRaw), dailyRaw?.meta || {});
        if (daily.n < 200) { shortHistory.push(ticker); return null; }
        dataOkCount++;
        const {C,H,L,V} = daily;
        { const sma50 = dmaS(C, 50); if (sma50 && C[C.length-1] > sma50) aboveSma50Count++; }
        const marketCapCr = screenerMcapNow(ticker, C[C.length-1]);
        const m = qualifiedMetricsS({C,H,L,V,weekly:null,marketCapCr,prevIdx:daily._prevSessionIdx});
        if (!(marketCapCr > MIN_SCREENER_MCAP_CR)) return null;
        /* No upper price cap: share price says nothing about swing quality (it excluded most Nifty heavyweights). */
        if (!(m.price > 10)) return null;
        priceEligibleCount++;
        /* Quick Bounce (RSI-2) on completed bars - independent of the swing setups below. */
        { const cl = completedLenS(daily.T); const qb = SwingPlan.quickBounce({ C: C.slice(0, cl), H: H.slice(0, cl), L: L.slice(0, cl) });
          if (qb?.ok) quickCands.push({ ticker, qb, price: +m.price.toFixed(2) }); }
        /* 1-month return for the sector-strength ranking (every eligible stock counts, not only bullish ones). */
        const secInfo = sectorInfoFor(ticker);
        if (secInfo?.sector && C.length > 22) sectorRet.push({ sector: secInfo.sector, ret: (C[C.length-1] / C[C.length-22] - 1) * 100 });
        const dg = { sym: ticker.replace(/\.(NS|BO)$/,''), price: +m.price.toFixed(2), bias: m.bias, picked: m.picked || null,
          decisionScore: m.decisionScore, rr: m.rrBull, longTrend: m.price > m.e200 && m.e50 > m.e200 };
        scanDiag.push(dg);
        if (m.bias !== 'Bullish') { dg.out = 'not bullish structure'; return null; }
        biasEligibleCount++;

        /* The setup the price is actually in (shared engine, same as the Overview); fall back to the
           best-scoring setup only to explain Watchlist candidates. */
        const chk = readyChecksS(m, daily.T, C);
        const { selected, wk, weeklyOk, volOk, baseTrendOk, readyCore } = chk;
        const rs = SwingPlan.relStrength(C, niftyCloses);
        const rsOk = Number.isFinite(rs.rs3m) && rs.rs3m > 0;
        const emaGap = m.e20 ? ((m.price - m.e20) / m.e20) * 100 : 999;
        const resistanceRoom = m.rrTarget && m.rrTarget > m.price ? ((m.rrTarget - m.price) / m.price) * 100 : null;
        const slRisk = m.rrStop && m.rrStop < m.price ? ((m.price - m.rrStop) / m.price) * 100 : null;

        const adxVal = Number(m.adx?.adx || m.adx || 0);
        const macdOk = !!(m.macd && m.macd.hist >= 0);
        const adxOk = !adxVal || adxVal >= 18;
        const rsi3Ago = rsiS(C.slice(0, Math.max(0, C.length - 3)));
        const rsiRising = Number.isFinite(m.rsi) && Number.isFinite(rsi3Ago) ? m.rsi > rsi3Ago : false;

        /* Results within 5 trading days or a weak Nifty turn an otherwise READY stock into Watchlist. */
        Object.assign(dg, { selName: selected?.name || null, selScore: selected?.score ?? null, gatePassed: !!selected?.gatePassed,
          gateReasons: selected?.gateReasons || [], limit: m.limit || null, dsLimit: m.decisionScoreAtLimit, rs3m: rs.rs3m, volOk, highSell: !!m.highSellingVolume, baseTrendOk, weeklyOk, readyCore });
        const resultsInfo = resultsCheckFor(ticker.replace(/\.(NS|BO)$/,''), resultsCal, todayKey);
        const resultsBlock = !!resultsInfo?.block;
        const regimeBlock = false; /* decided after the scan, once breadth is known */
        const readyOk = readyCore && !resultsBlock;
        if (readyCore && resultsBlock) resultsBlockedCount++;
        const extra = {
          resultsDate: resultsInfo?.date || null,
          resultsTradingDays: resultsInfo ? resultsInfo.tradingDays : null,
          resultsBlock, resultsRecent: !!resultsInfo?.recent,
          regimeBlock, readyCore,
          pickedSetup: m.picked || null,
          plan: m.plan, rs3m: rs.rs3m, rs6m: rs.rs6m, stock3m: rs.stock3m, nifty3m: rs.nifty3m,
          bounceVolume: m.pv?.todayRatio ?? null, pullbackDryUp: m.pv?.dryRatio ?? null,
          weekly: wk ? { up: wk.up, close: wk.close, ema20: wk.ema20 } : null,
          rsOk,
          trigger: triggerTextS({ m, rs, rsOk: true, volOk, weeklyOk, wk, readyCore, selected })
        };
        const blockReasons = [];
        if (resultsBlock) blockReasons.push(resultsInfo.date === todayKey ? `Results today (${resultsInfo.date})` : `Results in ${resultsInfo.tradingDays} trading day${resultsInfo.tradingDays===1?'':'s'} (${resultsInfo.date}) - avoid fresh swing entry`);

        const rankScore = (
          (selected?.score || m.finalQualification || 0) * 1.0 +
          Math.min(m.rrBull, 2.5) * 7 +
          Math.min(m.volRatio, 2.0) * 5 +
          (macdOk ? 3 : 0) + (adxOk ? 2 : 0) +
          Math.max(0, 8 - Math.abs(emaGap - 3)) * 1.5 +
          (Number.isFinite(resistanceRoom) ? Math.min(Math.max(resistanceRoom, 0), 8) * 1.2 : 0) -
          (Number.isFinite(slRisk) ? Math.max(0, slRisk - 8) * 3 : 0) +
          (Number.isFinite(rs.rs3m) ? Math.max(-10, Math.min(20, rs.rs3m)) * 0.5 : 0)   /* relative strength leaders rank higher */
        );

        if (readyOk) {
          return {...screenerCardPayloadS({ticker, m, selected, status:'READY', rankScore, emaGap, resistanceRoom, slRisk}), ...extra};
        }
        /* Ready on limit: a pullback that passes every check except price - it has run above the zone, so R:R
           from here is under 1.25 (and / or it is late from EMA20). Buying at the limit fixes exactly that; every
           other rule (trend, bounce candle, volume, weekly, results, and the strength gate after the scan)
           must pass as for READY. */
        const limitOk = chk.limitCore && !resultsBlock;
        if (limitOk) {
          const why = `Ready on limit: buy at ₹${m.limit.price} (R:R ${m.limit.rr.toFixed(2)}) - price is above the pullback zone`;
          return {...screenerCardPayloadS({ticker, m, selected, status:'WATCH', reason: why, rankScore: rankScore + 500, emaGap, resistanceRoom, slRisk}),
            ...extra, limitReady: true, limitEntry: m.limit,
            trigger: `Place a buy limit at ₹${m.limit.price}; it fills only if price comes back to the zone (${m.picked} ${m.limit.zone})` };
        }
        if (readyCore) {
          /* Passed every stock-level check; blocked only by results/regime. Keep it visible with that reason. */
          return {...screenerCardPayloadS({ticker, m, selected, status:'WATCH', reason: blockReasons.join(' · '), rankScore, emaGap, resistanceRoom, slRisk}), ...extra};
        }

        /* Watchlist = near-ready names from the same scan.
           It must NOT require Ready Gate failed only. If a stock is green in
           Overview but misses Ready screen because RR/EMA gap/volume is not
           enough, it should still appear here with the reason.
           This avoids the earlier problem where both Ready and Watchlist were empty. */
        const setupScore = Math.max(+(selected?.score || 0), +(m.finalQualification || 0));
        const watchGateClose = !!(selected && (selected.gatePassed || selected.score >= 55 || m.finalQualification >= 55));
        const ema50Gap = m.e50 ? ((m.price - m.e50) / m.e50) * 100 : 999;
        const nearUsefulZone = (emaGap >= -3 && emaGap <= 12) || (ema50Gap >= -3 && ema50Gap <= 7) || (Number.isFinite(slRisk) && slRisk <= 10);
        const watchOk = !!(
          selected && !readyOk && watchGateClose &&
          baseTrendOk &&
          m.rsi >= 45 && m.rsi <= 68 &&
          m.volRatio >= 0.8 &&
          setupScore >= 55 &&
          nearUsefulZone
        );
        if (!watchOk) return null;
        let reason = watchReasonS({m, selected, emaGap, resistanceRoom, slRisk});
        if (!weeklyOk) reason = `${wk.close <= wk.ema20 ? `Weekly close ${wk.close} below 20-week EMA ${wk.ema20}` : `Weekly trend not turned up: 10-week EMA ${wk.ema10} below 20-week EMA ${wk.ema20}`} · ${reason}`;
        if (m.picked && !volOk) { const vr = SwingPlan.setupVolumeReason(m.picked, m.volRatio, m.pv); if (vr) reason = `${vr} · ${reason}`; }
        if (selected.gatePassed && !reason.includes('RR') && !reason.includes('Entry') && !reason.includes('volume')) {
          const blockers = [];
          if (m.rrBull < 1.25) blockers.push('RR not enough');
          if (emaGap > 8) blockers.push('Entry late from EMA20');
          if (m.volRatio < 0.8) blockers.push('Needs volume');
          if (blockers.length) reason = blockers.slice(0,3).join(' · ');
        }
        if (resultsBlock) reason = `${blockReasons[0]} · ${reason}`;
        return {...screenerCardPayloadS({ticker, m, selected, status:'WATCH', reason, rankScore: rankScore - 25, emaGap, resistanceRoom, slRisk}), ...extra};
      } catch(e) { failedTickers.push(`${ticker} (${String(e && e.message || e).slice(0, 60)})`); return null; }
    }));

    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value) {
        if (r.value.tradeStatus === 'READY') ready.push(r.value);
        else watch.push(r.value);
      }
    });
    if (i + BATCH < universe.length) await new Promise(r => setTimeout(r, 250));
  }

  /* Breadth from this scan, then the market regime (Nifty trend + breadth) decides whether READY stands. */
  if (dataOkCount >= 50) { LAST_BREADTH = { pct: Math.round(aboveSma50Count / dataOkCount * 100), above: aboveSma50Count, total: dataOkCount, ts: Date.now() }; saveUniverseToDisk(); }
  const marketTrend = marketRegime(niftyTrend);
  /* Sector strength: average 1-month return of the universe stocks in each sector (3+ stocks). Leaders get a
     ranking bonus, laggards a small penalty. */
  const secAgg = {};
  sectorRet.forEach(x => { (secAgg[x.sector] = secAgg[x.sector] || []).push(x.ret); });
  const secRank = Object.entries(secAgg).filter(([, v]) => v.length >= 3)
    .map(([k, v]) => ({ sector: k, ret: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), n: v.length }))
    .sort((a, b) => b.ret - a.ret);
  const secPos = Object.fromEntries(secRank.map((x, i) => [x.sector, { rank: i + 1, ret: x.ret, of: secRank.length, n: x.n }]));
  if (secRank.length >= 5) { LAST_SECTOR_STRENGTH = { ts: Date.now(), map: secPos }; saveUniverseToDisk(); }
  /* Strength gate (replaces the Nifty-regime hold): a long passes when its sector is up over 1 month OR the
     stock beats Nifty over 3 months. A weak Nifty alone no longer holds a stock back - it only adds a
     smaller-size note. */
  const strengthWhy = x => {
    const sec = sectorInfoFor(x.sym)?.sector, sp = sec ? secPos[sec] : null;
    const secUp = sp ? sp.ret > 0 : null, rsUp = Number.isFinite(x.rs3m) ? x.rs3m > 0 : null;
    if (secUp || rsUp) return '';
    if (secUp === null && rsUp === null) return marketTrend.allowReady ? '' : `Market ${String(marketTrend.status).toLowerCase()} - ${marketTrend.note}`;
    return [sp ? `${sec} sector down ${Math.abs(sp.ret)}% in 1 month` : 'Sector strength unknown', rsUp === null ? 'RS vs Nifty unavailable' : `lagging Nifty (3M RS ${x.rs3m}%)`].join(' and ');
  };
  for (const x of ready.splice(0)) {
    if (marketTrend.trendUp === false) {
      regimeBlockedCount++;
      watch.push({ ...x, tradeStatus:'WATCH', isStrictQualified:false, regimeBlock:true, watchReason: NIFTY_TREND_WHY, confirmationNeeded: NIFTY_TREND_WHY, trigger:'Needs Nifty back above its EMA50 with EMA20 above EMA50' });
      continue;
    }
    const why = strengthWhy(x);
    if (!why) {
      if (!marketTrend.allowReady) x.marketNote = `Market ${String(marketTrend.status).toLowerCase()}: passed on sector / relative strength - use smaller size`;
      ready.push(x); continue;
    }
    regimeBlockedCount++;
    watch.push({ ...x, tradeStatus:'WATCH', isStrictQualified:false, regimeBlock:true, watchReason: why, confirmationNeeded: why, trigger: `Needs its sector up over 1 month or to outperform Nifty` });
  }
  for (const x of watch) {
    /* Ready-on-limit passes the same strength gate as READY. */
    if (x.limitReady) { const why = marketTrend.trendUp === false ? NIFTY_TREND_WHY : strengthWhy(x); if (why) { x.limitReady = false; x.rankScore -= 500; x.watchReason = `${why} · ${x.watchReason}`; x.confirmationNeeded = x.watchReason; } continue; }
    if (x.regimeBlock || x.rsOk !== false) continue;
    const why = strengthWhy(x);
    if (why) { x.watchReason = `${why} · ${x.watchReason || ''}`.replace(/ · $/, ''); x.confirmationNeeded = x.watchReason; }
  }
  ready.concat(watch).forEach(x => {
    const sec = sectorInfoFor(x.sym)?.sector, sp = sec ? secPos[sec] : null;
    if (!sp) return;
    x.sector = sec; x.sectorRank = sp.rank; x.sectorOf = sp.of; x.sectorRet1m = sp.ret;
    x.rankScore = (x.rankScore || 0) + (sp.rank <= 3 ? 6 : sp.rank <= 5 ? 4 : sp.rank > sp.of - 3 ? -4 : 0);
  });
  /* Relative-strength percentile among everything shown. */
  const rsVals = ready.concat(watch).map(x => x.rs3m).filter(Number.isFinite).sort((a,b) => a-b);
  ready.concat(watch).forEach(x => { if (Number.isFinite(x.rs3m) && rsVals.length) x.rsRank = Math.round(rsVals.filter(v => v <= x.rs3m).length / rsVals.length * 100); });
  const sortRank = (a,b)=>b.rankScore-a.rankScore;
  const allReadySorted = ready.sort(sortRank);
  const readySymsAll = new Set(allReadySorted.map(x => String(x.sym || '').toUpperCase()));
  const picks = allReadySorted.slice(0, 10).map(x => ({...x, screenerNo:1, screenerName:'Screener Match', confirmationRequired:false}));
  /* READY beyond the top 10 goes to the top of the Watchlist instead of disappearing. */
  const readyOverflow = allReadySorted.slice(10).map(x => ({...x, tradeStatus:'WATCH', isStrictQualified:false,
    watchReason:'READY - ranked below the top 10', confirmationNeeded:'READY - ranked below the top 10', rankScore:(x.rankScore || 0) + 1000}));
  const pickSyms = new Set(picks.map(x => String(x.sym || '').toUpperCase()));
  const watchlist = readyOverflow.concat(watch.filter(x => !readySymsAll.has(String(x.sym || '').toUpperCase())))
    .filter(x => !pickSyms.has(String(x.sym || '').toUpperCase()))
    .sort(sortRank)
    .slice(0, 20)
    .map(x => ({...x, screenerNo:2, screenerName:'Watchlist', confirmationRequired:true, selectedAction:'CONFIRM'}));
  /* Quick Bounce list: RSI-2 dips in large caps above their 50/200-day averages, only while Nifty is above its
     200-day average, no results within 5 trading days, not already READY. Most oversold first. */
  const niftyOk200 = marketTrend.aboveSma200 !== false;
  const quickBounce = !niftyOk200 ? [] : quickCands
    .filter(q => !readySymsAll.has(q.ticker.replace(/\.(NS|BO)$/, '').toUpperCase()))
    .map(q => {
      const sym = q.ticker.replace(/\.(NS|BO)$/, ''), ri = resultsCheckFor(sym, resultsCal, todayKey);
      const sec = sectorInfoFor(sym)?.sector || null;
      return { sym, ticker: q.ticker, price: q.price, ...q.qb, sector: sec, resultsDate: ri?.date || null, resultsBlock: !!ri?.block,
        resultsTradingDays: ri ? ri.tradingDays : null, resultsRecent: !!ri?.recent };
    })
    .filter(q => !q.resultsBlock)
    .sort((a, b) => a.rsi2 - b.rsi2).slice(0, 15);
  const quickBounceNote = !niftyOk200 ? `Quick Bounce paused: Nifty is below its 200-day average (${marketTrend.sma200})` : '';
  LAST_SCAN_DIAG = { ts: Date.now(), rows: scanDiag };
  const result = {
    picks,
    watchlist,
    quickBounce,
    quickBounceNote,
    screen1: picks,
    screen2: watchlist,
    duplicateCheck: {readySymbols: readySymsAll.size, watchlistExcludesAllReady: true},
    scanned: universe.length,
    scannedAttempted,
    partial: timedOut,
    passed: picks.length,
    readyCount: picks.length,
    watchCount: watchlist.length,
    confirmationCount: watchlist.length,
    strictQualified: picks.length,
    marketTrend,
    universe: universeInfo,
    resultsCalendar: { source: resultsCal.source, ok: resultsCal.ok, error: resultsCal.error, fetchedAt: resultsCal.fetchedAt,
      blockWindowTradingDays: RESULTS_BLOCK_TRADING_DAYS, readyBlockedByResults: resultsBlockedCount, readyBlockedByRegime: regimeBlockedCount },
    universeStats: {
      ...universeStatsBase,
      attempted: scannedAttempted,
      dataOk: dataOkCount,
      dataFailed: failedTickers.length,
      dataFailedSample: failedTickers.slice(0, 12),
      shortHistory: shortHistory.map(t => t.replace(/\.(NS|BO)$/, '')),
      priceEligible: priceEligibleCount,
      biasEligible: biasEligibleCount,
      priceNote: timedOut
        ? 'Price/bias counts are partial because the data provider timed out before the full universe completed.'
        : 'Price/bias counts are live and change with current market price; whitelist is not used as a bypass.'
    },
    universeLabel: 'Eligible NSE large-cap scan: market cap > ₹35,000Cr, price > ₹10, bullish bias only',
    screenerFlow: [
      {step:'Market', rule:'READY only while Nifty is above its EMA50 with EMA20 above EMA50; plus sector up (1M) or beating Nifty (3M)'},
      {step:'Quick Bounce', rule:'RSI-2 under 10, close above the 50/200-day averages, Nifty above its 200-day average; exit at the first close above the 5-day average or day 10'},
      {step:'Relative strength', rule:'READY needs the stock to outperform Nifty over ~3 months; leaders rank higher'},
      {step:'Volume', rule:'Pullbacks: quiet pullback, green bounce day on >=1.0x volume · Breakout: >=1.1x'},
      {step:'Results', rule:`No READY with results today or within ${RESULTS_BLOCK_TRADING_DAYS} trading days`},
      {step:'Bias', rule:'Bullish only: Price>EMA50 and EMA50>EMA200'},
      {step:'Setup', rule:'EMA20 Pullback / EMA50 Deep Pullback / Support Bounce / Pre-Breakout / Breakout / Momentum'},
      {step:'Entry / Action', rule:'RR≥1.25 + Volume≥0.8x + score gates decide Ready vs Watchlist'},
      {step:'Ready Gate', rule:'Selected setup hard gate must PASS (EMA20 pullback, EMA50 deep pullback, support bounce or breakout). Pre-Breakout and Momentum are watch-only'}
    ],
    filters: {
      criteria: 'Screener Match: Nifty above EMA50 + no results within 5 trading days + Bias Bullish + selected setup + RR≥1.25 + Volume≥0.8x + no high selling volume + Strategy score≥70 + Fresh Entry Score≥70 + setup gate PASS · Watchlist: Bias Bullish + setup forming + score≥55 + near entry zone + one or more confirmation gaps · No duplicate symbols: every Screener Match symbol is excluded from Watchlist · RSI, MACD and ADX remain quality inputs, and selected-strategy gate failures move the stock to Watchlist instead of Ready.'
    },
    scoreBasis: 'One eligible large-cap NSE scan. All indicators are calculated locally from the same daily Yahoo candles; Screener Match and Watchlist come from the same scan with duplicate symbols removed.',
    generatedAt: new Date().toISOString(),
    note: timedOut ? 'Screener Match/Watchlist returned partial results due to data-provider timeout; refresh again from the Screener tab.' : 'Screener Match is a server pre-filter; Overview remains the final trade decision: selected-strategy gate failures such as RSI outside zone, weak ADX, late entry, RR below 1.25, or volume below 0.8x, high selling volume, or RR below 1.25 cannot stay Ready. Watchlist shows need-confirmation candidates only. A stock cannot appear in both lists. Breakout is included; Pre-Breakout Watch and Momentum Continuation are watch-only and never READY.'
  };
  MY_TRADE_SCREENER_CACHE = result;
  /* A partial scan (timeout, or Yahoo paused so most charts failed) is kept 1 minute, not 30, so the next
     visit rescans instead of showing an empty or thin list for half an hour. */
  const scanOk = !timedOut && dataOkCount >= 0.8 * universe.length;
  MY_TRADE_SCREENER_TS = scanOk ? Date.now() : Date.now() - MY_TRADE_SCREENER_TTL + 60e3;
  return result;
}

/* ── Legacy screener code below is retained, but public routes use /api/my-trade-screener. ── */
let SCREENER_CACHE = null, SCREENER_TS = 0;
const SCREENER_TTL = 60 * 60 * 1000; /* 1 hour cache */

/* News cache — per symbol, 15 min TTL */


/* ══════════════════════════════════════════════════════════════════════
   ECONOMIC CALENDAR — Key Indian + US market events
   Static/manual calendar (not a live exchange calendar; verify important dates before trading)
   Events that move markets: RBI MPC, CPI, GDP, US FOMC, US NFP, F&O expiry
══════════════════════════════════════════════════════════════════════ */
const ECON_CALENDAR = [
  /* Manual dates only for what has no rule: RBI MPC and US FOMC decision days (verify on rbi.org.in /
     federalreserve.gov). F&O expiries, US EIA crude / gas storage and US payrolls are generated by rule
     below. Past entries were removed on 3 Nov 2026; add the 2027 RBI / FOMC dates when they are published. */
  { date:'2026-12-04', event:'RBI MPC Rate Decision', category:'RBI', impact:'HIGH', desc:'RBI MPC December meeting.', country:'IN' },
  { date:'2026-12-09', event:'US Fed FOMC Decision', category:'FOMC', impact:'HIGH', desc:'FOMC December meeting decision day. Meeting runs Dec 8-9, 2026.', country:'US' },
].sort((a,b)=>a.date.localeCompare(b.date));

/* Today's date in IST. toISOString() is UTC, so 00:00-05:30 IST used to count as the previous day. */
function istDateKey(ms = Date.now()) { return new Date(ms + 330 * 60000).toISOString().slice(0, 10); }
function daysBetweenKeys(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000); }

/* NSE F&O expiries are rule-based (Tuesday expiry; monthly = last Tuesday), so generate them instead of
   letting a hand-typed list run out. Holiday shifts are NOT applied - flagged in the description. */
/* NSE trading holidays that can fall on an expiry Tuesday. Fixed-date ones every year, plus dated ones that
   must be checked against the NSE circular each year. */
const NSE_FIXED_HOLIDAYS_MD = new Set(['01-26', '04-14', '05-01', '08-15', '10-02', '12-25']);
const NSE_DATED_HOLIDAYS = new Set((process.env.NSE_HOLIDAYS || '2026-11-24').split(',').map(s => s.trim()).filter(Boolean));
function isNseHoliday(key) { return NSE_DATED_HOLIDAYS.has(key) || NSE_FIXED_HOLIDAYS_MD.has(key.slice(5)); }
function previousNseTradingDay(d) {
  let x = new Date(d.getTime());
  do { x = new Date(x.getTime() - 86400000); } while ([0, 6].includes(x.getUTCDay()) || isNseHoliday(x.toISOString().slice(0, 10)));
  return x;
}
function generatedFnoExpiries(fromKey, days = 120) {
  const out = [];
  const start = new Date(fromKey + 'T00:00:00Z');
  for (let i = 0; i <= days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    if (d.getUTCDay() !== 2) continue; /* Tuesday */
    const isMonthly = new Date(d.getTime() + 7 * 86400000).getUTCMonth() !== d.getUTCMonth();
    const tueKey = d.toISOString().slice(0, 10);
    const key = isNseHoliday(tueKey) ? previousNseTradingDay(d).toISOString().slice(0, 10) : tueKey;
    if (key < fromKey) continue;
    const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const note = ' Generated by rule (Tuesday expiry); if that Tuesday is a trading holiday the expiry moves to the previous trading day - verify on NSE.';
    out.push(isMonthly
      ? { date:key, event:`NSE Monthly F&O Expiry (${mon})`, category:'FNO', impact:'HIGH', desc:'Monthly NSE equity/index derivatives expiry.' + note, country:'IN', generated:true }
      : { date:key, event:'Nifty Weekly Expiry', category:'FNO', impact:'MED', desc:'Weekly Nifty options expiry.' + note, country:'IN', generated:true });
  }
  return out;
}

/* US daylight saving (2nd Sunday of March to 1st Sunday of November) moves US data releases one hour
   later in IST in winter. */
function usDst(key) {
  const y = +key.slice(0, 4), nthSun = (m, n) => { const d = new Date(Date.UTC(y, m, 1)); return 1 + ((7 - d.getUTCDay()) % 7) + 7 * (n - 1); };
  const start = `${y}-03-${String(nthSun(2, 2)).padStart(2, '0')}`, end = `${y}-11-${String(nthSun(10, 1)).padStart(2, '0')}`;
  return key >= start && key < end;
}
/* Weekly / monthly US releases that move MCX crude, natural gas and bullion, generated by their usual rule
   (Wednesday EIA crude inventories, Thursday EIA gas storage, first-Friday payrolls). A US holiday can move
   a release by a day - flagged in the description. */
function generatedMacroEvents(fromKey, days = 21) {
  const out = [], start = new Date(fromKey + 'T00:00:00Z');
  for (let i = 0; i <= days; i++) {
    const d = new Date(start.getTime() + i * 86400000), key = d.toISOString().slice(0, 10), dow = d.getUTCDay(), dst = usDst(key);
    const t1030 = dst ? '8:00 pm IST' : '9:00 pm IST', t0830 = dst ? '6:00 pm IST' : '7:00 pm IST';
    const note = ' Generated by the usual weekday rule; a US holiday can move it by a day.';
    if (dow === 3) out.push({ date:key, time:t1030, event:'US EIA Crude Inventories', category:'EIA', impact:'HIGH', desc:`Weekly US crude stock change, ${t1030}. A surprise draw lifts crude, a build weighs on it.` + note, country:'US', generated:true });
    if (dow === 4) out.push({ date:key, time:t1030, event:'US EIA Natural Gas Storage', category:'NGSTORAGE', impact:'MED', desc:`Weekly US gas storage change, ${t1030}.` + note, country:'US', generated:true });
    if (dow === 5 && d.getUTCDate() <= 7) out.push({ date:key, time:t0830, event:'US Non-Farm Payrolls', category:'NFP', impact:'HIGH', desc:`US jobs report, ${t0830}. Moves the dollar, gold and silver.` + note, country:'US', generated:true });
  }
  return out;
}
function apiCalendar(req, res) {
  const today = istDateKey();
  const manualFnoDates = new Set(ECON_CALENDAR.filter(e => e.category === 'FNO').map(e => e.date));
  const manualNfp = new Set(ECON_CALENDAR.filter(e => e.category === 'NFP').map(e => e.date));
  const all = ECON_CALENDAR.concat(generatedFnoExpiries(today).filter(e => !manualFnoDates.has(e.date)),
                                   generatedMacroEvents(today).filter(e => !(e.category === 'NFP' && manualNfp.has(e.date))))
    .sort((a,b) => a.date.localeCompare(b.date));
  const upcoming = all.filter(e => e.date >= today).slice(0, 80);
  const past     = all.filter(e => e.date <  today).slice(-5).reverse();
  const next = upcoming[0];
  const daysUntil = next ? daysBetweenKeys(today, next.date) : null;
  /* Manually maintained categories whose last known date has passed - the UI should say "not maintained", not "no events". */
  const lastByCat = {};
  ECON_CALENDAR.forEach(e => { if (!lastByCat[e.category] || e.date > lastByCat[e.category]) lastByCat[e.category] = e.date; });
  const staleCategories = Object.keys(lastByCat).filter(c => !['FNO', 'NFP'].includes(c) && lastByCat[c] < today);
  /* Never in the calendar: no free reliable feed. Said every time so a quiet week is not read as "no events". */
  const notCovered = 'India / US CPI, GDP and OPEC+ dates are not in this calendar - check them separately.';
  send(res, { upcoming, past, next, daysUntil, total:all.length, staleCategories,
    stale: staleCategories.length > 0,
    staleNote: (staleCategories.length ? `Manual calendar has no upcoming ${staleCategories.join(', ')} dates - update ECON_CALENDAR in server.js. ` : '') + notCovered,
    source:'RBI / FOMC (manual) + generated F&O expiries, EIA and payrolls', updatedAt:'2026-11-03T00:00:00.000Z', checkedAt:new Date().toISOString() });
}

/* ══════════════════════════════════════════════════════════════════════
   EARNINGS DATES — static/manual list for top NSE stocks; verify with exchange/company filings
   India results cycle: Q4 Apr-May, Q1 Jul-Aug, Q2 Oct-Nov, Q3 Jan-Feb
══════════════════════════════════════════════════════════════════════ */
const EARNINGS_DATES = [
  /* Optional manual additions ({ sym:'NSE:XYZ', name, date:'YYYY-MM-DD', quarter }) for a stock the NSE event
     calendar misses. Results dates normally come from the NSE event calendar (getResultsCalendar). */
].sort((a,b)=>a.date.localeCompare(b.date));

async function apiEarnings(req, res, p) {
  const sym   = p.get('sym') || null;
  const today = istDateKey();
  /* Live NSE results calendar first (same data the screener uses), manual list as fallback. */
  try {
    const cal = await getResultsCalendar();
    if (sym && cal.ok) {
      const s = sym.replace('NSE:','');
      const info = resultsCheckFor(s, cal, today);
      const upcoming = info && info.tradingDays >= 0 ? [{ sym:'NSE:'+s, date:info.date, quarter:info.purpose, daysUntil:daysBetweenKeys(today, info.date), tradingDaysUntil:info.tradingDays, source:cal.source }] : [];
      const soon = upcoming.filter(x => x.tradingDaysUntil <= RESULTS_BLOCK_TRADING_DAYS);
      return send(res, { upcoming, past:[], soon, warned: soon.length > 0, source:cal.source, checkedAt:new Date().toISOString() });
    }
  } catch (er) { /* fall through to the manual list */ }
  let list = EARNINGS_DATES;
  /* Exact symbol match: substring matching made e.g. sym=GL match IGL and raise a false warning. */
  if (sym) { const want = sym.startsWith('NSE:') ? sym : 'NSE:' + sym; list = list.filter(e => e.sym === want); }
  const upcoming = list.filter(e => e.date >= today).map(e => ({ ...e, daysUntil: daysBetweenKeys(today, e.date) }));
  const past     = list.filter(e => e.date <  today).slice(-5).reverse();
  /* Warning: if earnings within 5 days */
  const soon = upcoming.filter(e => e.daysUntil <= 5);
  send(res, { upcoming, past, soon, warned: soon.length > 0, source:'manual-upcoming-only', updatedAt:'2026-05-16T08:45:00.000Z', checkedAt:new Date().toISOString(), note:'Old earnings dates removed. This is a manual no-key list; verify before trade.' });
}

/* ══════════════════════════════════════════════════════════════════════
   SECTOR / INDEX HEATMAP — NSE indices
   Source list: uploaded "All Nse Indices.xlsx"
   LTP column is reference only; live values are fetched from Yahoo/chart API.
══════════════════════════════════════════════════════════════════════ */
const SECTORS = [
  { key:'next50',      label:'Nifty Next 50',                 ticker:'^NSMIDCP', color:'#185FA5' },
  { key:'bank',        label:'Nifty Bank',                    ticker:'^NSEBANK', color:'#854F0B' },
  { key:'fmcg',        label:'Nifty FMCG',                    ticker:'^CNXFMCG', color:'#533AB7' },
  { key:'energy',      label:'Nifty Energy',                  ticker:'^CNXENERGY', color:'#633806' },
  { key:'consdur',     label:'Nifty Consumer Durables',       ticker:'NIFTY_CONSR_DURBL.NS', color:'#7B3F98' },
  { key:'finexbank',   label:'Nifty Fin Services Ex-Bank',    ticker:'FINIETF.NS', color:'#3B6D11' },
  { key:'it',          label:'Nifty IT',                      ticker:'^CNXIT', color:'#185FA5' },
  { key:'pvtbank',     label:'Nifty Private Bank',            ticker:'NIFTY_PVT_BANK.NS', color:'#8A5C12' },
  { key:'auto',        label:'Nifty Auto',                    ticker:'^CNXAUTO', color:'#791F1F' },
  { key:'finnifty',    label:'FinNifty',                      ticker:'NIFTY_FIN_SERVICE.NS', color:'#3B6D11' },
  { key:'pharma',      label:'Nifty Pharma',                  ticker:'^CNXPHARMA', color:'#27500A' },
  { key:'nifty50',     label:'Nifty 50',                      ticker:'^NSEI', color:'#185FA5' },
  { key:'midcap150',   label:'Nifty Midcap 150',              ticker:'NIFTYMIDCAP150.NS', color:'#5F5E5A' },
  { key:'health',      label:'Nifty Healthcare',              ticker:'NIFTY_HEALTHCARE.NS', color:'#2A6F4E' },
  { key:'metal',       label:'Nifty Metal',                   ticker:'^CNXMETAL', color:'#5F5E5A' },
  { key:'housing',     label:'Nifty Housing',                 ticker:'NIFTY_HOUSING.NS', color:'#A15A95' },
  { key:'consumption', label:'Nifty India Consumption',       ticker:'^CNXCONSUM', color:'#8D5C06' },
  { key:'oilgas',      label:'Nifty Oil & Gas',               ticker:'NIFTY_OIL_AND_GAS.NS', color:'#8D5C06' },
  { key:'pse',         label:'Nifty PSE',                     ticker:'^CNXPSE', color:'#A15C38' },
  { key:'commodities', label:'Nifty Commodities',             ticker:'^CNXCMDT', color:'#5F5E5A' },
  { key:'infra',       label:'Nifty Infra',                   ticker:'^CNXINFRA', color:'#A15A95' },
  { key:'psubank',     label:'Nifty PSU Bank',                ticker:'^CNXPSUBANK', color:'#A15C38' },
  { key:'digital',     label:'Nifty India Digital',           ticker:'NIFTY_IND_DIGITAL.NS', color:'#185FA5' },
  { key:'tourism',     label:'Nifty India Tourism',           ticker:'NIFTY_IND_TOURISM.NS', color:'#A15A95' },
  { key:'media',       label:'Nifty Media',                   ticker:'^CNXMEDIA', color:'#A15A95' },
  { key:'realty',      label:'Nifty Realty',                  ticker:'^CNXREALTY', color:'#7B3F98' },
];

let SECTOR_CACHE = null, SECTOR_TS = 0;
const SECTOR_TTL = 10 * 60 * 1000; /* 10 min */

/* One Yahoo call per sector (was two): a 5-day 15-minute chart gives the live price and the previous session's
   close (last bar of the earlier trading day), which also works for the NSE indices whose daily series
   carries only one bar. Falls back to the two-call path only if this fails. */
async function getSectorQuoteLight(ticker) {
  const r = await safeFetch(() => yfChart(ticker, '15m', '5d'), 0);
  const b = parseBars(r), meta = r?.meta || {};
  if (!b.n) throw new Error('no intraday bars');
  const day = t => istDateKey(t * 1000);
  const lastDay = day(b.T[b.n - 1]);
  let prev = null;
  for (let i = b.n - 1; i >= 0; i--) if (b.T[i] && day(b.T[i]) < lastDay) { prev = b.C[i]; break; }
  const live = Number(meta.regularMarketPrice) > 0 ? +meta.regularMarketPrice : b.C[b.n - 1];
  if (!(prev > 0) || !(live > 0)) throw new Error('no previous session');
  return { liveRaw: live, rawChg: live - prev, rawPct: (live - prev) / prev * 100,
           marketTime: Number(meta.regularMarketTime) || b.T[b.n - 1] };
}
async function getSectorPriceAndChange(s) {
  /* Direct-only Yahoo index ticker. No synthetic stock basket calculation. */
  try { return { ...(await getSectorQuoteLight(s.ticker)), usedTicker:s.ticker }; }
  catch { const val = await getPriceAndChange(s.ticker); return { ...val, usedTicker:s.ticker }; }
}

/* Sectors load in the background. A request waits at most ~6 s; whatever has not arrived yet is returned
   as "loading" (partial:true) and keeps loading - the page asks again a few seconds later. Before, any sector
   slower than 9 s (common at start-up, when breadth / sidebar / screener share the Yahoo queue) was dropped
   from the ranking, or the whole page timed out. */
let SECTOR_BUILD = null, SECTOR_PROGRESS = [];
function startSectorBuild() {
  if (SECTOR_BUILD) return SECTOR_BUILD;
  SECTOR_PROGRESS = new Array(SECTORS.length).fill(undefined);
  SECTOR_BUILD = Promise.allSettled(SECTORS.map((s, i) =>
    withTimeout(getSectorPriceAndChange(s), 30000, s.key + ' sector')
      .then(v => { SECTOR_PROGRESS[i] = { status:'fulfilled', value:v }; return v; },
            e => { SECTOR_PROGRESS[i] = { status:'rejected', reason:e }; throw e; })))
    .then(results => {
      const result = assembleSectors(results);
      const okCount = result.sectors.filter(x => !x.error).length;
      SECTOR_CACHE = result;
      /* Full 10 min only when most sectors loaded; a Yahoo blip is retried after ~30 s. */
      SECTOR_TS = okCount >= SECTORS.length * 0.6 ? Date.now() : Date.now() - SECTOR_TTL + 30 * 1000;
      return result;
    })
    .finally(() => { SECTOR_BUILD = null; });
  return SECTOR_BUILD;
}
async function apiSectors(req, res) {
  if (SECTOR_CACHE && Date.now() - SECTOR_TS < SECTOR_TTL) return send(res, SECTOR_CACHE);
  try {
    const build = startSectorBuild();
    const done = await Promise.race([build, new Promise(r => setTimeout(() => r(null), 6000))]);
    if (done) return send(res, done);
    const partial = assembleSectors(SECTOR_PROGRESS);
    /* A stale full list is better than a half-empty one: serve it, marked, while the new one loads. */
    if (SECTOR_CACHE) return send(res, { ...SECTOR_CACHE, refreshing:true });
    send(res, { ...partial, partial:true });
  } catch(e) { err(res, e.message); }
}
function assembleSectors(results) {
  {
    const todayKey = istDateKey();
    const tradedToday = results.filter(r => r && r.status === 'fulfilled' && r.value?.marketTime && istDateKey(r.value.marketTime * 1000) === todayKey).length;
    /* Holiday / pre-open: nothing traded today, so last-session changes are the right thing to show. */
    const staleCheckOn = nseSessionShare() < 1 && tradedToday >= SECTORS.length / 2;
    const sectors = SECTORS.map((s, i) => {
      if (!results[i]) return { ...s, ticker:s.ticker, price:null, chg:null, pct:null, isUp:false, pending:true, reason:'still loading' };
      if (results[i].status !== 'fulfilled') {
        return { ...s, ticker:s.ticker, price:null, chg:null, pct:null, isUp:false, error:true, removeOnFail:true, reason:results[i].reason?.message || 'sector fetch failed' };
      }
      const { liveRaw, rawChg, rawPct, usedTicker, marketTime } = results[i].value;
      /* Several NSE sectoral tickers on Yahoo stop updating intraday and report exactly 0.00%. During the
         session a quote whose last trade is not from today is stale: show N/A, never rank it as "top sector". */
      const lastTradeDay = marketTime ? istDateKey(marketTime * 1000) : null;
      if (staleCheckOn && lastTradeDay && lastTradeDay < todayKey) {
        return { ...s, ticker: usedTicker || s.ticker, price:+liveRaw.toFixed(2), chg:null, pct:null, isUp:false, error:true, stale:true, reason:`No trade today on Yahoo (last ${lastTradeDay})` };
      }
      return {
        ...s, ticker: usedTicker || s.ticker, price:+liveRaw.toFixed(2),
        chg:+rawChg.toFixed(2), pct:+rawPct.toFixed(2), isUp:rawPct>=0,
        source: 'Direct Yahoo index ticker',
      };
    });
    /* Sort by % change — top performers first */
    sectors.sort((a,b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity)); /* failed sectors last */
    return { sectors, updatedAt:new Date().toISOString() };
  }
}

/* ── /api/screener-explain?sym=NSE:X ── one stock through the screener's own maths: chosen setup, its stop /
   target / R:R, volume rule, relative strength and every gate reason. Uses cached charts. */
async function apiScreenerExplain(req, res, p) {
  const sym = String(p.get('sym') || '').toUpperCase();
  if (!/^NSE:[A-Z0-9&_.-]+$/.test(sym)) return err(res, 'NSE symbol required', 400);
  try {
    const ticker = sym.slice(4) + '.NS';
    await getNiftyRegime();
    const raw = await withTimeout(yfChart(ticker, '1d', '2y'), 15000, sym + ' explain');
    const daily = enrichDailyForLiveScreenerS(parseBars(raw), raw?.meta || {});
    if (daily.n < 200) return send(res, { sym, eligible:false, reason:'Less than 200 days of history' });
    const m = qualifiedMetricsS({ C:daily.C, H:daily.H, L:daily.L, V:daily.V, weekly:null, marketCapCr:screenerMcapNow(ticker, daily.C[daily.n-1]), prevIdx:daily._prevSessionIdx });
    const rs = NIFTY_CLOSES ? SwingPlan.relStrength(daily.C, NIFTY_CLOSES) : null;
    const pickedObj = m.picked ? m.strategyScores[SETUP_KEY[m.picked]] : null;
    send(res, { sym, price:m.price, bias:m.bias, marketCapCr:m.marketCapCr, picked:m.picked, plan:m.plan, rr:m.rrBull, rrBySetup:m.rrBy,
      volume:{ blend:+m.volRatio.toFixed(2), ...m.pv, ok: m.picked ? SwingPlan.setupVolumeOk(m.picked, m.volRatio, m.pv) : null },
      rs, decisionScore:m.decisionScore, highSellingVolume:m.highSellingVolume,
      setupScore: pickedObj ? Math.round(+pickedObj.score) : null, gate: pickedObj ? pickedObj.readyGate : null,
      regime: marketRegime(NIFTY_REGIME_CACHE), updatedAt:new Date().toISOString() });
  } catch (er) { err(res, er.message); }
}

/* ── /api/swing-context ── everything the Overview needs to apply the SAME gates as the screener:
   market regime (Nifty + breadth), relative strength vs Nifty, results within 5 trading days, NSE sector.
   Uses cached charts, so opening a stock normally costs no extra Yahoo calls. */
/* ── NSE option chain (free, no key): live premiums, OI, IV for Nifty / Bank Nifty / FinNifty ──
   NSE needs a session cookie from its own option-chain page first. One cookie serves 10 minutes; the chain is
   cached 3 minutes in market hours (30 outside), and goes through the NSE queue (one request at a time). */
const OC_SYMBOLS = { 'NSE:NIFTY':'NIFTY', 'NSE:BANKNIFTY':'BANKNIFTY', 'NSE:FINNIFTY':'FINNIFTY' };
let NSE_OC_COOKIE = null;
async function nseOptionCookie(force = false) {
  if (!force && NSE_OC_COOKIE && Date.now() - NSE_OC_COOKIE.ts < 10 * 60 * 1000) return NSE_OC_COOKIE.v;
  const page = await withTimeout(getWithHeaders('https://www.nseindia.com/option-chain', { Accept:'text/html' }), 15000, 'NSE option-chain cookie');
  const v = (page.headers['set-cookie'] || []).map(c => String(c).split(';')[0]).join('; ');
  if (!v) throw new Error('NSE gave no session cookie');
  NSE_OC_COOKIE = { v, ts: Date.now() };
  return v;
}
async function nseOcGet(path) {
  const hdr = c => ({ Accept:'application/json', Referer:'https://www.nseindia.com/option-chain', Cookie:c });
  let r;
  try { r = await withTimeout(get('https://www.nseindia.com' + path, hdr(await nseOptionCookie())), 15000, 'NSE option chain'); }
  catch (e) {
    /* NSE resets the connection when it sees bursts: one retry with a fresh session after a short pause. */
    await new Promise(res => setTimeout(res, 1500));
    r = await withTimeout(get('https://www.nseindia.com' + path, hdr(await nseOptionCookie(true))), 15000, 'NSE option chain (retry)');
  }
  if (r.status === 401 || r.status === 403) r = await withTimeout(get('https://www.nseindia.com' + path, hdr(await nseOptionCookie(true))), 15000, 'NSE option chain (new cookie)');
  if (r.status !== 200) throw new Error('NSE HTTP ' + r.status);
  return JSON.parse(r.body);
}
const NSE_MON = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };
const nseExpKey = e => { const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(e || ''); return m ? `${m[3]}-${NSE_MON[m[2]]}-${m[1]}` : null; };
function istMarketHoursS() {
  const t = new Date(Date.now() + 5.5 * 3600000), d = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  return d >= 1 && d <= 5 && m >= 9 * 60 && m <= 15 * 60 + 35;
}
async function getOptionChain(sym, want = '') {
  const name = OC_SYMBOLS[sym];
  if (!name) throw new Error('Option chain only for NSE:NIFTY, NSE:BANKNIFTY, NSE:FINNIFTY');
  {
    /* Expiry list cached 30 min on its own; the chain is cached per NSE expiry, so different "days" that land on
       the same expiry share one fetch (each new key used to cost two NSE calls in a one-at-a-time queue). */
    const info = (await cacheWrap(`ocinfo_${name}`, 1800e3, () => nseOcGet(`/api/option-chain-contract-info?symbol=${name}`))).value;
    const exps0 = (info.expiryDates || []).map(e => ({ nse: e, key: nseExpKey(e) })).filter(e => e.key);
    const today0 = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
    const dd0 = (a, b) => Math.abs(Date.parse(a) - Date.parse(b));
    const pick0 = exps0.find(e => e.key === want) || (want ? exps0.slice().sort((a, b) => dd0(a.key, want) - dd0(b.key, want))[0] : exps0.find(e => e.key >= today0)) || exps0[0];
    if (!pick0) throw new Error('No expiry dates from NSE');
    const { value } = await cacheWrap(`oc_${name}_${pick0.key}`, istMarketHoursS() ? 180e3 : 1800e3, async () => {
      const exps = exps0;
      const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
      /* The app's expiry calendar is generated by rule; NSE's list is the truth (holiday shifts). Exact date,
         else the closest NSE expiry to the one asked for, else the nearest one from today. */
      const dd = (a, b) => Math.abs(Date.parse(a) - Date.parse(b));
      const pick = exps.find(e => e.key === want) || (want ? exps.slice().sort((a, b) => dd(a.key, want) - dd(b.key, want))[0] : exps.find(e => e.key >= today)) || exps[0];
      if (!pick) throw new Error('No expiry dates from NSE');
      const j = await nseOcGet(`/api/option-chain-v3?type=Indices&symbol=${name}&expiry=${encodeURIComponent(pick.nse)}`);
      const rec = j.records || {}, spot = +rec.underlyingValue;
      const side = o => o ? { ltp: +o.lastPrice || 0, bid: +o.buyPrice1 || 0, ask: +o.sellPrice1 || 0, oi: +o.openInterest || 0,
        chgOi: +o.changeinOpenInterest || 0, iv: +o.impliedVolatility || 0, vol: +o.totalTradedVolume || 0 } : null;
      const all = (rec.data || []).filter(r => r.CE || r.PE).map(r => ({ k: +r.strikePrice, ce: side(r.CE), pe: side(r.PE) })).sort((a, b) => a.k - b.k);
      if (!all.length || !(spot > 0)) throw new Error('Empty option chain');
      const ceOi = all.reduce((a, r) => a + (r.ce?.oi || 0), 0), peOi = all.reduce((a, r) => a + (r.pe?.oi || 0), 0);
      /* Max pain: the expiry price where option buyers' total intrinsic value is smallest. */
      let maxPain = null, best = Infinity;
      for (const t of all) {
        const pain = all.reduce((a, r) => a + (r.ce?.oi || 0) * Math.max(0, t.k - r.k) + (r.pe?.oi || 0) * Math.max(0, r.k - t.k), 0);
        if (pain < best) { best = pain; maxPain = t.k; }
      }
      const top = (key, f) => all.filter(f).sort((a, b) => (b[key]?.oi || 0) - (a[key]?.oi || 0)).slice(0, 3).map(r => ({ k: r.k, oi: r[key].oi, chgOi: r[key].chgOi }));
      return {
        sym, name, spot, expiry: pick.key, expiries: exps.map(e => e.key).slice(0, 8), timestamp: rec.timestamp || null,
        pcr: ceOi ? +(peOi / ceOi).toFixed(2) : null, maxPain,
        callWalls: top('ce', r => r.k >= spot && r.ce), putWalls: top('pe', r => r.k <= spot && r.pe),
        strikes: all.filter(r => Math.abs(r.k - spot) / spot <= 0.12),
        source: 'NSE option chain', fetchedAt: new Date().toISOString(),
      };
    });
    return value;
  }
}
async function apiOptionChain(req, res, p) {
  const sym = String(p.get('sym') || 'NSE:NIFTY').toUpperCase();
  if (!OC_SYMBOLS[sym]) return err(res, 'Option chain only for NSE:NIFTY, NSE:BANKNIFTY, NSE:FINNIFTY', 400);
  try { send(res, await getOptionChain(sym, String(p.get('expiry') || ''))); }   /* expiry YYYY-MM-DD; default = nearest */
  catch (e) { err(res, 'NSE option chain unavailable: ' + e.message, 502); }
}

async function apiSwingContext(req, res, p) {
  const sym = String(p.get('sym') || '').toUpperCase();
  if (!/^NSE:[A-Z0-9&_.-]+$/.test(sym)) return err(res, 'NSE symbol required', 400);
  const code = sym.slice(4);
  try {
    const [nifty, cal] = await Promise.all([getNiftyRegime(), getResultsCalendar().catch(() => null)]);
    const regime = marketRegime(nifty);
    let rs = null;
    try {
      const raw = await withTimeout(yfChart(code + '.NS', '1d', '2y'), 15000, sym + ' rs');
      if (NIFTY_CLOSES) rs = SwingPlan.relStrength(enrichDailyForLiveScreenerS(parseBars(raw), raw?.meta || {}).C, NIFTY_CLOSES);   /* same series as the screener */
    } catch {}
    const r = cal ? resultsCheckFor(code, cal, istDateKey()) : null;
    send(res, {
      sym,
      regime: { status: regime.status, allowReady: regime.allowReady, note: regime.note, nifty: regime.nifty, ema50: regime.ema50,
        ema20: regime.ema20, trendUp: regime.trendUp ?? null, sma200: regime.sma200 ?? null, aboveSma200: regime.aboveSma200 ?? null,
        breadthPct: regime.breadth?.pct ?? null, breadthAt: regime.breadth ? new Date(regime.breadth.ts).toISOString() : null },
      rs,
      resultsSoon: r && r.block ? { date: r.date, tradingDaysUntil: r.tradingDays, purpose: r.purpose } : null,
      resultsCheck: cal?.ok ? (cal.source || 'NSE event calendar') : 'unavailable',
      sector: sectorInfoFor(code),
      sectorStrength: sectorStrengthFor(code),
      updatedAt: new Date().toISOString()
    });
  } catch (er) { err(res, er.message); }
}

/* ── /api/quote ── */
async function apiQuote(req,res,p){
  const sym=p.get('sym')||'NSE:NIFTY';
  const key=`quote:${sym}`;
  const mcxReq=isMCX(sym);
  /* MCX used to force a fresh fetch on EVERY request (no cache, no de-dupe). A short TTL keeps it
     near-live while letting several tabs/pollers share one fetch. */
  const force=p.get('force')==='1'||p.get('fresh')==='1';
  const producer = async () => {
      const mcx=mcxReq;
      const fxBasis=mcx?await getRateBasis():{live:1,prev:1};
      const rate=fxBasis.live;
      const prevRate=fxBasis.prev;
      const ticker=getTicker(sym);

      /* Fetch price and historical series in parallel.
         Old flow waited for price first, then fetched history, which made stock switching slower. */
      const priceP=withTimeout(getIndexFallbackPrice(sym, ticker), 20000, ticker + ' quote price');
      /* 20 s like the screener: requests wait their turn in the polite Yahoo queue, and on a cold start (sidebar +
         market context) a 10 s limit expired in the queue and the stock failed with "No historical data". */
      const histP=Promise.allSettled([
        /* 2y, not 1y: EMA200 needs a long warm-up, otherwise it is still ~60% its SMA seed and disagrees with charting platforms. */
      withTimeout(safeFetch(() => yfChart(ticker,'1d','2y'), 1), 20000, ticker + ' daily history'),
        withTimeout(safeFetch(() => yfChart(ticker,'1wk','2y'), 1), 20000, ticker + ' weekly history'),
        withTimeout(safeFetch(() => yfChart(ticker,'1h','5d'), 1), 20000, ticker + ' intraday history'),
        withTimeout(safeFetch(() => yfChart(ticker,'1mo','5y'), 1), 20000, ticker + ' monthly history'),
      ]);

      const [priceData, histResults] = await Promise.all([priceP, histP]);
      const {liveRaw,prevRaw,rawPct,todayOpen,todayHigh,todayLow,todayVol,changeBasis,basisTime}=priceData;
      const [dailyR,weeklyR,intraR,monthlyR]=histResults;

      let daily =dailyR.status ==='fulfilled'?parseBars(dailyR.value):null;
      let weekly=weeklyR.status==='fulfilled'?parseBars(weeklyR.value):null;
      let intra =intraR.status ==='fulfilled'?parseBars(intraR.value):null;
      let monthly=monthlyR.status==='fulfilled'?parseBars(monthlyR.value):null;
      if(!daily)throw new Error('No historical data for '+ticker);
      /* Price from NSE but history from Yahoo's ETF proxy: scale the ETF bars by (index / ETF price) so the
         candles, EMAs and levels sit at the index level (the shape is the ETF's, which tracks the index). */
      let proxyScale = null;
      if ((priceData.source === 'NSE' || priceData.source === 'ETFxRatio') && NSE_INDEX_PRIMARY.has(sym)) {
        const etfLast = +dailyR.value?.meta?.regularMarketPrice || +daily.C[daily.C.length - 1];
        if (etfLast > 0 && liveRaw > 0) {
          proxyScale = liveRaw / etfLast;
          if (priceData.source === 'NSE') NSE_PROXY_RATIO[sym] = proxyScale;
          const sc = b => b ? { ...b, O:b.O.map(v => v * proxyScale), H:b.H.map(v => v * proxyScale), L:b.L.map(v => v * proxyScale), C:b.C.map(v => v * proxyScale) } : b;
          daily = sc(daily); weekly = sc(weekly); intra = sc(intra); monthly = sc(monthly);
        }
      }

      /* Convert to INR for MCX.
         For MCX proxy day-change, use current futures × current USD/INR
         minus previous futures close × previous USD/INR close.
         This is the actual proxy move the user wants; rawPct alone ignores INR movement. */
      const price=conv(sym,liveRaw,rate);
      const pc   =conv(sym,prevRaw,mcx?prevRate:rate);
      const chg  =+(price-pc).toFixed(2);
      const pct  =+(pc && pc>0 ? (chg/pc)*100 : rawPct).toFixed(2);
      const cv=arr=>mcx?arr.map(v=>conv(sym,v,rate)):arr;
      const mcxWarning = mcx
        ? `${DATA_SOURCE_NOTES[sym] || ''} Price is a continuous proxy, not official MCX session price.`.trim()
        : (DATA_SOURCE_NOTES[sym] || '');
      const displayOpenRaw = todayOpen;

      return {
        sym,ticker,usdInr:mcx?rate:null,prevUsdInr:mcx?prevRate:null,
        price,pc,chg,pct,
        changeBasis: mcx ? changeBasis : 'previousClose',
        basisTime: mcx ? basisTime : null,
        dayOpen:conv(sym,displayOpenRaw,rate),
        dayHigh:conv(sym,todayHigh,rate),
        dayLow: conv(sym,todayLow, rate),
        dayVol: todayVol,
        daily: {T:daily.T||[],C:cv(daily.C),O:cv(daily.O),H:cv(daily.H),L:cv(daily.L),V:daily.V},
        weekly:weekly?{T:weekly.T||[],C:cv(weekly.C),O:cv(weekly.O),H:cv(weekly.H),L:cv(weekly.L),V:weekly.V}:null,
        monthly:monthly?{T:monthly.T||[],C:cv(monthly.C),O:cv(monthly.O),H:cv(monthly.H),L:cv(monthly.L),V:monthly.V}:null,
        intra: intra ?{T:intra.T||[],C:cv(intra.C), O:cv(intra.O), H:cv(intra.H), L:cv(intra.L), V:intra.V }:null,
        dataSource: {
          provider: priceData.source === 'NSE' ? (proxyScale ? `NSE index value · history from Yahoo ${ticker} scaled ×${proxyScale.toFixed(2)}` : 'NSE (Yahoo unavailable) · history Yahoo') : 'Yahoo Finance',
          mappedFrom: sym,
          ticker,
          mode: DATA_SOURCE_NOTES[sym] ? 'direct-yahoo-note' : 'direct',
          priceFallback: false,
          dailyFallback: false,
          weeklyFallback: false,
          warning: mcxWarning,
          changeBasis: mcx ? changeBasis : 'previousClose',
          basisTime: mcx ? basisTime : null,
          dailyBars: daily?.n || daily?.C?.length || 0,
          weeklyBars: weekly?.n || weekly?.C?.length || 0,
          monthlyBars: monthly?.n || monthly?.C?.length || 0,
          intradayBars: intra?.n || intra?.C?.length || 0,
          timezone: dailyR.status === 'fulfilled' ? (dailyR.value?.meta?.exchangeTimezoneName || dailyR.value?.meta?.timezone || 'Asia/Kolkata') : 'Asia/Kolkata'
        },
        /* Exchange time of the last trade (unix s). Lets the client tell whether the last daily bar
           is today's session or the previous one by date instead of by price. */
        marketTime: dailyR.status === 'fulfilled' ? (Number(dailyR.value?.meta?.regularMarketTime) || null) : null,
        updatedAt:new Date().toISOString(),
      };
  };
  try{
    if(force){
      const payload=await producer();
      API_CACHE.set(key,{value:payload,ts:Date.now()});
      return send(res,{...payload,cached:false,forced:true});
    }
    /* NSE symbols outside market hours do not move: no need to refetch every 20 s. */
    const quoteTtl = mcxReq ? TTL.mcx : (/^NSE:/.test(sym) && nseSessionShare() >= 1 ? 5 * 60 * 1000 : TTL.quote);
    const { value: payload, cached } = await cacheWrap(key, quoteTtl, producer);
    send(res,{...payload,cached});
  }catch(e){err(res,e.message);}
}

/* ── /api/quickprice ── */
function quickTtlFor(sym){ return isMCX(sym) ? TTL.mcx : (/^NSE:/.test(sym) && nseSessionShare() >= 1 ? 5 * 60 * 1000 : TTL.quick); }
/* Same cached quick price the sidebar uses (one shared cache entry per symbol). */
async function quickPriceFor(sym){ return (await cacheWrap(`quick:${sym}`, quickTtlFor(sym), () => quickProducer(sym))).value; }
async function apiQuick(req,res,p){
  const sym=p.get('sym')||'NSE:NIFTY';
  const key=`quick:${sym}`;
  const mcxReq=isMCX(sym);
  const force=p.get('force')==='1'||p.get('fresh')==='1';
  const producer = () => quickProducer(sym);
  try{
    if(force){
      const payload=await producer();
      API_CACHE.set(key,{value:payload,ts:Date.now()});
      return send(res,{...payload,cached:false,forced:true});
    }
    const { value: payload, cached } = await cacheWrap(key, quickTtlFor(sym), producer);
    send(res,{...payload,cached});
  }catch(e){err(res,e.message);}
}
async function quickProducer(sym){
  const mcx=isMCX(sym);
  const fxBasis=mcx?await getRateBasis():{live:1,prev:1};
  const rate=fxBasis.live;
  const prevRate=fxBasis.prev;
  const ticker=getTicker(sym);
  const {liveRaw,prevRaw,rawPct,changeBasis,basisTime}=await withTimeout(getIndexFallbackPrice(sym, ticker), 20000, ticker + ' quick price');
  const price=conv(sym,liveRaw,rate);
  const pc   =conv(sym,prevRaw,mcx?prevRate:rate);
  const chg  =+(price-pc).toFixed(2);
  const pct  =+(pc && pc>0 ? (chg/pc)*100 : rawPct).toFixed(2);
  return {sym,price,pc,chg,pct,isUp:pct>=0,usdInr:mcx?rate:null,prevUsdInr:mcx?prevRate:null,changeBasis:mcx?changeBasis:'previousClose',basisTime:mcx?basisTime:null,updatedAt:new Date().toISOString()};
}



/* ── /api/vix ── */
/* Global drivers of each MCX commodity, from Yahoo daily charts (6 months, shared chart cache, 15 min result
   cache, 3-5 tickers per commodity). Each driver votes +1 (supports a rise in the MCX price), -1 or 0. */
const MCX_DRIVER_TICKERS = { dxy:'DX-Y.NYB', us10y:'^TNX', usdinr:'USDINR=X', gold:'GC=F', silver:'SI=F', wti:'CL=F', brent:'BZ=F', natgas:'NG=F', copper:'HG=F' };
const MCX_DRIVER_SET = {
  'MCX:GOLD':['gold','dxy','us10y','usdinr'], 'MCX:GOLDPETAL':['gold','dxy','us10y','usdinr'],
  'MCX:SILVER':['silver','gold','dxy','us10y','usdinr'], 'MCX:CRUDEOIL':['wti','brent','dxy','usdinr'],
  'MCX:NATURALGAS':['natgas','usdinr'], 'MCX:COPPER':['copper','dxy','usdinr'],
};
const MCX_DRIVER_LABEL = { dxy:'Dollar index (DXY)', us10y:'US 10-year yield', usdinr:'USD/INR', gold:'COMEX gold', silver:'COMEX silver', wti:'WTI crude', brent:'Brent crude', natgas:'US natural gas', copper:'COMEX copper' };
function mcxDriverStats(C) {
  const c = C.filter(v => v > 0), n = c.length;
  if (n < 25) return null;
  const k = 2 / 21; let e = c.slice(0, 20).reduce((a, b) => a + b, 0) / 20;
  for (let i = 20; i < n; i++) e = c[i] * k + e * (1 - k);
  const last = c[n - 1];
  return { last, chg5: (last / c[n - 6] - 1) * 100, chg20: (last / c[n - 21] - 1) * 100, ema20: e, above: last > e, closes: c.slice(-6) };
}
function mcxDriverVote(key, st, commodityKey) {
  const fmt2 = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  /* A trend needs the 5-day move and the side of the 20-day average to agree, and a move big enough to matter
     (dollar index 0.3%, commodities 0.75%). */
  const min = key === 'dxy' ? 0.3 : 0.75;
  const trend = st.above && st.chg5 >= min ? 'rising' : !st.above && st.chg5 <= -min ? 'falling' : 'flat';
  if (key === 'dxy') {
    const v = trend === 'falling' ? 1 : trend === 'rising' ? -1 : 0;
    return { vote:v, text:`${trend === 'flat' ? 'Mixed' : trend === 'falling' ? 'Falling' : 'Rising'} (${fmt2(st.chg5)} in 5 days, ${st.above ? 'above' : 'below'} 20-day avg) - ${v > 0 ? 'a weaker dollar supports commodities' : v < 0 ? 'a stronger dollar weighs on commodities' : 'no push either way'}` };
  }
  if (key === 'us10y') {
    const v = st.chg5 < -1.5 ? 1 : st.chg5 > 1.5 ? -1 : 0;
    return { vote:v, text:`${st.last.toFixed(2)}% (${fmt2(st.chg5)} in 5 days) - ${v > 0 ? 'falling yields support gold and silver' : v < 0 ? 'rising yields weigh on gold and silver' : 'little change'}` };
  }
  if (key === 'usdinr') {
    const v = st.chg5 > 0.2 ? 1 : st.chg5 < -0.2 ? -1 : 0;
    return { vote:v, text:`₹${st.last.toFixed(2)} (${fmt2(st.chg5)} in 5 days) - ${v > 0 ? 'a weaker rupee lifts the MCX price' : v < 0 ? 'a stronger rupee lowers the MCX price' : 'rupee steady'}` };
  }
  const v = trend === 'rising' ? 1 : trend === 'falling' ? -1 : 0;
  const own = key === commodityKey;
  return { vote:v, text:`${trend === 'flat' ? 'Mixed' : trend === 'rising' ? 'Rising' : 'Falling'} (${fmt2(st.chg5)} in 5 days, ${st.above ? 'above' : 'below'} 20-day avg)${own ? ' - the international price MCX follows' : ''}` };
}
/* Full result kept 15 min; one with a missing driver only 30 s, so a start-up timeout (the Yahoo queue is
   busiest when the app opens) is retried on the next request instead of showing "not loaded" for 15 min. */
const MCX_DRV_CACHE = new Map(), MCX_DRV_INFLIGHT = new Map();
async function apiMcxDrivers(req, res, p) {
  const sym = String(p.get('sym') || '').toUpperCase();
  const set = MCX_DRIVER_SET[sym];
  if (!set) return err(res, 'unknown MCX symbol', 400);
  const hit = MCX_DRV_CACHE.get(sym);
  if (hit && Date.now() - hit.ts < hit.ttl) return send(res, { ...hit.value, cached:true });
  try {
    if (!MCX_DRV_INFLIGHT.has(sym)) MCX_DRV_INFLIGHT.set(sym, buildMcxDrivers(sym, set).finally(() => MCX_DRV_INFLIGHT.delete(sym)));
    const value = await MCX_DRV_INFLIGHT.get(sym);
    /* Nothing loaded but an older full result exists: serve that (marked stale) rather than an empty card. */
    if (!value.total && hit?.value?.total) return send(res, { ...hit.value, stale:true, cached:true });
    MCX_DRV_CACHE.set(sym, { value, ts:Date.now(), ttl: value.total === value.drivers.length ? 15 * 60e3 : 30e3 });
    send(res, { ...value, cached:false });
  } catch (e) { err(res, e.message); }
}
async function buildMcxDrivers(sym, set) {
  const own = set[0];
  const got = await Promise.allSettled(set.map(k => withTimeout(safeFetch(() => yfChart(MCX_DRIVER_TICKERS[k], '1d', '6mo'), 1), 20000, k)));
  const stats = {};
  const drivers = set.map((k, i) => {
    const st = got[i].status === 'fulfilled' ? mcxDriverStats(parseBars(got[i].value).C) : null;
    if (!st) return { key:k, label:MCX_DRIVER_LABEL[k], error:true, vote:0, text:'not loaded' + (got[i].status === 'rejected' ? ` (${String(got[i].reason?.message || 'error').slice(0, 60)})` : '') };
    stats[k] = st;
    return { key:k, label:MCX_DRIVER_LABEL[k], last:+st.last.toFixed(4), chg5:+st.chg5.toFixed(2), chg20:+st.chg20.toFixed(2), above:st.above, ...mcxDriverVote(k, st, own) };
  });
  /* Silver: the gold/silver ratio. A high ratio that is falling means silver is catching up with gold. */
  if (sym === 'MCX:SILVER' && stats.gold && stats.silver) {
    const r = stats.gold.last / stats.silver.last, r5 = stats.gold.closes[0] / stats.silver.closes[0], ch = (r / r5 - 1) * 100;
    const v = ch < -1 ? 1 : ch > 1 ? -1 : 0;
    drivers.push({ key:'gsratio', label:'Gold/silver ratio', last:+r.toFixed(1), chg5:+ch.toFixed(2), vote:v,
      text:`${r.toFixed(1)} (${ch >= 0 ? '+' : ''}${ch.toFixed(2)}% in 5 days) - ${v > 0 ? 'falling: silver is outperforming gold' : v < 0 ? 'rising: silver is lagging gold' : 'steady'}` });
  }
  const ok = drivers.filter(d => !d.error);
  return { sym, drivers, bull: ok.filter(d => d.vote > 0).length, bear: ok.filter(d => d.vote < 0).length, total: ok.length, updatedAt: new Date().toISOString() };
}

async function apiVix(req,res){
  try{
    const { value: payload, cached } = await cacheWrap('vix:india', TTL.vix, async () => {
      const {liveRaw}=await withTimeout(getPriceAndChange('^INDIAVIX'), 8000, 'India VIX price');
      return {vix:+liveRaw.toFixed(2),updatedAt:new Date().toISOString()};
    });
    send(res,{...payload,cached});
  }catch(e){err(res,e.message);}
}

/* ── /api/global — Gift Nifty, global indices, macro, IV Percentile, breadth ── */

/* Nifty 50 constituents for A/D + 52w breadth calculation. Excel + user's 4 missing names. */
const NIFTY50_STOCKS = [
  'RELIANCE.NS','HDFCBANK.NS','BHARTIARTL.NS','ICICIBANK.NS','SBIN.NS',
  'TCS.NS','BAJFINANCE.NS','LT.NS','HINDUNILVR.NS','INFY.NS',
  'SUNPHARMA.NS','MARUTI.NS','ADANIPORTS.NS','ITC.NS','AXISBANK.NS',
  'M&M.NS','KOTAKBANK.NS','NTPC.NS','ONGC.NS','TITAN.NS',
  'ADANIENT.NS','ULTRACEMCO.NS','HCLTECH.NS','JSWSTEEL.NS','BEL.NS',
  'BAJAJ-AUTO.NS','COALINDIA.NS','BAJAJFINSV.NS','POWERGRID.NS','NESTLEIND.NS',
  'TATASTEEL.NS','ASIANPAINT.NS','ETERNAL.NS','HINDALCO.NS','SHRIRAMFIN.NS',
  'WIPRO.NS','GRASIM.NS','EICHERMOT.NS','SBILIFE.NS','INDIGO.NS',
  'JIOFIN.NS','TMPV.NS','HDFCLIFE.NS','TATACONSUM.NS','DRREDDY.NS',
  'MAXHEALTH.NS','APOLLOHOSP.NS','CIPLA.NS','TRENT.NS','TECHM.NS',
];

const GLOBAL_LAST_GOOD = {};
async function apiGlobal(req,res){
  try {
    const { value: payload, cached } = await cacheWrap('global:all', TTL.global, async () => {
  const SYMBOLS = [
    /* Gift Nifty: Yahoo has NO direct ticker for NSE IFSC Gift Nifty futures.
       NSE IFSC data is not publicly distributed to Yahoo/Bloomberg free APIs.
       Every major broker (5paisa, Groww, Upstox, ICICI) uses ^NSEI as proxy.
       Gift Nifty tracks Nifty 50 spot within ±0.3% during market hours.
       Pre-market: it leads spot by ~15-50 pts (futures premium).
       We show Nifty spot (^NSEI) — this IS the correct Gift Nifty reference. */
    { key:'vix',        ticker:'^INDIAVIX', label:'India VIX',       cat:'india'  },
    { key:'niftySpot',  ticker:'^NSEI',     label:'Nifty 50',       cat:'india'  },
    { key:'bankNifty',  ticker:'^NSEBANK',  label:'Bank Nifty',     cat:'india'  },
    { key:'nasdaq',     ticker:'^IXIC',     label:'Nasdaq',          cat:'us'     },
    { key:'sp500',      ticker:'^GSPC',     label:'S&P 500',         cat:'us'     },
    { key:'dow',        ticker:'^DJI',      label:'Dow Jones',       cat:'us'     },
    { key:'nikkei',     ticker:'^N225',     label:'Nikkei 225',      cat:'asia'   },
    { key:'hangseng',   ticker:'^HSI',      label:'Hang Seng',       cat:'asia'   },
    { key:'dxy',        ticker:'DX-Y.NYB',  label:'DXY',             cat:'macro'  },
    { key:'us10y',      ticker:'^TNX',      label:'US 10yr Yield',   cat:'macro'  },
    { key:'wti',        ticker:'CL=F',      label:'WTI Crude',       cat:'macro'  },
    { key:'brent',      ticker:'BZ=F',      label:'Brent Crude',     cat:'macro'  },
    { key:'usdInr',     ticker:'USDINR=X',  label:'USD/INR',         cat:'macro'  },
    { key:'usvix',      ticker:'^VIX',      label:'CBOE VIX',        cat:'macro'  },
  ];

    /* All requests are queued at once, India VIX first: the Yahoo queue runs 4 at a time, so the time
       limit has to cover the wait in the queue too. The old 6 s per ticker (4 s for the VIX history), with
       breadth fetched afterwards, made India VIX time out on a cold start or while another page was
       loading - and the options idea then had no VIX for the 5 min the result was cached. */
    const vixHistP = withTimeout(safeFetch(() => yfChart('^INDIAVIX', '1d', '1y'), 1), 20000, 'India VIX history');
    vixHistP.catch(() => {});
    const resultsP = Promise.allSettled(
      SYMBOLS.map(s => withTimeout(safeFetch(() => getPriceAndChange(s.ticker), 1), 20000, s.ticker))
    );
    const breadthP = globalBreadth();
    const results = await resultsP;

    const data = {};
    SYMBOLS.forEach((s, i) => {
      if (results[i].status === 'fulfilled' && results[i].value && Number.isFinite(results[i].value.liveRaw)) {
        const { liveRaw, prevRaw, rawChg, rawPct } = results[i].value;
        data[s.key] = {
          label:s.label, cat:s.cat, ticker:s.ticker,
          price:+liveRaw.toFixed(2), prev:+prevRaw.toFixed(2),
          chg:+rawChg.toFixed(2), pct:+rawPct.toFixed(2), isUp:rawPct>=0,
        };
      } else {
        const reason = results[i].status === 'rejected' ? results[i].reason?.message : 'invalid price payload';
        data[s.key] = { label:s.label, cat:s.cat, ticker:s.ticker, error:true, reason };
      }
    });

    /* IV Percentile: % of trading days in past year where VIX was BELOW current VIX
       Formula: daysBelow / totalDays × 100
       Different from IV Rank which uses (cur-low)/(high-low)×100
       IVP=80% means options are more expensive than 80% of days this past year → SELL
       IVP=20% means options are cheaper than 80% of days this past year  → BUY       */
    let ivRankData = null;
    try {
      const vixHist = await vixHistP;
      const vixBars = parseBars(vixHist);
      /* Live India VIX missed: the daily history has the latest close. */
      if (data.vix?.error && vixBars.n > 1) {
        const last = vixBars.C[vixBars.n - 1], prev = vixBars.C[vixBars.n - 2], chg = last - prev;
        data.vix = { label:'India VIX', cat:'india', ticker:'^INDIAVIX', price:+last.toFixed(2), prev:+prev.toFixed(2), chg:+chg.toFixed(2), pct:+(chg / prev * 100).toFixed(2), isUp:chg >= 0, source:'daily close' };
      }
      if (vixBars.n > 10) {
        const allDays = vixBars.C.filter(v => v != null && v > 0);
        const curVix  = data.vix?.price || allDays[allDays.length - 1];
        const hi52    = Math.max(...allDays);
        const lo52    = Math.min(...allDays);
        /* TRUE IV Percentile */
        const daysBelow  = allDays.filter(v => v < curVix).length;
        const ivPct      = +(daysBelow / allDays.length * 100).toFixed(1);
        /* IV Rank kept for reference */
        const ivRank     = hi52 > lo52 ? +((curVix - lo52) / (hi52 - lo52) * 100).toFixed(1) : null;
        /* India VIX is already an ANNUALISED implied volatility (30-day horizon, quoted per year).
           Black-Scholes in /api/strategy expects annual sigma, so pass VIX through unchanged.
           The old VIX/sqrt(12) produced a monthly vol and understated premiums ~3.5x. */
        const autoIv     = curVix ? +(+curVix).toFixed(1) : null;
        ivRankData = {
          rank:         ivPct,           /* frontend uses .rank — now stores IV Percentile */
          ivPercentile: ivPct,
          ivRankValue:  ivRank,          /* old IV Rank formula, for reference */
          hi52w:  +hi52.toFixed(2),
          lo52w:  +lo52.toFixed(2),
          currentVix:   +curVix.toFixed(2),
          totalDays:    allDays.length,
          daysBelow,
          autoIvPct:    autoIv,
          signal: ivPct < 30 ? 'cheap' : ivPct > 70 ? 'expensive' : 'fair',
          label:  ivPct < 30
            ? `Cheap — cheaper than ${(100-ivPct).toFixed(0)}% of past year. Good to BUY options.`
            : ivPct > 70
            ? `Expensive — pricier than ${ivPct.toFixed(0)}% of past year. Good to SELL options.`
            : `Fair — mid-range (${ivPct}th percentile of past year)`,
        };
      }
    } catch {}
    data.ivRank = ivRankData;

    data.breadth = await breadthP;

    /* A ticker that still failed shows its last good value (up to 30 min old, marked stale) instead of
       nothing; whatever is missing or stale is listed in partial and the result is cached for 30 s only,
       so the next request picks up the prices the queue has fetched in the meantime. */
    const now = Date.now(), partial = [];
    for (const k of [...SYMBOLS.map(x => x.key), 'ivRank', 'breadth']) {
      const v = data[k];
      if (v && !v.error) { GLOBAL_LAST_GOOD[k] = { v, ts:now }; if (v.source === 'daily close') partial.push(k); continue; }
      const old = GLOBAL_LAST_GOOD[k];
      if (old && now - old.ts < 30 * 60e3) data[k] = { ...old.v, stale:true, staleAgeSec:Math.round((now - old.ts) / 1000) };
      partial.push(k);
    }
    return { ...data, partial, updatedAt: new Date().toISOString() };
    });
    if (!cached && payload.partial?.length) { const e = API_CACHE.get('global:all'); if (e) e.ts = Date.now() - TTL.global + 30e3; }
    send(res, { ...payload, cached });
  } catch(e) { err(res, e.message); }
}

/* Advance/decline and 52-week highs/lows from the Nifty 50 stocks (part of /api/global). */
async function globalBreadth() {
  /* ── MARKET BREADTH ──
     Compute Advance/Decline and 52-week H/L from Nifty 50 stocks.
     Fetch all 50 in parallel using quickprice-style 1d/5d chart.
     Each stock gives: chg (up/down), yearHigh, yearLow from meta.    */
  let breadthData = null;
  try {
    /* One light 5d chart per stock (was 2 calls incl. a full 1y history = 100 calls), each with its own
       timeout, so a few slow stocks no longer throw away the whole breadth result. 52w high/low come
       from Yahoo meta. */
    const breadthResults = await Promise.allSettled(
      NIFTY50_STOCKS.map(ticker => withTimeout((async () => {
        const r = await yfChart(ticker, '1d', '5d');
        const meta = r?.meta || {};
        const bars = parseBars(r);
        const n = bars.n;
        const liveRaw = firstValidNumber(meta.regularMarketPrice, n ? bars.C[n-1] : null);
        const liveTs = Number(meta.regularMarketTime);
        const lastIsToday = n && Number.isFinite(liveTs) && sameMarketDate(bars.T[n-1], liveTs, meta.exchangeTimezoneName || 'Asia/Kolkata');
        const prevRaw = firstValidNumber(meta.regularMarketPreviousClose, lastIsToday ? bars.C[n-2] : bars.C[n-1]);
        if (!liveRaw || !prevRaw) throw new Error('No breadth price');
        return { ticker, price:liveRaw, chg:liveRaw - prevRaw, prev:prevRaw, hi52:meta.fiftyTwoWeekHigh || null, lo52:meta.fiftyTwoWeekLow || null };
      })(), 20000, ticker + ' breadth'))
    );

    let advances=0, declines=0, unchanged=0, hi52Count=0, lo52Count=0;
    breadthResults.forEach(r => {
      if (r.status !== 'fulfilled') return;
      const { price, chg, prev, hi52, lo52 } = r.value;
      /* Unchanged band is relative (±0.05%), not a fixed ±₹0.10 that means nothing for a ₹3,000 stock. */
      const band = prev * 0.0005;
      if (chg > band)        advances++;
      else if (chg < -band)  declines++;
      else                   unchanged++;
      /* Within 0.5% of 52w high/low = at high/low */
      if (hi52 && price >= hi52 * 0.995) hi52Count++;
      if (lo52 && price <= lo52 * 1.005) lo52Count++;
    });

    const total = advances + declines + unchanged;
    if (!total) throw new Error('no breadth data');
    const adRatio = declines > 0 ? +(advances/declines).toFixed(2) : advances > 0 ? 99 : 1;
    const breadthSignal = adRatio > 2 ? 'strong-bull'
      : adRatio > 1.2 ? 'bull'
      : adRatio < 0.5 ? 'strong-bear'
      : adRatio < 0.8 ? 'bear'
      : 'neutral';

    breadthData = {
      advances, declines, unchanged,
      total, adRatio,
      sampled: breadthResults.filter(r => r.status === 'fulfilled').length,
      universe: NIFTY50_STOCKS.length,
      signal: breadthSignal,
      hi52Count, lo52Count,
      label: breadthSignal.includes('bull') ? 'Broad market advance — rally is real'
           : breadthSignal.includes('bear') ? 'Broad market decline — wide selling'
           : 'Mixed breadth — no clear direction',
      updatedAt: new Date().toISOString(),
    };
  } catch(e) { console.warn('Breadth fetch failed:', e.message); }
  return breadthData;
}

/* ── /api/search ── */
async function apiSearch(req,res,p){
  const q=(p.get('q')||'').trim();
  if(q.length<2){send(res,{results:[]});return;}
  try{send(res,{results:await searchStocks(q)});}catch(e){err(res,e.message);}
}

/* ── /api/health ── */
function apiHealth(req,res){send(res,{status:'ok',v:'1.0',time:new Date().toISOString(),usdInr:usdInrCache.rate,cacheSize:API_CACHE.size,outbound:outboundStats()});}


/* ── STATIC ── */
const fs=require('fs'),path=require('path');
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.ico':'image/x-icon',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.webmanifest':'application/manifest+json','.txt':'text/plain; charset=utf-8'};
/* ══════════════════════════════════════════════════════════════════════
   AUTH — Simple password gate. No signup. Cookie-based session.
   Set APP_PASSWORD in the environment (Render env vars, or APP_PASSWORD=... npm start locally).
   There is deliberately NO default password: a missing APP_PASSWORD disables login.
══════════════════════════════════════════════════════════════════════ */
const APP_VERSION  = '1.0';
const IS_PROD      = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || !!process.env.RENDER_EXTERNAL_URL || !!process.env.RENDER_SERVICE_ID;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const SESSION_TTL  = 7 * 24 * 60 * 60 * 1000; /* 7 days */
/* How many reverse proxies sit in front of the app (Render = 1). The client IP is the X-Forwarded-For
   entry that the LAST trusted proxy appended, i.e. counted from the RIGHT. The leftmost entry is
   whatever the client sent and must never be trusted. TRUST_PROXY_HOPS=0 -> use the socket address. */
const ON_RENDER = process.env.RENDER === 'true' || !!process.env.RENDER_EXTERNAL_URL || !!process.env.RENDER_SERVICE_ID;
const TRUST_PROXY_HOPS = /^\d+$/.test(String(process.env.TRUST_PROXY_HOPS || ''))
  ? +process.env.TRUST_PROXY_HOPS : (ON_RENDER ? 1 : 0);
const SESSIONS     = new Map(); /* token → expiry */

/* Login brute-force protection */
const LOGIN_ATTEMPTS = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
/* Backstop across ALL IPs: even with many addresses an attacker gets at most this many guesses per window. */
const LOGIN_GLOBAL_MAX = 100;
let LOGIN_GLOBAL = { count: 0, reset: Date.now() + LOGIN_WINDOW_MS };
function clientIp(req){
  const sock = String(req.socket.remoteAddress || '');
  if (!TRUST_PROXY_HOPS) return sock;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length >= TRUST_PROXY_HOPS ? xff[xff.length - TRUST_PROXY_HOPS] : sock;
}
function loginGlobalTripped(){
  const now = Date.now();
  if (now > LOGIN_GLOBAL.reset) LOGIN_GLOBAL = { count: 0, reset: now + LOGIN_WINDOW_MS };
  return LOGIN_GLOBAL.count >= LOGIN_GLOBAL_MAX;
}
function loginBlocked(ip){
  const now = Date.now();
  const item = LOGIN_ATTEMPTS.get(ip);
  if (!item) return false;
  if (now > item.reset) { LOGIN_ATTEMPTS.delete(ip); return false; }
  return item.count >= LOGIN_MAX_ATTEMPTS;
}
function recordLoginFail(ip){
  const now = Date.now();
  const item = LOGIN_ATTEMPTS.get(ip) || { count:0, reset: now + LOGIN_WINDOW_MS };
  if (now > item.reset) { item.count = 0; item.reset = now + LOGIN_WINDOW_MS; }
  item.count += 1;
  LOGIN_ATTEMPTS.set(ip, item);
  LOGIN_GLOBAL.count += 1;
}
/* Constant-time password check (fixed-length digests, so the password length is not leaked either). */
function passwordMatches(given){
  const crypto = require('crypto');
  const a = crypto.createHash('sha256').update(String(given || ''), 'utf8').digest();
  const b = crypto.createHash('sha256').update(APP_PASSWORD, 'utf8').digest();
  return APP_PASSWORD.length > 0 && crypto.timingSafeEqual(a, b);
}
function clearLoginFail(ip){ LOGIN_ATTEMPTS.delete(ip); }

/* Clean expired sessions every hour to prevent memory leak */
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of SESSIONS) {
    if (now > expiry) SESSIONS.delete(token);
  }
  for (const [ip, item] of LOGIN_ATTEMPTS) {
    if (now > item.reset) LOGIN_ATTEMPTS.delete(ip);
  }
}, 60 * 60 * 1000);

/* Signed session token "<expiry>.<random>.<hmac>": valid after a server restart (Render restarts used to log
   you out, because sessions lived only in memory). The key comes from APP_PASSWORD, so changing the password
   logs every device out. Logout revokes the token in memory and clears the cookie. */
/* Random secret for session signing and the Web Push key: APP_SECRET (Render generates it - render.yaml), else
   data/secret.key, created once. Deriving them from APP_PASSWORD let anyone holding one cookie (or the public push
   key sent to Google / Apple) test password guesses offline, past the login rate limit. */
const APP_SECRET = (() => {
  if (process.env.APP_SECRET && process.env.APP_SECRET.length >= 16) return process.env.APP_SECRET;
  const f = require('path').join(__dirname, 'data', 'secret.key');
  try { const v = require('fs').readFileSync(f, 'utf8').trim(); if (v.length >= 32) return v; } catch {}
  const v = require('crypto').randomBytes(32).toString('hex');
  try { require('fs').mkdirSync(require('path').dirname(f), { recursive: true }); require('fs').writeFileSync(f, v); } catch {}
  return v;
})();
/* Changing APP_PASSWORD still logs every device out: it is part of the signing key. */
const SESSION_HMAC_KEY = require('crypto').createHash('sha256').update('td-session-v2|' + APP_SECRET + '|' + APP_PASSWORD).digest();
const REVOKED_TOKENS = new Set();
function signSession(body) { return require('crypto').createHmac('sha256', SESSION_HMAC_KEY).update(body).digest('base64url'); }
function genToken() {
  const body = `${Date.now() + SESSION_TTL}.${require('crypto').randomBytes(12).toString('hex')}`;
  return `${body}.${signSession(body)}`;
}
function signedTokenValid(token) {
  const m = /^(\d{13})\.([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/.exec(token || '');
  if (!m || !APP_PASSWORD || REVOKED_TOKENS.has(token) || USER_STORE.revoked?.[token] || Date.now() > +m[1]) return false;
  const a = Buffer.from(m[3]), b = Buffer.from(signSession(`${m[1]}.${m[2]}`));
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

function getCookie(req, name) {
  const h = req.headers.cookie || '';
  const m = h.split(';').map(c=>c.trim()).find(c=>c.startsWith(name+'='));
  return m ? m.slice(name.length+1) : null;
}

function isAuthenticated(req) {
  const token = getCookie(req, 'td_session');
  if (!token) return false;
  if (signedTokenValid(token)) return true;
  const expiry = SESSIONS.get(token);
  if (!expiry || Date.now() > expiry) { SESSIONS.delete(token); return false; }
  /* Fixed 7-day session. The old server-side sliding expiry never refreshed the cookie's Max-Age,
     so the browser dropped the cookie after 7 days anyway; server and cookie now agree. */
  return true;
}

function loginPage(error) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TradeDesk — Login</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0a0a12;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
  .card{background:#12121e;border:1px solid #2a2a3a;border-radius:16px;padding:40px 36px;width:100%;max-width:380px;text-align:center}
  .logo{font-size:2rem;margin-bottom:8px}
  h1{color:#e0e0f0;font-size:1.4rem;font-weight:700;margin-bottom:4px}
  .sub{color:#5a5a7a;font-size:.82rem;margin-bottom:28px}
  input{width:100%;background:#1a1a2e;border:1px solid #2a2a3a;border-radius:10px;padding:12px 16px;color:#e0e0f0;font-size:1rem;outline:none;margin-bottom:14px;transition:border .2s}
  input:focus{border-color:#00bcd4}
  button{width:100%;background:#00bcd4;border:none;border-radius:10px;padding:13px;color:#000;font-size:1rem;font-weight:800;cursor:pointer;transition:opacity .2s}
  button:hover{opacity:.9}
  .err{background:rgba(255,23,68,.1);border:1px solid rgba(255,23,68,.3);border-radius:8px;color:#ff1744;font-size:.8rem;padding:10px 14px;margin-bottom:14px}
  .private{color:#3a3a5a;font-size:.72rem;margin-top:18px}
</style>
</head><body>
<div class="card">
  <div class="logo">📊</div>
  <h1>TradeDesk</h1>
  <div class="sub">TradeDesk v1.0 · Private access</div>
  ${error ? `<div class="err">❌ ${error}</div>` : ''}
  <form method="POST" action="/auth/login">
    <input type="password" name="password" placeholder="Enter password" autofocus autocomplete="current-password">
    <button type="submit">Sign in →</button>
  </form>
  <div class="private">🔒 Private access only — no signup</div>
</div>
</body></html>`;
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '', done = false;
    const finish = v => { if (!done) { done = true; resolve(v); } };
    req.on('data', c => {
      body += c;
      /* Oversized body: answer with an empty form instead of destroying the socket and hanging forever. */
      if (body.length > 1000) { finish({}); body = ''; req.removeAllListeners('data'); req.resume(); }
    });
    req.on('end', () => finish(Object.fromEntries(new URLSearchParams(body))));
    req.on('error', () => finish({}));
    req.on('close', () => finish({}));
  });
}

function staticFile(req,res,fp){
  const publicRoot = path.resolve(__dirname, 'public');
  const safePath = path.resolve(fp);
  if (safePath !== publicRoot && !safePath.startsWith(publicRoot + path.sep)) {
    res.writeHead(403, {'Content-Type':'text/plain; charset=utf-8'}); res.end('403'); return;
  }
  const mime=MIME[path.extname(safePath)]||'text/plain; charset=utf-8';
  /* Each file is read and gzipped once per change (by mtime), not on every request, and gets an ETag: the
     browser revalidates (Cache-Control no-cache) and a repeat visit gets "304 Not Modified" for every file
     instead of downloading ~900 KB again. Edits to a file show up on the next load. */
  fs.stat(safePath,(se,st)=>{
    if(se || !st.isFile()){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('404');return;}
    const hit = STATIC_CACHE.get(safePath);
    const serve = ent => {
      const hdr = {'Content-Type':mime,'Cache-Control':'no-cache','ETag':ent.etag,'Vary':'Accept-Encoding'};
      if (String(req.headers['if-none-match'] || '') === ent.etag) { res.writeHead(304, hdr); res.end(); return; }
      const useGz = ent.gz && String(req.headers['accept-encoding'] || '').includes('gzip');
      res.writeHead(200, useGz ? {...hdr,'Content-Encoding':'gzip'} : hdr);
      res.end(useGz ? ent.gz : ent.raw);
    };
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return serve(hit);
    fs.readFile(safePath,(e,d)=>{
      if(e){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('404');return;}
      const ent = { mtime: st.mtimeMs, size: st.size, raw: d, gz: null, etag: '"' + require('crypto').createHash('sha1').update(d).digest('base64url').slice(0, 16) + '"' };
      const done = () => { STATIC_CACHE.set(safePath, ent); serve(ent); };
      if (/text|javascript|json|svg|css|html|manifest/i.test(mime) && d.length > 1024) zlib.gzip(d, { level: 9 }, (ze, gz) => { if (!ze) ent.gz = gz; done(); });
      else done();
    });
  });
}
const STATIC_CACHE = new Map();

/* ══════════════════════════════════════════════════════════════════
   PERSONAL DATA SYNC + BACKGROUND ALERTS - free: no database, no push-service account, no API key.
   - Sync: alerts, Track Record, calculator settings, recent stocks and MCX calibrations are kept in
     data/user-store.json, newest copy wins per key, so laptop and phone see the same data. On a host whose
     disk resets (Render free), any browser that still has the data uploads it again on its next visit.
   - Web Push (VAPID, RFC 8291) straight from Node's crypto: alerts reach the phone with the app closed.
     The VAPID key is derived from APP_SECRET, so it stays the same across restarts.
   - Server alert engine (every minute in market hours), scheduled screener scans (09:25 and 15:15 IST)
     and, on Render, a self-ping that keeps the free instance awake during trading hours.
══════════════════════════════════════════════════════════════════ */
const nodeCrypto = require('crypto');
const STORE_FILE = path.join(__dirname, 'data', 'user-store.json');
const STORE_KEY_RE = /^(td_alerts|tradedesk_forward_test_v2|td_pos_capital|td_pos_risk_pct|td_recent_stocks|td_mcx_cal2_[A-Z0-9:_-]{1,40})$/;
const STORE_MAX_BYTES = 1500000;
let USER_STORE = { keys: {}, subs: [], scans: {}, revoked: {} };
try { const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); USER_STORE = { keys: j.keys || {}, subs: j.subs || [], scans: j.scans || {}, revoked: j.revoked || {} }; } catch {}
let STORE_SAVE_TIMER = null;
function saveStore() {
  clearTimeout(STORE_SAVE_TIMER);
  STORE_SAVE_TIMER = setTimeout(() => {
    try { fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true }); fs.writeFileSync(STORE_FILE, JSON.stringify(USER_STORE)); }
    catch (e) { console.warn('User store save failed:', e.message); }
  }, 400);
}
function readJsonBody(req, limit = STORE_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}
/* Every accepted change is stamped with the SERVER's clock (phones and PCs drift; a device whose clock ran
   ahead used to make later edits from other devices look older and get dropped). Devices send only the keys
   they changed since their last sync, so the last change to reach the server wins. */
function mergeStoreKeys(incoming) {
  const next = { ...USER_STORE.keys }, changed = [], now = Date.now();
  for (const [k, x] of Object.entries(incoming || {})) {
    if (!STORE_KEY_RE.test(k) || !x) continue;
    next[k] = { v: x.v == null ? null : String(x.v), t: Math.max(now, (+next[k]?.t || 0) + 1) }; changed.push(k);
  }
  if (JSON.stringify(next).length > STORE_MAX_BYTES) throw new Error('Stored data is over 1.5 MB');
  if (changed.length) { USER_STORE.keys = next; saveStore(); }
  return changed;
}
async function apiStore(req, res) {
  if (req.method === 'GET') return send(res, { keys: USER_STORE.keys, serverTime: Date.now() });
  if (req.method !== 'POST') return err(res, 'Use GET or POST', 405);
  try { const b = await readJsonBody(req); const changed = mergeStoreKeys(b.keys); send(res, { ok: true, changed, keys: USER_STORE.keys, serverTime: Date.now() }); }
  catch (e) { err(res, e.message, 400); }
}

/* ── Web Push ── */
const b64u = b => Buffer.from(b).toString('base64url');
const VAPID = (() => {
  if (!APP_PASSWORD) return null;
  try {
    const d = Buffer.from(nodeCrypto.hkdfSync('sha256', Buffer.from(APP_SECRET), Buffer.from('tradedesk-vapid-v2'), Buffer.from('p256 private key'), 32));
    const ecdh = nodeCrypto.createECDH('prime256v1'); ecdh.setPrivateKey(d);
    const pub = ecdh.getPublicKey();
    const key = nodeCrypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
    return { key, pub: b64u(pub) };
  } catch (e) { console.warn('Web Push disabled:', e.message); return null; }
})();
function webPush(sub, payload) {
  return new Promise(resolve => {
    try {
      const ua = Buffer.from(sub.keys.p256dh, 'base64url'), auth = Buffer.from(sub.keys.auth, 'base64url');
      const eph = nodeCrypto.createECDH('prime256v1'); eph.generateKeys();
      const asPub = eph.getPublicKey(), shared = eph.computeSecret(ua);
      const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', shared, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPub]), 32));
      const salt = nodeCrypto.randomBytes(16);
      const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
      const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
      const c = nodeCrypto.createCipheriv('aes-128-gcm', cek, nonce);
      const enc = Buffer.concat([c.update(Buffer.concat([Buffer.from(JSON.stringify(payload)), Buffer.from([2])])), c.final(), c.getAuthTag()]);
      const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
      const body = Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, enc]);
      const u = new URL(sub.endpoint);
      const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
      const claims = b64u(JSON.stringify({ aud: u.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: process.env.RENDER_EXTERNAL_URL || 'mailto:tradedesk@example.com' }));
      const sig = nodeCrypto.sign('sha256', Buffer.from(`${head}.${claims}`), { key: VAPID.key, dsaEncoding: 'ieee-p1363' });
      const r = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'POST', timeout: 10000,
        headers: { TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
          Authorization: `vapid t=${head}.${claims}.${b64u(sig)}, k=${VAPID.pub}` } }, x => { x.resume(); x.on('end', () => resolve(x.statusCode)); });
      r.on('timeout', () => { r.destroy(); resolve(0); });
      r.on('error', () => resolve(0));
      r.end(body);
    } catch (e) { console.warn('Web Push send failed:', e.message); resolve(0); }
  });
}
async function pushAll(payload) {
  if (!VAPID || !USER_STORE.subs.length) return { sent: 0, devices: 0 };
  let sent = 0;
  const keep = [];
  for (const sub of USER_STORE.subs) {
    const st = await webPush(sub, payload);
    if (st >= 200 && st < 300) sent++;
    if (st !== 404 && st !== 410) keep.push(sub); else console.warn('Push subscription expired - removed');
  }
  if (keep.length !== USER_STORE.subs.length) { USER_STORE.subs = keep; saveStore(); }
  return { sent, devices: USER_STORE.subs.length };
}
async function apiPush(req, res, pn) {
  if (pn === '/api/push/key') return send(res, { enabled: !!VAPID, publicKey: VAPID ? VAPID.pub : null, devices: USER_STORE.subs.length });
  if (req.method !== 'POST') return err(res, 'Use POST', 405);
  if (!VAPID) return err(res, 'Web Push needs APP_PASSWORD on the server', 400);
  try {
    if (pn === '/api/push/subscribe') {
      const { subscription: sub } = await readJsonBody(req, 8000);
      if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) return err(res, 'Bad subscription', 400);
      USER_STORE.subs = USER_STORE.subs.filter(x => x.endpoint !== sub.endpoint).concat([{ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, ts: Date.now() }]).slice(-10);
      saveStore();
      return send(res, { ok: true, devices: USER_STORE.subs.length });
    }
    if (pn === '/api/push/test') return send(res, await pushAll({ title: 'TradeDesk test alert', body: 'Background alerts work on this device - even with TradeDesk closed.', tag: 'td-test', url: '/' }));
    err(res, 'Not found', 404);
  } catch (e) { err(res, e.message, 400); }
}

/* ── Server alert engine (market hours, every minute) ── */
function istNowParts() { const t = new Date(Date.now() + 5.5 * 3600000); return { d: t.getUTCDay(), m: t.getUTCHours() * 60 + t.getUTCMinutes(), key: t.toISOString().slice(0, 10) }; }
function symMarketOpenS(sym) {
  const { d, m, key } = istNowParts();
  if (d < 1 || d > 5) return false;
  if (/^MCX:/.test(sym)) return m >= 9 * 60 && m <= 23 * 60 + 55;
  return !isNseHoliday(key) && m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}
function storeAlerts() { try { const a = JSON.parse(USER_STORE.keys.td_alerts?.v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } }
const alertId = a => a.id || `${a.sym}|${a.type}|${a.value}`;
let ALERT_TICK_RUNNING = false;
async function serverAlertTick() {
  if (ALERT_TICK_RUNNING) return;
  const active = storeAlerts().filter(a => a && !a.triggered && a.sym && Number.isFinite(+a.value) && symMarketOpenS(String(a.sym).toUpperCase()));
  if (!active.length) return;
  ALERT_TICK_RUNNING = true;
  try {
    const hits = new Map();
    for (const sym of [...new Set(active.map(a => String(a.sym).toUpperCase()))]) {
      let q; try { q = await quickPriceFor(sym); } catch { continue; }
      const p = +q?.price, pct = +q?.pct;
      if (!(p > 0)) continue;
      for (const a of active.filter(x => String(x.sym).toUpperCase() === sym)) {
        const v = +a.value;
        const hit = a.type === 'above' ? p >= v : a.type === 'below' ? p <= v
          : a.type === 'pct_up' ? (Number.isFinite(pct) && pct >= v) : a.type === 'pct_down' ? (Number.isFinite(pct) && pct <= -v) : false;
        if (!hit) continue;
        const px = n => (/^NSE:(NIFTY|BANKNIFTY|FINNIFTY)/.test(sym) ? '' : '₹') + (+n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
        const cond = a.type === 'above' ? `above ${px(v)}` : a.type === 'below' ? `below ${px(v)}` : a.type === 'pct_up' ? `up ${v}%+` : `down ${v}%+`;
        hits.set(alertId(a), { at: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) });
        await pushAll({ title: `🔔 ${sym.replace(/^(NSE|MCX):/, '')} ${cond}`, body: `Now ${px(p)} (${pct >= 0 ? '+' : ''}${Number.isFinite(pct) ? pct : '--'}% today)`, tag: `alert-${alertId(a)}`, url: '/' });
      }
    }
    if (hits.size) {
      /* Re-read before writing, so an alert the user added while prices were fetched is not lost. */
      const fresh = storeAlerts();
      fresh.forEach(a => { const h = hits.get(alertId(a)); if (h && !a.triggered) { a.triggered = true; a.triggeredAt = h.at; a.triggeredBy = 'server'; } });
      USER_STORE.keys.td_alerts = { v: JSON.stringify(fresh), t: Date.now() };
      saveStore();
    }
  } finally { ALERT_TICK_RUNNING = false; }
}

/* ── Scheduled screener scans: 09:25 (after the opening noise) and 15:15 (before the close) IST ── */
const SCAN_TIMES_IST = [9 * 60 + 25, 15 * 60 + 15];
async function scheduledScanTick() {
  const { d, m, key } = istNowParts();
  if (d < 1 || d > 5 || isNseHoliday(key)) return;
  const slot = SCAN_TIMES_IST.find(t => m >= t && m < t + 20);
  if (slot == null || USER_STORE.scans[`${key}|${slot}`]) return;
  USER_STORE.scans = { [`${key}|${slot}`]: Date.now() };   /* keep only the latest marker */
  saveStore();
  let data = MY_TRADE_SCREENER_CACHE && Date.now() - MY_TRADE_SCREENER_TS < 20 * 60 * 1000 ? MY_TRADE_SCREENER_CACHE : null;
  if (!data) {
    if (!MY_TRADE_SCREENER_INFLIGHT) MY_TRADE_SCREENER_INFLIGHT = runMyTradeScreenerScan().finally(() => { MY_TRADE_SCREENER_INFLIGHT = null; });
    data = await MY_TRADE_SCREENER_INFLIGHT;
  }
  const ready = (data.picks || []).map(x => x.sym), limits = (data.watchlist || []).filter(x => x.limitReady && x.limitEntry);
  const body = [ready.length ? `READY: ${ready.join(', ')}` : 'No READY stock',
    limits.length ? `Ready on limit: ${limits.map(x => `${x.sym} ₹${x.limitEntry.price}`).join(', ')}` : '',
    (data.quickBounce || []).length ? `Quick bounce: ${data.quickBounce.slice(0, 6).map(x => x.sym).join(', ')}` : ''].filter(Boolean).join(' · ');
  await pushAll({ title: `TradeDesk ${slot < 12 * 60 ? 'morning' : 'closing'} scan`, body, tag: 'td-scan', url: '/' });
}

setInterval(() => {
  serverAlertTick().catch(e => console.warn('Alert engine:', e.message));
  scheduledScanTick().catch(e => console.warn('Scheduled scan:', e.message));
}, 60 * 1000);

/* Render free sleeps after ~15 idle minutes, which stops the alert engine and the scheduled scans - and a sleeping
   process runs no timers, so it cannot wake itself (an overnight pause meant no 09:25 scan). A request to its own
   public address every 10 minutes, around the clock, keeps it awake: ~744 h a month, inside the 750 free hours
   (if no other free Render service shares them). */
if (ON_RENDER && process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    https.get(process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '') + '/auth/login', r => r.resume()).on('error', () => {});
  }, 10 * 60 * 1000);
}

/* ── SERVER ── */
const server=http.createServer((req,res)=>{
  /* Any unexpected throw in a handler becomes a 500 for that request instead of an unhandled
     rejection that terminates the process. */
  handleRequest(req,res).catch(e=>{
    console.error('Request failed:', req.url, e && e.message);
    try { if(!res.headersSent) res.writeHead(500,{'Content-Type':'text/plain; charset=utf-8'}); res.end('500'); } catch {}
  });
});
async function handleRequest(req,res){
  const par=url.parse(req.url,true),pn=par.pathname,ps=new URLSearchParams(par.query);

  /* ── AUTH ROUTES (no session needed) ── */
  if (req.method==='OPTIONS'){res.writeHead(204,CORS);res.end();return;}

  /* Login page */
  if (pn==='/auth/login' && req.method==='GET') {
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end(loginPage());
    return;
  }

  /* Login POST — verify password */
  if (pn==='/auth/login' && req.method==='POST') {
    if (!APP_PASSWORD) {
      res.writeHead(500,{'Content-Type':'text/html'});
      res.end(loginPage('APP_PASSWORD is not set on the server. Set it in the environment and restart.'));
      return;
    }
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      res.writeHead(429,{'Content-Type':'text/html'});
      res.end(loginPage('Too many wrong attempts. Try again after 15 minutes.'));
      return;
    }
    const body = await parseBody(req);
    /* Under a distributed guessing flood every attempt is slowed down, but a correct password still
       works - a hard global block would let an attacker lock the owner out indefinitely. */
    if (loginGlobalTripped()) await new Promise(r => setTimeout(r, 2000));
    if (passwordMatches(body.password)) {
      clearLoginFail(ip);
      const token  = genToken();
      const expiry = Date.now() + SESSION_TTL;
      SESSIONS.set(token, expiry);
      const secureCookie = IS_PROD ? '; Secure' : '';
      res.writeHead(302, {
        'Location': '/',
        'Set-Cookie': `td_session=${token}; HttpOnly; SameSite=Lax${secureCookie}; Max-Age=${SESSION_TTL/1000}; Path=/`,
      });
      res.end();
    } else {
      recordLoginFail(ip);
      res.writeHead(200,{'Content-Type':'text/html'});
      res.end(loginPage('Wrong password. Try again.'));
    }
    return;
  }

  /* Logout - POST only, so a third-party page or <img src> cannot log the user out (cookie is SameSite=Lax). */
  if (pn==='/auth/logout' && req.method!=='POST') {
    res.writeHead(405, {'Allow':'POST','Content-Type':'text/plain; charset=utf-8'});
    res.end('405 Method Not Allowed - use POST');
    return;
  }
  if (pn==='/auth/logout') {
    const token = getCookie(req, 'td_session');
    if (token) {
      SESSIONS.delete(token); REVOKED_TOKENS.add(token);
      /* Saved, so a logged-out token stays dead after a restart (expired entries are dropped). */
      const now = Date.now(), exp = +String(token).split('.')[0] || now + SESSION_TTL;
      USER_STORE.revoked = Object.fromEntries(Object.entries(USER_STORE.revoked || {}).filter(([, e]) => e > now).concat([[token, exp]]));
      saveStore();
    }
    res.writeHead(302, {
      'Location': '/auth/login',
      'Set-Cookie': 'td_session=; HttpOnly; Max-Age=0; Path=/',
    });
    res.end();
    return;
  }

  /* ── AUTH GUARD — all other routes require session ── */
  if (!isAuthenticated(req)) {
    if (pn.startsWith('/api/')) {
      res.writeHead(401,CORS);
      res.end(JSON.stringify({error:'Unauthorized — please login at /auth/login'}));
    } else {
      res.writeHead(302,{'Location':'/auth/login'});
      res.end();
    }
    return;
  }

  /* ── PROTECTED ROUTES ── */
  if(pn==='/api/quote')            return apiQuote(req,res,ps);
  if(pn==='/api/quickprice')       return apiQuick(req,res,ps);
  if(pn==='/api/news')             return apiNews(req,res,ps);
  if(pn==='/api/vix')              return apiVix(req,res);
  if(pn==='/api/mcx-drivers')      return apiMcxDrivers(req,res,ps);
  if(pn==='/api/global')           return apiGlobal(req,res);
  if(pn==='/api/search')           return apiSearch(req,res,ps);
  if(pn==='/api/health')           return apiHealth(req,res);
  if(pn==='/api/strategy/list')    return apiStrategyList(req,res);
  if(pn==='/api/strategy')         return apiStrategy(req,res,ps);
  /* Old screener endpoints are intentionally routed to the new one-scan Ready/Watchlist engine.
     This prevents stale old scanner logic from being used by bookmarks, cached UI, or old buttons. */
  if(pn==='/api/screener')         return apiMyTradeScreener(req,res);
  if(pn==='/api/qualified-screener') return apiMyTradeScreener(req,res);
  if(pn==='/api/my-trade-screener') return apiMyTradeScreener(req,res);
  if(pn==='/api/calendar')         return apiCalendar(req,res);
  if(pn==='/api/earnings')         return apiEarnings(req,res,ps);
  if(pn==='/api/sectors')          return apiSectors(req,res);
  if(pn==='/api/swing-context')    return apiSwingContext(req,res,ps);
  if(pn==='/api/option-chain')     return apiOptionChain(req,res,ps);
  if(pn==='/api/store')            return apiStore(req,res);
  if(pn==='/api/backtest')         return apiBacktest(req,res,ps);
  if(pn.startsWith('/api/push/'))  return apiPush(req,res,pn);
  if(pn==='/api/screener-explain') return apiScreenerExplain(req,res,ps);
  if(pn==='/api/screener-diag') return send(res, LAST_SCAN_DIAG);
  if(pn==='/api/sector-map') {
    const map = {}; Object.entries(LIVE_UNIVERSE?.industry || {}).forEach(([k, v]) => { if (v.sector) map[k] = v.sector; });
    return send(res, { count: Object.keys(map).length, source: LIVE_UNIVERSE?.source || null, map });
  }
  if(pn==='/api/universe') {
    if (ps.get('refresh') === '1') { refreshUniverse(true); return send(res, { ...universeSummary(), refreshing:true, rows:LIVE_UNIVERSE?.rows || [] }); }
    return send(res, { ...universeSummary(), refreshing: !!UNIVERSE_INFLIGHT, rows: liveUniverseUsable() ? LIVE_UNIVERSE.rows : [] });
  }
  const publicRoot = path.join(__dirname,'public');
  let relPath;
  try {
    relPath = (pn==='/'||pn==='/index.html') ? 'index.html' : decodeURIComponent(pn).replace(/^\/+/, '');
    /* A NUL byte makes fs.readFile throw synchronously, which used to crash the whole process. */
    if (relPath.includes('\0')) throw new Error('bad path');
  } catch {
    res.writeHead(400, {'Content-Type':'text/plain; charset=utf-8'});
    res.end('400 Bad Request');
    return;
  }
  const fp=path.resolve(publicRoot, relPath);
  staticFile(req,res,fp);
}

server.listen(PORT,()=>{
  console.log(`TradeDesk v1.0 on port ${PORT}`);
  /* Live screener universe: load the saved one; rebuilt in the background when older than 7 days. */
  loadUniverseFromDisk();
  setTimeout(() => refreshUniverse(false), 5000);
  setInterval(() => refreshUniverse(false), 6 * 60 * 60 * 1000);
  console.log(`Password auth: ${APP_PASSWORD ? '✅ APP_PASSWORD set' : '❌ APP_PASSWORD missing - login disabled. Start with APP_PASSWORD=... npm start'}`);
  getRate().then(r=>console.log(`USD/INR: ${r}`)).catch(e=>console.warn('USD/INR at start-up:', e.message));
});
