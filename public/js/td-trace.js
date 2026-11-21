/* Track record sub-tabs: Stocks (the browser's READY-pick tracker in app.js), MCX (Gold Petal, Crude Oil, Natural
   Gas - older Gold Petal rows are kind 'gold', newer ones kind 'mcx') and Nifty options.
   Gold Petal and Nifty records are made by the server at the moment it alerts a ready trade / a passed rule and
   are followed by the server to their exit (see SIGNAL TRACE in server.js). They arrive here through the synced
   key td_trace; this page and the server merge their copies by record id, so neither side loses rows. */
const TRACE_KEY = 'td_trace';
let TRACK_SUB = 'stock';
function traceParseC(v){
  try { const j = JSON.parse(v || 'null'); if (j && Array.isArray(j.rows)) return { clearedAt: +j.clearedAt || 0, rows: j.rows.filter(r => r && r.id) }; } catch {}
  return { clearedAt: 0, rows: [] };
}
function traceMergeC(a, b){
  const clearedAt = Math.max(+a.clearedAt || 0, +b.clearedAt || 0), m = new Map();
  for (const r of [...a.rows, ...b.rows]) {
    if ((+r.createdAt || 0) <= clearedAt) continue;
    const o = m.get(r.id);
    if (!o || (+r.upd || 0) > (+o.upd || 0)) m.set(r.id, r);
  }
  return { clearedAt, rows: [...m.values()].sort((x, y) => (+x.createdAt || 0) - (+y.createdAt || 0)).slice(-300) };
}
/* Used by syncNow when a newer server copy arrives: the merged text, or the server's own when nothing was added. */
function traceMergeJson(localText, serverText){
  const a = traceParseC(localText), b = traceParseC(serverText), m = traceMergeC(a, b);
  const sameAsServer = m.clearedAt === b.clearedAt && m.rows.length === b.rows.length && m.rows.every(r => b.rows.some(x => x.id === r.id && (+x.upd || 0) === (+r.upd || 0)));
  return sameAsServer ? serverText : JSON.stringify(m);
}
function traceLoadC(){ try { return traceParseC(localStorage.getItem(TRACE_KEY)); } catch { return { clearedAt: 0, rows: [] }; } }
const isMcxKind = k => k === 'mcx' || k === 'gold';
function traceClear(kind){
  if (!confirm(`Clear all ${isMcxKind(kind) ? 'MCX' : 'Nifty options'} records? Stock records are kept.`)) return;
  /* clearedAt removes every record made before now on all devices and on the server; the other kind's open
     records are kept by re-stamping them. */
  const t = traceLoadC(), now = Date.now();
  const keep = t.rows.filter(r => isMcxKind(kind) ? !isMcxKind(r.kind) : r.kind !== kind).map(r => ({ ...r, createdAt: now + 1, upd: now + 1 }));
  try { localStorage.setItem(TRACE_KEY, JSON.stringify({ clearedAt: now, rows: keep })); } catch {}
  tabTrace(kind);
}
/* Stock READY picks recorded by the server's scans -> the Stocks list (same row shape as updateForwardTestsFromPicks). */
function importStockTrace(){
  const recs = traceLoadC().rows.filter(r => r.kind === 'stock' && r.sym && +r.entry > 0);
  if (!recs.length || typeof readForwardTests !== 'function') return 0;
  const rows = readForwardTests(), have = new Set(rows.map(r => `${r.date}_${r.sym}`));
  let n = 0;
  for (const r of recs) {
    if (have.has(`${r.date}_${r.sym}`)) continue;
    rows.push({ date: r.date, source: 'server scan', rank: '-', sym: r.sym, side: 'Long', bias: r.bias || 'Bullish', entry: ftR(r.entry), current: ftR(r.entry),
      sl: ftR(r.sl), t1: ftR(r.t1), t2: null, trailSl: null, atr: null, rr1: null, rr2: null, score10: r.score10 || null, final: r.final || null, setup: r.setup || null,
      exitMode: r.exitMode || null, t2r: r.t2r ? ftR(r.t2r) : null, tags: r.tags || null, sector: r.sector || null,
      ...(r.pattern ? { pattern: true, planLocked: true, side: 'Long', source: 'pattern breakout' } : {}),
      /* the tested READY gate's own stop and 2R (rows recorded before 21 Nov 2026 have no flag - known by their setup) */
      ...(r.planLocked || ['EMA20/50 cross', 'Gap-up near 52-week high'].includes(String(r.setup || '')) ? { planLocked: true } : {}),
      status: 'Open', phase: 'entry', resultR: null, retNow: 0, d5: null, d10: null, d20: null, closed: false, createdAt: new Date(+r.createdAt || Date.now()).toISOString() });
    have.add(`${r.date}_${r.sym}`); n++;
  }
  if (n) saveForwardTests(rows.sort((a, b) => String(a.date).localeCompare(String(b.date))));
  return n;
}
function traceSubTabs(active){
  const b = (id, label) => `<button class="scr-tab${active === id ? ' active' : ''}" onclick="TRACK_SUB='${id}';tabScreener('track')">${label}</button>`;
  return `<div class="td-trace-sub">${b('stock', 'Stocks')}${b('mcx', 'MCX')}${b('nifty', 'Nifty options')}</div>`;
}
function traceSummaryHtml(rows){
  const done = rows.filter(r => r.closed && Number.isFinite(+r.resultR) && r.resultR !== null);
  const wins = done.filter(r => +r.resultR > 0).length;
  const avg = done.length ? done.reduce((a, r) => a + (+r.resultR || 0), 0) / done.length : null;
  const card = (l, v, c = '') => `<div class="scr-sum-card"><div class="scr-sum-label">${l}</div><div class="scr-sum-val"${c ? ` style="color:${c}"` : ''}>${v}</div></div>`;
  return `<div class="td-trace-sum">${card('Records', rows.length)}${card('Open', rows.filter(r => !r.closed).length, 'var(--acc)')}${card('Closed', done.length)}${card('Win rate', done.length ? Math.round(wins / done.length * 100) + '%' : '--', 'var(--bull)')}${card('Avg R', avg == null ? '--' : (avg >= 0 ? '+' : '') + avg.toFixed(2) + 'R', avg == null ? '' : avg >= 0 ? 'var(--bull)' : 'var(--bear)')}</div>`;
}
const trMoney = v => Number.isFinite(+v) && +v > 0 ? '₹' + fmt(+v) : '--';
const trR = v => v == null || !Number.isFinite(+v) ? '--' : (+v >= 0 ? '+' : '') + (+v).toFixed(2) + 'R';
const trCol = v => v == null || !Number.isFinite(+v) ? 'var(--tx2)' : +v > 0 ? 'var(--bull)' : +v < 0 ? 'var(--bear)' : 'var(--tx2)';
const trTime = ms => ms ? new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const MCX_TR_NAME = { 'MCX:GOLDPETAL': 'Gold Petal', 'MCX:CRUDEOIL': 'Crude Oil', 'MCX:NATURALGAS': 'Natural Gas' };
function traceGoldRows(rows){
  return rows.map(r => `<tr>
    <td>${escHtml(r.date)}<br><b>${escHtml(MCX_TR_NAME[r.sym || 'MCX:GOLDPETAL'] || r.sym)}</b> <span style="color:var(--tx3)">${escHtml(r.via || '')}</span></td>
    <td><span style="color:${r.side === 'SELL' ? 'var(--bear)' : 'var(--bull)'};font-weight:800">${r.side === 'SELL' ? 'SELL' : 'BUY'}</span>${r.small ? '<br><span style="color:var(--tx3)">small size</span>' : ''}</td>
    <td style="color:${trCol(r.resultR)};font-weight:900">${trR(r.resultR)}</td>
    <td style="font-weight:800;white-space:normal;min-width:130px">${escHtml(r.status || 'Open')}</td>
    <td>${trMoney(r.entry)}</td>
    <td>${trMoney(r.sl)}</td>
    <td>${r.exitMode === 'full' ? `${trMoney(r.target)}<br><span style="color:var(--tx3)">${escHtml(r.exitRule || 'all at target')}</span>` : `${trMoney(r.t1)}<br><span style="color:var(--tx3)">T2 ${trMoney(r.t2)}</span>`}</td>
    <td>${trMoney(r.closed ? r.exit || r.mark : r.mark)}<br><span style="color:var(--tx3)">${trTime(r.closed ? r.closedAt : r.markAt)}</span></td>
  </tr>`).join('');
}
function traceNiftyRows(rows){
  return rows.map(r => {
    const leg = r.ty === 'P' ? 'PE' : 'CE', lot = +r.lot || 65;
    const pnl = Number.isFinite(+r.pnlPts) ? `${+r.pnlPts >= 0 ? '+' : ''}${(+r.pnlPts).toFixed(2)} pts<br><span style="color:var(--tx3)">${+r.pnlPts >= 0 ? '+' : '-'}₹${fmt(Math.abs(r.pnlPts * lot), 0)}/lot</span>` : '--';
    return `<tr>
    <td>${escHtml(r.date)}<br><span style="color:var(--tx3)">Nifty ${fmt(r.spot, 0)}</span></td>
    <td><b>${escHtml(r.type || '')}</b><br><span style="color:var(--tx3)">Sell ${r.sell} ${leg} / buy ${r.buy} ${leg}</span></td>
    <td style="color:${trCol(r.resultR)};font-weight:900">${trR(r.resultR)}</td>
    <td style="color:${trCol(r.pnlPts)};font-weight:800">${pnl}</td>
    <td style="font-weight:800;white-space:normal;min-width:130px">${escHtml(r.status || 'Open')}</td>
    <td>${(+r.credit).toFixed(2)} pts<br><span style="color:var(--tx3)">₹${fmt(r.credit * lot, 0)}/lot</span></td>
    <td>${(+(r.targetValue ?? r.credit * 0.2)).toFixed(2)}<br><span style="color:var(--tx3)">stop ${(+r.stopValue).toFixed(2)}</span></td>
    <td>${Number.isFinite(+r.mark) ? (+r.mark).toFixed(2) : '--'}<br><span style="color:var(--tx3)">${r.exitSpot ? 'Nifty ' + fmt(r.exitSpot, 0) : trTime(r.markAt)}</span></td>
    <td>${escHtml(r.expiry)}</td>
  </tr>`; }).join('');
}
async function tabTrace(kind){
  const tc = document.getElementById('tc'); if (!tc) return;
  const live = typeof tcGuard === 'function' ? tcGuard() : () => true;
  tc.innerHTML = `<div class="ls" style="display:flex;min-height:100px"><div class="sp"></div><div class="lt">Loading the latest records…</div></div>`;
  try { if (typeof syncNow === 'function') await syncNow(); } catch {}
  if (!live()) return;
  if (kind === 'gold') kind = 'mcx';
  const gold = isMcxKind(kind);
  const rows = traceLoadC().rows.filter(r => gold ? isMcxKind(r.kind) : r.kind === kind).reverse();
  const head = gold
    ? '<th>Date</th><th>Side</th><th>Result</th><th>Status</th><th>Entry</th><th>Stop</th><th>Target</th><th>Last price</th>'
    : '<th>Date</th><th>Spread</th><th>Result</th><th>P&amp;L</th><th>Status</th><th>Credit</th><th>Close at (80%) / stop</th><th>Last value</th><th>Expiry</th>';
  const empty = `<tr><td colspan="${gold ? 8 : 9}">No records yet. ${gold ? 'An MCX trade (Gold Petal, Crude Oil, Natural Gas) is recorded when the server alerts it as ready (09:45 / 17:00) or when price reaches a waiting plan\'s level.' : 'A credit spread is recorded when your rule passes at the 10:00 check.'}</td></tr>`;
  const body = rows.length ? (gold ? traceGoldRows(rows) : traceNiftyRows(rows)) : empty;
  /* Win rate per commodity, so you can see which one really works for you. */
  const perSym = gold ? Object.entries(MCX_TR_NAME).map(([s, n]) => { const rs = rows.filter(r => (r.sym || 'MCX:GOLDPETAL') === s), done = rs.filter(r => r.closed && Number.isFinite(+r.resultR) && r.resultR !== null), w = done.filter(r => +r.resultR > 0).length, avg = done.length ? done.reduce((a, r) => a + (+r.resultR || 0), 0) / done.length : null;
    return `<tr><td>${n}</td><td>${rs.length}</td><td>${done.length}</td><td>${done.length ? Math.round(w / done.length * 100) + '%' : '—'}</td><td style="color:${trCol(avg)}">${avg == null ? '—' : trR(avg)}</td></tr>`; }).join('') : '';
  const perSymHtml = gold ? `<div class="j-table-wrap" style="margin-bottom:10px"><table class="ft-table"><thead><tr><th>Commodity</th><th>Records</th><th>Closed</th><th>Win rate</th><th>Avg R</th></tr></thead><tbody>${perSym}</tbody></table></div>` : '';
  const how = gold
    ? '<b>How it is followed:</b> records from 19 Nov 2026 use the tested exit - the whole position at the target (T1; Gold Petal rows before 20 Nov 2026 used 3R) or at the stop, else the close of day 20 (gold) / day 10 (others). Older Gold Petal rows: half at T1, the rest at T2 / entry / a close through the EMA. Entry is the plan\'s price - at once when price is already there, else when price reaches it that day ("Not filled" otherwise, left out of the win rate). Then checked once a day, each morning, on the completed daily candles at your MCX calibration: stop-loss = -1R; at T1 half is booked and the stop moves to entry; the rest exits at T2, at entry, or on a daily close through the plan\'s EMA. Still open after 10 trading days: closed at the close of day 10. Result = half T1 + half the rest. The alert day\'s candle is not judged (its high / low may have come before the alert); a day that touched both the stop and a target is marked Ambiguous.'
    : '<b>How it is followed:</b> from 21 Nov 2026 as tested - entered at the 15:05 premiums on the first trading day after an expiry and held to expiry, then settled from Nifty\'s close (1R = the most the spread can lose: width minus credit). The value is marked each day at 15:05. Rows recorded before 21 Nov 2026 kept their old exit (80% of the premium, a 2x-credit stop or the end of the week; 1R = 2x the credit). Brokerage and taxes are not included.';
  let today = '';
  try {
    const st = await apiFetch('/api/assistant-status', 10000);
    const lines = gold ? Object.entries(st.mcxNames || {}).map(([s, n]) => `${n}: ${st.mcx?.[s]?.day === st.day ? st.mcx[s].text : 'not checked yet today (09:45 and 17:00; a missed check runs at the next minute between 10:05 and 23:00)'}`)
      : [`Nifty: ${st.nifty?.day === st.day ? st.nifty.text : st.kite ? 'not checked yet today (10:00)' : 'not checked - connect Zerodha (checked within a minute after you connect, until 15:00)'}`];
    today = `<div class="aib" style="font-size:.72rem;margin:8px 0"><b>Today's server check</b> (a trade is recorded only when this says ready / passed):<br>${lines.map(escHtml).join('<br>')}</div>`;
  } catch {}
  if (!live()) return;
  tc.innerHTML = `${traceSubTabs(kind)}<div class="scr-header"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="font-size:1rem;font-weight:800;color:var(--acc)">${gold ? 'MCX - every alerted Gold Petal, Crude Oil and Natural Gas trade, followed to its exit' : 'Nifty options - every passed rule, followed to its exit'}</div><button onclick="traceClear('${kind}')" style="margin-left:auto;padding:4px 12px;background:var(--bgi);border:1px solid var(--brdl);border-radius:var(--rs);color:var(--bear);font-size:.75rem;font-weight:700;cursor:pointer">Clear records</button></div><div style="font-size:.72rem;color:var(--tx3);margin-top:6px">Recorded and checked by the server, also when the app is closed. <span data-sync-status>${typeof syncStatusText === 'function' ? syncStatusText() : ''}</span></div></div>
  ${today}
  ${traceSummaryHtml(rows)}
  ${perSymHtml}
  <div class="j-table-wrap"><table class="ft-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
  <div class="aib" style="font-size:.72rem;margin-top:10px">${how}</div>`;
}
