from pathlib import Path
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
    assert m.resolve("rupeezy", {"name": "x", "isin": "INE040A01034", "symbol": "WRONG", "exchange": "NSE"}) == ("HDFCBANK", "isin")
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
    info = merge.broker_status("rupeezy", {"fetchedAt": "2026-10-28T04:30:00Z", "count": 1}, now)
    assert info["status"] == "stale"


def test_broker_changes():
    dates = ["2026-11-05", "2026-11-06"]
    snaps = [{"AAA": [4.0, 3.0], "BBB": [3.0, None], "CCC": [2.0, 2.0]},
             {"AAA": [1.0, 3.0], "BBB": [3.0, 2.5], "CCC": [1.7, 2.0]}]
    got = {(e["symbol"], e["title"], e["level"]) for e in merge.broker_changes(dates, snaps)}
    assert got == {("AAA", "Dropped from Kotak Neo MTF", "alert"), ("BBB", "Added to Rupeezy MTF", "info"),
                   ("CCC", "Kotak Neo leverage cut", "watch")}


def test_merge_runs_on_the_repository_data(tmp_path):
    """The whole merge on a copy of the real data files: a change in what a scraper saves (say, an extra
    column in the delivery history) must fail here, not in the hourly refresh."""
    import shutil
    import subprocess
    import sys

    root = Path(__file__).resolve().parent.parent
    for f in ("merge.py", "alerts.py"):
        shutil.copy(root / f, tmp_path / f)
    shutil.copytree(root / "scrapers", tmp_path / "scrapers", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(root / "data", tmp_path / "data")
    shutil.copytree(root / "public" / "data", tmp_path / "public" / "data")
    r = subprocess.run([sys.executable, "merge.py"], cwd=tmp_path, capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, r.stderr[-2000:]
    assert "merged" in r.stdout


def test_market_delivery_rows_with_close(tmp_path, monkeypatch):
    """scrapers/market.py saves [delivery %, traded qty, close] per day (the close was added on 12 Nov 2026);
    merge must read the delivery % from any row length."""
    import json

    raw = tmp_path / "raw"
    raw.mkdir()
    days = {f"2026-11-{d:02d}": [40.0 + d, 1000.0, 100.0 + d] for d in range(3, 13)}
    days["2026-11-13"] = [80.0, 2000.0]  # an older two-value row still reads
    (raw / "market.json").write_text(json.dumps({"deliv": {"ABB": days}}))
    monkeypatch.setattr(merge, "RAW", raw)
    m = merge.Matcher(MASTER, [])
    data, _ = merge.build_market(m, {"ABB"}, ["ABB"])
    assert data["deliv"]["ABB"]["d"] == 80.0 and data["deliv"]["ABB"]["date"] == "2026-11-13"
    assert data["deliv"]["ABB"]["avg"] == round(sum(40.0 + d for d in range(3, 13)) / 10, 1)
