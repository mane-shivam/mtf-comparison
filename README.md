# MTF Compare

One page that shows the MTF leverage Kotak Neo and Rupeezy offer for every NSE stock and ETF, flags which broker gives the most, and works out the full cost of a trade at each (calculator in each stock's detail sheet; formulas and sources in `src/calc.ts`).

For personal reference. Check the broker app before placing an order.

## How it works

```
GitHub Actions (hourly 08:00-18:00 IST, then 22:00, 02:00, 06:00 IST, or the Refresh button)
  └─ scrapers/*.py  → data/raw/<broker>.json      (last good file kept on failure)
  └─ merge.py       → public/data/mtf.json, meta.json, unmatched.json, history.json
  └─ commit         → Vercel redeploys the static site
```

The browser loads `mtf.json` once (about 65 KB gzipped for ~2,200 stocks) and searches it locally.

## Data sources (recon, 28 Oct 2026)

| Broker | Route used | Rows | Notes |
| --- | --- | --- | --- |
| Kotak Neo | HTML table, `/margin-requirement/margin-trading/{page}/` | 1,709 (58 pages) | NSE symbol in the table; page count read from `totalPages` on page 1. Leverage 1 = not funded. |
| Rupeezy | JSON `rupeezy.in/api/mtf-stocks?page=N&pageSize=100` | 2,198 (22 pages) | Symbol and ISIN in the JSON even though the table hides them. Multiplier below 1 = not funded. |
| NSE | `EQUITY_L.csv`, `eq_etfseclist.csv` | 2,975 | Master list for matching. |

Saved responses are in `samples/` and the parser tests run against them.

**Matching:** overrides.csv → ISIN → broker's own NSE symbol → exact normalised name → rapidfuzz ≥ 92 → `unmatched.json` (shown in the page's "Needs matching" panel). On the first run every row matched.

## Market data for open positions

`scrapers/market.py` collects, each refresh: prices for pinned stocks (Yahoo Finance, since NSE's quote API
refuses servers), NSE exchange margin per stock (C_VAR1: VaR + ELM + ad hoc, which brokers set MTF leverage
from), F&O open interest vs the market-wide limit (combineoi), delivery % (bhavcopy, 30-session history kept
in `data/market_hist.json`), bulk and block deals (7 days) and promoter pledges. Results filings come from
NSE announcements (`scrapers/events.py`).

**Positions** (the Positions tab) are saved only in the browser: P&L after all charges, interest so far,
break-even today and the price below which a margin top-up is needed. Export/Import moves them between devices.

## Watchlist alerts and phone notifications

Every refresh compares each pinned stock with the previous refresh (`alerts.py`) and records changes:
multiplier up or down, dropped from or added to a broker's MTF list, entering, leaving or changing stage on
ASM/GSM/ESM, F&O ban in or out, price band or trade-to-trade changes, newly announced events or
flagged announcements, exchange margin moves, F&O open interest crossing 80%/90%, Kotak exposure cap changes,
promoter pledge changes, bulk/block deals, ±5% days, lower/upper circuit, 52-week high/low, volume ≥3× and
delivery spikes (price alerts at most once per day), and results filings. They appear under the bell on the site (last 30 days) and, if set up, on your phone.
A newly pinned stock only sets its baseline, so pinning never floods the feed.

Phone notifications go out from the refresh workflow (`scripts/notify.py`). Set either channel as
repository secrets (Settings → Secrets and variables → Actions → New repository secret):

- **Telegram**: message @BotFather → `/newbot` → copy the token into `TELEGRAM_BOT_TOKEN`. Send any message
  to your new bot, open `https://api.telegram.org/bot<token>/getUpdates`, and copy `chat.id` into `TELEGRAM_CHAT_ID`.
- **ntfy**: install the ntfy app, subscribe to a long random topic (e.g. `mtf-7f3k9q2x8w`), and put the same
  name in `NTFY_TOPIC`. Anyone who knows the topic can read it, so keep it random.

## Local development

Data files under `data/` and `public/data/` are rewritten by the bot on every refresh. Never merge them by
hand: take the bot's copies (`git checkout origin/<branch> -- data public/data`) and re-run the scrapers and
`merge.py` instead.

```bash
pip install -r requirements.txt
python scrapers/nse.py && python scrapers/kotak.py && python scrapers/rupeezy.py && python scrapers/surveillance.py
python merge.py
python -m pytest -q

npm install
npm run dev        # http://localhost:5173
```

## Deploy: GitHub Pages

1. Repo → Settings → Pages → Build and deployment → Source: **GitHub Actions**. (Pages on a private repo needs a paid GitHub plan, and the published site is public to anyone with the link.)
2. Actions → "Deploy to GitHub Pages" → Run workflow. The site goes to `https://<owner>.github.io/<repo>/`.
3. Every data refresh redeploys the site (`refresh.yml` calls `pages.yml`).
4. Refresh button on Pages: there is no server, so the button asks once for a GitHub fine-grained token (this repo only, **Actions: Read and write**) and keeps it in that browser's storage.

## Deploy: Vercel (alternative)

1. GitHub runs scheduled workflows only from the default branch, so keep the workflows there.
2. Import the repo in Vercel. `vercel.json` sets the Vite build and `dist/` output.
3. In Vercel → Settings → Environment Variables add:
   - `GITHUB_TOKEN`: fine-grained token, this repo only, **Actions: Read and write**.
   - `REFRESH_PASSCODE`: any short passcode. The page asks for it once and remembers it.
   - Optional `GITHUB_BRANCH` (default `main`) and `GITHUB_REPO` (default: the repo Vercel deploys).
4. Optional backup cron: point cron-job.org at `POST https://<site>/api/refresh` with header `x-refresh-passcode: <passcode>` at 04:30, 10:45 and 14:30 UTC.

`/api/refresh` refuses a new run if one started in the last 10 minutes or is still running.

## Files

| Path | What |
| --- | --- |
| `scrapers/` | One scraper per broker plus the NSE master list |
| `merge.py` | Matching, best broker with ties, daily history, `meta.json` status |
| `data/overrides.csv` | Hand fixes: broker, name → symbol |
| `data/history/` | One snapshot per IST day (90 days kept); powers ▲/▼ and the 7-day table |
| `src/` | Frontend (Vite + vanilla TypeScript) |
| `api/refresh.js` | Vercel function that triggers the workflow |
