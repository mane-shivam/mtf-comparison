"""Kotak Neo MTF list: server-rendered HTML table, 30 rows per page.

Route: /margin-requirement/margin-trading/{page}/. The page count is read from
the `totalPages` value embedded in the page (falls back to the pager links).
"""

from __future__ import annotations

import random
import re
import sys
import time

from bs4 import BeautifulSoup

if __package__ in (None, ""):
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
from scrapers.common import PoliteSession, run_scraper, to_float

BASE = "https://www.kotakneo.com/margin-requirement/margin-trading/{page}/"


def parse_page(html: str) -> tuple[list[dict], int]:
    """Return (rows, total_pages) for one Kotak page."""
    m = re.search(r'\\?"totalPages\\?":(\d+)', html)
    if m:
        total = int(m.group(1))
    else:
        pages = [int(p) for p in re.findall(r"margin-trading/(\d+)/", html)]
        total = max(pages, default=1)

    soup = BeautifulSoup(html, "html.parser")
    table = None
    for t in soup.find_all("table"):
        head = t.find("tr")
        if head and "NSE Symbol" in head.get_text(" ", strip=True):
            table = t
            break
    if table is None:
        raise ValueError("MTF table not found on Kotak page")

    rows = []
    for tr in table.find_all("tr")[1:]:
        tds = tr.find_all("td")
        if len(tds) < 4:
            continue
        # The name cell also holds a two-letter avatar; read the title element only.
        title = tds[0].select_one("p.company-card-title-content")
        name = (title or tds[0]).get_text(" ", strip=True)
        symbol, lev, exp = (td.get_text(" ", strip=True) for td in tds[1:4])
        lev_f = to_float(lev)
        if lev_f is None:
            continue
        rows.append({
            "symbol": symbol.strip().upper() or None,
            "name": name,
            "exchange": "NSE",
            "lev": round(lev_f, 2),
            "maxExposureCr": to_float(exp),
        })
    return rows, total


def fetch(s: PoliteSession, page: int, want_total: int | None = None, tries: int = 8) -> tuple[list[dict], int]:
    """One page from the wanted version of the list.

    Kotak's servers can serve two versions of the list at once (seen 11 Nov 2026: 57 and 114 pages,
    sorted differently). Pages mixed from both repeat some stocks and miss others, so a page from the
    other version, or one without its table, is fetched again with a cache-busting query.
    """
    last: Exception | None = None
    for attempt in range(tries):
        url = BASE.format(page=page) + f"?v={random.randint(1, 10**9)}"
        try:
            rows, total = parse_page(s.get(url).text)
            if want_total is None or total == want_total:
                return rows, total
            last = ValueError(f"page {page} came from another version of the list ({total} pages, want {want_total})")
        except ValueError as e:
            last = e
        time.sleep(1 + attempt)
    raise last or ValueError(f"page {page} failed")


def scrape() -> list[dict]:
    s = PoliteSession(referer="https://www.kotakneo.com/")
    # Pick the newest version: the one with the most pages among a few looks at page 1.
    first = [fetch(s, 1) for _ in range(3)]
    rows, total = max(first, key=lambda x: x[1])
    print(f"[kotak] {total} pages (versions seen: {sorted({t for _, t in first})})")
    for page in range(2, total + 1):
        rows.extend(fetch(s, page, total)[0])
    # The site occasionally repeats a row across a page boundary.
    seen, out = set(), []
    for r in rows:
        key = (r["symbol"], r["name"])
        if key not in seen:
            seen.add(key)
            out.append(r)
    return out


if __name__ == "__main__":
    sys.exit(run_scraper("kotak", scrape, min_rows=500))
