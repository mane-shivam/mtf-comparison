import json
from pathlib import Path

from scrapers import kotak, paytm, rupeezy

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


def test_paytm():
    rows = paytm.parse(json.loads((SAMPLES / "paytm_scrips.json").read_text()))
    assert len(rows) == 40
    godrej = next(r for r in rows if r["symbol"] == "GODREJCP")
    assert godrej["lev"] == 4.7 and godrej["ownPct"] == 21.08 and godrej["isin"] == "INE102D01028"


def test_paytm_skips_disabled():
    payload = {"data": [{"symbol": "X", "scrip_name": "X LTD", "margin_x": 4, "margin_perc": 25, "status": "DISABLED"}]}
    assert paytm.parse(payload) == []


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
