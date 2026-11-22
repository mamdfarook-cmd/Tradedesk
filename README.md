[README.md](https://github.com/user-attachments/files/28040590/README.md)
# TradeDesk v1.0

Private Indian market trading terminal for NSE indices/stocks, MCX reference prices, crypto pulse, global market snapshot, news, screeners, swing scoring and options strategy analysis.

## What is cleaned in this release

- Standardized release label to **v1.0**.
- Fixed Render/Linux static-file bug by using lowercase `public/` instead of `PUBLIC/`.
- Removed old version-history clutter from this README.
- Added `.gitignore` so GitHub does not receive local junk, logs, `node_modules`, cache files or old build artifacts.
- Kept browser local-cache cleanup logic so old v9 screener/global/sector/crypto cache keys are removed automatically.

## Project structure

```text
TradeDesk/
├── public/
│   ├── index.html            page markup only (21 KB)
│   ├── css/                  15 stylesheets, loaded in their original order (td-v27-assist.css = new UI parts)
│   ├── js/app.js             main app script (+ 3 small scripts, td-journal.js = My trades, td-ui.js = chart / phone UI)
│   ├── swing-plan.js         shared trading rules (browser + server)
│   ├── sw.js                 service worker: notifications + background alerts
│   ├── manifest.webmanifest  "Add to Home Screen" (needed for iPhone alerts)
│   └── icon-192.png
├── data/universe.json        starting stock universe (rebuilt weekly from NSE)
├── server.js
├── package.json
├── render.yaml               Render settings (Blueprint)
├── .gitignore
└── README.md
```

## Local run

There is no default password. Set `APP_PASSWORD` when starting the server; without it, login is disabled.

```bash
npm install
APP_PASSWORD=choose-a-password npm start
```

On Windows PowerShell: `$env:APP_PASSWORD="choose-a-password"; npm start`

Open:

```text
http://localhost:3000
```

## Render deployment

Render deploys from a GitHub repository (it has no zip upload).

1. Unzip, and upload the **contents** of the `TradeDesk` folder (not the folder itself) to your GitHub repository, so
   `server.js` and `package.json` sit at the top level of the repository. Replacing an older version: delete the old
   `public/index.html` first, or upload over it - every file in this zip replaces its old copy.
2. Render: **New → Blueprint** → pick the repository. Render reads `render.yaml` and asks for `APP_PASSWORD` once.
   Existing service: it redeploys by itself on the GitHub upload (or press **Manual Deploy**).
3. Manual settings, if you do not use the Blueprint:

```text
Runtime: Node
Build Command: npm install
Start Command: npm start
Required Environment Variable: APP_PASSWORD = your-private-password
Recommended Environment Variable: APP_SECRET = any long random text (32+ characters). render.yaml generates it.
  Without it the server makes data/secret.key, which Render's free disk loses on every deploy: you would have to
  log in again and turn background alerts on again after each deploy.
Recommended Environment Variable: NODE_ENV = production
Optional news API variables: MARKETAUX_KEY, FINNHUB_KEY, NEWSDATA_KEY (used on every news fetch alongside the free
  feeds; a symbol's news is cached 15 minutes, well inside their free daily limits)
Optional: TRUST_PROXY_HOPS (default 1 in production, 0 locally)
Optional: NSE_HOLIDAYS = extra trading holidays, comma-separated YYYY-MM-DD (the server also reads NSE's own list daily)
```

Alerts arrive as phone / browser notifications (turn them on: 🔔 box on a stock, or Screener → My trades → Phone /
browser alerts). Schedule (IST, NSE trading days unless noted):
- 09:20 your open trades: time exit due (stocks day 15, MCX day 10 / 20), results / ex-dates close, Gold Petal
  expiry (only when there is one).
- 09:30 morning brief: new entries allowed / small size / not today, global bias, India market regime,
  holidays, high-impact events, your open trades and open risk, up to 3 market-moving headlines.
- 09:45 and 17:00 (weekdays) MCX - Gold Petal, Crude Oil Mini, Natural Gas Mini: only when a BUY is ready (gold:
  all three buy-only, sold at T1 or day 10 - gold since 20 Nov 2026 without the driver filter), entry
  within 1 ATR of the price; a plan waiting for a bigger dip alerts when price reaches its buy level.
- Nifty options, only on the first trading day after a weekly expiry (as tested): 10:00 a reminder if Zerodha is not
  connected; 15:05 one alert with the bull-put rule (held to expiry) and the weekly sells (trend sell of one side, short strangle,
  both 2%+ away, exit on a close at 2x the premium / credit) with today's strikes and premiums from Zerodha.
- 11:00 and 15:00 stock scans: READY stocks of the tested gate (from 20 Nov 2026: EMA20 crosses above EMA50 while the
  stock beats Nifty over 3 months, or a 2%+ gap-up on 2x volume near the 52-week high; signal on a close; exit 2R or
  day 15). 11:00 alerts yesterday's-close signals, 15:00 today's; pattern breakouts at 15:00. Quick
  Bounce is watch-only (no alert). At 15:00, when nothing was ready, one quiet line with the day's MCX and Nifty
  status (so a silent day is not mistaken for a broken app).

Track record (Screener → Track record) has three sub-tabs, all checked once a day:
- Stocks: every READY pick (the server records the 11:00 / 15:00 scan picks even when the app is closed), entry =
  the price when it turned READY. From 19 Nov 2026: the whole position at 2R or the stop, else the close of day 15
  (older records keep T1 / T2 / day 10). Results by tag (delivery, PCR, structure, 52-week high, double bottom).
- MCX (Gold Petal, Crude Oil, Natural Gas): entry at the plan's defined price; checked each morning on the
  completed daily candles; the whole position at the target (T1; gold rows before 20 Nov 2026 3R) or the stop, else the close of day
  20 (gold) / 10. A win rate per commodity.
- Nifty options: entry at the 15:05 premiums on the first trading day after an expiry, held to expiry and settled from
  Nifty's close (rows before 21 Nov 2026: 80% of the premium, a 2x-credit stop or Friday's close).
They sync like My trades, so a Render restart does not lose them.

/api/health (open it while logged in) shows nseOptionChain: the time of the last good NSE option-chain answer and
the last error, if any; nseCookie: how often NSE's cookie page was fetched (about twice an hour at most); nseCalls: NSE's last 12
answers to this server (status, time, cookies, start of the body when not 200 - "Access Denied" / 403 means NSE
refuses this server's address); nseRefused: how often that happened (no NSE live call for 5 minutes after each).

FII / DII (22 Nov 2026): from Moneycontrol's FII / DII page, every 3 hours; NSDL (FPI only, settled figure) when
Moneycontrol refuses. NSE refuses Render's address; Kite has none. /api/health -> freeSources shows the source or the error.
When NSE refuses: results dates and dividend ex-dates from Yahoo's calendar (estimates are notes, not blocks), bonus /
split ex-dates from Yahoo's split calendar, the universe re-priced from the saved list. ASM / GSM: NSE only. Saved in
data/free-cal.json.

Data sources (18 Nov 2026). NSE refuses Render's address, so NSE market-data requests were removed:
- Option premiums: Zerodha Kite only (live, any expiry). Not connected: the last saved Kite chain on the pages,
  Black-Scholes estimates from India VIX otherwise (marked "Estimated premiums"; the 15:05 entry-day alert names the
  estimated strikes); the Track record needs Kite.
- Index values and previous closes: Zerodha Kite when connected, else Yahoo. Fin Services Ex-Bank = FINIETF ETF x the
  ratio learned from Kite, else the built-in ratio 978.8 (FINEXBANK_RATIO overrides it).
- Trading holidays: NSE's 2026 list is built in (NSE_HOLIDAYS=YYYY-MM-DD,... adds days; add 2027 in December).
- Still asked from NSE (other checks use them; saved / built-in data when refused, retried every 3-6 hours): the
  results calendar, corporate actions, ASM / GSM lists, the holiday list and the index member lists (universe).
Zerodha Kite Connect (optional, recommended): with KITE_API_KEY / KITE_API_SECRET on Render and the daily
"Connect Zerodha" login (Screener -> My trades; Zerodha ends it at 06:00), option premiums of every expiry, every NSE
index (Fin Services Ex-Bank included) and India VIX come live from Kite - no NSE call. Read-only, no orders.
Setup in KITE-SETUP.txt; /api/health -> kite, /api/kite/status.
Layout (20 Nov 2026): Indices = Nifty 50 / Next 50 / Midcap 150 (sectors are on Markets -> Sectors); MCX = Gold Petal,
Crude Oil, Natural Gas (the backtested ones). The list folds after a pick. Stock / MCX: Overview · Analysis (one
Technicals page) · News. Nifty: Market Pulse · Technicals · Option Builder. Removed: Decision, the stock Strategy page,
the Backtest and Yahoo vs Kite screener tabs.

Backtested changes (19 Nov 2026) - see CHANGES.md for the numbers:
- Stock exit: sell all at 2R or day 15 (T1 stays the R:R check). Tags on every screener row: higher highs / higher
  lows, near the 52-week high, double bottom above its neckline, and the stock-option put/call ratio (0.5+) from
  Zerodha: open interest of every stock option (~80 quote requests, ~1.5 min) once a day after 15:40, or as soon as
  Zerodha is connected when none is loaded (data/kite-pcr.json). NSE delivery % was removed: NSE's archive answers
  Render with 403. New list: Pattern breakouts (double bottom / flat base), also
  shown as a card on the stock's Overview. The Overview's trend (bias) uses the screener's rule, so the two agree.
- Missed checks catch up: an MCX check missed at 09:45 / 17:00 (deploy or restart) runs at the next minute between
  10:05 and 23:00; the Nifty entry-day check retries until 15:25 when the premiums were missing. The Track record's MCX /
  Nifty tabs show today's server check, i.e. why a signal was or was not recorded.
- Quick Bounce is watch-only; candle patterns no longer vote in the Overview bias.
- Nifty options: bull puts only (bear calls lost money); minimum credit by days to expiry (6+ up to 10 days, 20+
  beyond). The generic "Today's options idea" card was removed.
- MCX: Gold Petal, Crude Oil and Natural Gas are buy-only, sold at T1 or day 10 (Natural Gas Mini, 250 mmBtu).
- My trades: portfolio check (more than 5 open trades, more than 2 in one sector, open risk over the limit).

Notes for the free plan:
- The server keeps itself awake around the clock (it calls its own address every 10 minutes), so there is no cold
  start and alerts / the 11:00 and 15:00 scans always run. That uses about 744 of the 750 free instance hours a
  month, so it works only while this is your ONLY free Render web service: a second free service would use up the
  hours before the month ends and Render would pause both until the 1st.
- Render's free disk is wiped on every deploy: your alerts / Track Record come back automatically the next time
  you open TradeDesk on a device that has them; Export backup (Markets page) keeps a copy as a file.
  Notifications after a deploy: phone / browser alerts start again once you open TradeDesk on that device.
- Background alerts on a phone: open the 🔔 box on a stock → Turn on → Test. iPhone: Share → Add to Home Screen
  first, then open TradeDesk from that icon.
- Changing `APP_PASSWORD` logs every device out and needs background alerts turned on again.

After deploy, test:

```text
https://your-render-url.onrender.com/api/health
```

A protected browser session should redirect to `/auth/login` first. After login, `/api/health` should return JSON with `v: "1.0"`.

## GitHub fresh upload without old history

From the project folder:

```bash
git init
git add .
git commit -m "TradeDesk v1.0 clean release"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

This creates a clean repository history starting at v1.0.

## Important security note

If the GitHub repository is public, anyone can read the code. Keep passwords only in Render environment variables. Never put real API keys or passwords into `server.js`, `index.html`, README, or GitHub commits. Use Render environment variables instead.

## Data limitations

TradeDesk uses public/free data sources and proxies where exchange-grade data is not freely available. Prices, news and indicators can be delayed, incomplete or temporarily unavailable due to provider limits. Treat all signals as analysis support, not automatic trade instructions.
