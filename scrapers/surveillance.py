"""NSE and BSE surveillance lists (ASM short/long term, GSM) with stage and entry date.

NSE: www.nseindia.com/api/reportASM and /api/reportGSM (needs the cookies the report page sets).
     NSE gives no entry date, so the date comes from the matching BSE entry when the same stock is
     on the same list at the same stage (the exchanges decide ASM jointly), else from the first day
     this scraper saw it (data/surveillance_seen.json).
BSE: Trendlyne's ASM dashboard (BSE ASM + GSM with entry dates), since BSE's own page is an app
     with no simple endpoint.

Writes data/raw/surveillance.json. If one exchange fails, its previous entries are kept.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone

from bs4 import BeautifulSoup

if __package__ in (None, ""):
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from scrapers.common import RAW_DIR, ROOT, PoliteSession, now_iso

NSE_PAGE = "https://www.nseindia.com/reports/asm"
NSE_ASM = "https://www.nseindia.com/api/reportASM"
NSE_GSM = "https://www.nseindia.com/api/reportGSM"
TRENDLYNE = "https://trendlyne.com/equity/asm-dashboard/active-stocks/"
OUT = RAW_DIR / "surveillance.json"
SEEN = ROOT / "data" / "surveillance_seen.json"
IST = timezone(timedelta(hours=5, minutes=30))


def stage_of(text: str) -> str:
    """'Stage IV' -> 'IV', 'Stage 0' -> '0'."""
    m = re.search(r"\b(0|[IVX]+)\b", (text or "").replace("Stage", ""))
    return m.group(1) if m else (text or "").strip()


def parse_nse_asm(payload: dict) -> list[dict]:
    out = []
    for key, term in (("longterm", "long"), ("shortterm", "short")):
        block = payload.get(key) or {}
        for r in block.get("data", []) if isinstance(block, dict) else block:
            if r.get("symbol"):
                out.append({"symbol": r["symbol"].strip().upper(), "ex": "NSE", "list": "ASM", "term": term,
                            "stage": stage_of(r.get("asmSurvIndicator", "")), "desc": r.get("survDesc") or ""})
    return out


def parse_nse_gsm(payload: list) -> list[dict]:
    out = []
    for r in payload or []:
        if not r.get("symbol"):
            continue
        # gsmStage holds codes like 'LXII' for combined measures; survCode spells the GSM stage out.
        m = re.search(r"GSM\s*-?\s*(0|[IVX]+)\b", r.get("survCode") or "")
        out.append({"symbol": r["symbol"].strip().upper(), "ex": "NSE", "list": "GSM", "term": None,
                    "stage": m.group(1) if m else stage_of(r.get("gsmStage", "")), "desc": r.get("survDesc") or ""})
    return out


def parse_trendlyne(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    table = next((t for t in soup.find_all("table") if "Entry Date" in t.get_text()), None)
    if table is None:
        raise ValueError("ASM table not found on Trendlyne page")
    out = []
    for tr in table.find_all("tr")[1:]:
        tds = tr.find_all("td")
        if len(tds) < 6:
            continue
        name = tds[0].get("data-export") or tds[0].get_text(" ", strip=True)
        code, exch, kind, stage, date = (td.get_text(" ", strip=True) for td in tds[1:6])
        kind_l = kind.lower()
        try:
            since = datetime.strptime(date, "%d %b %Y").date().isoformat()
        except ValueError:
            since = None
        out.append({"symbol": code.strip().upper(), "name": name, "ex": exch.strip().upper() or "BSE",
                    "list": "GSM" if "gsm" in kind_l else "ASM",
                    "term": "short" if "short" in kind_l else "long" if "long" in kind_l else None,
                    "stage": stage_of(stage), "since": since, "exact": since is not None, "desc": kind})
    return out


def key(e: dict) -> tuple:
    return (e["symbol"], e["list"], e["term"], e["stage"])


def main() -> int:
    today = datetime.now(IST).date().isoformat()
    prev = json.loads(OUT.read_text()) if OUT.exists() else {"entries": [], "sources": {}}
    sources, entries = {}, []

    try:
        s = PoliteSession(referer=NSE_PAGE)
        s.s.headers["Accept"] = "application/json, text/plain, */*"
        s.get(NSE_PAGE)  # sets the cookies the API checks
        nse = parse_nse_asm(s.get(NSE_ASM).json()) + parse_nse_gsm(s.get(NSE_GSM).json())
        if not nse:
            raise RuntimeError("NSE returned no rows")
        sources["NSE"] = {"status": "ok", "count": len(nse), "fetchedAt": now_iso(), "error": None}
    except Exception as e:  # noqa: BLE001
        print(f"[surveillance] NSE failed: {e}")
        nse = [x for x in prev["entries"] if x["ex"] == "NSE"]
        sources["NSE"] = {**prev["sources"].get("NSE", {}), "status": "stale" if nse else "failed", "error": str(e)[:300]}

    try:
        bse = parse_trendlyne(PoliteSession(referer="https://trendlyne.com/").get(TRENDLYNE).text)
        if not bse:
            raise RuntimeError("Trendlyne returned no rows")
        sources["BSE"] = {"status": "ok", "count": len(bse), "fetchedAt": now_iso(), "error": None}
    except Exception as e:  # noqa: BLE001
        print(f"[surveillance] BSE (Trendlyne) failed: {e}")
        bse = [x for x in prev["entries"] if x["ex"] == "BSE"]
        sources["BSE"] = {**prev["sources"].get("BSE", {}), "status": "stale" if bse else "failed", "error": str(e)[:300]}

    # Entry dates for NSE rows: the BSE date for the same measure and stage, else first seen here.
    seen = json.loads(SEEN.read_text()) if SEEN.exists() else {}
    bse_dates = {key(b): b["since"] for b in bse if b.get("since")}
    live_seen = {}
    for e in nse:
        k = "|".join(str(x) for x in key(e))
        live_seen[k] = seen.get(k, today)
        if key(e) in bse_dates:
            e.update(since=bse_dates[key(e)], exact=True)
        else:
            e.update(since=live_seen[k], exact=False)
    entries = nse + bse

    SEEN.write_text(json.dumps(live_seen, indent=0, sort_keys=True) + "\n")
    OUT.write_text(json.dumps({"fetchedAt": now_iso(), "sources": sources, "entries": entries}, indent=0) + "\n")
    print(f"[surveillance] NSE {len(nse)} ({sum(e['exact'] for e in nse)} with exchange dates), BSE {len(bse)}")
    return 0 if any(v["status"] == "ok" for v in sources.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
