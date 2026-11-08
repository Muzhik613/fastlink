# Chrome Web Store readiness (0.4.8, checked 2026-11-07)

Package: `bash fast-ext/scripts/package.sh` → `fast-ext/dist/fastlink-0.4.8.zip` (49 files,
280 KB). The store copy of the manifest drops `key` and `update_url` (the store rejects
`key` and serves updates itself). Listing, permission and privacy text: `STORE-LISTING.md`,
`PERMISSIONS-JUSTIFICATION.md`, `PRIVACY-POLICY.md`.

## Design for approval (branch `store-ready`, 11-07; not released)

What changed for the store, and why:

1. **`fast_evaluate` moved to `chrome.userScripts.execute`.** This is the Web Store's
   sanctioned API for user-provided code. Both old paths are deleted: CDP `Runtime.evaluate`
   and the `chrome.scripting` + `(0, eval)` fallback. The package now has no `eval`,
   `new Function` or `Runtime.evaluate`. The tool is off until the user turns on **Allow User
   Scripts** on FastLink's details page; until then it returns how to turn it on. Tested
   11-07 on Chromium 156 (off before the toggle; async results; page variables; works on
   github.com, whose CSP blocked the old fallback).
2. **`activeTab` removed.** It was redundant with `<all_urls>`, and leftover permissions
   draw rejections.
3. **`minimum_chrome_version: 135`** (`userScripts.execute`).
4. **Store package** drops `key` and `update_url` (`scripts/package.sh`).

Kept, with reasons:
- `debugger`: trusted input on sites that ignore synthetic events, and screenshots of
  background tabs. No code evaluation goes through it any more. Making it optional (asked at
  runtime) would lower the install warning, but every automation would silently lose
  trusted input until someone clicks a button. Not done; it is Yaakov's call.
- `<all_urls>` and content scripts on all sites: the user points the assistant at any site.
  This draws in-depth review (days, not hours), not rejection.

## Risk per feature (estimate after the redesign)

| Feature | Estimate | Note |
|---|---|---|
| `fast_evaluate` via `userScripts` | **Medium-low risk** (was about 50/50) | It is the API built for this and the opt-in is Chrome's own toggle. Open point: `userScripts` is meant for code the *user* provides; ours is written by the user's own assistant and arrives through our relay. If review objects, drop `fast_evaluate` from the extension; nothing else depends on it. |
| `debugger` | **Likely pass**, in-depth review, install warning | Justification states exactly which CDP domains (Input, Page.captureScreenshot). |
| `<all_urls>` + content scripts | **Likely pass**, in-depth review | Single purpose: the user's own assistant drives the user's own tab. |
| Remote commands (click, fill, nav) | **Low risk** | Fixed actions shipped in the package, not an interpreter; comparable agent extensions are listed. |
| `webRequest` (read-only, idle detection) | **Pass** | |
| claude.ai reader script | **Pass with disclosure** | "Website content" disclosed. |
| `cookies` | n/a | Not requested. |
| Name "Claude" | **Low risk** | Keep the "not affiliated" line. |

Cost of the redesign: on every browser, fast_evaluate needs that one toggle once (svm-ytx,
hvm-boss, the laptop profiles…). Everything else works without it.

## Reviewer notes (paste into the dashboard's notes for the reviewer)

> FastLink lets the user's own AI assistant (Claude) operate the user's own browser tab:
> read the page, click, type, fill forms, navigate. Commands come from the user's own relay
> account (relay.ytx.app), which the user pairs this browser to with a one-time code. Every
> action is a fixed function shipped in the package. FastLink never evaluates strings: there
> is no eval, no new Function and no CDP Runtime.evaluate. The one feature that runs
> user-provided page JavaScript uses chrome.userScripts.execute, and only after the user
> turns on "Allow User Scripts" for FastLink. The debugger permission is used only for
> trusted input events (Input.dispatchMouseEvent / dispatchKeyEvent) and for screenshots of
> background tabs (Page.captureScreenshot). Test account: pair with a code from
> https://relay.ytx.app/pair/new (we can provide a reviewer account on request).

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
6. **Review the `store-ready` branch** (fast_evaluate on userScripts, activeTab gone) and
   OK releasing it as 0.4.9 to all browsers first (so the store copy and ours stay one code).
7. **OK the submission.** After approval, OK the relay change for the new ID (one-click
   sign-in), then the per-browser move.
