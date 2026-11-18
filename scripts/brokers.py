"""Read-only sync of holdings, positions, trades and funds from Kotak Neo and Rupeezy.

Runs in the refresh workflow with credentials from repository secrets. It only calls read endpoints:
there is no order code here, and Kotak accepts order requests only from a registered static IP, which
GitHub's runners never are.

Output: data/broker.enc.json, encrypted with POSITIONS_PASSPHRASE in the same format as the synced
positions (AES-256-GCM, PBKDF2-SHA256), so only the site, after you enter the passphrase, can read it.
Nothing readable is written to the repo or the log: the log shows only the shape of each response
(field names and types), which is what's needed to map fields, never their values.

Secrets (a broker is skipped when its secrets are missing):
  Kotak:   KOTAK_ACCESS_TOKEN, KOTAK_TOTP_SECRET, KOTAK_MOBILE, KOTAK_UCC, KOTAK_MPIN
  Rupeezy: RUPEEZY_API_KEY, RUPEEZY_APP_ID, plus a daily Sign in with Rupeezy on the site
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
import sys
import time
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "broker.enc.json"
SIGNIN = ROOT / "data" / "signin.json"  # gitignored: "sign in to Rupeezy" for scripts/notify.py
SIGNIN_SEEN = ROOT / "data" / "signin_seen.json"  # committed: the last day that notice went out (a date only)
SIGNIN_RE = ("not signed in", "expired", "sign-in", "sign in", "connect rupeezy")
TIMEOUT = 30
KOTAK_LOGIN = "https://mis.kotaksecurities.com/login/1.0/tradeApiLogin"
KOTAK_VALIDATE = "https://mis.kotaksecurities.com/login/1.0/tradeApiValidate"
VORTEX = "https://vortex-api.rupeezy.in/v2"


class SyncError(Exception):
    """A broker step failed; the message is safe to log (no credentials or account data)."""


def totp(secret: str, at: float | None = None, step: int = 30, digits: int = 6) -> str:
    """RFC 6238 code from a base32 key (what authenticator apps compute)."""
    key = base64.b32decode(secret.replace(" ", "").upper() + "=" * (-len(secret.replace(" ", "")) % 8))
    counter = int((time.time() if at is None else at) // step)
    mac = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = mac[-1] & 0x0F
    code = (struct.unpack(">I", mac[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** digits
    return str(code).zfill(digits)


def shape(obj, depth: int = 0):
    """Field names and types only, for the log: never values or row counts."""
    if depth > 4:
        return "…"
    if isinstance(obj, dict):
        return {k: shape(v, depth + 1) for k, v in list(obj.items())[:60]}
    if isinstance(obj, list):
        return [shape(obj[0], depth + 1)] if obj else []  # no counts: Actions logs are public
    return type(obj).__name__


ERROR_KEYS = ("message", "Message", "msg", "errMsg", "emsg", "error", "errors", "description", "stat", "code", "status")


def _reason(body) -> str:
    """The broker's own error text (codes and messages only), for the log."""
    out: list[str] = []

    def walk(x, depth=0):
        if depth > 3 or len(out) > 4:
            return
        if isinstance(x, dict):
            for k, v in x.items():
                if k in ERROR_KEYS and isinstance(v, (str, int)) and str(v).strip():
                    out.append(f"{k}={str(v).strip()[:100]}")
                elif isinstance(v, (dict, list)):
                    walk(v, depth + 1)
        elif isinstance(x, list):
            for v in x[:3]:
                walk(v, depth + 1)

    walk(body)
    return "; ".join(out) or f"fields: {sorted(body)[:8] if isinstance(body, dict) else type(body).__name__}"


# Category fields whose values are labels like "MTF" or "Equity", never account data: safe for public logs.
LABEL_FIELDS = {"instrumentType", "subType", "securityType", "securitySubType", "exchangeSegment", "series",
                "instrumentStatus", "isAlternateScrip", "product", "exchange", "prod", "prdCode", "exSeg"}


def labels(obj, out: dict | None = None, depth: int = 0) -> dict:
    out = {} if out is None else out
    if depth > 5:
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in LABEL_FIELDS and isinstance(v, str) and len(v) <= 24:
                out.setdefault(k, set()).add(v)
            elif isinstance(v, (dict, list)):
                labels(v, out, depth + 1)
    elif isinstance(obj, list):
        for v in obj:
            labels(v, out, depth + 1)
    return {k: sorted(v) if isinstance(v, set) else v for k, v in out.items()} if depth == 0 else out


def _json(r: requests.Response, what: str) -> dict:
    try:
        body = r.json()
    except ValueError:
        kind = (getattr(r, "headers", {}) or {}).get("content-type", "?")
        hint = " (this login route no longer exists)" if r.status_code == 404 else ""
        raise SyncError(f"{what}: HTTP {r.status_code}, {kind} response{hint}") from None
    if not r.ok:
        raise SyncError(f"{what}: HTTP {r.status_code} ({_reason(body)})")
    return body


def parts(calls: dict) -> dict:
    """Run each read on its own: one failing report (say, limits while the broker's back end sleeps)
    must not throw away the others. Failures land in "_errors"; an expired session still fails the broker."""
    out, errors = {}, {}
    for name, call in calls.items():
        try:
            out[name] = call()
        except SyncError as e:
            if "expired" in str(e) or "not signed in" in str(e):
                raise
            errors[name] = str(e)
        except requests.RequestException as e:
            errors[name] = type(e).__name__
    if not out:
        raise SyncError("; ".join(errors.values()) or "no data")
    if errors:
        out["_errors"] = errors
    return out


# ---------- Kotak Neo (Trade API v2) ----------

def kotak(env: dict) -> dict:
    if not (env["KOTAK_MPIN"].isdigit() and len(env["KOTAK_MPIN"]) == 6):
        raise SyncError("KOTAK_MPIN must be the 6-digit Neo trading MPIN (digits only); the secret isn't")
    key = env["KOTAK_ACCESS_TOKEN"]
    common = {"Authorization": key, "neo-fin-key": "neotradeapi", "Content-Type": "application/json"}
    s = requests.Session()
    # The same client headers Kotak's official SDK sends.
    s.headers.update({"User-Agent": "NeoSDK-Python/3.0.13", "Accept": "application/json"})
    login = _json(s.post(KOTAK_LOGIN, headers=common, timeout=TIMEOUT, json={
        "mobileNumber": env["KOTAK_MOBILE"], "ucc": env["KOTAK_UCC"], "totp": totp(env["KOTAK_TOTP_SECRET"])}),
        "Kotak login")
    d = login.get("data") or {}
    if not d.get("token"):
        raise SyncError("Kotak login: no session in the response (check mobile, client code and TOTP key)")
    val = _json(s.post(KOTAK_VALIDATE, headers={**common, "sid": d.get("sid", ""), "Auth": d["token"]},
                       json={"mpin": env["KOTAK_MPIN"]}, timeout=TIMEOUT), "Kotak MPIN")
    v = val.get("data") or {}
    base = (v.get("baseUrl") or "").rstrip("/")
    if not v.get("token") or not base:
        raise SyncError("Kotak MPIN: no session in the response (check the MPIN)")
    auth = {"Sid": v.get("sid", ""), "Auth": v["token"], "neo-fin-key": "neotradeapi", "accept": "application/json"}
    form = {**auth, "Content-Type": "application/x-www-form-urlencoded"}
    every = {"jData": json.dumps({"seg": "ALL", "exch": "ALL", "prod": "ALL"})}
    return parts({
        "holdings": lambda: _json(s.get(f"{base}/portfolio/v1/holdings", headers=form, timeout=TIMEOUT), "Kotak holdings"),
        "positions": lambda: _json(s.get(f"{base}/quick/user/positions", headers=auth, timeout=TIMEOUT), "Kotak positions"),
        "trades": lambda: _json(s.get(f"{base}/quick/user/trades", headers=auth, timeout=TIMEOUT), "Kotak trades"),
        "limits": lambda: _json(s.post(f"{base}/quick/user/limits", headers=form, data=every, timeout=TIMEOUT),
                                "Kotak limits"),
    })


# ---------- fills log ----------
# Each broker's trade book only covers today, and the snapshot only keeps the latest sync. So every sync adds
# the day's fills to a log kept in the snapshot for FILL_DAYS: the site books a sale only against a sell fill
# from this log (exact price and date), never because the holdings list shrank for a while (Kotak lists only
# settled shares, so a stock can drop out the day after it's bought).

IST = timezone(timedelta(hours=5, minutes=30))
FILL_DAYS = 45
_SFX = re.compile(r"-(EQ|BE|BZ|SM|ST)$")


def clean_sym(v) -> str:
    return _SFX.sub("", str(v or "").upper()).strip()


def _num(v) -> float:
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return 0.0


def _prev_trading(d: date) -> date:
    d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def session_day(t: datetime) -> str:
    """The latest session that had opened by t (IST): before 09:15 or at a weekend, an earlier day."""
    i = t.astimezone(IST)
    d = i.date()
    if d.weekday() >= 5 or i.hour * 60 + i.minute < 9 * 60 + 15:
        d = _prev_trading(d)
        while d.weekday() >= 5:
            d = _prev_trading(d)
    return d.isoformat()


def _fill_date(v) -> str | None:
    text = str(v or "").strip().replace("T", " ").split(" ")[0]
    for fmt in ("%d-%b-%Y", "%d/%m/%Y", "%Y-%m-%d", "%d-%m-%Y", "%Y/%m/%d", "%d %b %Y"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    return None


def is_derivative(r: dict) -> bool:
    """A futures or options row. Rupeezy sends an expiry_date field on stock rows too, so that alone says
    nothing: the segment, exchange, instrument type or option type decide."""
    seg = " ".join(str(r.get(k) or "") for k in ("exchange", "segment", "exSeg")).upper()
    inst = str(r.get("instrument_type") or r.get("instrument") or "").upper()
    return ("FO" in seg.replace("FOR", "") or "DERIV" in seg or bool(re.search(r"FUT|OPT", inst))
            or str(r.get("option_type") or "").upper() in ("CE", "PE"))


def fills_of(name: str, raw: dict, day: str) -> list[dict]:
    """Today's delivery/MTF fills on NSE cash: {id, d, sym, side, qty, px}."""
    out: list[dict] = []
    if name == "kotak":
        for t in ((raw.get("trades") or {}).get("data") or []) if isinstance(raw.get("trades"), dict) else []:
            seg = str(t.get("exSeg") or "nse_cm").lower()
            if not (seg.startswith("nse_cm") or seg == "nse"):  # NSE cash only: not BSE, not F&O
                continue
            if re.search(r"MIS|INTRADAY|^BO$|^CO$", str(t.get("prod") or ""), re.I):
                continue
            sym, qty, px = clean_sym(t.get("trdSym") or t.get("sym")), _num(t.get("fldQty") or t.get("qty")), _num(t.get("avgPrc") or t.get("prc"))
            if not sym or qty <= 0 or px <= 0:
                continue
            side = "S" if str(t.get("trnsTp") or "").upper().startswith("S") else "B"
            d = _fill_date(t.get("flDt")) or day
            key = ":".join(str(t.get(k) or "") for k in ("nOrdNo", "flId", "flLeg"))
            fid = f"k:{key}" if key.strip(":") else f"k:{d}:{sym}:{side}:{qty:g}:{px:g}:{t.get('flTm') or ''}"
            out.append({"id": fid, "d": d, "sym": sym, "side": side, "qty": qty, "px": round(px, 4)})
    else:
        day_rows = (((raw.get("positions") or {}).get("data") or {}).get("day") or []) if isinstance(raw.get("positions"), dict) else []
        for r in day_rows:
            if "EQ" not in str(r.get("exchange") or "NSE_EQ").upper() or is_derivative(r) \
                    or re.search(r"INTRADAY|MIS", str(r.get("product") or ""), re.I):
                continue  # stocks only: futures and options carry the stock's name too
            sym = clean_sym(r.get("symbol"))
            for side, q, p in (("B", "buy_quantity", "buy_price"), ("S", "sell_quantity", "sell_price")):
                qty, px = _num(r.get(q)), _num(r.get(p))
                if sym and qty > 0 and px > 0:
                    # The day's running total per stock, product and side: a later sync replaces it.
                    out.append({"id": f"r:{day}:{sym}:{r.get('product') or ''}:{side}", "d": day, "sym": sym,
                                "side": side, "qty": qty, "px": round(px, 4)})
    return out


def merge_fills(prev: list[dict], new: list[dict], day: str) -> list[dict]:
    by = {f["id"]: f for f in prev or []}
    by.update({f["id"]: f for f in new})
    cutoff = (date.fromisoformat(day) - timedelta(days=FILL_DAYS)).isoformat()
    return sorted((f for f in by.values() if f["d"] >= cutoff), key=lambda f: (f["d"], f["id"]))


def merge_report_fills(log: list[dict], report: list[dict], day: str) -> list[dict]:
    """Add Rupeezy's tradebook fills for the days and stocks the log has nothing for (days the sync missed).
    A day the log already covers keeps its own entries, so the site never sees one trade under two ids."""
    covered = {(f["d"], f["sym"], f["side"]) for f in log if not f["id"].startswith("rt:")}
    extra = [f for f in report if (f["d"], f["sym"], f["side"]) not in covered]
    return merge_fills(log, extra, day)


# ---------- Rupeezy (Vortex API) ----------

AUTH_FILE = ROOT / "data" / "rupeezy_auth.enc.json"  # one-time code from Sign in with Rupeezy (the site writes it)
SESSION_FILE = ROOT / "data" / "rupeezy_session.enc.json"  # the session made from it, reused until it expires


def _load(path: Path, passphrase: str) -> dict:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from portfolio import decrypt
    try:
        return decrypt(passphrase, json.loads(path.read_text())) if path.exists() else {}
    except Exception:  # noqa: BLE001
        return {}


def rupeezy_token(env: dict, s: requests.Session) -> str:
    """A Rupeezy session: a fresh sign-in code is exchanged once; otherwise the saved session is reused."""
    passphrase = env["POSITIONS_PASSPHRASE"]
    auth = _load(AUTH_FILE, passphrase)
    saved = _load(SESSION_FILE, passphrase)
    if auth.get("auth") and auth.get("at", "") > saved.get("from", ""):
        app, key = env["RUPEEZY_APP_ID"], env["RUPEEZY_API_KEY"]
        res = _json(s.post(f"{VORTEX}/user/session", timeout=TIMEOUT,
                           headers={"Content-Type": "application/json", "x-api-key": key},
                           json={"applicationId": app, "token": auth["auth"],
                                 "checksum": hashlib.sha256(f"{app}{auth['auth']}{key}".encode()).hexdigest()}),
                    "Rupeezy sign-in")
        token = (res.get("data") or {}).get("access_token")
        if not token:
            raise SyncError("Rupeezy sign-in: no session in the response. Tap Connect Rupeezy again")
        SESSION_FILE.write_text(json.dumps(encrypt(passphrase, {"token": token, "from": auth["at"]})) + "\n")
        return token
    if saved.get("token"):
        return saved["token"]
    raise SyncError("Rupeezy: not signed in. Tap Connect Rupeezy on the site")


def rupeezy(env: dict) -> dict:
    s = requests.Session()
    s.headers.update({"Accept": "application/json"})
    token = rupeezy_token(env, s)
    h = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}

    def get(path: str, what: str) -> dict:
        r = s.get(VORTEX + path, headers=h, timeout=TIMEOUT)
        if r.status_code in (401, 403):
            raise SyncError("Rupeezy session expired. Tap Connect Rupeezy on the site")
        return _json(r, what)

    out = parts({
        "holdings": lambda: get("/trading/portfolio/holdings", "Rupeezy holdings"),
        "positions": lambda: get("/trading/portfolio/positions", "Rupeezy positions"),
        "trades": lambda: get("/trading/trades", "Rupeezy trades"),
        "funds": lambda: get("/user/funds", "Rupeezy funds"),
    })
    out["reports"], errors = rupeezy_reports(s, h, datetime.now(timezone.utc))
    if errors:
        out.setdefault("_errors", {}).update(errors)
    return out


# Rupeezy's back-office reports (Vortex "Backoffice Reports"): the tradebook for any dates, P&L per stock and
# the MTF interest actually charged. Limited to one request a second. Each report is optional: one that fails
# is listed in _errors and the rest of the sync carries on.
REPORT_DAYS = 60  # tradebook window: fills the fill log back over any days the sync missed
REPORT_PREFIXES = ("/reports", "/trading/reports")
REPORT_PAUSE = 1.1  # seconds between report calls


def fy_start(day: date) -> date:
    return date(day.year if day.month >= 4 else day.year - 1, 4, 1)


def rupeezy_reports(s: requests.Session, h: dict, now: datetime) -> tuple[dict, dict]:
    today = now.astimezone(IST).date()
    fy = fy_start(today).isoformat()
    since = (today - timedelta(days=REPORT_DAYS)).isoformat()
    to = today.isoformat()
    calls = {
        "tradesMtf": f"/trades/MTF?from_date={since}&to_date={to}",
        "tradesEquity": f"/trades/EQUITY?from_date={since}&to_date={to}",
        "pnl": f"/pnl/EQUITY?from_date={fy}&to_date={to}",
        "interest": f"/mtf_interest?from_date={fy}&to_date={to}",
    }
    out: dict = {"from": since, "fy": fy, "to": to}
    errors: dict = {}
    for name, path in calls.items():
        last = ""
        for prefix in REPORT_PREFIXES:
            time.sleep(REPORT_PAUSE)  # one request a second
            try:
                r = s.get(VORTEX + prefix + path, headers=h, timeout=TIMEOUT)
            except requests.RequestException as e:
                last = type(e).__name__
                break
            if r.status_code == 404:
                last = "HTTP 404"
                continue  # try the other prefix
            try:
                out[name] = _json(r, f"Rupeezy {name} report")
                last = ""
            except SyncError as e:
                last = str(e)
            break
        if last:
            errors[f"report.{name}"] = last
    return out, errors


def _pick(row: dict, *keys):
    for k in keys:
        if row.get(k) not in (None, ""):
            return row[k]
    return None


def _rows(payload) -> list[dict]:
    """The list of rows in a report response, wherever the API put it."""
    if isinstance(payload, list):
        return [r for r in payload if isinstance(r, dict)]
    if isinstance(payload, dict):
        for k in ("data", "trades", "result", "records"):
            v = payload.get(k)
            if isinstance(v, (list, dict)) and v:
                return _rows(v)
    return []


def report_fills(reports: dict) -> list[dict]:
    """Stock fills from Rupeezy's tradebook report (MTF and delivery): {id, d, sym, side, qty, px}."""
    out, seen = [], set()
    for name in ("tradesMtf", "tradesEquity"):
        for r in _rows(reports.get(name)):
            if is_derivative(r):
                continue
            sym = clean_sym(_pick(r, "symbol", "trading_symbol", "scrip"))
            qty = _num(_pick(r, "quantity", "traded_quantity", "trade_quantity", "qty"))
            px = _num(_pick(r, "price", "trade_price", "traded_price", "rate"))
            side_raw = str(_pick(r, "side", "transaction_type", "buy_sell", "trade_type") or "").upper()
            d = _fill_date(_pick(r, "traded_at_date", "traded_at", "trade_time", "trade_date", "traded_time", "date"))
            tid = _pick(r, "trade_id", "trade_no", "tradeId", "id")
            if not (sym and qty > 0 and px > 0 and d and side_raw[:1] in ("B", "S")):
                continue
            fid = f"rt:{tid}" if tid else f"rt:{d}:{sym}:{side_raw[:1]}:{qty:g}:{px:g}"
            if fid in seen:
                continue  # the MTF and equity reports can both list an MTF trade
            seen.add(fid)
            out.append({"id": fid, "d": d, "sym": sym, "side": side_raw[:1], "qty": qty, "px": round(px, 4)})
    return out


BROKERS = {
    "kotak": (kotak, ["KOTAK_ACCESS_TOKEN", "KOTAK_TOTP_SECRET", "KOTAK_MOBILE", "KOTAK_UCC", "KOTAK_MPIN"]),
    "rupeezy": (rupeezy, ["RUPEEZY_API_KEY", "RUPEEZY_APP_ID"]),
}


def signin_notice(snapshot: dict, env: dict, now: datetime | None = None) -> bool:
    """Rupeezy's sessions end overnight and only its own sign-in page makes a new one. When the sync finds
    it signed out, leave a notice for scripts/notify.py, once a day (the hourly refresh sets NOTIFY_SIGNIN;
    the site's own quick sync doesn't, since you're on the site then)."""
    SIGNIN.unlink(missing_ok=True)
    r = (snapshot.get("brokers") or {}).get("rupeezy") or {}
    if not env.get("NOTIFY_SIGNIN") or r.get("ok") is not False or not any(k in (r.get("error") or "").lower() for k in SIGNIN_RE):
        return False
    day = (now or datetime.now(timezone.utc)).astimezone(timezone(timedelta(hours=5, minutes=30))).date().isoformat()
    seen = json.loads(SIGNIN_SEEN.read_text()) if SIGNIN_SEEN.exists() else {}
    if seen.get("rupeezy") == day:
        return False
    SIGNIN.write_text(json.dumps({"broker": "rupeezy"}) + "\n")
    SIGNIN_SEEN.write_text(json.dumps({"rupeezy": day}) + "\n")
    return True


def encrypt(passphrase: str, payload: dict) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=200_000).derive(passphrase.encode())
    data = AESGCM(key).encrypt(iv, json.dumps(payload, separators=(",", ":")).encode(), None)
    b = lambda x: base64.b64encode(x).decode()  # noqa: E731
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": 200_000, "salt": b(salt), "iv": b(iv), "data": b(data)}


def main(env: dict | None = None) -> int:
    env = dict(os.environ if env is None else env)
    passphrase = env.get("POSITIONS_PASSPHRASE", "").strip()
    wanted = {b: f for b, (f, keys) in BROKERS.items() if all(env.get(k, "").strip() for k in keys)}
    if not wanted:
        print("[brokers] no broker secrets set: skipped")
        return 0
    if not passphrase:
        print("[brokers] POSITIONS_PASSPHRASE not set: nothing is fetched, since the result couldn't be stored safely")
        return 0
    env = {k: v.strip() for k, v in env.items()}
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    snapshot: dict = {"at": now, "brokers": {}}
    prev: dict = {}
    if OUT.exists():
        try:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from portfolio import decrypt
            prev = decrypt(passphrase, json.loads(OUT.read_text())).get("brokers", {})
        except Exception:  # noqa: BLE001 - new passphrase or first run: start fresh
            prev = {}
    for name, fetch in wanted.items():
        try:
            raw = fetch(env)
            # A report that failed this time (Kotak limits during its night maintenance) keeps its last
            # reading, with that reading's time in "_stale", so the site still has the broker's own figure.
            last = (prev.get(name) or {}).get("raw") or {}
            for part in raw.get("_errors", {}):
                if part in last:
                    raw[part] = last[part]
                    raw.setdefault("_stale", {})[part] = (last.get("_stale") or {}).get(part) or prev[name].get("at")
            day = session_day(datetime.now(timezone.utc))
            fills = merge_fills((prev.get(name) or {}).get("fills") or [], fills_of(name, raw, day), day)
            if name == "rupeezy":
                fills = merge_report_fills(fills, report_fills(raw.get("reports") or {}), day)
            snapshot["brokers"][name] = {"ok": True, "at": now, "raw": raw, "fills": fills}
            for part, err in raw.get("_errors", {}).items():
                print(f"[brokers] {name} {part}: failed: {err}")
            print(f"[brokers] {name}: ok; response shape (names and types only):")
            print(json.dumps(shape(raw), indent=1)[:6000])
            print(f"[brokers] {name} category labels: {json.dumps(labels(raw))}")
        except (SyncError, requests.RequestException, KeyError, ValueError) as e:
            msg = str(e) if isinstance(e, SyncError) else type(e).__name__
            last = prev.get(name) or {}
            # Keep the last good data, marked stale, so one failed login doesn't blank the site.
            snapshot["brokers"][name] = {"ok": False, "at": last.get("at"), "error": msg, "failedAt": now,
                                         **({"raw": last["raw"]} if last.get("raw") else {}),
                                         **({"fills": last["fills"]} if last.get("fills") else {})}
            print(f"[brokers] {name}: failed: {msg}")
    OUT.write_text(json.dumps(encrypt(passphrase, snapshot)) + "\n")
    signin_notice(snapshot, env)
    return 0 if any(b["ok"] for b in snapshot["brokers"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
