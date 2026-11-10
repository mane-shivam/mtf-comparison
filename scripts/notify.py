"""Send this refresh's new alerts (data/alerts_new.json), private top-up warnings and the morning summary
(both from scripts/portfolio.py) to the phone.

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
PRIVATE = ROOT / "data" / "private_alerts.json"  # top-up warnings, from scripts/portfolio.py
SUMMARY = ROOT / "data" / "summary.json"  # morning summary, from scripts/portfolio.py
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


def messages(site: str | None) -> list[tuple[str, str, bool]]:
    """(title, body, serious) for each message this run sends: top-up warnings, watchlist changes, summary."""
    out = []
    private = json.loads(PRIVATE.read_text()) if PRIVATE.exists() else []
    if private:
        n = len(private)
        title = f"MTF Compare: margin top-up {'needed' if any(a['level'] == 'alert' for a in private) else 'close'}"
        body = "\n".join(f"{ICON.get(a['level'], '•')} {a['symbol']}: {a['text']}" for a in private)
        out.append((title if n == 1 else f"{title} ({n} positions)", body + (f"\n\n{site}" if site else ""), True))
    alerts = json.loads(NEW.read_text()) if NEW.exists() else []
    if alerts:
        title, body = compose(alerts, site)
        out.append((title, body, any(a["level"] == "alert" for a in alerts)))
    if SUMMARY.exists():
        s = json.loads(SUMMARY.read_text())
        out.append((s["title"], "\n".join(s["lines"]) + (f"\n\n{site}" if site else ""), False))
    return out


def main() -> int:
    site = os.environ.get("SITE_URL") or None
    msgs = messages(site)
    if not msgs:
        print("[notify] nothing to send")
        return 0
    sent, failed = [], []
    token, chat, topic = (os.environ.get(k, "").strip() for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "NTFY_TOPIC"))
    for title, body, serious in msgs:
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
    print(f"[notify] {len(msgs)} messages; sent via {', '.join(sorted(set(sent))) or 'nothing (no channel configured)'}")
    for f in failed:
        print(f"[notify] failed: {f}")
    return 1 if failed and not sent else 0

if __name__ == "__main__":
    sys.exit(main())
