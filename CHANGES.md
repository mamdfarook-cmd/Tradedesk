# TradeDesk — fixed release (23 Oct 2026)

## Before you run it
- **No default password any more.** Start with `APP_PASSWORD=your-password npm start`
  (PowerShell: `$env:APP_PASSWORD="your-password"; npm start`). On Render set `APP_PASSWORD`.
- Optional env vars: `MCX_DUTY_FACTOR` (default 1.06), `TRUST_PROXY_HOPS` (default 1 on Render, 0 elsewhere).
- Screener results are cached per day in the browser under a new key, so old cached scans are ignored automatically.

## Calculations
- Options: VIX passed as annual IV (premiums were ~3.5x too low); strikes placed from the expected move;
  probability of profit and 1-sigma move shown; strike overrides recompute max profit/loss, breakevens, greeks;
  index put skew; impossible strikes at extreme IV rejected; unknown lot size returns an error instead of 50.
- MCX gold/silver duty factor 1.15 -> 1.06.
- Previous close from Yahoo intraday meta (sector indices showed 0.00%; Brent/USDINR changes were wrong).
- Today's candle detected by date, not price (no duplicated/overwritten candles).
- Partial-day volume projected to a full day (no morning "weak volume" bias).
- 2-year history so EMA200 matches charting platforms.
- Fibonacci retracements measured from the 52-week high.

## Swing decisions
- Screener: Nifty regime filter (READY only while Nifty is above EMA50), no READY with results today or within
  5 trading days (live NSE event calendar), no Rs 1,000 price cap, stops placed below structure with ATR buffer.
- Overview: correct setup selection (EMA20/EMA50 pullbacks no longer overridden by momentum/breakout),
  high-volume down days block fresh longs (same rule as screener), live results warning + Ready Gate block.
- Forward test: correct sign for shorts, every bar after the signal evaluated, plan built from signal-day data.
- Position size: risk-based (Risk %), charges included (STT, stamp, exchange, SEBI, GST, DP).
- News sentiment: crash/sell-off headlines scored bearish; HTML entities decoded.
- Gold Petal: zones anchored on EMA20/EMA50 + ATR; "wait for a base" below value in a downtrend.

## Security and reliability
- Login rate limit uses the real client IP; correct password still works under a guessing flood; constant-time
  compare; POST-only logout; NUL-path crash fixed; oversized bodies handled; XSS escaping throughout.
- Request deadlines, retry backoff (no retry on 4xx/429), shared in-flight fetches (screener, USD/INR, news,
  results calendar), lighter market-breadth fetch, bounded news cache.

## UI
- Sub-tab bars no longer clipped; Markets page styled on desktop; sidebar shows price + coloured change;
  neutral "Wait" values; recently viewed stocks; market/results bar and results chips on screener cards;
  US 10Y in basis points; VIX coloured as risk; one render per Markets click; auto-refresh stays on your page.

## Update: live universe, exit plans (23 Oct 2026, later)
- **Live screener universe.** Once a day the server downloads NSE's official Nifty Total Market list (~750 stocks),
  adds your Excel list, computes live market cap (shares outstanding x live price) and keeps stocks above
  Rs 35,000 Cr. Renamed/demerged stocks (e.g. LTIM -> LTM, Tata Motors -> TMPV/TMCV) and stocks that fall below
  Rs 35,000 Cr are dropped; new ones are added. The screener shows the universe source, update time and the
  added/dropped lists. Saved to `data/universe.json`; if a rebuild fails the last good universe (or the Excel
  list) is used. `GET /api/universe` shows the full list (`?refresh=1` rebuilds it).
- **Exit plan on every strategy card** (and on the Overview when a trade is active): initial SL on a daily close
  beyond it, book 50% at T1 and move SL to entry, trail the rest (T1 -/+ 0.75 ATR or a daily close through EMA20),
  T2 = next level beyond T1, time stop after 10 sessions without T1.
- **Breakout / breakdown targets** use a measured move (7-day range height, minimum 2 ATR) instead of the nearest
  swing level, which was usually right above the breakout (median R:R 0.94 -> 1.55).
- **Momentum Continuation is watch-only** (never READY), like Pre-Breakout Watch. Tradable setups are EMA20
  Pullback, EMA50 Deep Pullback, Support Bounce and Breakout with Volume; the screener, Overview Ready Gate and
  Trade Gate all enforce this.

## Update: protection against being rate-limited / blocked
- **Polite outbound layer.** Every request to Yahoo, NSE, BSE and news sites goes through a per-site queue
  (Yahoo max 4 at a time with 150 ms spacing; NSE/BSE one at a time with 1.5-2 s gaps; news sites 2 at a time).
- **Automatic back-off.** If a site answers 429 (too many requests) or 403/999 (blocked), the app stops calling it
  for 1 min, doubling up to 15 min, and serves the last cached data instead of retrying.
- **Caching.** Price history is reused (daily 10 min, hourly 5 min, weekly 6 h, monthly 12 h, live price 30 s);
  API responses fall back to the last good value (up to 30 min) if a source fails; NSE quotes are cached 5 min
  outside market hours; the browser no longer forces fresh MCX quotes; sidebar prices load only for the list on
  screen, at most every 2 min.
- **Measured** (same session: open app, Gold Petal open ~2 min): start-up burst 232 -> 64 Yahoo calls,
  steady state ~20 -> 4 calls/min. A second screener Refresh within 10 min makes 0 Yahoo calls.
- `GET /api/health` now shows calls per site (last 1 and 5 min), queue and any active pause.

## Update: screener = Overview, RS, breadth regime, sectors, news (27 Oct 2026)
- **One engine for both pages.** `public/swing-plan.js` is used by the server screener and the browser
  Overview: same S&R levels, ATR, setup entry/stop/target, setup choice and R:R. Breakout-type setups
  measure R:R from the trigger price (max of price and trigger), not from today's price.
- **Screener READY is checked by the Overview.** Each READY pick is run through the real Overview decision
  (bias, confidence, Ready Gate). If the Overview does not say READY, the card moves to "Moved to Watchlist by
  the Overview check" with the Overview's reason. Alerts and forward tests use only confirmed picks.
- **Pullback volume rule.** Pullbacks and bounces want a quiet pullback (last 3 days at or below average) and
  volume of at least 1.0x average on the bounce day. Breakouts still need 1.1x. Pullbacks are no longer
  penalised for low volume while they pull back.
- **Relative strength vs Nifty** (3 and 6 months). Longs need positive 3M RS; screener cards show RS and the
  percentile rank; the Overview RS score uses the same 3M number.
- **Market regime with breadth.** Nifty vs EMA50 plus % of the universe above its 50-DMA. Narrow rallies
  (breadth < 40%) block fresh longs; a broad recovery (breadth >= 60%) allows them below EMA50. The regime
  only blocks longs; it never blocks a short.
- **Overview gate and action agree.** Confidence below 70 now turns the gate to CONFIRM with the reason, a
  setup still waiting for its trigger candle cannot pass the gate, and watch-only setups always fail it.
- **Sectors.** Sector comes from NSE's industry list (`/api/sector-map`); the Sector page no longer crashes on
  a missing value and shows the full ranked list with each sector vs Nifty.
- **News scoring.** The headline is scored first (the description used to pair "results" in the title with
  "lower" in the text, so "stock jumps 7% after Q2 results" scored -30). "fine-tune", "strike price" and a
  bare mention of SEBI/court/income tax no longer score as legal or operational risk. Group names (Tata,
  Bajaj, Adani, HDFC...) no longer count as a match for one company, so TCS news stops showing Tata Capital
  stories. Results-day headlines with the verb first ("shares slump after Q2 earnings") are now scored.

## Update: full re-audit fixes (27 Oct 2026, later)
Four independent reviews of the whole code, each finding checked against the code before fixing.
- **Breakouts could never be picked.** The breakout test compared price with the nearest resistance, which is
  above price by definition, so "Breakout with Volume" only fired above the 52-week high and a normal break of
  the 7-day high became watch-only Momentum. Breakout and Pre-Breakout now both use the 7-day high (the
  card's trigger and the gate's level).
- **Pullback / bounce targets** are now chosen above the current price (they were chosen above the EMA or
  support entry and could sit below price, giving R:R 0).
- **Heavy selling into a pullback** (last 3 days > 1.25x average volume) now blocks the pullback setups.
- **Support Bounce** uses the 7/14-day swing lows on all three layers (setup, score, gate).
- **Screener:** READY stocks ranked below the top 10 go to the top of the Watchlist instead of vanishing; a
  missing stop is "unknown", not 999% risk; unknown RS (Nifty data failed) no longer passes the RS rule.
- **Overview:** the Ready Gate checks the rules of the setup actually planned (exact setup kind, new EMA50
  rules); warnings count as adverse by direction (a short at resistance is not a risk); a CONFIRM gate can no
  longer show a WAIT badge; "near resistance" never points at a level below price; zero volume is flagged.
- **Strategy tab** breakout R:R is measured from the trigger (same as Overview/screener); the Sideways
  conditional cards are shown instead of an empty section.
- **Patterns:** hammer / hanging man and inverted hammer / shooting star are decided by the prior trend, not
  the candle colour. **Trend tab:** missing weekly/intraday data is N/A, not a Neutral vote.
- **Forward Test** tracks the screener's own stop/target; day-5/10/20 returns use the close of the Nth trading
  day after the signal.
- **F&O expiries** move to the previous trading day on NSE holidays (fixed-date holidays plus `NSE_HOLIDAYS`,
  default 2026-11-24). A/D ratio near 1.0 shows "Balanced"; "(auto from VIX)" only when VIX was used; crypto
  volume trend ignores today's unfinished bar; sectors with no live data are listed, not dropped.

## Update: UI clean-up (27 Oct 2026, later)
- Top menu (Indices / Stocks / MCX / Crypto / Markets) no longer leaves the previous page on screen: each
  menu shows its loaded instrument or a clear "pick one" panel, and the tab bar is hidden over that panel.
- Overview decision card: the Ready Gate lists what is missing (one reason per line); Final Action shows the
  confidence once instead of repeating the same reasons.
- Trade Plan without an active trade: one panel with the planned setup's entry / SL / T1 / R:R instead of four
  "Wait" cards.
- Strategy tab title names the selected setup; the "options hidden" notice no longer shows on stocks.

## Update: tab reshuffle (27 Oct 2026, later)
- Analysis sub-tabs: Indicators (now starts with the multi-timeframe Trend) · Patterns · S&R + Fib · Strategy ·
  Decision. Validation is merged into Decision: scores first, then the data-confidence and strategy checks,
  without repeating the score rows.
- Stock "Market" tab is now **News & Sector**: that stock's news and its sector ranking (opens on News).
  Indices: News & Sectors. MCX: News.
- Calendar and Alerts are on the top **Markets** page only.
- Forward Test moved into **Screener → Track Record** (next to Screener Match and Watchlist).
- Phone: the screener mode buttons wrap instead of running off screen; the Track Record table scrolls in its box.

## Update: Ready Gate fairness (29 Oct 2026)
- **One rule set for long setups.** When the shared engine picks a long setup, the Overview judges it with the
  engine / screener thresholds. The old classifier was stricter in three places: Breakout READY needed 1.35x
  volume (rule is 1.1x), EMA50 Deep Pullback could never be READY, EMA20 Pullback needed RSI 50 (rule is 45).
  So a stock the screener called READY could never pass on the Overview.
- **Confidence no longer blocks READY.** It re-weighed score, R:R and warnings the gate already checks, and the
  screener never used it. It is still shown, marked "information only".
- **Each reason once.** Removed repeats ("RR below 1.25" + "Breakout RR below 1.25", watch-only +
  "needs confirmation", bounce volume + "bounce not confirmed", weak R:R + "no active trigger").
  Support bounce uses the swing lows and RSI 40-60, as on the screener.
- **Decision card: 3 boxes.** Bias · Selected Setup · Decision. Final Action and Ready Gate were the same
  verdict in two boxes; the Decision box shows the action, the gate result and every missing item. When the
  market filter is the only blocker it says so.

## Update: screener fairness (29 Oct 2026)
- Checked against live data: 70 uptrend stocks, Overview vs screener with the market filter neutralised on both
  - zero disagreements. No stock is blocked by a single strict rule (apart from watch-only setups).
- **Watchlist cards say why the stock is there:** "Stock ready - waiting for market", "Stock ready - results
  soon", "READY - ranked below top 10", "Alert only" (watch-only setups, gate pill "ALERT ONLY"), or
  "Needs confirmation". Before, every card read "Need Confirmation", even stocks that pass every check.
- **Overview uses the screener's long-term trend rule** (longs need price and EMA50 above EMA200; shorts the
  mirror), so it cannot call a stock READY that the screener excludes by structure.
- **READY shorts** say on the Overview that the screener lists longs only.
- **BSE-listed trusts** (ALTIUSINVIT, KRT, MINDSPACE, NHIT) got a broken "ALTIUSINVIT.BO" symbol in the
  screener; they now open correctly.
- `GET /api/screener-diag` lists every stock of the last scan with its screener verdict and reasons.

## Update: entry / exit rules (29 Oct 2026, later)
- **Exit plan uses the price you pay.** Pullback / bounce / rejection / momentum setups are bought (sold) now, so
  "move SL to entry" after T1 is the current price, not the EMA20/support level (that was still a loss), and the
  T1/T2 R multiples match the Overview R:R. Breakouts fill at max(price, trigger).
- **Stop-loss order, not a closing stop.** The SL is hit when price trades through it, so a loss stays at 1R, which
  is what the position size is built on. (The text used to say "on a daily close", which can lose more.)
- **Track Record follows the exit plan:** half booked at T1 and the rest at T2 / trail stop / a daily close
  through EMA20; time stop after 10 sessions without T1 (exit at that close). Result = half T1 + half the rest.
  Before, it booked 100% at T2 and had no time stop or EMA20 exit, which overstated results.

## Update: weekly trend, sector strength, trigger line (29 Oct 2026, later)
- **Real weekly trend.** Weekly candles built from the daily bars (shared engine `weeklyTrend`): a long needs the
  weekly close above the 20-week EMA and the 10-week EMA at or above the 20-week. Same rule on the screener and
  the Overview (before, the screener's "weekly" signal was a copy of the daily one).
- **Sector strength in the ranking.** Average 1-month return of the universe stocks in each sector; top-3 sectors
  +6 rank points, top-5 +4, bottom-3 -4. Ranking only, never a block. Cards show e.g. "Banking #3/16 · 1M +1.0%".
- **Trigger line on every card**: what exactly must happen and at what price (e.g. "Needs a green close above
  EMA50 ₹1,375 on 1.0x+ volume (now 0.89x)", "buy nearer ₹1,801 (R:R 1.25 there)").

## Update: trade ideas, index day-change fix, faster sectors (30 Oct 2026)
- **Today's options idea** (Nifty / Bank Nifty / FinNifty: Market Pulse and Strategy). One plain comment, e.g.
  "Nifty 22,937 · VIX 15.1 (IV percentile 70%) · A/D 3.9:1 → Range-bound, options rich → Iron Condor: sell
  23350 CE / buy 23550 CE / sell 22350 PE / buy 22150 PE", with premiums, credit/debit per lot, max profit/loss,
  breakevens, model chance of profit, expiry, exit rules and "Open in Options Builder" (strikes filled in).
  Direction = trend vs EMA20/EMA50 + A/D breadth; volatility = IV percentile (cheap < 30 < fair < 60 < rich).
  Bull/Bear call/put spreads, iron condor and call calendar. Black-Scholes from India VIX - no option chain.
  It replaces the old bias and suitability panels, which picked strategies with their own (conflicting) rules.
- **Today's futures idea** (Crude Oil Mini, Gold Petal): trend-side BUY / SELL / WAIT with entry, stop-loss
  order, T1/T2 and ₹ per lot; waits for a better price when R:R < 1.25. Crude adds an option hedge at the stop
  (put for a long, call for a short) priced from recent volatility, with the capped worst-case loss.
- **Index day-change was wrong** whenever Yahoo's previousClose lagged a day (NSE indices, 29 Oct night: Nifty
  showed +0.82% instead of +1.05%, Nifty Auto +1.20% instead of -0.24%). NSE/BSE previous close now comes from
  the bars (last session before today's), metadata only as a fallback.
- **Sectors load faster and never drop.** One Yahoo call per sector (was two); the server answers within ~6 s
  and keeps loading slower sectors, which the page fills in automatically; the sector page no longer waits for
  the global-markets / breadth load. Cold start: all 26 sectors in ~7 s (was ~15 s, with sectors sometimes missing).
- Index pages wait for VIX / IV percentile before rendering (the Strategy page showed "IV not loaded" while
  Market Pulse used a rough estimate).

## Update: layout trimmed for stocks + Nifty options + MCX futures (30 Oct 2026, later)
- **MCX Overview** (Gold, Silver, Crude, Natural Gas, Copper): the futures idea card plus a compact market-context
  card (daily / weekly trend, price location, support / pivot / resistance). The stock-swing blocks (Fresh Entry,
  Hold Score, capital-based sizing, volume status) are gone - the volume was US futures volume, not MCX. Gold
  Petal keeps its accumulation dashboard under the idea card. Lot sizes for Gold/Silver/NG/Copper are standard
  MCX contracts - check with your broker.
- **Index Strategy page**: Options Quality Score panel removed (it was always capped by the missing option chain).
- **Crypto** hidden from the top menu and no longer fetched at start-up (fewer outbound calls); remove the
  `display:none` on the Crypto button to bring it back.
- **Indices**: the stock-style Decision sub-tab is removed (Market Pulse + the options idea cover indices).

## Update: MCX where / why / when + live option premiums + lots by risk (30 Oct 2026, evening)
- **Your MCX price (calibration).** Type the live MCX price from your broker on any MCX Overview; every level on
  the MCX cards (entry, stop, targets, zones, support/resistance) shifts by the gap to the proxy. Kept 3 days;
  a price more than 20% away is refused (wrong contract / unit).
- **Buy / sell zones.** Previous-day, 5-day and 20-day highs/lows, swing points, EMA20/50 and round numbers
  within 4 ATR, merged where they overlap ("strong" = two or more levels). Each zone shows its stop
  (0.5 ATR beyond), target (next strong zone) and R:R; zones against the trend are marked "book profit, not
  enter"; between zones the card says wait.
- **Global drivers.** New `/api/mcx-drivers` (Yahoo daily charts, 15 min cache, 3-6 tickers): dollar index,
  US 10-year yield, USD/INR, COMEX gold/silver/copper, WTI/Brent, US natural gas, gold/silver ratio for silver.
  Each votes up / down / neutral; the card says whether the drivers agree with the futures plan.
- **Events & timing.** The calendar now generates the weekly US releases by rule: EIA crude inventories
  (Wednesday), EIA gas storage (Thursday), payrolls (first Friday), in IST with US daylight saving applied.
  MCX cards list the next 7 days for that commodity, warn on anything high-impact today/tomorrow, and give the
  usual expiry pattern and session timing.
- **Commodity news.** Crude, silver, natural gas and copper get their own news queries and relevance words
  (only gold had them). Headlines are tagged by the commodity's own price move and supply/demand words
  ("oil tops $116" bullish, "US crude stocks rise" bearish); the stock-market word count no longer applies.
- **Lots by risk** on the Nifty options idea and every MCX plan: capital and risk % (shared with the position
  calculator) give the number of lots, or say one lot is above the limit. MCX crude uses the hedged loss.
- **Live option premiums.** Enter the broker's premium per leg on the options idea; credit/debit, max
  profit/loss, R:R and breakevens recalculate (chance of profit still uses India VIX).
- **Event check on option ideas.** RBI / Fed / CPI / payrolls / GDP dates before expiry are flagged with
  advice for sold options; an expiry within 2 days gets a gamma warning.

## Fix: India VIX missing on the Market tab / no Nifty options idea (30 Oct 2026, night)
- **Cause.** `/api/global` queued 28 Yahoo requests (4 at a time) with a 6 s limit per ticker that included
  the queue wait (4 s for the VIX history), and fetched breadth only afterwards. On a cold start or while
  another page was loading, India VIX (13th in the list) timed out, and that half-empty result was cached
  for 5 min - so the options idea said "India VIX not loaded" until it expired.
- **Fix.** India VIX and its history are queued first; tickers, VIX history and breadth are fetched together
  with a 20 s limit and one retry. A missed live VIX falls back to the latest daily close; any other miss
  shows its last good value (marked stale). An incomplete result is cached 30 s instead of 5 min, and the
  page re-fetches it after 35 s (up to 3 times) and redraws the Market page / a waiting options idea. The
  options idea also asks `/api/vix` directly if market data has no VIX. Browser wait raised to 40 s.

## Update: strength gate, real confidence, S&R + Patterns, timeframe boxes, MCX gap (2 Nov 2026)
- **Ready Gate: sector or relative strength instead of the Nifty hold (Overview and screener).** A long now
  passes this check when its sector is up over 1 month (average 1-month return of the universe stocks in that
  sector, from the last screener scan) OR the stock beats Nifty over 3 months. Both are kept: either one
  is enough. A weak Nifty no longer holds a stock back; it adds a "use smaller size" note. Held only when
  both are known to be weak. If neither can be measured yet, the Nifty regime still decides. Sector
  strength is saved with the universe, so it survives a restart; until the first scan it says "run a
  screener scan".
- **Confidence was stuck at 69.** It was capped at 69 whenever the Ready Gate did not pass (54 on a hard
  reject), so a 90+ setup held by one check always read 69. It now shows the calculated value. The header
  shows both numbers, e.g. "Score 91/100 · Confidence 72/100". Confidence = 55% score + 25% R:R + 20% trend
  strength - warnings, so it is usually below the score; the tooltip says so.
- **Patterns merged into S&R.** The Analysis bar is Indicators / S&R + Patterns / Strategy / Decision. The
  latest candle and confirmed patterns sit between the S&R levels and the Fibonacci table.
- **Multi-timeframe trend as small boxes.** There are four boxes (1 hour, daily, weekly, monthly), each
  with its signal and buy/sell/neutral counts: 4 across on desktop, 2 x 2 on a phone.
- **MCX factor to match the real contract.** The price is international price × USD/INR × a factor
  (not a fixed rupee amount), so the gap grows and shrinks with the price. The factors were set so that
  on 2 Nov 2026 the proxy matched the user's broker (gold +₹12,000/10g, gold petal +₹1,200/g, silver
  +₹20,000/kg, copper +₹15/kg):

  | Commodity | Old factor | New factor |
  |---|---|---|
  | Gold | 1.06 (import duty only) | 1.159 |
  | Gold petal | 1.06 | 1.159 (same as gold) |
  | Silver | 1.06 | 1.1885 |
  | Copper | none | 1.011 |

  Crude and natural gas are unchanged. Override with `MCX_FACTOR_GOLD`, `MCX_FACTOR_GOLDPETAL`,
  `MCX_FACTOR_SILVER` or `MCX_FACTOR_COPPER` (`MCX_DUTY_FACTOR` is gone). Older "Your MCX price"
  calibrations are ignored (new storage key), because they would adjust twice.

## Full re-check of every tab (2 Nov 2026, night) - fixes
Checked Overview, Analysis (Indicators, S&R + Patterns, Strategy, Decision, Market Pulse), News / Sector,
the Markets page (snapshot, sectors, calendar, news, alerts) and the Screener for a stock, Nifty, and the
MCX pages. Fixes:
- **Results check could silently switch off.** When the NSE event calendar timed out, the results list was
  replaced by the manual list only, so Glenmark (results in 3 days) and Divis (5 days) showed READY on both
  the screener and the Overview. The last good NSE list is now kept (and saved to disk) and used for up to
  3 days if a fetch fails; the label says it is the saved list. The limit was raised from 6 s to 15 s, because
  it includes the wait in the NSE queue.
- **Nifty options idea sold far-out strikes.** The short strike was `min(spot - 0.6 sigma, support)`, so a far
  support put it about 2 sigma out (22,350 PE for Rs 3, R:R 0.01). It now sits at or below support but never
  beyond 1 expected move (1.3 for the iron condor). A "credit too small for the risk" warning shows when R:R
  is below 0.10.
- **Decision page said WATCH while the Overview said WAIT.** Validation read the setup label; it now uses the
  Overview's final decision (after the Ready Gate).
- **Score next to confidence where it is visible.** The header badge is hidden by the layout, so the Decision
  box now reads "Score 91/100 · confidence 69/100".
- **Market Pulse contradiction.** "Bullish Bias" next to "Trend bias: Bear". The trend box said Bear for any
  value below 0, while the verdict needs -0.1. Both now use the same threshold, and the subtitle names only
  the signals that voted (e.g. "Breadth leans bullish").
- **MCX market context showed support above price** (the raw 7-day low after today broke it). It now shows
  the nearest support below and resistance above, with their names.
- **MCX zone targets skipped the zone price was in.** A sell zone aimed past the next zone (R:R 3.64 instead of
  0.53). The target is now the first zone in the way.
- **MCX exit text** said "exit on a close through EMA20" while price was already beyond it; it now uses EMA50
  in that case.
- **Strategy summary target** took the first of R1/R2/R3 above price and skipped nearer levels; it now takes the
  nearest level (bear side: nearest support, not S2 first).
- **Screener banner** said "no fresh longs" in a narrow market, which the strength gate no longer does; it now
  says longs still pass on sector or relative strength.
- **Same news story twice** ("Rs.2 ... - TradingView" and "₹2 ..."): the duplicate check ignores currency words
  and a trailing source. A description that only repeats the headline is hidden.

## Known limits (not code bugs)
- Market data is Yahoo/NSE public data; MCX prices are proxies from US futures x USD/INR (calibrate on the
  MCX Overview with your broker's price).
- MCX expiry days are shown as the usual pattern ("around the 19th-20th"), not exact dates. OPEC+ meeting
  dates and US CPI dates after July 2026 are not in the calendar.
- Manual calendar (RBI/CPI/GDP) needs updating in `ECON_CALENDAR`; F&O expiries and weekly US data
  (EIA, payrolls) are generated by rule (exchange / US holidays not applied). Hard-coded F&O lot sizes should be checked against NSE specs.
- NSE may block its event-calendar API from some cloud hosts; the screener then says "Results check
  unavailable" and does not block on results.

## UI: "Quiet Terminal" theme (2 Nov 2026, late)
- One style layer at the end of `index.html` (`td-v25-quiet-terminal`, 8.5 KB, about 2 KB gzipped). It changes
  colour, borders, corners, shadows and weights only; no layout changes, no web fonts, no images.
- Graphite surfaces (#0b0d10 / #13171c) with hairline borders instead of navy gradients, glows and drop
  shadows. One blue accent (#5b9cff) kept apart from up/down green (#2fbf71) and red (#f0616d); the old teal
  accent looked like "bullish".
- Cards are flat: an outer card has a hairline border; inner items are a slightly lighter tone without their own
  border or shadow, so there are no more "cards inside cards". Score tiles show their state as a thin top edge.
- The instrument list is rows separated by hairlines (active row: blue edge) instead of a box per row.
- Tabs and buttons: outlined, active = soft blue fill; visible focus ring for keyboard use; motion off when the
  system asks for reduced motion.
- Text contrast checked (WCAG AA): body 14.8:1, secondary 8.3:1, muted labels 5.9:1, red 5.7:1, green 7.6:1.
- To undo, delete that one `<style id="td-v25-quiet-terminal">` block.

## Fixes: Overview price tile, calculator before READY, Strategy levels, slow index list (3 Nov 2026)
- **Overview "Current Price" tile removed.** The price and today's % are already in the instrument header.
- **Position calculator works before READY.** While the decision is CONFIRM / WATCH but a setup is planned
  (e.g. held only by results or a trigger), the calculator sizes from the plan's entry, stop and T1 and says
  so ("Sized from the planned Breakout with Volume ... quantity only, enter when it turns READY"). It used to
  sit in Wait mode until READY.
- **Strategy header support / resistance.** It showed EMA50 as support and the target as resistance, which
  matched nothing on the S&R tab. It now shows the nearest swing support below and resistance above price,
  with the level's name (Prev Day Low, Swing R3 - 21D High, ...), the same levels the S&R tab lists.
- **Index list slow / blank on first load.** The rows in the middle of the list (Private Bank, PSU Bank, IT...)
  timed out at 15 s behind the market-data load and stayed "--" until the 2-minute refresh. The list now waits
  up to 40 s, retries failed rows once, and the heavy market context starts only after the list's prices are
  in (or after 12 s). Cold start measured with an 8 s cap: Private Bank / PSU Bank / IT in by 7 s, all but the last 5 rows by 11 s, all by 32 s (was: 22 rows blank until ~30 s).
- Server: 5xx replies are logged with the request path (a quote 500 seen right after a page load could not be
  traced).

## UI: "Market Gradient" theme (3 Nov 2026)
- New last style layer `td-v26-market-gradient` (7.6 KB, CSS only) on top of the grey v25 theme, which felt dull.
- Deep-navy gradient background with a faint green glow (top left) and red glow (bottom right); cards use a
  navy gradient with a soft shadow.
- Colour follows the signal, from the classes the app already sets:
  - bullish (decision READY, Trade Plan bullish, BUY idea, buy zones, up-day tiles): green gradient tint + green edge;
  - bearish (rejected decision, bearish plan, SELL idea, sell zones, down-day tiles): red tint + red edge;
  - wait / CONFIRM: amber tint.
  Index list rows and the instrument header are tinted by today's move; market snapshot tiles too.
- Active tabs/buttons: green-to-teal gradient with dark text (contrast 7.6-8.4:1). Muted labels stay >= 5:1 even on
  the greenest part of a card.
- To return to the grey theme, delete the `td-v26-market-gradient` block.
- Fixed a stale label: the MCX header said "× 1.06 duty" (and the Gold Petal note "1.06 duty factor"); it now says
  "× MCX factor" / 1.159, matching the price formula.

## Screener: Pick List tab (3 Nov 2026)
- New tab next to Screener Match: the same scan (READY + Watchlist, no extra server call) sorted into three
  groups, in this order:
  1. Breakout watch - Breakout with Volume, Pre-Breakout Watch, Momentum Continuation;
  2. Pullback to EMA20 / EMA50 - EMA20 Pullback, EMA50 Deep Pullback, Support Bounce;
  3. Near resistance / low R:R - R:R below 1.25 or less than 3% room to resistance, whatever the setup.
- Inside a group: READY first (green edge), then the scan's rank. Each row: status, results date, setup, price,
  week change, sector, the reason / trigger, and Entry / SL / T1 / R:R / room to resistance. Tap a row to open
  the stock. Refresh in this tab forces a new scan.

## Clean-up, full code review, independent screener universe (3 Nov 2026, night)
**Removed (unused):** crypto (sidebar list, two hidden tabs, loaders, /api/crypto and /api/cryptopulse); the hidden
"Forward Test" tab entry (Track Record itself stays); the Gift Nifty fetch (it called nseix.com on every market-data
load) and its unused fields; the old "Qualified Screener" (server + page, no longer called); past manual calendar
entries (RBI / FOMC / CPI / GDP / NFP / expiries up to Oct 2026 - only RBI 4 Dec and FOMC 9 Dec remain, the rest is
generated by rule); the May 2026 manual results list (results come from the NSE feed). About 730 lines removed.
The calendar now always says CPI, GDP and OPEC+ dates are not covered.

**Screener universe - independent of Excel, rebuilt weekly:** NSE Nifty Total Market + every NSE EQ stock listed in
the last 2 years (EQUITY_L.csv, so large new IPOs are scanned), live market cap = shares x live price. Stored with a
Rs 30,000 Cr buffer; the scan applies the live > Rs 35,000 Cr rule. No "added/dropped vs Excel" list any more; the
screener shows count, source, build date and next rebuild. Excel list kept only as a first-start fallback.
First build: 246 stocks > Rs 35,000 Cr (747 index + 475 recent listings checked, 4.5 min), including Groww,
Lenskart, Meesho, Tata Capital, LG Electronics India, HDB Financial; no REIT/InvIT tickers.

**Server fixes (from an independent review, each verified in the code):**
- Rate-limit pause now also stops queued requests, and in-flight replies no longer add strikes (one burst of 429s
  used to jump to a 15-minute lockout).
- One queue per provider (query1/query2 Yahoo, www/nsearchives NSE shared a limit only per sub-domain).
- A failed / partial screener scan is cached 1 minute, not 30.
- The screener's appended live candle no longer borrows yesterday's open/high/low/volume (it could fake a support test).
- Requests waiting on the same failed fetch get the last good value, like the first caller.
- Overview RS vs Nifty uses the same live-adjusted series as the screener.
- MCX is never priced at the built-in USD/INR 84.5 (about 11% low); without a live rate the quote errors / serves its
  last good value. The start-up rate call can no longer crash the server.
- The NSE cookie request has a hard deadline (it could hold NSE's single queue slot).

**Page fixes (from an independent review, each verified):**
- Planned position size uses the real buy price (current price; breakout: trigger if above), not the EMA/support zone -
  it understated risk. The planned line shows "buy X (zone Y)".
- Validation "Active Strategy RR" uses the same price, so it equals the Overview R:R.
- Support Bounce card entry = the swing support the engine / screener / gate use (7D/14D low).
- Market Pulse: an older render can no longer replace a newer page with a stuck spinner.
- MCX "confirmed" candle: MCX trades to 23:55 IST, so its evening bar is treated as still forming.
- Gold Petal dashboard and level check use the calibrated price like the cards above them.
- Screener Overview-check loop stops when you leave the screener (it kept probing and could run twice).
- Weekly-trend messages name the failing half of the rule ("10-week EMA still below the 20-week EMA" vs "close below").

**Verified in the browser:** PETRONET (READY) and ABCAPITAL (CONFIRM) - same price, score, RSI, entry/SL/T1 and R:R on
Overview, Strategy, Decision/Validation, calculator and screener; position size checked by hand. Nifty, MCX Crude,
Gold Petal, Markets (snapshot, sectors, calendar, news, alerts) and all four screener tabs: no errors, no NaN/undefined.

## Index / MCX / screener / alerts clean-up (4 Nov 2026)

- **Indices:** the Strategy page is now **Option Builder** (only the builder, no trade setup / 3-entry plan / options idea card) and appears only for Nifty, Bank Nifty and FinNifty. Market Pulse on every index other than Nifty 50 shows that index's own bias (its trend, EMA20/EMA50, 1-month and today vs Nifty, VIX for F&O indices; two signals needed for a bias) instead of voting with Nifty 50 breadth. The Bank Nifty / FinNifty options idea no longer uses Nifty 50 breadth.
- **MCX:** Strategy and Decision pages removed from Analysis (Indicators, S&R + Patterns).
- **Screener:** one list instead of Screener Match / Pick List / Watchlist tabs: Ready to trade → Watchlist (score ≥ 70, waiting for breakout or pullback, best first) → Low score / low R:R. Track Record is a small button. Strategy score columns removed. The Screener tab is gone from the stock page tab bar (sidebar "Open Screener" opens it).
- **Setup picker (shared engine, screener + Overview):** when several setups qualify it prefers one whose own R:R is ≥ 1.25, and a confirmed EMA50 bounce 3–5% above EMA50 now counts (the gate already accepted 0–5%). Before, the nearest-level rule handed ANTHEM to a breakout with R:R 0.54 although its EMA50 bounce passed with 1.35. Scan of 4 Nov: READY 2 → 5 (NAVINFLUOR, FLUOROCHEM, RADICO, BHEL breakouts; ANTHEM EMA50 pullback), all confirmed by the Overview.
- **Position calculator:** shows the capital in rupees (₹1,00,000), what the quantity buys, and the loss limit ("Max loss allowed ₹1,000 (1% of ₹1,00,000)"). The math was unchanged: 1% risk on 1 lakh = ₹1,000 maximum loss.
- **Markets page:** the Sectors / Calendar / News / Alerts buttons are removed; the page is the snapshot. Alerts moved to a 🔔 button next to the WhatsApp share button on the trade plan: set above/below/% alerts for that instrument, quick picks for entry / SL / T1 (levels already crossed are hidden), manage all alerts.

## Ready on limit for pullbacks (4 Nov 2026, evening)

- **Shared engine `limitEntry`:** for an EMA20 / EMA50 pullback or support bounce whose R:R from the current price is below 1.25, the highest buy price where R:R (same SL and T1) reaches 1.25, rounded down to 0.05. It must stay no lower than 0.5% under the EMA / support level and above the SL; otherwise there is no limit.
- **Screener:** a stock becomes **Ready on limit** when its only failing checks are about price (R:R below 1.25, late from EMA20) and its score at the limit's R:R is 70+. Everything else must pass as for READY: trend, bounce candle, volume, weekly trend, no results within 5 trading days, sector / relative-strength gate. New group between Ready and Watchlist, with the limit price, SL, T1, R:R at the limit, an Overview check that it shows the same limit, and a 🔔 "Alert at ₹limit" button.
- **Overview:** the same rule (Fresh Entry Score re-scored at the limit's R:R). A "READY ON LIMIT · Buy limit ₹X" card above the decision, the calculator sized at the limit, and "At buy limit" in the alert box. The exit plan already books 50% at T1 and trails the rest to T2.
- Scan of 4 Nov: 6 pullbacks got a limit price, none Ready on limit. Each also failed a non-price check: bounce-day volume, weekly trend, weak ADX, RSI, or results tomorrow. Screen and Overview were checked with a simulated MEDANTA row: same limit ₹1,379.50 on both.
- `/api/screener-diag` rows now carry the real gate reasons (they were always empty) plus the limit and the score at the limit.

## Screener ↔ Overview consistency check (4 Nov 2026, night)

- **Full comparison:** every stock in the scan (25) probed through its Overview and compared on bias, setup, R:R and action. Before: 3 stocks disagreed on bias. After: all 25 match.
- **Choppy-market rule, now one shared function `SwingPlan.isChoppy`:** inside the 7-day range, RSI 42–58 and ADX under 16.
  - The Overview also used to count "EMA20 within 1% of EMA50" as chop. Every pullback in an uptrend looks like that, so LGEINDIA (ADX 19.5) and MOTILALOFS (ADX 17.6) showed "Sideways" on the Overview while the screener had them as bullish setups. LGEINDIA would have shown READY on the screener and WAIT on the Overview once its results passed.
  - The screener now applies the same rule, so IPCALAB (ADX 13.7) is Sideways on both and no longer listed.
  - Four copies of the old rule were replaced, and the now-unused variables removed.
- **Screener Overview check:** retries once after a failed fetch. AUROPHARMA and RADICO had shown "check unavailable" on the first try; both match on the retry.

## Free upgrade: data, sync, background alerts, backtest, faster page (6 Nov 2026)

No paid service, API key, database or new hosting. Nothing new to configure: everything runs on APP_PASSWORD.

1. **Data**
   - **NSE option chain** (free, no key) for Nifty, Bank Nifty and FinNifty: `/api/option-chain`.
     - Live premiums in the Option Builder and the options idea card, labelled NSE or est.
     - PCR, max pain, and the biggest call / put open interest.
   - **Pricing rule** (`SwingPlan.ocPremium`): the bid/ask middle when the spread is tight; otherwise today's last trade only if it is inside the bid/ask; otherwise the estimate. A stale last price had priced the Nifty 23650 PE above the 24050 PE.
   - **Index prices:** NSE's own values are the backup for all 26 indices when Yahoo fails, and the main source for Fin Services Ex-Bank.
     - Yahoo has only an ETF for that index, so the app had shown ~31 instead of ~31,550.
     - Its history is the ETF's, scaled to the index level.
   - **Checked:** all 26 indices match NSE exactly.
   - **Not possible free:** real MCX quotes (mcxindia.com blocks automated requests). MCX stays the calibrated proxy.
2. **Storage**
   - **Sync:** alerts, Track Record, calculator, recent stocks and MCX calibrations sync through the server (`/api/store`, `data/user-store.json`).
     - The server stamps every change with its own clock, and each device sends only what it changed, so device clock drift cannot drop edits.
     - If the server's disk resets (Render free), the next browser visit uploads its copy again.
   - **Backup:** Export / Import a backup file from the Markets page.
   - **Logins** use signed tokens, so a server restart no longer logs you out. Changing APP_PASSWORD logs every device out.
3. **Alerts + hosting**
   - **Background alerts:** Web Push (VAPID, RFC 8291) is built on Node's crypto. The key is derived from APP_PASSWORD, so it stays the same across restarts.
   - **Server alert engine:** checks every minute in market hours (NSE 09:15–15:30, MCX 09:00–23:55) and pushes to every device where background alerts are on, even with TradeDesk closed.
   - **Scheduled scans:** a screener scan at 09:25 and 15:15 IST on trading days, pushing READY and Ready-on-limit stocks.
   - **Keep-awake:** on Render, a self-ping every 10 minutes on weekdays 08:30–24:00 IST, about 340 of the 750 free hours.
   - **iPhone:** needs Add to Home Screen first (manifest added).
   - **Tested end to end** against a local push service: valid signature and correct decryption, a key that survives restart, an MCX alert fired by the server engine and saved as triggered.
4. **Rules**
   - **Shared checks:** `readyChecksS` holds the READY / Ready-on-limit stock checks, used by the live scan and the backtest. The scan was regression-checked against the previous version: identical output.
   - **Backtest** (`/api/backtest`, screener → Backtest): the rules replayed day by day over ~15 months. Trades were checked by hand against the candles.
     - Result on 6 Nov: 289 trades, 40% win, −0.09R average.
     - By setup: Breakout −0.18R, EMA50 pullback −0.33R, EMA20 pullback +0.04R, Support bounce +0.76R (10 trades), Ready on limit +0.01R.
   - **Check all vs Overview** (screener): compares every listed stock's bias, setup, R:R and action with its Overview. 20 of 20 match.
5. **Front end**
   - **Split:** `index.html` went from 880 KB to 21 KB. Its 14 style blocks and 4 scripts moved to `public/css/` and `public/js/`, each at its original position.
   - **No visual change:** confirmed by computed-style fingerprints on four screens.
   - **Caching:** files are gzipped once, with ETags and revalidation. A repeat visit transfers about 6 KB instead of the whole page.
   - **Smaller:** the base64 icons were replaced by `icon-192.png`, the unused Yahoo / Marketaux preconnects removed, and 4 dead crypto / forward-test selectors removed.
   - **Not done:** the stacked `!important` style layers were moved, not rewritten. Merging them would risk visual changes for no functional gain.

## Strategy upgrade + full review (7 Nov 2026)

**Strategy** (all three tested on one year of data before adding)
1. **Breakout with Volume is watch-only.** It had 33% wins and −0.21R over 108 trades. A pullback that qualifies now wins over a watch-only breakout in the setup picker.
2. **Nifty trend gate:** READY and Ready-on-limit need Nifty above its EMA50 with EMA20 above EMA50.
   - Screener and Overview use the same rule and the same wording.
   - The sector / relative-strength gate stays.
3. **Quick Bounce (RSI-2), a new setup.** Shared `SwingPlan.quickBounce`, computed on completed bars only.
   - Rules: 2-day RSI under 10, price above its 50- and 200-day averages, Nifty above its 200-day average, no results within 5 trading days.
   - Trade: buy at the next open, stop 2.5 × ATR, sell at the first close above the 5-day average or on day 10.
   - Shown as its own screener group, an Overview card with a position calculator, and the 09:25 / 15:15 push. It is checked against the Overview like READY.

Backtest (1 year, 255 stocks): 289 trades at 40% wins and −0.09R became 335 trades at 61% wins and +0.09R. Quick Bounce alone: 246 trades, 65% wins, 3.4 days.

**Review fixes, server**
- **Keep-awake runs around the clock.** A sleeping instance can't wake itself, so the 09:25 scan was missed.
- **NSE 401/403 no longer counts as a rate limit.** That pause had blocked the fresh-session retry for the option chain, indices and results.
- **Fin Services Ex-Bank never shows the raw ETF price.** It scales by the last known ratio, or fails so the last good value is used.
- **Option Builder prices everything on one expiry**: strikes, estimates, Greeks and probability all use the NSE expiry it quotes. The expiry list is cached on its own, and chains are cached per expiry.
- **Backtest**: completed bars only, and Quick Bounce's 5-day-average exits counted as target exits.
- **Login cookies and the push key come from a random secret**: `APP_SECRET`, or `data/secret.key`. Before, they were derived from the password, which allowed offline guessing. A logout now survives restarts.
- **Stock history allows 20 s in the Yahoo queue** (cold start failed with "No historical data"), and the page waits 30 s for it.
- **Refresh forces a rescan**, at most one every 5 minutes.
- **Dead `apiScreener` removed** (159 lines).

**Review fixes, page**
- **Trade Gate** no longer notifies a stock the Overview demoted.
- **A slow scan** no longer overwrites a page the user opened meanwhile.
- **Every screener mode switch stops the previous Overview-check loops**, so Refresh can't run two at once.
- **Alerts are deleted and marked triggered by ID**, so a sync can't hit the wrong alert or make one fire again.
- **The limit line** says "no limit plan" instead of "limit ₹0.00".
- **The limit re-score** no longer overwrites the stock's real score.
- **Market Pulse** shows a spinner while it loads.

**Checked after the fixes**
- Every tab of a stock, three indices and three MCX contracts, plus Markets, Screener, Backtest and Track Record: no errors, no empty pages, no NaN / undefined.
- Screener vs Overview: 20 of 20 match.
- Web Push end to end with the new key.
- A logged-out cookie stays rejected after a restart.

## Screener in the top menu + Monthly Momentum (8 Nov 2026)

- **Screener is its own top-menu page** (Indices · Stocks · MCX · Screener · Markets): full width, with no instrument header or tab bar. The sidebar "Open Screener" button is gone.
  - Opening a stock from it switches the menu to Stocks.
- **Screener tabs:** Swing · Monthly momentum · Track record · Backtest. The button on the right refreshes whichever one is open.
- **Monthly momentum** (`/api/momentum`) is the method that tested best on 8.8 years: 13.1% a year vs Nifty 9.4% after 0.25% per swap, worst fall −30% (−21% with the Nifty 200-day filter), behind Nifty in 4 of 9 years.
  - Universe: the 100 largest stocks by market cap at the month-end close.
  - Score: (6-month + 12-month return) ÷ 2 ÷ 1-year volatility, the NSE Nifty200 Momentum 30 style.
  - List: top 20, equal weight, held all month.
- **The page shows:**
  - the list, with sells and buys vs last month;
  - the Nifty 200-day filter (the tested version holds cash when Nifty is below it);
  - quantity per stock for your capital, a setting that syncs between devices;
  - each stock's rank today and an "if the month ended today" preview.
- **Rebalance alert:** on the first trading day of the month, the 09:25 push adds the sells and buys.
- **Checked:** the app's list matches the backtest code's list on the same date (19 of 20; the one difference is the stock at exactly #100 by market cap, because the live universe has a few more stocks). It uses the same cached charts as the swing scan.
- **Momentum Continuation (the 1-10 day swing setup)** was tested on 9 years: −0.025R a trade, profitable in 3 of 10 years, so it stays watch-only.

## Index prices, option premiums, day change, mobile app (9 Nov 2026)

- **Index values and day change come from NSE first.** One NSE call returns every index, so it is shared and cached for 60 seconds. Yahoo is the backup.
  - Yahoo's daily bar for the last session was stale. On 9 Nov it had Nifty's 6 Nov close at 25,030.35, but NSE closed it at 24,986.40, so Nifty showed +14 (+0.06%) instead of +58 (+0.23%).
  - About half of the 26 indices were wrong the same way.
  - The sidebar, Overview, sectors and the top market bar (Nifty, Bank Nifty, India VIX) now all agree with NSE.
  - On the chart, the previous session's bar is set to NSE's close.
- **FIN SERVICE no longer stays on "loading", and sectors show for all 26 indices.**
  - Each sector used to wait on its own Yahoo request, and Fin Service's was slow.
  - Fin Services Ex-Bank now shows the real index (~31,470) instead of the ETF price (~32).
  - If NSE fails, NSE is skipped for 5 minutes and Yahoo serves the indices.
- **MCX day change uses Yahoo's daily bars.** Yahoo's "previous close" for futures was not stable. For NG=F it said 3.533 in one answer and 2.998 a few minutes later, so natural gas showed −11% on a +4.5% day. Gold, silver, crude, natural gas and copper now take the previous close from the daily bars. USD/INR keeps its current source.
- **Stocks were already correct.** 13 checked against NSE's official end-of-day file for 6 Nov: every previous close matched exactly.
- **Option premiums stay on NSE prices.**
  - A cold NSE fetch takes 10-20 s. It used to run after the spot price, so the page gave up at 15 s and showed Black-Scholes estimates. Every 3 minutes the cache expired and that happened again.
  - Now the chain and the spot price are fetched together.
  - Once one chain is in, it is returned at once while a refresh runs in the background.
  - If NSE fails, the last good chain is kept for up to 12 hours, marked "saved quote" after 10 minutes.
  - After 15:30 on expiry day, the default expiry moves to the next one.
- **Screener vs Overview check.**
  - A scan made while NSE was open is no longer reused after the close. The phone used to keep it for 24 hours, so an evening check compared a 15:00 scan with closing prices.
  - When a stock differs only because its price moved since the scan, the check now says so.
  - Checked: 20 of 20 match after the fix.
- **Breakout with Volume is a READY setup again.** This was asked for: the one-year backtest had it at 33% wins and −0.21R. Its gate still applies: close above the 7-day high on 1.1x+ volume, and R:R 1.25 or better.
- **Mobile app.**
  - The app icon, manifest and service worker are no longer behind the login. Phones fetch them without the login cookie, so "Add to Home screen" had no logo.
  - Added a 512 px icon and a 180 px Apple touch icon. The login page links them too.
  - On phones the bottom menu now sits directly under the page body, not inside the scrolling content, so it cannot scroll away in the installed app.

## Diwali Muhurat session, GAIL (9 Nov 2026, night)

- **Correction to the entry above:** Yahoo's index bars were not stale. NSE held the **Diwali Muhurat session on Sunday 8 Nov**, and Yahoo's daily bars skip it, going from Friday 6 Nov straight to Monday 9 Nov. The real previous close for 9 Nov was the Muhurat close: Nifty 24,986.40, GAIL 184.72, RELIANCE 1,324.00. NSE-first indices already gave the right change.
- **Stocks now count the Muhurat session too.**
  - Every stock's day change on 9 Nov was measured from Friday's close: GAIL showed +2.21 (+1.19%) instead of NSE's +3.28 (+1.78%), and SUNPHARMA +2.4% instead of −0.55%.
  - Yahoo's previousClose has the special sessions: 20 of 20 stocks matched NSE's 8 Nov file.
  - The app now uses it, unless it is the lagging kind seen on 29 Oct (equal to the close one session before the bars' last one) or more than 15% away from the bars.
- Removed the 9 Nov change that overwrote the previous daily bar of an index with NSE's close. It had replaced Friday's correct close with the Muhurat close.
- GAIL's WAIT is correct: the screener and Overview agree. It closed at 188 on its high, 0.5% under the 52-week high of 188.90, but RSI is 73 and price is 7.2% above EMA20. The pre-breakout and breakout setups allow at most RSI 72 and 6.5% above EMA20, so this counts as chasing.
- README: keep-awake runs around the clock (about 744 of the 750 free Render hours), so this must be the only free Render web service.

## Trade assistant, calendar checks, My trades, phone UI (13 Nov 2026)

**Calendar and risk checks** (free NSE data, refreshed once a day and kept in `data/nse-calendar.json`)
- **NSE trading holidays** now come from NSE's own list (20 for 2026). 10 Nov (Diwali Balipratipada) had run the scans and alerts as a normal day. Day counts for results now skip holidays too.
- **Corporate actions:** a bonus, split, rights issue or demerger with an ex-date within 10 trading days blocks a fresh entry, in the screener and the Overview alike, just as results do. A dividend shows as a note.
- **NSE surveillance lists (ASM / GSM):** a listed stock is blocked.
- **Gold Petal expiry:** the last day of the month, moved back to the previous working day. It is shown on the MCX card and turns red 5 trading days before.

**Gold Petal is buy-only.**
- A downtrend now reads AVOID ("no new buys / exit a long") instead of SELL.
- A buy waits until 2 of the 3 drivers agree. The drivers: dollar index below its 50-day EMA, US 10-year yield below its 50-day EMA, USD/INR above its 50-day EMA.
- Why: over 10 years, sells made about 0R a trade and buys +0.35R, or +0.43R with the driver filter.
- The plan is one shared function (`SwingPlan.commodityPlan`), so the page and the server alerts agree.

**Your credit-spread rule (Nifty)**
- **Where:** a card on the options idea and in the Option Builder, using the live NSE chain.
- **The rule:**
  - Sell 2%+ from spot with delta under 0.20; buy 200 points further out.
  - Bull put only in a Nifty uptrend, bear call only in a downtrend; otherwise no trade.
  - Credit at least 6 points weekly or 20 monthly.
  - Expiry: the first one at least 3 days away.
- "Highest OI in front of the strike" is shown for information only, because it made the backtest worse.
- PASS / NO TRADE, with every check listed.

**Honest labels**
- **Quick Bounce:** "small size only". Over 10 years with at most 5 positions it lost money overall.
- **Breakout with Volume:** "READY · half size", plus a warning on the Overview, from its 33% wins and −0.21R a trade.

**My trades** (Screener → My trades)
- 📒 "I took this trade" appears on the stock trade plan, Quick Bounce, the Gold Petal idea and the Nifty rule card.
- The dialog fills itself from the plan and sizes the quantity from your capital and risk %.
- **Total open risk:** what all open trades lose if every stop is hit, against a limit (default 5%). It also appears under every position calculator.
- Open trades show live P&L and R. Closing a trade records the result.
- **Results by setup:** trades, win %, average R and total ₹.
- Synced between devices like alerts.

**Alerts** (phone notification + Telegram when linked; set `TELEGRAM_BOT_TOKEN`, then Link)
- **08:45 brief:** market, holidays, events, open trades, Gold Petal.
- **Gold Petal:** 09:05 and 17:00 plan, plus an alert at the buy level.
- **09:30 Nifty options:** your rule.
- **Scans:** 09:25 and 15:15 summary with quantity; 11:30 and 13:30 only new READY / buy-limit / quick bounce.
- **Open-trade watcher:** stop hit, T1 hit (book half), day-10 exit, results or ex-date within 2 days, Gold Petal expiry, Nifty through your short strike.
- **Holidays:** a holiday note and no NSE scans.
- Notifications open the right page: `/?sym=...`, `/?view=trades`.

**UI**
- **Candle chart** (TradingView Lightweight Charts 4.2.0, from unpkg) with EMA20/50/200, the plan's entry / stop / T1, nearest support / resistance and, on Nifty, the rule's strikes. It can be folded away.
- **Verdict line** on the stock Overview: "WAIT · R:R 1.12 · Score 72 · 1 check missing". On phones the decision details fold under it.
- **Phones:**
  - The header hides while scrolling down, and the price card becomes a sticky strip with the verdict.
  - Swipe left / right to change tab; pull down at the top to refresh.
- **Lists:** READY / LIMIT / QUICK chips on stocks, BUY / SELL on MCX, RULE ✓ / NO TRADE on Nifty, and a 5-day mini line on stocks and MCX. Index prices come from NSE, which sends no history, so index rows have no mini line.
- **Prices:** flash green / red when they tick; loading rows shimmer instead of showing "--".

**Checked**
- Telegram end to end against a local stand-in for its API: link, test message, a real stop-hit alert from the watcher.
- Every scheduled job, with a simulated clock: once each, holiday, weekend.
- The rule and Gold plan on live data, and the journal from add to close to stats.
- Phone swipe, header and dialog.
- Full page sweep on phone and desktop widths.

## Phone fixes after the first use (13 Nov 2026, night)

- **Header fixed again.** The auto-hiding header and the sticky price strip are removed. The top menu stays in place, and the Indicators / S&R sub-menu sticks under it while scrolling, as before. The last line of every tab scrolls clear of the bottom menu (checked on all 18 pages at phone size).
- **Gestures removed.** Pull-to-refresh and swipe-to-change-tab are gone: both could fire while scrolling and reload the page. Pages change only from the tab bar.
- **News tab no longer feels stuck:**
  - The News / Sector buttons stay on screen while news loads; before, the whole tab was replaced by a spinner.
  - The server answers at once with the last headlines (up to 6 hours old) while it fetches new ones in the background. Before, every 15 minutes the tab waited for the full source fan-out, up to about 13 s.
  - A refresh that finds nothing keeps the earlier headlines.
  - Each source wait was cut from 6.5 s to 5 s.

## Why the phone kept the old page (13 Nov 2026, late)

- **Cause:** the last upload went through GitHub's "choose your files" box, which cannot keep folders. Every file landed at the top of the repository: the new `server.js` went live (it belongs at the top), but `public/js/td-ui.js`, `public/css/td-v27-assist.css` and `public/js/app.js` stayed the OLD versions. Re-adding the home-screen icon could not help.
- **The server now warns about a bad upload.** It lists page files sitting at the top of the repository, in the Render log and in `/api/health`, and the app shows a red "Upload problem" box on every device until it is fixed.
- **Page version label** at the bottom of the instrument list ("Page version 13 Nov 2026 · 3"), so a phone can be checked against the latest upload.
- **No browser pull-down-to-reload on phones** (`overscroll-behavior-y: none`).

## Global snapshot (14 Nov 2026)

- **US index futures (S&P 500, Nasdaq).** During Indian hours the cash S&P / Nasdaq / Dow are the previous night's close; the futures trade almost round the clock and show what the US is doing now.
  - The Global Bias now uses the futures, falling back to the cash indices when the futures are missing.
  - DAX counts in the bias only while Europe is trading (from 13:30 IST).
- **Europe:** DAX and FTSE 100.
- **Gold:** COMEX gold and silver, plus gold in ₹ per gram (the Gold Petal proxy). The ₹ figure includes the rupee's move: on 13 Nov gold was −0.07% in dollars but +0.14% in rupees.
- **FII / DII** net cash buying from NSE (one call, cached 3 hours), for example FII +₹5,737 Cr, DII −₹2,254 Cr.
- **Every card shows "● Live"** (traded in the last 30 minutes) or **"Closed · time / date"** in IST, so a last-night close no longer looks like a live move.
- **Grouped sections:** India · US now · US cash close / Asia / Europe · Gold / currency / rates · Oil.
- About 6 more data calls per refresh, only while the snapshot is open. Page version 13 Nov 2026 · 4.

## Calmer upload note (14 Nov 2026)

- **The red "Upload problem" box was misleading once the page was current.** GitHub's upload page never deletes files, so the 28 loose copies left by the first web upload stayed after a correct upload, and the box kept saying the phone had the old page.
- It is now a quiet **Housekeeping** note at the bottom of the Markets page, with a Hide button. It says the loose copies are unused, and that `upload-to-github.ps1` deletes them.
- The page version label moved from the instrument lists to the bottom of the Markets page ("Page version 14 Nov 2026 · 5").

## NSE moved to www.nseindia.in (14 Nov 2026)

- **What broke:** NSE moved its website from www.nseindia.com to **www.nseindia.in**, and every old address answers "301 moved". The app did not follow it, so everything read from NSE failed:
  - option chain: premiums fell back to estimates
  - index values: back to Yahoo
  - results dates
  - holidays, corporate actions, ASM / GSM
  - FII / DII
- **Now:**
  - The NSE address is a setting (default www.nseindia.in, override with `NSE_WWW`).
  - When NSE answers with a redirect to another www.nseindia.* address, the app switches to it and retries, so a future move fixes itself. Tested starting from the old address: it switched by itself and all five feeds loaded.
  - NSE's file archive (nsearchives.nseindia.com) did not move.

## Gold Petal sells + full recheck (14 Nov 2026)

- **Gold Petal SELL (small size)** when all 3 drivers point down: dollar index above its 50-day EMA, US 10-year yield above its 50-day EMA, USD/INR below its 50-day EMA. This was the user's choice.
  - Backtest for that case: 12 sells in 10 years, 58% wins, +0.04R a trade. The card says so.
  - Otherwise a downtrend is still AVOID.
  - The journal, zones and the 09:05 / 17:00 plan follow the same rule.
- **Independent code review of every change since 8 Nov, then fixes:**
  - **READY alerts sized from the pullback zone instead of the fill.** The plan's entry for EMA20 / EMA50 / support setups is the zone level, so the alert's quantity overstated the risk (e.g. price 102, zone 100, stop 98: 500 shares instead of 250). Alerts now size from the current price and show the zone separately. Breakout with Volume is now half size in the quantity too, not only in the text.
  - **The Gold Petal buy-level alert could almost never fire.** The plan is rebuilt every 30 minutes, and at the dip level it says "buy now", so its entry equalled the price. The day's planned level is now remembered, and the alert fires when price reaches it (once a day, and not if it is already below the stop).
  - **Stop / target alerts on a trade left open could repeat after 4 days.** Trade alert markers are now kept 60 days.
  - **An empty or odd NSE corporate-action answer could wipe the list for 20 hours.** It is now rejected and the last list kept. NSE text is also stripped of `<>&"` before it reaches the page.
  - **NSE index values on a busy NSE queue:** wait 25 s instead of 12 s, pause 2 minutes instead of 5 after a failure, and the calendar refresh starts 90 s after boot.
  - **Small fixes:**
    - The morning brief survives a bad capital value.
    - Telegram text is cut before escaping, so an `&amp;` is never split.
    - The NSE address check accepts only https www.nseindia.com / .in / .co.in / .org.
    - The Gold card heading no longer says "buy-only" above a SELL.
- **Checked:**
  - 28 API endpoints, every page on phone and desktop (19 of 19 each), Screener vs Overview 24 of 24.
  - All scheduled alerts with a simulated clock, and both fixes with direct tests.
  - The NSE feeds after the move to www.nseindia.in.
  - Page version 14 Nov 2026 · 6.
- **Known, accepted:**
  - The server's Gold plan builds its live candle and levels slightly differently from the page, so a level can differ by a few rupees.
  - Gold plans are also sent on NSE holidays (MCX's holiday list is not loaded).
  - Telegram links the last private chat that messaged the bot.

## Every tab and sub-tab checked (14 Nov 2026, evening)

- **44 tabs and sub-tabs** loaded with no error, blank page or NaN:
  - stocks HDFCBANK and LGEINDIA: Overview, Indicators, S&R, Strategy, Decision, News, Sector;
  - Nifty, Bank Nifty and Nifty IT: Market Pulse, Indicators, S&R, Option Builder, News, Sectors;
  - Gold Petal and Natural Gas: Overview, Indicators, S&R, News;
  - Markets: snapshot, Sectors, Calendar, News, Alerts.
- **Numbers recomputed independently** with textbook formulas on the same data (HDFCBANK), all identical:
  - RSI 73.4; EMA 20 / 50 / 200; MACD and signal; ADX with +DI / −DI; Bollinger bands;
  - pivot; 7 / 14 / 21-day and 52-week highs and lows.
- **Price data:** the 28 Oct candle matched NSE's official file.
- **Tabs agree:** Decision score = Overview score; Strategy says WAIT when the Overview does; Sector maps HDFC Bank to Banking / Nifty Private Bank; News is about the right company.
- **Fixed, wrong information on Strategy cards:** a conditional card whose zone is far from today's price measured its exit plan from today's price. Example: "buy near EMA20 747.52" but "move SL to your entry 804.00 · T1 0.96R". Cards more than 5% from their zone now say "If filled at 747.52: … T1 (7.36R) … move SL to 747.52". Cards at the zone (the active trade) are unchanged.
- Page version 14 Nov 2026 · 7.
