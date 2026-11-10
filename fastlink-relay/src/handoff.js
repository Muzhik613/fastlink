// Human hand-off (fast_handoff / fast_handoff_wait). An agent that meets a captcha it must not
// solve asks for a short-lived link; the person opens it on their phone, sees ONLY the
// challenge region of that one tab (cropped and clipped in the browser: handoff_frame), and
// their taps become real clicks there (handoff_tap). The agent never solves the check.
//
// Flow:  agent → fast_handoff (DO: record + first frame) → link https://<relay>/h/<token>
//        phone → worker /h/<token>[/state|/frame|/tap|/done] → KV token-hash → user's DO
//        agent → fast_handoff_wait → pending | done | expired
// Safety: the token is 32 random bytes and only its SHA-256 is stored; the link is bound to the
// first device that runs the page (cookie), works for ≤30 min, ends at Done, acts only on the
// tab and site it was made for (expectOrigin), shows only the challenge region, accepts taps
// only inside that region, one at a time, and every open/tap/done is in the activity log.

export const HANDOFF_MAX_MIN = 30;
const HANDOFF_DEFAULT_MIN = 10;
const FRAME_MIN_GAP_MS = 300;      // at most ~3 captures/s, and only while the page polls
const LIVE_MS = 5000;              // no fresh picture for this long → the page says Reconnecting
const KV_PREFIX = 'handoff:';
const REC_PREFIX = 'handoff:';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const unwrap = (p) => (p && typeof p === 'object' && 'error' in p ? p : (p?.result ?? p));
const tooOld = (e) => /Unknown action: handoff_/.test(String(e || ''));
const OLD_EXT = 'This browser runs a FastLink version without hand-off (needs 0.4.16 or newer). Reload the FastLink extension in that browser to update, then retry.';

// In-memory per-handoff state (frames are never stored durably).
function mem(relay, id) {
  if (!relay.handoffMem) relay.handoffMem = new Map();
  let m = relay.handoffMem.get(id);
  if (!m) relay.handoffMem.set(id, (m = { frame: null, seq: 0, crops: new Map(), inflight: null, tapBusy: 0, err: null }));
  return m;
}
const recKey = (id) => REC_PREFIX + id;
async function loadRec(relay, id) { return (await relay.ctx.storage.get(recKey(id))) || null; }
async function saveRec(relay, rec) { await relay.ctx.storage.put(recKey(rec.id), rec); }

// Expire lazily on every touch; an ended hand-off forgets its token at once.
async function settleExpiry(relay, rec) {
  if (rec.status === 'pending' && Date.now() > rec.exp) {
    rec.status = 'expired';
    await saveRec(relay, rec);
    await endToken(relay, rec);
    relay.audit('handoff_expired', {}, true, { name: rec.browser });
  }
  return rec;
}
async function endToken(relay, rec) {
  try { await relay.env.OAUTH_KV.delete(KV_PREFIX + rec.key); } catch { /* expires by TTL anyway */ }
  relay.handoffMem?.delete(rec.id);
}

function decodeDataUrl(u) {
  const b64 = String(u || '').replace(/^data:[^,]*,/, '');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The newest picture, plus the crops of the last few, so a tap is mapped with the crop of the
// picture the person actually saw (the phone is often a frame or two behind).
function setFrame(m, r) {
  m.frame = { bytes: decodeDataUrl(r.dataUrl), crop: r.crop, seq: ++m.seq, at: Date.now() };
  m.crops.set(m.frame.seq, r.crop);
  for (const k of m.crops.keys()) if (k < m.frame.seq - 20) m.crops.delete(k);
}

async function capture(relay, rec) {
  const target = await relay.resolveTarget(rec.browser);
  if (target.error) return { error: `Browser "${rec.browser}" is not connected.` };
  const args = { tabId: rec.tabId, ...(rec.region ? { region: rec.region } : {}), ...(rec.origin ? { expectOrigin: rec.origin } : {}) };
  const r = unwrap(await relay.callExtension('handoff_frame', args, 10000, target));
  if (r?.error) return { error: tooOld(r.error) ? OLD_EXT : r.error, siteChanged: !!r.siteChanged };
  return r;
}

// Start a capture unless one is running or the last is fresh. Not awaited by the page's poll.
function kick(relay, rec) {
  const m = mem(relay, rec.id);
  if (m.inflight || (m.frame && Date.now() - m.frame.at < FRAME_MIN_GAP_MS)) return;
  m.inflight = (async () => {
    try {
      const r = await capture(relay, rec);
      if (r.error) { m.err = r.error; m.siteChanged = r.siteChanged; return; }
      m.err = null; m.siteChanged = false; m.found = !!r.found;
      if (r.dataUrl && r.crop) setFrame(m, r);
      else m.frame = m.frame && { ...m.frame, at: Date.now(), gone: true };
    } catch (e) { m.err = e?.message || String(e); }
  })().finally(() => { m.inflight = null; });
}

// ---- agent side (called from mcp.js) -------------------------------------------------------

export async function handoffCreate(relay, target, args, { origin, relayOrigin }) {
  const minutes = Math.min(HANDOFF_MAX_MIN, Math.max(1, Number(args.minutes) || HANDOFF_DEFAULT_MIN));
  const region = args.region && typeof args.region === 'object' ? args.region : null;
  // The first frame binds the tab (the call's own tabId, else the target tab) and proves the
  // browser can do it. Nothing is created if it can't.
  const first = unwrap(await relay.callExtension('handoff_frame', { ...(typeof args.tabId === 'number' ? { tabId: args.tabId } : {}), ...(region ? { region } : {}) }, 15000, target));
  if (first?.error) return { error: tooOld(first.error) ? OLD_EXT : first.error };
  if (typeof first?.tabId !== 'number') return { error: 'The browser did not say which tab it read; nothing was created.' };

  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const key = await sha256hex(token);
  const id = key.slice(0, 16);
  const now = Date.now();
  const rec = {
    id, key, tabId: first.tabId, browser: target.name, origin: origin || null, region,
    note: typeof args.note === 'string' ? args.note.slice(0, 200) : null,
    created: now, exp: now + minutes * 60000, status: 'pending', taps: 0, viewer: null,
  };
  await saveRec(relay, rec);
  await relay.env.OAUTH_KV.put(KV_PREFIX + key, JSON.stringify({ userId: relay.userId, id }), { expirationTtl: Math.max(60, minutes * 60 + 60) });
  const m = mem(relay, id);
  m.found = !!first.found;
  if (first.dataUrl && first.crop) setFrame(m, first);
  relay.audit('fast_handoff', { tabId: rec.tabId, minutes }, true, target);
  return {
    handoffId: id,
    url: `${relayOrigin}/h/${token}`,
    expiresAt: new Date(rec.exp).toISOString(),
    tabId: rec.tabId,
    found: !!first.found,
    hint: first.found
      ? 'Send the url to the user (it works on one device, until Done or expiry), then call fast_handoff_wait with handoffId. Do not touch this tab meanwhile.'
      : 'No captcha frame is visible in that tab yet. The page will show it once it appears; or call again with region. Send the url, then call fast_handoff_wait.',
  };
}

export async function handoffWait(relay, args) {
  const id = String(args.handoffId || '');
  const until = Date.now() + Math.min(25, Math.max(0, Number(args.waitSec ?? 20))) * 1000;
  for (;;) {
    const rec = await loadRec(relay, id);
    if (!rec) return { error: `No hand-off "${id}".` };
    await settleExpiry(relay, rec);
    if (rec.status !== 'pending' || Date.now() >= until) {
      return { handoffId: id, status: rec.status, taps: rec.taps, expiresAt: new Date(rec.exp).toISOString(),
        ...(rec.status === 'pending' ? { hint: 'Still open; call fast_handoff_wait again.' } : rec.status === 'done' ? { hint: 'The person tapped Done. Read the page (fast_snapshot) to confirm the check passed.' } : {}) };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// ---- phone side: the worker resolves the token, the DO answers ---------------------------

const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', ...NOCACHE, ...extra } });
const NOCACHE = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex', 'x-content-type-options': 'nosniff' };
const cookieName = (id) => `fh_${id}`;
function readCookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

// Worker entry: /h/<token>[/op]. Unknown or ended tokens are a plain 404 (no oracle).
export async function handleHandoffRoute(request, env) {
  const url = new URL(request.url);
  const [, , token, op = '', extra] = url.pathname.split('/');
  const nf = () => new Response('This link has ended or is not valid.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...NOCACHE } });
  if (!token || token.length < 40 || extra !== undefined || !['', 'state', 'frame', 'tap', 'done'].includes(op)) return nf();
  const key = await sha256hex(token);
  let entry = null;
  try { entry = JSON.parse((await env.OAUTH_KV.get(KV_PREFIX + key)) || 'null'); } catch { entry = null; }
  if (!entry?.userId || !entry?.id) return nf();
  if (op === '') return page(token);
  const stub = env.USER_RELAY.get(env.USER_RELAY.idFromName(String(entry.userId)));
  const fwd = new URL(url.origin + '/__handoff');
  fwd.searchParams.set('id', entry.id);
  fwd.searchParams.set('op', op);
  return stub.fetch(new Request(fwd, {
    method: request.method,
    headers: { 'content-type': 'application/json', 'X-Handoff-Key': key, cookie: request.headers.get('cookie') || '', 'X-Fastlink-User-Id': String(entry.userId) },
    body: request.method === 'POST' ? (await request.text()).slice(0, 1000) : undefined,
  }));
}

// DO entry (/__handoff). Reached only from handleHandoffRoute, which proved the token.
export async function handoffRequest(relay, request) {
  const url = new URL(request.url);
  const id = url.searchParams.get('id') || '', op = url.searchParams.get('op') || '';
  const rec = await loadRec(relay, id);
  if (!rec || rec.key !== request.headers.get('X-Handoff-Key')) return json({ status: 'ended' }, 404);
  await settleExpiry(relay, rec);
  if (rec.status !== 'pending') return json({ status: rec.status });

  // One device: the first page that polls claims the link (a chat app's link preview fetches
  // only the HTML and never polls, so it can't claim it).
  const cookie = readCookie(request, cookieName(id));
  let setCookie = {};
  if (!rec.viewer) {
    const v = b64url(crypto.getRandomValues(new Uint8Array(18)));
    rec.viewer = await sha256hex(v);
    await saveRec(relay, rec);
    relay.audit('handoff_open', {}, true, { name: rec.browser });
    setCookie = { 'set-cookie': `${cookieName(id)}=${v}; Path=/h/; Max-Age=${HANDOFF_MAX_MIN * 60}; Secure; HttpOnly; SameSite=Strict` };
  } else if (!cookie || (await sha256hex(cookie)) !== rec.viewer) {
    return json({ status: 'elsewhere' }, 403);
  }

  const m = mem(relay, id);
  if (op === 'state') {
    kick(relay, rec);
    const live = !!m.frame && !m.err && (Date.now() - m.frame.at < LIVE_MS || (m.tapBusy && Date.now() - m.tapBusy < 15000));
    return json({ status: 'pending', live, tapping: !!m.tapBusy, seq: m.frame && !m.frame.gone ? m.frame.seq : 0, found: !!m.found,
      ...(m.siteChanged ? { why: 'The page moved to another site.' } : m.err ? { why: 'Reconnecting to the browser…' } : {}) }, 200, setCookie);
  }
  if (op === 'frame') {
    if (!m.frame || m.frame.gone) return new Response(null, { status: 204, headers: NOCACHE });
    return new Response(m.frame.bytes, { headers: { 'content-type': 'image/jpeg', 'x-seq': String(m.frame.seq), ...NOCACHE } });
  }
  if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
  let body = {};
  try { body = JSON.parse(await request.text()); } catch { body = {}; }
  if (op === 'done') {
    rec.status = 'done';
    await saveRec(relay, rec);
    await endToken(relay, rec);
    relay.audit('handoff_done', {}, true, { name: rec.browser });
    return json({ ok: true, status: 'done' });
  }
  if (op === 'tap') {
    const { fx, fy, seq } = body;
    const crop = m.frame && !m.frame.gone ? m.crops.get(seq) : null;   // the crop of the picture the person saw
    if (!crop) return json({ error: 'stale' }, 409);
    if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return json({ error: 'outside' }, 400);
    if (m.tapBusy) return json({ error: 'busy' }, 429);
    const x = Math.round(crop.x + fx * crop.w), y = Math.round(crop.y + fy * crop.h);
    m.tapBusy = Date.now();
    try {
      const target = await relay.resolveTarget(rec.browser);
      if (target.error) return json({ error: 'offline' }, 503);
      const r = unwrap(await relay.callExtension('handoff_tap', { tabId: rec.tabId, x, y, ...(rec.origin ? { expectOrigin: rec.origin } : {}) }, 10000, target));
      const ok = !r?.error;
      rec.taps += 1;
      await saveRec(relay, rec);
      relay.audit('handoff_tap', { x, y }, ok, target);
      return ok ? json({ ok: true }) : json({ error: r.siteChanged ? 'moved' : 'failed' }, 502);
    } finally {
      m.tapBusy = 0;
      if (m.frame) m.frame.at = 0;   // the next poll captures the result of the tap
    }
  }
  return json({ error: 'not found' }, 404);
}

// ---- the phone page -------------------------------------------------------------------------

function page(token) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const html = PAGE_HTML.replaceAll('__NONCE__', nonce);
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8', ...NOCACHE,
      'content-security-policy': `default-src 'none'; img-src blob:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    },
  });
}

const PAGE_HTML = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="robots" content="noindex">
<title>Quick check needed</title>
<style nonce="__NONCE__">
  :root { --bg:#f6f7f9; --fg:#1b1f24; --mut:#5b6470; --acc:#1a73e8; --card:#fff; --warn:#b06000; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111418; --fg:#e8eaed; --mut:#9aa0a6; --acc:#8ab4f8; --card:#1c2026; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; -webkit-tap-highlight-color:transparent; }
  main { max-width:560px; margin:0 auto; padding:16px; }
  h1 { font-size:18px; margin:0 0 6px; }
  p.note { margin:0 0 12px; color:var(--mut); }
  #wrap { position:relative; background:var(--card); border-radius:10px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,.15); touch-action:manipulation; min-height:80px; }
  #img { display:block; width:100%; height:auto; user-select:none; -webkit-user-select:none; }
  #wait { padding:40px 16px; text-align:center; color:var(--mut); }
  #wrap.stale #img { opacity:.35; filter:grayscale(1); }
  #banner { display:none; position:absolute; left:0; right:0; bottom:0; padding:8px; text-align:center; font-size:14px; font-weight:600; background:var(--warn); color:#fff; }
  #wrap.stale #banner { display:block; }
  .dot { position:absolute; width:26px; height:26px; margin:-13px 0 0 -13px; border-radius:50%; border:3px solid var(--acc); pointer-events:none; animation:f .8s forwards; }
  @keyframes f { to { opacity:0; transform:scale(1.6); } }
  #bar { display:flex; gap:10px; align-items:center; margin-top:14px; }
  #st { flex:1; color:var(--mut); font-size:14px; }
  button { font:inherit; font-weight:600; padding:12px 22px; border:0; border-radius:8px; background:var(--acc); color:#fff; }
  button:disabled { opacity:.5; }
</style>
</head><body><main>
<h1>Quick check needed</h1>
<p class="note">Tap the check below, then the squares it asks for, then Verify. Tap Done when it's finished.</p>
<div id="wrap"><div id="wait">Loading the live view…</div><img id="img" alt="Live view of the check" hidden><div id="banner">Reconnecting…</div></div>
<div id="bar"><span id="st">Connecting…</span><button id="done">Done</button></div>
</main>
<script nonce="__NONCE__">
const base = location.pathname.replace(/\\/$/, '');
const img = document.getElementById('img'), wrap = document.getElementById('wrap'), st = document.getElementById('st'), doneBtn = document.getElementById('done');
let seq = 0, over = false, busy = false, lastOk = Date.now(), tapping = false;
const ENDED = { done: 'Done, thank you.', expired: 'This link has expired.', ended: 'This check has ended.', elsewhere: 'This link is already open on another device.' };
function end(s) { over = true; st.textContent = ENDED[s] || ENDED.ended; doneBtn.disabled = true; wrap.classList.remove('stale'); }
function health(live, why) {
  wrap.classList.toggle('stale', !live);
  if (!live) document.getElementById('banner').textContent = why || 'Reconnecting…';
  if (!over && !tapping) st.textContent = live ? 'Live' : 'Reconnecting…';
}
async function tick() {
  if (over || busy) return; busy = true;
  try {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch(base + '/state', { cache: 'no-store', signal: ctl.signal, credentials: 'same-origin' });
    clearTimeout(to);
    const s = await r.json(); lastOk = Date.now();
    if (s.status !== 'pending') return end(s.status);
    if (!s.seq) { document.getElementById('wait').textContent = s.found ? 'Loading the live view…' : 'Waiting for the check to appear…'; }
    health(s.live || (!s.seq && !s.why), s.why);
    if (s.seq && s.seq !== seq) {
      const f = await fetch(base + '/frame', { cache: 'no-store', credentials: 'same-origin' });
      if (f.status === 200) {
        const n = Number(f.headers.get('x-seq')) || s.seq;
        const u = URL.createObjectURL(await f.blob());
        await new Promise((ok) => { img.onload = ok; img.onerror = ok; img.src = u; });
        seq = n; img.hidden = false; document.getElementById('wait')?.remove();
      }
    }
  } catch { if (Date.now() - lastOk > 3000) health(false, 'Reconnecting… (no connection)'); } finally { busy = false; }
}
setInterval(tick, 300); tick();
img.addEventListener('click', async (e) => {
  if (over) return;
  if (tapping || wrap.classList.contains('stale')) { st.textContent = tapping ? 'One moment, the last tap is still going…' : 'Wait until the view is live again'; return; }
  const b = img.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  const fx = (e.clientX - b.left) / b.width, fy = (e.clientY - b.top) / b.height;
  const d = document.createElement('div'); d.className = 'dot';
  d.style.left = (e.clientX - w.left) + 'px'; d.style.top = (e.clientY - w.top) + 'px';
  wrap.appendChild(d); setTimeout(() => d.remove(), 900);
  st.textContent = 'Tapping…'; tapping = true;
  try {
    const r = await (await fetch(base + '/tap', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fx, fy, seq }) })).json();
    if (r.status && r.status !== 'pending') return end(r.status);
    st.textContent = r.ok ? 'Live' : r.error === 'busy' ? 'One moment, the last tap is still going…' : r.error === 'stale' ? 'The view just changed; tap again' : r.error === 'moved' ? 'The page moved on' : 'That tap did not go through, try again';
  } catch { st.textContent = 'That tap did not go through, try again'; }
  finally { tapping = false; }
});
doneBtn.addEventListener('click', async () => {
  if (!confirm('Finished with the check? This ends the link.')) return;
  try { await fetch(base + '/done', { method: 'POST', credentials: 'same-origin', body: '{}' }); } catch {}
  end('done');
});
</script>
</body></html>`;
