# Captcha hand-off (`fast_handoff`)

An agent never solves a captcha or "are you human" check. It hands the check to the user's
phone, where the user solves it, and FastLink passes their taps through.

## For agents

1. A `fast_snapshot` (or an action's snapshot) on a page with a captcha frame carries
   `captcha: "… call fast_handoff …"`. The tool description and server instructions say the
   same.
2. Call `fast_handoff` with the same `tabId` (the helper fills it). Optional: `note` (one line
   above the check), `minutes` (1-30, default 10), `region` (`{x,y,w,h}`, viewport CSS px) only
   if the check is not found automatically (`found: false`).
3. Send the user the returned `url`. Do not touch that tab meanwhile.
4. Call `fast_handoff_wait {handoffId}` (up to 25 s per call) until `status` is `done` or
   `expired`. After `done`, read the page to confirm it passed.
5. No longer needed (the check went away, or was solved another way)? `fast_handoff_cancel
   {handoffId}` ends the link at once.

## What the person gets

- **The page:** `https://relay.ytx.app/h/<token>` shows only the challenge (the browser clips
  the picture itself). It refreshes about 3 times a second while open.
- **Taps:** a tap becomes a real click at that spot in the tab, one tap at a time.
- **Health:** the view goes grey with "Reconnecting…" when there is no fresh picture.
- **Done:** asks for confirmation, then ends the link.

## Limits and safety

- **One device:** the first device that opens the page owns the link; any other gets "already
  open on another device". A chat app's link preview doesn't claim it.
- **Time:** 30 minutes at most. The link ends at Done or expiry.
- **Scope:** only the tab it was made for, and only while that tab is on the same site.
- **Taps:** only inside the shown region.
- **Token:** 32 random bytes; the relay stores only its SHA-256.
- **Log:** open, each tap (coordinates), Done and expiry go to the activity log.
- **Browsers:** needs FastLink 0.4.16+. Not available on locked secure browsers (Aliya).

## Code

- **Relay:** `fastlink-relay/src/handoff.js` (tools, `/h/` route, phone page).
- **Extension:** `fast-ext/src/actions/handoff.js` (`handoff_frame`, `handoff_tap`).
- **Tests:** `fastlink-relay/test/handoff.test.mjs`.
