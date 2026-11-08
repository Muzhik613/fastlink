# Secure build: owner notes

A special FastLink build for ONE browser that handles sensitive sites. The normal extension
ships these files too, but turned off (`build.js`: `SECURE_BUILD = false`).

## What is fixed, and what is a setting

| Fixed (needs a code change) | Setting (options page; no new build) |
|---|---|
| Every call and reply sealed end to end (`sealed.js`) | **Driver**: whoever holds the lock code. `lock <browser> --replace` on another machine, paste the new code. |
| No unsealed call is ever run; nothing until a lock is set | **Allowed sites** (https, default port). The driving machine may remove sites with a sealed `set_allowlist`; it may add sites only if the owner ticks "Let the driving machine add allowed sites". |
| The relay logs only "sealed, size, ok" | **Page JavaScript** (`fast_evaluate`): off unless the owner ticks it. Page scripts can send data anywhere. Also needs Chrome's "Allow User Scripts" switch. |
| The on-page panel never shows call arguments or error text | |
| Each request carries a deadline; a late request is refused, not run. A timeout means "outcome unknown"; retrying is safe. | |
| `fast_batch` is not available (send steps one by one); `fast_switch`/`fast_close` need a `tabId`; `fast_list` lists allowed tabs only | |

## Files

- `sealed.js`: the format. AES-256-GCM, keys from HKDF-SHA256 over the 32-byte lock key.
  - Request: `{seq, ts, action, args}`. Response: the tool's normal reply.
  - The Python twin is `fast-dxt/server/fastlink_call.py` (`Sealer`).
  - If you change one side, change both: `fast-dxt/test/sealed.test.mjs` checks them
    against each other.
- `lock.js`: the lock state and the call gate.
  - replay window: the last 64 request numbers, plus a ±60 s clock check;
  - allowlist checks, before the call and again after it (redirects);
  - `set_allowlist` and `get_allowlist`.
- `optionsLock.js`: the "Secure browser lock" card on the options page.
- `build.js`: the build flag.

## Build, install, change

```sh
scripts/build-secure.sh                       # runs the tests, writes dist/fastlink-secure/
```

- **Install:** load `dist/fastlink-secure/` unpacked in the browser's own profile, then pair
  it (code from relay.ytx.app/pair/new) with its name. It does not auto-update.
- **Lock:** on the driving machine, `node fast-dxt/server/index.js lock <browser>`. Paste the
  code into options → Secure browser lock, with the allowed sites (`www.bank.com`, or
  `*.bank.com` for the site and its subdomains).
- **Scripts on that machine** seal automatically (`call.js`, `fastlink_call.py`) when a lock
  code exists for the browser.
- **Check:** `fast_status` shows the browser with `secure: true, locked: true`.
- **To change code:** edit, run `cd fast-ext && npm test` and `cd fast-dxt && npm test`,
  rebuild, re-install. The relay never needs to change for code here, unless you change the
  frame fields `{v, keyId, nonce, ct}`.

## Limits

- **Driving machine or browser compromised:** if the driving machine (it holds the key) or
  the browser itself is compromised, the lock does not help.
- **The relay still sees some metadata:** that the browser is used, when, and how much.
- **Calls are capped at about 30 s:** each relay call is limited to that. Split long waits
  into shorter calls.
