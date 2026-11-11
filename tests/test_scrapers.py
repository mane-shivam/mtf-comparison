import json
from pathlib import Path

from scrapers import kotak, rupeezy

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def test_kotak_first_page():
    rows, total = kotak.parse_page((SAMPLES / "kotak_p1.html").read_text())
    assert total == 58
    assert len(rows) == 30
    assert rows[0] == {"symbol": "ASHIANA", "name": "Ashiana Housing Limited", "exchange": "NSE",
                       "lev": 1.0, "maxExposureCr": 0.1}
    assert all(r["symbol"] and r["lev"] >= 1 for r in rows)


def test_kotak_last_page():
    rows, total = kotak.parse_page((SAMPLES / "kotak_p58.html").read_text())
    assert total == 58
    assert rows[-1]["symbol"] == "ZYDUSWELL"
    assert rows[-1]["lev"] == 3.1


def test_rupeezy():
    rows, total = rupeezy.parse(json.loads((SAMPLES / "rupeezy_api_p1.json").read_text()))
    assert total == 2198
    assert len(rows) == 100
    hdfc = rows[0]
    assert hdfc["symbol"] == "HDFCBANK" and hdfc["lev"] == 5 and hdfc["ownPct"] == 20


def test_rupeezy_below_one_is_full_own_funds():
    rows, _ = rupeezy.parse(json.loads((SAMPLES / "rupeezy_api_p22.json").read_text()))
    cnl = next(r for r in rows if r["symbol"] == "CNL")
    assert cnl["lev"] == 0.88 and cnl["ownPct"] == 100.0


def test_partial_list_is_rejected(tmp_path, monkeypatch):
    import json as _json
    from scrapers import common
    monkeypatch.setattr(common, "RAW_DIR", tmp_path)
    monkeypatch.setattr(common, "ROOT", tmp_path)
    good = [{"symbol": f"S{i}", "lev": 3.0} for i in range(1000)]
    assert common.run_scraper("x", lambda: good, min_rows=10) == 0
    half = good[:700]  # 30% of funded stocks gone at once: a partial scrape
    assert common.run_scraper("x", lambda: half, min_rows=10) == 1
    assert len(_json.loads((tmp_path / "x.json").read_text())["rows"]) == 1000  # last good kept
    assert common.run_scraper("x", lambda: good[:950], min_rows=10) == 0  # a normal change passes
