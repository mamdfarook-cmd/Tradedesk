/* ══════════════════════════════════════════════════════════════════════
   Angel One data on the page (26 Nov 2026). Loaded after app.js and td-journal.js; uses their helpers.
     - Screener -> "Yahoo vs Angel One": the same swing screener on Yahoo candles and on Angel One candles, a
       candle-by-candle check of the two sources and a live-price check - and the two switches (screener candles,
       live prices) so the better source can be chosen from the evidence;
     - Nifty -> Market Pulse: "F&O activity" (put/call ratio, OI build-up, gainers / losers, futures OI) - information only;
     - stock Overview: the exchange's circuit limits / 52-week range and, for F&O stocks, PCR, build-up and futures OI.
══════════════════════════════════════════════════════════════════════ */
const tdaNum = (v, dp = 0) => v != null && Number.isFinite(+v) ? (+v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—';
const tdaPct = (v, dp = 2) => v != null && Number.isFinite(+v) ? `${+v >= 0 ? '+' : ''}${(+v).toFixed(dp)}%` : '—';
const tdaTime = s => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST' : '—'; };
const tdaBig = v => !Number.isFinite(+v) ? '—' : Math.abs(v) >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(2) + ' L' : tdaNum(v);

/* ── Screener -> Yahoo vs Angel One ── */
async function tabSrcCompare(force = false){
  const tc = document.getElementById('tc'); if(!tc) return;
  const live = typeof tcGuard === 'function' ? tcGuard() : () => true;
  tc.innerHTML = `${screenerModeSwitch('srccmp')}<div class="scr-loading"><div class="sp"></div>
    <div class="lt">Running the screener on Yahoo candles and on Angel One candles…</div>
    <div class="scr-progress">Yahoo usually reuses its last scan · the Angel One scan reads the day's saved candles plus live quotes (about 20 seconds)</div></div>`;
  let d;
  try { d = await apiFetch('/api/screener-compare' + (force ? '?refresh=1' : ''), 240000); }
  catch(e){ if(live()) tc.innerHTML = `${screenerModeSwitch('srccmp')}<div class="eb"><strong>Comparison failed:</strong> ${escHtml(e.message)}</div>`; return; }
  if(!live()) return;
  if(!d.ready){
    const h = d.hist || {};
    tc.innerHTML = `${screenerModeSwitch('srccmp')}<div class="idea-card"><div class="idea-kicker">Yahoo vs Angel One</div>
      <div class="idea-title">${d.loading ? 'Loading Angel One candles' : 'Angel One not connected'}</div>
      <div class="idea-foot">${escHtml(d.note || '')}</div>
      ${d.loading ? `<div class="idea-foot">${tdaNum(h.done)} of ${tdaNum(h.total)} stocks${h.failed ? ` · ${h.failed} failed${h.lastError ? ` (${escHtml(h.lastError)})` : ''}` : ''}${h.minutesLeft != null ? ` · about ${h.minutesLeft} min left` : ''}</div>
        <div class="j-actions"><button class="idea-btn" onclick="tabScreener('srccmp')">Check again</button></div>` :
        `<div class="j-actions"><button class="idea-btn" onclick="tabScreener('trades')">Open My trades</button></div>`}</div>`;
    return;
  }
  tc.innerHTML = screenerModeSwitch('srccmp') + srcCmpHtml(d);
}
async function tdaSetPref(k, v){
  try {
    const r = await fetch(API + '/api/smartapi/prefs', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [k]: v }) });
    if(!r.ok){ const j = await r.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + r.status)); }
  } catch(e){ alert('Could not save: ' + e.message); return; }
  if(typeof clearMyTradeScreenerCache === 'function') clearMyTradeScreenerCache();
  tabScreener('srccmp');
}
function srcCmpHtml(d){
  const Y = d.yahoo, A = d.angel, ys = Y.stats || {}, as = A.stats || {}, c = d.candles || {}, pr = d.prefs || {};
  const tm = s => s.generatedAt ? tdaTime(s.generatedAt) : '—';
  const row = (label, y, a, better) => `<tr><td>${label}</td><td${better === 'y' ? ' class="sc-win"' : ''}>${y}</td><td${better === 'a' ? ' class="sc-win"' : ''}>${a}</td></tr>`;
  const okPct = s => s.attempted ? Math.round((s.dataOk || 0) / s.attempted * 100) : null, yo = okPct(ys), ao = okPct(as);
  const fb = d.sourceStats?.angel?.fallbacks || 0;
  /* what the evidence says, in one line */
  const candleVerdict = !c.checked ? 'No stock could be checked yet (Yahoo\'s copy of the candles is kept 30 minutes after a scan - press ↻ Rescan).'
    : !c.different ? `The two sources agree on all ${c.checked} stocks${c.close ? ` (${c.close} within 0.25% / a missing day)` : ''} - either one gives the screener the same picture.`
    : `${c.different} of ${c.checked} stocks differ (closes 0.25%+ apart on some days, or missing days) - often a split / bonus adjusted by one source only. See the list below before switching.`;
  const sw = (k, label, cur, help) => `<div class="tda-sw"><div><b>${label}</b><span>${help}</span></div><div class="tda-sw-btns">
    <button class="idea-btn${cur === 'yahoo' ? ' on' : ' ghost'}" ${cur === 'yahoo' ? 'disabled aria-pressed="true"' : `onclick="tdaSetPref('${k}','yahoo')"`}>${cur === 'yahoo' ? '✓ ' : ''}Yahoo</button>
    <button class="idea-btn${cur === 'angel' ? ' on' : ' ghost'}" ${cur === 'angel' ? 'disabled aria-pressed="true"' : `onclick="tdaSetPref('${k}','angel')"`}>${cur === 'angel' ? '✓ ' : ''}Angel One</button></div></div>`;
  const settings = `<div class="idea-card"><div class="idea-kicker">Which source the app uses</div>
    ${sw('candles', 'Screener &amp; Overview daily candles', pr.candles, pr.candles === 'angel' ? 'Angel One now (stocks it lacks, weekly / monthly 5-year and intraday charts stay on Yahoo).' : 'Yahoo now - the 10-year backtests were run on Yahoo candles. Switch only if the checks below show Angel One is as good or better.')}
    ${sw('live', 'Live stock prices', pr.live, pr.live === 'angel' ? 'Angel One now: the exchange\'s own price, circuit limits and 52-week range (Yahoo when Angel One fails).' : 'Yahoo now.')}
    <div class="idea-foot">Saved on the server; an upload resets them to Yahoo candles + Angel One prices (or the TD_SCREENER_CANDLES / TD_LIVE_PRICES variables on Render).</div></div>`;
  const summary = `<div class="idea-card"><div class="idea-kicker">Same screener rules · only the candles differ</div>
    <div class="j-table-wrap"><table class="j-table sc-table"><thead><tr><th></th><th>Yahoo</th><th>Angel One</th></tr></thead><tbody>
      ${row('READY', Y.ready.length, A.ready.length)}
      ${row('Watchlist', Y.watch.length, A.watch.length)}
      ${row('Stocks with full data', `${tdaNum(ys.dataOk)} / ${tdaNum(ys.attempted)}${yo != null ? ` (${yo}%)` : ''}`, `${tdaNum(as.dataOk)} / ${tdaNum(as.attempted)}${ao != null ? ` (${ao}%)` : ''}`, yo != null && ao != null && yo !== ao ? (yo > ao ? 'y' : 'a') : '')}
      ${row('Data failed / short history', `${tdaNum(ys.dataFailed)} / ${tdaNum(ys.shortHistory)}`, `${tdaNum(as.dataFailed)} / ${tdaNum(as.shortHistory)}`)}
      ${row('Scan', `${tm(ys)}${ys.reused ? ' (saved)' : ''}${ys.partial ? ' · partial' : ''}`, `${tm(as)}${as.reused ? ' (saved)' : ''}${as.ms ? ` · ${tdaNum(as.ms / 1000)} s` : ''}${as.partial ? ' · partial' : ''}`)}
      ${row('Charts from', 'Yahoo', as.chartsFromAngel || as.chartsFromYahoo ? `Angel One ${tdaNum(as.chartsFromAngel)} · Yahoo ${tdaNum(as.chartsFromYahoo)}` : '—')}
    </tbody></table></div>
    ${fb ? `<div class="idea-foot">${fb} Angel One chart request${fb > 1 ? 's' : ''} used Yahoo instead${d.sourceStats.angel.lastFallbacks?.length ? ` (e.g. ${escHtml(d.sourceStats.angel.lastFallbacks[0])})` : ''}.</div>` : ''}</div>`;
  const cCard = `<div class="idea-card"><div class="idea-kicker">Candle check · 2 years of daily candles, day by day (today excluded)</div>
    <div class="idea-title" style="font-size:.92rem">${escHtml(candleVerdict)}</div>
    <div class="j-table-wrap"><table class="j-table sc-table"><tbody>
      <tr><td>Stocks checked</td><td>${tdaNum(c.checked)}${c.noYahooCopy ? ` <span class="tda-dim">(+${c.noYahooCopy} without a Yahoo copy in memory)</span>` : ''}</td></tr>
      <tr><td>Identical (same days, closes within 0.05%)</td><td>${tdaNum(c.same)}</td></tr>
      <tr><td>Close (no day off by 0.25% or more, at most 2 days missing)</td><td>${tdaNum(c.close)}</td></tr>
      <tr><td>Different (a gap of 0.25%+ or more missing days)</td><td>${tdaNum(c.different)}</td></tr>
      <tr><td>Trading days missing in Angel One / in Yahoo</td><td>${tdaNum(c.missingInAngel)} / ${tdaNum(c.missingInYahoo)}</td></tr>
      <tr><td>Volume, Angel One ÷ Yahoo (median)</td><td>${c.volRatioMedian != null ? (+c.volRatioMedian).toFixed(3) : '—'}</td></tr>
    </tbody></table></div>
    ${(c.worst || []).length ? `<details class="tda-more"><summary>Stocks that differ (${c.worst.length})</summary><div class="j-table-wrap"><table class="j-table sc-table tda-small"><thead><tr><th>Stock</th><th>Biggest close gap</th><th>Days &gt;1%</th><th>Missing A / Y</th></tr></thead><tbody>
      ${c.worst.map(r => `<tr><td><b>${escHtml(r.sym)}</b></td><td>${(+r.maxDiff).toFixed(2)}% on ${escHtml(r.maxDay || '—')}${r.firstBig && r.over1 > 20 ? `<br><span class="tda-dim">from ${escHtml(r.firstBig)} on - looks like a split / bonus adjusted by one source only</span>` : ''}</td><td>${r.over1}</td><td>${r.onlyYahoo} / ${r.onlyAngel}${r.onlyYahooDays?.length ? `<br><span class="tda-dim">${escHtml(r.onlyYahooDays.join(', '))}</span>` : ''}</td></tr>`).join('')}
    </tbody></table></div></details>` : ''}</div>`;
  const lv = (d.live || []).filter(r => r.yahoo);
  const big = lv.filter(r => Math.abs(r.diffPct) > 0.2);
  const lCard = `<div class="idea-card"><div class="idea-kicker">Live price check · READY / Watchlist stocks, Angel One vs Yahoo</div>
    ${lv.length ? `<div class="idea-foot">${lv.length} stocks: ${big.length ? `${big.length} differ by more than 0.2% (usually Yahoo's price being a few minutes old - see the times)` : 'all within 0.2%'}.</div>
    <div class="j-table-wrap"><table class="j-table sc-table tda-small"><thead><tr><th>Stock</th><th>Angel One</th><th>Yahoo</th><th>Gap</th></tr></thead><tbody>
      ${lv.slice(0, 12).map(r => `<tr><td><b>${escHtml(r.sym)}</b>${r.uc ? `<br><span class="tda-dim">circuit ${tdaNum(r.lc, 2)}–${tdaNum(r.uc, 2)}</span>` : ''}</td><td>${tdaNum(r.angel, 2)}<br><span class="tda-dim">${escHtml(tdaTime(r.angelAt))}</span></td><td>${tdaNum(r.yahoo, 2)}<br><span class="tda-dim">${escHtml(tdaTime(r.yahooAt))}</span></td><td>${tdaPct(r.diffPct, 2)}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="idea-foot">No READY / Watchlist stock to check.</div>'}
    ${d.fx ? `<div class="idea-foot"><b>USD/INR:</b> Yahoo spot ${tdaNum(d.fx.yahoo, 4)} · Angel One ${escHtml(d.fx.contract || 'future')} ${tdaNum(d.fx.angel, 4)} (${tdaPct(d.fx.diffPct, 2)}). Angel One has only futures (a forward price), so the app keeps Yahoo's spot rate and uses the future only if Yahoo fails.</div>` : ''}</div>`;
  const cmp = (title, ya, aa) => {
    const ym = new Map(ya.map(x => [x.sym, x])), am = new Map(aa.map(x => [x.sym, x]));
    const both = ya.filter(x => am.has(x.sym)), onlyY = ya.filter(x => !am.has(x.sym)), onlyA = aa.filter(x => !ym.has(x.sym));
    const chip = (x, o) => `<button class="sc-chip" onclick="loadInstrument('NSE:${escHtml(x.sym)}','${escHtml(x.sym)}');document.querySelector('.nbtn[data-view=stocks]')?.click()" title="Open on Overview">
      <b>${escHtml(x.sym)}</b><span>${escHtml(x.setup || '')}${x.sl != null ? ` · stop ${tdaNum(x.sl, 2)}` : ''}${o && o.setup && o.setup !== x.setup ? ` · other: ${escHtml(o.setup)}` : ''}</span></button>`;
    const grp = (label, arr, other, cls) => `<div class="sc-grp ${cls}"><div class="sc-grp-h">${label} <i>${arr.length}</i></div>${arr.length ? arr.map(x => chip(x, other.get(x.sym))).join('') : '<div class="sc-none">none</div>'}</div>`;
    return `<div class="idea-card"><div class="idea-kicker">${title}</div><div class="sc-grps">${grp('On both', both, am, 'both')}${grp('Only Yahoo', onlyY, am, 'y')}${grp('Only Angel One', onlyA, ym, 'k')}</div></div>`;
  };
  const how = `<div class="idea-card"><div class="idea-kicker">How to read this</div><div class="idea-foot">
    A stock on one side only means the two sources' candles or prices differ enough to change a rule - data quality, not a better rule.
    In market hours the two scans run minutes apart, so stocks right at a rule's edge can flip with the price alone: compare after 15:30 for the cleanest read.
    Keep Yahoo candles unless the candle check shows Angel One identical or closer to the exchange (the backtests were run on Yahoo's candles).
    This page changes nothing in the normal Swing list, Overview, Track record or alerts - only the two switches above do.</div></div>`;
  return settings + cCard + summary + cmp('READY', Y.ready, A.ready) + cmp('Watchlist', Y.watch, A.watch) + lCard + how;
}

/* ── Nifty -> Market Pulse: F&O activity (information only) ── */
async function fnoActivityHtml(sym){
  if(sym !== 'NSE:NIFTY') return '';
  let d; try { d = await apiFetch('/api/fno?sym=NIFTY&market=1', 25000); } catch { return ''; }
  if(!d?.ready || !d.market) return '';
  const m = d.market, list = (rows, f) => (rows || []).length ? rows.map(f).join('') : '<div class="sc-none">none</div>';
  const bu = (t, label, cls) => `<div class="sc-grp ${cls}"><div class="sc-grp-h">${label}</div>${list(m.buildup[t], r => `<div class="tda-li"><b>${escHtml(r.sym)}</b><span>${tdaPct(r.pct)} · OI ${tdaPct(r.oi && r.oiChg != null ? r.oiChg / Math.max(1, r.oi - r.oiChg) * 100 : null, 1)}</span></div>`)}</div>`;
  const mv = (t, label, cls, oi) => `<div class="sc-grp ${cls}"><div class="sc-grp-h">${label}</div>${list(m.movers[t], r => `<div class="tda-li"><b>${escHtml(r.sym)}</b><span>${oi ? `OI ${tdaPct(r.pct)}` : tdaPct(r.pct)}</span></div>`)}</div>`;
  const oi = d.oi?.rows || [], o0 = oi.length > 10 ? oi[oi.length - 11] : oi[0], o1 = oi[oi.length - 1];
  const oiChg = o0 && o1 ? (o1.oi / o0.oi - 1) * 100 : null;
  return `<div class="idea-card tda-fno"><div class="idea-kicker">F&amp;O activity · Angel One · ${escHtml(tdaTime(m.at))} · information only</div>
    <div class="idea-grid" style="margin-top:6px">
      <div><span>Put/call ratio Nifty</span><b>${m.pcr.NIFTY != null ? (+m.pcr.NIFTY).toFixed(2) : '—'}</b></div>
      <div><span>Bank Nifty</span><b>${m.pcr.BANKNIFTY != null ? (+m.pcr.BANKNIFTY).toFixed(2) : '—'}</b></div>
      <div><span>Nifty futures OI (${oi.length > 10 ? '10 days' : oi.length + ' days'})</span><b>${tdaPct(oiChg, 1)}</b></div>
    </div>
    <details class="tda-more"><summary>Build-up and movers (near-month F&amp;O)</summary>
      <div class="sc-grps tda-grid4">${bu('Long Built Up', 'Long build-up (price ↑ OI ↑)', 'both')}${bu('Short Built Up', 'Short build-up (price ↓ OI ↑)', 'y')}${bu('Short Covering', 'Short covering (price ↑ OI ↓)', 'both')}${bu('Long Unwinding', 'Long unwinding (price ↓ OI ↓)', 'y')}</div>
      <div class="sc-grps tda-grid4">${mv('PercPriceGainers', 'Price gainers', 'both')}${mv('PercPriceLosers', 'Price losers', 'y')}${mv('PercOIGainers', 'OI gainers', 'k', true)}${mv('PercOILosers', 'OI losers', 'k', true)}</div>
      ${oi.length ? `<div class="idea-foot">Nifty ${escHtml(d.oi.expiry)} future, open interest: ${oi.slice(-6).map(r => `${escHtml(r.day.slice(5))} ${tdaBig(r.oi)}`).join(' · ')}</div>` : ''}
    </details>
    <div class="idea-foot">PCR is the put / call ratio of all strikes (Angel One). The 19 Nov 2026 backtest found no edge in it, so nothing here changes a signal.${m.errors?.length ? ` Not loaded: ${escHtml(m.errors.join('; ').slice(0, 160))}.` : ''}</div></div>`;
}

/* ── stock Overview: exchange data (Angel One) ── */
const TDA_FNO_SEEN = {};
function tdaExchCardHtml(sym){
  const e = CUR_DATA?.exch; if(!e) return '';
  const price = typeof getCurrentLivePrice === 'function' ? getCurrentLivePrice() : CUR_DATA.price;
  const toUc = e.uc && price ? (e.uc / price - 1) * 100 : null, toLc = e.lc && price ? (e.lc / price - 1) * 100 : null;
  const near = toUc != null && toUc < 2 ? `<b style="color:var(--warn)">${tdaPct(toUc, 1)} to the upper circuit</b> · ` : toLc != null && toLc > -2 ? `<b style="color:var(--warn)">${tdaPct(toLc, 1)} to the lower circuit</b> · ` : '';
  return `<div class="idea-card tda-exch" data-tda-exch><div class="idea-kicker">Exchange data · Angel One · ${escHtml(e.at || '')}</div>
    <div class="idea-grid" style="margin-top:6px">
      <div><span>Circuit limits</span><b>${tdaNum(e.lc, 2)} – ${tdaNum(e.uc, 2)}</b></div>
      <div><span>52-week range</span><b>${tdaNum(e.w52l, 2)} – ${tdaNum(e.w52h, 2)}</b></div>
      <div><span>Buy / sell queue</span><b>${tdaBig(e.buyQty)} / ${tdaBig(e.sellQty)}</b></div>
      <div><span>Average price today</span><b>${tdaNum(e.avg, 2)}</b></div>
    </div>
    <div class="idea-foot">${near}Circuit limits stop trading beyond those prices for the day. <span data-tda-fno></span></div></div>`;
}
async function tdaFnoLine(sym, el){
  const name = sym.replace(/^NSE:/, '');
  let d = TDA_FNO_SEEN[name];
  if(!d || Date.now() - d.t > 10 * 60e3){ try { d = { t: Date.now(), v: await apiFetch('/api/fno?sym=' + encodeURIComponent(name), 20000) }; TDA_FNO_SEEN[name] = d; } catch { return; } }
  const v = d.v; if(!v?.ready || !v.fno || CUR_SYM !== sym) return;
  const oi = v.oi?.rows || [], o0 = oi.length > 10 ? oi[oi.length - 11] : oi[0], o1 = oi[oi.length - 1];
  const parts = [];
  if(v.pcr != null) parts.push(`option PCR ${(+v.pcr).toFixed(2)}`);
  if(v.buildup) parts.push(`today: ${escHtml(v.buildup.toLowerCase().replace('built up', 'build-up'))}`);
  if(o0 && o1) parts.push(`futures OI ${tdaPct((o1.oi / o0.oi - 1) * 100, 1)} in ${oi.length > 10 ? 10 : oi.length - 1} days`);
  if(parts.length) el.innerHTML = `<br><b>F&amp;O:</b> ${parts.join(' · ')} <span class="tda-dim">(information only - no tested edge)</span>`;
}
function tdAngelAfterRender(tab){
  const tc = document.getElementById('tc'); if(!tc || !CUR_SYM || tab !== 'overview') return;
  const sym = CUR_SYM;
  if(!/^NSE:/.test(sym) || (typeof isIndexSymbol === 'function' && isIndexSymbol(sym)) || tc.querySelector('[data-tda-exch]')) return;
  const html = tdaExchCardHtml(sym); if(!html) return;
  tc.insertAdjacentHTML('beforeend', html);
  const el = tc.querySelector('[data-tda-exch] [data-tda-fno]'); if(el) tdaFnoLine(sym, el);
}
