"""Merge the three broker lists into public/data/*.json.

Reads   data/raw/<broker>.json (+ .error.json), data/nse/master.json, data/overrides.csv
Writes  public/data/mtf.json, meta.json, unmatched.json, history.json
        data/history/YYYY-MM-DD.json (one snapshot per IST day, overwritten on each run)
"""

from __future__ import annotations

import csv
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
HISTORY = ROOT / "data" / "history"
MASTER = ROOT / "data" / "nse" / "master.json"
OVERRIDES = ROOT / "data" / "overrides.csv"
OUT = ROOT / "public" / "data"

BROKERS = ["kotak", "paytm", "rupeezy"]
IST = timezone(timedelta(hours=5, minutes=30))
FUZZY_MIN = 92
STALE_AFTER = timedelta(hours=26)
HISTORY_KEEP_DAYS = 90
HISTORY_PUBLISH = 7

_STOP = re.compile(r"\b(ltd|limited|the|co|company|corp|corporation|inc)\b")


def normalise(name: str) -> str:
    s = (name or "").lower().replace("&", " and ")
    s = re.sub(r"[.,'()\-/]", " ", s)
    s = _STOP.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


def parse_ts(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


class Matcher:
    """Resolve a broker row to an NSE symbol: overrides, ISIN, broker symbol, exact name, fuzzy name."""

    def __init__(self, master: list[dict], overrides: list[dict]):
        self.by_symbol = {m["symbol"]: m for m in master}
        self.by_isin = {m["isin"]: m["symbol"] for m in master if m.get("isin")}
        self.by_name: dict[str, str] = {}
        for m in master:
            self.by_name.setdefault(normalise(m["name"]), m["symbol"])
        self.names = list(self.by_name)
        self.overrides = {}
        for o in overrides:
            key = ((o.get("broker") or "").strip().lower(), normalise(o.get("name", "")))
            self.overrides[key] = (o.get("symbol") or "").strip().upper()

    def resolve(self, broker: str, row: dict) -> tuple[str | None, str]:
        n = normalise(row.get("name", ""))
        for key in ((broker, n), ("", n)):
            if key in self.overrides:
                return self.overrides[key] or None, "override"
        isin = row.get("isin")
        if isin and isin in self.by_isin:
            return self.by_isin[isin], "isin"
        sym = row.get("symbol")
        if sym and row.get("exchange", "NSE") == "NSE":
            return sym, "symbol"
        if n in self.by_name:
            return self.by_name[n], "name"
        if self.names and n:
            try:
                from rapidfuzz import fuzz, process
            except ImportError:
                return None, "unmatched"
            hit = process.extractOne(n, self.names, scorer=fuzz.token_sort_ratio, score_cutoff=FUZZY_MIN)
            if hit:
                return self.by_name[hit[0]], "fuzzy"
        return None, "unmatched"


def broker_status(broker: str, raw: dict | None, now: datetime) -> dict:
    err = load_json(RAW / f"{broker}.error.json", None)
    fetched = parse_ts(raw.get("fetchedAt")) if raw else None
    info = {"fetchedAt": raw.get("fetchedAt") if raw else None, "count": raw.get("count", 0) if raw else 0,
            "status": "ok", "error": None}
    if not raw:
        info.update(status="failed", error=(err or {}).get("error") or "no data yet")
    elif err and (parse_ts(err.get("attemptedAt")) or now) >= fetched:
        info.update(status="stale", error=err.get("error"))
    elif now - fetched > STALE_AFTER:
        info.update(status="stale", error="last successful fetch is over a day old")
    return info


def cell(broker: str, row: dict) -> dict:
    c = {"lev": row["lev"]}
    if broker == "kotak":
        c["maxExposureCr"] = row.get("maxExposureCr")
    else:
        c["ownPct"] = row.get("ownPct")
    return c


def funded(c: dict | None) -> bool:
    return bool(c) and c["lev"] > 1


def previous_snapshot(today: str) -> dict:
    files = sorted(p for p in HISTORY.glob("*.json") if p.stem < today)
    return load_json(files[-1], {}) if files else {}


def main() -> None:
    now = datetime.now(timezone.utc).replace(microsecond=0)
    today = now.astimezone(IST).date().isoformat()

    master = load_json(MASTER, [])
    overrides = []
    if OVERRIDES.exists():
        with OVERRIDES.open(newline="") as f:
            overrides = [r for r in csv.DictReader(f) if not (r.get("broker") or "").startswith("#")]
    matcher = Matcher(master, overrides)

    stocks: dict[str, dict] = {}
    unmatched: list[dict] = []
    meta_brokers = {}

    for b in BROKERS:
        raw = load_json(RAW / f"{b}.json", None)
        meta_brokers[b] = broker_status(b, raw, now)
        matched = 0
        for row in (raw or {}).get("rows", []):
            sym, how = matcher.resolve(b, row)
            if not sym:
                unmatched.append({"broker": b, "name": row.get("name"), "symbol": row.get("symbol"),
                                  "isin": row.get("isin"), "exchange": row.get("exchange"), "lev": row["lev"]})
                continue
            matched += 1
            m = matcher.by_symbol.get(sym, {})
            # NSE's ETF list names the underlying index ("Nifty 50"), so ETFs take the broker's name.
            nse_name = m.get("name") if m.get("type") == "equity" else None
            s = stocks.setdefault(sym, {"symbol": sym, "name": nse_name or row.get("name") or sym,
                                        "type": m.get("type") or row.get("type") or "equity",
                                        "kotak": None, "paytm": None, "rupeezy": None})
            # NSE has the best equity names, then Kotak; Rupeezy has the best ETF names.
            preferred = "rupeezy" if s["type"] == "etf" else None if nse_name else "kotak"
            if b == preferred and row.get("name"):
                s["name"] = row["name"]
            if s[b] is None or row["lev"] > s[b]["lev"]:
                s[b] = cell(b, row)
        meta_brokers[b]["matched"] = matched

    prev = previous_snapshot(today)
    snapshot = {}
    for s in stocks.values():
        if "etf" in s["name"].lower() or "bees" in s["symbol"].lower():
            s["type"] = "etf"
        top = max((s[b]["lev"] for b in BROKERS if funded(s[b])), default=None)
        s["best"] = [b for b in BROKERS if funded(s[b]) and top - s[b]["lev"] < 0.005] if top else []
        s["bestLev"] = top
        levs = [s[b]["lev"] if s[b] else None for b in BROKERS]
        snapshot[s["symbol"]] = levs
        p = prev.get(s["symbol"])
        s["change"] = {b: (round(levs[i] - p[i], 2) if p and p[i] is not None and levs[i] is not None else 0)
                       for i, b in enumerate(BROKERS)}

    rows = sorted(stocks.values(), key=lambda s: s["symbol"])

    # Daily history: today's snapshot, prune old files, publish the last 7 days.
    HISTORY.mkdir(parents=True, exist_ok=True)
    (HISTORY / f"{today}.json").write_text(json.dumps(snapshot, separators=(",", ":"), sort_keys=True) + "\n")
    files = sorted(HISTORY.glob("*.json"))
    cutoff = (now.astimezone(IST).date() - timedelta(days=HISTORY_KEEP_DAYS)).isoformat()
    for p in files:
        if p.stem < cutoff:
            p.unlink()
    recent = [p for p in files if p.stem >= cutoff][-HISTORY_PUBLISH:]
    snaps = [load_json(p, {}) for p in recent]
    history = {"brokers": BROKERS, "dates": [p.stem for p in recent],
               "rows": {sym: [sn.get(sym) for sn in snaps] for sym in snapshot}}

    meta = {
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "brokers": meta_brokers,
        "total": len(rows),
        "unmatched": len(unmatched),
    }

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "mtf.json").write_text(json.dumps(rows, separators=(",", ":"), ensure_ascii=False) + "\n")
    (OUT / "unmatched.json").write_text(json.dumps(unmatched, indent=1, ensure_ascii=False) + "\n")
    (OUT / "history.json").write_text(json.dumps(history, separators=(",", ":")) + "\n")
    (OUT / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    # Every NSE symbol, so the site can pin a stock no broker funds yet.
    listed = sorted({m["symbol"]: m["name"] for m in master}.items())
    (OUT / "symbols.json").write_text(json.dumps(listed, separators=(",", ":"), ensure_ascii=False) + "\n")

    print(f"merged {len(rows)} stocks, {len(unmatched)} unmatched")
    for b, info in meta_brokers.items():
        print(f"  {b:8} {info['status']:6} rows={info['count']:5} matched={info['matched']:5} {info['error'] or ''}")


if __name__ == "__main__":
    main()
