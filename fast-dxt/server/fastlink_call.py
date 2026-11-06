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
"""
import json
import os
import socket
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


class Client:
    def __init__(self, agent, browser=None, client="script", timeout=DEFAULT_TIMEOUT):
        self.url = agent["relay"].rstrip("/") + "/mcp"
        self.token = agent["agentToken"]
        self.browser = browser
        self.timeout = timeout
        self.session_id = None
        self._next = 1
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

    def call(self, name, args=None, timeout=None):
        a = dict(args or {})
        if self.browser and a.get("browser") is None:
            a["browser"] = self.browser
        r = self._request("tools/call", {"name": name, "arguments": a}, timeout or self.timeout) or {}
        served = (r.get("_meta") or {}).get("fastlink/browser")
        content = r.get("content") or []
        images = [c for c in content if c.get("type") == "image"]
        first = next((c.get("text") for c in content if c.get("type") == "text"), None)
        body = first
        if isinstance(body, str):
            try:
                body = json.loads(body)
            except ValueError:
                pass
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
