/* ══════════════════════════════════════════════════════════════════════
   My trades - the user's own trades, total open risk, Telegram link.
   Trades live in localStorage 'td_journal' (synced to the server like alerts), so the server's open-trade
   watcher can send stop / target / time-exit / results alerts. Loaded after app.js and uses its helpers
   (apiFetch, fmt, escHtml, jsArg, readPosSetting, POS_CAPITAL_KEY, POS_RISK_KEY, screenerModeSwitch).
══════════════════════════════════════════════════════════════════════ */
const J_KEY = 'td_journal', J_LIMIT_KEY = 'td_max_open_risk', J_DEFAULT_LIMIT = 5;
function jLoad(){ try{ const a = JSON.parse(localStorage.getItem(J_KEY) || '[]'); return Array.isArray(a) ? a.filter(t => t && t.id) : []; }catch{ return []; } }
function jSave(a){ try{ localStorage.setItem(J_KEY, JSON.stringify(a)); }catch{} }
function jLimitPct(){ const v = readPosSetting(J_LIMIT_KEY, J_DEFAULT_LIMIT); return v > 0 && v <= 100 ? v : J_DEFAULT_LIMIT; }
/* Units per quantity: shares 1, MCX lots x lot size, option lots x lot size. */
const jUnits = t => (+t.qty || 0) * (t.kind === 'stock' ? 1 : (+t.lotQty || 1));
/* Rupees lost if the stop is hit. A credit spread's stop is a loss of 2x the credit (capped at the width). */
function jRiskRs(t){
  if(t.kind === 'option') return Math.min(2 * (+t.credit || 0), Math.max(0, (+t.wing || 0) - (+t.credit || 0))) * jUnits(t);
  const r = Math.abs((+t.entry || 0) - (+t.stop || 0)) * jUnits(t);
  return Number.isFinite(r) ? r : 0;
}
function openRiskNow(excludeId){ return jLoad().filter(t => t.status === 'open' && t.id !== excludeId).reduce((a, t) => a + jRiskRs(t), 0); }
const jInr = (n, d = 0) => Number.isFinite(+n) ? '₹' + (+n).toLocaleString('en-IN', { maximumFractionDigits: d }) : '—';
/* Line under every position calculator: what the open trades already risk, and the total with this one. */
function posOpenRiskLine(thisLoss, capital){
  const open = jLoad().filter(t => t.status === 'open');
  if(!open.length) return '';
  const cur = openRiskNow(), cap = +capital || readPosSetting(POS_CAPITAL_KEY, 10000), lim = jLimitPct();
  const tot = cur + (+thisLoss || 0), pct = cap > 0 ? tot / cap * 100 : 0, over = pct > lim;
  return `<span style="color:${over ? 'var(--bear)' : 'var(--tx3)'}">${over ? '⚠ ' : ''}Open trades already risk ${jInr(cur)} (${open.length}); with this trade ${jInr(tot)} = ${pct.toFixed(1)}% of capital${over ? ` - above your ${lim}% limit, size down or skip` : ` (limit ${lim}%)`}.</span>`;
}

/* ── Add / close a trade (one small dialog) ── */
function jModal(html){
  jCloseModal();
  const el = document.createElement('div');
  el.className = 'j-modal'; el.id = 'j-modal';
  el.innerHTML = `<div class="j-modal-box" role="dialog" aria-modal="true">${html}</div>`;
  el.addEventListener('click', e => { if(e.target === el) jCloseModal(); });
  document.body.appendChild(el);
  setTimeout(() => el.querySelector('input:not([readonly])')?.focus(), 30);
}
function jCloseModal(){ document.getElementById('j-modal')?.remove(); }
function jNum(id){ const v = Number(String(document.getElementById(id)?.value || '').replace(/,/g, '')); return Number.isFinite(v) ? v : NaN; }
function jTodayKey(){ return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }
let J_PENDING = {};   /* the prefill of the open dialog */
function openTradeForm(p = {}){
  J_PENDING = p || {};
  const kind = p.kind || 'stock', cap = readPosSetting(POS_CAPITAL_KEY, 10000), rp = readPosSetting(POS_RISK_KEY, 1);
  let qty = '';
  if(kind === 'stock' && +p.entry > +p.stop) qty = Math.max(1, Math.floor(cap * rp / 100 / (+p.entry - +p.stop)));
  if(kind === 'mcx' && +p.entry > 0 && +p.stop > 0) qty = Math.max(1, Math.floor(cap * rp / 100 / (Math.abs(+p.entry - +p.stop) * (+p.lotQty || 1))) || 1);
  if(kind === 'option') qty = 1;
  const f = (id, label, val, attrs = '') => `<label class="j-field"><span>${label}</span><input id="${id}" value="${val == null || val === '' || !Number.isFinite(+val) && typeof val === 'number' ? '' : escHtml(String(val))}" ${attrs}></label>`;
  const r2 = v => Number.isFinite(+v) && v !== null && v !== '' ? +(+v).toFixed(2) : '';
  const body = kind === 'option'
    ? `${f('j-short', `Sell strike (${p.optType === 'C' ? 'CE' : 'PE'})`, p.shortStrike, 'type="number" step="50"')}${f('j-long', 'Buy strike', p.longStrike, 'type="number" step="50"')}
       ${f('j-credit', 'Credit received (points)', r2(p.credit), 'type="number" step="0.05"')}${f('j-qty', `Lots (lot ${p.lotQty || 65})`, qty, 'type="number" min="1" step="1"')}
       ${f('j-exp', 'Expiry', p.expiry || '', 'type="date"')}`
    : `${f('j-entry', 'Entry price', r2(p.entry), 'type="number" step="0.05"')}${f('j-stop', 'Stop-loss', r2(p.stop), 'type="number" step="0.05"')}
       ${f('j-t1', 'Target 1', r2(p.t1), 'type="number" step="0.05"')}${f('j-qty', kind === 'mcx' ? `Lots (${p.lotQty || 1} per lot)` : 'Quantity (shares)', qty, 'type="number" min="1" step="1"')}`;
  jModal(`<div class="j-head"><b>📒 I took this trade</b><button class="alert-btn del" onclick="jCloseModal()" aria-label="Close">✕</button></div>
    <div class="j-sub">${p.sym ? escHtml(String(p.sym).replace(/^(NSE|MCX):/, '')) : ''}${p.setup ? ' · ' + escHtml(p.setup) : ''}</div>
    ${p.sym ? '' : f('j-sym', 'Symbol (e.g. NSE:RELIANCE)', '', 'autocapitalize="characters"')}
    <div class="j-grid">${body}${f('j-date', 'Date', jTodayKey(), 'type="date"')}</div>
    ${f('j-note', 'Note (optional)', '')}
    <div class="j-risk" id="j-risk"></div>
    <div class="j-actions"><button class="idea-btn" onclick="jSaveTrade()">Save trade</button><button class="idea-btn ghost" onclick="jCloseModal()">Cancel</button></div>
    <div class="idea-foot">The server watches open trades: stop and target alerts${kind === 'stock' ? ', the day-10 exit, results and ex-dates' : kind === 'option' ? ', Nifty through your short strike, expiry day' : ', contract expiry'} - by notification and Telegram.</div>`);
  const upd = () => { const t = jFromForm(p); const el = document.getElementById('j-risk'); if(!el || !t) return; const cap2 = readPosSetting(POS_CAPITAL_KEY, 10000), lim = jLimitPct(), cur = openRiskNow(), tot = cur + jRiskRs(t), pct = cap2 > 0 ? tot / cap2 * 100 : 0;
    el.innerHTML = `Risk on this trade <b>${jInr(jRiskRs(t))}</b> · all open trades with it <b>${jInr(tot)}</b> = <b style="color:${pct > lim ? 'var(--bear)' : 'var(--bull)'}">${pct.toFixed(1)}%</b> of ${jInr(cap2)} (limit ${lim}%)${pct > lim ? ' - over your limit' : ''}`; };
  document.querySelectorAll('#j-modal input').forEach(i => i.addEventListener('input', upd)); upd();
}
function jFromForm(p){
  const kind = p.kind || 'stock';
  const t = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, sym: String(p.sym || document.getElementById('j-sym')?.value || '').trim().toUpperCase(),
    name: p.name || '', setup: p.setup || (kind === 'stock' ? 'Manual' : ''), side: p.side || 'BUY', qty: jNum('j-qty'), lotQty: +p.lotQty || (kind === 'stock' ? 1 : 1),
    openedAt: document.getElementById('j-date')?.value || jTodayKey(), status: 'open', note: document.getElementById('j-note')?.value || '' };
  if(t.sym && !/^(NSE|MCX):/.test(t.sym)) t.sym = 'NSE:' + t.sym;
  if(kind === 'option') Object.assign(t, { optType: p.optType || 'P', shortStrike: jNum('j-short'), longStrike: jNum('j-long'), credit: jNum('j-credit'), expiry: document.getElementById('j-exp')?.value || p.expiry || '',
    wing: Math.abs(jNum('j-short') - jNum('j-long')), label: `${p.setup || 'Credit spread'} ${jNum('j-short')}/${jNum('j-long')}` });
  else Object.assign(t, { entry: jNum('j-entry'), stop: jNum('j-stop'), t1: jNum('j-t1'), t2: +p.t2 || null, calK: +p.calK || 1 });
  return t;
}
function jSaveTrade(){
  const p = J_PENDING || {}, t = jFromForm(p);
  const bad = !t.sym ? 'Symbol is missing' : !(t.qty > 0) ? 'Quantity / lots must be above 0'
    : t.kind === 'option' ? (!(t.credit > 0) || !(t.wing > 0) ? 'Strikes and credit are needed' : '')
    : !(t.entry > 0) || !(t.stop > 0) ? 'Entry and stop-loss are needed' : t.side !== 'SELL' && t.stop >= t.entry ? 'For a buy, the stop must be below the entry' : '';
  if(bad){ const el = document.getElementById('j-risk'); if(el) el.innerHTML = `<b style="color:var(--bear)">${escHtml(bad)}</b>`; return; }
  t.riskRs = +jRiskRs(t).toFixed(2);
  const a = jLoad(); a.push(t); jSave(a);
  jCloseModal();
  if(typeof showToast === 'function') showToast(`Saved to My trades: ${t.sym.replace(/^(NSE|MCX):/, '')}`);
  if(CURRENT_SCREENER_MODE === 'trades' && document.body.classList.contains('screener-mode')) tabJournal();
}
function closeTradeForm(id){
  const t = jLoad().find(x => x.id === id); if(!t) return;
  const opt = t.kind === 'option';
  jModal(`<div class="j-head"><b>Close ${escHtml(t.sym.replace(/^(NSE|MCX):/, ''))}${opt ? ' ' + escHtml(t.label || '') : ''}</b><button class="alert-btn del" onclick="jCloseModal()" aria-label="Close">✕</button></div>
    <div class="j-grid">
      <label class="j-field"><span>${opt ? 'Paid to close (points, 0 if it expired worthless)' : 'Exit price'}</span><input id="j-exit" type="number" step="0.05"></label>
      <label class="j-field"><span>Date</span><input id="j-xdate" type="date" value="${jTodayKey()}"></label>
      <label class="j-field"><span>Reason</span><select id="j-why"><option>Target</option><option>Stop</option><option>Time exit</option><option>Manual</option></select></label>
    </div>
    <div class="j-actions"><button class="idea-btn" onclick="jCloseTrade('${escHtml(id)}')">Close trade</button><button class="idea-btn ghost" onclick="jCloseModal()">Cancel</button></div>`);
}
function jPnl(t, exit){
  if(t.kind === 'option') return ((+t.credit || 0) - (+exit || 0)) * jUnits(t);
  return ((+exit || 0) - (+t.entry || 0)) * (t.side === 'SELL' ? -1 : 1) * jUnits(t);
}
function jCloseTrade(id){
  const exit = jNum('j-exit');
  if(!Number.isFinite(exit) || exit < 0){ document.getElementById('j-exit')?.focus(); return; }
  const a = jLoad(), t = a.find(x => x.id === id); if(!t) return jCloseModal();
  t.status = 'closed'; t.exit = exit; t.closedAt = document.getElementById('j-xdate')?.value || jTodayKey(); t.exitReason = document.getElementById('j-why')?.value || 'Manual';
  t.pnlRs = +jPnl(t, exit).toFixed(2); t.r = t.riskRs > 0 ? +(t.pnlRs / t.riskRs).toFixed(2) : null;
  jSave(a); jCloseModal(); tabJournal();
}
function jDelete(id){
  if(!confirm('Delete this trade from My trades? This cannot be undone.')) return;
  jSave(jLoad().filter(t => t.id !== id)); tabJournal();
}
function jSetLimit(v){ const n = Number(v); if(n > 0 && n <= 100) savePosSetting(J_LIMIT_KEY, n); tabJournal(); }

/* ── Telegram link (server keeps the chat id; the bot token is a Render environment variable) ── */
async function jTelegram(action){
  const box = document.getElementById('j-tg-msg');
  try{
    const r = await fetch(API + '/api/telegram/' + action, { method:'POST', credentials:'same-origin' });
    const j = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    if(box) box.innerHTML = `<span style="color:var(--bull)">${action === 'link' ? `Linked to ${escHtml(j.name || 'your chat')} ✓ - a confirmation message was sent.` : action === 'test' ? 'Test message sent ✓' : 'Unlinked.'}</span>`;
    if(action !== 'test') setTimeout(tabJournal, 1200);
  }catch(e){ if(box) box.innerHTML = `<span style="color:var(--bear)">${escHtml(e.message)}</span>`; }
}
function jTelegramHtml(st){
  if(!st) return '';
  const steps = `<ol class="j-steps"><li>In Telegram, open <b>@BotFather</b> → send <code>/newbot</code> → pick a name → copy the token it gives you.</li><li>Render → your service → <b>Environment</b> → add <code>TELEGRAM_BOT_TOKEN</code> = that token → save (it redeploys).</li><li>Open your new bot in Telegram, send <code>/start</code>, then press <b>Link</b> here.</li></ol>`;
  return `<div class="idea-card j-tg">
    <div class="idea-head"><div><div class="idea-kicker">Telegram alerts</div><div class="idea-title">${st.linked ? `Linked to ${escHtml(st.name || 'your chat')}` : st.configured ? 'Bot ready - link your chat' : 'Not set up'}</div></div><div class="idea-view ${st.linked ? 'bull' : 'neutral'}">${st.linked ? 'ON' : 'OFF'}</div></div>
    <div class="idea-foot">Every alert also goes to Telegram: stop / target on your trades, new READY stocks, the 08:45 brief, Gold Petal 09:05 / 17:00, Nifty options 09:30. Free.</div>
    ${st.configured ? '' : steps}
    <div class="j-actions">${st.configured && !st.linked ? `<button class="idea-btn" onclick="jTelegram('link')">Link</button>` : ''}${st.linked ? `<button class="idea-btn" onclick="jTelegram('test')">Send test</button><button class="idea-btn ghost" onclick="jTelegram('unlink')">Unlink</button>` : ''}${st.configured && !st.linked ? '<span class="idea-foot">Send /start to your bot first.</span>' : ''}</div>
    <div id="j-tg-msg" class="idea-foot"></div>
  </div>`;
}

/* ── The page (Screener → My trades) ── */
async function tabJournal(){
  const tc = document.getElementById('tc'); if(!tc) return;
  const live = typeof tcGuard === 'function' ? tcGuard() : () => true;
  const all = jLoad(), open = all.filter(t => t.status === 'open'), closed = all.filter(t => t.status === 'closed').sort((a, b) => String(b.closedAt).localeCompare(String(a.closedAt)));
  const cap = readPosSetting(POS_CAPITAL_KEY, 10000), lim = jLimitPct(), risk = openRiskNow(), pct = cap > 0 ? risk / cap * 100 : 0;
  const bar = `<div class="idea-card j-risk-card">
    <div class="idea-head"><div><div class="idea-kicker">Total open risk</div><div class="idea-title">${jInr(risk)} = ${pct.toFixed(1)}% of ${jInr(cap)}</div></div><div class="idea-view ${pct > lim ? 'bear' : 'bull'}">${pct > lim ? 'OVER LIMIT' : 'OK'}</div></div>
    <div class="j-meter"><i style="width:${Math.min(100, lim > 0 ? pct / lim * 100 : 0)}%;background:${pct > lim ? 'var(--bear)' : pct > lim * 0.8 ? 'var(--neu)' : 'var(--bull)'}"></i></div>
    <div class="idea-foot">What you lose if every open trade hits its stop. Limit <input type="number" min="1" max="100" step="0.5" value="${lim}" style="width:60px" onchange="jSetLimit(this.value)">% of capital (capital and risk % come from the position calculator).</div></div>`;
  const row = t => {
    const opt = t.kind === 'option';
    return `<div class="j-row" data-jid="${escHtml(t.id)}">
      <div class="j-row-main"><b>${escHtml(t.sym.replace(/^(NSE|MCX):/, ''))}</b> <span class="pl-tag ${opt ? 'watch' : 'ready'}">${escHtml(opt ? (t.label || 'Credit spread') : (t.setup || t.kind))}</span>
        <div class="j-row-sub">${opt ? `Credit ${fmt(t.credit)} pts · ${t.qty} lot${t.qty > 1 ? 's' : ''} · expiry ${escHtml(t.expiry || '—')}` : `Entry ${fmt(t.entry)} · SL ${fmt(t.stop)} · T1 ${t.t1 ? fmt(t.t1) : '—'} · ${t.qty} ${t.kind === 'mcx' ? 'lot' + (t.qty > 1 ? 's' : '') : 'sh'}`} · since ${escHtml(t.openedAt || '')} · risk ${jInr(t.riskRs ?? jRiskRs(t))}</div></div>
      <div class="j-row-live" data-jlive>…</div>
      <div class="j-row-act"><button class="idea-btn" onclick="closeTradeForm('${escHtml(t.id)}')">Close</button><button class="idea-btn ghost" onclick="jDelete('${escHtml(t.id)}')" aria-label="Delete">✕</button></div>
    </div>`;
  };
  /* Results by setup: count, wins, average R, total rupees (before charges). */
  const groups = {};
  closed.forEach(t => { const k = t.kind === 'option' ? (t.setup || 'Credit spread') : t.kind === 'mcx' ? (t.setup || 'MCX') : (t.setup || 'Stock'); (groups[k] = groups[k] || []).push(t); });
  const stat = ts => { const w = ts.filter(t => t.pnlRs > 0).length, rs = ts.filter(t => Number.isFinite(+t.r)); return { n: ts.length, win: ts.length ? Math.round(w / ts.length * 100) : 0, avgR: rs.length ? rs.reduce((a, t) => a + +t.r, 0) / rs.length : null, total: ts.reduce((a, t) => a + (+t.pnlRs || 0), 0) }; };
  const statRow = (k, s) => `<tr><td>${escHtml(k)}</td><td>${s.n}</td><td>${s.win}%</td><td style="color:${s.avgR > 0 ? 'var(--bull)' : s.avgR < 0 ? 'var(--bear)' : 'inherit'}">${s.avgR == null ? '—' : (s.avgR >= 0 ? '+' : '') + s.avgR.toFixed(2) + 'R'}</td><td style="color:${s.total >= 0 ? 'var(--bull)' : 'var(--bear)'}">${jInr(s.total)}</td></tr>`;
  const statsHtml = closed.length ? `<div class="idea-card"><div class="idea-kicker">Your results (closed trades, before charges)</div>
    <div class="j-table-wrap"><table class="j-table"><thead><tr><th>Setup</th><th>Trades</th><th>Win</th><th>Avg R</th><th>Total</th></tr></thead><tbody>
    ${Object.entries(groups).map(([k, ts]) => statRow(k, stat(ts))).join('')}${Object.keys(groups).length > 1 ? statRow('All', stat(closed)) : ''}</tbody></table></div>
    <div class="idea-foot">After 20-30 trades per setup this shows which of your trade types really make money - compare with the app's backtest.</div></div>` : '';
  const closedHtml = closed.length ? `<div class="idea-card"><div class="idea-kicker">Closed (latest 30)</div>${closed.slice(0, 30).map(t => `<div class="j-row closed"><div class="j-row-main"><b>${escHtml(t.sym.replace(/^(NSE|MCX):/, ''))}</b> <span class="j-row-sub">${escHtml(t.setup || t.label || '')} · ${escHtml(t.openedAt || '')} → ${escHtml(t.closedAt || '')} · ${escHtml(t.exitReason || '')}</span></div><div class="j-row-live" style="color:${t.pnlRs >= 0 ? 'var(--bull)' : 'var(--bear)'}">${jInr(t.pnlRs)}${t.r != null ? ` · ${t.r >= 0 ? '+' : ''}${t.r}R` : ''}</div><div class="j-row-act"><button class="idea-btn ghost" onclick="jDelete('${escHtml(t.id)}')" aria-label="Delete">✕</button></div></div>`).join('')}</div>` : '';
  tc.innerHTML = `${screenerModeSwitch('trades')}${bar}
    <div class="idea-card"><div class="idea-head"><div><div class="idea-kicker">Open trades</div><div class="idea-title">${open.length ? `${open.length} open` : 'No open trade'}</div></div><button class="idea-btn" onclick="openTradeForm({})">+ Add manually</button></div>
      ${open.length ? open.map(row).join('') : '<div class="idea-foot">Tap 📒 on a stock\'s trade plan, the Gold Petal idea or the Nifty rule card when you take a trade - or add one here.</div>'}</div>
    ${statsHtml}${closedHtml}<div data-j-tg><div class="idea-card"><div class="idea-kicker">Telegram alerts</div><div class="idea-foot">Loading…</div></div></div>`;
  apiFetch('/api/telegram/status', 10000).then(st => { if(live()) { const el = tc.querySelector('[data-j-tg]'); if(el) el.innerHTML = jTelegramHtml(st); } }).catch(() => { const el = tc.querySelector('[data-j-tg]'); if(el && live()) el.innerHTML = ''; });
  /* Live P&L, one quote at a time (same cached quick price as the sidebar). */
  for(const t of open){
    if(!live()) return;
    const el = tc.querySelector(`[data-jid="${CSS.escape(t.id)}"] [data-jlive]`); if(!el) continue;
    try{
      const q = await apiFetch(`/api/quickprice?sym=${encodeURIComponent(t.kind === 'option' ? 'NSE:NIFTY' : t.sym)}`, 20000);
      if(!live()) return;
      if(t.kind === 'option'){
        const p = +q.price, k = +t.shortStrike, tested = t.optType === 'P' ? p < k : p > k, dist = Math.abs(p - k) / p * 100;
        el.innerHTML = `<span style="color:${tested ? 'var(--bear)' : 'var(--bull)'}">Nifty ${fmt(p, 0)} · ${tested ? 'through' : `${dist.toFixed(1)}% from`} the short ${k}</span>`;
      } else {
        const p = +q.price * (t.kind === 'mcx' ? (+t.calK || 1) : 1), pnl = jPnl(t, p), r = t.riskRs > 0 ? pnl / t.riskRs : null;
        const flag = (t.side !== 'SELL' ? p <= t.stop : p >= t.stop) ? ' · <b style="color:var(--bear)">at / below stop</b>' : t.t1 && (t.side !== 'SELL' ? p >= t.t1 : p <= t.t1) ? ' · <b style="color:var(--bull)">T1 reached - book half</b>' : '';
        el.innerHTML = `<span style="color:${pnl >= 0 ? 'var(--bull)' : 'var(--bear)'}">Now ${fmt(p)} · ${jInr(pnl)}${r != null ? ` · ${r >= 0 ? '+' : ''}${r.toFixed(2)}R` : ''}</span>${flag}`;
      }
    }catch{ el.textContent = 'price n/a'; }
  }
}

/* Notification links: /?sym=NSE:GAIL opens that instrument, /?view=trades or /?view=screener opens those pages. */
(function deepLink(){
  let q; try{ q = new URLSearchParams(location.search); }catch{ return; }
  const sym = (q.get('sym') || '').toUpperCase(), view = q.get('view');
  if(!sym && !view) return;
  const go = () => {
    try{
      if(view === 'trades' || view === 'screener'){ document.querySelector('.nbtn[data-view="screener"]')?.click(); if(view === 'trades') setTimeout(() => tabScreener('trades'), 400); }
      else if(/^(NSE|MCX):[A-Z0-9&_.-]+$/.test(sym)){
        const v = sym.startsWith('MCX:') ? 'commodities' : (typeof isIndexSymbol === 'function' && isIndexSymbol(sym)) ? 'indices' : 'stocks';
        document.querySelector(`.nbtn[data-view="${v}"]`)?.click();
        setTimeout(() => loadInstrument(sym, (typeof CLIENT_NAMES === 'object' && CLIENT_NAMES[sym.replace(/^(NSE|MCX):/, '')]) || sym.replace(/^(NSE|MCX):/, '')), 400);
      }
      history.replaceState(null, '', location.pathname);
    }catch{}
  };
  if(document.readyState === 'complete') setTimeout(go, 800); else window.addEventListener('load', () => setTimeout(go, 800));
})();
