/* ══════════════════════════════════════════════════════════════════════
   Screener -> Yahoo vs Kite (19 Nov 2026): the same swing screener run on Yahoo data and on Zerodha Kite data,
   side by side, to see whether Kite's data finds different / better stocks. Test only: the Kite run never changes
   the normal Swing list, Overview, Track record or alerts. Loaded after app.js and uses its helpers.
══════════════════════════════════════════════════════════════════════ */
async function tabSrcCompare(force = false){
  const tc = document.getElementById('tc'); if(!tc) return;
  const live = typeof tcGuard === 'function' ? tcGuard() : () => true;
  tc.innerHTML = `${screenerModeSwitch('srccmp')}<div class="scr-loading"><div class="sp"></div>
    <div class="lt">Running the screener on Yahoo and on Zerodha Kite…</div>
    <div class="scr-progress">Yahoo usually reuses its last scan · the Kite scan takes about 2 minutes (Kite allows ~3 history requests a second)</div></div>`;
  let d;
  try { d = await apiFetch('/api/screener-compare' + (force ? '?refresh=1' : ''), 330000); }
  catch(e){ if(live()) tc.innerHTML = `${screenerModeSwitch('srccmp')}<div class="eb"><strong>Comparison failed:</strong> ${escHtml(e.message)}</div>`; return; }
  if(!live()) return;
  if(!d.ready){
    tc.innerHTML = `${screenerModeSwitch('srccmp')}<div class="idea-card"><div class="idea-kicker">Yahoo vs Zerodha Kite</div><div class="idea-title">Zerodha not connected</div>
      <div class="idea-foot">${escHtml(d.note || '')}</div><div class="j-actions"><button class="idea-btn" onclick="tabScreener('trades')">Open My trades</button></div></div>`;
    return;
  }
  tc.innerHTML = screenerModeSwitch('srccmp') + srcCmpHtml(d);
}
function srcCmpHtml(d){
  const Y = d.yahoo, K = d.kite, ys = Y.stats || {}, ks = K.stats || {};
  const num = (v, dp = 0) => Number.isFinite(+v) && v !== null ? (+v).toFixed(dp) : '—';
  const tm = s => s.generatedAt ? new Date(s.generatedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST' : '—';
  const row = (label, y, k, better) => `<tr><td>${label}</td><td${better === 'y' ? ' class="sc-win"' : ''}>${y}</td><td${better === 'k' ? ' class="sc-win"' : ''}>${k}</td></tr>`;
  const okPct = s => s.attempted ? Math.round((s.dataOk || 0) / s.attempted * 100) : null;
  const yo = okPct(ys), ko = okPct(ks);
  const fb = (d.sourceStats?.kite?.fallbacks || 0), notOn = (d.sourceStats?.kite?.notOnKite || 0);
  const summary = `<div class="idea-card"><div class="idea-kicker">Same screener rules · only the data differs</div>
    <div class="j-table-wrap"><table class="j-table sc-table"><thead><tr><th></th><th>Yahoo</th><th>Zerodha Kite</th></tr></thead><tbody>
      ${row('READY', Y.ready.length, K.ready.length)}
      ${row('Watchlist', Y.watch.length, K.watch.length)}
      ${row('Quick Bounce', Y.quick.length, K.quick.length)}
      ${row('Stocks with full data', `${num(ys.dataOk)} / ${num(ys.attempted)}${yo != null ? ` (${yo}%)` : ''}`, `${num(ks.dataOk)} / ${num(ks.attempted)}${ko != null ? ` (${ko}%)` : ''}`, yo != null && ko != null && yo !== ko ? (yo > ko ? 'y' : 'k') : '')}
      ${row('Data failed / short history', `${num(ys.dataFailed)} / ${num(ys.shortHistory)}`, `${num(ks.dataFailed)} / ${num(ks.shortHistory)}`)}
      ${row('Scan', `${tm(ys)}${ys.reused ? ' (saved)' : ''}${ys.partial ? ' · partial' : ''}`, `${tm(ks)}${ks.reused ? ' (saved)' : ''}${ks.ms ? ` · ${num(ks.ms / 1000)} s` : ''}${ks.partial ? ' · partial' : ''}`)}
      ${row('Charts from', 'Yahoo', ks.chartsFromKite || ks.chartsFromYahoo ? `Kite ${num(ks.chartsFromKite)} · Yahoo ${num(ks.chartsFromYahoo)}` : '—')}
    </tbody></table></div>
    ${!d.kiteHistorical ? '<div class="idea-foot" style="color:var(--bear)"><b>Your Kite plan gave no historical candles</b> - the screener needs 2 years of daily candles, so the Kite run used the Yahoo data instead and this comparison shows nothing yet. Check that your plan on developers.kite.trade includes historical data.</div>' : ''}
    ${fb || notOn ? `<div class="idea-foot">${fb ? `${fb} Kite chart request${fb > 1 ? 's' : ''} failed and used Yahoo instead${d.sourceStats.kite.lastFallbacks?.length ? ` (e.g. ${escHtml(d.sourceStats.kite.lastFallbacks[0])})` : ''}. ` : ''}${notOn ? `${notOn} chart${notOn > 1 ? 's' : ''} not on Kite (global / USD-INR) came from Yahoo.` : ''}</div>` : ''}
    ${(ks.dataFailedSample || []).length ? `<div class="idea-foot">Kite failed for: ${escHtml(ks.dataFailedSample.join(', '))}</div>` : ''}
    ${(ys.dataFailedSample || []).length ? `<div class="idea-foot">Yahoo failed for: ${escHtml(ys.dataFailedSample.join(', '))}</div>` : ''}</div>`;
  const cmp = (title, ya, ka, hint) => {
    const ym = new Map(ya.map(x => [x.sym, x])), km = new Map(ka.map(x => [x.sym, x]));
    const both = ya.filter(x => km.has(x.sym)), onlyY = ya.filter(x => !km.has(x.sym)), onlyK = ka.filter(x => !ym.has(x.sym));
    const chip = (x, o) => `<button class="sc-chip" onclick="loadInstrument('NSE:${escHtml(x.sym)}','${escHtml(x.sym)}');document.querySelector('.nbtn[data-view=stocks]')?.click()" title="Open on Overview">
      <b>${escHtml(x.sym)}</b><span>${escHtml(x.setup || '')}${x.score != null ? ` · ${num(x.score)}` : ''}${x.rr != null ? ` · RR ${num(x.rr, 2)}` : ''}${o && o.setup && o.setup !== x.setup ? ` · other: ${escHtml(o.setup)}` : ''}</span></button>`;
    const grp = (label, arr, other, cls) => `<div class="sc-grp ${cls}"><div class="sc-grp-h">${label} <i>${arr.length}</i></div>${arr.length ? arr.map(x => chip(x, other.get(x.sym))).join('') : '<div class="sc-none">none</div>'}</div>`;
    return `<div class="idea-card"><div class="idea-kicker">${title}</div>${hint ? `<div class="idea-foot">${hint}</div>` : ''}
      <div class="sc-grps">${grp('On both', both, km, 'both')}${grp('Only Yahoo', onlyY, km, 'y')}${grp('Only Kite', onlyK, ym, 'k')}</div></div>`;
  };
  const verdict = `<div class="idea-card"><div class="idea-kicker">How to read this</div><div class="idea-foot">
    A stock on only one side means the two sources' prices or volumes differ enough to change a rule (setup, RR, volume, score).
    That is data quality, not a better or worse rule. In market hours the two scans run a few minutes apart, so stocks right at a rule's edge can
    flip with the price move alone - compare after 15:30 for the cleanest read. To see which source picks better stocks, run this on several days and follow the
    "Only Kite" and "Only Yahoo" stocks on Overview / Track record: the side whose extra picks work out more often has the better data for this screener.
    The normal Swing list, Overview, Track record and alerts keep using Yahoo - this page changes nothing there.</div></div>`;
  return summary + cmp('READY', Y.ready, K.ready, '') + cmp('Watchlist', Y.watch, K.watch, '') + verdict;
}
