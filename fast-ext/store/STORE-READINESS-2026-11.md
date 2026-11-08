# Chrome Web Store readiness (0.4.8, checked 2026-11-07)

Package: `bash fast-ext/scripts/package.sh` → `fast-ext/dist/fastlink-0.4.8.zip` (49 files,
280 KB). The store copy of the manifest drops `key` and `update_url` (the store rejects
`key` and serves updates itself). Listing, permission and privacy text: `STORE-LISTING.md`,
`PERMISSIONS-JUSTIFICATION.md`, `PRIVACY-POLICY.md`.

## Risk per feature (estimate)

| Feature | How it works | Estimate | To pass |
|---|---|---|---|
| `fast_evaluate` | JS source text arrives from the relay. Main path: `chrome.debugger` → CDP `Runtime.evaluate` in the page. Fallback: `chrome.scripting.executeScript` (MAIN world) running `(0, eval)(fnStr)` in the page (`src/actions/evaluate.js`). Nothing is evaluated in the extension's own context. | **High risk, about 50/50.** The policy bans running "a string fetched from a remote source" with eval or similar, and the `eval` in the fallback is easy for review to spot. The code runs in the page, not in the extension, and comes from the user's own assistant, but review may not accept that difference. | 1) Delete the `eval` fallback and keep the debugger path only, so no `eval`/`new Function` is left in the package. 2) Declare it in the review notes: user-initiated page JS, off per account (`allow_evaluate`) and gated per origin. 3) If it is still rejected, remove `fast_evaluate` from the extension altogether (no second build). |
| `debugger` | Required permission today (trusted input, background-tab screenshots, evaluate). | **Likely pass**, with in-depth review (slower) and an install warning. | Justification text is ready. The listing calls it "optional"; that is wrong today. Either move it to `optional_permissions` or fix the text (fixed in the listing). |
| `<all_urls>` host + content scripts on all URLs (one in the MAIN world) | Needed to act on any site the user points Claude at. | **Likely pass**, in-depth review. | Justification ready; per-origin consent and read-only/block modes help. |
| Remote control as a whole (fixed commands from the relay: click, fill, nav…) | The policy also bans "an interpreter to run complex commands fetched from a remote source". | **Low to medium risk.** Comparable agent-driven extensions (Claude in Chrome, Browser MCP) are on the store. | Make the single purpose explicit: the user's own assistant drives the user's own tab. |
| `webRequest` on `<all_urls>` | Read-only request start/end, used to detect page idle. | **Pass** | Fix the justification: it says "network logs" (that tool no longer exists). |
| claude.ai content script (`claudeScrape.js`) | Reads the assistant's reply text on claude.ai and shows it in the side panel/overlay. | **Pass with disclosure** | Disclose "website content" under data use (already listed). |
| `cookies` | Not requested. | n/a | — |
| `identity`, `tabs`, `scripting`, `storage`, `alarms`, `webNavigation`, `notifications`, `sidePanel`, `activeTab` | All used (`activeTab` is redundant with `<all_urls>`). | **Pass** | Optionally drop `activeTab`, so it can't be flagged as an extra permission. |
| Name "Claude" in the listing | Trademark. | **Low risk** | Keep the "not affiliated with Anthropic" line. |

## Extension ID and pairings

- The store assigns its own ID on first upload. There are reports that a first upload can
  keep the existing ID (`ockcjadbkdfgfllidpcoamcepahfmlpf`) by including the private key, but
  it is unconfirmed. Plan for a **new ID**.
- Pairings do NOT carry over to a new ID: the relay pairing lives in `chrome.storage`, which
  Chrome keys by extension ID. Each browser pairs once again (code from
  `relay.ytx.app/pair/new`). Revoke its old entry first so it can keep its name. Then remove
  the old (policy or unpacked) copy, so two FastLinks don't both connect.
- The relay mostly doesn't care about the ID: device tokens and pairing codes don't check it.
  Two features pin it (`EXTENSION_ID` in `fastlink-relay/wrangler.toml`): one-click sign-in
  (`/ext/authorize` accepts only that ID's `chromiumapp.org` redirect), and the deep link on
  the pairing page. With a new ID both need a relay change (accept the store ID), which is a
  relay deploy needing Yaakov's OK. Code paste works without it.
- The policy feed (`release/updates.xml`) and the store copy would be two update channels.
  After the switch, retire the feed and the policy installs (replace, don't layer).

## What Yaakov must do

1. **Account:** sign in at https://chrome.google.com/webstore/devconsole with the Google
   account that should own FastLink. Pick it deliberately, because moving ownership later is
   painful. A Workspace account on ytx.app allows a group publisher and a "private to the
   ytx.app domain" listing.
2. **Fee:** pay the one-time $5 registration if this account hasn't already. Verify the
   contact email.
3. **Visibility:**
   - **Unlisted:** anyone with the link can install it. Works for Muse, family and Alex
     with no accounts to manage. Recommended.
   - **Private:** only listed testers' Google accounts, or members of a Google Group, can
     install it. Every user must be added, and each must use that Google account in Chrome.
4. **Privacy policy URL:** host `PRIVACY-POLICY.md` (for example on the ytx site) and paste
   the URL.
5. **Screenshots:** at least one at 1280×800.
6. **Decide `fast_evaluate`:** remove the eval fallback (recommended before submitting), or
   remove the tool.
7. **OK the submission.** After approval, OK the relay change for the new ID (one-click
   sign-in), then the per-browser move.
