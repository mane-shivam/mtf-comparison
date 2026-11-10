# MTF Compare

A personal dashboard for margin trading (MTF) on NSE. It compares Kotak Neo and Rupeezy leverage for every stock and ETF, tracks open MTF positions, and sends alerts for changes that affect them.

## What it does

- **Leverage comparison.** Shows each broker's multiplier for about 2,200 NSE stocks and ETFs. Brokers within 0.2× of the top count as best.
- **Risk flags.** Covers ASM, GSM and ESM stages, the F&O ban, price bands and trade-to-trade, board meetings and results, corporate actions, and adverse announcements.
- **Cost calculator.** Works out brokerage, statutory charges, depository fees and interest for each broker. Formulas and sources are in `src/calc.ts`.
- **Positions.**
  - P&L before and after every charge and interest. Returns are shown on total investment and on own money.
  - Interest per day and per month.
  - Margin checked per broker account using each broker's current rate for the stock.
  - Recorded sales, and realised P&L as of now.
- **Alerts.** Each refresh compares pinned stocks with the last refresh. Changes appear under the bell and go to the phone, along with margin top-up warnings and an 08:00 IST summary.

## How it runs

```
keeper.yml        starts each refresh on time (hourly 08:00-18:00 IST, then 22:00, 02:00, 06:00)
refresh.yml       scrapers/*.py → merge.py → alerts.py → scripts/portfolio.py → commit → notify → deploy
pages.yml         builds the Vite site and publishes it to GitHub Pages
```

A scraper that fails keeps its last good data and is marked stale. Saved broker responses in `samples/` back the parser tests.

## Data and privacy

| Data | Where it lives |
| --- | --- |
| Watchlist | `data/pins.json`, public |
| Positions, closed trades, rates, earlier P&L | `data/positions.enc.json`, encrypted in the browser (AES-256-GCM, key from the passphrase with PBKDF2-SHA256, 200,000 rounds) |
| Decrypted portfolio output | Built in the Actions runner only; the output files are gitignored and never committed |

The passphrase and tokens are never stored in the repo.

## Setup

**Repository secrets** (Settings → Secrets and variables → Actions):

| Secret | Purpose |
| --- | --- |
| `POSITIONS_PASSPHRASE` | The same passphrase used for private sync on the site. Enables top-up warnings and portfolio figures in the summary. |
| `NTFY_TOPIC` | Phone notifications through the ntfy app. Use a long random topic. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Optional second channel. |

**Browser:** connect a fine-grained GitHub token, limited to this repo with Contents and Actions set to Read and write. The site needs it to save pins and positions and to start refreshes. Then turn on private sync in the Positions tab.

## Development

```bash
pip install -r requirements.txt && python -m pytest -q
npm install && npm run dev
```

The bot rewrites the files under `data/` and `public/data/` on every refresh. Never merge them by hand. Take the bot's copies and re-run the scrapers and `merge.py`.

Check the broker app before placing an order. Margins and charges here are estimates.
