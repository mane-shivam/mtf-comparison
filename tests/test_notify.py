import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import notify  # noqa: E402


def test_compose_orders_by_severity_and_adds_link():
    alerts = [
        {"symbol": "ABB", "level": "info", "text": "Results on 13 Nov (board meeting announced)"},
        {"symbol": "MTARTECH", "level": "alert", "text": "LT-ASM stage I → II"},
        {"symbol": "HFCL", "level": "good", "text": "Exited LT-ASM IV"},
    ]
    title, body = notify.compose(alerts, "https://example.github.io/mtf/")
    assert title == "MTF Compare: 3 changes in your watchlist (1 serious)"
    assert body.splitlines()[:3] == ["🔴 MTARTECH: LT-ASM stage I → II", "🟢 HFCL: Exited LT-ASM IV",
                                     "🔵 ABB: Results on 13 Nov (board meeting announced)"]
    assert body.endswith("https://example.github.io/mtf/")


def test_no_alerts_sends_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(notify, "NEW", tmp_path / "none.json")
    assert notify.main() == 0
