/* ══════════════════════════════════════════════════════════════════════
   UI layer (no extra data calls): candle chart with the plan drawn on it, verdict line on top of the
   Overview, READY / LIMIT chips in the lists, price-tick flash. Loaded after app.js; tdAfterRender(tab) is called by
   renderTab / tabAnalysis after they write the page.
══════════════════════════════════════════════════════════════════════ */
/* Page version - shown on the market pill (tap/hover) and the Markets page, so a phone can be checked against the
   latest upload. Bump it with every page change. */
const TD_UI_VERSION = '14 Nov 2026 · 7';
const TD_PHONE = () => window.matchMedia('(max-width:820px)').matches;


/* ── Candle chart (TradingView Lightweight Charts, open source, loaded once from the CDN) ── */
const LWC_URL = 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js';
let LWC_PROMISE = null, TD_CHART = null, TD_CHART_RO = null;
function loadLwc(){
  if(window.LightweightCharts) return Promise.resolve(window.LightweightCharts);
  if(LWC_PROMISE) return LWC_PROMISE;
  LWC_PROMISE = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = LWC_URL; s.async = true;
    s.onload = () => window.LightweightCharts ? res(window.LightweightCharts) : rej(new Error('chart library missing'));
    s.onerror = () => { LWC_PROMISE = null; rej(new Error('chart library could not load')); };
    document.head.appendChild(s);
  });
  return LWC_PROMISE;
}
function tdChartOpen(){ try{ return localStorage.getItem('td_chart_open') !== '0'; }catch{ return true; } }
function tdToggleChart(){
  const open = !tdChartOpen(); try{ localStorage.setItem('td_chart_open', open ? '1' : '0'); }catch{}
  const card = document.querySelector('.td-chart-card'); if(!card) return;
  card.classList.toggle('closed', !open);
  if(open) drawTdChart(card); else destroyTdChart();
}
function destroyTdChart(){ try{ TD_CHART_RO?.disconnect(); }catch{} try{ TD_CHART?.remove(); }catch{} TD_CHART = null; TD_CHART_RO = null; }
const cssVar = (n, d) => { try{ return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d; }catch{ return d; } };
function tdEma(C, p){ const out = []; if(C.length < p) return out; const k = 2 / (p + 1); let e = C.slice(0, p).reduce((a, b) => a + b, 0) / p; out[p - 1] = e; for(let i = p; i < C.length; i++){ e = C[i] * k + e * (1 - k); out[i] = e; } return out; }
function chartCardHtml(){
  return `<div class="idea-card td-chart-card${tdChartOpen() ? '' : ' closed'}">
    <div class="td-chart-head" onclick="tdToggleChart()"><span class="idea-kicker">Chart · daily</span><span class="td-chart-legend"><i style="background:#f5c542"></i>EMA20 <i style="background:#38bdf8"></i>EMA50 <i style="background:#a78bfa"></i>EMA200</span><span class="td-chart-tg" aria-label="Show or hide the chart">▾</span></div>
    <div class="td-chart-box"></div><div class="td-chart-msg idea-foot"></div></div>`;
}
async function drawTdChart(card){
  destroyTdChart();
  const box = card?.querySelector('.td-chart-box'), msg = card?.querySelector('.td-chart-msg');
  if(!box || !CUR_DATA?.daily?.C?.length) return;
  const sym = CUR_SYM;
  let L;
  try{ L = await loadLwc(); }catch(e){ if(msg) msg.textContent = 'Chart not available offline (' + e.message + ').'; return; }
  if(CUR_SYM !== sym || !document.body.contains(box)) return;
  /* MCX levels are calibrated to the user's broker price: scale the candles the same way. */
  const k = typeof isMCXSymbol === 'function' && isMCXSymbol(sym) && typeof mcxCalK === 'function' ? mcxCalK(sym) : 1;
  const d = CUR_DATA.daily, tz = CUR_DATA.dataSource?.timezone || 'Asia/Kolkata';
  const byDay = new Map();
  for(let i = 0; i < d.C.length; i++){
    const t = +d.T?.[i], o = +d.O?.[i], h = +d.H?.[i], l = +d.L?.[i], c = +d.C?.[i];
    if(!(t > 0) || ![o, h, l, c].every(v => Number.isFinite(v) && v > 0)) continue;
    let key; try{ key = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(t * 1000)); }catch{ key = new Date(t * 1000).toISOString().slice(0, 10); }
    byDay.set(key, { time: key, open: o * k, high: h * k, low: l * k, close: c * k });
  }
  const bars = [...byDay.values()].sort((a, b) => a.time.localeCompare(b.time));
  if(bars.length < 20){ if(msg) msg.textContent = 'Not enough history for a chart.'; return; }
  const bull = cssVar('--bull', '#22c55e'), bear = cssVar('--bear', '#ef4444'), tx = cssVar('--tx2', '#9aa3b2');
  const chart = L.createChart(box, { width: box.clientWidth || 320, height: TD_PHONE() ? 240 : 300,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: tx, fontSize: 11 },
    grid: { vertLines: { color: 'rgba(255,255,255,.04)' }, horzLines: { color: 'rgba(255,255,255,.05)' } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, rightOffset: 4 },
    crosshair: { mode: 0 }, handleScroll: { vertTouchDrag: false }, localization: { priceFormatter: v => (+v).toLocaleString('en-IN', { maximumFractionDigits: 2 }) } });
  const cs = chart.addCandlestickSeries({ upColor: bull, downColor: bear, borderVisible: false, wickUpColor: bull, wickDownColor: bear });
  cs.setData(bars);
  const C = bars.map(b => b.close);
  [[20, '#f5c542'], [50, '#38bdf8'], [200, '#a78bfa']].forEach(([p, col]) => {
    const e = tdEma(C, p); if(!e.length) return;
    chart.addLineSeries({ color: col, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false })
      .setData(bars.map((b, i) => e[i] != null ? { time: b.time, value: e[i] } : null).filter(Boolean));
  });
  const line = (price, color, title, style = 2) => { if(Number.isFinite(+price) && +price > 0) cs.createPriceLine({ price: +price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }); };
  /* Plan levels: entry / stop / target 1, then the nearest support and resistance. Nifty: the rule's strikes. */
  const plan = PLAN_LEVELS[sym];
  if(plan){ line(plan.entry, cssVar('--acc', '#00bcd4'), plan.label || 'Entry', 0); line(plan.stop, bear, 'Stop'); line(plan.t1, bull, 'T1'); }
  try{ const sr = getSRTradeLevels(); line(+sr.nearestSupport?.v * k, 'rgba(34,197,94,.45)', 'S', 3); line(+sr.nearestResistance?.v * k, 'rgba(239,68,68,.45)', 'R', 3); }catch{}
  if(sym === 'NSE:NIFTY' && LAST_IDX_IDEA?.rule?.pick && !LAST_IDX_IDEA.rule.pick.none){ const p = LAST_IDX_IDEA.rule.pick; line(p.sell, '#f59e0b', `Sell ${p.ty === 'P' ? 'PE' : 'CE'}`, 2); line(p.buy, '#94a3b8', 'Buy', 3); }
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - (TD_PHONE() ? 70 : 130)), to: bars.length + 3 });
  TD_CHART = chart;
  if(window.ResizeObserver){ TD_CHART_RO = new ResizeObserver(() => { try{ chart.applyOptions({ width: box.clientWidth }); }catch{} }); TD_CHART_RO.observe(box); }
  const ruleLines = sym === 'NSE:NIFTY' && LAST_IDX_IDEA?.rule?.pick && !LAST_IDX_IDEA.rule.pick.none;
  if(msg) msg.textContent = plan ? `Lines: ${plan.label || 'entry'}, stop and T1 of the plan above; S / R = nearest support and resistance.`
    : ruleLines ? 'Lines: the sell and buy strikes of your credit-spread rule; S / R = nearest support and resistance.' : 'S / R = nearest support and resistance. No active plan to draw.';
}

/* ── Verdict line on top of the stock Overview: the answer first, the details one tap away (phones) ── */
function verdictBarHtml(v){
  if(!v) return '';
  const miss = (v.reasons || []).length, cls = v.action === 'READY' ? 'bull' : v.action === 'CONFIRM' ? 'neutral' : 'bear';
  return `<button type="button" class="td-verdict ${cls}" onclick="tdToggleDetails()" aria-label="Show or hide the decision details">
    <b>${escHtml(v.action || '')}</b><span>${v.rr ? `R:R ${(+v.rr).toFixed(2)} · ` : ''}Score ${escHtml(String(v.score ?? '--'))}${miss ? ` · ${miss} check${miss > 1 ? 's' : ''} missing` : ''}</span><i>▾</i></button>`;
}
function tdToggleDetails(){
  const d = document.querySelector('#tc .tp-decision'); if(!d) return;
  const open = d.classList.toggle('td-open');
  document.querySelector('#tc .td-verdict')?.classList.toggle('open', open);
  if(open) d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function tdAfterRender(tab){
  const tc = document.getElementById('tc'); if(!tc || !CUR_SYM) return;
  const sym = CUR_SYM, isIdx = typeof isIndexSymbol === 'function' && isIndexSymbol(sym), isMcx = typeof isMCXSymbol === 'function' && isMCXSymbol(sym);
  destroyTdChart();
  const wantChart = (tab === 'overview' && !isIdx) || (isIdx && tab === 'analysis:pulse');
  if(wantChart){
    const first = tab === 'overview' ? null : tc.querySelector('.analysis-bar, .td-analysis-bar, [class*="anl-bar"]');
    const html = chartCardHtml();
    if(first) first.insertAdjacentHTML('afterend', html); else tc.insertAdjacentHTML('afterbegin', html);
    const card = tc.querySelector('.td-chart-card');
    if(card && tdChartOpen()) drawTdChart(card);
  }
  if(tab === 'overview' && !isIdx && !isMcx){
    const v = OVERVIEW_VERDICT[sym];
    if(v){ tc.insertAdjacentHTML('afterbegin', verdictBarHtml(v)); tc.dataset.ov = 'stock'; const ih = document.getElementById('ih'); if(ih) ih.dataset.verdict = v.action || ''; }
    else delete tc.dataset.ov;
  } else {
    delete tc.dataset.ov; const ih = document.getElementById('ih'); if(ih) ih.dataset.verdict = isMcx ? (document.querySelector('[data-cidea] .idea-view')?.textContent || '') : ''; }
  refreshListChips();
}

/* (13 Nov 2026: the auto-hiding header, sticky price strip, swipe-to-change-tab and pull-to-refresh were removed at
   the user's request - the header stays fixed and pages change only from the tab bar.) */

/* ── READY / LIMIT / QUICK chips on the stock list, BUY / WAIT on MCX, PASS on Nifty - from data already on this
   device (the last screener scan, the last plans), so no extra calls. ── */
function refreshListChips(){
  let scan = null;
  try{ scan = (typeof MY_TRADE_CACHE_UI !== 'undefined' && MY_TRADE_CACHE_UI) || (typeof readMyTradeScreenerCache === 'function' ? readMyTradeScreenerCache() : null); }catch{}
  const st = {};
  if(scan){
    (scan.picks || []).forEach(x => st['NSE:' + x.sym] = { t: 'READY', c: 'ready' });
    (scan.watchlist || []).filter(x => x.limitReady && x.limitEntry).forEach(x => st['NSE:' + x.sym] = st['NSE:' + x.sym] || { t: 'LIMIT', c: 'ready' });
    (scan.quickBounce || []).forEach(x => st['NSE:' + x.sym] = st['NSE:' + x.sym] || { t: 'QUICK', c: 'watch' });
  }
  for(const [sym, lv] of Object.entries(typeof PLAN_LEVELS === 'object' ? PLAN_LEVELS : {})) if(sym.startsWith('MCX:') && lv) st[sym] = { t: lv.label === 'Sell' ? 'SELL' : 'BUY', c: lv.label === 'Sell' ? 'low' : 'ready' };
  if(typeof LAST_IDX_IDEA !== 'undefined' && LAST_IDX_IDEA?.rule) st['NSE:NIFTY'] = LAST_IDX_IDEA.rule.ok ? { t: 'RULE ✓', c: 'ready' } : { t: 'NO TRADE', c: 'low' };
  document.querySelectorAll('.ic[data-symbol]').forEach(row => {
    const s = st[row.dataset.symbol]; let chip = row.querySelector('.ic-chip');
    if(!s){ chip?.remove(); return; }
    if(!chip){ chip = document.createElement('span'); chip.className = 'ic-chip'; const p = row.querySelector('.icp'); p ? row.insertBefore(chip, p) : row.appendChild(chip); }
    if(chip.textContent !== s.t) chip.textContent = s.t;
    chip.className = 'ic-chip pl-tag ' + s.c;
  });
}
setInterval(refreshListChips, 5000);
document.addEventListener('DOMContentLoaded', () => setTimeout(refreshListChips, 1500));

/* ── Header price flash when the live price ticks ── */
(function priceFlash(){
  const start = () => {
    const el = document.getElementById('ihp'); if(!el || !window.MutationObserver) return;
    let prev = el.textContent;
    new MutationObserver(() => {
      const cur = el.textContent; if(cur === prev) return;
      const a = Number(String(prev).replace(/[^0-9.]/g, '')), b = Number(String(cur).replace(/[^0-9.]/g, ''));
      if(Number.isFinite(a) && Number.isFinite(b) && a > 0 && b > 0 && a !== b && Math.abs(b / a - 1) < 0.2){ el.classList.remove('q-flash-up', 'q-flash-dn'); void el.offsetWidth; el.classList.add(b > a ? 'q-flash-up' : 'q-flash-dn'); }
      prev = cur;
    }).observe(el, { childList: true, characterData: true, subtree: true });
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
