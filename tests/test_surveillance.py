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


def test_dates_new_entries_and_bootstrap():
    entries = [{"symbol": "A", "list": "ASM", "term": "long", "stage": "I"},
               {"symbol": "B", "list": "GSM", "term": None, "stage": "0"}]
    seen = {"A|ASM|long|I": {"since": "2026-08-31", "exact": True}}
    live = surveillance.date_entries(entries, seen, "2026-11-10")
    assert entries[0]["since"] == "2026-08-31" and entries[0]["exact"]
    # first seen after tracking began: dated by that refresh
    assert entries[1]["since"] == "2026-11-10" and entries[1]["exact"]
    assert set(live) == {"A|ASM|long|I", "B|GSM|None|0"}
    # first seen on the day tracking began: only "since at least"
    e = [{"symbol": "C", "list": "ASM", "term": "short", "stage": "I"}]
    surveillance.date_entries(e, {}, surveillance.TRACKING_STARTED["ASM"])
    assert not e[0]["exact"]


def test_stage_of():
    assert surveillance.stage_of("Stage IV") == "IV"
    assert surveillance.stage_of("Stage 0") == "0"


def test_nse_esm():
    rows = surveillance.parse_nse_esm([{"symbol": "3IINFOLTD", "esmSurvIndicator": "Stage II", "survDesc": "ESM II"}])
    assert rows == [{"symbol": "3IINFOLTD", "ex": "NSE", "list": "ESM", "term": None, "stage": "II", "desc": "ESM II"}]
