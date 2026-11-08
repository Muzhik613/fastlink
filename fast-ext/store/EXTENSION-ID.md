# FastLink — Stable Extension ID

The extension ships a fixed `"key"` in `manifest.json` so its ID is identical across
unpacked loads, the signed CRX on the self-hosted feed, and the secure build. The Chrome
Web Store copy is the exception: the store zip has no `key` (the store rejects it), so the
store assigns its own ID. The relay accepts that one too once it is added with
`POST /admin/extension-ids` (see LISTING.md).

## The values

| | |
|---|---|
| **Extension ID** | `ockcjadbkdfgfllidpcoamcepahfmlpf` |
| **identity redirect URI** | `https://ockcjadbkdfgfllidpcoamcepahfmlpf.chromiumapp.org/` |
| **Manifest `key`** | the base64 public key in `manifest.json` (`key` field) |

## Who depends on it
- **ext-auth** — `chrome.identity.getRedirectURL()` resolves to the redirect URI
  above; passed to the relay as `redirect_uri`.
- **relay-auth** — the relay's `/ext/authorize` `redirect_uri` allowlist accepts
  `EXTENSION_ID` (wrangler.toml, this ID) plus any ID added with `/admin/extension-ids`
  (the store copy's).

## Where the private key lives
- Private key (PEM): `<repo>/fastlink-extension-signing-key.pem`
  — **outside** `fast-ext/`, gitignored, never packaged. KEEP SECRET. Whoever
  uploads to the Chrome Web Store needs this so the published ID matches.
- The `key` field in `manifest.json` is only the **public** half — safe to commit.

## How these were derived
```sh
# manifest "key" = base64 of the DER-encoded SPKI public key
openssl rsa -in fastlink-extension-signing-key.pem -pubout -outform DER | base64 -w0

# extension ID = first 16 bytes of sha256(DER SPKI), hex digits mapped 0-f -> a-p
openssl rsa -in fastlink-extension-signing-key.pem -pubout -outform DER \
  | openssl dgst -sha256 -binary | xxd -p -c256 | head -c32 | tr '0-9a-f' 'a-p'
```

## Status
⚠️ **Pending human ratification** (SIGNUP-SPEC §7 open question #1). This is a
ready, working keypair so relay-auth/ext-auth are unblocked. If the human wants a
different key (e.g. generated in the CWS dashboard on first upload), regenerate
and update: the `key` in `manifest.json`, this file, and the relay allowlist. As
long as nothing has been published yet, swapping the key is free.
