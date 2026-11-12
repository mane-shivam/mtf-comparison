from scrapers import market

BHAV = """SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER
ENTERO, EQ, 11-Nov-2026, 2114.90, 2114.90, 2115.00, 1969.50, 2004.00, 2004.50, 2004.61, 309053, 6195.32, 30695, 105047, 33.99
"""


def test_bhav_keeps_the_official_close():
    assert market.parse_bhav(BHAV, {"ENTERO"}) == {"ENTERO": [33.99, 309053.0, 2004.5]}


def test_previous_close_comes_from_nse_when_yahoo_skips_a_session():
    # 12 Nov, intraday: Yahoo's bars lack 11 Nov, so its "previous close" is 10 Nov's 2,114.90 and a fall
    # that happened on 11 Nov reads as today's -5.6%.
    prices = {"ENTERO": {"p": 1996.3, "prev": 2114.9, "prevDate": "2026-11-10", "chg": -5.61, "date": "2026-11-12"}}
    hist = {"deliv": {"ENTERO": {"2026-11-10": [35.9, 809258.0, 2114.9], "2026-11-11": [33.99, 309053.0, 2004.5],
                                 "2026-11-12": [43.7, 135747.0, 1971.0]}}}  # today's own file never counts
    assert market.fix_prev(prices, hist) == 1
    assert prices["ENTERO"]["prev"] == 2004.5 and prices["ENTERO"]["chg"] == -0.41
    assert prices["ENTERO"]["prevDate"] == "2026-11-11"
    assert market.fix_prev(prices, hist) == 0  # already right


def test_yahoo_wins_while_nse_file_for_last_session_is_missing():
    prices = {"X": {"p": 110.0, "prev": 100.0, "prevDate": "2026-11-11", "chg": 10.0, "date": "2026-11-12"}}
    hist = {"deliv": {"X": {"2026-11-10": [50.0, 1.0, 90.0]}}}  # NSE's 11 Nov file not fetched yet
    assert market.fix_prev(prices, hist) == 0 and prices["X"]["prev"] == 100.0
    # Rows saved before closes were kept have no close: left alone.
    assert market.fix_prev(prices, {"deliv": {"X": {"2026-11-11": [50.0, 1.0]}}}) == 0


def test_holiday_file_repeating_the_last_session_is_not_a_session():
    assert market.bhav_date(BHAV) == "2026-11-11"
    assert market.bhav_date("SYMBOL, DATE1\n") is None
