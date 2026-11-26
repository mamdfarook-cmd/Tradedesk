/* ══════════════════════════════════════════════════════════════════════
   Angel One data on the page (26 Nov 2026). Loaded after app.js and td-journal.js; uses their helpers.
     - Nifty -> Market Pulse: "F&O activity" (put/call ratio, OI build-up, gainers / losers, futures OI) - information only;
     - stock Overview: the exchange's circuit limits / 52-week range and, for F&O stocks, PCR, build-up and futures OI.
══════════════════════════════════════════════════════════════════════ */
const tdaNum = (v, dp = 0) => v != null && Number.isFinite(+v) ? (+v).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp }) : '—';
const tdaPct = (v, dp = 2) => v != null && Number.isFinite(+v) ? `${+v >= 0 ? '+' : ''}${(+v).toFixed(dp)}%` : '—';
const tdaTime = s => { const t = Date.parse(s); return Number.isFinite(t) ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST' : '—'; };
const tdaBig = v => !Number.isFinite(+v) ? '—' : Math.abs(v) >= 1e7 ? (v / 1e7).toFixed(2) + ' Cr' : Math.abs(v) >= 1e5 ? (v / 1e5).toFixed(2) + ' L' : tdaNum(v);

/* ── Nifty -> Market Pulse: F&O activity (information only) ── */
async function fnoActivityHtml(sym){
  if(sym !== 'NSE:NIFTY') return '';
  let d; try { d = await apiFetch('/api/fno?sym=NIFTY&market=1', 15000); } catch { return ''; }
  if(!d?.ready || !d.market) return '';
  const m = d.market, list = (rows, f) => (rows || []).length ? rows.map(f).join('') : '<div class="sc-none">none</div>';
  const bu = (t, label, cls) => `<div class="sc-grp ${cls}"><div class="sc-grp-h">${label}</div>${list(m.buildup[t], r => `<div class="tda-li"><b>${escHtml(r.sym)}</b><span>${tdaPct(r.pct)} · OI ${tdaPct(r.oi && r.oiChg != null ? r.oiChg / Math.max(1, r.oi - r.oiChg) * 100 : null, 1)}</span></div>`)}</div>`;
  const mv = (t, label, cls, oi) => `<div class="sc-grp ${cls}"><div class="sc-grp-h">${label}</div>${list(m.movers[t], r => `<div class="tda-li"><b>${escHtml(r.sym)}</b><span>${oi ? `OI ${tdaPct(r.pct)}` : tdaPct(r.pct)}</span></div>`)}</div>`;
  const oi = d.oi?.rows || [], o0 = oi.length > 10 ? oi[oi.length - 11] : oi[0], o1 = oi[oi.length - 1];
  const oiChg = oi.length >= 2 && o0 && o1 ? (o1.oi / o0.oi - 1) * 100 : null;
  return `<div class="idea-card tda-fno"><div class="idea-kicker">F&amp;O activity · Angel One · ${escHtml(tdaTime(m.at))} · information only</div>
    <div class="idea-grid" style="margin-top:6px">
      <div><span>Put/call ratio Nifty</span><b>${m.pcr.NIFTY != null ? (+m.pcr.NIFTY).toFixed(2) : '—'}</b></div>
      <div><span>Bank Nifty</span><b>${m.pcr.BANKNIFTY != null ? (+m.pcr.BANKNIFTY).toFixed(2) : '—'}</b></div>
      <div><span>Nifty futures OI (${oi.length > 10 ? '10 days' : Math.max(0, oi.length - 1) + ' days'})</span><b>${tdaPct(oiChg, 1)}</b></div>
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
  /* kept 10 minutes - only a real answer ("not connected" is asked again next time) */
  if(!d || Date.now() - d.t > 10 * 60e3){ try { d = { t: Date.now(), v: await apiFetch('/api/fno?sym=' + encodeURIComponent(name), 20000) }; if(d.v?.ready) TDA_FNO_SEEN[name] = d; } catch { return; } }
  const v = d.v; if(!v?.ready || !v.fno || CUR_SYM !== sym) return;
  const oi = v.oi?.rows || [], o0 = oi.length > 10 ? oi[oi.length - 11] : oi[0], o1 = oi[oi.length - 1];
  const parts = [];
  if(v.pcr != null) parts.push(`option PCR ${(+v.pcr).toFixed(2)}`);
  if(v.buildup) parts.push(`today: ${escHtml(v.buildup.toLowerCase().replace('built up', 'build-up'))}`);
  if(oi.length >= 2 && o0 && o1) parts.push(`futures OI ${tdaPct((o1.oi / o0.oi - 1) * 100, 1)} in ${oi.length > 10 ? 10 : oi.length - 1} days`);
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
