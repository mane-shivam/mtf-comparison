"""Kotak Neo MTF list: server-rendered HTML table, 30 rows per page.

Route: /margin-requirement/margin-trading/{page}/. The page count is read from
the `totalPages` value embedded in the page (falls back to the pager links).
"""

from __future__ import annotations

import re
import sys

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


def scrape() -> list[dict]:
    s = PoliteSession(referer="https://www.kotakneo.com/")
    rows, total = parse_page(s.get(BASE.format(page=1)).text)
    print(f"[kotak] {total} pages")
    for page in range(2, total + 1):
        page_rows, _ = parse_page(s.get(BASE.format(page=page)).text)
        rows.extend(page_rows)
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
