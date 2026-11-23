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

  /* ── MCX futures plan (Overview card AND the server's Gold Petal alerts use this one function) ── */
  function emaArr(d, p) { if (d.length < p) return d.map(() => null); const k = 2 / (p + 1); let e = d.slice(0, p).reduce((a, b) => a + b, 0) / p; const o = new Array(p - 1).fill(null); o.push(e); for (let i = p; i < d.length; i++) { e = d[i] * k + e * (1 - k); o.push(e); } return o; }
  const emaLast = (d, p) => { const a = emaArr(d, p); return a[a.length - 1]; };
  function rsi14(C, p = 14) { if (C.length < p + 2) return null; const d = C.slice(1).map((c, i) => c - C[i]); let g = d.slice(0, p).reduce((a, b) => a + Math.max(0, b), 0) / p, l = d.slice(0, p).reduce((a, b) => a + Math.max(0, -b), 0) / p; for (let i = p; i < d.length; i++) { g = (g * (p - 1) + Math.max(0, d[i])) / p; l = (l * (p - 1) + Math.max(0, -d[i])) / p; } if (g === 0 && l === 0) return 50; if (l === 0) return 100; if (g === 0) return 0; return 100 - 100 / (1 + g / l); }
  /* Gold is traded BUY-ONLY: over 10 years the app's gold sells made about 0R a trade and its buys +0.35R
     (+0.43R when 2 of the 3 drivers below agreed), in a market where gold rose 362%. A downtrend is therefore
     "no new buys / exit a long", never a short. */
  /* Crude oil and natural gas are BUY-ONLY too (19 Nov 2026, 10-year backtest of these rules on COMEX/NYMEX x USD/INR):
     crude buys 59% wins +0.23R, sells 43% / -0.02R; natural gas buys 57% / +0.28R, sells 44% / +0.04R. */
  const BUY_ONLY_MCX = new Set(['MCX:GOLDPETAL', 'MCX:GOLD', 'MCX:CRUDEOIL', 'MCX:NATURALGAS']);
  const GOLD_MCX = new Set(['MCX:GOLDPETAL', 'MCX:GOLD']);
  /* Exit tested for each: gold - full exit at 3R or after 20 trading days (+0.88R a trade vs +0.43R at T1 in 10
     days); crude / natural gas - full exit at T1 or after 10 days (the version that was tested). */
  /* 20 Nov 2026 (user's bar: over 50% wins and profit in 75% of years): gold buys without the driver filter, sold at
     T1 or day 10 - 59% wins, 8 of 10 years (140 trades). With the 2-of-3 driver filter and 3R / 20 days it was 62% but
     only 7 of 10 years, and the gold sell 44% / 5 of 8 years - both dropped. */
  const MCX_EXIT = { 'MCX:GOLDPETAL': { r: null, days: 10 }, 'MCX:GOLD': { r: null, days: 10 }, 'MCX:CRUDEOIL': { r: null, days: 10 }, 'MCX:NATURALGAS': { r: null, days: 10 } };
  function commodityPlan(sym, { C, H, L, price, sr }, opts = {}) {
    const minRR = opts.minRR || 1.25, fmt = v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const e20 = emaLast(C, 20), e50 = emaLast(C, 50), rsi = rsi14(C);
    const atr = atrWilder(C, H, L, price, sr.r1, sr.s1);
    const up = price > e50 && e20 > e50, down = price < e50 && e20 < e50;
    const res = [sr.r1, sr.r2, sr.r3].map(Number).filter(v => v > 0).sort((a, b) => a - b);
    const sup = [sr.s1, sr.s2, sr.s3].map(Number).filter(v => v > 0).sort((a, b) => b - a);
    const buyOnly = BUY_ONLY_MCX.has(sym);
    /* Gold sells only when all 3 drivers point down (dollar up, US yield up, rupee stronger) - the one sell case the
       backtest did not lose on: 12 trades in 10 years, 58% wins, +0.04R. Shown as small size (user's choice). */
    const isGold = GOLD_MCX.has(sym);
    const goldSellOk = false;   /* gold sell removed 20 Nov 2026: 44% wins, 5 of 8 years in the backtest */
    let smallSize = false;
    let side = 'WAIT', entry = null, sl = null, t1 = null, t2 = null, action = '', why = '';
    if (up) {
      side = 'BUY';
      const extended = price - e20 > 1.5 * atr;
      entry = extended ? e20 : price;
      action = extended ? `Wait for a dip to EMA20 ${fmt(e20)} - price is ${((price - e20) / atr).toFixed(1)} ATR above it` : `Buy now / near ${fmt(price)}`;
      if (rsi > 72) { action = `RSI ${fmt(rsi.toFixed(1))} is stretched - wait for a dip to EMA20 ${fmt(e20)}`; entry = e20; }
      sl = calcAtrStopLoss({ side: 'long', price: entry, structuralStop: Math.min(e20, sup.find(v => v < entry) || e20) - 0.5 * atr, atr });
      t1 = res.find(v => v > entry + atr) || entry + 2 * atr; t2 = res.find(v => v > t1 + 0.5 * atr) || t1 + atr * 1.5;
      why = `Uptrend: price above EMA50 ${fmt(e50)} and EMA20 above EMA50.`;
    } else if (down && buyOnly && !goldSellOk) {
      side = 'AVOID';
      action = `No new buys. If you hold a long, exit it - or at the latest on a daily close below your stop`;
      why = isGold
        ? `Downtrend: price below EMA50 ${fmt(e50)} and EMA20 below EMA50. Gold is buy-only (selling it: 44% wins, profit in 5 of 8 years in the backtest), so stay out until price is back above EMA50 with EMA20 above it.`
        : `Downtrend: price below EMA50 ${fmt(e50)} and EMA20 below EMA50. This is buy-only: selling it lost money in the 10-year backtest (43-44% wins), so stay out until price is back above EMA50 with EMA20 above it.`;
    } else if (down) {
      side = 'SELL';
      const extended = e20 - price > 1.5 * atr;
      entry = extended ? e20 : price;
      action = extended ? `Wait for a rise to EMA20 ${fmt(e20)} - price is ${((e20 - price) / atr).toFixed(1)} ATR below it` : `Sell now / near ${fmt(price)}`;
      if (rsi < 28) { action = `RSI ${fmt(rsi.toFixed(1))} is oversold - wait for a rise to EMA20 ${fmt(e20)}`; entry = e20; }
      sl = calcAtrStopLoss({ side: 'short', price: entry, structuralStop: Math.max(e20, res.find(v => v > entry) || e20) + 0.5 * atr, atr });
      t1 = sup.find(v => v < entry - atr) || entry - 2 * atr; t2 = sup.find(v => v < t1 - 0.5 * atr) || t1 - atr * 1.5;
      why = `Downtrend: price below EMA50 ${fmt(e50)} and EMA20 below EMA50.`;
      if (buyOnly) { smallSize = true; why += ` All 3 drivers point down (dollar index, US 10-year yield, rupee) - the only case gold is sold here. Backtest: 12 sells in 10 years, 58% wins, about break-even (+0.04R a trade): small size only.`; }
    } else {
      why = `No trend: price ${price > e50 ? 'above' : 'below'} EMA50 ${fmt(e50)} but EMA20 ${e20 > e50 ? 'above' : 'below'} it. ${buyOnly ? 'Wait for the uptrend (price and EMA20 above EMA50) before buying.' : 'Trade only from the range edges - see the buy / sell zones below.'}`;
    }
    let risk = entry != null ? Math.abs(entry - sl) : null, rr = risk ? Math.abs(t1 - entry) / risk : null;
    /* Below 1.25 R:R the trade waits for a better price: entry where R:R = 1.25 is (T1 + 1.25 x SL) / 2.25. */
    if (rr != null && rr < minRR) {
      const better = (t1 + minRR * sl) / (1 + minRR);
      if (side === 'BUY' ? better < entry && better > sl : better > entry && better < sl) {
        action = `R:R ${rr.toFixed(2)} at ${fmt(entry)} is below ${minRR} - wait to ${side === 'BUY' ? 'buy nearer' : 'sell nearer'} ${fmt(better)}`;
        entry = better; risk = Math.abs(entry - sl); rr = Math.abs(t1 - entry) / risk;
      } else action = `R:R ${rr.toFixed(2)} is below ${minRR} - no trade at these levels`;
    }
    /* Gold buys also need 2 of the 3 drivers (dollar index, US 10-year yield, rupee) - the tested filter. */
    let driverBlock = false;
    /* 20 Nov 2026: the drivers are shown as information only - the buy without them passed the user's bar (8 of 10 years). */
    /* The tested exit: the target the whole position is sold at, and the time stop. Gold buys: 3R / 20 days; the gold
       small-size sell and other commodities: T1 / 10 days. */
    const ex = MCX_EXIT[sym] || { r: null, days: 10 };
    let exitTarget = t1 != null ? R2(t1) : null, exitDays = 10, exitRule = 'Sell all at T1, or at the close of day 10';
    if (side === 'BUY' && ex.r && risk > 0) { exitTarget = R2(entry + ex.r * risk); exitDays = ex.days; exitRule = `Sell all at ${ex.r}R, or at the close of day ${ex.days}`; }
    else if (side === 'BUY' || side === 'SELL') { exitDays = side === 'SELL' ? 10 : ex.days; exitRule = `${side === 'SELL' ? 'Buy back' : 'Sell'} all at T1, or at the close of day ${exitDays}`; }   /* the gold sell was tested with T1 / 10 days */
    if (side !== 'BUY' && side !== 'SELL') { exitTarget = null; exitDays = null; exitRule = null; }
    return { sym, price, e20, e50, rsi, atr, side, entry, sl, t1, t2, risk, rr, action, why, buyOnly, isGold, driverBlock, smallSize, exitTarget, exitDays, exitRule };
  }
  /* Gold drivers as tested: dollar index below its 50-day EMA, US 10-year yield below its 50-day EMA, USD/INR
     above its 50-day EMA - each supports a rise in INR gold. count = how many of the 3 agree. */
  function goldDriverRule({ dxy, tnx, inr }) {
    const one = (C, wantAbove, name) => { const c = (C || []).map(Number).filter(v => v > 0); if (c.length < 55) return { name, known: false }; const e = emaLast(c, 50), last = c[c.length - 1]; return { name, known: true, ok: wantAbove ? last > e : last < e, last, ema50: e }; };
    const items = [one(dxy, false, 'dollar index'), one(tnx, false, 'US 10-year yield'), one(inr, true, 'USD/INR')];
    const known = items.filter(x => x.known).length, count = items.filter(x => x.known && x.ok).length;
    const text = items.map(x => !x.known ? `${x.name} n/a` : `${x.name} ${x.ok ? '✓' : '✗'}`).join(', ');
    return { items, known, count, text };
  }
  /* Gold Petal contract expiry: the last calendar day of the month, moved back to the previous working day when
     that is a weekend or holiday (MCX contract rule). isHoliday(key) is optional. */
  function goldPetalExpiry(todayKey, isHoliday) {
    const hol = k => typeof isHoliday === 'function' && isHoliday(k);
    const work = d => { const w = d.getUTCDay(); return w !== 0 && w !== 6 && !hol(d.toISOString().slice(0, 10)); };
    const expOf = (y, m) => { const d = new Date(Date.UTC(y, m + 1, 0)); while (!work(d)) d.setUTCDate(d.getUTCDate() - 1); return d; };
    const t = new Date(todayKey + 'T00:00:00Z');
    let e = expOf(t.getUTCFullYear(), t.getUTCMonth());
    if (e.toISOString().slice(0, 10) < todayKey) e = expOf(t.getUTCFullYear(), t.getUTCMonth() + 1);
    let left = 0; for (const d = new Date(t); d < e; ) { d.setUTCDate(d.getUTCDate() + 1); if (work(d)) left++; }
    return { date: e.toISOString().slice(0, 10), tradingDaysLeft: left };
  }

  /* Which Gold Petal contract to buy (23 Nov 2026): the current month while 15+ trading days are left (the trade
     lasts up to 10 trading days, plus ~5 days' buffer before the delivery period), otherwise next month. Next month
     usually trades a little above the current one: shift the plan's entry / stop / target by that gap. */
  const GOLD_CONTRACT_MIN_DAYS = 15;
  function goldPetalContract(todayKey, isHoliday) {
    const cur = goldPetalExpiry(todayKey, isHoliday);
    const after = new Date(cur.date + 'T00:00:00Z'); after.setUTCDate(after.getUTCDate() + 1);
    const nxt = goldPetalExpiry(after.toISOString().slice(0, 10), isHoliday);
    const useNext = cur.tradingDaysLeft < GOLD_CONTRACT_MIN_DAYS, pick = useNext ? nxt : cur;
    const mon = k => new Date(k + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase();
    return { useNext, month: mon(pick.date), expiry: pick.date, current: cur, next: nxt, minDays: GOLD_CONTRACT_MIN_DAYS,
      text: useNext ? `Buy the ${mon(nxt.date)} contract (expires ${nxt.date}): the current ${mon(cur.date)} contract has only ${cur.tradingDaysLeft} trading days left (under ${GOLD_CONTRACT_MIN_DAYS}). Next month trades slightly higher - add the gap to the entry, stop and target.`
        : `Buy the ${mon(cur.date)} contract (expires ${cur.date}, ${cur.tradingDaysLeft} trading days left).` };
  }

  /* ── The user's credit-spread rule on the live NSE option chain (Option builder card AND the 09:30 alert) ──
     Sell strike: at least 2% from spot and |delta| < 0.20; buy the strike `wing` points further. Bull put only in a
     Nifty uptrend, bear call only in a downtrend (real-data backtest 2019-2026: puts in an uptrend were the only
     profitable version; iron condors and bear calls lost). Credit at least 6 points weekly / 20 monthly, else the
     charges eat it. "Highest OI in front of the strike" is shown but not required: it made results worse. */
  const ncdf = x => { const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911, s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + p * z); return 0.5 * (1 + s * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-z * z))); };
  const bsD1 = (S, K, T, s, r) => (Math.log(S / K) + (r + s * s / 2) * T) / (s * Math.sqrt(T));
  const bsPx = (S, K, T, s, ty, r) => { const a = bsD1(S, K, T, s, r), b = a - s * Math.sqrt(T); return ty === 'C' ? S * ncdf(a) - K * Math.exp(-r * T) * ncdf(b) : K * Math.exp(-r * T) * ncdf(-b) - S * ncdf(-a); };
  function optionDelta(S, K, T, px, ty, ivPct) {
    const r = 0.065;
    let s = ivPct > 0 ? ivPct / 100 : null;
    if (!s) {   /* implied from the option's own price */
      const intr = Math.max(0, ty === 'C' ? S - K * Math.exp(-r * T) : K * Math.exp(-r * T) - S);
      if (!(px > intr + 0.01)) return ty === 'C' ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
      let lo = 0.01, hi = 3; for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; bsPx(S, K, T, m, ty, r) > px ? hi = m : lo = m; } s = (lo + hi) / 2;
    }
    const d = ncdf(bsD1(S, K, T, s, r)); return ty === 'C' ? d : d - 1;
  }
  /* Weekly Nifty option selling (added 20 Nov 2026). Backtest on NSE closing prices Feb 2019 - Nov 2026, lot 65, 1 point
     cost per leg each way; entry at the close of the FIRST trading day after a weekly expiry, held to the next expiry,
     stops checked on closes:
       1. Trend sell: Nifty close > EMA20 > EMA50 -> sell a put, close < EMA20 < EMA50 -> sell a call (no trend, no
          trade); the first strike 2%+ from spot with delta under 0.20; exit when the option closes at 2x its premium.
          282 trades, 86% wins, profit in 8 of 8 years, about Rs 17,700 a lot a year, worst run -Rs 26,700 a lot.
       2. Short strangle: sell the put 2%+ below and the call 2%+ above (first 50-point strikes), every week; exit when
          the pair closes at 2x the credit. 404 trades, 78% wins, 7 of 8 years, about Rs 40,000 a lot a year, worst run
          -Rs 66,000 a lot.
     Both are NAKED (no bought wing): margin about Rs 1.5 lakh a lot, and the stop is the only protection. */
  function niftyWeeklySells(chain, { spot, trendUp, trendDown, daysToExpiry, step = 50, minAway = 0.02, maxDelta = 0.20 }) {
    const S = +spot || +chain?.spot, T = Math.max(0.5, +daysToExpiry || 1) / 365;
    if (!(S > 0) || !chain?.strikes?.length) return null;
    const px = (k, t) => { const v = ocPremium(chain, k, t); if (v > 0) return v; const row = (chain.strikes || []).find(r => +r.k === +k), o = row ? (t === 'C' ? row.ce : row.pe) : null; return o && o.ltp > 0 ? +o.ltp : null; };
    const ks = (chain.strikes || []).map(r => +r.k).filter(k => k % step === 0);
    const far = ty => ks.filter(k => ty === 'P' ? k <= S * (1 - minAway) : k >= S * (1 + minAway)).sort((a, b) => ty === 'P' ? b - a : a - b);
    let trend;
    if (!trendUp && !trendDown) trend = { ok: false, why: 'No clear Nifty trend (close, EMA20 and EMA50 not in order) - the tested rule sells only with the trend' };
    else {
      const ty = trendUp ? 'P' : 'C'; trend = { ok: false, ty, why: `No ${ty === 'P' ? 'put' : 'call'} 2%+ away with delta under ${maxDelta} and a quoted premium` };
      for (const k of far(ty)) {
        const p = px(k, ty); if (!(p > 0)) continue;
        const row = chain.strikes.find(r => +r.k === k), o = ty === 'P' ? row.pe : row.ce, d = optionDelta(S, k, T, p, ty, o && o.iv);
        if (Math.abs(d) >= maxDelta) continue;
        trend = { ok: true, ty, strike: k, premium: R2(p), delta: R2(d), away: R2(Math.abs(k - S) / S * 100), exitAt: R2(2 * p),
          why: `Nifty ${trendUp ? 'uptrend: sell the put' : 'downtrend: sell the call'} ${k} ${ty === 'P' ? 'PE' : 'CE'} at ${R2(p)}, exit if it closes at ${R2(2 * p)} or more` };
        break;
      }
    }
    const kp = far('P')[0], kc = far('C')[0], pp = kp != null ? px(kp, 'P') : null, pc = kc != null ? px(kc, 'C') : null;
    const credit = pp > 0 && pc > 0 ? R2(pp + pc) : null;
    const strangle = credit ? { ok: true, put: kp, call: kc, putPx: R2(pp), callPx: R2(pc), credit, exitAt: R2(2 * credit),
      why: `Sell ${kp} PE + ${kc} CE for ${credit} points, exit if the two together close at ${R2(2 * credit)} or more` }
      : { ok: false, why: 'No quoted premium for the 2%-away put and call' };
    return { trend, strangle, spot: R2(S) };
  }
  /* Entry day of the weekly sells: the first trading day after the previous weekly expiry (an expiry on a holiday moves
     to the trading day before). nearestExp = the next expiry on or after today; expiries = the exchange's list, whose
     usual weekday is the regular expiry day (an expiry moved by a holiday must not move the previous one). */
  function weeklySellEntry(today, nearestExp, isHoliday, expiries) {
    if (!today || !nearestExp) return null;
    const add = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    const trading = d => { const w = new Date(d + 'T00:00:00Z').getUTCDay(); return w !== 0 && w !== 6 && !(isHoliday && isHoliday(d)); };
    const nextTrading = d => { let x = add(d, 1); for (let g = 0; g < 10 && !trading(x); g++) x = add(x, 1); return x; };
    const dow = d => new Date(d + 'T00:00:00Z').getUTCDay(), cnt = {};
    (Array.isArray(expiries) && expiries.length ? expiries : [nearestExp]).forEach(e => { cnt[dow(e)] = (cnt[dow(e)] || 0) + 1; });
    const W = +Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a])[0];
    let prev = add(nearestExp, -10); while (dow(prev) !== W) prev = add(prev, 1);   /* the regular expiry day 4-10 days before */
    for (let g = 0; g < 10 && !trading(prev); g++) prev = add(prev, -1);
    const thisEntry = nextTrading(prev), nextEntry = nextTrading(nearestExp);
    return { isEntryDay: today === thisEntry, entryDay: today <= thisEntry ? thisEntry : nextEntry, thisEntry, nextEntry, expiry: today <= thisEntry ? nearestExp : null };
  }
  /* Monthly = the last expiry of its calendar month in NSE's own list. */
  function isMonthlyExpiry(exp, list) { return !!exp && Array.isArray(list) && list.length > 1 && !list.some(e => e > exp && String(e).slice(0, 7) === String(exp).slice(0, 7)); }
  function creditSpreadRule(chain, { spot, trendUp, trendDown, daysToExpiry, step = 50, wing = 200, minAway = 0.02, maxDelta = 0.20, monthly: monthlyIn }) {
    const S = +spot || +chain?.spot, T = Math.max(0.5, +daysToExpiry || 1) / 365, monthly = typeof monthlyIn === 'boolean' ? monthlyIn : (+daysToExpiry || 0) > 10;
    /* Minimum credit by the time left, not by the contract's name: the last weekly expiry of a month is "monthly" but
       with 4 days left it is a weekly-length trade (19 Nov 2026: 23 Nov expiry, 7.8 pts asked for 20+). The 20-point
       floor was for month-long trades. */
    const longTrade = (+daysToExpiry || 0) > 10, minCredit = longTrade ? 20 : 6;
    const px = (k, t) => { const v = ocPremium(chain, k, t); if (v > 0) return v; const row = (chain?.strikes || []).find(r => +r.k === +k), o = row ? (t === 'C' ? row.ce : row.pe) : null; return o && o.ltp > 0 ? +o.ltp : null; };
    const side = ty => {
      const rows = (chain?.strikes || []).filter(r => (ty === 'P' ? r.pe : r.ce));
      const otm = rows.filter(r => ty === 'P' ? r.k < S : r.k > S);
      const wallRow = otm.reduce((b, r) => ((ty === 'P' ? r.pe.oi : r.ce.oi) || 0) > ((b && (ty === 'P' ? b.pe.oi : b.ce.oi)) || 0) ? r : b, null);
      const wall = wallRow ? wallRow.k : null;
      const cand = rows.map(r => +r.k).filter(k => k % step === 0 && (ty === 'P' ? k <= S * (1 - minAway) : k >= S * (1 + minAway))).sort((a, b) => ty === 'P' ? b - a : a - b);
      for (const k of cand) {
        const p = px(k, ty); if (!(p > 0)) continue;
        const row = rows.find(r => +r.k === k), o = ty === 'P' ? row.pe : row.ce;
        const delta = optionDelta(S, k, T, p, ty, o && o.iv);
        if (Math.abs(delta) >= maxDelta) continue;
        const w = ty === 'P' ? k - wing : k + wing, pw = px(w, ty);
        if (!(pw >= 0) || pw == null) continue;
        const credit = R2(p - pw), away = Math.abs(k - S) / S * 100;
        const wallOk = wall != null && (ty === 'P' ? wall >= k : wall <= k);
        const trendOk = ty === 'P' ? !!trendUp : !!trendDown;
        const checks = [
          { name: ty === 'P' ? 'Nifty uptrend' : 'Nifty downtrend', pass: trendOk, need: true },
          { name: `Sell strike ${away.toFixed(1)}% from spot (2%+)`, pass: away >= minAway * 100, need: true },
          { name: `Delta ${Math.abs(delta).toFixed(2)} (under ${maxDelta})`, pass: Math.abs(delta) < maxDelta, need: true },
          { name: `Credit ${credit} pts (${minCredit}+ with ${+daysToExpiry || 0} days to expiry)`, pass: credit >= minCredit, need: true },
          { name: `Highest OI ${wall != null ? wall : '--'} ${wallOk ? 'in front of' : 'behind'} the strike`, pass: wallOk, need: false },
        ];
        return { type: ty === 'P' ? 'Bull put spread' : 'Bear call spread', ty, sell: k, buy: w, sellPx: R2(p), buyPx: R2(pw), credit, delta: R2(delta), away: R2(away), wall, wallOk,
          maxLoss: R2(wing - credit), checks, ok: checks.every(c => !c.need || c.pass) };
      }
      return { type: ty === 'P' ? 'Bull put spread' : 'Bear call spread', ty, none: true, checks: [], ok: false };
    };
    const put = side('P'), call = side('C');
    /* Bull puts only (19 Nov 2026 backtest, NSE prices 2019-2026): bull puts in an uptrend 93% wins, +Rs 145 a lot a
       week; bear calls in a downtrend won 87% but lost Rs 345 a lot on average. The call side is shown for
       information only. */
    if (!call.none) { call.checks.unshift({ name: 'Bear calls are not traded (they lost money in the backtest)', pass: false, need: true }); call.ok = false; }
    const pick = trendUp ? put : null;
    const verdict = !pick ? (trendDown ? 'No trade: Nifty is in a downtrend - bear-call spreads lost money in the backtest (87% wins, but -Rs 345 a lot on average), so only bull puts are traded'
      : 'No trade: Nifty has no clear uptrend - iron condors and range trades lost money in the backtest')
      : pick.none ? `No ${pick.type.toLowerCase()} strike meets 2% away and delta under ${maxDelta}`
      : pick.ok ? `${pick.type}: sell ${pick.sell} / buy ${pick.buy} for ${pick.credit} pts`
      : `No trade: ${pick.checks.filter(c => c.need && !c.pass).map(c => c.name).join(', ')}`;
    return { spot: S, daysToExpiry: +daysToExpiry, monthly, longTrade, minCredit, put, call, pick, ok: !!(pick && pick.ok), verdict };
  }

  /* ── Price structure and chart patterns (19 Nov 2026 10-year backtest on the screener's signals) ──
     Swing points: the high / low of the 7 bars centred on a bar, known 3 bars later. */
  function swingPoints(H, L, end) {
    const sh = [], sl = [];
    for (let k = 3; k + 3 <= end; k++) {
      let hi = true, lo = true;
      for (let j = k - 3; j <= k + 3; j++) { if (j === k) continue; if (H[j] >= H[k]) hi = false; if (L[j] <= L[k]) lo = false; }
      if (hi) sh.push(k); if (lo) sl.push(k);
    }
    return { sh, sl };
  }
  /* Tags on a stock's daily bars (last bar = today): higher highs + higher lows intact, distance from the 52-week
     high, and a double bottom (two swing lows 10-60 bars apart within 3%, the second in the last 20 bars) with the
     price above its neckline. Backtest (net R a trade): HH/HL +0.055 vs -0.015 broken; within 5% of the 52-week high
     +0.057; double bottom above neckline +0.099 (7 of 10 years); the app's average +0.011. */
  function stockTags({ H, L, C }) {
    const n = (C || []).length, i = n - 1; if (n < 60) return null;
    const { sh, sl } = swingPoints(H, L, i);
    const lastH = sh.slice(-2), lastL = sl.slice(-2);
    const hhhl = lastH.length === 2 && lastL.length === 2 && H[lastH[1]] > H[lastH[0]] && L[lastL[1]] > L[lastL[0]] && C[i] > L[lastL[1]];
    let hi = 0; for (let j = Math.max(0, i - 251); j <= i; j++) hi = Math.max(hi, +H[j] || 0);
    const off52 = hi > 0 ? (hi - C[i]) / hi * 100 : null;
    let db = null; const lows = sl.slice(-6);
    for (let a = lows.length - 2; a >= 0 && !db; a--) {
      const p = lows[a], q = lows[lows.length - 1];
      if (q - p >= 10 && q - p <= 60 && i - q <= 20 && Math.abs(L[p] - L[q]) / L[p] <= 0.03) {
        let m = 0; for (let j = p; j <= q; j++) m = Math.max(m, H[j]);
        if (m > L[p] * 1.05) db = { neck: R2(m), low: R2(Math.min(L[p], L[q])), above: C[i] > m };
      }
    }
    return { hhhl, off52: off52 == null ? null : R2(off52), near52: off52 != null && off52 <= 5, doubleBottom: db, dbAbove: !!(db && db.above) };
  }
  /* Pattern breakouts for the "Pattern breakouts" list (stock in an uptrend, Nifty in an uptrend - the caller checks):
     - double bottom: today's close crosses above the neckline (yesterday's close was not above it);
     - flat base: the 25 bars before today stayed within 12%, today closes above their high on 1.3x+ average volume.
     Stop under the pattern (minus 0.25 ATR, kept 0.75-3 ATR from the price), target 2R, up to 15 days.
     Backtest: double bottom 2,912 trades +0.065R; flat base 1,670 trades +0.056R (+0.134R with at most 5 open). */
  function patternBreakout({ H, L, C, V, atr, vToday }) {
    const n = (C || []).length, i = n - 1; if (n < 80 || !(atr > 0)) return null;
    const price = C[i];
    const plan = (name, low, note) => {
      let stop = low - 0.25 * atr;
      if (price - stop > 3 * atr) stop = price - 3 * atr;
      if (price - stop < 0.75 * atr) stop = price - 0.75 * atr;
      const risk = price - stop;
      return { name, price: R2(price), stop: R2(stop), target: R2(price + 2 * risk), riskPct: R2(risk / price * 100), note };
    };
    const now = stockTags({ H, L, C }), prev = stockTags({ H: H.slice(0, i), L: L.slice(0, i), C: C.slice(0, i) });
    if (now?.doubleBottom?.above && !(prev?.doubleBottom?.above) && C[i - 1] <= now.doubleBottom.neck) return plan('Double bottom breakout', now.doubleBottom.low, `Close above the neckline ${now.doubleBottom.neck}`);
    if (i >= 26) {
      const bh = Math.max(...H.slice(i - 25, i)), bl = Math.min(...L.slice(i - 25, i));
      let v20 = 0; for (let j = i - 20; j < i; j++) v20 += +V[j] || 0; v20 /= 20;
      const vt = Number.isFinite(+vToday) && +vToday > 0 ? +vToday : (+V[i] || 0);   /* today's volume projected to a full day during market hours */
      if (bh / bl - 1 <= 0.12 && price > bh && C[i - 1] <= bh && v20 > 0 && vt >= 1.3 * v20)
        return plan('Flat base breakout', bl, `25-day base ${R2(bl)}-${R2(bh)} (${((bh / bl - 1) * 100).toFixed(1)}%), volume ${(vt / v20).toFixed(1)}x`);
    }
    return null;
  }

  /* Swing READY gate (from 20 Nov 2026). 10-year backtest of 17 well-known swing entries on 235 large caps, all with
     the same rules: signal on the close, buy the next open, stop under the setup low (minus 0.25 ATR, kept 0.75-3 ATR
     from the entry), sell all at 2R or at the close of day 15, Nifty above its EMA50 with EMA20 above EMA50, at most 5
     open, 0.25% costs. The two that held up in every robustness test (other pick order, 3 / 8 open, 2017-21 vs 2022-26):
       A. EMA20 crosses above EMA50, close above EMA200, stock beats Nifty over 3 months: 54% wins, +0.21R, 9-10 of 10 years (2R / day-15 exit);
       B. gap-up 2%+ on 2x the 20-day volume that closes above its open, close > EMA50 > EMA200, within 10% of the
          52-week high: 48% wins, +0.20R, 8 of 10 years (2R / day-15 exit).
     Together in one 5-slot book with the trailing exit (TRAIL, 4 ATR, from 23 Nov 2026): 45% wins, +0.57R a trade
     (avg win +13%, avg loss -4%), 9 of 10 years, worst fall -10%, about 37 trades a year (A 48% / +0.42R, B 42% / +0.75R).
     With the old 2R / day-15 exit: 49% wins, +0.18R, 8 of 10 years, worst fall -13%. The old READY (EMA pullbacks / breakout with volume): 44%, +0.08R, 6 of 10 years.
     i = signal bar (default the last); entry = the price you buy at (default that bar's close). The caller checks the
     Nifty trend, results and corporate events. Returns { ok, setup, entry, stop, target, ... } or { ok:false, near }. */
  function swingGate({ O, H, L, C, V, i, rs3m, vToday, entry }) {
    const n = (C || []).length; i = Number.isInteger(i) ? i : n - 1;
    if (i < 260 || i >= n || !O || !V) return null;
    const ema = p => { const k = 2 / (p + 1), out = [+C[0]]; for (let j = 1; j <= i; j++) out.push(+C[j] * k + out[j - 1] * (1 - k)); return out; };
    const e20 = ema(20), e50 = ema(50), e200 = ema(200);
    let atr = 0; for (let j = 0; j <= i; j++) { const tr = j ? Math.max(H[j] - L[j], Math.abs(H[j] - C[j - 1]), Math.abs(L[j] - C[j - 1])) : H[j] - L[j]; atr = j < 14 ? (atr * j + tr) / (j + 1) : (atr * 13 + tr) / 14; }
    let v20 = 0; for (let j = i - 20; j < i; j++) v20 += +V[j] || 0; v20 /= 20;
    const vt = Number.isFinite(+vToday) && +vToday > 0 ? +vToday : +V[i] || 0;
    let hi52 = 0; for (let j = Math.max(0, i - 251); j <= i; j++) hi52 = Math.max(hi52, +H[j] || 0);
    const close = +C[i], off52 = hi52 > 0 ? (hi52 - close) / hi52 * 100 : null, gap = +C[i - 1] > 0 ? +O[i] / +C[i - 1] - 1 : 0;
    const rsOk = Number.isFinite(+rs3m) && +rs3m > 0;
    const info = { e20: R2(e20[i]), e50: R2(e50[i]), e200: R2(e200[i]), gapPct: R2(gap * 100), volX: v20 > 0 ? R2(vt / v20) : null, off52: R2(off52), rs3m: Number.isFinite(+rs3m) ? R2(+rs3m) : null, atr: R2(atr) };
    const px = valid(entry) ? +entry : close;
    const plan = (setup, low, why) => {
      let stop = low - 0.25 * atr; if (px - stop > 3 * atr) stop = px - 3 * atr; if (px - stop < 0.75 * atr) stop = px - 0.75 * atr;
      return { ok: true, setup, entry: R2(px), stop: R2(stop), target: R2(px + 2 * (px - stop)), riskPct: R2((px - stop) / px * 100), maxDays: 15, why, info };
    };
    const cross = e20[i] > e50[i] && e20[i - 1] <= e50[i - 1];
    if (cross && close > e200[i] && rsOk)
      return plan('EMA20/50 cross', Math.min(...L.slice(i - 10, i + 1).map(Number)), `EMA20 ${info.e20} crossed above EMA50 ${info.e50}, close above EMA200 ${info.e200}, beating Nifty by ${info.rs3m}% over 3 months`);
    if (close > e50[i] && e50[i] > e200[i] && gap >= 0.02 && v20 > 0 && vt >= 2 * v20 && close > +O[i] && off52 != null && off52 <= 10)
      return plan('Gap-up near 52-week high', +L[i], `Gap-up ${info.gapPct}% on ${info.volX}x volume, closed above its open, ${info.off52}% below the 52-week high`);
    /* Not a signal: what is missing, and whether a cross is close (EMA20 under EMA50 by 1% or less and closing in). */
    let near = null;
    const sp = (e50[i] - e20[i]) / e50[i], sp3 = (e50[i - 3] - e20[i - 3]) / e50[i - 3];
    /* Only stocks that can still become READY: a lagging stock (not beating Nifty) cannot. */
    if (e20[i] <= e50[i] && sp <= 0.01 && sp < sp3 && close > e200[i] && rsOk) near = `EMA20 ${info.e20} is ${(sp * 100).toFixed(2)}% under EMA50 ${info.e50} and closing in - a cross may come in the next few days`;
    else if (gap >= 0.02 && close > +O[i] && !(vt >= 2 * v20)) near = `Gap-up ${info.gapPct}%, but volume ${info.volX}x is under 2x the 20-day average`;
    return { ok: false, near, info };
  }

  /* Fresh entry score and Hold score (0-100) for any stock, from what the Analysis, News and Sector tabs show.
     Checklist scores: each item is a factor from the backtests (marked tested) or a plain check; a missing input
     (news not loaded, sector unknown) is left out and the rest is scaled to 100. The exit stays the plan's own
     (stop, 2R or day 15) - the scores are for confidence, not a new rule.
     ctx: { signal: 'ready'|'pattern'|'quick'|'near'|null, stop, niftyUp, rs3m, tf: {bull, denom} (Analysis trend,
     1 hour -> monthly; daily EMAs when absent), sectorUp, newsSent: 'bull'|'bear'|'neutral'|null, eventsClear,
     holdEventsClear }. i = bar to score (default the last). */
  function stockScores({ H, L, C }, ctx = {}, i) {
    const n = (C || []).length; i = Number.isInteger(i) ? i : n - 1;
    if (i < 210) return null;
    const ema = p => { const k = 2 / (p + 1); let e = +C[0]; for (let j = 1; j <= i; j++) e = +C[j] * k + e * (1 - k); return e; };
    const e20 = ema(20), e50 = ema(50), e200 = ema(200), price = +C[i];
    let atr = 0; for (let j = 0; j <= i; j++) { const tr = j ? Math.max(H[j] - L[j], Math.abs(H[j] - C[j - 1]), Math.abs(L[j] - C[j - 1])) : H[j] - L[j]; atr = j < 14 ? (atr * j + tr) / (j + 1) : (atr * 13 + tr) / 14; }
    let g = 0, l = 0; for (let j = i - 27; j <= i; j++) { const d = C[j] - C[j - 1], up = Math.max(d, 0), dn = Math.max(-d, 0); if (j <= i - 14) { g += up / 14; l += dn / 14; } else { g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14; } }
    const rsi = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    const em = (p, k0) => { const k = 2 / (p + 1); let e = +C[k0]; const out = []; for (let j = k0; j <= i; j++) { e = j === k0 ? +C[j] : +C[j] * k + e * (1 - k); out.push(e); } return out; };
    const k0 = Math.max(0, i - 120), m12 = em(12, k0), m26 = em(26, k0), macd = m12.map((v, j) => v - m26[j]);
    const sg = (() => { const k = 2 / 10; let e = macd[0]; for (let j = 1; j < macd.length; j++) e = macd[j] * k + e * (1 - k); return e; })();
    const macdUp = macd[macd.length - 1] >= sg;
    const tags = stockTags({ H: H.slice(0, i + 1), L: L.slice(0, i + 1), C: C.slice(0, i + 1) }) || {};
    const sr = srLevels({ H, L, C, i: i - 1, price });
    const res = (sr.resistances || []).map(x => +x.v).filter(v => v > price * 1.002).sort((a, b) => a - b)[0] || null;
    const stop = valid(ctx.stop) && ctx.stop < price ? +ctx.stop : price - 1.5 * atr, risk = price - stop;
    const room = res && risk > 0 ? (res - price) / risk : null;
    const tfPct = ctx.tf && ctx.tf.denom > 0 ? ctx.tf.bull / ctx.tf.denom : null;
    const trendPts = tfPct != null ? tfPct : ((price > e20 ? 1 : 0) + (e20 > e50 ? 1 : 0) + (e50 > e200 ? 1 : 0)) / 3;
    const trendTxt = tfPct != null ? `${ctx.tf.bull}/${ctx.tf.denom} timeframes bullish (Analysis → Trend)` : `daily EMAs: price ${price > e20 ? '>' : '<'} EMA20, EMA20 ${e20 > e50 ? '>' : '<'} EMA50, EMA50 ${e50 > e200 ? '>' : '<'} EMA200`;
    const news = ctx.newsSent === 'bull' ? 1 : ctx.newsSent === 'bear' ? 0 : ctx.newsSent === 'neutral' ? 0.6 : null;
    const yes = v => v == null ? null : v ? 1 : 0;
    const sigPts = { ready: 1, pattern: 0.8, breakout: 0.8, quick: 0.6, near: 0.3 }[ctx.signal] ?? 0;
    const sigTxt = { ready: 'READY signal (tested gate)', pattern: 'Pattern breakout (tested)', breakout: '20-day breakout (tested, separate list)', quick: 'Quick bounce (tested, watch-only)', near: 'A READY signal is close' }[ctx.signal] || 'No tested entry signal today';
    /* Weights from the 20 Nov 2026 check on every signal of the tested entries: higher highs & lows helped all of them
       (+0.01R to +0.11R a trade), momentum helped quick bounces (+0.18R vs +0.03R); "room to resistance" did the
       opposite and "near the 52-week high" was mixed, so neither is in the score. */
    const fresh = [
      { k: 'Entry signal', w: 30, f: sigPts, t: sigTxt, tested: true },
      { k: 'Nifty uptrend', w: 15, f: yes(ctx.niftyUp), t: ctx.niftyUp == null ? 'unknown' : ctx.niftyUp ? 'Nifty above EMA50, EMA20 above EMA50' : 'Nifty not in its uptrend', tested: true },
      { k: 'Higher highs & lows', w: 15, f: yes(tags.hhhl), t: tags.hhhl ? 'swing structure intact' : 'structure broken', tested: true },
      { k: 'Beats Nifty (3 months)', w: 10, f: ctx.rs3m == null ? null : ctx.rs3m > 0 ? 1 : 0, t: ctx.rs3m == null ? 'unknown' : `${ctx.rs3m > 0 ? '+' : ''}${R2(ctx.rs3m)}% vs Nifty`, tested: true },
      { k: 'Trend', w: 10, f: trendPts, t: trendTxt },
      { k: 'Momentum', w: 5, f: ((rsi >= 40 && rsi <= 75 ? 1 : 0) + (macdUp ? 1 : 0)) / 2, t: `RSI ${R2(rsi)}, MACD ${macdUp ? 'above' : 'below'} signal`, tested: true },
      { k: 'Sector (1 month)', w: 5, f: yes(ctx.sectorUp), t: ctx.sectorUp == null ? 'not loaded' : ctx.sectorUp ? 'sector up' : 'sector down' },
      { k: 'News', w: 5, f: news, t: ctx.newsSent ? { bull: 'positive', bear: 'negative', neutral: 'neutral' }[ctx.newsSent] : 'not loaded' },
      { k: 'No results / event close', w: 5, f: yes(ctx.eventsClear), t: ctx.eventsClear == null ? 'unknown' : ctx.eventsClear ? 'clear' : 'results or a corporate event within 5 trading days' },
    ];
    let lastSwingLow = null; { const lows = []; for (let k = Math.max(3, i - 60); k <= i - 3; k++) { let lo = true; for (let j = k - 3; j <= k + 3; j++) if (j !== k && L[j] <= L[k]) lo = false; if (lo) lows.push(k); } if (lows.length) lastSwingLow = +L[lows[lows.length - 1]]; }
    const hold = [
      { k: 'Above EMA20', w: 15, f: price > e20 ? 1 : 0, t: `EMA20 ${R2(e20)}` },
      { k: 'Above EMA50', w: 15, f: price > e50 ? 1 : 0, t: `EMA50 ${R2(e50)}` },
      { k: 'Above the last swing low', w: 15, f: lastSwingLow == null ? null : price > lastSwingLow ? 1 : 0, t: lastSwingLow == null ? 'none found' : `swing low ${R2(lastSwingLow)}` },
      { k: 'Trend', w: 10, f: trendPts, t: trendTxt },
      { k: 'Beats Nifty (3 months)', w: 10, f: ctx.rs3m == null ? null : ctx.rs3m > 0 ? 1 : 0, t: ctx.rs3m == null ? 'unknown' : `${ctx.rs3m > 0 ? '+' : ''}${R2(ctx.rs3m)}% vs Nifty`, tested: true },
      { k: 'Nifty uptrend', w: 10, f: yes(ctx.niftyUp), t: ctx.niftyUp == null ? 'unknown' : ctx.niftyUp ? 'yes' : 'no', tested: true },
      { k: 'Momentum', w: 10, f: ((rsi >= 40 && rsi <= 75 ? 1 : 0) + (macdUp ? 1 : 0)) / 2, t: `RSI ${R2(rsi)}${rsi > 75 ? ' (stretched)' : rsi < 40 ? ' (weak)' : ''}, MACD ${macdUp ? 'above' : 'below'} signal` },
      { k: 'Sector (1 month)', w: 5, f: yes(ctx.sectorUp), t: ctx.sectorUp == null ? 'not loaded' : ctx.sectorUp ? 'sector up' : 'sector down' },
      { k: 'News', w: 5, f: news, t: ctx.newsSent ? { bull: 'positive', bear: 'negative', neutral: 'neutral' }[ctx.newsSent] : 'not loaded' },
      { k: 'No results / ex-date in 2 days', w: 5, f: yes(ctx.holdEventsClear ?? ctx.eventsClear), t: (ctx.holdEventsClear ?? ctx.eventsClear) == null ? 'unknown' : (ctx.holdEventsClear ?? ctx.eventsClear) ? 'clear' : 'results / ex-date close - gap risk' },
    ];
    const total = rows => { const kn = rows.filter(r => r.f != null), w = kn.reduce((a, r) => a + r.w, 0); return w ? Math.round(kn.reduce((a, r) => a + r.w * r.f, 0) / w * 100) : null; };
    return { fresh: total(fresh), hold: total(hold), freshRows: fresh, holdRows: hold, rsi: R2(rsi), e20: R2(e20), e50: R2(e50), e200: R2(e200) };
  }

  /* 20-day breakout list (separate from READY, like Pattern breakouts - added 21 Nov 2026). 10-year backtest, same
     rules as READY (buy the next open, stop 0.25 ATR under the 5-day low kept 0.75-3 ATR away, sell all at 2R or the
     close of day 15, Nifty in its uptrend, at most 5 open, 0.25% costs): close above the 20-day high (first close
     above it) on 1.5x the 20-day volume, close > EMA50 > EMA200, higher highs & lows intact, within 10% of the 52-week
     high, beating Nifty over 3 months. 474 trades, 51% wins, +0.12R a trade, profit in 8 of 10 years; less steady than
     READY (5 of 10 years with 3 open), so it is a separate list. The caller checks Nifty, results and events. */
  function breakout20({ H, L, C, V, i, rs3m, vToday, entry }) {
    const n = (C || []).length; i = Number.isInteger(i) ? i : n - 1;
    if (i < 260 || i >= n || !V) return null;
    const ema = p => { const k = 2 / (p + 1); let e = +C[0]; for (let j = 1; j <= i; j++) e = +C[j] * k + e * (1 - k); return e; };
    const e50 = ema(50), e200 = ema(200), close = +C[i];
    let atr = 0; for (let j = 0; j <= i; j++) { const tr = j ? Math.max(H[j] - L[j], Math.abs(H[j] - C[j - 1]), Math.abs(L[j] - C[j - 1])) : H[j] - L[j]; atr = j < 14 ? (atr * j + tr) / (j + 1) : (atr * 13 + tr) / 14; }
    let v20 = 0; for (let j = i - 20; j < i; j++) v20 += +V[j] || 0; v20 /= 20;
    const vt = Number.isFinite(+vToday) && +vToday > 0 ? +vToday : +V[i] || 0;
    const hh = (a, b) => { let m = -Infinity; for (let j = a; j <= b; j++) m = Math.max(m, +H[j]); return m; };
    const hi20 = hh(i - 20, i - 1), hi20prev = hh(i - 21, i - 2), hi52 = hh(Math.max(0, i - 251), i);
    const off52 = hi52 > 0 ? (hi52 - close) / hi52 * 100 : null;
    const tags = stockTags({ H: H.slice(0, i + 1), L: L.slice(0, i + 1), C: C.slice(0, i + 1) }) || {};
    const rsOk = Number.isFinite(+rs3m) && +rs3m > 0;
    const info = { hi20: R2(hi20), volX: v20 > 0 ? R2(vt / v20) : null, off52: R2(off52), rs3m: Number.isFinite(+rs3m) ? R2(+rs3m) : null, e50: R2(e50), e200: R2(e200), atr: R2(atr) };
    const ok = close > e50 && e50 > e200 && close > hi20 && +C[i - 1] <= hi20prev && v20 > 0 && vt >= 1.5 * v20 && !!tags.hhhl && off52 != null && off52 <= 10 && rsOk;
    if (!ok) return { ok: false, info };
    const px = valid(entry) ? +entry : close;
    let stop = Math.min(...L.slice(i - 5, i + 1).map(Number)) - 0.25 * atr;
    if (px - stop > 3 * atr) stop = px - 3 * atr; if (px - stop < 0.75 * atr) stop = px - 0.75 * atr;
    return { ok: true, name: '20-day breakout', entry: R2(px), stop: R2(stop), target: R2(px + 2 * (px - stop)), riskPct: R2((px - stop) / px * 100), maxDays: 15, info,
      why: `Closed above the 20-day high ${info.hi20} on ${info.volX}x volume, higher highs & lows, ${info.off52}% below the 52-week high, beating Nifty by ${info.rs3m}% over 3 months` };
  }

  /* The READY gate's exit from 23 Nov 2026 (10-year backtest of the same entries, 5 open, 4 ATR: +0.57R a trade,
     45% wins, 9 of 10 years; 3 ATR gave +0.53R, 44% - vs +0.18R, ~13.5%, 49% for "all at 2R or day 15"): the stop-loss order, then a stop that
     trails 4 ATR under the highest close since the entry; sell on a daily close below EMA20 after day 5; at most 60
     trading days. b = daily bars {H, L, C}; bars from..to are the completed days after the entry (day 1 = from). */
  const TRAIL = { atr: 4, emaAfter: 5, maxDays: 60 };   /* 4 ATR from 23 Nov 2026 (3 ATR before): 3.75-5 ATR all tested about the same, +0.57R vs +0.53R */
  function trailWalk(b, from, to, entry, stop) {
    const C = b.C.map(Number), H = b.H.map(Number), L = b.L.map(Number), n = C.length;
    const atr = [], e20 = []; let a = 0, e = null;
    for (let i = 0; i < n; i++) {
      const tr = i ? Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])) : H[i] - L[i];
      a = i < 14 ? (a * i + tr) / (i + 1) : (a * 13 + tr) / 14; atr.push(a);
      e = e == null ? C[i] : C[i] * (2 / 21) + e * (19 / 21); e20.push(e);
    }
    let st = +stop, hc = +entry, d = 0;
    for (let i = Math.max(0, from); i <= Math.min(to, n - 1); i++) {
      d++;
      if (L[i] <= st) return { exit: 'stop', idx: i, level: R2(st), trail: R2(st), hc: R2(hc), days: d };
      hc = Math.max(hc, C[i]); st = Math.max(st, hc - TRAIL.atr * atr[i]);
      if (d > TRAIL.emaAfter && C[i] < e20[i]) return { exit: 'ema', idx: i, level: R2(C[i]), trail: R2(st), hc: R2(hc), days: d, e20: R2(e20[i]) };
      if (d >= TRAIL.maxDays) return { exit: 'time', idx: i, level: R2(C[i]), trail: R2(st), hc: R2(hc), days: d };
    }
    return { exit: null, trail: R2(st), hc: R2(hc), days: d, e20: n ? R2(e20[Math.min(to, n - 1)]) : null };
  }

  return { R2, srLevels, atrWilder, TRAIL, trailWalk, calcAtrStopLoss, swingSupport, weeklyTrend, longSetups, planRR, setupRR, limitEntry, isChoppy, ocPremium, quickBounce, pullbackVolume, relStrength, pickLongSetup, setupVolumeOk, setupVolumeReason, WATCH_ONLY,
    commodityPlan, goldDriverRule, goldPetalExpiry, goldPetalContract, creditSpreadRule, isMonthlyExpiry, BUY_ONLY_MCX, GOLD_MCX, MCX_EXIT, stockTags, patternBreakout, optionDelta, swingGate, niftyWeeklySells, weeklySellEntry, stockScores, breakout20 };
});
