"""NSE surveillance lists (ASM short/long term, GSM, ESM) with stage and the date each entry was added.

Source: www.nseindia.com/api/reportASM and /api/reportGSM (needs the cookies the report page sets).
BSE's own lists and Trendlyne both refuse requests from cloud servers, and ASM/GSM is decided jointly
by the exchanges, so every MTF-eligible stock BSE flags is on NSE's list too.

NSE publishes no entry date. data/surveillance_seen.json keeps one per measure and stage:
- entries already listed when tracking began were dated from BSE's published entry dates (via
  Trendlyne) where they matched, otherwise they are marked as "on the list since at least" that day;
- anything that appears later is dated by the refresh that first sees it (three runs a day).

Writes data/raw/surveillance.json. If NSE fails, the previous entries are kept and marked stale.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone

if __package__ in (None, ""):
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from scrapers.common import RAW_DIR, ROOT, PoliteSession, now_iso

NSE_PAGE = "https://www.nseindia.com/reports/asm"
NSE_ASM = "https://www.nseindia.com/api/reportASM"
NSE_GSM = "https://www.nseindia.com/api/reportGSM"
NSE_ESM = "https://www.nseindia.com/api/reportESM"
OUT = RAW_DIR / "surveillance.json"
SEEN = ROOT / "data" / "surveillance_seen.json"
IST = timezone(timedelta(hours=5, minutes=30))
# Entries first seen on the day a list started being tracked may be older than that day.
TRACKING_STARTED = {"ASM": "2026-11-04", "GSM": "2026-11-04", "ESM": "2026-11-08"}


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


def parse_nse_esm(payload: list) -> list[dict]:
    """Enhanced Surveillance Measure (smaller companies): stage I or II."""
    return [{"symbol": r["symbol"].strip().upper(), "ex": "NSE", "list": "ESM", "term": None,
             "stage": stage_of(r.get("esmSurvIndicator", "")), "desc": r.get("survDesc") or ""}
            for r in payload or [] if r.get("symbol")]


def key(e: dict) -> str:
    return "|".join(str(x) for x in (e["symbol"], e["list"], e["term"], e["stage"]))


def date_entries(entries: list[dict], seen: dict, today: str) -> dict:
    """Attach since/exact to each entry; return the seen-store for the entries still listed."""
    live = {}
    for e in entries:
        k = key(e)
        rec = seen.get(k)
        start = TRACKING_STARTED.get(e["list"], today)
        if isinstance(rec, str):  # older format: just the date
            rec = {"since": rec, "exact": rec > start}
        if rec is None or (rec["since"] == start and rec["exact"]):
            rec = {"since": rec["since"] if rec else today, "exact": (rec["since"] if rec else today) > start}
        live[k] = rec
        e.update(rec)
    return live


def main() -> int:
    today = datetime.now(IST).date().isoformat()
    prev = json.loads(OUT.read_text()) if OUT.exists() else {"entries": [], "sources": {}}
    try:
        s = PoliteSession(referer=NSE_PAGE)
        s.s.headers["Accept"] = "application/json, text/plain, */*"
        s.get(NSE_PAGE)  # sets the cookies the API checks
        entries = parse_nse_asm(s.get(NSE_ASM).json()) + parse_nse_gsm(s.get(NSE_GSM).json())
        try:
            entries += parse_nse_esm(s.get(NSE_ESM).json())
        except Exception as e:  # noqa: BLE001 - ESM is optional; ASM/GSM still count
            print(f"[surveillance] ESM failed: {e}")
        if not entries:
            raise RuntimeError("NSE returned no rows")
        source = {"status": "ok", "count": len(entries), "fetchedAt": now_iso(), "error": None}
    except Exception as e:  # noqa: BLE001
        print(f"[surveillance] NSE failed, keeping previous list: {e}")
        old = prev.get("sources", {}).get("NSE", {})
        prev_nse = [x for x in prev.get("entries", []) if x.get("ex") == "NSE"]
        OUT.write_text(json.dumps({**prev, "sources": {"NSE": {**old, "status": "stale" if prev_nse else "failed",
                                                                "error": str(e)[:300]}}}, indent=0) + "\n")
        return 1

    seen = json.loads(SEEN.read_text()) if SEEN.exists() else {}
    SEEN.write_text(json.dumps(date_entries(entries, seen, today), indent=0, sort_keys=True) + "\n")
    OUT.write_text(json.dumps({"fetchedAt": source["fetchedAt"], "sources": {"NSE": source}, "entries": entries},
                              indent=0) + "\n")
    print(f"[surveillance] NSE {len(entries)} entries ({sum(e['exact'] for e in entries)} with an added date)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
