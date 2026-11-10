"""Change alerts for pinned stocks.

Each refresh takes a small snapshot of every pinned stock (multiplier per broker, ASM/GSM/ESM flags,
F&O ban, price band and series, known events) and compares it with the snapshot from the previous
refresh. Differences become alerts. A stock seen for the first time (just pinned) only sets its
baseline, so pinning never floods the feed.

State: data/alerts_state.json. Output: public/data/alerts.json (last 30 days) and
data/alerts_new.json (this run's alerts, for scripts/notify.py).
"""

from __future__ import annotations

from datetime import datetime, timedelta

BROKER_LABEL = {"kotak": "Kotak Neo", "rupeezy": "Rupeezy"}
KEEP_DAYS = 30
KEEP_MAX = 600
STAGES = ["0", "I", "II", "III", "IV", "V", "VI"]


def _r1(x: float) -> float:
    return round(x + 1e-9, 1)


def surv_label(f: dict) -> str:
    if f["list"] == "ASM":
        return f"{'ST' if f.get('term') == 'short' else 'LT'}-ASM {f['stage']}"
    return f"{f['list']} {f['stage']}"


def snapshot(sym: str, row: dict | None, brokers: list[str], surv: list[dict], ban: bool,
             band: dict | None, events: list[dict]) -> dict:
    lev = {}
    for b in brokers:
        c = (row or {}).get(b)
        lev[b] = _r1(c["lev"]) if c and c["lev"] > 1 else None
    return {
        "name": (row or {}).get("name") or sym,
        "lev": lev,
        "surv": sorted(surv_label(f) for f in surv),
        "ban": ban,
        "band": (band or {}).get("band"),
        "series": (band or {}).get("series"),
        # Events the stock has right now, keyed so a newly announced one stands out.
        "events": {f"{e['kind']}|{e['date']}|{e['title']}": {"date": e["date"], "title": e["title"], "kind": e["kind"],
                                                            "level": e.get("level"), "link": e.get("link")}
                   for e in events if e["kind"] in ("meeting", "action", "news")},
    }


def _date(iso: str) -> str:
    return datetime.fromisoformat(iso).strftime("%-d %b")


def _stage(s: str) -> int:
    return STAGES.index(s) if s in STAGES else 0


def diff(sym: str, prev: dict, cur: dict, live_brokers: set[str] | None = None) -> list[dict]:
    """Alerts for one stock. level: alert (bad), watch (worth a look), info (neutral), good."""
    out: list[dict] = []

    def add(level: str, text: str, link: str | None = None):
        out.append({"symbol": sym, "name": cur["name"], "level": level, "text": text, "link": link})

    for b, label in BROKER_LABEL.items():
        if live_brokers is not None and b not in live_brokers:
            continue  # no data from this broker this run: don't read it as "dropped"
        p, c = prev.get("lev", {}).get(b), cur["lev"].get(b)
        if p and not c:
            add("alert", f"Dropped from {label} MTF (was {p}×). Convert or close an existing position.")
        elif c and not p:
            add("good", f"Now funded by {label} at {c}×")
        elif p and c and abs(c - p) >= 0.1 - 1e-9:
            if c < p:
                add("watch", f"{label} leverage cut {p}× → {c}×: you need more margin")
            else:
                add("good", f"{label} leverage up {p}× → {c}×: you need less margin")

    before, after = set(prev.get("surv", [])), set(cur["surv"])
    # Pair a stage change on the same list (LT-ASM I -> LT-ASM II) into one alert.
    kind = lambda lbl: lbl.rsplit(" ", 1)[0]  # noqa: E731
    gone, new = sorted(before - after), sorted(after - before)
    for g in list(gone):
        match = next((n for n in new if kind(n) == kind(g)), None)
        if match:
            gone.remove(g)
            new.remove(match)
            worse = _stage(match.rsplit(" ", 1)[1]) > _stage(g.rsplit(" ", 1)[1])
            add("alert" if worse else "good", f"{kind(g)} stage {g.rsplit(' ', 1)[1]} → {match.rsplit(' ', 1)[1]}")
    for n in new:
        add("alert" if n.rsplit(" ", 1)[1] not in ("I", "0") else "watch", f"Entered {n}")
    for g in gone:
        add("good", f"Exited {g}")

    if cur["ban"] and not prev.get("ban"):
        add("alert", "Entered the F&O ban", "https://nsearchives.nseindia.com/content/fo/fo_secban.csv")
    elif prev.get("ban") and not cur["ban"]:
        add("good", "Out of the F&O ban")

    pb, cb = prev.get("band"), cur["band"]
    if pb != cb and (pb or cb):
        tighter = (cb or 100) < (pb or 100)
        add("watch" if tighter else "good", f"Price band {pb or 'none'}{'%' if pb else ''} → {cb or 'none'}{'%' if cb else ''}")
    ps, cs = prev.get("series"), cur["series"]
    if ps != cs:
        if cs in ("BE", "BZ") and ps not in ("BE", "BZ"):
            add("watch", f"Moved to trade-to-trade ({cs})")
        elif ps in ("BE", "BZ") and cs not in ("BE", "BZ"):
            add("good", "Moved out of trade-to-trade")

    for k, e in cur["events"].items():
        if k in prev.get("events", {}):
            continue
        when = _date(e["date"])
        if e["kind"] == "meeting":
            add("info", f"{e['title']} on {when} (board meeting announced)", e["link"])
        elif e["kind"] == "action":
            add("info", f"{e['title']}: ex-date {when}", e["link"])
        else:
            add("alert" if e.get("level") == "alert" else "watch", f"{e['title']} ({when})", e["link"])
    return out


def run(pins: list[str], rows: dict, brokers: list[str], surveillance: dict, events: dict,
        prev_state: dict, prev_log: list, now_iso: str, live_brokers: set[str] | None = None) -> tuple[dict, list, list]:
    """Return (new state, full alert log, alerts from this run)."""
    ban = set((events.get("ban") or {}).get("symbols") or [])
    state, fresh = {}, []
    for sym in pins:
        cur = snapshot(sym, rows.get(sym), brokers, surveillance.get(sym, []), sym in ban,
                       (events.get("bands") or {}).get(sym), (events.get("events") or {}).get(sym, []))
        state[sym] = cur
        if sym in prev_state:
            fresh += [{**a, "at": now_iso} for a in diff(sym, prev_state[sym], cur, live_brokers)]
    cutoff = (datetime.fromisoformat(now_iso.replace("Z", "+00:00")) - timedelta(days=KEEP_DAYS)).isoformat()
    log = [a for a in prev_log if a["at"].replace("Z", "+00:00") >= cutoff] + fresh
    return state, log[-KEEP_MAX:], fresh
