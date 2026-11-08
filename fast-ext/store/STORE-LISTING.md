# FastLink — Chrome Web Store Listing

Copy/paste source for the Developer Dashboard. Keep the manifest `description` in
sync with the **Short description** below (Chrome caps the manifest field at 132
characters).

---

## Name
**FastLink**

## Category
**Developer Tools**

## Language
English (United States)

---

## Short description  (≤132 chars — used as manifest `description` too)
> Let Claude read and control your active Chrome tab — snapshot the DOM, click, fill forms, and run multi-step batches.

(Same as the manifest `description`.)

---

## Detailed description

**Give Claude hands in your browser.**

FastLink connects your own Claude assistant — Claude Code, Claude Desktop, or
claude.ai on the web — to the Chrome tab you're working in, so Claude can
actually *do* things instead of just describing them: read the page, click
buttons, fill out forms, and navigate.

**What you can do**
- 🔎 **Read any page** — Claude gets a structured snapshot of the DOM and visible
  text, or a screenshot, so it understands what's on screen.
- 🖱️ **Real interactions** — click, type, fill forms, select options, scroll,
  and press keys, delivered as *trusted* input so strict sites behave normally.
- 🧭 **Navigate** — open, reload, and move between tabs on your instruction.
- ⏱️ **Wait** — wait for text to appear or the page to go idle before acting.
- 📸 **Screenshots** — for elements outside the DOM (canvas, cross-origin frames),
  Claude reads a screenshot and clicks by coordinate.

**One sign-in, every assistant**
Pair your browser to your FastLink relay account once. claude.ai on the web,
and Claude Code / Claude Desktop through the FastLink helper, can then drive it,
each on its own tab.

**Privacy-first**
FastLink captures page data only when you have Claude act — it doesn't record
your browsing. No ads, no data selling, no model training on your data. Set any
site to read-only or block it entirely, and revoke paired browsers anytime.
Arbitrary-JavaScript execution is off by default. Full policy:
see the Privacy Policy linked in this listing.

**Who it's for**
Developers, power users, and anyone who wants their Claude assistant to operate a
real browser — testing web apps, filling repetitive forms, navigating consoles,
or automating multi-step tasks.

> FastLink is an independent tool that works alongside Anthropic's Claude. It is
> not affiliated with or endorsed by Anthropic or Google.

---

## Single-purpose statement  (Dashboard → Privacy)
> FastLink has a single purpose: to let the user's own Claude assistant observe
> and operate the user's active browser tab on the user's behalf — reading page
> content and performing clicks, form fills, and navigation that the user
> initiates through Claude.

---

## Permission justifications  (Dashboard → Privacy → per-permission boxes)
Paste the matching one-liners (full detail in `PERMISSIONS-JUSTIFICATION.md`):

| Permission | Justification (short) |
|---|---|
| `tabs` | Identify, navigate, reload, and read metadata for the tab Claude is driving. |
| `scripting` | Inject the in-page bridge that builds DOM/accessibility snapshots and runs user-requested page reads. |
| `activeTab` | Capture/script the currently focused tab on user action. |
| `storage` | Store the user's relay device token, relay config, browser name, and connection state locally. |
| `alarms` | Revive the MV3 service worker to keep the relay connection alive and reconnect. |
| `webRequest` | Observe (read-only) request start/finish to detect when a page has gone idle. No blocking/modification. |
| `debugger` | Trusted input (CDP) for strict sites, screenshots of non-foreground tabs, and the user-enabled page-JS tool. The "debugging this browser" bar shows while it is attached. |
| `identity` | One-click sign-in to the user's own relay account (`launchWebAuthFlow`) to pair this browser without copy-pasting a code. Manual code paste is the fallback. |
| `host_permissions <all_urls>` | The user points Claude at arbitrary sites; hosts can't be known in advance. Mitigated by per-origin consent + audit log. |

**Remote code:** all extension logic ships in the package. `fast_evaluate` runs page
JavaScript written by the user's own assistant, in the page (never in the extension),
only when the account enables it and per origin. Declare this in the review notes. Risk
assessment: `STORE-READINESS-2026-11.md`.

---

## Data-use disclosures  (Dashboard → Privacy → "What user data do you collect")
Check and disclose:
- **Web history / Website content** — page content/snapshots are sent to the
  user's Claude assistant to perform the requested
  action. _Not_ sold; _not_ used for ads; _not_ used for unrelated purposes.
- **Authentication information** — the relay device token (the user's own
  account credential), stored locally.

Certify: data is **not** sold to third parties; data use is limited to the single
purpose; data is **not** used for creditworthiness/lending.

---

## Privacy policy URL
Host `PRIVACY-POLICY.md` at a public URL and paste it here (e.g. the relay site
`/privacy` or a GitHub Pages URL). **Required before submission.**

---

## Assets checklist
- [ ] **Store icon** — 128×128 PNG. ✅ have `icons/icon-128.png` (and 256/512 if a
      larger source is needed).
- [ ] **Screenshots** — 1280×800 (or 640×400), PNG/JPEG, **at least 1**, up to 5.
      Suggested shots:
  1. The toolbar popup showing "Cloud relay — Connected".
  2. The options page (pair-a-relay screen).
  3. Claude driving a real page (e.g. a form being filled) with the FastLink
     activity overlay visible.
- [ ] **Small promo tile** — 440×280 PNG (optional but recommended).
- [ ] **Marquee promo tile** — 1400×560 PNG (optional).
- [ ] **Category:** Developer Tools.
- [ ] **Language:** English (US).

> Note: FastLink uses the name "Claude". Anthropic trademark — keep the
> "independent tool, not affiliated with/endorsed by Anthropic" disclaimer in the
> description to reduce brand-impersonation review risk.

---

## Testing notes (before publish / for QA)
- **CDP `debugger` path:** when the optional `debugger` permission is granted,
  Chrome shows a "…is debugging this browser" infobar in the target tab, and some
  anti-bot/anti-fraud sites (banking, ticketing) may detect the active debugger
  and block or degrade behavior. **Test trusted-input + background-tab capture
  against the primary target sites** before relying on it; verify the
  non-debugger fallback (captureVisibleTab + synthetic events) on those origins.
- Verify the default install (no `debugger` granted) works for read/snapshot/
  navigate, and that opting into the power-user feature triggers the runtime
  permission prompt.

## Pre-submission checklist
- [ ] Manifest `description` ≤132 chars and matches Short description. ✅ fixed.
- [ ] Icons 16/32/48/128 present in manifest + package. ✅
- [ ] Version bumped if resubmitting.
- [ ] Privacy policy hosted + URL added.
- [ ] All permission justifications pasted.
- [ ] Single-purpose + data-use disclosures completed.
- [ ] Built zip via `scripts/package.sh`, test-loaded unpacked from the staging
      output, confirmed it connects.
- [ ] If `identity` permission was added by the auth work, add its justification
      (text ready in `PERMISSIONS-JUSTIFICATION.md`).
