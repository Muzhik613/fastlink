"""fastlink_call.py — FastLink calls from Python scripts (stdlib only; Python 3.8+).

The Python twin of call.js. It uses this machine's pairing (~/.fastlink/agent.json,
made once with `node index.js pair <CODE>`; FASTLINK_AGENT_FILE overrides the path)
and talks to the relay's /mcp the same way the helper does.

    from fastlink_call import connect
    fl = connect(browser="mac2", client="aliya-pull")
    r = fl.call("fast_evaluate", {"tabId": 123, "fn": "() => location.href"}, timeout=40)
    # r = {"result": ..., "browser": ...} on success,
    #     {"error": ..., ...extras, "browser": ...} on failure.
    # A call that takes longer than its time limit raises FastLinkTimeout.

`browser` goes on every call (a script should always name its browser). `tabId` pins a
call to one tab, so other sessions using the same browser can't move it; the relay
refuses tab-named calls to extensions older than 0.4.8 instead of acting elsewhere.

Secure browsers (fast-ext/src/secure/): when this machine holds a lock code for `browser`
(node index.js lock <browser>), every browser call is sealed automatically (AES-256-GCM, the
format in fast-ext/src/secure/sealed.js) and the reply decrypted here; callers see the same
shapes. That needs the `cryptography` package; without it a sealed browser raises FastLinkError.
"""
import base64
import json
import os
import random
import re
import socket
import time
import urllib.error
import urllib.request

DEFAULT_TIMEOUT = 25  # seconds, the old broker scripts' default


class FastLinkError(Exception):
    pass


class FastLinkTimeout(FastLinkError):
    pass


def agent_file():
    return os.environ.get("FASTLINK_AGENT_FILE") or os.path.join(os.path.expanduser("~"), ".fastlink", "agent.json")


def load_agent():
    try:
        with open(agent_file()) as f:
            a = json.load(f)
        return a if a.get("relay") and a.get("agentToken") else None
    except (OSError, ValueError):
        return None


RELAY_NATIVE = {"fast_status", "fast_feedback"}  # answered by the relay, never sealed
RELAY_CALL_CAP = 30  # seconds: the relay gives up on a browser call; a sealed request is never run later
_SALT = b"fastlink-sealed-v1"


def lock_dir():
    return os.environ.get("FASTLINK_LOCK_DIR") or os.path.join(os.path.dirname(agent_file()), "locks")


def load_lock_code(browser):
    """This machine's lock code for `browser` (a secure browser), or None."""
    if not browser or not re.match(r"^[a-z0-9][a-z0-9_-]{0,31}$", browser):
        return None
    try:
        with open(os.path.join(lock_dir(), browser + ".key")) as f:
            code = f.read().strip()
    except OSError:
        return None
    return code if re.match(r"^[A-Za-z0-9_-]{43}$", code) else None


def _b64u_enc(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def _b64u_dec(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class Sealer:
    """The sealed format v1 (twin of fast-ext/src/secure/sealed.js)."""

    def __init__(self, lock_code):
        try:
            from cryptography.hazmat.primitives import hashes
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            from cryptography.hazmat.primitives.kdf.hkdf import HKDF
        except ImportError:
            raise FastLinkError("this browser is a secure (sealed) browser: install the Python 'cryptography' package")
        raw = _b64u_dec(lock_code)
        if len(raw) != 32:
            raise FastLinkError("a lock code is 43 characters (32 bytes)")
        hkdf = lambda info, n: HKDF(algorithm=hashes.SHA256(), length=n, salt=_SALT, info=info).derive(raw)
        self._aes = AESGCM(hkdf(b"enc", 32))
        self.key_id = hkdf(b"id", 8).hex()

    def _aad(self, direction, seq):
        tail = "|%s" % seq if direction == "res" else ""
        return ("fastlink-sealed-v1|%s|%s%s" % (direction, self.key_id, tail)).encode()

    def seal(self, direction, obj, seq=None):
        nonce = os.urandom(12)
        ct = self._aes.encrypt(nonce, json.dumps(obj, separators=(",", ":"), allow_nan=False).encode("utf-8"), self._aad(direction, seq))
        return {"v": 1, "keyId": self.key_id, "nonce": _b64u_enc(nonce), "ct": _b64u_enc(ct)}

    def unseal(self, direction, frame, seq=None):
        if not isinstance(frame, dict) or frame.get("v") != 1:
            raise FastLinkError("sealed: unsupported frame version")
        if frame.get("keyId") != self.key_id:
            raise FastLinkError("sealed: wrong lock key (key ids differ)")
        try:
            pt = self._aes.decrypt(_b64u_dec(frame["nonce"]), _b64u_dec(frame["ct"]), self._aad(direction, seq))
        except Exception:
            raise FastLinkError("sealed: frame failed authentication")
        return json.loads(pt.decode("utf-8"))


def _pick_from_sse(body, rpc_id):
    last = None
    for block in body.replace("\r\n", "\n").split("\n\n"):
        data = "\n".join(l[5:].lstrip(" ") for l in block.split("\n") if l.startswith("data:"))
        if not data:
            continue
        try:
            msg = json.loads(data)
        except ValueError:
            continue
        if msg.get("id") == rpc_id:
            return msg
        last = msg
    return last


def _shape_result(result, tab_id):
    """The shapes the relay gives unsealed calls (mcp.js): a reply's tabId rides into an
    object result, and a screenshot's dataUrl becomes an MCP image."""
    images = []

    def to_image(data_url):
        m = re.match(r"^data:(image/[\w.+-]+);base64,(.*)$", str(data_url or ""), re.S)
        if m:
            images.append({"type": "image", "data": m.group(2), "mimeType": m.group(1)})
        return bool(m)

    r = result
    if isinstance(r, dict):
        if r.get("dataUrl") and to_image(r["dataUrl"]):
            r = {k: v for k, v in r.items() if k != "dataUrl"}
        elif isinstance(r.get("screenshot"), dict) and r["screenshot"].get("dataUrl") and to_image(r["screenshot"]["dataUrl"]):
            r = dict(r, screenshot={k: v for k, v in r["screenshot"].items() if k != "dataUrl"})
        if isinstance(tab_id, int) and "tabId" not in r:
            r = dict(r, tabId=tab_id)
    out = {"result": r}
    if images:
        out["images"] = images
    return out


class Client:
    def __init__(self, agent, browser=None, client="script", timeout=DEFAULT_TIMEOUT):
        self.url = agent["relay"].rstrip("/") + "/mcp"
        self.token = agent["agentToken"]
        self.browser = browser
        self.timeout = timeout
        self.session_id = None
        self._next = 1
        self._sealers = {}
        self._last_seq = 0
        self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "fastlink-helper@" + socket.gethostname(), "version": "py (%s)" % client},
        }, timeout)

    def _request(self, method, params, timeout):
        rpc_id = self._next
        self._next += 1
        label = params.get("name") if isinstance(params, dict) and params.get("name") else method
        headers = {
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "authorization": "Bearer " + self.token,
            "user-agent": "fastlink-call-py",
        }
        if self.session_id:
            headers["mcp-session-id"] = self.session_id
        body = json.dumps({"jsonrpc": "2.0", "id": rpc_id, "method": method, "params": params}).encode()
        req = urllib.request.Request(self.url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                sid = res.headers.get("mcp-session-id")
                if sid:
                    self.session_id = sid
                text = res.read().decode("utf-8")
                ctype = res.headers.get("content-type", "")
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise FastLinkError("the relay rejected this machine's pairing (HTTP %d); pair again: node <fastlink>/fast-dxt/server/index.js pair <CODE>" % e.code)
            raise FastLinkError("relay HTTP %d: %s" % (e.code, e.read()[:200].decode("utf-8", "replace")))
        except socket.timeout:
            raise FastLinkTimeout("timeout " + label)
        except urllib.error.URLError as e:
            if isinstance(e.reason, socket.timeout):
                raise FastLinkTimeout("timeout " + label)
            raise FastLinkError("can't reach the FastLink relay: %s" % e.reason)
        msg = _pick_from_sse(text, rpc_id) if "text/event-stream" in ctype else (json.loads(text) if text else None)
        if not msg:
            raise FastLinkError("relay sent no reply to " + method)
        if msg.get("error"):
            raise FastLinkError("relay error %s: %s" % (msg["error"].get("code"), msg["error"].get("message")))
        return msg.get("result")

    def _sealer_for(self, browser):
        """The Sealer for a secure browser this machine holds a lock code for, else None."""
        if browser not in self._sealers:
            code = load_lock_code(browser)
            self._sealers[browser] = Sealer(code) if code else None
        return self._sealers[browser]

    @property
    def sealed(self):
        return self._sealer_for(self.browser) is not None

    def _send(self, name, arguments, timeout):
        r = self._request("tools/call", {"name": name, "arguments": arguments}, timeout or self.timeout) or {}
        content = r.get("content") or []
        body = next((c.get("text") for c in content if c.get("type") == "text"), None)
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except ValueError:
                pass
        return r, body, content, (r.get("_meta") or {}).get("fastlink/browser")

    def _next_seq(self):
        # Seconds * 2^20 + 20 random bits (as call.js): unique across processes in practice,
        # increasing within this one.
        self._last_seq = max(self._last_seq + 1, int(time.time()) * 2 ** 20 + random.randrange(2 ** 20))
        return self._last_seq

    def _sealed_call(self, name, args, timeout, target, sealer):
        # A relay timeout means the outcome is unknown; the browser refuses the request
        # after its deadline, so a retry can't make it run twice later.
        inner = {k: v for k, v in (args or {}).items() if k != "browser"}
        seq = self._next_seq()
        ts = int(time.time() * 1000)
        limit = timeout or self.timeout
        frame = sealer.seal("req", {"seq": seq, "ts": ts, "deadline": ts + int(min(limit, RELAY_CALL_CAP) * 1000), "action": name, "args": inner})
        frame["browser"] = target
        _, body, _, served = self._send("fast_sealed", frame, limit)
        if not (isinstance(body, dict) and isinstance(body.get("sealed"), dict)):
            # In clear the relay may only report an error; a result must come sealed.
            err = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), str) else "the relay sent an unsealed reply to a sealed call"
            return {"error": err, "browser": served}
        try:
            reply = sealer.unseal("res", body["sealed"], seq)
        except FastLinkError as e:
            return {"error": str(e), "browser": served}
        if isinstance(reply, dict) and "error" in reply:
            out = dict(reply)
            out["browser"] = served
            return out
        out = _shape_result(reply.get("result") if isinstance(reply, dict) else None,
                            reply.get("tabId") if isinstance(reply, dict) else None)
        out["browser"] = served
        return out

    def call(self, name, args=None, timeout=None):
        target = (args or {}).get("browser") or self.browser
        sealer = None if name in RELAY_NATIVE else self._sealer_for(target)
        if sealer is not None:
            return self._sealed_call(name, args, timeout, target, sealer)
        a = dict(args or {})
        if self.browser and a.get("browser") is None:
            a["browser"] = self.browser
        r, body, content, served = self._send(name, a, timeout)
        images = [c for c in content if c.get("type") == "image"]
        is_obj = isinstance(body, dict)
        if r.get("isError") or (is_obj and "error" in body):
            out = dict(body) if is_obj else {"error": str(body)}
            out["browser"] = served
            return out
        out = {"result": body, "browser": served}
        if images:
            out["images"] = images
        return out


def connect(browser=None, client="script", timeout=DEFAULT_TIMEOUT):
    agent = load_agent()
    if not agent:
        raise FastLinkError("FastLink is not paired on this machine: run node <fastlink>/fast-dxt/server/index.js pair <CODE> (code from https://relay.ytx.app/pair/new)")
    return Client(agent, browser=browser, client=client, timeout=timeout)
