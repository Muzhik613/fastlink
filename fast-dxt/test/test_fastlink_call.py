"""python3 -m unittest discover -s fast-dxt/test -p 'test_*.py'  — fastlink_call.py against a fake relay."""
import json, os, sys, tempfile, threading, time, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import fastlink_call  # noqa: E402

SEEN = []

class Fake(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        rpc = json.loads(self.rfile.read(int(self.headers["content-length"])))
        SEEN.append((self.headers.get("authorization"), self.headers.get("mcp-session-id"), rpc))
        if self.headers.get("authorization") != "Bearer fla_test":
            self.send_response(401); self.end_headers(); return
        p = rpc.get("params") or {}
        if rpc["method"] == "initialize":
            result, extra = {"protocolVersion": "2024-11-05"}, {"mcp-session-id": "sess-9"}
        else:
            a = p.get("arguments") or {}
            if a.get("slow"): time.sleep(1.0)
            if a.get("tabId") == 404:
                result = {"content": [{"type": "text", "text": json.dumps({"error": "No tab with id: 404."})}]}
            else:
                result = {"content": [{"type": "text", "text": json.dumps({"ok": True, "tabId": a.get("tabId")})}], "_meta": {"fastlink/browser": a.get("browser")}}
            extra = {}
        body = json.dumps({"jsonrpc": "2.0", "id": rpc["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        for k, v in extra.items(): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)

class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        fd, cls.agent = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as f:
            json.dump({"relay": "http://127.0.0.1:%d" % cls.srv.server_port, "agentToken": "fla_test"}, f)
        os.environ["FASTLINK_AGENT_FILE"] = cls.agent
    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown(); os.unlink(cls.agent)

    def test_calls_name_browser_keep_session_and_parse(self):
        fl = fastlink_call.connect(browser="mac2", client="aliya")
        r = fl.call("fast_text", {"tabId": 7})
        self.assertEqual(r, {"result": {"ok": True, "tabId": 7}, "browser": "mac2"})
        auth, sid, rpc = SEEN[-1]
        self.assertEqual(sid, "sess-9")
        self.assertEqual(rpc["params"]["arguments"], {"tabId": 7, "browser": "mac2"})
        self.assertIn("aliya", SEEN[-2][2]["params"]["clientInfo"]["version"])

    def test_error_payload(self):
        r = fastlink_call.connect(browser="mac2").call("fast_text", {"tabId": 404})
        self.assertEqual(r["error"], "No tab with id: 404.")
        self.assertNotIn("result", r)

    def test_timeout(self):
        fl = fastlink_call.connect(browser="mac2")
        with self.assertRaises(fastlink_call.FastLinkTimeout) as cm:
            fl.call("fast_text", {"slow": True}, timeout=0.3)
        self.assertIn("fast_text", str(cm.exception))

    def test_unpaired_and_rejected(self):
        os.environ["FASTLINK_AGENT_FILE"] = "/nonexistent/agent.json"
        try:
            with self.assertRaises(fastlink_call.FastLinkError):
                fastlink_call.connect()
        finally:
            os.environ["FASTLINK_AGENT_FILE"] = self.agent
        with open(self.agent) as f: good = json.load(f)
        fd, bad = tempfile.mkstemp(suffix=".json")
        with os.fdopen(fd, "w") as f: json.dump({**good, "agentToken": "fla_wrong"}, f)
        os.environ["FASTLINK_AGENT_FILE"] = bad
        try:
            with self.assertRaisesRegex(fastlink_call.FastLinkError, "pair again"):
                fastlink_call.connect()
        finally:
            os.environ["FASTLINK_AGENT_FILE"] = self.agent; os.unlink(bad)

if __name__ == "__main__":
    unittest.main()
