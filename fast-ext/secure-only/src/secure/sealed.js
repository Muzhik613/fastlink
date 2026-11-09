// sealed.js — the sealed-call format (v1) between a driving helper and a locked
// FastLink browser. The relay only forwards these frames; it never holds the key.
//
// Lock key: 32 random bytes, shared once by a human (helper prints it as a 43-char
// base64url "lock code", pasted into the browser's options). From it, HKDF-SHA256
// (salt "fastlink-sealed-v1") derives:
//   info "enc" → AES-256-GCM key
//   info "id"  → 8-byte key id (hex), not secret: lets both ends spot a wrong key
// Frame: { v:1, keyId, nonce, ct } — nonce 12 random bytes, ct = AES-GCM(ciphertext+tag),
// both base64url. AAD binds direction and request:
//   request  "fastlink-sealed-v1|req|<keyId>"            plaintext {seq, ts, action, args}
//   response "fastlink-sealed-v1|res|<keyId>|<seq>"      plaintext = the tool reply
// Uses only WebCrypto (globalThis.crypto.subtle): the extension, Node ≥ 19 and the tests
// run this same file. The Python twin is fast-dxt/server/fastlink_call.py.

export const SEALED_VERSION = 1;
const SALT = 'fastlink-sealed-v1';
const te = new TextEncoder();
const td = new TextDecoder();

export function b64uEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// A fresh lock key, as its lock code.
export function newLockCode() {
  return b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
}

// Lock code → { aesKey, keyId }. Throws on anything that isn't a 32-byte key.
export async function deriveKeys(lockCode) {
  let raw = null;
  try { raw = b64uDecode(String(lockCode || '').trim()); } catch { /* reported below */ }
  if (!raw || raw.length !== 32) throw new Error('a lock code is 43 characters (32 bytes)');
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey', 'deriveBits']);
  const hkdf = (info) => ({ name: 'HKDF', hash: 'SHA-256', salt: te.encode(SALT), info: te.encode(info) });
  const aesKey = await crypto.subtle.deriveKey(hkdf('enc'), base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const id = new Uint8Array(await crypto.subtle.deriveBits(hkdf('id'), base, 64));
  return { aesKey, keyId: [...id].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

function aad(dir, keyId, seq) {
  return te.encode(dir === 'res' ? `${SALT}|res|${keyId}|${seq}` : `${SALT}|req|${keyId}`);
}

// Encrypt `obj` (JSON) as a frame. dir 'req' | 'res'; `seq` binds a response to its request.
export async function seal(keys, dir, obj, seq) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(dir, keys.keyId, seq) },
    keys.aesKey, te.encode(JSON.stringify(obj)),
  );
  return { v: SEALED_VERSION, keyId: keys.keyId, nonce: b64uEncode(nonce), ct: b64uEncode(new Uint8Array(ct)) };
}

// Decrypt a frame → the object. Throws a plain Error (no content) on any mismatch.
export async function unseal(keys, dir, frame, seq) {
  if (!frame || frame.v !== SEALED_VERSION) throw new Error('sealed: unsupported frame version');
  if (frame.keyId !== keys.keyId) throw new Error('sealed: wrong lock key (key ids differ)');
  let pt;
  try {
    pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64uDecode(frame.nonce), additionalData: aad(dir, keys.keyId, seq) },
      keys.aesKey, b64uDecode(frame.ct),
    );
  } catch {
    throw new Error('sealed: frame failed authentication');
  }
  try { return JSON.parse(td.decode(pt)); } catch { throw new Error('sealed: bad plaintext'); }   // never echo it
}
