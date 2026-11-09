/* ══════════════════════════════════════════════════════════════════════
   TradeDesk shared swing-plan engine
   Loaded by BOTH the server (screener) and the browser (Overview / Strategy tab) so the two always compute
   the same support/resistance levels, setup entry/stop/target, setup choice, risk-reward, pullback volume
   rule and relative strength. Pure functions only - no DOM, no network.
══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SwingPlan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const R2 = v => { if (v == null || v === '') return null; const x = Number(v); return Number.isFinite(x) ? +x.toFixed(2) : null; };
  const valid = v => Number.isFinite(+v) && +v > 0;
  const hi = a => { const v = (a || []).map(Number).filter(Number.isFinite); return v.length ? Math.max(...v) : null; };
  const lo = a => { const v = (a || []).map(Number).filter(Number.isFinite); return v.length ? Math.min(...v) : null; };

  /* Support / resistance from COMPLETED sessions. i = index of the previous completed session. */
  function srLevels({ H, L, C, i, price, ph, pl, pc }) {
    H = (H || []).map(Number); L = (L || []).map(Number); C = (C || []).map(Number);
    const idx = Number.isInteger(i) && i >= 0 ? i : Math.max(0, C.length - 2);
    ph = valid(ph) ? +ph : H[idx]; pl = valid(pl) ? +pl : L[idx]; pc = valid(pc) ? +pc : C[idx];
    const pp = R2((ph + pl + pc) / 3);
    const upto = (arr, days) => arr.slice(Math.max(0, idx - days + 1), idx + 1);
    const r1 = R2(hi(upto(H, 7))), s1 = R2(lo(upto(L, 7)));
    const r2 = R2(hi(upto(H, 14))), s2 = R2(lo(upto(L, 14)));
    const r3 = R2(hi(upto(H, 21))), s3 = R2(lo(upto(L, 21)));
    const yw_high = R2(hi(H.slice(Math.max(0, idx - 251), idx + 1)));
    const yw_low = R2(lo(L.slice(Math.max(0, idx - 251), idx + 1)));
    const levels = [
      { n:'52-Week High', v:yw_high, type:'Major Resistance', k:'ptr' },
      { n:'Swing R3 — 21D High', v:r3, type:'Monthly swing resistance', k:'ptr' },
      { n:'Swing R2 — 14D High', v:r2, type:'2-week swing resistance', k:'ptr' },
      { n:'Swing R1 — 7D High', v:r1, type:'1-week swing resistance', k:'ptr' },
      { n:'Prev Day High', v:R2(ph), type:'Previous session high', k:'ptr' },
      { n:'Pivot Point', v:pp, type:'Prev H/L/C midpoint', k:'ptp' },
      { n:'Prev Day Close', v:R2(pc), type:'Reference', k:'ptp' },
      { n:'Prev Day Low', v:R2(pl), type:'Previous session low', k:'pts' },
      { n:'Swing S1 — 7D Low', v:s1, type:'1-week swing support', k:'pts' },
      { n:'Swing S2 — 14D Low', v:s2, type:'2-week swing support', k:'pts' },
      { n:'Swing S3 — 21D Low', v:s3, type:'Monthly swing support', k:'pts' },
      { n:'52-Week Low', v:yw_low, type:'Major Support', k:'pts' }
    ].filter(x => Number.isFinite(x.v)).sort((a, b) => b.v - a.v);
    const resistances = levels.filter(x => x.k === 'ptr' && x.v > price).sort((a, b) => a.v - b.v);
    const supports = levels.filter(x => x.k === 'pts' && x.v < price).sort((a, b) => b.v - a.v);
    return { price, ph:R2(ph), pl:R2(pl), pc:R2(pc), pp, r1, r2, r3, s1, s2, s3, yw_high, yw_low, levels, resistances, supports,
      priceAboveAllResistance: Number.isFinite(price) && !resistances.length,
      priceBelowAllSupport: Number.isFinite(price) && !supports.length,
      nearestResistance: resistances[0] || null, nextResistance: resistances[1] || null,
      nearestSupport: supports[0] || null, nextSupport: supports[1] || null };
  }

  /* Wilder ATR(14), seeded with the simple average of the first 14 true ranges. */
  function atrWilder(C, H, L, price, r1, s1) {
    if (!C || C.length < 16 || !H || !L) return Math.max(price * 0.015, Math.abs(r1 - s1) || price * 0.02, 1);
    const tr = [];
    for (let i = 1; i < C.length; i++) tr.push(Math.max(H[i] - L[i], Math.abs(H[i] - C[i-1]), Math.abs(L[i] - C[i-1])));
    let a = tr.slice(0, 14).reduce((x, y) => x + y, 0) / 14;
    for (let i = 14; i < tr.length; i++) a = (a * 13 + tr[i]) / 14;
    return a || Math.max(price * 0.015, Math.abs(r1 - s1) || price * 0.02, 1);
  }

  /* Structure stop clamped to 1.0-2.25 ATR from the entry (primary) or 0.75-1.75 ATR (trail). */
  function calcAtrStopLoss({ side, price, structuralStop, atr, fallbackStop, phase = 'primary' }) {
    const p = +price;
    const a = Number.isFinite(+atr) && +atr > 0 ? +atr : Math.max(p * 0.015, 1);
    const long = side === 'long' || side === 'Bullish';
    const short = side === 'short' || side === 'Bearish';
    const cfg = phase === 'trail' ? { min:0.75, max:1.75, pref:1.20 } : { min:1.00, max:2.25, pref:1.60 };
    let stop = Number.isFinite(+structuralStop) ? +structuralStop : null;
    const fallback = Number.isFinite(+fallbackStop) ? +fallbackStop : null;
    if (long) {
      if (!(Number.isFinite(stop) && stop < p)) stop = (Number.isFinite(fallback) && fallback < p) ? fallback : p - cfg.pref * a;
      const risk = p - stop;
      if (risk < cfg.min * a) stop = p - cfg.min * a;
      if (risk > cfg.max * a) stop = p - cfg.max * a;
      return R2(stop);
    }
    if (short) {
      if (!(Number.isFinite(stop) && stop > p)) stop = (Number.isFinite(fallback) && fallback > p) ? fallback : p + cfg.pref * a;
      const risk = stop - p;
      if (risk < cfg.min * a) stop = p + cfg.min * a;
      if (risk > cfg.max * a) stop = p + cfg.max * a;
      return R2(stop);
    }
    return Number.isFinite(stop) ? R2(stop) : null;
  }

  /* Entry / stop / target for the six long setups (numbers only; the UI adds the wording). */
  /* Nearest swing support (7D/14D low) at or just under price - the level the Support Bounce setup,
     its score and its gate all use. */
  function swingSupport(sr, price) {
    return [sr?.s1, sr?.s2].filter(v => valid(v) && +v <= +price * 1.01).map(Number)
      .sort((a, b) => Math.abs(price - a) - Math.abs(price - b))[0] || null;
  }

  function longSetups({ price, e20, e50, sr, atr }) {
    const { pp, r1, r2, r3, s1, s2 } = sr;
    const supports = (sr.supports || []).map(x => x.v).filter(v => Number.isFinite(v) && v < price).sort((a, b) => b - a);
    const resistances = (sr.resistances || []).map(x => x.v).filter(v => Number.isFinite(v) && v > price).sort((a, b) => a - b);
    const nearSupport = supports[0] || (Number.isFinite(e50) && e50 < price ? e50 : s1);
    const nearResistance = resistances[0] || (Number.isFinite(e20) && e20 > price ? e20 : r1);
    const nextResistance = resistances[1] || r2 || price + atr * 2;
    const farResistance = resistances[2] || r3 || nextResistance + atr;
    const uniq = arr => [...new Set(arr.filter(valid).map(v => R2(+v)))];
    const minMoveFrom = entry => Math.max(atr * 0.9, Math.abs(r1 - s1) * 0.35 || 0, Math.max(+entry || price, 1) * 0.01);
    const stopLong = (entry, structural, fallback) => calcAtrStopLoss({ side:'long', price:entry, structuralStop:structural, atr,
      fallbackStop: valid(fallback) ? fallback : entry - Math.max(atr * 1.4, minMoveFrom(entry)), phase:'primary' });
    const targetLong = (entry, ...levels) => {
      const minMove = minMoveFrom(entry);
      const hit = uniq(levels).filter(v => v > entry + minMove * 0.5).sort((a, b) => a - b)[0];
      return R2(hit || (entry + Math.max(minMove * 1.8, atr * 1.8)));
    };
    const firstBelow = (entry, ...levels) => uniq(levels).filter(v => v < entry).sort((a, b) => b - a)[0];
    /* Breakouts target a measured move (7-day range height above the breakout level, min 2 ATR). */
    const measured = entry => Math.max(targetLong(entry, r2, nextResistance, r3, farResistance), entry + Math.max(atr * 2, valid(r1) && valid(s1) ? r1 - s1 : 0));

    const emaEntry = valid(e20) ? e20 : nearSupport;
    const ema50Entry = valid(e50) ? e50 : nearSupport;
    const srEntry = swingSupport(sr, price) || nearSupport;
    const boEntry = valid(r1) ? r1 : price + Math.max(atr, price * 0.015);
    const momEntry = price;
    return {
      nearSupport, nearResistance, nextResistance, farResistance,
      'EMA20 Pullback':        { entry:R2(emaEntry),   stop:stopLong(emaEntry, Math.min(emaEntry, nearSupport) - atr * 0.25),   target:targetLong(Math.max(emaEntry, price), r1, r2, nextResistance, r3, farResistance) },
      'EMA50 Deep Pullback':   { entry:R2(ema50Entry), stop:stopLong(ema50Entry, Math.min(ema50Entry, nearSupport) - atr * 0.35), target:targetLong(Math.max(ema50Entry, price), r1, r2, nextResistance, r3, farResistance) },
      'Support Bounce':        { entry:R2(srEntry),    stop:stopLong(srEntry, srEntry - atr * 0.45),                                target:targetLong(Math.max(srEntry, price), r1, nextResistance, r2, farResistance) },
      'Pre-Breakout Watch':    { entry:R2(boEntry),    stop:stopLong(boEntry, firstBelow(boEntry, e20, pp, nearSupport, s1, price - atr) || boEntry - Math.max(atr * 1.5, minMoveFrom(boEntry))), target:R2(measured(boEntry)) },
      'Breakout with Volume':  { entry:R2(boEntry),    stop:stopLong(boEntry, Math.min(boEntry, valid(e20) ? e20 : boEntry) - atr * 0.35), target:R2(measured(boEntry)) },
      'Momentum Continuation': { entry:R2(momEntry),   stop:stopLong(momEntry, valid(e20) ? e20 - atr * 0.25 : momEntry - atr),       target:targetLong(momEntry, nearResistance, r1, r2, farResistance) },
    };
  }

  /* Risk-reward at the CURRENT price using a setup's own stop and target (what the Overview shows). */
  function planRR(price, stop, target) {
    const p = +price, s = +stop, t = +target;
    if (!(valid(p) && valid(s) && valid(t)) || !(s < p) || !(t > p)) return 0;
    return +((t - p) / (p - s)).toFixed(2);
  }

  /* R:R for a setup. Pullbacks/bounces are bought now, so R:R is from the current price. Breakout-type setups
     (Pre-Breakout, Breakout) are bought at their trigger level, so R:R is from max(current price, trigger). */
  function setupRR(name, price, card) {
    if (!card) return 0;
    const trigger = /breakout/i.test(name || '');
    const from = trigger ? Math.max(+price, +card.entry || 0) : +price;
    return planRR(from, card.stop, card.target);
  }

  /* Quick Bounce (RSI-2): a short dip inside an uptrend. Close above its 50- and 200-day averages and the 2-day
     RSI (Wilder) under 10. Buy next open (or near the close), stop 2.5 ATR(14) below the close, sell at the first
     close above the 5-day average or after 10 trading days. The caller also needs Nifty above its 200-day average.
     Backtest 7 Nov 2026 (235 large caps, 1 year, after 0.25% costs): 64-67% winners, +0.30% per trade, 3-4 days.
     Pass COMPLETED daily bars only (a forming bar makes the signal flicker during the day). */
  function quickBounce({ C, H, L }) {
    const n = (C || []).length;
    if (n < 210) return null;
    const sma = p => C.slice(n - p).reduce((a, b) => a + +b, 0) / p;
    let ag = 0, al = 0;
    for (let i = 1; i < n; i++) {
      const d = C[i] - C[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
      if (i <= 2) { ag += g / 2; al += l / 2; } else { ag = (ag + g) / 2; al = (al + l) / 2; }
    }
    const rsi2 = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    let atr = 0;
    for (let i = 1; i < n; i++) {
      const tr = Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1]));
      atr = i <= 14 ? atr + tr / 14 : (atr * 13 + tr) / 14;
    }
    const close = +C[n - 1], sma5 = sma(5), sma50 = sma(50), sma200 = sma(200);
    const ok = close > sma200 && close > sma50 && rsi2 < 10;
    return { ok, rsi2: +rsi2.toFixed(1), close: R2(close), sma5: R2(sma5), sma50: R2(sma50), sma200: R2(sma200), atr: R2(atr), stop: R2(close - 2.5 * atr) };
  }

  /* Option leg price from an NSE chain row (server Option Builder and the options idea card): the bid/ask
     middle when the spread is tight (<= 15% of the middle); else the last traded price, but only if it traded
     today and sits inside the bid/ask; else null (the caller keeps its estimate). A stale last price on an
     illiquid strike priced the Nifty 23650 PE at 256.55 - above the nearer 24050 PE (130.10). */
  function ocPremium(chain, k, t) {
    const row = (chain?.strikes || []).find(r => +r.k === +k), o = row ? (t === 'C' ? row.ce : row.pe) : null;
    if (!o) return null;
    const mid = o.bid > 0 && o.ask > 0 ? (o.bid + o.ask) / 2 : 0;
    if (mid > 0 && (o.ask - o.bid) / mid <= 0.15) return R2(mid);
    const inBand = !(o.bid > 0 && o.ask > 0) || (o.ltp >= o.bid && o.ltp <= o.ask);
    return o.ltp > 0 && o.vol > 0 && inBand ? +o.ltp : null;
  }

  /* Choppy market (screener and Overview): price inside its 7-day range, RSI 42-58 and ADX under 16. It used to
     also count EMA20 within 1% of EMA50 as chop - that is what every pullback in an uptrend looks like, so it
     turned pullbacks with a real trend (LGEINDIA ADX 19.5) into "Sideways" on the Overview only. */
  function isChoppy({ price, r1, s1, rsi, adx }) {
    const p = +price, a = Number(adx?.adx ?? adx);
    const inside = valid(p) && valid(r1) && valid(s1) && p < +r1 * 0.998 && p > +s1 * 1.002;
    const rsiNeutral = Number.isFinite(+rsi) && +rsi >= 42 && +rsi <= 58;
    return !!(inside && rsiNeutral && Number.isFinite(a) && a < 16);
  }

  /* Buy-limit price for a pullback / bounce whose R:R from the current price is below minRR: the highest price
     where R:R (same stop and T1) reaches minRR, rounded down to 0.05. It must stay inside the setup's zone
     (no lower than 0.5% under the EMA / support level - below that the pullback has failed) and above the
     stop. The target stays the one measured from the current price: levels between the limit and today's
     price have already been cleared, so they are not counted as resistance. */
  function limitEntry(name, price, card, minRR = 1.25) {
    if (!card || !/pullback|bounce/i.test(name || '')) return null;
    const p = +price, S = +card.stop, T = +card.target, Z = +card.entry;
    if (![p, S, T, Z].every(valid) || !(T > p) || !(S < Z)) return null;
    if (planRR(p, S, T) >= minRR) return null;
    const lim = Math.floor((T + minRR * S) / (1 + minRR) * 20) / 20;
    if (!(lim < p) || lim < Z * 0.995 || !(lim > S)) return null;
    return { price: R2(lim), rr: planRR(lim, S, T), zone: R2(Z), stop: R2(S), target: R2(T) };
  }

  /* Pullback volume rule: the pullback itself should be quiet; the bounce day needs participation.
     todayRatio = today's (projected) volume / 20-day average; dryRatio = last 3 completed days / 20-day average. */
  function pullbackVolume(V, C) {
    const n = (C || []).length;
    const v = (V || []).map(x => Number(x) || 0);
    const end = Math.max(0, Math.min(v.length, n) - 1);
    const base = v.slice(Math.max(0, end - 20), end);
    const avg = base.reduce((a, b) => a + b, 0) / Math.max(1, base.length);
    const last3 = v.slice(Math.max(0, end - 3), end);
    const avg3 = last3.reduce((a, b) => a + b, 0) / Math.max(1, last3.length);
    const todayRatio = avg ? (v[end] || 0) / avg : 0;
    const dryRatio = avg ? avg3 / avg : 1;
    const green = n >= 2 && +C[n-1] > +C[n-2];
    return { todayRatio:+todayRatio.toFixed(2), dryRatio:+dryRatio.toFixed(2), green, quietPullback: dryRatio <= 1.0,
             heavyPullback: dryRatio > 1.25, bounceOk: green && todayRatio >= 1.0 };
  }

  /* Weekly trend built from the daily bars (one candle per IST week, last close of the week), so the screener
     and the Overview judge the same weekly candles. Up = weekly close above the 20-week EMA and the 10-week
     EMA at or above the 20-week EMA. null when there are fewer than 21 weeks. */
  function weeklyTrend(T, C) {
    const wk = []; let last = null;
    for (let i = 0; i < (C || []).length; i++) {
      const t = Number(T?.[i]), c = Number(C[i]);
      if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
      const d = new Date(t * 1000 + 330 * 60000), dow = (d.getUTCDay() + 6) % 7;
      const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
      if (monday !== last) { wk.push(c); last = monday; } else wk[wk.length - 1] = c;
    }
    if (wk.length < 21) return null;
    const ema = p => { const k = 2 / (p + 1); let e = wk.slice(0, p).reduce((a, b) => a + b, 0) / p; for (let i = p; i < wk.length; i++) e = wk[i] * k + e * (1 - k); return e; };
    const close = wk[wk.length - 1], ema10 = ema(10), ema20 = ema(20);
    return { close: R2(close), ema10: R2(ema10), ema20: R2(ema20), weeks: wk.length,
             up: close > ema20 && ema10 >= ema20, down: close < ema20 && ema10 <= ema20 };
  }

  /* Relative strength vs Nifty: return difference in percentage points over ~3 and ~6 months. */
  function relStrength(C, niftyC) {
    const ret = (arr, d) => { const n = arr?.length || 0; return n > d && +arr[n-1-d] > 0 ? (+arr[n-1] / +arr[n-1-d] - 1) * 100 : null; };
    const s3 = ret(C, 63), n3 = ret(niftyC, 63), s6 = ret(C, 126), n6 = ret(niftyC, 126);
    const rs3m = s3 != null && n3 != null ? +(s3 - n3).toFixed(2) : null;
    const rs6m = s6 != null && n6 != null ? +(s6 - n6).toFixed(2) : null;
    return { stock3m: s3 != null ? +s3.toFixed(2) : null, nifty3m: n3 != null ? +n3.toFixed(2) : null, rs3m,
             stock6m: s6 != null ? +s6.toFixed(2) : null, nifty6m: n6 != null ? +n6.toFixed(2) : null, rs6m,
             outperforming: rs3m != null ? rs3m > 0 : null };
  }

  /* Which long setup the price is actually in. Same rules for Overview and screener.
     Pullbacks/bounces rank first (nearest entry wins), then breakout, then momentum (watch-only). */
  /* Watch-only: shown and alerted, never READY. Breakout with Volume was watch-only from 7 Nov 2026 (one-year
     backtest: 33% wins, -0.21R over 108 trades) and is a READY setup again from 9 Nov 2026 at the user's request;
     its own gate (close above the 7-day high on 1.1x+ volume, R:R >= 1.25) still applies. */
  const WATCH_ONLY = new Set(['Pre-Breakout Watch', 'Momentum Continuation']);
  function pickLongSetup({ price, e20, e50, e200, sr, rsi, macd, adx, volBlend, C, L, rrOf }) {
    const supportRef = swingSupport(sr, price);
    const distPct = level => Number.isFinite(+level) && +level > 0 ? Math.abs(+price - +level) / Math.max(Math.abs(+level), 1) * 100 : 999;
    const rsiOkBreak = Number.isFinite(+rsi) ? (+rsi >= 52 && +rsi <= 72) : true;
    const rsiOkPre = Number.isFinite(+rsi) ? (+rsi >= 48 && +rsi <= 68) : true;
    const macdBull = !!(macd && macd.macd >= macd.signal && macd.hist >= 0);
    const trendOk = Number.isFinite(+e50) && Number.isFinite(+e200) && +price > +e50 && +e50 > +e200;
    const brokeR1 = valid(sr?.r1) && +price > +sr.r1 * 1.002;
    /* Pre-Breakout and Breakout both trigger at the 7-day high (r1) - the card's entry and the gate's level. */
    const nearBreakout = valid(sr?.r1) && +sr.r1 > +price && ((+sr.r1 - +price) / +price * 100) <= 2.0;
    const distFromE20 = distPct(e20);
    const adxVal = Number(adx?.adx || adx || 0);
    const nC = Array.isArray(C) ? C.length : 0;
    const greenToday = nC >= 2 && Number(C[nC-1]) > Number(C[nC-2]); /* same as pullbackVolume.green */
    const distributionDay = nC >= 2 && !greenToday && Number(volBlend || 0) >= 1.10;
    /* A confirmed EMA50 bounce 3-5% above EMA50 (today's low touched it, green close) - the same window the
       EMA50 gate accepts. The picker stopped at 3%, so such a stock was handed to Breakout, failed its R:R and
       stayed WATCH although its EMA50 setup had passed (ANTHEM, 4 Nov 2026). */
    const lowToday = Array.isArray(L) && L.length ? Number(L[L.length - 1]) : NaN;
    const e50Signed = Number.isFinite(+e50) && +e50 > 0 ? (+price - +e50) / +e50 * 100 : -999;
    const ema50Bounce = greenToday && e50Signed >= 0 && e50Signed <= 5 && Number.isFinite(lowToday) && lowToday <= +e50 * 1.015;
    let list = [
      { name:'EMA20 Pullback', dist:distPct(e20), priority:1, ok:Number.isFinite(+e20) && Number.isFinite(+e50) && price >= e20 * 0.997 && e20 > e50 && distPct(e20) <= 2.5 },
      { name:'EMA50 Deep Pullback', dist:distPct(e50), priority:2, ok:Number.isFinite(+e50) && Number.isFinite(+e200) && e50 > e200 && ((price >= e50 * 0.995 && distPct(e50) <= 3.0) || ema50Bounce) },
      { name:'Support Bounce', dist:distPct(supportRef), priority:3, ok:Number.isFinite(+supportRef) && price >= supportRef && distPct(supportRef) <= 1.75 },
      { name:'Pre-Breakout Watch', dist:distPct(sr?.r1), priority:4, ok:trendOk && nearBreakout && rsiOkPre && distFromE20 <= 6.5 && (!adxVal || adxVal >= 14) },
      { name:'Breakout with Volume', dist:50, priority:5, ok:greenToday && !distributionDay && trendOk && brokeR1 && rsiOkBreak && distFromE20 <= 6.5 && (Number(volBlend || 0) >= 1.10 || macdBull) && (!adxVal || adxVal >= 16) },
      { name:'Momentum Continuation', dist:99, priority:6, ok:greenToday && !distributionDay && trendOk && +price > +e20 && distFromE20 <= 7.0 && rsiOkBreak && (Number(volBlend || 0) >= 1.0 || macdBull) && (!adxVal || adxVal >= 18) }
    ].filter(x => x.ok);
    /* When several setups qualify, use one whose own R:R works (>= 1.25) if there is one: the nearest-level
       rule alone handed FLUOROCHEM-type stocks to a pullback that fails R:R while their breakout passed,
       and ANTHEM-type stocks to a breakout with R:R 0.54 while their EMA50 bounce had 1.35. */
    { const tradable = list.filter(x => !WATCH_ONLY.has(x.name)); if (tradable.length) list = tradable; }   /* a pullback that qualifies beats a watch-only breakout */
    if (typeof rrOf === 'function') { const good = list.filter(x => +rrOf(x.name) >= 1.25); if (good.length) list = good; }
    const best = list.sort((a, b) => Math.abs(a.dist - b.dist) > 0.15 ? a.dist - b.dist : a.priority - b.priority)[0];
    return best ? best.name : null;
  }

  /* Volume requirement per setup type. */
  function setupVolumeOk(setupName, volBlend, pv) {
    if (/pullback|bounce/i.test(setupName || '')) return !!pv?.bounceOk && !pv?.heavyPullback; /* no heavy selling into it, volume on the bounce day */
    if (/breakout/i.test(setupName || '')) return Number(volBlend) >= 1.10;
    return Number(volBlend) >= 0.8;
  }
  function setupVolumeReason(setupName, volBlend, pv) {
    if (/pullback|bounce/i.test(setupName || '')) {
      if (!pv?.green) return 'Bounce not confirmed: needs a green close';
      if (!(pv.todayRatio >= 1.0)) return `Bounce-day volume ${pv.todayRatio}x is below 1.0x`;
      if (pv.heavyPullback) return `Heavy selling into the pullback (last 3 days ${pv.dryRatio}x average volume)`;
      return null;
    }
    if (/breakout/i.test(setupName || '') && !(Number(volBlend) >= 1.10)) return `Breakout volume ${(+volBlend || 0).toFixed(2)}x is below 1.1x`;
    return null;
  }

  return { R2, srLevels, atrWilder, calcAtrStopLoss, swingSupport, weeklyTrend, longSetups, planRR, setupRR, limitEntry, isChoppy, ocPremium, quickBounce, pullbackVolume, relStrength, pickLongSetup, setupVolumeOk, setupVolumeReason, WATCH_ONLY };
});
