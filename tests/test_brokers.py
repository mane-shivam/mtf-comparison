import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import brokers  # noqa: E402
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
