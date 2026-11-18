import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import brokers  # noqa: E402
brokers.REPORT_PAUSE = 0  # no pause between report calls in tests
import portfolio  # noqa: E402

PASS = "correct horse battery"
KOTAK = {"KOTAK_ACCESS_TOKEN": "tok", "KOTAK_TOTP_SECRET": "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
         "KOTAK_MOBILE": "+910000000000", "KOTAK_UCC": "ABC12", "KOTAK_MPIN": "123456", "POSITIONS_PASSPHRASE": PASS}


def test_totp_matches_rfc6238():
    # RFC 6238 SHA-1 vector: secret "12345678901234567890", T=59 -> 94287082 (8 digits).
    assert brokers.totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", at=59, digits=8) == "94287082"


def test_shape_hides_values():
    s = brokers.shape({"data": [{"symbol": "CDSL", "quantity": 151, "averagePrice": 1347.5}]})
    assert "CDSL" not in json.dumps(s) and "1347" not in json.dumps(s)
    assert s == {"data": [{"symbol": "str", "quantity": "int", "averagePrice": "float"}]}


class Resp:
    def __init__(self, body, status=200):
        self.body, self.status_code, self.ok = body, status, 200 <= status < 300

    def json(self):
        return self.body


class FakeSession:
    calls = []

    def __init__(self):
        self.headers = {}

    def _hit(self, method, url, **kw):
        FakeSession.calls.append((method, url))
        if url.endswith("tradeApiLogin"):
            return Resp({"data": {"token": "view", "sid": "s1"}})
        if url.endswith("tradeApiValidate"):
            return Resp({"data": {"token": "edit", "sid": "s2", "baseUrl": "https://e21.kotaksecurities.com/"}})
        return Resp({"data": [{"symbol": "CDSL", "quantity": 151}]})

    def get(self, url, **kw):
        return self._hit("GET", url, **kw)

    def post(self, url, **kw):
        return self._hit("POST", url, **kw)


def test_kotak_sync_is_read_only_and_encrypted(tmp_path, monkeypatch):
    monkeypatch.setattr(brokers, "OUT", tmp_path / "broker.enc.json")
    monkeypatch.setattr(brokers.requests, "Session", FakeSession)
    FakeSession.calls = []
    assert brokers.main(KOTAK) == 0
    urls = [u for _, u in FakeSession.calls]
    assert not any("order" in u.lower() for u in urls)  # never an order endpoint
    assert urls[2:] == ["https://e21.kotaksecurities.com/portfolio/v1/holdings",
                        "https://e21.kotaksecurities.com/quick/user/positions",
                        "https://e21.kotaksecurities.com/quick/user/trades",
                        "https://e21.kotaksecurities.com/quick/user/limits"]
    text = (tmp_path / "broker.enc.json").read_text()
    assert "CDSL" not in text
    snap = portfolio.decrypt(PASS, json.loads(text))
    assert snap["brokers"]["kotak"]["ok"] and snap["brokers"]["kotak"]["raw"]["holdings"]["data"][0]["symbol"] == "CDSL"


def test_failed_login_keeps_last_good_data(tmp_path, monkeypatch):
    monkeypatch.setattr(brokers, "OUT", tmp_path / "broker.enc.json")
    monkeypatch.setattr(brokers.requests, "Session", FakeSession)
    brokers.main(KOTAK)

    class Broken(FakeSession):
        def post(self, url, **kw):
            return Resp({"message": "Invalid TOTP"}, 401)

    monkeypatch.setattr(brokers.requests, "Session", Broken)
    assert brokers.main(KOTAK) == 1
    snap = portfolio.decrypt(PASS, json.loads((tmp_path / "broker.enc.json").read_text()))
    k = snap["brokers"]["kotak"]
    assert not k["ok"] and "Invalid TOTP" in k["error"] and k["raw"]["holdings"]["data"][0]["symbol"] == "CDSL"


def test_skips_without_secrets_or_passphrase(tmp_path, monkeypatch):
    monkeypatch.setattr(brokers, "OUT", tmp_path / "broker.enc.json")
    assert brokers.main({}) == 0
    assert brokers.main({k: v for k, v in KOTAK.items() if k != "POSITIONS_PASSPHRASE"}) == 0
    assert not (tmp_path / "broker.enc.json").exists()


def test_reason_shows_broker_error_text_only():
    assert brokers._reason({"error": [{"code": "10522", "message": "Invalid MPIN"}]}) == "code=10522; message=Invalid MPIN"
    assert brokers._reason({"data": None, "ok": False}) == "fields: ['data', 'ok']"


def test_mpin_format_is_checked_before_calling_kotak(tmp_path, monkeypatch):
    monkeypatch.setattr(brokers, "OUT", tmp_path / "broker.enc.json")
    monkeypatch.setattr(brokers.requests, "Session", FakeSession)
    FakeSession.calls = []
    brokers.main({**KOTAK, "KOTAK_MPIN": "1234"})
    assert FakeSession.calls == []


def test_rupeezy_sign_in_code_becomes_a_reusable_session(tmp_path, monkeypatch):
    monkeypatch.setattr(brokers, "OUT", tmp_path / "broker.enc.json")
    monkeypatch.setattr(brokers, "AUTH_FILE", tmp_path / "auth.enc.json")
    monkeypatch.setattr(brokers, "SESSION_FILE", tmp_path / "session.enc.json")
    env = {"RUPEEZY_API_KEY": "key", "RUPEEZY_APP_ID": "app", "POSITIONS_PASSPHRASE": PASS}
    seen = []

    class RZ(FakeSession):
        def post(self, url, **kw):
            seen.append((url, kw.get("json")))
            return Resp({"data": {"access_token": "tok1"}})

        def get(self, url, **kw):
            seen.append((url, kw["headers"]["Authorization"]))
            return Resp({"data": []})

    monkeypatch.setattr(brokers.requests, "Session", RZ)
    assert brokers.main(env) == 1  # not signed in yet
    (tmp_path / "auth.enc.json").write_text(json.dumps(brokers.encrypt(PASS, {"at": "2026-11-11T03:00:00Z", "auth": "code9"})))
    assert brokers.main(env) == 0
    url, body = seen[0]
    assert url.endswith("/user/session") and body["token"] == "code9"
    assert body["checksum"] == brokers.hashlib.sha256(b"appcode9key").hexdigest()
    assert all(a == "Bearer tok1" for _, a in seen[1:])
    seen.clear()
    assert brokers.main(env) == 0  # the same code isn't exchanged twice: the saved session is reused
    assert not any(u.endswith("/user/session") for u, _ in seen)


def test_one_failed_report_keeps_the_rest(tmp_path, monkeypatch):
    monkeypatch.setattr(brokers, "OUT", tmp_path / "broker.enc.json")

    class LimitsDown(FakeSession):
        def post(self, url, **kw):
            if url.endswith("/limits"):
                return Resp({"errMsg": "bridge API error out", "stat": "bridge API error out"}, 424)
            return super().post(url, **kw)

    monkeypatch.setattr(brokers.requests, "Session", LimitsDown)
    assert brokers.main(KOTAK) == 0
    k = portfolio.decrypt(PASS, json.loads((tmp_path / "broker.enc.json").read_text()))["brokers"]["kotak"]
    assert k["ok"] and "holdings" in k["raw"] and "limits" not in k["raw"]
    assert "bridge API error out" in k["raw"]["_errors"]["limits"]


def test_failed_report_keeps_its_last_reading_with_its_time(tmp_path, monkeypatch):
    monkeypatch.setattr(brokers, "OUT", tmp_path / "broker.enc.json")
    monkeypatch.setattr(brokers.requests, "Session", FakeSession)
    brokers.main(KOTAK)
    first = portfolio.decrypt(PASS, json.loads((tmp_path / "broker.enc.json").read_text()))["brokers"]["kotak"]

    class LimitsDown(FakeSession):
        def post(self, url, **kw):
            if url.endswith("/limits"):
                return Resp({"errMsg": "bridge API error out"}, 424)
            return super().post(url, **kw)

    monkeypatch.setattr(brokers.requests, "Session", LimitsDown)
    for _ in range(2):  # the reading's own time carries over, it isn't refreshed
        assert brokers.main(KOTAK) == 0
        k = portfolio.decrypt(PASS, json.loads((tmp_path / "broker.enc.json").read_text()))["brokers"]["kotak"]
        assert k["raw"]["limits"] == first["raw"]["limits"] and k["raw"]["_stale"]["limits"] == first["at"]
        assert "limits" in k["raw"]["_errors"]


def test_rupeezy_signed_out_notifies_once_a_day(tmp_path, monkeypatch):
    from datetime import datetime, timezone

    monkeypatch.setattr(brokers, "SIGNIN", tmp_path / "signin.json")
    monkeypatch.setattr(brokers, "SIGNIN_SEEN", tmp_path / "seen.json")
    out = {"brokers": {"rupeezy": {"ok": False, "error": "Rupeezy session expired. Tap Connect Rupeezy on the site"}}}
    morning = datetime(2026, 11, 18, 1, 31, tzinfo=timezone.utc)  # 07:01 IST
    assert not brokers.signin_notice(out, {}, morning)  # the site's own quick sync: no notification
    assert brokers.signin_notice(out, {"NOTIFY_SIGNIN": "1"}, morning)
    assert (tmp_path / "signin.json").exists()
    assert json.loads((tmp_path / "seen.json").read_text()) == {"rupeezy": "2026-11-18"}
    assert not brokers.signin_notice(out, {"NOTIFY_SIGNIN": "1"}, morning.replace(hour=5))  # same day: once
    assert not (tmp_path / "signin.json").exists()
    assert brokers.signin_notice(out, {"NOTIFY_SIGNIN": "1"}, morning.replace(day=19))  # next day again
    ok = {"brokers": {"rupeezy": {"ok": True}}}
    assert not brokers.signin_notice(ok, {"NOTIFY_SIGNIN": "1"}, morning.replace(day=20))
    other = {"brokers": {"rupeezy": {"ok": False, "error": "Rupeezy funds: HTTP 500"}}}  # not a sign-in problem
    assert not brokers.signin_notice(other, {"NOTIFY_SIGNIN": "1"}, morning.replace(day=21))


def test_fills_log_keeps_each_days_fills_across_syncs():
    from datetime import datetime, timezone

    k = {"trades": {"data": [
        {"trdSym": "CDSL-EQ", "trnsTp": "S", "fldQty": 50, "avgPrc": "1450.5", "exSeg": "nse_cm", "prod": "MTF",
         "flDt": "17-Nov-2026", "nOrdNo": "1", "flId": "9", "flLeg": 1},
        {"trdSym": "NUVAMA-EQ", "trnsTp": "B", "fldQty": 10, "avgPrc": "1880", "exSeg": "nse_cm", "prod": "MIS"},  # intraday
        {"trdSym": "CDSL", "trnsTp": "B", "fldQty": 5, "avgPrc": "10", "exSeg": "nse_fo", "prod": "NRML"},  # F&O
    ]}}
    got = brokers.fills_of("kotak", k, "2026-11-17")
    assert got == [{"id": "k:1:9:1", "d": "2026-11-17", "sym": "CDSL", "side": "S", "qty": 50.0, "px": 1450.5}]
    r = {"positions": {"data": {"day": [
        {"symbol": "ENTERO", "exchange": "NSE_EQ", "product": "MTF", "buy_quantity": 0, "sell_quantity": 30, "sell_price": 1990.0},
        {"symbol": "NIFTY26NOVFUT", "exchange": "NSE_FO", "product": "DELIVERY", "buy_quantity": 75, "buy_price": 25000},
        {"symbol": "SUNPHARMA", "exchange": "NSE_FO", "expiry_date": "2026-11-23", "product": "DELIVERY", "buy_quantity": 350, "buy_price": 1918},
    ]}}}
    day1 = brokers.fills_of("rupeezy", r, "2026-11-17")
    assert [(f["sym"], f["side"], f["qty"]) for f in day1] == [("ENTERO", "S", 30.0)]
    # Later the same day the running total grows: it replaces the earlier entry, it isn't added twice.
    r["positions"]["data"]["day"][0]["sell_quantity"] = 45
    log = brokers.merge_fills(day1, brokers.fills_of("rupeezy", r, "2026-11-17"), "2026-11-17")
    assert [f["qty"] for f in log] == [45.0]
    # Older than 45 days drops out.
    old = [{**log[0], "id": "x", "d": "2026-09-01"}]
    assert brokers.merge_fills(old, [], "2026-11-17") == []
    assert brokers.session_day(datetime(2026, 11, 18, 1, 30, tzinfo=timezone.utc)) == "2026-11-17"  # 07:00 IST
    assert brokers.session_day(datetime(2026, 11, 16, 1, 30, tzinfo=timezone.utc)) == "2026-11-13"  # Monday 07:00: Friday
    assert brokers.session_day(datetime(2026, 11, 18, 5, 0, tzinfo=timezone.utc)) == "2026-11-18"


def test_sync_keeps_the_fills_log_in_the_snapshot(tmp_path, monkeypatch):
    monkeypatch.setattr(brokers, "OUT", tmp_path / "broker.enc.json")
    monkeypatch.setattr(brokers, "SIGNIN", tmp_path / "s.json")
    monkeypatch.setattr(brokers.requests, "Session", FakeSession)
    brokers.main(KOTAK)
    snap = portfolio.decrypt(PASS, json.loads((tmp_path / "broker.enc.json").read_text()))
    assert "fills" in snap["brokers"]["kotak"]


def test_rupeezy_tradebook_report_fills_the_days_the_log_missed(monkeypatch):
    monkeypatch.setattr(brokers, "REPORT_PAUSE", 0)
    reports = {"tradesMtf": {"status": "success", "data": [
        {"symbol": "TATACOMM", "instrument_type": "EQ", "side": "SELL", "quantity": 135, "price": 1790.5,
         "trade_id": "T1", "traded_at": "2026-11-17 14:02:11"},
        {"symbol": "SUNPHARMA", "instrument_type": "FUTSTK", "expiry_date": "2026-11-24", "side": "BUY", "quantity": 350,
         "price": 1918, "trade_id": "T2", "traded_at": "2026-11-17 10:00:00"},
        {"symbol": "ENTERO", "side": "BUY", "quantity": 10, "price": 1990, "trade_id": "T3", "traded_at": "2026-11-18T10:00:00"},
    ]}, "tradesEquity": {"data": [
        {"symbol": "TATACOMM", "side": "SELL", "quantity": 135, "price": 1790.5, "trade_id": "T1", "traded_at": "2026-11-17 14:02:11"},
    ]}}
    got = brokers.report_fills(reports)
    assert [(f["id"], f["d"], f["sym"], f["side"]) for f in got] == [
        ("rt:T1", "2026-11-17", "TATACOMM", "S"), ("rt:T3", "2026-11-18", "ENTERO", "B")]  # no futures, no double
    # 18 Nov is already in the log from the day's positions: the report's copy of it is left out.
    log = [{"id": "r:2026-11-18:ENTERO:MTF:B", "d": "2026-11-18", "sym": "ENTERO", "side": "B", "qty": 10.0, "px": 1990.0}]
    merged = brokers.merge_report_fills(log, got, "2026-11-18")
    assert sorted(f["id"] for f in merged) == ["r:2026-11-18:ENTERO:MTF:B", "rt:T1"]


def test_rupeezy_reports_are_optional(monkeypatch):
    from datetime import datetime, timezone

    monkeypatch.setattr(brokers, "REPORT_PAUSE", 0)
    seen = []

    class S:
        def get(self, url, **kw):
            seen.append(url.split("/v2", 1)[1])
            if "/trading/reports" in url:
                return Resp({"status": "error", "message": "not enabled"}, 400)
            return Resp({}, 404) if "mtf_interest" in url or "pnl" in url else Resp({"status": "success", "data": []})

    out, errors = brokers.rupeezy_reports(S(), {}, datetime(2026, 11, 18, 6, 0, tzinfo=timezone.utc))
    assert out["fy"] == "2026-04-01" and out["tradesMtf"] == {"status": "success", "data": []}
    assert set(errors) == {"report.pnl", "report.interest"} and "not enabled" in errors["report.pnl"]
    assert "/reports/trades/MTF?from_date=2026-09-19&to_date=2026-11-18" in seen
