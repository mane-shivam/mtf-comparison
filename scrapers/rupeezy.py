"""Rupeezy MTF list: the page is fed by /api/mtf-stocks (JSON, 100 rows per page).

The JSON carries symbol and ISIN even though the table only shows names.
The site displays "Your Funds" as 1 / margin_multiplier, and 100% when the
multiplier is below 1, which we treat as not funded.
"""

from __future__ import annotations

import math
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from scrapers.common import PoliteSession, run_scraper, to_float

API = "https://rupeezy.in/api/mtf-stocks?page={page}&pageSize=100&search="


def parse(payload: dict) -> tuple[list[dict], int]:
    rows = []
    for r in payload.get("data") or []:
        lev = to_float(r.get("margin_multiplier"))
        if lev is None:
            continue
        exch = (r.get("exchange") or "NSE_EQ").split("_")[0]
        rows.append({
            "symbol": (r.get("symbol") or "").strip().upper() or None,
            "name": (r.get("security_desc") or "").strip(),
            "isin": r.get("isin"),
            "exchange": exch,
            "type": "etf" if "ETF" in (r.get("instrument_name") or "").upper() else "equity",
            "lev": round(lev, 2),
            "ownPct": 100.0 if lev < 1 else round(100 / lev, 2),
        })
    return rows, int(payload.get("total") or len(rows))


def scrape() -> list[dict]:
    s = PoliteSession(referer="https://rupeezy.in/margin-trading-facility/mtf-stock-lists")
    rows, total = parse(s.get(API.format(page=1)).json())
    pages = math.ceil(total / 100)
    print(f"[rupeezy] {total} stocks, {pages} pages")
    for page in range(2, pages + 1):
        page_rows, _ = parse(s.get(API.format(page=page)).json())
        rows.extend(page_rows)
    if abs(len(rows) - total) > total * 0.05:
        raise RuntimeError(f"got {len(rows)} rows but site reports {total}")
    return rows


if __name__ == "__main__":
    sys.exit(run_scraper("rupeezy", scrape, min_rows=500))
