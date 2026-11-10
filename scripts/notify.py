"""Send this refresh's new alerts (data/alerts_new.json) to the phone.

Channels, each turned on by setting repository secrets (Settings > Secrets and variables > Actions):
- Telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
- ntfy (ntfy.sh app): NTFY_TOPIC, a long random topic name only you know
SITE_URL is the dashboard link added to each message. With no channel configured this does nothing.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
NEW = ROOT / "data" / "alerts_new.json"
ICON = {"alert": "🔴", "watch": "🟠", "info": "🔵", "good": "🟢"}
ORDER = {"alert": 0, "watch": 1, "good": 2, "info": 3}
MAX_LINES = 40


def compose(alerts: list[dict], site: str | None) -> tuple[str, str]:
    """(title, body): most serious first, one line per change."""
    alerts = sorted(alerts, key=lambda a: (ORDER.get(a["level"], 9), a["symbol"]))
    lines = [f"{ICON.get(a['level'], '•')} {a['symbol']}: {a['text']}" for a in alerts[:MAX_LINES]]
    if len(alerts) > MAX_LINES:
        lines.append(f"…and {len(alerts) - MAX_LINES} more")
    serious = sum(a["level"] == "alert" for a in alerts)
    title = f"MTF Compare: {len(alerts)} change{'s' if len(alerts) != 1 else ''} in your watchlist"
    if serious:
        title += f" ({serious} serious)"
    if site:
        lines += ["", site]
    return title, "\n".join(lines)


def send_telegram(token: str, chat: str, title: str, body: str) -> None:
    r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage", timeout=20,
                      json={"chat_id": chat, "text": f"{title}\n\n{body}"[:4000], "disable_web_page_preview": True})
    r.raise_for_status()


def send_ntfy(topic: str, title: str, body: str, site: str | None, serious: bool) -> None:
    headers = {"Title": title.encode("utf-8"), "Tags": "chart_with_downwards_trend" if serious else "bell",
               "Priority": "high" if serious else "default"}
    if site:
        headers["Click"] = site
    r = requests.post(f"https://ntfy.sh/{topic}", data=body.encode("utf-8"), headers=headers, timeout=20)
    r.raise_for_status()


def main() -> int:
    alerts = json.loads(NEW.read_text()) if NEW.exists() else []
    if not alerts:
        print("[notify] no new alerts")
        return 0
    site = os.environ.get("SITE_URL") or None
    title, body = compose(alerts, site)
    serious = any(a["level"] == "alert" for a in alerts)
    sent, failed = [], []
    token, chat, topic = (os.environ.get(k, "").strip() for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "NTFY_TOPIC"))
    if token and chat:
        try:
            send_telegram(token, chat, title, body)
            sent.append("Telegram")
        except Exception as e:  # noqa: BLE001
            failed.append(f"Telegram: {e}")
    if topic:
        try:
            send_ntfy(topic, title, body, site, serious)
            sent.append("ntfy")
        except Exception as e:  # noqa: BLE001
            failed.append(f"ntfy: {e}")
    print(f"[notify] {len(alerts)} alerts; sent via {', '.join(sent) or 'nothing (no channel configured)'}")
    for f in failed:
        print(f"[notify] failed: {f}")
    return 1 if failed and not sent else 0


if __name__ == "__main__":
    sys.exit(main())
