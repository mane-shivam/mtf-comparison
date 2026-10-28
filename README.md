# MTF Compare

One page that shows the MTF leverage Kotak Neo, Paytm Money and Rupeezy offer for every NSE stock and ETF, and flags which broker gives the most.

For personal reference. Check the broker app before placing an order.

## How it works

```
GitHub Actions (10:00, 16:15, 20:00 IST, or the Refresh button)
  └─ scrapers/*.py  → data/raw/<broker>.json      (last good file kept on failure)
  └─ merge.py       → public/data/mtf.json, meta.json, unmatched.json, history.json
  └─ commit         → Vercel redeploys the static site
```

The browser loads `mtf.json` once (about 65 KB gzipped for ~2,200 stocks) and searches it locally.

## Data sources (recon, 28 Oct 2026)

| Broker | Route used | Rows | Notes |
| --- | --- | --- | --- |
| Kotak Neo | HTML table, `/margin-requirement/margin-trading/{page}/` | 1,709 (58 pages) | NSE symbol in the table; page count read from `totalPages` on page 1. Leverage 1 = not funded. |
| Paytm Money | JSON `api-eq.paytmmoney.com/mtf/order/api/v2/scrips` | 1,534 | One call; symbol, ISIN, margin %, multiplier. Found behind `paytmmoney.com/mtf/list`. |
| Rupeezy | JSON `rupeezy.in/api/mtf-stocks?page=N&pageSize=100` | 2,198 (22 pages) | Symbol and ISIN in the JSON even though the table hides them. Multiplier below 1 = not funded. |
| NSE | `EQUITY_L.csv`, `eq_etfseclist.csv` | 2,975 | Master list for matching. |

Saved responses are in `samples/` and the parser tests run against them.

**Matching:** overrides.csv → ISIN → broker's own NSE symbol → exact normalised name → rapidfuzz ≥ 92 → `unmatched.json` (shown in the page's "Needs matching" panel). On the first run every row matched.

## Local development

```bash
pip install -r requirements.txt
python scrapers/nse.py && python scrapers/kotak.py && python scrapers/paytm.py && python scrapers/rupeezy.py
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
| `data/manual/paytm.csv` | Fallback rows for days Paytm's API is down |
| `data/history/` | One snapshot per IST day (90 days kept); powers ▲/▼ and the 7-day table |
| `src/` | Frontend (Vite + vanilla TypeScript) |
| `api/refresh.js` | Vercel function that triggers the workflow |
