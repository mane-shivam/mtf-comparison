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


# Site wording explains itself ("…: you need more margin"); a notification only needs the change.
TRIM = (": you need more margin", ": you need less margin", ": a broker leverage cut may follow",
        ". Convert or close an existing position.", ": selling may not fill", ": read the filing")


def short(text: str) -> str:
    for t in TRIM:
        text = text.replace(t, "")
    return text


def line(a: dict) -> str:
    return f"{ICON.get(a['level'], '•')} {a['symbol']}: {short(a['text'])}"


def compose(alerts: list[dict], site: str | None = None) -> tuple[str, str]:
    """(title, body): most serious first, one short line per change."""
    alerts = sorted(alerts, key=lambda a: (ORDER.get(a["level"], 9), a["symbol"]))
    lines = [line(a) for a in alerts[:MAX_LINES]]
    if len(alerts) > MAX_LINES:
        lines.append(f"+{len(alerts) - MAX_LINES} more")
    serious = sum(a["level"] == "alert" for a in alerts)
    n = len(alerts)
    title = f"{n} watchlist change{'s' if n != 1 else ''}" + (f", {serious} serious" if serious else "")
    return title, "\n".join(lines)


def send_telegram(token: str, chat: str, title: str, body: str, site: str | None = None) -> None:
    text = f"{title}\n{body}" + (f"\n{site}" if site else "")
    r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage", timeout=20,
                      json={"chat_id": chat, "text": text[:4000],
                            "disable_web_page_preview": True})
    r.raise_for_status()


def send_ntfy(topic: str, title: str, body: str, site: str | None, serious: bool) -> None:
    headers = {"Title": title.encode("utf-8"), "Tags": "chart_with_downwards_trend" if serious else "bell",
               "Priority": "high" if serious else "default"}
    if site:
        headers["Click"] = site
    r = requests.post(f"https://ntfy.sh/{topic}", data=body.encode("utf-8"), headers=headers, timeout=20)
    r.raise_for_status()


def messages(site: str | None = None) -> list[tuple[str, str, bool]]:
    """(title, body, serious) for each message this run sends: top-up warnings, watchlist changes, summary."""
    out = []
    private = json.loads(PRIVATE.read_text()) if PRIVATE.exists() else []
    if private:
        private = sorted(private, key=lambda a: ORDER.get(a["level"], 9))
        top = private[0]
        title = (f"Top-up needed: {top['symbol']} {top['text']}" if top["level"] == "alert"
                 else f"Margin low: {top['symbol']}")
        rest = private[1:] if top["level"] == "alert" else private
        out.append((title, "\n".join(line(a) for a in rest) or "Add funds or reduce positions", True))
    alerts = json.loads(NEW.read_text()) if NEW.exists() else []
    if alerts:
        title, body = compose(alerts)
        out.append((title, body, any(a["level"] == "alert" for a in alerts)))
    if SUMMARY.exists():
        s = json.loads(SUMMARY.read_text())
        out.append((s["title"], "\n".join(s["lines"]), False))
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
                send_telegram(token, chat, title, body, site)
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
