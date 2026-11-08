# FastLink — Privacy Policy

_Last updated: 2026-11-08_

FastLink is a browser extension that lets **your own** Claude assistant (Claude
Code, Claude Desktop, or claude.ai on the web) read and operate the browser tab
you point it at, on your behalf. This policy explains exactly what data moves,
where it goes, and what is — and isn't — stored.

**Plain-language summary:** FastLink is a pipe between your browser and your
Claude assistant. It does not sell your data, show ads, profile you, or use your
data to train any model. Page content travels only to the Claude assistant you
have connected, so Claude can do what you asked it to do.

---

## Who operates FastLink
FastLink is an independent developer tool. The extension connects to one back
end: the **cloud relay**, a Cloudflare-hosted relay you pair your browser to.
Every Claude assistant you connect (claude.ai on the web, or Claude Code /
Claude Desktop through the FastLink helper) drives your browser through it, so
data sent this way transits the relay. Until you pair, FastLink connects to
nothing. See "Cloud relay" below.

---

## What data FastLink handles

### Page / browsing data (only while you have Claude act)
When you ask Claude to do something with a tab, FastLink may capture and send to
your connected Claude assistant:
- **DOM / accessibility snapshots and visible text** of the active/target tab.
- **Screenshots** of the active/target tab.
- **Results of page JavaScript** your assistant runs, only if you turned on
  "Allow User Scripts" for FastLink in Chrome (see "Your controls").
- **The current tab's URL and title.**

FastLink also watches request start/finish events (read-only) to tell when a page
has finished loading. It never blocks or alters requests, and it does not send
this request data anywhere.

On **claude.ai** tabs, FastLink reads the latest reply from your Claude chat to show
it in FastLink's side panel and on-page indicator. That text stays on your device;
it is not sent to the relay.

This data is captured **on demand**, to fulfill the action you requested through
Claude. FastLink does not continuously record your browsing.

### Credentials and configuration (stored locally on your device)
Stored in `chrome.storage.local` / `chrome.storage.session` on your machine:
- A **device token** — a bearer credential identifying this browser to your own
  relay account (once you pair).
- Relay configuration (relay base URL, your relay user id).
- Connection status for the toolbar UI.

No page content is persisted in extension storage.

---

## Cloud relay: what it stores
Once you pair a browser, the relay (Cloudflare D1 database) stores the
following account/operational data:
- **Account:** your Google account's user id, your email, and account flags.
- **Devices:** your device token(s), each browser's name, and last-seen
  time, so paired browsers can connect and so you can revoke them.
- **Paired machines:** a hash (never the plaintext) of each FastLink helper
  token you create for Claude Code / Claude Desktop, so you can revoke it.
- **Pairing / sign-in:** short-lived one-time pairing codes and magic-link
  records (consumed on use).
- **Per-origin consent:** your `allow` / `readonly` / `block` choice per website
  origin.
- **Audit log:** an append-only record of actions taken (tool name, origin, a
  short argument summary, success/failure) so you can see what was done.

The relay routes live commands and page data between your Claude assistant and your browser
**in transit**; it does not store your page snapshots, screenshots, or page
content as part of normal operation.

---

## What FastLink does NOT do
- ❌ No selling or renting of your data.
- ❌ No advertising and no ad/tracking networks.
- ❌ No use of your data to train any AI model (FastLink-operated).
- ❌ No analytics/telemetry beyond the operational audit log described above.
- ❌ No background or continuous collection — capture happens only when you have
  Claude act.

---

## Data sharing
Your data is shared only as needed to perform the action you requested:
- with **the Claude assistant you connected** (Anthropic's Claude Code / Desktop /
  claude.ai), governed by Anthropic's terms and privacy policy.

No other third parties receive your data.

---

## Your controls
- **Per-origin consent:** set any site to `readonly` (reads only, no actions) or
  `block`.
- **Revoke devices:** revoke a paired browser's device token at any time; the
  relay closes its connection.
- **Unpair / disable:** turn off the cloud relay in the extension options; no
  Claude assistant can drive your browser until you turn it back on.
- **Page JavaScript (`fast_evaluate`) is off by default.** It runs only after you
  turn on Chrome's "Allow User Scripts" switch for FastLink, and only where your
  account's settings allow it.

---

## Data retention
- **On-device:** persists until you unpair, clear extension storage, or remove
  the extension.
- **Relay:** account, device, consent, and audit records persist until you
  delete them / revoke; pairing codes and magic-links are short-lived and
  single-use.

---

## Children
FastLink is a developer tool not directed to children and is not intended for
use by anyone under 13.

## Changes
We will update this policy as the product evolves and revise the "Last updated"
date above.

## Contact
Questions or data requests: **support@ytx.app**
