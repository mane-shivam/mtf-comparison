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
  Rupeezy: RUPEEZY_API_KEY, RUPEEZY_APP_ID, RUPEEZY_CLIENT_CODE, RUPEEZY_PASSWORD, RUPEEZY_TOTP_SECRET
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
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "broker.enc.json"
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
    return {
        "holdings": _json(s.get(f"{base}/portfolio/v1/holdings", headers=form, timeout=TIMEOUT), "Kotak holdings"),
        "positions": _json(s.get(f"{base}/quick/user/positions", headers=auth, timeout=TIMEOUT), "Kotak positions"),
        "trades": _json(s.get(f"{base}/quick/user/trades", headers=auth, timeout=TIMEOUT), "Kotak trades"),
        "limits": _json(s.post(f"{base}/quick/user/limits", headers=form, data=every, timeout=TIMEOUT), "Kotak limits"),
    }


# ---------- Rupeezy (Vortex API) ----------

def rupeezy(env: dict) -> dict:
    s = requests.Session()
    s.headers.update({"Accept": "application/json"})
    login = _json(s.post(f"{VORTEX}/user/login", timeout=TIMEOUT,
                         headers={"Content-Type": "application/json", "x-api-key": env["RUPEEZY_API_KEY"]},
                         json={"client_code": env["RUPEEZY_CLIENT_CODE"], "password": env["RUPEEZY_PASSWORD"],
                               "totp": totp(env["RUPEEZY_TOTP_SECRET"]), "application_id": env["RUPEEZY_APP_ID"]}),
                  "Rupeezy login")
    token = (login.get("data") or {}).get("access_token")
    if not token:
        raise SyncError("Rupeezy login: no session in the response (password/TOTP login may be retired: "
                        "switch to Sign in with Rupeezy)")
    h = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    get = lambda path, what: _json(s.get(VORTEX + path, headers=h, timeout=TIMEOUT), what)  # noqa: E731
    out = {
        "holdings": get("/trading/portfolio/holdings", "Rupeezy holdings"),
        "positions": get("/trading/portfolio/positions", "Rupeezy positions"),
        "trades": get("/trading/trades", "Rupeezy trades"),
        "funds": get("/user/funds", "Rupeezy funds"),
    }
    try:  # end the session; harmless if it fails
        s.delete(f"{VORTEX}/user/session", headers=h, timeout=TIMEOUT)
    except requests.RequestException:
        pass
    return out


BROKERS = {
    "kotak": (kotak, ["KOTAK_ACCESS_TOKEN", "KOTAK_TOTP_SECRET", "KOTAK_MOBILE", "KOTAK_UCC", "KOTAK_MPIN"]),
    "rupeezy": (rupeezy, ["RUPEEZY_API_KEY", "RUPEEZY_APP_ID", "RUPEEZY_CLIENT_CODE", "RUPEEZY_PASSWORD",
                          "RUPEEZY_TOTP_SECRET"]),
}


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
            snapshot["brokers"][name] = {"ok": True, "at": now, "raw": raw}
            print(f"[brokers] {name}: ok; response shape (names and types only):")
            print(json.dumps(shape(raw), indent=1)[:6000])
        except (SyncError, requests.RequestException, KeyError, ValueError) as e:
            msg = str(e) if isinstance(e, SyncError) else type(e).__name__
            last = prev.get(name) or {}
            # Keep the last good data, marked stale, so one failed login doesn't blank the site.
            snapshot["brokers"][name] = {"ok": False, "at": last.get("at"), "error": msg, "failedAt": now,
                                         **({"raw": last["raw"]} if last.get("raw") else {})}
            print(f"[brokers] {name}: failed: {msg}")
    OUT.write_text(json.dumps(encrypt(passphrase, snapshot)) + "\n")
    return 0 if any(b["ok"] for b in snapshot["brokers"].values()) else 1


if __name__ == "__main__":
    sys.exit(main())
