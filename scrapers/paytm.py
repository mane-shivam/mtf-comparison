"""Paytm Money MTF list: one JSON call returns every row with symbol and ISIN.

Found behind https://www.paytmmoney.com/mtf/list (the page's JS calls
api-eq.paytmmoney.com/mtf/order/api/v2/scrips). If the API is down, rows can be
supplied by hand in data/manual/paytm.csv (columns: symbol,name,lev,ownPct).
"""

from __future__ import annotations

import csv
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from scrapers.common import ROOT, PoliteSession, run_scraper, to_float

API = "https://api-eq.paytmmoney.com/mtf/order/api/v2/scrips"
MANUAL = ROOT / "data" / "manual" / "paytm.csv"


def parse(payload: dict) -> list[dict]:
    rows = []
    for r in payload.get("data") or []:
        if (r.get("status") or "").upper() != "ENABLED":
            continue
        lev = to_float(r.get("margin_x"))
        own = to_float(r.get("margin_perc"))
        if lev is None:
            continue
        row = {
            "symbol": (r.get("symbol") or "").strip().upper() or None,
            "name": (r.get("scrip_name") or "").strip(),
            "isin": r.get("isin"),
            "exchange": r.get("exchange") or "NSE",
            "type": "etf" if r.get("instrument_type") == "ETF" else "equity",
            "lev": round(lev, 2),
            "ownPct": round(own, 2) if own is not None else None,
        }
        # Log rows where the displayed leverage disagrees with 1 / own funds %.
        if own and abs(100 / own - lev) > max(0.25, lev * 0.1):
            print(f"[paytm] mismatch {row['symbol']}: shows {lev}x but own funds {own}% (~{100 / own:.2f}x)")
        rows.append(row)
    return rows


def load_manual() -> list[dict]:
    rows = []
    with MANUAL.open(newline="") as f:
        for r in csv.DictReader(f):
            lev = to_float(r.get("lev"))
            if lev is None:
                continue
            rows.append({
                "symbol": (r.get("symbol") or "").strip().upper() or None,
                "name": (r.get("name") or "").strip(),
                "exchange": "NSE",
                "lev": lev,
                "ownPct": to_float(r.get("ownPct")),
            })
    return rows


def scrape() -> list[dict]:
    s = PoliteSession(referer="https://www.paytmmoney.com/mtf/list")
    s.s.headers["Origin"] = "https://www.paytmmoney.com"
    try:
        return parse(s.get(API).json())
    except Exception:
        if MANUAL.exists():
            print(f"[paytm] API failed, using {MANUAL.relative_to(ROOT)}")
            return load_manual()
        raise


if __name__ == "__main__":
    sys.exit(run_scraper("paytm", scrape, min_rows=500))
