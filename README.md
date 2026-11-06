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
│   ├── css/                  14 stylesheets, loaded in their original order
│   ├── js/app.js             main app script (+ 3 small scripts)
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
Recommended Environment Variable: NODE_ENV = production
Optional news API variables: MARKETAUX_KEY, FINNHUB_KEY, NEWSDATA_KEY
Optional: TRUST_PROXY_HOPS (default 1 in production, 0 locally)
Optional: NSE_HOLIDAYS = extra trading holidays, comma-separated YYYY-MM-DD
```

Notes for the free plan:
- The server keeps itself awake on weekdays 08:30-24:00 IST (alerts and the 09:25 / 15:15 scans need it running).
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
