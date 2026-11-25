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
/* ── Data-source context ──
   Stock charts come from Yahoo. The "Yahoo vs Kite" screener comparison that ran a second scan in a 'kite' context
   was removed on 20 Nov 2026 (and Kite itself on 25 Nov 2026); the per-source store below stays (always 'yahoo') so
   the screener code is unchanged. */
const SRC_ALS = new (require('async_hooks').AsyncLocalStorage)();
const dataSrc = () => (SRC_ALS.getStore() && SRC_ALS.getStore().src) || 'yahoo';
const srcStoreInit = () => ({ MY_TRADE_SCREENER_CACHE: null, MY_TRADE_SCREENER_TS: 0, MY_TRADE_SCREENER_INFLIGHT: null, NIFTY_REGIME_CACHE: null, NIFTY_REGIME_TS: 0,
  NIFTY_CLOSES: null, LAST_BREADTH: null, LAST_SECTOR_STRENGTH: null, LAST_SCAN_DIAG: { ts: 0, rows: [] } });
const SRCV = { yahoo: srcStoreInit() };
const SV = () => SRCV[dataSrc()];
/* Chart requests, shown on the Data source card: served, failed, average time. */
const srcStatInit = () => ({ charts: 0, ok: 0, failed: 0, ms: 0, fallbacks: 0, quoteCalls: 0, histCalls: 0, lastFallbacks: [] });
const SRC_STATS = { since: new Date().toISOString(), yahoo: srcStatInit() };
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
/* Files uploaded through the GitHub web page land at the TOP of the repository (its file picker cannot keep
   folders), while the page keeps loading the old copies in public/ - on 13 Nov 2026 the phone kept the old header
   and pull-to-refresh after an "upload". List such loose copies; the page shows a warning while any exist. */
const STRAY_PUBLIC_FILES = (() => {
  const fs0 = require('fs'), p0 = require('path'), names = new Set();
  const walk = d => { try { for (const e of fs0.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(p0.join(d, e.name)); else names.add(e.name); } } catch {} };
  walk(p0.join(__dirname, 'public'));
  let top = []; try { top = fs0.readdirSync(__dirname).filter(f => names.has(f) && fs0.statSync(p0.join(__dirname, f)).isFile()); } catch {}
  if (top.length) console.warn(`Housekeeping: ${top.length} loose copies of page files at the top of the repository (${top.slice(0, 8).join(', ')}${top.length > 8 ? ' ...' : ''}) - not used; the app serves public/. Remove them with upload-to-github.ps1.`);
  return top;
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
  /* Angel One SmartAPI: 1 quote request a second (Angel One's limit), one at a time */
  { re: { test: h => { try { return h === new URL(ANGEL.api).hostname; } catch { return false; } } }, max: 1, gapMs: 1100, key: 'angel' },
  /* All NSE addresses share one queue: NSE moved www.nseindia.com to www.nseindia.in on 14 Nov 2026, and the .in
     host had fallen into the generic bucket (2 at a time, 0.5 s apart) - the bursts NSE's bot protection blocks. */
  { re: /(^|\.)nseindia\.(com|in|co\.in|org)$/i, max: 1, gapMs: 2000, key: 'nse' },
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
function get(targetUrl, extraHdrs = {}, body = null, method = 'GET', queueHost = null) {
  const host = queueHost || new URL(targetUrl).hostname;   /* queueHost: a named queue instead of the URL's host */
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
    for (const k of Object.keys(hdrs)) if (hdrs[k] == null) delete hdrs[k];   /* null = leave this default header out */
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
      stream.on('end', () => { const buf = Buffer.concat(chunks); done(resolve, { status: res.statusCode, headers: res.headers, body: buf.toString('utf8'), buf }); });
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

/* NSE's website address. On 14 Nov 2026 NSE moved www.nseindia.com to www.nseindia.in (every old URL answers 301),
   which stopped the option chain, index values, results / holiday / corporate-action lists and FII / DII. The
   address is a variable: when NSE answers with a redirect to another www.nseindia.* host, the app switches to it
   (nseFollowMove) and retries, so a future move does not break it again. NSE_WWW in the environment overrides it. */
let NSE_WWW = String(process.env.NSE_WWW || 'https://www.nseindia.in').replace(/\/$/, '');
function nseFollowMove(r) {
  if (!r || ![301, 302, 307, 308].includes(r.status)) return false;
  let loc; try { loc = new URL(r.headers?.location || '', NSE_WWW); } catch { return false; }
  if (!/^www\.nseindia\.(com|in|co\.in|org)$/i.test(loc.hostname) || loc.protocol !== 'https:' || loc.origin === NSE_WWW) return false;
  console.warn(`NSE moved: ${NSE_WWW} -> ${loc.origin}`);
  NSE_WWW = loc.origin;
  return true;
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
  const st = SRC_STATS.yahoo, t0 = Date.now(); st.charts++;
  try { const v = await yfChartYahoo(ticker, interval, range); st.ok++; st.ms += Date.now() - t0; return v; }
  catch (e) { st.failed++; throw e; }
}
async function yfChartYahoo(ticker, interval, range) {
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
  /* Futures (NG=F, GC=F ...): the previous close is the daily bar before the live session's bar. Yahoo's
     previousClose for them is not stable - on 9 Nov 2026 NG=F's said 3.533 in one answer and 2.998 (the real
     6 Nov close) minutes later, which showed natural gas at -11% on a +4% day. */
  if (/=F$/.test(String(meta?.symbol || '')) && dn >= 2) {
    const tzF = meta?.exchangeTimezoneName || 'America/New_York';
    const lastIsLive = sameMarketDate(daily.T?.[dn - 1], meta?.regularMarketTime, tzF) || Math.abs(daily.C[dn - 1] - liveRaw) <= liveRaw * 1e-4;
    const p = lastIsLive ? daily.C[dn - 2] : daily.C[dn - 1];
    /* Contract roll: Yahoo's continuous future switches to the next month on one day, and its daily bars before that
       day are the OLD contract. On 20 Nov 2026 NG=F went from December (19 Nov close 3.268) to January (3.681), so
       natural gas showed +11.6% on a -0.2% day; CL=F the same (-2.0% instead of -0.4%). The intraday chart's previous
       close is the new contract's, so when the two disagree the one nearer the live price is the same contract.
       (9 Nov 2026 was the opposite case - a wrong previousClose - and the bar is nearer there.) */
    const ip = firstValidNumber(intraMeta?.chartPreviousClose, intraMeta?.previousClose, intraMeta?.regularMarketPreviousClose);
    if (p > 0 && ip > 0 && Math.abs(ip / p - 1) > 0.005 && Math.abs(liveRaw - ip) < Math.abs(liveRaw - p))
      return { liveRaw, prevRaw: ip, roll: { ratio: ip / p, oldPrev: p, newPrev: ip, prevBarT: +daily.T[lastIsLive ? dn - 2 : dn - 1], liveBarT: lastIsLive ? +daily.T[dn - 1] : null } };
    if (p > 0) return { liveRaw, prevRaw: p, prevBarT: +daily.T[lastIsLive ? dn - 2 : dn - 1] };
  }
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
    if (before.length) {
      const barPrev = lastClose[before[before.length - 1]], barPrev2 = before.length > 1 ? lastClose[before[before.length - 2]] : null;
      /* Yahoo's bars skip special sessions (Diwali Muhurat on Sunday 8 Nov 2026), while its previousClose has
         them: on 9 Nov every stock's change was measured from Friday's close (GAIL +1.19% instead of NSE's +1.78%).
         previousClose is kept unless it is the LAGGING kind seen on 29 Oct - equal to the close one session before
         the bars' last one - or implausibly far from the bars. */
      const lagging = barPrev2 != null && metaPrev != null && Math.abs(metaPrev - barPrev2) <= barPrev2 * 1e-5;
      const plausible = metaPrev > 0 && Math.abs(metaPrev - barPrev) <= barPrev * 0.15;
      prevRaw = plausible && !lagging ? metaPrev : barPrev;
    }
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
  const roll = picked.roll ? noteFutRoll(ticker, picked.roll, marketTime) : null;
  if (!picked.roll && picked.prevBarT > 0) dropFutRoll(ticker, picked.prevBarT);   /* no gap now: a roll noted from a bad quote is dropped */
  /* Last few daily closes for the list's mini chart (already fetched: no extra call); old-contract bars scaled. */
  const spark = futRollAdjust(ticker, daily).C.slice(-6).map(Number).filter(v => v > 0);
  if (spark.length && liveRaw > 0) { if (sameMarketDate(daily.T?.[dn - 1], marketTime, dailyMeta.exchangeTimezoneName || 'Asia/Kolkata')) spark[spark.length - 1] = liveRaw; else spark.push(liveRaw); }
  /* Roll day: Yahoo's day open (and sometimes high / low) can still be the old contract's - 299.66 against a 339 price. */
  const fx = v => futRollLevel(v, roll || picked.roll);   /* today's levels: the roll seen in this answer, confirmed or not */
  return { liveRaw, prevRaw, rawChg, rawPct, todayOpen: fx(todayOpen), todayHigh: fx(todayHigh), todayLow: fx(todayLow), todayVol, changeBasis, basisTime, marketTime, spark: spark.slice(-6), roll };
}

/* Futures contract rolls seen by this server: ticker -> [{ at: unix s of the first new-contract daily bar, ratio }].
   Bars before 'at' are scaled by ratio (new / old contract) so EMAs, levels and today's candle are one contract -
   without it the roll day looked like a +12% natural gas breakout. Kept 40 days in data/fut-rolls.json (a deploy
   wipes it; the roll day itself is always detected again from Yahoo's previous close). */
const FUT_ROLL_FILE = require('path').join(__dirname, 'data', 'fut-rolls.json');
let FUT_ROLLS = {};
try { FUT_ROLLS = JSON.parse(require('fs').readFileSync(FUT_ROLL_FILE, 'utf8')) || {}; } catch {}
/* A roll is kept only when it is seen again 10+ minutes later with the same size (Yahoo's previous close for a future
   can be wrong for a few minutes - NG=F on 9 Nov 2026), and dropped when a later answer shows no gap. 'at' = one second
   after the old contract's last daily bar: every bar up to it is scaled, the roll-day bar never is. 'dayT' = a time on
   the roll day, for the week / month the roll falls in. */
function noteFutRoll(ticker, roll, marketTime) {
  if (!roll || !(roll.ratio > 0) || !(roll.prevBarT > 0)) return null;
  const at = roll.prevBarT + 1, dayT = roll.liveBarT || (Number(marketTime) > 0 ? Number(marketTime) : Math.floor(Date.now() / 1000));
  const list = (FUT_ROLLS[ticker] || []).filter(r => Date.now() / 1000 - r.at < 40 * 86400);
  let same = list.find(r => r.at === at);
  if (same) {
    if (Math.abs(same.ratio / roll.ratio - 1) < 0.003) { if (!same.ok && Date.now() - same.seen >= 10 * 60e3) same.ok = true; }
    else Object.assign(same, { ratio: roll.ratio, seen: Date.now(), ok: false });   /* a different size: start again */
    Object.assign(same, { oldPrev: roll.oldPrev || same.oldPrev, newPrev: roll.newPrev || same.newPrev, dayT });
  } else list.push(same = { at, dayT, ratio: roll.ratio, oldPrev: roll.oldPrev || null, newPrev: roll.newPrev || null, seen: Date.now(), ok: false });
  FUT_ROLLS[ticker] = list; saveFutRolls();
  return same.ok ? same : null;
}
function dropFutRoll(ticker, prevBarT) {
  const list = FUT_ROLLS[ticker]; if (!list?.length) return;
  const keep = list.filter(r => r.at !== prevBarT + 1);
  if (keep.length !== list.length) { FUT_ROLLS[ticker] = keep; saveFutRolls(); }
}
function saveFutRolls() { try { const fs = require('fs'); fs.mkdirSync(require('path').dirname(FUT_ROLL_FILE), { recursive: true }); fs.writeFileSync(FUT_ROLL_FILE, JSON.stringify(FUT_ROLLS)); } catch {} }
/* A price from the roll day: old contract if it sits nearer the old contract's previous close than the new one's. */
function futRollLevel(v, r) {
  if (!r || !(v > 0) || !(r.oldPrev > 0) || !(r.newPrev > 0)) return v;
  return Math.abs(Math.log(v / r.oldPrev)) < Math.abs(Math.log(v / r.newPrev)) ? v * r.ratio : v;
}
function futRollsFor(ticker) { return (FUT_ROLLS[ticker] || []).filter(r => r.ok && r.dayT > 0 && Date.now() / 1000 - r.at < 40 * 86400).sort((a, b) => a.at - b.at); }
/* Scales the bars before each roll. kind 'intraday': the switch inside the session is found as the bar-to-bar jump
   that matches the ratio (Yahoo switched NG=F's hourly series at 08:00 UTC, not at the daily bar). kind 'week' /
   'month': bars of earlier periods are scaled; the period holding the roll keeps its close (the live, new contract)
   and its open / high / low are rebuilt from the adjusted daily bars (Yahoo stamps the current bar with the live time,
   so periods are matched by calendar, not by bar times). */
function futPeriodKey(t, kind) {
  const d = new Date(t * 1000);
  if (kind === 'month') return d.getUTCFullYear() * 12 + d.getUTCMonth();
  return Math.floor((Math.floor(t / 86400) + 3) / 7);   /* Monday-based week number */
}
function mergeLivePeriodBar(b, kind, gmtOff = 0) {
  const n = b?.T?.length || 0;
  if (n < 2 || !(b.T[n - 1] > 0) || !(b.T[n - 2] > 0)) return b;
  if (futPeriodKey(b.T[n - 1] + gmtOff, kind) !== futPeriodKey(b.T[n - 2] + gmtOff, kind)) return b;
  const cut = a => a.slice(0, n - 1), i = n - 2, j = n - 1;
  const out = { ...b, T: cut(b.T), O: cut(b.O), H: cut(b.H), L: cut(b.L), C: cut(b.C), V: cut(b.V || []), n: n - 1 };
  out.H[i] = Math.max(+b.H[i], +b.H[j]); out.L[i] = Math.min(+b.L[i], +b.L[j]); out.C[i] = b.C[j];
  if (b.V) out.V[i] = (+b.V[i] || 0) + (+b.V[j] || 0);
  return out;
}
function rebuildLastPeriodBar(b, daily, kind, gmtOff = 0) {
  const n = b?.T?.length || 0;
  if (!n || !daily?.T?.length) return b;
  const pk = futPeriodKey(b.T[n - 1] + gmtOff, kind), idx = [];
  daily.T.forEach((t, i) => { if (t > 0 && futPeriodKey(t + gmtOff, kind) === pk && daily.C[i] > 0) idx.push(i); });
  if (!idx.length) return b;
  const out = { ...b, O: [...b.O], H: [...b.H], L: [...b.L], C: [...b.C] }, i = n - 1;
  out.O[i] = daily.O[idx[0]];
  out.H[i] = Math.max(...idx.map(j => daily.H[j]), +out.C[i] || 0);
  out.L[i] = Math.min(...idx.map(j => daily.L[j]), +out.C[i] || Infinity);
  return out;
}
function futRollAdjust(ticker, bars, kind = 'daily', dailyAdj = null) {
  const rolls = futRollsFor(ticker);
  if (!bars || !rolls.length || !Array.isArray(bars.T) || !bars.T.length) return bars;
  const out = { ...bars, O: [...bars.O], H: [...bars.H], L: [...bars.L], C: [...bars.C] };
  const n = out.T.length, period = kind === 'week' || kind === 'month';
  const scale = i => { for (const k of ['O', 'H', 'L', 'C']) if (Number.isFinite(+out[k][i]) && out[k][i] != null) out[k][i] = +out[k][i] * r0.ratio; };
  let r0;
  for (const r of rolls) {
    r0 = r;
    if (period) {
      const ck = futPeriodKey(r.dayT, kind);
      /* Yahoo can return two bars for the current period (yesterday's snapshot + one stamped with the live time):
         only the last one is the new contract. */
      let lastCk = -1; for (let i = 0; i < n; i++) if (futPeriodKey(out.T[i], kind) === ck) lastCk = i;
      for (let i = 0; i < n; i++) {
        const pk = futPeriodKey(out.T[i], kind);
        if (pk < ck || (pk === ck && i !== lastCk)) scale(i);
        else if (pk === ck && dailyAdj?.T?.length) {
          const idx = []; dailyAdj.T.forEach((t, j) => { if (futPeriodKey(t, kind) === ck && dailyAdj.C[j] > 0) idx.push(j); });
          if (idx.length) { out.O[i] = dailyAdj.O[idx[0]]; out.H[i] = Math.max(...idx.map(j => dailyAdj.H[j]), +out.C[i] || 0); out.L[i] = Math.min(...idx.map(j => dailyAdj.L[j]), +out.C[i] || Infinity); }
        }
      }
      continue;
    }
    let cut = r.at;
    if (kind === 'intraday') {
      let best = -1, bestErr = Infinity;
      for (let i = 1; i < n; i++) {
        if (out.T[i] < r.at || out.T[i] > r.dayT + 24 * 3600 || !(out.C[i] > 0) || !(out.C[i - 1] > 0)) continue;
        const e = Math.abs(Math.log(out.C[i] / out.C[i - 1]) - Math.log(r.ratio));
        if (e < bestErr) { bestErr = e; best = i; }
      }
      if (best > 0 && bestErr < Math.abs(Math.log(r.ratio)) * 0.4) cut = out.T[best];
    }
    for (let i = 0; i < n; i++) if (out.T[i] < cut) scale(i);
    /* The roll day's own daily bar: open / high / low may still be old-contract prices. */
    if (kind === 'daily') for (let i = 0; i < n; i++) if (out.T[i] >= cut && out.T[i] <= r.dayT + 86400) {
      for (const k of ['O', 'H', 'L']) out[k][i] = futRollLevel(+out[k][i], r);
      out.H[i] = Math.max(out.H[i], out.O[i], out.C[i]); out.L[i] = Math.min(out.L[i], out.O[i], out.C[i]);
    }
  }
  return out;
}


/* ── ANGEL ONE SMARTAPI (optional, 25 Nov 2026 - replaced Zerodha Kite) ──
   NSE refuses Render's address, so option premiums and NSE's previous closes did not load there. With SMARTAPI_API_KEY
   set on Render and the day's "Connect Angel One" login done (a SmartAPI session ends at midnight IST - Angel One rule,
   it cannot be renewed without logging in), these come from Angel One's market-data API instead:
     - option premiums (bid / ask / last / OI / volume) of Nifty, Bank Nifty, FinNifty - live, kept 60 s;
     - the NSE indices Angel One lists (Nifty 50, Bank, Fin Services, sectors...) and India VIX - live, kept 30 s;
     - expiry dates and lot sizes from Angel One's public instrument list (downloaded once a day).
   Indices Angel One does not list (Fin Services Ex-Bank, Consumer Durables, Healthcare, Oil & Gas, Housing, Digital,
   Tourism) keep using Yahoo / the built-in ratio, as when nobody is connected.
   Login: Angel One's own "publisher login" page; it sends the user back to /api/smartapi/callback with the session
   token. Render holds only the API key - never the client code, PIN or TOTP.
   Read-only: this app never places, changes or cancels an order. */
const ANGEL = {
  /* also accepts the names people often type */
  key: String(process.env.SMARTAPI_API_KEY || process.env.SMARTAPI_KEY || process.env.ANGEL_API_KEY || process.env.ANGELONE_API_KEY || '').trim(),
  api: String(process.env.SMARTAPI_API_BASE || 'https://apiconnect.angelone.in').replace(/\/$/, ''),
  login: String(process.env.SMARTAPI_LOGIN_URL || 'https://smartapi.angelone.in/publisher-login'),
  master: String(process.env.SMARTAPI_MASTER_URL || 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json'),
  /* Automatic daily login (25 Nov 2026, the user's choice): client code, PIN and the TOTP secret (the text key behind
     the authenticator QR code) on Render. Without them the daily "Connect Angel One" button is used. */
  clientCode: String(process.env.SMARTAPI_CLIENT_CODE || process.env.ANGEL_CLIENT_CODE || '').trim(),
  pin: String(process.env.SMARTAPI_PIN || process.env.ANGEL_PIN || '').trim(),
  totpSecret: String(process.env.SMARTAPI_TOTP_SECRET || process.env.ANGEL_TOTP_SECRET || '').replace(/[\s-]/g, '').toUpperCase(),
  /* Angel One asks for these headers on every call; it does not check them for market data. */
  localIp: String(process.env.SMARTAPI_LOCAL_IP || '127.0.0.1'),
  publicIp: String(process.env.SMARTAPI_PUBLIC_IP || '127.0.0.1'),
  mac: String(process.env.SMARTAPI_MAC || '02:00:00:00:00:01'),
};
const ANGEL_FILE = require('path').join(__dirname, 'data', 'angel-session.json');
const ANGEL_INSTR_FILE = require('path').join(__dirname, 'data', 'angel-instruments.json');
let ANGEL_SESSION = null, ANGEL_SESSION_LOADED = false;   /* { token, user, name, at, until } - token kept encrypted on disk */
const ANGEL_STATE = { lastOk: null, lastError: null, lastErrorAt: null, calls: [] };
/* Index symbol -> pattern on Angel One's index name (letters and digits only). Matched against the instrument list, so
   a renamed index is still found; /api/smartapi/status lists any index it could not match. */
const IDX_RE = {
  'NSE:NIFTY': /^NIFTY50$/, 'NSE:BANKNIFTY': /^NIFTYBANK$/, 'NSE:NIFTYNXT50': /^NIFTYNEXT50$/, 'NSE:NIFTYFMCG': /^NIFTYFMCG$/,
  'NSE:NIFTYENERGY': /^NIFTYENERGY$/, 'NSE:NIFTYCONSDUR': /^NIFTYCONS\w*DUR/, 'NSE:NIFTYFINEXBANK': /^NIFTYFIN\w*EX\w*B/,
  'NSE:NIFTYIT': /^NIFTYIT$/, 'NSE:NIFTYPVTBANK': /^NIFTY(PVT|PRIVATE)BANK$/, 'NSE:NIFTYAUTO': /^NIFTYAUTO$/,
  'NSE:FINNIFTY': /^NIFTYFIN(SERVICE|SERVICES|ANCIALSERVICES)$/, 'NSE:NIFTYPHARMA': /^NIFTYPHARMA$/, 'NSE:NIFTYMID150': /^NIFTYMIDCAP150$/,
  'NSE:NIFTYHEALTH': /^NIFTYHEALTH/, 'NSE:NIFTYMETAL': /^NIFTYMETAL$/, 'NSE:NIFTYHOUSING': /^NIFTYHOUSING$/,
  'NSE:NIFTYCONSUMPTION': /^NIFTY(INDIA)?CONSUMPTION$/, 'NSE:NIFTYOILGAS': /^NIFTYOIL(AND)?GAS/, 'NSE:NIFTYPSE': /^NIFTYPSE$/,
  'NSE:NIFTYCOMMODITIES': /^NIFTYCOMMODITIES$/, 'NSE:NIFTYINFRA': /^NIFTYINFRA/, 'NSE:NIFTYPSUBANK': /^NIFTYPSUBANK$/,
  'NSE:NIFTYDIGITAL': /^NIFTY(IND|INDIA)DIGITAL/, 'NSE:NIFTYTOURISM': /^NIFTY(IND|INDIA)TOURISM/, 'NSE:NIFTYMEDIA': /^NIFTYMEDIA$/,
  'NSE:NIFTYREALTY': /^NIFTYREALTY$/, 'VIX': /^INDIAVIX$/,
};
const OC_NAMES = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY']);

function angelCipherKey() { return require('crypto').createHash('sha256').update('td-angel-v1|' + APP_SECRET).digest(); }
function angelSaveSession() {
  try {
    const fs = require('fs'); fs.mkdirSync(require('path').dirname(ANGEL_FILE), { recursive: true });
    if (!ANGEL_SESSION) { try { fs.unlinkSync(ANGEL_FILE); } catch {} return; }
    const c = require('crypto'), iv = c.randomBytes(12), ci = c.createCipheriv('aes-256-gcm', angelCipherKey(), iv);
    const data = Buffer.concat([ci.update(JSON.stringify(ANGEL_SESSION), 'utf8'), ci.final()]);
    fs.writeFileSync(ANGEL_FILE, JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: ci.getAuthTag().toString('base64'), data: data.toString('base64') }));
  } catch (e) { console.warn('Angel session save:', e.message); }
}
function angelSession() {
  if (!ANGEL_SESSION_LOADED) {
    ANGEL_SESSION_LOADED = true;
    try {
      const o = JSON.parse(require('fs').readFileSync(ANGEL_FILE, 'utf8')), c = require('crypto');
      const d = c.createDecipheriv('aes-256-gcm', angelCipherKey(), Buffer.from(o.iv, 'base64')); d.setAuthTag(Buffer.from(o.tag, 'base64'));
      ANGEL_SESSION = JSON.parse(Buffer.concat([d.update(Buffer.from(o.data, 'base64')), d.final()]).toString('utf8'));
    } catch {}
  }
  return ANGEL_SESSION && Date.now() < ANGEL_SESSION.until ? ANGEL_SESSION : null;
}
/* Angel One data can be used now: key set and today's login done. */
function angelReady() { return !!(ANGEL.key && (angelSession() || angelAutoOk())); }
/* ── automatic login ──
   TOTP (RFC 6238: HMAC-SHA1, 30 s, 6 digits) from the base32 secret, then loginByPassword. Brakes so a wrong PIN or
   secret can never lock the Angel One account: one try at a time, 30 minutes between failed tries, at most 3 failed
   tries a day, and a rejected PIN / TOTP / client code stops automatic login until Render restarts (fix the value). */
const angelAutoSet = () => !!(ANGEL.key && ANGEL.clientCode && ANGEL.pin && ANGEL.totpSecret);
const ANGEL_AUTO = { tries: [], lastFail: 0, failMsg: null, stopped: null, inflight: null, lastOk: null };
function angelAutoOk() {
  if (!angelAutoSet() || ANGEL_AUTO.stopped) return false;
  const day = istDateKey();
  return ANGEL_AUTO.tries.filter(t => t.day === day && !t.ok).length < 3;
}
function base32Bytes(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const out = [];
  for (const ch of String(s).replace(/=+$/, '')) {
    const i = A.indexOf(ch); if (i < 0) throw new Error('TOTP secret is not a valid base32 key');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpNow(secret, ms = Date.now()) {
  const c = require('crypto'), ctr = Buffer.alloc(8); ctr.writeBigUInt64BE(BigInt(Math.floor(ms / 1000 / 30)));
  const h = c.createHmac('sha1', base32Bytes(secret)).update(ctr).digest(), o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
async function angelAutoLogin(why) {
  if (angelSession()) return angelSession();
  if (!angelAutoOk()) throw new Error(ANGEL_AUTO.stopped || 'automatic login paused after 3 failed tries today');
  if (ANGEL_AUTO.inflight) return ANGEL_AUTO.inflight;
  if (Date.now() - ANGEL_AUTO.lastFail < 30 * 60e3) throw new Error('automatic login failed recently - next try after ' + new Date(ANGEL_AUTO.lastFail + 30 * 60e3).toISOString());
  ANGEL_AUTO.inflight = (async () => {
    const day = istDateKey(), t0 = Date.now(), path = '/rest/auth/angelbroking/user/v1/loginByPassword';
    const hdr = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-UserType': 'USER', 'X-SourceID': 'WEB',
      'X-ClientLocalIP': ANGEL.localIp, 'X-ClientPublicIP': ANGEL.publicIp, 'X-MACAddress': ANGEL.mac, 'X-PrivateKey': ANGEL.key, Referer: null, Origin: null };
    let r, j = null;
    try {
      r = await get(ANGEL.api + path, hdr, JSON.stringify({ clientcode: ANGEL.clientCode, password: ANGEL.pin, totp: totpNow(ANGEL.totpSecret) }), 'POST');
      try { j = JSON.parse(r.body); } catch {}
    } catch (e) { angelNote(path, t0, null, e); ANGEL_AUTO.tries.push({ day, ok: false }); ANGEL_AUTO.lastFail = Date.now(); ANGEL_AUTO.failMsg = e.message; throw e; }
    angelNote(path, t0, r.status);
    const tok = j?.data?.jwtToken;
    if (r.status !== 200 || !(j?.status === true || j?.success === true) || !tok) {
      const code = j?.errorcode || j?.errorCode || '', msg = (j?.message || 'HTTP ' + r.status) + (code ? ' (' + code + ')' : '');
      ANGEL_AUTO.tries.push({ day, ok: false }); ANGEL_AUTO.lastFail = Date.now(); ANGEL_AUTO.failMsg = msg;
      /* wrong PIN / TOTP / client code: retrying would count towards Angel One's lockout - stop until the value is fixed */
      if (/pin|password|totp|otp|client ?code|invalid user|credential/i.test(msg)) ANGEL_AUTO.stopped = 'automatic login stopped: Angel One said "' + msg + '" - check SMARTAPI_CLIENT_CODE / SMARTAPI_PIN / SMARTAPI_TOTP_SECRET on Render (saving restarts the app)';
      ANGEL_STATE.lastError = path + ': ' + msg; ANGEL_STATE.lastErrorAt = new Date().toISOString();
      throw new Error('Angel One automatic login: ' + msg);
    }
    ANGEL_AUTO.tries.push({ day, ok: true }); ANGEL_AUTO.failMsg = null; ANGEL_AUTO.lastOk = new Date().toISOString();
    let prof = null; try { prof = await angelCall('/rest/secure/angelbroking/user/v1/getProfile', null, { token: tok }); } catch {}
    ANGEL_SESSION = { token: String(tok).replace(/^Bearer\s+/i, ''), user: prof?.clientcode || ANGEL.clientCode, name: prof?.name || null, at: Date.now(), until: angelTokenEnd(Date.now()), auto: true };
    ANGEL_SESSION_LOADED = true; angelSaveSession(); API_CACHE.delete('angel:idx');
    console.log('Angel One: automatic login ok (' + (why || 'on demand') + ')');
    angelInstruments().catch(e => console.warn('Angel One instruments:', e.message));
    return ANGEL_SESSION;
  })().finally(() => { ANGEL_AUTO.inflight = null; });
  return ANGEL_AUTO.inflight;
}
/* A SmartAPI session ends at midnight IST: the first 00:00 after the login. */
function angelTokenEnd(ms) {
  const ist = new Date(ms + 5.5 * 3600e3);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 0, 0) - 5.5 * 3600e3;
}
function angelNote(path, t0, status, e) {
  const o = { at: new Date().toISOString(), path: String(path).split('?')[0], ms: Date.now() - t0 };
  if (status != null) o.status = status; if (e) o.error = String(e.message || e).slice(0, 140);
  ANGEL_STATE.calls.push(o); if (ANGEL_STATE.calls.length > 10) ANGEL_STATE.calls.shift();
}
/* One SmartAPI call (through the 'angel' queue: Angel One allows 1 quote request a second). */
async function angelCall(path, body = null, opts = {}) {
  if (!ANGEL.key) throw new Error('Angel One not set up (SMARTAPI_API_KEY on Render)');
  let token = opts.token || angelSession()?.token;
  if (!token && angelAutoOk()) token = (await angelAutoLogin('on demand'))?.token;
  if (!token) throw new Error('Angel One not connected today - press "Connect Angel One" (Screener -> My trades)');
  const hdr = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-UserType': 'USER', 'X-SourceID': 'WEB',
    'X-ClientLocalIP': ANGEL.localIp, 'X-ClientPublicIP': ANGEL.publicIp, 'X-MACAddress': ANGEL.mac, 'X-PrivateKey': ANGEL.key,
    Authorization: 'Bearer ' + token, Referer: null, Origin: null };
  const t0 = Date.now(); let r;
  try { r = await get(ANGEL.api + path, hdr, body ? JSON.stringify(body) : null, body ? 'POST' : 'GET'); }
  catch (e) { angelNote(path, t0, null, e); ANGEL_STATE.lastError = e.message; ANGEL_STATE.lastErrorAt = new Date().toISOString(); throw e; }
  angelNote(path, t0, r.status);
  let j = null; try { j = JSON.parse(r.body); } catch {}
  if (r.status === 200 && j && (j.status === true || j.success === true)) { ANGEL_STATE.lastOk = new Date().toISOString(); return j.data; }
  const code = j?.errorcode || j?.errorCode || '', msg = j?.message || ('HTTP ' + r.status);
  /* logged out / expired / bad token: login again (AG8001 invalid token, AG8002 expired, AG8003 missing) */
  if (!opts.token && (r.status === 401 || r.status === 403 || /^AG800[123]$/.test(code) || /token/i.test(msg) && /invalid|expired/i.test(msg))) { ANGEL_SESSION = null; angelSaveSession(); }
  ANGEL_STATE.lastError = `${path}: ${code || 'HTTP ' + r.status} - ${msg}`; ANGEL_STATE.lastErrorAt = new Date().toISOString();
  const er = new Error('Angel One: ' + msg + (code ? ' (' + code + ')' : '')); er.angelCode = code; throw er;
}
/* ── daily login (Angel One's publisher-login page, then back to /api/smartapi/callback) ── */
const ANGEL_LOGINS = new Map();   /* state -> time the login was started (10 minutes to finish it) */
function angelLoginUrl() {
  const st = require('crypto').randomBytes(16).toString('hex'), now = Date.now();
  for (const [k, t] of ANGEL_LOGINS) if (now - t > 10 * 60e3) ANGEL_LOGINS.delete(k);
  ANGEL_LOGINS.set(st, now);
  /* redirect_url is required: without it Angel One answers "Invalid redirect url" even when My Apps has the same address.
     It must match the Redirect URL saved in My Apps exactly (APP_URL on Render + /api/smartapi/callback). */
  return `${ANGEL.login}?api_key=${encodeURIComponent(ANGEL.key)}&redirect_url=${encodeURIComponent((APP_URL || '') + '/api/smartapi/callback')}&state=${st}`;
}
async function angelCallback(p) {
  const now = Date.now(), st = p.get('state');
  for (const [k, t] of ANGEL_LOGINS) if (now - t > 10 * 60e3) ANGEL_LOGINS.delete(k);
  /* Only a login started from this app in the last 10 minutes: Angel One returns the state; without it, the one pending login. */
  if (st ? !ANGEL_LOGINS.delete(st) : ANGEL_LOGINS.size !== 1) throw new Error('login link expired - press Connect Angel One again');
  if (!st) ANGEL_LOGINS.clear();
  const tok = String(p.get('auth_token') || p.get('jwtToken') || p.get('jwt_token') || '').replace(/^Bearer\s+/i, '').trim();
  if (!/^[A-Za-z0-9._-]{20,4096}$/.test(tok)) throw new Error('Angel One login was not completed');
  /* Check the token works before keeping it (and get the account name to show on the card). */
  const prof = await angelCall('/rest/secure/angelbroking/user/v1/getProfile', null, { token: tok });
  ANGEL_SESSION = { token: tok, user: prof?.clientcode || null, name: prof?.name || null, at: Date.now(), until: angelTokenEnd(Date.now()) };
  ANGEL_SESSION_LOADED = true; angelSaveSession();
  API_CACHE.delete('angel:idx');
  angelInstruments().then(() => angelIndexQuotes()).catch(e => console.warn('Angel One after login:', e.message));
  return ANGEL_SESSION;
}
async function angelLogout() {
  const s = angelSession();
  if (s) { try { await angelCall('/rest/secure/angelbroking/user/v1/logout', { clientcode: s.user || '' }); } catch {} }
  ANGEL_SESSION = null; ANGEL_SESSION_LOADED = true; angelSaveSession();
}
/* ── instrument list: option strikes / expiries / lot sizes and the index tokens, once a day ──
   Angel One's list is one ~40 MB JSON array of flat objects (no login needed). It is read as it streams in and only
   the rows used here are kept: parsing it whole would need ~300 MB of memory, more than Render's free plan has. */
const angelNorm = s => String(s || '').toUpperCase().replace(/&/g, 'AND').replace(/[^A-Z0-9]/g, '');
const ANGEL_MON = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const angelExpiryIso = s => { const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(String(s || '').toUpperCase()); return m && ANGEL_MON[m[2]] ? `${m[3]}-${ANGEL_MON[m[2]]}-${m[1]}` : null; };
function angelMasterRows(onRow) {
  return new Promise((resolve, reject) => {
    const u = new URL(ANGEL.master); countOutbound(u.hostname, 0);
    let settled = false, buf = '', n = 0;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(deadline); fn(v); };
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': BASE_HDR['User-Agent'], Accept: 'application/json', 'Accept-Encoding': 'gzip' }, timeout: 30000 }, res => {
      if (res.statusCode !== 200) { res.resume(); return done(reject, new Error('instrument list: HTTP ' + res.statusCode)); }
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        buf += chunk;
        let start = buf.indexOf('{'), end;
        while (start >= 0 && (end = buf.indexOf('}', start)) >= 0) {
          try { onRow(JSON.parse(buf.slice(start, end + 1))); n++; } catch {}
          start = buf.indexOf('{', end + 1);
        }
        buf = start >= 0 ? buf.slice(start) : '';
      });
      stream.on('end', () => done(resolve, n));
      stream.on('error', er => done(reject, er));
      if (stream !== res) res.on('error', er => done(reject, er));
    });
    const deadline = setTimeout(() => { req.destroy(); done(reject, new Error('instrument list: deadline exceeded')); }, 120000);
    req.on('timeout', () => { req.destroy(); done(reject, new Error('instrument list: timeout')); });
    req.on('error', er => done(reject, er));
    req.end();
  });
}
let ANGEL_INSTR = null, ANGEL_INSTR_INFLIGHT = null, ANGEL_INSTR_TRIED = 0;
try { ANGEL_INSTR = JSON.parse(require('fs').readFileSync(ANGEL_INSTR_FILE, 'utf8')); } catch {}
async function angelInstruments() {
  const today = istDateKey();
  if (ANGEL_INSTR?.day === today && ANGEL_INSTR.v === 1) return ANGEL_INSTR;
  const old = ANGEL_INSTR && Date.now() - (ANGEL_INSTR.ts || 0) < 4 * 86400e3 ? ANGEL_INSTR : null;
  if (old && Date.now() - ANGEL_INSTR_TRIED < 10 * 60e3) return old;   /* failed recently: keep the last list */
  if (ANGEL_INSTR_INFLIGHT) return ANGEL_INSTR_INFLIGHT;
  ANGEL_INSTR_TRIED = Date.now();
  ANGEL_INSTR_INFLIGHT = (async () => {
    const opt = {}, lot = {}, idxRows = [];
    const rows = await angelMasterRows(r => {
      if (r.exch_seg === 'NSE' && r.instrumenttype === 'AMXIDX') { idxRows.push({ token: String(r.token), symbol: r.symbol, name: r.name }); return; }
      const name = String(r.name || '').toUpperCase();
      if (r.exch_seg !== 'NFO' || r.instrumenttype !== 'OPTIDX' || !OC_NAMES.has(name)) return;
      const exp = angelExpiryIso(r.expiry), ty = /CE$/.test(r.symbol) ? 'CE' : /PE$/.test(r.symbol) ? 'PE' : null, k = +r.strike / 100;
      if (!exp || !ty || !(k > 0) || !r.token) return;
      (opt[name] = opt[name] || []).push([exp, k, ty, String(r.token)]);
      if (+r.lotsize > 0 && (!lot[name] || exp < lot[name].exp)) lot[name] = { exp, n: +r.lotsize };
    });
    if (!opt.NIFTY?.length) throw new Error(`Angel One instrument list has no Nifty options (${rows} rows read)`);
    const idx = {};
    for (const [sym, re] of Object.entries(IDX_RE)) {
      const hit = idxRows.find(r => re.test(angelNorm(r.symbol))) || idxRows.find(r => re.test(angelNorm(r.name)));
      if (hit) idx[sym] = hit.token;
    }
    ANGEL_INSTR = { v: 1, day: today, ts: Date.now(), opt, lot: Object.fromEntries(Object.entries(lot).map(([k, v]) => [k, v.n])), idx, indexNames: idxRows.length };
    try { require('fs').mkdirSync(require('path').dirname(ANGEL_INSTR_FILE), { recursive: true }); require('fs').writeFileSync(ANGEL_INSTR_FILE, JSON.stringify(ANGEL_INSTR)); } catch {}
    return ANGEL_INSTR;
  })().catch(e => { if (old) { console.warn('Angel One instruments (keeping the last list):', e.message); return old; } throw e; })
    .finally(() => { ANGEL_INSTR_INFLIGHT = null; });
  return ANGEL_INSTR_INFLIGHT;
}
/* Quotes for many tokens of one exchange, 50 per request (Angel One's limit). Returns token -> quote. */
async function angelQuote(exch, tokens, mode = 'FULL') {
  const out = {};
  for (let i = 0; i < tokens.length; i += 50) {
    const d = await angelCall('/rest/secure/angelbroking/market/v1/quote/', { mode, exchangeTokens: { [exch]: tokens.slice(i, i + 50) } });
    for (const q of d?.fetched || []) out[String(q.symbolToken)] = q;
  }
  return out;
}

/* Every listed index (and India VIX) in one request, kept 30 s in market hours, 10 minutes outside. */
async function angelIndexQuotes() {
  return (await cacheWrap('angel:idx', istMarketHoursS() ? 30e3 : 10 * 60e3, async () => {
    const ins = await angelInstruments(), list = [...new Set(Object.values(ins.idx || {}))];
    if (!list.length) throw new Error('no index found in Angel One\'s instrument list');
    return angelQuote('NSE', list, 'OHLC');
  })).value;
}
/* Index price in the shape of getPriceAndChange(): Angel One's live value and previous close; Yahoo only for the mini chart. */
async function angelIndexPrice(sym, ticker) {
  const ins = await angelInstruments(), id = ins.idx?.[sym];
  if (!id) throw new Error(sym + ' not in Angel One\'s index list');
  const q = (await angelIndexQuotes())[id], live = +q?.ltp, prev = +q?.close;
  if (!(live > 0)) throw new Error('Angel One gave no value for ' + sym);
  let y = null; if (ticker) { try { y = await withTimeout(getPriceAndChange(ticker, sym), 8000, ticker + ' mini chart'); } catch {} }
  const scale = NSE_INDEX_PRIMARY.has(sym) && y?.liveRaw > 0 ? live / y.liveRaw : 1;   /* Fin Ex-Bank: Yahoo has only the ETF */
  if (NSE_INDEX_PRIMARY.has(sym) && scale > 1 && NSE_SNAP.ratio[sym]?.day !== istDateKey()) { NSE_PROXY_RATIO[sym] = scale; NSE_SNAP.ratio[sym] = { k: scale, day: istDateKey() }; nseSnapSave(); }
  const spark = (y?.spark || []).map(v => v * scale); if (spark.length) spark[spark.length - 1] = live; else spark.push(live);
  const p0 = prev > 0 ? prev : live;
  return { liveRaw: live, prevRaw: p0, rawChg: live - p0, rawPct: p0 > 0 ? (live - p0) / p0 * 100 : 0,
    todayOpen: +q.open || live, todayHigh: +q.high || live, todayLow: +q.low || live, todayVol: 0,
    changeBasis: 'previousClose', basisTime: null, marketTime: y?.marketTime || Math.round(Date.now() / 1000), spark: spark.slice(-6), source: 'Angel One' };
}
async function angelVix() {
  const ins = await angelInstruments(), id = ins.idx?.VIX;
  if (!id) throw new Error('India VIX not in Angel One\'s index list');
  const v = +(await angelIndexQuotes())[id]?.ltp;
  if (!(v > 0)) throw new Error('Angel One gave no India VIX');
  return v;
}
/* ── option chain from Angel One (same shape as NSE's, built by ocBuild) ── */
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isoToNseDate = k => `${k.slice(8, 10)}-${MON3[+k.slice(5, 7) - 1]}-${k.slice(0, 4)}`;
async function angelExpiryInfo(name) {
  const ins = await angelInstruments(), rows = ins.opt?.[name];
  if (!rows?.length) throw new Error('no ' + name + ' options in Angel One\'s instrument list');
  return { expiryDates: [...new Set(rows.map(r => r[0]))].sort().map(isoToNseDate) };
}
const OC_SPOT_SYM = { NIFTY: 'NSE:NIFTY', BANKNIFTY: 'NSE:BANKNIFTY', FINNIFTY: 'NSE:FINNIFTY' };
async function angelOptionChain(sym, name, want, opts) {
  const exps = ocOpenExpiries(await angelExpiryInfo(name));
  const dd0 = (a, b) => Math.abs(Date.parse(a) - Date.parse(b));
  const pick = exps.find(e => e.key === want) || (want ? exps.slice().sort((a, b) => dd0(a.key, want) - dd0(b.key, want))[0] : exps[0]);
  if (!pick) throw new Error('no open ' + name + ' expiry in Angel One\'s list');
  const key = `${name}_${pick.key}`, hit = NSE_SNAP.chains[key], age = hit ? Date.now() - hit.ts : Infinity;
  const ttl = Math.min(opts.fresh != null ? opts.fresh : Infinity, istMarketHoursS() ? 60e3 : 15 * 60e3);
  const served = h => ({ ...h.value, expiries: exps.map(e => e.key).slice(0, 8), saved: true, stale: Date.now() - h.ts > 10 * 60e3, staleAgeSec: Math.round((Date.now() - h.ts) / 1000) });
  if (hit && hit.src === 'angel' && age < ttl) return served(hit);
  const fk = 'angel:' + key;
  if (!OC_INFLIGHT.has(fk)) OC_INFLIGHT.set(fk, (async () => {
    const ins = await angelInstruments(), q0 = (await angelIndexQuotes())[ins.idx?.[OC_SPOT_SYM[name]]], spot = +q0?.ltp;
    if (!(spot > 0)) throw new Error('Angel One gave no ' + name + ' spot');
    /* the 200 contracts nearest the spot (100 strikes): 4 quote requests at Angel One's 1 a second */
    const rows = (ins.opt[name] || []).filter(r => r[0] === pick.key && Math.abs(r[1] - spot) / spot <= 0.12)
      .sort((a, b) => Math.abs(a[1] - spot) - Math.abs(b[1] - spot)).slice(0, 200);
    if (!rows.length) throw new Error('no strikes near the spot in Angel One\'s list');
    const q = await angelQuote('NFO', rows.map(r => r[3]), 'FULL');
    const by = new Map();
    for (const [, k, ty, tok] of rows) {
      const o = q[tok]; if (!o) continue;
      const row = by.get(k) || { strikePrice: k }; by.set(k, row);
      row[ty] = { lastPrice: +o.ltp || 0, buyPrice1: +o.depth?.buy?.[0]?.price || 0, sellPrice1: +o.depth?.sell?.[0]?.price || 0,
        openInterest: +o.opnInterest || 0, changeinOpenInterest: 0, impliedVolatility: 0, totalTradedVolume: +o.tradeVolume || 0 };
    }
    if (!by.size) throw new Error('Angel One gave no option quotes');
    const ist = new Date(Date.now() + 5.5 * 3600e3), ts = `${isoToNseDate(ist.toISOString().slice(0, 10))} ${ist.toISOString().slice(11, 19)}`;
    const value = { ...ocBuild(sym, name, { records: { underlyingValue: spot, timestamp: ts, data: [...by.values()] } }, pick, exps), source: 'Angel One', lotSize: ins.lot?.[name] || null };
    NSE_SNAP.chains[key] = { value, ts: Date.now(), src: 'angel' };
    for (const k of Object.keys(NSE_SNAP.chains)) if (Date.now() - NSE_SNAP.chains[k].ts > 8 * 86400e3) delete NSE_SNAP.chains[k];
    nseSnapSave(); NSE_OC_LAST.ok = new Date().toISOString();
    return value;
  })().finally(() => OC_INFLIGHT.delete(fk)));
  try { return { ...(await OC_INFLIGHT.get(fk)), saved: false }; }
  catch (e) { if (hit && age < 4 * 86400e3) return served(hit); throw e; }
}
if (angelAutoSet()) setTimeout(() => { if (!angelSession()) angelAutoLogin('start-up').catch(e => console.warn(e.message)); }, 60e3);
function angelStatus() {
  const s = angelSession(), ins = ANGEL_INSTR;
  return {
    configured: !!ANGEL.key, keySet: !!ANGEL.key,
    auto: { set: angelAutoSet(), clientCodeSet: !!ANGEL.clientCode, pinSet: !!ANGEL.pin, totpSecretSet: !!ANGEL.totpSecret,
      lastOk: ANGEL_AUTO.lastOk, lastError: ANGEL_AUTO.failMsg, stopped: ANGEL_AUTO.stopped, failsToday: ANGEL_AUTO.tries.filter(t => t.day === istDateKey() && !t.ok).length },
    /* names (never values) of the Angel-like variables this server sees - tells a typo in the name from a missing one */
    envNames: Object.keys(process.env).filter(k => /SMARTAPI|ANGEL/i.test(k)).sort(),
    connected: !!s, user: s?.user || null, name: s?.name || null,
    until: s ? new Date(s.until).toISOString() : null, ready: angelReady(),
    redirectUrl: (APP_URL || '') + '/api/smartapi/callback',
    instruments: ins ? { day: ins.day, options: Object.fromEntries(Object.entries(ins.opt || {}).map(([k, v]) => [k, v.length])), lot: ins.lot || {},
      indices: Object.keys(ins.idx || {}).length, notFound: Object.keys(IDX_RE).filter(k => !ins.idx?.[k]), indexNames: ins.indexNames || 0 } : null,
    lastOk: ANGEL_STATE.lastOk, lastError: ANGEL_STATE.lastError, lastErrorAt: ANGEL_STATE.lastErrorAt, calls: ANGEL_STATE.calls,
  };
}

/* NSE index names (index symbols the app treats as NSE indices; Fin Services Ex-Bank: Yahoo only has the FINIETF
   ETF, ~31 for an index at ~31,500, so it is scaled - see getIndexFallbackPrice). */
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
/* ── NSE requests removed (18 Nov 2026) ──
   NSE refuses Render's address, so every NSE market-data request failed there. Removed: the option chain (now
   Angel One only), the index snapshot and previous closes (Angel One, else Yahoo), the archive index closes (Fin
   Ex-Bank ratio: the built-in ratio), FII / DII, the announcements feed and the Cloudflare relay. Still
   asked (they feed other checks and fall back to saved / built-in data, retried at most every few hours when
   refused): the results calendar, corporate actions, ASM / GSM, the holiday list and the index member lists.
   data/nse-snap.json keeps the last option chains (from Angel One) and the Fin Ex-Bank ratio. */
const NSE_SNAP_FILE = require('path').join(__dirname, 'data', 'nse-snap.json');
const NSE_SNAP = { chains: {}, info: {}, ratio: {} };
try { Object.assign(NSE_SNAP, JSON.parse(require('fs').readFileSync(NSE_SNAP_FILE, 'utf8'))); } catch {}
let NSE_SNAP_SAVE_T = null;
function nseSnapSave() {
  clearTimeout(NSE_SNAP_SAVE_T);
  NSE_SNAP_SAVE_T = setTimeout(() => { try { require('fs').mkdirSync(require('path').dirname(NSE_SNAP_FILE), { recursive: true }); require('fs').writeFileSync(NSE_SNAP_FILE, JSON.stringify(NSE_SNAP)); } catch (e) { console.warn('NSE snapshot save:', e.message); } }, 500);
}
const NSE_PROXY_RATIO = {};   /* Fin Ex-Bank index / ETF price: the built-in ratio (Angel One does not list this index) */
for (const [sym, o] of Object.entries(NSE_SNAP.ratio || {})) if (o?.k > 0) NSE_PROXY_RATIO[sym] = o.k;
const FINEXBANK_RATIO_DEFAULT = Number(process.env.FINEXBANK_RATIO) > 100 ? Number(process.env.FINEXBANK_RATIO) : 978.8;
async function getIndexFallbackPrice(sym, ticker) {
  /* Angel One first when connected: live value and previous close of the NSE indices it lists. */
  if (angelReady() && IDX_RE[sym]) { try { return await withTimeout(angelIndexPrice(sym, ticker), 15000, sym + ' Angel One'); } catch (e) { console.warn('Angel One index ' + sym + ':', e.message); } }
  if (NSE_INDEX_PRIMARY.has(sym)) {
    /* The Yahoo symbol is an ETF (~31 for an index at ~31,500): scaled by the index / ETF ratio (learned at the
       10:00 NSE snapshot, else from NSE's archive close), or fail so the last good value is served - a raw ETF
       price fired every "below" alert on this index. */
    /* Fin Ex-Bank: Yahoo has only the FINIETF ETF. Scaled by the ratio learned earlier, else the built-in
       ratio (measured 974-983 over 11-18 Nov 2026, so within about 0.5%). Before 18 Nov a deploy wiped the learned
       ratio and NSE refused to give a new one, so every quote failed with HTTP 500. */
    const learned = NSE_PROXY_RATIO[sym] > 0, k = learned ? NSE_PROXY_RATIO[sym] : FINEXBANK_RATIO_DEFAULT;
    const y = await getPriceAndChange(ticker, sym);
    const o = { ...y, liveRaw: y.liveRaw * k, prevRaw: y.prevRaw * k, todayOpen: y.todayOpen * k, todayHigh: y.todayHigh * k, todayLow: y.todayLow * k, source: learned ? 'ETFxRatio' : 'ETFxRatio (approx.)' };
    if (o.prevRaw > 0) Object.assign(o, { rawChg: o.liveRaw - o.prevRaw, rawPct: (o.liveRaw - o.prevRaw) / o.prevRaw * 100 });
    return o;
  }
  return getPriceAndChange(ticker, sym);
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
const FX_BASIS_TTL = 2 * 60 * 1000;   /* USD/INR moves little: one fetch per 2 min serves every MCX quote (was 10 s) */
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
/* One key space since the second (Kite) data-source context was removed; kept as a class so callers are unchanged. */
class SrcMap extends Map {
  k(key) { return key; }
  get(key) { return super.get(this.k(key)); }
  set(key, v) { return super.set(this.k(key), v); }
  has(key) { return super.has(this.k(key)); }
  delete(key) { return super.delete(this.k(key)); }
}
const API_CACHE = new SrcMap();
const INFLIGHT  = new SrcMap();
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
  /* NSE option chains / expiry lists (a handful of keys) are kept for a day: nseSwr serves them when NSE fails. */
  for (const [k, v] of API_CACHE) if (now - v.ts > (/^oc(info)?_/.test(k) ? 24 * 3600e3 : 30 * 60 * 1000)) API_CACHE.delete(k);
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
    if (now - v.ts > NEWS_STALE_MAX) delete NEWS_CACHE[k];   /* kept 6 h: served at once while a refresh runs */
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
const NEWS_STALE_MAX = 6 * 3600 * 1000;

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
  /* Whole words only (22 Nov 2026): "itc" used to match inside "bitcoin", so ITC's news showed crypto stories. The
     joined form ("hdfcbank" for "HDFC Bank") still counts, but only for names of 6+ letters. */
  const padded = ` ${text} `, compactT = text.replace(/ /g,'');
  for (const a of ctx.aliases) {
    if (!a || a.length < 3) continue;
    const compactA = a.replace(/ /g,'');
    if (padded.includes(` ${a} `)) score += a.split(' ').length >= 2 ? 35 : 18;
    else if (compactA.length >= 6 && compactT.includes(compactA)) score += 14;
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

function isQuotePageTitle(t) {
  return /\b(share|stock) price\b/i.test(t) && !/\b(jumps?|jumped|falls?|fell|rises?|rose|gains?|gained|drops?|dropped|slumps?|surges?|surged|soars?|tanks?|targets?|tops?|hits?|crash(es|ed)?|rall(y|ies|ied)|slips?|climbs?|plunges?|up|down|after|on|as)\b/i.test(t);
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
    /* Quote pages ("ITC Share Price Today - Live NSE/BSE", "ITC Share Price - Upstox") are not news (22 Nov 2026). */
    if (isQuotePageTitle(title)) continue;
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

  /* The key-based APIs (Marketaux tags articles by company - the most accurate for one stock; NewsData.io; Finnhub
     for gold / indices / global) now run alongside the free feeds on every fetch, when their key is set (22 Nov 2026:
     they used to run only when the feeds found under 4 headlines, which was almost never - so the keys sat unused).
     A symbol's news is cached 15 minutes, which keeps a personal app far inside their free daily limits.
     GDELT stays a backup for when everything else is thin. */
  const keyed = !!(MARKETAUX_KEY || NEWSDATA_KEY || (FINNHUB_KEY && (ctx.isMacro || ctx.isIndex)));
  const [rss, marketaux, newsdata, finnhub] = await Promise.all([
    withTimeoutFallback(fetchNewsRSSLayer(ctx), 5000, { items:[], health:[{source:'RSS layer', ok:false, error:'timeout'}] }),
    MARKETAUX_KEY ? withTimeoutFallback(fetchNewsMarketauxLayer(ctx), 6000, []) : Promise.resolve([]),
    NEWSDATA_KEY ? withTimeoutFallback(fetchNewsDataLayer(ctx), 6000, []) : Promise.resolve([]),
    FINNHUB_KEY && (ctx.isMacro || ctx.isIndex) ? withTimeoutFallback(fetchFinnhubLayer(ctx), 6000, []) : Promise.resolve([]),
  ]);
  health.push(...(rss.health || []));
  if (MARKETAUX_KEY) health.push({source:'Marketaux', ok:true, found:marketaux.length});
  if (NEWSDATA_KEY) health.push({source:'NewsData.io', ok:true, found:newsdata.length});
  if (FINNHUB_KEY && (ctx.isMacro || ctx.isIndex)) health.push({source:'Finnhub', ok:true, found:finnhub.length});
  let items = finalizeNews([...(rss.items || []), ...marketaux, ...newsdata, ...finnhub], ctx);
  const fromApi = items.some(i => ['marketaux', 'newsdata', 'finnhub'].includes(i.layer)), fromRss = items.some(i => i.layer === 'rss' || i.layer === 'google-rss');
  if (items.length) sourceUsed = fromApi && fromRss ? 'mixed' : fromApi ? 'api' : 'rss';
  if (!keyed && items.length) sourceUsed = 'rss';

  /* Backup: GDELT only when the above is thin. */
  if (items.length < 4) {
    const gdelt = await withTimeoutFallback(fetchNewsGdelt(ctx), 5000, []);
    health.push({source:'GDELT', ok:true, found:gdelt.length});
    items = finalizeNews([...items, ...gdelt], ctx);
    if (items.length && sourceUsed === 'none') sourceUsed = 'api-backup';
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
  const key  = `news_v15_${sym}_${newsHash(name)}`;

  const hit = NEWS_CACHE[key];
  if (hit && Date.now() - hit.ts < (hit.ttl || NEWS_TTL)) {
    return send(res, { ...hit.payload, cached: true, updatedAt: new Date(hit.ts).toISOString() });
  }
  /* Concurrent requests for the same key share one fetch instead of each fanning out. */
  const refresh = () => {
    let pending = NEWS_INFLIGHT.get(key);
    if (!pending) {
      pending = gatherAllNews(ctx).then(all => {
        const fresh24 = finalizeNews(filterNewsAge(all.items, 24), ctx, { maxAgeHrs: 24 });
        const week = finalizeNews(filterNewsAge(all.items, 168), ctx, { maxAgeHrs: 168 });
        const useFresh = fresh24.length >= 2;
        const finalItems = useFresh ? fresh24 : week;
        const sourceUsed = all.sourceUsed === 'none' && finalItems.length ? 'mixed' : all.sourceUsed;
        const payload = { items: finalItems, sym, source: sourceUsed, window: useFresh ? '24h' : '7d fallback', summary: newsSummary(finalItems, all.health, sourceUsed) };
        payload.summary.window = payload.window;
        const ttl = finalItems.length ? (ctx.isMacro ? NEWS_SOURCE_TTL.gold : NEWS_TTL) : EMPTY_NEWS_TTL;
        /* An empty answer never replaces earlier headlines (a feed blip used to blank the News tab). */
        if (finalItems.length || !NEWS_CACHE[key]?.payload?.items?.length) NEWS_CACHE[key] = { payload, ts: Date.now(), ttl };
        else NEWS_CACHE[key].ts = Date.now() - (NEWS_CACHE[key].ttl || NEWS_TTL) + EMPTY_NEWS_TTL;
        pruneNewsCache();
        return NEWS_CACHE[key];
      }).finally(() => NEWS_INFLIGHT.delete(key));
      NEWS_INFLIGHT.set(key, pending);
    }
    return pending;
  };
  /* Older than its TTL but under 6 h: answer at once with it and refresh in the background. The News tab used to
     wait for the full fan-out (up to ~13 s) every 15 minutes, which felt like the page was stuck. */
  if (hit && Date.now() - hit.ts < NEWS_STALE_MAX) {
    refresh().catch(e => console.warn('News refresh:', e.message));
    return send(res, { ...hit.payload, cached: true, refreshing: true, updatedAt: new Date(hit.ts).toISOString() });
  }
  try {
    const c = await refresh();
    send(res, { ...c.payload, updatedAt: new Date(c.ts).toISOString() });
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
    /* The NSE chain is requested first, in parallel with the spot price: both waits together must stay inside the
       page's 15 s limit (the chain used to wait up to 20 s after the spot, so a cold chain always ended as
       Black-Scholes estimates). */
    const wantChain = angelReady();   /* option builder: live premiums from Angel One when connected; else Black-Scholes only - no NSE call */
    const chainP = wantChain
      ? withTimeout(getOptionChain(sym, new Date(Date.now() + 5.5 * 3600000 + expiry * 86400000).toISOString().slice(0, 10), { estimate: false }), 11000, 'option chain').catch(() => null)
      : Promise.resolve(null);
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
    const expiryAsked = expiry;
    const chain = await chainP;
    if (chain?.expiry) expiry = Math.max(1, Math.round((Date.parse(chain.expiry + 'T15:30:00+05:30') - Date.now()) / 86400000));
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
      result.priceSource = liveLegs ? `${chain.source === 'Angel One' ? 'Angel One' : 'NSE'} live premiums (${liveLegs}/${optLegs} legs) · expiry ${chain.expiry}${chain.stale ? ' · saved quote' : ''}` : 'Black-Scholes estimate (no NSE quote for these strikes)';
      result.oi = { pcr: chain.pcr, maxPain: chain.maxPain, callWalls: chain.callWalls, putWalls: chain.putWalls, expiry: chain.expiry, nseSpot: chain.spot };
    }
    send(res, {
      sym, spot:+spot.toFixed(2), expiry, expiryAsked, iv:+(iv*100).toFixed(1),
      strikeInterval:si, lotSize:lot, ...result,
      updatedAt: new Date().toISOString(),
    });
  } catch(e) { err(res, e.message); }
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
const SHARES_TTL_MS = 45 * 24 * 60 * 60 * 1000;   /* share counts change at most quarterly (was 7 days: every weekly rebuild re-fetched all ~1,200) */
function universeFile() { return require('path').join(__dirname, 'data', 'universe.json'); }
function loadUniverseFromDisk() {
  try {
    const j = JSON.parse(require('fs').readFileSync(universeFile(), 'utf8'));
    if (j?.universe?.rows?.length) LIVE_UNIVERSE = j.universe;
    if (j?.shares && typeof j.shares === 'object') SHARES_CACHE = j.shares;
    if (j?.breadth?.pct != null) SV().LAST_BREADTH = j.breadth;
    if (j?.sectorStrength?.map) SV().LAST_SECTOR_STRENGTH = j.sectorStrength;
    if (Array.isArray(j?.resultsCal?.rows)) RESULTS_CAL_LAST_GOOD = j.resultsCal;
  } catch {}
}
function saveUniverseToDisk() {
  /* Never write before the saved universe is loaded (22 Nov 2026): a results-calendar save at that moment wrote
     "universe: null" over the file, losing the list and ~1,200 share counts. */
  if (!LIVE_UNIVERSE?.rows?.length) return;
  try {
    const fsm = require('fs'), dir = require('path').dirname(universeFile());
    fsm.mkdirSync(dir, { recursive: true });
    fsm.writeFileSync(universeFile(), JSON.stringify({ universe: LIVE_UNIVERSE, shares: SHARES_CACHE, breadth: SRCV.yahoo.LAST_BREADTH, sectorStrength: SRCV.yahoo.LAST_SECTOR_STRENGTH, resultsCal: RESULTS_CAL_LAST_GOOD }));
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
  UNIVERSE_INFLIGHT = SRC_ALS.run({ src: 'yahoo' }, () => buildUniverse()).catch(er => { console.warn('Universe refresh failed:', er.message); return LIVE_UNIVERSE; })
    .finally(() => { UNIVERSE_INFLIGHT = null; });
  return UNIVERSE_INFLIGHT;
}
async function buildUniverse() {
  const started = Date.now();
  let listed = [], source = '';
  try { listed = await fetchNseIndexList('ind_niftytotalmarket_list.csv'); source = 'NSE Nifty Total Market'; }
  catch (er) {
    try { listed = await fetchNseIndexList('ind_nifty500list.csv'); source = 'NSE Nifty 500'; }
    catch (er2) {
      /* NSE refused (it does on Render): re-price the stocks already known - the saved list plus the small ones. */
      const prev = [...(LIVE_UNIVERSE?.rows || []).map(r => ({ sym: r.sym, name: r.name, industry: r.industry || '' })),
        ...Object.keys(LIVE_UNIVERSE?.small || {}).map(t => ({ sym: t.replace(/\.NS$/, ''), name: t.replace(/\.NS$/, ''), industry: LIVE_UNIVERSE?.industry?.[t.replace(/\.NS$/, '')]?.industry || '' }))];
      if (prev.length < 100) throw er2;
      listed = prev; source = 'saved list (NSE unreachable)';
    }
  }
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
  /* Lighter weekly rebuild (22 Nov 2026): a stock last seen under ₹15,000 Cr would have to double in a week to reach
     the ₹35,000 Cr rule, so it is re-priced only in the full check every 4 weeks - about 1,000 fewer Yahoo calls a week. */
  const prevSmall = LIVE_UNIVERSE?.small || {};
  const fullDue = !LIVE_UNIVERSE?.lastFullAt || Date.now() - Date.parse(LIVE_UNIVERSE.lastFullAt) > 28 * 86400e3;
  const skipped = fullDue ? [] : tickers.filter(t => prevSmall[t] > 0 && prevSmall[t] < 15000);
  const skipSet = new Set(skipped), toCheck = tickers.filter(t => !skipSet.has(t));
  const rows = [], failed = [];
  await mapLimit(toCheck, 8, async t => {
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
  const small = {}; skipped.forEach(t => { small[t] = prevSmall[t]; });
  rows.forEach(r => { if (r.mcapCr > 0 && r.mcapCr < UNIVERSE_KEEP_MCAP_CR) small[r.ticker] = r.mcapCr; });
  LIVE_UNIVERSE = {
    generatedAt: new Date().toISOString(), source,
    rows: kept, industry, small,
    lastFullAt: fullDue ? new Date().toISOString() : LIVE_UNIVERSE.lastFullAt,
    stats: { listed: listed.length, recentListings: newOnes.length, checked: toCheck.length, skippedSmall: skipped.length, priced: rows.length, failed: failed.length,
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
  if (dow === 0 || dow === 6 || isNseHoliday(ist.toISOString().slice(0, 10))) return 1;
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

/* ── Independent 4-strategy scoring modules ──
   These modules READ the already-calculated EMA, RSI, MACD, ATR and S/R values.
   They do not change existing formulas, support/resistance levels or indicator calculations. */
function pctDistS(a, b) {
  a = Number(a); b = Number(b);
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? Math.abs(a - b) / Math.abs(b) * 100 : 999;
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
/* MY_TRADE_SCREENER_CACHE / _TS / _INFLIGHT, LAST_SCAN_DIAG: kept per data source in SRCV (top of file) */
const MY_TRADE_SCREENER_TTL = 30 * 60 * 1000; /* 30 min server cache to reduce Yahoo load */
/* Same rule as the page (scanPredatesClose in app.js): made during the NSE session, and that session is over. */
function scanPredatesCloseS(at) {
  const ms = Date.parse(at || ''); if (!Number.isFinite(ms)) return false;
  const ist = x => { const t = new Date(x + 5.5 * 3600000); return { d: t.toISOString().slice(0, 10), m: t.getUTCHours() * 60 + t.getUTCMinutes(), wd: t.getUTCDay() }; };
  const s = ist(ms), n = ist(Date.now());
  if (!(s.wd >= 1 && s.wd <= 5 && s.m >= 555 && s.m < 930)) return false;
  return n.d !== s.d || n.m >= 930;
}


/* Setups that can be shown and alerted on, but are never a READY (buy-now) signal. */
/* Same wording as the Overview's Ready Gate. */
const NIFTY_TREND_WHY = 'Nifty not in an uptrend (needs Nifty above its EMA50 and EMA20 above EMA50) - no fresh swing longs';
/* Daily bars that are complete: today's bar is still forming between 09:15 and 15:35 IST (same rule as the
   Overview's getConfirmedDailyIndex). */
function completedLenS(T) {
  const n = (T || []).length; if (!n) return 0;
  const { m, key } = istNowParts();
  return istDateKeyS(T[n - 1]) === key && m >= 9 * 60 + 15 && m < 15 * 60 + 35 ? n - 1 : n;
}

/* The stock-level READY checks, in one place: the live scan and the backtest call this, so the backtest
   measures exactly the rules the screener applies. Results dates and the sector-strength gate are applied by
   the caller (the backtest has no historical results calendar). */


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

function istDateKeyS(unixSec) { return new Date(unixSec * 1000 + 5.5 * 3600000).toISOString().slice(0, 10); }

/* ══════════════════════════════════════════════════════════════════
   MONTHLY MOMENTUM (separate from the swing screener) - the method that backtested best on 8.8 years
   (Jan 2018 - Oct 2026, after 0.25% per swap): 13.1% a year vs Nifty 9.4%, worst fall -30% (-21% with the
   Nifty 200-day filter), behind Nifty in 4 of 9 years.
   - Universe: the 100 largest stocks of the screener universe by market cap at the month-end close.
   - Score (NSE-style, as Nifty200 Momentum 30): average of the 6- and 12-month returns / 1-year volatility.
   - List: top 20, equal weight, decided on the last close of the previous month and held for the whole month.
   Uses the same cached 2-year daily charts as the screener scan (no extra calls after a scan).
══════════════════════════════════════════════════════════════════ */
let MOMENTUM_CACHE = null, MOMENTUM_INFLIGHT = null;
const MOM_TOP = 20, MOM_UNIVERSE = 100;
function momScoreS(C, i) {
  if (i < 253) return null;
  const r6 = C[i] / C[i - 126] - 1, r12 = C[i] / C[i - 252] - 1;
  let m = 0; const d = [];
  for (let k = i - 251; k <= i; k++) { const x = Math.log(C[k] / C[k - 1]); d.push(x); m += x; }
  m /= d.length;
  const vol = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / d.length) * Math.sqrt(252);
  return vol > 0 ? { score: (r6 + r12) / 2 / vol, r6: r6 * 100, r12: r12 * 100, vol: vol * 100 } : null;
}
function momRankS(data, dateKey) {   // dateKey: rank on the last close on or before this date
  const rows = [];
  for (const x of data) {
    let i = x.b.T.length - 1; while (i >= 0 && istDateKeyS(x.b.T[i]) > dateKey) i--;
    const sc = i >= 0 ? momScoreS(x.b.C, i) : null;
    if (!sc) continue;
    const sh = SHARES_CACHE[x.ticker]?.shares;
    rows.push({ ticker: x.ticker, sym: x.ticker.replace(/\.(NS|BO)$/, ''), close: x.b.C[i], date: istDateKeyS(x.b.T[i]), mcapCr: sh ? sh * x.b.C[i] / 1e7 : null, ...sc });
  }
  const big = rows.filter(r => r.mcapCr).sort((a, b) => b.mcapCr - a.mcapCr).slice(0, MOM_UNIVERSE);
  return big.sort((a, b) => b.score - a.score).map((r, k) => ({ ...r, rank: k + 1 }));
}
function monthStartKey(key, back = 0) { const d = new Date(key.slice(0, 7) + '-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - back); return d.toISOString().slice(0, 10); }
function prevDayKey(key) { const d = new Date(key + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); }
function firstTradingDayOfMonth(key) {
  let d = new Date(key.slice(0, 7) + '-01T00:00:00Z');
  for (let k = 0; k < 10; k++) { const kk = d.toISOString().slice(0, 10); if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && !isNseHoliday(kk)) return kk; d.setUTCDate(d.getUTCDate() + 1); }
  return key;
}
async function computeMomentumS() {
  const uni = screenerEligibleUniverseS(), data = [];
  for (let i = 0; i < uni.length; i += 8) {
    await Promise.all(uni.slice(i, i + 8).map(async ticker => {
      try {
        const raw = await withTimeout(safeFetch(() => yfChart(ticker, '1d', '2y'), 1), 20000, ticker + ' momentum history');
        const b = raw ? parseBars(raw) : null;
        if (!b || b.C.length < 260) return;
        const cl = completedLenS(b.T);
        ['T', 'O', 'H', 'L', 'C', 'V'].forEach(k => { b[k] = b[k].slice(0, cl); });
        data.push({ ticker, b });
      } catch {}
    }));
  }
  const today = istNowParts().key;
  const thisMonth = monthStartKey(today), lastMonth = monthStartKey(today, 1);
  const cur = momRankS(data, prevDayKey(thisMonth)), prev = momRankS(data, prevDayKey(lastMonth)), live = momRankS(data, today);
  const top = cur.slice(0, MOM_TOP), prevTop = prev.slice(0, MOM_TOP);
  const prevSet = new Set(prevTop.map(r => r.sym)), curSet = new Set(top.map(r => r.sym));
  const liveRank = new Map(live.map(r => [r.sym, r.rank])), liveClose = new Map(live.map(r => [r.sym, r.close]));
  const nifty = await getNiftyRegime();
  /* Portfolio read-out (21 Nov 2026): equal-weight average of the 20 - this month from the list's close to now, and their
     6 / 12-month returns as of the list date - with Nifty over the same windows. */
  const avg = a => a.length ? +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(1) : null;
  const perf = { mtd: avg(top.map(r => { const now = liveClose.get(r.sym); return now > 0 && r.close > 0 ? (now / r.close - 1) * 100 : null; }).filter(v => v != null)),
    r6: avg(top.map(r => r.r6)), r12: avg(top.map(r => r.r12)), nifty: null };
  try {
    const nb = parseBars(await withTimeout(safeFetch(() => yfChart('^NSEI', '1d', '2y'), 1), 15000, 'Nifty history'));
    let iL = nb.T.length - 1; while (iL >= 0 && istDateKeyS(nb.T[iL]) > (top[0]?.date || today)) iL--;
    const nLast = nb.C.length - 1, ret = (a, b) => a >= 0 && b >= 0 && nb.C[b] > 0 ? +((nb.C[a] / nb.C[b] - 1) * 100).toFixed(1) : null;
    perf.nifty = { mtd: ret(nLast, iL), r6: ret(iL, iL - 126), r12: ret(iL, iL - 252) };
  } catch {}
  const nextMonth = monthStartKey(new Date(Date.parse(thisMonth) + 40 * 864e5).toISOString().slice(0, 10));
  const out = {
    month: thisMonth.slice(0, 7), listDate: top[0]?.date || null, rebalanceDay: firstTradingDayOfMonth(thisMonth), nextRebalance: firstTradingDayOfMonth(nextMonth),
    holdings: top.map(r => ({ sym: r.sym, rank: r.rank, score: +r.score.toFixed(2), r6: +r.r6.toFixed(1), r12: +r.r12.toFixed(1), vol: +r.vol.toFixed(1),
      price: +(liveClose.get(r.sym) ?? r.close).toFixed(2), mcapCr: r.mcapCr ? Math.round(r.mcapCr) : null, sector: sectorInfoFor(r.sym)?.sector || null,
      isNew: !prevSet.has(r.sym), liveRank: liveRank.get(r.sym) || null })),
    sells: prevTop.filter(r => !curSet.has(r.sym)).map(r => ({ sym: r.sym, nowRank: cur.find(x => x.sym === r.sym)?.rank || null })),
    buys: top.filter(r => !prevSet.has(r.sym)).map(r => r.sym),
    livePreview: live.slice(0, MOM_TOP).map(r => ({ sym: r.sym, rank: r.rank, inList: curSet.has(r.sym) })),
    niftyFilter: { aboveSma200: nifty.aboveSma200 ?? null, nifty: nifty.nifty ?? null, sma200: nifty.sma200 ?? null },
    universe: { stocks: data.length, ranked: cur.length }, perf,
    generatedAt: new Date().toISOString(),
  };
  MOMENTUM_CACHE = { ts: Date.now(), value: out };
  return out;
}
async function apiMomentum(req, res, p) {
  const fresh = p.get('refresh') === '1';
  /* The list changes once a month; the live preview and prices are refreshed at most every 2 hours. */
  if (!fresh && MOMENTUM_CACHE && Date.now() - MOMENTUM_CACHE.ts < 2 * 3600e3 && MOMENTUM_CACHE.value.month === istNowParts().key.slice(0, 7)) return send(res, { ...MOMENTUM_CACHE.value, cached: true });
  if (!MOMENTUM_INFLIGHT) MOMENTUM_INFLIGHT = computeMomentumS().finally(() => { MOMENTUM_INFLIGHT = null; });
  try { send(res, await MOMENTUM_INFLIGHT); } catch (e) { err(res, 'Momentum ranking failed: ' + e.message); }
}

/* ── Nifty market regime ──
   Swing longs work best when the index trend supports them. READY is allowed only while Nifty holds
   above its EMA50; below EMA50 every candidate is shown as Watchlist with the regime as the reason.
   If Nifty data cannot be loaded the filter is skipped (and says so) rather than blocking everything. */
/* NIFTY_REGIME_CACHE / _TS, NIFTY_CLOSES: per data source in SRCV */
/* Breadth = % of the scanned universe trading above its 50-day average (updated by every screener scan). */
/* LAST_BREADTH {pct, above, total, ts}, LAST_SECTOR_STRENGTH: per data source in SRCV */
/* Sector strength from the last screener scan: average 1-month return of the universe stocks in each sector
   (3+ stocks). {ts, map:{sector:{rank, ret, of, n}}}. Used by the Ready Gate (Overview and screener). */
function sectorStrengthFor(code) {
  const sec = sectorInfoFor(code)?.sector, sp = sec && SV().LAST_SECTOR_STRENGTH?.map?.[sec];
  return sp ? { sector: sec, ret1m: sp.ret, rank: sp.rank, of: sp.of, n: sp.n, at: new Date(SV().LAST_SECTOR_STRENGTH.ts).toISOString() } : (sec ? { sector: sec, ret1m: null } : null);
}
/* Market regime from index trend AND breadth:
   - Nifty above EMA50 with breadth >= 40%  -> longs allowed (BULL if breadth >= 55% and Nifty above EMA20)
   - Nifty above EMA50 but breadth < 40%    -> NARROW: index held up by a few stocks, no fresh longs
   - Nifty below EMA50 but breadth >= 60%   -> RECOVERY: broad strength returning, longs allowed
   - otherwise                              -> CORRECTION / BEAR, no fresh longs
   Without a recent breadth reading the Nifty-only rule is used. */
function marketRegime(nifty, breadthMaxAgeMs = 18 * 3600e3) {
  const b = SV().LAST_BREADTH && Date.now() - SV().LAST_BREADTH.ts < breadthMaxAgeMs ? SV().LAST_BREADTH : null; /* breadth only changes in market hours */
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
  if (SV().NIFTY_REGIME_CACHE && Date.now() - SV().NIFTY_REGIME_TS < 10 * 60 * 1000) return SV().NIFTY_REGIME_CACHE;
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
       aboveSma200: Nifty above its 200-day average (the Monthly momentum filter). */
    const sma200 = C.slice(n - 200).reduce((a, b) => a + b, 0) / 200;
    SV().NIFTY_REGIME_CACHE = { status, allowReady, nifty:+price.toFixed(2), ema20:+e20.toFixed(2), ema50:+e50.toFixed(2), ema200:+e200.toFixed(2), note,
      trendUp: price > e50 && e20 > e50, sma200: +sma200.toFixed(2), aboveSma200: price > sma200 };
    SV().NIFTY_CLOSES = C.slice();
    SV().NIFTY_REGIME_TS = Date.now();
    return SV().NIFTY_REGIME_CACHE;
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
    if (dow !== 0 && dow !== 6 && !isNseHoliday(new Date(d).toISOString().slice(0, 10))) count += step;
  }
  /* Results on a weekend are priced in on the next session, so count that session. */
  const endDow = new Date(end).getUTCDay();
  if (step > 0 && (endDow === 0 || endDow === 6)) count += 1;
  return count;
}
/* ── Free fallbacks when NSE refuses (22 Nov 2026) ──
   NSE refuses Render's address, so results dates, bonus / split dates and FII / DII never arrived there.
   - Results + dividend ex-dates: Yahoo's calendar per stock (quoteSummary calendarEvents, needs Yahoo's cookie +
     crumb). Only the screener universe, each stock at most every 3 days, 40 a run - spread through the day.
     A date Yahoo marks as an estimate is a note, not a block.
   - Bonus / split: Yahoo's market-wide split calendar (a bonus shows as a split there), 30 days ahead, NSE rows only.
   - FII / DII: Moneycontrol's FII / DII page (cash market, last 10 sessions), once every 3 hours (every 30 minutes
     after 18:00 IST until the day's row is there).
   Each is used only while NSE's own list is missing, and saved in data/free-cal.json. */
const FREE_CAL_FILE = require('path').join(__dirname, 'data', 'free-cal.json');
let FREE_CAL = { earn: {}, splits: {}, splitsTs: 0, fiiDii: null, fiiTs: 0 };
try { const j = JSON.parse(require('fs').readFileSync(FREE_CAL_FILE, 'utf8')); if (j && typeof j === 'object') FREE_CAL = { ...FREE_CAL, ...j }; } catch {}
function saveFreeCal() { try { const fs = require('fs'); fs.mkdirSync(require('path').dirname(FREE_CAL_FILE), { recursive: true }); fs.writeFileSync(FREE_CAL_FILE, JSON.stringify(FREE_CAL)); } catch {} }
let YF_CRUMB = { crumb: null, cookie: '', ts: 0 };
async function yahooCrumb(force = false) {
  if (!force && YF_CRUMB.crumb && Date.now() - YF_CRUMB.ts < 12 * 3600e3) return YF_CRUMB;
  const r0 = await withTimeout(getWithHeaders('https://fc.yahoo.com/', { Accept: 'text/html' }), 10000, 'Yahoo cookie');
  const cookie = (r0.headers?.['set-cookie'] || []).map(c => String(c).split(';')[0]).join('; ');
  if (!cookie) throw new Error('no Yahoo cookie');
  const r = await withTimeout(get('https://query1.finance.yahoo.com/v1/test/getcrumb', { Cookie: cookie, Accept: 'text/plain' }), 10000, 'Yahoo crumb');
  const crumb = String(r.body || '').trim();
  if (r.status !== 200 || !crumb || crumb.length > 40 || /[<{]/.test(crumb)) throw new Error('no Yahoo crumb (HTTP ' + r.status + ')');
  return (YF_CRUMB = { crumb, cookie, ts: Date.now() });
}
async function yahooCalendarOne(ticker) {
  let c = await yahooCrumb();
  const go = () => get(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=calendarEvents&crumb=${encodeURIComponent(c.crumb)}`, { Cookie: c.cookie, Accept: 'application/json' });
  let r = await withTimeout(go(), 10000, ticker + ' calendar');
  if (r.status === 401) { c = await yahooCrumb(true); r = await withTimeout(go(), 10000, ticker + ' calendar'); }
  if (r.status !== 200) throw new Error('calendar HTTP ' + r.status);
  const ce = JSON.parse(r.body)?.quoteSummary?.result?.[0]?.calendarEvents || {};
  const day = v => v > 0 ? istDateKeyS(v) : null;
  return { earn: day(ce.earnings?.earningsDate?.[0]?.raw), est: !!ce.earnings?.isEarningsDateEstimate, exDiv: day(ce.exDividendDate?.raw), ts: Date.now() };
}
let FREE_CAL_RUNNING = false;
async function freeCalendarTick() {
  if (FREE_CAL_RUNNING) return;
  FREE_CAL_RUNNING = true;
  try {
    const nseResults = RESULTS_CAL_CACHE?.source === 'NSE event calendar' && !RESULTS_CAL_CACHE.error;
    const nseCorp = NSE_CAL.ts.corp && Date.now() - NSE_CAL.ts.corp < 2 * 86400e3;
    let changed = false;
    if (!nseResults || !nseCorp) {
      const tickers = (LIVE_UNIVERSE?.rows || []).filter(r => r.mcapCr > MIN_SCREENER_MCAP_CR).map(r => r.ticker);
      const due = tickers.filter(t => !(FREE_CAL.earn[t]?.ts > Date.now() - 3 * 86400e3)).slice(0, 50);
      for (const t of due) {
        try { FREE_CAL.earn[t] = await yahooCalendarOne(t); changed = true; }
        catch (e) { if (/crumb|cookie|429|paused/i.test(e.message)) { console.warn('Yahoo calendar:', e.message); break; } FREE_CAL.earn[t] = { ts: Date.now(), error: true }; }
      }
    }
    if (!nseCorp && Date.now() - (FREE_CAL.splitsTs || 0) > 20 * 3600e3) {
      try {
        const c = await yahooCrumb(), from = istDateKey(), to = istDateKeyS(Date.now() / 1000 + 30 * 86400), splits = {};
        for (let off = 0; off < 1000; off += 250) {
          const body = JSON.stringify({ sortType: 'ASC', entityIdType: 'splits', sortField: 'startdatetime', includeFields: ['ticker', 'companyshortname', 'startdatetime', 'old_share_worth', 'share_worth'],
            query: { operator: 'and', operands: [{ operator: 'gte', operands: ['startdatetime', from] }, { operator: 'lte', operands: ['startdatetime', to] }] }, offset: off, size: 250 });
          const r = await withTimeout(get(`https://query1.finance.yahoo.com/v1/finance/visualization?lang=en-US&region=US&crumb=${encodeURIComponent(c.crumb)}`, { Cookie: c.cookie, 'Content-Type': 'application/json', Accept: 'application/json' }, body, 'POST'), 15000, 'Yahoo splits');
          if (r.status !== 200) throw new Error('splits HTTP ' + r.status);
          const rows = JSON.parse(r.body)?.finance?.result?.[0]?.documents?.[0]?.rows || [];
          for (const [tk, name, at, oldW, newW] of rows) {
            if (!/\.NS$/.test(String(tk))) continue;
            const sym = String(tk).replace(/\.NS$/, '').toUpperCase(), date = String(at || '').slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(date)) (splits[sym] = splits[sym] || []).push({ date, subject: `Split / bonus ${+newW || '?'}:${+oldW || '?'} (Yahoo)`, kind: 'split' });
          }
          if (rows.length < 250) break;
        }
        FREE_CAL.splits = splits; FREE_CAL.splitsTs = Date.now(); changed = true;
      } catch (e) { FREE_CAL.splitsTs = Date.now() - 14 * 3600e3; console.warn('Yahoo splits:', e.message); }   /* retry in ~6 h */
    }
    if (changed) { saveFreeCal(); if (!nseResults) RESULTS_CAL_TS = 0; }
  } finally { FREE_CAL_RUNNING = false; }
}
setTimeout(() => freeCalendarTick().catch(() => {}), 3 * 60e3);
setInterval(() => freeCalendarTick().catch(() => {}), 60 * 60e3);
/* GIFT Nifty (24 Nov 2026): Nifty futures on NSE IX, trading ~21 h a day - the pre-open cue for the Nifty gap.
   Free source: Moneycontrol's live-index page (__NEXT_DATA__ stockData: lastprice / prevclose / lastupdated, IST).
   One request at most every 3 minutes, shared by every page load. */
let GIFT = { v: null, ts: 0, tried: 0, err: null }, GIFT_INFLIGHT = null;
async function getGiftNifty() {
  if (Date.now() - GIFT.tried < (GIFT.err ? 60e3 : 3 * 60e3)) return GIFT.v;
  if (GIFT_INFLIGHT) return GIFT_INFLIGHT;
  GIFT_INFLIGHT = (async () => {
    GIFT.tried = Date.now();
    try {
      const r = await withTimeout(get('https://www.moneycontrol.com/live-index/gift-nifty', { Accept: 'text/html' }), 12000, 'GIFT Nifty');
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const m = String(r.body || '').match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      const sd = m ? JSON.parse(m[1])?.props?.pageProps?.consumptionData?.stockData : null;
      const num = x => +String(x ?? '').replace(/,/g, '');
      const price = num(sd?.lastprice), prev = num(sd?.prevclose);
      if (!(price > 0 && prev > 0)) throw new Error('no price on the page');
      /* "24 Nov, 2026 21:07" in IST -> unix seconds, so the card shows Live / Closed like the others */
      const t = String(sd.lastupdated || '').match(/(\d{1,2}) (\w{3}),? (\d{4}) (\d{1,2}):(\d{2})/);
      const at = t ? Math.round((Date.parse(`${t[1]} ${t[2]} ${t[3]} ${t[4]}:${t[5]}:00 GMT+0530`) || 0) / 1000) || null : null;
      GIFT.v = { label: 'GIFT Nifty', cat: 'india', ticker: 'GIFT NIFTY', price, prev, chg: +(price - prev).toFixed(2), pct: +((price / prev - 1) * 100).toFixed(2), isUp: price >= prev, at, source: 'Moneycontrol' };
      GIFT.ts = Date.now(); GIFT.err = null;
    } catch (e) { GIFT.err = e.message; /* retry in a minute; a value over 30 min old is not shown */ }
    return GIFT.v && Date.now() - GIFT.ts < 30 * 60e3 ? GIFT.v : null;
  })().finally(() => { GIFT_INFLIGHT = null; });
  return GIFT_INFLIGHT;
}
/* FII / DII cash-market net (Rs Cr) from Moneycontrol, last 10 sessions; the saved copy when it fails. */
let FII_INFLIGHT = null;
setTimeout(() => getFiiDii().catch(() => {}), 60e3);
setInterval(() => getFiiDii().catch(() => {}), 30 * 60e3);
/* How long a saved copy is good for. Moneycontrol posts the day's row late in the evening (23 Nov 2026: not there at
   21:07 IST, there by 22:55), and a flat 3 hours kept the previous day until about midnight. From 18:00 IST on an NSE
   trading day, while the latest row is not today's, check every 30 minutes (one request each); otherwise 3 hours. */
function fiiMaxAge() {
  const t = new Date(Date.now() + 330 * 60000), key = t.toISOString().slice(0, 10), m = t.getUTCHours() * 60 + t.getUTCMinutes(), wd = t.getUTCDay();
  const tradingDay = wd !== 0 && wd !== 6 && !isNseHoliday(key);
  return tradingDay && m >= 18 * 60 && FREE_CAL.fiiDii?.days?.[0]?.date !== key ? 30 * 60e3 : 3 * 3600e3;
}
async function getFiiDii() {
  if (FREE_CAL.fiiDii && Date.now() - FREE_CAL.fiiTs < fiiMaxAge()) return FREE_CAL.fiiDii;
  if (FII_INFLIGHT) return FII_INFLIGHT;
  FII_INFLIGHT = (async () => {
    try {
      const r = await withTimeout(get('https://www.moneycontrol.com/markets/fii-dii-data/', { Accept: 'text/html' }), 15000, 'FII / DII');
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const m = String(r.body).match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      const rows = m ? JSON.parse(m[1])?.props?.pageProps?.FiiDiiData?.fiiDiiData : null;
      const num = v => { const n = +String(v ?? '').replace(/,/g, ''); return Number.isFinite(n) ? n : null; };
      const days = (Array.isArray(rows) ? rows : []).map(x => ({ date: String(x.date || '').slice(0, 10), fii: num(x.fiiCM), dii: num(x.diiCM), fiiIdxFut: num(x.fiiIdxFut) }))
        .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.fii != null && x.dii != null).slice(0, 10);
      if (!days.length) throw new Error('no FII / DII rows');
      FREE_CAL.fiiDii = { days, source: 'Moneycontrol (NSE provisional data)', fetchedAt: new Date().toISOString() }; FREE_CAL.fiiTs = Date.now(); FREE_CAL.fiiErr = null; saveFreeCal();
    } catch (e) {
      const mcErr = 'Moneycontrol: ' + e.message;
      console.warn('FII / DII', mcErr);
      /* Second source: NSDL (the depository) - FPI equity net on the stock exchanges, reported for the previous
         trading day. FII only (no DII). Used when Moneycontrol refuses this server. */
      try {
        const r = await withTimeout(get('https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx', { Accept: 'text/html' }), 15000, 'NSDL FPI');
        if (r.status !== 200) throw new Error('HTTP ' + r.status);
        const t = String(r.body).replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
        const m = t.match(/(\d{2}-[A-Za-z]{3}-\d{4})\s+Equity\s+Stock Exchange\s+([\d,.]+)\s+([\d,.]+)\s+(\(?[\d,.]+\)?)/);
        if (!m) throw new Error('unexpected NSDL page');
        const num = v => { const neg = /\(/.test(v), n = +String(v).replace(/[(),]/g, ''); return neg ? -n : n; };
        const date = nseDdMmmToKey(m[1]);
        if (!date) throw new Error('NSDL date');
        const prev = (FREE_CAL.fiiDii?.days || []).filter(x => x.date !== date && x.src === 'nsdl');
        FREE_CAL.fiiDii = { days: [{ date, fii: num(m[4]), dii: null, src: 'nsdl' }, ...prev].slice(0, 10), source: 'NSDL (FPI equity, stock exchange; no DII)', fetchedAt: new Date().toISOString() };
        FREE_CAL.fiiTs = Date.now(); FREE_CAL.fiiErr = mcErr; saveFreeCal();
      } catch (e2) {
        FREE_CAL.fiiErr = `${mcErr}; NSDL: ${e2.message}`; console.warn('FII / DII NSDL:', e2.message);
        FREE_CAL.fiiTs = Date.now() - Math.max(0, fiiMaxAge() - 60 * 60e3);   /* try again in an hour (30 min in the evening) */
      }
    }
    return FREE_CAL.fiiDii;
  })().finally(() => { FII_INFLIGHT = null; });
  return FII_INFLIGHT;
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
    const evPath = `/api/event-calendar?index=equities&from_date=${nseDateParam(Date.now() - 3 * 86400000)}&to_date=${nseDateParam(Date.now() + 12 * 86400000)}`;
    const mk = () => ({ u: NSE_WWW + evPath, hdr: { Accept:'application/json', Referer: NSE_WWW + '/companies-listing/corporate-filings-event-calendar', Origin: NSE_WWW } });
    let { u, hdr } = mk();
    /* 15 s: the time includes the wait in the NSE queue (one request at a time, 2 s apart). */
    let r = await withTimeout(get(u, hdr), 15000, 'NSE event calendar');
    if (nseFollowMove(r)) { ({ u, hdr } = mk()); r = await withTimeout(get(u, hdr), 15000, 'NSE event calendar (new address)'); }
    if (r.status === 401 || r.status === 403) {
      /* Some hosts need NSE session cookies: take them from the event-calendar page and retry once. */
      const page = await withTimeout(getWithHeaders(NSE_WWW + '/companies-listing/corporate-filings-event-calendar', { Accept:'text/html' }), 15000, 'NSE cookie warm-up');
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
  if (source !== 'NSE event calendar') {
    let n = 0;
    for (const [t, e] of Object.entries(FREE_CAL.earn || {})) if (e?.earn && !e.error) { const sym = t.replace(/\.NS$/, ''); if (!bySym.has(sym.toUpperCase()) || !bySym.get(sym.toUpperCase()).some(x => x.date === e.earn)) { add(sym, e.earn, e.est ? 'Results (Yahoo estimate)' : 'Financial Results (Yahoo)'); const l = bySym.get(sym.toUpperCase()); l[l.length - 1].estimate = !!e.est; n++; } }
    if (n) { ok = true; source = (source === 'manual list only' ? '' : source + ' + ') + `Yahoo calendar (${n} stocks)`; }
  }
  EARNINGS_DATES.forEach(x => add(String(x.sym).replace('NSE:',''), x.date, 'Results (manual list)'));
  RESULTS_CAL_CACHE = { bySym, ok, source, error, fetchedAt: new Date().toISOString() };
  /* Retry a failed fetch after ~10 minutes instead of an hour. */
  RESULTS_CAL_TS = ok && !error ? Date.now() : Date.now() + 2 * 3600e3;   /* NSE refused / failed: next try in 3 hours (it refuses Render) */
  return RESULTS_CAL_CACHE;
}
function resultsCheckFor(sym, cal, todayKey) {
  const list = cal?.bySym?.get(String(sym).toUpperCase());
  if (!list || !list.length) return null;
  const upcoming = list.filter(x => x.date >= todayKey).sort((a,b) => a.date.localeCompare(b.date))[0];
  const pick = upcoming || list.sort((a,b) => b.date.localeCompare(a.date))[0];
  const tradingDays = tradingDaysUntil(todayKey, pick.date);
  /* A date Yahoo marks as an estimate is shown, but does not block. */
  return { date: pick.date, purpose: pick.purpose, tradingDays, estimate: !!pick.estimate, block: !pick.estimate && tradingDays >= 0 && tradingDays <= RESULTS_BLOCK_TRADING_DAYS, recent: tradingDays < 0 && tradingDays >= -2 };
}

async function apiMyTradeScreener(req, res) {
  const q = url.parse(req.url, true).query || {};
  /* A forced rescan (~250 Yahoo calls) is allowed at most every 5 minutes; inside that, the fresh result is reused. */
  /* A scan made while NSE was open is not reused after that session closed (the Overview then uses the final close). */
  const cacheOk = SV().MY_TRADE_SCREENER_CACHE && !scanPredatesCloseS(SV().MY_TRADE_SCREENER_CACHE.generatedAt);
  const forceRefresh = (q.refresh === '1' || q.force === '1' || q.nocache === '1') && !(cacheOk && Date.now() - SV().MY_TRADE_SCREENER_TS < 5 * 60 * 1000);
  if (!forceRefresh && cacheOk && Date.now() - SV().MY_TRADE_SCREENER_TS < MY_TRADE_SCREENER_TTL) return send(res, SV().MY_TRADE_SCREENER_CACHE);
  /* A full scan is ~150 Yahoo calls. Concurrent requests (several tabs, refresh clicks) now share the
     scan already running instead of each starting another one. */
  if (!SV().MY_TRADE_SCREENER_INFLIGHT) {
    SV().MY_TRADE_SCREENER_INFLIGHT = runMyTradeScreenerScan().finally(() => { SV().MY_TRADE_SCREENER_INFLIGHT = null; });
  }
  try { send(res, await SV().MY_TRADE_SCREENER_INFLIGHT); }
  catch (e) { err(res, e.message); }
}

/* One line: what exactly has to happen (and at what price) for this stock to become READY. */

/* Per-stock outcome of the last scan (every eligible stock, not just the top 20) - for /api/screener-diag. */
async function runMyTradeScreenerScan() {
  const scanDiag = [], sectorRet = [];

  /* Market regime (Nifty vs EMA20/50/200) and the results calendar are loaded once per scan. */
  const [niftyTrend, resultsCal] = await Promise.all([getNiftyRegime(), getResultsCalendar()]);
  const niftyCloses = SV().NIFTY_CLOSES;
  const todayKey = istDateKey();
  let resultsBlockedCount = 0, regimeBlockedCount = 0, eventBlockedCount = 0;

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
  const patternCands = [], bo20Cands = [];

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
        /* 1-month return for the sector-strength ranking (every eligible stock counts, not only bullish ones). */
        const secInfo = sectorInfoFor(ticker);
        if (secInfo?.sector && C.length > 22) sectorRet.push({ sector: secInfo.sector, ret: (C[C.length-1] / C[C.length-22] - 1) * 100 });
        const dg = { sym: ticker.replace(/\.(NS|BO)$/,''), price: +m.price.toFixed(2), bias: m.bias, picked: m.picked || null,
          decisionScore: m.decisionScore, rr: m.rrBull, longTrend: m.price > m.e200 && m.e50 > m.e200 };
        scanDiag.push(dg);
        const bullish = m.bias === 'Bullish';
        if (bullish) biasEligibleCount++;
        /* Tags (backtested, shown and recorded - they do not change READY) and the Pattern breakouts list. */
        const sym0 = ticker.replace(/\.(NS|BO)$/, ''), stTags = SwingPlan.stockTags({ H, L, C }) || {};
        const tags = { hhhl: !!stTags.hhhl, off52: stTags.off52 ?? null, near52: !!stTags.near52, dbAbove: !!stTags.dbAbove, dbNeck: stTags.doubleBottom?.neck ?? null };
        if (bullish) { const pb = SwingPlan.patternBreakout({ H, L, C, V, atr: m.atr }); if (pb) patternCands.push({ sym: sym0, ticker, ...pb, tags }); }

        /* Swing READY gate (tested 20 Nov 2026, SwingPlan.swingGate): EMA20/50 cross with relative strength, or a gap-up
           near the 52-week high. The signal is a CLOSE: during the session yesterday's completed bar is the signal (buy
           now); today's forming bar counts from 15:00 (near the close) - before that it waits on the Watchlist. The old
           pullback / breakout READY (44% wins, 6 of 10 years) is no longer a READY rule. */
        const rs = SwingPlan.relStrength(C, niftyCloses);
        const freshOf = (signal, stop, eventsClear = null) => { try { return SwingPlan.stockScores({ H, L, C }, { signal, stop, niftyUp: niftyTrend ? niftyTrend.trendUp !== false : null, rs3m: rs.rs3m, eventsClear })?.fresh ?? null; } catch { return null; } };
        { const pc = patternCands[patternCands.length - 1]; if (pc && pc.sym === sym0 && pc.fresh == null) pc.fresh = freshOf('pattern', pc.stop); }
        const nB = C.length, liveBar = completedLenS(daily.T) < nB, nearClose = istNowParts().m >= 15 * 60;
        const vToday = null;   /* enrichDailyForLiveScreenerS already projected today's volume to a full day - do not do it twice */
        const D = { O: daily.O, H, L, C, V, rs3m: rs.rs3m, entry: m.price };
        const gPrev = liveBar ? SwingPlan.swingGate({ ...D, i: nB - 2 }) : null;
        const gNow = SwingPlan.swingGate({ ...D, vToday });
        const g = gPrev?.ok ? gPrev : gNow;
        /* 20-day breakout list (separate from READY, tested 21 Nov 2026): same signal-on-a-close rule as READY. */
        { const bPrev = liveBar ? SwingPlan.breakout20({ H, L, C, V, i: nB - 2, rs3m: rs.rs3m, entry: m.price }) : null;
          const bNow = SwingPlan.breakout20({ H, L, C, V, rs3m: rs.rs3m, vToday, entry: m.price });
          const bo = bPrev?.ok ? bPrev : bNow?.ok ? bNow : null;
          if (bo) bo20Cands.push({ sym: sym0, ticker, ...bo, fresh: freshOf('breakout', bo.stop), price: +m.price.toFixed(2), signalDay: bPrev?.ok ? 'yesterday' : 'today', signalDate: istDateKeyS(daily.T[bPrev?.ok ? nB - 2 : nB - 1]),
            forming: !bPrev?.ok && liveBar && !nearClose, tags }); }
        if (!g) return null;
        const signalDay = gPrev?.ok ? 'yesterday' : 'today', forming = g.ok && signalDay === 'today' && liveBar && !nearClose;
        const signalDate = istDateKeyS(daily.T[gPrev?.ok ? nB - 2 : nB - 1]);
        const nearTxt = !g.ok ? (gNow?.near || gPrev?.near || null) : null;
        if (!g.ok && !nearTxt) return null;
        const resultsInfo = resultsCheckFor(sym0, resultsCal, todayKey), resultsBlock = !!resultsInfo?.block;
        const evChk = stockEventCheckS(ticker, todayKey), eventBlock = evChk.block;
        const readyOk = g.ok && !forming && !resultsBlock && !eventBlock;
        if (g.ok && !forming && resultsBlock) resultsBlockedCount++;
        if (g.ok && !forming && eventBlock && !resultsBlock) eventBlockedCount++;
        Object.assign(dg, { gate: g.ok ? g.setup : null, signalDay, forming, near: nearTxt, rs3m: rs.rs3m });
        const blockReasons = [];
        if (resultsBlock) blockReasons.push(resultsInfo.date === todayKey ? `Results today (${resultsInfo.date})` : `Results in ${resultsInfo.tradingDays} trading day${resultsInfo.tradingDays===1?'':'s'} (${resultsInfo.date}) - avoid fresh swing entry`);
        blockReasons.push(...evChk.reasons);
        const sel = { name: g.ok ? g.setup : 'Swing READY gate', score: 100, action: 'READY', gatePassed: true, gateReasons: [] };
        const extra = {
          resultsDate: resultsInfo?.date || null, resultsTradingDays: resultsInfo ? resultsInfo.tradingDays : null, resultsBlock, resultsRecent: !!resultsInfo?.recent,
          eventBlock, eventReasons: evChk.reasons, eventNotes: evChk.notes, surveillance: evChk.surveillance, regimeBlock: false,
          gateV2: true, signalDay, signalDate, forming, gateInfo: g.info || null, fresh: g.ok ? freshOf(readyOk ? 'ready' : 'near', g.stop, !resultsBlock && !eventBlock) : null,
          pickedSetup: g.ok ? g.setup : null, selectedStrategy: g.ok ? g.setup : 'Watch',
          plan: g.ok ? { entry: g.entry, stop: g.stop, target: g.target } : null, exit2R: g.ok ? g.target : null, rr: g.ok ? 2 : null, riskPct: g.ok ? g.riskPct : null,
          rs3m: rs.rs3m, rs6m: rs.rs6m, stock3m: rs.stock3m, nifty3m: rs.nifty3m, rsOk: Number.isFinite(rs.rs3m) && rs.rs3m > 0, tags,
          trigger: g.ok ? `${g.why}. Signal at ${signalDay === 'yesterday' ? "yesterday's" : "today's"} close - buy ${signalDay === 'yesterday' ? 'now' : 'near the close or at the next open'}; stop ${g.stop}, then trail 4 ATR under the highest close, sell on a close below EMA20 after day 5, at most 60 days` : nearTxt
        };
        if (readyOk) return { ...screenerCardPayloadS({ ticker, m, selected: sel, status: 'READY', rankScore: 100 - (+g.riskPct || 0), emaGap: 0, resistanceRoom: null, slRisk: g.riskPct }), ...extra };
        const reason = forming ? `Forming today: ${g.why} - READY if it holds at the close (from 15:00)`
          : g.ok ? blockReasons.join(' · ') : nearTxt;
        return { ...screenerCardPayloadS({ ticker, m, selected: sel, status: 'WATCH', reason, rankScore: g.ok ? 60 - (+g.riskPct || 0) : 20 + (Number.isFinite(rs.rs3m) ? Math.min(20, rs.rs3m) : 0), emaGap: 0, resistanceRoom: null, slRisk: g.riskPct ?? null }), ...extra };
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
  if (dataOkCount >= 50) { SV().LAST_BREADTH = { pct: Math.round(aboveSma50Count / dataOkCount * 100), above: aboveSma50Count, total: dataOkCount, ts: Date.now() }; saveUniverseToDisk(); }
  const marketTrend = marketRegime(niftyTrend);
  /* Sector strength: average 1-month return of the universe stocks in each sector (3+ stocks). Leaders get a
     ranking bonus, laggards a small penalty. */
  const secAgg = {};
  sectorRet.forEach(x => { (secAgg[x.sector] = secAgg[x.sector] || []).push(x.ret); });
  const secRank = Object.entries(secAgg).filter(([, v]) => v.length >= 3)
    .map(([k, v]) => ({ sector: k, ret: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2), n: v.length }))
    .sort((a, b) => b.ret - a.ret);
  const secPos = Object.fromEntries(secRank.map((x, i) => [x.sector, { rank: i + 1, ret: x.ret, of: secRank.length, n: x.n }]));
  if (secRank.length >= 5) { SV().LAST_SECTOR_STRENGTH = { ts: Date.now(), map: secPos }; saveUniverseToDisk(); }
  /* The tested READY gate needs Nifty in its uptrend (as tested); its own strength rule (RS for the cross) is in the gate. */
  for (const x of ready.splice(0)) {
    if (marketTrend.trendUp === false) {
      regimeBlockedCount++;
      watch.push({ ...x, tradeStatus:'WATCH', isStrictQualified:false, regimeBlock:true, watchReason: NIFTY_TREND_WHY, confirmationNeeded: NIFTY_TREND_WHY, trigger:'Needs Nifty back above its EMA50 with EMA20 above EMA50' });
      continue;
    }
    ready.push(x);
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
  /* Pattern breakouts: only while Nifty is in its uptrend (same gate as READY), no results / corporate event close,
     not already READY. Tightest stop first. */
  const patternBreakouts = marketTrend.trendUp === false ? [] : patternCands
    .filter(p => !readySymsAll.has(p.sym.toUpperCase()))
    .map(p => { const ri = resultsCheckFor(p.sym, resultsCal, todayKey), ev = stockEventCheckS(p.sym, todayKey);
      return { ...p, sector: sectorInfoFor(p.sym)?.sector || null, resultsDate: ri?.date || null, resultsBlock: !!ri?.block, resultsTradingDays: ri ? ri.tradingDays : null, resultsRecent: !!ri?.recent, eventBlock: ev.block, eventNotes: ev.notes }; })
    .filter(p => !p.resultsBlock && !p.eventBlock)
    .sort((a, b) => a.riskPct - b.riskPct).slice(0, 15);
  const patternNote = marketTrend.trendUp === false ? `Pattern breakouts paused: ${NIFTY_TREND_WHY}` : '';
  /* 20-day breakouts: Nifty in its uptrend (as tested), not READY, no results / corporate event close. Tightest stop first. */
  const breakouts20 = marketTrend.trendUp === false ? [] : bo20Cands
    .filter(b => !readySymsAll.has(b.sym.toUpperCase()))
    .map(b => { const ri = resultsCheckFor(b.sym, resultsCal, todayKey), ev = stockEventCheckS(b.sym, todayKey);
      return { ...b, sector: sectorInfoFor(b.sym)?.sector || null, resultsDate: ri?.date || null, resultsBlock: !!ri?.block, resultsTradingDays: ri ? ri.tradingDays : null, eventBlock: ev.block }; })
    .filter(b => !b.resultsBlock && !b.eventBlock)
    .sort((a, b) => a.riskPct - b.riskPct).slice(0, 15);
  const breakouts20Note = marketTrend.trendUp === false ? `20-day breakouts paused: ${NIFTY_TREND_WHY}` : '';
  SV().LAST_SCAN_DIAG = { ts: Date.now(), rows: scanDiag };
  const result = {
    picks,
    watchlist,
    patternBreakouts,
    patternNote,
    breakouts20,
    breakouts20Note,
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
      blockWindowTradingDays: RESULTS_BLOCK_TRADING_DAYS, readyBlockedByResults: resultsBlockedCount, readyBlockedByRegime: regimeBlockedCount,
      readyBlockedByEvents: eventBlockedCount, eventsChecked: !!NSE_CAL.ts.corp, surveillanceChecked: !!NSE_CAL.ts.surv },
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
    universeLabel: 'Eligible NSE large-cap scan: market cap > ₹35,000Cr, price > ₹10',
    screenerFlow: [
      {step:'READY gate', rule:'Tested 20 Nov 2026 (17 swing entries, 10 years): A. EMA20 crosses above EMA50, close above EMA200, stock beats Nifty over 3 months; or B. a 2%+ gap-up on 2x the 20-day volume that closes above its open, close > EMA50 > EMA200, within 10% of the 52-week high'},
      {step:'Signal', rule:"On a close: during the session yesterday's completed candle is the signal (buy now); today's forming candle counts from 15:00 (before that it waits on the Watchlist)"},
      {step:'Market', rule:'READY only while Nifty is above its EMA50 with EMA20 above EMA50 (as tested)'},
      {step:'Stop / exit', rule:'Stop 0.25 ATR under the setup low (10-day low for A, the gap day low for B), kept 0.75-3 ATR from the price; then a stop trailing 4 ATR under the highest close, sell on a close below EMA20 after day 5, at most 60 days (from 23 Nov 2026; before: all at 2R or the close of day 15); at most 5 open'},
      {step:'Backtest', rule:'A and B in one 5-slot book with the trailing exit: 45% wins, +0.57R a trade (avg win +13%, avg loss -4%), profit in 9 of 10 years, worst fall -10% (with the old 2R / day-15 exit: 49% wins, +0.18R, 8 of 10 years). The old pullback / breakout READY: 44%, 6 of 10 years'},
      {step:'Results', rule:`No READY with results today or within ${RESULTS_BLOCK_TRADING_DAYS} trading days, or a corporate event close`},
      {step:'Pattern breakouts', rule:'Separate list (unchanged): double bottom or flat base breakouts, own stop and 2R exit'},
      {step:'20-day breakouts', rule:'Separate list: first close above the 20-day high on 1.5x volume, close > EMA50 > EMA200, higher highs & lows, within 10% of the 52-week high, beating Nifty over 3 months; stop under the 5-day low, 2R or day 15 (51% wins, 8 of 10 years)'}
    ],
    filters: {
      criteria: 'Screener Match: Nifty above EMA50 + no results within 5 trading days + Bias Bullish + selected setup + RR≥1.25 + Volume≥0.8x + no high selling volume + Strategy score≥70 + Fresh Entry Score≥70 + setup gate PASS · Watchlist: Bias Bullish + setup forming + score≥55 + near entry zone + one or more confirmation gaps · No duplicate symbols: every Screener Match symbol is excluded from Watchlist · RSI, MACD and ADX remain quality inputs, and selected-strategy gate failures move the stock to Watchlist instead of Ready.'
    },
    scoreBasis: 'One eligible large-cap NSE scan. All indicators are calculated locally from the same daily Yahoo candles; Screener Match and Watchlist come from the same scan with duplicate symbols removed.',
    generatedAt: new Date().toISOString(),
    note: timedOut ? 'Screener Match/Watchlist returned partial results due to data-provider timeout; refresh again from the Screener tab.' : 'Screener Match is a server pre-filter; Overview remains the final trade decision: selected-strategy gate failures such as RSI outside zone, weak ADX, late entry, RR below 1.25, or volume below 0.8x, high selling volume, or RR below 1.25 cannot stay Ready. Watchlist shows need-confirmation candidates only. A stock cannot appear in both lists. Breakout is included; Pre-Breakout Watch and Momentum Continuation are watch-only and never READY.'
  };
  SV().MY_TRADE_SCREENER_CACHE = result;
  /* A partial scan (timeout, or Yahoo paused so most charts failed) is kept 1 minute, not 30, so the next
     visit rescans instead of showing an empty or thin list for half an hour. */
  const scanOk = !timedOut && dataOkCount >= 0.8 * universe.length;
  SV().MY_TRADE_SCREENER_TS = scanOk ? Date.now() : Date.now() - MY_TRADE_SCREENER_TTL + 60e3;
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
/* NSE's 2026 trading holidays (built in: NSE refuses Render, so its holiday list cannot be fetched there). Add 2027's
   when NSE publishes it (December), or set NSE_HOLIDAYS=YYYY-MM-DD,... on Render. */
const NSE_HOLIDAYS_BUILTIN = [['2026-01-15','Municipal Corporation Election - Maharashtra'],['2026-01-26','Republic Day'],['2026-02-15','Mahashivratri'],
  ['2026-03-03','Holi'],['2026-03-21','Id-Ul-Fitr (Ramadan Eid)'],['2026-03-26','Shri Ram Navami'],['2026-03-31','Shri Mahavir Jayanti'],['2026-04-03','Good Friday'],
  ['2026-04-14','Dr. Baba Saheb Ambedkar Jayanti'],['2026-05-01','Maharashtra Day'],['2026-05-28','Bakri Id'],['2026-06-26','Muharram'],['2026-08-15','Independence Day'],
  ['2026-09-14','Ganesh Chaturthi'],['2026-10-02','Mahatma Gandhi Jayanti'],['2026-10-20','Dussehra'],['2026-11-08','Diwali Laxmi Pujan'],['2026-11-10','Diwali-Balipratipada'],
  ['2026-11-24','Prakash Gurpurb Sri Guru Nanak Dev'],['2026-12-25','Christmas']];
const NSE_DATED_HOLIDAYS = new Set([...NSE_HOLIDAYS_BUILTIN.map(h => h[0]), ...String(process.env.NSE_HOLIDAYS || '').split(',').map(s => s.trim()).filter(Boolean)]);
function isNseHoliday(key) { return NSE_DATED_HOLIDAYS.has(key) || NSE_FIXED_HOLIDAYS_MD.has(key.slice(5)); }

/* ── NSE calendar data, refreshed once a day (free NSE APIs, the option-chain session):
   - trading holidays: the list above only had fixed dates, so 10 Nov 2026 (Diwali Balipratipada) ran the scans
     and alerts as a normal day. Days marked "*" by NSE (Diwali Laxmi Pujan) have a special Muhurat session.
   - corporate actions: a bonus, split, rights or demerger inside a 1-10 day swing changes the price overnight, so it
     blocks a fresh entry like results do; a dividend is a note (price drops by it on the ex-date).
   - surveillance lists (ASM / GSM): higher margins, trade limits, sometimes trade-for-trade - no fresh entry.
   Kept in data/nse-calendar.json so a restart does not need NSE; a failed refresh keeps the last copy. */
const NSE_CAL_FILE = require('path').join(__dirname, 'data', 'nse-calendar.json');   /* local requires: path / fs are declared further down */
let NSE_CAL = { holidays: NSE_HOLIDAYS_BUILTIN.map(([date, name]) => ({ date, name, special: false })), corp: {}, surv: {}, ts: {} };
try { const j = JSON.parse(require('fs').readFileSync(NSE_CAL_FILE, 'utf8')); NSE_CAL = { holidays: j.holidays?.length ? j.holidays : NSE_CAL.holidays, corp: j.corp || {}, surv: j.surv || {}, ts: j.ts || {} }; } catch {}
/* Every listed day is closed for the normal session; "*" only says a special (Muhurat) session is held. */
function applyNseHolidays() { for (const h of NSE_CAL.holidays) NSE_DATED_HOLIDAYS.add(h.date); }
applyNseHolidays();
const nseDdMmmToKey = s => { const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})/.exec(String(s || '').trim()); const mon = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' }; return m && mon[m[2]] ? `${m[3]}-${mon[m[2]]}-${m[1]}` : null; };
const nseDateParamS = ms => { const t = new Date(ms + 5.5 * 3600e3); return `${String(t.getUTCDate()).padStart(2, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${t.getUTCFullYear()}`; };
function corpKind(subject) {
  const s = String(subject || '');
  if (/split|sub-?division/i.test(s)) return 'split';
  if (/bonus/i.test(s)) return 'bonus';
  if (/rights/i.test(s)) return 'rights';
  if (/demerger|scheme of arrangement|spin/i.test(s)) return 'demerger';
  if (/dividend|distribution/i.test(s)) return 'dividend';
  return 'other';
}
let NSE_CAL_INFLIGHT = null;
const NSE_CAL_FAIL = {};
async function refreshNseCalendar(force = false) {
  if (NSE_CAL_INFLIGHT) return NSE_CAL_INFLIGHT;
  /* holiday list weekly, the others daily; after a failed try (NSE refuses Render) not again for 6 hours */
  const stale = k => (force || !NSE_CAL.ts[k] || Date.now() - NSE_CAL.ts[k] > (k === 'hol' ? 7 * 24 : 20) * 3600e3) && !(Date.now() - (NSE_CAL_FAIL[k] || 0) < 6 * 3600e3);
  if (!stale('hol') && !stale('corp') && !stale('surv')) return NSE_CAL;
  NSE_CAL_INFLIGHT = (async () => {
    let changed = false;
    if (stale('hol')) try {
      const j = await nseOcGet('/api/holiday-master?type=trading');
      const list = (j.CM || j.FO || []).map(h => ({ date: nseDdMmmToKey(h.tradingDate), name: String(h.description || '').replace(/\*$/, '').trim(), special: /\*\s*$/.test(String(h.description || '')) })).filter(h => h.date);
      if (list.length >= 5) { NSE_CAL.holidays = list; NSE_CAL.ts.hol = Date.now(); applyNseHolidays(); changed = true; }
    } catch (e) { NSE_CAL_FAIL.hol = Date.now(); console.warn('NSE holidays:', e.message); }
    if (stale('corp')) try {
      const j = await nseOcGet(`/api/corporates-corporateActions?index=equities&from_date=${nseDateParamS(Date.now() - 2 * 86400e3)}&to_date=${nseDateParamS(Date.now() + 30 * 86400e3)}`);
      const rows = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : null;
      if (!rows) throw new Error('unexpected NSE corporate-action answer');
      if (!rows.length && Object.keys(NSE_CAL.corp || {}).length) throw new Error('NSE returned no corporate actions - keeping the last list');
      const corp = {};
      for (const r of rows) {
        const date = nseDdMmmToKey(r.exDate), sym = String(r.symbol || '').toUpperCase();
        if (!date || !sym || (r.series && r.series !== 'EQ')) continue;
        (corp[sym] = corp[sym] || []).push({ date, subject: String(r.subject || '').replace(/[<>&"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140), kind: corpKind(r.subject) });
      }
      NSE_CAL.corp = corp; NSE_CAL.ts.corp = Date.now(); changed = true;
    } catch (e) { NSE_CAL_FAIL.corp = Date.now(); console.warn('NSE corporate actions:', e.message); }
    if (stale('surv')) try {
      const [asm, gsm] = await Promise.all([nseOcGet('/api/reportASM'), nseOcGet('/api/reportGSM')]);
      const surv = {};
      for (const r of [...(asm?.longterm?.data || []), ...(asm?.shortterm?.data || [])]) if (r.symbol) surv[String(r.symbol).toUpperCase()] = `ASM ${String(r.survDesc || '').match(/Long Term|Short Term/i)?.[0] || ''} ${r.asmSurvIndicator || ''}`.replace(/\s+/g, ' ').trim();
      for (const r of (Array.isArray(gsm) ? gsm : gsm?.data || [])) if (r.symbol) surv[String(r.symbol).toUpperCase()] = `GSM stage ${r.gsmStage || ''}`.trim();
      if (Object.keys(surv).length) { NSE_CAL.surv = surv; NSE_CAL.ts.surv = Date.now(); changed = true; }
    } catch (e) { NSE_CAL_FAIL.surv = Date.now(); console.warn('NSE ASM/GSM:', e.message); }
    if (changed) { try { require('fs').mkdirSync(require('path').dirname(NSE_CAL_FILE), { recursive: true }); require('fs').writeFileSync(NSE_CAL_FILE, JSON.stringify(NSE_CAL)); } catch (e) { console.warn('NSE calendar save:', e.message); } }
    return NSE_CAL;
  })().finally(() => { NSE_CAL_INFLIGHT = null; });
  return NSE_CAL_INFLIGHT;
}
setTimeout(() => refreshNseCalendar().catch(() => {}), 90 * 1000);   /* after the start-up rush on the NSE queue */
setInterval(() => refreshNseCalendar().catch(() => {}), 60 * 60 * 1000);   /* each part refetches only when 20 h old */
const STOCK_EVENT_BLOCK_DAYS = 10;   /* the longest swing hold */
/* Bonus / split / rights / demerger with an ex-date in the next 10 trading days, or an ASM / GSM listing, blocks a
   fresh entry (screener READY and the Overview gate alike); a dividend is only a note. */
function stockEventCheckS(code, todayKey = istDateKey()) {
  const sym = String(code || '').replace(/^NSE:/, '').replace(/\.(NS|BO)$/, '').toUpperCase();
  const reasons = [], notes = [], items = [];
  const surv = NSE_CAL.surv[sym];
  if (surv) reasons.push(`On the NSE surveillance list (${surv}) - higher margins and trade limits, no fresh swing entry`);
  const nseCorpFresh = NSE_CAL.ts.corp && Date.now() - NSE_CAL.ts.corp < 2 * 86400e3;
  const free = nseCorpFresh ? [] : [...(FREE_CAL.splits?.[sym] || []),
    ...(FREE_CAL.earn?.[sym + '.NS']?.exDiv ? [{ date: FREE_CAL.earn[sym + '.NS'].exDiv, subject: 'Dividend (Yahoo)', kind: 'dividend' }] : [])];
  const nseList = NSE_CAL.corp[sym] || [];
  for (const a of [...nseList, ...free.filter(f => !nseList.some(n => n.date === f.date && (n.kind === f.kind || (f.kind === 'split' && n.kind === 'bonus'))))]) {
    if (a.date < todayKey) continue;
    const td = tradingDaysUntil(todayKey, a.date);
    if (td > STOCK_EVENT_BLOCK_DAYS) continue;
    const when = a.date === todayKey ? 'today' : `${a.date} (${td} trading day${td === 1 ? '' : 's'})`;
    items.push({ ...a, tradingDays: td });
    if (a.kind === 'dividend' || a.kind === 'other') notes.push(`${a.subject} - ex-date ${when}: the price drops by the payout that morning`);
    else reasons.push(`${a.subject} - ex-date ${when}: the price adjusts overnight, no fresh swing entry`);
  }
  return { block: reasons.length > 0, reasons, notes, items, surveillance: surv || null };
}
function upcomingSpecialSession(todayKey = istDateKey()) {
  return NSE_CAL.holidays.filter(h => h.date >= todayKey).sort((a, b) => a.date.localeCompare(b.date))
    .map(h => ({ ...h, tradingDays: tradingDaysUntil(todayKey, h.date) })).slice(0, 3);
}
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
const SECTOR_SYM = t => Object.keys(YF_MAP).find(k => k.startsWith('NSE:') && YF_MAP[k] === t);
async function getSectorPriceAndChange(s) {
  /* Angel One when connected (one shared request for all sectors), else the direct Yahoo index ticker; Fin Ex-Bank
     ETF x ratio. No synthetic stock basket calculation. */
  const sym = SECTOR_SYM(s.ticker);
  if (sym && NSE_INDEX_NAME[sym]) {
    const n = await getIndexFallbackPrice(sym, s.ticker);
    return { ...n, rawChg: n.liveRaw - n.prevRaw, rawPct: n.prevRaw > 0 ? (n.liveRaw - n.prevRaw) / n.prevRaw * 100 : 0, usedTicker:s.ticker };
  }
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
        source: results[i].value.source === 'NSE' ? 'NSE index value' : 'Direct Yahoo index ticker',
      };
    });
    /* Sort by % change — top performers first */
    sectors.sort((a,b) => (b.pct ?? -Infinity) - (a.pct ?? -Infinity)); /* failed sectors last */
    return { sectors, updatedAt:new Date().toISOString() };
  }
}


/* ── /api/swing-context ── everything the Overview needs to apply the SAME gates as the screener:
   market regime (Nifty + breadth), relative strength vs Nifty, results within 5 trading days, NSE sector.
   Uses cached charts, so opening a stock normally costs no extra Yahoo calls. */
/* ── NSE option chain (free, no key): live premiums, OI, IV for Nifty / Bank Nifty / FinNifty ──
   NSE needs a session cookie from its own option-chain page first. One cookie serves 10 minutes; the chain is
   cached 3 minutes in market hours (30 outside), and goes through the NSE queue (one request at a time). */
const OC_SYMBOLS = { 'NSE:NIFTY':'NIFTY', 'NSE:BANKNIFTY':'BANKNIFTY', 'NSE:FINNIFTY':'FINNIFTY' };
/* NSE session cookie. Root cause of "NSE loads once, then premiums / indices / FII-DII fail" (16 Nov 2026): every
   caller that found no cookie, or wanted a fresh one, fetched NSE's 340 KB option-chain page itself - a page load
   queued up to 11 page fetches in NSE's one-at-a-time queue - and the 15 s timeouts counted the time spent WAITING
   in that queue, so on a slow host every NSE call timed out before its turn and its answer was thrown away. Now one
   page fetch at a time serves every caller, a cookie younger than a minute is reused even when a fresh one is
   asked for, it is kept 30 minutes (NSE's nsit cookie lasts 2 h), and cookies NSE sends with API answers update it. */
let NSE_OC_COOKIE = null, NSE_OC_COOKIE_INFLIGHT = null;
const NSE_COOKIE_STATS = { pageFetches: 0, lastPageAt: null };
/* The last NSE answers as this server saw them (/api/health -> nseCalls): status, time taken, the cookies NSE set,
   and the start of the body when it was not a 200 - tells a blocked server ("Access Denied", 403) from a slow one
   (Timeout) or a changed address (301). */
const NSE_CALLS = [];
/* NSE refusing this server (403 "Access Denied" on its cookie page, or on an API call with a fresh cookie): no NSE
   live call for 5 minutes - asking again at once on every page view only keeps a blocked address blocked. */
const NSE_DENIED = { until: 0, count: 0, last: null };
function nseDenied(status) {
  NSE_DENIED.count++; NSE_DENIED.last = new Date().toISOString(); NSE_DENIED.until = Date.now() + 5 * 60e3;
  console.warn(`NSE refused this server (HTTP ${status}); no NSE live calls until ${new Date(NSE_DENIED.until).toISOString()}`);
}
function nseNote(path, t0, r, err) {
  const o = { at: new Date().toISOString(), path: String(path).split('?')[0], ms: Date.now() - t0 };
  if (r) { o.status = r.status; const ck = (r.headers?.['set-cookie'] || []).map(c => String(c).split('=')[0]); if (ck.length) o.cookies = ck.join(',');
    if (r.status !== 200 && r.body) o.body = String(r.body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140); }
  if (err) o.error = String(err.message || err).slice(0, 140);
  NSE_CALLS.push(o); if (NSE_CALLS.length > 12) NSE_CALLS.shift();
}
function nseMergeCookies(base, setCookie) {
  const jar = new Map(String(base || '').split(/;\s*/).filter(Boolean).map(c => [c.split('=')[0], c]));
  for (const c of setCookie || []) { const kv = String(c).split(';')[0]; if (kv.includes('=')) jar.set(kv.split('=')[0], kv); }
  return [...jar.values()].join('; ');
}
async function nseOptionCookie(force = false) {
  const age = NSE_OC_COOKIE ? Date.now() - NSE_OC_COOKIE.ts : Infinity;
  if (NSE_OC_COOKIE && (age < 60e3 || (!force && age < 30 * 60e3))) return NSE_OC_COOKIE.v;
  if (NSE_OC_COOKIE_INFLIGHT) return NSE_OC_COOKIE_INFLIGHT;
  NSE_OC_COOKIE_INFLIGHT = (async () => {
    NSE_COOKIE_STATS.pageFetches++; NSE_COOKIE_STATS.lastPageAt = new Date().toISOString();
    const pageGet = async () => { const t0 = Date.now();
      try { const p = await getWithHeaders(NSE_WWW + '/option-chain', { Accept:'text/html' }); nseNote('/option-chain (cookie page)', t0, p); return p; }
      catch (e) { nseNote('/option-chain (cookie page)', t0, null, e); throw e; } };
    let page = await pageGet();
    if (nseFollowMove(page)) page = await pageGet();
    if (page.status === 401 || page.status === 403) { nseDenied(page.status); throw new Error('NSE refused this server (HTTP ' + page.status + ')'); }
    const v = nseMergeCookies('', page.headers['set-cookie']);
    if (!v) throw new Error('NSE gave no session cookie (HTTP ' + page.status + ')');
    NSE_OC_COOKIE = { v, ts: Date.now() };
    return v;
  })().finally(() => { NSE_OC_COOKIE_INFLIGHT = null; });
  return NSE_OC_COOKIE_INFLIGHT;
}
/* One NSE API call. No timeout here on purpose: get() already gives each request 15 s idle / 20 s in total once it
   is NSE's turn; a timeout around the queue wait is the caller's choice (a page may stop waiting, the fetch still
   finishes and fills the cache for the next look). */
async function nseOcGet(path) {
  const hdr = c => ({ Accept:'application/json', Referer: NSE_WWW + '/option-chain', ...(c ? { Cookie:c } : {}) });
  const call = async c => { const t0 = Date.now(); let r;
    try { r = await get(NSE_WWW + path, hdr(c)); } catch (e) { nseNote(path, t0, null, e); throw e; }
    nseNote(path, t0, r);
    if (r.headers?.['set-cookie'] && NSE_OC_COOKIE) NSE_OC_COOKIE.v = nseMergeCookies(NSE_OC_COOKIE.v, r.headers['set-cookie']);
    return r; };
  if (Date.now() < NSE_DENIED.until) throw new Error(`NSE refused this server - next try after ${new Date(NSE_DENIED.until + 5.5 * 3600e3).toISOString().slice(11, 16)} IST`);
  let r;
  /* Without a cookie first when none is saved (NSE answered cookie-less API calls on 17 Nov 2026): the 340 KB
     cookie page is fetched only when NSE asks for it (401 / 403). */
  const saved = NSE_OC_COOKIE && Date.now() - NSE_OC_COOKIE.ts < 30 * 60e3 ? NSE_OC_COOKIE.v : '';
  try { r = await call(saved); }
  catch (e) {
    if (e.cooldown || /refused this server/.test(e.message)) throw e;   /* paused after a 429 / refused: do not queue more */
    /* NSE resets the connection when it sees bursts: one retry with a fresh session after a short pause. */
    await new Promise(res => setTimeout(res, 1500));
    r = await call(await nseOptionCookie(true));
  }
  /* NSE moved to another address: new session there, then the same request again. */
  if (nseFollowMove(r)) r = await call(await nseOptionCookie(true));
  if (r.status === 401 || r.status === 403) { r = await call(await nseOptionCookie(true)); if (r.status === 401 || r.status === 403) nseDenied(r.status); }
  if (r.status !== 200) throw new Error('NSE HTTP ' + r.status);
  return JSON.parse(r.body);
}
const NSE_MON = { Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06', Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12' };
const nseExpKey = e => { const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(e || ''); return m ? `${m[3]}-${NSE_MON[m[2]]}-${m[1]}` : null; };
function istMarketHoursS() {
  const t = new Date(Date.now() + 5.5 * 3600000), d = t.getUTCDay(), m = t.getUTCHours() * 60 + t.getUTCMinutes();
  return d >= 1 && d <= 5 && !isNseHoliday(t.toISOString().slice(0, 10)) && m >= 9 * 60 && m <= 15 * 60 + 35;
}
/* Stale-while-revalidate for NSE: a cold NSE fetch takes 10-20 s (cookie page + contract list + chain) and often
   fails from cloud hosts. Once one answer is in, it is returned at once while a refresh runs in the background,
   and kept (up to maxAge) when NSE fails - before, every 3 minutes a request waited on the slow refetch, hit the
   15 s page timeout or an NSE error, and the premiums flipped back to Black-Scholes estimates. */
async function nseSwr(key, ttl, maxAge, producer) {
  const old = API_CACHE.get(key);
  /* "saved quote" on the page once the copy is more than 10 minutes old */
  const aged = o => Date.now() - o.ts > 10 * 60e3 ? { ...o.value, stale: true, staleAgeSec: Math.round((Date.now() - o.ts) / 1000) } : o.value;
  if (old && Date.now() - old.ts >= ttl && Date.now() - old.ts < maxAge) {
    if (!INFLIGHT.has(key)) cacheWrap(key, 0, producer).catch(() => {});
    return aged(old);
  }
  try { const r = await cacheWrap(key, ttl, producer); return r.value; }
  catch (e) { if (old && Date.now() - old.ts < maxAge) return aged(old); throw e; }
}
/* Last option-chain fetch from NSE (shown in /api/health): tells whether NSE is answering this server. */
const NSE_OC_LAST = { ok: null, error: null, errorAt: null };
/* Expiry list: Angel One's instrument list; without Angel One the weekly Nifty expiries are worked out (Tuesday, the
   trading day before when Tuesday is a holiday) - only for the dates shown, premiums need Angel One. */
async function ocExpiryList(name, fetch = false) {
  if (angelReady()) { try { return await angelExpiryInfo(name); } catch (e) { console.warn('Angel One expiries:', e.message); } }
  const out = [], ist = new Date(Date.now() + 5.5 * 3600e3);
  let d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  for (let n = 0; n < 70 && out.length < 8; n++, d = new Date(d.getTime() + 86400e3)) {
    if (d.getUTCDay() !== 2) continue;
    let e = d; while (e.getUTCDay() === 0 || e.getUTCDay() === 6 || isNseHoliday(e.toISOString().slice(0, 10))) e = new Date(e.getTime() - 86400e3);
    out.push(isoToNseDate(e.toISOString().slice(0, 10)));
  }
  return { expiryDates: out, computed: true };
}
/* Expiries (YYYY-MM-DD) still open now: after 15:30 IST an expiry dated today is finished. */
function ocOpenExpiries(info) {
  const istNow = new Date(Date.now() + 5.5 * 3600000), afterClose = istNow.getUTCHours() * 60 + istNow.getUTCMinutes() >= 15 * 60 + 30;
  const today0 = istNow.toISOString().slice(0, 10);
  return (info.expiryDates || []).map(e => ({ nse: e, key: nseExpKey(e) })).filter(e => e.key && (e.key > today0 || (e.key === today0 && !afterClose)));
}
function ocBuild(sym, name, j, pick, exps) {
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
}
const OC_INFLIGHT = new Map();
/* Option chain estimated with Black-Scholes when Angel One is not connected: spot from Yahoo, one volatility for every
   strike = India VIX (Yahoo), expiries computed from NSE's weekday rule. Real out-of-the-money puts usually trade at a
   higher volatility than VIX, so estimated credits tend to be on the low side. No open interest. Kept 5 minutes. */
async function estimatedOptionChain(sym, name, want) {
  return (await cacheWrap(`ocest:${sym}|${want || ''}`, 5 * 60e3, async () => {
    const exps = ocOpenExpiries(await ocExpiryList(name));
    const dd0 = (a, b) => Math.abs(Date.parse(a) - Date.parse(b));
    const pick = exps.find(e => e.key === want) || (want ? exps.slice().sort((a, b) => dd0(a.key, want) - dd0(b.key, want))[0] : exps[0]);
    if (!pick) throw new Error('no open expiry');
    const spot = +(await quickPriceFor(sym, 60e3))?.price;
    if (!(spot > 0)) throw new Error('no spot price');
    const vx = (await cacheWrap('vix:est', 10 * 60e3, async () => +(await withTimeout(getPriceAndChange('^INDIAVIX'), 8000, 'India VIX')).liveRaw)).value;
    if (!(vx > 5 && vx < 90)) throw new Error('no India VIX');
    const T = Math.max(0.25 / 365, (Date.parse(pick.key + 'T15:30:00+05:30') - Date.now()) / (365 * 86400e3)), sig = vx / 100, r = 0.065;
    const step = name === 'BANKNIFTY' ? 100 : 50, data = [];
    for (let k = Math.ceil(spot * 0.88 / step) * step; k <= spot * 1.12; k += step) {
      const leg = ty => { const v = Math.round(bsPrice(spot, k, T, r, sig, ty) * 20) / 20;
        return { lastPrice: v, buyPrice1: v, sellPrice1: v, openInterest: 0, changeinOpenInterest: 0, impliedVolatility: vx, totalTradedVolume: v > 0 ? 1 : 0 }; };
      data.push({ strikePrice: k, CE: leg('C'), PE: leg('P') });
    }
    const ist = new Date(Date.now() + 5.5 * 3600e3), ts = `${isoToNseDate(ist.toISOString().slice(0, 10))} ${ist.toISOString().slice(11, 19)}`;
    return { ...ocBuild(sym, name, { records: { underlyingValue: spot, timestamp: ts, data } }, pick, exps), pcr: null, maxPain: null, callWalls: [], putWalls: [],
      estimated: true, vix: +vx.toFixed(2), source: `Black-Scholes estimate (India VIX ${vx.toFixed(1)}) - Angel One not connected` };
  })).value;
}
/* Option chain of one expiry. opts.fresh (ms): the scheduled jobs pass it - NSE is asked when the saved chain is
   older than that. Without it (pages, trade ideas) only the saved chain is served: premiums of the 10:00 / 15:05
   fetch, marked with their time. Nothing saved from today -> one catch-up call a day (Nifty), else an error and the
   page uses Black-Scholes estimates. */
async function getOptionChain(sym, want = '', opts = {}) {
  const name = OC_SYMBOLS[sym];
  if (!name) throw new Error('Option chain only for NSE:NIFTY, NSE:BANKNIFTY, NSE:FINNIFTY');
  /* Angel One when connected: live premiums of any expiry, kept 60 s - no NSE call. */
  if (angelReady()) { try { return await angelOptionChain(sym, name, want, opts); } catch (e) { console.warn('Angel One option chain:', e.message); } }
  /* Not connected: the last saved chain (pages show its time; under 4 days), never for a scheduled check. */
  if (opts.fresh == null) {
    const today = istDateKey(), exps = Object.keys(NSE_SNAP.chains).filter(k => k.startsWith(name + '_')).map(k => k.slice(name.length + 1)).filter(e => e >= today).sort();
    const near = want ? exps.slice().sort((a, b) => Math.abs(Date.parse(a) - Date.parse(want)) - Math.abs(Date.parse(b) - Date.parse(want)))[0] : exps[0];
    const k = near && `${name}_${near}`;
    const h = k && NSE_SNAP.chains[k];
    if (h && Date.now() - h.ts < 4 * 86400e3) return { ...h.value, saved: true, stale: true, staleAgeSec: Math.round((Date.now() - h.ts) / 1000) };
  }
  /* Angel One not connected and nothing saved: Black-Scholes premiums from India VIX (22 Nov 2026), marked estimated. */
  if (opts.estimate !== false) { try { return await estimatedOptionChain(sym, name, want); } catch (e) { console.warn('Estimated chain:', e.message); } }
  throw new Error('live premiums need Angel One connected (Screener -> My trades -> Connect Angel One)');
}
/* The Nifty rule's expiry: the first one at least 3 days away (same as the page). */
async function niftyRuleExpiry(fetch) {
  const exps = ocOpenExpiries(await ocExpiryList('NIFTY', fetch)).map(e => e.key), today = istDateKey();
  return exps.find(e => daysBetweenKeys(today, e) >= 3) || exps.find(e => e > today) || exps[0];
}

async function apiOptionChain(req, res, p) {
  const sym = String(p.get('sym') || 'NSE:NIFTY').toUpperCase();
  if (!OC_SYMBOLS[sym]) return err(res, 'Option chain only for NSE:NIFTY, NSE:BANKNIFTY, NSE:FINNIFTY', 400);
  try { send(res, await getOptionChain(sym, String(p.get('expiry') || ''))); }   /* expiry YYYY-MM-DD; default = nearest */
  catch (e) { err(res, 'Option premiums unavailable: ' + e.message, 502); }
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
      if (SV().NIFTY_CLOSES) rs = SwingPlan.relStrength(enrichDailyForLiveScreenerS(parseBars(raw), raw?.meta || {}).C, SV().NIFTY_CLOSES);   /* same series as the screener */
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
      events: stockEventCheckS(code, istDateKey()),   /* bonus / split / rights / ASM / GSM - the screener's same check */
      sector: sectorInfoFor(code),
      sectorStrength: sectorStrengthFor(code),
      updatedAt: new Date().toISOString()
    });
  } catch (er) { err(res, er.message); }
}

/* ── /api/quote ── */
/* The full quote (price, change, daily/weekly/hourly/monthly history) for one symbol - used by /api/quote and by
   the server's own alerts (Gold Petal plan), through the same cache key. */
async function buildQuotePayload(sym) {
  const mcxReq = isMCX(sym);
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
      /* Yahoo appends the current session as an extra bar on weekly / monthly charts (TITAN, 20 Nov 2026: a Mon-Thu
         week bar plus a one-day "week" stamped with the live time), so the weekly and monthly trend counted today as
         its own week / month. That bar is merged into its period's bar (exchange-local calendar). */
      const gmtOff = Number(weeklyR.value?.meta?.gmtoffset ?? dailyR.value?.meta?.gmtoffset) || 0;
      weekly = mergeLivePeriodBar(weekly, 'week', gmtOff);
      monthly = mergeLivePeriodBar(monthly, 'month', gmtOff);
      /* Futures contract roll: old-contract bars scaled to the new contract (see futRollAdjust). */
      const rollsHere = /=F$/.test(ticker) ? futRollsFor(ticker) : [];
      if (rollsHere.length) {
        daily = futRollAdjust(ticker, daily);
        intra = futRollAdjust(ticker, intra, 'intraday');
        weekly = futRollAdjust(ticker, weekly, 'week', daily);
        monthly = futRollAdjust(ticker, monthly, 'month', daily);
      }
      const lastRoll = rollsHere.length ? rollsHere[rollsHere.length - 1] : null;
      /* The current week / month bar from the daily bars (Yahoo's can be today only - Gold's November bar on 20 Nov). */
      weekly = rebuildLastPeriodBar(weekly, daily, 'week', gmtOff);
      monthly = rebuildLastPeriodBar(monthly, daily, 'month', gmtOff);
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
          provider: priceData.source === 'NSE' ? (proxyScale ? `NSE index value · history from Yahoo ${ticker} scaled ×${proxyScale.toFixed(2)}` : 'NSE index value · history Yahoo') : 'Yahoo Finance',
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
        /* Last futures contract roll (ms) and its size: an MCX calibration saved before it no longer fits. */
        rolledAt: lastRoll ? lastRoll.at * 1000 : null, rollPct: lastRoll ? +((lastRoll.ratio - 1) * 100).toFixed(2) : null,
        updatedAt:new Date().toISOString(),
      };
  }
async function apiQuote(req,res,p){
  const sym=p.get('sym')||'NSE:NIFTY';
  const key=`quote:${sym}`;
  const mcxReq=isMCX(sym);
  /* MCX used to force a fresh fetch on EVERY request (no cache, no de-dupe). A short TTL keeps it
     near-live while letting several tabs/pollers share one fetch. */
  const force=p.get('force')==='1'||p.get('fresh')==='1';
  const producer = () => buildQuotePayload(sym);
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
/* Background checks (price alerts, open-trade stops, MCX buy levels - every minute) accept a price up to 90 s old:
   about half the Yahoo calls of fetching each minute, and an alert is at most ~1.5 min late (22 Nov 2026). */
const BG_QUOTE_MAX_AGE = 90 * 1000;
async function quickPriceFor(sym, maxAge = 0){ return (await cacheWrap(`quick:${sym}`, Math.max(quickTtlFor(sym), maxAge), () => quickProducer(sym))).value; }
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
  const {liveRaw,prevRaw,rawPct,changeBasis,basisTime,spark}=await withTimeout(getIndexFallbackPrice(sym, ticker), 20000, ticker + ' quick price');
  const price=conv(sym,liveRaw,rate);
  const pc   =conv(sym,prevRaw,mcx?prevRate:rate);
  const chg  =+(price-pc).toFixed(2);
  const pct  =+(pc && pc>0 ? (chg/pc)*100 : rawPct).toFixed(2);
  const lastRoll = mcx ? futRollsFor(ticker).slice(-1)[0] : null;
  return {sym,price,pc,chg,pct,isUp:pct>=0,usdInr:mcx?rate:null,prevUsdInr:mcx?prevRate:null,changeBasis:mcx?changeBasis:'previousClose',basisTime:mcx?basisTime:null,
    rolledAt: lastRoll ? lastRoll.at * 1000 : null,
    spark: Array.isArray(spark) ? spark.map(v => conv(sym, v, rate)) : null, updatedAt:new Date().toISOString()};
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
/* Cached driver set for one MCX symbol (15 min; 30 s when a driver failed) - the page and the alerts share it. */
async function mcxDriversFor(sym) {
  const set = MCX_DRIVER_SET[sym];
  if (!set) throw new Error('unknown MCX symbol');
  const hit = MCX_DRV_CACHE.get(sym);
  if (hit && Date.now() - hit.ts < hit.ttl) return { ...hit.value, cached:true };
  if (!MCX_DRV_INFLIGHT.has(sym)) MCX_DRV_INFLIGHT.set(sym, buildMcxDrivers(sym, set).finally(() => MCX_DRV_INFLIGHT.delete(sym)));
  const value = await MCX_DRV_INFLIGHT.get(sym);
  /* Nothing loaded but an older full result exists: serve that (marked stale) rather than an empty card. */
  if (!value.total && hit?.value?.total) return { ...hit.value, stale:true, cached:true };
  MCX_DRV_CACHE.set(sym, { value, ts:Date.now(), ttl: value.total === value.drivers.length ? 15 * 60e3 : 30e3 });
  return { ...value, cached:false };
}
async function apiMcxDrivers(req, res, p) {
  const sym = String(p.get('sym') || '').toUpperCase();
  if (!MCX_DRIVER_SET[sym]) return err(res, 'unknown MCX symbol', 400);
  try { send(res, await mcxDriversFor(sym)); } catch (e) { err(res, e.message); }
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
  /* Gold: the tested buy filter (dollar, US yield, rupee vs their 50-day EMA), shared with the page. */
  let goldRule = null;
  if (SwingPlan.BUY_ONLY_MCX.has(sym)) {
    const closes = k => { const i = set.indexOf(k); return i >= 0 && got[i].status === 'fulfilled' ? parseBars(got[i].value).C : null; };
    goldRule = SwingPlan.goldDriverRule({ dxy: closes('dxy'), tnx: closes('us10y'), inr: closes('usdinr') });
  }
  return { sym, drivers, goldRule, bull: ok.filter(d => d.vote > 0).length, bear: ok.filter(d => d.vote < 0).length, total: ok.length, updatedAt: new Date().toISOString() };
}

async function apiVix(req,res){
  try{
    const { value: payload, cached } = await cacheWrap('vix:india', TTL.vix, async () => {
      if (angelReady()) { try { return { vix: +(await withTimeout(angelVix(), 10000, 'Angel One VIX')).toFixed(2), updatedAt: new Date().toISOString(), source: 'Angel One' }; } catch {} }
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
/* FII / DII: back on 22 Nov 2026 from Moneycontrol (NSE refuses Render's address). */
async function apiGlobal(req,res){
  try {
    const { value: payload, cached } = await cacheWrap('global:all', TTL.global, async () => {
  const SYMBOLS = [
    { key:'vix',        ticker:'^INDIAVIX', label:'India VIX',       cat:'india'  },
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
    /* US index FUTURES trade almost round the clock: during Indian hours the cash S&P / Nasdaq / Dow above are
       the previous night's close, the futures are what the US is doing now - the overnight cue for Nifty. */
    { key:'spFut',      ticker:'ES=F',      label:'S&P 500 futures', cat:'usfut'  },
    { key:'nqFut',      ticker:'NQ=F',      label:'Nasdaq futures',  cat:'usfut'  },
    /* Europe opens at 13:30 IST and often moves Nifty in the afternoon. */
    { key:'dax',        ticker:'^GDAXI',    label:'DAX',             cat:'europe' },
    { key:'ftse',       ticker:'^FTSE',     label:'FTSE 100',        cat:'europe' },
    /* Gold / silver: the drivers of Gold Petal. */
    { key:'gold',       ticker:'GC=F',      label:'COMEX Gold',      cat:'metal'  },
    { key:'silver',     ticker:'SI=F',      label:'COMEX Silver',    cat:'metal'  },
  ];

    /* All requests are queued at once, India VIX first: the Yahoo queue runs 4 at a time, so the time
       limit has to cover the wait in the queue too. The old 6 s per ticker (4 s for the VIX history), with
       breadth fetched afterwards, made India VIX time out on a cold start or while another page was
       loading - and the options idea then had no VIX for the 5 min the result was cached. */
    const vixHistP = withTimeout(safeFetch(() => yfChart('^INDIAVIX', '1d', '1y'), 1), 20000, 'India VIX history');
    vixHistP.catch(() => {});
    /* Nifty, Bank Nifty and India VIX from Angel One when connected (exchange previous close), else Yahoo. */
    const GLOBAL_ANGEL = { '^NSEI':'NSE:NIFTY', '^NSEBANK':'NSE:BANKNIFTY', '^INDIAVIX':'VIX' };
    const globalPrice = async s => {
      if (GLOBAL_ANGEL[s.ticker] && angelReady()) { try { return await withTimeout(angelIndexPrice(GLOBAL_ANGEL[s.ticker], s.ticker), 15000, s.ticker + ' Angel One'); } catch {} }
      return safeFetch(() => getPriceAndChange(s.ticker), 1);
    };
    const resultsP = Promise.allSettled(
      SYMBOLS.map(s => withTimeout(globalPrice(s), 20000, s.ticker))
    );
    const breadthP = globalBreadth();
    getGiftNifty().catch(() => {});
    const results = await resultsP;

    const data = {};
    SYMBOLS.forEach((s, i) => {
      if (results[i].status === 'fulfilled' && results[i].value && Number.isFinite(results[i].value.liveRaw)) {
        const { liveRaw, prevRaw, rawChg, rawPct, marketTime } = results[i].value;
        data[s.key] = {
          label:s.label, cat:s.cat, ticker:s.ticker,
          price:+liveRaw.toFixed(2), prev:+prevRaw.toFixed(2),
          chg:+rawChg.toFixed(2), pct:+rawPct.toFixed(2), isUp:rawPct>=0,
          at: Number(marketTime) || null,   /* time of the last trade (unix s): the page shows Live / Closed */
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
    /* fetched in the background (start-up, then hourly when 3 h old): the page waits at most 4 s for it */
    data.giftNifty = await withTimeoutFallback(getGiftNifty().catch(() => null), 4000, null)
      || { label: 'GIFT Nifty', cat: 'india', error: true, reason: GIFT.err || 'not loaded yet' };
    data.fiiDii = await withTimeoutFallback(getFiiDii().catch(() => FREE_CAL.fiiDii || null), 4000, FREE_CAL.fiiDii || null);
    data.fiiDiiError = FREE_CAL.fiiErr || null;

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
function apiHealth(req,res){const ks=angelStatus();send(res,{freeSources:{fiiDii:FREE_CAL.fiiDii?{source:FREE_CAL.fiiDii.source,last:FREE_CAL.fiiDii.days?.[0]?.date,fetchedAt:FREE_CAL.fiiDii.fetchedAt}:null,fiiDiiError:FREE_CAL.fiiErr||null,yahooCalendarStocks:Object.keys(FREE_CAL.earn||{}).length,yahooSplitsAt:FREE_CAL.splitsTs?new Date(FREE_CAL.splitsTs).toISOString():null,resultsSource:RESULTS_CAL_CACHE?.source||null},angel:{configured:ks.configured,connected:ks.connected,ready:ks.ready,until:ks.until,lastOk:ks.lastOk,lastError:ks.lastError,indices:ks.instruments?.indices??null,notFound:ks.instruments?.notFound??null},status:'ok',v:'1.0',strayTopLevelFiles:STRAY_PUBLIC_FILES,time:new Date().toISOString(),usdInr:usdInrCache.rate,cacheSize:API_CACHE.size,nseCookie:NSE_COOKIE_STATS,nseCalls:NSE_CALLS,nseRefused:{count:NSE_DENIED.count,last:NSE_DENIED.last,pausedUntil:NSE_DENIED.until>Date.now()?new Date(NSE_DENIED.until).toISOString():null},outbound:outboundStats()});}


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
<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" type="image/png" href="/icon-192.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="TradeDesk"><meta name="theme-color" content="#0e0e0e">
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

/* Page bundles (21 Nov 2026 - Lighthouse on a phone: 15 stylesheets + 8 scripts were 23 render-blocking requests,
   ~2.2 s). The same files joined in the page's own order into /css/bundle.css and /js/bundle.js, built from the sources
   at the first request after a change (by the files' mtimes), gzipped once, with an ETag like every other file. */
const PAGE_CSS = ['base.css', 'td-v23-bottom-tab-slight-lower.css', 'td-v24-professional-desktop-ui.css', 'td-screener-context.css', 'td-real-tab-mode-fix.css',
  'td-bottom-default-fix.css', 'td-polish-v7.css', 'td-scroll-overlap-fix-only.css', 'td-bottom-tab-small-lift-ios-fix.css', 'td-v25-quiet-terminal.css',
  'td-v26-market-gradient.css', 'td-v24b.css', 'td-final-uniform-picker-fix.css', 'td-ui-polish.css', 'td-v27-assist.css', 'td-theme.css'].map(f => 'css/' + f);
const PAGE_JS = ['swing-plan.js', 'js/app.js', 'js/td-journal.js', 'js/td-trace.js', 'js/td-ui.js', 'js/td-real-tab-mode-fix-js.js', 'js/td-bottom-default-fix-js.js',
  'js/td-final-market-snapshot-fix.js'];
const BUNDLES = {};
function pageBundle(req, res, kind) {
  const files = kind === 'css' ? PAGE_CSS : PAGE_JS, full = files.map(f => path.join(__dirname, 'public', f));
  let sig = ''; try { sig = full.map(f => fs.statSync(f).mtimeMs).join('|'); } catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('bundle: ' + e.message); return; }
  const serve = ent => {
    const hdr = { 'Content-Type': kind === 'css' ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'ETag': ent.etag, 'Vary': 'Accept-Encoding' };
    if (String(req.headers['if-none-match'] || '') === ent.etag) { res.writeHead(304, hdr); res.end(); return; }
    const useGz = String(req.headers['accept-encoding'] || '').includes('gzip');
    res.writeHead(200, useGz ? { ...hdr, 'Content-Encoding': 'gzip' } : hdr); res.end(useGz ? ent.gz : ent.raw);
  };
  if (BUNDLES[kind]?.sig === sig) return serve(BUNDLES[kind]);
  /* scripts: each file ends its own statement list (";") so one file cannot run into the next */
  const raw = Buffer.from(full.map((f, k) => `/* ${files[k]} */\n` + fs.readFileSync(f, 'utf8') + (kind === 'js' ? '\n;\n' : '\n')).join('\n'), 'utf8');
  const ent = { sig, raw, gz: zlib.gzipSync(raw, { level: 9 }), etag: '"' + require('crypto').createHash('sha1').update(raw).digest('base64url').slice(0, 16) + '"' };
  BUNDLES[kind] = ent; serve(ent);
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
   - Server alert engine (every minute in market hours), scheduled screener scans (11:00 and 15:00 IST)
     and, on Render, a self-ping that keeps the free instance awake during trading hours.
══════════════════════════════════════════════════════════════════ */
const nodeCrypto = require('crypto');
const STORE_FILE = path.join(__dirname, 'data', 'user-store.json');
const STORE_KEY_RE = /^(td_alerts|tradedesk_forward_test_v2|td_pos_capital|td_pos_risk_pct|td_mom_capital|td_recent_stocks|td_journal|td_max_open_risk|td_trace|td_mcx_cal2_[A-Z0-9:_-]{1,40})$/;
const STORE_MAX_BYTES = 1500000;
let USER_STORE = { keys: {}, subs: [], scans: {}, revoked: {}, flags: {}, trailLv: {} };
try { const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); USER_STORE = { keys: j.keys || {}, subs: j.subs || [], scans: j.scans || {}, revoked: j.revoked || {}, flags: j.flags || {}, trailLv: j.trailLv || {} }; delete USER_STORE.keys.td_tg_link; } catch {}
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
    /* The signal trace is written by the server too: merge the two copies by record id instead of replacing. */
    if (k === 'td_trace') { if (x.v == null) continue; next[k] = { v: JSON.stringify(traceMerge(traceParse(next[k]?.v), traceParse(String(x.v)))), t: Math.max(now, (+next[k]?.t || 0) + 1) }; changed.push(k); continue; }
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
      let q; try { q = await quickPriceFor(sym, BG_QUOTE_MAX_AGE); } catch { continue; }
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

/* ── Scheduled screener scans (IST): 11:00 and 15:00 send the READY / ready-on-limit / quick bounce stocks (with
   entry, stop, target and the quantity for the user's capital and risk %). Two scans instead of four halves the
   Yahoo calls; 15:00 leaves time to buy before the close. ── */
const SCAN_TIMES_IST = [11 * 60, 15 * 60];
function sizingLine(entry, stop, sizeFactor = 1) {
  const num = k => { try { return +JSON.parse(USER_STORE.keys[k]?.v || 'null'); } catch { return NaN; } };
  const cap = num('td_pos_capital'), rp = num('td_pos_risk_pct');
  if (!(cap > 0) || !(rp > 0) || !(entry > stop)) return '';
  const qty = Math.floor(cap * rp / 100 * sizeFactor / (entry - stop));
  return qty > 0 ? ` · qty ${qty} (risk ${+(rp * sizeFactor).toFixed(2)}% of ${inr(cap, 0)}${sizeFactor < 1 ? ', half size' : ''})` : ' · stop too wide for your risk %';
}
function scanSignals(data, slot) {
  const out = [];
  /* READY buys at the current price (the plan's entry is the pullback ZONE, e.g. EMA20 - sizing from it overstated the
     quantity, the mistake the Overview's calculator avoids). Breakout with Volume is half size, in the quantity too. */
  for (const x of data.picks || []) {
    const pl = x.plan || {}, bo = (x.pickedSetup || x.selectedStrategy) === 'Breakout with Volume', fill = +x.price > 0 ? +x.price : pl.entry;
    const t2 = +x.exit2R > 0 ? +x.exit2R : +pl.stop > 0 && fill > pl.stop ? fill + 2 * (fill - pl.stop) : null;   /* the screener's own 2R, so list, alert and record agree */
    out.push({ id: `ready|${x.sym}`, signalDate: x.signalDate || null, text: `READY ${x.sym} (${x.pickedSetup || x.selectedStrategy}): buy ~${inr(fill)}${pl.entry && Math.abs(pl.entry - fill) > fill * 0.001 ? ` (zone ${inr(pl.entry)})` : ''} · stop ${inr(pl.stop)}${x.gateV2 ? ' · exit: trailing stop 4 ATR under the highest close, or a close below EMA20 after day 5 (the 09:20 alert gives each new stop)' : ` · exit 2R ${t2 ? inr(t2) : '--'} or day 15`}${x.gateV2 ? (x.signalDay === 'yesterday' ? " · signal at yesterday's close" : " · signal at today's close") : ` (T1 ${inr(pl.target)})`}${sizingLine(fill, pl.stop, bo ? 0.5 : 1)}` });
  }
  /* Quick Bounce is watch-only (2 in 3 win, but no profit with 5 positions open over 10 years): no alert. Pattern
     breakouts are judged on the day's close, so they are alerted at the 15:00 scan only. */
  /* 20-day breakouts: yesterday's-close signals at any scan, today's at the last scan (near the close). */
  for (const x of (data.breakouts20 || []).filter(x => x.signalDay === 'yesterday' || slot === SCAN_TIMES_IST[SCAN_TIMES_IST.length - 1]).filter(x => !x.forming).slice(0, 5))
    out.push({ id: `bo20|${x.sym}`, signalDate: x.signalDate || null, text: `20-day breakout ${x.sym}: buy ~${inr(x.price)} · stop ${inr(x.stop)} · exit 2R ${inr(x.target)} or day 15 (signal at ${x.signalDay === 'yesterday' ? "yesterday's" : "today's"} close)${sizingLine(x.price, x.stop)}` });
  if (slot === SCAN_TIMES_IST[SCAN_TIMES_IST.length - 1]) for (const x of (data.patternBreakouts || []).slice(0, 5))
    out.push({ id: `pattern|${x.sym}`, text: `${x.name} ${x.sym}: buy near the close / next open if it holds ~${inr(x.price)} · stop ${inr(x.stop)} · exit 2R ${inr(x.target)} or day 15${sizingLine(x.price, x.stop)}` });
  return out;
}
async function scheduledScanTick() {
  const { d, m, key } = istNowParts();
  if (d < 1 || d > 5 || isNseHoliday(key)) return;
  const slot = SCAN_TIMES_IST.find(t => m >= t && m < t + 20);
  if (slot == null || USER_STORE.scans[`${key}|${slot}`]) return;
  USER_STORE.scans = { [`${key}|${slot}`]: Date.now() };   /* keep only the latest marker */
  saveStore();
  const istMin = ts => { const t = new Date(ts + 5.5 * 3600e3); return t.getUTCHours() * 60 + t.getUTCMinutes(); };
  const lastSlot = slot === SCAN_TIMES_IST[SCAN_TIMES_IST.length - 1];
  let data = SV().MY_TRADE_SCREENER_CACHE && Date.now() - SV().MY_TRADE_SCREENER_TS < 20 * 60 * 1000 && (!lastSlot || istMin(SV().MY_TRADE_SCREENER_TS) >= 15 * 60) ? SV().MY_TRADE_SCREENER_CACHE : null;
  if (!data) {
    if (!SV().MY_TRADE_SCREENER_INFLIGHT) SV().MY_TRADE_SCREENER_INFLIGHT = runMyTradeScreenerScan().finally(() => { SV().MY_TRADE_SCREENER_INFLIGHT = null; });
    data = await SV().MY_TRADE_SCREENER_INFLIGHT;
  }
  const sig = scanSignals(data, slot).filter(x => !x.signalDate || flagOnce(`sig|${x.id}|${x.signalDate}`)), hhmm = `${Math.floor(slot / 60)}:${String(slot % 60).padStart(2, '0')}`;
  try { traceStockRecord(data?.picks || [], key); } catch (e) { console.warn('Stock trace:', e.message); }
  /* Pattern breakouts are judged on the day's close: recorded at the last scan with their own stop and 2R target. */
  if (slot === SCAN_TIMES_IST[SCAN_TIMES_IST.length - 1]) try {
    traceStockRecord((data?.patternBreakouts || []).slice(0, 5).map(x => ({ sym: x.sym, price: x.price, plan: { stop: x.stop, target: x.target },
      pickedSetup: x.name, exit2R: x.target, sector: x.sector, tags: x.tags || {}, pattern: true, fresh: x.fresh })), key);
  } catch (e) { console.warn('Pattern trace:', e.message); }
  if (slot === SCAN_TIMES_IST[SCAN_TIMES_IST.length - 1]) try {
    traceStockRecord((data?.breakouts20 || []).filter(x => !x.forming).slice(0, 5).map(x => ({ sym: x.sym, price: x.price, plan: { stop: x.stop, target: x.target },
      pickedSetup: '20-day breakout', exit2R: x.target, sector: x.sector, tags: x.tags || {}, pattern: true, signalDate: x.signalDate, fresh: x.fresh })), key);
  } catch (e) { console.warn('20-day breakout trace:', e.message); }
  if (sig.length) {
    await pushAll({ title: `🟢 ${sig.length} stock${sig.length > 1 ? 's' : ''} ready · ${hhmm} scan`, body: sig.map(x => x.text).join('\n'), tag: 'td-scan', url: '/?view=screener' });
  } else if (slot === SCAN_TIMES_IST[SCAN_TIMES_IST.length - 1]) {
    /* One quiet line at the last scan of the day when nothing was ready, so a silent day is not mistaken for a
       broken app: today's Gold Petal and Nifty options status (they alert only when there is a trade). */
    const mcx = MCX_ALERT_SYMS.map(s => `${MCX_NAME[s]}: ${MCX_STATUS[s]?.day === key ? MCX_STATUS[s].text : 'plan not checked today'}`).join('\n');
    const nifty = NIFTY_STATUS?.day === key ? NIFTY_STATUS.text : 'not checked today';
    await pushAll({ title: 'TradeDesk · nothing ready today', body: `No stock ready (${hhmm} scan)\n${mcx}\nNifty options: ${nifty}`, tag: 'td-scan', url: '/?view=screener' });
  }
  if (slot === SCAN_TIMES_IST[0] && key === firstTradingDayOfMonth(key)) {
    try {
      const mo = await computeMomentumS();
      await pushAll({ title: `Momentum rebalance - ${mo.month}`, tag: 'td-momentum', url: '/?view=screener',
        body: `Sell: ${mo.sells.map(x => x.sym).join(', ') || 'none'} · Buy: ${mo.buys.join(', ') || 'none'}${mo.niftyFilter.aboveSma200 === false ? ' · Nifty below its 200-day average (tested version holds cash)' : ''}` });
    } catch (e) { console.warn('Momentum push:', e.message); }
  }
}

/* ══════════════════════════════════════════════════════════════════
   TRADE ASSISTANT - alerts go to the phones / browsers that turned on background alerts (Web Push).
   (Telegram removed 20 Nov 2026 - not used.)
   - 09:30 morning brief (NSE trading days): new entries allowed / small size / not today, global bias, India
     regime, holidays, high-impact events, open trades, market-moving headlines.
   - 09:45 and 17:00 Gold Petal, Crude Oil, Natural Gas: an alert only on a BUY plan (buy-only since 20 Nov 2026), plus an instant alert when
     price reaches the planned buy level. 10:00 Nifty options: an alert only when the credit-spread rule passes.
   - Scans at 11:00 and 15:00: READY / ready-on-limit / quick bounce stocks; at 15:00 one quiet line (with the Gold
     and Nifty status) when nothing was ready.
   - Open-trade watcher (trades the user marked "I took this trade"): stop hit, target 1 hit, day-10 exit,
     results / ex-date within 2 trading days, Gold Petal expiry, Nifty through the short strike.
══════════════════════════════════════════════════════════════════ */
const APP_URL = String(process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');

/* One-time markers (event key -> time), kept 4 days, so each alert fires once. */
function flagOnce(k) {
  const f = USER_STORE.flags || (USER_STORE.flags = {});
  if (f[k]) return false;
  f[k] = Date.now();
  /* Trade alerts (j|...) are kept 60 days so a stop / target alert does not repeat on a trade left open; the rest 4 days. */
  for (const [kk, t] of Object.entries(f)) if (Date.now() - t > (kk.startsWith('j|') ? 60 : 4) * 86400e3) delete f[kk];
  saveStore();
  return true;
}
function storeJournal() { try { const a = JSON.parse(USER_STORE.keys.td_journal?.v || '[]'); return Array.isArray(a) ? a.filter(t => t && t.id && t.sym) : []; } catch { return []; } }
const inr = (n, d = 2) => '₹' + (+n).toLocaleString('en-IN', { maximumFractionDigits: d });
const symShort = s => String(s || '').replace(/^(NSE|MCX):/, '');

/* Gold Petal plan on the server - the page's own function (SwingPlan.commodityPlan) on the same quote, with the
   user's saved MCX calibration (synced key) and the same drivers. */
const MCX_ALERT_SYMS = ['MCX:GOLDPETAL', 'MCX:CRUDEOIL', 'MCX:NATURALGAS'];
const MCX_NAME = { 'MCX:GOLDPETAL': 'Gold Petal', 'MCX:CRUDEOIL': 'Crude Oil Mini', 'MCX:NATURALGAS': 'Natural Gas Mini' };
const MCX_EMOJI = { 'MCX:GOLDPETAL': '🟡', 'MCX:CRUDEOIL': '🛢', 'MCX:NATURALGAS': '🔥' };
async function goldPlanS(sym = 'MCX:GOLDPETAL') {
  const q = (await cacheWrap(`quote:${sym}`, TTL.mcx, () => buildQuotePayload(sym))).value;
  let k = 1;
  try { const c = JSON.parse(USER_STORE.keys['td_mcx_cal2_' + sym]?.v || 'null'); if (c && c.mcx > 0 && c.proxy > 0 && Date.now() - c.ts < 3 * 86400e3 && !(q.rolledAt && c.ts < q.rolledAt)) { const kk = c.mcx / c.proxy; if (kk > 0.8 && kk < 1.25) k = kk; } } catch {}
  const d = q.daily, n = d.C.length;
  if (n < 60 || !(q.price > 0)) throw new Error(`${MCX_NAME[sym] || sym} history too short`);
  const C = d.C.map(v => v * k), H = d.H.map(v => v * k), L = d.L.map(v => v * k), price = q.price * k;
  /* Same live candle rule as the page (enrichLiveData): a bar is appended only when Yahoo's last bar is from an EARLIER
     date than the live trade. 23 Nov 2026: at 09:45 IST (23:15 New York) a US future's last bar is already stamped with
     the next trading day, which the old "same date?" test took for a missing bar - the plan got a duplicate candle and
     its EMAs, ATR and levels differed from the app's. */
  const tz = q.dataSource?.timezone || 'America/New_York';
  const dk = ts => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000)); } catch { return ''; } };
  const lastK = dk(d.T[n - 1]), liveK = dk(q.marketTime);
  const sameDay = lastK && liveK ? lastK >= liveK : sameMarketDate(d.T[n - 1], q.marketTime, tz);
  if (sameDay) { C[n - 1] = price; H[n - 1] = Math.max(H[n - 1], price); L[n - 1] = Math.min(L[n - 1], price); }
  else { C.push(price); H.push(price); L.push(price); }
  const sr = SwingPlan.srLevels({ H, L, C, i: C.length - 2, price });
  let drivers = null; if (SwingPlan.GOLD_MCX.has(sym)) { try { drivers = (await mcxDriversFor(sym)).goldRule; } catch {} }
  const plan = SwingPlan.commodityPlan(sym, { C, H, L, price, sr }, { minRR: 1.25, drivers });
  return { ...plan, calibrated: k !== 1, calK: k, drivers, expiry: sym === 'MCX:GOLDPETAL' ? SwingPlan.goldPetalExpiry(istDateKey(), isNseHoliday) : null,
    contract: sym === 'MCX:GOLDPETAL' ? SwingPlan.goldPetalContract(istDateKey(), isNseHoliday) : null };
}
function goldPlanText(p) {
  const head = p.side === 'BUY' && !p.driverBlock ? `BUY · ${p.action}` : p.side === 'BUY' ? `WAIT · ${p.action}` : p.side === 'SELL' ? `SELL (small size - all 3 drivers point down) · ${p.action}` : p.side === 'AVOID' ? `AVOID · ${p.action}` : `WAIT · ${p.why}`;
  const lv = p.side === 'BUY' || p.side === 'SELL' ? `\nEntry ${inr(p.entry)} · Stop ${inr(p.sl)} · Target ${inr(p.exitTarget || p.t1)} (${p.exitRule || 'T1'}) · R:R to T1 ${p.rr ? p.rr.toFixed(2) : '--'}` : '';
  const drv = p.drivers?.known ? `\nDrivers (information only) ${p.drivers.count}/3: ${p.drivers.text}` : '';
  const exp = p.expiry && p.expiry.tradingDaysLeft <= 5 ? `\n⚠ Contract expires ${p.expiry.date} (${p.expiry.tradingDaysLeft} trading days) - roll or exit` : '';
  const ctr = p.contract && (p.side === 'BUY' || p.side === 'SELL') ? `\n${p.contract.text}` : '';
  return `${head}${lv}${drv}${exp}${ctr}\nNow ${inr(p.price)}${p.calibrated ? ' (your MCX calibration)' : ' (proxy - calibrate in the app for exact MCX levels)'}`;
}
function niftyRuleText({ rule, chain }) {
  const p = rule.pick;
  const lines = [`${rule.ok ? '✅ ' : ''}${rule.verdict}`, `Expiry ${chain.expiry} (${rule.daysToExpiry} days) · Nifty ${(+rule.spot).toFixed(0)}${chain.stale ? ' · saved NSE quote' : ''}`];
  if (p && !p.none) {
    lines.push(`Sell ${p.sell} ${p.ty === 'P' ? 'PE' : 'CE'} ${p.sellPx} / buy ${p.buy} ${p.ty === 'P' ? 'PE' : 'CE'} ${p.buyPx} · credit ${p.credit} pts (${inr(p.credit * 65, 0)}/lot) · max loss ${inr(p.maxLoss * 65, 0)}/lot`);
    lines.push(p.checks.map(c => `${c.pass ? '✓' : c.need ? '✗' : 'ℹ'} ${c.name}`).join('\n'));
    if (rule.ok) lines.push(`Hold to expiry (the tested exit) - the most it can lose is ${inr(p.maxLoss * 65, 0)}/lot.`);
  }
  return lines.join('\n');
}

/* Open-trade watcher. Prices come from the same cached quick price the sidebar uses. */
let WATCH_RUNNING = false;
async function openTradeWatchTick() {
  if (WATCH_RUNNING) return;
  const open = storeJournal().filter(t => t.status === 'open');
  if (!open.length) return;
  WATCH_RUNNING = true;
  try {
    const today = istDateKey();
    for (const t of open) {
      const sym = String(t.sym).toUpperCase(), name = symShort(sym), long = t.side !== 'SELL';
      if (t.kind === 'option') {
        /* Credit spread: alert when Nifty closes through the short strike, and on the expiry morning. */
        if (!symMarketOpenS('NSE:NIFTY')) continue;
        let q; try { q = await quickPriceFor('NSE:NIFTY', BG_QUOTE_MAX_AGE); } catch { continue; }
        const p = +q?.price, k = +t.shortStrike;
        const ck = +t.callStrike, putHit = p > 0 && k > 0 && (t.optType === 'P' ? p < k : p > k), callHit = p > 0 && ck > 0 && p > ck;
        if ((putHit || callHit) && flagOnce(`j|${t.id}|tested|${today}`)) {
          const leg = callHit ? `${ck} CE` : `${k} ${t.optType === 'P' ? 'PE' : 'CE'}`, naked = !(+t.wing > 0);
          await pushAll({ title: `⚠ Nifty through your short ${leg}`, body: `Nifty ${p.toFixed(0)}. ${t.label || 'Option trade'}: ${naked ? 'naked sell - exit if the option(s) close at 2x what you sold for (the tested exit).' : 'the tested plan holds the spread to expiry - the loss is capped at the spread width minus the credit.'}`, tag: `j-${t.id}`, url: '/?view=trades' });
        }
        if (t.expiry === today && flagOnce(`j|${t.id}|expiry`)) await pushAll({ title: `Expiry today: ${t.label || 'credit spread'}`, body: 'Close it before 15:15 or let it expire if both strikes are safely out of the money.', tag: `j-${t.id}`, url: '/?view=trades' });
        continue;
      }
      if (!symMarketOpenS(sym)) continue;
      let q; try { q = await quickPriceFor(sym, BG_QUOTE_MAX_AGE); } catch { continue; }
      let p = +q?.price;
      if (!(p > 0)) continue;
      if (sym.startsWith('MCX:') && +t.calK > 0) p *= +t.calK;   /* levels were saved in calibrated MCX terms */
      const tl = t.exitMode === 'trail' && long ? +USER_STORE.trailLv?.[t.id] || 0 : 0, stop = Math.max(+t.stop || 0, tl), t1 = +t.t1;
      if (stop > 0 && (long ? p <= stop : p >= stop) && flagOnce(`j|${t.id}|stop`))
        await pushAll({ title: `🛑 ${name} hit your ${tl > +t.stop ? 'trailing ' : ''}stop ${inr(stop)}`, body: `Now ${inr(p)}. Exit as planned and mark the trade closed in My trades.`, tag: `j-${t.id}`, url: '/?view=trades' });
      else if (t1 > 0 && (long ? p >= t1 : p <= t1) && flagOnce(`j|${t.id}|t1`))
        /* Trades saved from 19 Nov 2026 carry the tested exit (exitDays): their target is the whole-position exit. */
        await pushAll({ title: `🎯 ${name} reached your target ${inr(t1)}`, body: t.exitDays ? `Now ${inr(p)}. The tested exit sells the whole position here - then mark it closed in My trades.` : `Now ${inr(p)}. Book half and move the stop to your entry ${inr(t.entry)}.`, tag: `j-${t.id}`, url: '/?view=trades' });
    }
  } finally { WATCH_RUNNING = false; }
}
/* Once a day (09:20): time exits, results / corporate actions close to an open trade, Gold Petal expiry. */
async function openTradeDailyChecks() {
  const open = storeJournal().filter(t => t.status === 'open'), today = istDateKey(), msgs = [];
  if (!open.length) return msgs;
  let cal = null; try { cal = await getResultsCalendar(); } catch {}
  for (const t of open) {
    const sym = String(t.sym).toUpperCase(), name = symShort(sym);
    if (t.kind === 'mcx' && +t.exitDays > 0) {
      const held = t.openedAt ? tradingDaysUntil(t.openedAt, today) : 0;
      if (held >= +t.exitDays && flagOnce(`j|${t.id}|dayN|${today}`)) msgs.push(`${name}: day ${held} - the plan's time exit (${+t.exitDays} trading days) is due`);
    }
    /* Trailing exit (23 Nov 2026): from the completed daily candles since the entry - one quote per open trade a day. */
    if (t.kind === 'stock' && t.exitMode === 'trail' && t.openedAt && +t.entry > 0 && +t.stop > 0) try {
      const q = (await cacheWrap(`quote:${sym}`, TTL.quote, () => buildQuotePayload(sym))).value, d = q?.daily;
      const idx = (d?.T || []).map((ts, i) => [istDateKey(ts * 1000), i]).filter(([k]) => k > t.openedAt && k < today).map(([, i]) => i);
      if (idx.length) {
        const w = SwingPlan.trailWalk(d, idx[0], idx[idx.length - 1], +t.entry, +t.stop);
        const lv = (USER_STORE.trailLv ||= {});
        if (w.exit === 'ema' && flagOnce(`j|${t.id}|trail-ema`)) msgs.push(`${name}: closed below EMA20 (${inr(w.level)} vs ${inr(w.e20)}) - the trailing exit sells at today's open`);
        else if (w.exit === 'time' && flagOnce(`j|${t.id}|trail-time`)) msgs.push(`${name}: day ${w.days} - the trailing exit's time limit; sell today`);
        else if (w.exit === 'stop' && flagOnce(`j|${t.id}|trail-stop`)) msgs.push(`${name}: the stop ${inr(w.level)} was reached - exit and mark it closed in My trades`);
        else if (!w.exit && w.trail > Math.max(+t.stop, +lv[t.id] || 0) + 0.005) { lv[t.id] = w.trail; saveStore(); msgs.push(`${name}: raise your stop-loss to ${inr(w.trail)} (4 ATR under the highest close ${inr(w.hc)})`); }
      }
    } catch (e) { console.warn(`trail ${sym}:`, e.message); }
    if (t.kind === 'stock') {
      const held = t.openedAt ? tradingDaysUntil(t.openedAt, today) : 0, lim = +t.exitDays > 0 ? +t.exitDays : 10;
      if (t.exitMode !== 'trail' && held >= lim && flagOnce(`j|${t.id}|day10|${today}`)) msgs.push(`${name}: day ${held} - the plan's time exit (${lim} trading days) is due`);
      const r = cal ? resultsCheckFor(name, cal, today) : null;
      if (r && r.tradingDays >= 0 && r.tradingDays <= 2 && flagOnce(`j|${t.id}|results|${r.date}`)) msgs.push(`${name}: results ${r.date === today ? 'today' : `on ${r.date}`} - gap risk, consider booking or tightening the stop`);
      for (const a of stockEventCheckS(name, today).items.filter(a => a.tradingDays <= 2))
        if (flagOnce(`j|${t.id}|ca|${a.date}|${a.kind}`)) msgs.push(`${name}: ${a.subject}, ex-date ${a.date} - the price adjusts that morning`);
    }
    if (sym === 'MCX:GOLDPETAL') {
      const e = SwingPlan.goldPetalExpiry(today, isNseHoliday);
      if (e.tradingDaysLeft <= 3 && flagOnce(`j|${t.id}|gpexp|${e.date}|${today}`)) msgs.push(`Gold Petal: contract expires ${e.date} (${e.tradingDaysLeft} trading days) - roll to next month or exit`);
    }
  }
  return msgs;
}

/* Global cue for the brief: the same score as the Markets page's Global Bias card (US index futures, Nikkei,
   Hang Seng, India VIX). Reuses the page's data when it is under 20 min old, else 4 light Yahoo quotes plus
   NSE's index list (already fetched for the index prices). */
async function globalCueS() {
  const hit = API_CACHE.get('global:all');
  let d = hit && Date.now() - hit.ts < 20 * 60e3 ? hit.value : null;
  if (!d) {
    d = {};
    const T = { spFut: 'ES=F', nqFut: 'NQ=F', nikkei: '^N225', hangseng: '^HSI' };
    await Promise.all(Object.entries(T).map(async ([k, t]) => {
      try { const r = await withTimeout(safeFetch(() => getPriceAndChange(t), 1), 15000, t); if (Number.isFinite(r?.rawPct)) d[k] = { pct: r.rawPct }; } catch {}
    }));
    try { const y = await getPriceAndChange('^INDIAVIX'); if (y.liveRaw > 0) d.vix = { price: y.liveRaw, pct: y.prevRaw > 0 ? (y.liveRaw / y.prevRaw - 1) * 100 : null }; } catch {}
  }
  const pct = it => it && !it.error && it.pct != null && Number.isFinite(+it.pct) ? +it.pct : null;
  let score = 0; const parts = [];
  /* Same rules as the page's computeGlobalBiasVerdict: US futures (cash close when a future is missing, plus the Dow
     at half weight then), Nikkei, Hang Seng, and the DAX at half weight only while it is trading. */
  const add = (k, name, w = 1) => {
    const p = pct(d[k]); if (p == null) return;
    parts.push(`${name} ${p >= 0 ? '+' : ''}${p.toFixed(2)}%`);
    if (p >= 0.25) score += w; else if (p <= -0.25) score -= w;
  };
  const liveNow = it => !!it && !it.error && Number(it.at) > 0 && Date.now() / 1000 - Number(it.at) < 1800;
  if (pct(d.spFut) != null) add('spFut', 'S&P fut'); else add('sp500', 'S&P');
  if (pct(d.nqFut) != null) add('nqFut', 'Nasdaq fut'); else add('nasdaq', 'Nasdaq');
  if (pct(d.spFut) == null) add('dow', 'Dow', 0.5);
  add('nikkei', 'Nikkei'); add('hangseng', 'Hang Seng');
  if (liveNow(d.dax)) add('dax', 'DAX', 0.5);
  const vix = +d.vix?.price > 0 && !d.vix?.error ? +d.vix.price : null, vp = pct(d.vix);
  if (vix != null) { parts.push(`India VIX ${vix.toFixed(1)}`); if (vix < 15) score += 0.75; else if (vix > 20) score -= 1; }
  if (vp != null) { if (vp <= -3) score += 0.5; else if (vp >= 3) score -= 0.5; }
  const label = !parts.length ? 'UNKNOWN' : score >= 2.5 ? 'BULL' : score <= -2.5 ? 'BEAR' : 'NEUTRAL';
  return { label, score, text: parts.join(' · ') };
}
/* Market-moving headlines for the brief: the Nifty news list (the News tab's cache when under an hour old),
   last 18 hours, only headlines with a clear up / down impact, strongest first. */
async function marketHeadlinesS() {
  const sym = 'NSE:NIFTY', name = 'NIFTY', ctx = buildNewsContext(name, sym), c = NEWS_CACHE[`news_v15_${sym}_${newsHash(name)}`];
  let items = c && Date.now() - c.ts < 60 * 60e3 ? c.payload?.items || [] : null;
  if (!items) { const all = await withTimeout(gatherAllNews(ctx), 15000, 'news'); items = finalizeNews(all.items || [], ctx); }
  /* Market recaps ("Sensex jumps 500 points", "Stock market LIVE") and broker pick lists ("Stocks to buy") describe
     the market, they do not move it. */
  const RECAP = /\b(sensex|nifty)\b.{0,60}\b(\d[\d,.]*\s*(pts|points)|jumps?|falls?|gains?|rises?|slips?|drops?|ends?|closes?|opens?|trades?|tops?|nears?|extends?|rall(y|ies)|snaps?)\b|\b(stock|share)?\s*market\s+(live|today|highlights|updates?|wrap)\b|\blive\s*(updates?|blog)\b|\b(closing|opening)\s+bell\b|\bstocks?\s+to\s+(buy|watch|sell)\b|\b(top|stock)\s+picks?\b|\bbuy\s+or\s+sell\b|\bstocks?\s+in\s+(news|focus)\b|\btrade\s+setup\b/i;
  return filterNewsAge(items, 18).filter(i => Math.abs(+i.impactScore || 0) >= 5 && !RECAP.test(i.title || ''))
    .sort((a, b) => Math.abs(b.impactScore) - Math.abs(a.impactScore)).slice(0, 3)
    .map(i => ({ ...i, title: String(i.title).replace(/\s+\|\s+.*$/, '').trim() }));
}
/* "New entries" line: open-risk limit first, then the market regime (the same filter the READY gate uses), then
   reasons to trade smaller (cautious regime, weak global cues, a big event today). */
function entryVerdictS({ reg, glob, eventToday, openPct, limitPct }) {
  if (openPct != null && openPct >= limitPct) return `NO NEW TRADES - open risk ${openPct.toFixed(1)}% is at your ${limitPct}% limit`;
  if (reg && reg.allowReady === false) return `NOT TODAY - ${reg.note}`;
  const why = [];
  if (!reg || reg.status === 'UNKNOWN') why.push('Nifty trend not available');
  else if (['CAUTION', 'RECOVERY'].includes(reg.status)) why.push(`market ${reg.status.toLowerCase()}`);
  if (glob?.label === 'BEAR') why.push('global cues weak');
  if (eventToday) why.push(`${eventToday} today`);
  return why.length ? `SMALL SIZE - ${why.join(', ')}` : 'ALLOWED - market trend and global cues support fresh swing longs';
}

async function morningBrief() {
  const today = istDateKey(), lines = [];
  let reg = null, glob = null;
  /* Breadth is measured by the scans (11:00 / 15:00); at 09:30 the last one is from the previous session. */
  try { reg = marketRegime(await getNiftyRegime(), 4 * 86400e3); } catch {}
  try { glob = await globalCueS(); } catch {}
  const evLines = []; let eventToday = null;
  try {
    const tom = istDateKey(Date.now() + 86400e3);
    const ev = ECON_CALENDAR.concat(generatedMacroEvents(today)).filter(e => (e.date === today || e.date === tom) && /HIGH/i.test(e.impact || '') && ['RBI', 'FOMC', 'CPI', 'NFP', 'BUDGET', 'GDP'].includes(e.category));
    for (const e of ev.slice(0, 5)) evLines.push(`${e.date === today ? 'Today' : 'Tomorrow'}: ${e.event}${e.time ? ' ' + e.time : ''}`);
    eventToday = ev.find(e => e.date === today)?.event || null;
  } catch {}
  const open = storeJournal().filter(t => t.status === 'open');
  let cap = 0; try { cap = +JSON.parse(USER_STORE.keys.td_pos_capital?.v || '0') || 0; } catch {}
  let limitPct = 5; try { const v = +JSON.parse(USER_STORE.keys.td_max_open_risk?.v || '5'); if (v > 0 && v <= 100) limitPct = v; } catch {}
  const risk = open.reduce((a, t) => a + (+t.riskRs || 0), 0), openPct = cap > 0 ? risk / cap * 100 : null;

  lines.push(`New entries: ${entryVerdictS({ reg, glob, eventToday, openPct, limitPct })}`);
  lines.push(`Global: ${glob ? `${glob.label}${glob.text ? ' - ' + glob.text : ''}` : 'not available'}`);
  lines.push(`India: ${reg ? `${reg.status} - ${reg.note}` : 'Nifty trend not available'}`);
  for (const h of upcomingSpecialSession(today).filter(h => h.tradingDays <= 3)) lines.push(`${h.date === today ? 'Today' : h.date}: NSE holiday - ${h.name}${h.special ? ' (special Muhurat session - check NSE timing)' : ''}`);
  lines.push(...evLines);
  if (open.length) lines.push(`Open trades: ${open.length} (${open.map(t => symShort(t.sym)).join(', ')}) · open risk ${inr(risk, 0)}${openPct != null ? ` = ${openPct.toFixed(1)}% of capital` : ''}`);
  try { lines.push(...await openTradeDailyChecks()); } catch {}
  try {
    const h = await marketHeadlinesS();
    lines.push(h.length ? 'News:\n' + h.map(i => `${i.impactScore > 0 ? '▲' : '▼'} ${String(i.title).slice(0, 120)}${i.source ? ` (${i.source})` : ''}`).join('\n') : 'News: no big market-moving headline since last evening');
  } catch { lines.push('News: not reachable - check the News tab'); }
  try { const e = SwingPlan.goldPetalExpiry(today, isNseHoliday); if (e.tradingDaysLeft <= 5) lines.push(`Gold Petal contract expires ${e.date} (${e.tradingDaysLeft} trading days) - roll or exit`); } catch {}
  lines.push('MCX (Gold Petal, Crude Oil, Natural Gas): 09:45 alerts only a ready buy, 17:00 always sends a status line. Nifty options 10:00 (bull put) and 15:05 on the day after an expiry (weekly sells). Stock scans 11:00 and 15:00.');
  return lines.join('\n');
}

/* Schedule (IST). NSE jobs skip weekends and NSE holidays; Gold Petal runs on weekdays (MCX). */
let ASSIST_RUNNING = false;
async function assistantTick() {
  if (ASSIST_RUNNING) return;
  const { d, m, key } = istNowParts();
  if (d < 1 || d > 5) return;
  const nseDay = !isNseHoliday(key);
  ASSIST_RUNNING = true;
  try {
    const at = (min, id) => m >= min && m < min + 20 && flagOnce(`job|${id}|${key}`);
    /* Angel One: the session ends at midnight every day - a reminder to log in before the market opens. */
    if (nseDay && angelAutoSet() && !angelSession() && at(8 * 60 + 40, 'angel-auto-login')) { try { await angelAutoLogin('08:40'); } catch (e) { console.warn(e.message); } }
    if (nseDay && ANGEL.key && !angelSession() && at(8 * 60 + 45, 'angel-login')) await pushAll({ title: 'Connect Angel One for today', body: 'Live option premiums, India VIX and index values come from Angel One. Its login ends at midnight - tap to connect (TradeDesk -> My trades -> Connect Angel One).', tag: 'td-angel', url: '/api/smartapi/login' });
    if (nseDay && at(9 * 60 + 30, 'brief')) await pushAll({ title: `☀ TradeDesk morning brief · ${key}`, body: await morningBrief(), tag: 'td-brief', url: '/' });
    else if (!nseDay && at(9 * 60 + 30, 'holiday')) await pushAll({ title: 'NSE holiday today', body: `${NSE_CAL.holidays.find(h => h.date === key)?.name || 'Trading holiday'} - no NSE scans today. MCX may trade; an MCX alert still comes at 09:45 if there is a trade.`, tag: 'td-brief', url: '/' });
    /* Gold Petal: an alert only when the plan is a trade (BUY with the drivers, or SELL); otherwise the status is
       kept for the 15:00 "nothing ready" line. The 17:00 check catches the US-data evening. */
    /* A check missed today (the server was deployed / restarted after 09:45 or 17:00) runs once at the next minute,
       so a new deploy does not mean a silent day. */
    const mcxMissed = MCX_ALERT_SYMS.some(s => MCX_STATUS[s]?.day !== key);
    const mcxCatch = mcxMissed && ((m >= 10 * 60 + 5 && m < 17 * 60) || (m >= 17 * 60 + 20 && m < 23 * 60)) && flagOnce(`job|mcx-catchup|${key}|${m < 17 * 60 ? 'am' : 'pm'}`);
    for (const [min, id] of [[9 * 60 + 45, 'gold-am'], [17 * 60, 'gold-pm'], [-1, 'catch-up']]) {
      if (min < 0 ? mcxCatch : at(min, id)) {
        let readyNow = 0;
        if (min < 12 * 60) await traceGoldDaily(key).catch(e => console.warn('MCX trace:', e.message));   /* yesterday's candle first */
        for (const sym of MCX_ALERT_SYMS) {
          if (min < 0 && MCX_STATUS[sym]?.day === key) continue;
          try {
            /* Ready = a trade plan whose entry is within one day's range (1 ATR) of the price. A plan that waits for a
               bigger dip / rise is alerted later, when price reaches its level (below). */
            const g = await goldPlanS(sym), trade = ((g.side === 'BUY' && !g.driverBlock) || g.side === 'SELL') && g.entry > 0 && Math.abs(g.entry - g.price) <= (g.atr || 0);
            GOLD_PLAN_LAST[sym] = { plan: g, ts: Date.now() };
            const waiting = !trade && g.entry > 0 && (g.side === 'SELL' || (g.side === 'BUY' && !g.driverBlock));
            MCX_STATUS[sym] = { day: key, text: waiting ? `${g.side === 'SELL' ? 'SELL (small size)' : 'BUY'} plan waiting - alert when price reaches ${inr(g.entry)} (now ${inr(g.price)})` : goldPlanText(g).split('\n')[0] };
            if (trade) {
              const when = min < 0 ? `check at ${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}` : min < 12 * 60 ? '09:45' : '17:00';
              traceGoldRecord(g, `ready ${when}`, key); readyNow++;
              await pushAll({ title: `${MCX_EMOJI[sym]} ${MCX_NAME[sym]} · ${g.side === 'SELL' ? 'SELL (small size)' : 'BUY'} ready · ${min < 0 ? when : min < 12 * 60 ? 'morning' : 'evening'}`, body: goldPlanText(g), tag: `td-mcx-${sym}`, url: `/?sym=${sym}` });
            }
          } catch (e) { MCX_STATUS[sym] = { day: key, text: `plan not available (${e.message})` }; console.warn(`${sym} plan:`, e.message); }
        }
        /* Evening: one quiet line when no MCX trade is ready, so a silent evening is not mistaken for a broken alert
           (the morning check has the 15:00 summary for that). */
        if (min === 17 * 60 && !readyNow)
          await pushAll({ title: 'MCX evening check · nothing ready', body: MCX_ALERT_SYMS.map(s => `${MCX_EMOJI[s]} ${MCX_NAME[s]}: ${MCX_STATUS[s]?.day === key ? MCX_STATUS[s].text : 'plan not checked'}`).join('\n'), tag: 'td-mcx-evening', url: '/' });
      }
    }
    /* Nifty options (21 Nov 2026, matched to the backtests): all three are entered at the close of the FIRST trading day
       after a weekly expiry - the bull-put rule held to expiry (the app's own rule: 95% wins, profit in 8 of 8 years;
       alerting any day with a 2x-credit stop was +Rs 27 a lot, 4 of 8 years), the trend sell and the short strangle (exit on
       a close at 2x). One alert at 15:05 that day (a retry until 15:25 if the premiums were missing), a 10:00 reminder that
       day when Angel One is not connected. The Track record is marked at 15:05 and settled at 15:40. */
    const genExp = (() => { try { return generatedFnoExpiries(key, 40).map(x => x.date); } catch { return []; } })();
    const enGen = nseDay ? SwingPlan.weeklySellEntry(key, genExp.find(e => e >= key), isNseHoliday, genExp) : null;
    if (nseDay && enGen && !enGen.isEntryDay && NIFTY_STATUS?.day !== key) NIFTY_STATUS = { day: key, text: `no entry today - next entry ${enGen.entryDay} at the close (the day after an expiry)` };
    if (nseDay && enGen?.isEntryDay && ANGEL.key && !angelReady() && at(10 * 60, 'nifty-angel-reminder'))
      await pushAll({ title: 'Nifty options: entry day today', body: "The bull put and the weekly sells are entered at today's close. Connect Angel One before 15:00 so the 15:05 check has live premiums (My trades -> Connect Angel One).", tag: 'td-nifty-opt', url: '/?view=trades' });
    const niftyRetry = nseDay && m >= 15 * 60 + 6 && m < 15 * 60 + 26 && NIFTY_STATUS?.day === key && NIFTY_STATUS.failed && angelReady() && flagOnce(`job|nifty-retry|${key}|${m}`);
    if (nseDay && (at(15 * 60 + 5, 'nse-evening') || niftyRetry)) {
      let chain15 = null;
      try { chain15 = await withTimeout(getOptionChain('NSE:NIFTY', await niftyRuleExpiry(true), { fresh: niftyRetry ? 60e3 : 30 * 60e3, estimate: false }), 25000, 'Nifty chain'); } catch (e) { console.warn('15:05 premiums:', e.message); }
      const exps = chain15?.expiries?.length ? chain15.expiries : genExp, en = SwingPlan.weeklySellEntry(key, exps.find(e => e >= key), isNseHoliday, exps);
      if (en?.isEntryDay && !chain15?.strikes?.length) {
        const first = NIFTY_STATUS?.day !== key || !NIFTY_STATUS.failed;
        NIFTY_STATUS = { day: key, failed: true, text: 'entry day, but option premiums were not available' };
        /* an estimate of the bull put from Black-Scholes, so the alert still names strikes (not recorded in the Track record) */
        let est = '';
        if (first) try {
          const ec = await withTimeout(estimatedOptionChain('NSE:NIFTY', 'NIFTY', await niftyRuleExpiry(true).catch(() => '')), 20000, 'estimated chain');
          const reg = await getNiftyRegime(), days = Math.max(1, Math.round((Date.parse(ec.expiry + 'T15:30:00+05:30') - Date.now()) / 86400e3));
          const er = SwingPlan.creditSpreadRule(ec, { spot: +ec.spot, trendUp: reg.nifty > reg.ema20 && reg.ema20 > reg.ema50, trendDown: reg.nifty < reg.ema20 && reg.ema20 < reg.ema50, daysToExpiry: days, step: 50, wing: 200, monthly: SwingPlan.isMonthlyExpiry(ec.expiry, ec.expiries) });
          est = er?.pick && !er.pick.none ? ` Estimate (Black-Scholes, India VIX ${ec.vix}): sell ${er.pick.sell} PE / buy ${er.pick.buy} PE, about ${er.pick.credit} pts - ${er.ok ? 'passes' : 'does not pass'} on the estimate; check the real credit in your broker.` : ` Estimate: ${String(er?.verdict || 'no strike').slice(0, 120)}.`;
        } catch (e) { console.warn('Estimated Nifty rule:', e.message); }
        if (first) await pushAll({ title: 'Nifty options: entry day, premiums missing', body: `${angelReady() ? 'Option premiums were not available.' : 'Angel One is not connected (its login ends at midnight).'}${est} Connect Angel One before 15:25 - the check runs again - or open Markets -> Nifty.`, tag: 'td-nifty-opt', url: '/?view=trades' });
      } else if (en?.isEntryDay && flagOnce(`job|nifty-entry|${key}`)) {
        try {
          const reg = await getNiftyRegime(), spot = +chain15.spot || +reg.nifty;
          const days = Math.max(1, Math.round((Date.parse(chain15.expiry + 'T15:30:00+05:30') - Date.now()) / 86400e3));
          const trendUp = reg.nifty > reg.ema20 && reg.ema20 > reg.ema50, trendDown = reg.nifty < reg.ema20 && reg.ema20 < reg.ema50;
          const rule = SwingPlan.creditSpreadRule(chain15, { spot, trendUp, trendDown, daysToExpiry: days, step: 50, wing: 200, monthly: SwingPlan.isMonthlyExpiry(chain15.expiry, chain15.expiries) });
          const w = SwingPlan.niftyWeeklySells(chain15, { spot, trendUp, trendDown, daysToExpiry: days, step: 50 });
          NIFTY_STATUS = { day: key, text: String(rule.verdict || (rule.ok ? 'rule passed' : 'rule not met')).slice(0, 110) };
          if (rule.ok) traceNiftyRecord({ rule, chain: chain15 }, key);
          await pushAll({ title: `📊 Nifty options · entry today at the close (expiry ${chain15.expiry})`, tag: 'td-nifty-opt', url: '/?sym=NSE:NIFTY',
            body: `1. Bull put: ${niftyRuleText({ rule, chain: chain15 })}\n2. Trend sell: ${w?.trend?.ok ? `SELL ${w.trend.strike} ${w.trend.ty === 'P' ? 'PE' : 'CE'} ~${w.trend.premium} (${inr(w.trend.premium * 65, 0)}/lot) · exit if it closes at ${w.trend.exitAt}+` : w?.trend?.why || 'no quote'}\n3. Strangle: ${w?.strangle?.ok ? `SELL ${w.strangle.put} PE ${w.strangle.putPx} + ${w.strangle.call} CE ${w.strangle.callPx} = ${w.strangle.credit} pts · exit if the pair closes at ${w.strangle.exitAt}+` : w?.strangle?.why || 'no quote'}\nNaked sells: margin ~₹1.5L a lot; the 2x exit is the only protection. Check premiums before ordering.` });
        } catch (e) { NIFTY_STATUS = { day: key, failed: true, text: `entry day, check failed (${e.message})` }; console.warn('Nifty entry:', e.message); }
      }
      if (!niftyRetry) await traceNiftyCheck(key, m, 'mark').catch(e => console.warn('Nifty trace:', e.message));
    }
    if (at(15 * 60 + 40, 'trace-nifty-settle')) await traceNiftyCheck(key, m, 'settle').catch(e => console.warn('Nifty trace:', e.message));
    if (nseDay && at(9 * 60 + 20, 'trade-checks')) {
      const msgs = await openTradeDailyChecks().catch(() => []);
      if (msgs.length) await pushAll({ title: '📋 Your open trades', body: msgs.join('\n'), tag: 'td-trades', url: '/?view=trades' });
    }
    /* Gold Petal: price reached the planned level of a "wait for a dip" buy or "wait for a rise" sell, once a day,
       MCX hours. */
    if (m >= 9 * 60 && m <= 23 * 60 + 30) for (const sym of MCX_ALERT_SYMS) {
      if (!GOLD_PLAN_LAST[sym] || Date.now() - GOLD_PLAN_LAST[sym].ts > 30 * 60e3) { try { GOLD_PLAN_LAST[sym] = { plan: await goldPlanS(sym), ts: Date.now() }; } catch { GOLD_PLAN_LAST[sym] = { plan: null, ts: Date.now() }; } }
      const g = GOLD_PLAN_LAST[sym]?.plan;
      /* The plan is rebuilt every 30 min from the live price, so once price falls to the planned dip level the new plan
         says "buy now" and its entry equals the price: remember the day's planned level and alert against that. */
      const tradeSide = g && ((g.side === 'BUY' && !g.driverBlock) || g.side === 'SELL') ? g.side : null;
      const cur = GOLD_BUY_LEVEL[sym];
      if (tradeSide && (tradeSide === 'BUY' ? g.entry < g.price * 0.999 : g.entry > g.price * 1.001) &&
          (!cur || cur.day !== key || cur.entry !== g.entry || cur.side !== tradeSide))
        GOLD_BUY_LEVEL[sym] = { sym, day: key, side: tradeSide, entry: g.entry, sl: g.sl, t1: g.t1, t2: g.t2, exitTarget: g.exitTarget, exitDays: g.exitDays, exitRule: g.exitRule, e20: g.e20, smallSize: g.smallSize, calK: g.calK || 1 };
      if (g && !tradeSide) GOLD_BUY_LEVEL[sym] = null;   /* trend or drivers turned: no level alert */
      const lv = GOLD_BUY_LEVEL[sym];
      if (lv && lv.day === key) {
        const sell = lv.side === 'SELL';
        let q; try { q = await quickPriceFor(sym, BG_QUOTE_MAX_AGE); } catch {}
        const p = q?.price ? q.price * (lv.calK || 1) : null;   /* the plan's levels are in calibrated MCX terms */
        if (p && (sell ? p >= lv.entry && p < lv.sl : p <= lv.entry && p > lv.sl) && flagOnce(`${sym === 'MCX:GOLDPETAL' ? 'gold' : sym}-${sell ? 'sellzone' : 'buyzone'}|${key}`)) {
          traceGoldLevel(lv, p, key);
          await pushAll({ title: `${MCX_EMOJI[sym]} ${MCX_NAME[sym]} at your ${sell ? 'sell (small size)' : 'buy'} level ${inr(lv.entry)}`, body: `Now ${inr(p)}. Stop ${inr(lv.sl)} · target ${inr(lv.exitTarget || lv.t1)} (${lv.exitRule || 'T1'}). Check the MCX quote before ordering.`, tag: `td-mcx-${sym}`, url: `/?sym=${sym}` });
        }
      }
    }
  } finally { ASSIST_RUNNING = false; }
}
const GOLD_PLAN_LAST = {}, GOLD_BUY_LEVEL = {}, MCX_STATUS = {};
let NIFTY_STATUS = null;
/* ══════════════════════════════════════════════════════════════════
   SIGNAL TRACE - every alerted trade followed to its exit, checked ONCE A DAY (few calls):
   - Stocks: each READY pick of the 11:00 / 15:00 scans is recorded here (entry = the price at the scan); the
     Track record page adds it to its stock list and walks the daily candles: stop, T1 / T2, and an exit at the
     close of day 10 at the latest.
   - Gold Petal: recorded when the server alerts a trade (ready at 09:45 / 17:00, or price reaching a waiting plan's
     level). Entry = the plan's defined price: filled at once when price is already there, else when the level
     alert sees price reach it that day ("Not filled" otherwise). Checked each morning at 09:45 on the completed
     daily candles (the same quote the 09:45 plan uses - no extra call): stop -1R · at T1 half booked and the stop
     moved to entry · the rest at T2, at entry, or on a daily close through the plan's EMA.
   - Nifty options: recorded when the bull-put rule passes at 15:05 on the first trading day after an expiry, held to
     expiry and settled from Nifty's close (1R = width minus credit). Rows from before 21 Nov 2026 keep their old
     exit (80% of the premium, a 2x-credit stop or Friday's close; 1R = 2x the credit).
   Stored in the synced key td_trace so the phone keeps a copy and uploads it again after a Render restart wiped
   the server's disk; the server and the page merge the two copies by record id.
══════════════════════════════════════════════════════════════════ */
const TRACE_KEY = 'td_trace';
const r2 = v => Math.round(+v * 100) / 100;
function traceParse(v) {
  try { const j = JSON.parse(v || 'null'); if (j && Array.isArray(j.rows)) return { clearedAt: +j.clearedAt || 0, rows: j.rows.filter(r => r && r.id) }; } catch {}
  return { clearedAt: 0, rows: [] };
}
function traceMerge(a, b) {
  const clearedAt = Math.max(+a.clearedAt || 0, +b.clearedAt || 0), m = new Map();
  for (const r of [...a.rows, ...b.rows]) {
    if ((+r.createdAt || 0) <= clearedAt) continue;
    const o = m.get(r.id);
    if (!o || (+r.upd || 0) > (+o.upd || 0)) m.set(r.id, r);
  }
  return { clearedAt, rows: [...m.values()].sort((x, y) => (+x.createdAt || 0) - (+y.createdAt || 0)).slice(-500) };
}
function traceLoad() { return traceParse(USER_STORE.keys[TRACE_KEY]?.v); }
function traceSave(t) { USER_STORE.keys[TRACE_KEY] = { v: JSON.stringify(t), t: Math.max(Date.now(), (+USER_STORE.keys[TRACE_KEY]?.t || 0) + 1) }; saveStore(); }

/* Stocks: the READY picks of a scan (entry = price at the scan). Stock records older than 60 days are dropped -
   by then the page has copied them into its own list. */
function traceStockRecord(picks, key) {
  if (!picks?.length) return;
  const t = traceLoad(), now = Date.now();
  t.rows = t.rows.filter(r => r.kind !== 'stock' || now - (+r.createdAt || 0) < 60 * 86400e3);
  let added = 0;
  for (const x of picks) {
    const sym = String(x.sym || '').toUpperCase(), price = +x.price, pl = x.plan || {};
    /* one trade per stock: not again while a record of it is younger than 14 days (the page closes records; it also
       refuses a stock that still has an open one) */
    if (!sym || !(price > 0) || t.rows.some(r => r.kind === 'stock' && r.sym === sym && (r.date === key || (x.signalDate && r.signalDate === x.signalDate) || now - (+r.createdAt || 0) < 14 * 86400e3))) continue;
    const tg = x.tags || {};
    t.rows.push({ id: `stock|${key}|${sym}`, kind: 'stock', sym, date: key, createdAt: now, upd: now, entry: r2(price),
      sl: +pl.stop > 0 ? r2(pl.stop) : null, t1: +pl.target > 0 ? r2(pl.target) : null, setup: x.pickedSetup || x.selectedStrategy || null,
      exitMode: x.gateV2 ? 'trail' : '2R', t2r: +x.exit2R > 0 ? r2(x.exit2R) : +pl.stop > 0 && price > pl.stop ? r2(price + 2 * (price - pl.stop)) : null, sector: x.sector || null,
      tags: { hhhl: tg.hhhl ?? null, near52: tg.near52 ?? null, dbAbove: tg.dbAbove ?? null },
      bias: x.bias || 'Bullish', score10: x.score10 || null, final: x.finalQualification || x.decisionScore || null, pattern: !!x.pattern,
      signalDate: x.signalDate || null, planLocked: !!(x.pattern || x.gateV2), fresh: Number.isFinite(+x.fresh) ? +x.fresh : null });
    added++;
  }
  if (added) traceSave(t);
}

/* Gold Petal ----------------------------------------------------- */
/* MCX records (kind 'mcx'; older Gold Petal rows are kind 'gold' and keep their old exit). New rows follow the tested
   exit: the whole position at exitTarget (T1 for all since 20 Nov 2026; older gold rows 3R) or at the stop, else the close of day exitDays. */
const isMcxRow = r => r.kind === 'mcx' || r.kind === 'gold';
function traceGoldRecord(g, via, key, filledNow = false) {
  const t = traceLoad(), sym = g.sym || 'MCX:GOLDPETAL';
  if (t.rows.some(r => isMcxRow(r) && (r.sym || 'MCX:GOLDPETAL') === sym && !r.closed)) return null;   /* one trade per commodity at a time, like the plan */
  const long = g.side !== 'SELL', now = Date.now(), entry = r2(g.entry), price = +g.price;
  const filled = filledNow || (long ? price <= entry * 1.001 : price >= entry * 0.999);
  const row = { id: `mcx|${sym}|${now}`, kind: 'mcx', sym, date: key, createdAt: now, upd: now, via, exitMode: 'full',
    target: r2(g.exitTarget || g.t1), maxDays: +g.exitDays || 10, exitRule: g.exitRule || null,
    side: long ? 'BUY' : 'SELL', small: !!g.smallSize, entry, sl: r2(g.sl), t1: r2(g.t1), t2: r2(g.t2), calK: +g.calK || 1,
    trailRef: Number.isFinite(+g.e20) && (long ? price > g.e20 : price < g.e20) ? 'e20' : 'e50',
    phase: filled ? 'entry' : 'pending', status: filled ? 'Open' : `Waiting for ${inr(entry)} today`, closed: false,
    filledAt: filled ? now : null, mark: r2(price), markAt: now, resultR: null };
  t.rows.push(row); traceSave(t);
  return row;
}
/* The level alert saw price reach the entry: a waiting record becomes the trade; with none waiting, a new one. */
function traceGoldLevel(lv, p, key) {
  const t = traceLoad(), side = lv.side === 'SELL' ? 'SELL' : 'BUY', sym = lv.sym || 'MCX:GOLDPETAL';
  const w = t.rows.find(r => isMcxRow(r) && (r.sym || 'MCX:GOLDPETAL') === sym && !r.closed && r.phase === 'pending' && r.side === side && r.date === key);
  if (w) { w.phase = 'entry'; w.status = 'Open'; w.filledAt = Date.now(); w.mark = r2(p); w.markAt = Date.now(); w.upd = Date.now(); traceSave(t); return w; }
  return traceGoldRecord({ ...lv, price: p }, 'price reached the planned level', key, true);
}
function emaSeries(C, p) {
  const o = new Array(C.length).fill(null); if (C.length < p) return o;
  const k = 2 / (p + 1); let e = C.slice(0, p).reduce((a, b) => a + b, 0) / p; o[p - 1] = e;
  for (let i = p; i < C.length; i++) { e = C[i] * k + e * (1 - k); o[i] = e; }
  return o;
}
/* One completed daily candle {h, l, c, e20, e50} (calibrated) applied to an open Gold Petal record. When one candle
   reaches both the stop and a target the order is unknown, so the record is marked Ambiguous instead of guessed. */
function traceGoldBar(r, b) {
  const long = r.side !== 'SELL', sg = long ? 1 : -1, risk = Math.abs(r.entry - r.sl);
  const R = px => risk > 0 ? r2((px - r.entry) * sg / risk) : 0;
  const up = lv => long ? b.h >= lv : b.l <= lv, down = lv => long ? b.l <= lv : b.h >= lv;
  const close = (status, res, px) => { r.closed = true; r.status = status; r.resultR = res == null ? null : r2(res); r.closedAt = Date.now(); r.exitDate = b.date; if (px != null) r.exit = r2(px); };
  if (r.exitMode === 'full') {   /* the tested exit: all at the target or the stop, else the close of day maxDays */
    if (r.phase !== 'entry') return;
    const sl = down(r.sl), tg = up(r.target);
    if (sl && tg) close('Ambiguous: stop and target on the same day', null);
    else if (tg) close('Target hit', R(r.target), r.target);
    else if (sl) close('SL hit', -1, r.sl);
    else { r.days = (+r.days || 0) + 1; if (r.days >= (+r.maxDays || 10) && Number.isFinite(+b.c)) close(`Day ${+r.maxDays || 10} exit`, R(b.c), b.c); }
    return;
  }
  if (r.phase === 'entry') {
    const sl = down(r.sl), t1 = up(r.t1), t2 = up(r.t2);
    if (sl && (t1 || t2)) close('Ambiguous: stop and target on the same day', null);
    else if (t2) close('T2 hit', 0.5 * R(r.t1) + 0.5 * R(r.t2), r.t2);
    else if (t1) { r.phase = 'trail'; r.rT1 = R(r.t1); r.status = 'T1 hit · half booked, stop at entry'; r.resultR = r2(0.5 * r.rT1); }
    else if (sl) close('SL hit', -1, r.sl);
  } else if (r.phase === 'trail') {
    const rT1 = +r.rT1 || R(r.t1), t2 = up(r.t2), be = down(r.entry);
    const ema = r.trailRef === 'e50' ? b.e50 : b.e20;
    if (t2 && be) close('Ambiguous: T2 and entry on the same day', null);
    else if (t2) close('T2 hit', 0.5 * rT1 + 0.5 * R(r.t2), r.t2);
    else if (be) close('Rest stopped at entry', 0.5 * rT1, r.entry);
    else if (Number.isFinite(+ema) && Number.isFinite(+b.c) && (long ? b.c < ema : b.c > ema)) close(`Daily close ${long ? 'below' : 'above'} ${r.trailRef === 'e50' ? 'EMA50' : 'EMA20'}`, 0.5 * rT1 + 0.5 * R(b.c), b.c);
  }
  /* At most 10 trading days, like the stock swing trades: still open after the 10th completed day after the
     entry -> closed at that day's close (before T1: all of it; after T1: the half that was still running). */
  if (!r.closed && (r.phase === 'entry' || r.phase === 'trail')) {
    r.days = (+r.days || 0) + 1;
    if (r.days >= 10 && Number.isFinite(+b.c))
      close(r.phase === 'trail' ? 'T1 hit · rest closed on day 10' : 'Day 10 exit', r.phase === 'trail' ? 0.5 * (+r.rT1 || R(r.t1)) + 0.5 * R(b.c) : R(b.c), b.c);
  }
}
/* Each morning (09:45): completed candles after the record day. The record day's candle is not judged - its
   high / low may have come before the alert (same rule as the stock Track record). */
async function traceGoldDaily(key) {
  const t = traceLoad(), openAll = t.rows.filter(r => isMcxRow(r) && !r.closed);
  if (!openAll.length) return;
  let changed = false;
  for (const sym of [...new Set(openAll.map(r => r.sym || 'MCX:GOLDPETAL'))]) {
  const open = openAll.filter(r => (r.sym || 'MCX:GOLDPETAL') === sym);
  let q; try { q = (await cacheWrap(`quote:${sym}`, TTL.mcx, () => buildQuotePayload(sym))).value; } catch { continue; }
  const d = q?.daily;
  if (!d?.C?.length) continue;
  /* 23 Nov 2026: a futures roll (Natural Gas on 20 Nov: the next contract 12.6% higher) rescales the old bars to the new
     contract. A record made before the roll keeps old-contract levels, so it was judged against new-contract prices
     (false target / stop). Its levels move by the same ratio, once per roll. */
  const rolls = /=F$/.test(YF_MAP[sym] || '') ? futRollsFor(YF_MAP[sym]) : [];
  for (const r of open) {
    for (const ro of rolls) {
      const tag = String(ro.at); if ((r.rollsApplied || []).includes(tag) || !(+r.createdAt < (+ro.seen || ro.at * 1000))) continue;
      for (const k of ['entry', 'sl', 't1', 't2', 'target', 'mark']) if (+r[k] > 0) r[k] = r2(+r[k] * ro.ratio);
      r.rollsApplied = [...(r.rollsApplied || []), tag]; r.rollNote = `levels moved ${((ro.ratio - 1) * 100).toFixed(1)}% for the futures roll`; r.upd = Date.now(); changed = true;
    }
  }
  for (const r of open) {
    if (r.phase === 'pending') {
      if (r.date < key) { r.closed = true; r.status = 'Not filled (entry not reached that day)'; r.resultR = null; r.closedAt = Date.now(); r.upd = Date.now(); changed = true; }
      continue;
    }
    const k = +r.calK || 1, C = d.C.map(v => v * k), e20 = emaSeries(C, 20), e50 = emaSeries(C, 50);
    const from = r.evalThrough && r.evalThrough > r.date ? r.evalThrough : r.date;
    for (let i = 0; i < d.C.length && !r.closed; i++) {
      const date = d.T?.[i] ? istDateKey(d.T[i] * 1000) : null;
      if (!date || date <= from || date >= key) continue;
      traceGoldBar(r, { date, h: d.H[i] * k, l: d.L[i] * k, c: C[i], e20: e20[i], e50: e50[i] });
      r.evalThrough = date; r.mark = r2(C[i]); r.markAt = Date.now(); r.upd = Date.now(); changed = true;
    }
  }
  }
  if (changed) traceSave(t);
}

/* Nifty options -------------------------------------------------- */
function traceNiftyRecord({ rule, chain }, key) {
  const p = rule.pick; if (!rule.ok || !p || p.none) return null;
  const t = traceLoad();
  if (t.rows.some(r => r.kind === 'nifty' && !r.closed && r.expiry === chain.expiry && r.ty === p.ty)) return null;   /* one per expiry and side */
  const now = Date.now();
  const row = { id: `nifty|${chain.expiry}|${p.ty}|${now}`, kind: 'nifty', sym: 'NSE:NIFTY', date: key, createdAt: now, upd: now,
    type: p.type, ty: p.ty, sell: +p.sell, buy: +p.buy, credit: r2(p.credit), width: Math.abs(+p.sell - +p.buy), expiry: chain.expiry, lot: 65,
    spot: r2(rule.spot), hold: true, mark: r2(p.credit), markAt: now, status: 'Open · held to expiry', closed: false, resultR: null, pnlPts: null };
  t.rows.push(row); traceSave(t);
  return row;
}
function ocPxS(chain, k, ty) {
  const v = SwingPlan.ocPremium(chain, k, ty); if (v > 0) return v;
  const row = (chain?.strikes || []).find(x => +x.k === +k), o = row ? (ty === 'C' ? row.ce : row.pe) : null;
  return o && +o.ltp >= 0 ? +o.ltp : null;
}
async function niftyCloseOn(dateKey, todayKey, m) {
  const b = parseBars(await withTimeout(safeFetch(() => yfChart('^NSEI', '1d', '1mo'), 1), 15000, 'Nifty closes'));
  for (let i = b.T.length - 1; i >= 0; i--) if (b.T[i] && istDateKey(b.T[i] * 1000) === dateKey) return +b.C[i];
  return null;
}
function traceNiftySettle(r, spot) {
  const intrinsic = Math.max(0, Math.min(r.width, r.ty === 'P' ? r.sell - spot : spot - r.sell));
  r.pnlPts = r2(r.credit - intrinsic); r.resultR = r2(r.pnlPts / (r.hold ? Math.max(1, r.width - r.credit) : 2 * r.credit)); r.closed = true; r.closedAt = Date.now(); r.exitSpot = r2(spot);
  r.status = intrinsic <= 0 ? 'Expired worthless · full credit kept' : intrinsic >= r.width ? 'Expired · max loss' : 'Expired · part of the credit lost';
  r.mark = r2(intrinsic); r.markAt = Date.now(); r.upd = Date.now();
}
/* mode: 'morning' (10:00: 80% / stop), 'week' (15:05 on the week's last trading day: close everything older than
   today), 'settle' (15:40: expiries of today). Expiries already past (server was down) settle from Yahoo's close. */
async function traceNiftyCheck(key, m, mode = 'morning') {
  const t = traceLoad(), open = t.rows.filter(r => r.kind === 'nifty' && !r.closed);
  if (!open.length) return;
  let changed = false;
  for (const exp of [...new Set(open.map(r => r.expiry))]) {
    const rows = open.filter(r => r.expiry === exp);
    if (exp < key || (exp === key && mode === 'settle')) {
      let spot = null; try { spot = await niftyCloseOn(exp, key, m); } catch {}
      if (spot > 0) { rows.forEach(r => traceNiftySettle(r, spot)); changed = true; }
      continue;
    }
    if (mode === 'settle') continue;   /* 'mark' (15:05): update open rows; the bull put is held to expiry (older rows: 80% / stop) */
    const due = mode === 'week' ? rows.filter(r => r.date < key) : rows;
    if (!due.length) continue;
    let chain; try { chain = await withTimeout(getOptionChain('NSE:NIFTY', exp, { fresh: 30 * 60e3, estimate: false }), 25000, 'Nifty chain'); } catch { continue; }
    if (chain.expiry !== exp) continue;
    const spot = +chain.spot;
    for (const r of due) {
      const a = ocPxS(chain, r.sell, r.ty), b = ocPxS(chain, r.buy, r.ty);
      if (!(a > 0) || b == null) continue;
      const v = r2(Math.max(0, a - b)), tgt = +r.targetValue || r2(0.2 * r.credit);
      r.pnlPts = r2(r.credit - v); r.resultR = r2(r.pnlPts / (r.hold ? Math.max(1, r.width - r.credit) : 2 * r.credit)); r.mark = v; r.markAt = Date.now(); r.upd = Date.now(); changed = true;
      if (r.hold) { r.status = spot > 0 && (r.ty === 'P' ? spot < r.sell : spot > r.sell) ? 'Open · Nifty through the short strike (held to expiry)' : 'Open · held to expiry'; continue; }
      const shut = status => { r.closed = true; r.closedAt = Date.now(); r.exitSpot = r2(spot); r.status = status; };
      if (v <= tgt) shut('80% of the premium earned · closed');
      else if (v >= r.stopValue) shut('Stop hit (loss 2x the credit)');
      else if (mode === 'week') shut('Closed at the end of the week');
      else r.status = spot > 0 && (r.ty === 'P' ? spot < r.sell : spot > r.sell) ? 'Open · Nifty through the short strike' : 'Open';
    }
  }
  if (changed) traceSave(t);
}


setInterval(() => {
  serverAlertTick().catch(e => console.warn('Alert engine:', e.message));
  scheduledScanTick().catch(e => console.warn('Scheduled scan:', e.message));
  openTradeWatchTick().catch(e => console.warn('Trade watcher:', e.message));
  assistantTick().catch(e => console.warn('Assistant:', e.message));
}, 60 * 1000);

/* Render free sleeps after ~15 idle minutes, which stops the alert engine and the scheduled scans - and a sleeping
   process runs no timers, so it cannot wake itself (an overnight pause meant no morning alerts). A request to its own
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

  /* App icon, web-app manifest and service worker are public (no data in them). Phones fetch the manifest and
     the home-screen icon WITHOUT the login cookie, so behind the login they got the login page and the
     "Add to Home screen" shortcut had no logo. */
  if (req.method === 'GET' && (pn === '/icon-192.png' || pn === '/icon-512.png' || pn === '/apple-touch-icon.png' || pn === '/manifest.webmanifest' || pn === '/sw.js')) {
    return staticFile(req, res, path.join(__dirname, 'public', pn.slice(1)));
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
  if(pn==='/api/market-calendar') {
    const today = istDateKey();
    return send(res, { holidays: NSE_CAL.holidays, upcoming: upcomingSpecialSession(today), fetchedAt: NSE_CAL.ts.hol ? new Date(NSE_CAL.ts.hol).toISOString() : null,
      goldPetalExpiry: SwingPlan.goldPetalExpiry(today, isNseHoliday), today,
      /* Loose copies are unused leftovers once public/ is current (the page version label shows that): a quiet
         housekeeping note, not an error. GitHub's upload page never deletes files, so they stay until removed. */
      strayFiles: STRAY_PUBLIC_FILES.length ? { count: STRAY_PUBLIC_FILES.length, sample: STRAY_PUBLIC_FILES.slice(0, 4) } : null });
  }
  if(pn==='/api/news')             return apiNews(req,res,ps);
  if(pn==='/api/vix')              return apiVix(req,res);
  if(pn==='/api/mcx-drivers')      return apiMcxDrivers(req,res,ps);
  if(pn==='/api/global')           return apiGlobal(req,res);
  if(pn==='/api/search')           return apiSearch(req,res,ps);
  if(pn==='/api/health')           return apiHealth(req,res);
  /* Angel One SmartAPI: daily login (redirect to Angel One and back), status, disconnect */
  if(pn==='/api/smartapi/status')  return send(res, angelStatus());
  if(pn==='/api/assistant-status') return send(res, { day: istDateKey(), mcx: MCX_STATUS, mcxNames: MCX_NAME, nifty: NIFTY_STATUS, angel: angelReady() });
  if(pn==='/api/smartapi/login') {
    if (!ANGEL.key) return err(res, 'Set SMARTAPI_API_KEY on Render first', 400);
    res.writeHead(302, { Location: angelLoginUrl(), 'Cache-Control': 'no-store' }); return res.end();
  }
  if(pn==='/api/smartapi/callback') {
    let to = '/?view=trades&angel=ok';
    try { await angelCallback(ps); } catch (e) { to = '/?view=trades&angel=' + encodeURIComponent(String(e.message || e).slice(0, 140)); }
    res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); return res.end();
  }
  if(pn==='/api/smartapi/logout') {
    if (req.method !== 'POST') return err(res, 'POST only', 405);
    await angelLogout(); return send(res, { ok: true, connected: false });
  }
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
  if(pn==='/api/momentum')         return apiMomentum(req,res,ps);
  if(pn.startsWith('/api/push/'))  return apiPush(req,res,pn);
  if(pn==='/api/screener-diag') return send(res, SV().LAST_SCAN_DIAG);
  if(pn==='/api/sector-map') {
    const map = {}; Object.entries(LIVE_UNIVERSE?.industry || {}).forEach(([k, v]) => { if (v.sector) map[k] = v.sector; });
    return send(res, { count: Object.keys(map).length, source: LIVE_UNIVERSE?.source || null, map });
  }
  if(pn==='/api/universe') {
    if (ps.get('refresh') === '1') { refreshUniverse(true); return send(res, { ...universeSummary(), refreshing:true, rows:LIVE_UNIVERSE?.rows || [] }); }
    return send(res, { ...universeSummary(), refreshing: !!UNIVERSE_INFLIGHT, rows: liveUniverseUsable() ? LIVE_UNIVERSE.rows : [] });
  }
  if (req.method === 'GET' && pn === '/css/bundle.css') return pageBundle(req, res, 'css');
  if (req.method === 'GET' && pn === '/js/bundle.js') return pageBundle(req, res, 'js');
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
