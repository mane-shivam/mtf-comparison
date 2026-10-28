"""Download NSE's equity and ETF master lists used for symbol matching.

Writes data/nse/master.json: [{symbol, name, isin, type}]. On failure the
previous file is kept (the lists change slowly).
"""

from __future__ import annotations

import csv
import io
import json
import sys

if __package__ in (None, ""):
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from scrapers.common import ROOT, PoliteSession

EQUITY_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
ETF_URL = "https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv"
OUT = ROOT / "data" / "nse" / "master.json"


def parse_equity(text: str) -> list[dict]:
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        if r.get("SYMBOL"):
            rows.append({"symbol": r["SYMBOL"].upper(), "name": r.get("NAME OF COMPANY", ""),
                         "isin": r.get("ISIN NUMBER", ""), "type": "equity"})
    return rows


def parse_etf(text: str) -> list[dict]:
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
        if r.get("Symbol"):
            rows.append({"symbol": r["Symbol"].upper(), "name": r.get("Underlying Asset") or r.get("SecurityName", ""),
                         "isin": r.get("ISINNumber", ""), "type": "etf"})
    return rows


def main() -> int:
    s = PoliteSession(referer="https://www.nseindia.com/")
    try:
        rows = parse_equity(s.get(EQUITY_URL).text) + parse_etf(s.get(ETF_URL).text)
        if len(rows) < 1500:
            raise RuntimeError(f"only {len(rows)} rows")
    except Exception as e:  # noqa: BLE001
        print(f"[nse] failed, keeping previous master list: {e}")
        return 0 if OUT.exists() else 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rows, indent=0, ensure_ascii=False) + "\n")
    print(f"[nse] {len(rows)} symbols -> {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
