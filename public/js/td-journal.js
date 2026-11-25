/* ══════════════════════════════════════════════════════════════════════
   My trades - the user's own trades, total open risk, phone alerts.
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
/* Rupees at risk on the tested exit. */
function jRiskRs(t){
  /* Credit spread: held to expiry as tested, so the risk is the most it can lose (width - credit). Naked sell (no buy
     strike): the exit on a close at 2x the premium loses about 1x the credit. */
  if(t.kind === 'option') return (+t.wing > 0 ? Math.max(0, (+t.wing || 0) - (+t.credit || 0)) : (+t.credit || 0)) * jUnits(t);
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
    ? `${f('j-short', `Sell strike (${p.optType === 'C' ? 'CE' : 'PE'})`, p.shortStrike, 'type="number" step="50"')}${f('j-long', 'Buy strike (empty = naked)', p.longStrike, 'type="number" step="50"')}
       ${f('j-credit', 'Credit received (points)', r2(p.credit), 'type="number" step="0.05"')}${f('j-qty', `Lots (lot ${p.lotQty || 65})`, qty, 'type="number" min="1" step="1"')}
       ${f('j-exp', 'Expiry', p.expiry || '', 'type="date"')}`
    : `${f('j-entry', 'Entry price', r2(p.entry), 'type="number" step="0.05"')}${f('j-stop', 'Stop-loss', r2(p.stop), 'type="number" step="0.05"')}
       ${f('j-t1', 'Target 1', r2(p.t1), 'type="number" step="0.05"')}${f('j-qty', kind === 'mcx' ? `Lots (${p.lotQty || 1} per lot)` : 'Quantity (shares)', qty, 'type="number" min="1" step="1"')}`;
  jModal(`<div class="j-head"><b>📒 I took this trade</b><button class="alert-btn del" onclick="jCloseModal()" aria-label="Close">✕</button></div>
    <div class="j-sub">${p.sym ? escHtml(String(p.sym).replace(/^(NSE|MCX):/, '')) : ''}${p.setup ? ' · ' + escHtml(p.setup) : ''}</div>
    ${p.sym ? '' : jSymField('')}
    <div class="j-grid">${body}${f('j-date', 'Date', jTodayKey(), 'type="date"')}</div>
    ${f('j-note', 'Note (optional)', '')}
    <div class="j-risk" id="j-risk"></div>
    <div class="j-actions"><button class="idea-btn" onclick="jSaveTrade()">Save trade</button><button class="idea-btn ghost" onclick="jCloseModal()">Cancel</button></div>
    <div class="idea-foot">The server watches open trades: stop and target alerts${kind === 'stock' ? ', the day-10 exit, results and ex-dates' : kind === 'option' ? ', Nifty through your short strike, expiry day' : ', contract expiry'} - by phone / browser notification.</div>`);
  const upd = () => { const t = jFromForm(p); const el = document.getElementById('j-risk'); if(!el || !t) return; const cap2 = readPosSetting(POS_CAPITAL_KEY, 10000), lim = jLimitPct(), cur = openRiskNow(), tot = cur + jRiskRs(t), pct = cap2 > 0 ? tot / cap2 * 100 : 0;
    el.innerHTML = `Risk on this trade <b>${jInr(jRiskRs(t))}</b> · all open trades with it <b>${jInr(tot)}</b> = <b style="color:${pct > lim ? 'var(--bear)' : 'var(--bull)'}">${pct.toFixed(1)}%</b> of ${jInr(cap2)} (limit ${lim}%)${pct > lim ? ' - over your limit' : ''}`; };
  document.querySelectorAll('#j-modal input').forEach(i => i.addEventListener('input', upd)); upd();
  if(!p.sym) jSymWire(price => { const e = document.getElementById('j-entry'); if(e && !e.value && kind === 'stock'){ e.value = price; upd(); } });
}
/* ── Symbol box for manual trades: suggestions from the app's stock search, and a price check, so a typo,
   a company name or a renamed stock (TATAMOTORS -> TMPV / TMCV) is caught before the trade is saved. ── */
function jSymField(val){
  return `<label class="j-field j-symf"><span>Stock (type the name or NSE symbol)</span><input id="j-sym" value="${escHtml(val)}" autocapitalize="characters" autocomplete="off" placeholder="e.g. Reliance or RELIANCE">
    <div class="j-sugg" id="j-sugg"></div><small class="j-symchk" id="j-symchk"></small></label>`;
}
const jSymNorm = v => { const s = String(v || '').trim().toUpperCase().replace(/\s+/g, ''); return !s ? '' : /^(NSE|MCX):/.test(s) ? s : 'NSE:' + s; };
let J_SYM_OK = {};   /* symbol -> last price, for symbols that returned a price */
async function jSymCheck(onPrice){
  const el = document.getElementById('j-symchk'), sym = jSymNorm(document.getElementById('j-sym')?.value);
  if(!el) return false;
  if(!sym){ el.textContent = ''; return false; }
  if(J_SYM_OK[sym]){ el.innerHTML = `<span style="color:var(--bull)">✓ ${escHtml(sym.replace(/^(NSE|MCX):/, ''))} now ${fmt(J_SYM_OK[sym])}</span>`; return true; }
  el.innerHTML = '<span style="color:var(--tx3)">checking the price…</span>';
  try{
    const q = await apiFetch(`/api/quickprice?sym=${encodeURIComponent(sym)}`, 20000);
    if(!(+q.price > 0)) throw new Error('no price');
    J_SYM_OK[sym] = +q.price;
    if(jSymNorm(document.getElementById('j-sym')?.value) !== sym) return false;
    el.innerHTML = `<span style="color:var(--bull)">✓ ${escHtml(sym.replace(/^(NSE|MCX):/, ''))} now ${fmt(+q.price)}</span>`;
    if(onPrice) onPrice(+(+q.price).toFixed(2));
    return true;
  }catch{
    if(jSymNorm(document.getElementById('j-sym')?.value) === sym) el.innerHTML = `<span style="color:var(--bear)">✗ No price for ${escHtml(sym.replace(/^(NSE|MCX):/, ''))} - pick the stock from the list (renamed stocks have a new symbol)</span>`;
    return false;
  }
}
function jSymWire(onPrice){
  const inp = document.getElementById('j-sym'), box = document.getElementById('j-sugg'); if(!inp || !box) return;
  let timer = null, seq = 0;
  const pick = s => { inp.value = s; box.innerHTML = ''; box.style.display = 'none'; inp.dispatchEvent(new Event('input')); jSymCheck(onPrice); };
  inp.addEventListener('input', e => {
    if(!e.isTrusted) return;
    const chk = document.getElementById('j-symchk'); if(chk) chk.textContent = '';
    clearTimeout(timer);
    const q = inp.value.trim().replace(/^(NSE|MCX):/i, '');
    if(q.length < 2){ box.style.display = 'none'; return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try{
        const d = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`, 15000);
        if(my !== seq) return;
        const rs = (d.results || []).filter(r => r.type !== 'INDEX').slice(0, 6);
        box.innerHTML = rs.length ? rs.map(r => { const s = String(r.symbol || '').replace(/[^A-Z0-9._&-]/gi, ''); return `<button type="button" class="j-sugg-i" data-s="${escHtml(s)}"><b>${escHtml(s)}</b> <span>${escHtml(r.name || '')}</span></button>`; }).join('')
          : '<div class="j-sugg-none">No stock found - check the spelling</div>';
        box.style.display = 'block';
        box.querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', () => pick(b.dataset.s)));
      }catch{ box.style.display = 'none'; }
    }, 300);
  });
  inp.addEventListener('blur', () => setTimeout(() => { box.style.display = 'none'; jSymCheck(onPrice); }, 200));
}
/* Edit a saved open trade: the stock (e.g. one saved before the price check, or renamed after a demerger), and
   entry / stop / target / quantity (or strikes / credit / lots / expiry for a spread). */
function jEditTrade(id, noPrice){
  const t = jLoad().find(x => x.id === id); if(!t) return;
  const opt = t.kind === 'option';
  const f = (fid, label, val, attrs = '') => `<label class="j-field"><span>${label}</span><input id="${fid}" value="${val == null || !Number.isFinite(+val) && fid !== 'j-exp' ? '' : escHtml(String(val))}" ${attrs}></label>`;
  const body = opt
    ? `${f('j-short', 'Sell strike', t.shortStrike, 'type="number" step="50"')}${f('j-long', 'Buy strike', t.longStrike, 'type="number" step="50"')}
       ${f('j-credit', 'Credit received (points)', t.credit, 'type="number" step="0.05"')}${f('j-qty', 'Lots', t.qty, 'type="number" min="1" step="1"')}${f('j-exp', 'Expiry', t.expiry || '', 'type="date"')}`
    : `${f('j-entry', 'Entry price', t.entry, 'type="number" step="0.05"')}${f('j-stop', 'Stop-loss', t.stop, 'type="number" step="0.05"')}
       ${f('j-t1', 'Target 1', t.t1, 'type="number" step="0.05"')}${f('j-qty', t.kind === 'mcx' ? 'Lots' : 'Quantity (shares)', t.qty, 'type="number" min="1" step="1"')}`;
  jModal(`<div class="j-head"><b>Edit ${escHtml(t.sym.replace(/^(NSE|MCX):/, ''))}${opt ? ' ' + escHtml(t.label || '') : ''}</b><button class="alert-btn del" onclick="jCloseModal()" aria-label="Close">✕</button></div>
    ${noPrice ? `<div class="j-sub" style="color:var(--bear)">No price was found for ${escHtml(t.sym.replace(/^(NSE|MCX):/, ''))} - pick the stock from the list. After a demerger or split, correct the entry, stop and quantity too.</div>` : ''}
    ${t.kind === 'stock' ? jSymField(t.sym.replace(/^NSE:/, '')) : ''}
    <div class="j-grid">${body}</div>
    <div class="j-risk" id="j-risk"></div>
    <div class="j-actions"><button class="idea-btn" onclick="jSaveEdit('${escHtml(id)}')">Save</button><button class="idea-btn ghost" onclick="jCloseModal()">Cancel</button></div>`);
  if(t.kind === 'stock'){ jSymWire(); jSymCheck(); }
}
async function jSaveEdit(id){
  const a = jLoad(), t = a.find(x => x.id === id); if(!t) return jCloseModal();
  const msg = m => { const el = document.getElementById('j-risk'); if(el) el.innerHTML = `<b style="color:var(--bear)">${escHtml(m)}</b>`; };
  const n = { ...t, qty: jNum('j-qty') };
  if(t.kind === 'option'){
    Object.assign(n, { shortStrike: jNum('j-short'), longStrike: jNum('j-long'), credit: jNum('j-credit'), expiry: document.getElementById('j-exp')?.value || t.expiry });
    n.wing = n.longStrike > 0 ? Math.abs(n.shortStrike - n.longStrike) : 0;
    n.label = n.longStrike > 0 ? `${t.setup || 'Credit spread'} ${n.shortStrike}/${n.longStrike}` : `${t.setup || 'Naked sell'} ${n.shortStrike}${t.callStrike ? ' PE + ' + t.callStrike + ' CE' : ''} (naked)`;
    if(!(n.credit > 0) || !(n.shortStrike > 0)) return msg('Sell strike and credit are needed');
  } else {
    Object.assign(n, { entry: jNum('j-entry'), stop: jNum('j-stop'), t1: jNum('j-t1') });
    if(!Number.isFinite(n.t1) || n.t1 <= 0) n.t1 = null;
    if(!(n.entry > 0) || !(n.stop > 0)) return msg('Entry and stop-loss are needed');
    if(n.side !== 'SELL' && n.stop >= n.entry) return msg('For a buy, the stop must be below the entry');
  }
  if(!(n.qty > 0)) return msg('Quantity / lots must be above 0');
  if(t.kind === 'stock'){
    const sym = jSymNorm(document.getElementById('j-sym')?.value);
    if(sym !== t.sym && !(await jSymCheck())) return msg('No price for this stock - pick it from the list');
    n.sym = sym || t.sym;
  }
  n.riskRs = +jRiskRs(n).toFixed(2);
  Object.assign(t, n); jSave(a); jCloseModal(); tabJournal();
}
function jFromForm(p){
  const kind = p.kind || 'stock';
  const t = { id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), kind, sym: p.sym ? String(p.sym).trim().toUpperCase() : jSymNorm(document.getElementById('j-sym')?.value),
    name: p.name || '', setup: p.setup || (kind === 'stock' ? 'Manual' : ''), side: p.side || 'BUY', qty: jNum('j-qty'), lotQty: +p.lotQty || (kind === 'stock' ? 1 : 1),
    openedAt: document.getElementById('j-date')?.value || jTodayKey(), status: 'open', note: document.getElementById('j-note')?.value || '' };
  if(t.sym && !/^(NSE|MCX):/.test(t.sym)) t.sym = 'NSE:' + t.sym;
  if(kind === 'option') Object.assign(t, { optType: p.optType || 'P', shortStrike: jNum('j-short'), longStrike: jNum('j-long'), credit: jNum('j-credit'), expiry: document.getElementById('j-exp')?.value || p.expiry || '',
    wing: jNum('j-long') > 0 ? Math.abs(jNum('j-short') - jNum('j-long')) : 0, callStrike: +p.callStrike || null,
    label: jNum('j-long') > 0 ? `${p.setup || 'Credit spread'} ${jNum('j-short')}/${jNum('j-long')}` : `${p.setup || 'Naked sell'} ${jNum('j-short')}${p.callStrike ? ' PE + ' + p.callStrike + ' CE' : ''} (naked)` });
  else Object.assign(t, { entry: jNum('j-entry'), stop: jNum('j-stop'), t1: jNum('j-t1'), t2: +p.t2 || null, calK: +p.calK || 1, exitDays: +p.exitDays || null, ...(p.exitMode ? { exitMode: p.exitMode } : {}) });
  return t;
}
async function jSaveTrade(){
  const p = J_PENDING || {}, t = jFromForm(p);
  if(!p.sym && t.sym && !(await jSymCheck())){ const el = document.getElementById('j-risk'); if(el) el.innerHTML = `<b style="color:var(--bear)">No price for this stock - pick it from the list so the app can follow it</b>`; return; }
  const bad = !t.sym ? 'Symbol is missing' : !(t.qty > 0) ? 'Quantity / lots must be above 0'
    : t.kind === 'option' ? (!(t.credit > 0) || !(t.shortStrike > 0) ? 'Sell strike and credit are needed' : '')
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

/* ── Phone / browser alerts (Web Push): how many devices the server sends alerts to ── */
function jPushHtml(st){
  if(!st) return '';
  const n = +st.devices || 0;
  return `<div class="idea-card j-push">
    <div class="idea-head"><div><div class="idea-kicker">Phone / browser alerts</div><div class="idea-title">${!st.enabled ? 'Not available on this server' : n ? `On for ${n} device${n === 1 ? '' : 's'}` : 'No device gets alerts yet'}</div></div></div>
    <div class="idea-foot">Stop / target on your trades, new READY stocks, the 09:30 brief, MCX 09:45 / 17:00 and Nifty options 10:00 come as notifications. A deploy clears the device list - open TradeDesk once on each device afterwards and it signs up again.</div>
    <div class="j-actions"><button class="idea-btn" onclick="enablePushNow().then(() => setTimeout(tabJournal, 800))">Turn on for this device</button>${n ? '<button class="idea-btn ghost" onclick="testPushNow()">Send test</button>' : ''}</div>
  </div>`;
}

/* Angel One SmartAPI (live premiums, India VIX, index values): the day's login - Angel One ends it at midnight. */
async function jAngel(action){
  const box = document.getElementById('j-angel-msg');
  if(action === 'connect'){ location.href = API + '/api/smartapi/login'; return; }
  try{
    const r = await fetch(API + '/api/smartapi/' + action, { method:'POST', credentials:'same-origin' });
    const j = await r.json().catch(() => ({}));
    if(!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    if(box) box.innerHTML = 'Disconnected.';
    setTimeout(tabJournal, 800);
  }catch(e){ if(box) box.innerHTML = `<span style="color:var(--bear)">${escHtml(e.message)}</span>`; }
}
function jAngelHtml(st){
  if(!st) return '';
  const tm = iso => { try{ return new Date(iso).toLocaleString('en-IN', {day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'Asia/Kolkata'}); }catch{ return iso; } };
  const msg = window.TD_ANGEL_MSG; window.TD_ANGEL_MSG = null;
  const envNote = st.configured ? '' : `<div style="display:block;font-size:.78rem;line-height:1.55;color:var(--tx2);margin:8px 0"><b>This server sees:</b> SMARTAPI_API_KEY ${st.keySet ? '✓' : '✗ missing'}${(st.envNames || []).length ? ` · variable names found: ${st.envNames.map(escHtml).join(', ')}` : ' · no variable with SMARTAPI or ANGEL in its name'}. The <b>Connect Angel One</b> button appears here once it shows ✓ (after Render restarts with it).</div>`;
  const steps = `<ol class="j-steps"><li>On <b>smartapi.angelone.in</b> → My Apps, open your app and set the <b>Redirect URL</b> to <code>${escHtml(st.redirectUrl || '/api/smartapi/callback')}</code></li><li>Render → your service → <b>Environment</b> → add <code>SMARTAPI_API_KEY</code> (the API key from the same app page) → save (it redeploys). Your client code, PIN and TOTP are never needed here.</li><li>When Render has restarted, reload this page: a <b>Connect Angel One</b> button appears on this card - press it once every morning (Angel One ends the login at midnight).</li></ol>`;
  const au = st.auto || {};
  const state = !st.configured ? 'Not set up' : st.connected ? `Connected${st.name ? ' as ' + escHtml(st.name) : ''} · until ${tm(st.until)}${au.set ? ' · automatic login' : ''}` : au.set && !au.stopped ? 'Not connected yet - logs in automatically (on start, 08:40 and when data is needed)' : 'Not connected today';
  const autoLine = au.set ? `<br>Automatic login: ON${au.lastOk ? ` · last ${tm(au.lastOk)}` : ''}${au.stopped ? ` · <b style="color:var(--bear)">${escHtml(au.stopped)}</b>` : au.lastError ? ` · <span style="color:var(--bear)">last try failed: ${escHtml(au.lastError)}</span>` : ''}`
    : (au.clientCodeSet || au.pinSet || au.totpSecretSet) ? `<br>Automatic login: OFF - Render has ${['SMARTAPI_CLIENT_CODE', 'SMARTAPI_PIN', 'SMARTAPI_TOTP_SECRET'].filter((k, i) => !( [au.clientCodeSet, au.pinSet, au.totpSecretSet][i])).join(', ')} missing` : '';
  const ins = st.instruments, miss = ins?.notFound?.length ? ` · not listed by Angel One (Yahoo used): ${ins.notFound.map(s => escHtml(s.replace(/^NSE:/, ''))).join(', ')}` : '';
  return `<div class="idea-card j-kite">
    <div class="idea-head"><div><div class="idea-kicker">Angel One SmartAPI (market data)</div><div class="idea-title">${state}</div></div><div class="idea-view ${st.ready ? 'bull' : st.configured ? 'bear' : 'neutral'}">${st.ready ? 'ON' : 'OFF'}</div></div>
    <div class="idea-foot">When connected: live option premiums for trade ideas, the option builder and the Track record; the NSE indices Angel One lists (Nifty, Bank Nifty, Fin Services, sectors); India VIX - without asking NSE. Read-only: TradeDesk never places orders.${autoLine}${ins ? `<br>Instrument list ${escHtml(ins.day || '')}: ${ins.indices} indices${miss}${st.lastOk ? ` · last Angel One answer ${tm(st.lastOk)}` : ''}` : ''}${st.lastError ? `<br><span style="color:var(--tx3)">Last Angel One error: ${escHtml(st.lastError)}</span>` : ''}</div>
    ${st.configured ? '' : envNote + steps}
    <div class="j-actions">${st.configured ? `<button class="idea-btn" onclick="jAngel('connect')">${st.connected ? 'Reconnect' : 'Connect Angel One'}</button>` : ''}${st.connected ? `<button class="idea-btn ghost" onclick="jAngel('logout')">Disconnect</button>` : ''}</div>
    <div id="j-angel-msg" class="idea-foot">${msg ? (msg === 'ok' ? '<span style="color:var(--bull)">Angel One connected ✓</span>' : `<span style="color:var(--bear)">Angel One login: ${escHtml(msg)}</span>`) : ''}</div>
  </div>`;
}

/* Portfolio limits (backtest: at most 5 open positions changed results more than most entry filters; at most 2 per
   sector cut the worst drop). Sector names come from the stock list (one /api/universe call, kept for the session). */
let J_SECTORS = null;
function jPortfolioWarn(open, sectors, pct, lim){
  const w = [], stocks = open.filter(t => t.kind === 'stock');
  if (open.length > 5) w.push(`${open.length} open trades - the backtest used at most 5 at a time; skip new ones until some close`);
  if (pct > lim) w.push(`open risk ${pct.toFixed(1)}% is above your ${lim}% limit`);
  if (sectors) { const by = {}; stocks.forEach(t => { const s = sectors[t.sym.replace(/^NSE:/, '')]; if (s) (by[s] = by[s] || []).push(t.sym.replace(/^NSE:/, '')); });
    for (const [s, list] of Object.entries(by)) if (list.length > 2) w.push(`${list.length} trades in ${s} (${list.join(', ')}) - keep at most 2 per sector`); }
  return w.length ? `<div class="idea-hedge" style="border-color:var(--bear);margin-top:8px"><b>⚠ Portfolio check:</b> ${w.map(escHtml).join(' · ')}</div>`
    : open.length ? `<div class="idea-foot" style="margin-top:6px">✓ Portfolio check: ${open.length} of 5 open trades${sectors ? ', no more than 2 per sector' : ''}.</div>` : '';
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
    <div class="idea-foot">What you lose if every open trade hits its stop. Limit <input type="number" min="1" max="100" step="0.5" value="${lim}" style="width:60px" onchange="jSetLimit(this.value)">% of capital (capital and risk % come from the position calculator).</div>
    <div data-j-port>${jPortfolioWarn(open, null, pct, lim)}</div></div>`;
  const row = t => {
    const opt = t.kind === 'option';
    return `<div class="j-row" data-jid="${escHtml(t.id)}">
      <div class="j-row-main"><b>${escHtml(t.sym.replace(/^(NSE|MCX):/, ''))}</b> <span class="pl-tag ${opt ? 'watch' : 'ready'}">${escHtml(opt ? (t.label || 'Credit spread') : (t.setup || t.kind))}</span>
        <div class="j-row-sub">${opt ? `Credit ${fmt(t.credit)} pts · ${t.qty} lot${t.qty > 1 ? 's' : ''} · expiry ${escHtml(t.expiry || '—')}` : `Entry ${fmt(t.entry)} · SL ${fmt(t.stop)} · T1 ${t.t1 ? fmt(t.t1) : '—'} · ${t.qty} ${t.kind === 'mcx' ? 'lot' + (t.qty > 1 ? 's' : '') : 'sh'}`} · since ${escHtml(t.openedAt || '')} · risk ${jInr(t.riskRs ?? jRiskRs(t))}</div></div>
      <div class="j-row-live" data-jlive>…</div>
      <div class="j-row-act"><button class="idea-btn" onclick="closeTradeForm('${escHtml(t.id)}')">Close</button><button class="idea-btn ghost" onclick="jEditTrade('${escHtml(t.id)}')" aria-label="Edit" title="Edit">✎</button><button class="idea-btn ghost" onclick="jDelete('${escHtml(t.id)}')" aria-label="Delete">✕</button></div>
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
    <div class="idea-card"><div class="idea-head"><div><div class="idea-kicker">Open trades</div><div class="idea-title">${open.length ? `${open.length} open` : 'No open trade'}</div>${open.length ? '<div class="j-total" data-jtotal>Profit / loss now: loading…</div>' : ''}</div><button class="idea-btn" onclick="openTradeForm({})">+ Add manually</button></div>
      ${open.length ? open.map(row).join('') : '<div class="idea-foot">Tap 📒 on a stock\'s trade plan, the Gold Petal idea or the Nifty rule card when you take a trade - or add one here.</div>'}</div>
    ${statsHtml}${closedHtml}<div data-j-angel></div><div data-j-push></div>`;
  apiFetch('/api/smartapi/status', 10000).then(st => { if(live()) { const el = tc.querySelector('[data-j-angel]'); if(el) el.innerHTML = jAngelHtml(st); } }).catch(() => {});
  if (open.some(t => t.kind === 'stock')) (J_SECTORS ? Promise.resolve(J_SECTORS) : apiFetch('/api/universe', 20000).then(u => (J_SECTORS = Object.fromEntries((u.rows || []).filter(r => r.sym && r.sector).map(r => [r.sym, r.sector])))))
    .then(sec => { if (!live()) return; const el = tc.querySelector('[data-j-port]'); if (el) el.innerHTML = jPortfolioWarn(open, sec, pct, lim); }).catch(() => {});
  apiFetch('/api/push/key', 10000).then(st => { if(live()) { const el = tc.querySelector('[data-j-push]'); if(el) el.innerHTML = jPushHtml(st); } }).catch(() => {});
  /* Live P&L (same cached quick price as the sidebar), 3 at a time, then the total of the open trades. */
  let pnlSum = 0, priced = 0, missing = 0;
  const one = async t => {
    if(!live()) return;
    const el = tc.querySelector(`[data-jid="${CSS.escape(t.id)}"] [data-jlive]`); if(!el) return;
    try{
      const q = await apiFetch(`/api/quickprice?sym=${encodeURIComponent(t.kind === 'option' ? 'NSE:NIFTY' : t.sym)}`, 20000);
      if(!live()) return;
      if(!(+q.price > 0)) throw new Error('no price');
      if(t.kind === 'option'){
        const p = +q.price, k = +t.shortStrike, tested = t.optType === 'P' ? p < k : p > k, dist = Math.abs(p - k) / p * 100;
        el.innerHTML = `<span style="color:${tested ? 'var(--bear)' : 'var(--bull)'}">Nifty ${fmt(p, 0)} · ${tested ? 'through' : `${dist.toFixed(1)}% from`} the short ${k}</span>`;
        missing++;   /* a spread's P&L needs its option prices, not Nifty - not in the total */
      } else {
        const p = +q.price * (t.kind === 'mcx' ? (+t.calK || 1) : 1), pnl = jPnl(t, p), r = t.riskRs > 0 ? pnl / t.riskRs : null;
        const mv = t.entry > 0 ? (p - t.entry) / t.entry * 100 * (t.side === 'SELL' ? -1 : 1) : null;
        pnlSum += pnl; priced++;
        const flag = (t.side !== 'SELL' ? p <= t.stop : p >= t.stop) ? ' · <b style="color:var(--bear)">at / below stop</b>' : t.t1 && (t.side !== 'SELL' ? p >= t.t1 : p <= t.t1) ? ' · <b style="color:var(--bull)">T1 reached - book half</b>' : '';
        el.innerHTML = `<span style="color:${pnl >= 0 ? 'var(--bull)' : 'var(--bear)'}">Now ${fmt(p)} · ${pnl >= 0 ? '+' : '-'}${jInr(Math.abs(pnl))}${mv != null ? ` (${mv >= 0 ? '+' : ''}${mv.toFixed(1)}%)` : ''}${r != null ? ` · ${r >= 0 ? '+' : ''}${r.toFixed(2)}R` : ''}</span>${flag}`;
      }
    }catch{
      missing++;
      el.innerHTML = t.kind === 'option' ? 'Nifty price n/a' : `<span style="color:var(--bear)">No price for ${escHtml(t.sym.replace(/^(NSE|MCX):/, ''))}</span> <button class="idea-btn ghost j-fix" onclick="jEditTrade('${escHtml(t.id)}', 1)">Change stock</button>`;
    }
  };
  const queue = open.slice();
  await Promise.all([0, 1, 2].map(async () => { while(queue.length && live()) await one(queue.shift()); }));
  const tot = tc.querySelector('[data-jtotal]'); if(!tot || !live()) return;
  if(!priced){ tot.textContent = missing ? 'Profit / loss now: no stock price available' : ''; return; }
  tot.innerHTML = `Profit / loss now: <b style="color:${pnlSum >= 0 ? 'var(--bull)' : 'var(--bear)'}">${pnlSum >= 0 ? '+' : '-'}${jInr(Math.abs(pnlSum))}</b>${cap > 0 ? ` (${pnlSum >= 0 ? '+' : ''}${(pnlSum / cap * 100).toFixed(2)}% of capital)` : ''} · ${pnlSum >= 0 ? 'in profit' : 'in loss'}${missing ? ` · ${missing} trade${missing > 1 ? 's' : ''} not counted` : ''} <span style="color:var(--tx3);font-weight:400">· before charges</span>`;
}

/* Notification links: /?sym=NSE:GAIL opens that instrument, /?view=trades or /?view=screener opens those pages. */
(function deepLink(){
  let q; try{ q = new URLSearchParams(location.search); }catch{ return; }
  const sym = (q.get('sym') || '').toUpperCase(), view = q.get('view');
  if(q.get('angel')) window.TD_ANGEL_MSG = q.get('angel');   /* result of the Angel One login, shown on its card */
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
