# FastLink: Chrome Web Store dashboard answers (REVIEWED, paste-ready)

## STATUS (2026-11-08, after the audit; everything below matches `fastlink-0.4.13.zip`)

**Done:**
1. **`fast_evaluate` and `userScripts` are gone from the package** (ext 0.4.13; feed + GitHub release `ext-v0.4.13`).
   - The relay no longer lists the tool. The dead eval policy and operator flag are gone from the code; their columns get dropped in a later migration, so a rollback stays safe.
   - The package has no `chrome.userScripts` call and no eval of strings. Page JavaScript exists only in the separate secure build for one owner-controlled browser (`scripts/build-secure.sh`); it never ships through the store or the feed.
   - Remote code = **No**.
2. **Manifest `description`** = `Connect your own AI assistant (Claude or another MCP app) to your Chrome tabs: read pages, click, fill forms, navigate.` (119 chars). The summary below is exactly this.
3. **Options → Behavior** copy fixed (no "running scripts"). `3-behavior.png` re-shot. All five screenshots are re-shot from the 0.4.13 build, unpaired, no personal data.
4. **`minimum_chrome_version`** removed (it was only there for userScripts).
5. **`tabs`** kept. Reason in the table.
6. **Relay** (deployed, version 95291921):
   - Extra extension ids for one-click sign-in can be added at runtime, with no deploy.
   - A daily job deletes activity-log rows older than 30 days and expired pairing codes.
   - The batch load check no longer runs page JavaScript.
7. **Privacy policy** replaced with the APPENDIX text, live at the URL below. The activity log retention is 30 days, which the relay now enforces. The unpair/revoke claims match what exists.

**Before Submit (blocking):**
- **Store ID for one-click sign-in.**
  1. Upload `fastlink-0.4.13.zip` as a **draft** and read the item ID on the dashboard (32 letters a-p).
  2. Add it on hvm, then test "Sign in & connect" from the store copy:
     `curl -s -X POST https://relay.ytx.app/admin/extension-ids -H "Authorization: Bearer $(cat ~/.config/fastlink/relay-admin-token)" -H 'content-type: application/json' -d '{"add":"<ID>"}'`
     The response lists the allowed ids.
- **Google OAuth consent screen.**
  - **Status:** not confirmed yet (no gcloud here). Check Cloud Console → Google Auth Platform → **Audience** → Publishing status for the relay's sign-in client (project 1075856735469).
  - **If it says "Testing":** click **Publish app**. The scopes are only `openid` + `email` (non-sensitive), so no Google verification is needed. It may ask for the app name, support email, homepage `https://fastlink.ytx.app`, the privacy policy URL below, and authorized domain `ytx.app`.
  - **Evidence so far:** 7 Google accounts on 5 domains have signed in to the relay. That is consistent with "In production", but Testing allows up to 100 listed test users, so it doesn't prove it. Ask the Cloud Console assistant if unsure.

**Residual risk to accept or fix (not blocking):**
- A reviewer with no Claude account can't see an AI drive the tab; they can only pair and look at the settings. MCP-bridge extensions are approved on this basis, but the Twilio lesson says to remove doubt. Best fix: a tiny relay page (e.g. `relay.ytx.app/try`, after Google sign-in, with buttons "Read my current tab" / "Click a link") that sends one tool call to the paired browser and shows the result. That's a relay deploy and needs Yaakov's OK. If you build it, add one line to the test instructions.
- `page.js` (300 KB) runs in the MAIN world on every page at document_start and exposes `window.__fastlink.run`. That's not a policy rule, but a sharp reviewer may ask why it's on every page and not injected on demand. Pages can also read or overwrite that global, which is a security point for later.
- `webRequest` listeners run on all URLs all the time, even when nothing is driving. It's local-only and only counts requests in flight, which is fine. Adding the listeners only while driving would be tidier.
- The screenshots are all settings pages. Consider replacing `2-connection.png` with an action shot: a real page with the "Claude is driving this tab" overlay plus the side panel. "Yellow Zinc" calls out screenshots that don't show the functionality.

---

**Package:** `fastlink-0.4.13.zip` (in this folder). No `key`, no `update_url`, no `minimum_chrome_version`.

## 1. Package
Upload `fastlink-0.4.13.zip`. Save as draft. Do the two "Before Submit" items above. Then submit.

## 2. Store listing

**Summary** (comes from the manifest `description`, 119 chars):
```
Connect your own AI assistant (Claude or another MCP app) to your Chrome tabs: read pages, click, fill forms, navigate.
```

**Detailed description:**
```
FastLink is an independent tool. It is not made, endorsed or affiliated with Anthropic, Google or any AI company.

FastLink connects an AI assistant you already use (for example Claude Code, claude.ai, or any app that supports remote MCP connectors) to your own Chrome, so the assistant can read and operate pages in your real, signed-in browser instead of a separate automated one.

WHAT IT DOES
• Reads the page you point it at as a compact text snapshot of its structure (links, buttons, fields, text).
• Clicks, types, fills whole forms, selects options, scrolls, navigates, and opens, switches or closes tabs, when your assistant asks it to.
• Takes screenshots of the tab it is working in, when your assistant asks for one.

YOU STAY IN CONTROL
• Per-site choice: the first time the assistant tries a site, FastLink asks you to Allow or Deny. You can set any site to Allow, Read-only (read, no clicks or typing) or Block.
• An on-page panel shows each step the assistant takes. A side panel shows the assistant's latest reply.
• "Stop driving" pauses everything with one click. "Disconnect relay" cuts the connection.
• Advanced control (on by default, can be turned off in Options): uses Chrome's debugger API only to send real mouse and keyboard input to sites that ignore simulated clicks, and to screenshot a tab that isn't in front. While it is attached, Chrome shows its own "FastLink started debugging this browser" bar. Turn Advanced control off and FastLink uses only normal page scripting.

HOW TO SET IT UP
1. Install FastLink. The setup page opens.
2. Connect this browser: "Sign in & connect" (Google sign-in), or a pairing code from relay.ytx.app/pair/new.
3. Give the browser a name, for example "work-laptop".
4. Connect your assistant once. In claude.ai: Settings → Connectors → Add custom connector → https://relay.ytx.app/mcp. Other apps: add a remote MCP connector with the same address. Claude Code: one command, shown on the setup page.
Then ask your assistant: "Use FastLink to read my current tab."

PRIVACY
FastLink sends page content only when your assistant performs an action. It goes through the FastLink relay (relay.ytx.app, over an encrypted connection) to the assistant app you connected. The relay does not store page content. FastLink does not record your browsing, show ads, sell data, or use data to train models. On claude.ai, FastLink reads the assistant's latest reply to show it in the side panel. That text stays on your device. When you click Allow or Deny in FastLink's panel, FastLink presses the matching button in claude.ai's own permission prompt for you. Full policy: see the privacy policy link on this page. Support: support@ytx.app
```

**Category:** Productivity › Developer Tools

**Language:** English (United States)

**Graphics:**
- Store icon: `store-icon-128.png`
- Screenshots (1280×800, all re-shot from 0.4.13), in order: `1-welcome.png`, `5-ai.png`, `4-sites.png`, `3-behavior.png`, `2-connection.png` (an action shot would be better; see residual risks).
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
| `debugger` | "Advanced control" (on by default, user can turn it off in Options). It uses only these Chrome DevTools Protocol commands on the tab the assistant works in: Input.dispatchMouseEvent, Input.dispatchKeyEvent and Input.insertText (real input for sites that ignore simulated events, e.g. canvas apps and some React/Salesforce widgets), and Page.captureScreenshot (screenshot of a tab that isn't in front). No other domains are used (no Runtime, Network or Storage). Attached on first use per tab; Chrome shows its debugging bar; detaches when the tab closes or the user cancels the bar. |
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
- [x] **Website content:** page text, structure and screenshots of the tab the assistant works in, sent in transit to the user's own assistant. Not stored by the relay.
- [ ] Health, Financial, Personal communications, Location, User activity: leave unticked (they only appear inside "website content" if the user has the assistant work on such a page).

**Certifications:** tick all three.

**Privacy policy URL:**
```
https://github.com/Muzhik613/fastlink/blob/main/fast-ext/store/PRIVACY-POLICY.md
```
(Live; updated 2026-11-08 with the APPENDIX text, 30-day activity-log retention.)

## 4. Distribution
Unlisted · All regions · Free.

## 5. Test instructions
```
Pairing needs only a Google account; step 4 needs a Claude account with custom connectors.
1. Install FastLink. Its setup page opens.
2. Click "Sign in & connect" and sign in with any Google account. Or: open https://relay.ytx.app/pair/new, sign in, copy the code, then use "Use a pairing code" on the setup page. The status turns to Connected.
3. Name the browser (any name).
4. In claude.ai (a plan with custom connectors): Settings → Connectors → Add custom connector → name FastLink, URL https://relay.ytx.app/mcp → Connect → sign in with the same Google account.
5. Open any website in another tab, then ask Claude in claude.ai: "Use FastLink to read my current tab", then "click the first link".
Expected: FastLink asks Allow/Deny for that site; after Allow, an on-page panel shows each step, and Claude answers with the page content and performs the click. The FastLink side panel shows Claude's latest reply.
Without a Claude account you can still verify steps 1–3 and the Options page (per-site Allow/Read-only/Block, Stop driving, Advanced control).
Debugger: used only for real mouse/keyboard input (Input.*) and screenshots of background tabs (Page.captureScreenshot), under "Advanced control" in Options. Chrome's debugging bar appears when it is attached. No remote code is executed.
Contact: support@ytx.app
```

---

## APPENDIX: privacy policy
Applied and published (`fast-ext/store/PRIVACY-POLICY.md`, URL above). The activity-log retention is 30 days, enforced by the relay's daily prune.
