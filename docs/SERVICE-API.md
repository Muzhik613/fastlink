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
- **Tools:** a token with an `agents.tools` list sees and may call only those tools (others are
  refused with `toolNotAllowed`).
- **Tokens (11-26):** `jewel-api` (`~/.secrets/fastlink-relay.json`): browsers winytx, mpc1, hvm-ytx,
  hvm-boss; fetch/capture origins below. `deskhub-rcs` (`~/.secrets/fastlink-rcs.json`): hvm-boss
  only; tools fast_list, fast_text, fast_watch, fast_watch_read, fast_watch_stop; no fetch/capture.
- **Revoke:** set `revoked = 1` on its row in the relay's `agents` table (by `label`).

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
- **Read text:** `fast_text {browser, tabId, selector?, offset?, maxLen?}` → `{truncated, next?, text, offset, length}`. One call returns at most 2,000,000 characters; while `truncated:true`, call again with `offset:next` (same selector) and join the pieces.
- **Close the tab:** `fast_close {browser, tabId}`.
- **Calls are capped at about 30 s each.** Split long waits into several `fast_wait` calls.
- **Fetch from inside a tab (`fast_fetch`):** `{browser, tabId, url, method?, headers?, body?}` (method GET, POST, DELETE or HEAD; a body with POST or DELETE) →
  `{status, ok, url, contentType, length, truncated, body}`.
  - It runs one fixed `fetch()` in the tab's own page, with that site's cookies and bot-check
    state, so the site's own JSON API answers as it would for the page (~0.5 s).
  - Only for tokens with allowed fetch origins (jewel-api: `https://www.jewelosco.com`), and only
    same-origin as the tab. A body only with POST or DELETE (up to 64 KB).
  - `Cookie`, `Host`, `Origin`, `Referer` headers are dropped (the browser sets them).
  - The response body is cut at 2 MB (`truncated:true`, `length` = the full size) and returned byte-exact (extension 0.4.35+; older: 512 KB).
  - Pattern: open one tab on the site (`fast_tab`, background + scoped), keep it, call
    `fast_fetch` against it repeatedly; reopen it if a call says the tab is gone or moved.
  - Methods per origin and browser for jewel-api (anything else is refused by the relay):
    - `https://www.jewelosco.com`: mpc1 GET/POST; hvm-ytx GET/HEAD/POST/DELETE; winytx and
      hvm-boss GET/HEAD (logged-in personal profiles).
    - `https://www.dunkindonuts.com`, `https://api-idp.dunkindonuts.com`: hvm-ytx and hvm-boss
      GET/HEAD/POST/DELETE.
  - The URL must be on the tab's own origin: a call to `api-idp.dunkindonuts.com` needs a tab open
    on that origin (from a `www` tab use `fast_capture` to see those requests instead).

## Watching a page or its requests (extension 0.4.33+)

A watch runs in the browser and pushes each change to the relay as it happens. The relay keeps
the events (numbered `seq` 1, 2, … per watch), so a reader that polls late still gets every
event since its cursor. Two kinds, one reader:

- **Watch a list in the page:** `fast_watch {browser, tabId, selector, fields?, key?, limit?}` →
  `{watchId, after:0, items, matches}` (`items` = the list now).
  - `selector` matches ONE item (e.g. a conversation row). Without `fields` an item is `{text}`.
  - `fields`: `{name: spec}`, spec = `"css"` (text of that child), `"css@attr"` (its attribute),
    `"@attr"` (the item's own attribute), `""` (the item's own text). Missing → `null`.
  - `key`: the field that identifies an item, so an edit is `change` (with `prev`) rather than
    `remove` + `add`. `limit`: the first N matches (default 50, max 200).
  - Events: `{seq, at, kind:'add'|'change'|'remove', key, index?, item, prev?}`. A MutationObserver
    in the page re-reads the list after every DOM change (also in a background tab), so two
    messages arriving between two polls are two events. A page reload re-installs the watch and
    reports only what really changed; an empty list right after a load is treated as "still
    rendering", never as everything removed.
- **Capture the tab's own requests:** `fast_capture {browser, tabId, url, method?, body?, maxBody?}`
  → `{watchId, after:0}`.
  - Every request the tab makes whose URL contains `url` (and `method`, when given) becomes one
    event: `{seq, at, kind:'request', url, method, resourceType, requestHeaders, postData?, status,
    responseHeaders, mimeType, body, bodyLength, base64?, truncated?}` (or `failed` instead of
    the response). `requestHeaders` are the headers as sent on the wire (auth headers and
    `Cookie` included). `body` is cut at `maxBody` (default and limit 2 MB; extension 0.4.35+, older 512 KB).
  - Uses Chrome's debugger on that tab (the "FastLink is debugging this browser" banner shows).
    Opening DevTools on the tab or dismissing the banner ends the capture (`ended` event).
  - Service tokens: only on a tab whose origin is one of the token's fetch origins, and only
    requests to those origins are recorded.
  - Start the capture first, then make the page do the request (reload, open the cart …).
- **Read:** `fast_watch_read {watchId, after, waitSec?}` → `{state, events, next, more, gap?}`.
  - Returns at once when there are events with `seq > after`, else waits up to `waitSec`
    (0-25, default 20) for the first. Loop: `after = result.next`.
  - `more:true`: the answer was cut at ~8 MB; read again right away.
  - `gap:N`: N events were dropped before this read (a watch keeps its last 1000 DOM events or
    100 requests). `{kind:'dropped', count}`: the browser couldn't reach the relay for a long time.
  - `state:'ended'` + `reason` (also an `{kind:'ended'}` event): the tab closed, the debugger was
    detached, or Chrome / FastLink restarted in that browser. Start a new watch.
  - `{error, watchGone:true}`: no such watch (stopped, or ended over an hour ago).
- **Stop:** `fast_watch_stop {watchId}`. At most 50 watches per account.

```js
let { watchId, items } = await call('fast_watch', { browser: 'hvm', tabId,
  selector: 'mws-conversation-list-item', key: 'name',
  fields: { name: '.name', snippet: '.snippet-text', time: 'mws-relative-timestamp' } });
for (let after = 0;;) {
  const r = await call('fast_watch_read', { watchId, after, waitSec: 25 });
  if (r.error || r.state === 'ended') break;          // start again
  for (const e of r.events) handle(e);                // add / change / remove
  after = r.next;
}
```

**Cheaper one-off read:** `fast_text {browser, tabId, selector, limit: N}` → `{items:[text …], matches}`,
the first N matches only.

## Payment sheets (Google Pay) — extension 0.4.36+

The Google Pay sheet (`pay.google.com/gp/p/ui/pay`) is a Chrome Payment Handler window, not a tab.
- `fast_list` lists it after the tabs: `{targetId, kind:'sheet', url, title, openerTabId}` (opener = the
  tab that opened it).
- `fast_snapshot {targetId}` → `{items:[{i, tag, role?, label, x, y, disabled?, checked?}], text,
  crossOriginFrames?}`; `fast_click {targetId, id | text, role?, index?}` clicks with real mouse input;
  `fast_screenshot {targetId}` and `fast_click_xy {targetId, x, y}` for anything the snapshot can't read.
- The buyflow frame inside the sheet (payments.google.com) shows up 1-2 s after the sheet opens:
  poll fast_snapshot {targetId} until items carry frame:"payments.google.com". After a click that
  opens a list (the card list: role=option rows in a role=listbox), wait ~1.5 s for it to settle
  before clicking a row, or the click only hovers it. The sheet drops its #__WA__ URL fragment soon
  after loading, so don't rely on it.
- Read and click only (no typing, no navigation). Service tokens: only pay.google.com sheets, and only a
  token with Dunkin fetch origins (jewel-api). Never press Pay unless the order is meant to go through.

## Origin-limited tokens

A token with `agents.origins` (deskhub-rcs-send: `https://messages.google.com`) must pass `tabId`; the
tab must be on one of its origins (checked fresh on every call), fast_nav / fast_tab only load URLs
there, and fast_batch / fast_switch / fast_close are refused.
`~/.secrets/fastlink-rcs-send.json`: hvm-boss only; tools fast_list, fast_snapshot, fast_text, fast_click,
fast_fill, fast_type, fast_key_press, fast_wait, fast_nav, fast_screenshot, fast_fetch (GET on
messages.google.com, including the page's own `blob:https://messages.google.com/…` picture URLs).

`fast_fetch` returns binary responses (image, audio, video, font, pdf, zip, octet-stream) as base64
(`base64:true`, `length` = bytes).

There is no JavaScript evaluation for services (fast_fetch takes a URL, never code). `fast_evaluate` exists only in the locked secure
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
