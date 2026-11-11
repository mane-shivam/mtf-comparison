import base64
import json
import os
import sys
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import portfolio  # noqa: E402

PASS = "correct horse battery"
POS = {"id": "a", "sym": "AAA", "broker": "kotak", "qty": 100, "price": 400.0, "date": "2026-10-10", "lev": 4}


def encrypt(payload: dict) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=1000).derive(PASS.encode())
    data = AESGCM(key).encrypt(iv, json.dumps(payload).encode(), None)
    b = lambda x: base64.b64encode(x).decode()  # noqa: E731
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": 1000, "salt": b(salt), "iv": b(iv), "data": b(data)}


def test_round_trip():
    assert portfolio.decrypt(PASS, encrypt({"positions": [POS]}))["positions"] == [POS]


def test_top_up_price_and_levels():
    m = portfolio.metrics(POS, {"p": 400, "prev": 400, "date": "2026-11-09"}, {}, date(2026, 11, 9))
    # funded 30,000; 30 days at 9.69% = 238.93; call = (30000 + 238.93) / (100 × 0.75)
    assert round(m["call"], 2) == round((30000 + 30000 * 9.69 * 30 / 36500) / 75, 2)
    px = lambda p: {"AAA": {"p": p, "prev": p, "date": "2026-11-09"}}  # noqa: E731
    today = date(2026, 11, 9)
    assert portfolio.warnings([POS], px(500), {}, today) == []
    assert portfolio.warnings([POS], px(410), {}, today)[0]["level"] == "watch"
    assert portfolio.warnings([POS], px(380), {}, today)[0]["level"] == "alert"


def run(tmp_path, monkeypatch, price, now):
    for name in ("ENC", "SEEN", "PRIVATE", "SUMMARY"):
        monkeypatch.setattr(portfolio, name, tmp_path / name)
    monkeypatch.setattr(portfolio, "PUB", tmp_path)
    (tmp_path / "market.json").write_text(json.dumps({"prices": {"AAA": {"p": price, "prev": price, "date": "2026-11-09"}}}))
    if not portfolio.ENC.exists():
        portfolio.ENC.write_text(json.dumps(encrypt({"positions": [POS], "closed": [], "rates": {}})))
    monkeypatch.setenv("POSITIONS_PASSPHRASE", PASS)
    portfolio.main(now)
    out = json.loads(portfolio.PRIVATE.read_text()) if portfolio.PRIVATE.exists() else []
    summ = json.loads(portfolio.SUMMARY.read_text()) if portfolio.SUMMARY.exists() else None
    return out, summ


def test_warn_once_a_day_and_summary_once(tmp_path, monkeypatch):
    early = datetime(2026, 11, 10, 1, 0, tzinfo=timezone.utc)  # 06:30 IST: no summary yet
    out, summ = run(tmp_path, monkeypatch, 380, early)
    assert [a["level"] for a in out] == ["alert"] and summ is None
    assert "AAA" not in portfolio.SEEN.read_text()  # nothing readable is committed
    later = datetime(2026, 11, 10, 3, 0, tzinfo=timezone.utc)  # 08:30 IST
    out, summ = run(tmp_path, monkeypatch, 379, later)
    assert out == [] and summ["lines"][0] == "P&L −₹2,100 (-5.2%), last session +₹0"
    assert any(line.startswith("Margin: Kotak ₹") and line.endswith("short") for line in summ["lines"])
    out, summ = run(tmp_path, monkeypatch, 379, datetime(2026, 11, 10, 4, 0, tzinfo=timezone.utc))
    assert out == [] and summ is None  # both already sent today
    out, _ = run(tmp_path, monkeypatch, 379, datetime(2026, 11, 11, 4, 0, tzinfo=timezone.utc))
    assert [a["level"] for a in out] == ["alert"]  # a new day warns again


def test_wrong_passphrase_still_sends_summary(tmp_path, monkeypatch):
    (tmp_path / "ENC").write_text(json.dumps(encrypt({"positions": [POS]})))
    for name in ("ENC", "SEEN", "PRIVATE", "SUMMARY"):
        monkeypatch.setattr(portfolio, name, tmp_path / name)
    monkeypatch.setattr(portfolio, "PUB", tmp_path)
    monkeypatch.setenv("POSITIONS_PASSPHRASE", "wrong passphrase!")
    portfolio.main(datetime(2026, 11, 10, 3, 0, tzinfo=timezone.utc))
    assert not portfolio.PRIVATE.exists()
    assert json.loads(portfolio.SUMMARY.read_text())["lines"] == ["Nothing new on your watchlist"]


def test_margin_is_checked_per_broker_account():
    today = date(2026, 11, 9)
    loser = {**POS, "id": "l", "sym": "LOS"}  # 100 @ 400, 4x: below its own margin at 380
    winner = {**POS, "id": "w", "sym": "WIN"}  # same size, up 20%
    prices = {"LOS": {"p": 380, "prev": 380, "date": "2026-11-09"}, "WIN": {"p": 480, "prev": 480, "date": "2026-11-09"}}
    assert portfolio.warnings([loser], prices, {}, today)[0]["level"] == "alert"
    # The gain at the same broker covers the loss: no top-up.
    assert portfolio.warnings([loser, winner], prices, {}, today) == []
    # At a different broker it doesn't help.
    got = portfolio.warnings([loser, {**winner, "broker": "rupeezy"}], prices, {}, today)
    assert [(a["symbol"], a["level"]) for a in got] == [("Kotak", "alert")]


def test_margin_uses_todays_broker_rate():
    today = date(2026, 11, 9)
    prices = {"AAA": {"p": 430, "prev": 430, "date": "2026-11-09"}}
    # At the entry 4x (25%) a 7.5% gain leaves room; if the broker now asks 40%, it's short.
    assert portfolio.warnings([POS], prices, {}, today, {"AAA": {"kotak": {"lev": 4.0}}}) == []
    got = portfolio.warnings([POS], prices, {}, today, {"AAA": {"kotak": {"lev": 2.5}}})
    assert got[0]["level"] == "alert"
    # Dropped from MTF: the full value is needed.
    assert portfolio.warnings([POS], prices, {}, today, {"AAA": {"kotak": None}})[0]["level"] == "alert"
    # Rupeezy's exact own-money % wins over 100 / leverage.
    r = {**POS, "broker": "rupeezy"}
    assert portfolio.margin_pct(r, {"AAA": {"rupeezy": {"lev": 4.0, "ownPct": 26.1}}}) == 26.1


def test_keeper_slots():
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
    import keeper

    u = lambda *a: datetime(*a, tzinfo=timezone.utc)  # noqa: E731
    assert keeper.next_slot(u(2026, 11, 10, 2, 0)) == u(2026, 11, 10, 2, 30)  # 08:00 IST
    assert keeper.next_slot(u(2026, 11, 10, 2, 30)) == u(2026, 11, 10, 3, 30)
    assert keeper.next_slot(u(2026, 11, 10, 12, 31)) == u(2026, 11, 10, 16, 30)  # 22:00 IST
    assert keeper.next_slot(u(2026, 11, 10, 20, 31)) == u(2026, 11, 11, 0, 30)  # 06:00 IST next day
    assert keeper.next_slot(u(2026, 11, 11, 0, 31)) == u(2026, 11, 11, 2, 30)


def test_lot_bought_with_spare_margin_uses_up_spare():
    today = date(2026, 11, 9)
    prices = {"AAA": {"p": 480, "prev": 480, "date": "2026-11-09"}, "BBB": {"p": 100, "prev": 100, "date": "2026-11-09"}}
    winner = {**POS, "id": "w"}  # 100 @ 400 -> 480 at 4x: lots of spare margin
    a = portfolio.accounts([winner], prices, {}, today)[0]
    # A new lot paid fully from that spare (cash 0) must use the spare up, not add fresh money.
    new = {"id": "n", "sym": "BBB", "broker": "kotak", "qty": 200, "price": 100.0, "date": "2026-11-09", "lev": 4, "cash": 0}
    b = portfolio.accounts([winner, new], prices, {}, today)[0]
    assert round(a["spare"] - b["spare"]) == 5000  # its 25% margin (20,000 x 25%) comes out of the spare
    same_as_cash = {**new, "cash": None}
    c = portfolio.accounts([winner, same_as_cash], prices, {}, today)[0]
    assert round(c["spare"]) == round(a["spare"])  # new money covers its own margin: spare unchanged
