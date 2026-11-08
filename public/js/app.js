const SWING_MIN_RR = 1.25;
const SWING_STRONG_RR = 1.50;

const TD_ICON_DATA_URI = '/icon-192.png';   /* was a 40 KB base64 copy of this file */

/* ════════════════════════════════════════════════════════
   TradeDesk v1.0 — Live Edition
   All data fetched from /api/* endpoints (server-side fetch)
   No CORS issues, real Yahoo Finance + Google News data
════════════════════════════════════════════════════════ */

/* Detect if running locally or on server */
const API = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? '' /* same origin */
  : ''; /* same origin on Render too */

const POPULAR=[]; /* Popular stocks removed: use search only */
const NSE_INDEX_CODES = new Set(['NIFTY','BANKNIFTY','NIFTYNXT50','FINNIFTY','NIFTYIT','NIFTYAUTO','NIFTYPHARMA','NIFTYFMCG','NIFTYMETAL','NIFTYREALTY','NIFTYMEDIA','NIFTYPSUBANK','NIFTYPVTBANK','NIFTYENERGY','NIFTYOILGAS','NIFTYHEALTH','NIFTYINFRA']);

let CUR_SYM=null, CUR_DATA=null, DATA_CACHE={}, AI_CACHE={};
let LOAD_SEQ = 0;
const DATA_CACHE_TTL = 60 * 1000;       /* fast back-switch cache */
const SECONDARY_CACHE_TTL = 15 * 60 * 1000; /* news/strategy-style data */

/* Fix: cache TTL — clear periodically to prevent unbounded growth */
setInterval(() => { DATA_CACHE = {}; AI_CACHE = {}; }, 15 * 60 * 1000);

/* Clear any stale news cache from previous RSS-based implementation */
Object.keys(AI_CACHE).filter(k => k.startsWith('news_')).forEach(k => delete AI_CACHE[k]);

/* Global stock name map — used by search, screener, doSearch */
const CLIENT_NAMES = {
  'NIFTY':'Nifty 50','BANKNIFTY':'Bank Nifty','NIFTYNXT50':'Nifty Next 50',
  'FINNIFTY':'Nifty Financial Services',
  'NIFTYIT':'Nifty IT','NIFTYAUTO':'Nifty Auto','NIFTYPHARMA':'Nifty Pharma','NIFTYFMCG':'Nifty FMCG',
  'NIFTYMETAL':'Nifty Metal','NIFTYREALTY':'Nifty Realty','NIFTYMEDIA':'Nifty Media','NIFTYPSUBANK':'Nifty PSU Bank',
  'NIFTYPVTBANK':'Nifty Private Bank','NIFTYENERGY':'Nifty Energy','NIFTYOILGAS':'Nifty Oil & Gas',
  'NIFTYHEALTH':'Nifty Healthcare','NIFTYINFRA':'Nifty Infrastructure',
  'TCS':'Tata Consultancy Services','INFY':'Infosys','WIPRO':'Wipro',
  'HCLTECH':'HCL Technologies','TECHM':'Tech Mahindra','LTIM':'LTIMindtree',
  'HDFCBANK':'HDFC Bank','ICICIBANK':'ICICI Bank','SBIN':'State Bank of India',
  'KOTAKBANK':'Kotak Mahindra Bank','AXISBANK':'Axis Bank',
  'RELIANCE':'Reliance Industries','LT':'Larsen & Toubro',
  'BAJFINANCE':'Bajaj Finance','BAJAJFINSV':'Bajaj Finserv',
  'MARUTI':'Maruti Suzuki','TATAMOTORS':'Tata Motors',
  'M&M':'Mahindra & Mahindra','BAJAJ-AUTO':'Bajaj Auto',
  'HEROMOTOCO':'Hero MotoCorp','EICHERMOT':'Eicher Motors',
  'TVSMOTOR':'TVS Motor','ASHOKLEY':'Ashok Leyland',
  'SUNPHARMA':'Sun Pharmaceutical','DRREDDY':"Dr Reddy's",
  'CIPLA':'Cipla','DIVISLAB':"Divi's Labs",'LUPIN':'Lupin',
  'HINDUNILVR':'Hindustan Unilever','ITC':'ITC Limited',
  'NESTLEIND':'Nestle India','BRITANNIA':'Britannia',
  'TITAN':'Titan Company','ASIANPAINT':'Asian Paints',
  'ULTRACEMCO':'UltraTech Cement','GRASIM':'Grasim Industries',
  'TATASTEEL':'Tata Steel','JSWSTEEL':'JSW Steel',
  'HINDALCO':'Hindalco','VEDL':'Vedanta','SAIL':'SAIL',
  'NTPC':'NTPC','POWERGRID':'Power Grid Corp',
  'ONGC':'ONGC','BPCL':'Bharat Petroleum','IOC':'Indian Oil',
  'BHARTIARTL':'Bharti Airtel','INDUSINDBK':'IndusInd Bank',
  'ADANIENT':'Adani Enterprises','ADANIPORTS':'Adani Ports',
  'ZOMATO':'Zomato','IRCTC':'IRCTC','DMART':'DMart','TRENT':'Trent',
  'DIXON':'Dixon Technologies','POLYCAB':'Polycab','HAVELLS':'Havells',
  'HAL':'Hindustan Aeronautics','BEL':'Bharat Electronics',
  'IRFC':'IRFC','PFC':'Power Finance Corp','RECLTD':'REC Limited',
  'COALINDIA':'Coal India','AMBUJACEM':'Ambuja Cements',
  'APOLLOHOSP':'Apollo Hospitals','SBILIFE':'SBI Life',
  'HDFCLIFE':'HDFC Life','SHRIRAMFIN':'Shriram Finance',
  'CHOLAFIN':'Cholamandalam','MUTHOOTFIN':'Muthoot Finance',
  'FEDERALBNK':'Federal Bank','BANKBARODA':'Bank of Baroda',
  'PIDILITIND':'Pidilite Industries',
  'COLPAL':'Colgate-Palmolive',
  'TATACONSUM':'Tata Consumer','DABUR':'Dabur','MARICO':'Marico',
  'GODREJCP':'Godrej Consumer','OFSS':'Oracle Financial',
  'COFORGE':'Coforge','PERSISTENT':'Persistent Systems','MPHASIS':'Mphasis',
  'KPITTECH':'KPIT Technologies','NAUKRI':'Info Edge (Naukri)',
  'DLF':'DLF','GODREJPROP':'Godrej Properties','OBEROIRLTY':'Oberoi Realty',
  'INDIGO':'IndiGo','SBICARD':'SBI Cards','HDFCAMC':'HDFC AMC',
  'ANGELONE':'Angel One','MCX':'MCX India','BSE':'BSE Limited',
  'CDSL':'CDSL','CAMS':'CAMS','SIEMENS':'Siemens India',
  'ABB':'ABB India','KEI':'KEI Industries','TATAPOWER':'Tata Power',
  'ADANIGREEN':'Adani Green','SUZLON':'Suzlon Energy',
};

const isFiniteNum=v=>Number.isFinite(Number(v));
const fmt=(n,d=2)=>!isFiniteNum(n)?'--':Number(n).toLocaleString('en-IN',{minimumFractionDigits:d,maximumFractionDigits:d});
const fmtVol=v=>{const n=Number(v);return !Number.isFinite(n)||n<=0?'--':n>=1e7?(n/1e7).toFixed(2)+' Cr':n>=1e5?(n/1e5).toFixed(2)+' L':n.toLocaleString('en-IN');};
const timeAgo=s=>{
  if(!s)return'';
  const t = typeof s === 'number' ? s : new Date(s).getTime();
  if(!Number.isFinite(t)) return String(s);
  const m=Math.max(0,Math.floor((Date.now()-t)/60000));
  if(m<1)return'just now';
  if(m<60)return`${m}m ago`;
  const h=Math.floor(m/60);
  if(h<48)return`${h}h ago`;
  return`${Math.floor(h/24)}d ago`;
};
const show=(id,v)=>{const el=document.getElementById(id);if(el)el.style.display=v;};
const R2=n=>{ const x=Number(n); return Number.isFinite(x)?+x.toFixed(2):null; };

/* ── SAFE HTML / URL HELPERS ── */
/* Render-sequence guard for #tc. Every top-level render bumps the sequence; async renderers capture it
   and skip their write if a newer render started meanwhile (stale renders used to overwrite the page). */
let TC_RENDER_SEQ = 0;
function tcBeginRender(){ const tok = ++TC_RENDER_SEQ; return () => tok === TC_RENDER_SEQ; }
function tcGuard(){ const tok = TC_RENDER_SEQ; return () => tok === TC_RENDER_SEQ; }
/* Safe literal for an inline onclick="fn(${jsArg(x)})" handler: JSON-quoted, then HTML-escaped. */
function jsArg(v){ return escHtml(JSON.stringify(v == null ? '' : v)); }
let OPT_REQ_SEQ = 0;
/* Sidebar quote: neutral price + green/red change. The whole line used to be one forced teal colour,
   so falling instruments showed in green. */
function setSidebarQuote(el, priceTxt, pct){
  if(!el) return;
  const p = Number(pct), up = p >= 0;
  el.innerHTML = `<span class="q-px">${escHtml(priceTxt)}</span><span class="q-chg ${Number.isFinite(p) ? (up ? 'q-up' : 'q-dn') : ''}">${Number.isFinite(p) ? `${up?'▲':'▼'}${Math.abs(p).toFixed(2)}%` : '--'}</span>`;
  el.style.color = '';
}
function escHtml(v){
  return String(v ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}
function safeUrl(v){
  try{
    const u = new URL(String(v || '#'), location.origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '#';
  }catch{ return '#'; }
}

/* ── FETCH FROM BACKEND ── */
async function apiFetch(path, timeoutMs=15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(API + path, { signal: controller.signal, credentials:'same-origin', cache:'no-store' });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`API error ${r.status} for ${path}`);
    return r.json();
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`Request timed out (${timeoutMs/1000}s) — check server or internet connection`);
    throw e;
  }
}


/* ── PERSONAL DATA SYNC (server /api/store) ──
   Alerts, Track Record, calculator settings, recent stocks and MCX calibrations follow you between devices.
   Every change to one of those keys is time-stamped; the newest copy wins, here or on the server. If the
   server's disk was reset, this browser uploads its copy again. */
const SYNC_KEY_RE = /^(td_alerts|tradedesk_forward_test_v2|td_pos_capital|td_pos_risk_pct|td_mom_capital|td_recent_stocks|td_mcx_cal2_[A-Z0-9:_-]{1,40})$/;
const SYNC_META_KEY = 'td_sync_meta';
let SYNC_APPLYING = false, SYNC_TIMER = null, SYNC_INFLIGHT = null, SYNC_STATE = { ok:null, at:null, msg:'' };
function syncMeta(){ try { return JSON.parse(localStorage.getItem(SYNC_META_KEY) || '{}') || {}; } catch { return {}; } }
function saveSyncMeta(m){ try { localStorage.setItem(SYNC_META_KEY, JSON.stringify(m)); } catch {} }
(function patchStorageForSync(){
  const P = Storage.prototype;
  if (P.setItem.__tdSync) return;
  const setI = P.setItem, remI = P.removeItem;
  const mark = k => {
    if (SYNC_APPLYING) return;
    const m = syncMeta(); m[k] = { t: +(m[k]?.t ?? m[k]) || 0, dirty: true }; saveSyncMeta(m);
    clearTimeout(SYNC_TIMER); SYNC_TIMER = setTimeout(() => syncNow().catch(() => {}), 2000);
  };
  P.setItem = function(k, v){ setI.call(this, k, v); try { if (this === window.localStorage && SYNC_KEY_RE.test(k)) mark(k); } catch {} };
  P.removeItem = function(k){ remI.call(this, k); try { if (this === window.localStorage && SYNC_KEY_RE.test(k)) mark(k); } catch {} };
  P.setItem.__tdSync = true;
})();
function syncLocalKeys(){ const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (SYNC_KEY_RE.test(k)) out.push(k); } } catch {} return out; }
/* meta[k] = { t: server time of the copy this device has, dirty: changed here and not sent yet } */
async function syncNow(){
  if (SYNC_INFLIGHT) return SYNC_INFLIGHT;
  SYNC_INFLIGHT = (async () => {
    try {
      const sk = (await apiFetch('/api/store', 15000)).keys || {};
      const meta = syncMeta(), push = {}, applied = [];
      const M = k => (meta[k] && typeof meta[k] === 'object') ? meta[k] : { t: +meta[k] || 0, dirty: false };
      for (const [k, x] of Object.entries(sk)) {   /* newer copies from other devices / the server alert engine */
        if (!SYNC_KEY_RE.test(k) || M(k).dirty || !(+x.t > M(k).t)) continue;
        SYNC_APPLYING = true;
        try { if (x.v == null) localStorage.removeItem(k); else localStorage.setItem(k, x.v); } finally { SYNC_APPLYING = false; }
        meta[k] = { t: +x.t, dirty: false }; applied.push(k);
      }
      for (const k of syncLocalKeys()) {   /* changes made here, or data the server lost (disk reset) */
        if (M(k).dirty || !sk[k]) push[k] = { v: localStorage.getItem(k) };
      }
      for (const k of Object.keys(meta)) {   /* deletions made here */
        if (SYNC_KEY_RE.test(k) && M(k).dirty && localStorage.getItem(k) == null && sk[k]) push[k] = { v: null };
      }
      if (Object.keys(push).length) {
        const r = await fetch(API + '/api/store', { method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ keys: push }) });
        if (!r.ok) throw new Error('save failed (' + r.status + ')');
        const saved = (await r.json()).keys || {};
        /* Re-read: a change made while this request was in flight stays "dirty" and goes out next time. */
        const cur = syncMeta();
        Object.keys(push).forEach(k => { if (localStorage.getItem(k) === push[k].v) cur[k] = { t: +saved[k]?.t || Date.now(), dirty: false }; });
        applied.forEach(k => { cur[k] = meta[k]; });
        saveSyncMeta(cur);
      } else {
        const cur = syncMeta(); applied.forEach(k => { cur[k] = meta[k]; }); saveSyncMeta(cur);
      }
      if (applied.includes('td_alerts') && typeof loadAlerts === 'function') {
        ALERTS = loadAlerts(); startAlertEngine();
        if (document.getElementById('td-alert-pop')) renderAlertPopup();
      }
      SYNC_STATE = { ok:true, at:Date.now(), msg:`${applied.length ? applied.length + ' updated from server' : 'up to date'}${Object.keys(push).length ? ` · ${Object.keys(push).length} sent` : ''}` };
    } catch (e) { SYNC_STATE = { ok:false, at:Date.now(), msg:e.message }; }
    finally { SYNC_INFLIGHT = null; document.querySelectorAll('[data-sync-status]').forEach(el => { el.innerHTML = syncStatusText(); }); }
  })();
  return SYNC_INFLIGHT;
}
function syncStatusText(){
  if (SYNC_STATE.ok == null) return 'Syncing…';
  const t = new Date(SYNC_STATE.at).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' });
  return SYNC_STATE.ok ? `<span style="color:var(--bull)">Synced ${t}</span> · ${escHtml(SYNC_STATE.msg)}` : `<span style="color:var(--bear)">Sync failed ${t}</span> · ${escHtml(SYNC_STATE.msg)} - data is still saved in this browser`;
}
function exportBackup(){
  const keys = {}; syncLocalKeys().forEach(k => { keys[k] = localStorage.getItem(k); });
  const blob = new Blob([JSON.stringify({ app:'TradeDesk', exportedAt:new Date().toISOString(), keys }, null, 1)], { type:'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `tradedesk-backup-${istDateKey()}.json`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function importBackup(input){
  const f = input?.files?.[0]; if (!f) return;
  f.text().then(txt => {
    const j = JSON.parse(txt); let n = 0;
    Object.entries(j.keys || {}).forEach(([k, v]) => { if (SYNC_KEY_RE.test(k) && typeof v === 'string') { localStorage.setItem(k, v); n++; } });
    ALERTS = loadAlerts(); startAlertEngine();
    showToast('Backup restored', `${n} item${n === 1 ? '' : 's'} restored and synced.`, 'bull');
    syncNow();
  }).catch(e => showToast('Import failed', e.message, 'bear')).finally(() => { input.value = ''; });
}
function dataPanelHtml(){
  return `<div class="td-data-panel"><div><b>Your data</b> (alerts, Track Record, calculator, recent stocks) · <span data-sync-status>${syncStatusText()}</span></div>
    <div class="td-data-btns"><button class="anl-btn" onclick="syncNow()">Sync now</button><button class="anl-btn" onclick="exportBackup()">Export backup</button>
    <label class="anl-btn" style="cursor:pointer">Import backup<input type="file" accept="application/json,.json" style="display:none" onchange="importBackup(this)"></label></div></div>`;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncNow().catch(() => {}); });
setInterval(() => { if (!document.hidden) syncNow().catch(() => {}); }, 120000);
setTimeout(() => syncNow().catch(() => {}), 1500);

/* ── DAILY LOCAL YAHOO CACHE ──
   Used only for scan/dashboard endpoints where same-day reuse is acceptable.
   Do NOT use for selected stock quote/analysis/news because those need intraday freshness. */
const DAILY_LOCAL_CACHE_VERSION = 'v1_9_swing_logic_aligned';
const DAILY_LOCAL_CACHE_NAMES = ['ready_watch_screener_v15'];
const DEPRECATED_DAILY_LOCAL_CACHE_NAMES = ['global_markets','sector_heatmap','crypto_prices','crypto_pulse','qualified_screener_v11','my_trade_screener_v1','my_trade_screener_v2','ready_watch_screener_v2','ready_watch_screener_v3','ready_watch_screener_v5','ready_watch_screener_v7','ready_watch_screener_v8','ready_watch_screener_v9','ready_watch_screener_v10','ready_watch_screener_v11','ready_watch_screener_v12','stock_of_week'];
/* These used to be cached for the full day, which made live values stale. Clear them once and keep daily cache only for heavy screener data. */
try { DEPRECATED_DAILY_LOCAL_CACHE_NAMES.forEach(n => localStorage.removeItem(dailyCacheKey(n))); } catch {}

function todayKeyPart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function indiaMarketMinutesNow(){
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:false, weekday:'short'}).formatToParts(new Date());
    const get = t => parts.find(p => p.type === t)?.value || '';
    const wd = get('weekday');
    if(['Sat','Sun'].includes(wd)) return null;
    return Number(get('hour')) * 60 + Number(get('minute'));
  } catch { return null; }
}
function isIndiaMarketHoursNow(){
  const m = indiaMarketMinutesNow();
  return Number.isFinite(m) && m >= 9*60+15 && m <= 15*60+45;
}
function getScreenerUiTtlMs(){
  return isIndiaMarketHoursNow() ? 30 * 60 * 1000 : 24 * 60 * 60 * 1000;
}

function dailyCacheKey(name) {
  return `${DAILY_LOCAL_CACHE_VERSION}_${name}_${todayKeyPart()}`;
}

function readDailyLocalCache(name) {
  try {
    const raw = localStorage.getItem(dailyCacheKey(name));
    if (!raw) return null;
    const payload = JSON.parse(raw);
    if (!payload || !payload.data || !payload.savedAt) return null;
    if (String(name).includes('screener') && Date.now() - Number(payload.savedAt) > getScreenerUiTtlMs()) return null;
    return {...payload.data, localCacheSavedAt: payload.savedAt, localCacheTtlMs: getScreenerUiTtlMs()};
  } catch { return null; }
}

function saveDailyLocalCache(name, data) {
  try {
    /* Keep only today's supported cache keys. Prevents mobile localStorage bloat. */
    const keep = new Set(DAILY_LOCAL_CACHE_NAMES.map(n => dailyCacheKey(n)));
    Object.keys(localStorage).forEach(k => {
      if ((k.startsWith('v9_') || k.startsWith('v1_') || k.startsWith(DAILY_LOCAL_CACHE_VERSION)) &&
          (k.includes('screener') || k.includes('global') || k.includes('sector') || k.includes('crypto'))) {
        if (!keep.has(k)) localStorage.removeItem(k);
      }
    });
    localStorage.setItem(dailyCacheKey(name), JSON.stringify({ savedAt: Date.now(), data }));
  } catch {}
}

function clearDailyLocalCache(name=null) {
  try {
    if (name) localStorage.removeItem(dailyCacheKey(name));
    else Object.keys(localStorage).forEach(k => {
      if (k.startsWith(DAILY_LOCAL_CACHE_VERSION) ||
          ((k.startsWith('v9_') || k.startsWith('v1_')) && (k.includes('qualified') || k.includes('screener')))) localStorage.removeItem(k);
    });
  } catch {}
}

async function apiFetchDailyCached(cacheName, path, timeoutMs=20000, opts={}) {
  if (!opts.force) {
    const local = readDailyLocalCache(cacheName);
    if (local) return { ...local, _localDailyCache:true };
  }
  const data = await apiFetch(path, timeoutMs);
  saveDailyLocalCache(cacheName, data);
  return { ...data, _localDailyCache:false };
}

/* ── LIVE QUOTE ── */
async function fetchLiveQuote(sym) {
  /* No force=1: the server's short cache is shared by every tab and protects Yahoo from repeat calls. */
  /* 30 s: the server allows its history fetches 20 s in the polite Yahoo queue (cold start). */
  return apiFetch(`/api/quote?sym=${encodeURIComponent(sym)}&_=${Date.now()}`, 30000);
}

/* ── LIVE QUICK PRICE ── */
async function fetchQuickPrice(sym) {
  return apiFetch(`/api/quickprice?sym=${encodeURIComponent(sym)}&_=${Date.now()}`);
}

/* ── LIVE NEWS ── */
/* ── LIVE NEWS — fetched via server RSS/Yahoo/optional Marketaux fallback ── */
async function fetchLiveNews(sym, name) {
  return apiFetch(`/api/news?sym=${encodeURIComponent(sym)}&name=${encodeURIComponent(name)}`);
}

/* Google News puts the headline (plus the source) in the description, so the card printed it twice. */
function newsDescRepeatsTitle(i){
  const n = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const t = n(i.title).split(' ').slice(0, 10).join(' '), d = n(i.desc);
  return !!t && d.startsWith(t);
}
/* ── INDIA VIX ── */
async function fetchVIX() {
  try { return (await apiFetch('/api/vix')).vix; } catch { return null; }
}

/* ── GLOBAL MARKETS ── */
let GLOBAL_DATA = null; /* cached for options IV auto-fill */
let SECTOR_DATA_PROMISE = null;

async function ensureSectorData(force=false) {
  if (!force && GLOBAL_DATA?.sectors?.length) return GLOBAL_DATA.sectors;
  if (SECTOR_DATA_PROMISE) return SECTOR_DATA_PROMISE;
  SECTOR_DATA_PROMISE = apiFetch('/api/sectors', 15000)
    .then(d => {
      const sectors = (d.sectors || []).filter(s => Number.isFinite(+s.pct));
      const sectorsNoData = (d.sectors || []).filter(s => !Number.isFinite(+s.pct));
      GLOBAL_DATA = { ...(GLOBAL_DATA || {}), sectors, sectorsNoData, sectorsPartial: !!(d.partial || d.refreshing), sectorUpdatedAt: d.updatedAt || new Date().toISOString() };
      /* Some sectors were still loading on the server: fetch again shortly and refresh the sector page if open. */
      if (d.partial || d.refreshing) setTimeout(() => {
        ensureSectorData(true).then(() => { if (document.querySelector('#tc [data-sectors-page]')) tabSectors(); }).catch(() => {});
      }, d.partial ? 4000 : 8000);
      return sectors;
    })
    .catch(() => {
      GLOBAL_DATA = { ...(GLOBAL_DATA || {}), sectors: GLOBAL_DATA?.sectors || [] };
      return GLOBAL_DATA.sectors || [];
    })
    .finally(() => { SECTOR_DATA_PROMISE = null; });
  return SECTOR_DATA_PROMISE;
}

let MARKET_CONTEXT_PROMISE = null;
async function preloadMarketContext(force=false) {
  /* Fresh Entry Score uses both breadth from /api/global and sector performance from /api/sectors.
     Preload both in the background and before Overview/Decision rendering, so opening the
     Market/Sector tab manually is no longer required for market score context. */
  if (!force && MARKET_CONTEXT_PROMISE) return MARKET_CONTEXT_PROMISE;
  MARKET_CONTEXT_PROMISE = Promise.allSettled([
    loadGlobalBar(),
    ensureSectorData(force)
  ]).finally(() => { MARKET_CONTEXT_PROMISE = null; });
  return MARKET_CONTEXT_PROMISE;
}

function gFmt(v, d=2) { return v==null ? '--' : (+v).toLocaleString('en-IN',{minimumFractionDigits:d,maximumFractionDigits:d}); }

function setGi(idPrice, idChg, item, decimals=2) {
  if (!item || item.error) return;
  const pe = document.getElementById(idPrice);
  const ce = document.getElementById(idChg);
  if (pe) pe.textContent = gFmt(item.price, decimals);
  if (ce) {
    const sign = item.isUp ? '▲' : '▼';
    ce.textContent = `${sign}${Math.abs(item.pct).toFixed(2)}%`;
    ce.className = 'gi-chg ' + (item.isUp ? 'gi-up' : 'gi-dn');
  }
}

function globalPct(item) {
  if (!item || item.error) return null;
  const pct = Number(item.pct);
  return Number.isFinite(pct) ? pct : null;
}

function computeGlobalBiasVerdict(d) {
  if (!d) return {label:'WAIT', cls:'neutral', score:0, note:'No global data'};
  let score = 0;
  const reasons = [];
  const add = (name, item, weight=1) => {
    const pct = globalPct(item);
    if (pct == null) return;
    if (pct >= 0.25) { score += weight; reasons.push(`${name} +${pct.toFixed(2)}%`); }
    else if (pct <= -0.25) { score -= weight; reasons.push(`${name} ${pct.toFixed(2)}%`); }
  };

  add('S&P', d.sp500, 1);
  add('Nasdaq', d.nasdaq, 1);
  add('Dow', d.dow, 0.5);
  add('Nikkei', d.nikkei, 1);
  add('Hang Seng', d.hangseng, 1);

  const vix = d.vix?.price != null ? Number(d.vix.price) : null;
  const vixPct = globalPct(d.vix);
  if (vix != null && Number.isFinite(vix)) {
    if (vix < 15) { score += 0.75; reasons.push(`VIX ${vix.toFixed(1)} calm`); }
    else if (vix > 20) { score -= 1; reasons.push(`VIX ${vix.toFixed(1)} high`); }
  }
  if (vixPct != null) {
    if (vixPct <= -3) score += 0.5;
    else if (vixPct >= 3) score -= 0.5;
  }

  if (score >= 2.5) return {label:'BULL', cls:'bull', score, note:reasons.slice(0,3).join(' · ') || 'Global risk-on'};
  if (score <= -2.5) return {label:'BEAR', cls:'bear', score, note:reasons.slice(0,3).join(' · ') || 'Global risk-off'};
  return {label:'NEUTRAL', cls:'neutral', score, note:reasons.slice(0,3).join(' · ') || 'Mixed global cues'};
}

function setGlobalBiasRow(d) {
  const el = document.getElementById('g-gift-v');
  if (!el) return;
  const v = computeGlobalBiasVerdict(d);
  const col = v.cls === 'bull' ? 'var(--bull)' : v.cls === 'bear' ? 'var(--bear)' : 'var(--neu)';
  el.innerHTML = `<div style="font-weight:800;color:${col}">${v.label}</div><div style="font-size:.72rem;color:${col}">Score ${v.score.toFixed(1)}</div>`;
  el.title = v.note;
}

async function loadGlobalBar() {
  try {
    const d = await apiFetch('/api/global', 40000);
    const existingSectors = GLOBAL_DATA?.sectors;
    GLOBAL_DATA = existingSectors?.length ? { ...d, sectors: existingSectors } : d;
    /* Some prices were still queued on the server (cold start, or another page loading): fetch again in 35 s
       (up to 3 times) and redraw the Market page, or an options idea that was waiting for India VIX. */
    if (!d.partial?.length) loadGlobalBar._tries = 0;
    else if (!loadGlobalBar._retry && (loadGlobalBar._tries || 0) < 3) loadGlobalBar._retry = setTimeout(() => {
      loadGlobalBar._retry = null; loadGlobalBar._tries = (loadGlobalBar._tries || 0) + 1;
      loadGlobalBar().then(() => {
        if (document.querySelector('#tc .td-market-compact') && window.renderCompactMarketDashboardV19) window.renderCompactMarketDashboardV19();
        else if (+GLOBAL_DATA?.vix?.price > 0 && document.querySelector('#tc [data-idx-idea-wait]')) renderTab(activeTabName());
      }).catch(() => {});
    }, 35000);

    /* Helper: populate a vertical market list row */
    function setMktRow(vidEl, item, decimals=2) {
      const el = document.getElementById(vidEl);
      if (!el || !item || item.error) return;
      const col = item.isUp ? 'var(--bull)' : 'var(--bear)';
      const sign = item.isUp ? '▲' : '▼';
      el.innerHTML = `<div style="font-weight:700;font-variant-numeric:tabular-nums">${(+item.price).toLocaleString('en-IN',{minimumFractionDigits:decimals,maximumFractionDigits:decimals})}</div><div style="font-size:.75rem;color:${col}">${sign}${vidEl==='g-us10y-v' && Number.isFinite(+item.chg) ? Math.abs(+item.chg*100).toFixed(0)+' bp' : Math.abs(item.pct).toFixed(2)+'%'}</div>`; /* yields move in basis points, not % */
    }

    setGlobalBiasRow(d);
    setMktRow('g-nasdaq-v',   d.nasdaq,    0);
    setMktRow('g-sp500-v',    d.sp500,     0);
    setMktRow('g-dow-v',      d.dow,       0);
    setMktRow('g-nikkei-v',   d.nikkei,    0);
    setMktRow('g-hangseng-v', d.hangseng,  0);
    setMktRow('g-usdinr-v',   d.usdInr,    2);
    setMktRow('g-dxy-v',      d.dxy,       2);
    setMktRow('g-us10y-v',    d.us10y,     2);
    setMktRow('g-wti-v',      d.wti,       2);
    setMktRow('g-brent-v',    d.brent,     2);
    setMktRow('g-vix-v',      d.vix,       2);

    if (d.ivRank) {
      const el = document.getElementById('g-ivpct-v');
      if (el) {
        const col = d.ivRank.rank < 30 ? 'var(--bull)' : d.ivRank.rank > 70 ? 'var(--bear)' : 'var(--neu)';
        el.innerHTML = `<div style="font-weight:700;color:${col}">${d.ivRank.rank}%</div><div style="font-size:.75rem;color:${col}">${d.ivRank.signal==='cheap'?'BUY opts':d.ivRank.signal==='expensive'?'SELL opts':'Fair'}</div>`;
      }
    }

    if (d.breadth) {
      const el = document.getElementById('g-ad-v');
      if (el) {
        const col = d.breadth.adRatio > 1.2 ? 'var(--bull)' : d.breadth.adRatio < 0.8 ? 'var(--bear)' : 'var(--neu)';
        el.innerHTML = `<div style="font-weight:700;color:${col}">${d.breadth.advances}↑ ${d.breadth.declines}↓</div><div style="font-size:.75rem;color:${col}">${d.breadth.adRatio}:1</div>`;
      }
    }
    return GLOBAL_DATA;

  } catch(e) { console.warn('Global data load failed:', e.message); return GLOBAL_DATA; }
}

/* ── INDICATOR MATH ── */
function emaArr(d,p){if(d.length<p)return d.map(()=>null);const k=2/(p+1);let e=d.slice(0,p).reduce((a,b)=>a+b,0)/p;const o=new Array(p-1).fill(null);o.push(e);for(let i=p;i<d.length;i++){e=d[i]*k+e*(1-k);o.push(e);}return o;}
const emaLast=(d,p)=>{const a=emaArr(d,p);return a[a.length-1];};
const smaLast=(d,p)=>d.length<p?null:d.slice(-p).reduce((a,b)=>a+b,0)/p;
function calcRSI(C,p=14){if(C.length<p+2)return null;const d=C.slice(1).map((c,i)=>c-C[i]);let g=d.slice(0,p).reduce((a,b)=>a+Math.max(0,b),0)/p,l=d.slice(0,p).reduce((a,b)=>a+Math.max(0,-b),0)/p;for(let i=p;i<d.length;i++){g=(g*(p-1)+Math.max(0,d[i]))/p;l=(l*(p-1)+Math.max(0,-d[i]))/p;}if(g===0&&l===0)return 50;if(l===0)return 100;if(g===0)return 0;return 100-100/(1+g/l);}
function calcMACD(C){if(!Array.isArray(C)||C.length<35)return null;const e12=emaArr(C,12),e26=emaArr(C,26);const ml=e12.map((v,i)=>v!=null&&e26[i]!=null?v-e26[i]:null);const cl=ml.filter(v=>Number.isFinite(v));if(cl.length<9)return null;const sig=emaArr(cl,9).filter(v=>Number.isFinite(v));const macd=cl[cl.length-1],signal=sig[sig.length-1];if(![macd,signal].every(Number.isFinite))return null;return{macd,signal,hist:macd-signal};}
function calcBB(C,p=20){if(C.length<p)return null;const s=C.slice(-p),b=s.reduce((a,c)=>a+c,0)/p;const sd=Math.sqrt(s.reduce((a,c)=>a+(c-b)**2,0)/p);return{upper:R2(b+2*sd),basis:R2(b),lower:R2(b-2*sd)};}
function calcStoch(C,H,L,k=14,d=3){if(C.length<k)return null;const ks=[];for(let i=k-1;i<C.length;i++){const hh=Math.max(...H.slice(i-k+1,i+1)),ll=Math.min(...L.slice(i-k+1,i+1));ks.push(hh===ll?50:(C[i]-ll)/(hh-ll)*100);}return{k:ks[ks.length-1],d:ks.slice(-d).reduce((a,b)=>a+b,0)/Math.min(d,ks.length)};}
function calcCCI(C,H,L,p=20){if(C.length<p)return null;const tp=C.map((c,i)=>(H[i]+L[i]+c)/3),sl=tp.slice(-p);const sm=sl.reduce((a,b)=>a+b,0)/p,md=sl.reduce((a,b)=>a+Math.abs(b-sm),0)/p;return md===0?0:(tp[tp.length-1]-sm)/(0.015*md);}
function calcADX(C,H,L,p=14){if(C.length<p*2+2)return null;const trs=[],pdm=[],ndm=[];for(let i=1;i<C.length;i++){trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));const u=H[i]-H[i-1],dn=L[i-1]-L[i];pdm.push(u>dn&&u>0?u:0);ndm.push(dn>u&&dn>0?dn:0);}/* Wilder smoothing: init with average (not sum), each step adds a[i]/p not a[i] */function ws(a,p){let s=a.slice(0,p).reduce((x,y)=>x+y,0)/p;const r=[s];for(let i=p;i<a.length;i++){s=s-s/p+a[i]/p;r.push(s);}return r;}const atr=ws(trs,p),sp=ws(pdm,p),sn=ws(ndm,p);const pdi=sp.map((v,i)=>atr[i]?v/atr[i]*100:0),ndi=sn.map((v,i)=>atr[i]?v/atr[i]*100:0);const dx=pdi.map((v,i)=>{const s=v+ndi[i];return s?Math.abs(v-ndi[i])/s*100:0;});const adxA=ws(dx,p);const last=adxA.length-1,off=pdi.length-adxA.length;return last<0?null:{adx:adxA[last],pdi:pdi[last+off]||pdi[pdi.length-1],ndi:ndi[last+off]||ndi[ndi.length-1]};}
const calcMom=(C,p=10)=>C.length<p+1?null:C[C.length-1]-C[C.length-1-p];
const calcAO=(H,L)=>{if(H.length<34)return null;const mid=H.map((h,i)=>(h+L[i])/2);return mid.slice(-5).reduce((a,b)=>a+b,0)/5-mid.slice(-34).reduce((a,b)=>a+b,0)/34;};
function dateKeyFromUnixSec(ts, tz='Asia/Kolkata'){
  if(!ts)return'';
  try{
    return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(ts*1000));
  }catch{return'';}
}
function latestSessionStartIndex(T, tz='Asia/Kolkata'){
  if(!Array.isArray(T) || !T.length) return 0;
  const lastIdx = T.length-1;
  const key = dateKeyFromUnixSec(T[lastIdx], tz);
  if(!key) return 0;
  let start = lastIdx;
  while(start>0 && dateKeyFromUnixSec(T[start-1], tz) === key) start--;
  return start;
}
function calcVWAP(C,H,L,V,T){
  if(!Array.isArray(C)||C.length===0)return null;
  const start = latestSessionStartIndex(T || [], 'Asia/Kolkata');
  let pv=0,tv=0;
  for(let i=Math.max(0,start);i<C.length;i++){
    const c=Number(C[i]),h=Number(H?.[i]),l=Number(L?.[i]),v=Number(V?.[i])||0;
    if(![c,h,l].every(Number.isFinite)) continue;
    const tp=(h+l+c)/3; pv+=tp*v; tv+=v;
  }
  return tv>0?R2(pv/tv):null;
}
function calcSuperTrend(C,H,L,period=7,mult=3){
  if(!Array.isArray(C)||C.length<period+2)return null;
  const n=C.length;
  const tr=new Array(n).fill(null);
  for(let i=1;i<n;i++){
    tr[i]=Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1]));
  }
  const atr=new Array(n).fill(null);
  let sum=0;
  for(let i=1;i<=period;i++) sum += Number(tr[i]) || 0;
  atr[period]=sum/period;
  for(let i=period+1;i<n;i++) atr[i]=(atr[i-1]*(period-1)+(Number(tr[i])||0))/period;

  const basicU=new Array(n).fill(null), basicL=new Array(n).fill(null), finalU=new Array(n).fill(null), finalL=new Array(n).fill(null), st=new Array(n).fill(null), dir=new Array(n).fill(null);
  for(let i=period;i<n;i++){
    const mid=(H[i]+L[i])/2;
    basicU[i]=mid+mult*atr[i];
    basicL[i]=mid-mult*atr[i];
    if(i===period){
      finalU[i]=basicU[i]; finalL[i]=basicL[i];
      dir[i]=C[i] >= mid ? 1 : -1;
      st[i]=dir[i]===1 ? finalL[i] : finalU[i];
      continue;
    }
    finalU[i]=(basicU[i] < finalU[i-1] || C[i-1] > finalU[i-1]) ? basicU[i] : finalU[i-1];
    finalL[i]=(basicL[i] > finalL[i-1] || C[i-1] < finalL[i-1]) ? basicL[i] : finalL[i-1];
    if(st[i-1] === finalU[i-1]){
      if(C[i] <= finalU[i]){ st[i]=finalU[i]; dir[i]=-1; }
      else{ st[i]=finalL[i]; dir[i]=1; }
    }else{
      if(C[i] >= finalL[i]){ st[i]=finalL[i]; dir[i]=1; }
      else{ st[i]=finalU[i]; dir[i]=-1; }
    }
  }
  const last=n-1, stVal=st[last], d=dir[last];
  if(!Number.isFinite(stVal) || !d) return null;
  return{value:R2(stVal),dir:d,label:d===1?'Bullish':'Bearish'};
}

function calcRecommend({C,H,L}){
  let buy=0,sell=0,neu=0;const n=C.length,price=C[n-1];
  const add=v=>{if(v>0)buy++;else if(v<0)sell++;else neu++;};
  [[true,5],[true,10],[true,20],[true,50],[true,100],[true,200],[false,50],[false,200]].forEach(([isE,p])=>{const v=isE?emaLast(C,p):smaLast(C,p);add(v==null?0:price>v?1:price<v?-1:0);});
  const rsi=calcRSI(C);add(rsi==null?0:rsi<30?1:rsi>70?-1:rsi>50?1:-1);
  const st=calcStoch(C,H,L);add(st==null?0:st.k<20?1:st.k>80?-1:st.k>st.d?1:-1);
  const cci=calcCCI(C,H,L);add(cci==null?0:cci<-100?1:cci>100?-1:0);
  const macd=calcMACD(C);add(macd==null?0:macd.macd>macd.signal?1:-1);
  const bb=calcBB(C);add(bb==null?0:price<bb.lower?1:price>bb.upper?-1:0);
  const adx=calcADX(C,H,L);add(adx==null?0:adx.pdi>adx.ndi?1:adx.pdi<adx.ndi?-1:0);
  const ao=calcAO(H,L);add(ao==null?0:ao>0?1:-1);
  const total=buy+sell+neu;return{value:total?(buy-sell)/total:0,buy,sell,neu,total};
}

function istNowParts(){
  const parts = new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).formatToParts(new Date());
  const get=t=>parts.find(p=>p.type===t)?.value;
  return {date:`${get('year')}-${get('month')}-${get('day')}`, hour:+get('hour'), minute:+get('minute')};
}
function getConfirmedDailyIndex(d, sym=CUR_SYM){
  const C=d?.C||[], T=d?.T||[], n=C.length;
  if(n<3) return n-1;
  const lastDate = dateKeyFromUnixSec(T[n-1], 'Asia/Kolkata');
  const now = istNowParts();
  const mins = now.hour*60 + now.minute;
  /* MCX trades 09:00-23:55 IST: at 8 pm its bar is still forming (NSE hours treated it as completed). */
  const mcx = isMCXSymbol(sym);
  const marketOpen = mcx ? 9*60 : 9*60+15, marketSettled = mcx ? 23*60+55 : 15*60+35;
  const lastBarIsToday = lastDate && lastDate === now.date;
  return (lastBarIsToday && mins >= marketOpen && mins < marketSettled) ? n-2 : n-1;
}
function detectPatterns({C,O,H,L}, endIndex=null){
  const e = Number.isInteger(endIndex) ? endIndex : (C?.length||0)-1;
  if(!Array.isArray(C)||e<2)return[];
  const c=C[e],o=O[e],h=H[e],l=L[e],c1=C[e-1],o1=O[e-1],h1=H[e-1],l1=L[e-1],c2=C[e-2],o2=O[e-2];
  const body=Math.abs(c-o),range=h-l||1,upper=h-Math.max(o,c),lower=Math.min(o,c)-l,body1=Math.abs(c1-o1);
  const pats=[];
  if(body/range<0.1)pats.push({name:'Doji',s:'neutral',note:'Indecision — wait for breakout direction'});
  /* Same shapes, opposite meaning: the trend before the candle decides (hammer after a fall, hanging man after
     a rise). Candle colour is only the fallback when there are too few bars to judge the trend. */
  const priorDown = e >= 6 ? C[e-1] < C[e-6] : c > o, priorUp = e >= 6 ? C[e-1] > C[e-6] : c < o;
  const longLower = body>0&&lower>2*body&&upper<body, longUpper = body>0&&upper>2*body&&lower<body;
  if(longLower&&priorDown)pats.push({name:'Hammer',s:'bull',note:'Bullish reversal after a decline, on confirmed candle'});
  if(longUpper&&priorUp)pats.push({name:'Shooting Star',s:'bear',note:'Bearish reversal after a rise, on confirmed candle'});
  if(longUpper&&priorDown)pats.push({name:'Inverted Hammer',s:'bull',note:'Potential bullish reversal after a decline, on confirmed candle'});
  if(longLower&&priorUp)pats.push({name:'Hanging Man',s:'bear',note:'Bearish top reversal after a rise, on confirmed candle'});
  if(c>o&&body/range>0.7)pats.push({name:'Strong Bullish Candle',s:'bull',note:'Heavy buying pressure on confirmed candle'});
  if(o>c&&body/range>0.7)pats.push({name:'Strong Bearish Candle',s:'bear',note:'Heavy selling pressure on confirmed candle'});
  if(c1<o1&&c>o&&c>o1&&o<c1&&body>body1)pats.push({name:'Bullish Engulfing',s:'strong-bull',note:'High-reliability confirmed reversal'});
  if(c1>o1&&c<o&&c<o1&&o>c1&&body>body1)pats.push({name:'Bearish Engulfing',s:'strong-bear',note:'High-reliability confirmed reversal'});
  if(h<=h1&&l>=l1)pats.push({name:'Inside Bar',s:'neutral',note:'Confirmed consolidation — breakout pending'});
  if(c2<o2&&Math.abs(c1-o1)/((h1-l1)||1)<0.3&&c>o&&c>(o2+c2)/2)pats.push({name:'Morning Star',s:'strong-bull',note:'3-candle confirmed bullish reversal'});
  if(c2>o2&&Math.abs(c1-o1)/((h1-l1)||1)<0.3&&c<o&&c<(o2+c2)/2)pats.push({name:'Evening Star',s:'strong-bear',note:'3-candle confirmed bearish reversal'});
  return pats;
}

/* ── SIGNALS ── */
function sigRec(v){if(v==null)return{l:'N/A',c:'na'};if(v>=.5)return{l:'Strong Buy',c:'strong-bull'};if(v>=.1)return{l:'Buy',c:'bull'};if(v>-.1)return{l:'Neutral',c:'neutral'};if(v>-.5)return{l:'Sell',c:'bear'};return{l:'Strong Sell',c:'strong-bear'};}
function sigScore(c){return{['strong-bull']:2,bull:1,neutral:0,bear:-1,['strong-bear']:-2,na:0}[c]??0;}
function sigRSI(v){if(v==null)return{l:'N/A',c:'na',note:''};if(v>=80)return{l:'Extremely Overbought',c:'strong-bear',note:fmt(v,1)};if(v>=70)return{l:'Overbought',c:'bear',note:fmt(v,1)};if(v<=20)return{l:'Extremely Oversold',c:'strong-bull',note:fmt(v,1)};if(v<=30)return{l:'Oversold',c:'bull',note:fmt(v,1)};return v>50?{l:'Neutral+',c:'bull',note:fmt(v,1)}:{l:'Neutral−',c:'bear',note:fmt(v,1)};}
function sigMACD(m,s){if(m==null||s==null)return{l:'N/A',c:'na',note:''};const d=m-s;return d>0?{l:m>0?'Bullish':'Weak Bullish',c:m>0?'bull':'neutral',note:`Hist: ${d>0?'+':''}${fmt(d)}`}:{l:m<0?'Bearish':'Weak Bearish',c:m<0?'bear':'neutral',note:`Hist: ${fmt(d)}`};}
function sigBB(price,upper,lower,basis){
  if(price==null||upper==null||lower==null)return{l:'N/A',c:'na',note:''};
  const bw = Number.isFinite(basis)&&basis ? ((upper-lower)/basis*100) : null;
  const noteBW = bw==null ? '' : `BW: ${fmt(bw,1)}%`;
  const range = upper-lower;
  const p = range ? (price-lower)/range*100 : 50;
  /* Keep Bollinger interpretation consistent with calcRecommend():
     upper band = stretched/overbought risk, lower band = stretched/oversold opportunity. */
  if(price>upper)return{l:'Above Upper Band',c:'strong-bear',note:noteBW};
  if(price<lower)return{l:'Below Lower Band',c:'strong-bull',note:noteBW};
  if(p>=75)return{l:'Near Upper Band',c:'bear',note:`${fmt(p,0)}%`};
  if(p<=25)return{l:'Near Lower Band',c:'bull',note:`${fmt(p,0)}%`};
  return{l:'Middle of Bands',c:'neutral',note:`${fmt(p,0)}%`};
}
function sigADX(adx,p,n){if(adx==null)return{l:'N/A',c:'na',note:''};const t=adx>25?'Trending':'Ranging';const c=p>n?(adx>25?'bull':'neutral'):(adx>25?'bear':'neutral');return{l:`${t} (${p>n?'Bullish':'Bearish'})`,c,note:`ADX ${fmt(adx,1)} · +DI ${fmt(p,1)} · −DI ${fmt(n,1)}`};}
function sigVolume(tv,av,chg){if(!tv||!av)return{l:'N/A',c:'na',note:''};const r=tv/av,note=`${(r*100).toFixed(0)}% of avg`;if(chg>0&&r>1.2)return{l:'High Buying Volume',c:'bull',note};if(chg<0&&r>1.2)return{l:'High Selling Volume',c:'bear',note};if(r<0.7)return{l:'Low Volume',c:'neutral',note};return{l:'Average Volume',c:'neutral',note};}
function sigEMA(price,e20,e50,e200){
  const p=Number(price), above=[], below=[];
  if(!Number.isFinite(p)) return {l:'N/A',c:'na',note:'Price not available'};
  const add=(label,v)=>{const n=Number(v); if(Number.isFinite(n)){p>n?above.push(label):below.push(label);}};
  add('EMA20',e20); add('EMA50',e50); add('EMA200',e200);
  const total=above.length+below.length;
  if(!total) return {l:'N/A',c:'na',note:'EMA data not sufficient'};
  if(above.length===total)return{l:'Above All Key EMAs',c:'strong-bull',note:`↑ ${above.join(', ')}`};
  if(below.length===total)return{l:'Below All Key EMAs',c:'strong-bear',note:`↓ ${below.join(', ')}`};
  if(above.length>below.length)return{l:'Mostly Above EMAs',c:'bull',note:`↑ ${above.join(', ')} · ↓ ${below.join(', ')}`};
  return{l:'Mostly Below EMAs',c:'bear',note:`↓ ${below.join(', ')} · ↑ ${above.join(', ')}`};
}
function sigVWAP(price,vwap){if(!vwap)return{l:'N/A',c:'na',note:''};const d=((price-vwap)/vwap*100);if(d>1)return{l:'Above VWAP',c:'bull',note:`+${d.toFixed(2)}% · VWAP ${fmt(vwap)}`};if(d<-1)return{l:'Below VWAP',c:'bear',note:`${d.toFixed(2)}% · VWAP ${fmt(vwap)}`};return{l:'At VWAP',c:'neutral',note:`${d.toFixed(2)}% · VWAP ${fmt(vwap)}`};}
function sigST(st){if(!st)return{l:'N/A',c:'na',note:''};return st.dir===1?{l:'SuperTrend: Bullish',c:'bull',note:`ST: ${fmt(st.value)} (price above)`}:{l:'SuperTrend: Bearish',c:'bear',note:`ST: ${fmt(st.value)} (price below)`};}

/* ── HTML BUILDERS ── */
const bdg=({l,c})=>`<span class="bdg ${c}">${l}</span>`;
const secT=t=>`<div class="st">${t}</div>`;
const sRow=(lbl,sig,val='')=>`<div class="sr"><div class="srl"><div class="sll">${lbl}</div>${val?`<div class="slv">${val}</div>`:''}${sig.note?`<div class="sln">${sig.note}</div>`:''}</div>${bdg(sig)}</div>`;


/* ── OPTIONS DECISION HELPERS — shared by Index Decision tab and Strategy tab ── */
function makeOptionsQualityCore(suggestedStrategy, bCount, bearCount, rangeCount, ivRank, vix, expiryDays){
  const rows = [];
  const add = (name, pts, max, note) => rows.push({name, pts:Math.max(0,Math.min(max,Math.round(pts))), max, note});
  const strongest = Math.max(bCount||0, bearCount||0, rangeCount||0);
  const strongestType = strongest === rangeCount ? 'range' : strongest === bCount ? 'bullish' : strongest === bearCount ? 'bearish' : 'mixed';
  add('Market bias clarity', strongest>=3 ? 20 : strongest>=2 ? 14 : 8, 20,
    strongest>=3 ? `Clear ${strongestType} bias from index trend, breadth, VIX and IV context` : strongest>=2 ? 'Usable but not perfect bias' : 'Mixed bias; reduce size or avoid');
  const isPremiumSell = /condor|strangle|bear_call|bull_put/.test(suggestedStrategy||'');
  let ivPts = 8, ivNote = 'IV Percentile not loaded — neutral/low credit';
  if(ivRank != null){
    if(isPremiumSell){
      ivPts = ivRank>=70 ? 20 : ivRank>=50 ? 15 : ivRank>=30 ? 10 : 6;
      ivNote = `IV percentile ${ivRank}%: ${ivRank>=70?'good for premium selling':'not ideal for premium selling'}`;
    } else {
      ivPts = ivRank<=30 ? 20 : ivRank<=50 ? 15 : ivRank<=70 ? 10 : 6;
      ivNote = `IV percentile ${ivRank}%: ${ivRank<=30?'better for debit buying':'expensive for option buying'}`;
    }
  }
  add('IV condition', ivPts, 20, ivNote);
  add('OI / PCR support', 8, 20, 'Live option-chain OI/PCR not connected; score is capped here');
  const definedRisk = /spread|condor/.test(suggestedStrategy||'');
  add('Risk/reward payoff', definedRisk ? 18 : 11, 20, definedRisk ? 'Defined-risk strategy preferred' : 'Undefined/high gamma risk; use smaller size');
  const expPts = expiryDays>=10 && expiryDays<=45 ? 20 : expiryDays>=5 ? 12 : 5;
  add('Liquidity + expiry safety', expPts, 20, expiryDays<5 ? 'Expiry too close; gamma/theta risk high' : expiryDays>45 ? 'Far expiry; slower theta and wider spreads possible' : 'Expiry window acceptable');
  const score100 = rows.reduce((a,r)=>a+r.pts,0);
  const grade = score100>=80?'A+':score100>=70?'A':score100>=55?'B':score100>=40?'C':'Avoid';
  const col = score100>=70?'var(--bull)':score100>=55?'var(--neu)':'var(--bear)';
  const label = score100>=70?'Usable options setup':score100>=55?'Conditional options setup only':'Avoid / planning only';
  return {score100, grade, col, label, rows};
}

function buildIndexOptionsDecisionSnapshot(sym){
  const d = CUR_DATA?.daily || {}, C=d.C||[], H=d.H||[], L=d.L||[];
  const n = C.length, price = firstFiniteNumber(getCurrentLivePrice(), C[n-1]);
  const expiryDays = Math.max(1, Math.min(90, +OPT_STATE.expiry || 30));
  const vix = GLOBAL_DATA?.vix?.price ?? null;
  const ivRank = GLOBAL_DATA?.ivRank?.rank ?? null;
  const adRatio = GLOBAL_DATA?.breadth?.adRatio ?? null;
  if(!n || !Number.isFinite(price)){
    const optQ = makeOptionsQualityCore('iron_condor',0,0,1,ivRank,vix,expiryDays);
    return {bias:'NO DATA', cls:'neutral', col:'var(--neu)', suggested:'iron_condor', optQ, rows:[], price:null, vix, ivRank, adRatio, expiryDays};
  }
  const dr = sigRec(CUR_DATA.daily.rec.value);
  const wr = sigRec(CUR_DATA.weekly?.rec?.value ?? 0);
  const rsi = calcRSI(C), macd = calcMACD(C), st = calcSuperTrend(C,H,L);
  const e20=emaLast(C,20), e50=emaLast(C,50), e200=emaLast(C,200);
  let trendPts = 0;
  if(dr.c==='bull'||dr.c==='strong-bull') trendPts += 2; else if(dr.c==='bear'||dr.c==='strong-bear') trendPts -= 2;
  if(wr.c==='bull'||wr.c==='strong-bull') trendPts += 2; else if(wr.c==='bear'||wr.c==='strong-bear') trendPts -= 2;
  if(e20 && price > e20) trendPts += 1; else if(e20) trendPts -= 1;
  if(e50 && price > e50) trendPts += 1; else if(e50) trendPts -= 1;
  if(e200 && price > e200) trendPts += 1; else if(e200) trendPts -= 1;
  if(macd?.hist > 0) trendPts += 1; else if(macd?.hist < 0) trendPts -= 1;
  if(st?.dir === 1) trendPts += 1; else if(st?.dir === -1) trendPts -= 1;
  if(rsi >= 52 && rsi <= 68) trendPts += 1; else if(rsi <= 48 && rsi >= 32) trendPts -= 1;
  const trendBias = trendPts >= 4 ? 'bull' : trendPts <= -4 ? 'bear' : 'neutral';
  const adBias = !adRatio ? 'neutral' : adRatio > 1.5 ? 'bull' : adRatio < 0.7 ? 'bear' : 'neutral';
  const vixBias = vix == null ? 'neutral' : vix >= 20 ? 'range' : vix < 14 ? 'directional' : 'neutral';
  const ivBias = ivRank == null ? 'neutral' : ivRank > 70 ? 'range' : ivRank < 30 ? 'directional' : 'neutral';
  let bCount = 0, bearCount = 0, rangeCount = 0;
  if(trendBias==='bull') bCount += 2; else if(trendBias==='bear') bearCount += 2;
  if(adBias==='bull') bCount += 1; else if(adBias==='bear') bearCount += 1;
  if(vixBias==='range') rangeCount += 1;
  if(ivBias==='range') rangeCount += 1;
  if(ivBias==='directional' && trendBias==='bull') bCount += 1;
  if(ivBias==='directional' && trendBias==='bear') bearCount += 1;
  let suggested='iron_condor', bias='RANGE / WAIT', cls='neutral', col='var(--neu)', desc='Mixed index signals; prefer range strategy or wait for breakout confirmation.';
  if(rangeCount >= 2 && Math.abs(bCount-bearCount) <= 1){
    suggested='iron_condor'; bias='RANGE TRADE'; cls='neutral'; col='var(--neu)'; desc='High IV/VIX or mixed direction favours defined-risk range planning.';
  } else if(bCount > bearCount && bCount >= 2){
    suggested = ivBias==='range' ? 'bull_put_spread' : 'bull_call_spread'; bias='BULLISH INDEX BIAS'; cls='bull'; col='var(--bull)'; desc='Index trend/breadth lean bullish; use defined-risk bullish strategy only near clean levels.';
  } else if(bearCount > bCount && bearCount >= 2){
    suggested = ivBias==='range' ? 'bear_call_spread' : 'bear_put_spread'; bias='BEARISH INDEX BIAS'; cls='bear'; col='var(--bear)'; desc='Index trend/breadth lean bearish; use defined-risk bearish strategy only after confirmation.';
  }
  const optQ = makeOptionsQualityCore(suggested,bCount,bearCount,rangeCount,ivRank,vix,expiryDays);
  AI_CACHE[`optq_${sym}`] = {score100:optQ.score100, grade:optQ.grade, rows:optQ.rows, ts:Date.now(), source:'index-decision'};
  const rows = [
    {name:'Index directional bias', value:trendBias.toUpperCase(), note:`Trend score ${trendPts} · Daily ${dr.l} · Weekly ${wr.l}`},
    {name:'Market breadth', value:adRatio ? `${adRatio}:1` : 'No data', note:adBias==='bull'?'Breadth supports upside':adBias==='bear'?'Breadth is weak':'Breadth neutral / unavailable'},
    {name:'VIX condition', value:vix!=null ? fmt(vix,1) : 'No data', note:vixBias==='range'?'High VIX: prefer credit/range or reduce size':vixBias==='directional'?'Low VIX: debit strategies are less expensive':'Neutral VIX'},
    {name:'IV percentile', value:ivRank!=null ? `${ivRank}%` : 'No data', note:ivBias==='range'?'High IV: premium selling gets better credit':ivBias==='directional'?'Low IV: option buying is less expensive':'Neutral/unknown IV'},
    {name:'Suggested strategy', value:suggested.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase()), note:'Defined-risk planning; verify live option chain and broker margin before entry'}
  ];
  return {bias, cls, col, desc, suggested, optQ, rows, price, vix, ivRank, adRatio, expiryDays, trendBias, adBias, vixBias, ivBias, bCount, bearCount, rangeCount};
}

function renderIndexOptionsDecision(sym){
  const snap = buildIndexOptionsDecisionSnapshot(sym);
  const rows = snap.optQ.rows.map(r=>`<div class="tp-qrow"><div><strong>${r.name}</strong><span>${r.note}</span></div><b>${r.pts}/${r.max}</b></div>`).join('');
  const ctx = snap.rows.map(r=>`<div class="tp-qrow"><div><strong>${r.name}</strong><span>${r.note}</span></div><b>${r.value}</b></div>`).join('');
  const strategyName = snap.suggested.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
  return `<div class="aib"><strong style="color:var(--acc)">Index selected:</strong> Decision tab now uses the index-options engine, not stock swing scoring. Stock sector score, stock volume score and stock swing quality are not used here.</div>`+
    `<div class="tp-decision ${snap.cls==='bull'?'qualified':snap.cls==='bear'?'conditional':'conditional'}" style="border-color:${snap.col}">
      <div class="tp-decision-top"><div><div class="tp-decision-label">Index Options Decision</div><div class="tp-decision-main" style="color:${snap.col}">${snap.bias}</div></div><div class="tp-confidence"><div class="tp-conf-num">${snap.optQ.score100}</div><div class="tp-conf-lbl">Options Quality</div></div></div>
      <div class="tp-summary">${snap.desc}</div>
    </div>`+
    `<div class="tp-section" style="border-color:${snap.optQ.col}"><div class="tp-section-title">Options Strategy Quality Score</div>
      <div class="tp-score-head ${snap.optQ.score100>=70?'bull':snap.optQ.score100>=55?'neutral':'bear'}"><div><span class="tp-score-num">${snap.optQ.score100}</span><span class="tp-score-total">/100</span></div><div class="tp-grade" style="color:${snap.optQ.col}">${snap.optQ.grade}</div></div>
      <div class="tp-score-bar"><div style="width:${snap.optQ.score100}%;background:${snap.optQ.col}"></div></div>
      <div class="aib" style="margin-bottom:10px"><strong>${snap.optQ.label}</strong>. Suggested strategy: <strong style="color:${snap.col}">${strategyName}</strong>. OI/PCR is capped because live option chain is not connected.</div>
      <div class="tp-quality-list">${rows}</div>
    </div>`+
    `<div class="tp-section"><div class="tp-section-title">Index Options Inputs</div><div class="tp-quality-list">${ctx}</div></div>`+
    `<div class="aib"><strong style="color:var(--warn)">Execution warning:</strong> Before placing an index option trade, verify live option-chain OI, premium, bid/ask spread, margin, expiry day risk and max loss in your broker. This page is a decision filter, not broker-grade execution data.</div>`;
}

/* ── TRADE VALIDITY + GOLD PETAL HELPERS ── */
function getTradeValiditySnapshot(sym){
  const d = CUR_DATA?.daily || {}, C=d.C||[], H=d.H||[], L=d.L||[], V=d.V||[], O=d.O||[];
  const n=C.length, price=getCurrentLivePrice(), prev=firstFiniteNumber(CUR_DATA.pc,C[n-2],C[n-1],price);
  if(!n || !Number.isFinite(price)) return {score:0,label:'No Data',cls:'bear',checks:[],avoid:[]};
  const rsi=calcRSI(C), macdD=calcMACD(C), adxR=calcADX(C,H,L);
  const e20=emaLast(C,20), e50=emaLast(C,50), e200=emaLast(C,200);
  const st=calcSuperTrend(C,H,L);
  const sr=getSRTradeLevels();
  const volEnd = Math.max(0, Math.min(V.length, n) - 1);
  const volBase = V.slice(Math.max(0, volEnd - 20), volEnd);
  const avgVol=volBase.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase.length);
  const volToday=Number(V[n-1])||0;
  const volRatio=avgVol?volToday/avgVol:1;
  const ema20Ok=Number.isFinite(+e20) && +e20>0;
  const ema50Ok=Number.isFinite(+e50) && +e50>0;
  const ema200Ok=Number.isFinite(+e200) && +e200>0;
  const trendBull = Number.isFinite(+price) && ema50Ok && ema200Ok && price>e50 && e50>e200;
  const trendBear = Number.isFinite(+price) && ema50Ok && ema200Ok && price<e50 && e50<e200;
  const nearestResVal = Number(sr.nearestResistance?.v ?? sr.r1);
  const nearestSupVal = Number(sr.nearestSupport?.v ?? sr.s1);
  const r1Ok=Number.isFinite(+nearestResVal) && +nearestResVal>0;
  const s1Ok=Number.isFinite(+nearestSupVal) && +nearestSupVal>0;
  const nearRes = r1Ok && Math.abs(price-nearestResVal)/price*100 < 0.75;
  const nearSup = s1Ok && Math.abs(price-nearestSupVal)/price*100 < 0.75;
  const rrBull = r1Ok && s1Ok && price>nearestSupVal ? (nearestResVal-price)/(price-nearestSupVal) : 0;
  const rrBear = r1Ok && s1Ok && nearestResVal>price && nearestSupVal<price ? (price-nearestSupVal)/(nearestResVal-price) : 0;
  const checks=[];
  const add=(name,pass,pts,max,note)=>checks.push({name,pass,pts:pass?pts:Math.round(pts*.35),max,note});
  add('Trend alignment', trendBull||trendBear, 18, 18, trendBull?'Bull trend: price > EMA50 > EMA200':trendBear?'Bear trend: price < EMA50 < EMA200':'Trend is mixed');
  add('Momentum health', (rsi>=45&&rsi<=68&&macdD?.hist>0)||(rsi<=55&&rsi>=32&&macdD?.hist<0), 16, 16, `RSI ${fmt(rsi,1)} · MACD hist ${macdD?fmt(macdD.hist):'--'}`);
  add('Volume confirmation', volRatio>=1.0, 14, 14, `${volRatio?volRatio.toFixed(2):'--'}x 20D average`);
  /* Use the RR in the direction of the trend. max(rrBull, rrBear) was always ≥1 because one is the
     inverse of the other, so this check almost always passed. */
  const nearbySrRR = trendBull ? rrBull : trendBear ? rrBear : 0;
  add('Nearby S/R room', nearbySrRR>=1.3, 18, 18, `Nearby S/R room approx ${nearbySrRR.toFixed(2)}:1${trendBull||trendBear?'':' (no clear trend)'} · active Strategy RR is shown separately from Strategy-tab levels`);
  add('Not late entry', !(rsi>72 || (ema20Ok && Math.abs(price-e20)/e20*100>8)), 14, 14, `Distance from EMA20 ${ema20Ok?((price-e20)/e20*100).toFixed(1)+'%':'--'}`);
  add('S/R location', !(nearRes&&trendBull) && !(nearSup&&trendBear), 12, 12, nearRes?'Close to resistance':nearSup?'Close to support':'Not trapped near key S/R');
  /* SuperTrend only counts when it points the same way as the EMA trend (it used to pass just by existing). */
  const stAgrees = !!st && ((trendBull && st.dir===1) || (trendBear && st.dir===-1));
  add('Trend strength', adxR?.adx>=16 || stAgrees, 8, 8, `ADX ${adxR?.adx?fmt(adxR.adx,1):'--'} · ${st?.label||'No ST'}${st&&!stAgrees?' (against trend)':''}`);
  const score=checks.reduce((a,c)=>a+c.pts,0);
  const avoid=[];
  if(rsi>72) avoid.push({t:'Overbought chase risk',d:`RSI ${fmt(rsi,1)}. Avoid fresh long unless pullback/consolidation comes.`,c:'bear'});
  if(rsi<28) avoid.push({t:'Oversold breakdown risk',d:`RSI ${fmt(rsi,1)}. Avoid fresh short after extended fall.`,c:'bear'});
  if(ema20Ok && Math.abs(price-e20)/e20*100>8) avoid.push({t:'Far from EMA20',d:`Price is ${(Math.abs(price-e20)/e20*100).toFixed(1)}% away from EMA20. Entry may be late.`,c:'neutral'});
  if(volRatio<0.7) avoid.push({t:'Weak participation',d:`Volume is only ${(volRatio*100).toFixed(0)}% of 20D average.`,c:'neutral'});
  if(nearRes) avoid.push({t:'Near resistance',d:`Price is close to ${sr.nearestResistance?.n || 'nearest resistance'} ${fmt(nearestResVal)}. Fresh long has poor room.`,c:'bear'});
  if(nearSup) avoid.push({t:'Near support',d:`Price is close to ${sr.nearestSupport?.n || 'nearest support'} ${fmt(nearestSupVal)}. Fresh short has poor room.`,c:'bear'});
  const cls=score>=75?'bull':score>=50?'neutral':'bear';
  const label=score>=75?'Valid Setup Zone':score>=50?'Conditional Setup':'Avoid / Wait Zone';
  return {score,label,cls,checks,avoid,price,volRatio,rsi,rr:nearbySrRR};
}

function getDataConfidenceSnapshot(sym){
  const d = CUR_DATA || {};
  const dailyN = d.daily?.C?.length || 0;
  const weeklyN = d.weekly?.C?.length || 0;
  const volN = Array.isArray(d.daily?.V) ? d.daily.V.filter(v=>Number.isFinite(+v) && +v>=0).length : 0;
  const price = getCurrentLivePrice();
  const ds = d.dataSource || {};
  const ageMin = d.updatedAt ? Math.floor((Date.now() - new Date(d.updatedAt).getTime()) / 60000) : null;
  const mode = ds.mode || 'direct';
  const sourceWarn = ds.warning || '';
  const isProxy = /proxy|fallback|estimated|basket/i.test(mode + ' ' + sourceWarn);
  const isCached = !!d.cached || !!d._localDailyCache;
  const checks=[];
  const add=(name,pass,pts,max,note)=>checks.push({name,pass,pts:pass?pts:Math.round(pts*.35),max,note});
  add('Price feed available', Number.isFinite(+price) && +price>0, 20, 20, Number.isFinite(+price)?`Current price ${fmt(price)}`:'Current price missing');
  add('Daily candles sufficient', dailyN>=50, 20, 20, `Daily candles loaded: ${dailyN}. Minimum required: 50.`);
  add('Weekly candles available', weeklyN>=20, 15, 15, weeklyN?`Weekly candles loaded: ${weeklyN}`:'Weekly candles missing / weak confirmation');
  add('Volume series available', volN>=20 || isIndexSymbol(sym) || isMCXSymbol(sym), 10, 10, volN?`Volume candles loaded: ${volN}`:'Volume data missing or limited');
  add('Fresh server response', ageMin==null ? false : ageMin<=30, 15, 15, ageMin==null?'No updatedAt timestamp':`Updated ${ageMin<1?'just now':ageMin+'m ago'}${isCached?' · server/browser cached':''}`);
  add('Source is not proxy/estimated', !isProxy, 20, 20, isProxy ? (sourceWarn || `Source mode: ${mode}`) : `Source: ${ds.provider || 'Backend'} · ${ds.ticker || sym}`);
  const score = checks.reduce((a,c)=>a+c.pts,0);
  const cls = score>=85?'bull':score>=65?'neutral':'bear';
  const label = score>=85?'High Data Confidence':score>=65?'Medium Data Confidence':'Low Data Confidence';
  return {score,cls,label,checks,isProxy,isCached,mode,sourceWarn,dailyN,weeklyN,ageMin};
}

async function tabValidity(sym, opts={}){
  const v=getTradeValiditySnapshot(sym);
  const dq=getDataConfidenceSnapshot(sym);
  const col=v.cls==='bull'?'var(--bull)':v.cls==='bear'?'var(--bear)':'var(--neu)';
  const dqCol=dq.cls==='bull'?'var(--bull)':dq.cls==='bear'?'var(--bear)':'var(--neu)';
  let decisionSnap = AI_CACHE[`decision_snap_${sym}`]?.snap || null;
  if(!decisionSnap){
    try{ decisionSnap = await buildUnifiedSwingDecisionSnapshot(sym); }catch(e){ decisionSnap=null; }
  }
  const holdSnap = decisionSnap?.holdSnap || null;
  const row = (name, ok, note, score='') => `<div class="tp-qrow"><div><strong>${ok?'✅':'⚠️'} ${escHtml(name)}</strong><span>${escHtml(note)}</span></div>${score?`<b>${escHtml(score)}</b>`:''}</div>`;
  const hasRows = Array.isArray(decisionSnap?.rows) && decisionSnap.rows.length >= 5;
  const marketRow = decisionSnap?.rows?.find(r=>/Sector \+ market/i.test(r.name));
  const rrRow = decisionSnap?.rows?.find(r=>/Risk\/reward/i.test(r.name));
  const trendRow = decisionSnap?.rows?.find(r=>/Trend structure/i.test(r.name));
  const setupRow = decisionSnap?.rows?.find(r=>/Setup shape/i.test(r.name));
  const volumeRow = decisionSnap?.rows?.find(r=>/Volume/i.test(r.name));
  const strategyPlan = await getStrategyTradePlan(sym, document.getElementById('ihn')?.textContent || sym, decisionSnap?.bias || 'Sideways').catch(()=>null);
  /* The Overview's final decision (after the Ready Gate) when it has been worked out in the last 5 min; the
     setup label alone said "WATCH" while the Overview showed "WAIT". */
  const ovV = OVERVIEW_VERDICT[sym] && Date.now() - OVERVIEW_VERDICT[sym].ts < 5*60*1000 ? OVERVIEW_VERDICT[sym] : null;
  const finalActionText = ovV ? `${ovV.action} · Ready Gate ${ovV.gate}${ovV.reason ? ' · ' + ovV.reason : ''}` : String(decisionSnap?.setupLabel || '');
  const finalActionReady = /^READY\b/i.test(finalActionText);
  const numericStrategyLevelsOk = !!(strategyPlan?.isActive && Number.isFinite(+strategyPlan?.stopLoss) && Number.isFinite(+strategyPlan?.target1));
  const strategyOk = finalActionReady && numericStrategyLevelsOk;
  const strategyNote = strategyOk
    ? `Entry: ${fmt(firstFiniteNumber(strategyPlan.entryPrice, extractTradePriceFromText(strategyPlan.entry, getCurrentLivePrice())))} · SL: ${fmt(strategyPlan.stopLoss)} · Target: ${fmt(strategyPlan.target1)}`
    : !finalActionReady
      ? `Overview final action is ${finalActionText || 'missing'}; Strategy levels are conditional, not active.`
      : 'Strategy setup levels not complete';
  /* Fill = current price (breakouts: the trigger when it is above) - the same price the Overview R:R uses. */
  const activeEntryNum = (/breakout/i.test(strategyPlan?.setupName || '') && Number.isFinite(+strategyPlan?.entryPrice))
    ? Math.max(getCurrentLivePrice(), +strategyPlan.entryPrice) : getCurrentLivePrice();
  const activeSLNum = Number(strategyPlan?.stopLoss);
  const activeTargetNum = Number(strategyPlan?.target1);
  const candidateStrategyRR = (strategyPlan?.isActive && Number.isFinite(activeEntryNum) && Number.isFinite(activeSLNum) && Number.isFinite(activeTargetNum) && Math.abs(activeEntryNum-activeSLNum)>0)
    ? Math.abs(activeTargetNum-activeEntryNum)/Math.abs(activeEntryNum-activeSLNum)
    : null;
  const strategyRR = (finalActionReady && candidateStrategyRR != null) ? candidateStrategyRR : null;
  const currentPlanRR = (strategyPlan?.isActive && Number.isFinite(activeSLNum) && Number.isFinite(activeTargetNum))
    ? calcTradePlanRiskReward({bias:strategyPlan.bias, price:getCurrentLivePrice(), stopLoss:activeSLNum, target1:activeTargetNum, atr:null})
    : null;
  const rrHtml = strategyRR != null
    ? `<div class="tp-score-head ${strategyRR>=1.5?'bull':strategyRR>=1.0?'neutral':'bear'}"><div><span class="tp-score-num">${strategyRR.toFixed(2)}</span><span class="tp-score-total">:1</span></div><div class="tp-grade">Active Strategy RR</div></div>
       <div class="aib">Uses the same active Strategy tab levels: Entry ${fmt(activeEntryNum)} · SL ${fmt(activeSLNum)} · Target ${fmt(activeTargetNum)}. No separate S/R approximation is shown here.</div>`
    : `<div class="aib"><strong>No active strategy RR.</strong> ${escHtml(strategyNote)}${candidateStrategyRR!=null?` Plan R:R at ${fmt(activeEntryNum)} is ${candidateStrategyRR.toFixed(2)}:1 - not an active trade until the decision is READY.`:''} Validation will not invent a separate RR from nearest support/resistance.</div>`;
  const missing = [];
  const neutralCheck = (label, r) => {
    const n = String(r?.note || '');
    const isNeutral = /not loaded|neutral credit|UNKNOWN|NO DATA|not safe|not fully loaded|not available/i.test(n);
    if(isNeutral) missing.push(`${label}: ${n}`);
    return !isNeutral;
  };
  const coreOk = hasRows && Number.isFinite(+decisionSnap?.score100);
  const dataRows = dq.checks.map(c => row(c.name, c.pass, c.note, `${c.pts}/${c.max}`));
  const scoreText = (r) => r ? `${r.pts}/${r.max}` : '';
  const decisionRow = (label, checkLabel, r, extraOk=true) => {
    const ok = !!r && !!extraOk && neutralCheck(checkLabel, r);
    return {ok, html:row(label, ok, r?.note || `${label} row missing`, scoreText(r))};
  };
  const rrOk = !!rrRow && (decisionSnap?.rrNum||0)>0;
  const setupRowData = [
    decisionRow('EMA trend structure checked', 'EMA trend', trendRow),
    decisionRow('Setup shape checked', 'Setup', setupRow),
    decisionRow('Entry status / S&R / RR checked', 'RR', rrRow, rrOk),
    decisionRow('Volume participation checked', 'Volume', volumeRow),
    decisionRow('Market / sector / relative strength checked', 'Market/sector/RS', marketRow),
    {ok:coreOk && hasRows, html:row('Fresh Entry score breakdown checked', coreOk && hasRows, decisionSnap ? `${decisionSnap.score100}/100 · ${decisionSnap.lbl} · ${decisionSnap.grade}` : 'Fresh entry snapshot missing')},
    {ok:!!holdSnap?.rows?.length, html:row('Hold Score breakdown checked', !!holdSnap?.rows?.length, holdSnap ? `${holdSnap.score100}/100 · ${holdSnap.grade}` : 'Hold score not available until directional setup exists')},
    {ok:strategyOk, html:row('Strategy tab active trade setup checked', strategyOk, strategyNote)},
    {ok:!!(ovV || (decisionSnap?.setupLabel && decisionSnap?.setupDetail)), html:row('Final action checked in Overview', !!(ovV || (decisionSnap?.setupLabel && decisionSnap?.setupDetail)), ovV ? finalActionText : `${decisionSnap?.setupLabel || 'Final action missing'} · ${decisionSnap?.setupDetail || ''}`)}
  ];
  /* Under Decision, the five score rows and the two breakdown rows repeat the Fresh Entry / Hold tables above. */
  const setupRows = (opts.merged ? setupRowData.slice(7) : setupRowData).map(x=>x.html);
  const allDataOk = dq.checks.every(c=>c.pass);
  const allSetupOk = missing.length===0 && setupRowData.every(x=>x.ok);
  const confirmed = allDataOk && allSetupOk;
  const combinedLabel = confirmed ? '✅ Checklist Passed' : (allSetupOk && !allDataOk ? '⚠️ Setup valid, data confidence weak' : '⚠️ Not Fully Confirmed');
  const combinedText = confirmed
    ? 'Setup validation and data-confidence checks passed. Still verify fresh news, earnings, broker price and liquidity before order placement.'
    : 'Do not treat the score as final. Fix the warning items below or reduce confidence/position size.';
  const warnList = [];
  dq.checks.filter(c=>!c.pass).forEach(c=>warnList.push(`Data confidence: ${c.name} — ${c.note}`));
  missing.forEach(m=>warnList.push(`Setup validation: ${m}`));
  const statusHtml = `<div class="tp-section" style="border-color:${confirmed?'var(--bull)':'var(--neu)'}"><div class="tp-section-title">${combinedLabel}</div><div class="aib"><strong style="color:${confirmed?'var(--bull)':'var(--neu)'}">${combinedText}</strong></div>${warnList.length?`<div class="tp-warning-list" style="margin-top:10px">${warnList.map(m=>`<div class="tp-warning neutral"><strong>Checklist warning</strong><span>${escHtml(m)}</span></div>`).join('')}</div>`:''}</div>`;
  const oldRows=v.checks.map(c=>`<div class="tp-qrow"><div><strong>${c.pass?'✅':'⚠️'} ${escHtml(c.name)}</strong><span>${escHtml(c.note)}</span></div><b>${c.pts}/${c.max}</b></div>`).join('');
  const avoid=v.avoid.length?v.avoid.map(a=>`<div class="tp-warning ${a.c}"><strong>${escHtml(a.t)}</strong><span>${escHtml(a.d)}</span></div>`).join(''):`<div class="aib">No major avoid-zone warning from loaded technical data. Still verify fresh news, calendar events and earnings manually.</div>`;
  return `${statusHtml}
  <div class="tp-section"><div class="tp-section-title">Combined Checklist — Validation + Data Confidence</div>
    <div class="tp-mini-grid" style="margin-bottom:10px">
      ${opts.merged ? '' : `<div class="tp-mini"><h4>Fresh Entry Score</h4><p><strong style="color:${decisionSnap?.col || col}">${decisionSnap?.score100 ?? '--'}/100 · ${escHtml(decisionSnap?.grade || 'No snapshot')}</strong></p></div>`}
      <div class="tp-mini"><h4>Data Confidence</h4><p><strong style="color:${dqCol}">${dq.score}/100 · ${escHtml(dq.label)}</strong></p></div>
      <div class="tp-mini"><h4>Rule</h4><p>Green score is not enough. Setup and data must both pass.</p></div>
    </div>
    <div class="tp-section-title" style="font-size:.78rem;margin-top:12px">Data Confidence Checks</div>
    <div class="tp-quality-list">${dataRows.join('')}</div>
    <div class="tp-section-title" style="font-size:.78rem;margin-top:14px">Setup Validation Checks</div>
    <div class="tp-quality-list">${setupRows.join('')}</div>
    <div class="aib" style="margin-top:10px">This checklist combines two different things: whether the trade setup is valid, and whether the input data is trustworthy. Proxy/estimated/stale data does not automatically reject a trade, but it reduces confidence and must be manually verified.</div>
  </div>
  <div class="tp-section"><div class="tp-section-title">Active Strategy Risk/Reward — Same Levels as Strategy Tab</div>
    ${rrHtml}
  </div>
  <div class="tp-section"><div class="tp-section-title">Avoid Zone</div><div class="tp-warning-list">${avoid}</div></div>`;
}

function goldPetalDashboard(sym){
  if(sym!=='MCX:GOLDPETAL') return '';
  /* Calibrated like the futures card and zones above (they use mcxData); the dashboard used raw proxy values. */
  const D=mcxData(sym), C=D.C, H=D.H, L=D.L;
  const n=C.length, price=D.price;
  if(!n || !Number.isFinite(price)) return '';
  /* Daily history is now 2 years: take the last 252 sessions for a true 52-week range. */
  const validH = H.slice(-252).map(Number).filter(Number.isFinite), validL = L.slice(-252).map(Number).filter(Number.isFinite);
  const hi52=validH.length ? Math.max(...validH) : price, lo52=validL.length ? Math.min(...validL) : price;
  const e20=emaLast(C,20), e50=emaLast(C,50), e200=emaLast(C,200);
  const atr=(()=>{const tr=[];for(let i=1;i<C.length;i++)tr.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1])));return tr.slice(-14).reduce((a,b)=>a+b,0)/Math.max(1,tr.slice(-14).length)||price*.015;})();
  /* Zones are anchored on EMA20/EMA50 and ATR, not on today's price. The old version clamped to the 52W low
     (zero-width "deep" zone near the low) and set "expensive" at price+3 ATR, which moved with price. */
  const anchor20 = Number.isFinite(e20) && e20>0 ? e20 : price;
  const anchor50 = Number.isFinite(e50) && e50>0 ? e50 : anchor20;
  const support=Math.min(anchor50, anchor20 - atr);
  const deep=support - 1.5*atr;
  const fairLow=R2(support), fairHigh=R2(anchor20 + atr);
  const expensive=R2(Math.min(hi52 > anchor20 + 2*atr ? hi52 : Infinity, anchor20 + 2.5*atr));
  const dxy=GLOBAL_DATA?.dxy, us10y=GLOBAL_DATA?.us10y, usdInr=GLOBAL_DATA?.usdInr, usvix=GLOBAL_DATA?.usvix;
  const pct=x=>x&&!x.error&&Number.isFinite(+x.pct)?+x.pct:null;
  let risk=0, notes=[];
  const dxyPct=pct(dxy), yPct=pct(us10y), inrPct=pct(usdInr), vixPct=pct(usvix);
  if(dxyPct!=null){ if(dxyPct>0.25){risk-=1;notes.push(`DXY up ${dxyPct.toFixed(2)}% pressures gold`);} else if(dxyPct<-0.25){risk+=1;notes.push(`DXY down ${dxyPct.toFixed(2)}% supports gold`);} }
  /* Yield moves are judged in basis points (5 bp is a meaningful daily move for the US 10Y). */
  const yBp = us10y && !us10y.error && Number.isFinite(+us10y.chg) ? +us10y.chg*100 : (yPct!=null && Number.isFinite(+us10y?.prev) ? yPct/100*us10y.prev*100 : null);
  if(yBp!=null){ if(yBp>5){risk-=1;notes.push(`US 10Y yield up ${yBp.toFixed(0)} bp pressures gold`);} else if(yBp<-5){risk+=1;notes.push(`US 10Y yield down ${Math.abs(yBp).toFixed(0)} bp supports gold`);} }
  if(inrPct!=null){ if(inrPct>0.15){risk+=1;notes.push(`USD/INR up ${inrPct.toFixed(2)}% supports Indian gold`);} else if(inrPct<-0.15){risk-=0.5;notes.push(`USD/INR down ${inrPct.toFixed(2)}% cools Indian gold`);} }
  if(vixPct!=null){ if(vixPct>3){risk+=0.5;notes.push(`US VIX up ${vixPct.toFixed(2)}% gives safe-haven support`);} else if(vixPct<-3){risk-=0.25;notes.push(`US VIX down ${vixPct.toFixed(2)}% lowers fear bid`);} }
  /* A missing EMA (short history) must not count as "price above it" (price>null is true in JS). */
  const gE50 = Number.isFinite(e50) && e50>0, gE200 = Number.isFinite(e200) && e200>0;
  const gUp = gE50 && gE200 && price>e50 && e50>e200, gDown = gE50 && gE200 && price<e50 && e50<e200;
  if(gUp){risk+=1;notes.push('Gold Petal trend above EMA50/200');}
  else if(gDown){risk-=1;notes.push('Gold Petal trend below EMA50/200');}
  const trendPts = gUp ? 25 : (gE50 && price>e50) ? 18 : gDown ? 6 : 12;
  const macroPts = Math.max(4, Math.min(30, 15 + risk*5));
  /* Below value in a downtrend is a falling knife, not the best buy zone: wait for a base first. */
  const belowValueInDowntrend = gDown && price < fairLow;
  const zonePts = belowValueInDowntrend ? 10 : price<=fairLow ? 25 : price<=fairHigh ? 18 : price>=expensive ? 5 : 12;
  const eventPts = notes.length ? 12 : 8;
  const goldQuality = Math.max(1, Math.min(100, Math.round(trendPts + macroPts + zonePts + eventPts)));
  const goldGrade = goldQuality>=80?'A+':goldQuality>=70?'A':goldQuality>=55?'B':goldQuality>=40?'C':'Avoid';
  const sig=risk>=1.5?{l:'ACCUMULATE ON DIPS',c:'bull'}:risk<=-1?{l:'WAIT / AVOID FRESH BUY',c:'bear'}:{l:'SLOW ACCUMULATION ONLY',c:'neutral'};
  const col=sig.c==='bull'?'var(--bull)':sig.c==='bear'?'var(--bear)':'var(--neu)';
  const zone = belowValueInDowntrend ? 'Below value in a downtrend — wait for a base' : price<=deep ? 'Deep accumulation zone' : price<=fairLow ? 'Deep/Fair accumulation zone' : price<=fairHigh ? 'Fair buy zone' : price>=expensive ? 'Expensive zone — avoid chase' : 'Neutral zone';
  return `<div class="tp-section" style="border-color:${col};background:linear-gradient(180deg,rgba(255,215,64,.08),#12121c)">
    <div class="tp-head"><div><div class="tp-kicker">Gold Petal Dashboard</div><div class="tp-title">Accumulation + Risk Signal</div></div><div class="tp-bias ${sig.c}">🟡 ${sig.l}</div></div>
    <div class="tp-grid">
      <div class="tp-item"><div class="tp-label">Current Zone</div><div class="tp-val" style="color:${col}">${zone}</div><div class="tp-sub">Gold Petal ${fmt(price)}</div></div>
      <div class="tp-item"><div class="tp-label">Deep Accumulation</div><div class="tp-val" style="color:var(--bull)">${fmt(deep)} – ${fmt(fairLow)}</div><div class="tp-sub">Better risk/reward zone</div></div>
      <div class="tp-item"><div class="tp-label">Fair Buy Zone</div><div class="tp-val" style="color:var(--neu)">${fmt(fairLow)} – ${fmt(fairHigh)}</div><div class="tp-sub">Small quantity only</div></div>
      <div class="tp-item"><div class="tp-label">Expensive Above</div><div class="tp-val" style="color:var(--bear)">${fmt(expensive)}</div><div class="tp-sub">Avoid fresh aggressive buy</div></div>
      <div class="tp-item"><div class="tp-label">52W Range</div><div class="tp-val">${fmt(lo52)} – ${fmt(hi52)}</div><div class="tp-sub">Last 252 daily sessions</div></div>
      <div class="tp-item"><div class="tp-label">Gold Petal Buy Quality</div><div class="tp-val" style="color:${col}">${goldQuality}/100 · ${goldGrade}</div><div class="tp-sub">MCX trend + macro + buy zone + event risk</div></div>
    </div>
    <div class="tp-mini-grid" style="margin-top:10px"><div class="tp-mini"><h4>Risk Drivers</h4><p>${notes.slice(0,5).join('<br>')||'Global drivers not loaded yet.'}</p></div><div class="tp-mini"><h4>Buying Rule</h4><p>Do not chase vertical rallies. Buy small near fair zone, add more only near deep accumulation, and keep cash for second/third buy.</p></div></div>
  </div>`;
}


/* ── TABS ── */
function tabIndicators(){
  const{C,H,L,V}=CUR_DATA.daily,n=C.length,price=getCurrentLivePrice(),prevClose=firstFiniteNumber(CUR_DATA.pc,C[n-2],C[n-1]),priceChg=price-prevClose;
  const indexInstrument = isIndexSymbol(CUR_SYM);
  const iC=CUR_DATA.intra?.C||[],iH=CUR_DATA.intra?.H||[],iL=CUR_DATA.intra?.L||[],iV=CUR_DATA.intra?.V||[],iT=CUR_DATA.intra?.T||[];
  const rsi=calcRSI(C),macdD=calcMACD(C),bb=calcBB(C),adxR=calcADX(C,H,L);
  const e20=emaLast(C,20),e50=emaLast(C,50),e200=emaLast(C,200);
  const todayVol=(n > 0 && V.length >= n) ? (V[n-1] || 0) : (V[V.length-1] || 0);
  const volEnd=Math.max(0, Math.min(V.length, n)-1);
  const volSlice20=V.slice(Math.max(0, volEnd-20), volEnd);
  const avgVol20=volSlice20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volSlice20.length);
  const volRatio=indexInstrument ? 0 : (avgVol20?todayVol/avgVol20:1),volChg=(!indexInstrument && V[n-2])?((todayVol-V[n-2])/V[n-2]*100):0;
  /* todayVol is the full-day projection during market hours; show the raw traded volume too. */
  const volProj = !!CUR_DATA.dayVolProjected && CUR_DATA._liveSessionIdx === n-1;
  const volShown = volProj ? `${fmtVol(CUR_DATA._rawTodayVol)} (proj. ${fmtVol(todayVol)})` : fmtVol(todayVol);
  const vwap=calcVWAP(iC,iH,iL,iV,iT),stResult=calcSuperTrend(C,H,L);
  const rs=sigRSI(rsi),ms=sigMACD(macdD?.macd,macdD?.signal),bs=sigBB(price,bb?.upper,bb?.lower,bb?.basis);
  const as=sigADX(adxR?.adx,adxR?.pdi,adxR?.ndi),es=sigEMA(price,e20,e50,e200);
  const vs=indexInstrument ? {l:'Index Volume N/A',c:'na',note:'Index is not directly traded; use breadth/sector data instead.'} : sigVolume(todayVol,avgVol20,priceChg),vwapS=sigVWAP(price,vwap),stS=sigST(stResult);
  const rec=CUR_DATA.daily.rec;
  const allSigs=[rs,ms,bs,as,es,vs,vwapS,stS];
  const bullCount=allSigs.filter(s=>s.c==='bull'||s.c==='strong-bull').length;
  const bearCount=allSigs.filter(s=>s.c==='bear'||s.c==='strong-bear').length;
  const overallC=bullCount>bearCount?'bull':bearCount>bullCount?'bear':'neutral';
  return`<div class="ov-box">
    <div class="ov-title">Overall Indicator Summary — Live Data</div>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">
      ${bdg({l:`${bullCount} Bullish · ${bearCount} Bearish`,c:overallC})}
      <span style="font-size:.75rem;color:var(--tx3)">${rec.buy} MA Buy · ${rec.sell} MA Sell · ${rec.neu} Neutral</span>
    </div>
    <div class="ov-grid">
      <div class="ov-item"><span class="ov-label">RSI (14)</span><span class="ov-val" style="color:${rs.c==='bull'||rs.c==='strong-bull'?'var(--bull)':rs.c==='bear'||rs.c==='strong-bear'?'var(--bear)':'var(--neu)'}">${rsi!=null?fmt(rsi,1):'--'}</span><span style="font-size:.68rem;color:var(--tx3)">${rs.l}</span></div>
      <div class="ov-item"><span class="ov-label">MACD Hist</span><span class="ov-val" style="color:${macdD?.hist>=0?'var(--bull)':'var(--bear)'}">${macdD?fmt(macdD.hist):'--'}</span><span style="font-size:.68rem;color:var(--tx3)">${ms.l}</span></div>
      <div class="ov-item"><span class="ov-label">ADX</span><span class="ov-val" style="color:${as.c==='bull'?'var(--bull)':as.c==='bear'?'var(--bear)':'var(--neu)'}">${adxR?fmt(adxR.adx,1):'--'}</span><span style="font-size:.68rem;color:var(--tx3)">${as.l}</span></div>
      <div class="ov-item"><span class="ov-label">VWAP</span><span class="ov-val" style="color:${vwapS.c==='bull'?'var(--bull)':vwapS.c==='bear'?'var(--bear)':'var(--neu)'}">${fmt(vwap)}</span><span style="font-size:.68rem;color:var(--tx3)">${vwapS.l}</span></div>
      <div class="ov-item"><span class="ov-label">SuperTrend (7,3)</span><span class="ov-val" style="color:${stS.c==='bull'?'var(--bull)':'var(--bear)'}">${stResult?fmt(stResult.value):'--'}</span><span style="font-size:.68rem;color:var(--tx3)">${stResult?.label||'--'}</span></div>
      <div class="ov-item"><span class="ov-label">EMAs 20/50/200</span><span class="ov-val" style="color:${es.c==='bull'||es.c==='strong-bull'?'var(--bull)':es.c==='bear'||es.c==='strong-bear'?'var(--bear)':'var(--neu)'}">${[e20,e50,e200].filter(v=>v!=null&&price>v).length}/3 Above</span><span style="font-size:.68rem;color:var(--tx3)">${es.l}</span></div>
      <div class="ov-item"><span class="ov-label">Bollinger</span><span class="ov-val" style="color:${bs.c==='bull'||bs.c==='strong-bull'?'var(--bull)':bs.c==='bear'||bs.c==='strong-bear'?'var(--bear)':'var(--neu)'}; font-size:.78rem">${bs.l}</span><span style="font-size:.68rem;color:var(--tx3)">${bs.note}</span></div>
      <div class="ov-item"><span class="ov-label">Volume</span><span class="ov-val" style="color:${vs.c==='bull'?'var(--bull)':vs.c==='bear'?'var(--bear)':'var(--neu)'}">${indexInstrument?'N/A':(volRatio*100).toFixed(0)+'% avg'}</span><span style="font-size:.68rem;color:var(--tx3)">${vs.l}</span></div>
    </div>
  </div>`+
  secT('Momentum / Oscillators')+
  sRow('RSI (14)',rs,`Value: ${rsi!=null?fmt(rsi,1):'--'}`)+
  sRow('MACD (12,26,9)',ms,`MACD: ${macdD?fmt(macdD.macd):'-'} · Signal: ${macdD?fmt(macdD.signal):'-'}`)+
  secT('VWAP & SuperTrend (Live)')+
  sRow('VWAP (Current Session)',vwapS,'Resets to the latest intraday session using intraday timestamps.')+sRow('SuperTrend (7, 3)',stS)+
  secT('Trend Strength')+
  sRow('ADX (14)',as)+sRow('EMA 20 / 50 / 200',es,`EMA20: ${fmt(e20)} · EMA50: ${fmt(e50)} · EMA200: ${fmt(e200)}`)+
  secT('Volatility')+
  sRow('Bollinger Bands (20,2)',bs,`Upper: ${bb?fmt(bb.upper):'-'} · Mid: ${bb?fmt(bb.basis):'-'} · Lower: ${bb?fmt(bb.lower):'-'}`)+
  secT(indexInstrument?'Volume (Not applicable for indices)':'Volume (Live)')+
  (indexInstrument
    ? sRow('Index Volume',vs,'Nifty/BankNifty index volume from Yahoo is not reliable tradable volume. Use A/D breadth, sector trend and futures/options data instead.')
    : sRow('Today Volume',vs,`Vol: ${volShown} · Avg20: ${fmtVol(Math.round(avgVol20))} · Chg: ${volChg>=0?'+':''}${volChg.toFixed(1)}%`)+
      sRow('Volume vs Avg',{l:volRatio>1.5?'Very High':volRatio>1.2?'Above Average':volRatio<0.7?'Below Average':'Normal',c:volRatio>1.2?(priceChg>=0?'bull':'bear'):'neutral'},`${(volRatio*100).toFixed(0)}% of 20-day average`));
}

function tabTrend(){
  const d=CUR_DATA,dr=sigRec(d.daily.rec.value);
  const wr=d.weekly?.rec ? sigRec(d.weekly.rec.value) : {l:'N/A',c:'na',note:'Weekly data unavailable'};
  const ir=d.intra?.rec ? sigRec(d.intra.rec.value) : {l:'N/A',c:'na',note:'Intraday data unavailable'};
  const mr=d.monthly?.rec ? sigRec(d.monthly.rec.value) : {l:'N/A',c:'na',note:'Monthly data unavailable'};
  const signals=[dr].concat(d.weekly?.rec ? [wr] : [], d.intra?.rec ? [ir] : [], d.monthly?.rec ? [mr] : []);
  const denom=signals.length;
  const bull=signals.filter(s=>s.c==='bull'||s.c==='strong-bull').length;
  const bear=signals.filter(s=>s.c==='bear'||s.c==='strong-bear').length;
  /* One small box per timeframe (4 across, 2 on a phone) instead of four full-width rows. */
  const box=(lbl,sig,rec)=>`<div class="ov-item mtf-box"><span class="ov-label">${lbl}</span>${bdg(sig)}<span class="mtf-cnt">${rec ? `${rec.buy??0}↑ ${rec.sell??0}↓ ${rec.neu??0}→` : 'No data'}</span></div>`;
  return secT('Multi-Timeframe Trend (Live Data)')+
    `<div class="ov-grid mtf-grid">${box('1 Hour',ir,d.intra?.rec)}${box('Daily',dr,d.daily.rec)}${box('Weekly',wr,d.weekly?.rec)}${box('Monthly',mr,d.monthly?.rec)}</div>`+
    `<div style="margin-top:10px;padding:10px 14px;background:var(--bgc);border:1px solid var(--brd);border-radius:var(--rs);font-size:.82rem;color:var(--tx2)">
      Confluence: <strong style="color:${bull>bear?'var(--bull)':bear>bull?'var(--bear)':'var(--neu)'}">${bull>bear?bull+'/'+denom+' Bullish':bear>bull?bear+'/'+denom+' Bearish':'Mixed signals'}</strong>
    </div>`;
}

function tabPatterns(){
  const{C,O,H,L}=CUR_DATA.daily,n=C.length;
  const todayO=O[n-1],todayH=H[n-1],todayL=L[n-1],todayC=C[n-1],prevC=C[n-2],prevO=O[n-2],prevH=H[n-2],prevL=L[n-2];
  const gapPct=((todayO-prevC)/prevC*100),gapAbs=todayO-prevC;
  const isGapUp=gapPct>0.1,isGapDown=gapPct<-0.1;
  const isBull=todayC>todayO,isBear=todayC<todayO;
  const body=Math.abs(todayC-todayO),range=todayH-todayL||1;
  const bodyPct=(body/range*100).toFixed(0);
  const confirmedIdx=getConfirmedDailyIndex(CUR_DATA.daily);
  const pats=detectPatterns(CUR_DATA.daily, confirmedIdx);
  return`<div class="candle-card">
    <div class="candle-header"><div><div class="candle-title">Latest Daily Candle — Live / Forming</div><div style="font-size:.72rem;color:var(--tx3);margin-top:2px">${isBull?'Bullish (Green)':isBear?'Bearish (Red)':'Doji'} · Body ${bodyPct}% of range</div></div>${bdg({l:isBull?'Bullish':isBear?'Bearish':'Neutral',c:isBull?'bull':isBear?'bear':'neutral'})}</div>
    <div style="margin-bottom:12px"><span class="gap-badge ${isGapUp?'gap-up':isGapDown?'gap-down':'gap-flat'}">${isGapUp?'▲':isGapDown?'▼':'→'} ${isGapUp?`Gap Up ${fmt(Math.abs(gapAbs))} (${Math.abs(gapPct).toFixed(2)}%)`:isGapDown?`Gap Down ${fmt(Math.abs(gapAbs))} (${Math.abs(gapPct).toFixed(2)}%)`:`Flat Open (${gapPct.toFixed(2)}%)`}</span>
    <div style="font-size:.75rem;color:var(--tx3)">Open <strong style="color:var(--tx)">${fmt(todayO)}</strong> vs Previous Close <strong style="color:var(--tx)">${fmt(prevC)}</strong></div></div>
    <div class="candle-prices">
      <div class="cp-item"><div class="cp-label">Open</div><div class="cp-val">${fmt(todayO)}</div></div>
      <div class="cp-item"><div class="cp-label">High</div><div class="cp-val" style="color:var(--bull)">${fmt(todayH)}</div></div>
      <div class="cp-item"><div class="cp-label">Low</div><div class="cp-val" style="color:var(--bear)">${fmt(todayL)}</div></div>
      <div class="cp-item"><div class="cp-label">Close</div><div class="cp-val" style="color:${isBull?'var(--bull)':isBear?'var(--bear)':'var(--neu)'}">${fmt(todayC)}</div></div>
    </div>
    <div style="font-size:.75rem;color:var(--tx3);padding:8px 0;border-top:1px solid var(--brd)">Previous Session — Close: <strong>${fmt(prevC)}</strong> · H: <strong style="color:var(--bear)">${fmt(prevH)}</strong> · L: <strong style="color:var(--bull)">${fmt(prevL)}</strong></div>
  </div>`+(pats.length?secT(`Confirmed Candle Patterns — completed session ${(()=>{const t=CUR_DATA.daily?.T?.[confirmedIdx];return t?marketDateKeyFromTs(t):'';})()} (not today's forming candle)`)+`<div class="pat-list">${pats.map(p=>`<div class="pat-item"><div><div class="pat-name">${p.name}</div><div class="pat-note">${p.note}</div></div>${bdg({l:p.s==='neutral'?'Neutral':p.s.includes('bull')?'Bullish':'Bearish',c:p.s})}</div>`).join('')}</div>`:`<div style="padding:12px 0;font-size:.82rem;color:var(--tx3);text-align:center">No strong confirmed pattern on the completed candle</div>`);
}

function tabSR(){
  const {price, ph, pl, pc, pp, r1, r2, s1, s2, yw_high, yw_low, levels} = getSRTradeLevels();
  const colClass={ptr:'var(--bear)',ptp:'var(--neu)',pts:'var(--bull)'};
  const near=v=>price && Math.abs(v-price)/price<0.0075;

  /* Fibonacci Retracement from 52w low to high. Guard against flat/range-less data. */
  const fibRange = Math.max(0, yw_high - yw_low);
  /* Retracements of the Low → High move are measured DOWN from the high: level = high − range × ratio.
     (The old code measured up from the low, so "23.6% minor" was really the 76.4% deep level and 38.2/61.8 were swapped.)
     pos = where the level sits in the 52w range (0 = low, 1 = high), used for the bar width. */
  const fibLevels = fibRange > 0 ? [
    { ratio:0,    label:'0%',    price:R2(yw_high),                   note:'52w High (top)' },
    { ratio:0.236,label:'23.6%', price:R2(yw_high - fibRange*0.236),  note:'Minor retracement' },
    { ratio:0.382,label:'38.2%', price:R2(yw_high - fibRange*0.382),  note:'Key retracement' },
    { ratio:0.5,  label:'50%',   price:R2(yw_high - fibRange*0.5),    note:'Midpoint' },
    { ratio:0.618,label:'61.8%', price:R2(yw_high - fibRange*0.618),  note:'Golden ratio' },
    { ratio:0.786,label:'78.6%', price:R2(yw_high - fibRange*0.786),  note:'Deep retracement' },
    { ratio:1,    label:'100%',  price:R2(yw_low),                    note:'52w Low (base)' },
  ].map(f=>({...f, pos:1-f.ratio, dist:+((f.price-price)/price*100).toFixed(2), isNear:Math.abs(f.price-price)/price<0.01})) : [];

  const pricePos = fibRange > 0 ? ((price - yw_low)/fibRange*100).toFixed(1) : '--';
  const fibHtml = secT('Fibonacci Retracement (52-Week Low → High)')+
    `<div style="background:var(--bgc);border:1px solid var(--brd);border-radius:var(--r);padding:12px 14px;margin-bottom:14px">
      <div style="font-size:.72rem;color:var(--tx3);margin-bottom:10px">
        Range: <strong style="color:var(--bull)">${fmt(yw_low)}</strong> ↔ <strong style="color:var(--bear)">${fmt(yw_high)}</strong>
        · Width: <strong>${fmt(fibRange, fibRange < 100 ? 2 : 0)}</strong>
        · Current at <strong style="color:var(--acc)">${pricePos}%</strong> of range
      </div>
      ${fibLevels.length ? fibLevels.map(f=>{ /* already ordered high → low price */
        const isSup = f.price < price, isRes = f.price > price;
        const col = f.isNear ? 'var(--acc)' : isSup ? 'var(--bull)' : isRes ? 'var(--bear)' : 'var(--neu)';
        const barW = Math.round(f.pos*100);
        return `<div class="fib-row${f.isNear?' near':''}">
          <span class="fib-level" style="color:${col}">${f.label}</span>
          <span class="fib-price" style="color:${col}">${fmt(f.price)}${f.isNear?` ◀ NEAR`:''}</span>
          <div class="fib-bar"><div class="fib-mark" style="width:${barW}%;background:${col}"></div></div>
          <span style="font-size:.75rem;color:var(--tx3);min-width:90px;text-align:right">${f.dist>=0?'+':''}${f.dist}% · ${f.note}</span>
        </div>`;
      }).join('') : `<div style="font-size:.8rem;color:var(--tx3);padding:10px">Not enough 52-week range data for Fibonacci levels.</div>`}
    </div>`;

  return`<div class="cur-price-bar"><div><div class="cpb-label">Live Price</div><div class="cpb-val">${fmt(price)}</div></div><div><div class="cpb-label">Prev Close</div><div style="font-size:.9rem;font-weight:700;font-variant-numeric:tabular-nums">${fmt(pc)}</div></div><div><div class="cpb-label">Prev H / L</div><div style="font-size:.82rem;font-weight:600"><span style="color:var(--bear)">${fmt(ph)}</span> / <span style="color:var(--bull)">${fmt(pl)}</span></div></div><div style="margin-left:auto;font-size:.72rem;color:var(--tx3)">◀ = Nearest level</div></div>`+
  `<div class="lvl-card"><div class="lvl-header"><span>Key Support &amp; Resistance (from live data)</span><span style="font-weight:400;color:var(--tx3)">Dist from ${fmt(price,0)}</span></div>${levels.map(lv=>{const d=((lv.v-price)/price*100);return`<div class="lvl-row${near(lv.v)?' near':''}"><div><div class="lvl-name" style="color:${colClass[lv.k]}">${lv.n}${near(lv.v)?' ◀':''}</div><div class="lvl-type">${lv.type}</div></div><div style="text-align:right"><div class="lvl-price" style="color:${colClass[lv.k]}">${fmt(lv.v)}</div><div class="lvl-dist">${(+d>0?'+':'')+d.toFixed(2)}%</div></div></div>`;}).join('')}</div>`+
  secT('Candles & Patterns')+tabPatterns()+
  fibHtml;
}

/* ══════════════════════════════════════════════════════════════════
   OPTIONS STRATEGY STATE
══════════════════════════════════════════════════════════════════ */
let OPT_STATE = { strategy:'iron_condor', expiry:30, iv:'', lot:'', strikes:[] };

/* NSE F&O lot sizes — VERIFIED April 2026 from Dhan/NSE
   SEBI revised indices Jan 27 2026: NIFTY 75→65, BANKNIFTY 35→30, FINNIFTY 65→60 */
const LOT_PRESETS = {
  'NSE:NIFTY':65,'NSE:BANKNIFTY':30,
  'NSE:FINNIFTY':60,'NSE:NIFTYNXT50':25,
  'NSE:RELIANCE':250,'NSE:HDFCBANK':550,'NSE:TCS':175,
  'NSE:INFY':400,'NSE:ICICIBANK':700,'NSE:WIPRO':1500,
  'NSE:TATAMOTORS':550,'NSE:SBIN':1500,'NSE:LT':175,
  'NSE:AXISBANK':625,'NSE:TATASTEEL':550,'NSE:BAJFINANCE':750,
  'NSE:KOTAKBANK':400,'NSE:HINDUNILVR':300,'NSE:MARUTI':65,
  'NSE:SUNPHARMA':350,'NSE:HCLTECH':350,'NSE:ULTRACEMCO':100,
  'NSE:ADANIENT':309,'NSE:ADANIPORTS':475,'NSE:NTPC':2250,
  'NSE:POWERGRID':2900,'NSE:ONGC':1925,'NSE:COALINDIA':1350,
  'NSE:BHARTIARTL':475,'NSE:ASIANPAINT':250,'NSE:BAJAJFINSV':250,
  'NSE:M&M':175,'NSE:HEROMOTOCO':150,'NSE:EICHERMOT':100,
  'NSE:TITAN':375,'NSE:NESTLEIND':50,'NSE:DRREDDY':625,
  'NSE:DIVISLAB':100,'NSE:CIPLA':375,'NSE:APOLLOHOSP':125,
  'NSE:JSWSTEEL':675,'NSE:HINDALCO':700,'NSE:VEDL':1375,
  'NSE:SAIL':5850,'NSE:GRASIM':250,'NSE:INDUSINDBK':500,
  'NSE:FEDERALBNK':5000,'NSE:BANKBARODA':2925,
  'NSE:IRCTC':325,'NSE:DMART':150,'NSE:SIEMENS':100,
  'NSE:HAVELLS':500,'NSE:ASHOKLEY':5000,'NSE:TVSMOTOR':350,
  'NSE:ITC':1600,'NSE:BAJAJ-AUTO':75,'NSE:TECHM':600,
  'NSE:TATAPOWER':2700,'NSE:TATACONSUM':875,'NSE:SBILIFE':750,
  'NSE:HDFCLIFE':1100,'NSE:ZOMATO':2425,'NSE:ETERNAL':2425,
};

const STRAT_LIST = [
  { id:'iron_condor',      name:'Iron Condor',       icon:'🦅', outlook:'Neutral',        type:'Credit' },
  { id:'bull_call_spread', name:'Bull Call Spread',  icon:'📈', outlook:'Bullish',         type:'Debit'  },
  { id:'bear_put_spread',  name:'Bear Put Spread',   icon:'📉', outlook:'Bearish',         type:'Debit'  },
  { id:'long_straddle',    name:'Long Straddle',     icon:'⚡', outlook:'High Volatility', type:'Debit'  },
  { id:'long_strangle',    name:'Long Strangle',     icon:'🔀', outlook:'High Volatility', type:'Debit'  },
  { id:'covered_call',     name:'Covered Call',      icon:'🛡️', outlook:'Neutral–Bullish', type:'Credit' },
  { id:'bull_put_spread',  name:'Bull Put Spread',   icon:'🟢', outlook:'Bullish',         type:'Credit' },
  { id:'bear_call_spread', name:'Bear Call Spread',  icon:'🔴', outlook:'Bearish',         type:'Credit' },
];

function buildPayoffSVG(payoff, spot) {
  if (!payoff || payoff.length < 2) return '';
  const W = 560, H = 160, px = 32, py = 20;
  const iW = W - px*2, iH = H - py*2;
  const spots = payoff.map(p => p.spot);
  const pls   = payoff.map(p => p.pl);
  const minPL = Math.min(...pls), maxPL = Math.max(...pls);
  const rng   = maxPL - minPL || 1;
  const sx = v => px + (v - spots[0]) / (spots[spots.length-1] - spots[0]) * iW;
  const sy = v => py + iH - ((v - minPL) / rng) * iH;
  const zero = sy(0);
  // Build path
  const pts = payoff.map(p => `${sx(p.spot).toFixed(1)},${sy(p.pl).toFixed(1)}`).join(' ');
  const firstX = sx(spots[0]).toFixed(1), lastX = sx(spots[spots.length-1]).toFixed(1);
  // Zero line X points for gradient fill
  const abovePts = `${firstX},${zero.toFixed(1)} ` + payoff.map(p => `${sx(p.spot).toFixed(1)},${sy(p.pl).toFixed(1)}`).join(' ') + ` ${lastX},${zero.toFixed(1)}`;
  const belowPts = `${firstX},${zero.toFixed(1)} ` + payoff.map(p => `${sx(p.spot).toFixed(1)},${sy(p.pl).toFixed(1)}`).join(' ') + ` ${lastX},${zero.toFixed(1)}`;
  // Spot line
  const spotX = sx(spot).toFixed(1);
  // Y axis labels
  /* Signed compact labels (old code printed "+-200" when every point was a loss). */
  const fmtK = v => (v > 0 ? '+' : v < 0 ? '-' : '') + (Math.abs(v) >= 1000 ? (Math.abs(v)/1000).toFixed(1)+'K' : Math.abs(v).toFixed(0));
  const maxL = fmtK(maxPL), minL = fmtK(minPL);
  /* P&L at the actual spot (linear between payoff points), not at the middle array index. */
  const plAtSpot = (() => {
    for (let i = 1; i < payoff.length; i++) {
      const a = payoff[i-1], b = payoff[i];
      if (spot >= a.spot && spot <= b.spot) return b.spot === a.spot ? a.pl : a.pl + (b.pl - a.pl) * (spot - a.spot) / (b.spot - a.spot);
    }
    return pls[Math.round(pls.length/2)];
  })();
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:160px;display:block;margin-top:10px">
  <defs>
    <clipPath id="aboveZero"><rect x="${px}" y="${py}" width="${iW}" height="${(zero-py).toFixed(1)}"/></clipPath>
    <clipPath id="belowZero"><rect x="${px}" y="${zero.toFixed(1)}" width="${iW}" height="${(py+iH-zero).toFixed(1)}"/></clipPath>
  </defs>
  <!-- Grid -->
  <line x1="${px}" y1="${zero.toFixed(1)}" x2="${(px+iW).toFixed(1)}" y2="${zero.toFixed(1)}" stroke="#3a3a5a" stroke-width="1" stroke-dasharray="4,3"/>
  <line x1="${spotX}" y1="${py}" x2="${spotX}" y2="${(py+iH).toFixed(1)}" stroke="#00bcd4" stroke-width="1" stroke-dasharray="3,3" opacity=".7"/>
  <!-- Profit fill (above zero) -->
  <polygon points="${abovePts}" fill="rgba(0,230,118,0.15)" clip-path="url(#aboveZero)"/>
  <!-- Loss fill (below zero) -->
  <polygon points="${belowPts}" fill="rgba(255,23,68,0.15)" clip-path="url(#belowZero)"/>
  <!-- Main line -->
  <polyline points="${pts}" fill="none" stroke="#00bcd4" stroke-width="2" stroke-linejoin="round"/>
  <!-- Spot marker -->
  <circle cx="${spotX}" cy="${sy(plAtSpot).toFixed(1)}" r="3" fill="#00bcd4"/>
  <!-- Labels -->
  <text x="${px+2}" y="${(py+10).toFixed(1)}" font-size="9" fill="#00e676" font-family="monospace">${maxL}</text>
  <text x="${px+2}" y="${(py+iH).toFixed(1)}" font-size="9" fill="#ff1744" font-family="monospace">${minL}</text>
  <text x="${spotX}" y="${(py+iH+12).toFixed(1)}" font-size="9" fill="#00bcd4" font-family="monospace" text-anchor="middle">SPOT</text>
  <text x="${(px+iW/2).toFixed(1)}" y="${(py-4).toFixed(1)}" font-size="9" fill="#5a5a7a" font-family="sans-serif" text-anchor="middle">P&amp;L at Expiry (₹/lot)</text>
</svg>`;
}

async function loadOptionStrategy(sym, stratId) {
  /* Only the newest request may write #opt-result (fast clicks let older responses overwrite newer ones). */
  const req = ++OPT_REQ_SEQ;
  let box = document.getElementById('opt-result');
  if (box) { box.innerHTML = '<div class="ls" style="display:flex;min-height:80px;justify-content:center"><div class="sp"></div></div>'; }

  try {
    const params = new URLSearchParams({ sym, strategy: stratId, expiry: OPT_STATE.expiry });
    if (OPT_STATE.iv)  params.set('iv',  OPT_STATE.iv);
    /* India VIX is NIFTY 50's implied vol — only use it for NIFTY. Other symbols fall back to
       the server's per-symbol default IV (BANKNIFTY 18%, stocks 20%). */
    else if (sym === 'NSE:NIFTY' && GLOBAL_DATA?.ivRank?.autoIvPct) params.set('iv', GLOBAL_DATA.ivRank.autoIvPct); /* auto from VIX */
    /* Use already-loaded selected quote as spot to avoid a second slow Yahoo call. */
    if (CUR_DATA?.price && CUR_SYM === sym) params.set('spot', CUR_DATA.price);
    if (OPT_STATE.lot) params.set('lot', OPT_STATE.lot);
    if (OPT_STATE.strikes && OPT_STATE.strikes.length)
      params.set('strikes', OPT_STATE.strikes.join(','));

    const d = await apiFetch(`/api/strategy?${params}`);
    if (req !== OPT_REQ_SEQ || CUR_SYM !== sym) return;
    box = document.getElementById('opt-result');

    // Save lot returned from server so display stays in sync
    if (!OPT_STATE.lot) {
      document.getElementById('opt-lot').value = d.lotSize;
    }

    const legColor = leg => leg.action === 'BUY' ? 'var(--bull)' : 'var(--bear)';
    const legBg    = leg => leg.action === 'BUY' ? 'rgba(0,230,118,0.07)' : 'rgba(255,23,68,0.07)';

    /* Editable option strike rows. Underlying/STOCK leg is shown as entry price, not as a fake PUT. */
    const legs = (d.legs||[]).map((leg, i) => {
      const isStock = leg.type === 'STOCK';
      const typeLabel = isStock ? 'UNDERLYING' : (leg.type==='C'?'CALL':'PUT');
      const suffix = isStock ? 'ENTRY' : (leg.type==='C'?'CE':'PE');
      const inputHtml = isStock
        ? `<input id="opt-strike-${i}" type="number" value="${leg.strike}" disabled
            style="width:90px;background:var(--bgp);border:1px solid var(--brd);border-radius:var(--rs);padding:4px 8px;color:var(--tx3);font-size:.85rem;font-weight:700;font-variant-numeric:tabular-nums">`
        : `<input id="opt-strike-${i}" type="number" value="${leg.strike}" step="${d.strikeInterval||50}"
            style="width:90px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);padding:4px 8px;color:var(--tx);font-size:.85rem;font-weight:700;font-variant-numeric:tabular-nums"
            onchange="optUpdateStrike(${i},${(d.legs||[]).length},${jsArg(sym)},${jsArg(stratId)})">`;
      return `
      <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:${legBg(leg)};border:1px solid ${legColor(leg)};border-radius:var(--rs);margin-bottom:6px;flex-wrap:wrap">
        <span style="font-size:.72rem;font-weight:800;padding:2px 9px;border-radius:20px;background:${legColor(leg)};color:#000;white-space:nowrap">${leg.action}</span>
        <span style="font-size:.78rem;font-weight:700;color:${legColor(leg)};white-space:nowrap">${typeLabel}</span>
        <div style="display:flex;align-items:center;gap:5px;flex:1;min-width:160px">
          <span style="font-size:.72rem;color:var(--tx3)">${isStock?'Entry':'Strike'}</span>
          ${inputHtml}
          <span style="font-size:.72rem;color:var(--tx3);white-space:nowrap">${suffix}</span>
        </div>
        <span style="margin-left:auto;font-size:.82rem;font-weight:700;color:var(--acc);white-space:nowrap">₹${fmt(leg.premium)}${leg.live ? ' <span style="font-size:.62rem;color:var(--bull)">NSE</span>' : (d.priceSource ? ' <span style="font-size:.62rem;color:var(--tx3)">est.</span>' : '')}</span>
      </div>`;
    }).join('');

    const credit = d.netCredit != null ? `<div class="strat-cell"><div class="strat-label">Net Credit</div><div class="strat-val" style="color:var(--bull)">₹${fmt(d.netCredit)}</div></div>` : '';
    const debit  = d.netDebit  != null ? `<div class="strat-cell"><div class="strat-label">Net Debit</div><div class="strat-val" style="color:var(--bear)">₹${fmt(d.netDebit)}</div></div>` : '';
    const profitCol = d.maxProfit != null ? 'var(--bull)' : 'var(--tx3)';
    const g = d.greeks || {};
    const greekSign = v => v != null ? (v > 0 ? `+${v}` : `${v}`) : '--';

    /* IV Percentile from cached global data */
    let ivPctHtml = '';
    if (GLOBAL_DATA?.ivRank) {
      const ivr = GLOBAL_DATA.ivRank;
      const col = ivr.rank < 30 ? 'var(--bull)' : ivr.rank > 70 ? 'var(--bear)' : 'var(--neu)';
      const fillCol = ivr.rank < 30 ? '#00e676' : ivr.rank > 70 ? '#ff1744' : '#ffd740';
      const daysCtx = ivr.daysBelow != null
        ? `${ivr.daysBelow} of ${ivr.totalDays} days VIX was lower`
        : `52w range: ${ivr.lo52w}–${ivr.hi52w}`;
      ivPctHtml = `
        <div class="iv-pct-bar" title="IV Percentile = % of past year trading days where VIX was BELOW today's VIX. Different from IV Rank.">
          <span class="ivp-label">IV Percentile</span>
          <span class="ivp-val ${ivr.rank<30?'ivp-cheap':ivr.rank>70?'ivp-exp':'ivp-fair'}">${ivr.rank}%</span>
          <div class="ivp-track"><div class="ivp-fill" style="width:${ivr.rank}%;background:${fillCol}"></div></div>
          <span class="ivp-sig" style="color:${col}">${ivr.label}</span>
          <span style="font-size:.75rem;color:var(--tx3);margin-left:6px">${daysCtx}</span>
        </div>`;
    }

    /* Theta ₹/day per leg and total */
    const thetaDay = g.theta != null ? +(g.theta * d.lotSize).toFixed(0) : null;
    const thetaHtml = thetaDay != null
      ? `<div style="font-size:.75rem;padding:5px 10px;background:${thetaDay>=0?'var(--bullb)':'var(--bearb)'};border:1px solid ${thetaDay>=0?'var(--bull)':'var(--bear)'};border-radius:var(--rs);display:inline-block;margin-bottom:10px">
           Theta decay: <strong style="color:${thetaDay>=0?'var(--bull)':'var(--bear)'}">${thetaDay>=0?'+':''}₹${Math.abs(thetaDay)}/day</strong>
           <span style="color:var(--tx3);font-size:.68rem"> per lot</span>
         </div>` : '';

    const html = `
      <div class="aib" style="margin-bottom:10px">
        📡 Live spot <strong style="color:var(--acc)">₹${fmt(d.spot)}</strong> · ${escHtml(d.priceSource || 'theoretical Black-Scholes premiums')} · IV <strong style="color:var(--acc)">${d.iv}%</strong>${(sym === 'NSE:NIFTY' && !OPT_STATE?.iv && GLOBAL_DATA?.ivRank?.autoIvPct) ? ` <span style="font-size:.7rem;color:var(--tx3)">(auto from VIX)</span>` : ''} · ${d.expiry}d to expiry · Lot size <strong style="color:var(--acc)">${d.lotSize}</strong>
        <span style="float:right;font-size:.68rem;color:var(--tx3)">Strike interval: ${d.strikeInterval}</span>
      </div>

      ${ivPctHtml}
      ${d.oi ? `<div class="aib" style="margin-bottom:10px;font-size:.74rem"><b>NSE open interest (${ideaDate(d.oi.expiry)} expiry):</b> PCR ${d.oi.pcr ?? '--'} · max pain ${fmt(d.oi.maxPain,0)} · biggest call OI (resistance) ${(d.oi.callWalls||[]).map(w => fmt(w.k,0)).join(', ') || '--'} · biggest put OI (support) ${(d.oi.putWalls||[]).map(w => fmt(w.k,0)).join(', ') || '--'}. Prices use the NSE expiry closest to your Expiry (days).</div>` : ''}
      ${thetaHtml}

      ${secT('Option Legs — Edit Strikes to Recalculate')}
      ${legs}
      <div style="font-size:.7rem;color:var(--tx3);margin-bottom:10px;margin-top:-2px">✏️ Change any strike value and press Enter / Tab to recalculate premiums &amp; payoff</div>

      ${secT('Strategy Metrics')}
      <div class="strat-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:10px">
        ${credit}${debit}
        <div class="strat-cell"><div class="strat-label">Max Profit</div><div class="strat-val" style="color:${profitCol}">${d.maxProfit != null ? '₹'+fmt(d.maxProfit,0) : '∞ Unlimited'}</div></div>
        <div class="strat-cell"><div class="strat-label">Max Loss</div><div class="strat-val" style="color:var(--bear)">${d.maxLoss != null ? '₹'+fmt(d.maxLoss,0) : '∞ Unlimited'}</div></div>
        <div class="strat-cell"><div class="strat-label">Lot Size</div><div class="strat-val">${d.lotSize}</div></div>
        <div class="strat-cell" title="Chance the position is profitable at expiry, lognormal model at the same IV. Read it together with max profit/loss: a big reward:risk with a low probability is not an edge."><div class="strat-label">Prob. of Profit</div><div class="strat-val" style="color:${d.pop>=55?'var(--bull)':d.pop>=40?'var(--neu)':'var(--bear)'}">${Number.isFinite(+d.pop)?fmt(d.pop,1)+'%':'--'}</div></div>
        <div class="strat-cell" title="1-sigma expected move to expiry = spot x IV x sqrt(days/365)"><div class="strat-label">Expected Move (1σ)</div><div class="strat-val">${Number.isFinite(+d.expectedMove)?'±'+fmt(d.expectedMove,0):'--'}</div></div>
      </div>

      <div style="padding:9px 13px;background:var(--bgc);border:1px solid var(--brd);border-radius:var(--rs);margin-bottom:8px;font-size:.82rem">
        <span style="color:var(--tx3);font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em">Breakeven${(d.breakeven||[]).length>1?'s':''}</span><br>
        <strong style="color:var(--neu);font-size:.95rem">${(d.breakeven||[]).map(v=>fmt(v,0)).join(' — ')}</strong>
        <span style="float:right;font-size:.75rem;color:var(--tx2)">${escHtml(d.profitZone||'')}</span>
      </div>

      ${secT('Position Greeks (Combined)')}
      <div class="strat-grid" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
        <div class="strat-cell"><div class="strat-label">Delta (Δ)</div><div class="strat-val" style="color:${(g.delta||0)>=0?'var(--bull)':'var(--bear)'}">${greekSign(g.delta)}</div><div style="font-size:.75rem;color:var(--tx3)">Price sensitivity</div></div>
        <div class="strat-cell"><div class="strat-label">Gamma (Γ)</div><div class="strat-val" style="color:${(g.gamma||0)>=0?'var(--bull)':'var(--bear)'}">${greekSign(g.gamma)}</div><div style="font-size:.75rem;color:var(--tx3)">Delta acceleration</div></div>
        <div class="strat-cell"><div class="strat-label">Theta (Θ)</div><div class="strat-val" style="color:${(g.theta||0)>=0?'var(--bull)':'var(--bear)'}">${greekSign(g.theta)}/day</div><div style="font-size:.75rem;color:var(--tx3)">Time decay / unit</div></div>
        <div class="strat-cell"><div class="strat-label">Vega (ν)</div><div class="strat-val" style="color:${(g.vega||0)>=0?'var(--bull)':'var(--bear)'}">${greekSign(g.vega)}/1%IV</div><div style="font-size:.75rem;color:var(--tx3)">Volatility / unit</div></div>
      </div>

      ${secT('Payoff at Expiry')}
      <div style="background:var(--bgc);border:1px solid var(--brd);border-radius:var(--rs);padding:12px 14px;margin-bottom:12px">
        ${buildPayoffSVG(d.payoff, d.spot)}
        <div style="display:flex;gap:16px;font-size:.7rem;color:var(--tx3);margin-top:4px">
          <span><span style="color:var(--bull)">●</span> Profit zone</span>
          <span><span style="color:var(--bear)">●</span> Loss zone</span>
          <span><span style="color:var(--acc)">|</span> Current spot</span>
        </div>
      </div>

      <div class="aib">${escHtml(d.description||'')}</div>`;

    if (box) box.innerHTML = html;
  } catch(e) {
    if (req !== OPT_REQ_SEQ) return;
    box = document.getElementById('opt-result');
    if (box) box.innerHTML = `<div class="eb"><strong>Strategy error:</strong> ${escHtml(e.message)}<br><button onclick="loadOptionStrategy(${jsArg(sym)},${jsArg(OPT_STATE.strategy)})">↻ Retry</button></div>`;
  }
}

/* Collect all strike inputs and reload with overridden strikes */
function optUpdateStrike(changedIdx, legCount, sym, stratId) {
  const strikes = [];
  for (let i = 0; i < legCount; i++) {
    const el = document.getElementById(`opt-strike-${i}`);
    strikes.push(el ? +el.value : 0);
  }
  if (strikes.every(s => s > 0)) {
    OPT_STATE.strikes = strikes;
    loadOptionStrategy(sym, stratId);
  }
}




function buildFourStrategyTradeSetups(ctx){
  const {name, rsi, macdD, e20, e50, e200, C, H, L} = ctx;
  const sr = ctx.srLevels || (CUR_DATA?.daily ? getSRTradeLevels() : null);
  const price = firstFiniteNumber(ctx.price, sr?.price, getCurrentLivePrice()) || 0;
  const pp = firstFiniteNumber(ctx.pp, sr?.pp, price);
  const r1 = firstFiniteNumber(ctx.r1, sr?.r1, price * 1.02);
  const r2 = firstFiniteNumber(ctx.r2, sr?.r2, r1, price * 1.04);
  const r3 = firstFiniteNumber(ctx.r3, sr?.r3, r2, price * 1.06);
  const s1 = firstFiniteNumber(ctx.s1, sr?.s1, price * 0.98);
  const s2 = firstFiniteNumber(ctx.s2, sr?.s2, s1, price * 0.96);
  const s3 = firstFiniteNumber(ctx.s3, sr?.s3, s2, price * 0.94);
  const atr = SwingPlan.atrWilder(C, H, L, price, r1, s1); /* shared engine */

  const supports = (sr?.supports || []).map(x=>x.v).filter(v=>Number.isFinite(v) && v < price).sort((a,b)=>b-a);
  const resistances = (sr?.resistances || []).map(x=>x.v).filter(v=>Number.isFinite(v) && v > price).sort((a,b)=>a-b);
  const nearSupport = supports[0] || (Number.isFinite(e50) && e50 < price ? e50 : s1);
  const nextSupport = supports[1] || s2 || price - atr*2;
  const farSupport = supports[2] || s3 || nextSupport - atr;
  const nearResistance = resistances[0] || (Number.isFinite(e20) && e20 > price ? e20 : r1);
  const nextResistance = resistances[1] || r2 || price + atr*2;
  const farResistance = resistances[2] || r3 || nextResistance + atr;
  const round = v => fmt(R2(v));
  const valid = v => Number.isFinite(+v) && +v > 0;
  const uniq = arr => [...new Set(arr.filter(valid).map(v=>R2(+v)))];
  const minMoveFrom = entry => Math.max(atr*0.9, Math.abs(r1-s1)*0.35 || 0, Math.max(+entry || price, 1)*0.01);

  /* Each strategy must calculate SL/target from its own entry trigger.
     Old code calculated all stops from current price, so ATR clamping often made
     EMA pullback, S/R bounce, breakout and momentum cards show the same levels. */
  const stopLongFromEntry = (entry, structural, fallback)=>calcAtrStopLoss({
    side:'long', price:entry, structuralStop:structural, atr,
    fallbackStop:valid(fallback) ? fallback : entry - Math.max(atr*1.4, minMoveFrom(entry)),
    phase:'primary'
  });
  const stopShortFromEntry = (entry, structural, fallback)=>calcAtrStopLoss({
    side:'short', price:entry, structuralStop:structural, atr,
    fallbackStop:valid(fallback) ? fallback : entry + Math.max(atr*1.4, minMoveFrom(entry)),
    phase:'primary'
  });
  const targetLongFromEntry = (entry, ...levels)=>{
    const minMove = minMoveFrom(entry);
    const hit = uniq(levels).filter(v=>v > entry + minMove*0.5).sort((a,b)=>a-b)[0];
    return round(hit || (entry + Math.max(minMove*1.8, atr*1.8)));
  };
  const targetShortFromEntry = (entry, ...levels)=>{
    const minMove = minMoveFrom(entry);
    const hit = uniq(levels).filter(v=>v < entry - minMove*0.5).sort((a,b)=>b-a)[0];
    return round(hit || (entry - Math.max(minMove*1.8, atr*1.8)));
  };
  const entryText = (label, entry)=>`${label} ${round(entry)}`;
  const num = v => Number(String(v ?? '').replace(/,/g,''));
  const firstBelow = (entry, ...levels) => uniq(levels).filter(v=>v < entry).sort((a,b)=>b-a)[0];
  const firstAbove = (entry, ...levels) => uniq(levels).filter(v=>v > entry).sort((a,b)=>a-b)[0];
  /* Exit plan for every card (entry -> management -> exit), the same rules the Forward Test uses:
     stop-loss order at the SL; book half at T1 and move SL to entry; trail the rest
     (T1 ∓ 0.75 ATR, or a daily close through EMA20, whichever comes first); T2 = next level beyond T1;
     time stop if T1 is not reached within 10 sessions. */
  function withExitPlans(cards, side){
    const long = side === 'long';
    const lv = long ? [r1, r2, r3, nextResistance, farResistance] : [s1, s2, s3, nextSupport, farSupport];
    return cards.map(card => {
      const entry0 = +card.entryPrice, sl = num(card.stoploss), t1 = num(card.target);
      if(!(entry0 > 0 && sl > 0 && t1 > 0)) return card;
      /* Pullbacks, bounces, rejections and momentum are bought/sold NOW, so the trade is managed from the current
         price (the same price the R:R is measured from); breakouts/breakdowns fill at their trigger. The card's
         EMA / support level is the zone, not the fill: "move SL to entry" at EMA20 would still be a loss. */
      const trigger = /breakout|breakdown/i.test(card.name || '');
      let entry = trigger ? (long ? Math.max(price, entry0) : Math.min(price, entry0)) : price;
      if(!(long ? sl < entry && t1 > entry : sl > entry && t1 < entry)) entry = entry0;
      const beyond = uniq(lv).filter(v => long ? v > t1 + atr*0.25 : v < t1 - atr*0.25).sort((a,b) => long ? a-b : b-a)[0];
      const t2 = R2(beyond || (long ? t1 + (t1 - entry) : t1 - (entry - t1)));
      const trail = R2(long ? Math.max(entry, t1 - atr*0.75) : Math.min(entry, t1 + atr*0.75));
      const risk = Math.abs(entry - sl), rr1 = risk ? Math.abs(t1 - entry) / risk : null, rr2 = risk ? Math.abs(t2 - entry) / risk : null;
      const dir = long ? 'below' : 'above';
      /* Stop-loss ORDER at the SL (not "on a daily close"): a close-based stop can lose more than the 1R the
         position size is built on. */
      const exit = `Exit plan: stop-loss order at ${round(sl)} (exit if price trades ${dir} it) · book 50% at T1 ${round(t1)}${rr1?` (${rr1.toFixed(2)}R)`:''} and move SL to your entry ${round(entry)} · trail the rest with ${round(trail)} or a daily close ${dir} EMA20${valid(e20)?` (${round(e20)})`:''} · T2 ${round(t2)}${rr2?` (${rr2.toFixed(2)}R)`:''} · time stop: exit at the close if T1 is not hit within 10 sessions.`;
      return {...card, fillEntry:round(entry), target2:round(t2), trailStop:round(trail), rr1:rr1!=null?+rr1.toFixed(2):null, rr2:rr2!=null?+rr2.toFixed(2):null, exit};
    });
  }

  /* Sideways/choppy market: Strategy tab may show trigger levels, but must not
     label any long/short as active. These are conditional only. */
  if(ctx.bias === 'Sideways'){
    const longEntry = (valid(nearResistance) && nearResistance > price) ? nearResistance : (valid(r1) && r1 > price ? r1 : price + Math.max(atr, price*0.012));
    const shortEntry = (valid(nearSupport) && nearSupport < price) ? nearSupport : (valid(s1) && s1 < price ? s1 : price - Math.max(atr, price*0.012));
    const longStopBase = firstBelow(longEntry, pp, nearSupport, s1, s2, price - atr) || (longEntry - Math.max(atr*1.2, minMoveFrom(longEntry)));
    const shortStopBase = firstAbove(shortEntry, pp, nearResistance, r1, r2, price + atr) || (shortEntry + Math.max(atr*1.2, minMoveFrom(shortEntry)));
    const longStop = stopLongFromEntry(longEntry, longStopBase, longEntry - Math.max(atr*1.4, minMoveFrom(longEntry)));
    const shortStop = stopShortFromEntry(shortEntry, shortStopBase, shortEntry + Math.max(atr*1.4, minMoveFrom(shortEntry)));
    return [
      {name:'Breakout Long — conditional only', type:'Neutral Long Trigger', entry:`Wait. Buy only after close above ${entryText('resistance', longEntry)} with volume`, target:targetLongFromEntry(longEntry, nextResistance, r2, r3, farResistance), stoploss:round(longStop), rationale:'Sideways/choppy market. This is a trigger level only; do not treat it as an active buy.'},
      {name:'Breakdown Short — conditional only', type:'Neutral Short Trigger', entry:`Wait. Short only after close below ${entryText('support', shortEntry)} with volume`, target:targetShortFromEntry(shortEntry, nextSupport, s2, s3, farSupport), stoploss:round(shortStop), rationale:'Sideways/choppy market. This is a trigger level only; do not treat it as an active short.'}
    ];
  }

  const trendBull = Number.isFinite(e50) && Number.isFinite(e200) && price > e50 && e50 > e200;
  const trendBear = Number.isFinite(e50) && Number.isFinite(e200) && price < e50 && e50 < e200;
  const useBear = ctx.bias === 'Bearish' || (!trendBull && trendBear);
  const type = useBear ? 'Short' : 'Long';

  if(useBear){
    const emaEntry = valid(e20) ? e20 : nearResistance;
    const ema50Entry = valid(e50) ? e50 : nearResistance;
    const emaLike = v => valid(v) && valid(e20) && Math.abs(v - e20) / Math.max(Math.abs(e20), 1) * 100 < 0.5;
    const srAltResistance = resistances.find(v => !emaLike(v));
    const srEntry = valid(srAltResistance) ? srAltResistance : (valid(nextResistance) && !emaLike(nextResistance) ? nextResistance : nearResistance);
    const boEntry = valid(s1) ? s1 : price - Math.max(atr, price*0.015);
    const momEntry = price;
    const emaStop = stopShortFromEntry(emaEntry, Math.max(emaEntry, nearResistance) + atr*0.25);
    const ema50Stop = stopShortFromEntry(ema50Entry, Math.max(ema50Entry, nearResistance) + atr*0.35);
    const srStop  = stopShortFromEntry(srEntry, srEntry + atr*0.45);
    const boStop  = stopShortFromEntry(boEntry, Math.max(boEntry, valid(e20)?e20:boEntry) + atr*0.35);
    const momStop = stopShortFromEntry(momEntry, valid(e20)?e20+atr*0.25:momEntry+atr);
    return withExitPlans([
      {name:'EMA20 Rejection', type, entryPrice:R2(emaEntry), entry:`Sell/short near ${entryText('EMA20', emaEntry)} only after bearish rejection candle`, target:targetShortFromEntry(emaEntry, s1, s2, nextSupport, s3, farSupport), stoploss:round(emaStop), rationale:`Continuation short. Uses EMA20 rejection entry, not the S/R or breakdown trigger. Indicator EMA20 = ${valid(e20)?round(e20):'--'}.`},
      {name:'EMA50 Deep Rejection', type, entryPrice:R2(ema50Entry), entry:`Sell/short near ${entryText('EMA50', ema50Entry)} only after bearish rejection and close back below EMA50`, target:targetShortFromEntry(ema50Entry, s1, s2, nextSupport, s3, farSupport), stoploss:round(ema50Stop), rationale:`Deep bearish pullback/rejection. Valid only when EMA50 remains below EMA200 and price rejects the EMA50 zone.`},
      {name:'Resistance Bounce / Rejection', type, entryPrice:R2(srEntry), entry:`Sell/short near ${entryText('resistance', srEntry)} after rejection, not directly on support`, target:targetShortFromEntry(srEntry, s1, nextSupport, s2, farSupport), stoploss:round(srStop), rationale:'S/R strategy. Entry comes from resistance rejection; SL is above that resistance with ATR buffer. If EMA20 is the nearest resistance, this card uses the next separate resistance level to avoid duplicate EMA/SR setup numbers.'},
      {name:'Breakdown with Volume', type, entryPrice:R2(boEntry), entry:`Sell/short only below ${entryText('Swing S1', boEntry)} with volume and close below level`, target:round(Math.min(num(targetShortFromEntry(boEntry, s2, nextSupport, s3, farSupport)), boEntry - Math.max(atr*2, valid(r1)&&valid(s1) ? r1 - s1 : 0))), stoploss:round(boStop), rationale:'Breakdown strategy. Entry is the support-break level; SL is calculated from the breakdown trigger, not current price.'},
      {name:'Momentum Continuation', type, watchOnly:true, entryPrice:R2(momEntry), entry:`Watch-only (not a short signal): continue short near current price ${round(momEntry)} only while price stays below EMA20 ${valid(e20)?round(e20):'--'} and momentum remains bearish`, target:targetShortFromEntry(momEntry, nextSupport, s1, s2, farSupport), stoploss:round(momStop), rationale:'Momentum strategy. Uses current continuation entry; use smaller size if price is already far from EMA20 or RSI is oversold.'}
    ], 'short');
  }

  const emaEntry = valid(e20) ? e20 : nearSupport;
  const ema50Entry = valid(e50) ? e50 : nearSupport;
  const srEntry = SwingPlan.swingSupport({s1, s2}, price) || nearSupport;   /* 7D/14D swing low, as SwingPlan.longSetups */
  const boEntry = valid(r1) ? r1 : price + Math.max(atr, price*0.015);
  const preBoEntry = boEntry;
  const momEntry = price;
  const emaStop = stopLongFromEntry(emaEntry, Math.min(emaEntry, nearSupport) - atr*0.25);
  const ema50Stop = stopLongFromEntry(ema50Entry, Math.min(ema50Entry, nearSupport) - atr*0.35);
  const srStop  = stopLongFromEntry(srEntry, srEntry - atr*0.45);
  const preBoStop = stopLongFromEntry(preBoEntry, firstBelow(preBoEntry, e20, pp, nearSupport, s1, price-atr) || preBoEntry - Math.max(atr*1.5, minMoveFrom(preBoEntry)));
  const boStop  = stopLongFromEntry(boEntry, Math.min(boEntry, valid(e20)?e20:boEntry) - atr*0.35);
  const momStop = stopLongFromEntry(momEntry, valid(e20)?e20-atr*0.25:momEntry-atr);
  /* Stops/targets from the shared engine so the screener's R:R matches this card exactly. */
  const LS = SwingPlan.longSetups({ price, e20, e50, atr, sr:{ pp, r1, r2, r3, s1, s2, supports:supports.map(v=>({v})), resistances:resistances.map(v=>({v})) } });
  return withExitPlans([
    {name:'EMA20 Pullback', type, entryPrice:R2(emaEntry), entry:`Buy near ${entryText('EMA20', emaEntry)} only after bullish candle/volume confirmation`, target:round(LS['EMA20 Pullback'].target), stoploss:round(LS['EMA20 Pullback'].stop), rationale:`Preferred trend pullback. Uses exact Indicator EMA20; this is separate from support/resistance and breakout trigger.`},
    {name:'EMA50 Deep Pullback', type, entryPrice:R2(ema50Entry), entry:`Buy near ${entryText('EMA50', ema50Entry)} only after price closes at/above EMA50 with bounce confirmation`, target:round(LS['EMA50 Deep Pullback'].target), stoploss:round(LS['EMA50 Deep Pullback'].stop), rationale:`Deep trend pullback. Uses exact Indicator EMA50 and requires price recovery at/above EMA50; separate from EMA20 pullback.`},
    {name:'Support Bounce', type, entryPrice:R2(srEntry), entry:`Buy near ${entryText('support', srEntry)} after bounce confirmation`, target:round(LS['Support Bounce'].target), stoploss:round(LS['Support Bounce'].stop), rationale:'S/R strategy. Entry comes from support bounce; SL is below that support with ATR buffer.'},
    {name:'Pre-Breakout Watch', type, entryPrice:R2(preBoEntry), entry:`Watch for close above ${entryText('Swing R1', preBoEntry)} with volume. Do not enter before breakout confirmation.`, target:round(LS['Pre-Breakout Watch'].target), stoploss:round(LS['Pre-Breakout Watch'].stop), rationale:'Pre-breakout swing watch. Price is building below resistance; this creates a planned trigger before the 5% move instead of showing nothing.'},
    {name:'Breakout with Volume', type, entryPrice:R2(boEntry), entry:`Buy only above ${entryText('Swing R1', boEntry)} with volume and close above level`, target:round(LS['Breakout with Volume'].target), stoploss:round(LS['Breakout with Volume'].stop), rationale:'Breakout strategy. Entry is the resistance-break level; SL is calculated from the breakout trigger, not current price.'},
    {name:'Momentum Continuation', type, watchOnly:true, entryPrice:R2(momEntry), entry:`Watch-only (not a buy signal): continue long near current price ${round(momEntry)} only while price holds above EMA20 ${valid(e20)?round(e20):'--'} and momentum remains bullish`, target:round(LS['Momentum Continuation'].target), stoploss:round(LS['Momentum Continuation'].stop), rationale:'Momentum strategy. Uses current continuation entry; avoid chase if price is too far above EMA20 or RSI is overbought.'}
  ], 'long');
}
function buildLocalStrategyPlan(ctx){
  const {name, sym, rsi, macdD, adxR, e20, e50, e200, stResult, C, H, L, rec, weeklyRec} = ctx;
  const sr = ctx.srLevels || (CUR_DATA?.daily ? getSRTradeLevels() : null);
  const price = firstFiniteNumber(ctx.price, sr?.price, getCurrentLivePrice()) || 0;
  const pp = firstFiniteNumber(ctx.pp, sr?.pp, price);
  const r1 = firstFiniteNumber(ctx.r1, sr?.r1, price * 1.02);
  const r2 = firstFiniteNumber(ctx.r2, sr?.r2, r1, price * 1.04);
  const r3 = firstFiniteNumber(ctx.r3, sr?.r3, r2, price * 1.06);
  const s1 = firstFiniteNumber(ctx.s1, sr?.s1, price * 0.98);
  const s2 = firstFiniteNumber(ctx.s2, sr?.s2, s1, price * 0.96);
  const s3 = firstFiniteNumber(ctx.s3, sr?.s3, s2, price * 0.94);
  const atr = (()=>{
    if(!C || C.length < 16) return Math.max(price*0.015, Math.abs(r1-s1)||price*0.02);
    const tr=[];
    for(let i=1;i<C.length;i++) tr.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
    let a = tr.slice(0,14).reduce((x,y)=>x+y,0)/14;
    for(let i=14;i<tr.length;i++) a=(a*13+tr[i])/14;
    return a || Math.max(price*0.015, Math.abs(r1-s1)||price*0.02);
  })();

  const supports = (sr?.supports || []).map(x=>x.v).filter(v=>Number.isFinite(v) && v < price).sort((a,b)=>b-a);
  const resistances = (sr?.resistances || []).map(x=>x.v).filter(v=>Number.isFinite(v) && v > price).sort((a,b)=>a-b);
  const nearestSupport = supports[0] || (Number.isFinite(e50) && e50 < price ? e50 : s1);
  const nextSupport = supports[1] || s1 - Math.max(atr, Math.abs(r1-s1));
  const nearestResistance = resistances[0] || (Number.isFinite(e20) && e20 > price ? e20 : r1);
  const nextResistance = resistances[1] || r1 + Math.max(atr, Math.abs(r1-s1));

  let score = 0;
  if(rec?.value > 0.15) score += 1; else if(rec?.value < -0.15) score -= 1;
  if(weeklyRec?.value > 0.10) score += 1; else if(weeklyRec?.value < -0.10) score -= 1;
  if(Number.isFinite(e20) && price > e20) score += 0.75; else if(Number.isFinite(e20)) score -= 0.75;
  if(Number.isFinite(e50) && price > e50) score += 1; else if(Number.isFinite(e50)) score -= 1;
  if(Number.isFinite(e200) && price > e200) score += 1; else if(Number.isFinite(e200)) score -= 1;
  if(macdD?.hist > 0) score += 1; else if(macdD?.hist < 0) score -= 1;
  if(stResult?.dir === 1) score += 1; else if(stResult?.dir === -1) score -= 1;
  if(rsi >= 52 && rsi <= 68) score += 0.75;
  if(rsi > 72) score -= 0.75;
  if(rsi <= 48 && rsi >= 32) score -= 0.75;
  if(rsi < 28) score += 0.50;

  const trendStrong = (adxR?.adx || 0) >= 20;
  const adxVal = Number(adxR?.adx || 0);
  const choppyMarket = SwingPlan.isChoppy({price, r1, s1, rsi, adx:adxVal});   /* shared with the screener */
  const preferredBias = ['Bullish','Bearish','Sideways'].includes(ctx.bias) ? ctx.bias : (['Bullish','Bearish','Sideways'].includes(ctx.preferredBias) ? ctx.preferredBias : null);
  const bias = preferredBias || (choppyMarket ? 'Sideways' : (score >= 2.25 ? 'Bullish' : score <= -2.25 ? 'Bearish' : 'Sideways'));
  const round = v => fmt(R2(v));
  const minMove = Math.max(atr, price*0.012, Math.abs(r1-s1)*0.5 || 0);
  /* Named nearest levels for the header card (the same objects the S&R tab lists). The header used to show
     EMA50 as "support" and the target as "resistance", which matched nothing on the S&R tab. */
  const nearSupObj = (sr?.supports || []).filter(x => Number.isFinite(x.v) && x.v < price).sort((a,b) => b.v - a.v)[0] || null;
  const nearResObj = (sr?.resistances || []).filter(x => Number.isFinite(x.v) && x.v > price).sort((a,b) => a.v - b.v)[0] || null;
  const keyLevels = {
    support: round(nearestSupport), resistance: round(nearestResistance), pivot: round(pp),
    supportName: nearSupObj ? nearSupObj.n : (Number.isFinite(e50) && e50 < price ? 'EMA50 - no swing support below' : 'Swing S1'),
    resistanceName: nearResObj ? nearResObj.n : (Number.isFinite(e20) && e20 > price ? 'EMA20 - no swing resistance above' : 'Swing R1'),
    pivotName: 'Classic pivot (prev H+L+C)/3',
  };

  if(bias === 'Bullish'){
    const pullback = Number.isFinite(e20) && e20 < price ? e20 : nearestSupport;
    const entryZone = Number.isFinite(e20) ? e20 : pullback;
    let structuralSl = Number.isFinite(e50) && e50 < price ? e50 : nearestSupport;
    if(Number.isFinite(nearestSupport) && nearestSupport < price) structuralSl = Math.min(structuralSl, nearestSupport);
    structuralSl = structuralSl - atr*0.10;
    let sl = calcAtrStopLoss({side:'long', price, structuralStop:structuralSl, atr, fallbackStop:price-minMove, phase:'primary'});

    /* Swing standard: Active target starts at the nearest completed swing resistance (R1),
       then falls forward to R2/R3/nearestResistance if R1 is already crossed. */
    /* Nearest resistance at least 0.3 ATR above price. Taking the first of R1/R2/R3 above price skipped nearer
       levels: with R1 and R2 already crossed, Nifty 23,441 got R3 26,373 while 23,971 was the next level. */
    let t1 = [r1, r2, r3, nearestResistance].map(Number).filter(v => Number.isFinite(v) && v > price + atr*0.3).sort((a,b) => a-b)[0];
    if(!Number.isFinite(t1) || t1 <= price) t1 = price + Math.max(minMove, Math.abs(price-sl)*1.5);

    const ema20EntryText = Number.isFinite(e20) ? `EMA20 ${round(e20)}` : `support ${round(pullback)}`;
    const entry = price > (e20 || 0)
      ? `Buy pullback near ${ema20EntryText} or breakout above Swing R1 ${round(r1)} only with bullish candle/volume`
      : `Wait: buy only after close back above ${ema20EntryText} with volume`;
    return {
      bias,
      four_strategy_setups: buildFourStrategyTradeSetups({...ctx, price, pp, r1, r2, r3, s1, s2, s3, srLevels:sr, bias}),
      strategy_name: trendStrong ? 'Bullish Swing Pullback / Breakout Setup' : 'Bullish Swing Pullback Setup',
      summary: `${name} is bullish only while price holds above EMA20/EMA50. Target uses the nearest valid resistance from the 14/21-day swing levels.`,
      setups:[
        {name:'Bullish Swing Pullback / Breakout', type:'Long', entry, target:round(t1), stoploss:round(sl), rationale:'Fallback swing logic only: price above trend EMAs; entry near EMA20/R1 breakout, ATR-adjusted stop below EMA50/support, target at the selected swing resistance.'}
      ],
      key_levels:keyLevels,
      risk_note:(Number.isFinite(t1) && t1 > price && ((t1-price)/price*100) <= 2 ? 'Do not buy directly under target resistance. Wait for breakout confirmation or pullback.' : 'Price is not directly under resistance; wait for clean EMA/support bounce or breakout confirmation.'), best_timeframe: trendStrong ? '1hr / Daily' : 'Daily'
    };
  }

  if(bias === 'Bearish'){
    const bounce = Number.isFinite(e20) && e20 > price ? e20 : nearestResistance;
    let structuralSl = Number.isFinite(e20) && e20 > price ? e20 : nearestResistance;
    if(Number.isFinite(nearestResistance) && nearestResistance > price) structuralSl = Math.max(structuralSl, nearestResistance);
    structuralSl = structuralSl + atr*0.10;
    let sl = calcAtrStopLoss({side:'short', price, structuralStop:structuralSl, atr, fallbackStop:price+minMove, phase:'primary'});

    /* Bearish swing standard: Active target = 14D low (S2) or next valid support.
       If price has already broken those levels, fall forward to next valid support/ATR target. */
    let t1 = [s1, s2, s3, nearestSupport].map(Number).filter(v => Number.isFinite(v) && v < price - atr*0.3).sort((a,b) => b-a)[0];   /* nearest support, as the long side */
    if(!Number.isFinite(t1) || t1 >= price) t1 = price - Math.max(minMove, Math.abs(sl-price)*1.5);

    const resistanceAlt = Number.isFinite(nearestResistance) && (!Number.isFinite(e20) || Math.abs(nearestResistance - e20) > Math.max(price*0.002, 0.5))
      ? ` / resistance ${round(nearestResistance)}`
      : '';
    const ema20RejectText = Number.isFinite(e20) ? `EMA20 ${round(e20)}${resistanceAlt}` : `resistance ${round(bounce)}`;
    const entry = price < (e50 || Infinity)
      ? `Sell/short on bounce rejection near ${ema20RejectText} or breakdown below Swing S1 ${round(s1)} with bearish candle/volume`
      : `Wait: bearish setup only after close below EMA50 ${round(e50 || price)} with volume`;
    return {
      bias,
      four_strategy_setups: buildFourStrategyTradeSetups({...ctx, price, pp, r1, r2, r3, s1, s2, s3, srLevels:sr, bias}),
      strategy_name: trendStrong ? 'Bearish Swing Rejection / Breakdown Setup' : 'Bearish Swing Rejection Setup',
      summary: `${name} is bearish only while price stays below EMA50 and rejects EMA20/resistance. Target uses the nearest valid support from the 14/21-day swing levels.`,
      setups:[
        {name:'Bearish Swing Rejection / Breakdown', type:'Short', entry, target:round(t1), stoploss:round(sl), rationale:'Fallback swing logic only: bearish stock; close below EMA50, ATR-adjusted stop above EMA20/resistance, target at the selected swing support.'}
      ],
      key_levels:keyLevels,
      risk_note:'Do not short directly on support. If price is far below EMA20, wait for bounce rejection or clean S1 breakdown confirmation.', best_timeframe: trendStrong ? '1hr / Daily' : 'Daily'
    };
  }

  return {
    bias:'Sideways', four_strategy_setups: buildFourStrategyTradeSetups({...ctx, price, pp, r1, r2, r3, s1, s2, s3, srLevels:sr, bias:'Sideways'}), strategy_name:'Wait for Breakout / Breakdown',
    summary:`${name} has mixed signals. Do not force a trade; use live S/R levels and wait for breakout above ${round(nearestResistance)} or breakdown below ${round(nearestSupport)}.`,
    setups:[
      {name:'Breakout Long — conditional only', type:'Neutral Long Trigger', entry:`Wait. Long only after close above ${round(nearestResistance)} with volume`, target:round(nextResistance), stoploss:round(Math.max(pp, nearestSupport)), rationale:'Only confirmed breakout gives directional edge. Not an active buy while market is sideways.'},
      {name:'Breakdown Short — conditional only', type:'Neutral Short Trigger', entry:`Wait. Short only after close below ${round(nearestSupport)} with volume`, target:round(nextSupport), stoploss:round(Math.min(pp, nearestResistance)), rationale:'Only confirmed breakdown gives downside edge. Not an active short while market is sideways.'}
    ], key_levels:keyLevels,
    risk_note:'Sideways market gives false signals. Wait for confirmation or reduce size heavily.', best_timeframe:'1hr / Daily'
  };
}


function computeMasterSwingBiasFromLoadedData(sym){
  const d = CUR_DATA?.daily || {}, C=d.C||[], H=d.H||[], L=d.L||[], V=d.V||[], O=d.O||[];
  const n=C.length, price=getCurrentLivePrice();
  if(!n || !Number.isFinite(+price)) return 'Sideways';
  const sr = getSRTradeLevels();
  const {r1,s1} = sr;
  const dr=sigRec(CUR_DATA.daily?.rec?.value), wr=sigRec(CUR_DATA.weekly?.rec?.value ?? 0);
  const rsiV=calcRSI(C), rsiS=sigRSI(rsiV);
  const macdD=calcMACD(C), ms=sigMACD(macdD?.macd, macdD?.signal);
  const adxR=calcADX(C,H,L), adxS=sigADX(adxR?.adx, adxR?.pdi, adxR?.ndi);
  const e20=emaLast(C,20), e50=emaLast(C,50), e200=emaLast(C,200), emaSig=sigEMA(price,e20,e50,e200);
  const prev=firstFiniteNumber(CUR_DATA.prevDayClose, CUR_DATA.pc, C[n-2], C[n-1], price);
  const volEnd=Math.max(0, Math.min(V.length,n)-1);
  const volBase20=V.slice(Math.max(0, volEnd-20), volEnd);
  const avgVol20=volBase20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase20.length);
  const volSig=sigVolume(V[n-1]||0, avgVol20, price-prev);
  const pats=detectPatterns(CUR_DATA.daily, getConfirmedDailyIndex(CUR_DATA.daily));
  const pBull=pats.filter(p=>p.s==='bull'||p.s==='strong-bull').length, pBear=pats.filter(p=>p.s==='bear'||p.s==='strong-bear').length;
  const patSig=pBull>pBear?{c:'bull'}:pBear>pBull?{c:'bear'}:{c:'neutral'};
  const scoreMap={ 'strong-bull':2, bull:1, neutral:0, bear:-1, 'strong-bear':-2, na:0 };
  const raw=[dr,wr,emaSig,rsiS,ms,volSig,patSig,adxS].reduce((a,x)=>a+(scoreMap[x?.c]||0),0);
  const adxVal=Number(adxR?.adx||0);
  const priceOk=Number.isFinite(+price), e20Ok=Number.isFinite(+e20), e50Ok=Number.isFinite(+e50);
  const choppy=SwingPlan.isChoppy({price, r1, s1, rsi:rsiV, adx:adxVal});   /* shared with the screener */
  if(!choppy && raw>=3 && e50Ok && price>e50 && (adxVal>=16 || (r1 != null && Number.isFinite(+r1) && +r1>0 && price>r1*1.002) || (e20Ok && e20>e50))) return 'Bullish';
  if(!choppy && raw<=-3 && e50Ok && price<e50 && (adxVal>=16 || (s1 != null && Number.isFinite(+s1) && +s1>0 && price<s1*0.998) || (e20Ok && e20<e50))) return 'Bearish';
  return 'Sideways';
}

async function tabStrategy(sym){
  const live = tcGuard();
  const name = document.getElementById('ihn').textContent;
  const tc = document.getElementById('tc');

  /* ── Part 1: AI Trade Setups (existing) ── */
  const key = `strat_${sym}`;
  const {C,H,L} = CUR_DATA.daily, n = C.length;
  const srLevels = getSRTradeLevels();
  const price = srLevels.price;
  const {pp, r1, r2, r3, s1, s2, s3} = srLevels;
  const rsi=calcRSI(C), macdD=calcMACD(C), adxR=calcADX(C,H,L);
  const e20=emaLast(C,20), e50=emaLast(C,50), e200=emaLast(C,200);
  const stResult=calcSuperTrend(C,H,L), bb=calcBB(C);
  const V = CUR_DATA.daily.V || [];
  const volEnd = Math.max(0, Math.min(V.length, n) - 1);
  const volBase20 = V.slice(Math.max(0, volEnd - 20), volEnd);
  const volBase3 = V.slice(Math.max(0, volEnd - 3), volEnd);
  const avgVol20 = volBase20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase20.length);
  const avgVol3 = volBase3.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase3.length);
  const todayVol = (n > 0 && V.length >= n) ? (Number(V[n-1])||0) : (Number(V[V.length-1])||0);
  const volRatio = avgVol20 ? todayVol / avgVol20 : 0;
  const volBlend = (volRatio||0)*0.6 + ((avgVol20&&volBase3.length?avgVol3/avgVol20:volRatio)||0)*0.4;
  const rec=CUR_DATA.daily.rec, weeklyRec=CUR_DATA.weekly?.rec;

  /* Deterministic swing-trade plan. Overview/Decision bias is master; Strategy must not show an active setup when master bias is Sideways. */
  const masterBias = computeMasterSwingBiasFromLoadedData(sym);
  let strat = buildLocalStrategyPlan({name, sym, price, rsi, macdD, adxR, e20, e50, e200, stResult, pp, r1, r2, r3, s1, s2, s3, C, H, L, rec, weeklyRec, srLevels, bias:masterBias});
  if(masterBias === 'Sideways' && strat.bias !== 'Sideways'){
    const supports = (srLevels?.supports || []).map(x=>x.v).filter(v=>Number.isFinite(v) && v < price).sort((a,b)=>b-a);
    const resistances = (srLevels?.resistances || []).map(x=>x.v).filter(v=>Number.isFinite(v) && v > price).sort((a,b)=>a-b);
    const nearestSupport = supports[0] || (Number.isFinite(e50) && e50 < price ? e50 : s1);
    const nextSupport = supports[1] || s2 || nearestSupport - Math.max(Math.abs(r1-s1)||price*0.02, price*0.015);
    const nearestResistance = resistances[0] || (Number.isFinite(e20) && e20 > price ? e20 : r1);
    const nextResistance = resistances[1] || r2 || nearestResistance + Math.max(Math.abs(r1-s1)||price*0.02, price*0.015);
    const atrLocal = calcATRFromBars(C,H,L,price,firstFiniteNumber(CUR_DATA.prevDayClose,C[n-2],price),14);
    strat = buildPreferredSidewaysStrategyPlan({name, price, pp, nearestSupport, nextSupport, nearestResistance, nextResistance, atr:atrLocal});
  }
  AI_CACHE[key] = strat;
  const biasC = strat.bias==='Bullish'?'bull':strat.bias==='Bearish'?'bear':'neutral';
  const showOptions = isIndexSymbol(sym);   /* index page = Option Builder only (the options idea is on Market Pulse) */
  const selectedTradePlan = await getStrategyTradePlan(sym, name, masterBias).catch(()=>null);
  const selectedSetup = selectedTradePlan?.isActive ? selectedTradePlan.setup : null;
  const selectedPlanCurrentRR = selectedTradePlan?.isActive
    ? calcTradePlanRiskReward({bias:selectedTradePlan.bias, price: (selectedTradePlan.bias === 'Bullish' && /breakout/i.test(selectedTradePlan.setupName || '') && Number.isFinite(+selectedTradePlan.entryPrice)) ? Math.max(price, +selectedTradePlan.entryPrice) : price, stopLoss:selectedTradePlan.stopLoss, target1:selectedTradePlan.target1, atr:calcATRFromBars(C,H,L,price,firstFiniteNumber(CUR_DATA.prevDayClose,C[n-2],price),14)})
    : null;
  const selectedPlanAtEntryRR = selectedTradePlan?.isActive && Number.isFinite(+selectedTradePlan.entryPrice) && Number.isFinite(+selectedTradePlan.stopLoss) && Number.isFinite(+selectedTradePlan.target1) && Math.abs(+selectedTradePlan.entryPrice-+selectedTradePlan.stopLoss)>0
    ? Math.abs(+selectedTradePlan.target1-+selectedTradePlan.entryPrice)/Math.abs(+selectedTradePlan.entryPrice-+selectedTradePlan.stopLoss)
    : null;
  const selectedPlanNote = selectedSetup
    ? (selectedPlanCurrentRR?.valid && selectedPlanCurrentRR.rr >= SWING_MIN_RR
        ? `Candidate setup. Current-price RR ${selectedPlanCurrentRR.rr.toFixed(2)}:1 is acceptable; Overview/Decision still must pass score and confirmation gates.`
        : `Candidate setup only — not a buy signal now. Planned RR near entry ${selectedPlanAtEntryRR!=null?selectedPlanAtEntryRR.toFixed(2)+':1':'--'}; current-price RR ${selectedPlanCurrentRR?.valid?selectedPlanCurrentRR.rr.toFixed(2)+':1':'not valid'} is weak or unconfirmed.`)
    : '';
  const setupCardHtml = (s, note='') => `<div class="setup-card ${s.type==='Long'?'bull-card':s.type==='Short'?'bear-card':'neu-card'}"><div class="setup-name"><span class="setup-tag ${s.type==='Long'?'tag-bull':s.type==='Short'?'tag-bear':'tag-opt'}">${s.type}</span>${escHtml(s.name)}</div><div class="setup-detail"><strong style="color:var(--tx)">Entry:</strong> ${s.entry}<br><strong style="color:var(--bull)">Target:</strong> ${s.target} · <strong style="color:var(--bear)">SL:</strong> ${s.stoploss}<br><span style="color:var(--tx2)">${escHtml(s.rationale)}</span>${s.exit?`<br><span class="setup-exit">${escHtml(s.exit)}</span>`:''}${note?`<br><span style="color:${/not a buy signal|not active|weak or unconfirmed/i.test(note)?'var(--neu)':'var(--acc)'};font-weight:800">${note}</span>`:''}</div></div>`;
  const selectedSetupHtml = selectedSetup
    ? setupCardHtml(selectedSetup, selectedPlanNote)
    : `<div class="setup-card neu-card"><div class="setup-name"><span class="setup-tag tag-opt">WAIT</span>No Active Strategy Selected</div><div class="setup-detail"><strong style="color:var(--tx)">Entry:</strong> Wait<br><strong style="color:var(--bull)">Target:</strong> Wait · <strong style="color:var(--bear)">SL:</strong> Wait<br><span style="color:var(--tx2)">Sideways/choppy or weak setup. The 4 strategy cards below are conditional ideas only; Overview must not show an active trade.</span></div></div>`;

  /* ── OPTIONS BIAS PANEL — compute Bull/Bear/Range verdict from A/D ratio, India VIX, IV Percentile and swing decision score ── */
  const vix      = GLOBAL_DATA?.vix?.price ?? null;
  const ivRank   = GLOBAL_DATA?.ivRank?.rank ?? null;   /* ?? keeps a real 0% (VIX at its 1-year low) */
  const adRatio  = GLOBAL_DATA?.breadth?.adRatio ?? null;

  const stResult2 = calcSuperTrend(C,H,L);
  const macdD2    = calcMACD(C);
  const rsi2      = calcRSI(C);

  /* Use real swing decision score cache if available — else quick estimate from available data */
  const cachedScore = AI_CACHE[`s10_${sym}`];
  const realS10     = cachedScore?.s10 ?? null;
  const scoreRatio  = realS10 != null ? realS10 / 10
    : (() => {
        /* Quick estimate using data already in scope */
        const _dr  = sigRec(CUR_DATA.daily.rec.value);
        const _wr  = sigRec(CUR_DATA.weekly?.rec?.value ?? 0);
        const _e50 = emaLast(C, 50), _e200 = emaLast(C, 200);
        const _price = C[C.length - 1];
        /* Symmetric bull/bear points in [-8, +8], mapped to 0..1 (old version capped bear at -1 per
           input and divided an 8-point max by 7, so the ratio could exceed 1 and leaned bullish). */
        const _emaVals = [_e50, _e200].filter(v => Number.isFinite(v) && v > 0);
        let pts = 0;
        if (_dr.c==='bull'||_dr.c==='strong-bull') pts+=2; else if (_dr.c==='bear'||_dr.c==='strong-bear') pts-=2;
        if (_wr.c==='bull'||_wr.c==='strong-bull') pts+=2; else if (_wr.c==='bear'||_wr.c==='strong-bear') pts-=2;
        _emaVals.forEach(v => { pts += _price > v ? 1 : -1; });
        if (macdD2?.hist > 0) pts++; else if (macdD2?.hist < 0) pts--;
        if (rsi2 > 50 && rsi2 < 70) pts++; else if (rsi2 < 50 && rsi2 > 30) pts--;
        return Math.max(0, Math.min(1, (pts + 8) / 16));
      })();
  const scoreBias    = scoreRatio > 0.65 ? 'bull' : scoreRatio < 0.4 ? 'bear' : 'neutral';
  const scoreDisplay = realS10 != null ? `${realS10}/10` : `${Math.max(1,Math.min(10,Math.round(scoreRatio*10)))}/10`;

  const makeOptionQuality = makeOptionsQualityCore;


  /* Volatility is not direction. Low VIX / low IV percentile = options are cheap, which favours DEBIT
     strategies in whatever direction the trend points ('directional'); it is never a bullish vote by
     itself. Same rule as buildIndexOptionsDecisionSnapshot (Decision tab). */
  const vixBias = vix === null ? 'neutral'
    : vix < 14  ? 'directional'
    : vix < 20  ? 'neutral'
    : 'range';              /* high VIX = sell premium, Iron Condor */

  /* IV Percentile bias */
  const ivBias = ivRank === null ? 'neutral'
    : ivRank < 30 ? 'directional'
    : ivRank > 70 ? 'range'  /* options expensive → sell premium */
    : 'neutral';

  /* A/D bias */
  const adBias = !adRatio ? 'neutral'
    : adRatio > 1.5 ? 'bull'
    : adRatio < 0.7 ? 'bear'
    : 'neutral';

  /* Final options verdict */
  const biasInputs = [adBias, vixBias, ivBias, scoreBias];
  let bCount = biasInputs.filter(b=>b==='bull').length;
  let bearCount = biasInputs.filter(b=>b==='bear').length;
  const rangeCount = biasInputs.filter(b=>b==='range').length;
  /* Cheap IV only strengthens an existing direction (mirrors the Decision tab). */
  if(ivBias==='directional' && scoreBias==='bull') bCount += 1;
  if(ivBias==='directional' && scoreBias==='bear') bearCount += 1;

  let optVerdict, optVerdictCol, optVerdictDesc, suggestedStrat;
  if (bCount >= 3) {
    optVerdict='🐂 BULLISH'; optVerdictCol='var(--bull)';
    optVerdictDesc='Real loaded signals favour upside. Consider Bull Call Spread or Bull Put Spread.';
    suggestedStrat='bull_call_spread';
  } else if (bearCount >= 3) {
    optVerdict='🐻 BEARISH'; optVerdictCol='var(--bear)';
    optVerdictDesc='Real loaded signals favour downside. Consider Bear Put Spread or Bear Call Spread.';
    suggestedStrat='bear_put_spread';
  } else if (rangeCount + (biasInputs.filter(b=>b==='neutral').length) >= 3 || (vixBias==='range'&&ivBias==='range')) {
    optVerdict='🦅 RANGE TRADE'; optVerdictCol='var(--neu)';
    optVerdictDesc='High IV or mixed signals. Iron Condor or Short Strangle to collect premium.';
    suggestedStrat='iron_condor';
  } else if (bCount > bearCount) {
    optVerdict='↗ MILDLY BULLISH'; optVerdictCol='var(--bull)';
    optVerdictDesc='Lean bullish but not strong. Bull Call Spread limits risk.';
    suggestedStrat='bull_call_spread';
  } else if (bearCount > bCount) {
    optVerdict='↘ MILDLY BEARISH'; optVerdictCol='var(--bear)';
    optVerdictDesc='Lean bearish. Bear Put Spread or Bear Call Spread.';
    suggestedStrat='bear_call_spread';
  } else {
    optVerdict='⚖ NEUTRAL'; optVerdictCol='var(--neu)';
    optVerdictDesc='No clear directional edge. Range-bound strategy suits best.';
    suggestedStrat='iron_condor';
  }

  /* Index: use the options idea's verdict (computed above with the same VIX / IV percentile / trend / breadth),
     so the panel cannot say "RANGE TRADE -> Iron Condor" under an idea card that says "Bullish -> Bull Put". */
  const ideaX = (typeof LAST_IDX_IDEA !== 'undefined' && LAST_IDX_IDEA && LAST_IDX_IDEA.sym === sym && LAST_IDX_IDEA.s) ? LAST_IDX_IDEA : null;
  if (ideaX) {
    const v = ideaX.view, s = ideaX.s;
    optVerdict = v === 'Bullish' ? '🐂 BULLISH' : v === 'Bearish' ? '🐻 BEARISH' : '🦅 RANGE TRADE';
    optVerdictCol = v === 'Bullish' ? 'var(--bull)' : v === 'Bearish' ? 'var(--bear)' : 'var(--neu)';
    optVerdictDesc = `Same verdict as Today's options idea: ${v}, options ${ideaX.vol} → ${s.name}.`;
    suggestedStrat = s.id === 'calendar' ? 'iron_condor' : s.id;
  }
  const expiryDays = Math.max(1, Math.min(90, +OPT_STATE.expiry || 30));
  const optQ = makeOptionQuality(suggestedStrat, bCount, bearCount, rangeCount, ivRank, vix, expiryDays);
  AI_CACHE[`optq_${sym}`] = {score100:optQ.score100, grade:optQ.grade, rows:optQ.rows, ts:Date.now()};
  const optQualityPanel = `<div class="tp-section" style="border-color:${optQ.col}">
    <div class="tp-section-title">Options Strategy Quality Score</div>
    <div class="tp-score-head ${optQ.score100>=70?'bull':optQ.score100>=55?'neutral':'bear'}"><div><span class="tp-score-num">${optQ.score100}</span><span class="tp-score-total">/100</span></div><div class="tp-grade" style="color:${optQ.col}">${optQ.grade}</div></div>
    <div class="tp-score-bar"><div style="width:${optQ.score100}%;background:${optQ.col}"></div></div>
    <div class="aib" style="margin-bottom:10px"><strong>${optQ.label}</strong>. This is separate from stock swing score. It measures IV, bias clarity, option-chain availability, payoff risk and expiry safety.</div>
    <div class="tp-quality-list">${optQ.rows.map(r=>`<div class="tp-qrow"><div><strong>${r.name}</strong><span>${r.note}</span></div><b>${r.pts}/${r.max}</b></div>`).join('')}</div>
  </div>`;

  function biasBadge(b) {
    return b==='bull' ? `<span style="font-size:.75rem;padding:2px 7px;border-radius:20px;background:var(--bullb);color:var(--bull);font-weight:700">BULL</span>`
         : b==='bear' ? `<span style="font-size:.75rem;padding:2px 7px;border-radius:20px;background:var(--bearb);color:var(--bear);font-weight:700">BEAR</span>`
         : b==='range'? `<span style="font-size:.75rem;padding:2px 7px;border-radius:20px;background:var(--neub);color:var(--neu);font-weight:700">RANGE</span>`
         : b==='directional'? `<span style="font-size:.75rem;padding:2px 7px;border-radius:20px;background:var(--bgi);color:var(--acc);font-weight:700">LOW IV</span>`
         :              `<span style="font-size:.75rem;padding:2px 7px;border-radius:20px;background:var(--bgi);color:var(--tx3);font-weight:700">NEUT</span>`;
  }

  const optBiasPanel = `
    <div style="background:var(--bgc);border:2px solid ${optVerdictCol};border-radius:var(--r);padding:16px 18px;margin-bottom:14px">
      <div style="font-size:.7rem;font-weight:800;color:var(--tx3);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">⚙ Options Strategy Bias</div>
      <div style="font-size:1.3rem;font-weight:800;color:${optVerdictCol};margin-bottom:4px">${optVerdict}</div>
      <div style="font-size:.78rem;color:var(--tx2);margin-bottom:14px">${optVerdictDesc}</div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:12px">
        <div style="background:var(--bgp);border-radius:var(--rs);padding:8px 6px;text-align:center">
          <div style="font-size:.75rem;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">A/D Ratio</div>
          <div style="font-size:.85rem;font-weight:800;color:${adBias==='bull'?'var(--bull)':adBias==='bear'?'var(--bear)':'var(--neu)'}">${adRatio||'--'}</div>
          ${biasBadge(adBias)}
        </div>
        <div style="background:var(--bgp);border-radius:var(--rs);padding:8px 6px;text-align:center">
          <div style="font-size:.75rem;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">India VIX</div>
          <div style="font-size:.85rem;font-weight:800;color:${vix?(vix<14?'var(--bull)':vix<20?'var(--neu)':'var(--bear)'):'var(--tx3)'}">${vix?.toFixed(1)||'--'}</div>
          ${biasBadge(vixBias)}
        </div>
        <div style="background:var(--bgp);border-radius:var(--rs);padding:8px 6px;text-align:center">
          <div style="font-size:.75rem;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">IV Percentile</div>
          <div style="font-size:.85rem;font-weight:800;color:${ivRank?(ivRank<30?'var(--bull)':ivRank>70?'var(--bear)':'var(--neu)'):'var(--tx3)'}">${ivRank!=null?ivRank+'%':'--'}</div>
          ${biasBadge(ivBias)}
          <div style="font-size:.72rem;color:var(--tx3)">${GLOBAL_DATA?.ivRank?.daysBelow!=null?GLOBAL_DATA.ivRank.daysBelow+'/'+GLOBAL_DATA.ivRank.totalDays+'d':'% days below'}</div>
        </div>
        <div style="background:var(--bgp);border-radius:var(--rs);padding:8px 6px;text-align:center">
          <div style="font-size:.75rem;color:var(--tx3);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${isIndexSymbol(sym)?'Index Directional Bias':'Directional Swing Bias'}</div>
          <div style="font-size:.85rem;font-weight:800;color:${scoreBias==='bull'?'var(--bull)':scoreBias==='bear'?'var(--bear)':'var(--neu)'}">${scoreDisplay}</div>
          ${biasBadge(scoreBias)}
          ${realS10==null?`<div style="font-size:.72rem;color:var(--tx3)">est.</div>`:`<div style="font-size:.72rem;color:var(--tx3)">${isIndexSymbol(sym)?'from index decision':'from Decision tab'}</div>`}
        </div>
      </div>

      <div style="font-size:.72rem;color:var(--tx3);border-top:1px solid var(--brd);padding-top:8px">
        Suggested strategy: <strong style="color:${optVerdictCol}">${suggestedStrat.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</strong>
        <button onclick="OPT_STATE.strategy='${suggestedStrat}';OPT_STATE.strikes=[];document.querySelectorAll('.opt-btn').forEach(b=>b.classList.toggle('active',b.dataset.sid==='${suggestedStrat}'));loadOptionStrategy(${jsArg(sym)},'${suggestedStrat}')"
          style="margin-left:10px;padding:3px 12px;background:${optVerdictCol};border:none;border-radius:var(--rs);color:#000;font-size:.72rem;font-weight:800;cursor:pointer">Apply →</button>
        <span style="float:right;font-size:.75rem">A/D + VIX + IV Percentile + Directional bias</span>
      </div>
    </div>`;

  const suitabilityRows = [
    {name:'Bull Call Spread', id:'bull_call_spread', ok:bCount>bearCount && ivBias!=='range', why:'Defined-risk bullish debit spread. Better than naked call when direction is bullish but IV is not very cheap.'},
    {name:'Bear Put Spread', id:'bear_put_spread', ok:bearCount>bCount && ivBias!=='range', why:'Defined-risk bearish debit spread. Useful when trend/breadth lean down.'},
    {name:'Bull Put Spread', id:'bull_put_spread', ok:bCount>=bearCount && ivBias==='range' && expiryDays>=7, why:'Credit spread for mildly bullish/range market. Needs discipline because premium is theoretical here.'},
    {name:'Bear Call Spread', id:'bear_call_spread', ok:bearCount>=bCount && ivBias==='range' && expiryDays>=7, why:'Credit spread for mildly bearish/range market. Avoid if price is breaking out upward.'},
    {name:'Iron Condor', id:'iron_condor', ok:(optVerdict.includes('RANGE') || (Math.abs(bCount-bearCount)<=1 && ivBias==='range')) && expiryDays>=7, why:'Best only when market is range-bound and IV is high/fair. Not for trending breakout days.'},
    {name:'Long Straddle/Strangle', id:'long_straddle', ok:ivBias==='directional' && expiryDays>=10 && Math.abs(bCount-bearCount)<=1, why:'Only when options are relatively cheap and you expect a large move. Avoid near expiry.'},
  ];
  let bestSuit = suitabilityRows.filter(x=>x.ok).slice(0,3);
  const fallbackSuit = suitabilityRows.find(x=>x.id===suggestedStrat);
  if(!bestSuit.length && fallbackSuit) bestSuit = [fallbackSuit];
  const bestIds = new Set(bestSuit.map(x=>x.id));
  const avoidSuit = suitabilityRows.filter(x=>!x.ok && !bestIds.has(x.id)).slice(0,3);
  const suitCard = (x, good) => `<div class="tp-qrow"><div><strong>${good?'✅':'⚠️'} ${x.name}</strong><span>${x.why}</span></div><button onclick="OPT_STATE.strategy='${x.id}';OPT_STATE.strikes=[];document.querySelectorAll('.opt-btn').forEach(b=>b.classList.toggle('active',b.dataset.sid==='${x.id}'));loadOptionStrategy(${jsArg(sym)},'${x.id}')" style="background:${good?'var(--acc)':'var(--bgi)'};border:1px solid var(--brdl);border-radius:var(--rs);padding:4px 10px;color:${good?'#000':'var(--tx2)'};font-size:.72rem;font-weight:800;cursor:pointer">${good?'Use':'Check'}</button></div>`;
  const lowFitHtml = avoidSuit.length
    ? avoidSuit.map(x=>suitCard(x,false)).join('')
    : `<div class="aib">No separate low-fit strategy after removing duplicates from Best Fit.</div>`;
  const suitabilityPanel = `<div class="tp-section"><div class="tp-section-title">Strategy Suitability Engine — No Option-Chain Required</div>
    <div class="aib" style="margin-bottom:10px">Uses only loaded data: A/D ratio, VIX, IV percentile, trend score and expiry days. It does not use PCR/OI and it does not pretend to know live bid/ask premium.</div>
    <div class="tp-mini-grid"><div class="tp-mini"><h4>Best Fit Now</h4><p><strong style="color:${optVerdictCol}">${optVerdict.replace(/[🐂🐻🦅⚖↗↘]/g,'').trim()}</strong><br>${optVerdictDesc}</p></div><div class="tp-mini"><h4>Expiry Risk</h4><p>${expiryDays<5?'Very high gamma/theta risk. Avoid positional option buying/selling unless it is intraday.':expiryDays<10?'Short expiry. Use defined-risk spreads and smaller size.':'Expiry is workable for defined-risk spreads.'}</p></div></div>
    <div class="tp-quality-list" style="margin-top:10px">${bestSuit.filter(Boolean).map(x=>suitCard(x,true)).join('')}</div>
    <div class="tp-section-title" style="margin-top:12px">Avoid / Low Fit</div>
    <div class="tp-quality-list">${lowFitHtml}</div>
  </div>`;

  /* ── Part 2: Options Strategy Selector ── */
  const presetLot = LOT_PRESETS[sym] || '';
  const currentLot = OPT_STATE.lot || presetLot || '';

  const stratBtns = STRAT_LIST.map(s => `
    <button onclick="OPT_STATE.strategy='${s.id}';OPT_STATE.strikes=[];document.querySelectorAll('.opt-btn').forEach(b=>b.classList.toggle('active',b.dataset.sid==='${s.id}'));loadOptionStrategy(${jsArg(sym)},'${s.id}')"
      class="opt-btn${OPT_STATE.strategy===s.id?' active':''}" data-sid="${s.id}"
      style="display:flex;flex-direction:column;align-items:center;gap:3px;padding:8px 10px;background:var(--bgc);border:1px solid ${OPT_STATE.strategy===s.id?'var(--acc)':'var(--brd)'};border-radius:var(--rs);cursor:pointer;min-width:90px;transition:all .15s;${OPT_STATE.strategy===s.id?'background:rgba(0,188,212,.1);':''}"
      title="${s.outlook}">
      <span style="font-size:1.1rem">${s.icon}</span>
      <span style="font-size:.75rem;font-weight:700;color:${OPT_STATE.strategy===s.id?'var(--acc)':'var(--tx2)'};text-align:center;line-height:1.2">${s.name}</span>
      <span style="font-size:.75rem;color:var(--tx3)">${s.type}</span>
    </button>`).join('');

  const html = `${showOptions ? '' : `
    <!-- ─── AI TRADE SETUP (existing) ─── -->
    <div class="strat-hero">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">${bdg({l:'Live Data Based',c:'neutral'})} <div class="strat-title">${selectedTradePlan?.isActive ? escHtml(selectedTradePlan.setupName) : strat.strategy_name}</div>${bdg({l:strat.bias,c:biasC})}<span class="tf-badge">Best TF:<b>${strat.best_timeframe}</b></span></div>
      <div class="strat-sub">${escHtml(strat.summary)}</div>
      <div class="strat-grid"><div class="strat-cell"><div class="strat-label">Support</div><div class="strat-val" style="color:var(--bull)">${strat.key_levels?.support}</div>${strat.key_levels?.supportName ? `<div class="strat-lvl-name">${escHtml(strat.key_levels.supportName)}</div>` : ''}</div><div class="strat-cell"><div class="strat-label">Pivot</div><div class="strat-val" style="color:var(--neu)">${strat.key_levels?.pivot}</div>${strat.key_levels?.pivotName ? `<div class="strat-lvl-name">${escHtml(strat.key_levels.pivotName)}</div>` : ''}</div><div class="strat-cell"><div class="strat-label">Resistance</div><div class="strat-val" style="color:var(--bear)">${strat.key_levels?.resistance}</div>${strat.key_levels?.resistanceName ? `<div class="strat-lvl-name">${escHtml(strat.key_levels.resistanceName)}</div>` : ''}</div></div>
      <div style="font-size:.75rem;color:var(--bear);padding:6px 10px;background:var(--bearb);border-radius:var(--rs)">${strat.risk_note}</div>
    </div>
    ${secT('Trade Setup This Week — Selected Strategy')}
    ${selectedSetupHtml}

    ${secT('3 Main Strategy Entry Plan — Actual Entry / Target / Stop Loss')}
    <div class="aib" style="font-size:.72rem;margin-bottom:10px">These are separate trade styles. For screener/Overview selection, the active long plan is limited to EMA20 Pullback, EMA50 Deep Pullback, or Support Bounce; active short plan is limited to EMA20/EMA50/Rejection or Resistance Rejection. Entry, target, and stop loss come from the selected setup only.</div>
    ${(strat.four_strategy_setups||[]).filter(s=>/EMA20 Pullback|EMA50 Deep Pullback|Support Bounce|EMA20 Rejection|EMA50 Deep Rejection|Resistance Bounce|conditional only/i.test(s.name||'')).map(s=>`<div class="setup-card ${s.type==='Long'?'bull-card':s.type==='Short'?'bear-card':'neu-card'}"><div class="setup-name"><span class="setup-tag ${s.type==='Long'?'tag-bull':s.type==='Short'?'tag-bear':'tag-opt'}">${s.type}</span>${escHtml(s.name)}</div><div class="setup-detail"><strong style="color:var(--tx)">Entry:</strong> ${s.entry}<br><strong style="color:var(--bull)">Target:</strong> ${s.target} · <strong style="color:var(--bear)">SL:</strong> ${s.stoploss}<br><span style="color:var(--tx2)">${escHtml(s.rationale)}</span>${s.exit?`<br><span class="setup-exit">${escHtml(s.exit)}</span>`:''}</div></div>`).join('')}

`}
    <!-- ─── OPTION BUILDER ─── -->
    ${showOptions ? `<div style="margin-top:6px;background:var(--bgc);border:1px solid var(--brd);border-radius:var(--r);padding:16px 18px;margin-bottom:14px">` : '<div style="display:none">'}
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
        <span style="font-size:.8rem;font-weight:800;color:var(--acc);letter-spacing:.05em">⚙ OPTION BUILDER</span>
        <span style="font-size:.7rem;color:var(--tx3)">Live spot · Black-Scholes pricing</span>
        <div style="margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap">

          <label style="font-size:.72rem;color:var(--tx2)">Lot Size</label>
          <input type="number" id="opt-lot" value="${currentLot}" min="1" placeholder="${presetLot||'auto'}"
            title="NSE F&O lot size — preset loaded for known symbols"
            style="width:70px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);padding:4px 8px;color:var(--tx);font-size:.8rem"
            onchange="OPT_STATE.lot=+this.value||'';OPT_STATE.strikes=[];loadOptionStrategy(${jsArg(sym)},OPT_STATE.strategy)">
          ${presetLot ? `<span style="font-size:.75rem;color:var(--tx3)" title="Official NSE lot size">✓ NSE preset</span>` : ''}

          <label style="font-size:.72rem;color:var(--tx2)">Expiry (days)</label>
          <input type="number" id="opt-expiry" value="${OPT_STATE.expiry}" min="1" max="90"
            style="width:55px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);padding:4px 8px;color:var(--tx);font-size:.8rem"
            onchange="OPT_STATE.expiry=+this.value;OPT_STATE.strikes=[];loadOptionStrategy(${jsArg(sym)},OPT_STATE.strategy)">

          <label style="font-size:.72rem;color:var(--tx2)">IV %</label>
          <input type="number" id="opt-iv" value="${OPT_STATE.iv}" placeholder="auto" min="5" max="100"
            style="width:55px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);padding:4px 8px;color:var(--tx);font-size:.8rem"
            onchange="OPT_STATE.iv=this.value;OPT_STATE.strikes=[];loadOptionStrategy(${jsArg(sym)},OPT_STATE.strategy)">

          <button onclick="OPT_STATE.strikes=[];OPT_STATE.lot='';document.getElementById('opt-lot').value='${presetLot||''}';loadOptionStrategy(${jsArg(sym)},OPT_STATE.strategy)"
            style="background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);padding:4px 10px;color:var(--tx2);font-size:.72rem;cursor:pointer"
            title="Reset to auto-calculated strikes">↺ Reset</button>
        </div>
      </div>
      <!-- Strategy picker buttons -->
      <div style="display:flex;flex-wrap:wrap;gap:7px;margin-bottom:16px">
        ${stratBtns}
      </div>
    ${showOptions ? `</div>

    <!-- Options result injected here -->
    <div id="opt-result"><div class="ls" style="display:flex;min-height:80px;justify-content:center"><div class="sp"></div></div></div>` : '</div>'}
  `;

  /* Skip the write if the user moved to another symbol/page while the trade plan was loading. */
  if(!live() || CUR_SYM !== sym) return;
  tc.innerHTML = html;

  // Auto-load the selected strategy only for indices
  if(showOptions) loadOptionStrategy(sym, OPT_STATE.strategy);
}

/* ══════════════════════════════════════════════════════════════════
   TRADE IDEAS — one plain-English plan per instrument
   Index options (Nifty / Bank Nifty / FinNifty): direction from trend + breadth, volatility from India VIX and
   its 1-year percentile, strikes from the expected move and S/R. MCX futures: trend plan with entry / SL /
   targets in ₹ per lot, plus an option hedge for crude oil. Built only from data already loaded (no option
   chain / OI - NSE blocks it), so premiums are Black-Scholes estimates from VIX or historical volatility.
══════════════════════════════════════════════════════════════════ */
const IDX_OPT = {
  'NSE:NIFTY':     { name:'Nifty',      lot:65, step:50,  wing:200, weekly:true },
  'NSE:BANKNIFTY': { name:'Bank Nifty', lot:30, step:100, wing:500, weekly:false },
  'NSE:FINNIFTY':  { name:'FinNifty',   lot:60, step:50,  wing:200, weekly:false },
};
function ideaNcdf(x){ const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911; const s=x<0?-1:1, z=Math.abs(x)/Math.SQRT2, t=1/(1+p*z); const e=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-z*z); return 0.5*(1+s*e); }
function ideaBs(S, K, T, sig, type){
  const r = 0.065;
  if(!(T > 0) || !(sig > 0)) return Math.max(0, type==='C' ? S-K : K-S);
  const d1 = (Math.log(S/K) + (r + sig*sig/2)*T) / (sig*Math.sqrt(T)), d2 = d1 - sig*Math.sqrt(T);
  return type==='C' ? S*ideaNcdf(d1) - K*Math.exp(-r*T)*ideaNcdf(d2) : K*Math.exp(-r*T)*ideaNcdf(-d2) - S*ideaNcdf(-d1);
}
/* P(price at expiry above x), lognormal with the same volatility. */
function ideaProbAbove(S, x, T, sig){ if(!(T>0 && sig>0 && x>0)) return S > x ? 1 : 0; return ideaNcdf((Math.log(S/x) - sig*sig/2*T) / (sig*Math.sqrt(T))); }
/* One /api/calendar fetch (30 min) serves expiries, the options event check and the MCX events card. */
let IDEA_CAL_CACHE = null;
async function ideaCalendar(){
  if(IDEA_CAL_CACHE && Date.now() - IDEA_CAL_CACHE.ts < 1800e3) return IDEA_CAL_CACHE.v;
  try{ const c = await apiFetch('/api/calendar', 10000); IDEA_CAL_CACHE = { v:c?.upcoming || [], ts:Date.now() }; return IDEA_CAL_CACHE.v; }
  catch{ return IDEA_CAL_CACHE?.v || []; }
}
async function ideaExpiries(){
  const today = istDateKey();
  return (await ideaCalendar()).filter(e => /expiry/i.test(e.event || '') && e.date >= today).map(e => ({date:e.date, monthly:/monthly/i.test(e.event)}))
    .sort((a,b) => a.date < b.date ? -1 : 1);
}
function ideaDaysTo(dateKey){ return Math.max(1, Math.round((Date.parse(dateKey + 'T15:30:00+05:30') - Date.now()) / 86400000)); }
function ideaDate(dateKey){ try{ return new Date(dateKey + 'T00:00:00').toLocaleDateString('en-IN', {day:'2-digit', month:'short'}); }catch{ return dateKey; } }
/* Annualised historical volatility of daily closes (fallback volatility for MCX, where no implied vol is loaded). */
function ideaHistVol(C, days){ const c = (C||[]).slice(-(days+1)).map(Number).filter(v => v > 0); if(c.length < 10) return null; const r = c.slice(1).map((v,i) => Math.log(v/c[i])); const m = r.reduce((a,b)=>a+b,0)/r.length; return Math.sqrt(r.reduce((a,b)=>a+(b-m)**2,0)/(r.length-1)) * Math.sqrt(252); }

async function buildIndexOptionsIdea(sym){
  const cfg = IDX_OPT[sym];
  if(!cfg || !CUR_DATA?.daily?.C?.length) return null;
  const C = CUR_DATA.daily.C, spot = getCurrentLivePrice();
  const e20 = emaLast(C,20), e50 = emaLast(C,50);
  let vix = +GLOBAL_DATA?.vix?.price;
  /* Market data missed India VIX: ask the light VIX endpoint directly. */
  if(!(vix > 0)) vix = +(await fetchVIX()) || NaN;
  const ivp = Number.isFinite(+GLOBAL_DATA?.ivRank?.ivPercentile) ? +GLOBAL_DATA.ivRank.ivPercentile : null;
  /* Breadth is Nifty 50's advance/decline - it votes only on the Nifty idea. */
  const ad = sym === 'NSE:NIFTY' && Number.isFinite(+GLOBAL_DATA?.breadth?.adRatio) ? +GLOBAL_DATA.breadth.adRatio : null;
  if(!(vix > 0) || !(spot > 0)) return { error:'India VIX / spot not loaded yet - this card refreshes by itself when it arrives.' };
  const sr = getSRTradeLevels();
  /* Direction: trend (-3..+3) plus breadth (-1..+1). */
  const trend = (spot > e20 ? 1 : -1) + (e20 > e50 ? 1 : -1) + (spot > e50 ? 1 : -1);
  const breadth = ad == null ? 0 : ad >= 1.5 ? 1 : ad <= 0.67 ? -1 : 0;
  const score = trend + breadth;
  const view = score >= 2 ? 'Bullish' : score <= -2 ? 'Bearish' : 'Range-bound';
  /* Volatility: IV percentile when loaded, else the VIX level. */
  const vol = ivp != null ? (ivp < 30 ? 'cheap' : ivp > 60 ? 'rich' : 'fair') : (vix < 14 ? 'cheap' : vix > 18 ? 'rich' : 'fair');
  const ex = await ideaExpiries();
  const pick = (minDays, monthlyOnly) => ex.find(e => (!monthlyOnly || e.monthly) && ideaDaysTo(e.date) >= minDays);
  const main = pick(5, !cfg.weekly);
  const T = main ? ideaDaysTo(main.date) : 30, Ty = T/365, iv = vix/100;
  const sd = spot * iv * Math.sqrt(Ty);
  const rnd = (x, dir) => dir < 0 ? Math.floor(x/cfg.step)*cfg.step : dir > 0 ? Math.ceil(x/cfg.step)*cfg.step : Math.round(x/cfg.step)*cfg.step;
  const atm = rnd(spot, 0);
  const supBelow = [sr.s1, sr.s2].map(Number).filter(v => v > 0 && v < spot).sort((a,b) => b-a)[0];
  const resAbove = [sr.r1, sr.r2].map(Number).filter(v => v > spot).sort((a,b) => a-b)[0];
  const P = (K, t, T2=Ty) => ideaBs(spot, K, T2, iv, t);
  let s;
  if(view === 'Bullish' && vol === 'cheap'){
    const k2 = rnd(spot + 0.75*sd, 1);
    s = { id:'bull_call_spread', name:'Bull Call Spread', kind:'debit', legs:[{a:'BUY',t:'C',k:atm},{a:'SELL',t:'C',k:k2}],
      why:'Bullish view and options are cheap: buy the call spread (pay a small debit, limited risk).' };
  } else if(view === 'Bullish'){
    /* At or below support, but never more than 1 expected move away: a far support (22,350 with Nifty at
       23,441) put the short strike ~2 sigma out for a Rs 3 premium and an R:R of 0.01. */
    const k1 = rnd(Math.max(spot - 1.0*sd, Math.min(spot - 0.6*sd, supBelow || Infinity)), -1);
    s = { id:'bull_put_spread', name:'Bull Put Spread', kind:'credit', legs:[{a:'SELL',t:'P',k:k1},{a:'BUY',t:'P',k:k1 - cfg.wing}],
      why:`Bullish view and options are ${vol}: sell a put below support and collect premium.` };
  } else if(view === 'Bearish' && vol === 'cheap'){
    const k2 = rnd(spot - 0.75*sd, -1);
    s = { id:'bear_put_spread', name:'Bear Put Spread', kind:'debit', legs:[{a:'BUY',t:'P',k:atm},{a:'SELL',t:'P',k:k2}],
      why:'Bearish view and options are cheap: buy the put spread (limited risk).' };
  } else if(view === 'Bearish'){
    const k1 = rnd(Math.min(spot + 1.0*sd, Math.max(spot + 0.6*sd, resAbove || 0)), 1);   /* capped like the bull put */
    s = { id:'bear_call_spread', name:'Bear Call Spread', kind:'credit', legs:[{a:'SELL',t:'C',k:k1},{a:'BUY',t:'C',k:k1 + cfg.wing}],
      why:`Bearish view and options are ${vol}: sell a call above resistance and collect premium.` };
  } else if(vol === 'cheap'){
    const near = pick(2, false), far = ex.find(e => e.monthly && near && ideaDaysTo(e.date) >= ideaDaysTo(near.date) + 14);
    if(near && far){
      const Tn = ideaDaysTo(near.date)/365, Tf = ideaDaysTo(far.date)/365;
      s = { id:'calendar', name:'Calendar Spread (call)', kind:'calendar', near, far, Tn, Tf,
        legs:[{a:'SELL',t:'C',k:atm,T:Tn,exp:near.date},{a:'BUY',t:'C',k:atm,T:Tf,exp:far.date}],
        why:'No clear direction and options are cheap: sell the near-expiry option, hold the longer one - gains from time decay and from a rise in volatility.' };
    }
  }
  if(!s){
    const kc = rnd(Math.min(spot + 1.3*sd, Math.max(spot + sd, resAbove || 0)), 1), kp = rnd(Math.max(spot - 1.3*sd, Math.min(spot - sd, supBelow || Infinity)), -1);
    s = { id:'iron_condor', name:'Iron Condor', kind:'credit', legs:[{a:'SELL',t:'C',k:kc},{a:'BUY',t:'C',k:kc + cfg.wing},{a:'SELL',t:'P',k:kp},{a:'BUY',t:'P',k:kp - cfg.wing}],
      why:`No clear direction and options are ${vol}: sell both sides about one expected move away.` };
  }
  s.legs.forEach(l => { l.prem = P(l.k, l.t, l.T ?? Ty); });
  /* Live NSE premiums (option chain) replace the estimates; premiums typed in from the broker win over both
     (kept while the same legs are shown). A calendar's far leg is looked up in its own expiry. */
  const chain = await ideaChain(sym, main?.date);
  const farChain = s.far?.date && s.far.date !== main?.date ? await ideaChain(sym, s.far.date) : null;
  s.legs.forEach(l => { const ch = l.exp && farChain && l.exp === s.far?.date ? farChain : chain; l.nse = ch ? SwingPlan.ocPremium(ch, l.k, l.t) : null; });
  const liveKey = `${sym}|${s.id}|${s.legs.map(l => l.t + l.k + (l.exp || '')).join(',')}|${main?.date || ''}`;
  const saved = IDEA_LIVE_PREM[liveKey] || {};
  s.legs.forEach((l, i) => { l.typed = saved[i] > 0; l.live = saved[i] > 0 ? saved[i] : (l.nse > 0 ? l.nse : null); });
  /* Scheduled events between today and the (near) expiry. */
  const today = istDateKey(), until = s.near?.date || main?.date || today;
  const events = (await ideaCalendar()).filter(e => IDX_EVENT_CATS.includes(e.category) && e.date >= today && e.date <= until);
  const nearT = s.near ? ideaDaysTo(s.near.date) : T;
  const x = { sym, cfg, spot, e20, e50, vix, ivp, ad, trend, breadth, score, view, vol, T, sd, expiry: main?.date || null, s, iv, Ty, liveKey, events, nearT,
    oc: chain ? { pcr: chain.pcr, maxPain: chain.maxPain, callWalls: chain.callWalls, putWalls: chain.putWalls, expiry: chain.expiry, stale: !!chain.stale, at: chain.fetchedAt } : null };
  Object.assign(x, ideaOptMetrics(x));
  LAST_IDX_IDEA = x;
  return x;
}
/* NSE option chain via the server (cached there 3 min); client keeps it 3 min too. Null when NSE is unreachable. */
const IDEA_CHAIN_CACHE = {};
async function ideaChain(sym, expiry){
  if(!IDX_OPT[sym]) return null;
  const k = `${sym}|${expiry || ''}`, hit = IDEA_CHAIN_CACHE[k];
  if(hit && Date.now() - hit.ts < 180e3) return hit.v;
  try { const v = await apiFetch(`/api/option-chain?sym=${encodeURIComponent(sym)}&expiry=${encodeURIComponent(expiry || '')}`, 20000); IDEA_CHAIN_CACHE[k] = {v, ts:Date.now()}; return v; }
  catch { return hit?.v || null; }
}
/* Net premium, max profit / loss, breakevens and model chance of profit - from the live premiums where the
   user typed them, else the Black-Scholes estimates. */
function ideaOptMetrics(x){
  const {s, cfg, spot, iv, Ty, e20} = x;
  const pr = l => l.live > 0 ? l.live : l.prem;
  const net = s.legs.reduce((a,l) => a + (l.a === 'SELL' ? pr(l) : -pr(l)), 0);   /* + credit, - debit */
  const k = s.legs.map(l => l.k);
  let maxProfit, maxLoss, be = [], pop;
  if(s.id === 'bull_put_spread'){ maxProfit = net; maxLoss = cfg.wing - net; be = [k[0] - net]; pop = ideaProbAbove(spot, be[0], Ty, iv); }
  else if(s.id === 'bear_call_spread'){ maxProfit = net; maxLoss = cfg.wing - net; be = [k[0] + net]; pop = 1 - ideaProbAbove(spot, be[0], Ty, iv); }
  else if(s.id === 'bull_call_spread'){ maxLoss = -net; maxProfit = (k[1]-k[0]) + net; be = [k[0] - net]; pop = ideaProbAbove(spot, be[0], Ty, iv); }
  else if(s.id === 'bear_put_spread'){ maxLoss = -net; maxProfit = (k[0]-k[1]) + net; be = [k[0] + net]; pop = 1 - ideaProbAbove(spot, be[0], Ty, iv); }
  else if(s.id === 'iron_condor'){ maxProfit = net; maxLoss = cfg.wing - net; be = [k[2] - net, k[0] + net]; pop = ideaProbAbove(spot, be[0], Ty, iv) - ideaProbAbove(spot, be[1], Ty, iv); }
  else { /* calendar: value of the long option at near expiry if the index sits at the strike */
    maxLoss = -net; maxProfit = ideaBs(k[0], k[0], s.Tf - s.Tn, iv, 'C') - (-net);
    const band = spot * iv * Math.sqrt(s.Tn) * 0.75; be = [k[0] - band, k[0] + band];
    pop = ideaProbAbove(spot, be[0], s.Tn, iv) - ideaProbAbove(spot, be[1], s.Tn, iv);
  }
  const exit = s.kind === 'credit'
    ? `Book at 50-60% of the credit. Exit if ${cfg.name} closes beyond a short strike or the loss reaches 2x the credit.`
    : s.kind === 'debit'
    ? `Book at 70-80% of the maximum profit. Exit if the spread loses half its cost or ${cfg.name} closes back ${s.id === 'bull_call_spread' ? 'below' : 'above'} EMA20 (${fmt(e20)}).`
    : `Exit before the near expiry, or earlier if ${cfg.name} moves more than ${fmt(be[1]-k[0],0)} points from ${k[0]}.`;
  return { net, maxProfit, maxLoss, be, pop, exit, usingLive: s.legs.some(l => l.live > 0) };
}

/* Shared by the options and MCX cards: lots from the capital and risk % saved by the position calculator. */
let LAST_IDX_IDEA = null;
const IDEA_LIVE_PREM = {};
const IDX_EVENT_CATS = ['RBI', 'FOMC', 'CPI', 'NFP', 'GDP', 'BUDGET'];
function ideaLots(lossPerLot){
  const cap = readPosSetting(POS_CAPITAL_KEY, 10000), rp = readPosSetting(POS_RISK_KEY, 1), budget = cap * rp / 100;
  return { cap, rp, budget, lots: lossPerLot > 0 ? Math.floor(budget / lossPerLot) : 0, pct: lossPerLot > 0 ? lossPerLot / cap * 100 : 0 };
}
function ideaSizeHtml(lossPerLot, what){
  if(!(lossPerLot > 0)) return '';
  const z = ideaLots(lossPerLot);
  return `<div class="idea-size">
    <label>Capital ₹<input type="number" min="0" step="1000" value="${z.cap}" onchange="ideaSizeChanged(this,'cap')"></label>
    <label>Risk <input type="number" min="0.1" max="10" step="0.25" value="${z.rp}" onchange="ideaSizeChanged(this,'risk')">%</label>
    <span>${z.lots > 0
      ? `→ <b>${z.lots} lot${z.lots > 1 ? 's' : ''}</b> · ${escHtml(what)} ₹${fmt(lossPerLot,0)} per lot, ₹${fmt(z.lots*lossPerLot,0)} in all (limit ₹${fmt(z.budget,0)})`
      : `→ <b style="color:var(--bear)">0 lots</b> · one lot risks ₹${fmt(lossPerLot,0)} = ${z.pct.toFixed(1)}% of capital, above your ${z.rp}% limit`}</span>
  </div>`;
}
function ideaSizeChanged(el, which){
  savePosSetting(which === 'cap' ? POS_CAPITAL_KEY : POS_RISK_KEY, Number(el.value));
  if(document.querySelector('[data-idx-idea]') && LAST_IDX_IDEA) ideaRerender();
  else if(isMCXSymbol(CUR_SYM)) renderTab('overview');
}
function ideaRerender(){ const el = document.querySelector('[data-idx-idea]'); if(el && LAST_IDX_IDEA) el.outerHTML = indexIdeaHtml(LAST_IDX_IDEA); }
function ideaApplyLive(reset){
  const x = LAST_IDX_IDEA; if(!x) return;
  const saved = {};
  if(!reset) document.querySelectorAll('[data-idx-idea] [data-leg]').forEach(inp => { const v = Number(inp.value); if(v > 0) saved[+inp.dataset.leg] = v; });
  IDEA_LIVE_PREM[x.liveKey] = saved;
  x.s.legs.forEach((l, i) => { l.typed = saved[i] > 0; l.live = saved[i] > 0 ? saved[i] : (!reset && l.nse > 0 ? l.nse : null); });
  Object.assign(x, ideaOptMetrics(x));
  ideaRerender();
}
function evDay(key){
  const dd = Math.round((Date.parse(key + 'T00:00:00Z') - Date.parse(istDateKey() + 'T00:00:00Z')) / 86400000);
  return dd === 0 ? 'Today' : dd === 1 ? 'Tomorrow' : new Date(key + 'T00:00:00').toLocaleDateString('en-IN', {weekday:'short', day:'2-digit', month:'short'});
}

function indexIdeaHtml(x){
  if(!x) return '';
  if(x.error) return `<div class="idea-card" data-idx-idea-wait><div class="idea-kicker">Today's options idea</div><div class="aib">${escHtml(x.error)}</div></div>`;
  const {cfg, s} = x, lot = cfg.lot;
  const ce = l => l.t === 'C' ? 'CE' : 'PE';
  const legTxt = s.legs.map(l => `<span class="idea-leg ${l.a === 'SELL' ? 'sell' : 'buy'}">${l.a === 'SELL' ? 'Sell' : 'Buy'} ${l.k} ${ce(l)}${l.exp ? ` (${ideaDate(l.exp)})` : ''} ${l.live > 0 ? `₹${fmt(l.live)} ${l.typed ? 'yours' : 'NSE'}` : `≈ ₹${fmt(l.prem)}`}</span>`).join('');
  const netTxt = x.net >= 0 ? `Net credit ${x.usingLive ? '' : '≈ '}₹${fmt(x.net)} (₹${fmt(x.net*lot,0)} per lot)` : `Net debit ${x.usingLive ? '' : '≈ '}₹${fmt(-x.net)} (₹${fmt(-x.net*lot,0)} per lot)`;
  const comment = `${cfg.name} ${fmt(x.spot,0)} · VIX ${fmt(x.vix,1)}${x.ivp != null ? ` (IV percentile ${Math.round(x.ivp)}%)` : ' (IV percentile not loaded yet - judged from the VIX level)'}${x.ad != null ? ` · A/D ${x.ad}:1` : ''} → ${x.view}, options ${x.vol} → <b>${s.name}</b>: ${s.legs.map(l => `${l.a === 'SELL' ? 'sell' : 'buy'} ${l.k} ${ce(l)}`).join(' / ')}`;
  const trendTxt = `${x.spot > x.e20 ? 'above' : 'below'} EMA20 ${fmt(x.e20,0)}, ${x.spot > x.e50 ? 'above' : 'below'} EMA50 ${fmt(x.e50,0)}, EMA20 ${x.e20 > x.e50 ? 'above' : 'below'} EMA50`;
  const ordered = { iron_condor:[0,1,2,3], bull_call_spread:[0,1], bear_put_spread:[0,1], bull_put_spread:[0,1], bear_call_spread:[0,1] }[s.id];
  const apply = ordered ? `<button class="idea-btn" onclick="OPT_STATE.strategy='${s.id}';OPT_STATE.strikes=[${ordered.map(i => s.legs[i].k).join(',')}];OPT_STATE.expiry=${x.T};OPT_STATE.lot='';switchAnalysis('strategy')">Open in Option Builder</button>` : '';
  const rr = x.maxLoss > 0 ? x.maxProfit / x.maxLoss : null;
  /* Events before expiry and expiry-week gamma. */
  const evs = x.events || [], shortOpt = s.kind === 'credit' || s.kind === 'calendar';
  const warn = [];
  if(evs.length) warn.push(`${evs.map(e => `${escHtml(e.event)} (${escHtml(evDay(e.date))})`).join(', ')} before ${s.near ? 'the near expiry' : 'expiry'}. ${shortOpt ? 'Sold options lose most on event days - trade fewer lots, keep the short strikes wider, or enter after the event.' : 'A big move helps a debit spread only in the right direction - size for losing the full debit.'}`);
  if(x.nearT <= 2) warn.push(`Expiry in ${x.nearT} day${x.nearT > 1 ? 's' : ''}: premiums change very fast now (gamma). For a 3-10 day hold use the next expiry.`);
  /* A credit far smaller than the risk is not worth selling, whatever the model chance says. */
  const thin = s.kind === 'credit' && x.maxLoss > 0 && x.maxProfit / x.maxLoss < 0.10
    ? `<div class="idea-hedge" style="border-color:var(--bear)"><b>⚠ Credit too small for the risk:</b> ₹${fmt(x.maxProfit)} to make vs ₹${fmt(x.maxLoss)} to lose per unit (R:R ${(x.maxProfit / x.maxLoss).toFixed(2)}). Skip, or check live premiums - a short strike closer to spot pays more.</div>` : '';
  const evHtml = thin + (warn.length ? `<div class="idea-hedge" style="border-color:var(--bear)"><b>⚠ Event risk:</b> ${warn.join(' ')}</div>` : `<div class="idea-hedge"><b>Events:</b> no RBI / Fed / CPI / jobs / GDP date in the app calendar before ${s.near ? 'the near expiry' : 'expiry'}.</div>`);
  const typed = s.legs.some(l => l.typed), nse = s.legs.some(l => !l.typed && l.nse > 0);
  const liveHtml = `<details class="idea-live"${typed ? ' open' : ''}><summary>${typed ? 'Using your premiums - edit' : nse ? 'Using NSE live premiums - type your own to override' : 'Enter live premiums from your broker'}</summary>
    <div class="idea-live-row">${s.legs.map((l, i) => `<label>${l.a === 'SELL' ? 'Sell' : 'Buy'} ${l.k} ${ce(l)}<input data-leg="${i}" type="number" min="0" step="0.05" value="${l.typed ? l.live : ''}" placeholder="${fmt(l.nse > 0 ? l.nse : l.prem)}"></label>`).join('')}
      <button class="idea-btn" onclick="ideaApplyLive()">Recalculate</button>${x.usingLive ? '<button class="idea-btn ghost" onclick="ideaApplyLive(true)">Use estimates</button>' : ''}</div>
    <div class="idea-foot" style="margin-top:6px">Type the last traded price (or the mid of bid/ask) for each leg; empty legs keep the NSE price, or the estimate when NSE has none.</div></details>`;
  return `<div class="idea-card" data-idx-idea>
    <div class="idea-head"><div><div class="idea-kicker">Today's options idea · ${escHtml(cfg.name)}</div><div class="idea-title">${escHtml(s.name)}</div></div>
      <div class="idea-view ${x.view === 'Bullish' ? 'bull' : x.view === 'Bearish' ? 'bear' : 'neutral'}">${x.view}</div></div>
    <div class="idea-comment">${comment}</div>
    <div class="idea-legs">${legTxt}</div>
    <div class="idea-grid">
      <div><span>${x.net >= 0 ? 'Credit' : 'Debit'}${x.usingLive ? ' (live)' : ''}</span><b>${netTxt}</b></div>
      <div><span>Max profit / loss per lot</span><b>₹${fmt(x.maxProfit*lot,0)} / ₹${fmt(x.maxLoss*lot,0)}${rr != null ? ` · R:R ${rr.toFixed(2)}` : ''}</b></div>
      <div><span>Breakeven${x.be.length > 1 ? 's' : ''}</span><b>${x.be.map(v => fmt(v,0)).join(' - ')}</b></div>
      <div><span>Chance of profit (model)</span><b>${Math.round(Math.max(0, Math.min(1, x.pop))*100)}%</b></div>
      <div><span>Expiry</span><b>${x.expiry ? `${ideaDate(x.expiry)} · ${x.T} days` : `~${x.T} days`}</b></div>
      <div><span>Expected move (1σ)</span><b>±${fmt(x.sd,0)} pts</b></div>
    </div>
    ${ideaSizeHtml(x.maxLoss * lot, 'max loss')}
    ${x.oc ? `<div class="idea-hedge"><b>NSE open interest${x.oc.expiry ? ` (${ideaDate(x.oc.expiry)} expiry)` : ''}:</b> PCR ${x.oc.pcr ?? '--'}${x.oc.pcr != null ? (x.oc.pcr > 1.3 ? ' (heavy put writing - support below)' : x.oc.pcr < 0.7 ? ' (heavy call writing - cap above)' : ' (balanced)') : ''} · max pain ${fmt(x.oc.maxPain,0)} · biggest call OI (resistance) ${(x.oc.callWalls||[]).map(w => fmt(w.k,0)).join(', ') || '--'} · biggest put OI (support) ${(x.oc.putWalls||[]).map(w => fmt(w.k,0)).join(', ') || '--'}${x.oc.stale ? ' · saved quote' : ''}${x.oc.expiry && x.expiry && x.oc.expiry !== x.expiry ? ` · NSE expiry ${ideaDate(x.oc.expiry)} used (app calendar said ${ideaDate(x.expiry)})` : ''}</div>` : ''}
    ${evHtml}
    ${liveHtml}
    <ul class="idea-why">
      <li><b>Why:</b> ${escHtml(s.why)}</li>
      <li><b>Trend:</b> ${trendTxt}${x.breadth ? ` · breadth ${x.breadth > 0 ? 'strong' : 'weak'}` : ''} (score ${x.score > 0 ? '+' : ''}${x.score}; ±2 or more = directional)</li>
      <li><b>Volatility:</b> VIX ${fmt(x.vix,1)}${x.ivp != null ? (x.ivp < 50 ? `, lower than on ${100 - Math.round(x.ivp)}% of days in the past year` : `, higher than on ${Math.round(x.ivp)}% of days in the past year`) : ''} - ${x.vol === 'cheap' ? 'favour buying (debit spreads / calendars)' : x.vol === 'rich' ? 'favour selling (credit spreads / iron condors)' : 'credit spreads with defined risk'}</li>
      <li><b>Exit:</b> ${escHtml(x.exit)}</li>
    </ul>
    <div class="idea-foot">${x.usingLive ? `Credit / debit, max profit / loss and breakevens use ${typed ? 'your premiums' : 'NSE live premiums (bid/ask middle, or the last trade of today when the spread is wide; legs with no good quote keep the estimate)'}; the chance of profit still uses India VIX as the volatility. Check the spread before placing.` : 'Premiums are Black-Scholes estimates from India VIX - NSE option chain was not reachable. Enter live premiums above, and check spreads and liquidity before placing.'} Lot ${lot}.${apply}</div>
  </div>`;
}

/* MCX futures plan. Crude oil: hedged with a bought option at the stop level. */
const MCX_IDEA = {
  'MCX:CRUDEOIL':  { name:'Crude Oil Mini', unit:'barrel', lotQty:10, hedge:true, optLotQty:100, optStep:50,
                     lotNote:'Crude Oil Mini = 10 barrels; price is ₹ per barrel.' },
  'MCX:GOLDPETAL': { name:'Gold Petal', unit:'gram', lotQty:1, hedge:false,
                     lotNote:'Gold Petal = 1 gram per lot. MCX has no options on Gold Petal, so the stop-loss is the hedge.' },
  /* Standard MCX contract sizes - check the exact lot (and mini variants) with your broker. */
  'MCX:GOLD':       { name:'Gold', unit:'10 g', lotQty:100, hedge:false, lotNote:'Gold = 1 kg per lot (price is ₹ per 10 g, so ₹1 move = ₹100 per lot). Check the lot with your broker.' },
  'MCX:SILVER':     { name:'Silver', unit:'kg', lotQty:30, hedge:false, lotNote:'Silver = 30 kg per lot (price is ₹ per kg). Check the lot with your broker.' },
  'MCX:NATURALGAS': { name:'Natural Gas', unit:'mmBtu', lotQty:1250, hedge:false, lotNote:'Natural Gas = 1,250 mmBtu per lot. Check the lot with your broker.' },
  'MCX:COPPER':     { name:'Copper', unit:'kg', lotQty:2500, hedge:false, lotNote:'Copper = 2,500 kg per lot (price is ₹ per kg). Check the lot with your broker.' },
};
/* Contract and session notes. Expiry days are the usual pattern, not exact dates - check the contract. */
const MCX_CONTRACT_NOTE = {
  'MCX:CRUDEOIL':   'Crude Oil Mini usually expires around the 19th-20th of each month (just before the US WTI contract). Roll to the next month 2-3 days before. OPEC+ meetings move crude sharply - check the date in the news.',
  'MCX:GOLDPETAL':  'Gold Petal expires around the last business day of the month and can go into delivery - close or roll a few days before.',
  'MCX:GOLD':       'Gold expires around the 5th of the contract month (Feb, Apr, Jun, Aug, Oct, Dec) and can go into delivery - roll a few days before.',
  'MCX:SILVER':     'Silver expires around the 5th of the contract month (Mar, May, Jul, Sep, Dec) - roll a few days before.',
  'MCX:NATURALGAS': 'Natural Gas usually expires around the 25th-27th of each month (just before the US contract) - roll 2-3 days before.',
  'MCX:COPPER':     'Copper expires around the last business day of the month - roll a few days before.',
};
const MCX_SESSION_NOTE = 'MCX trades 9 am to 11:30 pm IST (11:55 pm in the US winter). Most of the daily range comes after the US open (7 pm IST in the US summer, 8 pm in winter), so stops are usually hit in the evening.';
const MCX_EVENT_CATS = {
  'MCX:CRUDEOIL':['EIA','FOMC','NFP','CPI'], 'MCX:GOLD':['FOMC','NFP','CPI','RBI'], 'MCX:GOLDPETAL':['FOMC','NFP','CPI','RBI'],
  'MCX:SILVER':['FOMC','NFP','CPI'], 'MCX:NATURALGAS':['NGSTORAGE'], 'MCX:COPPER':['FOMC','NFP','CPI'],
};
const MCX_ROUND = { 'MCX:GOLD':1000, 'MCX:GOLDPETAL':100, 'MCX:SILVER':1000, 'MCX:CRUDEOIL':100, 'MCX:NATURALGAS':10, 'MCX:COPPER':10 };

/* Calibration: the user's broker price vs the proxy. Every level on the MCX cards is multiplied by
   k = MCX / proxy (the gap is mostly duty and the contract basis, which moves slowly) for 3 days. */
const MCX_CAL_KEY = 'td_mcx_cal2_'; /* v2: the proxy now includes the fixed MCX gap, so older calibrations no longer apply */
function mcxCal(sym){ try{ const c = JSON.parse(localStorage.getItem(MCX_CAL_KEY + sym) || 'null'); if(c && c.mcx > 0 && c.proxy > 0 && Date.now() - c.ts < 3*86400e3) return c; }catch{} return null; }
function mcxCalK(sym){ const c = mcxCal(sym), k = c ? c.mcx / c.proxy : 1; return k > 0.8 && k < 1.25 ? k : 1; }
function mcxCalSet(sym, reset){
  const msg = t => { const el = document.querySelector('[data-mcx-cal-msg]'); if(el){ el.textContent = t; el.style.color = 'var(--bear)'; } };
  try{
    if(reset) localStorage.removeItem(MCX_CAL_KEY + sym);
    else {
      const v = Number(String(document.querySelector('[data-mcx-cal]')?.value || '').replace(/,/g,'')), proxy = getCurrentLivePrice();
      if(!(v > 0) || !(proxy > 0)) return msg('Type the current MCX price from your broker first.');
      if(Math.abs(v / proxy - 1) > 0.2) return msg(`₹${fmt(v)} is more than 20% away from the proxy ₹${fmt(proxy)} - check the contract and unit (₹ per ${MCX_IDEA[sym]?.unit || 'unit'}).`);
      localStorage.setItem(MCX_CAL_KEY + sym, JSON.stringify({ mcx:v, proxy, ts:Date.now() }));
    }
  }catch{ return msg('Could not save in this browser.'); }
  renderTab('overview');
}
/* Daily bars, live price and S/R levels in calibrated MCX terms. */
function mcxData(sym){
  const k = mcxCalK(sym), d = CUR_DATA.daily, sc = a => (a || []).map(v => v != null && Number.isFinite(+v) ? +v * k : v);
  const sr = { ...getSRTradeLevels() };
  Object.keys(sr).forEach(key => { if(/^(s\d|r\d|pp|yw_high|yw_low)$/.test(key) && sr[key] != null && Number.isFinite(+sr[key])) sr[key] = +sr[key] * k; });
  return { k, C:sc(d.C), H:sc(d.H), L:sc(d.L), price:getCurrentLivePrice() * k, sr };
}

/* MCX Overview: your price → futures plan → buy/sell zones → global drivers → events + news → trend context.
   The stock-swing blocks (Fresh Entry, Hold Score, capital-based sizing, volume status) are not shown: the
   volume is the US futures volume, not MCX, and the sizing is by lot here. */
function mcxOverviewHtml(sym){
  const D = mcxData(sym), x = buildCommodityIdea(sym, D), sr = D.sr, loc = getPriceLocationSnapshot(getSRTradeLevels());
  const d = CUR_DATA, dr = sigRec(d.daily.rec.value), wr = d.weekly?.rec ? sigRec(d.weekly.rec.value) : {l:'N/A', c:'neutral'};
  const col = c => String(c).includes('bull') ? 'var(--bull)' : String(c).includes('bear') ? 'var(--bear)' : 'var(--neu)';
  const lv = (n, v) => Number.isFinite(+v) && +v > 0 ? `<div><span>${n}</span><b>${fmt(v)}</b></div>` : '';
  /* Nearest level on the right side of price (the raw 7-day low was shown as "support" even after today broke
     below it). Names like "Swing S2 — 14D Low"; scaled by the calibration like the other levels. */
  const lvNear = (n, o) => o && +o.v > 0 ? `<div><span>${n} (${escHtml(String(o.n || '').replace(/^Swing [SR]\d — /, ''))})</span><b>${fmt(+o.v * D.k)}</b></div>` : `<div><span>${n}</span><b>none nearby</b></div>`;
  return `${mcxCalHtml(sym)}${commodityIdeaHtml(sym, x)}${mcxExtrasHtml(sym, D, x)}
    <div class="idea-card" style="border-color:var(--brd)">
      <div class="idea-kicker">Market context</div>
      <div class="idea-grid" style="margin-top:8px">
        <div><span>Daily trend</span><b style="color:${col(dr.c)}">${escHtml(dr.l)}</b></div>
        <div><span>Weekly trend</span><b style="color:${col(wr.c)}">${escHtml(wr.l)}</b></div>
        <div><span>Price location</span><b style="color:${col(loc.cls)}">${escHtml(loc.label)}</b></div>
        ${lvNear('Support', sr.nearestSupport)}${lv('Pivot', sr.pp)}${lvNear('Resistance', sr.nearestResistance)}
      </div>
      <div class="idea-foot">${escHtml(loc.note || '')}</div>
    </div>`;
}
function mcxCalHtml(sym){
  const c = mcxCal(sym), proxy = getCurrentLivePrice();
  return `<div class="idea-card mcx-cal" style="border-color:var(--brd)">
    <div class="mcx-cal-row">
      <label><span class="idea-kicker">Your MCX price</span><input data-mcx-cal type="number" min="0" step="any" value="${c ? c.mcx : ''}" placeholder="₹ per ${escHtml(MCX_IDEA[sym]?.unit || 'unit')}"></label>
      <button class="idea-btn" onclick="mcxCalSet('${sym}')">Calibrate</button>${c ? `<button class="idea-btn ghost" onclick="mcxCalSet('${sym}', true)">Reset</button>` : ''}
      <span data-mcx-cal-msg class="mcx-cal-msg">${c
        ? `Calibrated ${escHtml(new Date(c.ts).toLocaleString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'}))}: MCX ₹${fmt(c.mcx)} vs proxy ₹${fmt(c.proxy)} (${c.mcx >= c.proxy ? '+' : ''}${((c.mcx/c.proxy - 1)*100).toFixed(2)}%). Every level on this page is shifted by that gap (kept 3 days).`
        : `Levels use the proxy ₹${fmt(proxy)} (international price × USD/INR${/GOLD|SILVER|COPPER/.test(sym) ? ' × MCX factor' : ''}). Type your broker's live MCX price to shift every level to the real contract.`}</span>
    </div></div>`;
}

/* Buy / sell zones: levels within 4 ATR of price, merged when closer than 0.35 ATR. A zone where two or
   more levels overlap is "strong". */
function mcxZones(sym, D){
  const {C, H, L, price} = D, n = C.length;
  if(n < 30 || !(price > 0)) return null;
  const atr = SwingPlan.atrWilder(C, H, L, price, D.sr.r1, D.sr.s1);
  if(!(atr > 0)) return null;
  const lv = [], add = (v, src) => { if(v > 0 && Math.abs(v - price) <= 4*atr) lv.push({v, src}); };
  add(H[n-2], 'previous day high'); add(L[n-2], 'previous day low'); add(C[n-2], 'previous close');
  add(Math.max(...H.slice(n-6, n-1)), '5-day high'); add(Math.min(...L.slice(n-6, n-1)), '5-day low');
  add(Math.max(...H.slice(n-21, n-1)), '20-day high'); add(Math.min(...L.slice(n-21, n-1)), '20-day low');
  let sh = 0, sl = 0;
  for(let i = n-3; i >= Math.max(2, n-60) && (sh < 3 || sl < 3); i--){
    if(sh < 3 && H[i] >= Math.max(H[i-1], H[i-2], H[i+1], H[i+2])){ add(H[i], 'swing high'); sh++; }
    if(sl < 3 && L[i] <= Math.min(L[i-1], L[i-2], L[i+1], L[i+2])){ add(L[i], 'swing low'); sl++; }
  }
  add(emaLast(C, 20), 'EMA20'); add(emaLast(C, 50), 'EMA50');
  const step = MCX_ROUND[sym];
  if(step){ add(Math.floor(price/step)*step, 'round number'); add(Math.ceil(price/step)*step, 'round number'); }
  lv.sort((a,b) => a.v - b.v);
  const zones = [];
  for(const p of lv){ const z = zones[zones.length-1]; if(z && p.v - z.hi <= 0.35*atr){ z.hi = p.v; z.src.push(p.src); } else zones.push({lo:p.v, hi:p.v, src:[p.src]}); }
  zones.forEach(z => { z.src = [...new Set(z.src)]; z.strength = z.src.length; const w = 0.2*atr; if(z.hi - z.lo < w){ const m = (z.lo + z.hi)/2; z.lo = m - w/2; z.hi = m + w/2; } });
  const inside = zones.find(z => price >= z.lo && price <= z.hi) || null;
  const below = zones.filter(z => z.hi < price).sort((a,b) => b.hi - a.hi).slice(0, 2);
  const above = zones.filter(z => z.lo > price).sort((a,b) => a.lo - b.lo).slice(0, 2);
  return { atr, price, inside, below, above, all:zones };
}
function mcxZonesHtml(sym, D, x){
  const z = mcxZones(sym, D);
  if(!z) return '';
  const a = z.atr, side = x?.side || 'WAIT', b = z.below[0], s = z.above[0];
  const zr = q => `₹${fmt(q.lo)} - ₹${fmt(q.hi)}`;
  let status, cls;
  if(z.inside){ status = `Price is inside a zone (${zr(z.inside)}). Wait: a daily close above ₹${fmt(z.inside.hi)} turns it into support, a close below ₹${fmt(z.inside.lo)} into resistance.`; cls = 'neutral'; }
  else if(b && z.price - b.hi <= 0.3*a){ status = side === 'SELL' ? `At a buy zone, but the trend is down: book short profits here - no fresh buying.` : `At a buy zone: buy only if a candle closes back above ₹${fmt(b.lo)} (the zone holds).`; cls = 'bull'; }
  else if(s && s.lo - z.price <= 0.3*a){ status = side === 'BUY' ? `At a sell zone, but the trend is up: book long profits here - no fresh selling.` : `At a sell zone: sell only if a candle closes back below ₹${fmt(s.hi)} (the zone holds).`; cls = 'bear'; }
  else { status = `Between zones - the no-trade middle. Wait for price to reach ${b ? `the buy zone ${zr(b)}` : ''}${b && s ? ' or ' : ''}${s ? `the sell zone ${zr(s)}` : ''}.`; cls = 'neutral'; }
  const row = (q, dir) => {
    const entry = dir > 0 ? q.hi : q.lo, stop = dir > 0 ? q.lo - 0.5*a : q.hi + 0.5*a;
    /* Target: the first zone in the way, however close - price meets it first. Skipping to the next "strong"
       zone, or past zones within half an ATR, jumped over the zone price was sitting in (crude: a 9,357 sell
       aimed at 8,284 past 8,998-9,200, R:R 3.64); a close obstacle now shows as a small R:R ("skip"). */
    const beyond = dir > 0 ? z.all.filter(t => t !== q && t.lo > entry) : [...z.all].reverse().filter(t => t !== q && t.hi < entry);
    const tz = beyond[0];
    const tgt = tz ? (dir > 0 ? tz.lo : tz.hi) : null, rr = tgt ? Math.abs(tgt - entry) / Math.abs(entry - stop) : null;
    const against = (dir > 0 && side === 'SELL') || (dir < 0 && side === 'BUY'), withT = (dir > 0 && side === 'BUY') || (dir < 0 && side === 'SELL');
    const note = against ? '<span style="color:var(--neu)">against the trend - use it to book profit, not to enter</span>'
      : rr != null && rr < SWING_MIN_RR ? '<span style="color:var(--bear)">R:R below 1.25 - skip</span>'
      : withT ? '<span style="color:var(--bull)">with the trend</span>' : '';
    return `<div class="zone-row ${dir > 0 ? 'buy' : 'sell'}">
      <div class="zone-main"><b>${dir > 0 ? 'Buy zone' : 'Sell zone'} ${zr(q)}</b><span class="zone-tag${q.strength >= 2 ? ' strong' : ''}">${q.strength >= 2 ? 'strong' : 'single level'}</span><span class="zone-dist">${(Math.abs(entry - z.price)/a).toFixed(1)} ATR away</span></div>
      <div class="zone-sub">${escHtml(q.src.join(' + '))} · stop ${dir > 0 ? 'below' : 'above'} ₹${fmt(stop)}${tgt ? ` · target ₹${fmt(tgt)} · R:R ${rr.toFixed(2)}` : ''}${note ? ' · ' + note : ''}</div>
    </div>`;
  };
  return `<div class="idea-card" style="border-color:var(--brd)">
    <div class="idea-kicker">Buy / sell zones · where</div>
    <div class="idea-comment zone-status ${cls}">${escHtml(status)}</div>
    ${z.above.slice().reverse().map(q => row(q, -1)).join('')}
    <div class="zone-price">${z.inside ? `Now ₹${fmt(z.price)} · inside ${zr(z.inside)}` : `Now ₹${fmt(z.price)}`}</div>
    ${z.below.map(q => row(q, 1)).join('')}
    <div class="idea-foot">A zone is where levels overlap: previous day, 5-day and 20-day highs/lows, swing points, EMA20/50 and round numbers. Enter only when price reaches a zone and holds it; in between, wait. ATR ₹${fmt(a)}.</div>
  </div>`;
}

function mcxExtrasHtml(sym, D, x){
  return `${mcxZonesHtml(sym, D, x)}
    <div class="idea-card" style="border-color:var(--brd)" data-mcx-drivers data-side="${x?.side || 'WAIT'}"><div class="idea-kicker">Global drivers · why</div><div class="idea-foot">Loading…</div></div>
    <div class="mcx-two">
      <div class="idea-card" style="border-color:var(--brd)" data-mcx-events><div class="idea-kicker">Events & timing · when</div><div class="idea-foot">Loading…</div></div>
      <div class="idea-card" style="border-color:var(--brd)" data-mcx-news><div class="idea-kicker">News</div><div class="idea-foot">Loading…</div></div>
    </div>`;
}
function mcxDriversHtml(d, side){
  const ok = (d?.drivers || []).filter(v => !v.error);
  if(!ok.length) return `<div class="idea-kicker">Global drivers · why</div><div class="idea-foot">Not loaded - try again in a minute.</div>`;
  const net = d.bull - d.bear, lean = net >= 2 ? 'bull' : net <= -2 ? 'bear' : 'neutral';
  const align = side === 'BUY' ? (lean === 'bear' ? '⚠ The drivers disagree with the BUY plan - wait, or trade half size.' : lean === 'bull' ? '✓ The drivers agree with the BUY plan.' : 'Drivers are mixed - the price trend leads.')
    : side === 'SELL' ? (lean === 'bull' ? '⚠ The drivers disagree with the SELL plan - wait, or trade half size.' : lean === 'bear' ? '✓ The drivers agree with the SELL plan.' : 'Drivers are mixed - the price trend leads.')
    : lean === 'neutral' ? 'No price trend and no driver push - range trade only.' : `No price trend yet, but the drivers ${lean === 'bull' ? 'support a rise' : 'point to a fall'} - watch for a breakout ${lean === 'bull' ? 'up' : 'down'}.`;
  return `<div class="idea-head"><div><div class="idea-kicker">Global drivers · why</div><div class="idea-title">${d.bull} of ${d.total} support a rise · ${d.bear} a fall</div></div>
      <div class="idea-view ${lean}">${lean === 'bull' ? 'Supportive' : lean === 'bear' ? 'Negative' : 'Mixed'}</div></div>
    <div class="idea-comment"><b>${escHtml(align)}</b></div>
    <div class="drv-list">${d.drivers.map(v => `<div class="drv-row"><span class="drv-ic ${v.vote > 0 ? 'bull' : v.vote < 0 ? 'bear' : 'neutral'}">${v.vote > 0 ? '▲' : v.vote < 0 ? '▼' : '•'}</span><b>${escHtml(v.label)}</b><span>${escHtml(v.text)}</span></div>`).join('')}</div>
    <div class="idea-foot">▲ pushes the MCX price up, ▼ down. From daily closes (5-day change and the 20-day average); refreshed every 15 min.</div>`;
}
function mcxEventsHtml(sym, cal){
  const cats = MCX_EVENT_CATS[sym] || [], t = istDateKey(), dayKey = ms => new Date(ms + 330*60000).toISOString().slice(0, 10);
  const lim = dayKey(Date.now() + 7*86400e3), tom = dayKey(Date.now() + 86400e3);
  const ev = (cal || []).filter(e => cats.includes(e.category) && !(e.category === 'CPI' && e.country === 'IN') && e.date >= t && e.date <= lim);
  const soon = ev.filter(e => e.date <= tom && e.impact === 'HIGH');
  return `<div class="idea-kicker">Events & timing · when</div>
    ${soon.length ? `<div class="idea-hedge" style="border-color:var(--bear)"><b>⚠ ${escHtml(soon.map(e => `${e.event} ${evDay(e.date).toLowerCase()}${e.time ? ' ' + e.time : ''}`).join('; '))}</b> - no fresh entry in the hour before; keep the stop-loss order in place.</div>` : ''}
    <div class="drv-list">${ev.length ? ev.map(e => `<div class="drv-row"><span class="drv-ic ${e.impact === 'HIGH' ? 'bear' : 'neutral'}">${e.impact === 'HIGH' ? '!' : '•'}</span><b>${escHtml(evDay(e.date))}${e.time ? ' · ' + escHtml(e.time) : ''}</b><span>${escHtml(e.event)}</span></div>`).join('')
      : '<div class="drv-row"><span class="drv-ic neutral">•</span><span>No scheduled event in the next 7 days.</span></div>'}</div>
    <ul class="idea-why"><li><b>Contract:</b> ${escHtml(MCX_CONTRACT_NOTE[sym] || 'Check the expiry date with your broker.')}</li><li><b>Session:</b> ${escHtml(MCX_SESSION_NOTE)}</li></ul>
    <div class="idea-foot">US weekly data follows its usual weekday; Fed / RBI / CPI dates come from the app calendar. Verify before trading.</div>`;
}
function mcxNewsHtml(r){
  const items = (r?.items || []).slice(0, 4);
  if(!items.length) return `<div class="idea-kicker">News</div><div class="idea-foot">No recent headlines found.</div>`;
  const s = r.summary?.sentiment;
  return `<div class="idea-head"><div class="idea-kicker">News · ${escHtml(r.window || 'latest')}</div><div class="idea-view ${s === 'bull' ? 'bull' : s === 'bear' ? 'bear' : 'neutral'}">${s === 'bull' ? 'Bullish tone' : s === 'bear' ? 'Bearish tone' : 'Mixed tone'}</div></div>
    <div class="drv-list">${items.map(i => `<div class="drv-row"><span class="drv-ic ${i.s === 'bull' ? 'bull' : i.s === 'bear' ? 'bear' : 'neutral'}">${i.s === 'bull' ? '▲' : i.s === 'bear' ? '▼' : '•'}</span><span>${i.link && /^https?:\/\//i.test(i.link) ? `<a href="${escHtml(i.link)}" target="_blank" rel="noopener noreferrer">${escHtml(i.title)}</a>` : escHtml(i.title)} <i>${escHtml(i.source || '')}${i.date ? ' · ' + escHtml(i.date) : ''}</i></span></div>`).join('')}</div>
    <div class="idea-foot">Tone comes from keyword rules on the headline - read the story before acting. Full list in the News tab.</div>`;
}
/* Fills the drivers / events / news placeholders after the Overview is on screen (never blocks it). */
function mcxFillAsync(sym){
  const side = document.querySelector('[data-mcx-drivers]')?.dataset.side || 'WAIT';
  const put = (sel, html) => { const el = document.querySelector(sel); if(el && CUR_SYM === sym) el.innerHTML = html; };
  apiFetch('/api/mcx-drivers?sym=' + encodeURIComponent(sym), 30000)
    .then(d => put('[data-mcx-drivers]', mcxDriversHtml(d, side)))
    .catch(e => put('[data-mcx-drivers]', `<div class="idea-kicker">Global drivers · why</div><div class="idea-foot">Not loaded: ${escHtml(e.message || 'error')}</div>`));
  ideaCalendar().then(cal => put('[data-mcx-events]', mcxEventsHtml(sym, cal)));
  const key = `news_${sym}`, st = sym.replace(/NSE:|MCX:|CRYPTO:/g, '');
  (AI_CACHE[key] ? Promise.resolve(AI_CACHE[key]) : fetchLiveNews(sym, CLIENT_NAMES[st] || document.getElementById('ihn')?.textContent || st).then(r => (AI_CACHE[key] = r)))
    .then(r => put('[data-mcx-news]', mcxNewsHtml(r))).catch(() => put('[data-mcx-news]', mcxNewsHtml(null)));
}

/* The trailing level for the rest of the position: EMA20 while price is on the trade's side of it, else EMA50
   (a long already below EMA20 used to be told to exit "on a close through EMA20"). */
function mcxTrailLevel(x){
  const long = x.side !== 'SELL', e20ok = Number.isFinite(+x.e20) && (long ? x.price > x.e20 : x.price < x.e20);
  return e20ok || !Number.isFinite(+x.e50) ? `EMA20 (${fmt(x.e20)})` : `EMA50 (${fmt(x.e50)})`;
}
function buildCommodityIdea(sym, D){
  const cfg = MCX_IDEA[sym];
  if(!cfg || !CUR_DATA?.daily?.C?.length) return null;
  D = D || mcxData(sym);
  const {C, H, L, price, sr} = D;
  const e20 = emaLast(C,20), e50 = emaLast(C,50), rsi = calcRSI(C);
  const atr = SwingPlan.atrWilder(C, H, L, price, sr.r1, sr.s1);
  const up = price > e50 && e20 > e50, down = price < e50 && e20 < e50;
  const res = [sr.r1, sr.r2, sr.r3].map(Number).filter(v => v > 0).sort((a,b) => a-b);
  const sup = [sr.s1, sr.s2, sr.s3].map(Number).filter(v => v > 0).sort((a,b) => b-a);
  let side = 'WAIT', entry = null, sl = null, t1 = null, t2 = null, action = '', why = '';
  if(up){
    side = 'BUY';
    const extended = price - e20 > 1.5*atr;
    entry = extended ? e20 : price;
    action = extended ? `Wait for a dip to EMA20 ${fmt(e20)} - price is ${((price-e20)/atr).toFixed(1)} ATR above it` : `Buy now / near ${fmt(price)}`;
    if(rsi > 72){ action = `RSI ${fmt(rsi,1)} is stretched - wait for a dip to EMA20 ${fmt(e20)}`; entry = e20; }
    sl = SwingPlan.calcAtrStopLoss({side:'long', price:entry, structuralStop: Math.min(e20, sup.find(v => v < entry) || e20) - 0.5*atr, atr});
    t1 = res.find(v => v > entry + atr) || entry + 2*atr; t2 = res.find(v => v > t1 + 0.5*atr) || t1 + atr*1.5;
    why = `Uptrend: price above EMA50 ${fmt(e50)} and EMA20 above EMA50.`;
  } else if(down){
    side = 'SELL';
    const extended = e20 - price > 1.5*atr;
    entry = extended ? e20 : price;
    action = extended ? `Wait for a rise to EMA20 ${fmt(e20)} - price is ${((e20-price)/atr).toFixed(1)} ATR below it` : `Sell now / near ${fmt(price)}`;
    if(rsi < 28){ action = `RSI ${fmt(rsi,1)} is oversold - wait for a rise to EMA20 ${fmt(e20)}`; entry = e20; }
    sl = SwingPlan.calcAtrStopLoss({side:'short', price:entry, structuralStop: Math.max(e20, res.find(v => v > entry) || e20) + 0.5*atr, atr});
    t1 = sup.find(v => v < entry - atr) || entry - 2*atr; t2 = sup.find(v => v < t1 - 0.5*atr) || t1 - atr*1.5;
    why = `Downtrend: price below EMA50 ${fmt(e50)} and EMA20 below EMA50.`;
  } else {
    why = `No trend: price ${price > e50 ? 'above' : 'below'} EMA50 ${fmt(e50)} but EMA20 ${e20 > e50 ? 'above' : 'below'} it. Trade only from the range edges - see the buy / sell zones below.`;
  }
  let risk = entry != null ? Math.abs(entry - sl) : null, rr = risk ? Math.abs(t1 - entry) / risk : null;
  /* Same minimum as the stock plans: below 1.25 R:R the trade waits for a better price. Entry where R:R = 1.25
     (stop and target unchanged): e = (T1 + 1.25 x SL) / 2.25. */
  if(rr != null && rr < SWING_MIN_RR){
    const better = (t1 + SWING_MIN_RR * sl) / 2.25;
    if(side === 'BUY' ? better < entry && better > sl : better > entry && better < sl){
      action = `R:R ${rr.toFixed(2)} at ${fmt(entry)} is below 1.25 - wait to ${side === 'BUY' ? 'buy nearer' : 'sell nearer'} ${fmt(better)}`;
      entry = better; risk = Math.abs(entry - sl); rr = Math.abs(t1 - entry) / risk;
    } else action = `R:R ${rr.toFixed(2)} is below 1.25 - no trade at these levels`;
  }
  let hedge = null;
  if(cfg.hedge && entry != null){
    const hv = Math.max(ideaHistVol(C, 20) || 0, (ideaHistVol(C, 60) || 0) * 0.8) || 0.35;
    const T = 21/365, type = side === 'SELL' ? 'C' : 'P';
    const K = side === 'SELL' ? Math.ceil(sl / cfg.optStep) * cfg.optStep : Math.floor(sl / cfg.optStep) * cfg.optStep;
    const prem = ideaBs(price, K, T, hv, type);
    const worst = (side === 'SELL' ? K - entry : entry - K) + prem;   /* per unit, however far price runs */
    hedge = { type, K, prem, hv, worst, be: side === 'SELL' ? entry - prem : entry + prem };
  }
  const lossPerLot = entry == null ? null : (hedge ? hedge.worst : risk) * cfg.lotQty;   /* with the hedge: the capped loss */
  return { sym, cfg, k:D.k, price, e20, e50, rsi, atr, side, entry, sl, t1, t2, risk, rr, action, why, hedge, lossPerLot };
}
function commodityIdeaHtml(sym, x){
  x = x || buildCommodityIdea(sym);
  if(!x) return '';
  const {cfg} = x, q = cfg.lotQty, u = cfg.unit;
  const src = x.k !== 1 ? `Levels calibrated to your MCX price (${x.k >= 1 ? '+' : ''}${((x.k - 1)*100).toFixed(2)}% vs the proxy).` : 'Prices are a proxy (international futures × USD/INR) - calibrate with your MCX price below / check the MCX quote before ordering.';
  const head = `<div class="idea-head"><div><div class="idea-kicker">Today's futures idea · ${escHtml(cfg.name)}</div><div class="idea-title">${x.side === 'WAIT' ? 'No trend - range trade only' : `${x.side} ${escHtml(cfg.name)} future`}</div></div>
    <div class="idea-view ${x.side === 'BUY' ? 'bull' : x.side === 'SELL' ? 'bear' : 'neutral'}">${x.side}</div></div>`;
  if(x.side === 'WAIT') return `<div class="idea-card">${head}<div class="idea-comment">${escHtml(x.why)}</div><div class="idea-foot">${escHtml(cfg.lotNote)} ${escHtml(src)}</div></div>`;
  const h = x.hedge;
  const hedgeHtml = h ? `<div class="idea-hedge"><b>Hedge:</b> buy ${h.K} ${h.type === 'C' ? 'CE (call)' : 'PE (put)'} ≈ ₹${fmt(h.prem)} per ${u} (~3 weeks, volatility ${Math.round(h.hv*100)}% from recent price swings).
      With the hedge the loss is capped near ₹${fmt(h.worst)} per ${u} (₹${fmt(h.worst*q,0)} per Mini lot) even on a gap, and breakeven moves to ${fmt(h.be)}.
      MCX's main crude option is on the 100-barrel contract, so one option covers 10 Mini lots - for fewer Mini lots, check whether your broker offers Mini options or rely on the stop-loss.</div>` : '';
  return `<div class="idea-card">${head}
    <div class="idea-comment">${escHtml(cfg.name)} ${fmt(x.price)} · ${escHtml(x.why)} → <b>${escHtml(x.action)}</b></div>
    <div class="idea-grid">
      <div><span>Entry</span><b>${fmt(x.entry)}</b></div>
      <div><span>Stop-loss (order)</span><b>${fmt(x.sl)} · ₹${fmt(x.risk*q,0)} per lot</b></div>
      <div><span>Target 1 / Target 2</span><b>${fmt(x.t1)} / ${fmt(x.t2)}</b></div>
      <div><span>Reward per lot (T1)</span><b>₹${fmt(Math.abs(x.t1-x.entry)*q,0)} · R:R ${x.rr ? x.rr.toFixed(2) : '--'}</b></div>
      <div><span>ATR (daily range)</span><b>${fmt(x.atr)}</b></div>
      <div><span>RSI</span><b>${fmt(x.rsi,1)}</b></div>
    </div>
    ${ideaSizeHtml(x.lossPerLot, 'stop-loss risk')}
    ${hedgeHtml}
    <ul class="idea-why"><li><b>Exit:</b> book half at T1 and move the stop to entry; exit the rest at T2 or on a daily close ${x.side === 'SELL' ? 'above' : 'below'} ${mcxTrailLevel(x)}.</li></ul>
    <div class="idea-foot">${escHtml(cfg.lotNote)} ${escHtml(src)} Check margin and circuit limits before ordering.</div>
  </div>`;
}

async function tabPulse(sym){
  if(sym !== 'NSE:NIFTY') return tabIndexOwnPulse(sym);
  /* No spinner write here: renderTab / tabAnalysis already show one, and this write (without a stale check)
     replaced a newer page with a spinner that never cleared. */
  const{C,H,L,V}=CUR_DATA.daily,n=C.length,price=getCurrentLivePrice();
  const rec=CUR_DATA.daily.rec,weeklyRec=CUR_DATA.weekly?.rec;
  const combinedBias=(rec.value+(weeklyRec?.value||0))/2;
  const isIndex=sym==='NSE:NIFTY'||sym==='NSE:BANKNIFTY';

  let vix = GLOBAL_DATA?.vix?.price || null;
  if(!vix && isIndex){ try{vix=await fetchVIX();}catch{} }

  const ivRank = GLOBAL_DATA?.ivRank || null;
  const ivPerc = ivRank ? ivRank.rank : (vix ? Math.round(Math.max(10,Math.min(90,(vix-10)/20*100))) : 50);
  const ivColor = ivPerc>70?'var(--bear)':ivPerc<30?'var(--bull)':'var(--neu)';
  const breadth = GLOBAL_DATA?.breadth || null;

  const volEnd=Math.max(0, Math.min(V.length, n)-1);
  const volSlice20=V.slice(Math.max(0, volEnd-20), volEnd);
  const avgVol=volSlice20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volSlice20.length);
  const volToday=V[n-1]||0,volRatio=avgVol?volToday/avgVol:1;

  let verdict='Neutral',verdictC='neutral',verdictIcon='⚖️',verdictSub='Mixed signals.';
  const adBull = breadth ? breadth.advances > breadth.declines * 1.5 : false;
  const adBear = breadth ? breadth.declines > breadth.advances * 1.5 : false;
  /* IV percentile measures option pricing, not direction, so it no longer votes bull/bear.
     VIX above 18 stays as a risk-off (fear) signal. */
  const bullSignals=[combinedBias>0.1,adBull,volRatio>1.4&&combinedBias>0].filter(Boolean).length;
  const bearSignals=[vix&&vix>18,combinedBias<-0.1,adBear,volRatio>1.4&&combinedBias<0].filter(Boolean).length;
  /* Name the signals that actually voted (it used to claim "breadth, VIX, volume and trend" when only breadth did). */
  const bullWhy=[combinedBias>0.1&&'trend',adBull&&'breadth',volRatio>1.4&&combinedBias>0&&'volume'].filter(Boolean);
  const bearWhy=[vix&&vix>18&&'VIX above 18',combinedBias<-0.1&&'trend',adBear&&'breadth',volRatio>1.4&&combinedBias<0&&'volume'].filter(Boolean);
  const whyTxt=a=>a.join(', ').replace(/^./,m=>m.toUpperCase());
  if(bullSignals>bearSignals){verdict='Bullish Bias';verdictC='bull';verdictIcon='📈';verdictSub=`${whyTxt(bullWhy)} lean${bullWhy.length===1?'s':''} bullish${bearWhy.length?` (against: ${bearWhy.join(', ')})`:''}.`;}
  else if(bearSignals>bullSignals){verdict='Bearish Bias';verdictC='bear';verdictIcon='📉';verdictSub=`${whyTxt(bearWhy)} lean${bearWhy.length===1?'s':''} bearish${bullWhy.length?` (against: ${bullWhy.join(', ')})`:''}.`;}

  const vixColor=vix?vix<15?'var(--bull)':vix<20?'var(--neu)':'var(--bear)':'var(--tx2)';
  const vixLabel=vix?vix<15?'Low (Complacency)':vix<20?'Moderate':vix<25?'Elevated':'High (Fear)':'N/A';

  const breadthHtml = breadth ? `
    ${secT('Market Breadth — Nifty 50 Stocks (Live)')}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:14px">
      <div class="strat-cell" style="text-align:center"><div class="strat-label">Advances</div><div style="font-size:1.5rem;font-weight:800;color:var(--bull)">${breadth.advances}</div><div style="font-size:.68rem;color:var(--tx3)">stocks up today</div></div>
      <div class="strat-cell" style="text-align:center"><div class="strat-label">Declines</div><div style="font-size:1.5rem;font-weight:800;color:var(--bear)">${breadth.declines}</div><div style="font-size:.68rem;color:var(--tx3)">stocks down today</div></div>
      <div class="strat-cell" style="text-align:center"><div class="strat-label">A/D Ratio</div><div style="font-size:1.5rem;font-weight:800;color:${breadth.adRatio>1.2?'var(--bull)':breadth.adRatio<0.8?'var(--bear)':'var(--neu)'}">${breadth.adRatio}</div><div style="font-size:.68rem;color:var(--tx3)">${breadth.adRatio>2?'Strong advance':breadth.adRatio>1.2?'Mild advance':breadth.adRatio<0.5?'Strong decline':breadth.adRatio<0.8?'Mild decline':'Balanced'}</div></div>
      <div class="strat-cell" style="text-align:center"><div class="strat-label">Unchanged</div><div style="font-size:1.5rem;font-weight:800;color:var(--neu)">${breadth.unchanged}</div><div style="font-size:.68rem;color:var(--tx3)">flat stocks</div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
      <div class="strat-cell"><div class="strat-label">52-Week Highs (Nifty 50)</div><div style="font-size:1.1rem;font-weight:800;color:var(--bull)">${breadth.hi52Count} stocks</div><div style="font-size:.72rem;color:var(--tx3);margin-top:2px">${breadth.hi52Count>5?'Strong bull — many stocks at yearly peak':breadth.hi52Count>2?'Moderate — selective buying':'Few stocks at highs'}</div></div>
      <div class="strat-cell"><div class="strat-label">52-Week Lows (Nifty 50)</div><div style="font-size:1.1rem;font-weight:800;color:var(--bear)">${breadth.lo52Count} stocks</div><div style="font-size:.72rem;color:var(--tx3);margin-top:2px">${breadth.lo52Count>5?'Warning — widespread weakness':breadth.lo52Count>2?'Some stocks under pressure':'Low count — not broad selloff'}</div></div>
    </div>
    <div class="aib" style="margin-bottom:14px;font-size:.75rem">${breadth.label} · Based on ${breadth.total} Nifty 50 stocks · Updated ${timeAgo(breadth.updatedAt)}</div>` : '';

  return`<div class="market-verdict" style="border-color:${verdictC==='bull'?'var(--bull)':verdictC==='bear'?'var(--bear)':'var(--brd)'}"><div class="mv-icon">${verdictIcon}</div><div class="mv-title" style="color:${verdictC==='bull'?'var(--bull)':verdictC==='bear'?'var(--bear)':'var(--neu)'}">${verdict}</div><div class="mv-sub">${verdictSub}</div></div>`+
  breadthHtml+
  `<div class="pulse-row">
    ${isIndex&&vix!=null?`<div class="pulse-metric"><div class="pm-label">India VIX (Live)</div><div class="pm-val" style="color:${vixColor}">${vix.toFixed(2)}</div><div class="pm-sub">${vixLabel}</div><div class="vix-bar-wrap"><div class="vix-bar" style="width:${Math.min(100,(vix/30)*100)}%;background:${vixColor}"></div></div></div>`:''}
    <div class="pulse-metric"><div class="pm-label">IV Percentile ${ivRank?'(Real — VIX 52w)':'(Estimated)'}</div><div class="pm-val" style="color:${ivColor}">${ivPerc}%</div><div class="pm-sub">${ivPerc>70?'Expensive premium zone':ivPerc<30?'Low premium zone':'Fair Value'}</div><div class="vix-bar-wrap"><div class="vix-bar" style="width:${ivPerc}%;background:${ivColor}"></div></div></div>
    <div class="pulse-metric"><div class="pm-label">Volume Pressure</div><div class="pm-val" style="color:${isIndex?'var(--neu)':volRatio>1.4?(combinedBias>=0?'var(--bull)':'var(--bear)'):'var(--neu)'}">${isIndex?'N/A':volRatio.toFixed(2)+'x'}</div><div class="pm-sub">${isIndex?'Index volume is not a reliable tradable field; use breadth/OI instead.':'Today volume vs last '+volSlice20.length+' bars average'}</div></div>
  </div>`+
  secT('Interpretation Guide')+
  `<div class="gauge-row pulse-guide">
    <div class="gauge-card"><div class="gauge-title">VIX Reading</div><div class="gauge-val" style="color:${vixColor}">${vix!=null?vix.toFixed(1):'--'}</div><div class="gauge-label" style="color:${vixColor}">${vixLabel}</div><div class="gauge-note">&lt;15 = Low fear · 15-20 = Normal · &gt;20 = Elevated · &gt;25 = Panic</div></div>
    <div class="gauge-card"><div class="gauge-title">IV Percentile</div><div class="gauge-val" style="color:${ivColor}">${ivPerc}%</div><div class="gauge-label" style="color:${ivColor}">${ivPerc>70?'Expensive':ivPerc<30?'Cheap':'Fair'}</div><div class="gauge-note">${ivRank?`${ivRank.daysBelow!=null?ivRank.daysBelow+'/'+ivRank.totalDays+' past year days had lower VIX':'52w VIX range: '+ivRank.lo52w+'–'+ivRank.hi52w}`:'Uses India VIX approximation when history is not loaded'}</div></div>
    <div class="gauge-card"><div class="gauge-title">Breadth Signal</div><div class="gauge-val" style="color:${breadth?.adRatio>1?'var(--bull)':'var(--bear)'}">${breadth?breadth.adRatio+':1':'--'}</div><div class="gauge-label" style="color:${breadth?.adRatio>1.2?'var(--bull)':breadth?.adRatio<0.8?'var(--bear)':'var(--neu)'}">${breadth?.label||'Loading...'}</div><div class="gauge-note">${breadth?`${breadth.hi52Count} at 52w high · ${breadth.lo52Count} at 52w low`:''}</div></div>
    <div class="gauge-card"><div class="gauge-title">Trend Bias</div><div class="gauge-val" style="color:${combinedBias>0.1?'var(--bull)':combinedBias<-0.1?'var(--bear)':'var(--neu)'}">${combinedBias>0.1?'Bull':combinedBias<-0.1?'Bear':'Flat'}</div><div class="gauge-label">Daily + Weekly</div><div class="gauge-note">Uses price trend plus daily/weekly recommendation only.</div></div>
  </div>`;
}

/* Market Pulse for every index except Nifty 50: the verdict comes from THIS index - its own trend, its EMAs
   and how it is doing against Nifty. It used to vote with Nifty 50 breadth, so Nifty IT read "Bullish -
   breadth leans bullish" on a day it fell 1.5% while Nifty rose. */
function idxDayPct(d){
  const C = d?.daily?.C || [];
  const p = firstFiniteNumber(d?.price, d?.livePrice, C[C.length-1]), pc = firstFiniteNumber(d?.prevDayClose, C[C.length-2]);
  return p && pc ? (p - pc) / pc * 100 : null;
}
async function tabIndexOwnPulse(sym){
  const d = CUR_DATA, C = d.daily.C, price = getCurrentLivePrice();
  const name = escHtml(document.getElementById('ihn')?.textContent || sym.replace('NSE:',''));
  const combined = ((d.daily.rec?.value || 0) + (d.weekly?.rec?.value || 0)) / 2;
  const e20 = emaLast(C,20), e50 = emaLast(C,50);
  const bench = await ensureNiftyBenchmarkData();
  const r1m = calcReturnPctFromCloses(C, 21), n1m = calcReturnPctFromCloses(bench?.daily?.C || [], 21);
  const rs = r1m != null && n1m != null ? r1m - n1m : null;
  const day = idxDayPct(d), nDay = idxDayPct(bench);
  const fno = !!IDX_OPT[sym];
  const vix = fno ? (+GLOBAL_DATA?.vix?.price || null) : null;
  const stackUp = price > e20 && e20 > e50, stackDn = price < e20 && e20 < e50;
  const bull = [combined > 0.1 && 'trend', stackUp && 'price above EMA20 > EMA50', rs != null && rs > 1 && `beating Nifty by ${rs.toFixed(1)}% in 1 month`].filter(Boolean);
  const bear = [combined < -0.1 && 'trend', stackDn && 'price below EMA20 < EMA50', rs != null && rs < -1 && `lagging Nifty by ${Math.abs(rs).toFixed(1)}% in 1 month`, vix > 18 && 'India VIX above 18'].filter(Boolean);
  /* Two signals at least: one alone (e.g. only lagging Nifty) is a lean, not a bias. */
  const v = bull.length >= 2 && bull.length > bear.length ? {t:'Bullish', c:'bull', i:'📈', w:bull, o:bear} : bear.length >= 2 && bear.length > bull.length ? {t:'Bearish', c:'bear', i:'📉', w:bear, o:bull} : {t:'Neutral', c:'neutral', i:'⚖️', w:[], o:[]};
  const sub = v.w.length ? `${v.w.join(', ').replace(/^./, m => m.toUpperCase())}${v.o.length ? ` (against: ${v.o.join(', ')})` : ''}.` : (bull.length || bear.length ? `No clear bias. ${bull.length ? 'For: ' + bull.join(', ') + '. ' : ''}${bear.length ? 'Against: ' + bear.join(', ') + '.' : ''}` : 'No clear signal.');
  const col = x => x == null ? 'var(--tx2)' : x > 0 ? 'var(--bull)' : x < 0 ? 'var(--bear)' : 'var(--neu)';
  const pct = x => x == null ? '--' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  const tile = (label, val, color, note) => `<div class="pulse-metric"><div class="pm-label">${label}</div><div class="pm-val" style="color:${color}">${val}</div><div class="pm-sub">${note}</div></div>`;
  const vc = v.c === 'bull' ? 'var(--bull)' : v.c === 'bear' ? 'var(--bear)' : 'var(--neu)';
  return `<div class="market-verdict" style="border-color:${v.c === 'neutral' ? 'var(--brd)' : vc}"><div class="mv-icon">${v.i}</div><div class="mv-title" style="color:${vc}">${name}: ${v.t} bias</div><div class="mv-sub">${escHtml(sub)}</div></div>
  <div class="pulse-row">
    ${tile('Trend (daily + weekly)', combined > 0.1 ? 'Up' : combined < -0.1 ? 'Down' : 'Flat', col(combined > 0.1 ? 1 : combined < -0.1 ? -1 : 0), 'Daily and weekly signal of this index')}
    ${tile('EMA20 / EMA50', stackUp ? 'Above both' : stackDn ? 'Below both' : 'Mixed', col(stackUp ? 1 : stackDn ? -1 : 0), `EMA20 ${fmt(e20)} · EMA50 ${fmt(e50)}`)}
    ${tile('1 month vs Nifty', rs == null ? '--' : `${rs >= 0 ? '+' : ''}${rs.toFixed(1)}%`, col(rs), `${name} ${pct(r1m)} · Nifty ${pct(n1m)}`)}
    ${tile('Today vs Nifty', pct(day), col(day == null || nDay == null ? null : day - nDay), `Nifty ${pct(nDay)}`)}
    ${fno && vix ? tile('India VIX', vix.toFixed(2), vix > 18 ? 'var(--bear)' : vix < 15 ? 'var(--bull)' : 'var(--neu)', vix > 18 ? 'High - fear' : vix < 15 ? 'Low' : 'Normal') : ''}
  </div>
  <div class="aib" style="font-size:.72rem">Nifty 50 breadth is not used here - it describes Nifty, not ${name}. It is shown on the Nifty 50 page.</div>`;
}

async function tabNews(sym){
  /* Use full company name from CLIENT_NAMES for better stock-specific news */
  const rawName = document.getElementById('ihn').textContent;
  const stockSym = sym.replace(/NSE:|MCX:|CRYPTO:/g,'');
  const name = CLIENT_NAMES[stockSym] || rawName;
  /* Names/symbols come from search results and the DOM (decoded text): escape before HTML, encode in URLs. */
  const nameHtml = escHtml(name), symUrl = encodeURIComponent(stockSym);
  const key = `news_${sym}`;
  const isIndex = NSE_INDEX_CODES.has(stockSym);

  let result=AI_CACHE[key];
  if(!result){
    document.getElementById('tc').innerHTML=`<div class="ls" style="display:flex;min-height:120px"><div class="sp"></div><div class="lt">Searching latest <strong>${nameHtml}</strong> news via layered news engine…</div></div>`;
    try{result=await fetchLiveNews(sym,name);AI_CACHE[key]=result;}
    catch{result={items:[]};}
  }

  const items = result.items || [];

  /* Fallback with stock-specific links */
  if(!items.length) return `<div style="text-align:center;padding:24px">
    <div style="font-size:1.2rem;margin-bottom:8px">📰</div>
    <div style="font-weight:700;margin-bottom:6px;color:var(--tx)">No news found for ${nameHtml}</div>
    <div style="font-size:.78rem;color:var(--tx2);margin-bottom:16px">Read latest ${nameHtml} news directly:</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center">
      <a href="https://economictimes.indiatimes.com/topic/${encodeURIComponent(name.toLowerCase().replace(/\s+/g,'-'))}" target="_blank" style="padding:7px 14px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);color:var(--acc);font-size:.78rem;text-decoration:none;font-weight:600">ET: ${escHtml(stockSym)} ↗</a>
      <a href="https://www.moneycontrol.com/news/tags/${encodeURIComponent(stockSym.toLowerCase())}/" target="_blank" style="padding:7px 14px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);color:var(--acc);font-size:.78rem;text-decoration:none;font-weight:600">Moneycontrol ↗</a>
      <a href="https://www.screener.in/company/${symUrl}/" target="_blank" style="padding:7px 14px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);color:var(--acc);font-size:.78rem;text-decoration:none;font-weight:600">Screener ↗</a>
      <a href="https://www.google.com/search?q=${encodeURIComponent(name+' NSE stock news today')}" target="_blank" style="padding:7px 14px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);color:var(--acc);font-size:.78rem;text-decoration:none;font-weight:600">Google News ↗</a>
    </div>
  </div>`;

  const bull = items.filter(i=>i.s==='bull').length;
  const bear = items.filter(i=>i.s==='bear').length;
  const neut = items.length - bull - bear;
  const summary = result.summary || {};
  const overall = summary.sentiment==='bull' ? {l:'Positive',c:'bull'} : summary.sentiment==='bear' ? {l:'Negative',c:'bear'} : (bull > bear*1.5 ? {l:'Positive',c:'bull'} : bear > bull*1.5 ? {l:'Negative',c:'bear'} : {l:'Mixed',c:'neutral'});
  const updatedAt = result.updatedAt ? new Date(result.updatedAt).toLocaleTimeString('en-IN') : '--';
  const srcMap = {rss:'RSS layer', 'rss+gdelt':'RSS + GDELT', 'api-marketaux':'Marketaux backup', 'api-newsdata':'NewsData backup', 'api-finnhub':'Finnhub global', mixed:'Mixed sources', none:'No-source fallback'};
  const srcLabel = srcMap[result.source] || String(result.source||'Layered news').replace(/\+/g,' + ');
  const windowLabel = result.window || summary.window || 'latest';
  const healthLabel = summary.healthLabel || (items.length>=5?'Good':items.length>=2?'Usable':'Weak');
  const newsScore = summary.newsScore ?? items.reduce((a,i)=>a+(i.impactScore||0),0);
  const sourceOk = (summary.sourceHealth||[]).filter(x=>x.ok&&x.found>0).slice(0,4).map(x=>`${escHtml(x.source)}:${escHtml(x.found)}`).join(' · ');

  /* Sentiment bar widths */
  const total = items.length || 1;
  const bw = Math.round(bull/total*100), bearW = Math.round(bear/total*100), nw = 100-bw-bearW;

  return `
    <div class="aib" style="margin-bottom:10px">
      📰 <strong style="color:var(--acc)">${nameHtml}</strong> · ${escHtml(srcLabel)} · ${escHtml(windowLabel)} · ${items.length} articles · ${updatedAt}
      <span style="float:right">${bdg(overall)}</span>
      <div style="font-size:.7rem;color:var(--tx3);margin-top:4px">Health: <strong style="color:${healthLabel==='Good'?'var(--bull)':healthLabel==='Usable'?'var(--neu)':'var(--bear)'}">${healthLabel}</strong> · News impact score: <strong style="color:${newsScore>10?'var(--bull)':newsScore<-10?'var(--bear)':'var(--neu)'}">${newsScore>0?'+':''}${newsScore}</strong>${sourceOk?' · '+sourceOk:''}</div>
    </div>

    ${newsScore>10 ? `<div class="aib" style="margin-bottom:10px"><strong style="color:var(--acc)">News is secondary.</strong> Positive news is present, but the trade is valid only if Overview/Decision confirms a technical entry.</div>` : ''}

    <div style="background:var(--bgc);border:1px solid var(--brd);border-radius:var(--rs);padding:10px 14px;margin-bottom:12px">
      <div style="font-size:.68rem;color:var(--tx3);font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">News Sentiment for ${nameHtml}</div>
      <div style="display:flex;height:8px;border-radius:4px;overflow:hidden;gap:2px;margin-bottom:6px">
        ${bw>0?`<div style="width:${bw}%;background:var(--bull);border-radius:4px 0 0 4px"></div>`:''}
        ${nw>0?`<div style="width:${nw}%;background:var(--brd)"></div>`:''}
        ${bearW>0?`<div style="width:${bearW}%;background:var(--bear);border-radius:0 4px 4px 0"></div>`:''}
      </div>
      <div style="display:flex;gap:16px;font-size:.72rem">
        <span style="color:var(--bull)">▲ ${bull} Bullish</span>
        <span style="color:var(--tx3)">● ${neut} Neutral</span>
        <span style="color:var(--bear)">▼ ${bear} Bearish</span>
      </div>
    </div>

    ${items.map(i=>{
      const sentCol = i.s==='bull'?'var(--bull)':i.s==='bear'?'var(--bear)':'var(--tx3)';
      const sentBg  = i.s==='bull'?'var(--bullb)':i.s==='bear'?'var(--bearb)':'var(--bgi)';
      const sentLbl = i.s==='bull'?'▲ Bullish':i.s==='bear'?'▼ Bearish':'Neutral';
      const scoreVal = i.impactScore ?? (i.sentScore!=null ? Math.round(i.sentScore*30) : null);
      const scoreStr = scoreVal != null ? ` · Impact ${scoreVal > 0 ? '+' : ''}${scoreVal}` : '';
      const catStr = i.category ? ` · ${i.category}` : '';
      return `<div class="ni" style="border-left:3px solid ${sentCol}">
        <div class="nit"><a href="${safeUrl(i.link)}" target="_blank" rel="noopener" style="text-decoration:none;color:var(--tx)">${escHtml(i.title || 'Untitled')}</a></div>
        ${i.desc && !newsDescRepeatsTitle(i)?`<div style="font-size:.72rem;color:var(--tx2);margin:4px 0 6px;line-height:1.4">${escHtml(i.desc)}</div>`:''}
        <div class="nim">
          <span class="nis">${escHtml(i.source || 'News')}</span>
          <span>${timeAgo(i.publishedAt || i.date)}</span>
          <span style="padding:1px 7px;border-radius:20px;font-size:.75rem;font-weight:700;background:${sentBg};color:${sentCol}">${sentLbl}${scoreStr}</span>${i.category?`<span style="color:var(--tx3)"> · ${escHtml(i.category)}</span>`:''}
        </div>
      </div>`;
    }).join('')}

    <div style="margin-top:10px;text-align:center;font-size:.72rem;color:var(--tx3)">
      Search more:
      <a href="https://economictimes.indiatimes.com/topic/${encodeURIComponent(name)}" target="_blank" style="color:var(--acc);margin:0 8px">ET ↗</a>
      <a href="https://www.moneycontrol.com/news/tags/${encodeURIComponent(stockSym.toLowerCase())}/" target="_blank" style="color:var(--acc);margin:0 8px">Moneycontrol ↗</a>
      <a href="https://www.screener.in/company/${symUrl}/" target="_blank" style="color:var(--acc);margin:0 8px">Screener ↗</a>
    </div>`;
}

/* ── STOCK SECTOR MAP ── */
/* Auto-rebuilt from Book1_final_corrected (1).xlsx: 271 stock symbols mapped to broad dashboard sectors. */
const STOCK_SECTOR = {
  /* IT */
  'NSE:COFORGE':'IT','NSE:HCLTECH':'IT','NSE:HEXT':'IT','NSE:INFY':'IT',
  'NSE:LTIM':'IT','NSE:LTTS':'IT','NSE:MPHASIS':'IT','NSE:NAUKRI':'IT',
  'NSE:OFSS':'IT','NSE:PERSISTENT':'IT','NSE:TCS':'IT','NSE:TECHM':'IT',
  'NSE:WIPRO':'IT',
  /* Banking */
  'NSE:AUBANK':'Banking','NSE:AXISBANK':'Banking','NSE:BANDHANBNK':'Banking','NSE:BANKBARODA':'Banking',
  'NSE:BANKINDIA':'Banking','NSE:CANBK':'Banking','NSE:CENTRALBK':'Banking','NSE:FEDERALBNK':'Banking',
  'NSE:HDFCBANK':'Banking','NSE:ICICIBANK':'Banking','NSE:IDFCFIRSTB':'Banking','NSE:INDIANB':'Banking',
  'NSE:INDUSINDBK':'Banking','NSE:IOB':'Banking','NSE:KOTAKBANK':'Banking','NSE:MAHABANK':'Banking',
  'NSE:PNB':'Banking','NSE:SBIN':'Banking','NSE:UCOBANK':'Banking','NSE:UNIONBANK':'Banking',
  'NSE:YESBANK':'Banking',
  /* Finance */
  'NSE:360ONE':'Finance','NSE:ABCAPITAL':'Finance','NSE:ABSLAMC':'Finance','NSE:AIIL':'Finance',
  'NSE:BAJAJFINSV':'Finance','NSE:BAJAJHFL':'Finance','NSE:BAJAJHLDNG':'Finance','NSE:BAJFINANCE':'Finance',
  'NSE:BSE':'Finance','NSE:CHOLAFIN':'Finance','NSE:CHOLAHLDNG':'Finance','NSE:CRISIL':'Finance',
  'NSE:GICRE':'Finance','NSE:GROWW':'Finance','NSE:HDBFS':'Finance','NSE:HDFCAMC':'Finance',
  'NSE:HDFCLIFE':'Finance','NSE:HUDCO':'Finance','NSE:ICICIAMC':'Finance','NSE:ICICIGI':'Finance',
  'NSE:ICICIPRULI':'Finance','NSE:IDBI':'Finance','NSE:IREDA':'Finance','NSE:IRFC':'Finance',
  'NSE:JIOFIN':'Finance','NSE:LICI':'Finance','NSE:LTF':'Finance','NSE:M&MFIN':'Finance',
  'NSE:MCX':'Finance','NSE:MFSL':'Finance','NSE:MOTILALOFS':'Finance','NSE:MUTHOOTFIN':'Finance',
  'NSE:NAM-INDIA':'Finance','NSE:PAYTM':'Finance','NSE:PFC':'Finance','NSE:PIRAMALFIN':'Finance',
  'NSE:POLICYBZR':'Finance','NSE:POONAWALLA':'Finance','NSE:RECLTD':'Finance','NSE:SBICARD':'Finance',
  'NSE:SBILIFE':'Finance','NSE:SHRIRAMFIN':'Finance','NSE:STARHEALTH':'Finance','NSE:SUNDARMFIN':'Finance',
  'NSE:TATACAP':'Finance','NSE:TATAINVEST':'Finance',
  /* Pharma */
  'NSE:ABBOTINDIA':'Pharma','NSE:AJANTPHARM':'Pharma','NSE:ALKEM':'Pharma','NSE:AUROPHARMA':'Pharma',
  'NSE:BIOCON':'Pharma','NSE:CIPLA':'Pharma','NSE:DIVISLAB':'Pharma','NSE:DRREDDY':'Pharma',
  'NSE:EMCURE':'Pharma','NSE:GLAND':'Pharma','NSE:GLAXO':'Pharma','NSE:GLENMARK':'Pharma',
  'NSE:IPCALAB':'Pharma','NSE:JBCHEPHARM':'Pharma','NSE:LAURUSLABS':'Pharma','NSE:LUPIN':'Pharma',
  'NSE:SUNPHARMA':'Pharma','NSE:TORNTPHARM':'Pharma','NSE:ZYDUSLIFE':'Pharma',
  /* Healthcare */
  'NSE:ANTHEM':'Healthcare','NSE:APOLLOHOSP':'Healthcare','NSE:ASTERDM':'Healthcare','NSE:FORTIS':'Healthcare',
  'NSE:MANKIND':'Healthcare','NSE:MAXHEALTH':'Healthcare','NSE:MEDANTA':'Healthcare','NSE:NH':'Healthcare',
  /* Auto */
  'NSE:ASHOKLEY':'Auto','NSE:ATHERENERG':'Auto','NSE:BAJAJ-AUTO':'Auto','NSE:BALKRISIND':'Auto',
  'NSE:BHARATFORG':'Auto','NSE:BOSCHLTD':'Auto','NSE:EICHERMOT':'Auto','NSE:ENDURANCE':'Auto',
  'NSE:ESCORTS':'Auto','NSE:HEROMOTOCO':'Auto','NSE:HYUNDAI':'Auto','NSE:M&M':'Auto',
  'NSE:MARUTI':'Auto','NSE:MOTHERSON':'Auto','NSE:MRF':'Auto','NSE:SCHAEFFLER':'Auto',
  'NSE:SONACOMS':'Auto','NSE:TIINDIA':'Auto','NSE:TMCV':'Auto','NSE:TMPV':'Auto',
  'NSE:TVSMOTOR':'Auto','NSE:UNOMINDA':'Auto',
  /* FMCG */
  'NSE:BERGEPAINT':'FMCG','NSE:BRITANNIA':'FMCG','NSE:COLPAL':'FMCG','NSE:DABUR':'FMCG',
  'NSE:GODFRYPHLP':'FMCG','NSE:GODREJCP':'FMCG','NSE:GODREJIND':'FMCG','NSE:HINDUNILVR':'FMCG',
  'NSE:ITC':'FMCG','NSE:MARICO':'FMCG','NSE:NESTLEIND':'FMCG','NSE:PATANJALI':'FMCG',
  'NSE:PGHH':'FMCG','NSE:RADICO':'FMCG','NSE:TATACONSUM':'FMCG','NSE:UBL':'FMCG',
  'NSE:UNITDSPR':'FMCG','NSE:VBL':'FMCG',
  /* Metal */
  'NSE:ADANIENT':'Metal','NSE:APLAPOLLO':'Metal','NSE:HINDALCO':'Metal','NSE:HINDCOPPER':'Metal',
  'NSE:HINDZINC':'Metal','NSE:JINDALSTEL':'Metal','NSE:JSL':'Metal','NSE:JSWSTEEL':'Metal',
  'NSE:LLOYDSME':'Metal','NSE:NATIONALUM':'Metal','NSE:NMDC':'Metal','NSE:SAIL':'Metal',
  'NSE:TATASTEEL':'Metal','NSE:VEDL':'Metal','NSE:WELCORP':'Metal',
  /* Energy */
  'NSE:ADANIENSOL':'Energy','NSE:ADANIGREEN':'Energy','NSE:ADANIPOWER':'Energy','NSE:ATGL':'Energy',
  'NSE:BPCL':'Energy','NSE:COALINDIA':'Energy','NSE:GAIL':'Energy','NSE:HINDPETRO':'Energy',
  'NSE:IOC':'Energy','NSE:JSWENERGY':'Energy','NSE:NHPC':'Energy','NSE:NLCINDIA':'Energy',
  'NSE:NTPC':'Energy','NSE:NTPCGREEN':'Energy','NSE:OIL':'Energy','NSE:ONGC':'Energy',
  'NSE:PETRONET':'Energy','NSE:POWERGRID':'Energy','NSE:PREMIERENE':'Energy','NSE:RELIANCE':'Energy',
  'NSE:SUZLON':'Energy','NSE:TATAPOWER':'Energy','NSE:TORNTPOWER':'Energy','NSE:WAAREEENER':'Energy',
  /* Infra */
  'NSE:3MINDIA':'Infra','NSE:ABB':'Infra','NSE:ADANIPORTS':'Infra','NSE:AIAENG':'Infra',
  'NSE:ALTIUSINVIT':'Infra','NSE:APARINDS':'Infra','NSE:ASTRAL':'Infra','NSE:BDL':'Infra',
  'NSE:BEL':'Infra','NSE:BHARTIARTL':'Infra','NSE:BHEL':'Infra','NSE:CGPOWER':'Infra',
  'NSE:COCHINSHIP':'Infra','NSE:CONCOR':'Infra','NSE:CUMMINSIND':'Infra','NSE:ENRIN':'Infra',
  'NSE:GMRAIRPORT':'Infra','NSE:GRSE':'Infra','NSE:GVT&D':'Infra','NSE:HAL':'Infra',
  'NSE:INDUSTOWER':'Infra','NSE:JSWINFRA':'Infra','NSE:KEI':'Infra','NSE:LT':'Infra',
  'NSE:MAZDOCK':'Infra','NSE:NHIT':'Infra','NSE:POLYCAB':'Infra','NSE:POWERINDIA':'Infra',
  'NSE:RVNL':'Infra','NSE:SIEMENS':'Infra','NSE:SOLARINDS':'Infra','NSE:SUPREMEIND':'Infra',
  'NSE:TATACOMM':'Infra','NSE:THERMAX':'Infra',
  /* Cement */
  'NSE:AMBUJACEM':'Cement','NSE:DALBHARAT':'Cement','NSE:GRASIM':'Cement','NSE:JKCEMENT':'Cement',
  'NSE:SHREECEM':'Cement','NSE:ULTRACEMCO':'Cement',
  /* Realty */
  'NSE:DLF':'Realty','NSE:EMBASSY':'Realty','NSE:GODREJPROP':'Realty','NSE:KRT':'Realty',
  'NSE:LODHA':'Realty','NSE:MINDSPACE':'Realty','NSE:OBEROIRLTY':'Realty','NSE:PHOENIXLTD':'Realty',
  'NSE:PRESTIGE':'Realty',
  /* Consumer */
  'NSE:ASIANPAINT':'Consumer','NSE:BHARTIHEXA':'Consumer','NSE:BLUESTARCO':'Consumer','NSE:DELHIVERY':'Consumer',
  'NSE:DIXON':'Consumer','NSE:DMART':'Consumer','NSE:ETERNAL':'Consumer','NSE:HAVELLS':'Consumer',
  'NSE:IDEA':'Consumer','NSE:INDHOTEL':'Consumer','NSE:INDIGO':'Consumer','NSE:IRCTC':'Consumer',
  'NSE:ITCHOTELS':'Consumer','NSE:JUBLFOOD':'Consumer','NSE:KALYANKJIL':'Consumer','NSE:KPRMILL':'Consumer',
  'NSE:LENSKART':'Consumer','NSE:LGEINDIA':'Consumer','NSE:MEESHO':'Consumer','NSE:NYKAA':'Consumer',
  'NSE:PAGEIND':'Consumer','NSE:PWL':'Consumer','NSE:SWIGGY':'Consumer','NSE:TITAN':'Consumer',
  'NSE:TRENT':'Consumer','NSE:VMM':'Consumer','NSE:VOLTAS':'Consumer',
  /* Chemicals */
  'NSE:COROMANDEL':'Chemicals','NSE:FACT':'Chemicals','NSE:FLUOROCHEM':'Chemicals','NSE:LINDEINDIA':'Chemicals',
  'NSE:NAVINFLUOR':'Chemicals','NSE:PIDILITIND':'Chemicals','NSE:PIIND':'Chemicals','NSE:SRF':'Chemicals',
  'NSE:UPL':'Chemicals',
  /* Indices */
  'NSE:NIFTY':'Index','NSE:BANKNIFTY':'Index','NSE:NIFTYNXT50':'Index','NSE:FINNIFTY':'Index',
  'NSE:NIFTYIT':'Index','NSE:NIFTYAUTO':'Index','NSE:NIFTYPHARMA':'Index','NSE:NIFTYFMCG':'Index',
  'NSE:NIFTYMETAL':'Index','NSE:NIFTYREALTY':'Index','NSE:NIFTYMEDIA':'Index','NSE:NIFTYPSUBANK':'Index',
  'NSE:NIFTYPVTBANK':'Index','NSE:NIFTYENERGY':'Index','NSE:NIFTYOILGAS':'Index','NSE:NIFTYHEALTH':'Index',
  'NSE:NIFTYINFRA':'Index',
};

/* Sector from NSE's official industry classification (server /api/sector-map), loaded once per session. */
const SECTOR_OVERRIDE = {};
async function loadSectorMap(){
  try{ const d = await apiFetch('/api/sector-map', 10000); Object.entries(d?.map || {}).forEach(([k, v]) => { SECTOR_OVERRIDE['NSE:' + k] = v; }); }catch{}
}
function getStockSector(sym){
  const raw = String(sym || '').toUpperCase().replace(/\.NS$|\.BO$/g,'');
  const ov = SECTOR_OVERRIDE[raw.startsWith('NSE:') ? raw : 'NSE:' + raw];
  if(ov) return ov;
  if(raw.startsWith('MCX:')) return 'Commodity';
  const ns = raw.startsWith('NSE:') ? raw : `NSE:${raw.replace(/^NSE:/,'')}`;
  if(STOCK_SECTOR[ns]) return STOCK_SECTOR[ns];
  const code = ns.replace('NSE:','');
  if(NSE_INDEX_CODES.has(code)) return 'Index';
  /* Conservative fallback by symbol/name so Yahoo search results do not all show UNKNOWN. */
  const name = String(CLIENT_NAMES?.[code] || code).toUpperCase();
  const text = `${code} ${name}`;
  if(/BANK|BNK|PNB|CANBK|UNIONBANK|SBIN/.test(text)) return 'Banking';
  if(/FIN|LIFE|AMC|CARD|INSUR|BSE|MCX|CDSL|CAMS|KFIN|PFC|REC|IRFC|HUDCO|IREDA/.test(text)) return 'Finance';
  if(/PHARMA|DRREDDY|CIPLA|LUPIN|HEALTH|HOSP|LAB|BIOCON|MANKIND|ABBOT/.test(text)) return 'Pharma';
  if(/AUTO|MOTOR|MOTORS|MARUTI|EICHER|BAJAJ|MOTHERSON|FORG|BOSCH|TYRE|TIINDIA|HYUNDAI/.test(text)) return 'Auto';
  if(/FMCG|FOOD|CONSUM|BEVER|ITC|NESTLE|DABUR|MARICO|BRITANNIA|COLPAL|PATANJALI/.test(text)) return 'FMCG';
  if(/STEEL|METAL|HINDALCO|VEDL|SAIL|NMDC|ZINC|ALUMIN|JINDAL/.test(text)) return 'Metal';
  if(/OIL|GAS|POWER|ENERGY|RELIANCE|ONGC|BPCL|IOC|NTPC|NHPC|SJVN|TORNTPOWER|ADANI/.test(text)) return 'Energy';
  if(/CEMENT|ULTRACEMCO|GRASIM|AMBUJA|ACC|DALBHARAT/.test(text)) return 'Cement';
  if(/REALTY|DLF|LODHA|PRESTIGE|OBEROI|PHOENIX|BRIGADE|SOBHA/.test(text)) return 'Realty';
  if(/TECH|INFY|TCS|WIPRO|HCL|LTIM|MPHASIS|COFORGE|PERSISTENT|OFSS|ELXSI|NAUKRI/.test(text)) return 'IT';
  if(/TELECOM|AIRTEL|IDEA|SUNTV|MEDIA/.test(text)) return 'Media';
  if(/LT|SIEMENS|ABB|HAVELLS|POLYCAB|KEI|BEL|HAL|BDL|SHIP|CONCOR|IRCON|RVNL|NBCC|DELHIVERY/.test(text)) return 'Infra';
  if(/TITAN|TRENT|DMART|PAGE|DIXON|AMBER|VOLTAS|BLUESTARCO|BLUESTAR|CROMPTON|PAINT|PIDILITE|SRF|ZOMATO|NYKAA|INDHOTEL|INDIGO|IRCTC|KALYAN|WHIRLPOOL/.test(text)) return 'Consumer';
  return 'Unknown';
}

function calcAtrStopLoss({side, price, structuralStop, atr, fallbackStop, phase='primary'}){
  const p = +price;
  const a = Number.isFinite(+atr) && +atr > 0 ? +atr : Math.max(p*0.015, 1);
  const long = side === 'long' || side === 'Bullish';
  const short = side === 'short' || side === 'Bearish';
  const cfg = phase === 'trail'
    ? {min:0.75, max:1.75, pref:1.20}
    : {min:1.00, max:2.25, pref:1.60};
  let stop = Number.isFinite(+structuralStop) ? +structuralStop : null;
  const fallback = Number.isFinite(+fallbackStop) ? +fallbackStop : null;
  if(long){
    if(!(Number.isFinite(stop) && stop < p)) stop = (Number.isFinite(fallback) && fallback < p) ? fallback : p - cfg.pref*a;
    let risk = p - stop;
    if(risk < cfg.min*a) stop = p - cfg.min*a;
    if(risk > cfg.max*a) stop = p - cfg.max*a;
    return R2(stop);
  }
  if(short){
    if(!(Number.isFinite(stop) && stop > p)) stop = (Number.isFinite(fallback) && fallback > p) ? fallback : p + cfg.pref*a;
    let risk = stop - p;
    if(risk < cfg.min*a) stop = p + cfg.min*a;
    if(risk > cfg.max*a) stop = p + cfg.max*a;
    return R2(stop);
  }
  return Number.isFinite(stop) ? R2(stop) : null;
}

function calcATRFromBars(C, H, L, price, prev, period=14){
  if(!Array.isArray(C) || C.length < period+2) return Math.max((price||1)*0.015, Math.abs((price||0)-(prev||price||0)), 1);
  const tr=[];
  for(let i=1;i<C.length;i++){
    tr.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
  }
  let atr = tr.slice(0,period).reduce((a,b)=>a+(Number.isFinite(b)?b:0),0)/period;
  for(let i=period;i<tr.length;i++) atr = (atr*(period-1)+(Number.isFinite(tr[i])?tr[i]:0))/period;
  return atr || Math.max((price||1)*0.015, Math.abs((price||0)-(prev||price||0)), 1);
}

function deriveSwingRiskReward({bias, price, stopLoss, target1, target2, e20, e50, r1, r2, s1, s2, C=[], H=[], L=[], atr}){
  const valid = v => Number.isFinite(+v) && +v > 0;
  const lastHighs = H.slice(Math.max(0,H.length-21), Math.max(0,H.length-1)).filter(valid);
  const lastLows  = L.slice(Math.max(0,L.length-21), Math.max(0,L.length-1)).filter(valid);
  const recentHigh = lastHighs.length ? Math.max(...lastHighs) : null;
  const recentLow  = lastLows.length ? Math.min(...lastLows) : null;
  const safeAtr = valid(atr) ? +atr : Math.max(price*0.015, 1);
  const minReward = Math.max(safeAtr*0.75, price*0.008);
  let stop=null, target=null, risk=0, reward=0, stopNote='', targetNote='';

  if(bias==='Bullish'){
    const stopCandidates=[stopLoss,s1,s2,e20,e50,recentLow].filter(v=>valid(v) && +v < price).map(Number).sort((a,b)=>b-a);
    stop = (valid(stopLoss) && +stopLoss < price) ? +stopLoss : (stopCandidates[0] || price - safeAtr*1.5);
    stop = calcAtrStopLoss({side:'long', price, structuralStop:stop, atr:safeAtr, fallbackStop:price-safeAtr*1.5, phase:'primary'});
    risk = Math.max(price - stop, safeAtr*0.75);
    const targetCandidates=[target1,r1,r2,recentHigh,price+safeAtr*2].filter(v=>valid(v) && +v > price).map(Number);
    const meaningful=targetCandidates.filter(v=>v-price>=minReward).sort((a,b)=>a-b);
    target = meaningful[0] || (targetCandidates.length ? Math.max(...targetCandidates) : price + safeAtr*1.5);
    reward = Math.max(target - price, 0);
    stopNote = valid(stopLoss) && +stopLoss < price ? 'strategy stop' : 'nearest swing support / EMA support';
    targetNote = meaningful.length ? 'nearest meaningful swing target' : 'ATR fallback target';
  } else if(bias==='Bearish'){
    const stopCandidates=[stopLoss,r1,r2,e20,e50,recentHigh].filter(v=>valid(v) && +v > price).map(Number).sort((a,b)=>a-b);
    stop = (valid(stopLoss) && +stopLoss > price) ? +stopLoss : (stopCandidates[0] || price + safeAtr*1.5);
    stop = calcAtrStopLoss({side:'short', price, structuralStop:stop, atr:safeAtr, fallbackStop:price+safeAtr*1.5, phase:'primary'});
    risk = Math.max(stop - price, safeAtr*0.75);
    const targetCandidates=[target1,s1,s2,recentLow,price-safeAtr*2].filter(v=>valid(v) && +v < price).map(Number);
    const meaningful=targetCandidates.filter(v=>price-v>=minReward).sort((a,b)=>b-a);
    target = meaningful[0] || (targetCandidates.length ? Math.min(...targetCandidates) : price - safeAtr*1.5);
    reward = Math.max(price - target, 0);
    stopNote = valid(stopLoss) && +stopLoss > price ? 'strategy stop' : 'nearest swing resistance / EMA resistance';
    targetNote = meaningful.length ? 'nearest meaningful swing target' : 'ATR fallback target';
  }

  const rr = risk > 0 && reward > 0 ? +(reward/risk).toFixed(2) : 0;
  return {rr, stop:R2(stop), target:R2(target), risk, reward, atr:safeAtr, stopAtr:safeAtr ? +(risk/safeAtr).toFixed(2) : null, stopNote, targetNote};
}


function calcTradePlanRiskReward({bias, price, stopLoss, stopLoss2, target1, target2, atr}){
  const valid = v => Number.isFinite(+v) && +v > 0;
  const long = bias === 'Bullish';
  const short = bias === 'Bearish';
  const p = +price, baseSl = +stopLoss, trailSl = valid(stopLoss2) ? +stopLoss2 : +stopLoss;
  const t1 = +target1; // single active target only
  const safeAtr = valid(atr) ? +atr : Math.max((+price||1)*0.015, 1);
  if(!(long || short) || !valid(p) || !valid(baseSl)) {
    return {valid:false, rr:0, risk:0, reward:0, target:null, stop:baseSl, targetLabel:'Target 1', note:'Strategy stop/target not clear'};
  }

  /* One RR source for Overview, Score and Position Calculator.
     Uses only the selected setup's single entry, stop loss and target. */
  let target = null, targetLabel = 'Target', activeStop = baseSl;
  if(long){
    if(valid(t1) && t1 > p) { target = t1; targetLabel = 'Target'; activeStop = baseSl; }
  } else if(short){
    if(valid(t1) && t1 < p) { target = t1; targetLabel = 'Target'; activeStop = baseSl; }
  }

  /* Do not re-clamp or secretly modify the Strategy-tab stop.
     Overview RR must use the exact selected setup stop loss shown in Strategy tab. */
  activeStop = R2(activeStop);
  const risk = long ? (p - activeStop) : (activeStop - p);
  if(risk <= 0) {
    return {valid:false, rr:0, risk, reward:0, target:null, stop:R2(activeStop), targetLabel, note:'Active stop loss is on the wrong side of current price'};
  }
  if(!valid(target)) {
    return {valid:false, rr:0, risk, reward:0, target:null, stop:R2(activeStop), targetLabel, note:'Current price has already crossed the Strategy target or target is invalid'};
  }

  const reward = long ? (target - p) : (p - target);
  if(reward <= 0) {
    return {valid:false, rr:0, risk, reward, target:null, stop:R2(activeStop), targetLabel, note:'Target is on the wrong side of current price'};
  }
  return {
    valid:true,
    rr:+(reward / risk).toFixed(2),
    risk,
    reward,
    target:R2(target),
    stop:R2(activeStop),
    targetLabel,
    stopAtr:+(risk / safeAtr).toFixed(2),
    note:`RR is calculated from current price to ${targetLabel} using Strategy stop loss`
  };
}

function eventRiskPenaltyFromSnapshot(evt){
  if(!evt) return {penalty:0,reasons:[]};
  let penalty = 0;
  const reasons = [];
  /* Earnings/result data is deliberately removed. User verifies it manually. */
  if(evt.calendar?.nextHigh){
    const e = evt.calendar.nextHigh;
    const days = Number.isFinite(+e.daysUntil) ? +e.daysUntil : Math.ceil((new Date(e.date)-new Date(istDateKey()))/86400000);
    /* A past event carries no forward risk. */
    if(days < 0) return {penalty:0, reasons:[]};
    if(days <= 1) penalty += 3;
    else if(days <= 3) penalty += 2;
    reasons.push(`HIGH impact calendar event in ${days} day${days===1?'':'s'}: ${e.event}`);
  }
  return {penalty:Math.min(3, penalty), reasons};
}

async function getTradeEventRiskSnapshot(sym){
  const cacheKey = `eventrisk_${sym||'GLOBAL'}`;
  const cached = AI_CACHE[cacheKey];
  if(cached && Date.now()-cached.ts < 10*60*1000) return cached;
  const out = {ts:Date.now(), calendar:{loaded:false, fresh:false, lastUpdated:null, nextHigh:null, note:'Calendar not loaded'}, earnings:{removed:true, note:'Earnings tab removed — verify manually before trade'}};
  const today = istDateKey(); /* IST, not UTC: 00:00–05:30 IST used to count as the previous day */
  const ageDays = (iso)=>{
    if(!iso) return 999;
    const d = new Date(iso);
    if(!Number.isFinite(d.getTime())) return 999;
    return Math.floor((new Date(today)-new Date(d.toISOString().slice(0,10)))/86400000);
  };
  try{
    const cal = await apiFetch('/api/calendar');
    const list = Array.isArray(cal?.upcoming) ? cal.upcoming : [];
    const high = list.filter(e=>e.impact==='HIGH').map(e=>({...e, daysUntil:Math.ceil((new Date(e.date)-new Date(today))/86400000)})).find(e=>e.daysUntil>=0 && e.daysUntil<=3) || null;
    out.calendar = {loaded:true, fresh:ageDays(cal?.updatedAt) <= 7, lastUpdated:cal?.updatedAt||null, lastChecked:cal?.checkedAt||null, nextHigh:high, note:cal?.source==='manual-static'?'Manual/static calendar — verify high impact dates':'Calendar loaded'};
  }catch(e){ out.calendar.note = `Calendar error: ${e.message}`; }
  /* Earnings/result API check removed by request. Manual verification is required before trade. */
  const p = eventRiskPenaltyFromSnapshot(out);
  out.penalty = p.penalty;
  out.reasons = p.reasons;
  AI_CACHE[cacheKey] = out;
  return out;
}

function buildSwingDecisionSnapshot(sym, opts={}){
  const d = CUR_DATA?.daily || {}, C=d.C||[], H=d.H||[], L=d.L||[], V=d.V||[], O=d.O||[];
  const n=C.length, price=getCurrentLivePrice(), prev=firstFiniteNumber(CUR_DATA.pc,C[n-2],C[n-1],price);
  if(!n || !Number.isFinite(price)) return {score100:0,s10:1,grade:'No Data',gradeClass:'bear',scoreBias:'NEUTRAL',lbl:'No Data',col:'var(--bear)',rows:[],bull:0,bear:0,total:0};

  const rsiV=calcRSI(C), macdD=calcMACD(C), adxR=calcADX(C,H,L);
  const e20=emaLast(C,20), e50=emaLast(C,50), e200=emaLast(C,200);
  /* Use completed prior candles for volume baseline; today's candle remains the numerator. */
  const volEnd = Math.max(0, Math.min(V.length, n) - 1);
  const volBase20 = V.slice(Math.max(0, volEnd - 20), volEnd);
  const volBase3  = V.slice(Math.max(0, volEnd - 3),  volEnd);
  const avgVol20=volBase20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase20.length);
  const avgVol3=volBase3.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase3.length);
  const volRatio=opts.volRatio ?? (avgVol20 ? (Number(V[n-1])||0)/avgVol20 : 0);
  const volRatio3=avgVol20 && volBase3.length ? avgVol3/avgVol20 : volRatio;
  const volBlend=Number.isFinite(+opts.volBlend) ? +opts.volBlend : ((volRatio||0)*0.6 + (volRatio3||0)*0.4);
  const sr=typeof getSRTradeLevels==='function' ? getSRTradeLevels() : {};
  const r1=opts.r1 ?? sr.r1, s1=opts.s1 ?? sr.s1, r2=opts.r2 ?? sr.r2, s2=opts.s2 ?? sr.s2;
  const priceLocation = opts.priceLocation || (typeof getPriceLocationSnapshot === 'function' ? getPriceLocationSnapshot(sr) : null);
  const atr = opts.atr ?? calcATRFromBars(C,H,L,price,prev,14);
  const rrData = opts.rrData || deriveSwingRiskReward({bias:opts.bias, price, stopLoss:opts.stopLoss, target1:opts.target1, target2:null, e20, e50, r1, r2, s1, s2, C, H, L, atr});
  const rrNum=Number.isFinite(+opts.rrNum) && +opts.rrNum>0 ? +opts.rrNum : (rrData?.rr || 0);

  const priceOk = Number.isFinite(+price);
  const e20Ok = Number.isFinite(+e20), e50Ok = Number.isFinite(+e50), e200Ok = Number.isFinite(+e200);
  const emaBull = priceOk && e20Ok && e50Ok && e200Ok && price>e20 && e20>e50 && e50>e200;
  const emaBullBase = priceOk && e50Ok && e200Ok && price>e50 && e50>e200;
  const emaBear = priceOk && e20Ok && e50Ok && e200Ok && price<e20 && e20<e50 && e50<e200;
  const emaBearBase = priceOk && e50Ok && e200Ok && price<e50 && e50<e200;
  let bias=opts.bias || 'Sideways';
  if(!opts.bias){
    if(emaBullBase) bias='Bullish';
    else if(emaBearBase) bias='Bearish';
  }

  const rows=[];
  const add=(name,pts,max,note)=>rows.push({name,pts:Math.max(0,Math.min(max,Math.round(pts))),max,note});

  let trendPts=6, trendNote='Mixed EMA structure';
  if(emaBull){ trendPts=20; trendNote='Price > EMA20 > EMA50 > EMA200'; }
  else if(emaBullBase){ trendPts=16; trendNote='Price > EMA50 > EMA200'; }
  else if(priceOk && e50Ok && price>e50){ trendPts=11; trendNote='Price above EMA50 but trend stack not clean'; }
  else if(emaBear){ trendPts=20; trendNote='Bear trend: price < EMA20 < EMA50 < EMA200'; }
  else if(emaBearBase){ trendPts=15; trendNote='Bear trend: price < EMA50 < EMA200'; }
  add('Trend structure', trendPts, 20, trendNote);

  const setup = opts.setupInfo || classifyTradeSetup({bias, price, e20, e50, e200, rsiV, macdD, volRatio:volBlend, r1, s1, r2, s2, rrNum, priceLocation, C, H, L, O});
  /* Pullback setups are judged on the shared volume rule (quiet pullback, volume on the bounce day). */
  const pvS = SwingPlan.pullbackVolume(V, C);
  const isPullbackSetup = bias === 'Bullish' && /pullback|bounce/i.test(`${setup.setupDetail || ''} ${setup.label || ''}`);
  let setupPts = 8;
  if(/READY/i.test(setup.label)) setupPts = (rrNum >= 1.3 && (isPullbackSetup ? pvS.bounceOk : volBlend >= 0.9)) ? 25 : 22;
  else if(/CONFIRM/i.test(setup.label)) setupPts=17;
  else if(/WATCH|Watchlist/i.test(setup.label)) setupPts=11;
  else if(/WAIT|Avoid|No Clear/i.test(setup.label)) setupPts=5;
  add('Setup shape / entry location', setupPts, 25, `${setup.setupDetail || setup.label} — ${setup.note || 'Price action setup classification'} · Final action also depends on RR, volume, market and RS.`);

  const lastO = Number(O?.[n-1]), lastC = Number(C?.[n-1] ?? price), priorC = Number(C?.[n-2] ?? lastC);
  const candleBull = Number.isFinite(lastO) && lastC > lastO;
  const candleBear = Number.isFinite(lastO) && lastC < lastO;
  const priceUp = Number.isFinite(priorC) && lastC > priorC;
  const priceDown = Number.isFinite(priorC) && lastC < priorC;
  const sellingPressure = (bias === 'Bullish' || bias === 'Sideways') && (candleBear || priceDown) && volBlend >= 1.2;
  const buyingPressure  = (bias === 'Bearish' || bias === 'Sideways') && (candleBull || priceUp) && volBlend >= 1.2;
  let volPts = volBlend>=1.25?10:volBlend>=1.0?8:volBlend>=0.75?5:3;
  let volNoteSuffix = '';
  if(isPullbackSetup){
    volPts = pvS.bounceOk ? (pvS.todayRatio >= 1.25 ? 10 : 8) : pvS.quietPullback ? 6 : volPts;
    volNoteSuffix = ` · pullback: last 3 days ${Math.round(pvS.dryRatio*100)}% of average (${pvS.quietPullback ? 'quiet - healthy' : 'heavy'}), bounce day ${pvS.bounceOk ? 'confirmed' : 'not confirmed yet'}`;
  }
  if(bias === 'Bullish' && sellingPressure){ volPts = Math.min(volPts, 4); volNoteSuffix = ' · high selling volume is negative for fresh long'; }
  else if(bias === 'Bearish' && buyingPressure){ volPts = Math.min(volPts, 4); volNoteSuffix = ' · high buying volume is negative for fresh short'; }
  else if(bias === 'Sideways' && (sellingPressure || buyingPressure)){ volPts = Math.min(volPts, 5); volNoteSuffix = sellingPressure ? ' · high selling pressure; no bullish confirmation' : ' · high buying pressure, but bias is still sideways'; }
  add('Volume confirmation', volPts, 10, `Blended volume ${(volBlend*100).toFixed(0)}% of 20D average · today ${(volRatio*100).toFixed(0)}% · 3D avg ${(volRatio3*100).toFixed(0)}%${volNoteSuffix}`);

  const breadth=GLOBAL_DATA?.breadth, adRatio=+(breadth?.adRatio||0);
  const sectorSnap = getSectorBiasSnapshotFromList(sym, GLOBAL_DATA?.sectors || []);
  const sectorPct=Number.isFinite(+sectorSnap?.pct)?+sectorSnap.pct:null;
  const breadthScore = (dir) => {
    if(!adRatio || !Number.isFinite(adRatio)) return {pts:2, note:'A/D --'};
    if(dir==='bull') return {pts:adRatio>=1.5?5:adRatio>=1.0?4:adRatio>=0.8?3:1, note:`A/D ${adRatio}:1`};
    return {pts:adRatio<=0.67?5:adRatio<=1.0?4:adRatio<=1.25?3:1, note:`A/D ${adRatio}:1`};
  };
  const sectorScore = (dir) => {
    if(sectorSnap.sector === 'Unknown') return {pts:2, note:'Sector UNKNOWN — mapping missing'};
    if(sectorPct == null) return {pts:2, note:`Sector ${sectorSnap.sector}: NO DATA`};
    if(dir==='bull') return {pts:sectorPct>=0.25?5:sectorPct>=0?4:sectorPct>-0.25?2:1, note:`Sector ${sectorSnap.sector} ${sectorPct>=0?'+':''}${sectorPct.toFixed(2)}% (${sectorSnap.label})`};
    return {pts:sectorPct<=-0.25?5:sectorPct<=0?4:sectorPct<0.25?2:1, note:`Sector ${sectorSnap.sector} ${sectorPct>=0?'+':''}${sectorPct.toFixed(2)}% (${sectorSnap.label})`};
  };
  let marketPts=9, marketNote='Market/sector/RS data not fully loaded — neutral credit only';
  if(bias==='Bullish' || bias==='Bearish'){
    const dir = bias==='Bullish' ? 'bull' : 'bear';
    const b= breadthScore(dir), se=sectorScore(dir), rs=getRelativeStrengthVsNiftySnapshot(sym, C, dir);
    marketPts = Math.round((b.pts + se.pts + rs.pts) / 15 * 20);
    marketNote = `${b.note} · ${se.note} · ${rs.note}`;
  } else {
    /* Sideways bias should not receive a flat market score.
       Use an unbiased bull/bear composite so weak breadth/sector data can still drag the score down. */
    const bBull=breadthScore('bull'), bBear=breadthScore('bear');
    const seBull=sectorScore('bull'), seBear=sectorScore('bear');
    const rsBull=getRelativeStrengthVsNiftySnapshot(sym, C, 'bull'), rsBear=getRelativeStrengthVsNiftySnapshot(sym, C, 'bear');
    const avgB=(bBull.pts + bBear.pts) / 2;
    const avgSe=(seBull.pts + seBear.pts) / 2;
    const avgRs=(rsBull.pts + rsBear.pts) / 2;
    marketPts=Math.round((avgB + avgSe + avgRs) / 15 * 20);
    marketNote=`No clear market alignment · neutral composite: ${bBull.note}/${bBear.note} · ${seBull.note}/${seBear.note} · Bull ${rsBull.note} · Bear ${rsBear.note}`;
  }
  add('Sector + market + relative strength', marketPts, 20, marketNote);

  let rrPts = rrNum>=2?25:rrNum>=1.5?21:rrNum>=SWING_MIN_RR?18:rrNum>=1?12:rrNum>0?5:2;
  let rrNote = rrNum ? `Swing RR ${rrNum.toFixed(2)}:1 using ${rrData?.targetNote || 'target'} and ${rrData?.stopNote || 'stop'}` : 'Entry/SL/target not clear yet';
  if(rrNum > 0 && rrData?.stopAtr && rrData.stopAtr < 0.75){ rrPts -= 3; rrNote += ` · stop too tight (${rrData.stopAtr} ATR)`; }
  if(rrNum > 0 && rrData?.stopAtr && rrData.stopAtr > 3.5){ rrPts -= 2; rrNote += ` · stop too wide (${rrData.stopAtr} ATR)`; }
  add('Risk/reward + stop quality', rrPts, 25, rrNote);

  /* News/calendar/earnings are deliberately NOT part of Fresh Entry Score.
     They are manual checks outside the score, as requested. */

  const rawScore100=rows.reduce((a,r)=>a+r.pts,0);
  const setupActionText = String(setup?.action || setup?.label || '').toUpperCase();
  let entryScoreCap = 100, capReason = '';
  if(setupActionText.includes('WAIT')) { entryScoreCap = 54; capReason = 'Capped because setup action is WAIT'; }
  else if(setupActionText.includes('WATCH')) { entryScoreCap = 64; capReason = 'Capped because setup action is WATCH'; }
  else if(setupActionText.includes('CONFIRM')) { entryScoreCap = 74; capReason = 'Capped because setup still needs confirmation'; }
  const score100=Math.min(rawScore100, entryScoreCap);
  const s10=Math.max(1,Math.min(10,Math.round(score100/10)));
  const grade=score100>=80?'A+':score100>=70?'A':score100>=55?'B':score100>=40?'C':'Avoid';
  const gradeClass=score100>=70?'bull':score100>=55?'neutral':'bear';
  const col=score100>=70?'var(--bull)':score100>=55?'var(--neu)':'var(--bear)';
  const baseLbl=score100>=80?'High-quality fresh entry':score100>=70?'Tradable fresh entry':score100>=55?'Watchlist / wait':score100>=40?'Weak setup':'Avoid';
  const lbl=capReason ? `${baseLbl} · ${capReason}` : baseLbl;
  const scoreBias=bias==='Bullish' && score100>=55?'BULL':bias==='Bearish' && score100>=55?'BEAR':'NEUTRAL';
  const bull=rows.filter(r=>r.pts/r.max>=0.67).length;
  const bear=rows.filter(r=>r.pts/r.max<0.40).length;
  if(!opts.noCache) AI_CACHE[`s10_${sym}`]={s10, score100, bull, bear, total:rows.length, ts:Date.now()};   /* what-if scores (limit re-score) are not cached */
  return {score100,rawScore100,entryScoreCap,capReason,s10,grade,gradeClass,col,lbl,scoreBias,bull,bear,total:rows.length,rows,bias,setupLabel:setup.label,setupDetail:setup.setupDetail,setupNote:setup.note,rrNum,volRatio,volBlend,rrData};
}

function buildSwingHoldSnapshot(sym, ctx={}){
  const {bias, price, prev, e20, e50, e200, stopLoss, volRatio, rsiV, macdD, swingSnap, warnings=[]} = ctx;
  const rows=[];
  const add=(name,pts,max,note)=>rows.push({name,pts:Math.max(0,Math.min(max,Math.round(pts))),max,note});
  if(!(bias==='Bullish' || bias==='Bearish') || !Number.isFinite(price)){
    return {score100:0,grade:'No Hold',gradeClass:'bear',col:'var(--bear)',lbl:'No active directional hold setup',rows:[]};
  }
  const long = bias==='Bullish';
  /* Comparisons against a missing EMA (null) must fail, not pass — price>null is true in JS. */
  const okV = v => Number.isFinite(v) && v > 0;
  const gt = (a,b) => okV(a) && okV(b) && a > b, lt = (a,b) => okV(a) && okV(b) && a < b;
  const trendOk = long ? gt(price,e50) && gt(e50,e200) : lt(price,e50) && lt(e50,e200);
  const trendStrong = long ? gt(price,e20) && gt(e20,e50) && gt(e50,e200) : lt(price,e20) && lt(e20,e50) && lt(e50,e200);
  add('Trend still intact', trendStrong?25:trendOk?20:(long ? gt(price,e200) : lt(price,e200))?12:4, 25, trendStrong?'EMA stack still clean':trendOk?'Primary trend still valid':'Trend structure weakening');

  let stopPts=5, stopNote='No stop loss configured — hold risk cannot be judged properly';
  if(Number.isFinite(stopLoss)){
    const cushion = long ? (price-stopLoss)/price*100 : (stopLoss-price)/price*100;
    stopPts = cushion>3?25:cushion>1?18:cushion>0?10:0;
    stopNote = cushion>0 ? `Price still has ${cushion.toFixed(1)}% cushion from stop` : 'Stop/invalidation is breached or too close';
  }
  add('Stop/invalidation status', stopPts, 25, stopNote);

  const structurePts = long ? (gt(price,e20)?20:gt(price,e50)?15:gt(price,e200)?10:4) : (lt(price,e20)?20:lt(price,e50)?15:lt(price,e200)?10:4);
  add('Price structure for holding', structurePts, 20, long ? 'Bull hold favours price above 20/50 DMA' : 'Bear hold favours price below 20/50 DMA');

  let pressurePts=9, pressureNote='Normal/noisy candle pressure';
  if(long){
    if(price>=prev && volRatio>=0.8){ pressurePts=15; pressureNote='Price holding/up with acceptable volume'; }
    else if(price>=prev){ pressurePts=12; pressureNote='Price holding but volume is light'; }
    else if(price<prev && volRatio>=1.5){ pressurePts=4; pressureNote='High-volume down day — watch closely'; }
  } else {
    if(price<=prev && volRatio>=0.8){ pressurePts=15; pressureNote='Price weakening with acceptable volume'; }
    else if(price<=prev){ pressurePts=12; pressureNote='Price weakening but volume is light'; }
    else if(price>prev && volRatio>=1.5){ pressurePts=4; pressureNote='High-volume bounce against short'; }
  }
  add('Selling/buying pressure', pressurePts, 15, pressureNote);

  const marketRow = swingSnap?.rows?.find(r=>/Sector \+ market/i.test(r.name));
  const marketEventPts = Math.round(((marketRow?.pts ?? 9)/(marketRow?.max || 20))*15);
  add('Market / sector support for holding', marketEventPts, 15, `${marketRow?.note || 'Market neutral'}`);

  const score100=rows.reduce((a,r)=>a+r.pts,0);
  const grade=score100>=80?'Strong Hold':score100>=65?'Hold':score100>=50?'Trail Tight':'Exit Watch';
  const gradeClass=score100>=65?'bull':score100>=50?'neutral':'bear';
  const col=score100>=65?'var(--bull)':score100>=50?'var(--neu)':'var(--bear)';
  const lbl=score100>=80?'Healthy open trade':score100>=65?'Continue holding with planned SL':score100>=50?'Hold only with tight trailing stop':'Do not ignore exit/invalidation';
  return {score100,grade,gradeClass,col,lbl,rows};
}


async function buildUnifiedSwingDecisionSnapshot(sym){
  const {C,H,L,V,O} = CUR_DATA.daily, n=C.length;
  const price = getCurrentLivePrice(), prev = firstFiniteNumber(CUR_DATA.pc, C[n-2], C[n-1], price);
  const name = document.getElementById('ihn').textContent || sym;
  const dr    = sigRec(CUR_DATA.daily.rec.value);
  const wr    = sigRec(CUR_DATA.weekly?.rec?.value ?? 0);
  const rsiV  = calcRSI(C);
  const rsiS  = sigRSI(rsiV);
  const macdD = calcMACD(C);
  const ms    = sigMACD(macdD?.macd, macdD?.signal);
  const adxR  = calcADX(C,H,L);
  const adxS  = sigADX(adxR?.adx, adxR?.pdi, adxR?.ndi);
  const e20   = emaLast(C,20), e50=emaLast(C,50), e200=emaLast(C,200);
  const emaSig = sigEMA(price,e20,e50,e200);
  const indexInstrument = isIndexSymbol(sym);
  const todayVol=V[n-1] || 0;
  /* Compare today's/live volume against completed prior candles. Including the current partial candle in its own average makes the score unstable intraday. */
  const volEnd = Math.max(0, Math.min(V.length, n) - 1);
  const volBase20 = V.slice(Math.max(0, volEnd - 20), volEnd);
  const volBase3  = V.slice(Math.max(0, volEnd - 3),  volEnd);
  const avgVol20=volBase20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase20.length);
  const avgVol3=volBase3.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase3.length);
  const volRatio = indexInstrument ? 0 : (avgVol20 ? todayVol / avgVol20 : 0);
  const volBlend = indexInstrument ? 0 : ((volRatio||0)*0.6 + ((avgVol20&&volBase3.length?avgVol3/avgVol20:volRatio)||0)*0.4);
  const volSig = indexInstrument ? {l:'Index Volume N/A',c:'na'} : sigVolume(todayVol, avgVol20, price-prev);
  const confirmedPatternIdx = getConfirmedDailyIndex(CUR_DATA.daily);
  const pats   = detectPatterns(CUR_DATA.daily, confirmedPatternIdx);
  const pBull  = pats.filter(p=>p.s==='bull'||p.s==='strong-bull').length;
  const pBear  = pats.filter(p=>p.s==='bear'||p.s==='strong-bear').length;
  const patSig = pBull>pBear?{l:`${pBull} Bullish Pattern${pBull>1?'s':''}`,c:'bull'}:pBear>pBull?{l:`${pBear} Bearish Pattern${pBear>1?'s':''}`,c:'bear'}:{l:'No Clear Pattern',c:'neutral'};
  const srLevels = getSRTradeLevels();
  const priceLocation = getPriceLocationSnapshot(srLevels);
  const {r1,s1,r2,s2} = srLevels;
  const sigs = [dr,wr,emaSig,rsiS,ms,volSig,patSig,adxS];
  const scoreMap = { 'strong-bull':2, bull:1, neutral:0, bear:-1, 'strong-bear':-2, na:0 };
  const rawBiasScore = sigs.reduce((a,s)=>a+(scoreMap[s.c]||0),0);
  const bullCt = sigs.filter(s=>s.c==='bull'||s.c==='strong-bull').length;
  const bearCt = sigs.filter(s=>s.c==='bear'||s.c==='strong-bear').length;
  const adxValForBias = Number(adxR?.adx || 0);
  const priceOk = Number.isFinite(+price);
  const e20Ok = Number.isFinite(+e20), e50Ok = Number.isFinite(+e50), e200Ok = Number.isFinite(+e200);
  const r1Ok = r1 != null && Number.isFinite(+r1) && +r1 > 0, s1Ok = s1 != null && Number.isFinite(+s1) && +s1 > 0; /* +null is 0, which is finite */
  const choppyBias = SwingPlan.isChoppy({price, r1, s1, rsi:rsiV, adx:adxValForBias});   /* shared with the screener */
  let bias = 'Sideways';
  if(!choppyBias && rawBiasScore >= 3 && priceOk && e50Ok && price > e50 && (adxValForBias >= 16 || (r1Ok && price > r1*1.002) || (e20Ok && e20 > e50))) bias='Bullish';
  else if(!choppyBias && rawBiasScore <= -3 && priceOk && e50Ok && price < e50 && (adxValForBias >= 16 || (s1Ok && price < s1*0.998) || (e20Ok && e20 < e50))) bias='Bearish';

  let strategyPlan=null;
  try {
    strategyPlan = await getStrategyTradePlan(sym, name, bias);
    if(strategyPlan?.bias) bias = strategyPlan.bias;
  } catch { strategyPlan=null; }

  const atr = calcATRFromBars(C,H,L,price,prev,14);
  const derivedRR = deriveSwingRiskReward({
    bias, price,
    stopLoss:strategyPlan?.stopLoss,
    target1:strategyPlan?.target1,
    target2:null,
    e20, e50, r1, r2, s1, s2, C, H, L, atr
  });
  const rrFromPriceD = (bias === 'Bullish' && /breakout/i.test(strategyPlan?.setupName || '') && Number.isFinite(+strategyPlan?.entryPrice)) ? Math.max(price, +strategyPlan.entryPrice) : price; /* trigger setups: R:R from the trigger */
  const planRR = calcTradePlanRiskReward({bias, price: rrFromPriceD, stopLoss:strategyPlan?.stopLoss, stopLoss2:strategyPlan?.stopLoss2, target1:strategyPlan?.target1, target2:null, atr});
  const rrData = planRR.valid
    ? {...derivedRR, rr:planRR.rr, risk:planRR.risk, reward:planRR.reward, stop:planRR.stop, target:planRR.target, stopAtr:planRR.stopAtr, stopNote:'Strategy tab stop loss', targetNote:`Strategy tab ${planRR.targetLabel}`, rrTargetLabel:planRR.targetLabel}
    : {rr:0, stop:planRR.stop || strategyPlan?.stopLoss || null, target:null, risk:planRR.risk || 0, reward:0, atr, stopAtr:planRR.stopAtr || null, stopNote:'Strategy tab stop loss', targetNote:planRR.note || 'Strategy target invalid', rrTargetLabel:'Wait'};
  const rrNum = rrData.rr || 0;

  let warnings=[];
  /* c:'bear' = adverse for THIS trade (costs confidence), c:'bull' = favourable. A short at resistance or a
     long at support is the textbook entry, not a risk. */
  const advLong = bias === 'Bearish' ? 'bull' : 'bear', advShort = bias === 'Bearish' ? 'bear' : 'bull';
  if(rsiV >= 70) warnings.push({t:'RSI overbought',d:`RSI ${fmt(rsiV,1)} — fresh long entry is risky`,c:advLong});
  if(rsiV <= 30) warnings.push({t:'RSI oversold',d:`RSI ${fmt(rsiV,1)} — fresh short entry is risky`,c:advShort});
  const nearestResistanceVal = Number(srLevels.nearestResistance?.v ?? (+r1 > price ? r1 : NaN));
  const nearestSupportVal = Number(srLevels.nearestSupport?.v ?? (+s1 > 0 && +s1 < price ? s1 : NaN));
  if(Number.isFinite(nearestResistanceVal) && Math.abs(price-nearestResistanceVal)/price*100 < 0.75) warnings.push({t:'Near resistance',d:`Price is close to ${srLevels.nearestResistance?.n || 'nearest resistance'} ${fmt(nearestResistanceVal)}`,c:advLong});
  if(Number.isFinite(nearestSupportVal) && Math.abs(price-nearestSupportVal)/price*100 < 0.75) warnings.push({t:'Near support',d:`Price is close to ${srLevels.nearestSupport?.n || 'nearest support'} ${fmt(nearestSupportVal)}`,c:advShort});
  if(Number.isFinite(volBlend) && volBlend < .75) warnings.push({t:'Weak volume',d:`Blended volume only ${(volBlend*100).toFixed(0)}% of 20D average`,c:'neutral'});
  if((dr.c?.includes('bull') && wr.c?.includes('bear')) || (dr.c?.includes('bear') && wr.c?.includes('bull'))) warnings.push({t:'Daily/weekly mismatch',d:'Trend is mixed across timeframes',c:'neutral'});
  const newsItems = AI_CACHE[`news_${sym}`]?.items||[];
  const newsBear  = newsItems.filter(i=>i.s==='bear').length;
  if(newsBear >= 2) warnings.push({t:'News risk',d:`${newsBear} bearish news items loaded`,c:advLong});

  const setupInfo = classifyTradeSetup({bias, price, e20, e50, e200, rsiV, macdD, volRatio:volBlend, r1, s1, r2, s2, rrNum, priceLocation, C, H, L, O, planSetup: strategyPlan?.isActive ? strategyPlan.setupName : ''});
  const snap = buildSwingDecisionSnapshot(sym, {
    bias, setupInfo, rrNum, rrData, warnings, rawBiasScore, bullCt, bearCt,
    volRatio, volBlend, r1, s1, r2, s2, atr, priceLocation,
    stopLoss:strategyPlan?.stopLoss, target1:strategyPlan?.target1, target2:null
  });
  snap.holdSnap = buildSwingHoldSnapshot(sym, {bias, price, prev, e20, e50, e200, stopLoss:strategyPlan?.stopLoss, volRatio:volBlend, rsiV, macdD, swingSnap:snap, warnings});
  AI_CACHE[`decision_snap_${sym}`] = {price, snap, ts:Date.now()};
  return snap;
}


async function tabScore(sym){
  if(sym==='MCX:GOLDPETAL') {
    const gold = goldPetalDashboard(sym);
    return (gold || '<div class="aib">Gold Petal data not loaded yet.</div>') +
      '<div class="aib"><strong style="color:var(--acc)">Gold Petal uses separate Buy Quality /100:</strong> MCX trend, macro pressure, USD/INR, DXY, US yield, VIX and accumulation zones. Stock swing score, sector breadth and A/D ratio are not used for Gold Petal buying.</div>';
  }
  if(isIndexSymbol(sym)) {
    return renderIndexOptionsDecision(sym);
  }
  const name=document.getElementById('ihn').textContent;
  const snap=await buildUnifiedSwingDecisionSnapshot(sym);
  const d=CUR_DATA.daily, C=d.C||[], H=d.H||[], L=d.L||[];
  const rsiV=calcRSI(C), macdD=calcMACD(C), adxR=calcADX(C,H,L), bb=calcBB(C), price=C[C.length-1];
  const secondary=[
    {name:'RSI', sig:sigRSI(rsiV), note:'Secondary momentum only; not a standalone entry signal'},
    {name:'MACD', sig:sigMACD(macdD?.macd,macdD?.signal), note:'Late confirmation; low weight to avoid double-counting trend'},
    {name:'ADX', sig:sigADX(adxR?.adx,adxR?.pdi,adxR?.ndi), note:'Trend-strength context only'},
    {name:'Bollinger Band', sig:sigBB(price,bb?.upper,bb?.lower,bb?.basis), note:'Visual context; not used in final decision score'},
  ];
  const rowHtml=snap.rows.map(r=>`<div class="tp-qrow"><div><strong>${r.name}</strong><span>${r.note}</span></div><b>${r.pts}/${r.max}</b></div>`).join('');
  const hold=snap.holdSnap;
  const holdHtml=hold?.rows?.length ? hold.rows.map(r=>`<div class="tp-qrow"><div><strong>${r.name}</strong><span>${r.note}</span></div><b>${r.pts}/${r.max}</b></div>`).join('') : '';
  const secHtml=secondary.map(r=>`<div class="sbi"><span class="sbn">${r.name}</span>${bdg(r.sig)}<span style="font-size:.75rem;color:var(--tx3);margin-left:4px">${r.note}</span></div>`).join('');
  return `<div class="aib">📡 Decision score computed from <strong style="color:var(--acc)">live market data</strong> · ${new Date().toLocaleTimeString('en-IN')}</div>`+
    `<div class="sc"><div class="sn" style="color:${snap.col}">${snap.score100}/100</div><div class="sl2" style="color:${snap.col}">Fresh Entry Score · ${snap.lbl} · ${snap.grade}</div><div class="sbw"><div class="sbar" style="width:${snap.score100}%;background:${snap.col}"></div></div><div class="sbs">Fresh entry score: trend 20 + setup 25 + volume 10 + market/sector/RS 20 + RR 25. News/calendar/earnings are not part of this score; verify them manually.</div></div>`+
    (hold ? `<div class="sc"><div class="sn" style="color:${hold.col}">${hold.score100}/100</div><div class="sl2" style="color:${hold.col}">Open Trade Hold Score · ${hold.lbl} · ${hold.grade}</div><div class="sbw"><div class="sbar" style="width:${hold.score100}%;background:${hold.col}"></div></div><div class="sbs">Use this after entry. Do not exit only because the fresh-entry score dropped.</div></div>` : '')+
    `<div class="aib"><strong style="color:var(--acc)">Important:</strong> The first score is for fresh entry only. The hold score checks whether an already-open swing trade is still valid around trend, stop loss, structure, pressure and market/sector support.</div>`+
    secT('Fresh Entry Score Breakdown')+
    `<div class="tp-quality-list">${rowHtml}</div>`+
    (holdHtml ? secT('Open Trade Hold Score Breakdown')+`<div class="tp-quality-list">${holdHtml}</div>` : '')+
    secT('Secondary Confirmation — not part of main score')+
    `<div class="sbk">${secHtml}</div>`;
}

/* ── ANTHROPIC AI CALL ── */
async function callAI(prompt,tokens){
  /* Browser-side Anthropic calls are not valid here:
     1) the browser cannot safely hold an API key,
     2) Anthropic API will fail CORS/auth without a server proxy,
     3) waiting for that failed request slows every stock load.
     Keep the deterministic fallback paths fast instead. */
  throw new Error('Client-side AI disabled — using local deterministic fallback.');
}


/* ── NOTIFICATION ENGINE ── */
function loadAlerts(){
  try{
    const arr = JSON.parse(localStorage.getItem('td_alerts') || '[]');
    return Array.isArray(arr) ? arr.filter(a => a && a.sym && a.type && Number.isFinite(+a.value)) : [];
  }catch{ return []; }
}
let ALERTS = loadAlerts();
const NOTIF_PREF_KEY = 'td_notifications_enabled';
let NOTIF_ENABLED = ('Notification' in window) && Notification.permission === 'granted';
let NOTIF_WORKER_READY = null;
let ALERT_CHECK_INTERVAL = null;
const NOTIF_SOUNDS = { bull: [880,0.3], bear: [220,0.3], neutral: [520,0.22] };

function saveAlerts() { try { localStorage.setItem('td_alerts', JSON.stringify(ALERTS)); } catch(e) { /* quota/private mode: keep alerts in memory */ } }
/* Price prefix by instrument: indices are points, everything else ₹. */
function alertPx(sym, v){ const s=String(sym||''); return (isIndexSymbol(s) ? '' : '₹') + fmt(v); }
/* Re-render the alerts view without dropping the Market Info sub-tab bar. */
function rerenderAlertsView(){
  if(document.getElementById('td-alert-pop')) { renderAlertPopup(); return; }
  const tc=document.getElementById('tc'); if(!tc) return;
  if(tc.querySelector('.market-subtabs-v14') && window.tabMarketInfo){ tabMarketInfo._view='alerts'; tabMarketInfo(); }
  else tc.innerHTML = tabAlerts();
}
function notifSupported(){ return ('Notification' in window); }
function notifSecure(){ return window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1'; }
function refreshNotifState(){
  NOTIF_ENABLED = notifSupported() && Notification.permission === 'granted';
  if (NOTIF_ENABLED) localStorage.setItem(NOTIF_PREF_KEY, '1');
  return NOTIF_ENABLED;
}

function registerNotificationWorker(){
  if (!('serviceWorker' in navigator) || !notifSecure()) return Promise.resolve(null);
  if (NOTIF_WORKER_READY) return NOTIF_WORKER_READY;
  NOTIF_WORKER_READY = navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then(() => navigator.serviceWorker.ready)
    .catch(err => {
      console.warn('TradeDesk notification worker failed:', err);
      NOTIF_WORKER_READY = null;
      return null;
    });
  return NOTIF_WORKER_READY;
}

function initNotificationsOnLoad(){
  refreshNotifState();
  /* Do NOT request permission on page load. Chrome/Edge/Safari can block prompts that are not user-click driven. */
  if (NOTIF_ENABLED) { registerNotificationWorker(); ensurePush(false).catch(() => {}); }   /* re-register with the server after its restart */
}
/* ── Background alerts (Web Push): the server sends alerts to this device even with TradeDesk closed. ── */
let PUSH_STATE = { supported: ('PushManager' in window) && ('serviceWorker' in navigator), on:false, devices:0 };
function pushKeyBytes(s){ const b = atob((s + '='.repeat((4 - s.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(b, ch => ch.charCodeAt(0)); }
function bytesB64u(buf){ return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function ensurePush(ask = false){
  if (!PUSH_STATE.supported || !notifSecure()) return false;
  if (Notification.permission !== 'granted') { if (!ask || !(await requestNotifPermission())) return false; }
  const reg = await registerNotificationWorker();
  if (!reg?.pushManager) return false;
  const k = await apiFetch('/api/push/key', 10000);
  if (!k.enabled || !k.publicKey) return false;
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options?.applicationServerKey && bytesB64u(sub.options.applicationServerKey) !== k.publicKey) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly:true, applicationServerKey: pushKeyBytes(k.publicKey) });
  const r = await fetch(API + '/api/push/subscribe', { method:'POST', credentials:'same-origin', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
  const j = await r.json().catch(() => ({}));
  PUSH_STATE = { ...PUSH_STATE, on: r.ok, devices: +j.devices || 0 };
  return r.ok;
}
async function enablePushNow(){
  try {
    const ok = await ensurePush(true);
    showToast(ok ? 'Background alerts on' : 'Not turned on', ok ? 'This device now gets alerts even with TradeDesk closed.' : 'Allow notifications for this site (iPhone: open TradeDesk from the Home Screen icon), then try again.', ok ? 'bull' : 'neutral');
  } catch (e) { showToast('Background alerts failed', e.message, 'bear'); }
  if (document.getElementById('td-alert-pop')) renderAlertPopup();
}
async function testPushNow(){
  try {
    const r = await fetch(API + '/api/push/test', { method:'POST', credentials:'same-origin' });
    const j = await r.json();
    showToast('Test sent', `Sent to ${j.sent || 0} of ${j.devices || 0} device(s). Close TradeDesk and it still arrives.`, j.sent ? 'bull' : 'neutral');
  } catch (e) { showToast('Test failed', e.message, 'bear'); }
}

function requestNotifPermission() {
  if (!notifSupported()) return Promise.resolve(false);
  if (!notifSecure()) return Promise.resolve(false);
  if (Notification.permission === 'granted') { refreshNotifState(); return Promise.resolve(true); }
  if (Notification.permission === 'denied') return Promise.resolve(false);
  return Notification.requestPermission().then(p => {
    refreshNotifState();
    return p === 'granted';
  }).catch(() => false);
}

/* Called directly from button click — permission request must stay inside this user gesture */
function enableNotificationsNow() {
  const btn = document.getElementById('notif-enable-btn');
  if (btn) { btn.textContent = 'Requesting…'; btn.disabled = true; }

  const resetBtn = () => { if (btn) { btn.textContent = 'Enable'; btn.disabled = false; } };
  const rerender = () => rerenderAlertsView();

  if (!notifSupported()) {
    alert('Browser notifications are not supported in this browser. Use Chrome or Edge on desktop for the best result.');
    resetBtn(); return;
  }
  if (!notifSecure()) {
    alert('Browser notifications need HTTPS. Use your Render https:// URL. They will not work on an insecure http:// link.');
    resetBtn(); return;
  }
  if (Notification.permission === 'denied') {
    alert('Notifications are blocked for this site.\n\nFix in Chrome/Edge:\n1. Click the 🔒 icon near the address bar\n2. Site settings → Notifications → Allow\n3. Reload TradeDesk\n4. Press Enable again');
    resetBtn(); return;
  }

  requestNotifPermission().then(async ok => {
    if (!ok) {
      resetBtn();
      showToast('Notifications not enabled', 'Browser permission was not granted. In-app alerts will still work while the page is open.', 'neutral');
      rerender();
      return;
    }
    await registerNotificationWorker();
    refreshNotifState();
    sendNotification('TradeDesk Alerts Active ✓', 'Notification test passed. Alerts will show while TradeDesk is open or minimised.', 'bull', { forceBrowser:true });
    rerender();
    startAlertEngine();
  });
}

function testNotificationNow(){
  if (!refreshNotifState()) {
    showToast('Notification test failed', 'Permission is not granted. Press Enable first, or allow notifications from browser site settings.', 'bear');
    return;
  }
  sendNotification('TradeDesk Test Alert', 'If you see this desktop notification, alert notifications are working.', 'bull', { forceBrowser:true });
}

function showBrowserNotification(title, body, type='bull', tag='tradedesk-alert'){
  if (!refreshNotifState()) return;
  const options = {
    body,
    icon: TD_ICON_DATA_URI,
    badge: TD_ICON_DATA_URI,
    tag,
    renotify: true,
    requireInteraction: false,
    data: { url: location.origin + '/', type }
  };
  registerNotificationWorker().then(reg => {
    if (reg && typeof reg.showNotification === 'function') return reg.showNotification(title, options);
    try { return new Notification(title, options); } catch(e) { console.warn('Notification fallback failed:', e); }
  }).catch(() => {
    try { new Notification(title, options); } catch(e) { console.warn('Notification failed:', e); }
  });
}

/* One shared AudioContext: browsers cap live contexts, so creating one per alert eventually silenced sound. */
let NOTIF_AUDIO_CTX = null;
function playSound(type) {
  try {
    const AC = window.AudioContext||window.webkitAudioContext;
    if (!NOTIF_AUDIO_CTX) NOTIF_AUDIO_CTX = new AC();
    const ctx = NOTIF_AUDIO_CTX;
    if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    const [freq, vol] = NOTIF_SOUNDS[type] || [440, 0.3];
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(); osc.stop(ctx.currentTime + 0.5);
  } catch {}
}

function sendNotification(title, body, type='bull', opts={}) {
  playSound(type);
  if (opts.forceBrowser || document.hidden || refreshNotifState()) showBrowserNotification(title, body, type, opts.tag || 'tradedesk-alert');
  // Always show in-app toast, even if browser permission is blocked.
  showToast(title, body, type);
}

function showToast(title, body, type) {
  const t = document.createElement('div');
  const col = type==='bull'?'var(--bull)':type==='bear'?'var(--bear)':'var(--neu)';
  t.style.cssText = `position:fixed;top:20px;right:20px;z-index:9999;background:var(--bgp);border:2px solid ${col};border-radius:10px;padding:14px 18px;max-width:320px;box-shadow:0 4px 20px rgba(0,0,0,.4);animation:slideIn .3s ease`;
  t.innerHTML = `<div style="font-weight:700;color:${col};font-size:.9rem;margin-bottom:4px">${escHtml(title)}</div><div style="font-size:.78rem;color:var(--tx2)">${escHtml(body)}</div>`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 6000);
}

// Add slideIn animation once
if (!document.getElementById('toast-style')) {
  const s = document.createElement('style');
  s.id = 'toast-style';
  s.textContent = '@keyframes slideIn{from{transform:translateX(120%);opacity:0}to{transform:translateX(0);opacity:1}}';
  document.head.appendChild(s);
}

let ALERT_CHECK_RUNNING = false;
async function checkAlerts() {
  if (!ALERTS.length) return;
  /* A run with many symbols can outlast the 60s interval; overlapping runs sent duplicate notifications. */
  if (ALERT_CHECK_RUNNING) return;
  ALERT_CHECK_RUNNING = true;
  try { await checkAlertsOnce(); } finally { ALERT_CHECK_RUNNING = false; }
}
async function checkAlertsOnce() {
  const activeAlerts = ALERTS.filter(a => !a.triggered);
  if (!activeAlerts.length) return;
  // Group by symbol to minimize API calls
  const syms = [...new Set(activeAlerts.map(a => a.sym))];
  for (const sym of syms) {
    try {
      const d = await fetchQuickPrice(sym);
      /* A missing price (null) compares as 0 and used to fire every "below" alert. */
      if (!Number.isFinite(+d?.price) || +d.price <= 0) continue;
      const pctOk = Number.isFinite(+d.pct);
      const symAlerts = activeAlerts.filter(a => a.sym === sym);
      for (const alert of symAlerts) {
        let triggered = false;
        let msg = '';
        if (alert.type === 'above' && d.price >= alert.value) {
          triggered = true;
          msg = `${sym} is above ${alertPx(sym,alert.value)} — Now ${alertPx(sym,d.price)} (${d.pct>=0?'+':''}${d.pct}%)`;
        } else if (alert.type === 'below' && d.price <= alert.value) {
          triggered = true;
          msg = `${sym} is below ${alertPx(sym,alert.value)} — Now ${alertPx(sym,d.price)} (${d.pct>=0?'+':''}${d.pct}%)`;
        } else if (pctOk && alert.type === 'pct_up' && d.pct >= alert.value) {
          triggered = true;
          msg = `${sym} is up ${d.pct}% today — Now ${alertPx(sym,d.price)}`;
        } else if (pctOk && alert.type === 'pct_down' && d.pct <= -alert.value) {
          triggered = true;
          msg = `${sym} is down ${Math.abs(d.pct)}% today — Now ${alertPx(sym,d.price)}`;
        }
        if (triggered) {
          /* Mark the alert in the CURRENT list: a sync during the price fetch replaces ALERTS, and the flag set on
             the old object was lost, so the alert fired again every minute. */
          const cur = ALERTS.find(a => alertKey(a) === alertKey(alert));
          if (cur?.triggered) continue;
          (cur || alert).triggered = true;
          (cur || alert).triggeredAt = new Date().toLocaleTimeString('en-IN');
          saveAlerts();
          const isUp = alert.type === 'above' || alert.type === 'pct_up';
          sendNotification(`🔔 Alert: ${sym}`, msg, isUp ? 'bull' : 'bear', { tag: 'alert-' + (alert.id || `${alert.sym}|${alert.type}|${alert.value}`) });
          // Re-render alerts tab if open
          const activeTab = document.querySelector('.tbt.active');
          if (activeTab?.dataset.tab === 'alerts' || (tabMarketInfo._view === 'alerts' && document.querySelector('#tc .market-subtabs-v14'))) rerenderAlertsView();
        }
      }
      // Auto-detect big moves (±1%) — send notification even without set alert
      if (pctOk && Math.abs(d.pct) >= 1 && sym === CUR_SYM) {
        const key = `bigmove_${sym}_${new Date().toDateString()}`;
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, '1');
          const isUp = d.pct >= 0;
          sendNotification(
            `${isUp?'📈':'📉'} Market Move: ${sym}`,
            `${sym} moved ${isUp?'+':''}${d.pct}% today — Now ${alertPx(sym,d.price)}`,
            isUp ? 'bull' : 'bear'
          );
        }
      }
    } catch {}
  }
}

function startAlertEngine() {
  if (ALERT_CHECK_INTERVAL) { clearInterval(ALERT_CHECK_INTERVAL); ALERT_CHECK_INTERVAL = null; }
  if (!ALERTS.some(a => !a.triggered)) return;
  ALERT_CHECK_INTERVAL = setInterval(checkAlerts, 60000); // check every minute while page is open
  checkAlerts(); // immediate check
}



/* ── ALERTS ── */
function pushBannerHtml(){
  if (!PUSH_STATE.supported) return '';
  return `<div class="notif-banner"><div class="notif-dot"${PUSH_STATE.on ? '' : ' style="background:var(--neu);box-shadow:none"'}></div><div><strong style="color:var(--tx)">Background alerts</strong><br>${PUSH_STATE.on
    ? `On for this device (${PUSH_STATE.devices} device${PUSH_STATE.devices === 1 ? '' : 's'} in total). The server checks prices every minute in market hours and alerts you even with TradeDesk closed.`
    : 'Get alerts on this phone / PC even when TradeDesk is closed. iPhone: Share → Add to Home Screen, then open TradeDesk from that icon and turn this on.'}</div>
    <button class="enable-notif-btn" onclick="${PUSH_STATE.on ? 'testPushNow()' : 'enablePushNow()'}">${PUSH_STATE.on ? 'Test' : 'Turn on'}</button></div>`;
}
function notifBannerHtml() {
  const notifGranted = refreshNotifState();
  const canNotify = notifSupported();
  const secure = notifSecure();
  const denied = canNotify && Notification.permission === 'denied';
  let html = '';

  if (!canNotify) {
    html += `<div class="notif-banner"><div class="notif-dot" style="background:var(--bear);box-shadow:none"></div><div><strong style="color:var(--bear)">Browser notifications not supported</strong><br>Use Chrome or Edge on desktop. In-app alerts still work while TradeDesk is open.</div></div>`;
  } else if (!secure) {
    html += `<div class="notif-banner"><div class="notif-dot" style="background:var(--bear);box-shadow:none"></div><div><strong style="color:var(--bear)">HTTPS required</strong><br>Open your Render https:// URL. Browser notifications do not work on insecure http:// pages.</div></div>`;
  } else if (denied) {
    html += `<div class="notif-banner"><div class="notif-dot" style="background:var(--bear);box-shadow:none"></div><div><strong style="color:var(--bear)">Notifications blocked</strong><br>Click the browser lock icon → Site settings → Notifications → Allow, then reload.</div></div>`;
  } else if (!notifGranted) {
    html += `<div class="notif-banner">
      <div class="notif-dot"></div>
      <div><strong style="color:var(--tx)">Enable Browser Notifications</strong><br>
      Desktop alerts while TradeDesk is open/minimised. Permission must be enabled from this button.</div>
      <button class="enable-notif-btn" id="notif-enable-btn" onclick="enableNotificationsNow()">Enable</button>
    </div>`;
  } else {
    html += `<div class="notif-banner"><div class="notif-dot"></div><div style="color:var(--bull)"><strong>Browser notifications enabled</strong> — alerts will appear while TradeDesk is open/minimised</div><button class="enable-notif-btn" onclick="testNotificationNow()">Test</button></div>`;
  }

  return html;
}
function tabAlerts() {
  let html = notifBannerHtml();
  html += `<div class="alert-panel">
    <div class="alert-title">🔔 Create Price Alert</div>
    <div class="alert-form">
      <div class="alert-row">
        <span class="alert-label">Symbol</span>
        <input class="alert-input" id="al-sym" placeholder="e.g. NSE:NIFTY or MCX:GOLD" value="${escHtml(CUR_SYM||'NSE:NIFTY')}">
      </div>
      <div class="alert-row">
        <span class="alert-label">Condition</span>
        <select class="alert-select" id="al-type">
          <option value="above">Price goes ABOVE ▲</option>
          <option value="below">Price goes BELOW ▼</option>
          <option value="pct_up">Day change UP % ▲</option>
          <option value="pct_down">Day change DOWN % ▼</option>
        </select>
        <input class="alert-input" id="al-val" type="number" placeholder="Value" style="max-width:120px">
      </div>
      <div class="alert-row">
        <button class="alert-btn" onclick="addAlert()">+ Add Alert</button>
        <span style="font-size:.72rem;color:var(--tx3);margin-left:8px">Checked every 1 min during market hours</span>
      </div>
    </div>
  </div>`;

  html += `<div class="alert-panel">
    <div class="alert-title">📋 Active Alerts <span style="font-size:.75rem;font-weight:400;color:var(--tx3)">(${ALERTS.length} total)</span></div>`;

  if (!ALERTS.length) {
    html += `<div style="text-align:center;padding:20px;font-size:.82rem;color:var(--tx3)">No alerts set. Create one above.</div>`;
  } else {
    html += '<div class="alert-list">';
    ALERTS.forEach((a, i) => {
      const condLabel = a.type==='above'?`Price above ${alertPx(a.sym,a.value)}`:
                        a.type==='below'?`Price below ${alertPx(a.sym,a.value)}`:
                        a.type==='pct_up'?`Up ${a.value}%+ today`:
                        `Down ${a.value}%+ today`;
      html += `<div class="alert-item ${a.triggered?'triggered':''}">
        <div>
          <div class="ai-sym">${escHtml(a.sym)}</div>
          <div class="ai-cond">${escHtml(condLabel)}${a.triggeredAt?' — triggered at '+escHtml(a.triggeredAt):''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="ai-status ${a.triggered?'triggered':'active'}">${a.triggered?'Triggered':'Active'}</span>
          <button class="alert-btn del" onclick="deleteAlert(${jsArg(alertKey(a))})">✕</button>
        </div>
      </div>`;
    });
    html += '</div>';
    html += `<div style="margin-top:10px;text-align:right">
      <button class="alert-btn del" onclick="clearAllAlerts()" style="font-size:.75rem">Clear All</button>
    </div>`;
  }
  html += '</div>';

  // Auto-move alerts (news-triggered)
  html += `<div class="alert-panel">
    <div class="alert-title">⚡ Auto Market Alerts</div>
    <div style="font-size:.78rem;color:var(--tx2);line-height:1.7">
      These fire automatically — no setup needed:<br>
      <strong style="color:var(--tx)">• Big move alert</strong> — notifies when selected instrument moves ±1% in a day<br>
      <strong style="color:var(--tx)">• Screener Trade Alert</strong> — notifies when loaded screener cards show READY/CONFIRM<br>
      <strong style="color:var(--tx)">• Market open gate check</strong> — checks already-loaded screener stocks after NSE opens<br>
      <br>
      <button class="alert-btn" onclick="runTradeGateCheck({manual:true,delayMs:1500})" style="margin:6px 0 8px 0">Run Trade Gate Check Now</button><br>
      <span style="color:var(--tx3)">Price and screener checks run only while TradeDesk is open. Saved active alerts restart automatically after reload, but true alerts after closing the browser need server push.</span>
    </div>
  </div>`;

  return html;
}

/* Alert box for one instrument (opened from 🔔 on its trade plan). Quick picks fill the form from the plan. */
function openAlertPopup(sym, lv){
  closeAlertPopup();
  const p = document.createElement('div');
  p.id = 'td-alert-pop'; p.dataset.sym = sym; p.dataset.lv = JSON.stringify(lv || {});
  p.addEventListener('click', e => { if(e.target === p) closeAlertPopup(); });
  document.body.appendChild(p);
  renderAlertPopup();
}
function closeAlertPopup(){
  const had = !!document.getElementById('td-alert-pop');
  document.getElementById('td-alert-pop')?.remove();
  /* refresh the bell's "active alert" dot */
  if(had && CUR_SYM && document.querySelector('.tp-alert-btn')){
    const on = ALERTS.some(a => a.sym === CUR_SYM && !a.triggered);
    document.querySelectorAll('.tp-alert-btn').forEach(b => { const d = b.querySelector('.tp-alert-dot'); if(on && !d) b.insertAdjacentHTML('beforeend', '<i class="tp-alert-dot"></i>'); if(!on && d) d.remove(); });
  }
}
function alertQuickFill(type, v){ const t = document.getElementById('al-type'), x = document.getElementById('al-val'); if(t) t.value = type; if(x) x.value = v; }
function renderAlertPopup(){
  const p = document.getElementById('td-alert-pop'); if(!p) return;
  const sym = p.dataset.sym; let lv = {}; try{ lv = JSON.parse(p.dataset.lv || '{}'); }catch{}
  const price = sym === CUR_SYM ? getCurrentLivePrice() : null;
  /* A level the price has already crossed would fire at once - leave it out. */
  const crossed = (type, v) => price > 0 && (type === 'above' ? price >= +v : price <= +v);
  const chip = (label, type, v) => Number.isFinite(+v) && +v > 0 && !crossed(type, v) ? `<button type="button" class="alert-chip" onclick="alertQuickFill('${type}', ${+(+v).toFixed(2)})">${label} ${alertPx(sym, v)}</button>` : '';
  const mine = ALERTS.map((a, i) => ({a, i})).filter(x => x.a.sym === sym);
  const others = ALERTS.length - mine.length;
  const cond = a => a.type==='above' ? `Price above ${alertPx(a.sym,a.value)}` : a.type==='below' ? `Price below ${alertPx(a.sym,a.value)}` : a.type==='pct_up' ? `Up ${a.value}%+ today` : `Down ${a.value}%+ today`;
  const item = ({a, i}) => `<div class="alert-item ${a.triggered?'triggered':''}"><div>${a.sym !== sym ? `<div class="ai-sym">${escHtml(a.sym)}</div>` : ''}<div class="ai-cond">${escHtml(cond(a))}${a.triggeredAt?' — triggered at '+escHtml(a.triggeredAt):''}</div></div>
    <div style="display:flex;align-items:center;gap:8px"><span class="ai-status ${a.triggered?'triggered':'active'}">${a.triggered?'Triggered':'Active'}</span><button class="alert-btn del" onclick="deleteAlert(${jsArg(alertKey(a))})">✕</button></div></div>`;
  p.innerHTML = `<div class="alert-pop-card" role="dialog" aria-label="Price alert">
    <div class="alert-pop-head"><div class="alert-title" style="margin:0">🔔 Alert · ${escHtml(sym.replace(/^NSE:|^MCX:/,''))}${price ? ` <span style="font-weight:600;color:var(--tx3);font-size:.75rem">now ${alertPx(sym, price)}</span>` : ''}</div><button class="alert-btn del" onclick="closeAlertPopup()" aria-label="Close">✕</button></div>
    ${notifBannerHtml()}
    ${pushBannerHtml()}
    <div class="alert-chips">${chip('At buy limit', 'below', lv.limit)}${chip('Above entry', 'above', lv.entry)}${chip('Below SL', 'below', lv.sl)}${chip('Above T1', 'above', lv.t1)}</div>
    <input type="hidden" id="al-sym" value="${escHtml(sym)}">
    <div class="alert-row">
      <select class="alert-select" id="al-type">
        <option value="above">Price goes ABOVE ▲</option>
        <option value="below">Price goes BELOW ▼</option>
        <option value="pct_up">Day change UP % ▲</option>
        <option value="pct_down">Day change DOWN % ▼</option>
      </select>
      <input class="alert-input" id="al-val" type="number" placeholder="Value" style="max-width:120px">
      <button class="alert-btn" onclick="addAlert()">+ Add</button>
    </div>
    <div style="font-size:.7rem;color:var(--tx3);margin:4px 0 10px">Checked every minute in market hours - by this page while it is open, and by the server (with background alerts on, it reaches you with TradeDesk closed).</div>
    ${mine.length ? `<div class="alert-list">${mine.map(item).join('')}</div>` : '<div style="font-size:.78rem;color:var(--tx3)">No alert on this instrument yet.</div>'}
    <div style="font-size:.7rem;color:var(--tx3);margin-top:10px" data-sync-status>${syncStatusText()}</div>
    ${others ? `<details style="margin-top:10px"><summary style="font-size:.75rem;color:var(--tx2);cursor:pointer">Other alerts (${others})</summary><div class="alert-list" style="margin-top:6px">${ALERTS.map((a, i) => ({a, i})).filter(x => x.a.sym !== sym).map(item).join('')}</div></details>` : ''}
  </div>`;
}

async function addAlert() {
  const sym  = String(document.getElementById('al-sym')?.value || '').trim().toUpperCase();
  const type = document.getElementById('al-type')?.value;
  const val  = parseFloat(document.getElementById('al-val')?.value);
  if (!sym || !type || isNaN(val) || val <= 0) {
    showToast('Missing Info', 'Please fill in symbol and value', 'neutral');
    return;
  }
  try{
    const q = await apiFetch('/api/quickprice?sym=' + encodeURIComponent(sym), 8000);
    if(!Number.isFinite(+q.price)) throw new Error('No live price returned');
  }catch(e){
    showToast('Invalid / unavailable symbol', `${sym}: ${e.message}`, 'bear');
    return;
  }
  ALERTS.push({ id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), sym, type, value: val, triggered: false, createdAt: new Date().toLocaleTimeString('en-IN') });
  saveAlerts();
  startAlertEngine();
  rerenderAlertsView();
  showToast('Alert Set ✓', `Watching ${sym} — ${type} ${val}`, 'bull');
}

/* Alerts are identified by id (older ones by sym|type|value), not by position: a sync that changed the list made
   a list index point at a different alert. */
const alertKey = a => a?.id || `${a?.sym}|${a?.type}|${a?.value}`;
function deleteAlert(key) {
  const i = typeof key === 'number' ? key : ALERTS.findIndex(a => alertKey(a) === key);
  if (i < 0) return;
  ALERTS.splice(i, 1);
  saveAlerts();
  startAlertEngine();
  rerenderAlertsView();
}

function clearAllAlerts() {
  ALERTS = [];
  saveAlerts();
  startAlertEngine();
  rerenderAlertsView();
}


/* ══════════════════════════════════════════════════════════════════
   FORWARD TEST — real trade-plan tracking
   Tracks entry, stop loss, target, status and R-multiple.
   Important: this is browser-local. It evaluates future candles when the site is opened/refreshed.
══════════════════════════════════════════════════════════════════ */
const FORWARD_TEST_KEY = 'tradedesk_forward_test_v2';
/* Market date in IST. toISOString() is UTC, which put 00:00–05:30 IST records on the previous day. */
function localDateKey(d=new Date()) { return new Date(d.getTime() + 330*60000).toISOString().slice(0,10); }
/* Signed % return: a falling price is a GAIN for a short. */
function ftSignedRet(row, price){
  if(!ftValid(row?.entry) || !ftValid(price)) return null;
  const raw = (price - row.entry) / row.entry * 100;
  return +((row.side === 'Short' ? -raw : raw)).toFixed(2);
}
/* Daily bars as [{date, h, l}] in IST market dates, sorted, one per date. */
function ftDailyBars(q){
  /* Daily bars with close and EMA20 (needed for the time stop and the "daily close below EMA20" exit). */
  const d=q?.daily||{}, T=d.T||[], H=d.H||[], L=d.L||[], C=d.C||[];
  const out=[]; const k=2/21; let ema=null, seed=[];
  for(let i=0;i<T.length;i++){
    const c=+C[i];
    if(Number.isFinite(c)){ if(ema==null){ seed.push(c); if(seed.length===20) ema=seed.reduce((a,b)=>a+b,0)/20; } else ema=c*k+ema*(1-k); }
    const date=marketDateKeyFromTs(T[i]);
    if(!date || !Number.isFinite(+H[i]) || !Number.isFinite(+L[i])) continue;
    const bar={date,h:+H[i],l:+L[i],c:Number.isFinite(c)?c:null,e20:ema};
    if(out.length && out[out.length-1].date===date) out[out.length-1]=bar; else out.push(bar);
  }
  return out;
}
/* Quote truncated to bars on or before dateKey, so a plan built later still uses only signal-day data. */
function ftQuoteAsOf(q, dateKey){
  const d=q?.daily; if(!d?.T?.length) return q;
  let n=0; while(n<d.T.length && marketDateKeyFromTs(d.T[n]) <= dateKey) n++;
  if(n<2) return q;
  const cut=a=>Array.isArray(a)?a.slice(0,n):a;
  /* ftSwingLevels skips the last bar (it was the forming candle at signal time), so levels come from bars before the signal. */
  return {...q, price:+d.C[n-1], daily:{...d, T:cut(d.T), C:cut(d.C), H:cut(d.H), L:cut(d.L), O:cut(d.O), V:cut(d.V)}};
}
function daysBetween(a,b=localDateKey()) { return Math.floor((new Date(b+'T00:00:00') - new Date(a+'T00:00:00'))/86400000); }
function readForwardTests(){ try{return JSON.parse(localStorage.getItem(FORWARD_TEST_KEY)||'[]')||[]}catch(e){return[]} }
function saveForwardTests(rows){ try{ localStorage.setItem(FORWARD_TEST_KEY, JSON.stringify(rows.slice(-500))); }catch(e){ /* quota/private mode: keep in-memory result */ } }
function ftValid(v){ return Number.isFinite(+v) && +v > 0; }
function ftR(v){ return ftValid(v) ? R2(+v) : null; }
function ftMoney(v){ return ftValid(v) ? '₹' + fmt(+v) : '--'; }
function ftPct(v){ return Number.isFinite(+v) ? ((+v>=0?'+':'') + (+v).toFixed(2) + '%') : '--'; }
function ftRText(v){ return Number.isFinite(+v) ? ((+v>=0?'+':'') + (+v).toFixed(2) + 'R') : '--'; }
function ftAtr(C=[],H=[],L=[],price=0){
  const prev = Array.isArray(C) && C.length >= 2 ? +C[C.length-2] : +price;
  return calcATRFromBars(C,H,L,+price||0,+prev||+price||0,14);
}
function ftEma(C=[],p=20){ return Array.isArray(C) && C.length>=p ? emaLast(C,p) : null; }
function ftHi(arr){ const v=(arr||[]).filter(x=>Number.isFinite(+x)).map(Number); return v.length ? Math.max(...v) : null; }
function ftLo(arr){ const v=(arr||[]).filter(x=>Number.isFinite(+x)).map(Number); return v.length ? Math.min(...v) : null; }
function ftSwingLevels(q, entry){
  const d=q?.daily||{}, C=d.C||[], H=d.H||[], L=d.L||[];
  const n=C.length, end=Math.max(0,n-2); /* avoid current partial candle where possible */
  const hs=(days)=>H.slice(Math.max(0,end-days+1),end+1);
  const ls=(days)=>L.slice(Math.max(0,end-days+1),end+1);
  return {
    e20:ftEma(C,20), e50:ftEma(C,50), e200:ftEma(C,200), atr:ftAtr(C,H,L,entry||q?.price),
    r1:ftHi(hs(7)), r2:ftHi(hs(14)), r3:ftHi(hs(21)),
    s1:ftLo(ls(7)), s2:ftLo(ls(14)), s3:ftLo(ls(21)),
    recentHigh:ftHi(hs(21)), recentLow:ftLo(ls(21))
  };
}
function ftBuildPlanFromQuote(row, q){
  const entry=+row.entry || +q?.price || 0;
  const bias = row.bias || q?.bias || 'Bullish';
  const side = String(row.side || (bias === 'Bearish' ? 'Short' : 'Long'));
  const short = side === 'Short' || bias === 'Bearish';
  const lv=ftSwingLevels(q, entry);
  const atr=ftValid(row.atr) ? +row.atr : lv.atr;
  if(!ftValid(entry) || !ftValid(atr)) return row;

  if(short){
    let rawSl = ftValid(row.sl) && +row.sl > entry ? +row.sl : (ftValid(lv.e20) && lv.e20 > entry ? lv.e20 : (ftValid(lv.r1) && lv.r1 > entry ? lv.r1 : entry + atr*1.6));
    let sl = calcAtrStopLoss({side:'short', price:entry, structuralStop:rawSl, atr, fallbackStop:entry+atr*1.6, phase:'primary'});
    let t1 = ftValid(row.t1) && +row.t1 < entry ? +row.t1 : (ftValid(lv.s2) && lv.s2 < entry ? lv.s2 : (ftValid(lv.s3) && lv.s3 < entry ? lv.s3 : entry - atr*2));
    let t2 = ftValid(row.t2) && +row.t2 < t1 ? +row.t2 : (ftValid(lv.s3) && lv.s3 < t1 ? lv.s3 : t1 - Math.max(entry-t1, atr*1.5));
    const risk = Math.max(sl-entry, atr*0.75);
    const trailSl = Math.min(entry, t1 + atr*0.75);
    return {...row, side:'Short', bias:'Bearish', sl:ftR(sl), t1:ftR(t1), t2:ftR(t2), trailSl:ftR(trailSl), atr:ftR(atr), rr1:risk>0?+((entry-t1)/risk).toFixed(2):null, rr2:risk>0?+((entry-t2)/risk).toFixed(2):null, planLocked:true};
  } else {
    let rawSl = ftValid(row.sl) && +row.sl < entry ? +row.sl : (ftValid(lv.e50) && lv.e50 < entry ? lv.e50 : (ftValid(lv.s1) && lv.s1 < entry ? lv.s1 : entry - atr*1.6));
    let sl = calcAtrStopLoss({side:'long', price:entry, structuralStop:rawSl, atr, fallbackStop:entry-atr*1.6, phase:'primary'});
    let t1 = ftValid(row.t1) && +row.t1 > entry ? +row.t1 : (ftValid(lv.r1) && lv.r1 > entry ? lv.r1 : (ftValid(lv.r2) && lv.r2 > entry ? lv.r2 : (ftValid(lv.r3) && lv.r3 > entry ? lv.r3 : entry + atr*2)));
    let t2 = ftValid(row.t2) && +row.t2 > t1 ? +row.t2 : (ftValid(lv.r3) && lv.r3 > t1 ? lv.r3 : t1 + Math.max(t1-entry, atr*1.5));
    const risk = Math.max(entry-sl, atr*0.75);
    const trailSl = Math.max(entry, t1 - atr*0.75);
    return {...row, side:'Long', bias:'Bullish', sl:ftR(sl), t1:ftR(t1), t2:ftR(t2), trailSl:ftR(trailSl), atr:ftR(atr), rr1:risk>0?+((t1-entry)/risk).toFixed(2):null, rr2:risk>0?+((t2-entry)/risk).toFixed(2):null, planLocked:true};
  }
}
function ftNthBarReturn(row, q, nBars){
  const d = q?.daily || {}, C = d.C || [], T = d.T || [], today = localDateKey();
  const closes = [];
  for(let i=0;i<C.length;i++){ const k = T[i] ? marketDateKeyFromTs(T[i]) : ''; if(k && k > row.date && k < today && Number.isFinite(+C[i])) closes.push(+C[i]); }
  return closes.length >= nBars ? ftSignedRet(row, closes[nBars-1]) : null;
}
function ftEvaluateRow(row, q){
  const price=+q?.price || +row.current || +row.entry;
  const today=localDateKey();
  row.current=ftR(price) || row.current;
  const ret = ftSignedRet(row, price);
  row.retNow = ret == null ? row.retNow ?? null : ret;
  if(row.d5==null) row.d5=ftNthBarReturn(row, q, 5);
  if(row.d10==null) row.d10=ftNthBarReturn(row, q, 10);
  if(row.d20==null) row.d20=ftNthBarReturn(row, q, 20);

  /* Build the plan from data as of the signal date only (no look-ahead if the tab is opened days later). */
  if(!row.planLocked) row = ftBuildPlanFromQuote(row, ftQuoteAsOf(q, row.date));
  const entry=+row.entry, sl=+row.sl;
  const risk = row.side==='Short' ? (sl-entry) : (entry-sl);
  if(!(risk>0)) { row.status='Invalid Plan'; row.resultR=null; return row; }
  if(row.closed) { row.lastCheckedDate=today; return row; }

  /* Walk every daily bar AFTER the signal date that has not been evaluated yet, in order.
     Same-day high/low is never judged because it may have happened before the signal was captured.
     evalThrough = last date whose bar has been fully applied. */
  const bars = ftDailyBars(q);
  /* Only when the quote's last trade is from today: on weekends/holidays/pre-open dayHigh/dayLow are the
     previous session's, which is already in bars and would otherwise be applied twice. */
  const quoteDay = q?.marketTime ? marketDateKeyFromTs(q.marketTime) : null;
  if(quoteDay === today && Number.isFinite(+q?.dayHigh) && Number.isFinite(+q?.dayLow) && +q.dayHigh>0 && (!bars.length || bars[bars.length-1].date < today))
    bars.push({date:today, h:+q.dayHigh, l:+q.dayLow, c:Number.isFinite(+q.price)?+q.price:null, e20:null}); /* today's session when Yahoo daily has not rolled yet */
  /* Rows saved by the old single-day evaluator have no evalThrough; resume from their last check if already in trail. */
  const resumeFrom = row.evalThrough || (row.phase==='trail' ? row.lastCheckedDate : null);
  const from = resumeFrom && resumeFrom > row.date ? resumeFrom : row.date;
  for(const b of bars){
    if(b.date <= from) continue;
    const before = row.status + '|' + row.phase;
    ftApplyBar(row, b, risk, b.date < today);
    const changed = (row.status + '|' + row.phase) !== before || row.closed;
    /* A completed day is final. Today's bar is only marked done once it produced an event;
       otherwise it is re-checked on the next refresh with its fuller range. */
    if(b.date < today || changed) row.evalThrough = b.date;
    if(row.closed) break;
    /* If T1 hit on this bar, the trail phase is judged from the NEXT bar — intrabar order is unknown. */
  }
  if(!row.closed && !row.status) row.status = row.phase==='trail' ? 'T1 Hit · trailing' : 'Open';
  row.lastCheckedDate=today;
  return row;
}
/* Apply one bar's high/low to the trade state. Logic unchanged from the original single-day version. */
/* One daily bar of the exit plan shown on every card:
   stop-loss order at SL (-1R) · at T1 book 50% and move SL to entry · the rest exits at T2, at the trail stop
   (T1 -/+ 0.75 ATR, never worse than entry) or on a daily close through EMA20 · time stop: if T1 is not hit
   within 10 sessions, exit at that close. Result R = 0.5 x R(T1) + 0.5 x R(rest). When one bar touches both
   the stop and a target the order is unknown, so it is marked Ambiguous instead of guessed. */
function ftApplyBar(row, bar, risk, barComplete=true){
  const entry=+row.entry, sl=+row.sl, t1=+row.t1, t2=+row.t2, trailSl=+row.trailSl;
  const short = row.side==='Short', sgn = short ? -1 : 1;
  const R = px => +(((px - entry) * sgn) / risk).toFixed(2);
  const up = px => short ? bar.l <= px : bar.h >= px;      /* price reached a target level */
  const down = px => short ? bar.h >= px : bar.l <= px;    /* price reached a stop level */
  const closeThroughEma = barComplete && Number.isFinite(bar.c) && Number.isFinite(bar.e20) && (short ? bar.c > bar.e20 : bar.c < bar.e20);
  const rT1 = Number.isFinite(+row.rT1) ? +row.rT1 : R(t1);
  const close = (status, r) => { row.status=status; row.closed=true; row.resultR = r==null ? null : +r.toFixed(2); };
  if(row.phase==='trail'){
    const hitT2 = ftValid(t2) && up(t2), hitTrail = ftValid(trailSl) && down(trailSl);
    if(hitT2 && hitTrail) close('Ambiguous: T2 & Trail SL', null);
    else if(hitT2) close('T2 Hit', 0.5*rT1 + 0.5*R(t2));
    else if(hitTrail) close('Trail Stop Hit', 0.5*rT1 + 0.5*R(trailSl));
    else if(closeThroughEma) close('EMA20 Exit', 0.5*rT1 + 0.5*R(bar.c));
    else { row.status='T1 Hit · trailing'; row.resultR = +(0.5*rT1).toFixed(2); }
    return row;
  }
  const hitSL = ftValid(sl) && down(sl), hitT1 = ftValid(t1) && up(t1), hitT2 = ftValid(t2) && up(t2);
  if(hitSL && (hitT1 || hitT2)) close('Ambiguous: SL & Target', null);
  else if(hitT2) close('T2 Hit', 0.5*rT1 + 0.5*R(t2));
  else if(hitT1){ row.phase='trail'; row.rT1=rT1; row.status='T1 Hit · trailing'; row.resultR=+(0.5*rT1).toFixed(2); }
  else if(hitSL) close('SL Hit', -1);
  else {
    if(barComplete) row.sessions = (+row.sessions || 0) + 1;
    if(row.sessions >= 10 && Number.isFinite(bar.c)) close('Time Stop', R(bar.c));
    else row.status='Open';
  }
  return row;
}
function updateForwardTestsFromPicks(picks=[], source='qualified') {
  const today = localDateKey();
  const rows = readForwardTests();
  const byKey = new Map(rows.map(r=>[`${r.date}_${r.sym}`, r]));
  picks.forEach((p,i)=>{
    const sym = p.sym || String(p.ticker||'').replace('.NS','');
    const entry = +p.price;
    if(!sym || !entry) return;
    const key = `${today}_${sym}`;
    if(!byKey.has(key)) {
      const bias = p.bias || 'Bullish';
      const side = bias === 'Bearish' ? 'Short' : 'Long';
      const rec = {
        date:today, source, rank:i+1, sym, side, bias, entry:ftR(entry), current:ftR(entry),
        sl:ftR(p.plan?.stop ?? p.rrStop), t1:ftR(p.plan?.target ?? p.rrTarget), t2:null, trailSl:null, atr:ftR(p.atr),
        rr1:p.rrBull||p.rr||null, rr2:null, score10:p.score10||null,
        final:p.finalQualification||p.decisionScore||null, setup:p.pickedSetup||p.setup||null,
        status:'Open', phase:'entry', resultR:null, retNow:0, d5:null, d10:null, d20:null, closed:false,
        createdAt:new Date().toISOString()
      };
      rows.push(rec); byKey.set(key, rec);
    }
  });
  saveForwardTests(rows);
}
function refreshForwardTestsWithPicks(picks=[]) {
  /* Fast fallback used from screener render. Detailed SL/T1/T2 evaluation runs in tabForwardTest(). */
  const priceMap = new Map(picks.map(p=>[p.sym || String(p.ticker||'').replace('.NS',''), +p.price]));
  const today = localDateKey();
  const rows = readForwardTests().map(r=>{
    const cur = priceMap.get(r.sym);
    if(cur) {
      r.current = ftR(cur);
      const ret = ftSignedRet(r, cur);
      if(ret != null) r.retNow = ret;
    }
    return r;
  });
  saveForwardTests(rows);
}
async function refreshForwardTestsDetailed(limit=80){
  let rows = readForwardTests();
  const active = rows.filter(r=>!r.closed || !r.planLocked).slice(-limit);
  for(const r of active){
    try{
      const q = await fetchLiveQuote(`NSE:${r.sym}`);
      const idx = rows.findIndex(x=>x.date===r.date && x.sym===r.sym);
      if(idx>=0) rows[idx]=ftEvaluateRow(rows[idx], q);
    }catch(e){ /* keep local row if one stock fails */ }
  }
  saveForwardTests(rows);
  return rows;
}
async function tabForwardTest() {
  const tc = document.getElementById('tc');
  const live = tcGuard();
  tc.innerHTML = `<div class="ls" style="display:flex;min-height:100px"><div class="sp"></div><div class="lt">Updating forward test trade plans…</div></div>`;
  try{
    /* Use the live my-trade screener cache (SCREENER_CACHE_UI / qualified cache are never filled). */
    let d = MY_TRADE_CACHE_UI || readMyTradeScreenerCache();
    if(!d) d = await apiFetch('/api/my-trade-screener', 120000);
    if(d?.picks?.length) updateForwardTestsFromPicks(d.picks,'mytrade');
    await refreshForwardTestsDetailed(80);
  }catch(e){ /* keep existing local records even when network fails */ }
  const rows = readForwardTests().slice().reverse();
  const finished = rows.filter(r=>r.closed && Number.isFinite(+r.resultR));
  const wins = finished.filter(r=>+r.resultR>0).length;
  const avgR = finished.length ? (finished.reduce((a,r)=>a+(+r.resultR||0),0)/finished.length).toFixed(2) : '--';
  const winRate = finished.length ? Math.round(wins/finished.length*100) : '--';
  const openCount = rows.filter(r=>!r.closed).length;
  const body = rows.length ? rows.slice(0,120).map(r=>{
    const retCol = (+r.retNow||0)>=0?'var(--bull)':'var(--bear)';
    const resCol = (+r.resultR||0)>0?'var(--bull)':(+r.resultR||0)<0?'var(--bear)':'var(--tx2)';
    const statusCol = String(r.status||'').includes('SL')?'var(--bear)':String(r.status||'').includes('Target')||String(r.status||'').includes('T1')||String(r.status||'').includes('T2')?'var(--bull)':String(r.status||'').includes('Ambiguous')?'var(--neu)':'var(--tx2)';
    return `<tr>
      <td>${escHtml(r.date)}<br><span style="color:var(--tx3)">${daysBetween(r.date)}D</span></td>
      <td><strong>${escHtml(r.sym)}</strong><br><span style="color:var(--tx3)">#${escHtml(r.rank||'-')} · ${escHtml(r.setup||r.source||'qualified')}</span></td>
      <td><span style="color:${r.side==='Short'?'var(--bear)':'var(--bull)'};font-weight:800">${escHtml(r.side||'Long')}</span></td>
      <td>${ftMoney(r.entry)}</td>
      <td>${ftMoney(r.sl)}<br><span style="color:var(--tx3)">Trail ${ftMoney(r.trailSl)}</span></td>
      <td>${ftMoney(r.t1)}<br><span style="color:var(--tx3)">T2 ${ftMoney(r.t2)}</span></td>
      <td>${ftMoney(r.current)}<br><span style="color:${retCol};font-weight:800">${ftPct(r.retNow)}</span></td>
      <td style="color:${statusCol};font-weight:800">${escHtml(r.status||'Open')}</td>
      <td style="color:${resCol};font-weight:900">${ftRText(r.resultR)}</td>
      <td>${escHtml(r.final||r.score10||'--')}%</td>
    </tr>`;
  }).join('') : `<tr><td colspan="10">No records yet. Each READY pick in Screener Match is saved here automatically and tracked to its stop or target.</td></tr>`;
  if(!live()) return;
  tc.innerHTML = `<div class="scr-header"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="font-size:1rem;font-weight:800;color:var(--acc)">Track Record — how past screener picks played out</div><button onclick="localStorage.removeItem(FORWARD_TEST_KEY);tabForwardTest()" style="margin-left:auto;padding:4px 12px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);color:var(--bear);font-size:.75rem;font-weight:700;cursor:pointer">Clear Records</button></div><div style="font-size:.72rem;color:var(--tx3);margin-top:6px">Tracks each qualified signal as an actual plan: Entry, ATR-adjusted Stop Loss, Target, Stop Loss and R-multiple. Same-day signal candles are not judged because the day high/low may have happened before the signal. Open this tab daily for proper local tracking.</div></div>
  <div class="scr-summary"><div class="scr-sum-card"><div class="scr-sum-label">Records</div><div class="scr-sum-val">${rows.length}</div></div><div class="scr-sum-card"><div class="scr-sum-label">Open / Trail</div><div class="scr-sum-val" style="color:var(--acc)">${openCount}</div></div><div class="scr-sum-card"><div class="scr-sum-label">Closed R Samples</div><div class="scr-sum-val">${finished.length}</div></div><div class="scr-sum-card"><div class="scr-sum-label">Win Rate</div><div class="scr-sum-val" style="color:var(--bull)">${winRate}${winRate==='--'?'':'%'}</div></div><div class="scr-sum-card"><div class="scr-sum-label">Avg R</div><div class="scr-sum-val" style="color:${(+avgR||0)>=0?'var(--bull)':'var(--bear)'}">${avgR}${avgR==='--'?'':'R'}</div></div></div>
  <table class="ft-table"><thead><tr><th>Date</th><th>Stock</th><th>Side</th><th>Entry</th><th>SL / Trail</th><th>T1 / T2</th><th>Now</th><th>Status</th><th>Result</th><th>Decision</th></tr></thead><tbody>${body}</tbody></table>
  <div class="aib" style="font-size:.72rem;margin-top:10px"><b>Reading the result:</b> each trade follows its exit plan: stop-loss order (-1R), half booked at T1, the rest at T2 / trail stop / a close through EMA20, or a time stop after 10 sessions without T1. Result = half T1 + half the rest. +1R means profit equal to one planned risk unit. -1R means stop-loss hit. Ambiguous means daily high/low touched both SL and target on the same day; without intraday order, the app refuses to guess.</div>`;
}

/* ══════════════════════════════════════════════════════════════════
   QUALIFIED TRADE SCREENER — Uses website scoring layers
══════════════════════════════════════════════════════════════════ */
let SCREENER_CACHE_UI = null, SCREENER_TS_UI = 0;
const SCREENER_TTL_UI = 24 * 60 * 60 * 1000; /* after-hours max; during NSE hours use getScreenerUiTtlMs() */
const SCREENER_LOCAL_VERSION = DAILY_LOCAL_CACHE_VERSION;

function screenerTodayKey() { return dailyCacheKey('qualified_screener_v12'); }
function readLocalScreenerCache() { return readDailyLocalCache('qualified_screener_v12'); }
function saveLocalScreenerCache(data) { saveDailyLocalCache('qualified_screener_v12', data); }
function clearLocalScreenerCache() {
  clearDailyLocalCache('qualified_screener_v12'); clearDailyLocalCache('qualified_screener_v11');
  SCREENER_CACHE_UI = null;
  SCREENER_TS_UI = 0;
}

function qualifiedReason(s) {
  const setup = s.setup || 'Trend + momentum';
  const vol = Number.isFinite(+s.volPressure) ? `${s.volPressure}x vol` : 'Volume ok';
  const status = s.isStrictQualified ? 'Trade-ready scan' : 'Watchlist only';
  return `${setup} · ${vol} · ${status}`;
}
function qualifiedGrade(score) {
  score = +score || 0;
  if (score >= 80) return 'A+ · Strong fresh-entry quality';
  if (score >= 70) return 'A · Qualified fresh entry';
  if (score >= 55) return 'B · Watchlist only';
  if (score >= 40) return 'C · Weak / wait';
  return 'Avoid · poor setup';
}

let CURRENT_SCREENER_MODE = 'mytrade';
async function tabScreener(mode = CURRENT_SCREENER_MODE, force = false) {
  /* A new render: the Overview-check loops of the previous screen stop (after Refresh, two loops used to write
     the old scan's verdicts into the new rows). */
  tcBeginRender();
  if (mode === 'qualified' || mode === 'picklist' || mode === 'stockweek') mode = 'mytrade';   /* one screener list */
  if (mode === 'backtest') { CURRENT_SCREENER_MODE = mode; await tabBacktest(); return; }
  if (mode === 'momentum') { CURRENT_SCREENER_MODE = mode; await tabMomentum(force); return; }
  CURRENT_SCREENER_MODE = mode;
  if (mode === 'mytrade') { await tabMyTradeScreener(force); return; }
  if (mode === 'stockweek') { await tabStockOfWeekScreener(); return; }
  if (mode === 'picklist') { await tabPickList(); return; }
  if (mode === 'track') {
    await tabForwardTest();
    const tc = document.getElementById('tc');
    if (CURRENT_SCREENER_MODE === 'track' && tc && !tc.querySelector('.scr-tabs-row') && tc.querySelector('.ft-table, .scr-header')) tc.insertAdjacentHTML('afterbegin', screenerModeSwitch('track'));
    return;
  }
  await tabMyTradeScreener();
}





/* Screener Match: user-specific conservative scan.
   Old screeners stay unchanged. This one selects only EMA20 Pullback, EMA50 Deep Pullback, or Support Bounce candidates. */
let MY_TRADE_CACHE_UI = null, MY_TRADE_TS_UI = 0;
function readMyTradeScreenerCache() { return readDailyLocalCache('ready_watch_screener_v15'); }
function saveMyTradeScreenerCache(data) { saveDailyLocalCache('ready_watch_screener_v15', data); }
function clearMyTradeScreenerCache() { clearDailyLocalCache('ready_watch_screener_v15'); clearDailyLocalCache('ready_watch_screener_v12'); clearDailyLocalCache('ready_watch_screener_v10','ready_watch_screener_v11'); clearDailyLocalCache('ready_watch_screener_v9'); clearDailyLocalCache('ready_watch_screener_v8'); MY_TRADE_CACHE_UI = null; MY_TRADE_TS_UI = 0; }
function screenerUniverseStatsHtml(data) {
  const u = data?.universeStats || {};
  const parts = [];
  if(Number.isFinite(+u.marketCapEligible)) parts.push(`MCap > ₹35kCr ${u.marketCapEligible}`);
  if(Number.isFinite(+u.priceEligible)) parts.push(`Price > ₹10 ${u.priceEligible}`);
  if(Number.isFinite(+u.biasEligible)) parts.push(`Bullish bias ${u.biasEligible}`);
  if(!parts.length) return '';
  const note = u.priceNote ? `<div style="font-size:.66rem;color:var(--tx3);margin-top:3px">${u.priceNote}</div>` : '';
  return `<div style="font-size:.7rem;color:var(--tx2);margin-top:6px"><b>Universe count:</b> ${parts.join(' → ')}</div>${note}`;
}
function screenerFlowHtml(data) {
  const flow = data?.screenerFlow || [
    {step:'Bias', rule:'Bullish only'},
    {step:'Setup', rule:'EMA20 Pullback / EMA50 Pullback / Support Bounce only'},
    {step:'Entry / Action', rule:'RR≥1.25 + Volume≥0.8x + score gates decide Ready vs Watchlist'},
    {step:'Ready Gate', rule:'Selected setup gate must PASS'}
  ];
  return `<div class="scr-filters" style="margin-top:10px">${flow.map((x,i)=>`<span class="scr-filter"><b>${i+1}. ${x.step}</b>: ${x.rule}</span>`).join('')}</div>`;
}
function screenerClientReadyOk(s) {
  const setupScore = Math.round(+s?.selectedStrategyScore || +s?.finalQualification || 0);
  const readyStatus = String(s?.tradeStatus || '').toUpperCase() === 'READY';
  const gateOk = String(s?.readyGate || '').toUpperCase() === 'PASS';
  const rrOk = Number(s?.rr) >= 1.25;
  /* Volume is checked per setup on the server (pullback bounce-day / breakout rule); trust its READY. */
  return !!(readyStatus && setupScore >= 70 && gateOk && rrOk);
}
function screenerBadgeHtml(s) {
  const readyClientOk = screenerClientReadyOk(s);
  const txt = readyClientOk ? 'Screener Match' : 'Watchlist';
  const col = readyClientOk ? 'var(--bull)' : 'var(--neu)';
  return `<span class="scr-badge" style="border:1px solid ${col};color:${col}">${txt}</span>`;
}
function screenerTriggerHtml(s) {
  const sec = s?.sector && Number.isFinite(+s?.sectorRank)
    ? `<span class="scr-sec ${+s.sectorRank <= 5 ? 'lead' : +s.sectorRank > (+s.sectorOf || 99) - 3 ? 'lag' : ''}">${escHtml(s.sector)} #${s.sectorRank}/${s.sectorOf} · 1M ${+s.sectorRet1m >= 0 ? '+' : ''}${(+s.sectorRet1m).toFixed(1)}%</span>` : '';
  const trg = s?.trigger ? `<div class="scr-trigger"><b>Trigger:</b> ${escHtml(s.trigger)}</div>` : '';
  return (trg || sec) ? `<div class="scr-trigger-row">${trg}${sec}</div>` : '';
}
function screenerCardGateHtml(s) {
  const rrOk = Number(s?.rr) >= 1.25;
  /* Volume rule by setup (same as server): pullbacks = bounce-day volume >= 1.0x, breakouts = >= 1.1x. */
  const setupName = s?.pickedSetup || s?.selectedStrategy || '';
  const isPullback = /pullback|bounce/i.test(setupName), isBreakout = /breakout/i.test(setupName);
  const volVal = isPullback && Number.isFinite(+s?.bounceVolume) ? +s.bounceVolume : Number(s?.volPressure || 0);
  const volOk = isPullback ? volVal >= 1.0 : isBreakout ? volVal >= 1.1 : volVal >= 0.8;
  const volLabel = isPullback ? 'Bounce vol' : 'Volume';
  const rsOk = Number.isFinite(+s?.rs3m) ? +s.rs3m > 0 : true;
  const setupScore = Math.round(+s?.selectedStrategyScore || +s?.finalQualification || 0);
  const readyOk = screenerClientReadyOk(s);
  const gateOk = String(s?.readyGate || '').toUpperCase() === 'PASS';
  const pill = (label, ok, value) => `<span class="scr-filter" style="border-color:${ok?'rgba(76,175,80,.45)':'rgba(255,193,7,.45)'};color:${ok?'var(--bull)':'var(--neu)'}"><b>${label}</b>: ${value}</span>`;
  return `<div class="scr-filters" style="margin-top:8px">
    ${pill('Bias', s?.bias === 'Bullish', s?.bias || '-')}
    ${pill('Setup', setupScore >= (readyOk ? 70 : 55), `${setupScore}%`)}
    ${pill('RR', rrOk, `${Number(s?.rr || 0).toFixed(2)}x`)}
    ${pill(volLabel, volOk, `${volVal.toFixed(2)}x`)}
    ${Number.isFinite(+s?.rs3m) ? pill('RS 3M', rsOk, `${+s.rs3m > 0 ? '+' : ''}${(+s.rs3m).toFixed(1)}%${Number.isFinite(+s?.rsRank) ? ` · top ${Math.max(1, 100 - +s.rsRank)}%` : ''}`) : ''}
    ${SwingPlan.WATCH_ONLY.has(s?.pickedSetup || '') ? pill('Gate', false, 'ALERT ONLY') : pill('Gate', gateOk, s?.readyGate || '-')}
  </div>`;
}
async function tabMyTradeScreener(force = false) {
  const tc = document.getElementById('tc');
  const live = tcGuard();   /* a slow scan must not replace a page the user opened meanwhile */
  tc.innerHTML = `${screenerModeSwitch('mytrade')}<div class="scr-loading">
    <div class="sp"></div>
    <div class="lt">Scanning Screener Matches & Watchlist…</div>
    <div class="scr-progress">One scan · Screener Match + Watchlist · no duplicate stocks</div>
  </div>`;
  try {
    if (!force && MY_TRADE_CACHE_UI && Date.now() - MY_TRADE_TS_UI < getScreenerUiTtlMs()) {
      renderMyTradeScreener(MY_TRADE_CACHE_UI, 'memory');
      return;
    }
    const localData = force ? null : readMyTradeScreenerCache();
    if (localData) {
      MY_TRADE_CACHE_UI = localData;
      MY_TRADE_TS_UI = Date.now();
      renderMyTradeScreener(localData, 'local');
      return;
    }
    const data = await apiFetch('/api/my-trade-screener' + (force ? '?refresh=1' : ''), 120000);
    MY_TRADE_CACHE_UI = data;
    MY_TRADE_TS_UI = Date.now();
    saveMyTradeScreenerCache(data);
    if (!live() || CURRENT_SCREENER_MODE !== 'mytrade') return;
    renderMyTradeScreener(data, 'server');
  } catch(e) {
    if (!live()) return;
    tc.innerHTML = `<div class="eb"><strong>Ready/Watchlist error:</strong> ${e.message}<br>
      <button onclick="clearMyTradeScreenerCache();tabScreener('mytrade')" style="margin-top:8px;padding:6px 14px;background:var(--acc);border:none;border-radius:var(--rs);color:#000;font-weight:700;cursor:pointer">↻ Retry</button></div>`;
  }
}
/* Group 1 READY, 2 watchlist with a good setup score (waiting for its breakout or pullback), 3 low score /
   low R:R / near resistance. */
function screenerRowGroup(s){
  if(s._ready) return 1;
  if(s.limitReady && s.limitEntry) return 1.5;
  const sc = +s.selectedStrategyScore || +s.finalQualification || 0, rr = Number(s.rr), room = Number(s.resistanceRoom);
  if(sc < 70 || (Number.isFinite(rr) && rr < SWING_MIN_RR) || (Number.isFinite(room) && room < 3)) return 3;
  return 2;
}
function screenerRowTag(s, g){
  if(g === 1) return {t:'READY', c:'ready'};
  if(g === 1.5) return {t:'Ready on limit', c:'ready'};
  const setup = String(s.pickedSetup || s.selectedStrategy || '');
  if(g === 2) return {t: /breakout|momentum/i.test(setup) ? 'Wait breakout' : /pullback|bounce/i.test(setup) ? 'Wait pullback' : 'Watch', c:'watch'};
  const rr = Number(s.rr), room = Number(s.resistanceRoom);
  return {t: Number.isFinite(rr) && rr < SWING_MIN_RR ? 'Low R:R' : Number.isFinite(room) && room < 3 ? 'Near resistance' : 'Low score', c:'low'};
}
function renderMyTradeScreener(data, source='server') {
  const tc = document.getElementById('tc');
  const seen = new Set(), all = [];
  (data.picks || []).forEach(s => { const k = String(s.sym).toUpperCase(); if(!seen.has(k)){ seen.add(k); all.push({...s, _ready: screenerClientReadyOk(s)}); } });
  (data.watchlist || []).forEach(s => { const k = String(s.sym).toUpperCase(); if(!seen.has(k)){ seen.add(k); all.push({...s, _ready:false}); } });
  const score = s => +s.selectedStrategyScore || +s.finalQualification || 0;
  const f = v => Number.isFinite(+v) ? fmt(+v) : '--';
  const row = (s, g) => {
    const lim = g === 1.5 ? s.limitEntry : null;
    const p = s.plan || {}, rr = lim ? Number(lim.rr) : Number(s.rr), tag = screenerRowTag(s, g);
    const why = g === 1 ? (s.trigger || 'All checks pass') : lim ? `Buy limit ₹${f(lim.price)} - fills only if price comes back (now ₹${f(s.price)}, R:R from here ${Number(s.rr).toFixed(2)})` : (s.watchReason || s.trigger || '');
    return `<div class="pl-row ${g === 1 ? 'ready' : ''}" data-sym="NSE:${escHtml(s.sym)}" data-name="${escHtml(s.sym)}" title="Open ${escHtml(s.sym)}">
      <div class="pl-main">
        <div class="pl-sym">${escHtml(s.sym)} <span class="pl-tag ${tag.c}">${tag.t}</span>${screenerResultsChip(s)}</div>
        <div class="pl-setup">${escHtml(s.pickedSetup || s.selectedStrategy || 'Setup')} · ₹${f(s.price)}${Number.isFinite(+s.weekChg) ? ` · <span style="color:${+s.weekChg >= 0 ? 'var(--bull)' : 'var(--bear)'}">${+s.weekChg >= 0 ? '+' : ''}${s.weekChg}% wk</span>` : ''}${s.sector ? ` · ${escHtml(s.sector)}` : ''}</div>
        <div class="pl-why">${escHtml(String(why).slice(0, 160))}</div>
        ${g === 1 || lim ? `<div class="scr-ov" data-ov="${escHtml(s.sym)}">${s._overviewAction ? screenerOverviewLine(s) : 'Overview check…'}</div>` : ''}
        ${lim ? `<button type="button" class="alert-chip" style="margin-top:6px" onclick="event.stopPropagation();openAlertPopup(${jsArg('NSE:' + s.sym)}, ${jsArg({limit:lim.price, sl:lim.stop, t1:lim.target})})">🔔 Alert at ₹${f(lim.price)}</button>` : ''}
      </div>
      <div class="pl-levels">
        <div><span>${lim ? 'Limit' : 'Entry'}</span><b>${f(lim ? lim.price : p.entry)}</b></div>
        <div><span>SL</span><b style="color:var(--bear)">${f(lim ? lim.stop : p.stop)}</b></div>
        <div><span>T1</span><b style="color:var(--bull)">${f(lim ? lim.target : p.target)}</b></div>
        <div><span>R:R</span><b style="color:${rr >= SWING_MIN_RR ? 'var(--bull)' : 'var(--neu)'}">${Number.isFinite(rr) ? rr.toFixed(2) : '--'}</b></div>
      </div>
    </div>`;
  };
  const groups = [
    {g:1, title:'Ready to trade', sub:'Every check passed, and the Overview confirms each one below.', cls:'bull', id:'scrMatchGrid'},
    {g:1.5, title:'Ready on limit', sub:'Good pullback, but price has run above the zone. Place a buy limit at the price shown - it fills only if price comes back; R:R there is 1.25 or better.', cls:'bull', id:'scrLimitGrid'},
    {g:2, title:'Watchlist - waiting for breakout or pullback', sub:'Good setup score. Buy only when the trigger (close above resistance, or the bounce at EMA20 / EMA50) happens.', cls:'bull', id:'scrDemoted'},
    {g:3, title:'Low score / low R:R', sub:'Weak setup, R:R under 1.25 or close to resistance - not a buy yet.', cls:'neutral', id:''},
  ];
  /* Quick Bounce (RSI-2): its own list from the scan (data.quickBounce). */
  const qb = data.quickBounce || [];
  const qbRow = q => `<div class="pl-row ready" data-sym="NSE:${escHtml(q.sym)}" data-name="${escHtml(q.sym)}" title="Open ${escHtml(q.sym)}">
      <div class="pl-main">
        <div class="pl-sym">${escHtml(q.sym)} <span class="pl-tag ready">Quick bounce</span>${screenerResultsChip(q)}</div>
        <div class="pl-setup">RSI-2 ${q.rsi2} · ₹${f(q.price)} · above 50 / 200-day average${q.sector ? ` · ${escHtml(q.sector)}` : ''}</div>
        <div class="pl-why">Buy near ₹${f(q.close)} (next open). Sell at the first close above the 5-day average (₹${f(q.sma5)} today) or after 10 days.</div>
        <div class="scr-ov" data-ovq="${escHtml(q.sym)}">Overview check…</div>
      </div>
      <div class="pl-levels">
        <div><span>Buy</span><b>${f(q.close)}</b></div>
        <div><span>SL</span><b style="color:var(--bear)">${f(q.stop)}</b></div>
        <div><span>Exit</span><b style="color:var(--bull)">5-day avg</b></div>
        <div><span>Now</span><b>${f(q.sma5)}</b></div>
      </div>
    </div>`;
  const qbGroup = `<div class="pl-group bull" id="scrQuickGrid">
      <div class="pl-head"><div><div class="pl-title">Quick bounce (RSI-2)</div><div class="pl-sub">Short dip in an uptrend: 2-day RSI under 10, price above its 50- and 200-day averages, Nifty above its 200-day average. Hold 1-10 days. Backtest: about 2 in 3 trades win, small gains (+0.3% a trade after costs) - keep the stop.</div></div><div class="pl-count">${qb.length}</div></div>
      ${qb.length ? qb.map(qbRow).join('') : `<div class="pl-empty">${escHtml(data.quickBounceNote || 'None in this scan.')}</div>`}
    </div>`;
  const html = groups.map(G => {
    const list = all.filter(s => screenerRowGroup(s) === G.g).sort((a,b) => score(b) - score(a) || (+b.rankScore || 0) - (+a.rankScore || 0));
    const empty = G.g === 1 ? `No stock is READY in this scan.${data?.marketTrend?.allowReady === false ? ' The market filter is holding back fresh longs.' : ''}` : 'None in this scan.';
    return `<div class="pl-group ${G.cls}"${G.id ? ` id="${G.id}"` : ''}>
      <div class="pl-head"><div><div class="pl-title">${G.title}</div><div class="pl-sub">${G.sub}</div></div><div class="pl-count">${list.length}</div></div>
      ${G.g === 2 ? '<div id="scrDemotedGrid"></div>' : ''}
      ${list.length ? list.map(s => row(s, G.g)).join('') : `<div class="pl-empty">${empty}</div>`}
    </div>${G.g === 1.5 ? qbGroup : ''}`;
  }).join('');
  const ts = data.generatedAt ? new Date(data.generatedAt) : null;
  const when = ts ? ts.toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'}) : '--';
  tc.innerHTML = `${screenerModeSwitch('mytrade')}${screenerContextHtml(data)}
    <div class="aib" style="font-size:.72rem;margin-bottom:10px">Scan of ${when}${source === 'server' ? '' : ' (saved - Refresh before trading)'} · ${all.length} stocks. Tap a stock for its full Overview.
      <div id="scrConsistency" style="margin-top:6px"><button class="alert-chip" onclick="checkAllVsOverview()" title="Opens every listed stock's Overview in the background and compares bias, setup, R:R and action (about 4 data calls per stock)">Check all vs Overview</button></div></div>
    ${html}`;
  tc.querySelectorAll('.pl-row[data-sym]').forEach(el => el.addEventListener('click', () => {
    const sym = el.dataset.sym;
    loadInstrument(sym, CLIENT_NAMES[sym.replace('NSE:','')] || el.dataset.name || sym.replace('NSE:',''));
  }));
  /* One check at a time: an Overview probe swaps the page's current stock while it runs. */
  const live = tcGuard();
  SCR_VERIFY = verifyScreenerPicksWithOverview(all.filter(s => s._ready || screenerRowGroup(s) === 1.5), data, tc, live)
    .then(() => verifyQuickWithOverview(qb, tc, live)).catch(() => {});
}
let SCR_VERIFY = Promise.resolve();
async function verifyQuickWithOverview(list, tc, live){
  for(const q of list){
    if(!live()) return;
    const sym = 'NSE:' + q.sym;
    let v = null; try { v = await probeOverviewVerdict(sym, CLIENT_NAMES[q.sym] || q.sym); } catch {}
    if(!v && live()){ await new Promise(r => setTimeout(r, 1500)); try { v = await probeOverviewVerdict(sym, CLIENT_NAMES[q.sym] || q.sym); } catch {} }
    if(!live()) return;
    const el = tc.querySelector(`.scr-ov[data-ovq="${q.sym}"]`);
    if(el) el.innerHTML = !v ? `<span style="color:var(--neu)">Overview check unavailable — open the stock to confirm</span>`
      : v.quick ? `<span style="color:var(--bull);font-weight:800">Overview: quick bounce ✓</span>` : `<span style="color:var(--neu);font-weight:800">Overview: no quick bounce</span>`;
  }
}
function screenerOverviewLine(s){
  if(s.limitReady && s.limitEntry){
    if(s._overviewAction === 'UNCHECKED') return `<span style="color:var(--neu)">Overview check unavailable — open the stock to confirm</span>`;
    const hasLim = s._overviewLimit != null && Number.isFinite(+s._overviewLimit);
    return hasLim && Math.abs(+s._overviewLimit - +s.limitEntry.price) < 0.06
      ? `<span style="color:var(--bull);font-weight:800">Overview: limit ₹${fmt(s._overviewLimit)} ✓</span>`
      : `<span style="color:var(--neu);font-weight:800">Overview: ${escHtml(s._overviewAction || '')}${hasLim ? ` · limit ₹${fmt(s._overviewLimit)}` : ' · no limit plan'}</span> <span style="color:var(--tx3)">${escHtml(s._overviewReason || '')}</span>`;
  }
  if(s._overviewAction === 'READY') return `<span style="color:var(--bull);font-weight:800">Overview: READY ✓</span>`;
  if(s._overviewAction === 'UNCHECKED') return `<span style="color:var(--neu)">Overview check unavailable — open the stock to confirm</span>`;
  return `<span style="color:var(--neu);font-weight:800">Overview: ${escHtml(s._overviewAction)}</span> <span style="color:var(--tx3)">${escHtml(s._overviewReason || '')}</span>`;
}
/* One stock at a time (no burst on Yahoo); quote + context come from the server's caches after the scan. */
async function verifyScreenerPicksWithOverview(picks, data, tc, live = () => true){
  /* #tc is permanent, so "document.body.contains(tc)" never stopped this loop: it kept probing (and swapping
     CUR_SYM/CUR_DATA) after the user opened a stock, and re-opening the screener started a second loop. */
  for(const s of picks){
    if(!live()) return;
    if(!s._overviewAction || s._overviewAction === 'UNCHECKED'){
      const sym = `NSE:${s.sym}`;
      let v = null;
      try { v = await probeOverviewVerdict(sym, CLIENT_NAMES[s.sym] || s.sym); } catch { v = null; }
      /* One retry: a single slow quote / context fetch used to leave "check unavailable" (AUROPHARMA, RADICO). */
      if(!v && live()){ await new Promise(r => setTimeout(r, 1500)); try { v = await probeOverviewVerdict(sym, CLIENT_NAMES[s.sym] || s.sym); } catch { v = null; } }
      s._overviewAction = v?.action || 'UNCHECKED';
      s._overviewReason = v?.reason || '';
      s._overviewLimit = v?.limit ?? null;
      /* The Trade Gate reads MY_TRADE_CACHE_UI.picks, not these display copies: a pick the Overview demoted used
         to be notified as "Trade Gate Ready". */
      const src = (MY_TRADE_CACHE_UI?.picks || []).find(p => p.sym === s.sym);
      if (src) { src._overviewAction = s._overviewAction; src._overviewReason = s._overviewReason; }
    }
    if(!document.body.contains(tc)) continue;
    const line = tc.querySelector(`.scr-ov[data-ov="${s.sym}"]`);
    if(line) line.innerHTML = screenerOverviewLine(s);
    const card = line?.closest('.scr-card, .pl-row');
    if(card && !s.limitReady && s._overviewAction !== 'READY' && s._overviewAction !== 'UNCHECKED'){
      const box = tc.querySelector('#scrDemoted'), grid = tc.querySelector('#scrDemotedGrid');
      if(box && grid){
        card.querySelector('.scr-rank')?.remove(); card.classList.remove('ready');
        const tag = card.querySelector('.pl-tag'); if(tag){ tag.textContent = 'Overview: not yet'; tag.className = 'pl-tag watch'; }
        grid.appendChild(card); box.style.display = '';
        box.querySelector('.pl-empty')?.remove();
      }
    }
  }
  const confirmed = picks.filter(s => !s.limitReady && s._overviewAction === 'READY');
  if(document.body.contains(tc) && picks.length && !tc.querySelector('#scrMatchGrid .scr-card, #scrMatchGrid .pl-row')){
    tc.querySelector('#scrMatchGrid')?.insertAdjacentHTML('beforeend', `<div class="pl-empty">No stock is READY after the Overview check.</div>`);
  }
  updateForwardTestsFromPicks(confirmed, 'mytrade');
  refreshForwardTestsWithPicks(confirmed);
  maybeRunTradeGateAfterScreenerLoad();
  notifyReadyScreenerPicks({...data, picks: confirmed}, 'Screener Match');
}

/* Watchlist uses the same /api/my-trade-screener response as Ready.
   Old alternate screener wording is removed to avoid mixing two different screeners. */
let STOCK_WEEK_CACHE_UI = null, STOCK_WEEK_TS_UI = 0;
async function fetchStockOfWeekCached(force=false) {
  if (!force && STOCK_WEEK_CACHE_UI && Date.now() - STOCK_WEEK_TS_UI < getScreenerUiTtlMs()) return { ...STOCK_WEEK_CACHE_UI, _localDailyCache:'memory' };
  if (!force) {
    const local = readDailyLocalCache('ready_watch_screener_v15');
    if (local) { STOCK_WEEK_CACHE_UI = local; STOCK_WEEK_TS_UI = Date.now(); return { ...local, _localDailyCache:'local' }; }
  }
  const data = await apiFetch('/api/my-trade-screener' + (force ? '?refresh=1&_=' + Date.now() : ''), 120000);
  STOCK_WEEK_CACHE_UI = data;
  STOCK_WEEK_TS_UI = Date.now();
  saveDailyLocalCache('ready_watch_screener_v15', data);
  return { ...data, _localDailyCache:false };
}
function clearStockOfWeekCache() { clearDailyLocalCache('ready_watch_screener_v15'); clearDailyLocalCache('ready_watch_screener_v12'); clearDailyLocalCache('ready_watch_screener_v10','ready_watch_screener_v11'); clearDailyLocalCache('ready_watch_screener_v9'); clearDailyLocalCache('ready_watch_screener_v8'); STOCK_WEEK_CACHE_UI=null; STOCK_WEEK_TS_UI=0; }


async function tabStockOfWeekScreener() {
  const tc = document.getElementById('tc');
  tc.innerHTML = `<div class="scr-loading">
    <div class="sp"></div>
    <div class="lt">Loading Watchlist…</div>
    <div class="scr-progress">Uses the same scan as Ready. Ready symbols are excluded from Watchlist.</div>
  </div>`;
  try {
    const data = await fetchStockOfWeekCached(false);
    renderStockOfWeekScreener(data, data._localDailyCache || 'server');
  } catch(e) {
    tc.innerHTML = `<div class="eb"><strong>Watchlist error:</strong> ${e.message}<br>
      <button onclick="clearStockOfWeekCache();tabStockOfWeekScreenerFresh()" style="margin-top:8px;padding:6px 14px;background:var(--acc);border:none;border-radius:var(--rs);color:#000;font-weight:700;cursor:pointer">↻ Retry</button></div>`;
  }
}

async function tabStockOfWeekScreenerFresh() {
  const tc = document.getElementById('tc');
  tc.innerHTML = `<div class="scr-loading">
    <div class="sp"></div>
    <div class="lt">Refreshing Watchlist…</div>
    <div class="scr-progress">Forcing fresh one-scan Ready/Watchlist refresh with duplicate removal.</div>
  </div>`;
  try {
    const data = await fetchStockOfWeekCached(true);
    renderStockOfWeekScreener(data, 'server');
  } catch(e) {
    tc.innerHTML = `<div class="eb"><strong>Watchlist refresh error:</strong> ${e.message}<br>
      <button onclick="tabStockOfWeekScreenerFresh()" style="margin-top:8px;padding:6px 14px;background:var(--acc);border:none;border-radius:var(--rs);color:#000;font-weight:700;cursor:pointer">↻ Retry</button></div>`;
  }
}

/* ── PICK LIST: the same scan (READY + Watchlist) sorted into three groups, in this order:
   1. Breakout watch   (Breakout with Volume, Pre-Breakout Watch, Momentum Continuation)
   2. Pullback 20 / 50 (EMA20 Pullback, EMA50 Deep Pullback, Support Bounce)
   3. Near resistance / low R:R (R:R below 1.25 or under 3% room to resistance - whatever the setup)
   Inside a group: READY first, then the scan's rank. No extra server call: it reuses the Watchlist cache. ── */
function pickListGroup(s){
  const setup = String(s.pickedSetup || s.selectedStrategy || '');
  const rr = Number(s.rr), room = Number(s.resistanceRoom);
  if((Number.isFinite(rr) && rr < SWING_MIN_RR) || (Number.isFinite(room) && room < 3)) return 3;
  if(/breakout|momentum/i.test(setup)) return 1;
  if(/pullback|bounce/i.test(setup)) return 2;
  return 3;
}
async function tabPickList(force=false){
  const tc = document.getElementById('tc');
  tc.innerHTML = `${screenerModeSwitch('picklist')}<div class="scr-loading"><div class="sp"></div><div class="lt">Sorting today's scan…</div></div>`;
  try {
    const data = await fetchStockOfWeekCached(force);
    if(CURRENT_SCREENER_MODE !== 'picklist') return;
    renderPickList(data, data._localDailyCache || 'server');
  } catch(e) {
    tc.innerHTML = `${screenerModeSwitch('picklist')}<div class="eb"><strong>Pick List error:</strong> ${escHtml(e.message)}</div>`;
  }
}
function renderPickList(data, source='server'){
  const tc = document.getElementById('tc');
  const seen = new Set(), all = [];
  (data.picks || []).forEach(s => { const k = String(s.sym).toUpperCase(); if(!seen.has(k)){ seen.add(k); all.push({...s, _ready: screenerClientReadyOk(s)}); } });
  (data.watchlist || []).forEach(s => { const k = String(s.sym).toUpperCase(); if(!seen.has(k)){ seen.add(k); all.push({...s, _ready:false}); } });
  const groups = [
    {n:1, title:'1 · Breakout watch', sub:'Buy only on a close above the trigger level with volume.', cls:'bull'},
    {n:2, title:'2 · Pullback to EMA20 / EMA50', sub:'Buy the bounce: a green close at the average on normal volume.', cls:'bull'},
    {n:3, title:'3 · Near resistance / low R:R', sub:'Little room to the next resistance or R:R under 1.25 - wait for a pullback or a breakout first.', cls:'neutral'},
  ];
  const f = v => Number.isFinite(+v) ? fmt(+v) : '--';
  const row = s => {
    const p = s.plan || {};
    const rr = Number(s.rr), room = Number(s.resistanceRoom);
    const why = s._ready ? (s.trigger || 'All checks pass') : (s.watchReason || s.trigger || '');
    return `<div class="pl-row ${s._ready ? 'ready' : ''}" data-sym="NSE:${escHtml(s.sym)}" data-name="${escHtml(s.sym)}" title="Open ${escHtml(s.sym)}">
      <div class="pl-main">
        <div class="pl-sym">${escHtml(s.sym)} <span class="pl-tag ${s._ready ? 'ready' : 'watch'}">${s._ready ? 'READY' : 'WATCH'}</span>${screenerResultsChip(s)}</div>
        <div class="pl-setup">${escHtml(s.pickedSetup || s.selectedStrategy || 'Setup')} · ₹${f(s.price)}${Number.isFinite(+s.weekChg) ? ` · <span style="color:${+s.weekChg >= 0 ? 'var(--bull)' : 'var(--bear)'}">${+s.weekChg >= 0 ? '+' : ''}${s.weekChg}% wk</span>` : ''}${s.sector ? ` · ${escHtml(s.sector)}` : ''}</div>
        <div class="pl-why">${escHtml(String(why).slice(0, 140))}</div>
      </div>
      <div class="pl-levels">
        <div><span>Entry</span><b>${f(p.entry)}</b></div>
        <div><span>SL</span><b style="color:var(--bear)">${f(p.stop)}</b></div>
        <div><span>T1</span><b style="color:var(--bull)">${f(p.target)}</b></div>
        <div><span>R:R</span><b style="color:${rr >= SWING_MIN_RR ? 'var(--bull)' : 'var(--neu)'}">${Number.isFinite(rr) ? rr.toFixed(2) : '--'}</b></div>
        <div><span>Room</span><b style="color:${room >= 3 ? 'var(--tx)' : 'var(--neu)'}">${Number.isFinite(room) ? room.toFixed(1) + '%' : '--'}</b></div>
      </div>
    </div>`;
  };
  const html = groups.map(g => {
    const list = all.filter(s => pickListGroup(s) === g.n).sort((a,b) => (b._ready - a._ready) || ((+b.rankScore || 0) - (+a.rankScore || 0)));
    return `<div class="pl-group ${g.cls}">
      <div class="pl-head"><div><div class="pl-title">${g.title}</div><div class="pl-sub">${g.sub}</div></div><div class="pl-count">${list.length}</div></div>
      ${list.length ? list.map(row).join('') : '<div class="pl-empty">None in today\'s scan.</div>'}
    </div>`;
  }).join('');
  const ts = data.generatedAt ? new Date(data.generatedAt) : null;
  const when = ts ? ts.toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'}) : '--';
  tc.innerHTML = `${screenerModeSwitch('picklist')}${screenerContextHtml(data)}
    <div class="aib" style="font-size:.72rem;margin-bottom:10px">Scan of ${when}${source === 'server' ? '' : ' (saved today - Refresh before trading)'} · ${all.length} stocks · READY first in each group, then the scan rank. Tap a stock for its full Overview.</div>
    ${html}`;
  tc.querySelectorAll('.pl-row[data-sym]').forEach(el => el.addEventListener('click', () => {
    const sym = el.dataset.sym;
    loadInstrument(sym, CLIENT_NAMES[sym.replace('NSE:','')] || el.dataset.name);
  }));
}

/* ── MONTHLY MOMENTUM (separate from the swing screener) ──
   Top 20 of the 100 largest stocks by the NSE-style score, decided on the previous month-end close and held all
   month (server /api/momentum). Backtested 8.8 years: 13.1% a year vs Nifty 9.4% after costs. */
const MOM_CAP_KEY = 'td_mom_capital';
async function tabMomentum(force = false){
  const tc = document.getElementById('tc');
  CURRENT_SCREENER_MODE = 'momentum';
  const live = tcGuard();
  tc.innerHTML = `${screenerModeSwitch('momentum')}<div class="scr-loading"><div class="sp"></div><div class="lt">Ranking the 100 largest stocks…</div><div class="scr-progress">First load after a restart reads ~250 charts (1-2 minutes); then it is cached.</div></div>`;
  let d;
  try { d = await apiFetch('/api/momentum' + (force ? '?refresh=1' : ''), 240000); }
  catch(e){ if(live()) tc.innerHTML = `${screenerModeSwitch('momentum')}<div class="eb">Momentum list error: ${escHtml(e.message)}</div>`; return; }
  if(!live() || CURRENT_SCREENER_MODE !== 'momentum') return;
  MOM_LAST = d;
  renderMomentum(d);
}
let MOM_LAST = null;
function momCapitalChanged(el){ savePosSetting(MOM_CAP_KEY, Number(el.value)); if(MOM_LAST) renderMomentum(MOM_LAST); }
function renderMomentum(d){
  const tc = document.getElementById('tc');
  const cap = readPosSetting(MOM_CAP_KEY, 500000), per = cap / Math.max(1, d.holdings.length);
  const dt = k => k ? new Date(k + 'T00:00:00').toLocaleDateString('en-IN', {day:'2-digit', month:'short', year:'numeric'}) : '--';
  const pct = v => `<span style="color:${v >= 0 ? 'var(--bull)' : 'var(--bear)'}">${v >= 0 ? '+' : ''}${(+v).toFixed(1)}%</span>`;
  const nf = d.niftyFilter || {};
  const filter = nf.aboveSma200 === false
    ? `<div class="mom-filter bear"><b>Nifty is below its 200-day average</b> (${fmt(nf.nifty,0)} vs ${fmt(nf.sma200,0)}). The tested version holds <b>cash</b> this month: that cut the worst fall from -30% to -21% for about 0.5% a year less return.</div>`
    : nf.aboveSma200 === true ? `<div class="mom-filter bull"><b>Nifty is above its 200-day average</b> (${fmt(nf.nifty,0)} vs ${fmt(nf.sma200,0)}) - stay invested in the list.</div>` : '';
  const preview = d.livePreview || [], inNow = new Set(d.holdings.map(h => h.sym));
  const wouldIn = preview.filter(p => !inNow.has(p.sym)).map(p => p.sym), wouldOut = d.holdings.filter(h => !preview.some(p => p.sym === h.sym)).map(h => h.sym);
  const open = s => `onclick="loadInstrument(${jsArg('NSE:' + s)}, ${jsArg(CLIENT_NAMES[s] || s)})"`;
  const rows = d.holdings.map(h => { const qty = h.price > 0 ? Math.floor(per / h.price) : 0; return `<tr class="mom-row" ${open(h.sym)} title="Open ${escHtml(h.sym)}">
      <td>${h.rank}</td><td><b>${escHtml(h.sym)}</b>${h.isNew ? ' <span class="pl-tag ready">New</span>' : ''}<div class="mom-sub">${escHtml(h.sector || '')}</div></td>
      <td>${h.score.toFixed(2)}</td><td>${pct(h.r6)}</td><td>${pct(h.r12)}</td><td>${h.vol.toFixed(0)}%</td>
      <td>₹${fmt(h.price)}</td><td><b>${qty.toLocaleString('en-IN')}</b><div class="mom-sub">${formatINR(qty * h.price)}</div></td>
      <td>${h.liveRank ? '#' + h.liveRank : '--'}</td></tr>`; }).join('');
  tc.innerHTML = `${screenerModeSwitch('momentum')}
    <div class="aib mom-head"><b>List for ${escHtml(d.month)}</b> · ranked on the ${dt(d.listDate)} close · buy / sell on <b>${dt(d.rebalanceDay)}</b> · next rebalance <b>${dt(d.nextRebalance)}</b> · ${d.universe.ranked} largest stocks ranked</div>
    ${filter}
    <div class="mom-changes">
      <div><span class="mom-lbl">Sell (left the top 20)</span>${d.sells.length ? d.sells.map(x => `<span class="mom-chip sell" ${open(x.sym)}>${escHtml(x.sym)}${x.nowRank ? ` #${x.nowRank}` : ''}</span>`).join('') : '<span class="mom-none">none</span>'}</div>
      <div><span class="mom-lbl">Buy (new in the top 20)</span>${d.buys.length ? d.buys.map(s => `<span class="mom-chip buy" ${open(s)}>${escHtml(s)}</span>`).join('') : '<span class="mom-none">none</span>'}</div>
      <div class="mom-cap"><label>Capital ₹<input type="number" min="0" step="10000" value="${cap}" onchange="momCapitalChanged(this)"></label><span>${formatINR(per)} per stock (equal weight, ${d.holdings.length} stocks)</span></div>
    </div>
    <div class="bt-wrap"><table class="bt-table mom-table"><thead><tr><th>#</th><th>Stock</th><th>Score</th><th>6M</th><th>12M</th><th>Volatility</th><th>Price now</th><th>Qty</th><th>Rank today</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="aib" style="font-size:.72rem;margin-bottom:10px"><b>If the month ended today:</b> ${wouldIn.length ? `${escHtml(wouldIn.join(', '))} would enter` : 'no new entries'}${wouldOut.length ? ` · ${escHtml(wouldOut.join(', '))} would leave` : ''}. This is only a preview - trade the list once a month, not on daily rank changes.</div>
    <div class="aib mom-how">
      <b>How it works.</b> On the first trading day of each month: rank the 100 largest stocks by (6-month return + 12-month return) ÷ 2, divided by their 1-year volatility, the way NSE's Nifty200 Momentum 30 does. Hold the top 20 in equal amounts for the month; sell what left the list, buy what joined (usually 5-6 stocks). No stop-loss, no target - the monthly ranking is the exit.
      <br><b>Note:</b> a stock's Overview judges a 1-10 day swing entry, so strong momentum stocks often show "overbought" or "wait" there. For this monthly list, that swing verdict does not apply.
      <br><b>Backtest</b> (Jan 2018 - Oct 2026, 0.25% per swap): <b>13.1% a year vs Nifty 9.4%</b>, worst fall -30% (-21% with the 200-day filter). It wins big in trending years (2021 +64%, 2024 +31%) and lags in choppy ones (behind Nifty in 4 of 9 years, including 2025-26) - expect a bad year now and then.
      <br><b>Tax:</b> most stocks are sold within a year, so gains are short-term (20%). A Nifty200 Momentum 30 index fund / ETF does the same with no tax until you sell. Not investment advice.
    </div>`;
}

/* ── BACKTEST: the screener's READY / Ready-on-limit rules replayed on the last ~15 months (server /api/backtest) ── */
async function tabBacktest(run = false){
  const tc = document.getElementById('tc');
  CURRENT_SCREENER_MODE = 'backtest';
  tc.innerHTML = `${screenerModeSwitch('backtest')}<div class="scr-loading"><div class="sp"></div><div class="lt">${run ? 'Replaying the rules on ~270 stocks (1-2 minutes)…' : 'Loading the last backtest…'}</div></div>`;
  const live = tcGuard();
  let d;
  try { d = await apiFetch('/api/backtest' + (run ? '?refresh=1' : ''), 590000); }
  catch(e){ if(live()) tc.innerHTML = `${screenerModeSwitch('backtest')}<div class="eb">Backtest error: ${escHtml(e.message)}</div>`; return; }
  if(!live() || CURRENT_SCREENER_MODE !== 'backtest') return;
  if(d.none){ tc.innerHTML = `${screenerModeSwitch('backtest')}<div class="scr-empty">No backtest yet. Press <b>Run again</b> - it replays the screener's rules day by day over ~15 months (uses the scan's cached charts).</div>`; return; }
  const col = v => v == null ? 'var(--tx3)' : v > 0.05 ? 'var(--bull)' : v < -0.05 ? 'var(--bear)' : 'var(--neu)';
  const row = (name, s, strong) => `<tr${strong ? ' class="bt-strong"' : ''}><td>${escHtml(name)}</td><td>${s.trades}</td><td>${s.winPct ?? '--'}%</td>
    <td style="color:${col(s.avgR)};font-weight:800">${s.avgR != null ? (s.avgR > 0 ? '+' : '') + s.avgR.toFixed(2) + 'R' : '--'}</td>
    <td style="color:${col(s.totalR)}">${s.totalR > 0 ? '+' : ''}${s.totalR}R</td><td>${s.avgWinR ?? '--'} / ${s.avgLossR ?? '--'}</td>
    <td>${s.byExit.T1} / ${s.byExit.SL} / ${s.byExit.Time}</td><td>${s.avgDays ?? '--'}</td><td>${s.worstLosingStreak}</td></tr>`;
  const verdict = d.all.avgR > 0.1 ? 'The rules made money over this period.'
    : d.all.avgR < -0.05 ? 'The rules as a whole lost money over this period - favour the setups with a positive average R and use smaller size on the rest.'
    : 'The rules were close to break-even over this period.';
  const recent = (d.recent || []).slice(0, 25).map(t => `<tr><td>${escHtml(t.date)}</td><td>${escHtml(t.sym)}</td><td>${escHtml(t.setup)}${t.kind === 'Limit' ? ' (limit)' : ''}</td><td>${fmt(t.entry)}</td><td>${fmt(t.stop)} / ${t.target != null ? fmt(t.target) : '5-day avg'}</td><td>${escHtml(t.how === 'SMA5' ? '5-day avg' : t.how)} ${fmt(t.exit)}</td><td style="color:${col(t.r)};font-weight:800">${t.r > 0 ? '+' : ''}${t.r}R</td></tr>`).join('');
  tc.innerHTML = `${screenerModeSwitch('backtest')}
    <div class="aib" style="font-size:.74rem;margin-bottom:10px"><b>${d.all.trades} trades</b> on ${d.stocks} stocks, signals ${escHtml(d.from || '')} → ${escHtml(d.to || '')} · run ${new Date(d.generatedAt).toLocaleString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'})}. <b>${verdict}</b><br><span style="color:var(--tx3)">${escHtml(d.rules)} Past results only - the universe is today's large caps, so stocks that dropped out of it are missing.</span></div>
    <div class="bt-wrap"><table class="bt-table"><thead><tr><th>Setup</th><th>Trades</th><th>Win</th><th>Avg R</th><th>Total R</th><th>Avg win / loss</th><th>Target / SL / day 10</th><th>Days</th><th>Worst losing run</th></tr></thead><tbody>
      ${row('All signals', d.all, true)}${row('READY', d.ready, true)}${row('Ready on limit', d.limit, true)}${d.quick ? row('Quick bounce (RSI-2)', d.quick, true) : ''}
      ${Object.entries(d.bySetup).map(([k, s]) => row(k, s)).join('')}
    </tbody></table></div>
    <div class="aib" style="font-size:.72rem;margin:10px 0">Avg R = average result per trade in units of the risk taken (+1R = made what was risked). Above 0 means the setup paid over this period; at 40% wins a setup needs its wins to be about 1.5x its losses.</div>
    <div class="bt-wrap"><table class="bt-table"><thead><tr><th>Signal</th><th>Stock</th><th>Setup</th><th>Entry</th><th>SL / T1</th><th>Exit</th><th>Result</th></tr></thead><tbody>${recent}</tbody></table></div>`;
}

/* ── Screener vs Overview: every listed stock checked against its own Overview (bias, setup, R:R, action) ── */
async function checkAllVsOverview(){
  const data = MY_TRADE_CACHE_UI; if(!data) return;
  const box = document.getElementById('scrConsistency'); if(!box) return;
  const live = tcGuard();
  box.innerHTML = 'Waiting for the automatic Overview check to finish…';
  await SCR_VERIFY;   /* probes swap the current stock: never two at once */
  const rows = [...(data.picks || []), ...(data.watchlist || [])];
  let ok = 0, n = 0; const bad = [];
  for(const s of rows){
    if(!live()) return;
    box.innerHTML = `Checking ${n + 1} of ${rows.length} against its Overview…`;
    const sym = 'NSE:' + s.sym; delete OVERVIEW_VERDICT[sym];
    let v = null; try { v = await probeOverviewVerdict(sym, CLIENT_NAMES[s.sym] || s.sym); } catch {}
    if(!v){ await new Promise(r => setTimeout(r, 1500)); try { v = await probeOverviewVerdict(sym, CLIENT_NAMES[s.sym] || s.sym); } catch {} }
    n++;
    const why = [];
    if(!v) why.push('Overview did not load');
    else {
      if(v.bias !== 'Bullish') why.push(`Overview bias ${v.bias}`);
      const noSetup = x => !x || /no active strategy|wait for breakout/i.test(x);   /* the Overview's wording for "no setup" */
      const oSet = noSetup(v.setup) ? '' : v.setup, sSet = s.pickedSetup || '';
      if(oSet !== sSet) why.push(`setup ${oSet || 'none'} vs ${sSet || 'none'}`);
      if(!(Math.abs((+v.rr || 0) - (+s.rr || 0)) < 0.015)) why.push(`R:R ${(+v.rr || 0).toFixed(2)} vs ${(+s.rr || 0).toFixed(2)}`);
      const sReady = String(s.tradeStatus).toUpperCase() === 'READY';
      if(sReady !== (v.action === 'READY')) why.push(`action ${v.action} vs ${s.tradeStatus}`);
      if(s.limitReady && s.limitEntry && !(Math.abs((+v.limit || 0) - +s.limitEntry.price) < 0.06)) why.push(`limit ${v.limit ?? 'none'} vs ${s.limitEntry.price}`);
    }
    if(why.length) bad.push(`<b>${escHtml(s.sym)}</b>: ${escHtml(why.join(', '))}`); else ok++;
  }
  for(const q of (data.quickBounce || [])){
    if(!live()) return;
    box.innerHTML = `Checking quick bounce ${q.sym} against its Overview…`;
    const sym = 'NSE:' + q.sym; delete OVERVIEW_VERDICT[sym];
    let v = null; try { v = await probeOverviewVerdict(sym, CLIENT_NAMES[q.sym] || q.sym); } catch {}
    n++;
    if(!v) bad.push(`<b>${escHtml(q.sym)}</b>: Overview did not load`); else if(!v.quick) bad.push(`<b>${escHtml(q.sym)}</b>: no quick bounce on the Overview`); else ok++;
  }
  box.innerHTML = `<b style="color:${bad.length ? 'var(--bear)' : 'var(--bull)'}">Screener vs Overview: ${ok} of ${n} match</b>${bad.length ? ` · ${bad.join(' · ')}` : ' - same bias, setup, R:R and action on every stock.'}`;
}

/* Market regime + results-calendar status shown above both screener lists. */
function screenerContextHtml(data) {
  const mt = data?.marketTrend || {}, rc = data?.resultsCalendar || {};
  const st = String(mt.status || 'UNKNOWN').toUpperCase();
  const col = st === 'BULL' ? 'var(--bull)' : st === 'CAUTION' ? 'var(--neu)' : st === 'UNKNOWN' ? 'var(--tx3)' : 'var(--bear)';
  if (!mt.status || mt.status === 'NOT_USED') return `<div class="scr-context" style="--ctx:var(--tx3)"><span class="scr-ctx-pill">Market —</span><span class="scr-ctx-text">This cached scan predates the market/results filters. Press Refresh.</span></div>`;
  const lvl = mt.nifty != null && Number.isFinite(+mt.nifty) ? `Nifty ${fmt(mt.nifty,0)} · EMA20 ${fmt(mt.ema20,0)} · EMA50 ${fmt(mt.ema50,0)} · EMA200 ${fmt(mt.ema200,0)}` : 'Nifty levels unavailable';
  const resTxt = rc.ok
    ? `Results check: ${escHtml(rc.source || 'NSE')} · READY blocked by results ${+rc.readyBlockedByResults || 0}`
    : `Results check unavailable${rc.error ? ' (' + escHtml(rc.error) + ')' : ''} — verify result dates manually`;
  const regTxt = (+rc.readyBlockedByRegime || 0) ? ` · READY held back by weak sector and RS ${+rc.readyBlockedByRegime}` : '';
  /* The regime no longer holds longs by itself (strength gate): say so instead of the old "no fresh longs". */
  const note = (mt.allowReady === false ? `${String(mt.note || '').replace(/\s*-\s*(narrow market, )?no fresh (swing )?longs.*$/i, '')} - longs still pass when their sector is up (1M) or they beat Nifty (3M); use smaller size` : (mt.note || ''))
    + (mt.trendUp === false ? ' · Nifty trend filter: no READY until Nifty is above its EMA50 with EMA20 above EMA50' : mt.trendUp === true ? ' · Nifty trend filter passed' : '');
  return `<div class="scr-context" style="--ctx:${col}">
    <span class="scr-ctx-pill">Market ${escHtml(st)}</span>
    <span class="scr-ctx-text">${escHtml(note)}<br><span class="scr-ctx-sub">${lvl} · ${resTxt}${regTxt}</span></span>
  </div>${screenerUniverseHtml(data)}`;
}
/* Where the scanned stocks come from: live NSE list × live market cap, with what changed vs the Excel list. */
function screenerUniverseHtml(data) {
  /* Independent NSE universe (no Excel comparison): how many stocks, where from, when built, next rebuild. */
  const u = data?.universe;
  if (!u) return '';
  if (u.mode !== 'live') return `<div class="scr-universe"><b>Universe:</b> ${escHtml(u.source || '')} — ${escHtml(u.note || '')}</div>`;
  const d = v => v ? new Date(v).toLocaleString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit'}) : '--';
  return `<div class="scr-universe"><b>Universe:</b> ${u.eligible} NSE stocks with live market cap &gt; ₹35,000 Cr · ${escHtml(u.source)} · built ${d(u.generatedAt)} · next rebuild ${d(u.nextRebuildAt)}</div>`;
}

/* Results-date chip on a screener card (blocking window in red, just-reported in grey). */
function screenerResultsChip(s) {
  if (!s?.resultsDate) return '';
  const d = new Date(s.resultsDate + 'T00:00:00').toLocaleDateString('en-IN', {day:'2-digit', month:'short'});
  if (s.resultsBlock) return `<span class="scr-chip scr-chip-bad">📅 Results ${d}${s.resultsDate === istDateKey() ? ' · today' : ` · in ${s.resultsTradingDays} TD`}</span>`;
  if (s.resultsRecent) return `<span class="scr-chip">📅 Results out ${d}</span>`;
  return `<span class="scr-chip">📅 Results ${d}</span>`;
}
function screenerModeSwitch(active='mytrade') {
  /* Four views of the Screener page; the button on the right refreshes the one that is open. */
  const tabs = [['mytrade', 'Swing'], ['momentum', 'Monthly momentum'], ['track', 'Track record'], ['backtest', 'Backtest']];
  const action = active === 'mytrade' ? `<button class="scr-act" onclick="clearMyTradeScreenerCache();tabScreener('mytrade', true)" title="New scan (at most one every 5 minutes)">↻ Refresh</button>`
    : active === 'momentum' ? `<button class="scr-act" onclick="tabScreener('momentum', true)" title="Re-rank with the latest prices">↻ Refresh</button>`
    : active === 'track' ? `<button class="scr-act" onclick="tabScreener('track')">↻ Refresh</button>`
    : `<button class="scr-act" onclick="tabBacktest(true)">↻ Run again</button>`;
  return `<div class="scr-tabs-row scr-tabs-v2">
    ${tabs.map(([id, label]) => `<button class="scr-tab${active === id ? ' active' : ''}" onclick="tabScreener('${id}')">${label}</button>`).join('')}
    ${action}
  </div>`;
}


function renderStockOfWeekScreener(data, source='server') {
  const tc = document.getElementById('tc');
  const readySyms = new Set((data.picks || data.screen1 || []).map(x => String(x.sym || '').toUpperCase()));
  const picks = (data.watchlist || data.screen2 || []).filter(x => !readySyms.has(String(x.sym || '').toUpperCase()));
  const ts = data.generatedAt ? new Date(data.generatedAt) : new Date();
  const cacheLabel = source === 'local' ? 'Daily local cache' : source === 'memory' ? 'Session cache' : 'Fresh server scan';
  const tsStr = ts.toLocaleTimeString('en-IN', {hour:'2-digit', minute:'2-digit'}) + ', ' + ts.toLocaleDateString('en-IN');
  const stratScore = (obj) => Number.isFinite(+obj?.score) ? Math.round(+obj.score) : '-';
  const stratColor = (obj) => {
    const v = +obj?.score;
    return Number.isFinite(v) ? (v >= 70 ? 'var(--bull)' : v >= 55 ? 'var(--neu)' : 'var(--tx3)') : 'var(--tx3)';
  };
  const cards = picks.map((s,i)=>{
    const chgColor = s.weekChg >= 0 ? 'var(--bull)' : 'var(--bear)';
    const sign = s.weekChg >= 0 ? '+' : '';
    const score = Math.round(+s.finalQualification || ((+s.score || 0) * 100));
    const setupTxt = s.setup || 'Base screen match';
    /* Why the stock is on the Watchlist. A stock that passes every stock-level check and is held back only by
       the market filter or a results date used to read "Need Confirmation", which looked like a missing check. */
    const watchOnlySetup = SwingPlan.WATCH_ONLY.has(s.pickedSetup || '');
    const status = s.readyCore && s.regimeBlock ? {t:'Stock ready · waiting for market', c:'var(--acc)',
        why:'Passes every stock check. Becomes READY when the market filter allows fresh longs (Nifty above EMA50 with breadth 40%+, or a broad recovery).'}
      : s.readyCore && s.resultsBlock ? {t:'Stock ready · results soon', c:'var(--acc)', why: s.watchReason || 'Passes every stock check; results are within 5 trading days.'}
      : /ranked below the top 10/i.test(s.watchReason || '') ? {t:'READY · ranked below top 10', c:'var(--bull)', why:'Passes every check, including the market filter; only the top 10 are listed as Screener Match.'}
      : watchOnlySetup ? {t:`Alert only · ${s.pickedSetup}`, c:'var(--neu)', why: s.watchReason || 'Watch-only setup: wait for a breakout close or a pullback setup.'}
      : {t:`Needs confirmation · ${setupTxt}`, c:'var(--neu)', why: s.watchReason || 'Near-ready, not trade-ready yet'};
    const alertTxt = status.why;
    const alertColor = status.c;
    const ss = s.strategyScores || {};
    return `<div class="scr-card" data-sym="NSE:${s.sym}" data-name="${s.sym}" title="Click to analyse ${s.sym}">
      <div class="scr-rank">#${i+1}</div>
      <div class="scr-top">
        <div class="scr-title-wrap">
          <div class="scr-sym"><span class="scr-sym-text">${s.sym}</span></div>
          <div class="scr-pattern" style="color:${status.c}">${escHtml(status.t)}</div>${screenerResultsChip(s)}
        </div>
        <div class="scr-price-wrap">
          <div class="scr-price">₹${fmt(s.price)}</div>
          <div class="scr-chg" style="color:${chgColor}">${sign}${s.weekChg}% week</div>
        </div>
      </div>
      <div style="margin-top:8px;padding:6px 9px;border:1px solid var(--brdl);border-radius:var(--rs);background:rgba(255,255,255,.03);font-size:.74rem;font-weight:900;color:${alertColor}" title="${s.alertReason || 'Same eligible large-cap scan, but Ready conditions have not fully passed yet'}">Why on Watchlist: ${escHtml(alertTxt)}</div>
      ${screenerCardGateHtml(s)}
      ${screenerTriggerHtml(s)}
      <div class="scr-metrics">
        <div class="scr-met"><div class="scr-ml">Score</div><div class="scr-mv" title="Server shortlist score uses neutral market/event credit; open full analysis for live /100 score" style="color:${score>=70?'var(--bull)':score>=55?'var(--neu)':'var(--bear)'}">${score}%</div></div>
        <div class="scr-met" title="Current price must be equal to or above EMA20"><div class="scr-ml">EMA20</div><div class="scr-mv" style="color:${+s.price>=+s.e20?'var(--bull)':'var(--bear)'}">₹${fmt(s.e20)}</div></div>
        <div class="scr-met" title="Current price vs EMA50"><div class="scr-ml">EMA50</div><div class="scr-mv" style="color:${+s.price>=+s.e50?'var(--bull)':'var(--bear)'}">₹${fmt(s.e50)}</div></div>
        <div class="scr-met" title="EMA20 Pullback score"><div class="scr-ml">EMA20 PB</div><div class="scr-mv" style="color:${stratColor(ss.emaPullback)}">${stratScore(ss.emaPullback)}</div></div>
        <div class="scr-met" title="EMA50 Deep Pullback score"><div class="scr-ml">EMA50 PB</div><div class="scr-mv" style="color:${stratColor(ss.ema50DeepPullback)}">${stratScore(ss.ema50DeepPullback)}</div></div>
        <div class="scr-met" title="Support / Resistance Bounce score"><div class="scr-ml">S/R Bounce</div><div class="scr-mv" style="color:${stratColor(ss.supportBounce)}">${stratScore(ss.supportBounce)}</div></div>
      </div>

    </div>`;
  }).join('');
  tc.innerHTML = `${screenerModeSwitch('stockweek')}
    ${screenerContextHtml(data)}
    ${cards ? `<div class="scr-grid">${cards}</div>` : '<div class="scr-empty">No Watchlist confirmation stocks today.</div>'}`;
  tc.querySelectorAll('.scr-card[data-sym]').forEach(el=>{
    el.addEventListener('click',()=>loadInstrument(el.dataset.sym, CLIENT_NAMES[el.dataset.sym.replace('NSE:','')] || el.dataset.name || el.dataset.sym.replace('NSE:','')));
  });
}

/* ══════════════════════════════════════════════════════════════════
   SECTOR HEATMAP TAB
══════════════════════════════════════════════════════════════════ */
async function tabSectors() {
  const tc = document.getElementById('tc');
  tc.innerHTML = '<div class="ls" style="display:flex;min-height:100px"><div class="sp"></div><div class="lt">Loading sector performance…</div></div>';
  try {
    const live = tcGuard();
    const sectors = await ensureSectorData();
    if(!live()) return;
    const d = { sectors, updatedAt: GLOBAL_DATA?.sectorUpdatedAt || new Date().toISOString() };
    if (!sectors.length) { tc.innerHTML = '<div class="eb">Sector data unavailable</div>'; return; }

    /* Only sectors with a real % change can be ranked (N/A ones used to crash this view on .toFixed). */
    const ranked = sectors.filter(s => Number.isFinite(+s.pct)).sort((a,b) => +b.pct - +a.pct);
    const na = sectors.filter(s => !Number.isFinite(+s.pct)).concat(GLOBAL_DATA?.sectorsNoData || []);
    if (!ranked.length) { tc.innerHTML = '<div class="eb">Sector data unavailable right now — try again in a minute.</div>'; return; }
    const best = ranked[0], worst = ranked[ranked.length-1];
    const pctTxt = v => `${+v >= 0 ? '+' : ''}${(+v).toFixed(2)}%`;
    const isStock = /^NSE:/.test(String(CUR_SYM||'')) && !isIndexSymbol(CUR_SYM);
    const selected = isStock ? getSectorBiasSnapshotFromList(CUR_SYM, sectors) : null;
    const selectedCol = !selected ? 'var(--tx3)' : selected.cls === 'bull' ? 'var(--bull)' : selected.cls === 'bear' ? 'var(--bear)' : 'var(--neu)';
    const selectedPct = !selected || selected.pct == null ? '--' : pctTxt(selected.pct);
    const keys = selected ? new Set(sectorKeysForSymbol(CUR_SYM, selected.sector)) : new Set();
    const maxAbs = Math.max(...ranked.map(s => Math.abs(+s.pct)), 0.5);
    const nifty = ranked.find(s => s.key === 'nifty50');
    const rows = ranked.map((s, i) => {
      const up = +s.pct >= 0, w = Math.round(Math.abs(+s.pct) / maxAbs * 100);
      const vsNifty = nifty && s.key !== 'nifty50' ? +s.pct - +nifty.pct : null;
      return `<div class="sec-row${keys.has(s.key) ? ' sec-mine' : ''}">
        <span class="sec-rank">${i+1}</span>
        <span class="sec-name">${escHtml(s.label)}</span>
        <span class="sec-bar"><span style="width:${w}%;background:${up ? 'var(--bull)' : 'var(--bear)'}"></span></span>
        <span class="sec-pct" style="color:${up ? 'var(--bull)' : 'var(--bear)'}">${pctTxt(s.pct)}</span>
        <span class="sec-vs">${vsNifty == null ? '' : `${vsNifty >= 0 ? '+' : ''}${vsNifty.toFixed(2)} vs Nifty`}</span>
      </div>`;
    }).join('');
    tc.innerHTML = `<div data-sectors-page></div>
      ${secT('Sector Snapshot — NSE Indices')}
      <div class="tc2">
        <div class="strat-cell"><div class="strat-label">Top Sector</div><div class="strat-val" style="color:var(--bull)">${escHtml(best.label)} ${pctTxt(best.pct)}</div><div class="scn">Strongest sector index today</div></div>
        <div class="strat-cell"><div class="strat-label">Worst Sector</div><div class="strat-val" style="color:var(--bear)">${escHtml(worst.label)} ${pctTxt(worst.pct)}</div><div class="scn">Weakest sector index today</div></div>
      </div>
      <div class="strat-cell" style="margin-bottom:14px;border-left:3px solid ${selectedCol}">
        <div class="strat-label">Selected Stock Sector</div>
        ${selected ? `<div class="strat-val" style="color:${selectedCol}">${escHtml(selected.sector)}: ${escHtml(selected.label)} ${selectedPct}</div>
        <div class="scn">${escHtml(selected.note)}${selected.source ? ` · ${escHtml(selected.source)}` : ''} · classification: NSE industry</div>`
        : `<div class="strat-val" style="color:var(--tx3)">Open a stock to see its sector</div>`}
      </div>
      ${secT('All sectors today (ranked)')}
      <div class="sec-list">${rows}</div>
      ${na.filter(s => s.pending).length ? `<div class="aib" style="font-size:.7rem;margin-top:8px">Still loading (updates automatically): ${na.filter(s => s.pending).map(s => escHtml(s.label)).join(', ')}</div>` : ''}
      ${na.filter(s => !s.pending).length ? `<div class="aib" style="font-size:.7rem;margin-top:8px">No live data: ${na.filter(s => !s.pending).map(s => escHtml(s.label)).join(', ')}</div>` : ''}
      <div class="aib" style="font-size:.72rem;margin-top:8px">NSE sector indices via Yahoo · Updated ${timeAgo(d.updatedAt)} · highlighted row = your stock's sector.</div>
      <style>
        .sec-list{display:flex;flex-direction:column;gap:4px}
        .sec-row{display:grid;grid-template-columns:22px minmax(120px,1.4fr) minmax(60px,2fr) 70px 110px;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--brd);border-radius:8px;background:var(--bgc);font-size:.76rem}
        .sec-row.sec-mine{border-color:var(--acc);box-shadow:inset 3px 0 0 var(--acc)}
        .sec-rank{color:var(--tx3);font-weight:800;text-align:right}
        .sec-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .sec-bar{height:6px;background:rgba(148,163,184,.12);border-radius:4px;overflow:hidden}
        .sec-bar span{display:block;height:100%;border-radius:4px}
        .sec-pct{font-weight:800;text-align:right;font-variant-numeric:tabular-nums}
        .sec-vs{font-size:.66rem;color:var(--tx3);text-align:right}
        @media(max-width:520px){ .sec-row{grid-template-columns:18px minmax(90px,1.4fr) minmax(40px,1fr) 60px} .sec-vs{display:none} }
      </style>`;
  } catch(e) { tc.innerHTML = `<div class="eb">Sector error: ${escHtml(e.message)}</div>`; }
}

/* ══════════════════════════════════════════════════════════════════
   ECONOMIC CALENDAR TAB
══════════════════════════════════════════════════════════════════ */
async function tabCalendar() {
  const tc = document.getElementById('tc');
  tc.innerHTML = '<div class="ls" style="display:flex;min-height:80px"><div class="sp"></div></div>';
  try {
    const live = tcGuard();
    const d = await apiFetch('/api/calendar');
    if(!live()) return;
    const upcoming = d.upcoming || [];
    const today = istDateKey(); /* IST date, not UTC */

    function calBadgeClass(cat) {
      /* Missing category used to throw and blank the whole calendar. */
      return `cal-badge cal-${String(cat || 'other').toLowerCase().replace(/[^a-z0-9-]/g,'')}`;
    }
    function impactBadge(impact) {
      return `<span style="font-size:.75rem;padding:1px 6px;border-radius:20px;font-weight:800;background:${impact==='HIGH'?'var(--bearb)':'var(--neub)'};color:${impact==='HIGH'?'var(--bear)':'var(--neu)'}">${impact}</span>`;
    }
    function daysLabel(dateStr) {
      const diff = Math.ceil((new Date(dateStr)-new Date(today))/86400000);
      if (diff === 0) return '<span class="cal-days" style="color:var(--bear);font-weight:800">TODAY</span>';
      if (diff === 1) return '<span class="cal-days" style="color:var(--bear)">Tomorrow</span>';
      if (diff <= 7)  return `<span class="cal-days" style="color:var(--neu)">In ${diff} days</span>`;
      return `<span class="cal-days">In ${diff} days</span>`;
    }

    const eventHtml = upcoming.map(e => `
      <div class="cal-event ${e.impact==='HIGH'?'cal-high':'cal-med'}">
        <div class="cal-date">${escHtml(String(e.date||'').slice(5))}<br><span style="font-size:.72rem;color:var(--tx3)">${escHtml(String(e.date||'').slice(0,4))}</span></div>
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap">
            <span class="${calBadgeClass(e.category)}">${escHtml(e.category || 'Other')}</span>
            <span style="font-size:.8rem;font-weight:700;color:var(--tx)">${escHtml(e.event)}</span>
            ${impactBadge(e.impact)}
            <span style="font-size:.75rem;color:var(--tx3)">${e.country==='IN'?'🇮🇳':'🇺🇸'}</span>
          </div>
          <div style="font-size:.72rem;color:var(--tx2);line-height:1.4">${escHtml(e.desc || '')}</div>
        </div>
        <div>${daysLabel(e.date)}</div>
      </div>`).join('');

    tc.innerHTML = `
      ${d.next ? `<div style="background:var(--bearb);border:1px solid var(--bear);border-radius:var(--rs);padding:10px 14px;margin-bottom:14px;font-size:.82rem">
        <strong style="color:var(--bear)">Next event:</strong> <strong>${escHtml(d.next.event)}</strong> — ${d.daysUntil===0?'<strong style="color:var(--bear)">TODAY</strong>':`in ${d.daysUntil} day${d.daysUntil===1?'':'s'}`} (${escHtml(d.next.date)})
      </div>` : ''}
      ${d.staleNote ? `<div class="aib" style="margin-bottom:10px;font-size:.72rem;color:var(--warn)">⚠️ ${escHtml(d.staleNote)}</div>` : ''}
      <div class="aib" style="margin-bottom:10px;font-size:.72rem">📌 Calendar status: ${String(d.source||'').startsWith('manual')?'Manual/static list':'Loaded'} · Last updated: ${d.updatedAt?new Date(d.updatedAt).toLocaleString(): '--'} · Checked: ${d.checkedAt?new Date(d.checkedAt).toLocaleString(): '--'}</div>
      ${secT('Upcoming Market Events')}
      ${eventHtml || '<div class="scr-empty">No upcoming events</div>'}
      <div class="aib" style="font-size:.72rem;margin-top:10px">⚠️ Avoid holding naked options or large intraday positions around HIGH impact events. Dates are approximate — verify on RBI / NSE websites before trading.</div>`;
  } catch(e) { tc.innerHTML = `<div class="eb">Calendar error: ${escHtml(e.message)}</div>`; }
}

/* ══════════════════════════════════════════════════════════════════
   EARNINGS TAB REMOVED
══════════════════════════════════════════════════════════════════ */
async function tabEarnings() {
  const tc = document.getElementById('tc');
  tc.innerHTML = `<div class="aib"><strong>📌 Earnings/result tab removed.</strong><br>Result dates are not auto-verified in this app. Check NSE/BSE/company announcements manually before every stock trade.</div>`;
}

async function checkEarningsWarning(sym) {
  /* Disabled by request: no manual/static earnings alert is shown. */
}

/* ── SHOW GLOBAL TAB (no instrument needed) ── */
async function showGlobalTab(tab) {
  const live = tcBeginRender();
  document.body.classList.remove('crypto-mode');
  document.body.classList.add('market-mode');
  const tc = document.getElementById('tc');
  show('es','none'); show('ls','none'); show('ih','none'); show('tc','flex'); show('tbar','none');
  document.querySelectorAll('.tbt').forEach(b => {
    b.style.display = 'none';
    b.classList.toggle('active', false);
  });
  tc.innerHTML = '<div class="ls" style="display:flex;min-height:100px"><div class="sp"></div></div>';
  try {
    if(tab==='sectors')    { preloadMarketContext().catch(()=>{}); await tabSectors();    return; }
    if(tab==='calendar')   { await tabCalendar();   return; }
    if(tab==='earnings')   { await tabEarnings();   return; }
    if(tab==='alerts')     { tc.innerHTML=tabAlerts(); return; }
    if(tab==='screener')   { await tabScreener();   return; }
    if(tab==='marketinfo') { await preloadMarketContext(); if(!live()) return; await tabMarketInfo(); return; }
  } catch(e) { if(live()) tc.innerHTML = `<div class="eb">Error: ${escHtml(e.message)}</div>`; }
}


/* Shared S&R trade-level engine — one source for Overview targets/SL and S&R tab values */
function firstFiniteNumber(...vals){
  for(const v of vals){ const n=Number(v); if(Number.isFinite(n) && n>0) return n; }
  return null;
}
function getCurrentLivePrice(){
  const d = CUR_DATA || {}, C = d.daily?.C || [];
  return firstFiniteNumber(d.price, d.livePrice, C[C.length-1]) || 0;
}
function approxSame(a,b,pctTol=0.0005){
  a=Number(a); b=Number(b);
  if(!Number.isFinite(a) || !Number.isFinite(b) || b===0) return false;
  return Math.abs(a-b)/Math.abs(b) <= pctTol;
}
function marketDateKeyFromTs(ts, tz='Asia/Kolkata'){
  const n = Number(ts);
  if(!Number.isFinite(n) || n <= 0) return '';
  try{
    return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(n*1000));
  }catch{
    return new Date(n*1000).toISOString().slice(0,10);
  }
}
function marketDateKeyFromIso(iso, tz='Asia/Kolkata'){
  const t = Date.parse(iso || '');
  if(!Number.isFinite(t)) return '';
  try{
    return new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(t));
  }catch{
    return new Date(t).toISOString().slice(0,10);
  }
}
function lastFiniteTimestamp(arr){
  if(!Array.isArray(arr)) return null;
  for(let i=arr.length-1;i>=0;i--){
    const n=Number(arr[i]);
    if(Number.isFinite(n) && n>0) return n;
  }
  return null;
}
function marketLocalTimeInfo(iso, tz='Asia/Kolkata'){
  const t = Date.parse(iso || '');
  if(!Number.isFinite(t)) return null;
  try{
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{
      timeZone:tz,weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false
    }).formatToParts(new Date(t)).map(p=>[p.type,p.value]));
    return {weekday:parts.weekday, minutes:Number(parts.hour)*60 + Number(parts.minute)};
  }catch{ return null; }
}
function isLikelyActiveCashMarketSession(iso, tz='Asia/Kolkata'){
  const x = marketLocalTimeInfo(iso, tz);
  if(!x || !Number.isFinite(x.minutes)) return false;
  if(['Sat','Sun'].includes(x.weekday)) return false;
  return x.minutes >= 9*60 && x.minutes <= (15*60 + 45);
}
/* NSE intraday volume is U-shaped (heavy at open and close). Cumulative share of a normal day's
   volume by minutes since 09:15 IST. Used to project today's partial volume to a full-day figure so it
   can be compared with completed-day averages. Approximation; outside the session share = 1. */
const NSE_VOL_CURVE=[[0,0],[15,.08],[30,.14],[60,.22],[120,.35],[180,.47],[240,.58],[300,.70],[345,.80],[360,.86],[375,1]];
function istDateKey(d=new Date()){ return new Date(d.getTime()+330*60000).toISOString().slice(0,10); }
function nseSessionShare(now=new Date()){
  const ist=new Date(now.getTime()+330*60000), dow=ist.getUTCDay();
  if(dow===0||dow===6) return 1;
  const m=ist.getUTCHours()*60+ist.getUTCMinutes()+ist.getUTCSeconds()/60-555;
  if(m<=0||m>=375) return 1;
  for(let i=1;i<NSE_VOL_CURVE.length;i++){
    const [m1,s1]=NSE_VOL_CURVE[i], [m0,s0]=NSE_VOL_CURVE[i-1];
    if(m<=m1) return Math.max(.08, s0+(s1-s0)*(m-m0)/(m1-m0));
  }
  return 1;
}
function projectedTodayVolume(rawVol, now=new Date()){
  const v=Number(rawVol)||0, s=nseSessionShare(now);
  return s>=1 ? Math.round(v) : Math.round(v/s);
}
function approxSamePrice(a,b,pct=0.002){
  const x=Number(a), y=Number(b);
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<=0||y<=0) return false;
  return Math.abs(x-y) <= Math.max(0.05, Math.max(x,y)*pct);
}
function getCompletedDailyHistory(){
  const live = CUR_DATA || {}, hist = live._dailyHistory || live.daily || {};
  const C = (hist.C||[]).map(Number), H = (hist.H||[]).map(Number), L = (hist.L||[]).map(Number), O = (hist.O||[]).map(Number), T = (hist.T||[]).map(Number);
  const last = C.length - 1;
  if(last < 0) return {C,H,L,O,T,todayIdx:0,prevIdx:0,lastWasCurrentSession:false};

  /* Robust previous-session selection.
     Yahoo daily history may lag intraday and its last candle can be the previous completed
     session. In that case the client appends a live candle and stores _prevSessionIdx.
     Never blindly use n-2; that was showing Friday/older candle as "previous day". */
  let prevIdx = Number.isInteger(live._prevSessionIdx) ? live._prevSessionIdx : null;
  if(prevIdx == null || prevIdx < 0 || prevIdx > last){
    const pc = Number(live.pc);
    if(Number.isFinite(pc) && pc>0){
      for(let j=last;j>=0;j--){
        if(approxSamePrice(C[j], pc)){ prevIdx=j; break; }
      }
    }
  }
  if(prevIdx == null || prevIdx < 0 || prevIdx > last) prevIdx = last >= 1 ? last - 1 : last;
  const todayIdx = Number.isInteger(live._liveSessionIdx) ? live._liveSessionIdx : (live.daily?.C?.length ? live.daily.C.length-1 : last);
  return {C,H,L,O,T,todayIdx,prevIdx,lastWasCurrentSession:prevIdx<last};
}
function hi(arr){ const v=arr.filter(Number.isFinite); return v.length ? Math.max(...v) : null; }
function lo(arr){ const v=arr.filter(Number.isFinite); return v.length ? Math.min(...v) : null; }
function getSRTradeLevels(){
  const liveDaily = CUR_DATA.daily || {}, liveC = liveDaily.C || [], liveH = liveDaily.H || [], liveL = liveDaily.L || [];
  const price=getCurrentLivePrice();
  const hist=getCompletedDailyHistory(), C=hist.C, H=hist.H, L=hist.L, i=hist.prevIdx;

  const ph=firstFiniteNumber(H[i], CUR_DATA.prevDayHigh, liveDaily.H?.[liveDaily.H.length-2], price);
  const pl=firstFiniteNumber(L[i], CUR_DATA.prevDayLow,  liveDaily.L?.[liveDaily.L.length-2], price);
  const pc=firstFiniteNumber(C[i], CUR_DATA.prevDayClose, CUR_DATA.pc, liveDaily.C?.[liveDaily.C.length-2], price);
  const pp=R2((ph+pl+pc)/3);

  /* Shared engine: identical levels to the screener (public/swing-plan.js). */
  const lv = SwingPlan.srLevels({ H, L, C, i, price, ph, pl, pc });
  if(lv.yw_high == null) lv.yw_high = R2(hi(liveH.slice(-252)));
  if(lv.yw_low == null) lv.yw_low = R2(lo(liveL.slice(-252)));
  return lv;
}

function buildWhatsAppTradePlanUrl(payload){
  const text = [
    `Stock name : ${payload.stockName || payload.symbol}`,
    `Entry : ${payload.entry1 || payload.entry || '--'}`,
    `Target : ${payload.t1 || '--'}`,
    `Stoploss : ${payload.stopLoss || '--'}`
  ].join('\n');
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

function formatINR(n){
  return !Number.isFinite(+n) ? '--' : '₹' + (+n).toLocaleString('en-IN',{maximumFractionDigits:0});
}
/* Position sizing + estimated NSE delivery-equity charges.
   Qty is risk-based: the smaller of (capital ÷ price) and (capital × risk% ÷ stop distance).
   Charges are ESTIMATES: STT 0.1% buy+sell, stamp 0.015% buy, NSE txn 0.00297% both sides,
   SEBI ₹10/crore both sides, GST 18% on brokerage+txn+SEBI, DP ₹15.93 per sell, brokerage ₹0. */
const POS_CAPITAL_KEY = 'td_pos_capital', POS_RISK_KEY = 'td_pos_risk_pct';
function readPosSetting(key, dflt){ try{ const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : dflt; }catch{ return dflt; } }
function savePosSetting(key, v){ try{ if(Number.isFinite(v) && v > 0) localStorage.setItem(key, String(v)); }catch{} }
function estimateDeliveryCharges(buyValue, sellValue, brokerage=0){
  const buy = Math.max(0, +buyValue || 0), sell = Math.max(0, +sellValue || 0), turnover = buy + sell;
  if(!turnover) return 0;
  const stt = 0.001 * turnover, stamp = 0.00015 * buy, txn = 0.0000297 * turnover, sebi = turnover * 10 / 1e7;
  const gst = 0.18 * (brokerage + txn + sebi), dp = sell > 0 ? 15.93 : 0;
  return stt + stamp + txn + sebi + gst + brokerage + dp;
}
function computePositionPlan({bias, price, target, stop, capital, riskPct}){
  const directional = bias === 'Bullish' || bias === 'Bearish';
  const dataValid = directional && Number.isFinite(price) && price > 0 && Number.isFinite(target) && target > 0 && Number.isFinite(stop) && stop > 0;
  const rewardPerShare = bias === 'Bearish' ? price - target : target - price;
  const riskPerShare = bias === 'Bearish' ? stop - price : price - stop;
  const validPlan = dataValid && rewardPerShare > 0 && riskPerShare > 0;
  const qtyCap = dataValid ? Math.floor(capital / price) : 0;
  /* Size so that stop distance + estimated round-trip charges stays within the Risk % budget. */
  const legs1 = bias === 'Bearish' ? [stop, price] : [price, stop];
  const dpFixed = 15.93, varChargePerShare = Math.max(0, estimateDeliveryCharges(...legs1) - dpFixed);
  const riskBudget = capital * riskPct / 100 - dpFixed;
  const qtyRisk = validPlan ? Math.max(0, Math.floor(riskBudget / (riskPerShare + varChargePerShare))) : qtyCap;
  const qty = Math.max(0, Math.min(qtyCap, qtyRisk));
  /* Long: buy at price, sell at target/stop. Bearish: sell at price, buy back at target/stop (same charge model). */
  const legs = exit => bias === 'Bearish' ? [qty*exit, qty*price] : [qty*price, qty*exit];
  const chgT = validPlan && qty ? estimateDeliveryCharges(...legs(target)) : 0;
  const chgS = validPlan && qty ? estimateDeliveryCharges(...legs(stop)) : 0;
  const gain = validPlan ? qty * rewardPerShare - chgT : 0;
  const loss = validPlan ? qty * riskPerShare + chgS : 0;
  const rr = validPlan && loss > 0 && gain > 0 ? (gain / loss).toFixed(2) + ':1' : 'Wait';
  return {validPlan, qty, gain, loss, rr, charges:chgT, limitedByRisk: validPlan && qtyRisk < qtyCap};
}
function updatePositionCalc(id){
  const root = document.getElementById(id);
  if(!root) return;
  const capital = Math.max(0, Number(String(root.querySelector('[data-pos-capital]')?.value || '').replace(/,/g,'')) || 0);
  const riskPct = Math.max(0, Number(root.querySelector('[data-pos-risk]')?.value) || 0);
  savePosSetting(POS_CAPITAL_KEY, capital); savePosSetting(POS_RISK_KEY, riskPct);
  const r = computePositionPlan({bias:root.dataset.bias || 'Sideways', price:Number(root.dataset.price), target:Number(root.dataset.target), stop:Number(root.dataset.stop), capital, riskPct});
  const setText = (sel, val) => { const el = root.querySelector(sel); if(el) el.textContent = val; };
  setText('[data-pos-qty]', r.qty.toLocaleString('en-IN'));
  setText('[data-pos-qty-sub]', posQtySub(r, riskPct, Number(root.dataset.price)));
  setText('[data-pos-capfmt]', formatINR(capital));
  setText('[data-pos-limit]', posLimitSub(capital, riskPct));
  setText('[data-pos-gain]', r.validPlan ? formatINR(r.gain) : '—');
  setText('[data-pos-loss]', r.validPlan ? formatINR(r.loss) : '—');
  setText('[data-pos-chg]', r.validPlan ? formatINR(r.charges) : '—');
  setText('[data-pos-rr]', r.rr);
}
function posQtySub(r, riskPct, price){
  const used = r.qty * (+price || 0);
  return `${r.limitedByRisk ? `Limited by ${riskPct}% risk` : 'Capital ÷ entry price'}${used > 0 ? ` · buys ${formatINR(used)}` : ''}`;
}
function posLimitSub(capital, riskPct){ return `Max loss allowed ${formatINR(capital * riskPct / 100)} (${riskPct}% of ${formatINR(capital)})`; }
function buildPositionSizeCalc({id, bias, price, target1, stopLoss, targetLabel='Target', note=''}){
  const safeId = String(id || 'poscalc').replace(/[^A-Za-z0-9_-]/g,'_');
  const p = Number(price), t = Number(target1), s = Number(stopLoss);
  /* Capital and risk % persist, so the 60s auto-refresh re-render keeps what the user typed. */
  const capital = readPosSetting(POS_CAPITAL_KEY, 10000), riskPct = readPosSetting(POS_RISK_KEY, 1);
  const r = computePositionPlan({bias, price:p, target:t, stop:s, capital, riskPct});
  const tgtLabel = escHtml(String(targetLabel || 'Target'));
  const helper = r.validPlan ? (note || 'Uses current price, active target and Stop Loss from this trade plan. P&amp;L is net of estimated delivery charges.') : 'No valid directional trade plan yet — calculator stays in Wait mode.';
  const safeBias = ['Bullish','Bearish'].includes(bias) ? bias : 'Sideways';
  return `<div class="pos-calc" id="${safeId}" data-bias="${safeBias}" data-price="${Number.isFinite(p)?p:0}" data-target="${Number.isFinite(t)?t:0}" data-stop="${Number.isFinite(s)?s:0}">
    <div class="pos-head">
      <div><div class="pos-title">Position Size Calculator</div><div class="pos-sub">${helper}</div></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="pos-cap"><span>Capital <b data-pos-capfmt style="color:var(--tx)">${formatINR(capital)}</b></span><input data-pos-capital type="number" min="0" step="500" value="${capital}" oninput="updatePositionCalc('${safeId}')"></label>
        <label class="pos-cap"><span>Risk %</span><input data-pos-risk type="number" min="0.1" max="100" step="0.25" value="${riskPct}" style="width:70px" oninput="updatePositionCalc('${safeId}')"></label>
      </div>
    </div>
    <div class="pos-grid">
      <div class="pos-item"><div class="pos-label">Approx Qty</div><div class="pos-val" data-pos-qty>${r.qty.toLocaleString('en-IN')}</div><div class="pos-sub" data-pos-qty-sub>${posQtySub(r, riskPct, p)}</div></div>
      <div class="pos-item"><div class="pos-label">Net Gain @ ${tgtLabel}</div><div class="pos-val" style="color:var(--bull)" data-pos-gain>${r.validPlan ? formatINR(r.gain) : '—'}</div><div class="pos-sub">After est. charges <span data-pos-chg>${r.validPlan ? formatINR(r.charges) : '—'}</span></div></div>
      <div class="pos-item"><div class="pos-label">Net Loss @ Stop Loss</div><div class="pos-val" style="color:var(--bear)" data-pos-loss>${r.validPlan ? formatINR(r.loss) : '—'}</div><div class="pos-sub" data-pos-limit>${posLimitSub(capital, riskPct)}</div></div>
      <div class="pos-item"><div class="pos-label">Risk–Reward</div><div class="pos-val" style="color:var(--acc)" data-pos-rr>${r.rr}</div><div class="pos-sub">Net of estimated charges</div></div>
    </div>
  </div>`;
}
function getVolumePressureSnapshot(sym){
  const d = CUR_DATA?.daily || {};
  const C = d.C || [], V = d.V || [];
  const n = C.length;
  if(!n || !V.length) return {label:'NO DATA', cls:'neutral', ratio:null, note:'Volume data not available for this instrument.'};
  const volEnd = Math.max(0, Math.min(V.length, n) - 1);
  const volBase20 = V.slice(Math.max(0, volEnd - 20), volEnd);
  const avgVol = volBase20.reduce((a,b)=>a+(Number(b)||0),0) / Math.max(1, volBase20.length);
  const volToday = Number(V[n-1]) || 0;
  const ratio = avgVol ? volToday / avgVol : 1;
  const price = Number(C[n-1]) || 0;
  const prev = Number(C[n-2]) || price;
  const dayMove = price - prev;
  const dayPct = prev ? (dayMove / prev) * 100 : 0;
  /* A tiny move on average volume is not "active" buying/selling: need at least a 0.3% day move. */
  const dir = dayPct >= 0.3 ? 'buying' : dayPct <= -0.3 ? 'selling' : 'neutral';

  let label = 'Normal Volume', cls = 'neutral';
  if(ratio >= 1.4 && dir === 'buying') { label = 'High Buying Volume'; cls = 'bull'; }
  else if(ratio >= 1.4 && dir === 'selling') { label = 'High Selling Volume'; cls = 'bear'; }
  else if(ratio >= 1.4) { label = 'High Neutral Volume'; cls = 'neutral'; }
  else if(ratio >= 1.0 && dir === 'buying') { label = 'Active Buying Volume'; cls = 'bull'; }
  else if(ratio >= 1.0 && dir === 'selling') { label = 'Active Selling Volume'; cls = 'bear'; }
  else if(ratio < 0.75) { label = 'Low Volume'; cls = 'neutral'; }

  const note = `${ratio.toFixed(2)}x of 20D average · Today ${dayPct>=0?'+':''}${dayPct.toFixed(2)}%`;
  return {label, cls, ratio, note, dayPct};
}

function getPriceLocationSnapshot(srLevels){
  const s = srLevels || getSRTradeLevels();
  const price = Number(s.price);
  const pp = Number(s.pp);
  const nearestSupport = s.nearestSupport;
  const nearestResistance = s.nearestResistance;
  if(!Number.isFinite(price)) return {label:'NO DATA', cls:'neutral', note:'Price location unavailable.'};

  const pctDist = (level) => Number.isFinite(Number(level)) && price ? Math.abs(price-Number(level))/price*100 : Infinity;
  const supportDist = pctDist(nearestSupport?.v);
  const resistanceDist = pctDist(nearestResistance?.v);
  const pivotDist = pctDist(pp);
  const nearBand = 0.75;

  const pivotText = Number.isFinite(pp)
    ? (price > pp ? 'Above Pivot' : price < pp ? 'Below Pivot' : 'At Pivot')
    : 'Pivot N/A';

  let zone = 'Between Levels';
  let cls = price >= pp ? 'bull' : 'neutral';
  if(supportDist <= nearBand && resistanceDist <= nearBand) { zone = 'Tight S/R Zone'; cls = 'neutral'; }
  else if(supportDist <= nearBand) { zone = 'Near Support'; cls = price >= pp ? 'bull' : 'neutral'; }
  else if(resistanceDist <= nearBand) { zone = 'Near Resistance'; cls = 'bear'; }
  else if(pivotDist <= nearBand) { zone = 'Near Pivot'; cls = 'neutral'; }
  else if(s.priceAboveAllResistance) { zone = 'Above All Resistance / Breakout Zone'; cls = 'strong-bull'; }
  else if(s.priceBelowAllSupport) { zone = 'Below All Support / Breakdown Zone'; cls = 'strong-bear'; }
  else if(price > pp) { zone = 'Above Pivot Zone'; cls = 'bull'; }
  else if(price < pp) { zone = 'Below Pivot Zone'; cls = 'bear'; }

  const label = `${zone} · ${pivotText}`;
  const supTxt = Number.isFinite(Number(nearestSupport?.v)) ? `${nearestSupport.n} ${fmt(nearestSupport.v)} (${supportDist.toFixed(1)}% below)` : 'Support N/A';
  const resTxt = Number.isFinite(Number(nearestResistance?.v)) ? `${nearestResistance.n} ${fmt(nearestResistance.v)} (${resistanceDist.toFixed(1)}% above)` : 'Resistance N/A';
  const note = `${supTxt} · ${resTxt}`;
  return {
    label, cls, note, supportDist, resistanceDist, pivotText,
    nearestSupportValue: Number.isFinite(Number(nearestSupport?.v)) ? Number(nearestSupport.v) : null,
    nearestSupportName: nearestSupport?.n || null,
    nearestResistanceValue: Number.isFinite(Number(nearestResistance?.v)) ? Number(nearestResistance.v) : null,
    nearestResistanceName: nearestResistance?.n || null
  };
}
const PRIVATE_BANK_KEYS = new Set(['HDFCBANK','ICICIBANK','KOTAKBANK','AXISBANK','INDUSINDBK','FEDERALBNK','AUBANK','BANDHANBNK','IDFCFIRSTB','YESBANK']);
const PSU_BANK_KEYS = new Set(['SBIN','PNB','BANKBARODA','CANBK','UNIONBANK','BANKINDIA','CENTRALBK','INDIANB','IOB','MAHABANK','UCOBANK']);
const INDEX_SECTOR_KEY = {
  NIFTY:['nifty50'], BANKNIFTY:['bank'], FINNIFTY:['finnifty','finexbank'], NIFTYNXT50:['next50'],
  NIFTYIT:['it'], NIFTYAUTO:['auto'], NIFTYPHARMA:['pharma'], NIFTYFMCG:['fmcg'], NIFTYMETAL:['metal'],
  NIFTYREALTY:['realty'], NIFTYMEDIA:['media'], NIFTYPSUBANK:['psubank'], NIFTYPVTBANK:['pvtbank'],
  NIFTYENERGY:['energy'], NIFTYOILGAS:['oilgas'], NIFTYHEALTH:['health'], NIFTYINFRA:['infra']
};
const SECTOR_KEY_PRIORITY = {
  ConsumerDurables:['consdur','consumption'], Power:['energy'], Diversified:['nifty50'],
  IT:['it'], Finance:['finnifty','finexbank'], Pharma:['pharma','health'], Healthcare:['health','pharma'], Auto:['auto'], FMCG:['fmcg'], Metal:['metal'],
  Energy:['energy','oilgas'], Realty:['realty'], Infra:['infra','pse'], Cement:['infra','housing'], Consumer:['consdur','consumption','tourism','fmcg'],
  Media:['media','digital'], Telecom:['digital','infra'], Chemicals:['commodities'], Commodity:['commodities','metal','oilgas','energy'], Crypto:['digital'],
  Banking:['bank','pvtbank','psubank'], Bank:['bank','pvtbank','psubank'], Index:['nifty50']
};
function sectorKeysForSymbol(sym, sector){
  const code = String(sym||'').toUpperCase().replace(/^NSE:/,'').replace(/\.NS$/,'');
  if(sector === 'Index') return INDEX_SECTOR_KEY[code] || ['nifty50'];
  if(sector === 'Banking' || sector === 'Bank'){
    if(PRIVATE_BANK_KEYS.has(code)) return ['pvtbank','bank'];
    if(PSU_BANK_KEYS.has(code)) return ['psubank','bank'];
    return ['bank','pvtbank','psubank'];
  }
  return SECTOR_KEY_PRIORITY[sector] || [];
}
function getSectorBiasSnapshotFromList(sym, sectors){
  const sector = getStockSector(sym);
  const list = Array.isArray(sectors) ? sectors : [];
  if(sector === 'Unknown') return {sector, label:'UNKNOWN', cls:'neutral', pct:null, note:'Sector mapping not available for this stock.'};
  const keys = sectorKeysForSymbol(sym, sector);
  const hit = keys.map(k => list.find(s => String(s.key||'').toLowerCase() === k)).find(Boolean);
  const pct = hit && Number.isFinite(+hit.pct) ? +hit.pct : null;
  if(pct == null) return {sector, label:'NO DATA', cls:'neutral', pct:null, note:`Sector index data not available for ${sector}. Expected index key: ${keys.join(' / ') || 'none'}.`};
  const cls = pct >= 0.25 ? 'bull' : pct <= -0.25 ? 'bear' : 'neutral';
  const label = cls === 'bull' ? 'BULL' : cls === 'bear' ? 'BEAR' : 'FLAT';
  const note = cls === 'bull' ? 'Mapped sector index is giving tailwind today.' : cls === 'bear' ? 'Mapped sector index is under pressure today.' : 'Mapped sector index is almost flat today.';
  return {sector, label, cls, pct, note, source:hit.label, sectorKey:hit.key};
}

function getSectorBiasSnapshot(sym){
  return getSectorBiasSnapshotFromList(sym, GLOBAL_DATA?.sectors || []);
}

function getScoreTabSnapshot(sym){
  return buildSwingDecisionSnapshot(sym);
}


/* Shared Strategy-tab trade setup engine — one source for Overview trade-plan levels */
function extractPlanNumber(v){
  if(typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v ?? '').replace(/,/g,'').match(/-?\d+(?:\.\d+)?/);
  return m ? +m[0] : null;
}
function extractTradePriceFromText(v, refPrice=null){
  if(typeof v === 'number' && Number.isFinite(v)) return v;
  /* Strip indicator/label tokens (EMA20, DMA200, R1, S2, 52w, 20D, 1.5x, 2:1, 3%) before reading numbers.
     The old ">= 50" filter dropped real prices of stocks under ₹50 and kept "200" from "EMA200". */
  const cleaned = String(v ?? '').replace(/,/g,'')
    .replace(/\b(?:EMA|DMA|SMA|MA|RSI|ADX|ATR)\s*\d+\b/gi,' ')
    .replace(/\b[RS]\d\b/gi,' ')
    .replace(/\b\d+\s*(?:w|wk|d|D|m|y|x|%)\b/g,' ')
    .replace(/\b\d+(?:\.\d+)?\s*:\s*\d+(?:\.\d+)?\b/g,' ');
  const nums = cleaned.match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter(Number.isFinite) || [];
  if(!nums.length) return null;
  /* Prefer the number nearest the current symbol price when available. */
  const ref = Number(refPrice);
  const candidates = nums;
  if(Number.isFinite(ref) && ref > 0){
    return candidates.sort((a,b)=>Math.abs(a-ref)-Math.abs(b-ref))[0];
  }
  return candidates[candidates.length-1];
}
function setupDirection(setup, fallback='Sideways'){
  const t = String(setup?.type || '').toLowerCase();
  const n = String(setup?.name || '').toLowerCase();
  if(t.includes('long') || n.includes('long') || n.includes('buy')) return 'Bullish';
  if(t.includes('short') || n.includes('short') || n.includes('sell')) return 'Bearish';
  return fallback || 'Sideways';
}

/* Pick one active strategy from the same 4 Strategy Entry Plan cards.
   Overview and Strategy tab must use this exact object for entry/target/SL. */
function selectActiveFourStrategySetup({setupPool, preferredBias, price, e20, e50, e200, r1, s1, r2, srLevels, rsiV, macdD, adxR, volBlend, C=[], H=[], L=[]}){
  const pool = Array.isArray(setupPool) ? setupPool.filter(Boolean) : [];
  if(!pool.length || preferredBias === 'Sideways') return null;
  const wantDir = preferredBias === 'Bullish' ? 'Bullish' : preferredBias === 'Bearish' ? 'Bearish' : 'Sideways';
  const sameDirPool = pool.filter(s => setupDirection(s, wantDir) === wantDir);
  const candidates = sameDirPool.length ? sameDirPool : pool;
  const txt = s => `${s?.name||''} ${s?.type||''} ${s?.entry||''} ${s?.rationale||''}`.toLowerCase();
  const findBy = re => candidates.find(s => re.test(txt(s)));
  const nearPct = (a,b,pct=1.25)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)/Math.max(Math.abs(b),1)*100<=pct;
  const levelValue = v => Number(v && typeof v === 'object' ? v.v : v);
  const nearestSupport = levelValue(srLevels?.nearestSupport ?? srLevels?.support);
  const nearestResistance = levelValue(srLevels?.nearestResistance ?? srLevels?.resistance);
  let selected = null;

  if(preferredBias === 'Bullish'){
    /* Shared engine: the screener picks the setup with the same rules. */
    /* Each candidate's own R:R from its card (same shared-engine numbers the screener uses). */
    const numL = v => Number(String(v ?? '').replace(/,/g, ''));
    const rrOf = nm => { const cd = candidates.find(x => x.name === nm); return cd ? SwingPlan.setupRR(nm, price, {entry:+cd.entryPrice, stop:numL(cd.stoploss), target:numL(cd.target)}) : 0; };
    const pickedName = SwingPlan.pickLongSetup({ price, e20, e50, e200, sr: srLevels, rsi: rsiV, macd: macdD, adx: adxR, volBlend, C, L, rrOf });
    selected = pickedName ? (candidates.find(x => x.name === pickedName) || null) : null;
  } else if(preferredBias === 'Bearish'){
    const ema20Reject = findBy(/ema20|ema\s*20/);
    const ema50Reject = findBy(/ema50|ema\s*50|deep rejection/);
    const resistanceReject = findBy(/resistance/);
    const distPct = (level) => Number.isFinite(+level) && +level > 0 ? Math.abs(+price - +level) / Math.max(Math.abs(+level), 1) * 100 : 999;
    const resistanceRef = Number.isFinite(+nearestResistance) ? +nearestResistance : r1;
    const validSetups = [
      {setup:ema20Reject, name:'EMA20 Rejection', dist:distPct(e20), ok:Number.isFinite(+e20) && Number.isFinite(+e50) && e20 < e50 && price <= e20 * 1.025 && distPct(e20) <= 2.5},
      {setup:ema50Reject, name:'EMA50 Deep Rejection', dist:distPct(e50), ok:Number.isFinite(+e50) && Number.isFinite(+e200) && e50 < e200 && price <= e50 * 1.005 && distPct(e50) <= 3.0},
      {setup:resistanceReject, name:'Resistance Rejection', dist:distPct(resistanceRef), ok:Number.isFinite(+resistanceRef) && resistanceRef >= price * 0.995 && distPct(resistanceRef) <= 1.25}
    ].filter(x => x.setup && x.ok);
    selected = validSetups.sort((a,b) => Math.abs(a.dist-b.dist) > 0.15 ? a.dist-b.dist : 0)[0]?.setup || null;
  }
  return selected || null;
}

function buildPreferredSidewaysStrategyPlan({name, price, pp, nearestSupport, nextSupport, nearestResistance, nextResistance, atr}){
  const round = v => fmt(R2(v));
  const p = Number(price) || 0;
  const ns = Number(nearestSupport);
  const nr = Number(nearestResistance);
  const nxtS = Number(nextSupport);
  const nxtR = Number(nextResistance);
  const pivot = Number(pp);
  const safeAtr = Number.isFinite(Number(atr)) && Number(atr) > 0 ? Number(atr) : Math.max(p*0.015, 1);
  const longEntry = Number.isFinite(nr) && nr > p ? nr : p + safeAtr;
  const shortEntry = Number.isFinite(ns) && ns < p ? ns : p - safeAtr;
  const longTarget = Number.isFinite(nxtR) && nxtR > longEntry ? nxtR : longEntry + safeAtr*1.8;
  const shortTarget = Number.isFinite(nxtS) && nxtS < shortEntry ? nxtS : shortEntry - safeAtr*1.8;
  const longStop = Math.max(Number.isFinite(pivot) ? pivot : p-safeAtr, Number.isFinite(ns) ? ns : p-safeAtr);
  const shortStop = Math.min(Number.isFinite(pivot) ? pivot : p+safeAtr, Number.isFinite(nr) ? nr : p+safeAtr);
  return {
    bias:'Sideways', strategy_name:'Wait for Breakout / Breakdown',
    summary:`${name} is sideways/choppy. No fresh directional trade until price breaks and sustains outside the nearest S/R range.`,
    setups:[
      {name:'Breakout Long — only after confirmation', type:'Neutral Long Trigger', entry:`Wait. Long only after close above resistance ${round(longEntry)} with volume`, target:round(longTarget), stoploss:round(longStop), rationale:'Choppy market: breakout level is a trigger, not a current buy signal.'},
      {name:'Breakdown Short — only after confirmation', type:'Neutral Short Trigger', entry:`Wait. Short only after close below support ${round(shortEntry)} with volume`, target:round(shortTarget), stoploss:round(shortStop), rationale:'Choppy market: breakdown level is a trigger, not a current short signal.'}
    ],
    key_levels:{support:round(Number.isFinite(ns)?ns:shortEntry), resistance:round(Number.isFinite(nr)?nr:longEntry), pivot:round(Number.isFinite(pivot)?pivot:p)},
    risk_note:'Sideways/choppy market. Entry, target and stop are conditional trigger levels only; Final Action must remain WAIT until breakout/breakdown confirms.', best_timeframe:'1hr / Daily'
  };
}

async function getStrategyTradePlan(sym, name, preferredBias='Sideways'){
  const key = `strat_${sym}`;
  const {C,H,L} = CUR_DATA.daily, n = C.length;
  const srLevels = getSRTradeLevels();
  const price = srLevels.price;
  const {pp, r1, r2, r3, s1, s2, s3} = srLevels;
  const rsi=calcRSI(C), macdD=calcMACD(C), adxR=calcADX(C,H,L);
  const e20=emaLast(C,20), e50=emaLast(C,50), e200=emaLast(C,200);
  const stResult=calcSuperTrend(C,H,L), bb=calcBB(C);
  const V = CUR_DATA.daily.V || [];
  const volEnd = Math.max(0, Math.min(V.length, n) - 1);
  const volBase20 = V.slice(Math.max(0, volEnd - 20), volEnd);
  const volBase3 = V.slice(Math.max(0, volEnd - 3), volEnd);
  const avgVol20 = volBase20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase20.length);
  const avgVol3 = volBase3.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase3.length);
  const todayVol = (n > 0 && V.length >= n) ? (Number(V[n-1])||0) : (Number(V[V.length-1])||0);
  const volRatio = avgVol20 ? todayVol / avgVol20 : 0;
  const volBlend = (volRatio||0)*0.6 + ((avgVol20&&volBase3.length?avgVol3/avgVol20:volRatio)||0)*0.4;
  const rec=CUR_DATA.daily.rec, weeklyRec=CUR_DATA.weekly?.rec;
  const prev = firstFiniteNumber(CUR_DATA.pc, C[n-2], C[n-1], price);
  const atr = calcATRFromBars(C,H,L,price,prev,14);
  let strat = buildLocalStrategyPlan({name, sym, price, rsi, macdD, adxR, e20, e50, e200, stResult, pp, r1, r2, r3, s1, s2, s3, C, H, L, rec, weeklyRec, srLevels, bias:preferredBias});
  /* Overview bias is the master decision. If Overview says Sideways/choppy, Strategy must not silently convert it to Bullish/Bearish. */
  if(preferredBias === 'Sideways' && strat.bias !== 'Sideways'){
    const supports = (srLevels?.supports || []).map(x=>x.v).filter(v=>Number.isFinite(v) && v < price).sort((a,b)=>b-a);
    const resistances = (srLevels?.resistances || []).map(x=>x.v).filter(v=>Number.isFinite(v) && v > price).sort((a,b)=>a-b);
    const nearestSupport = supports[0] || (Number.isFinite(e50) && e50 < price ? e50 : s1);
    const nextSupport = supports[1] || s2 || nearestSupport - Math.max(atr || 0, Math.abs(r1-s1) || price*0.02);
    const nearestResistance = resistances[0] || (Number.isFinite(e20) && e20 > price ? e20 : r1);
    const nextResistance = resistances[1] || r2 || nearestResistance + Math.max(atr || 0, Math.abs(r1-s1) || price*0.02);
    strat = buildPreferredSidewaysStrategyPlan({name, price, pp, nearestSupport, nextSupport, nearestResistance, nextResistance, atr});
  }
  AI_CACHE[key] = strat;
  const setups = Array.isArray(strat.setups) ? strat.setups : [];
  if(strat.bias === 'Sideways'){
    const neutralSetup = setups.find(s => /breakout|breakdown|wait/i.test(`${s.name||''} ${s.type||''}`)) || setups[0] || {};
    return {
      strat, setup:neutralSetup, bias:'Sideways',
      entry:'Wait — no active entry in sideways/choppy market',
      stopLoss:null, stopLoss2:null, target1:null, target2:null,
      setupName:strat.strategy_name || 'Wait for Breakout / Breakdown',
      rationale:strat.risk_note || strat.summary || 'Sideways/choppy market: breakout/breakdown levels are only conditional triggers, not current entry prices.',
      source:'Trade Setup This Week',
      isActive:false
    };
  }
  const setupPool = Array.isArray(strat.four_strategy_setups) && strat.four_strategy_setups.length ? strat.four_strategy_setups : setups;
  const want = preferredBias==='Bullish' ? 'long' : preferredBias==='Bearish' ? 'short' : '';
  let primary = selectActiveFourStrategySetup({setupPool, preferredBias, price, e20, e50, e200, r1, s1, r2, srLevels, rsiV:rsi, macdD, adxR, volBlend, C, H, L});
  if(!primary){
    return {
      strat, setup:null, bias:preferredBias || strat.bias || 'Sideways',
      entry:'Wait — current price is not near EMA20, EMA50, support, pre-breakout, or confirmed breakout zone',
      stopLoss:null, stopLoss2:null, target1:null, target2:null,
      setupName:'No Active Strategy Selected',
      rationale:'Trend may exist, but price location is not valid for the allowed Strategy-tab entries. Wait for pullback to EMA20/EMA50/support, pre-breakout trigger below resistance, or confirmed breakout with volume.',
      source:'Trade Setup This Week',
      isActive:false
    };
  }
  const direction = setupDirection(primary, strat.bias || preferredBias || 'Sideways');
  const sameDir = setupPool.filter(s => setupDirection(s, direction) === direction);
  let stopLoss = extractPlanNumber(primary.stoploss);
  let target1  = extractPlanNumber(primary.target);
  const entryPrice = firstFiniteNumber(primary.entryPrice, extractTradePriceFromText(primary.entry, price), price);
  if(!Number.isFinite(stopLoss)) stopLoss = direction==='Bullish' ? pp : direction==='Bearish' ? r1 : pp;
  if(!Number.isFinite(target1))  target1  = direction==='Bullish' ? r1 : direction==='Bearish' ? s1 : pp;
  const stopLoss2 = stopLoss;
  const target2 = null;
  return {strat, setup:primary, bias:direction, entry:primary.entry || 'Wait for setup confirmation', entryPrice:R2(entryPrice), stopLoss:R2(stopLoss), stopLoss2:R2(stopLoss), target1:R2(target1), target2:null,
    setupName:primary.name || strat.strategy_name || 'Trade Setup This Week', rationale:primary.rationale || strat.summary || '', source:'Trade Setup This Week', isActive:true};
}


function classifyTradeSetup({bias, price, e20, e50, e200, rsiV, macdD, volRatio, r1, s1, r2, s2, rrNum, priceLocation, C=[], H=[], L=[], O=[], V=(typeof CUR_DATA!=='undefined' && CUR_DATA?.daily?.V) || [], planSetup=''}) {
  /* Pullbacks: quiet pullback is fine; READY needs a green bounce day on >=1.0x volume (shared rule). */
  const pv = Array.isArray(V) && V.length ? SwingPlan.pullbackVolume(V, C) : null;
  const pbVolOk = pv ? pv.bounceOk : volRatio >= 0.8;
  const pOk = Number.isFinite(+price);
  const e20Ok = Number.isFinite(+e20) && +e20 > 0;
  const e50Ok = Number.isFinite(+e50) && +e50 > 0;
  const e200Ok = Number.isFinite(+e200) && +e200 > 0;
  const macdBull = !!(macdD && macdD.macd > macdD.signal && macdD.macd > 0);
  const macdBear = !!(macdD && macdD.macd < macdD.signal && macdD.macd < 0);
  const aboveTrend = pOk && e50Ok && e200Ok && price > e50 && e50 > e200;
  const belowTrend = pOk && e50Ok && e200Ok && price < e50 && e50 < e200;
  const aboveE20Trend = pOk && e20Ok && e50Ok && price >= e20 * 0.997 && e20 > e50;
  const belowE20Trend = pOk && e20Ok && e50Ok && price <= e20 * 1.003 && e20 < e50;
  const distE20 = e20Ok ? Math.abs(price - e20) / e20 * 100 : 99;
  const distE50 = e50Ok ? Math.abs(price - e50) / e50 * 100 : 99;
  const locLabel = String(priceLocation?.label || '').toLowerCase();
  const locSupportDist = Number(priceLocation?.supportDist);
  const locResistanceDist = Number(priceLocation?.resistanceDist);
  const firstValidLevel = (...vals) => vals.map(Number).find(v => Number.isFinite(v) && v > 0) || null;
  const supportRef = firstValidLevel(priceLocation?.nearestSupportValue, s1, s2);
  const resistanceRef = firstValidLevel(priceLocation?.nearestResistanceValue, r1, r2);

  const brokeR1 = Number.isFinite(r1) && r1 > 0 && price > r1 * 1.002;
  const brokeS1 = Number.isFinite(s1) && s1 > 0 && price < s1 * 0.998;
  const nearR = !brokeR1 && ((resistanceRef ? Math.abs(price - resistanceRef) / price * 100 < 1.0 : false) || (locLabel.includes('near resistance') && Number.isFinite(locResistanceDist) && locResistanceDist <= 1.0) || (Number.isFinite(locResistanceDist) && locResistanceDist <= 0.75));
  const nearS = !brokeS1 && ((supportRef ? Math.abs(price - supportRef) / price * 100 < 1.0 : false) || (locLabel.includes('near support') && Number.isFinite(locSupportDist) && locSupportDist <= 1.0) || (Number.isFinite(locSupportDist) && locSupportDist <= 0.75));
  const lastIdx = Array.isArray(C) ? C.length - 1 : -1;
  const lastClose = Number(C?.[lastIdx] || price);
  const prevClose = Number(C?.[lastIdx-1] || lastClose);
  const lastLow = Number(L?.[lastIdx] || lastClose);
  const lastHigh = Number(H?.[lastIdx] || lastClose);
  const supportBounceConfirmed = !!(Number.isFinite(+supportRef) && nearS && lastLow <= +supportRef * 1.005 && lastClose > +supportRef && lastClose > prevClose);
  const resistanceRejectConfirmed = !!(Number.isFinite(+resistanceRef) && nearR && lastHigh >= +resistanceRef * 0.995 && lastClose < +resistanceRef && lastClose < prevClose);
  const prevNearE20 = !!(e20Ok && Number.isFinite(prevClose) && Math.abs(prevClose - e20) / e20 * 100 <= 1.25);
  const todayTouchedE20 = !!(e20Ok && Number.isFinite(lastLow) && Number.isFinite(lastHigh) && lastLow <= e20 * 1.005 && lastHigh >= e20 * 0.995);
  const prevNearE50 = !!(e50Ok && Number.isFinite(prevClose) && Math.abs(prevClose - e50) / e50 * 100 <= 1.25);
  const todayTouchedSupport = !!(Number.isFinite(+supportRef) && Number.isFinite(lastLow) && lastLow <= +supportRef * 1.005);
  const entryZoneTouchedLong = prevNearE20 || todayTouchedE20 || prevNearE50 || todayTouchedSupport || nearS;

  const cls = bias === 'Bullish' ? 'bull' : bias === 'Bearish' ? 'bear' : 'neutral';
  /* rrNum 0 means "no RR available" (no valid plan), not a weak RR - don't label it "Weak RR setup". */
  const rrWeak = Number.isFinite(rrNum) && rrNum > 0 && rrNum < SWING_MIN_RR;
  const pack = (obj) => ({
    setupDetail: obj.setupDetail || String(obj.label || 'No clean entry').replace(/^(READY|CONFIRM|WATCH|WAIT) · /i,''),
    ...obj
  });

  /* A long setup picked by the shared engine is judged ONLY on its own confirmation, with the same thresholds
     as the engine, the Ready Gate and the screener. The older checks below used different numbers (breakout
     READY needed 1.35x volume instead of 1.1x, EMA50 Deep Pullback could never be READY, EMA20 needed RSI 50
     instead of 45), so a setup the screener accepted could never pass on the Overview. RSI / ADX / R:R /
     distribution limits are checked once, in the Ready Gate. */
  if (bias === 'Bullish' && planSetup && /^(EMA20 Pullback|EMA50 Deep Pullback|Support Bounce|Breakout with Volume|Pre-Breakout Watch|Momentum Continuation)$/.test(planSetup)) {
    const green = lastClose > prevClose;
    const heavy = !!pv?.heavyPullback;
    const bounceVol = pv ? pv.bounceOk : volRatio >= 1.0;
    const sw = SwingPlan.swingSupport({ s1, s2 }, price);
    const mk = (ready, readyTxt, confirmTxt, note) => pack({ label:`${ready ? 'READY' : 'CONFIRM'} · ${planSetup}`, setupDetail:planSetup, cls,
      action: ready ? 'READY' : 'CONFIRM', simple: ready ? readyTxt : confirmTxt, note });
    if (planSetup === 'EMA20 Pullback')
      return mk(bounceVol && !heavy, 'Bounce from EMA20 confirmed',
        heavy ? 'Heavy selling into the pullback - wait for it to dry up' : 'In the EMA20 zone - wait for a green bounce day on 1.0x+ volume',
        'Trend pullback to EMA20 (EMA20 above EMA50). Entry on a green close with at least average volume; stop below the pullback low.');
    if (planSetup === 'EMA50 Deep Pullback') {
      const held = e50Ok && lastLow <= e50 * 1.015 && lastClose >= e50 && green;
      return mk(held && bounceVol && !heavy, 'Bounce from EMA50 confirmed',
        heavy ? 'Heavy selling into the pullback - wait for it to dry up' : 'Near EMA50 - wait for a green close above EMA50 on 1.0x+ volume',
        'Deeper pullback to EMA50 in an EMA50 > EMA200 trend. Entry only after price holds EMA50 and closes green.');
    }
    if (planSetup === 'Support Bounce') {
      const held = !!sw && lastLow <= sw * 1.005 && lastClose > sw && green;
      return mk(held && bounceVol && !heavy, 'Bounce from swing support confirmed',
        'At swing support - wait for a green close above it on 1.0x+ volume',
        'Bounce from the 7/14-day swing low. Entry after a green close above support; stop below support.');
    }
    if (planSetup === 'Breakout with Volume')
      return mk(volRatio >= 1.1, 'Close above the 7-day high on 1.1x+ volume',
        `Above the 7-day high - volume ${(+volRatio || 0).toFixed(2)}x needs to be 1.1x+`,
        'Close above the 7-day high in an uptrend. Target is a measured move; stop below the breakout level.');
    return pack({ label:`CONFIRM · ${planSetup}`, setupDetail:planSetup, cls, action:'CONFIRM',
      simple: planSetup === 'Pre-Breakout Watch' ? 'Bullish base just below the 7-day high - alert only' : 'Momentum continuation - alert only',
      note:'Watch-only setup: use it as an alert, never as an entry by itself.' });
  }

  if (bias === 'Bullish') {
    if (rsiV >= 70) {
      return pack({label:'WAIT · Bullish but stretched', setupDetail:'Overbought chase zone', cls:'neutral', action:'WAIT', simple:'Bullish, but not a fresh buy', note:'RSI is overbought. Do not chase; wait for EMA20 pullback or breakout retest.'});
    }
    if (lastClose < prevClose && volRatio >= 1.10) {
      return pack({label:'WAIT · High selling volume', setupDetail:'Distribution day', cls:'neutral', action:'WAIT', simple:'Bullish trend, but today is a high-volume down day', note:'Price is falling on above-average volume. Healthy pullbacks come on light volume; wait for selling to dry up and a bullish close that holds EMA20/support.'});
    }
    if (rrWeak) {
      const zoneTxt = entryZoneTouchedLong ? 'The EMA/support entry zone was already touched or is nearby, but the current price has moved enough that current-price RR is weak.' : 'Price is not giving enough reward versus the active stop.';
      return pack({label:'WAIT · Weak RR', setupDetail:'Weak RR setup', cls:'neutral', action:'WAIT', simple:'Bullish direction, but reward is too small', note:`${zoneTxt} Wait for a better entry near EMA20/support, or wait for the next resistance/target to open.`});
    }

    // 1) Strong-trend pullback: first preference for swing longs.
    if (aboveE20Trend && distE20 <= 2.5 && rsiV >= 50 && rsiV <= 68 && !(nearR && distE20 > 1.0) && !pbVolOk) {
      return pack({label:'CONFIRM · EMA20 pullback long', setupDetail:'Pullback from 20 EMA', cls, action:'CONFIRM', simple:'In the EMA20 pullback zone — wait for the bounce day', note:`Pullback location is right. Buy only on a green bounce candle with volume at least 1.0x the 20-day average${pv ? ` (today ${pv.todayRatio}x${pv.green ? '' : ', red candle'})` : ''}.`});
    }
    if (aboveE20Trend && distE20 <= 2.5 && rsiV >= 50 && rsiV <= 68 && pbVolOk && !(nearR && distE20 > 1.0)) {
      return pack({label:'READY · EMA20 pullback long', setupDetail:'Pullback from 20 EMA', cls, action:'READY', simple:'Best bullish swing setup', note:'Price is holding near EMA20 while EMA20 is above EMA50. This is the preferred trend-continuation pullback zone.'});
    }

    // Breakout/momentum is now a first-class swing setup, not ignored.
    if (aboveTrend && brokeR1 && (volRatio >= 1.1 || macdBull) && rsiV >= 52 && rsiV <= 72 && distE20 <= 6.5) {
      const strongBreakout = volRatio >= 1.35 && rsiV <= 70;
      return pack({label: strongBreakout ? 'READY · Breakout momentum long' : 'CONFIRM · Breakout momentum long', setupDetail:'Breakout Momentum Long', cls, action:strongBreakout?'READY':'CONFIRM', simple:'Resistance breakout with momentum', note:'Price has broken above swing resistance with bullish trend support. This catches the breakout-start swing that the old pullback-only logic missed.'});
    }

    // 2) Deeper pullback: valid, but slower/weaker than EMA20 pullback.
    if (aboveTrend && distE50 <= 3.5 && rsiV >= 48 && rsiV <= 65 && !nearR) {
      return pack({label:'CONFIRM · Deep pullback long', setupDetail:'Deep pullback near 50 EMA', cls, action:'CONFIRM', simple:'Deeper bullish pullback setup', note:'Price is near EMA50 in a bullish larger trend. This needs bullish candle/volume confirmation because a break below EMA50 can damage the swing trend.'});
    }

    // 3) Support / Resistance Bounce: must show actual bounce/rejection before READY.
    if (nearS) {
      if (!aboveTrend) return pack({label:'WAIT · Support watch', setupDetail:'Support bounce / trend weak', cls:'neutral', action:'WAIT', simple:'Near support, but trend is not fully confirmed', note:'Price is near support, but trend structure is not strong enough yet. Wait for bounce/close above support or EMA confirmation.'});
      if (supportBounceConfirmed && rsiV >= 35 && rsiV <= 58 && pbVolOk) return pack({label:'READY · Support bounce long', setupDetail:'Support / Resistance Bounce', cls, action:'READY', simple:'Confirmed support bounce', note:'Price touched/rejected support and closed back above it with acceptable RSI/volume. Entry is valid only near the support-bounce zone.'});
      if (rsiV >= 35 && rsiV <= 58 && volRatio >= 0.8) return pack({label:'CONFIRM · Support bounce long', setupDetail:'Support / Resistance Bounce', cls, action:'CONFIRM', simple:'Support zone reached; bounce not confirmed', note:'Price is near support inside a bullish trend, but no confirmed bounce candle yet. Wait for close back above support with bullish follow-through.'});
      return pack({label:'CONFIRM · Support bounce watch', setupDetail:'Support / Resistance Bounce', cls, action:'CONFIRM', simple:'Near support; wait for bullish confirmation', note:'Price is near support in a bullish trend, but RSI/volume confirmation is not strong enough yet. Buy only after confirmation.'});
    }

    if (nearR) {
      if (aboveTrend && rsiV >= 48 && rsiV <= 68 && distE20 <= 6.5 && (volRatio >= 0.75 || macdBull)) {
        return pack({label:'CONFIRM · Pre-breakout watch', setupDetail:'Pre-Breakout Watch', cls, action:'CONFIRM', simple:'Bullish base just below resistance', note:'Stock is close to resistance inside a bullish trend. Do not buy before breakout; prepare alert for close above resistance with volume.'});
      }
      return pack({label:'WAIT · Below resistance', setupDetail:'Near resistance / late zone', cls:'neutral', action:'WAIT', simple:'Bullish, but too close to resistance', note:'Do not buy directly under R1. Wait for breakout above R1 or a pullback to EMA20/support.'});
    }

    if (aboveE20Trend && macdBull && volRatio >= 1.0 && rsiV >= 55 && rsiV <= 70 && distE20 <= 7.0) {
      return pack({label:'CONFIRM · Momentum continuation long', setupDetail:'Momentum Continuation', cls, action:'CONFIRM', simple:'Momentum continuation is valid but needs strict risk control', note:'Momentum is positive and price is still within acceptable EMA20 distance. This is no longer ignored, but it remains lower quality than a fresh pullback or breakout trigger.'});
    }
    if (macdBull && volRatio >= 1.2) {
      return pack({label:'WATCH · Momentum building', setupDetail:'Momentum building', cls, action:'WATCH', simple:'Momentum supports upside, but entry is not clean', note:'Momentum is positive, but price is not in a clean EMA20 pullback, support bounce or confirmed breakout zone yet.'});
    }
    return pack({label:'WATCH · Bullish bias only', setupDetail:'No clean bullish trigger', cls:'neutral', action:'WATCH', simple:'Bullish, but entry trigger is not clean', note:'Bias is bullish, but there is no clean EMA20 pullback, breakout above R1, or confirmed EMA50 deep pullback yet.'});
  }

  if (bias === 'Bearish') {
    if (rsiV <= 30) {
      return pack({label:'WAIT · Bearish but stretched', setupDetail:'Oversold chase zone', cls:'neutral', action:'WAIT', simple:'Bearish, but not a fresh short', note:'RSI is oversold. Do not chase; wait for EMA20 rejection or support-break retest.'});
    }
    if (lastClose > prevClose && volRatio >= 1.10) {
      return pack({label:'WAIT · High buying volume', setupDetail:'Accumulation day', cls:'neutral', action:'WAIT', simple:'Bearish trend, but today is a high-volume up day', note:'Price is rising on above-average volume. Wait for buying to fade and a bearish close below EMA20/resistance before shorting.'});
    }
    if (rrWeak) {
      return pack({label:'WAIT · Weak RR', setupDetail:'Weak RR setup', cls:'neutral', action:'WAIT', simple:'Bearish direction, but reward is too small', note:'Reward versus stop is weak. Wait for a better short entry near EMA20/resistance, or wait for the next downside target to open.'});
    }

    // 1) Strong-trend pullback/rejection: first preference for swing shorts.
    if (belowE20Trend && distE20 <= 2.5 && rsiV <= 50 && rsiV >= 32 && volRatio >= 0.8 && !nearS) {
      return pack({label:'READY · EMA20 rejection short', setupDetail:'Rejection from 20 EMA', cls, action:'READY', simple:'Best bearish swing setup', note:'Price is rejecting near EMA20 while EMA20 is below EMA50. This is the preferred bearish continuation zone.'});
    }

    // Breakdown is informational in this user version; it must not drive Final Action/READY.
    if (belowTrend && brokeS1 && (volRatio >= 1 || macdBear) && rsiV <= 50 && rsiV > 30) {
      return pack({label:'WATCH · Breakdown ignored for active plan', setupDetail:'Breakdown info only', cls:'neutral', action:'WATCH', simple:'Breakdown detected, but not one of your active swing setups', note:'Your active decision engine is limited to EMA pullback/rejection and S/R rejection/bounce setups.'});
    }

    // 2) Deeper bearish pullback/rejection near EMA50.
    if (belowTrend && distE50 <= 3.5 && rsiV >= 35 && rsiV <= 52 && !nearS) {
      return pack({label:'CONFIRM · Deep rejection short', setupDetail:'Deep rejection near 50 EMA', cls, action:'CONFIRM', simple:'Deeper bearish rejection setup', note:'Price is near EMA50 in a bearish larger trend. Short only after rejection/breakdown confirmation because a close above EMA50 weakens the bearish setup.'});
    }

    // 4) Resistance rejection after cleaner EMA20/breakdown/deep-rejection checks.
    if (nearR) {
      if (!belowTrend) return pack({label:'WAIT · Resistance watch', setupDetail:'Resistance watch / trend weak', cls:'neutral', action:'WAIT', simple:'Near resistance, but bearish trend is not fully confirmed', note:'Price is near resistance, but bearish trend structure is not strong enough yet. Wait for rejection/breakdown confirmation.'});
      return pack({label:'CONFIRM · Resistance rejection', setupDetail:'Resistance rejection', cls, action:'CONFIRM', simple:'Near resistance; wait for bearish confirmation', note:'Price is near resistance in a bearish trend. Short only after rejection/breakdown confirmation.'});
    }

    if (nearS) {
      return pack({label:'WAIT · Above support', setupDetail:'Near support / late short zone', cls:'neutral', action:'WAIT', simple:'Bearish, but too close to support', note:'Do not short directly above support. Wait for breakdown below S1 or bounce rejection near EMA20/resistance.'});
    }

    if (macdBear && volRatio >= 1.2) {
      return pack({label:'WATCH · Downside momentum building', setupDetail:'Downside momentum building', cls, action:'WATCH', simple:'Momentum supports downside, but entry is not clean', note:'Momentum is negative, but price is not in a clean EMA20 rejection or confirmed breakdown zone yet.'});
    }
    return pack({label:'WATCH · Bearish bias only', setupDetail:'No clean bearish trigger', cls:'neutral', action:'WATCH', simple:'Bearish, but entry trigger is not clean', note:'Bias is bearish, but there is no clean EMA20 rejection, breakdown below S1, or confirmed EMA50 deep rejection yet.'});
  }
  return pack({label:'WAIT · No clear direction', setupDetail:'No clear direction', cls:'neutral', action:'WAIT', simple:'No trade setup yet', note:'Sideways bias. Wait for breakout, breakdown, or pullback confirmation.'});
}


/* Simple Ready Gate: runs AFTER Fresh Entry Score.
   It does not duplicate scoring; it only blocks READY when non-negotiable trade rules fail. */
const NIFTY_TREND_WHY = 'Nifty not in an uptrend (needs Nifty above its EMA50 and EMA20 above EMA50) - no fresh swing longs';
function buildReadyGate({bias, setupInfo, rrNum, qScore, price, e20, e50, e200, rsiV, adxR, volBlend, dr, wr, r1, s1, r2, s2, priceLocation=null, C=[], H=[], L=[], resultsSoon=null, planSetupName='', regime=null, rs=null, sectorStr=null}){
  const reasons=[];
  const add=(txt)=>{ if(txt && !reasons.includes(txt)) reasons.push(txt); };
  /* Pre-Breakout Watch and Momentum Continuation are watch-only: alerts, never a READY entry. */
  const watchOnly = /pre[- ]?breakout|momentum continuation/i;
  /* Breakout with Volume is watch-only too (backtest: 33% wins, -0.21R). Matched on the plan's own setup name only:
     classifier labels mention "breakout" on stocks whose plan is a pullback. */
  if(/^breakout with volume$/i.test(String(planSetupName || '').trim())) add('Breakout with Volume is watch-only (it lost money in the backtest) - buy the pullback to EMA20 / support after it, or set an alert');
  else if(watchOnly.test(String(planSetupName || '')) || watchOnly.test(`${setupInfo?.setupDetail || ''} ${setupInfo?.label || ''}`)) add(`${/momentum/i.test(String(planSetupName || setupInfo?.setupDetail || '')) ? 'Momentum Continuation' : 'Pre-Breakout'} is watch-only — wait for an EMA20/EMA50 pullback or support bounce`);
  /* Same rule as the screener: no fresh swing entry with results today or within 5 trading days (gap risk). */
  if(resultsSoon) add(resultsSoon.date === istDateKey() ? `Results today (${resultsSoon.date})` : `Results in ${resultsSoon.tradingDaysUntil} trading day${resultsSoon.tradingDaysUntil===1?'':'s'} (${resultsSoon.date})`);
  const setupText = `${setupInfo?.setupDetail || ''} ${setupInfo?.label || ''} ${setupInfo?.simple || ''}`.toLowerCase();
  /* Which setup's own rules to check: the active plan's setup for longs (the entry/stop/target shown come
     from it), otherwise the classified setup. Matched by exact kind, so "Deep pullback near 50 EMA" no longer
     gets the EMA20 rules and "Breakout Momentum" no longer gets the momentum rules. */
  const kindSrc = (bias === 'Bullish' && planSetupName) ? String(planSetupName).toLowerCase()
    : `${setupInfo?.setupDetail || ''} ${setupInfo?.label || ''}`.toLowerCase();
  const setupKind = /pre[- ]?breakout/.test(kindSrc) ? 'pre'
    : /breakout|breakdown/.test(kindSrc) ? 'breakout'
    : /momentum/.test(kindSrc) ? 'momentum'
    : /ema50|50 ema|deep/.test(kindSrc) ? 'ema50'
    : /support|resistance|bounce/.test(kindSrc) ? 'sr'
    : /ema20|20 ema|pullback|rejection/.test(kindSrc) ? 'ema20' : '';
  const action = setupInfo?.action || 'WATCH';
  const adxVal = Number(adxR?.adx || 0);
  const distE20 = (Number.isFinite(+price) && Number.isFinite(+e20) && +e20>0) ? Math.abs(+price-+e20)/+price*100 : 999;
  const daily = String(dr?.c || '').toLowerCase();
  const weekly = String(wr?.c || '').toLowerCase();
  const longConflict = bias==='Bullish' && weekly.includes('bear');
  const shortConflict = bias==='Bearish' && weekly.includes('bull');
  const supportRef = [priceLocation?.nearestSupportValue,s1,s2].map(Number).filter(v=>Number.isFinite(v)&&v>0&&v<=+price*1.02).sort((a,b)=>Math.abs(+price-a)-Math.abs(+price-b))[0] || s1;
  const resistanceRef = [priceLocation?.nearestResistanceValue,r1,r2].map(Number).filter(v=>Number.isFinite(v)&&v>0&&v>=+price*0.98).sort((a,b)=>Math.abs(+price-a)-Math.abs(+price-b))[0] || r1;
  const nearSupport = Number.isFinite(+supportRef) && +supportRef>0 ? Math.abs(+price-+supportRef)/+price*100 : 999;
  const nearResistance = Number.isFinite(+resistanceRef) && +resistanceRef>0 ? Math.abs(+price-+resistanceRef)/+price*100 : 999;

  if(!(bias==='Bullish' || bias==='Bearish')) add('Sideways/choppy bias');
  /* Trade with the long-term trend (the screener's rule): longs need price and EMA50 above EMA200, shorts below. */
  if(Number.isFinite(+e200) && +e200 > 0 && Number.isFinite(+e50)){
    if(bias==='Bullish' && !(+price > +e200 && +e50 > +e200)) add('Long-term trend not up: price and EMA50 must be above EMA200');
    if(bias==='Bearish' && !(+price < +e200 && +e50 < +e200)) add('Long-term trend not down: price and EMA50 must be below EMA200');
  }
  /* Weak R:R / distribution / overbought each have their own reason below, so they don't also get a vague
     "no trigger" line. */
  const labelTxt = String(setupInfo?.label || '');
  if((action==='WAIT' || action==='WATCH') && !/weak rr|high selling volume|high buying volume|stretched/i.test(labelTxt)) add('No active strategy trigger');
  if(/stretched/i.test(labelTxt)) add(`RSI ${fmt(rsiV,1)} is stretched - wait for a pullback`);
  if(!Number.isFinite(+rrNum) || +rrNum <= 0) add('RR not available');
  else if(+rrNum < SWING_MIN_RR) add(`RR ${(+rrNum).toFixed(2)} is below 1.25`);
  if(+qScore < 70) add(`Fresh Entry Score ${qScore}/100 is below 70`);
  /* Weekly trend for longs: the same weekly candles and rule as the screener (weekly close above a rising
     20-week EMA). Shorts keep the daily/weekly signal-conflict check. */
  const wkT = (typeof CUR_DATA!=='undefined' && CUR_DATA?.daily?.T) ? SwingPlan.weeklyTrend(CUR_DATA.daily.T, C) : null;
  /* Name the failing half of the rule (close above the 20-week EMA AND 10-week EMA >= 20-week EMA): "close 381.00
     vs EMA 380.91" read as a pass when it was the 10-week EMA that was still below. */
  if(bias==='Bullish' && wkT && !wkT.up) add(wkT.close <= wkT.ema20
    ? `Weekly trend not up: weekly close ${fmt(wkT.close)} is below the 20-week EMA ${fmt(wkT.ema20)}`
    : `Weekly trend not up yet: 10-week EMA ${fmt(wkT.ema10)} is still below the 20-week EMA ${fmt(wkT.ema20)}`);
  if(shortConflict) add('Daily/weekly trend conflict');
  /* Volume by setup type (same rule as the screener): pullbacks need a green bounce day on >=1.0x volume,
     breakouts >=1.1x, anything else >=0.8x. */
  {
    const setupNameForVol = planSetupName || setupInfo?.setupDetail || setupInfo?.label || '';
    const Vd = (typeof CUR_DATA!=='undefined' && CUR_DATA?.daily?.V) || [];
    const pvG = Vd.length ? SwingPlan.pullbackVolume(Vd, C) : null;
    const vr = SwingPlan.setupVolumeReason(setupNameForVol, volBlend, pvG);
    if(vr) add(vr);
    else if(!/pullback|bounce|breakout/i.test(setupNameForVol) && Number.isFinite(+volBlend) && +volBlend < 0.8) add('Weak volume confirmation below 0.8x');
    /* A setup that still needs its trigger candle cannot pass. Skipped when the volume line or the
       watch-only line above already says exactly what is missing. */
    if(action==='CONFIRM' && !vr && !reasons.some(r => /watch-only/i.test(r))) add(`Needs confirmation: ${setupInfo?.simple || 'wait for the trigger candle'}`);
  }
  /* Market regime and relative strength - the screener applies the same two rules. */
  /* The market regime gates LONGS only. Shorts are blocked only in a confirmed BULL market. */
  /* Longs: strength instead of the Nifty regime (same rule as the screener). The stock passes when its sector
     is up over 1 month OR it beats Nifty over 3 months; a weak Nifty alone no longer holds it back (it only
     adds a smaller-size note). With neither known, the Nifty regime decides as before. */
  const notes = [];
  if(bias === 'Bullish'){
    const secUp = Number.isFinite(+sectorStr?.ret1m) && sectorStr?.ret1m != null ? +sectorStr.ret1m > 0 : null;
    const rsUp = rs && Number.isFinite(+rs.rs3m) && rs.rs3m != null ? +rs.rs3m > 0 : null;
    if(secUp || rsUp){
      if(regime && regime.allowReady === false) notes.push(`Market ${String(regime.status||'').toLowerCase()} - passed on ${[secUp ? `${sectorStr.sector} sector strength` : '', rsUp ? 'beating Nifty' : ''].filter(Boolean).join(' and ')}; use smaller size`);
    } else if(secUp === null && rsUp === null){
      if(regime && regime.allowReady === false) add(`Market ${String(regime.status||'').toLowerCase()}: ${regime.note || 'no fresh swing longs'}`);
    } else {
      add(`${secUp === false ? `${sectorStr.sector} sector down ${Math.abs(sectorStr.ret1m)}% in 1 month` : 'Sector strength not measured yet (run a screener scan)'} and ${rsUp === false ? `lagging Nifty (3M RS ${rs.rs3m}%)` : 'RS vs Nifty unavailable'}`);
    }
  }
  if(bias === 'Bearish' && regime && regime.status === 'BULL') add('Market bull: Nifty and breadth are strong - no fresh swing shorts');
  /* Nifty trend gate for longs - same rule and words as the screener. */
  if(bias === 'Bullish' && regime && regime.trendUp === false) add(NIFTY_TREND_WHY);
  /* Same rule as the server screener: no fresh long on a red candle with above-average volume
     (distribution), no fresh short on a green candle with above-average volume (accumulation). */
  {
    const i = Array.isArray(C) ? C.length - 1 : -1;
    const lc = Number(C?.[i]), pc0 = Number(C?.[i-1]);
    if(Number.isFinite(lc) && Number.isFinite(pc0) && Number.isFinite(+volBlend) && +volBlend >= 1.10){
      if(bias==='Bullish' && lc < pc0) add('High selling volume today');
      if(bias==='Bearish' && lc > pc0) add('High buying volume today');
    }
  }

  /* Strategy-specific simple quality gates. These are stricter pass/fail checks, not extra score points. */
  if(setupKind === 'ema50'){
    /* Same rules as the screener's EMA50 Deep Pullback gate (mirrored for a short). */
    const distE50Signed = (Number.isFinite(+price) && Number.isFinite(+e50) && +e50 > 0) ? (+price - +e50) / +e50 * 100 : NaN;
    const iL = Array.isArray(C) ? C.length - 1 : -1;
    const cl = Number(C?.[iL] ?? price), pv0 = Number(C?.[iL-1] ?? cl), lw = Number(L?.[iL] ?? cl), hg = Number(H?.[iL] ?? cl);
    if(bias==='Bullish'){
      if(!(distE50Signed >= 0 && distE50Signed <= 5)) add('Not near the EMA50 pullback zone');
      if(!(lw <= +e50 * 1.015 && cl >= +e50 && cl > pv0) && !reasons.some(r => /^Needs confirmation|volume/i.test(r))) add('EMA50 bounce not confirmed');
      if(Number.isFinite(+rsiV) && (+rsiV < 45 || +rsiV > 62)) add(`RSI ${fmt(rsiV,1)} outside EMA50 pullback zone`);
    }
    if(bias==='Bearish'){
      if(!(distE50Signed <= 0 && distE50Signed >= -5)) add('Not near the EMA50 rejection zone');
      if(!(hg >= +e50 * 0.985 && cl <= +e50 && cl < pv0) && !reasons.some(r => /^Needs confirmation|volume/i.test(r))) add('EMA50 rejection not confirmed');
      if(Number.isFinite(+rsiV) && (+rsiV < 38 || +rsiV > 55)) add(`RSI ${fmt(rsiV,1)} outside EMA50 rejection zone`);
    }
    if(adxVal && adxVal < 16) add(`ADX ${adxVal.toFixed(1)} is weak for EMA50 trend setup`);
  }

  if(setupKind === 'ema20'){
    if(distE20 > 2.5) add(`EMA20 entry is late (${distE20.toFixed(1)}% away)`);
    if(bias==='Bullish' && !(Number.isFinite(+price) && Number.isFinite(+e20) && +price >= +e20 * 0.997)) add('Bullish EMA20 pullback needs price holding near/above EMA20');
    if(bias==='Bullish' && !(Number.isFinite(+e20) && Number.isFinite(+e50) && +e20 > +e50)) add('EMA20 must be above EMA50');
    if(bias==='Bullish' && !(Number.isFinite(+price) && Number.isFinite(+e50) && +price > +e50)) add('Bullish EMA pullback needs price above EMA50');
    if(bias==='Bearish' && !(Number.isFinite(+price) && Number.isFinite(+e50) && +price < +e50)) add('Bearish EMA rejection needs price below EMA50');
    if(Number.isFinite(+rsiV) && bias==='Bullish' && (+rsiV < 45 || +rsiV > 68)) add(`RSI ${fmt(rsiV,1)} outside EMA pullback zone`);
    if(Number.isFinite(+rsiV) && bias==='Bearish' && (+rsiV < 32 || +rsiV > 55)) add(`RSI ${fmt(rsiV,1)} outside EMA rejection zone`);
    if(adxVal && adxVal < 18) add(`ADX ${adxVal.toFixed(1)} is weak for EMA trend setup`);
  }

  if(setupKind === 'sr'){
    if(bias==='Bullish'){
      const idx = Array.isArray(C) ? C.length - 1 : -1;
      const lastClose = Number(C?.[idx] || price), prevClose = Number(C?.[idx-1] || lastClose), lastLow = Number(L?.[idx] || lastClose);
      const swS = SwingPlan.swingSupport({s1, s2}, +price) || supportRef;
      const swDist = Number.isFinite(+swS) && +swS > 0 ? Math.abs(+price - +swS) / +price * 100 : 999;
      const bounceConfirmed = Number.isFinite(+swS) && swDist <= 1.5 && lastLow <= +swS * 1.005 && lastClose > +swS && lastClose > prevClose;
      if(swDist > 1.5) add('Not close enough to swing support for a bounce setup');
      else if(!bounceConfirmed && !reasons.some(r => /^Needs confirmation/i.test(r))) add('Support bounce candle is not confirmed');
      if(Number.isFinite(+rsiV) && (+rsiV < 40 || +rsiV > 60)) add(`RSI ${fmt(rsiV,1)} outside support-bounce zone`);
    }
    if(bias==='Bearish'){
      if(nearResistance > 1.5) add('Not close enough to resistance for rejection setup');
      if(Number.isFinite(+rsiV) && (+rsiV < 40 || +rsiV > 65)) add(`RSI ${fmt(rsiV,1)} outside resistance-rejection zone`);
    }
  }

  if(setupKind === 'pre'){
    if(Number.isFinite(+volBlend) && +volBlend < 0.75) add('Pre-breakout watch needs at least 0.75x volume');
    if(distE20 > 6.5) add(`Pre-breakout is too extended from EMA20 (${distE20.toFixed(1)}%)`);
    if(Number.isFinite(+rsiV) && bias==='Bullish' && (+rsiV < 48 || +rsiV > 68)) add(`RSI ${fmt(rsiV,1)} outside pre-breakout watch zone`);
    if(adxVal && adxVal < 14) add(`ADX ${adxVal.toFixed(1)} is weak for pre-breakout watch`);
  } else if(setupKind === 'breakout'){
    if(distE20 > 6.5) add(`Breakout is extended from EMA20 (${distE20.toFixed(1)}%)`);
    if(Number.isFinite(+rsiV) && bias==='Bullish' && (+rsiV < 52 || +rsiV > 72)) add(`RSI ${fmt(rsiV,1)} outside clean breakout zone`);
    if(adxVal && adxVal < 16) add(`ADX ${adxVal.toFixed(1)} is weak for breakout`);
  }

  if(setupKind === 'momentum'){
    if(adxVal && adxVal < 18) add(`ADX ${adxVal.toFixed(1)} is weak for momentum`);
    if(distE20 > 7) add(`Momentum entry is late (${distE20.toFixed(1)}% from EMA20)`);
    if(Number.isFinite(+rsiV) && bias==='Bullish' && (+rsiV < 55 || +rsiV > 72)) add(`RSI ${fmt(rsiV,1)} outside healthy momentum zone`);
  }

  const passed = reasons.length === 0;
  const fatalReason = reasons.some(r => /sideways|no active strategy trigger|rr not available/i.test(r)) || (Number.isFinite(+rrNum) && +rrNum < 1.0) || (+qScore < 45);
  const soft = !passed && !fatalReason && ['READY','CONFIRM'].includes(action) && Number.isFinite(+rrNum) && +rrNum >= SWING_MIN_RR && +qScore >= 55 && reasons.length <= 4;
  return {
    passed,
    soft,
    label: passed ? 'PASSED' : soft ? 'CONFIRM' : 'FAILED',
    cls: passed ? 'bull' : soft ? 'neutral' : 'bear',
    sub: passed ? 'Ready Gate passed' : soft ? 'Setup forming, not ready' : 'Ready Gate failed',
    reasons,
    notes,
    summary: passed ? 'Mandatory trade checks passed.' : reasons.slice(0,3).join(' · ')
  };
}

function makeSimpleEntryDecision({bias, setupInfo, hardReject, confidence, rejectRules=[]}){
  const dir = bias === 'Bullish' ? 'BULLISH' : bias === 'Bearish' ? 'BEARISH' : 'NEUTRAL';
  const setupAction = setupInfo?.action || 'WATCH';
  if(hardReject){
    const first = rejectRules[0] || 'One or more trade filters failed';
    return {
      decisionClass:'reject',
      decisionMain:'NO FRESH TRADE — WAIT',
      actionBadge:'WAIT',
      actionBadgeSub:'Filter failed',
      actionLine:`Do not force this trade. Main issue: ${first}.`,
      miniTitle:'Wait / no fresh trade',
      miniReason:first
    };
  }
  if(setupAction === 'READY'){
    return {
      decisionClass:'qualified',
      decisionMain:`${dir} TRADE READY`,
      actionBadge:'READY',
      actionBadgeSub:'Entry allowed',
      actionLine:`Direction is ${bias.toLowerCase()} and entry quality is acceptable. Enter only inside the stated entry zone and follow stop loss.`,
      miniTitle:'Ready setup',
      miniReason:setupInfo?.simple || 'Entry quality is acceptable'
    };
  }
  if(setupAction === 'CONFIRM'){
    return {
      decisionClass:'conditional',
      decisionMain:`${dir} BIAS — WAIT FOR CONFIRMATION`,
      actionBadge:'CONFIRM',
      actionBadgeSub:'Not ready yet',
      actionLine:`Direction is ${bias.toLowerCase()}, but confirmation is still required. Wait for candle close/volume confirmation near the entry zone.`,
      miniTitle:'Confirmation needed',
      miniReason:setupInfo?.simple || 'Setup needs confirmation'
    };
  }
  if(setupAction === 'WAIT'){
    const setupTxt = `${setupInfo?.label || ''} ${setupInfo?.simple || ''} ${setupInfo?.note || ''}`.toLowerCase();
    const isSupportWait = setupTxt.includes('near support');
    const isResistanceWait = setupTxt.includes('near resistance');
    const isRrWeak = setupTxt.includes('rr weak') || setupTxt.includes('risk/reward is weak') || setupTxt.includes('reward versus stop');
    const waitSub = isSupportWait ? (isRrWeak ? 'Near support / weak RR' : 'Near support')
                  : isResistanceWait ? (isRrWeak ? 'Near resistance / weak RR' : 'Near resistance')
                  : isRrWeak ? 'Weak RR'
                  : 'Not a clean entry';
    const waitLine = isSupportWait
      ? `Bias is ${bias.toLowerCase()} and price is near support, but entry is not ready yet. Wait for bounce/volume confirmation and acceptable RR.`
      : isResistanceWait
        ? `Bias is ${bias.toLowerCase()} and price is near resistance, but entry is not ready yet. Wait for rejection/breakdown confirmation and acceptable RR.`
        : `Bias is ${bias.toLowerCase()}, but the current price is not a clean fresh entry. Wait for pullback, breakout hold, or better risk/reward.`;
    return {
      decisionClass:'conditional',
      decisionMain:`${dir} BIAS — WAIT`,
      actionBadge:'WAIT',
      actionBadgeSub:waitSub,
      actionLine:waitLine,
      miniTitle:'Wait — not ready',
      miniReason:setupInfo?.simple || waitSub
    };
  }
  return {
    decisionClass:'conditional',
    decisionMain:`${dir} BIAS — WATCHLIST ONLY`,
    actionBadge:'WATCH',
    actionBadgeSub:'No clean entry',
    actionLine:`There is directional bias, but the setup is not clean enough for aggressive entry. Keep it on watchlist and wait for a defined trigger.`,
    miniTitle:'Watchlist only',
    miniReason:setupInfo?.simple || 'Bias exists, but no clean entry setup'
  };
}

function buildFinalSetupPill(setupInfo, simpleDecision){
  const finalAction = simpleDecision?.actionBadge || setupInfo?.action || 'WATCH';
  const base = String(setupInfo?.label || 'No clean entry').replace(/^(READY|CONFIRM|WATCH|WAIT) · /i,'');
  if(finalAction === 'READY') return {label:`READY · ${base}`, cls:setupInfo?.cls || 'bull', note:setupInfo?.note || simpleDecision?.actionLine || ''};
  if(finalAction === 'CONFIRM') return {label:`CONFIRM · ${base}`, cls:'neutral', note:simpleDecision?.actionLine || setupInfo?.note || ''};
  if(finalAction === 'WAIT') return {label:`WAIT · ${base}`, cls:'neutral', note:simpleDecision?.actionLine || setupInfo?.note || ''};
  return {label:'WATCH · No clean entry', cls:'neutral', note:simpleDecision?.actionLine || setupInfo?.note || 'Bias exists, but final entry is not clean yet'};
}



/* ══════════════════════════════════════════════════════════════════
   OVERVIEW TAB — summary card of all analysis at a glance
══════════════════════════════════════════════════════════════════ */

function tabGoldPetalOverview(sym){
  const kCal = mcxCalK(sym), price = getCurrentLivePrice() * kCal;   /* calibrated, like the cards above */
  const d = CUR_DATA || {}, ds = d.dataSource || {};
  const sr = getSRTradeLevels();
  const loc = getPriceLocationSnapshot(sr);
  const validity = getTradeValiditySnapshot(sym);
  const confidence = getDataConfidenceSnapshot(sym);
  const col = validity.cls==='bull'?'var(--bull)':validity.cls==='bear'?'var(--bear)':'var(--neu)';
  const dqCol = confidence.cls==='bull'?'var(--bull)':confidence.cls==='bear'?'var(--bear)':'var(--neu)';
  const warn = ds.warning || 'Continuous proxy: COMEX Gold × USD/INR × 1.159 MCX factor converted to ₹/1g. Verify broker MCX price before orders.';
  const support = sr.nearestSupport?.v != null ? sr.nearestSupport.v * kCal : undefined;
  const resistance = sr.nearestResistance?.v != null ? sr.nearestResistance.v * kCal : undefined;
  const supportName = sr.nearestSupport?.n || 'Nearest support';
  const resistanceName = sr.nearestResistance?.n || 'Nearest resistance';
  const buyPanel = goldPetalDashboard(sym) || '<div class="aib">Gold Petal dashboard needs more candle data.</div>';
  const confRows = (confidence.checks||[]).map(c=>`<div class="tp-qrow"><div><strong>${c.pass?'✅':'⚠️'} ${escHtml(c.name)}</strong><span>${escHtml(c.note)}</span></div><b>${c.pts}/${c.max}</b></div>`).join('');
  return `
    <div class="tp-decision conditional" style="border-color:var(--neu)">
      <div class="tp-decision-top"><div><div class="tp-decision-label">MCX Gold Petal Overview</div><div class="tp-decision-main" style="color:var(--neu)">PROXY PRICE — ACCUMULATION VIEW</div></div><div class="tp-confidence"><div class="tp-conf-num">${fmt(price)}</div><div class="tp-conf-lbl">₹ / 1g proxy</div></div></div>
      <div class="tp-summary">${escHtml(warn)} This tab does not use stock sector score or stock Fresh Entry Score for Gold Petal.</div>
    </div>
    ${buyPanel}
    <div class="tp-section"><div class="tp-section-title">Gold Petal Level Check</div>
      <div class="tp-grid">
        <div class="tp-item"><div class="tp-label">Current Price Location</div><div class="tp-val" style="color:${loc.cls==='bull'?'var(--bull)':loc.cls==='bear'?'var(--bear)':'var(--neu)'}">${escHtml(loc.label)}</div><div class="tp-sub">${escHtml(loc.note)}</div></div>
        <div class="tp-item"><div class="tp-label">Nearest Support</div><div class="tp-val" style="color:var(--bull)">${Number.isFinite(+support)?fmt(support):'--'}</div><div class="tp-sub">${escHtml(supportName)}</div></div>
        <div class="tp-item"><div class="tp-label">Nearest Resistance</div><div class="tp-val" style="color:var(--bear)">${Number.isFinite(+resistance)?fmt(resistance):'--'}</div><div class="tp-sub">${escHtml(resistanceName)}</div></div>
        <div class="tp-item"><div class="tp-label">USD/INR Used</div><div class="tp-val">${d.usdInr || '--'}</div><div class="tp-sub">Previous basis: ${d.prevUsdInr || '--'} · ${escHtml(d.changeBasis || 'proxy')}</div></div>
      </div>
    </div>
    <div class="tp-section"><div class="tp-section-title">Data Validation</div>
      <div class="tp-score-head ${confidence.cls}"><div><span class="tp-score-num">${confidence.score}</span><span class="tp-score-total">/100</span></div><div class="tp-grade" style="color:${dqCol}">${confidence.label}</div></div>
      <div class="tp-quality-list">${confRows}</div>
      <div class="aib">Proxy source is expected for Gold Petal. Medium data confidence is normal because this is not an official MCX feed.</div>
    </div>
    <div class="aib"><strong style="color:var(--warn)">Execution rule:</strong> Do not place Gold Petal orders from this proxy alone. Check live MCX/broker quote, spread, circuit limit and contract liquidity before entry.</div>`;
}

/* Live NSE results date for a stock (server: /api/earnings, NSE event calendar). Cached 30 min per symbol;
   any failure returns null so the Overview still renders. */
const RESULTS_INFO_CACHE = {};
async function getResultsSoon(sym){
  if(!/^NSE:/.test(String(sym)) || isIndexSymbol(sym)) return null;
  const c = RESULTS_INFO_CACHE[sym];
  if(c && Date.now() - c.ts < 30*60*1000) return c.v;
  try{
    const TIMEOUT = {};
    const d = await Promise.race([apiFetch(`/api/earnings?sym=${encodeURIComponent(sym)}`, 5000), new Promise(r => setTimeout(() => r(TIMEOUT), 5000))]);
    if(d === TIMEOUT || !d) return null; /* not cached: retry on the next render */
    const v0 = d?.soon?.[0] || null;
    const v = v0 ? {...v0, tradingDaysUntil: Number.isFinite(+v0.tradingDaysUntil) ? +v0.tradingDaysUntil : +v0.daysUntil} : null;
    RESULTS_INFO_CACHE[sym] = {v, ts:Date.now()};
    return v;
  }catch{ return null; }
}
/* Market regime + relative strength + results + NSE sector for a stock (server /api/swing-context).
   Cached 5 min per symbol; failures are not cached and never block the Overview. */
const SWING_CTX_CACHE = {};
async function getSwingContext(sym){
  if(!/^NSE:/.test(String(sym)) || isIndexSymbol(sym)) return null;
  const c = SWING_CTX_CACHE[sym];
  if(c && Date.now() - c.ts < 5*60*1000) return c.v;
  try{
    const TIMEOUT = {};
    const d = await Promise.race([apiFetch(`/api/swing-context?sym=${encodeURIComponent(sym)}`, 8000), new Promise(r => setTimeout(() => r(TIMEOUT), 8000))]);
    if(d === TIMEOUT || !d || d.error) return null;
    if(d.sector?.sector) SECTOR_OVERRIDE[sym] = d.sector.sector;
    SWING_CTX_CACHE[sym] = {v:d, ts:Date.now()};
    return d;
  }catch{ return null; }
}
/* Screener READY must agree with the Overview. For each READY pick the screener runs this exact Overview
   decision. Quote and swing context are fetched first; after that the Overview has no network wait (cached
   context, results taken from it), so the temporary CUR_SYM/CUR_DATA swap resolves in microtasks and no
   click or timer can run against the swapped data. */
let OVERVIEW_PROBE_NAME = null;
const OVERVIEW_VERDICT = {};
async function probeOverviewVerdict(sym, name){
  const c = OVERVIEW_VERDICT[sym];
  if(c && Date.now() - c.ts < 5*60*1000) return c;
  const ctx = await getSwingContext(sym);
  if(!ctx) return null;
  const data = enrichLiveData(await fetchLiveQuote(sym));
  const saveSym = CUR_SYM, saveData = CUR_DATA;
  CUR_SYM = sym; CUR_DATA = data; OVERVIEW_PROBE_NAME = name;
  try { await tabOverview(sym); }
  finally { CUR_SYM = saveSym; CUR_DATA = saveData; OVERVIEW_PROBE_NAME = null; }
  return OVERVIEW_VERDICT[sym] || null;
}
async function tabOverview(sym) {
  const swingCtx = await getSwingContext(sym);
  const resultsSoon = swingCtx ? (swingCtx.resultsSoon || null) : await getResultsSoon(sym);
  const marketRegime = swingCtx?.regime || null, relStrength = swingCtx?.rs || null;
  if(isIndexSymbol(sym)) {
    return renderIndexOptionsDecision(sym);
  }
  if(sym === 'MCX:GOLDPETAL') {
    return tabGoldPetalOverview(sym);
  }
  const {C,H,L,V,O} = CUR_DATA.daily, n=C.length;
  const price = getCurrentLivePrice(), prev = firstFiniteNumber(CUR_DATA.pc, C[n-2], C[n-1], price);
  const name = OVERVIEW_PROBE_NAME || document.getElementById('ihn').textContent || sym;

  /* Core signals used to build trade plan */
  const dr    = sigRec(CUR_DATA.daily.rec.value);
  const wr    = sigRec(CUR_DATA.weekly?.rec?.value ?? 0);
  const rsiV  = calcRSI(C);
  const rsiS  = sigRSI(rsiV);
  const macdD = calcMACD(C);
  const ms    = sigMACD(macdD?.macd, macdD?.signal);
  const adxR  = calcADX(C,H,L);
  const adxS  = sigADX(adxR?.adx, adxR?.pdi, adxR?.ndi);
  const e20   = emaLast(C,20), e50=emaLast(C,50), e200=emaLast(C,200);
  const emaSig = sigEMA(price,e20,e50,e200);
  const todayVol=V[n-1] || 0;
  const volEnd = Math.max(0, Math.min(V.length, n) - 1);
  const volBase20 = V.slice(Math.max(0, volEnd - 20), volEnd);
  const volBase3 = V.slice(Math.max(0, volEnd - 3), volEnd);
  const avgVol20=volBase20.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase20.length);
  const avgVol3=volBase3.reduce((a,b)=>a+(Number(b)||0),0)/Math.max(1,volBase3.length);
  const volRatio = avgVol20 ? todayVol / avgVol20 : 0;
  const volBlend = (volRatio||0)*0.6 + ((avgVol20&&volBase3.length?avgVol3/avgVol20:volRatio)||0)*0.4;
  const volSig = sigVolume(todayVol, avgVol20, price-prev);
  const confirmedPatternIdx = getConfirmedDailyIndex(CUR_DATA.daily);
  const pats   = detectPatterns(CUR_DATA.daily, confirmedPatternIdx);
  const pBull  = pats.filter(p=>p.s==='bull'||p.s==='strong-bull').length;
  const pBear  = pats.filter(p=>p.s==='bear'||p.s==='strong-bear').length;
  const patSig = pBull>pBear?{l:`${pBull} Bullish Pattern${pBull>1?'s':''}`,c:'bull'}:pBear>pBull?{l:`${pBear} Bearish Pattern${pBear>1?'s':''}`,c:'bear'}:{l:'No Clear Pattern',c:'neutral'};

  /* Pivot / S&R — use same source as S&R tab */
  const srLevels = getSRTradeLevels();
  const {ph,pl,pc,pp,r1,r2,s1,s2,nearestResistance,nextResistance,nearestSupport,nextSupport} = srLevels;

  /* ATR for stop/target spacing */
  const calcATRLocal = (period=14) => {
    if(C.length < period+2) return Math.max(price*0.015, Math.abs(price-prev));
    const tr=[];
    for(let i=1;i<C.length;i++) tr.push(Math.max(H[i]-L[i], Math.abs(H[i]-C[i-1]), Math.abs(L[i]-C[i-1])));
    let atr = tr.slice(0,period).reduce((a,b)=>a+b,0)/period;
    for(let i=period;i<tr.length;i++) atr = (atr*(period-1)+tr[i])/period;
    return atr || Math.max(price*0.015, Math.abs(price-prev));
  };
  const atr = calcATRLocal(14);
  const pctChg = +(((price-prev)/(prev||price))*100).toFixed(2);

  /* Bias engine */
  const sigs = [dr,wr,emaSig,rsiS,ms,volSig,patSig,adxS];
  const scoreMap = { 'strong-bull':2, bull:1, neutral:0, bear:-1, 'strong-bear':-2, na:0 };
  const rawBiasScore = sigs.reduce((a,s)=>a+(scoreMap[s.c]||0),0);
  const bullCt = sigs.filter(s=>s.c==='bull'||s.c==='strong-bull').length;
  const bearCt = sigs.filter(s=>s.c==='bear'||s.c==='strong-bear').length;
  const adxValForBias = Number(adxR?.adx || 0);
  const choppyBias = SwingPlan.isChoppy({price, r1, s1, rsi:rsiV, adx:adxValForBias});   /* shared with the screener */
  let bias = 'Sideways', biasClass='neutral', biasIcon='↔';
  /* Guard null levels: null*1.002 is 0, so "price > r1*1.002" used to pass whenever R1 was missing. */
  const biasE50Ok = Number.isFinite(e50) && e50 > 0;
  const biasR1Ok = r1 != null && Number.isFinite(+r1) && +r1 > 0, biasS1Ok = s1 != null && Number.isFinite(+s1) && +s1 > 0;
  if(!choppyBias && rawBiasScore >= 3 && biasE50Ok && price > e50 && (adxValForBias >= 16 || (biasR1Ok && price > r1*1.002) || (Number.isFinite(e20) && e20 > e50))) { bias='Bullish'; biasClass='bull'; biasIcon='▲'; }
  else if(!choppyBias && rawBiasScore <= -3 && biasE50Ok && price < e50 && (adxValForBias >= 16 || (biasS1Ok && price < s1*0.998) || (Number.isFinite(e20) && e20 < e50))) { bias='Bearish'; biasClass='bear'; biasIcon='▼'; }

  /* Trade plan values — exact match with Strategy tab > Trade Setups This Week */
  const strategyPlan = await getStrategyTradePlan(sym, name, bias);
  if(strategyPlan?.bias){
    bias = strategyPlan.bias;
    biasClass = bias==='Bullish' ? 'bull' : bias==='Bearish' ? 'bear' : 'neutral';
    biasIcon  = bias==='Bullish' ? '▲' : bias==='Bearish' ? '▼' : '↔';
  }
  let entryZone = strategyPlan?.entry || 'Wait for setup confirmation';
  let entryForShare = entryZone;
  let stopLoss = strategyPlan?.stopLoss;
  let stopLoss2 = strategyPlan?.stopLoss2;
  let target1 = strategyPlan?.target1;
  let target2 = null;
  const setupSourceLabel = strategyPlan?.setupName || 'Trade Setup This Week';
  const setupRationale = strategyPlan?.rationale || 'Matches the Strategy tab trade setup.';
  let invalidCondition;
  if(bias==='Bullish') {
    invalidCondition = `Setup invalid if price closes below ${fmt(stopLoss)} or the Strategy tab trade setup changes.`;
  } else if(bias==='Bearish') {
    invalidCondition = `Setup invalid if price closes above ${fmt(stopLoss)} or the Strategy tab trade setup changes.`;
  } else {
    invalidCondition = `No trade until the Strategy tab gives a clear long/short setup with entry, target and stop loss.`;
  }

  const derivedRR = deriveSwingRiskReward({bias, price, stopLoss, target1, target2, e20, e50, r1, r2, s1, s2, C, H, L, atr});
  /* Breakout-type plans are entered at their trigger level, so R:R is measured from max(price, trigger) -
     the shared engine's setupRR rule, identical to the screener. */
  const rrFromPrice = (bias === 'Bullish' && /breakout/i.test(strategyPlan?.setupName || '') && Number.isFinite(+strategyPlan?.entryPrice)) ? Math.max(price, +strategyPlan.entryPrice) : price;
  const planRR = calcTradePlanRiskReward({bias, price: rrFromPrice, stopLoss, stopLoss2, target1, target2, atr});
  const rrData = planRR.valid
    ? {...derivedRR, rr:planRR.rr, risk:planRR.risk, reward:planRR.reward, stop:planRR.stop, target:planRR.target, stopAtr:planRR.stopAtr, stopNote:'Strategy tab stop loss', targetNote:`Strategy tab ${planRR.targetLabel}`, rrTargetLabel:planRR.targetLabel}
    : {rr:0, stop:planRR.stop || stopLoss || null, target:null, risk:planRR.risk || 0, reward:0, atr, stopAtr:planRR.stopAtr || null, stopNote:'Strategy tab stop loss', targetNote:planRR.note || 'Strategy target invalid', rrTargetLabel:'Wait'};
  const rrNumResolved = rrData.rr || 0;
  const rr = rrData.rr ? rrData.rr.toFixed(2) + ':1' : 'Wait';

  /* Warning signs + reject rules. This stays local and uses already-loaded data only. */
  let warnings=[];
  /* c:'bear' = adverse for THIS trade (costs confidence), c:'bull' = favourable. A short at resistance or a
     long at support is the textbook entry, not a risk. */
  const advLong = bias === 'Bearish' ? 'bull' : 'bear', advShort = bias === 'Bearish' ? 'bear' : 'bull';
  if(rsiV >= 70) warnings.push({t:'RSI overbought',d:`RSI ${fmt(rsiV,1)} — fresh long entry is risky`,c:advLong});
  if(rsiV <= 30) warnings.push({t:'RSI oversold',d:`RSI ${fmt(rsiV,1)} — fresh short entry is risky`,c:advShort});
  const nearestResistanceVal = Number(nearestResistance?.v ?? (+r1 > price ? r1 : NaN));
  const nearestSupportVal = Number(nearestSupport?.v ?? (+s1 > 0 && +s1 < price ? s1 : NaN));
  if(Number.isFinite(nearestResistanceVal) && Math.abs(price-nearestResistanceVal)/price*100 < 0.75) warnings.push({t:'Near resistance',d:`Price is close to ${nearestResistance?.n || 'nearest resistance'} ${fmt(nearestResistanceVal)}`,c:advLong});
  if(Number.isFinite(nearestSupportVal) && Math.abs(price-nearestSupportVal)/price*100 < 0.75) warnings.push({t:'Near support',d:`Price is close to ${nearestSupport?.n || 'nearest support'} ${fmt(nearestSupportVal)}`,c:advShort});
  if(Number.isFinite(volBlend) && volBlend < .75) warnings.push({t:'Weak volume',d:`Blended volume only ${(volBlend*100).toFixed(0)}% of 20D average`,c:'neutral'});
  if((dr.c?.includes('bull') && wr.c?.includes('bear')) || (dr.c?.includes('bear') && wr.c?.includes('bull'))) warnings.push({t:'Daily/weekly mismatch',d:'Trend is mixed across timeframes',c:'neutral'});
  /* IV is options-specific, so it is deliberately not used in stock swing qualification. */
  const newsItems = AI_CACHE[`news_${sym}`]?.items||[];
  const newsBear  = newsItems.filter(i=>i.s==='bear').length;
  if(newsBear >= 2) warnings.push({t:'News risk',d:`${newsBear} bearish news items loaded`,c:advLong});
  /* RS helps longs when the stock leads Nifty and helps shorts when it lags; only the opposite case is a warning. */
  if(relStrength && Number.isFinite(+relStrength.rs3m) && (bias === 'Bullish' || bias === 'Bearish')) warnings.push({t: relStrength.rs3m > 0 ? (bias === 'Bearish' ? 'Stronger than Nifty' : 'Relative strength') : (bias === 'Bearish' ? 'Weaker than Nifty' : 'Lagging Nifty'), d:`3M: stock ${relStrength.stock3m}% vs Nifty ${relStrength.nifty3m}% (RS ${relStrength.rs3m > 0 ? '+' : ''}${relStrength.rs3m}%)${Number.isFinite(+relStrength.rs6m) ? ` · 6M RS ${relStrength.rs6m > 0 ? '+' : ''}${relStrength.rs6m}%` : ''}`, c: (relStrength.rs3m > 0) === (bias !== 'Bearish') ? 'bull' : 'bear'});
  if(bias === 'Bullish' && marketRegime && marketRegime.allowReady === false) warnings.unshift({t:`Market ${marketRegime.status}`, d: marketRegime.note || 'No fresh swing longs', c:'bear'});
  if(resultsSoon) warnings.unshift({t:'Results soon',d:`Quarterly results ${resultsSoon.date === istDateKey() ? 'today' : `on ${resultsSoon.date} (${resultsSoon.tradingDaysUntil} trading day${resultsSoon.tradingDaysUntil===1?'':'s'})`} — gap risk, avoid a fresh swing entry`,c:'bear'});
  const warnSeen = new Set();
  warnings = warnings.filter(w => { const k = `${w.t}|${w.d}`; if(warnSeen.has(k)) return false; warnSeen.add(k); return true; });

  /* Corrected Fresh Entry Score — hold score is calculated separately after entry */
  const rrNum = rrNumResolved;
  const priceLocationForSetup = getPriceLocationSnapshot(srLevels);
  const setupInfo = classifyTradeSetup({bias, price, e20, e50, e200, rsiV, macdD, volRatio:volBlend, r1, s1, r2, s2, rrNum, priceLocation:priceLocationForSetup, C, H, L, O, planSetup: strategyPlan?.isActive ? strategyPlan.setupName : ''});
  /* News/calendar/earnings are manual checks and are not part of Fresh Entry Score. */
  const swingSnap = buildSwingDecisionSnapshot(sym, {bias, setupInfo, rrNum, rrData, warnings, rawBiasScore, bullCt, bearCt, volRatio, volBlend, r1, s1, r2, s2, atr, stopLoss, target1, target2, priceLocation:priceLocationForSetup});
  const holdSnap = buildSwingHoldSnapshot(sym, {bias, price, prev, e20, e50, e200, stopLoss, volRatio:volBlend, rsiV, macdD, swingSnap, warnings});
  swingSnap.holdSnap = holdSnap;
  AI_CACHE[`decision_snap_${sym}`] = {price, snap:swingSnap, ts:Date.now()};
  const quality = swingSnap.rows;
  const qScore = swingSnap.score100;
  const grade = swingSnap.grade;
  const gradeClass = swingSnap.gradeClass;

  /* No-trade filter + qualification layer — only critical combinations block. */
  const rejectRules=[];
  let rejectScore = 0;
  const addReject = (msg, weight=1) => { rejectRules.push(msg); rejectScore += weight; };

  /* Critical: bad RR only if a setup exists but reward is too small. Missing RR becomes a warning, not automatic NO TRADE. */
  if(rrNum && rrNum < 1.0) addReject(`Risk–Reward only ${rr}; below 1:1 is not acceptable`, 3);
  else if(rrNum && rrNum < SWING_MIN_RR) addReject(`Risk–Reward only ${rr}; minimum active-trade RR is 1.25:1`, 1);
  else if(!rrNum) addReject('Risk–Reward is not available yet — treat as wait/confirm, not hard rejection', 1);

  /* Soft filters: neutral/sideways markets should reduce confidence, not kill every trade. */
  if(bias==='Sideways') addReject('Bias is sideways — need breakout/breakdown confirmation', 1);
  if(qScore < 35) addReject(`Swing quality score is very weak: ${qScore}/100`, 3);

  const nearResistance = bias==='Bullish' && Number.isFinite(nearestResistanceVal) && Math.abs(price-nearestResistanceVal)/price*100 < 0.5;
  const nearSupport = bias==='Bearish' && Number.isFinite(nearestSupportVal) && Math.abs(price-nearestSupportVal)/price*100 < 0.5;
  if(nearResistance) addReject('Bull trade is very close to resistance', 2);
  if(nearSupport) addReject('Bear trade is very close to support', 2);
  if(Number.isFinite(volBlend) && volBlend < .6) addReject('Volume confirmation is very weak', 2);
  else if(volBlend && volBlend < .75) addReject('Volume confirmation is weak', 1);
  /* News stays as a warning only. It should not automatically convert every setup into NO TRADE. */

  const readyGate = buildReadyGate({bias, setupInfo, rrNum, qScore, price, e20, e50, e200, rsiV, adxR, volBlend, dr, wr, r1, s1, r2, s2, priceLocation:priceLocationForSetup, C, H, L, resultsSoon, planSetupName: strategyPlan?.isActive ? strategyPlan.setupName : '', regime: marketRegime, rs: relStrength, sectorStr: swingCtx?.sectorStrength || null});
  readyGate.reasons.forEach(r => addReject(`Ready Gate: ${r}`, /sideways|no active strategy trigger|rr not available/i.test(r) ? 2 : 1));
  let setupInfoForDecision = readyGate.passed ? setupInfo : {
    ...setupInfo,
    action: readyGate.soft ? 'CONFIRM' : 'WAIT',
    simple: readyGate.passed ? setupInfo?.simple : readyGate.summary,
    note: readyGate.summary
  };

  const fatalReject = (rrNum && rrNum < 1.0) || qScore < 45 || bias === 'Sideways';
  /* A soft (CONFIRM) gate already says "forming, not ready"; its reasons must not also add up to a WAIT badge. */
  const hardReject = fatalReject || (rejectScore >= 7 && !readyGate.soft);
  const warningPenalty = Math.min(15,
    (warnings.filter(w=>w.c==='bear').length * 8) +
    (warnings.filter(w=>w.c==='neutral').length * 3)
  );
  let confidence = Math.round(
    Math.max(0, Math.min(100,
      (qScore * 0.55) +
      (Math.min(Math.max(rrNum,0),2.5) / 2.5 * 25) +
      (Math.min(Math.abs(rawBiasScore),8) / 8 * 20) -
      warningPenalty
    ))
  );
  /* Confidence (score + R:R + trend strength - warnings) is part of the Ready Gate, not a hidden second
     filter: a gate that PASSED but low confidence used to show "Gate PASSED" next to "WATCH". */
  /* Confidence is shown, but it no longer blocks READY: it re-weighs the score, R:R and the warnings that the
     gate already checks, and the screener never used it - so it made the Overview silently stricter. */
  /* Shown as calculated. It used to be capped at 69 whenever the gate did not pass (54 on a hard reject), so a
     90+ setup held by one check always read "69" - the gate label and the missing-checks list already say
     why it is not READY. */

  const simpleDecision = makeSimpleEntryDecision({bias, setupInfo:setupInfoForDecision, hardReject, confidence, rejectRules});
  const finalSetupPill = buildFinalSetupPill(setupInfoForDecision, simpleDecision);
  const {decisionClass, decisionMain, actionBadge, actionBadgeSub, actionLine} = simpleDecision;
  OVERVIEW_VERDICT[sym] = {action: actionBadge, gate: readyGate.label, bias, setup: strategyPlan?.setupName || '', confidence, score: qScore,
    reasons: readyGate.reasons.slice(), classified: setupInfo?.label || '', rr: rrNum,
    reason: actionBadge === 'READY' ? '' : (readyGate.passed ? simpleDecision.miniReason : readyGate.summary) || actionBadgeSub || '', ts: Date.now()};
  const biasDetailClass = bias==='Bullish' ? 'bull' : bias==='Bearish' ? 'bear' : 'neutral';
  const entryDetailClass = decisionClass==='qualified' ? 'bull' : decisionClass==='reject' ? 'bear' : 'neutral';
  const setupCleanLabel = strategyPlan?.isActive ? (strategyPlan.setupName || 'Selected Strategy') : (setupInfoForDecision?.setupDetail || String(setupInfoForDecision?.label || 'No clean setup').replace(/^(READY|CONFIRM|WATCH|WAIT) · /i,''));
  const finalActionValue = actionBadge === 'READY' ? 'READY — only if price is inside/near entry zone'
    : actionBadge === 'CONFIRM' ? 'Wait for confirmation'
    : actionBadge === 'WAIT' ? 'Do not enter now'
    : 'Watchlist only';
  const activeTradeAllowed = actionBadge === 'READY';
  /* Ready on limit (same rule as the screener): a pullback / bounce plan whose only failing checks are about
     price - R:R under 1.25 from here, late from EMA20, or the Fresh Entry Score that only the R:R points keep
     under 70 (re-scored at the limit's R:R). */
  const limitPlan = (() => {
    if(activeTradeAllowed || bias !== 'Bullish' || !strategyPlan?.isActive || !/pullback|bounce/i.test(strategyPlan.setupName || '')) return null;
    const fixable = /^RR .*below 1\.25|^EMA20 entry is late|^Fresh Entry Score \d+\/100 is below 70/;
    if(!readyGate.reasons.length || !readyGate.reasons.every(r => fixable.test(r))) return null;
    const lim = SwingPlan.limitEntry(strategyPlan.setupName, price, {entry:+strategyPlan.entryPrice, stop:+stopLoss, target:+target1});
    if(!lim) return null;
    if(readyGate.reasons.some(r => /^Fresh Entry Score/.test(r))){
      const qL = buildSwingDecisionSnapshot(sym, {noCache:true, bias, setupInfo, rrNum:lim.rr, rrData:{...rrData, rr:lim.rr}, warnings, rawBiasScore, bullCt, bearCt, volRatio, volBlend, r1, s1, r2, s2, atr, stopLoss, target1, target2, priceLocation:priceLocationForSetup}).score100;
      if(!(qL >= 70)) return null;
    }
    return lim;
  })();
  if(limitPlan && OVERVIEW_VERDICT[sym]) OVERVIEW_VERDICT[sym].limit = limitPlan.price;
  /* Quick Bounce (RSI-2) on completed bars - the same function and filters as the screener's list. */
  const qbPlan = (() => {
    if(isMCXSymbol(sym) || isIndexSymbol(sym)) return null;
    const d = CUR_DATA.daily, e = getConfirmedDailyIndex(d, sym);
    const q = SwingPlan.quickBounce({ C: d.C.slice(0, e + 1), H: d.H.slice(0, e + 1), L: d.L.slice(0, e + 1) });
    if(!q?.ok) return null;
    const niftyOk = marketRegime?.aboveSma200 !== false;
    return { ...q, niftyOk, active: niftyOk && !resultsSoon };
  })();
  if(OVERVIEW_VERDICT[sym]) OVERVIEW_VERDICT[sym].quick = !!qbPlan?.active;
  const noActiveTradeText = bias === 'Sideways'
    ? 'No active trade — sideways/choppy'
    : actionBadge === 'CONFIRM'
      ? 'No active trade — wait for confirmation'
      : actionBadge === 'WAIT'
        ? 'No active trade — wait'
        : 'No active trade — watchlist only';
  const entrySub = actionBadgeSub === simpleDecision.miniReason ? actionBadgeSub : `${actionBadgeSub} · ${simpleDecision.miniReason}`;
  /* Join reason fragments once each (the same reason used to appear two or three times in one card). */
  function uniqueReasonText(txt){
    const seen = new Set(), out = [];
    String(txt||'').split(/\s·\s|\.\s+(?=[A-Z])/).map(s=>s.replace(/^Main issue:\s*/i,'').replace(/\.$/,'').trim()).filter(Boolean)
      .forEach(s => { const k = s.toLowerCase(); if(![...seen].some(x => x.includes(k) || k.includes(x))){ seen.add(k); out.push(s); } });
    return out.join(' · ');
  }
  const topDecisionDetails = `
    <div class="tp-decision-details">
      <div class="tp-detail ${biasDetailClass}"><div class="tp-detail-label">Bias</div><div class="tp-detail-value">${bias}</div><div class="tp-detail-sub">Trend / momentum direction.</div></div>
      <div class="tp-detail ${setupInfoForDecision?.cls || 'neutral'}"><div class="tp-detail-label">Selected Setup</div><div class="tp-detail-value">${setupCleanLabel}</div><div class="tp-detail-sub">${setupInfo?.simple || setupInfo?.note || 'Setup is not clean yet.'}${readyGate.passed ? '' : ' · not active until the Ready Gate passes'}</div></div>
      <div class="tp-detail tp-decision-box ${entryDetailClass}"><div class="tp-detail-label">Decision · Ready Gate ${readyGate.label}</div><div class="tp-detail-value">${actionBadge} · ${(!readyGate.passed && readyGate.reasons.length && readyGate.reasons.every(r => /^Market /.test(r))) ? 'Stock setup is ready - held back only by the market filter' : finalActionValue}</div><div class="tp-detail-sub">${readyGate.passed ? `All Ready Gate checks passed · score ${qScore}/100 · confidence ${confidence}/100 · recheck before next-day entry.${readyGate.notes?.length ? ' ' + escHtml(readyGate.notes.join(' · ')) + '.' : ''}${bias==='Bearish' ? ' Short setup: the Screener lists long setups only.' : ''}` : `<span class="tp-missing">What is missing (${readyGate.reasons.length}):</span><ul class="tp-reasons">${readyGate.reasons.map(r=>`<li>${escHtml(r)}</li>`).join('')}</ul><span class="tp-conf">Score ${qScore}/100 · confidence ${confidence}/100 (information only)</span>`}</div></div>
    </div>`;

  const topRisk = warnings.length ? warnings.slice(0,3).map(w=>`${w.t}: ${w.d}`).join(' · ') : 'No major warning from loaded technical data. Still verify earnings, calendar events and fresh news manually.';
  const volumePressure = getVolumePressureSnapshot(sym);
  const volumePressureColor = volumePressure.cls === 'bull' ? 'var(--bull)' : volumePressure.cls === 'bear' ? 'var(--bear)' : 'var(--neu)';
  const volumePressureMini = `<div class="tp-mini"><h4>Today Volume Status</h4><p><strong style="color:${volumePressureColor}">${volumePressure.label}</strong><br>${volumePressure.note}</p></div>`;
  const priceLocation = getPriceLocationSnapshot(srLevels);
  const priceLocationColor = priceLocation.cls === 'bull' ? 'var(--bull)' : priceLocation.cls === 'bear' ? 'var(--bear)' : 'var(--neu)';
  const priceLocationMini = `<div class="tp-mini"><h4>Current Price Status</h4><p><strong style="color:${priceLocationColor}">${priceLocation.label}</strong><br>${priceLocation.note}</p></div>`;
  const goldDash = goldPetalDashboard(sym);
  const invalidationClean = invalidCondition.replace(/`/g,'');

  const compactEntryValues = (raw) => {
    const text = String(raw ?? '');
    const found = [];
    const add = (m) => {
      if(!m || !m[1]) return;
      const n = Number(String(m[1]).replace(/,/g,''));
      if(Number.isFinite(n) && n > 0 && !found.some(x => Math.abs(x-n) < 0.01)) found.push(n);
    };
    [/EMA20(?:\/resistance)?\s+([0-9,.]+)/i, /Swing\s+[RS]1\s+([0-9,.]+)/i, /EMA50\s+([0-9,.]+)/i, /above\s+([0-9,.]+)/i, /below\s+([0-9,.]+)/i].forEach(re => add(re.exec(text)));
    if(!found.length && Number.isFinite(Number(raw))) found.push(Number(raw));
    return found.slice(0,1);
  };
  const entryValsForShare = activeTradeAllowed ? compactEntryValues(entryForShare || entryZone) : [];
  const shareUrl = buildWhatsAppTradePlanUrl({
    symbol: sym,
    stockName: name,
    entry1: entryValsForShare.length ? fmt(entryValsForShare[0]) : 'Wait',
    t1: activeTradeAllowed ? fmt(rrData.target || target1) : 'Wait',
    stopLoss: activeTradeAllowed ? fmt(rrData.stop || stopLoss) : 'Wait'
  });

  const planItem = (label,val,sub='',extraClass='') => `<div class="tp-item ${extraClass}"><div class="tp-label">${label}</div><div class="tp-val">${val}</div>${sub?`<div class="tp-sub">${sub}</div>`:''}</div>`;
  const compactEntryLevels = (raw) => {
    const text = String(raw ?? '');
    const found = compactEntryValues(raw);
    if(!found.length) return text.toLowerCase().includes('wait') ? 'Wait' : 'Check Strategy tab';
    return `<div class="tp-entry-lines">${found.map((v,i)=>`<div class="tp-entry-line"><span>Entry</span><b>${fmt(v)}</b></div>`).join('')}</div>`;
  };
  const activeStopLoss = activeTradeAllowed ? (rrData.stop || stopLoss) : null;
  const activeTarget = activeTradeAllowed ? (rrData.target || target1) : null;
  const activeTargetLabel = activeTradeAllowed && rrData.rrTargetLabel && rrData.rrTargetLabel !== 'Wait' ? rrData.rrTargetLabel : 'Target';
  /* Not READY yet but a setup is planned (gate CONFIRM, or held only by results / a trigger): size it from the
     plan's entry, stop and T1 so the quantity is known before the trigger. The card says it is a plan. */
  const plannedOk = !activeTradeAllowed && strategyPlan?.isActive && ['Bullish','Bearish'].includes(bias)
    && Number.isFinite(+strategyPlan.stopLoss) && Number.isFinite(+strategyPlan.target1);
  /* Same fill as the Overview R:R (rrFromPrice): pullbacks / bounces are bought at the current price, breakouts at
     the trigger if it is above. The EMA / support level is the zone, not the fill - sizing from it understated
     the risk (e.g. stop 4 away sized as 2 away = 1.6x the chosen Risk %). */
  const plannedEntry = plannedOk ? (limitPlan ? limitPlan.price : rrFromPrice) : null;   /* a limit plan fills at the limit */
  const positionCalc = buildPositionSizeCalc(activeTradeAllowed
    ? {id:`poscalc_${sym}`, bias, price, target1:activeTarget, stopLoss:activeStopLoss, targetLabel:activeTargetLabel}
    : plannedOk
      ? {id:`poscalc_${sym}`, bias, price:plannedEntry, target1:+strategyPlan.target1, stopLoss:+strategyPlan.stopLoss, targetLabel:'T1 (planned)',
         note:`Sized from the planned ${escHtml(strategyPlan.setupName || 'setup')}${limitPlan ? ' (buy limit)' : ''}: entry ${fmt(plannedEntry)} · SL ${fmt(strategyPlan.stopLoss)} · T1 ${fmt(strategyPlan.target1)}. ${limitPlan ? 'Quantity for the buy limit - it fills only if price comes back to it.' : `Decision is ${actionBadge} - quantity only, enter when it turns READY.`}`}
      : {id:`poscalc_${sym}`, bias:'Sideways', price, target1:null, stopLoss:null, targetLabel:'Target'});
  const rejectHtml = ''; /* Removed Trade Filter Warnings card: details already exist in decision/reason fields. */
  const qHtml = quality.map(q=>`<div class="tp-qrow"><div><strong>${q.name}</strong><span>${q.note}</span></div><b>${q.pts}/${q.max}</b></div>`).join('');
  const holdHtml = holdSnap.rows.map(q=>`<div class="tp-qrow"><div><strong>${q.name}</strong><span>${q.note}</span></div><b>${q.pts}/${q.max}</b></div>`).join('');
  const compactEntry = activeTradeAllowed ? compactEntryLevels(entryZone) : noActiveTradeText;
  const displayRR = activeTradeAllowed ? rr : 'Wait';
  const displayRRSub = activeTradeAllowed ? (rr==='Wait'?'Invalid / wait':rrNum>=SWING_MIN_RR?'Current-price RR acceptable':'Current-price RR weak') : 'No active setup';
  const trendClass = (dr.c?.includes('bull') && wr.c?.includes('bull')) ? 'bull' : (dr.c?.includes('bear') && wr.c?.includes('bear')) ? 'bear' : 'neutral';
  const trendCombo = `<div class="tp-trend-combo"><span>Daily: <b>${dr.l}</b></span><span>Weekly: <b>${wr.l}</b></span></div>`;
  const trendSub = trendClass === 'bull' ? 'Both timeframes support long bias' : trendClass === 'bear' ? 'Both timeframes support short bias' : 'Mixed / neutral confirmation';
  const scoreMini = `
    <div class="tp-score-mini-grid">
      <div class="tp-score-mini ${gradeClass}"><div class="tp-score-mini-label">Fresh Entry</div><div class="tp-score-mini-val">${qScore}/100</div><div class="tp-score-mini-sub">${grade}</div></div>
      <div class="tp-score-mini ${holdSnap.gradeClass}"><div class="tp-score-mini-label">Hold Score ${bias==='Bearish'?'(if short)':bias==='Bullish'?'(if long)':''}</div><div class="tp-score-mini-val">${holdSnap.score100}/100</div><div class="tp-score-mini-sub">${holdSnap.grade}${activeTradeAllowed?'':' · only for an existing position'}</div></div>
    </div>`;

  return `
    ${qbPlan ? `<div class="tp-limit-card tp-qb-card${qbPlan.active ? '' : ' paused'}">
      <div class="tp-limit-head"><span class="pl-tag ${qbPlan.active ? 'ready' : 'low'}">QUICK BOUNCE · RSI-2 ${qbPlan.rsi2}</span> ${qbPlan.active ? `Buy near <b>₹${fmt(qbPlan.close)}</b>` : 'Paused'}</div>
      <div class="tp-limit-sub">${qbPlan.active
        ? `Short dip in an uptrend: close above its 50-day (${fmt(qbPlan.sma50)}) and 200-day (${fmt(qbPlan.sma200)}) averages, 2-day RSI ${qbPlan.rsi2} (under 10). Buy at the next open, stop ₹${fmt(qbPlan.stop)} (2.5 × ATR), sell at the first close above the 5-day average (₹${fmt(qbPlan.sma5)} today - it moves every day) or after 10 trading days. Separate from the swing plan below. Backtest: about 2 in 3 trades win, +0.3% a trade after costs, 3-4 days.`
        : `RSI-2 is ${qbPlan.rsi2}, but the setup is paused: ${!qbPlan.niftyOk ? 'Nifty is below its 200-day average' : 'results are due within 5 trading days'}.`}</div>
      ${qbPlan.active ? buildPositionSizeCalc({id:`poscalc_qb_${sym}`, bias:'Bullish', price:qbPlan.close, target1: qbPlan.sma5 > qbPlan.close ? qbPlan.sma5 : qbPlan.close + qbPlan.atr, stopLoss:qbPlan.stop, targetLabel:'5-day avg (est.)', note:'Sized from the Quick Bounce stop (2.5 × ATR). The exit is the first close above the 5-day average, so the gain shown is an estimate.'}) : ''}
    </div>` : ''}
    ${limitPlan ? `<div class="tp-limit-card">
      <div class="tp-limit-head"><span class="pl-tag ready">READY ON LIMIT</span> Buy limit <b>₹${fmt(limitPlan.price)}</b></div>
      <div class="tp-limit-sub">Every check passes except price: do not buy at the market (₹${fmt(price)}, R:R ${rrNum ? rrNum.toFixed(2) : '--'}). A buy limit at ₹${fmt(limitPlan.price)} - between today's price and the ${escHtml(strategyPlan.setupName)} level ${fmt(limitPlan.zone)} - gives R:R ${limitPlan.rr.toFixed(2)} with SL ${fmt(limitPlan.stop)} and T1 ${fmt(limitPlan.target)}. It fills only if price comes back; cancel it if price closes below the SL first, or if results are announced before it fills. Book 50% at T1 and trail the rest (exit plan below).</div>
    </div>` : ''}
    <div class="tp-decision ${decisionClass}">
      <div class="tp-decision-top">
        <div>
          <div class="tp-decision-label">Swing Trade Decision</div>
          <div class="tp-decision-main">${decisionMain}</div>
        </div>
        <div class="tp-action-badge">
          <div class="tp-action-word">${actionBadge}</div>
          <div class="tp-action-lbl">${actionBadgeSub}</div>
          <div class="tp-action-lbl" title="Score = Fresh Entry Score (the gate needs 70+). Confidence = 55% score + 25% R:R + 20% trend strength, minus warnings, so it is usually below the score.">Score ${qScore}/100 · Confidence ${confidence}/100</div>
        </div>
      </div>
      ${topDecisionDetails}
      <div class="tp-summary">${actionLine}</div>
      ${rejectHtml}
    </div>

    ${goldDash}
    <div class="trade-plan-card ${biasClass}">
      <div class="tp-head">
        <div class="tp-head-main">
          <div class="tp-kicker-row">
            <div class="tp-kicker">Trade Plan</div>
            <div class="tp-actions">
              <button type="button" class="tp-share-btn tp-alert-btn" onclick="openAlertPopup(${jsArg(sym)}, ${jsArg(isMCXSymbol(sym) ? {} : {limit:limitPlan ? limitPlan.price : null, entry:+strategyPlan?.entryPrice || null, sl:+stopLoss || null, t1:+target1 || null})})" title="Price alert for ${escHtml(name)}" aria-label="Set a price alert">🔔${ALERTS.some(a => a.sym === sym && !a.triggered) ? '<i class="tp-alert-dot"></i>' : ''}</button>
              <a class="tp-share-btn" href="${shareUrl}" target="_blank" rel="noopener" title="Share trade plan on WhatsApp" aria-label="Share trade plan on WhatsApp">💬</a>
            </div>
          </div>
          <div class="tp-title">${escHtml(name)}</div>
          <div style="font-size:.75rem;color:var(--acc);font-weight:800;margin-top:4px">Selected Strategy: ${activeTradeAllowed ? setupSourceLabel : (actionBadge === 'CONFIRM' ? 'No active strategy — CONFIRM first' : 'No active strategy — WAIT')}</div>
        </div>
      </div>

      <div class="tp-grid tp-exec-grid">
        ${activeTradeAllowed ? `
        ${planItem('Stop Loss', fmt(activeStopLoss), 'Active Strategy SL', 'stop-loss plan-stop')}
        ${planItem('Entry Zone', compactEntry, '', 'entry-zone')}
        ${planItem('Target', fmt(activeTarget), activeTargetLabel, 'plan-target')}
        ${planItem('Daily + Weekly Trend', trendCombo, trendSub, trendClass)}
        ${planItem('Risk–Reward', displayRR, displayRRSub, '')}` : `
        ${planItem(noActiveTradeText.replace(/^No active trade — /,'No active trade · '), (strategyPlan?.isActive && Number.isFinite(+strategyPlan.stopLoss) && Number.isFinite(+strategyPlan.target1))
            ? `<span class="tp-planned">Planned ${escHtml(strategyPlan.setupName || 'setup')}: buy ${fmt(rrFromPrice)}${Math.abs(rrFromPrice - (+strategyPlan.entryPrice || rrFromPrice)) > 0.005 && !/breakout/i.test(strategyPlan.setupName || '') ? ` (zone ${fmt(strategyPlan.entryPrice)})` : ''} · SL ${fmt(strategyPlan.stopLoss)} · T1 ${fmt(strategyPlan.target1)}${rrNum ? ` · R:R ${rr}` : ''}</span>`
            : 'No entry, stop or target until a setup is confirmed', 'Levels become active only when the decision is READY.', 'is-wait tp-wide')}
        ${planItem('Daily + Weekly Trend', trendCombo, trendSub, trendClass)}`}
        ${activeTradeAllowed && strategyPlan?.setup?.exit ? planItem('Exit Plan', `T2 ${escHtml(strategyPlan.setup.target2 || '--')} · trail ${escHtml(strategyPlan.setup.trailStop || '--')}`, escHtml(strategyPlan.setup.exit.replace(/^Exit plan:\s*/,'')), 'plan-exit') : ''}
      </div>
      ${scoreMini}
      ${positionCalc}
      <div class="tp-status-grid">
        ${priceLocationMini}
        ${volumePressureMini}
      </div>
    </div>`;
}


/* ══════════════════════════════════════════════════════════════════
   ANALYSIS TAB — pick Indicators / Trend / Patterns / S&R / Fibonacci
══════════════════════════════════════════════════════════════════ */
let ANALYSIS_VIEW = 'indicators'; /* remembered between tab switches */

async function tabAnalysis(sym) {
  const tc = document.getElementById('tc');
  const isIndex = isIndexSymbol(sym);

  /* Strategy and Decision moved inside Analysis to keep the bottom tab bar clean. */
  /* Trend lives at the top of Indicators; Validation checks live under Decision (they showed the same
     score breakdowns twice). */
  if(ANALYSIS_VIEW === 'trend') ANALYSIS_VIEW = 'indicators';
  if(ANALYSIS_VIEW === 'validity') ANALYSIS_VIEW = 'decision';
  /* Candle patterns live inside S&R (one page for levels, the latest candle and its patterns). */
  if(ANALYSIS_VIEW === 'patterns') ANALYSIS_VIEW = 'sr';
  /* Indices: the Strategy page is only the Option Builder, and only where options trade (Nifty, Bank Nifty,
     FinNifty). MCX: no Strategy / Decision pages - the Overview card carries the MCX plan. */
  const hasOptions = isIndex && !!IDX_OPT[sym];
  const views = isIndex ? [
    {id:'pulse',      label:'Market Pulse'},
    {id:'indicators', label:'Indicators'},
    {id:'sr',         label:'S&R + Patterns'},
    ...(hasOptions ? [{id:'strategy', label:'Option Builder'}] : []),
  ] : isMCXSymbol(sym) ? [
    {id:'indicators', label:'Indicators'},
    {id:'sr',         label:'S&R + Patterns'},
  ] : [
    {id:'indicators', label:'Indicators'},
    {id:'sr',         label:'S&R + Patterns'},
    {id:'strategy',   label:'Strategy'},
    {id:'decision',   label:'Decision'},
  ];

  if(!views.some(v => v.id === ANALYSIS_VIEW)) ANALYSIS_VIEW = isIndex ? 'pulse' : 'indicators';

  const btnBar = `<div class="analysis-bar analysis-bar-v14">
    ${views.map(v=>`<button class="anl-btn${ANALYSIS_VIEW===v.id?' active':''}" onclick="switchAnalysis('${v.id}')">${v.label}</button>`).join('')}
  </div>`;

  const live = tcBeginRender();
  let inner = '';
  /* Market Pulse waits for India VIX, the NSE option chain and breadth (10-20 s on a cold start): show the bar and a
     spinner meanwhile instead of a blank page. */
  if (ANALYSIS_VIEW==='pulse' && live()) tc.innerHTML = btnBar + '<div class="ls" style="display:flex;min-height:100px"><div class="sp"></div><div class="lt">Loading VIX, option chain and market breadth…</div></div>';
  if      (ANALYSIS_VIEW==='pulse')      { const idea = indexIdeaHtml(await buildIndexOptionsIdea(sym)); if(!live() || CUR_SYM !== sym) return; inner = idea + await tabPulse(sym); }
  else if (ANALYSIS_VIEW==='indicators') inner = tabTrend() + tabIndicators();
  else if (ANALYSIS_VIEW==='sr')         inner = tabSR();
  else if (ANALYSIS_VIEW==='decision')   inner = (await tabScore(sym)) + `<div class="td-merged-head">Validation checks</div>` + (await tabValidity(sym, {merged:true}));
  else if (ANALYSIS_VIEW==='strategy') {
    tc.innerHTML = btnBar + '<div class="ls" style="display:flex;min-height:100px"><div class="sp"></div></div>';
    await tabStrategy(sym);
    if(!live()) return;
    /* v17 fix: do not rewrite tc.innerHTML after tabStrategy starts loading the option result.
       Rewriting detached #opt-result and left the visible options builder stuck on loading. */
    tc.insertAdjacentHTML('afterbegin', btnBar);
    return;
  }

  if(!live() || CUR_SYM !== sym) return;
  tc.innerHTML = btnBar + inner;
}

async function switchAnalysis(view) {
  ANALYSIS_VIEW = view;
  await tabAnalysis(CUR_SYM);
}

/* ══════════════════════════════════════════════════════════════════
   MARKET INFO TAB — Sectors + Calendar + Earnings combined
══════════════════════════════════════════════════════════════════ */
async function tabMarketInfo() {
  const tc = document.getElementById('tc');
  /* On a stock / index / MCX page this tab is about THAT instrument: its news and its sector. Market-wide
     pages (Calendar, Alerts) live on the top Markets page; Forward Test lives in the Screener. */
  const marketPage = document.body.classList.contains('market-mode');
  const isMcx = String(CUR_SYM || '').startsWith('MCX:');
  const views = marketPage ? [
    {id:'sectors',     label:'Sectors'},
    {id:'calendar',    label:'Calendar'},
    {id:'news',        label:'News'},
    {id:'alerts',      label:'Alerts'},
  ] : isMcx ? [
    {id:'news',        label:'News'},
  ] : [
    {id:'news',        label:'News'},
    {id:'sectors',     label:isIndexSymbol(CUR_SYM) ? 'Sectors' : 'Sector'},
  ];
  /* The Markets page and an instrument page each remember their own sub-tab (an instrument opens on News). */
  const want = marketPage ? tabMarketInfo._view : tabMarketInfo._instView;
  let miView = views.some(v => v.id === want) ? want : views[0].id;
  if(marketPage) tabMarketInfo._view = miView; else tabMarketInfo._instView = miView;
  const live = tcBeginRender();

  /* Sectors/Calendar used to replace the page without this bar, leaving News/Alerts/Forward Test unreachable.
     Every market sub-view now keeps the bar, plus a way back to the compact snapshot. */
  const backBtn = (document.body.classList.contains('market-mode') && typeof window.renderCompactMarketDashboardV19 === 'function')
    ? `<button class="anl-btn" onclick="tabMarketInfo._view=null;renderCompactMarketDashboardV19()">← Snapshot</button>` : '';
  /* A one-choice menu (MCX: News only) is just noise. */
  const btnBar = (views.length < 2 && !backBtn) ? '' : `<div class="analysis-bar analysis-bar-v14 market-subtabs-v14">
    ${backBtn}${views.map(v=>`<button class="anl-btn${miView===v.id?' active':''}" onclick="switchMarketInfo('${v.id}')">${v.label}</button>`).join('')}
  </div>`;

  tc.innerHTML = btnBar + '<div class="ls" style="display:flex;min-height:100px"><div class="sp"></div></div>';
  try {
    let inner = '';
    /* The sector page needs only the sector list - it used to wait for the whole market context (global
       markets, 50-stock breadth, VIX history), ~15 s on a cold start. That keeps loading in the background. */
    if      (miView==='sectors')     { preloadMarketContext().catch(()=>{}); await tabSectors(); if(!live()) return; tc.innerHTML = btnBar + tc.innerHTML; return; }
    else if (miView==='calendar')    { await tabCalendar();    if(!live()) return; tc.innerHTML = btnBar + tc.innerHTML; return; }
    else if (miView==='news')        { inner = await tabNews(CUR_SYM || 'NSE:NIFTY'); }
    else if (miView==='alerts')      { inner = tabAlerts(); }
    if(!live()) return;
    tc.innerHTML = btnBar + inner;
  } catch(e) { if(live()) tc.innerHTML = btnBar + `<div class="eb">Error: ${escHtml(e.message)}</div>`; }
}
tabMarketInfo._view = 'sectors';

async function switchMarketInfo(view) {
  if(document.body.classList.contains('market-mode')) tabMarketInfo._view = view; else tabMarketInfo._instView = view;
  await tabMarketInfo();
}

/* Override tabSectors/Calendar to prepend the button bar */
const _origTabSectors  = tabSectors;
const _origTabCalendar = tabCalendar;

async function tabSectorsWrapped() {
  await _origTabSectors();
  const tc=document.getElementById('tc');
  if(tc&&!tc.querySelector('.analysis-bar')){
    const views=[{id:'sectors',label:'🗺 Sectors'},{id:'calendar',label:'📅 Calendar'}];
    const bar=`<div class="analysis-bar">${views.map(v=>`<button class="anl-btn${tabMarketInfo._view===v.id?' active':''}" onclick="switchMarketInfo('${v.id}')">${v.label}</button>`).join('')}</div>`;
    tc.innerHTML=bar+tc.innerHTML;
  }
}

/* ── TRADE GATE CHECK — replaces useless NSE Open notification ── */
const TRADE_GATE_STATE_KEY = 'td_trade_gate_last_run_date';
const TRADE_GATE_NOTIFY_KEY = 'td_trade_gate_ready_notified';
let TRADE_GATE_RUNNING = false;

function tradeGateTodayKey(){
  return new Date(Date.now() + 5.5*3600000).toISOString().slice(0,10);
}
function tradeGateSleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function tradeGateIsMarketOpen(){
  const ist = new Date(Date.now() + 5.5*3600000);
  const min = ist.getUTCHours()*60 + ist.getUTCMinutes();
  const day = ist.getUTCDay();
  return day>=1 && day<=5 && min>=9*60+15 && min<15*60+30;
}
function tradeGateLoadedPicks(){
  const sources = [];
  /* Only the my-trade (Ready/Watchlist) screener is live; the old qualified-screener cache is never filled. */
  try { if (MY_TRADE_CACHE_UI?.picks?.length) sources.push({mode:'Ready', picks:MY_TRADE_CACHE_UI.picks}); } catch {}
  try { const m = readMyTradeScreenerCache?.(); if (m?.picks?.length) sources.push({mode:'Ready', picks:m.picks}); } catch {}

  const seen = new Set();
  const out = [];
  for (const src of sources) {
    for (const p of (src.picks || [])) {
      const sym = String(p.sym || p.ticker || '').replace(/^NSE:/,'').replace(/\.NS$/,'').trim().toUpperCase();
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      out.push({...p, sym, _gateMode:src.mode});
      if (out.length >= 20) return out;
    }
  }
  return out;
}
function tradeGateScore(p){
  return Math.round(+p.selectedStrategyScore || +p.finalQualification || +p.decisionScore || 0);
}
function tradeGatePickAction(p){
  const raw = [p.alertAction, p.selectedAction, p.action, p.finalAction, p.tradeAction, p.tradeAlert, p.alertTxt, p.setupLabel, p.label]
    .map(v => String(v || '').toUpperCase()).join(' ');
  if (/\bREADY\b/.test(raw)) return 'READY';
  if (/\bCONFIRM\b/.test(raw)) return 'CONFIRM';
  return '';
}
function tradeGateIsReady(p, q){
  const score = tradeGateScore(p);
  const price = +q?.price;
  const action = tradeGatePickAction(p);
  /* Main fix: screener cards already expose Trade Alert READY/CONFIRM.
     Do not miss those just because the numeric score field is named differently. */
  if (q && (!Number.isFinite(price) || price <= 0)) return false;
  if (p?._overviewAction && p._overviewAction !== 'READY') return false;
  const gateOk = String(p?.readyGate || '').toUpperCase() === 'PASS';
  const rrOk = !Number.isFinite(+p?.rr) || Number(p.rr) >= 1.25;
  const volOk = !Number.isFinite(+p?.volPressure) || Number(p.volPressure) >= 0.8;
  /* CONFIRM picks must pass the same gate/RR/volume checks as READY before being announced as ready
     (they used to pass on score>=55 alone). Watchlist cards are always CONFIRM with readyGate FAIL. */
  if (action === 'READY' || action === 'CONFIRM') return score >= 70 && gateOk && rrOk && volOk;
  const ss = p.strategyScores || {};
  const hasActiveStrategy = Object.values(ss).some(x => x && x.active === true && ['READY','CONFIRM'].includes(String(x.action || '').toUpperCase()));
  if (hasActiveStrategy || p.buyAlert === true) return score >= 70 && gateOk && rrOk && volOk;
  return false;
}
function notifyReadyScreenerPicks(data, mode='Screener'){
  const picks = Array.isArray(data?.picks) ? data.picks : [];
  if (!picks.length) return;
  const ready = picks.filter(p => tradeGateIsReady(p, null));
  if (!ready.length) return;
  const today = tradeGateTodayKey();
  const sig = today + '|' + mode + '|' + ready.map(p => String(p.sym || p.ticker || '').replace(/^NSE:/,'').replace(/\.NS$/,'').toUpperCase()).join(',');
  try { if (localStorage.getItem(TRADE_GATE_NOTIFY_KEY) === sig) return; } catch {}
  const top = ready.slice(0,3).map(p => `${tradeGateName({...p, sym:String(p.sym || p.ticker || '').replace(/^NSE:/,'').replace(/\.NS$/,'').toUpperCase()})} (${String(p.sym || p.ticker || '').replace(/^NSE:/,'').replace(/\.NS$/,'').toUpperCase()})`).join(', ');
  const more = ready.length > 3 ? ` +${ready.length-3} more` : '';
  sendNotification('✅ Trade Alert Ready', `${ready.length} ${mode} stock${ready.length>1?'s':''} ready/confirm: ${top}${more}`, 'bull');
  try { localStorage.setItem(TRADE_GATE_NOTIFY_KEY, sig); } catch {}
}
function tradeGateName(p){
  const sym = String(p.sym || '').toUpperCase();
  return CLIENT_NAMES?.[sym] || sym;
}
async function runTradeGateCheck(opts={}){
  if (TRADE_GATE_RUNNING) return;
  const picks = tradeGateLoadedPicks();
  if (!picks.length) {
    if (opts.manual) showToast('Trade Gate skipped', 'No screener stocks are loaded yet. Open Screener first, then run the gate check.', 'neutral');
    return;
  }
  TRADE_GATE_RUNNING = true;
  const total = picks.length;
  const delayMs = +opts.delayMs || 10000;
  sendNotification('Trade Gate Check Started', `Checking ${total} loaded screener stocks. No fake baskets, no full 271-stock scan.`, 'neutral');
  const ready = [];
  const failed = [];
  for (let i=0; i<picks.length; i++) {
    const p = picks[i];
    const sym = p.sym;
    try {
      const q = await fetchQuickPrice(`NSE:${sym}`);
      if (tradeGateIsReady(p, q)) {
        ready.push({sym, name:tradeGateName(p), score:tradeGateScore(p), price:q.price, pct:q.pct, mode:p._gateMode});
      }
    } catch(e) {
      failed.push(sym);
    }
    if (i < picks.length-1) await tradeGateSleep(delayMs);
  }
  TRADE_GATE_RUNNING = false;
  const today = tradeGateTodayKey();
  try { localStorage.setItem(TRADE_GATE_STATE_KEY, today); } catch {}

  if (ready.length) {
    const top = ready.slice(0,3).map(r => `${r.name} (${r.sym})`).join(', ');
    const more = ready.length > 3 ? ` +${ready.length-3} more` : '';
    sendNotification('✅ Trade Gate Ready', `${ready.length} loaded screener stock${ready.length>1?'s':''} ready: ${top}${more}`, 'bull');
  } else {
    const suffix = failed.length ? ` ${failed.length} symbols failed data load.` : '';
    sendNotification('No Trade Setup', `No loaded screener stock is ready for today.${suffix}`, 'neutral');
  }
}
function maybeRunTradeGateAfterScreenerLoad(){
  if (!tradeGateIsMarketOpen()) return;
  let ran = null;
  try { ran = localStorage.getItem(TRADE_GATE_STATE_KEY); } catch {}
  if (ran === tradeGateTodayKey()) return;
  setTimeout(() => runTradeGateCheck({delayMs:10000}), 1200);
}
function watchMarketHours() {
  let wasOpen = tradeGateIsMarketOpen();
  setInterval(() => {
    const isOpen = tradeGateIsMarketOpen();
    if (isOpen && !wasOpen) {
      /* No NSE Open popup. Run the useful gate check only on already loaded screener stocks. */
      runTradeGateCheck({delayMs:10000});
    }
    wasOpen = isOpen;
  }, 30000);
}




/* ── STOCK SEARCH AUTOCOMPLETE ── */
let searchTimer=null;
async function searchSuggestions(q){
  if(q.length<2){hideSugg();return;}
  try{
    const d=await apiFetch(`/api/search?q=${encodeURIComponent(q)}`);
    const box=document.getElementById('suggestions');
    if(!d.results||!d.results.length){
      box.innerHTML='<div style="padding:10px 14px;font-size:.78rem;color:var(--tx3)">No results — type symbol directly e.g. RELIANCE</div>';
      box.style.display='block';
      return;
    }
    /* Use data-* attributes — prevents apostrophes in names (Dr Reddy's, Divi's) from breaking onclick */
    box.innerHTML=d.results.map(r=>{
      const isIndex=r.type==='INDEX';
      const rawSymbol=String(r.symbol || '').replace(/[^A-Z0-9._&-]/gi,'');
      const sym=`NSE:${rawSymbol}`;
      const displayName=r.name||rawSymbol;
      return `<div class="sugg-item" data-sym="${escHtml(sym)}" data-name="${escHtml(displayName)}" data-rawsym="${escHtml(rawSymbol)}">
        <div>
          <div class="sugg-sym">${escHtml(rawSymbol)}</div>
          <div class="sugg-name">${escHtml(displayName)}</div>
        </div>
        <span class="sugg-ex" style="${isIndex?'background:rgba(0,188,212,.12);color:var(--acc)':''}">${escHtml(r.exchange||'NSE')}</span>
      </div>`;
    }).join('');
    /* Use mousedown — fires before blur/hideSugg so selection registers */
    box.querySelectorAll('.sugg-item').forEach(el=>{
      el.addEventListener('mousedown', e=>{
        e.preventDefault(); /* prevent input blur which would hide dropdown */
        const sym  = el.dataset.sym;
        const name = el.dataset.name;
        const rawSym = el.dataset.rawsym;
        hideSugg();
        closeCompactPickers();
        const sinp = document.getElementById('sinp');
        sinp.value = rawSym;
        sinp.blur();
        loadInstrument(sym, name);
      });
    });
    box.style.display='block';
  }catch(e){
    const box=document.getElementById('suggestions');
    if(box){
      box.innerHTML='<div style="padding:10px 14px;font-size:.78rem;color:var(--bear)">Search error — type symbol directly e.g. RELIANCE</div>';
      box.style.display='block';
    }
  }
}
function hideSugg(){const b=document.getElementById('suggestions');if(b)b.style.display='none';}

/* ── SWING STOCKS ── */


/* ── RENDER TAB ── */
const GLOBAL_TABS = ['sectors','calendar','marketinfo','alerts'];
async function renderTab(tab){
  const tc=document.getElementById('tc');
  if(!tc)return;
  if(!GLOBAL_TABS.includes(tab) && !CUR_DATA) return;
  const live=tcBeginRender();
  if(tab==='strategy'){ ANALYSIS_VIEW='strategy'; tab='analysis'; }
  if(tab==='score'){ ANALYSIS_VIEW='decision'; tab='analysis'; }
  if(tab==='alerts'){ tabMarketInfo._view='alerts'; tab='marketinfo'; }
  document.querySelectorAll('.tbt').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  tc.innerHTML='<div class="ls" style="display:flex;min-height:100px"><div class="sp"></div></div>';
  try{
    const needsStockMarketContext = CUR_SYM?.startsWith('NSE:') && !isIndexSymbol(CUR_SYM) && (
      tab === 'overview' || (tab === 'analysis' && ['decision','strategy'].includes(ANALYSIS_VIEW))
    );
    if(needsStockMarketContext || (isIndexSymbol(CUR_SYM) && tab === 'analysis' && !GLOBAL_DATA?.ivRank)) {
      await preloadMarketContext();
    }
    /* Regime / RS / results / sector context for stock tabs, so every tab scores with the same inputs. */
    if(CUR_SYM?.startsWith('NSE:') && !isIndexSymbol(CUR_SYM) && ['overview','analysis','score','strategy'].includes(tab)) await getSwingContext(CUR_SYM);
    if(!live()) return; /* user clicked another tab meanwhile - do not start a stale render */
    let html='';
    if(tab==='overview')         html = (isMCXSymbol(CUR_SYM) && CUR_SYM !== 'MCX:GOLDPETAL' && MCX_IDEA[CUR_SYM]) ? mcxOverviewHtml(CUR_SYM) : await tabOverview(CUR_SYM);
    else if(tab==='analysis')   { await tabAnalysis(CUR_SYM); return; }
    else if(tab==='marketinfo') { await tabMarketInfo(); return; }
    else if(tab==='indicators')  html=tabIndicators();
    else if(tab==='trend')       html=tabTrend();
    else if(tab==='patterns')    html=tabSR();
    else if(tab==='sr')          html=tabSR();
    else if(tab==='strategy')   {await tabStrategy(CUR_SYM);return;}
    else if(tab==='screener')   {await tabScreener();return;}
    else if(tab==='sectors')    {await tabSectors();return;}
    else if(tab==='calendar')   {await tabCalendar();return;}
    else if(tab==='pulse')       html=await tabPulse(CUR_SYM);
    else if(tab==='news')        html=await tabNews(CUR_SYM);
    else if(tab==='score')       html=await tabScore(CUR_SYM);
    else if(tab==='alerts')      html=tabAlerts();
    if(tab==='overview' && CUR_SYM === 'MCX:GOLDPETAL'){   /* Gold Petal keeps its accumulation dashboard below the MCX cards */
      const D = mcxData(CUR_SYM), x = buildCommodityIdea(CUR_SYM, D);
      html = mcxCalHtml(CUR_SYM) + commodityIdeaHtml(CUR_SYM, x) + mcxExtrasHtml(CUR_SYM, D, x) + html;
    }
    if(!live()) return;
    tc.innerHTML=html;
    if(tab==='overview' && isMCXSymbol(CUR_SYM) && MCX_IDEA[CUR_SYM]) mcxFillAsync(CUR_SYM);
  }catch(e){ if(live()) tc.innerHTML=`<div class="eb"><strong>Error:</strong> ${escHtml(e.message)}</div>`; }
}

/* ── LOAD INSTRUMENT (live) ── */

/* Reset options state when switching instruments */
function resetOptState(newSym) {
  OPT_STATE.strikes = [];
  OPT_STATE.lot = '';   /* will auto-load preset for new symbol */
}









function enrichLiveData(liveData){
  if(!liveData?.daily?.C?.length) throw new Error('No daily data returned by server');
  /* Keep an untouched copy of historical candles before inserting the live quote.
     S&R previous-day values must come from completed candles, not from the live-updated candle. */
  const d = liveData.daily;
  liveData._dailyHistory = {
    C:[...(d.C||[])], H:[...(d.H||[])], L:[...(d.L||[])], O:[...(d.O||[])], V:[...(d.V||[])], T:[...(d.T||[])]
  };
  /* Force all client-side tabs to use the same live price shown in the header.
     IMPORTANT: if Yahoo daily history has not rolled to the current session, do NOT overwrite
     the last completed candle. Append a live forming candle instead, otherwise previous H/L/C
     becomes one candle too old. */
  const p = Number(liveData.price);
  if(Number.isFinite(p) && d?.C?.length){
    const rawLast = d.C.length - 1;
    const pc = Number(liveData.pc);
    /* Decide by DATE whether Yahoo's last daily bar is the previous session: compare its market date with
       the live trade's market date (server sends marketTime). The old price-only test (last close within
       0.2% of previous close) duplicated today's candle on flat days and overwrote the completed candle
       on gap days. Fall back to the price test only when no timestamps are available. */
    const tz = liveData.dataSource?.timezone || 'Asia/Kolkata';
    const liveKey = marketDateKeyFromTs(liveData.marketTime, tz);
    const lastKey = marketDateKeyFromTs(d.T?.[rawLast], tz);
    const lastIsPrevSession = (liveKey && lastKey) ? lastKey < liveKey : approxSamePrice(d.C[rawLast], pc);
    const makeLiveBar = () => {
      const o = Number.isFinite(+liveData.dayOpen) ? +liveData.dayOpen : p;
      const h = Number.isFinite(+liveData.dayHigh) ? +liveData.dayHigh : Math.max(o,p);
      const l = Number.isFinite(+liveData.dayLow) ? +liveData.dayLow : Math.min(o,p);
      /* Today's NSE volume is partial during the session: project it to a full-day estimate so every
         volume-ratio check compares like with like. Raw value kept for display. */
      const rawVol = Math.round(Number(liveData.dayVol)||0);
      const isTodayNse = /^NSE:/.test(String(liveData.sym||'')) && liveKey && liveKey === istDateKey();
      const vol = isTodayNse ? projectedTodayVolume(rawVol) : rawVol;
      liveData._rawTodayVol = rawVol;
      liveData.dayVolProjected = vol !== rawVol;
      return {O:R2(o), H:R2(Math.max(h,o,p)), L:R2(Math.min(l,o,p)), C:R2(p), V:vol, T:Number(liveData.marketTime) || Math.floor(Date.parse(liveData.updatedAt||new Date())/1000)};
    };
    if(lastIsPrevSession){
      const b = makeLiveBar();
      liveData._prevSessionIdx = rawLast;
      liveData._liveSessionIdx = rawLast + 1;
      liveData._liveSessionAppended = true;
      d.O.push(b.O); d.H.push(b.H); d.L.push(b.L); d.C.push(b.C); d.V.push(b.V); d.T.push(b.T);
    }else{
      const b = makeLiveBar();
      liveData._prevSessionIdx = rawLast >= 1 ? rawLast - 1 : rawLast;
      liveData._liveSessionIdx = rawLast;
      d.C[rawLast] = b.C; d.H[rawLast] = b.H; d.L[rawLast] = b.L; d.O[rawLast] = b.O;
      if(d.V?.length) d.V[rawLast] = b.V || d.V[rawLast];
    }
    liveData.livePrice = R2(p);
  }
  const dailyRec=calcRecommend(liveData.daily);
  const weeklyRec=liveData.weekly?calcRecommend(liveData.weekly):dailyRec;
  const intraRec=liveData.intra?calcRecommend(liveData.intra):dailyRec;
  const monthlyRec=liveData.monthly?calcRecommend(liveData.monthly):null;
  liveData.daily.rec=dailyRec;
  if(liveData.weekly)liveData.weekly.rec=weeklyRec;
  if(liveData.intra)liveData.intra.rec=intraRec;
  if(liveData.monthly)liveData.monthly.rec=monthlyRec;
  liveData._cacheTs = Date.now();
  return liveData;
}

function getCachedLiveData(sym){
  /* MCX moves after NSE hours and the proxy basis is recalculated intraday. Do not show old MCX cache first. */
  if(String(sym||'').startsWith('MCX:')) return null;
  const d = DATA_CACHE[sym];
  return d && Date.now() - (d._cacheTs || 0) < DATA_CACHE_TTL ? d : null;
}


let NIFTY_BENCH_PROMISE = null;
function calcReturnPctFromCloses(C, lookback=21){
  if(!Array.isArray(C) || C.length < lookback + 1) return null;
  const last = +C[C.length-1], base = +C[C.length-1-lookback];
  if(!Number.isFinite(last) || !Number.isFinite(base) || base <= 0) return null;
  return (last - base) / base * 100;
}
function ensureNiftyBenchmarkData(){
  const cached = getCachedLiveData('NSE:NIFTY');
  if(cached?.daily?.C?.length) return Promise.resolve(cached);
  if(NIFTY_BENCH_PROMISE) return NIFTY_BENCH_PROMISE;
  NIFTY_BENCH_PROMISE = fetchLiveQuote('NSE:NIFTY')
    .then(d => enrichLiveData(d))
    .then(d => { DATA_CACHE['NSE:NIFTY'] = d; return d; })
    .catch(()=>null)
    .finally(()=>{ NIFTY_BENCH_PROMISE = null; });
  return NIFTY_BENCH_PROMISE;
}
function getRelativeStrengthVsNiftySnapshot(sym, stockCloses, direction='bull'){
  /* Prefer the server's 3-month RS (same number the Ready Gate and screener use). The old 1-month version
     only worked if NIFTY had been opened earlier in the session, otherwise it gave neutral credit. */
  const ctxRs = (typeof SWING_CTX_CACHE !== 'undefined') ? SWING_CTX_CACHE[sym]?.v?.rs : null;
  if(ctxRs && Number.isFinite(+ctxRs.rs3m)){
    const d = +ctxRs.rs3m;
    const pts = direction === 'bear' ? (d <= -10 ? 5 : d <= -3 ? 4 : d <= 0 ? 3 : d <= 3 ? 2 : 1)
                                     : (d >= 10 ? 5 : d >= 3 ? 4 : d >= 0 ? 3 : d >= -3 ? 2 : 1);
    return {pts, max:5, diff:d, note:`RS vs Nifty ${d >= 0 ? '+' : ''}${d.toFixed(1)}% over 3M (stock ${ctxRs.stock3m >= 0 ? '+' : ''}${ctxRs.stock3m}%, Nifty ${ctxRs.nifty3m >= 0 ? '+' : ''}${ctxRs.nifty3m}%)`};
  }
  const bench = DATA_CACHE['NSE:NIFTY'];
  const niftyCloses = bench?.daily?.C || [];
  const stock1m = calcReturnPctFromCloses(stockCloses, 21);
  const nifty1m = calcReturnPctFromCloses(niftyCloses, 21);
  if(stock1m == null || nifty1m == null){
    return {pts:2, max:5, diff:null, stock1m, nifty1m, note:'RS vs Nifty not loaded yet — neutral credit'};
  }
  const diff = stock1m - nifty1m;
  let pts;
  if(direction === 'bear') pts = diff <= -5 ? 5 : diff <= -2 ? 4 : diff <= 0 ? 3 : diff <= 2 ? 2 : 1;
  else pts = diff >= 5 ? 5 : diff >= 2 ? 4 : diff >= 0 ? 3 : diff >= -2 ? 2 : 1;
  const sign = diff >= 0 ? '+' : '';
  return {pts, max:5, diff, stock1m, nifty1m, note:`RS vs Nifty ${sign}${diff.toFixed(1)}% over ~1M (stock ${stock1m>=0?'+':''}${stock1m.toFixed(1)}%, Nifty ${nifty1m>=0?'+':''}${nifty1m.toFixed(1)}%)`};
}

function activeTabName(){
  /* Do not fall back to Overview when the user is on the compact Market/Crypto page.
     Auto-refresh runs in the background; it must not drag the UI back to the previous stock page. */
  if(document.body.classList.contains('market-mode')) return 'marketinfo';
  if(document.body.classList.contains('crypto-mode')) return 'cryptopulse';
  const active = document.querySelector('.tbt.active');
  if(active && active.style.display !== 'none') return active.dataset.tab || defaultMainTabForSymbol(CUR_SYM);
  return defaultMainTabForSymbol(CUR_SYM);
}

function isIndexSymbol(sym = CUR_SYM){
  const code = String(sym || '').replace('NSE:','');
  return String(sym || '').startsWith('NSE:') && NSE_INDEX_CODES.has(code);
}

function isMCXSymbol(sym = CUR_SYM){
  return String(sym || '').startsWith('MCX:');
}

function defaultMainTabForSymbol(sym = CUR_SYM){
  return isIndexSymbol(sym) ? 'analysis' : 'overview';
}

function applyInstrumentData(sym, name, liveData, opts={}){
  /* Hard stale-response guard: never let an old/previous symbol overwrite the current selected instrument. */
  if(sym !== CUR_SYM && !opts.allowStaleApply) return false;
  document.body.classList.remove('market-mode');
  document.body.classList.remove('crypto-mode');
  CUR_DATA=liveData;
  DATA_CACHE[sym]=liveData;

  const{price,chg,pct,dayOpen,dayHigh,dayLow,dayVol,updatedAt,cached}=liveData;
  const isUp=pct>=0;

  document.getElementById('ihn').textContent=name;
  const isMCXSym = sym.startsWith('MCX:');
  document.getElementById('ihx').textContent = isMCXSym
    ? `${sym} · Continuous proxy · US futures × USD/INR${/^MCX:(GOLD|GOLDPETAL|SILVER|COPPER)$/.test(sym)?' × MCX factor':''} · USD/INR: ${liveData.usdInr||'--'}`
    : `${sym} · Live · Yahoo Finance`;
  document.getElementById('ihp').textContent=fmt(price);
  const ce=document.getElementById('ihc');
  ce.textContent=`${isUp?'▲':'▼'} ${fmt(Math.abs(chg))} (${isUp?'+':''}${pct.toFixed(2)}%)`;
  ce.className=`ihc ${isUp?'up':'down'}`;
  document.getElementById('ihov').innerHTML=`<span>O: ${fmt(dayOpen)}</span><span>H: ${fmt(dayHigh)}</span><span>L: ${fmt(dayLow)}</span>${Number(dayVol)>0 && !isIndexSymbol(sym) ? `<span>Vol: ${fmtVol(dayVol)}</span>` : ''}`;
  const src = opts.fromCache ? 'Cached · refreshing' : (cached ? 'Server cache' : (liveData.forced ? 'Fresh' : 'Live'));
  document.getElementById('iht').textContent=`${src} · Updated ${new Date(updatedAt).toLocaleTimeString('en-IN')}`;

  show('ls','none');show('ih','flex');show('tbar','flex');show('tc','flex');
  const isIndexSym = isIndexSymbol(sym);
  const isStockNotIndex = sym.startsWith('NSE:') && !isIndexSym;
  const analysisBtn = document.querySelector('.tbt[data-tab="analysis"]');
  if(analysisBtn) analysisBtn.textContent = 'Analysis';
  document.querySelectorAll('.tbt').forEach(b=>{
    const t=b.dataset.tab;
    if(['strategy','score','alerts'].includes(t)) b.style.display='none';
    else if(t==='overview') b.style.display=isIndexSym?'none':'';
    else if(t==='analysis') b.style.display='';
    else if(t==='marketinfo') b.style.display='';
    else if(t==='screener') b.style.display=(isStockNotIndex ? '' : 'none');
    else b.style.display='none';
  });

  const qel=document.getElementById(`q-${sym}`);
  setSidebarQuote(qel, fmt(price), pct);
}

function precomputeScoreCache(sym, liveData){
  if (AI_CACHE[`s10_${sym}`]) return;
  try {
    const oldData = CUR_DATA;
    if (!CUR_DATA || CUR_DATA !== liveData) CUR_DATA = liveData;
    const snap = buildSwingDecisionSnapshot(sym);
    AI_CACHE[`s10_${sym}`] = { s10:snap.s10, score100:snap.score100, bull:snap.bull, bear:snap.bear, total:snap.total, ts:Date.now() };
    if (oldData && oldData !== liveData) CUR_DATA = oldData;
  } catch(e) { /* silent — Decision tab will compute on demand */ }
}

function warmSecondaryData(sym, name, liveData){
  const newsKey  = `news_${sym}`;
  const newsName = CLIENT_NAMES[sym.replace('NSE:','').replace('MCX:','')] || name;
  const cachedNews = AI_CACHE[newsKey];
  if (!cachedNews || Date.now() - (cachedNews.ts || 0) > SECONDARY_CACHE_TTL) {
    fetchLiveNews(sym, newsName)
      .then(result => {
        AI_CACHE[newsKey] = {...result, ts:Date.now()};
        if(CUR_SYM===sym && activeTabName()==='news') renderTab('news');
      })
      .catch(() => { AI_CACHE[newsKey] = { items:[], ts:Date.now() }; });
  }
  setTimeout(()=>precomputeScoreCache(sym, liveData), 0);
  if (sym.startsWith('NSE:') && !isIndexSymbol(sym)) {
    preloadMarketContext().then(()=>{
      delete AI_CACHE[`s10_${sym}`];
      const t = activeTabName();
      if(CUR_SYM===sym && !document.body.classList.contains('market-mode') && !document.body.classList.contains('crypto-mode') && ['overview','analysis','score','strategy'].includes(t)) renderTab(t);
    }).catch(()=>{});
    ensureNiftyBenchmarkData().then(()=>{
      delete AI_CACHE[`s10_${sym}`];
      const t = activeTabName();
      if(CUR_SYM===sym && !document.body.classList.contains('market-mode') && !document.body.classList.contains('crypto-mode') && ['overview','analysis','score','strategy'].includes(t)) renderTab(t);
    }).catch(()=>{});
  }
}

/* Recently viewed NSE stocks (per browser) so the Stocks sidebar is not an empty panel. */
const RECENT_STOCKS_KEY = 'td_recent_stocks';
const RECENT_PX = {};
function readRecentStocks(){ try{ const a = JSON.parse(localStorage.getItem(RECENT_STOCKS_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => x && /^NSE:[A-Z0-9&_-]+$/.test(x.sym)) : []; }catch{ return []; } }
function rememberRecentStock(sym, name){
  if(!/^NSE:/.test(String(sym)) || isIndexSymbol(sym)) return;
  const list = [{sym, name:String(name || sym.replace('NSE:',''))}, ...readRecentStocks().filter(x => x.sym !== sym)].slice(0, 8);
  try{ localStorage.setItem(RECENT_STOCKS_KEY, JSON.stringify(list)); }catch{}
  renderRecentStocks();
}
function renderRecentStocks(){
  const box = document.getElementById('recentStocks'); if(!box) return;
  const list = readRecentStocks();
  box.innerHTML = list.length ? `<div class="vt" style="margin-top:6px">Recently viewed</div>${list.map(x => `<div class="ic recent-ic" data-symbol="${escHtml(x.sym)}" data-name="${escHtml(x.name)}"><div class="icn">${escHtml(x.name)}</div><div class="ics">${escHtml(x.sym)}</div><div class="icp" id="q-${escHtml(x.sym)}">--</div></div>`).join('')}` : '';
  box.querySelectorAll('.recent-ic').forEach(c => c.addEventListener('click', () => loadInstrument(c.dataset.symbol, c.dataset.name)));
  const now = Date.now();
  list.forEach(x => {
    const c = RECENT_PX[x.sym];
    if(c && now - c.ts < 60000){ setSidebarQuote(document.getElementById(`q-${x.sym}`), fmt(c.d.price), c.d.pct); return; }
    fetchQuickPrice(x.sym).then(d => { RECENT_PX[x.sym] = {d, ts:Date.now()}; setSidebarQuote(document.getElementById(`q-${x.sym}`), fmt(d.price), d.pct); }).catch(()=>{});
  });
}
document.addEventListener('DOMContentLoaded', () => setTimeout(renderRecentStocks, 300));

async function loadInstrument(sym,name){
  /* Opened from the Screener page: switch the top menu to Stocks first (sidebar, tab bar, mode). */
  if(document.body.classList.contains('screener-mode') && /^NSE:/.test(String(sym)) && !isIndexSymbol(sym)) document.querySelector('.nbtn[data-view="stocks"]')?.click();
  try{ rememberRecentStock(sym, name); }catch{}
  closeCompactPickers();
  const seq = ++LOAD_SEQ;
  CUR_SYM=sym;
  resetOptState(sym);
  show('es','none');show('ls','flex');show('ih','none');show('tbar','none');show('tc','none');
  document.querySelectorAll('.ic,.chip').forEach(el=>el.classList.toggle('active',el.dataset.symbol===sym||el.dataset.sym===sym));
  document.getElementById('lt').textContent=`Fetching live ${name} data…`;


  const cached = getCachedLiveData(sym);
  if(cached){
    applyInstrumentData(sym, name, cached, {fromCache:true});
    warmSecondaryData(sym, name, cached);
    if(isIndexSymbol(sym)) ANALYSIS_VIEW = 'pulse';
    renderTab(defaultMainTabForSymbol(sym));
    fetchLiveQuote(sym).then(fresh => {
      if(seq !== LOAD_SEQ || CUR_SYM !== sym) return;
      fresh = enrichLiveData(fresh);
      /* Fresh data invalidates calculated tab caches but keeps news cache. */
      ['strat','pulse','score'].forEach(k=>delete AI_CACHE[`${k}_${sym}`]);
      delete AI_CACHE[`s10_${sym}`];
      applyInstrumentData(sym, name, fresh);
      warmSecondaryData(sym, name, fresh);
      let t = activeTabName();
      if(t === 'overview' && isIndexSymbol(sym)) t = 'analysis';
      if(!document.body.classList.contains('market-mode') && !document.body.classList.contains('crypto-mode') && ['overview','analysis','score','strategy'].includes(t)) renderTab(t);
    }).catch(()=>{});
    return;
  }

  try{
    let liveData=await fetchLiveQuote(sym);
    if(seq !== LOAD_SEQ || CUR_SYM !== sym) return;
    liveData=enrichLiveData(liveData);
    ['strat','pulse','score'].forEach(k=>delete AI_CACHE[`${k}_${sym}`]);
    delete AI_CACHE[`s10_${sym}`];
    applyInstrumentData(sym, name, liveData);
    warmSecondaryData(sym, name, liveData);
    if(isIndexSymbol(sym)) ANALYSIS_VIEW = 'pulse';
    await renderTab(defaultMainTabForSymbol(sym));
  }catch(err){
    if(seq !== LOAD_SEQ || CUR_SYM !== sym) return;
    show('ls','none');show('es','flex');
    document.getElementById('es').innerHTML=`<div class="eb"><strong>Failed to load ${escHtml(name)}</strong><br><span style="color:var(--tx2);font-size:.78rem">${escHtml(err.message)}</span><br><br>Check that the TradeDesk server is running.<br><button onclick="loadInstrument(${jsArg(sym)},${jsArg(name)})">↻ Retry</button></div>`;
  }
}


/* ── SIDEBAR QUICK PRICES (live) ── */
const HIDE_INDEX_IF_QUOTE_FAIL = new Set(['NSE:NIFTYPSE','NSE:NIFTYINFRA','NSE:NIFTYTOURISM','NSE:NIFTYOILGAS','NSE:NIFTYPVTBANK']);
/* Load quotes only for the list the user is looking at, and not more than once per 2 minutes per list
   (the app used to fetch every sidebar list at start-up: ~90 Yahoo calls before anything was opened). */
const VIEW_PRICES_TS = {};
function loadViewPrices(viewId, force=false){
  const view = document.getElementById(`view-${viewId}`);
  if(!view) return Promise.resolve();
  if(!force && VIEW_PRICES_TS[viewId] && Date.now() - VIEW_PRICES_TS[viewId] < 2*60*1000) return Promise.resolve();
  VIEW_PRICES_TS[viewId] = Date.now();
  return loadSidebarPrices(sym => !!view.querySelector(`.ic[data-symbol="${CSS.escape(sym)}"]`));
}
function activeViewId(){ return (document.querySelector('.view.active')?.id || 'view-indices').replace('view-',''); }
async function loadSidebarPrices(filterFn=null, retryOf=null){
  const cards=retryOf || [...document.querySelectorAll('.ic[data-symbol]')].filter(card => !filterFn || filterFn(card.dataset.symbol));
  let i=0; const failed=[];
  const worker=async()=>{
    while(i<cards.length){
      const card=cards[i++];
      const sym=card.dataset.symbol;
      try{
        /* 40 s, not the 15 s default: at start-up the Yahoo queue also carries the market data and sectors, and
           the rows in the middle of the list (Private Bank, PSU Bank, IT) used to time out and stay "--". */
        const d=await apiFetch(`/api/quickprice?sym=${encodeURIComponent(sym)}&_=${Date.now()}`, 40000);
        const el=document.getElementById(`q-${sym}`);
        setSidebarQuote(el, fmt(d.price), d.pct);
        if(HIDE_INDEX_IF_QUOTE_FAIL.has(sym)) card.style.display='';
      }catch(e){
        failed.push(card);
        if(retryOf && HIDE_INDEX_IF_QUOTE_FAIL.has(sym)){
          card.style.display='none';
          card.dataset.hiddenReason='Yahoo direct index ticker failed; hidden instead of showing fake basket data';
        }
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(4,cards.length)}, worker));
  /* One retry a few seconds later for whatever failed (the server has usually finished those fetches by then). */
  if(failed.length && !retryOf){ await new Promise(r=>setTimeout(r,4000)); await loadSidebarPrices(null, failed); }
}

/* ── MARKET STATUS ── */
function setMarketStatus(){
  const el=document.getElementById('mpill');if(!el)return;
  const ist=new Date(Date.now()+(5.5*3600000));
  const h=ist.getUTCHours(),m=ist.getUTCMinutes(),day=ist.getUTCDay(),min=h*60+m;
  if(day===0||day===6){el.textContent='Closed (Weekend)';el.className='mpill closed';return;}
  if(min>=9*60+15&&min<15*60+30){el.textContent='NSE Open';el.className='mpill open';return;}
  if(min>=9*60&&min<9*60+15){el.textContent='Pre-Open';el.className='mpill pre';return;}
  if(min>=9*60&&min<23*60){el.textContent='MCX Open';el.className='mpill open';return;}
  el.textContent='Market Closed';el.className='mpill closed';
}

/* ── AUTO REFRESH: MCX continuous proxy + NSE market hours ── */
function startAutoRefresh(){
  setInterval(()=>{
    const ist=new Date(Date.now()+(5.5*3600000));
    const min=ist.getUTCHours()*60+ist.getUTCMinutes(),day=ist.getUTCDay();
    const isWeekday=(day>=1&&day<=5);
    const isNseOpen=isWeekday&&(min>=9*60+15&&min<15*60+30);
    const isCurMcx=CUR_SYM&&String(CUR_SYM).startsWith('MCX:');
    /* MCX cards are continuous proxies from US futures × USD/INR, so keep refreshing even after MCX India closes. */
    const shouldRefreshSelected=CUR_SYM&&(isCurMcx?true:isNseOpen);

    if(shouldRefreshSelected){
      const refreshSym = CUR_SYM;
      const refreshName = document.getElementById('ihn')?.textContent || refreshSym;
      fetchLiveQuote(refreshSym).then(d=>{
        if(CUR_SYM !== refreshSym) return; /* user selected another symbol while request was running */
        const fresh=enrichLiveData(d);
        ['strat','pulse','score'].forEach(k=>delete AI_CACHE[`${k}_${refreshSym}`]);
        delete AI_CACHE[`s10_${refreshSym}`];
        DATA_CACHE[refreshSym]=fresh;
        /* Decide what the user is looking at BEFORE applying: applyInstrumentData removes market/crypto
           mode, which used to make the check below always pass and jump the user to Overview. */
        const body=document.body.classList;
        if(body.contains('market-mode') || body.contains('crypto-mode')) return; /* Markets/Crypto page: cache only */
        const activeBtn=document.querySelector('.tbt.active');
        const t = activeBtn && activeBtn.style.display !== 'none' && getComputedStyle(activeBtn).display !== 'none' ? activeBtn.dataset.tab : null;
        if(!t) return; /* Screener/Calendar/Forward Test opened without a stock tab: don't touch the page */
        applyInstrumentData(refreshSym,refreshName,fresh);
        if(CUR_SYM !== refreshSym) return;
        if(['overview','analysis','score','strategy'].includes(t)) renderTab(t);
      }).catch(()=>{});
    }

    /* MCX sidebar values must keep moving after NSE/MCX closes because they are continuous proxies. */
    if(activeViewId()==='commodities') loadViewPrices('commodities').catch(()=>{});
    else if(activeViewId()==='indices' && isNseOpen) loadViewPrices('indices').catch(()=>{});

    /* Refresh global bar less often than MCX quotes. */
    if(!startAutoRefresh._lastGlobal || Date.now()-startAutoRefresh._lastGlobal > 5*60*1000){
      startAutoRefresh._lastGlobal = Date.now();
      loadGlobalBar().catch(()=>{});
    }
    setMarketStatus();
  }, 60*1000);
}

/* ── INIT ── */


/* Compact mobile picker: hides long instrument lists until user taps category */
function setupCompactPickers(){
  const labels={indices:'Select Index',stocks:'Stock Search',commodities:'Select MCX Commodity',markets:'Global Markets'};
  document.querySelectorAll('.view').forEach(view=>{
    if(view.querySelector('.selector-toggle')) return;
    const key=(view.id||'').replace('view-','');
    const btn=document.createElement('button');
    btn.type='button';
    btn.className='selector-toggle';
    btn.innerHTML=`<span>${labels[key]||'Select'}</span><span class="sel-sub">Tap to open</span><span class="sel-arrow">⌄</span>`;
    btn.addEventListener('click',(e)=>{
      e.stopPropagation();
      const isOpen=view.classList.contains('selector-open');
      document.querySelectorAll('.view.selector-open').forEach(v=>v.classList.remove('selector-open'));
      if(!isOpen) view.classList.add('selector-open');
    });
    view.prepend(btn);
  });
}
function closeCompactPickers(){
  if(window.matchMedia('(max-width:820px)').matches){
    document.querySelectorAll('.view.selector-open').forEach(v=>v.classList.remove('selector-open'));
  }
}

document.addEventListener('DOMContentLoaded',()=>{
  setupCompactPickers();
  setMarketStatus();
  /* Throttle startup calls. Without this, sidebar + global breadth requests compete with the first stock load. */
  /* The visible list's prices go first; the heavy market context (global markets, 50-stock breadth, VIX
     history, sectors - about 110 Yahoo calls) starts once they are in, or after 12 s at most. Started together,
     the list used to fill only after ~30 s on a cold start. */
  const firstPrices = new Promise(res => setTimeout(() => loadViewPrices(activeViewId()).catch(()=>{}).finally(res), 300));
  setTimeout(()=>loadSectorMap(), 900);
  /* Preload global breadth + sectors after first paint; Fresh Entry Score should not need manual Market tab opening. */
  Promise.race([firstPrices, new Promise(r => setTimeout(r, 12000))]).then(() => preloadMarketContext().catch(()=>{}));
  startAutoRefresh(); startAlertEngine();
  watchMarketHours();
  initNotificationsOnLoad();

  /* Indices / Stocks / MCX: show the loaded instrument if it belongs to this menu, otherwise a clean
     "pick one" panel. The previous page (Markets snapshot, crypto prompt) used to stay on screen. */
  function showViewHome(view){
    const sym = String(CUR_SYM || '');
    const belongs = !!CUR_DATA && (
      view === 'commodities' ? sym.startsWith('MCX:') :
      view === 'indices' ? isIndexSymbol(sym) :
      sym.startsWith('NSE:') && !isIndexSymbol(sym));
    const es = document.getElementById('es');
    if(belongs){
      show('es','none'); show('ls','none'); show('ih','flex'); show('tbar','flex'); show('tc','flex');
      renderTab(activeTabName());
      return;
    }
    show('ls','none'); show('ih','none'); show('tbar','none'); show('tc','none'); show('es','flex');
    const copy = {
      indices: ['Select an index', 'Pick Nifty 50, Bank Nifty or any sector index from the list for trend, breadth and options view.'],
      stocks: ['Search a stock', 'Type a symbol in the search box, open a recent stock, or open the Screener (top menu) for swing candidates and the monthly momentum list.'],
      commodities: ['Select a commodity', 'Pick Gold, Gold Petal, Silver, Crude, Natural Gas or Copper from the list.']
    }[view];
    if(es && copy) es.innerHTML = `<div class="ei"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg></div><div class="et">${copy[0]}</div><div class="es2">${copy[1]}</div>`;
  }
  window.showViewHome = showViewHome;
  /* Screener page (top menu): full width, no instrument header or tab bar. */
  window.openScreenerView = function(){
    show('es','none'); show('ls','none'); show('ih','none'); show('tbar','none'); show('tc','flex');
    document.querySelectorAll('.tbt').forEach(b => b.classList.remove('active'));
    tabScreener(CURRENT_SCREENER_MODE || 'mytrade');
  };
  document.querySelectorAll('.nbtn').forEach(btn=>btn.addEventListener('click',()=>{
  if(btn.dataset.view !== 'crypto') document.body.classList.remove('crypto-mode');
  if(btn.dataset.view !== 'markets') document.body.classList.remove('market-mode');
    document.querySelectorAll('.nbtn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    const activeView=document.getElementById(`view-${btn.dataset.view}`);
    activeView?.classList.add('active');
    document.querySelectorAll('.view.selector-open').forEach(v=>v.classList.remove('selector-open'));
    if(btn.dataset.view==='commodities' || btn.dataset.view==='indices') {
      loadViewPrices(btn.dataset.view).catch(()=>{});
    }
    if(['indices','stocks','commodities'].includes(btn.dataset.view)) showViewHome(btn.dataset.view);
    if(btn.dataset.view==='screener') openScreenerView();
    if(btn.dataset.view==='markets') {
      activeView?.classList.add('selector-open');
      /* ONE render per click. Previously this handler, the v19 patch and the final snapshot patch each
         rendered the page (about 5 overlapping async renders), and the slowest one won. */
      if(window.tabMarketInfo) tabMarketInfo._view = null;
      if(typeof window.renderCompactMarketDashboardV19 === 'function') window.renderCompactMarketDashboardV19(true);
      else { preloadMarketContext(true).catch(()=>{}); showGlobalTab('marketinfo'); }
    }
  }));

  document.querySelectorAll('.ic').forEach(c=>c.addEventListener('click',()=>loadInstrument(c.dataset.symbol,c.dataset.name)));

  const grid=document.getElementById('pgrid');
  if(grid){
    POPULAR.forEach(sym=>{
      const el=document.createElement('div');el.className='chip';el.dataset.sym=`NSE:${sym}`;
      el.innerHTML=`<span>${sym}</span><span class="cs">NSE</span>`;
      el.addEventListener('click',()=>loadInstrument(`NSE:${sym}`,sym));grid.appendChild(el);
    });
  }

  const inp=document.getElementById('sinp'),go=document.getElementById('sgo');

  const doSearch=()=>{
    const raw=inp.value.trim().toUpperCase().replace(/[^A-Z0-9&.-]/g,'');
    if(!raw) return;
    hideSugg();
    closeCompactPickers();
    inp.blur();
    /* Use known name if available, else use symbol as name */
    const name = CLIENT_NAMES[raw] || raw;
    /* Handle index symbols without NSE: prefix mapping */
    const sym = NSE_INDEX_CODES.has(raw) ? `NSE:${raw}` : `NSE:${raw}`;
    loadInstrument(sym, name);
  };
  go.addEventListener('click',doSearch);
  document.getElementById('stockScreenerBtn')?.addEventListener('click', async ()=>{
    closeCompactPickers();
    /* Open screener without auto-changing selected stock/index. */
    show('es','none'); show('ls','none'); show('ih', CUR_DATA ? 'flex' : 'none'); show('tbar','flex'); show('tc','flex');
    document.querySelectorAll('.tbt').forEach(b=>{
      const t=b.dataset.tab;
      const showTab = CUR_DATA && CUR_SYM?.startsWith('NSE:') && !isIndexSymbol(CUR_SYM) && ['overview','analysis','screener','marketinfo'].includes(t);
      b.style.display = showTab ? '' : 'none';
      b.classList.toggle('active', false);
    });
    await tabScreener();
    document.getElementById('tc')?.scrollIntoView({behavior:'smooth', block:'start'});
  });
  inp.addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
  inp.addEventListener('input',()=>{
    clearTimeout(searchTimer);
    const v=inp.value.trim();
    if(v.length>=2) searchTimer=setTimeout(()=>searchSuggestions(v),300);
    else hideSugg();
  });
  inp.addEventListener('blur',()=>setTimeout(hideSugg,200));
  document.addEventListener('mousedown',e=>{if(!e.target.closest('#sinp')&&!e.target.closest('#suggestions'))hideSugg();});

  document.querySelectorAll('.mkt-row').forEach(row=>row.addEventListener('click',()=>showGlobalTab(row.dataset.globalTab||'marketinfo')));
  document.querySelectorAll('.tbt').forEach(btn=>btn.addEventListener('click',()=>renderTab(btn.dataset.tab)));
  document.addEventListener('click',e=>{
    if(e.target.closest('.ic[data-symbol], .chip')) closeCompactPickers();
  });


  document.getElementById('rb')?.addEventListener('click',()=>{
    if(CUR_SYM){
      delete DATA_CACHE[CUR_SYM];
      ['news','strat','pulse','score'].forEach(k=>delete AI_CACHE[`${k}_${CUR_SYM}`]);
      loadInstrument(CUR_SYM,document.getElementById('ihn')?.textContent||CUR_SYM);
    }
  });
});
