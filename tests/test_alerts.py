import alerts

BROKERS = ["kotak", "rupeezy"]


def snap(kotak=4.0, rupeezy=4.0, surv=(), ban=False, band=None, series="EQ", events=()):
    row = {"name": "Test Ltd", "kotak": {"lev": kotak} if kotak else None, "rupeezy": {"lev": rupeezy} if rupeezy else None}
    flags = [dict(zip(("list", "term", "stage"), f)) for f in surv]
    return alerts.snapshot("TST", row, BROKERS, flags, ban, {"band": band, "series": series}, list(events))


def texts(prev, cur, live=None):
    return [(a["level"], a["text"]) for a in alerts.diff("TST", prev, cur, live)]


def test_no_change_no_alert():
    assert texts(snap(), snap()) == []


def test_leverage_moves():
    got = texts(snap(kotak=4.27, rupeezy=4.0), snap(kotak=3.3, rupeezy=4.5))
    assert ("watch", "Kotak Neo leverage cut 4.3× → 3.3×: you need more margin") in got
    assert ("good", "Rupeezy leverage up 4.0× → 4.5×: you need less margin") in got
    # below display precision: no alert
    assert texts(snap(kotak=4.27), snap(kotak=4.26)) == []


def test_dropped_and_added():
    got = texts(snap(kotak=3.1, rupeezy=None), snap(kotak=None, rupeezy=2.5))
    assert got[0][0] == "alert" and got[0][1].startswith("Dropped from Kotak Neo MTF (was 3.1×)")
    assert ("good", "Now funded by Rupeezy at 2.5×") in got


def test_failed_broker_is_not_dropped():
    assert texts(snap(kotak=3.1), snap(kotak=None), live={"rupeezy"}) == []


def test_surveillance_enter_exit_and_stage_change():
    assert texts(snap(), snap(surv=[("ASM", "short", "I")])) == [("watch", "Entered ST-ASM I")]
    assert texts(snap(), snap(surv=[("ESM", None, "II")])) == [("alert", "Entered ESM II")]
    assert texts(snap(surv=[("GSM", None, "0")]), snap()) == [("good", "Exited GSM 0")]
    assert texts(snap(surv=[("ASM", "long", "I")]), snap(surv=[("ASM", "long", "II")])) == [("alert", "LT-ASM stage I → II")]
    assert texts(snap(surv=[("ASM", "long", "IV")]), snap(surv=[("ASM", "long", "III")])) == [("good", "LT-ASM stage IV → III")]


def test_ban_band_series():
    assert texts(snap(), snap(ban=True))[0][:1] == ("alert",)
    assert texts(snap(ban=True), snap()) == [("good", "Out of the F&O ban")]
    assert texts(snap(band=None), snap(band=5)) == [("watch", "Price band none → 5%")]
    assert texts(snap(series="EQ"), snap(series="BE")) == [("watch", "Moved to trade-to-trade (BE)")]


def test_new_events():
    meet = {"kind": "meeting", "date": "2026-11-13", "title": "Results", "link": "https://x/a.pdf"}
    news = {"kind": "news", "date": "2026-11-09", "title": "Auditor resigned", "level": "alert", "link": "https://x/b.pdf"}
    got = alerts.diff("TST", snap(), snap(events=[meet, news]))
    assert [(a["level"], a["text"], a["link"]) for a in got] == [
        ("info", "Results on 13 Nov (board meeting announced)", "https://x/a.pdf"),
        ("alert", "Auditor resigned (9 Nov)", "https://x/b.pdf"),
    ]
    # already known: no repeat
    assert alerts.diff("TST", snap(events=[meet]), snap(events=[meet])) == []


def test_run_baselines_new_pins_and_trims_log():
    rows = {"AAA": {"name": "A", "kotak": {"lev": 4.0}, "rupeezy": None}}
    state, log, fresh = alerts.run(["AAA"], rows, BROKERS, {}, {}, {}, [], "2026-11-10T10:00:00Z")
    assert fresh == [] and "AAA" in state
    rows["AAA"]["kotak"] = {"lev": 3.0}
    old = [{"at": "2026-09-01T00:00:00Z", "symbol": "OLD", "text": "x", "level": "info"}]
    state, log, fresh = alerts.run(["AAA"], rows, BROKERS, {}, {}, state, old, "2026-11-10T16:00:00Z")
    assert [a["text"] for a in fresh] == ["Kotak Neo leverage cut 4.0× → 3.0×: you need more margin"]
    assert [a["symbol"] for a in log] == ["AAA"]  # 30-day trim dropped the September entry
