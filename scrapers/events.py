"""NSE F&O ban list and company events (board meetings, corporate actions) from 3 days ago onwards.

Sources (all NSE, which answers GitHub Actions):
- F&O ban: nsearchives.nseindia.com/content/fo/fo_secban.csv
- Board meetings: /api/corporate-board-meetings (purpose, agenda, link to the filing)
- Corporate actions: /api/corporates-corporateActions (ex-dates for dividends, splits, bonuses, ...)

Writes data/raw/events.json. A part that fails keeps its previous data and is marked stale.
"""

from __future__ import annotations

import json
import re
import sys
from datetime import date, datetime, timedelta, timezone

if __package__ in (None, ""):
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from scrapers.common import RAW_DIR, PoliteSession, now_iso

BAN_CSV = "https://nsearchives.nseindia.com/content/fo/fo_secban.csv"
NSE_PAGE = "https://www.nseindia.com/companies-listing/corporate-filings-event-calendar"
BOARD = "https://www.nseindia.com/api/corporate-board-meetings?index=equities&from_date={f}&to_date={t}"
ACTIONS = "https://www.nseindia.com/api/corporates-corporateActions?index=equities&from_date={f}&to_date={t}"
QUOTE = "https://www.nseindia.com/get-quotes/equity?symbol={sym}"
OUT = RAW_DIR / "events.json"
IST = timezone(timedelta(hours=5, minutes=30))
LOOKBACK_DAYS = 3
AHEAD_DAYS = 90


def iso(d: str) -> str | None:
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%d-%B-%Y"):
        try:
            return datetime.strptime(d.strip(), fmt).date().isoformat()
        except (ValueError, AttributeError):
            pass
    return None


def parse_ban(text: str) -> dict:
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    m = re.search(r"Trade Date\s+(\S+?):?$", lines[0]) if lines else None
    symbols = [l.split(",", 1)[1].strip().upper() for l in lines[1:] if "," in l]
    return {"date": iso(m.group(1).rstrip(":")) if m else None, "symbols": symbols}


def meeting_title(purpose: str, desc: str) -> str:
    """'Financial Results/Dividend' -> 'Results · Dividend'; a bare intimation is read from its text."""
    text = f"{purpose} {desc}".lower() if purpose.lower().startswith("board meeting") else purpose.lower()
    parts = []
    for key, label in (("result", "Results"), ("dividend", "Dividend"), ("bonus", "Bonus"), ("split", "Split"),
                       ("sub-division", "Split"), ("buy back", "Buyback"), ("buyback", "Buyback"),
                       ("fund rais", "Fund raising"), ("right", "Rights"), ("merger", "Merger"),
                       ("amalgamation", "Merger"), ("scheme", "Scheme")):
        if key in text and label not in parts:
            parts.append(label)
    return " · ".join(parts) if parts else "Board meeting"


def parse_board(rows: list) -> list[dict]:
    """One event per stock and meeting date, keeping the most informative row and a readable link."""
    best: dict[tuple, dict] = {}
    for r in rows or []:
        sym, when = (r.get("bm_symbol") or "").upper(), iso(r.get("bm_date") or "")
        if not sym or not when:
            continue
        att = r.get("attachment") or ""
        link = att if att.lower().endswith(".pdf") else (r.get("ixbrl") or att or QUOTE.format(sym=sym))
        ev = {"symbol": sym, "date": when, "kind": "meeting",
              "title": meeting_title(r.get("bm_purpose") or "", r.get("bm_desc") or ""),
              "detail": " ".join((r.get("bm_desc") or "").split())[:240], "link": link}
        k = (sym, when)
        if k not in best or (best[k]["title"] == "Board meeting" and ev["title"] != "Board meeting"):
            best[k] = ev
    return list(best.values())


def action_title(subject: str) -> str:
    s = subject.lower()
    for key, label in (("dividend", "Ex-dividend"), ("bonus", "Bonus"), ("split", "Split"), ("sub-division", "Split"),
                       ("rights", "Rights"), ("buy back", "Buyback"), ("buyback", "Buyback"),
                       ("distribution", "Distribution"), ("demerger", "Demerger"), ("agm", "AGM"),
                       ("annual general", "AGM"), ("interest", "Interest payment"), ("redemption", "Redemption")):
        if key in s:
            return label
    return "Corporate action"


def parse_actions(rows: list) -> list[dict]:
    out = []
    for r in rows or []:
        sym, when = (r.get("symbol") or "").upper(), iso(r.get("exDate") or "")
        if not sym or not when:
            continue
        subject = " ".join((r.get("subject") or "").split())
        out.append({"symbol": sym, "date": when, "kind": "action", "title": action_title(subject),
                    "detail": subject[:240], "link": QUOTE.format(sym=sym)})
    return out


def main() -> int:
    today = datetime.now(IST).date()
    f, t = (today - timedelta(days=LOOKBACK_DAYS)).strftime("%d-%m-%Y"), (today + timedelta(days=AHEAD_DAYS)).strftime("%d-%m-%Y")
    prev = json.loads(OUT.read_text()) if OUT.exists() else {"sources": {}, "ban": None, "events": []}
    sources: dict = {}
    s = PoliteSession(referer=NSE_PAGE)

    try:
        ban = parse_ban(s.get(BAN_CSV).text)
        if not ban["date"]:
            raise RuntimeError("could not read the trade date")
        sources["ban"] = {"status": "ok", "fetchedAt": now_iso(), "error": None}
    except Exception as e:  # noqa: BLE001
        print(f"[events] F&O ban list failed: {e}")
        ban = prev.get("ban")
        sources["ban"] = {**prev["sources"].get("ban", {}), "status": "stale" if ban else "failed", "error": str(e)[:300]}

    try:
        s.s.headers["Accept"] = "application/json, text/plain, */*"
        s.get(NSE_PAGE)  # sets the cookies the API checks
        events = parse_board(s.get(BOARD.format(f=f, t=t)).json()) + parse_actions(s.get(ACTIONS.format(f=f, t=t)).json())
        if not events:
            raise RuntimeError("NSE returned no events")
        sources["events"] = {"status": "ok", "fetchedAt": now_iso(), "count": len(events), "error": None}
    except Exception as e:  # noqa: BLE001
        print(f"[events] corporate events failed: {e}")
        events = prev.get("events", [])
        sources["events"] = {**prev["sources"].get("events", {}), "status": "stale" if events else "failed", "error": str(e)[:300]}

    cutoff = (today - timedelta(days=LOOKBACK_DAYS)).isoformat()
    events = sorted((e for e in events if e["date"] >= cutoff), key=lambda e: (e["symbol"], e["date"]))
    OUT.write_text(json.dumps({"fetchedAt": now_iso(), "sources": sources, "ban": ban, "events": events}, indent=0) + "\n")
    print(f"[events] ban {ban and ban['date']}: {ban and ban['symbols']}; {len(events)} events from {cutoff}")
    return 0 if any(v.get("status") == "ok" for v in sources.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
