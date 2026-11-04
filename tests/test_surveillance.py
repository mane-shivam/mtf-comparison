import json
from pathlib import Path

from scrapers import surveillance

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


def test_nse_asm():
    rows = surveillance.parse_nse_asm(json.loads((SAMPLES / "nse_asm.json").read_text()))
    assert len(rows) == 30
    assert rows[0] == {"symbol": "A2ZINFRA", "ex": "NSE", "list": "ASM", "term": "long", "stage": "I",
                       "desc": "Long Term Additional Surveillance Measure (LTASM) - Stage I"}
    assert {r["term"] for r in rows} == {"long", "short"}


def test_nse_gsm_stage_from_code():
    rows = surveillance.parse_nse_gsm(json.loads((SAMPLES / "nse_gsm.json").read_text()))
    by_code = {r["symbol"]: r for r in rows}
    assert all(r["list"] == "GSM" and r["term"] is None for r in rows)
    # 'IBC - Receipt & GSM 0' carries gsmStage 'LXII'; the stage is read from the code instead
    assert by_code["AGSTRA"]["stage"] == "0"
    assert any(r["stage"] == "VI" for r in rows)


def test_trendlyne():
    rows = surveillance.parse_trendlyne((SAMPLES / "trendlyne_asm.html").read_text())
    assert len(rows) == 30
    r = rows[0]
    assert r["ex"] == "BSE" and r["list"] in ("ASM", "GSM") and r["since"] and r["exact"]
    assert r["name"] and "52 week" not in r["name"]


def test_stage_of():
    assert surveillance.stage_of("Stage IV") == "IV"
    assert surveillance.stage_of("Stage 0") == "0"
