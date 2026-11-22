# FastLink: Chrome Web Store dashboard answers (REVIEWED, paste-ready)

## STATUS (2026-11-22): 0.4.14 live; 0.4.32 SUBMITTED for review 2026-11-22 15:4x CT (auto-publish on pass) by the boss

**Dashboard item:** `eiifomohibgelcdhadklpmdnoblpalde` (publisher YTX, yaakov@ytx.app, non-trader). The live, public version is **0.4.14** (store page checked 2026-11-16 and again 2026-11-22: "Updated November 15, 2026", 282 KiB).

**Next package:** `fast-ext/dist/fastlink-0.4.32.zip` (`bash fast-ext/scripts/package.sh`; sha256 `646da865066ff3440d34541e64bd8397906ab8e4667298dfce0a6d90339a53d8`, same file list as 0.4.31). It has no `key`, no `update_url`, and fast_fetch is replaced by a stub (see below). Upload steps: `STORE-UPLOAD.md`.

### What changed, 0.4.14 → 0.4.32 (store copy)
- **Manifest:** only `version`. Permissions, host permissions, content scripts and CSP are unchanged.
- **debugger:** the same four CDP commands (Input.dispatchMouseEvent, Input.dispatchKeyEvent, Input.insertText, Page.captureScreenshot). The new hand-off feature uses two of them.
- **Remote code:** none. No eval, new Function, userScripts or Runtime.evaluate. Every injected function is packaged.
- **New features:**
  - Hand-off (0.4.16): a person finishes a step, such as an "are you human" check, from their phone. FastLink sends cropped tab images to a one-time relay link, and the person's taps come back.
  - Remote restart for updates, `fast_update` (0.4.17). In the store copy this means `chrome.runtime.requestUpdateCheck` against the store, then a reload.
  - File upload into a page's `<input type=file>`, `fast_upload` (0.4.31).
  - Options → Connection log (0.4.30). Local only; scalar values only.
- **Fixes (0.4.19–0.4.32):**
  - Typing: real key presses; a fallback when the tab is in the background; nested editors; password fields.
  - Frames: one frame enumeration shared by every tool (Stripe and other embedded checkouts).
  - Discarded tabs are loaded before a tool acts on them.
  - Large pages are read in windows.
  - Each call has a watchdog, so every call gets an answer.
  - A call lost when the connection is replaced (for example, a Chrome restart) is resent and runs once (0.4.32). This is a relayClient.js change only; manifest, permissions and listing text are unchanged.
  - Clearer errors: a host the browser blocks for every extension (Edge), a disabled field.
- **Left out of the store zip on purpose:**
  - `fast_fetch` (0.4.21) is replaced by a stub. It is a relay-built, credentialed fetch for service tokens only, which run the owner's own feed browsers. The relay never offers it to store users. Keeping it out also keeps a "server-driven request with the user's cookies" off the reviewer's desk.
  - `update.html` (0.4.18) is not included. It is used only by unpacked copies.
  - The secure / operator builds are left out, as before.

### Before submitting
1. **Publish the updated privacy policy** (`PRIVACY-POLICY.md`, updated 2026-11-16) to https://fastlink.ytx.app/privacy. It now covers hand-off images, uploaded files and the local connection log. The listing must not promise more than the live policy.
2. The dashboard's **Privacy practices** answers stay the same. Hand-off images and uploaded files fall under "Website content", which is already ticked. Update the `debugger` justification with the text in section 3.

**Residual risk (unchanged from 0.4.14, accepted):** `page.js` runs in the MAIN world on every page at document_start, and the `webRequest` listeners are always on. The `/ext?token=` URL may appear in Workers logs.

---

**Package:** `fastlink-0.4.32.zip` (`fast-ext/scripts/package.sh`; no `key`, no `update_url`).

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
• Puts files your assistant gives it into a page's file-upload field.
• Hands a step to you when the assistant must not do it itself (for example an "are you human" check): you finish it from your phone through a one-time link.

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
| `debugger` | "Advanced control" (on by default, user can turn it off in Options). It uses only these Chrome DevTools Protocol commands on the tab the assistant works in: Input.dispatchMouseEvent, Input.dispatchKeyEvent and Input.insertText (input for controls that don't respond to scripted events, e.g. canvas-based editors and custom widgets), and Page.captureScreenshot (screenshot of a tab that isn't in front). The same two commands (Page.captureScreenshot, Input.dispatchMouseEvent) let the user finish a step from their phone when the assistant hands it over: a cropped image goes to the user's one-time link and their taps come back to that tab. No other domains are used (no Runtime, Network or Storage). Attached on first use per tab; Chrome shows its debugging bar; detaches when the tab closes or the user cancels the bar. |
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
Public (Listed) · All regions · Free.

## 5. Test instructions
(The dashboard field is "Additional instructions", 500 chars max; no credentials.)
```
No test account needed.
1. Install; setup page opens. Click "Sign in & connect", any Google account. Status: Connected.
2. Open https://example.com in a tab.
3. Open https://relay.ytx.app/try, same Google account. Pick the example.com tab, click "Read this tab", then "Click its first link".
With Claude (custom connectors): add connector https://relay.ytx.app/mcp, ask "Use FastLink to read the example.com tab".
Options: site rules, Stop driving, Advanced control. support@ytx.app
```

---

## APPENDIX: privacy policy
Applied and published (`fast-ext/store/PRIVACY-POLICY.md`, URL above). The activity-log retention is 30 days, enforced by the relay's daily prune.
