from datetime import datetime, timezone

import merge

MASTER = [
    {"symbol": "ABB", "name": "ABB India Limited", "isin": "INE117A01022", "type": "equity"},
    {"symbol": "M&M", "name": "Mahindra & Mahindra Limited", "isin": "INE101A01026", "type": "equity"},
    {"symbol": "HDFCBANK", "name": "HDFC Bank Limited", "isin": "INE040A01034", "type": "equity"},
]


def test_normalise():
    assert merge.normalise("Mahindra & Mahindra Ltd.") == "mahindra and mahindra"
    assert merge.normalise("ABB India Limited") == merge.normalise("abb india ltd")


def test_match_order():
    m = merge.Matcher(MASTER, [{"broker": "", "name": "Some Odd Name", "symbol": "ABB"}])
    assert m.resolve("paytm", {"name": "x", "isin": "INE040A01034", "symbol": "WRONG", "exchange": "NSE"}) == ("HDFCBANK", "isin")
    assert m.resolve("kotak", {"name": "ABB India", "symbol": "ABB", "exchange": "NSE"}) == ("ABB", "symbol")
    assert m.resolve("rupeezy", {"name": "MAHINDRA AND MAHINDRA LTD", "exchange": "BSE"}) == ("M&M", "name")
    assert m.resolve("rupeezy", {"name": "Mahindra & Mahindr Ltd", "exchange": "BSE"}) == ("M&M", "fuzzy")
    assert m.resolve("rupeezy", {"name": "some odd name"}) == ("ABB", "override")
    assert m.resolve("rupeezy", {"name": "Totally Unknown Co", "exchange": "BSE"}) == (None, "unmatched")


def test_status_stale_when_error_is_newer(tmp_path, monkeypatch):
    monkeypatch.setattr(merge, "RAW", tmp_path)
    now = datetime(2026, 10, 28, 12, tzinfo=timezone.utc)
    raw = {"fetchedAt": "2026-10-28T04:30:00Z", "count": 10}
    assert merge.broker_status("kotak", raw, now)["status"] == "ok"
    (tmp_path / "kotak.error.json").write_text('{"attemptedAt": "2026-10-28T10:45:00Z", "error": "boom"}')
    info = merge.broker_status("kotak", raw, now)
    assert info["status"] == "stale" and info["error"] == "boom"
    assert merge.broker_status("kotak", None, now)["status"] == "failed"


def test_status_stale_when_old():
    now = datetime(2026, 10, 30, 12, tzinfo=timezone.utc)
    info = merge.broker_status("paytm", {"fetchedAt": "2026-10-28T04:30:00Z", "count": 1}, now)
    assert info["status"] == "stale"
