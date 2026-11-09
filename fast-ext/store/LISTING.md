# FastLink: Chrome Web Store dashboard answers (REVIEWED, paste-ready)

## STATUS (2026-11-09): draft complete, waiting for Yaakov's Submit

**Dashboard draft:** item `eiifomohibgelcdhadklpmdnoblpalde` (publisher YTX, yaakov@ytx.app verified, non-trader), package `fastlink-0.4.14.zip`. Every section below is entered and saved. "Submit for review" is enabled; only Yaakov presses it (or OKs it).

**Done for this submission:**
- **Relay:** the store ID is added via `/admin/extension-ids`. "Sign in & connect" was tested with the 0.4.14 zip loaded under the store's public key (same ID): it connected to the relay. The test devices were removed from D1; backups are in `~/fastlink-store/d1-backup/` on hvm.
- **0.4.14 (policy review):**
  - Secure-build lock, sealed calls and `fast_evaluate` code moved to `secure-only/`; the store package has none of it.
  - UI says "your assistant" instead of "Claude" (except where it names claude.ai or Claude Code).
  - No anti-bot-sounding wording.
  - No remote Google Fonts.
  - Options no longer promises an Allow/Deny prompt.
  - `claudeScrape.js` renamed to `claudeReply.js`.
  - Screenshots re-shot from 0.4.14.
- **Listing:** no first-use Allow/Deny claim (the relay default is allow); neutral debugger wording; "does not track the pages you browse yourself" plus the 30-day action log; User activity ticked; test instructions use an example.com step.
- **Privacy policy** (`PRIVACY-POLICY.md` = fastlink.ytx.app/privacy, live 2026-11-09): adds feedback notes, timing diagnostics, Cloudflare request logs, a custom relay address, and the Google API Services User Data Policy.

**Pending: the relay `/try` page** (built and tested, not deployed; needs Yaakov's OK). After the deploy and a live check, replace the dashboard test instructions with:
```
No test account needed.
1. Install; setup page opens. Click "Sign in & connect", any Google account. Status: Connected.
2. Open https://example.com in a tab.
3. Open https://relay.ytx.app/try, same Google account. Pick the example.com tab, click "Read this tab", then "Click its first link".
With Claude (custom connectors): add connector https://relay.ytx.app/mcp, ask "Use FastLink to read the example.com tab".
Options: site rules, Stop driving, Advanced control. support@ytx.app
```

**Residual risk (accepted, not blocking):**
- Until `/try` is deployed, a reviewer without a Claude plan that has custom connectors can only pair and look at Options.
- `page.js` runs in the MAIN world on every page at document_start, and the `webRequest` listeners are always on. Both are local-only, but injecting on demand and listening only while a call runs would be narrower.
- Workers observability logs may include the `/ext?token=` WebSocket URL. Moving the token out of the URL is a relay change.
- The screenshots show only settings pages; an action shot would be stronger.

---

**Package:** `fastlink-0.4.14.zip` (`fast-ext/scripts/package.sh`; no `key`, no `update_url`).

## 1. Package
Upload the zip from `scripts/package.sh` to the draft and save. Submit only with Yaakov's OK.

## 2. Store listing

**Summary** (comes from the manifest `description`, 119 chars):
```
Connect your own AI assistant (Claude or another MCP app) to your Chrome tabs: read pages, click, fill forms, navigate.
```

**Detailed description:**
```
FastLink is an independent tool. It is not made, endorsed or affiliated with Anthropic, Google or any AI company.

FastLink connects an AI assistant you already use (for example Claude Code, claude.ai, or any app that supports remote MCP connectors) to your own Chrome, so the assistant can read and operate pages in the Chrome you already use.

WHAT IT DOES
• Reads the page you point it at as a compact text snapshot of its structure (links, buttons, fields, text).
• Clicks, types, fills whole forms, selects options, scrolls, navigates, and opens, switches or closes tabs, when your assistant asks it to.
• Takes screenshots of the tab it is working in, when your assistant asks for one.

YOU STAY IN CONTROL
• Per-site rules: in Options, set any site to Allow, Read-only (read, no clicks or typing) or Block.
• An on-page panel shows each step the assistant takes. A side panel shows the assistant's latest reply.
• "Stop driving" pauses everything with one click. "Disconnect relay" cuts the connection.
• Advanced control (on by default, can be turned off in Options): uses Chrome's debugger API only for input to controls that don't respond to scripted events (for example canvas-based editors and custom widgets), and to screenshot a tab that isn't in front. While it is attached, Chrome shows its own "FastLink started debugging this browser" bar. Turn Advanced control off and FastLink uses only normal page scripting.

HOW TO SET IT UP
1. Install FastLink. The setup page opens.
2. Connect this browser: "Sign in & connect" (Google sign-in), or a pairing code from relay.ytx.app/pair/new.
3. Give the browser a name, for example "work-laptop".
4. Connect your assistant once. In claude.ai: Settings → Connectors → Add custom connector → https://relay.ytx.app/mcp. Other apps: add a remote MCP connector with the same address. Claude Code: one command, shown on the setup page.
Then ask your assistant: "Use FastLink to read my current tab."

PRIVACY
FastLink sends page content only when your assistant performs an action. It goes through the FastLink relay (relay.ytx.app, over an encrypted connection) to the assistant app you connected. The relay does not store page content; it keeps a 30-day log of the assistant's actions (action name and site, no page content). FastLink does not track the pages you browse yourself, show ads, sell data, or use data to train models. On claude.ai, FastLink reads the assistant's latest reply to show it in the side panel. That text stays on your device. When you click Allow or Deny in FastLink's panel, FastLink presses the matching button in claude.ai's own permission prompt for you. Full policy: see the privacy policy link on this page. Support: support@ytx.app
```

**Category:** Productivity › Developer Tools

**Language:** English (United States)

**Graphics:**
- Store icon: `store-icon-128.png`
- Screenshots (1280×800, all re-shot from 0.4.14, unpaired), in order: `1-welcome.png`, `5-ai.png`, `4-sites.png`, `3-behavior.png`, `2-connection.png`.
- Promo tiles: skip.

**Homepage URL:** `https://fastlink.ytx.app`  **Support URL:** leave empty.

## 3. Privacy practices

**Single purpose:**
```
FastLink lets the user's own AI assistant read and operate the user's Chrome tabs at the user's request: reading page content and performing the clicks, typing, form fills and navigation the user asks the assistant to do.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `tabs` | To list, open, switch to, navigate and close the tabs the assistant works in, and report their URL and title, including browser pages such as chrome:// that host permissions don't cover. |
| `scripting` | To run FastLink's own packaged functions in the tab the assistant works in, to read the page structure and to click, type and fill forms. No code from outside the package is run. |
| `debugger` | "Advanced control" (on by default, user can turn it off in Options). It uses only these Chrome DevTools Protocol commands on the tab the assistant works in: Input.dispatchMouseEvent, Input.dispatchKeyEvent and Input.insertText (input for controls that don't respond to scripted events, e.g. canvas-based editors and custom widgets), and Page.captureScreenshot (screenshot of a tab that isn't in front). No other domains are used (no Runtime, Network or Storage). Attached on first use per tab; Chrome shows its debugging bar; detaches when the tab closes or the user cancels the bar. |
| `alarms` | To keep the connection to the user's relay account alive and reconnect after the service worker sleeps. |
| `webRequest` | Observe only: counts requests still in flight in a tab, so the assistant can wait until a page has finished loading. Requests are never blocked or changed, and nothing about them is stored or sent anywhere. |
| `webNavigation` | `getAllFrames`: to find a page's embedded frames so the assistant can read and fill forms inside them (e.g. checkout or sign-in frames). |
| `storage` | Stores locally this browser's pairing token, relay address, settings (Advanced control, notifications) and UI state. |
| `identity` | `launchWebAuthFlow` for the optional "Sign in & connect" button, which pairs this browser to the user's relay account with Google sign-in. Pairing by code works without it. |
| `notifications` | Optional desktop alert when the assistant finishes or seems stuck. Off by default. |
| `sidePanel` | FastLink's side panel, which shows what the assistant is doing and its latest reply. |
| Host `<all_urls>` | The user chooses which site the assistant works on, so the sites can't be known ahead of time. Content scripts on all sites read and act on the page the assistant works in. A content script on claude.ai shows the assistant's latest reply in the side panel and presses claude.ai's Allow/Deny button when the user clicks Allow/Deny in FastLink. Users can set any site to Read-only or Block. |

**Are you using remote code?** **No.**
```
All of FastLink's logic is in the package. The relay sends only commands as data (for example "click the element labelled Submit"), and the packaged code carries them out. FastLink does not load or evaluate code from any source (no eval, no new Function, no remote scripts, no userScripts, no CDP Runtime.evaluate).
```

**Data collected** (tick):
- [x] **Personally identifiable information:** the email address of the Google account used to sign in to the relay.
- [x] **Authentication information:** this browser's pairing token (stored locally; sent only to relay.ytx.app).
- [x] **Web history:** URLs and titles of tabs when the assistant lists or navigates tabs; the site (origin) of each action in the relay's activity log.
- [x] **Website content:** page text, structure and screenshots of the tab the assistant works in, sent in transit to the user's own assistant. Not stored by the relay (except inside a feedback note the user or assistant chooses to send).
- [x] **User activity:** the relay's activity log (the action the assistant took, e.g. click or type, the argument names, and the site's origin; 30 days) and timing diagnostics (action names and durations).
- [ ] Health, Financial, Personal communications, Location: leave unticked (they only appear inside "website content" if the user has the assistant work on such a page).

**Certifications:** tick all three.

**Privacy policy URL:**
```
https://fastlink.ytx.app/privacy
```
(Live; same text as `PRIVACY-POLICY.md`, updated 2026-11-08, 30-day activity-log retention.)

## 4. Distribution
Unlisted · All regions · Free.

## 5. Test instructions
(The dashboard field is "Additional instructions", 500 chars max; no credentials.)
```
No test account needed.
1. Install; setup page opens. Click "Sign in & connect", any Google account. Status: Connected.
2. claude.ai (plan with custom connectors) > Settings > Connectors > Add custom connector, URL https://relay.ytx.app/mcp, same Google account.
3. Open https://example.com in another tab, ask Claude: "Use FastLink to read the example.com tab, then click its link."
Without Claude: see Options (site rules, Stop driving, Advanced control). support@ytx.app
```

---

## APPENDIX: privacy policy
Applied and published (`fast-ext/store/PRIVACY-POLICY.md`, URL above). The activity-log retention is 30 days, enforced by the relay's daily prune.
