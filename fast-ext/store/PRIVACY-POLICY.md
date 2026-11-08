# FastLink: Privacy Policy
_Last updated: 2026-11-08_

FastLink is a browser extension that lets an AI assistant you already use (for example Claude Code, claude.ai, or another app that supports remote MCP connectors) read and operate the Chrome tabs you point it at, on your behalf. FastLink is an independent tool, not affiliated with Anthropic, Google or any AI company.

## Summary
FastLink is a pipe between your browser and the AI assistant you connect. It does not sell your data, show ads, profile you, or use your data to train any model.

## What FastLink handles, and when
Only when your assistant performs an action you asked for, FastLink captures and sends to that assistant:
- the text and structure (links, buttons, form fields) of the tab it works in;
- screenshots of that tab;
- the URL and title of your open tabs when the assistant lists or switches tabs.

FastLink also watches request start/finish events in the browser to tell when a page has finished loading. This is never stored or sent anywhere.

On claude.ai, FastLink reads the assistant's latest reply to show it in FastLink's side panel. That text stays on your device. When you click Allow or Deny in FastLink's panel, FastLink presses the matching button in claude.ai's permission prompt.

## Where data goes
- **FastLink relay (relay.ytx.app, hosted on Cloudflare).** Commands and page data pass through it, encrypted in transit (HTTPS/WSS), between your browser and your assistant. The relay does not store page content or screenshots.
- **The AI app you connect** (for example Anthropic's Claude, or any other app you add as a connector). It receives the page data your request needs, under that provider's own terms and privacy policy.
- **Google**, only to sign you in (we receive your email address and account ID).

No one else receives your data.

## What is stored
On your device (chrome.storage): this browser's pairing token, the relay address, and your settings. No page content.

On the relay:
- Account: Google account ID and email address.
- Devices: each paired browser's token, name and last-seen time.
- Helper tokens for Claude Code: stored only as a hash.
- Your per-site choices (Allow / Read-only / Block).
- Activity log: for each action, the action name, the argument names (never their values), the site's origin, the browser name, and success or failure. It is used for security and troubleshooting.
- Pairing codes and sign-in links: short-lived and single-use.

## Retention and deletion
On-device data stays until you remove the extension or clear its storage. Relay account, device and site-choice records stay until you ask us to delete them. The activity log is deleted automatically after 30 days, and expired pairing codes after a day. To delete your account and all relay data, email support@ytx.app from your account's address; we delete it within 30 days.

## Your controls
- Allow, Read-only or Block any site; FastLink asks before the assistant first uses a new site.
- "Stop driving" pauses all actions; "Disconnect relay" disconnects this browser; removing the extension deletes its local data.
- Advanced control (Chrome debugger: real mouse/keyboard input and background-tab screenshots) can be turned off in Options.

## Limited Use
The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Children
FastLink is not directed to children under 13.

## Changes and contact
We update this page when practices change and revise the date above. Questions or data requests: support@ytx.app
