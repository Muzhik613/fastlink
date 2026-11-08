# Submitting FastLink to the Chrome Web Store

Dashboard: https://chrome.google.com/webstore/devconsole (the Google account that paid the $5).
Every field's text lives in `STORE-LISTING.md` (same folder); this sheet only says what goes where.

## Files (on hvm: `~/fastlink-webstore/`, so the hvm-boss Chrome can upload them)

| Field | File |
|---|---|
| Package | `fastlink-0.4.10.zip` (recommended) or `fastlink-0.4.9.zip`. 0.4.9's welcome page still claims "capture console & network", a feature that no longer exists; 0.4.10 fixes that and pairs new browsers with a device-kind name. 0.4.10 is not yet released to our own browsers; uploading it needs Yaakov's OK for 0.4.10. |
| Store icon (128×128) | `store-icon-128.png` |
| Screenshots (1280×800) | `1-welcome.png`, `2-connection.png`, `3-behavior.png`, `4-sites.png` (taken from the 0.4.10 build, unpaired, no personal data). Source: `fast-ext/store/screenshots/`. |

## Store listing tab (text in `STORE-LISTING.md`)

- Name: FastLink · Category: **Developer Tools** · Language: English (United States)
- Short description: section "Short description" (same as the manifest).
- Detailed description: section "Detailed description".

## Privacy tab

- Single purpose: section "Single-purpose statement".
- Permission justifications: the table in "Permission justifications", one box per permission.
- Remote code: answer **"No, I am not using remote code"**, and paste the "Remote code" paragraph if asked.
- Data use: section "Data-use disclosures"; tick the three certifications.
- Privacy policy URL: https://github.com/Muzhik613/fastlink/blob/main/fast-ext/store/PRIVACY-POLICY.md
  (public, live, no deploy needed). Contact address in it: support@ytx.app. Yaakov: confirm
  that mailbox is read, or tell me which address to use.

## Distribution tab

- Visibility: **Unlisted** (anyone with the link can install; not searchable).
- Regions: all.

## Reviewer notes (Test instructions)

Paste the "Reviewer notes" paragraph from `STORE-READINESS-2026-11.md`.

## Order of steps (one blocker)

1. Create the item and upload the zip as a **draft** (don't submit yet). The dashboard now
   shows the item's **ID**.
2. Send me that ID. The store copy has a new ID, and the relay accepts one-click
   "Sign in & connect" only from our current ID (`EXTENSION_ID` in
   `fastlink-relay/wrangler.toml`). Without a change a reviewer who clicks that button gets an
   error (rejection risk). The fix is a small relay change (accept both IDs), a **relay deploy
   that needs Yaakov's OK**. Pairing codes work either way.
3. After that deploy, fill the tabs above and **Submit for review**.
4. After approval: each browser moves to the store copy once (re-pair with a code, since a
   new ID has no saved pairing), and the self-hosted feed and policy installs are retired.
