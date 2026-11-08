from scrapers import events


def test_parse_ban():
    ban = events.parse_ban("Securities in Ban For Trade Date 08-NOV-2026:\n1,KAYNES\n2,ABC\n")
    assert ban == {"date": "2026-11-08", "symbols": ["KAYNES", "ABC"]}
    assert events.parse_ban("Securities in Ban For Trade Date 09-NOV-2026:\n")["symbols"] == []


def test_meeting_title():
    assert events.meeting_title("Financial Results/Dividend", "") == "Results · Dividend"
    assert events.meeting_title("Board Meeting Intimation", "to consider the Unaudited Financial results") == "Results"
    assert events.meeting_title("Other business matters", "") == "Board meeting"


def test_parse_board_keeps_informative_row_and_readable_link():
    rows = [
        {"bm_symbol": "ABB", "bm_date": "13-Nov-2026", "bm_purpose": "Board Meeting Intimation", "bm_desc": "meeting",
         "attachment": "https://x/a.xml", "ixbrl": "https://x/a.html"},
        {"bm_symbol": "ABB", "bm_date": "13-Nov-2026", "bm_purpose": "Financial Results", "bm_desc": "results",
         "attachment": "https://x/b.pdf", "ixbrl": None},
    ]
    out = events.parse_board(rows)
    assert len(out) == 1
    assert out[0]["title"] == "Results" and out[0]["link"] == "https://x/b.pdf" and out[0]["date"] == "2026-11-13"


def test_parse_actions():
    out = events.parse_actions([
        {"symbol": "ITC", "exDate": "12-Nov-2026", "subject": "Interim Dividend - Rs 3 Per Share"},
        {"symbol": "XYZ", "exDate": "14-Nov-2026", "subject": "Face Value Split (Sub-Division) - From Rs 10/- To Re 1/-"},
        {"symbol": "BAD", "exDate": "-", "subject": "Dividend"},
    ])
    assert [(e["symbol"], e["title"], e["date"]) for e in out] == [("ITC", "Ex-dividend", "2026-11-12"), ("XYZ", "Split", "2026-11-14")]
    assert out[0]["link"].endswith("symbol=ITC")


def test_parse_announcements_keeps_risky_categories_only():
    rows = [
        {"symbol": "AAA", "an_dt": "07-Nov-2026 23:28:04", "desc": "Credit Rating", "attchmntText": "AAA rating",
         "attchmntFile": "https://x/a.pdf"},
        {"symbol": "BBB", "an_dt": "06-Nov-2026 10:00:00", "desc": "Resignation of Statutory Auditor", "attchmntText": "",
         "attchmntFile": ""},
        {"symbol": "CCC", "an_dt": "06-Nov-2026 10:00:00", "desc": "Copy of Newspaper Publication"},
    ]
    out = {e["symbol"]: e for e in events.parse_announcements(rows)}
    assert set(out) == {"AAA", "BBB"}
    assert out["AAA"]["level"] == "watch" and out["AAA"]["link"] == "https://x/a.pdf" and out["AAA"]["date"] == "2026-11-07"
    assert out["BBB"]["level"] == "alert" and out["BBB"]["title"] == "Auditor resigned"
    assert out["BBB"]["link"].endswith("symbol=BBB")


def test_parse_sec_list():
    text = "Symbol,Series,Security Name,Band,Remarks\nAAA,EQ,A,20,-\nBBB,EQ,B,5,-\nCCC,BE,C,2,-\nDDD,SM,D,5,-\nEEE,EQ,E,No Band,-\n"
    assert events.parse_sec_list(text) == {"BBB": {"band": 5, "series": "EQ"}, "CCC": {"band": 2, "series": "BE"}}
