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
  const BUY_ONLY_MCX = new Set(['MCX:GOLDPETAL', 'MCX:GOLD']);
  function commodityPlan(sym, { C, H, L, price, sr }, opts = {}) {
    const minRR = opts.minRR || 1.25, fmt = v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
    const e20 = emaLast(C, 20), e50 = emaLast(C, 50), rsi = rsi14(C);
    const atr = atrWilder(C, H, L, price, sr.r1, sr.s1);
    const up = price > e50 && e20 > e50, down = price < e50 && e20 < e50;
    const res = [sr.r1, sr.r2, sr.r3].map(Number).filter(v => v > 0).sort((a, b) => a - b);
    const sup = [sr.s1, sr.s2, sr.s3].map(Number).filter(v => v > 0).sort((a, b) => b - a);
    const buyOnly = BUY_ONLY_MCX.has(sym);
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
    } else if (down && buyOnly) {
      side = 'AVOID';
      action = `No new buys. If you hold a long, exit it - or at the latest on a daily close below your stop`;
      why = `Downtrend: price below EMA50 ${fmt(e50)} and EMA20 below EMA50. Gold is traded buy-only here (the backtest found no edge in selling it), so a downtrend means stay out until price is back above EMA50 with EMA20 above it.`;
    } else if (down) {
      side = 'SELL';
      const extended = e20 - price > 1.5 * atr;
      entry = extended ? e20 : price;
      action = extended ? `Wait for a rise to EMA20 ${fmt(e20)} - price is ${((e20 - price) / atr).toFixed(1)} ATR below it` : `Sell now / near ${fmt(price)}`;
      if (rsi < 28) { action = `RSI ${fmt(rsi.toFixed(1))} is oversold - wait for a rise to EMA20 ${fmt(e20)}`; entry = e20; }
      sl = calcAtrStopLoss({ side: 'short', price: entry, structuralStop: Math.max(e20, res.find(v => v > entry) || e20) + 0.5 * atr, atr });
      t1 = sup.find(v => v < entry - atr) || entry - 2 * atr; t2 = sup.find(v => v < t1 - 0.5 * atr) || t1 - atr * 1.5;
      why = `Downtrend: price below EMA50 ${fmt(e50)} and EMA20 below EMA50.`;
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
    if (side === 'BUY' && buyOnly && opts.drivers && opts.drivers.known >= 2) {
      if (opts.drivers.count < 2) { driverBlock = true; action = `Wait: only ${opts.drivers.count} of 3 drivers support gold (${opts.drivers.text}) - buy when 2 of 3 agree`; }
    }
    return { sym, price, e20, e50, rsi, atr, side, entry, sl, t1, t2, risk, rr, action, why, buyOnly, driverBlock };
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
  /* Monthly = the last expiry of its calendar month in NSE's own list. */
  function isMonthlyExpiry(exp, list) { return !!exp && Array.isArray(list) && list.length > 1 && !list.some(e => e > exp && String(e).slice(0, 7) === String(exp).slice(0, 7)); }
  function creditSpreadRule(chain, { spot, trendUp, trendDown, daysToExpiry, step = 50, wing = 200, minAway = 0.02, maxDelta = 0.20, monthly: monthlyIn }) {
    const S = +spot || +chain?.spot, T = Math.max(0.5, +daysToExpiry || 1) / 365, monthly = typeof monthlyIn === 'boolean' ? monthlyIn : (+daysToExpiry || 0) > 10;
    const minCredit = monthly ? 20 : 6;
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
          { name: `Credit ${credit} pts (${minCredit}+ ${monthly ? 'monthly' : 'weekly'})`, pass: credit >= minCredit, need: true },
          { name: `Highest OI ${wall != null ? wall : '--'} ${wallOk ? 'in front of' : 'behind'} the strike`, pass: wallOk, need: false },
        ];
        return { type: ty === 'P' ? 'Bull put spread' : 'Bear call spread', ty, sell: k, buy: w, sellPx: R2(p), buyPx: R2(pw), credit, delta: R2(delta), away: R2(away), wall, wallOk,
          maxLoss: R2(wing - credit), checks, ok: checks.every(c => !c.need || c.pass) };
      }
      return { type: ty === 'P' ? 'Bull put spread' : 'Bear call spread', ty, none: true, checks: [], ok: false };
    };
    const put = side('P'), call = side('C');
    const pick = trendUp ? put : trendDown ? call : null;
    const verdict = !pick ? 'No trade: Nifty has no clear trend - iron condors and range trades lost money in the backtest'
      : pick.none ? `No ${pick.type.toLowerCase()} strike meets 2% away and delta under ${maxDelta}`
      : pick.ok ? `${pick.type}: sell ${pick.sell} / buy ${pick.buy} for ${pick.credit} pts`
      : `No trade: ${pick.checks.filter(c => c.need && !c.pass).map(c => c.name).join(', ')}`;
    return { spot: S, daysToExpiry: +daysToExpiry, monthly, minCredit, put, call, pick, ok: !!(pick && pick.ok), verdict };
  }

  return { R2, srLevels, atrWilder, calcAtrStopLoss, swingSupport, weeklyTrend, longSetups, planRR, setupRR, limitEntry, isChoppy, ocPremium, quickBounce, pullbackVolume, relStrength, pickLongSetup, setupVolumeOk, setupVolumeReason, WATCH_ONLY,
    commodityPlan, goldDriverRule, goldPetalExpiry, creditSpreadRule, isMonthlyExpiry, BUY_ONLY_MCX };
});
