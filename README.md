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
Optional news API variables: MARKETAUX_KEY, FINNHUB_KEY, NEWSDATA_KEY
Optional: TRUST_PROXY_HOPS (default 1 in production, 0 locally)
Optional: NSE_HOLIDAYS = extra trading holidays, comma-separated YYYY-MM-DD (the server also reads NSE's own list daily)
Optional: TELEGRAM_BOT_TOKEN = your Telegram bot's token, for alerts in Telegram (see below)
```

Telegram alerts (free, optional):
1. In Telegram open @BotFather, send /newbot, pick a name, and copy the token it gives you.
2. Render → your service → Environment → add TELEGRAM_BOT_TOKEN = that token → Save (Render redeploys).
3. Open your new bot in Telegram and send /start. In TradeDesk: Screener → My trades → Telegram alerts → Link.
Every alert then also arrives in Telegram. Schedule (IST, NSE trading days unless noted):
- 09:20 your open trades: day-10 time exit, results / ex-dates close, Gold Petal expiry (only when there is one).
- 09:30 morning brief: new entries allowed / small size / not today, global bias, India market regime, FII/DII,
  holidays, high-impact events, your open trades and open risk, up to 3 market-moving headlines.
- 09:45 and 17:00 (weekdays) Gold Petal: only when a BUY (2 of 3 drivers) or SELL is ready (entry within 1 ATR of
  the price); a plan waiting for a bigger dip / rise alerts when price reaches its buy / sell level.
- 10:00 Nifty options: only when your credit-spread rule passes on the live NSE chain.
- 11:00 and 15:00 stock scans: READY / buy-limit / quick bounce stocks. At 15:00, when nothing was ready, one quiet
  line with the day's Gold Petal and Nifty status (so a silent day is not mistaken for a broken app).

Track record (Screener → Track record) has three sub-tabs, all checked once a day:
- Stocks: every READY pick (the server records the 11:00 / 15:00 scan picks even when the app is closed), entry =
  the price when it turned READY; stop, T1 / T2 on each day's candle; closed at the close of day 10 at the latest.
- Gold Petal: entry at the plan's defined price; checked each morning on the completed daily candles; closed at
  the close of day 10 at the latest.
- Nifty options: entry at the 10:00 NSE premiums; closed once 80% of the premium is earned, at the stop (loss 2x
  the credit), or at 15:05 on Friday (the week's last trading day).
They sync like My trades, so a Render restart does not lose them.

/api/health (open it while logged in) shows nseOptionChain: the time of the last good NSE option-chain answer and
the last error, if any; nseCookie: how often NSE's cookie page was fetched (about twice an hour at most); fiiDii:
the day of the FII / DII figures held and the latest day NSE should have published; nseCalls: NSE's last 12
answers to this server (status, time, cookies, start of the body when not 200 - "Access Denied" / 403 means NSE
refuses this server's address); nseRefused: how often that happened (no NSE live call for 5 minutes after each).

FII / DII figures are fetched once per published day and kept in data/fii-dii.json; NSE is asked again only after
17:30 IST on the next trading day.

NSE call budget (NSE refuses cloud servers that ask often). NSE is asked only at fixed times; pages read the saved
copy (data/nse-snap.json):
- 10:00  Nifty premiums of the rule's expiry (+ the expiry list once a day) and all index values.
- 15:05  Nifty premiums once more (Track record check, Friday close, the afternoon's premiums on the pages).
- evening  FII / DII once per published day; holiday list weekly; corporate actions and ASM / GSM lists daily.
- Only when nothing from today is saved (after a deploy), one catch-up call each for premiums and index values.
Index prices are live from Yahoo, with NSE's previous close from the 10:00 snapshot; Fin Services Ex-Bank is the
ETF x the index / ETF ratio. The option builder uses Black-Scholes estimates only; trade ideas use the saved NSE
premiums (with their time) for the rule's expiry, estimates for other expiries.

NSE relay (optional, free): relay/nse-relay-worker.js is a Cloudflare Worker that asks NSE from Cloudflare's address.
Setup in relay/RELAY-SETUP.txt; then set NSE_RELAY_URL and NSE_RELAY_KEY on Render. /api/health shows nseRelay.
- Any time the market is open: stop or target 1 hit on a trade in My trades (tap 📒 when you take a trade).

Notes for the free plan:
- The server keeps itself awake around the clock (it calls its own address every 10 minutes), so there is no cold
  start and alerts / the 11:00 and 15:00 scans always run. That uses about 744 of the 750 free instance hours a
  month, so it works only while this is your ONLY free Render web service: a second free service would use up the
  hours before the month ends and Render would pause both until the 1st.
- Render's free disk is wiped on every deploy: your alerts / Track Record come back automatically the next time
  you open TradeDesk on a device that has them; Export backup (Markets page) keeps a copy as a file.
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
