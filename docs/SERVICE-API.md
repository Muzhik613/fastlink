# Calling FastLink from a service

A server-side program drives a named browser through the relay's MCP endpoint over plain HTTPS.
Every call is one JSON-RPC `tools/call`. No MCP client library is needed.

## Endpoint and token

- **URL:** `https://relay.ytx.app/mcp`.
- **Credentials:** `~/.secrets/fastlink-relay.json` (`{url, token, browsers, doc}`, mode 600). Never
  log the token.
- **Headers:**
  - `Authorization: Bearer <token>`
  - `Content-Type: application/json`
  - `Accept: application/json, text/event-stream`
- **Scope:** a service token is limited to the browsers listed with it (`browsers`).
  - A call to any other browser, or a sealed call, is refused.
  - `fast_status` lists only those browsers.
  - Always pass `browser`, unless the token has exactly one.
- **Revoke:** set `revoked = 1` on its row in the relay's `agents` table (label `jewel-api`).

## Request / response

```http
POST /mcp
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"fast_tab","arguments":{"browser":"winytx","url":"https://example.com/","background":true,"scoped":true,"noSnapshot":true}}}
```

- **The answer:** the result is JSON text in `result.content[0].text`. Parse it.
- **Errors:** they come back the same way, as an object with `error` (HTTP status is still 200).
- **Response format:** the body may be plain JSON or one Server-Sent-Events line
  `data: {…}`. Handle both.

## The calls a scraper needs

- **Open a tab:** `fast_tab {browser, url, background:true, scoped:true, noSnapshot:true}` → `{tabId, url}`.
  - Always `background:true, scoped:true`: the tab opens behind the user's tabs and never becomes
    the browser's target tab.
  - These are people's real browsers, so never navigate, close or type into a tab you did not
    open.
- **Wait for text:** `fast_wait {browser, tabId, text:"…", timeoutMs:15000, noSnapshot:true}`. Or use
  `selector:"css"` instead of `text`. On timeout: `{error:"Timed out waiting …"}`.
- **Read links and controls:** `fast_snapshot {browser, tabId, limit:200}` →
  - `items`: `[{i, tag, text|label, href?, …}]`; links carry `href`.
  - `content`: the visible text blocks.
  - Add `full:true` for the whole page instead of the visible part.
- **Read text:** `fast_text {browser, tabId, selector?, maxLen?}` → `{text, truncated}`.
- **Close the tab:** `fast_close {browser, tabId}`.
- **Calls are capped at about 30 s each.** Split long waits into several `fast_wait` calls.

There is no JavaScript evaluation for services. `fast_evaluate` exists only in the locked secure
build. Read pages with `fast_snapshot` / `fast_text`.

## Minimal Node example

```js
const { url, token } = JSON.parse(fs.readFileSync(process.env.HOME + '/.secrets/fastlink-relay.json', 'utf8'));
async function call(name, args) {
  const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }) });
  const t = await r.text();
  const j = t.startsWith('{') ? JSON.parse(t) : JSON.parse(t.match(/data: (.*)/)[1]);
  return JSON.parse(j.result.content[0].text);
}
const { tabId } = await call('fast_tab', { browser: 'winytx', url, background: true, scoped: true, noSnapshot: true });
try {
  await call('fast_wait', { browser: 'winytx', tabId, selector: 'a[href]', timeoutMs: 15000, noSnapshot: true });
  const { items } = await call('fast_snapshot', { browser: 'winytx', tabId, limit: 200 });
} finally {
  await call('fast_close', { browser: 'winytx', tabId });
}
```
