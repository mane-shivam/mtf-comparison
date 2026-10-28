"""Shared helpers for the broker scrapers."""

from __future__ import annotations

import json
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import requests

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "data" / "raw"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)
REQUEST_GAP_S = 1.0  # polite scraping: about one request per second


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class PoliteSession:
    """requests.Session that waits REQUEST_GAP_S between calls and retries transient errors."""

    def __init__(self, referer: str | None = None):
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-IN,en;q=0.9",
        })
        if referer:
            self.s.headers["Referer"] = referer
        self._last = 0.0

    def get(self, url: str, **kw) -> requests.Response:
        for attempt in range(3):
            wait = REQUEST_GAP_S - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.monotonic()
            try:
                r = self.s.get(url, timeout=30, **kw)
                if r.status_code < 500 and r.status_code != 429:
                    r.raise_for_status()
                    return r
                err: Exception = requests.HTTPError(f"{r.status_code} for {url}")
            except (requests.ConnectionError, requests.Timeout) as e:
                err = e
            time.sleep(2 ** (attempt + 1))
        raise err


def to_float(v) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(",", "").replace("x", "").replace("%", "").strip()
    if s in ("", "-", "--"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def run_scraper(broker: str, scrape: Callable[[], list[dict]], min_rows: int) -> int:
    """Run a scraper and write data/raw/<broker>.json on success.

    On failure the previous good file is left untouched and the error is written
    to data/raw/<broker>.error.json, so merge.py can mark the broker stale.
    Returns a process exit code.
    """
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    out = RAW_DIR / f"{broker}.json"
    err_file = RAW_DIR / f"{broker}.error.json"
    started = now_iso()
    try:
        rows = scrape()
        if len(rows) < min_rows:
            raise RuntimeError(f"only {len(rows)} rows scraped (expected at least {min_rows})")
        payload = {"broker": broker, "fetchedAt": now_iso(), "count": len(rows), "rows": rows}
        out.write_text(json.dumps(payload, indent=0, ensure_ascii=False) + "\n")
        err_file.unlink(missing_ok=True)
        print(f"[{broker}] ok: {len(rows)} rows -> {out.relative_to(ROOT)}")
        return 0
    except Exception as e:  # noqa: BLE001 - any failure keeps last good data
        traceback.print_exc()
        err_file.write_text(json.dumps({"broker": broker, "attemptedAt": started, "error": str(e)[:500]}, indent=1) + "\n")
        print(f"[{broker}] FAILED: {e}")
        return 1
