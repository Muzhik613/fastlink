// src/watch.js — live watches: the browser pushes events, a service reads them (relay-core).
//
//   fast_watch   {tabId, selector, fields?, key?, limit?}  a DOM list in the page; events
//                add / change / remove as the page changes (fast-ext/src/actions/watch.js)
//   fast_capture {tabId, url, method?, body?, maxBody?}     the tab's own requests whose URL
//                contains `url`: request headers + body, status, response headers + body
//   fast_watch_read {watchId, after, waitSec}  events with seq > after; waits up to 25 s for
//                the first one (long poll). Read again with after = the result's `next`.
//   fast_watch_stop {watchId}
//
// Events are kept in this DO's storage (survives hibernation), numbered `seq` 1, 2, … per
// watch, so a reader that polls late still gets every event since its cursor; only past
// the per-watch cap do the oldest go (the read then says `gap`).
//
// Ext frames (fast-ext/src/watchOutbox.js):
//   ext → relay {type:'watch', watchId, n, events, dropped?}   batch n of that watch; a batch
//               the relay has (n ≤ lastN) is acked again, never stored twice
//   relay → ext {type:'watch_ack', watchId, n} | {type:'watch_gone', watchId}
//   hello {watches:[ids]}: active watches of that browser missing from the list have ended
//               (Chrome or FastLink restarted there and the page observers are gone).

const META = 'watch:';
const EV = 'wev:';
const evKey = (id, seq) => `${EV}${id}:${String(seq).padStart(10, '0')}`;
// A capture body over BODY_CHUNK characters is stored in pieces (one DO value is ≤ 2 MB).
const BD = 'wbd:';
const BODY_CHUNK = 400_000;
const bodyPrefix = (id, seq) => `${BD}${id}:${seq == null ? '' : String(seq).padStart(10, '0') + ':'}`;
const bodyKey = (id, seq, k) => `${bodyPrefix(id, seq)}${String(k).padStart(4, '0')}`;
export const WATCH_MAX_PER_ACCOUNT = 50;
// Kept per watch: a DOM watch's events are small; a capture's carry bodies up to 2 MB.
const KEEP = { dom: 1000, request: 100 };
const EVENT_MAX_CHARS = 1_500_000;       // one stored value (DO SQLite values are ≤ 2 MB)
const READ_MAX_CHARS = 8_000_000;        // one fast_watch_read answer
const READ_WAIT_MAX_S = 25;
const ENDED_KEEP_MS = 60 * 60_000;       // an ended watch stays readable this long
const LOST_REASON = 'FastLink in that browser restarted (Chrome or the extension), so the watch is gone there: start it again';

// Every write to a watch's events runs one at a time per DO (two batches never share a seq).
function serial(relay, fn) {
  const p = (relay._watchChain || Promise.resolve()).then(fn);
  relay._watchChain = p.catch(() => {});
  return p;
}

const waiters = (relay) => (relay._watchWaiters ||= new Map());
function wake(relay, id) {
  const set = waiters(relay).get(id);
  if (!set) return;
  waiters(relay).delete(id);
  for (const fn of set) fn();
}
function waitFor(relay, id, ms) {
  return new Promise((resolve) => {
    const m = waiters(relay);
    if (!m.has(id)) m.set(id, new Set());
    const fn = () => { clearTimeout(t); m.get(id)?.delete(fn); resolve(); };
    const t = setTimeout(fn, ms);
    m.get(id).add(fn);
  });
}

const getMeta = (relay, id) => (typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id) ? relay.ctx.storage.get(META + id) : Promise.resolve(undefined));
const notFound = (id) => ({ error: `No watch "${id}" (stopped, ended over an hour ago, or never started). Start one with fast_watch or fast_capture.`, watchGone: true });

async function allMetas(relay) {
  return [...(await relay.ctx.storage.list({ prefix: META })).values()];
}

async function deleteWatch(relay, meta) {
  const keys = [META + meta.id];
  for (let s = meta.firstSeq; s <= meta.lastSeq; s++) keys.push(evKey(meta.id, s));
  keys.push(...(await relay.ctx.storage.list({ prefix: bodyPrefix(meta.id) })).keys());
  for (let i = 0; i < keys.length; i += 128) await relay.ctx.storage.delete(keys.slice(i, i + 128));
  wake(relay, meta.id);
}

// Store events after the watch's last seq; trims the oldest past the cap. Returns the meta.
async function append(relay, meta, events) {
  const puts = {};
  for (const e of events) {
    let ev = { ...e, seq: ++meta.lastSeq };
    if (typeof ev.body === 'string' && ev.body.length > BODY_CHUNK) {
      const n = Math.ceil(ev.body.length / BODY_CHUNK);
      for (let k = 0; k < n; k++) puts[bodyKey(meta.id, ev.seq, k)] = ev.body.slice(k * BODY_CHUNK, (k + 1) * BODY_CHUNK);
      const { body, ...rest } = ev;
      ev = { ...rest, bodyParts: n };
    }
    if (JSON.stringify(ev).length > EVENT_MAX_CHARS) {
      const { body, postData, ...rest } = ev;
      ev = { ...rest, tooLarge: true, note: 'event over 1.5 MB: body dropped (lower maxBody)' };
    }
    puts[evKey(meta.id, ev.seq)] = ev;
    if (e.kind === 'ended') { meta.state = 'ended'; meta.reason = String(e.reason || 'ended'); meta.endedAt = Date.now(); }
  }
  if (meta.firstSeq === 0 && meta.lastSeq > 0) meta.firstSeq = 1;
  const keep = KEEP[meta.kind] || 1000;
  const drop = [];
  while (meta.lastSeq - meta.firstSeq + 1 > keep) {
    drop.push(evKey(meta.id, meta.firstSeq));
    drop.push(...(await relay.ctx.storage.list({ prefix: bodyPrefix(meta.id, meta.firstSeq) })).keys());
    meta.firstSeq++;
  }
  puts[META + meta.id] = meta;
  const entries = Object.entries(puts);
  for (let i = 0; i < entries.length; i += 128) await relay.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
  for (let i = 0; i < drop.length; i += 128) await relay.ctx.storage.delete(drop.slice(i, i + 128));
  wake(relay, meta.id);
  return meta;
}

// Ended watches past ENDED_KEEP_MS are deleted (run on every new watch).
async function sweep(relay, metas) {
  const now = Date.now();
  const live = [];
  for (const m of metas) {
    if (m.state === 'ended' && now - (m.endedAt || 0) > ENDED_KEEP_MS) await deleteWatch(relay, m);
    else live.push(m);
  }
  return live;
}

// fast_watch / fast_capture: register the watch, then start it in the browser.
// `extArgs` are the checked args for the extension (watchId is added here).
export async function watchCreate(relay, target, action, extArgs) {
  const metas = await sweep(relay, await allMetas(relay));
  const active = metas.filter((m) => m.state !== 'ended');
  if (active.length >= WATCH_MAX_PER_ACCOUNT) {
    return { error: `This account already has ${active.length} watches (the limit is ${WATCH_MAX_PER_ACCOUNT}). Stop some with fast_watch_stop.`, watches: active.map((m) => ({ watchId: m.id, kind: m.kind, browser: m.browser, tabId: m.tabId })) };
  }
  const id = crypto.randomUUID();
  const kind = action === 'fast_capture' ? 'request' : 'dom';
  const meta = {
    id, kind, browser: target.name, deviceToken: target.deviceToken, tabId: extArgs.tabId ?? null,
    state: 'pending', createdAt: Date.now(), firstSeq: 0, lastSeq: 0, lastN: 0,
    what: kind === 'dom' ? { selector: extArgs.selector } : { url: extArgs.url, ...(extArgs.method ? { method: extArgs.method } : {}) },
  };
  await relay.ctx.storage.put(META + id, meta);
  const payload = await relay.callExtension(action, { ...extArgs, watchId: id }, undefined, target);
  const cur = await relay.ctx.storage.get(META + id);
  if (!payload || typeof payload !== 'object' || 'error' in payload) {
    if (cur) await deleteWatch(relay, cur);
    // a browser that never ran it may still run it later (a late copy): tell it to stop
    relay.notifyExtension({ type: 'watch_gone', watchId: id }, target);
    return payload && typeof payload === 'object' ? payload : { error: `${action} failed` };
  }
  const result = payload.result || {};
  if (cur && cur.state === 'pending') {
    cur.state = 'active';
    if (typeof result.tabId === 'number') cur.tabId = result.tabId;
    await relay.ctx.storage.put(META + id, cur);
  }
  return {
    result: {
      ...result, watchId: id, after: 0,
      hint: `Events arrive as the ${kind === 'dom' ? 'page changes' : 'tab makes matching requests'}: call fast_watch_read {watchId:"${id}", after:0} and then after = each result's next. fast_watch_stop ends it.`,
    },
    tabId: payload.tabId,
  };
}

const inScope = (meta, scope) => !scope || scope.includes(meta.browser);

// fast_watch_read {watchId, after?, waitSec?}
export async function watchRead(relay, args = {}, scope = null) {
  let meta = await getMeta(relay, args.watchId);
  if (!meta || !inScope(meta, scope)) return notFound(args.watchId);
  const after = args.after == null ? 0 : Number(args.after);
  if (!Number.isInteger(after) || after < 0) return { error: 'fast_watch_read `after` must be a whole number ≥ 0 (the last result\'s `next`)' };
  const waitSec = args.waitSec == null ? 20 : Number(args.waitSec);
  if (!Number.isFinite(waitSec) || waitSec < 0 || waitSec > READ_WAIT_MAX_S) return { error: `fast_watch_read \`waitSec\` must be 0-${READ_WAIT_MAX_S}` };
  if (meta.lastSeq <= after && meta.state !== 'ended' && waitSec > 0) {
    await waitFor(relay, meta.id, waitSec * 1000);
    meta = await getMeta(relay, meta.id);
    if (!meta) return notFound(args.watchId);
  }
  const from = Math.max(after + 1, meta.firstSeq || 1);
  const events = [];
  let chars = 0, more = false;
  for (let s = from; s <= meta.lastSeq && !more; s += 64) {
    const keys = [];
    for (let k = s; k < s + 64 && k <= meta.lastSeq; k++) keys.push(evKey(meta.id, k));
    const got = await relay.ctx.storage.get(keys);
    for (const k of keys) {
      let ev = got.get(k);
      if (!ev) continue;
      if (ev.bodyParts) {
        const parts = await relay.ctx.storage.get(Array.from({ length: ev.bodyParts }, (_, i) => bodyKey(meta.id, ev.seq, i)));
        const { bodyParts, ...rest } = ev;
        ev = { ...rest, body: Array.from({ length: bodyParts }, (_, i) => parts.get(bodyKey(meta.id, ev.seq, i)) || '').join('') };
      }
      const n = JSON.stringify(ev).length;
      if (events.length && chars + n > READ_MAX_CHARS) { more = true; break; }
      chars += n;
      events.push(ev);
    }
  }
  const next = events.length ? events.at(-1).seq : after;
  const missed = meta.firstSeq > after + 1 && meta.lastSeq > after ? meta.firstSeq - after - 1 : 0;
  return {
    watchId: meta.id, kind: meta.kind, browser: meta.browser, tabId: meta.tabId, state: meta.state,
    ...(meta.reason ? { reason: meta.reason } : {}),
    events, next, more,
    ...(missed ? { gap: missed, hint: `${missed} older events were dropped before this read (over the per-watch cap): poll more often.` } : {}),
  };
}

// fast_watch_stop {watchId}: forget it here and stop it in the browser (when online).
export async function watchStop(relay, args = {}, scope = null) {
  const meta = await getMeta(relay, args.watchId);
  if (!meta || !inScope(meta, scope)) return notFound(args.watchId);
  await serial(relay, () => deleteWatch(relay, meta));
  let browserStopped = false;
  const target = await relay.resolveTarget(meta.browser);
  if (!target.error && target.deviceToken === meta.deviceToken) {
    const r = await relay.callExtension('fast_watch_stop', { watchId: meta.id }, undefined, target);
    browserStopped = !!(r && r.result);
  }
  return { watchId: meta.id, stopped: true, browserStopped, ...(browserStopped ? {} : { note: 'the browser is offline or did not answer; it stops the watch when it next reports' }) };
}

// {type:'watch'} from a browser socket. `token` = that socket's device token.
export function watchIngest(relay, ws, token, msg) { return serial(relay, () => ingest(relay, ws, token, msg)); }
async function ingest(relay, ws, token, msg) {
  const id = msg.watchId;
  const send = (f) => { try { ws.send(JSON.stringify(f)); } catch { /* socket gone: the batch is resent */ } };
  const meta = await getMeta(relay, id);
  if (!meta || meta.deviceToken !== token) { if (!meta) send({ type: 'watch_gone', watchId: id }); return; }
  const n = Number(msg.n);
  if (!Number.isInteger(n) || n < 1) return;
  if (n <= meta.lastN || meta.state === 'ended') { send({ type: 'watch_ack', watchId: id, n }); if (meta.state === 'ended') send({ type: 'watch_gone', watchId: id }); return; }
  const events = (Array.isArray(msg.events) ? msg.events : []).slice(0, 500).filter((e) => e && typeof e === 'object' && !Array.isArray(e));
  const dropped = Number(msg.dropped) > 0 ? [{ kind: 'dropped', count: Number(msg.dropped), at: Date.now(), note: 'the browser could not reach the relay and dropped these oldest events' }] : [];
  meta.lastN = n;
  await append(relay, meta, [...dropped, ...events]);
  send({ type: 'watch_ack', watchId: id, n });
}

// A hello that lists the browser's live watches: active ones it no longer runs have ended.
export function watchReconcile(relay, token, ids) {
  if (!token || !Array.isArray(ids)) return Promise.resolve();
  return serial(relay, () => reconcile(relay, token, ids));
}
async function reconcile(relay, token, ids) {
  const have = new Set(ids.map(String));
  for (const m of await allMetas(relay)) {
    if (m.deviceToken !== token || m.state !== 'active' || have.has(m.id)) continue;
    await append(relay, m, [{ kind: 'ended', reason: LOST_REASON, at: Date.now() }]);
  }
}
