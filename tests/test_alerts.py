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
    state, log, fresh = alerts.run(["AAA"], rows, BROKERS, {}, {}, {}, {}, [], "2026-11-10T10:00:00Z")
    assert fresh == [] and "AAA" in state
    rows["AAA"]["kotak"] = {"lev": 3.0}
    old = [{"at": "2026-09-01T00:00:00Z", "symbol": "OLD", "text": "x", "level": "info"}]
    state, log, fresh = alerts.run(["AAA"], rows, BROKERS, {}, {}, {}, state, old, "2026-11-10T16:00:00Z")
    assert [a["text"] for a in fresh] == ["Kotak Neo leverage cut 4.0× → 3.0×: you need more margin"]
    assert [a["symbol"] for a in log] == ["AAA"]  # 30-day trim dropped the September entry


def msnap(**m):
    return alerts.snapshot("TST", {"name": "T", "kotak": {"lev": 4.0, "maxExposureCr": m.pop("exp", 50.0)}, "rupeezy": None},
                           BROKERS, [], False, {"band": m.pop("band", None), "series": "EQ"}, [], m)


def mtexts(prev, cur):
    return [(a["level"], a["text"]) for a in alerts.diff("TST", prev, cur)]


def test_exchange_margin_mwpl_exposure_pledge():
    v = lambda x: {"var": {"rows": {"TST": {"m": x}}}}  # noqa: E731
    assert mtexts(msnap(**v(16.3)), msnap(**v(25.0))) == [("watch", "Exchange margin 16% → 25%: a broker leverage cut may follow")]
    assert mtexts(msnap(**v(45)), msnap(**v(55)))[0][0] == "alert"
    o = lambda x: {"mwpl": {"rows": {"TST": {"pct": x}}}}  # noqa: E731
    assert mtexts(msnap(**o(70)), msnap(**o(84.5))) == [("watch", "F&O open interest at 84% of the limit (ban at 95%)")]
    assert mtexts(msnap(**o(84)), msnap(**o(91)))[0][0] == "alert"
    assert mtexts(msnap(**o(85)), msnap(**o(60)))[0][0] == "good"
    assert mtexts(msnap(exp=50.0), msnap(exp=25.0)) == [("watch", "Kotak Neo max MTF exposure ₹50 Cr → ₹25 Cr")]
    pl = lambda x: {"pledge": {"TST": {"pct": x}}}  # noqa: E731
    assert mtexts(msnap(**pl(0)), msnap(**pl(4.5))) == [("alert", "Promoters pledged 4.5% of their shares")]


def test_deals_and_day_flags_once_per_day():
    deal = {"deals": {"TST": [{"date": "2026-11-09", "kind": "bulk", "client": "X LLP", "side": "SELL", "qty": 100000.0, "price": 94.27}]}}
    assert mtexts(msnap(), msnap(**deal)) == [("watch", "Bulk deal: X LLP sold 100,000 shares at ₹94.27")]
    px = lambda chg, date="2026-11-10": {"prices": {"TST": {"p": 95.0, "prev": 100.0, "chg": chg, "lo52": 50, "hi52": 200,  # noqa: E731
                                                            "vol": 10, "avgVol": 10, "date": date}}}
    first = mtexts(msnap(**px(-5.0)), msnap(**px(-6.0)))
    assert first == []  # already flagged earlier the same day
    assert mtexts(msnap(**px(-1.0)), msnap(**px(-6.0))) == [("watch", "Down 6.0% today at ₹95.00")]
    assert mtexts(msnap(**px(-6.0, "2026-11-09")), msnap(**px(-6.0))) == [("watch", "Down 6.0% today at ₹95.00")]
    circ = {"prices": {"TST": {"p": 95.2, "prev": 100.0, "chg": -4.8, "date": "2026-11-10"}}, "band": 5}
    assert ("alert", "At or near the lower circuit (5% band): selling may not fill") in mtexts(msnap(), msnap(**circ))


def test_old_snapshot_format_is_only_a_baseline():
    rows = {"AAA": {"name": "A", "kotak": {"lev": 3.0}, "rupeezy": None}}
    old_state = {"AAA": {"name": "A", "lev": {"kotak": 4.0, "rupeezy": None}, "surv": [], "ban": False,
                         "band": None, "series": "EQ", "events": {}}}
    market = {"deals": {"AAA": [{"date": "2026-11-09", "kind": "bulk", "client": "X", "side": "SELL", "qty": 1.0, "price": 1.0}]}}
    _, _, fresh = alerts.run(["AAA"], rows, BROKERS, {}, {}, market, old_state, [], "2026-11-10T10:00:00Z")
    assert fresh == []
