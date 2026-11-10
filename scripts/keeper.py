"""Start the data refresh on time.

GitHub runs scheduled workflows late or not at all when it is busy, which for a small repo can mean
hours without a refresh. This script runs in .github/workflows/keeper.yml: it waits for each refresh
slot and starts refresh.yml through the API (workflow_dispatch, which the built-in token is allowed
to trigger). Before GitHub's 6-hour job limit it starts a fresh keeper run and exits, so the chain
continues. A slot that already had a refresh in the last 25 minutes (the site's Refresh button, or a
scheduled run that did fire) is skipped.

Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME. DRY_RUN=1 prints instead of calling GitHub.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

# Refresh slots in UTC (hour, minute): hourly 08:00-18:00 IST, then 22:00, 02:00, 06:00 IST.
SLOTS = [(h, 30) for h in range(2, 13)] + [(16, 30), (20, 30), (0, 30)]
BUDGET = timedelta(hours=5, minutes=30)  # hand over before the 6-hour job limit
RECENT = timedelta(minutes=25)


def next_slot(after: datetime) -> datetime:
    """The first slot strictly after `after` (UTC)."""
    day = after.replace(second=0, microsecond=0)
    for d in range(2):
        base = (day + timedelta(days=d)).replace(hour=0, minute=0)
        for h, m in sorted(SLOTS):
            t = base.replace(hour=h, minute=m)
            if t > after:
                return t
    raise AssertionError("no slot within two days")


def api(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{os.environ['GITHUB_REPOSITORY']}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}", "Accept": "application/vnd.github+json",
                 "X-GitHub-Api-Version": "2022-11-28"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def recent_refresh(now: datetime) -> bool:
    runs = api("GET", "/actions/workflows/refresh.yml/runs?per_page=5").get("workflow_runs", [])
    for run in runs:
        started = datetime.fromisoformat(run["created_at"].replace("Z", "+00:00"))
        if run["status"] in ("queued", "in_progress", "waiting", "pending") or now - started < RECENT:
            return True
    return False


def dispatch(workflow: str) -> None:
    if os.environ.get("DRY_RUN"):
        print(f"[keeper] would start {workflow}")
        return
    api("POST", f"/actions/workflows/{workflow}/dispatches", {"ref": os.environ["GITHUB_REF_NAME"]})
    print(f"[keeper] started {workflow}")


def main() -> int:
    start = datetime.now(timezone.utc)
    while True:
        now = datetime.now(timezone.utc)
        slot = next_slot(now)
        if slot - start > BUDGET:
            break
        wait = (slot - now).total_seconds()
        print(f"[keeper] next refresh {slot:%Y-%m-%d %H:%M} UTC, waiting {wait / 60:.0f} min", flush=True)
        time.sleep(max(0, wait))
        now = datetime.now(timezone.utc)
        try:
            if recent_refresh(now):
                print("[keeper] a refresh ran or is running already: skipped")
            else:
                dispatch("refresh.yml")
        except Exception as e:  # noqa: BLE001 - one failed call must not end the chain
            print(f"[keeper] could not start the refresh: {e}")
    for attempt in range(4):  # continue in a fresh run; the backup schedule restarts the chain if this fails
        try:
            dispatch("keeper.yml")
            return 0
        except Exception as e:  # noqa: BLE001
            print(f"[keeper] could not start the next keeper run: {e}")
            time.sleep(15 * (attempt + 1))
    return 1


if __name__ == "__main__":
    sys.exit(main())
