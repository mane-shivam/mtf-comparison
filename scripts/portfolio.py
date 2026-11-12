"""Private portfolio checks and the morning summary.

Positions are synced from the site as data/positions.enc.json, encrypted in the browser (AES-GCM-256,
key from the passphrase via PBKDF2-SHA256). With the same passphrase in the POSITIONS_PASSPHRASE
repository secret, this script decrypts them in the Actions runner and:

- warns when a position is at or within 3% of its margin top-up price, once a day per position;
- once a day, at the first run from 08:00 IST, builds a morning summary: portfolio P&L and interest,
  results due in the next 7 days for pinned stocks, and the last day's serious alerts.

Nothing readable about the positions is committed. Warnings and the summary go to gitignored files
(data/private_alerts.json, data/summary.json) that scripts/notify.py sends. The only committed state is
data/portfolio_seen.json: the summary date and keyed hashes of the warnings already sent, which reveal
nothing without the passphrase.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENC = ROOT / "data" / "positions.enc.json"
BROKER = ROOT / "data" / "broker.enc.json"
SEEN = ROOT / "data" / "portfolio_seen.json"
PRIVATE = ROOT / "data" / "private_alerts.json"
SUMMARY = ROOT / "data" / "summary.json"
PUB = ROOT / "public" / "data"
IST = timezone(timedelta(hours=5, minutes=30))
CALL_WARN = 3.0  # % above the top-up price that counts as close (same as the site)
SUMMARY_HOUR = 8
LABEL = {"kotak": "Kotak Neo", "rupeezy": "Rupeezy"}
SHORT = {"kotak": "Kotak", "rupeezy": "Rupeezy"}
DEFAULT_INTEREST = {"kotak": 9.69, "rupeezy": 10.99}  # % a year; the site's defaults


def decrypt(passphrase: str, f: dict) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    b = lambda s: base64.b64decode(s)  # noqa: E731
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b(f["salt"]), iterations=int(f["iter"])).derive(
        passphrase.encode())
    return json.loads(AESGCM(key).decrypt(b(f["iv"]), b(f["data"]), None))


def rupees(x: float, signed: bool = False) -> str:
    s = f"₹{abs(x):,.0f}"
    if signed:
        return ("+" if x >= 0 else "−") + s
    return ("−" if x < 0 else "") + s


def metrics(pos: dict, px: dict | None, rates: dict, today: date) -> dict:
    lev = max(1.0, float(pos["lev"]))
    buy = pos["qty"] * pos["price"]
    funded = buy - buy / lev
    rate = float((rates.get(pos["broker"]) or {}).get("interest", DEFAULT_INTEREST.get(pos["broker"], 10)))
    days = max(0, (today - date.fromisoformat(pos["date"])).days)
    interest = funded * rate * days / 36500
    # Cash actually put in: a lot bought with spare margin (e.g. unrealised gains) has less than its margin.
    cash = min(buy / lev, max(0.0, float(pos["cash"]))) if pos.get("cash") is not None else buy / lev
    m = {"buy": buy, "own": cash, "debt": buy - cash, "funded": funded, "interest": interest, "perDay": funded * rate / 36500,
         "ltp": None, "value": None, "gross": None, "day": None, "call": None, "dist": None}
    if lev > 1:
        m["call"] = (funded + interest) / (pos["qty"] * (1 - 1 / lev))
    if not px or not px.get("p"):
        return m
    p = px["p"]
    m.update(ltp=p, value=pos["qty"] * p, gross=pos["qty"] * p - m["buy"])
    base = pos["price"] if pos["date"] >= (px.get("date") or "") else px.get("prev")
    if base:
        m["day"] = pos["qty"] * (p - base)
    if m["call"]:
        m["dist"] = (p / m["call"] - 1) * 100
    return m


def margin_pct(pos: dict, mtf: dict | None) -> float:
    """The broker's margin for this stock today (% of value), from public/data/mtf.json; 100 if no longer funded."""
    if mtf is None:
        return 100 / max(1.0, float(pos["lev"]))
    c = (mtf.get(pos["sym"]) or {}).get(pos["broker"])
    if not c or c.get("lev", 0) <= 1:
        return 100.0
    return float(c.get("ownPct") or 100 / c["lev"])


def broker_avail(snapshot: dict | None, now: datetime) -> dict:
    """Each broker's own free-margin figure from data/broker.enc.json (Kotak's net limit, Rupeezy's net
    available funds), if read in the last 26 hours. Same rule as the site."""
    out: dict = {}
    for b, x in ((snapshot or {}).get("brokers") or {}).items():
        raw = (x or {}).get("raw") or {}
        part = "limits" if b == "kotak" else "funds"
        if not x.get("at") or ((raw.get("_errors") or {}).get(part) and not (raw.get("_stale") or {}).get(part)):
            continue
        at = (raw.get("_stale") or {}).get(part) or x["at"]
        try:
            age = now - datetime.fromisoformat(str(at).replace("Z", "+00:00"))
            v = float(raw["limits"]["Net"]) if b == "kotak" else float(
                (raw["funds"].get("nse") or raw["funds"].get("exchange_combined"))["net_available"])
        except (KeyError, TypeError, ValueError, AttributeError):
            continue
        if age < timedelta(hours=26):
            out[b] = v
    return out


def accounts(positions: list[dict], prices: dict, rates: dict, today: date, mtf: dict | None = None,
             reported: dict | None = None) -> list[dict]:
    """Margin per broker account, as brokers check it: a gain on one stock covers a loss on another.

    needed = sum(value x the broker's margin % for that stock today), equity = sum(value - broker's money - interest), spare = equity - needed,
    fall = % every holding can drop together before spare reaches zero (same as the site).
    When the broker reports its own free margin, that is the spare (it counts charges, interest and
    withdrawals taken from cash, idle cash, and its exact margin per stock); equity follows from it.
    """
    out = []
    for broker in LABEL:
        value = needed = equity = 0.0
        n = 0
        for pos in positions:
            if pos["broker"] != broker:
                continue
            m = metrics(pos, prices.get(pos["sym"]), rates, today)
            lev = max(1.0, float(pos["lev"]))
            if m["value"] is None or lev <= 1:
                continue
            n += 1
            value += m["value"]
            needed += m["value"] * margin_pct(pos, mtf) / 100
            equity += m["value"] - m["debt"] - m["interest"]  # cash in + unrealised P&L - interest
        if not n:
            continue
        if reported and broker in reported:
            equity = needed + reported[broker]
        spare, sens = equity - needed, value - needed
        out.append({"broker": broker, "n": n, "needed": needed, "equity": equity, "spare": spare,
                    "fall": spare / sens * 100 if sens > 0 else None})
    return out


def warnings(positions: list[dict], prices: dict, rates: dict, today: date, mtf: dict | None = None,
             reported: dict | None = None) -> list[dict]:
    out = []
    for a in accounts(positions, prices, rates, today, mtf, reported):
        label = SHORT[a["broker"]]
        if a["spare"] < 0:
            level, text = "alert", f"{rupees(-a['spare'])} short"
        elif a["fall"] is not None and a["fall"] <= CALL_WARN:
            level, text = "watch", f"{a['fall']:.1f}% from a top-up ({rupees(a['spare'])} spare)"
        else:
            continue
        out.append({"id": a["broker"], "symbol": label, "name": label, "level": level, "text": text, "link": None})
    return out


def tag(passphrase: str, *parts: str) -> str:
    return hmac.new(passphrase.encode(), "|".join(parts).encode(), hashlib.sha256).hexdigest()[:20]


def results_due(pins: list[str], events: dict, today: date, days: int = 7) -> list[str]:
    end = (today + timedelta(days=days)).isoformat()
    out = []
    for sym in pins:
        for e in events.get(sym, []):
            if e["kind"] == "meeting" and "Results" in e["title"] and today.isoformat() <= e["date"] <= end:
                out.append((e["date"], sym))
                break
    return [f"{sym} {datetime.fromisoformat(d).strftime('%a')}" for d, sym in sorted(out)]


def summary(payload: dict | None, prices: dict, pins: list[str], events: dict, alerts: list[dict],
            now: datetime, held: dict[str, set[str]], mtf: dict | None = None, reported: dict | None = None) -> dict:
    today = now.date()
    lines: list[str] = []
    if payload is not None:
        pos = payload.get("positions") or []
        ms = [(p, metrics(p, prices.get(p["sym"]), payload.get("rates") or {}, today)) for p in pos]
        priced = [(p, m) for p, m in ms if m["value"] is not None]
        if pos:
            own = sum(m["own"] for _, m in ms)
            gross = sum(m["gross"] for _, m in priced)
            day = sum(m["day"] or 0 for _, m in priced)
            invest = sum(m["buy"] for _, m in priced)
            pct = gross / invest * 100 if invest else 0
            lines.append(f"P&L {rupees(gross, True)} ({pct:+.1f}%), last session {rupees(day, True)}")
            lines.append(f"Interest {rupees(sum(m['perDay'] for _, m in ms))}/day")
            margin = [f"{SHORT[a['broker']]} {rupees(-a['spare'])} short" if a["spare"] < 0
                      else f"{SHORT[a['broker']]} {a['fall'] or 0:.1f}% headroom"
                      for a in accounts(pos, prices, payload.get("rates") or {}, today, mtf, reported)]
            if margin:
                lines.append("Margin: " + ", ".join(margin))
            movers = sorted(priced, key=lambda x: x[1]["day"] or 0)
            if len(movers) >= 2:
                lo, hi = movers[0], movers[-1]
                lines.append(f"Movers: {hi[0]['sym']} {rupees(hi[1]['day'] or 0, True)}, "
                             f"{lo[0]['sym']} {rupees(lo[1]['day'] or 0, True)}")
        booked = float(payload.get("start") or 0) + sum(c["pnl"] for c in payload.get("closed") or [])
        if booked:
            lines.append(f"Booked {rupees(booked, True)}")
    due = results_due(pins, events, today)
    if due:
        lines.append("Results: " + ", ".join(due))
    since = (now - timedelta(hours=24)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    recent = [a for a in alerts if a["at"] >= since and a["level"] in ("alert", "watch")]
    if recent:
        mine = [a for a in recent if is_mine(a, held)]
        serious = [a for a in recent if a["level"] == "alert"]
        lines.append(f"24h: {len(recent)} flag{'s' if len(recent) != 1 else ''}" + (f", {len(mine)} held" if held else ""))
        for a in sorted(serious, key=lambda a: not is_mine(a, held))[:3]:
            lines.append(f"🔴 {a['symbol']}: {a['text']}")
    if not lines:
        lines.append("Nothing new on your watchlist")
    return {"title": f"Morning summary, {today.strftime('%a %-d %b')}", "lines": lines}


def is_mine(alert: dict, held: dict[str, set[str]]) -> bool:
    """An alert about a stock you hold; one about a single broker (a Rupeezy leverage cut) only if you hold
    the stock at that broker. Same rule as the site."""
    at = held.get(alert["symbol"])
    if not at:
        return False
    about = [b for b, name in SHORT.items() if re.search(rf"\b{name}\b", alert["text"], re.I)]
    return not about or any(b in at for b in about)


def load_json(p: Path, default):
    try:
        return json.loads(p.read_text())
    except (OSError, ValueError):
        return default


def main(now: datetime | None = None) -> int:
    now = (now or datetime.now(timezone.utc)).astimezone(IST)
    today = now.date()
    for p in (PRIVATE, SUMMARY):
        p.unlink(missing_ok=True)
    seen = load_json(SEEN, {"summary": None, "sent": []})
    passphrase = os.environ.get("POSITIONS_PASSPHRASE", "").strip()
    market = load_json(PUB / "market.json", {})
    prices = market.get("prices") or {}
    rows = load_json(PUB / "mtf.json", None)
    mtf = {r["symbol"]: r for r in rows} if isinstance(rows, list) else None

    payload = None
    reported: dict = {}
    if passphrase and BROKER.exists():
        try:
            reported = broker_avail(decrypt(passphrase, json.loads(BROKER.read_text())), now)
        except Exception as e:  # noqa: BLE001
            print(f"[portfolio] broker figures unavailable: {type(e).__name__}")
    if passphrase and ENC.exists():
        try:
            payload = decrypt(passphrase, json.loads(ENC.read_text()))
        except Exception as e:  # noqa: BLE001
            print(f"[portfolio] could not decrypt positions (wrong passphrase?): {type(e).__name__}")
    elif not passphrase:
        print("[portfolio] POSITIONS_PASSPHRASE not set: no top-up warnings")

    if payload is not None:
        fresh, sent = [], set(seen.get("sent") or [])
        day = today.isoformat()
        for w in warnings(payload.get("positions") or [], prices, payload.get("rates") or {}, today, mtf, reported):
            k = tag(passphrase, day, w.pop("id"), w["level"])
            if k not in sent:
                fresh.append(w)
                sent.add(k)
        if fresh:
            PRIVATE.write_text(json.dumps(fresh, ensure_ascii=False, indent=1) + "\n")
        # Only today's tags matter; older ones can't repeat.
        seen["sent"] = [k for k in sent if k in {tag(passphrase, day, b, lv) for b in LABEL for lv in ("alert", "watch")}]
        print(f"[portfolio] {len(payload.get('positions') or [])} positions, {len(fresh)} new top-up warnings")

    if now.hour >= SUMMARY_HOUR and seen.get("summary") != today.isoformat():
        pins = load_json(ROOT / "data" / "pins.json", {}).get("pins") or []
        events = load_json(PUB / "events.json", {}).get("events") or {}
        alerts = load_json(PUB / "alerts.json", [])
        held: dict[str, set[str]] = {}
        for p in (payload or {}).get("positions") or []:
            held.setdefault(p["sym"], set()).add(p["broker"])
        SUMMARY.write_text(json.dumps(summary(payload, prices, pins, events, alerts, now, held, mtf, reported), ensure_ascii=False,
                                      indent=1) + "\n")
        seen["summary"] = today.isoformat()
        print("[portfolio] morning summary ready")

    SEEN.write_text(json.dumps(seen, indent=1) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
