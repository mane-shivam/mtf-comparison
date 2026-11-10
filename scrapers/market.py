"""Market data that matters for an open MTF position.

- Prices for pinned stocks: Yahoo Finance daily chart (<SYMBOL>.NS): last price, previous close, day
  range, 52-week range, volume and 20-day average volume, last 30 closes. NSE's own quote API refuses
  servers, so Yahoo is used for prices only.
- Exchange margin per stock: NSE C_VAR1 file (VaR + extreme loss + ad hoc = applicable margin %).
  Brokers set MTF leverage from it, so a rise usually comes before a broker cut.
- F&O open interest vs market-wide limit (MWPL %): NSE combineoi file; 95% means the F&O ban.
- Delivery %: NSE bhavcopy (sec_bhavdata_full), kept as a rolling 30-session history for pinned stocks.
- Bulk and block deals: NSE bulk.csv / block.csv, kept for 7 days.
- Promoter pledge: NSE corporate-pledgedata (by company name; merge.py maps it to symbols).

Writes data/raw/market.json and data/market_hist.json. Each part that fails keeps its previous data.
"""

from __future__ import annotations

import csv
import io
import json
import sys
import zipfile
from datetime import date, datetime, timedelta, timezone
from urllib.parse import quote

if __package__ in (None, ""):
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from scrapers.common import RAW_DIR, ROOT, PoliteSession, now_iso

IST = timezone(timedelta(hours=5, minutes=30))
OUT = RAW_DIR / "market.json"
HIST = ROOT / "data" / "market_hist.json"
PINS = ROOT / "data" / "pins.json"

YAHOO = "https://query{n}.finance.yahoo.com/v8/finance/chart/{sym}.NS?range=3mo&interval=1d"
VAR = "https://nsearchives.nseindia.com/archives/nsccl/var/C_VAR1_{d}_{v}.DAT"
MWPL = "https://nsearchives.nseindia.com/archives/nsccl/mwpl/combineoi_{d}.zip"
BHAV = "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{d}.csv"
BULK = "https://nsearchives.nseindia.com/content/equities/bulk.csv"
BLOCK = "https://nsearchives.nseindia.com/content/equities/block.csv"
PLEDGE = "https://www.nseindia.com/api/corporate-pledgedata?index=equities"
PLEDGE_PAGE = "https://www.nseindia.com/companies-listing/corporate-filings-pledged-data"
LOOKBACK = 6  # days to search back for the latest daily file
HIST_SESSIONS = 30
DEAL_DAYS = 7


def num(v) -> float | None:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def parse_yahoo(payload: dict) -> dict | None:
    res = (payload.get("chart") or {}).get("result") or []
    if not res:
        return None
    r = res[0]
    m = r.get("meta") or {}
    q = ((r.get("indicators") or {}).get("quote") or [{}])[0]
    days = [datetime.fromtimestamp(t, IST).date().isoformat() for t in r.get("timestamp") or []]
    bars = [(d, c, v) for d, c, v in zip(days, q.get("close") or [], q.get("volume") or []) if c is not None]
    price = m.get("regularMarketPrice")
    if not bars or price is None:
        return None
    last_day = datetime.fromtimestamp(m.get("regularMarketTime") or 0, IST).date().isoformat()
    past = [b for b in bars if b[0] < last_day]  # completed sessions before the latest one
    prev = past[-1][1] if past else None
    vols = [v for _, _, v in past[-20:] if v]
    return {
        "p": round(price, 2),
        "prev": round(prev, 2) if prev else None,
        "chg": round((price / prev - 1) * 100, 2) if prev else None,
        "dayHi": m.get("regularMarketDayHigh"),
        "dayLo": m.get("regularMarketDayLow"),
        "hi52": m.get("fiftyTwoWeekHigh"),
        "lo52": m.get("fiftyTwoWeekLow"),
        "vol": m.get("regularMarketVolume"),
        "avgVol": round(sum(vols) / len(vols)) if vols else None,
        "date": last_day,
        "t": m.get("regularMarketTime"),
        "closes": [[d, round(c, 2)] for d, c, _ in bars[-30:]],
    }


def parse_var(text: str) -> dict:
    """{symbol: {m: applicable margin %, adhoc: %}} from a C_VAR1 file (EQ preferred over BE/BZ)."""
    out = {}
    for line in text.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 10 or f[0] != "20":
            continue
        sym, series = f[1].upper(), f[2]
        if series not in ("EQ", "BE", "BZ") or (sym in out and out[sym]["series"] == "EQ"):
            continue
        out[sym] = {"m": num(f[9]), "adhoc": num(f[8]), "series": series}
    return {k: {"m": v["m"], "adhoc": v["adhoc"]} for k, v in out.items()}


def parse_mwpl(csv_text: str) -> dict:
    """{symbol: {pct, ban}}: futures-equivalent OI as % of the market-wide position limit."""
    out = {}
    for r in csv.DictReader(io.StringIO(csv_text)):
        r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
        sym, mwpl, fut = r.get("NSE Symbol", "").upper(), num(r.get("MWPL")), num(r.get("Future Equivalent Open Interest"))
        if sym and mwpl:
            out[sym] = {"pct": round(fut / mwpl * 100, 1) if fut is not None else None,
                        "ban": "no fresh" in r.get("Limit for Next Day", "").lower()}
    return out


def parse_bhav(text: str, symbols: set[str]) -> dict:
    """{symbol: [delivery %, traded qty]} for EQ rows of the given symbols."""
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
        sym = r.get("SYMBOL", "").upper()
        if sym in symbols and r.get("SERIES") in ("EQ", "BE", "BZ"):
            out[sym] = [num(r.get("DELIV_PER")), num(r.get("TTL_TRD_QNTY"))]
    return out


def parse_deals(text: str, kind: str) -> list[dict]:
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
        try:
            d = datetime.strptime(r.get("Date", ""), "%d-%b-%Y").date().isoformat()
        except ValueError:
            continue
        sym = r.get("Symbol", "").upper()
        if sym:
            out.append({"symbol": sym, "date": d, "kind": kind, "client": r.get("Client Name", ""),
                        "side": r.get("Buy/Sell", "").upper(), "qty": num(r.get("Quantity Traded")),
                        "price": num(r.get("Trade Price / Wght. Avg. Price"))})
    return out


def parse_pledge(payload: dict) -> list[dict]:
    out = []
    for r in (payload or {}).get("data") or []:
        pct = num(r.get("percPromoterShares"))
        if r.get("comName") and pct is not None:
            out.append({"name": r["comName"].strip(), "pct": pct, "promoter": num(r.get("percPromoterHolding")),
                        "asOf": (r.get("broadcastDt") or "")[:11]})
    return out


def latest(s: PoliteSession, url_for, today: date):
    """Fetch the newest daily file that exists within LOOKBACK days: (date, response)."""
    for back in range(LOOKBACK + 1):
        d = today - timedelta(days=back)
        for url in url_for(d.strftime("%d%m%Y")):
            try:
                r = s.s.get(url, timeout=30)
                if r.status_code == 200 and len(r.content) > 200:
                    return d.isoformat(), r
            except Exception:  # noqa: BLE001
                pass
    raise RuntimeError("no file in the last %d days" % LOOKBACK)


def main() -> int:
    today = datetime.now(IST).date()
    prev = json.loads(OUT.read_text()) if OUT.exists() else {}
    hist = json.loads(HIST.read_text()) if HIST.exists() else {"bhavTried": {}, "deliv": {}, "deals": []}
    pins = (json.loads(PINS.read_text()) if PINS.exists() else {}).get("pins", [])
    sources, out = {}, {}

    def part(name, fn, fallback):
        try:
            out[name] = fn()
            sources[name] = {"status": "ok", "fetchedAt": now_iso(), "error": None}
        except Exception as e:  # noqa: BLE001
            print(f"[market] {name} failed: {e}")
            out[name] = prev.get(name, fallback)
            sources[name] = {**(prev.get("sources") or {}).get(name, {}), "status": "stale" if out[name] else "failed",
                             "error": str(e)[:300]}

    ys = PoliteSession(referer="https://finance.yahoo.com/")

    def prices():
        got = {}
        for i, sym in enumerate(pins):
            try:
                r = ys.get(YAHOO.format(n=1 + i % 2, sym=quote(sym, safe="")))
                p = parse_yahoo(r.json())
                if p:
                    got[sym] = p
            except Exception as e:  # noqa: BLE001 - one missing stock shouldn't fail the rest
                print(f"[market] price {sym}: {e}")
        if pins and len(got) < len(pins) * 0.5:
            raise RuntimeError(f"prices for only {len(got)} of {len(pins)} pins")
        return got

    ns = PoliteSession(referer="https://www.nseindia.com/")

    def var():
        d, r = latest(ns, lambda d: [VAR.format(d=d, v=v) for v in (6, 5, 4, 3, 2, 1)], today)
        return {"date": d, "rows": parse_var(r.text)}

    def mwpl():
        d, r = latest(ns, lambda d: [MWPL.format(d=d)], today)
        z = zipfile.ZipFile(io.BytesIO(r.content))
        name = next(n for n in z.namelist() if n.lower().endswith(".csv"))
        return {"date": d, "rows": parse_mwpl(z.read(name).decode("utf-8", "replace"))}

    def deliv():
        # Fill the rolling per-stock history with any session file not fetched yet.
        syms = set(pins)
        for back in range(HIST_SESSIONS + 15):
            d = today - timedelta(days=back)
            key = d.isoformat()
            if key in hist["bhavTried"] or d.weekday() >= 5:
                continue
            r = ns.s.get(BHAV.format(d=d.strftime("%d%m%Y")), timeout=30)
            if r.status_code == 200 and len(r.content) > 1000:
                for sym, row in parse_bhav(r.text, syms).items():
                    hist["deliv"].setdefault(sym, {})[key] = row
                hist["bhavTried"][key] = "ok"
            elif back > 1:  # today's or yesterday's file may still appear later
                hist["bhavTried"][key] = "missing"
        keep = (today - timedelta(days=HIST_SESSIONS * 2)).isoformat()
        hist["bhavTried"] = {k: v for k, v in hist["bhavTried"].items() if k >= keep}
        hist["deliv"] = {s: {d: v for d, v in sorted(days.items())[-HIST_SESSIONS:]}
                         for s, days in hist["deliv"].items() if s in syms}
        return {s: hist["deliv"][s] for s in syms if s in hist["deliv"]}

    def deals():
        new = parse_deals(ns.get(BULK).text, "bulk") + parse_deals(ns.get(BLOCK).text, "block")
        cutoff = (today - timedelta(days=DEAL_DAYS)).isoformat()
        seen, keep = set(), []
        for d in new + hist.get("deals", []):
            k = (d["symbol"], d["date"], d["kind"], d["client"], d["side"], d["qty"])
            if d["date"] >= cutoff and k not in seen:
                seen.add(k)
                keep.append(d)
        hist["deals"] = keep
        return keep

    def pledge():
        s = PoliteSession(referer=PLEDGE_PAGE)
        s.s.headers["Accept"] = "application/json, text/plain, */*"
        s.get(PLEDGE_PAGE)
        rows = parse_pledge(s.get(PLEDGE).json())
        if len(rows) < 100:
            raise RuntimeError(f"only {len(rows)} pledge rows")
        return rows

    part("prices", prices, {})
    part("var", var, {})
    part("mwpl", mwpl, {})
    part("deliv", deliv, {})
    part("deals", deals, [])
    part("pledge", pledge, [])

    HIST.write_text(json.dumps(hist, separators=(",", ":")) + "\n")
    OUT.write_text(json.dumps({"fetchedAt": now_iso(), "sources": sources, **out}, separators=(",", ":")) + "\n")
    print("[market] " + ", ".join(f"{k}: {v['status']}" for k, v in sources.items())
          + f"; prices {len(out['prices'])}/{len(pins)}")
    return 0 if any(v["status"] == "ok" for v in sources.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
