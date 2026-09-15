// drive-web.js — script the OFFICIAL CHAT WEBSITES (claude.ai, grok.com) so a
// benchmark cell runs unattended.
//
// The chat page is driven through the LOCAL FastLink connector; the chat itself
// then drives the browser through the CLOUD RELAY. Same Chrome, two channels.
//
// ── SELF-COLLISION HAZARD — read before changing anything here ──
// The chat page lives in the SAME browser the chat is about to drive. Every
// FastLink tool acts on the ACTIVE tab. So the moment the prompt is submitted this
// driver must STOP touching the browser: the model is about to open tabs and move
// focus, and a stray fast_switch from us would yank focus mid-run, corrupting both
// the run and its timing.
// The contract is therefore strictly phased:
//     openChat → newChat → sendPrompt   (we own the browser)
//     …run…                             (WE TOUCH NOTHING — the URL trail is read
//                                        once after the run, monitor.js TrailWatcher)
//     readFinalMessage                  (only AFTER the relay trace goes quiet)
// readFinalMessage is the only post-submit call, and it is the one that switches
// back to the chat tab.
//
// ── NO PARALLELISM ON THIS PATH ──
// The relay reports a single connected device and exposes no device-selection tool
// (fast_profile exists only on the LOCAL connector). Two chat cells at once would
// interleave onto one browser and one trace. run.js enforces a lockfile; this file
// assumes it holds.
import { fl, evalIn, switchToTab, tabs } from './fastlink.js';

export const SITES = {
  claude: {
    id: 'claude',
    label: 'claude.ai',
    url: 'https://claude.ai/new',
    urlMatch: 'claude.ai',
    // A TipTap/ProseMirror contenteditable. NOTE the decoy: claude.ai also renders
    // a <textarea id="static-composer-input"> shim that is NOT the live composer —
    // any textarea-first selector types into a dead element. Verified 2026-08-06.
    composerSelectors: ['div[contenteditable="true"][aria-label*="prompt" i]', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
    // Newest-last list of rendered assistant turns. These move around as the app
    // ships; the prompt-tail fallback in readFinalMessage is the durable path.
    messageSelectors: ['[data-testid="assistant-message"]', '.font-claude-response', '[data-is-streaming] .font-claude-message'],
    stopSelectors: ['button[aria-label*="Stop" i]'],
  },
  grok: {
    id: 'grok',
    label: 'grok.com',
    url: 'https://grok.com/',
    urlMatch: 'grok.com',
    // Also TipTap/ProseMirror (aria-label "Ask Grok anything"). grok.com carries a
    // stray empty <textarea> too, so textarea selectors are deliberately absent.
    // Verified 2026-08-06.
    composerSelectors: ['div[contenteditable="true"][aria-label*="Grok" i]', 'div.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][role="textbox"]'],
    messageSelectors: ['.message-bubble', '[class*="response-content"]', '[data-testid*="message"]'],
    stopSelectors: ['button[aria-label*="Stop" i]', 'button[type="submit"][aria-label*="Stop" i]'],
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (arr) => JSON.stringify(arr);

// ---------------------------------------------------------------------------
// Interstitials. Both sites interrupt with upsells / consent / "what's new"
// dialogs, and a modal swallows the composer click. Dismissal is text-driven, not
// coordinate-driven, and it NEVER clicks anything that looks like an upgrade CTA.
// ---------------------------------------------------------------------------
const DISMISS_FN = `() => {
  const YES = /^(no thanks|maybe later|not now|dismiss|skip|got it|continue|accept all|accept|i agree|agree|close|okay|ok|done|later)$/i;
  const NO  = /(upgrade|subscribe|buy|start trial|go pro|super ?grok|max plan|pay)/i;
  const clicked = [];
  const roots = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[data-state="open"]')];
  const scan = roots.length ? roots : [document.body];
  for (const root of scan) {
    for (const b of root.querySelectorAll('button,[role="button"],a[role="button"]')) {
      const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
      if (!t || NO.test(t)) continue;
      if (!YES.test(t)) continue;
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      b.click(); clicked.push(t);
      break;
    }
  }
  if (!clicked.length && roots.length) {
    for (const root of roots) {
      const x = root.querySelector('button[aria-label*="close" i],button[aria-label*="dismiss" i]');
      if (x) { x.click(); clicked.push('(x)'); }
    }
  }
  return { clicked, dialogs: roots.length };
}`;

export async function dismissUpsell(site) {
  await switchToTab(site.urlMatch);
  const r1 = await evalIn(null, DISMISS_FN);
  if (r1?.dialogs) { await sleep(600); await evalIn(null, DISMISS_FN); }
  // Escape clears anything text-matching missed (both sites close modals on Esc).
  await fl('fast_key', { key: 'Escape' });
  return r1;
}

// ---------------------------------------------------------------------------
export async function openChat(siteId, { fresh = true } = {}) {
  const site = SITES[siteId];
  if (!site) throw new Error(`unknown site "${siteId}" (expected: ${Object.keys(SITES).join(', ')})`);
  const existing = (await tabs()).find((t) => (t.url || '').includes(site.urlMatch));
  if (existing && !fresh) await fl('fast_switch', { tabId: existing.id });
  else if (existing) { await fl('fast_switch', { tabId: existing.id }); await fl('fast_nav', { url: site.url, waitMs: 20000 }); }
  else await fl('fast_tab', { url: site.url });
  await sleep(2500);
  await dismissUpsell(site);
  return site;
}

/** A brand-new conversation, so no prior turn can contaminate the measurement.
 *  Navigating to the site's "new chat" URL is more reliable than hunting a button
 *  whose label both sites rename regularly. */
export async function newChat(site) {
  const url = site.id === 'claude' ? 'https://claude.ai/new' : 'https://grok.com/';
  await switchToTab(site.urlMatch);
  await fl('fast_nav', { url, waitMs: 20000 });
  await sleep(2000);
  await dismissUpsell(site);
  return true;
}

// Set the composer's text directly. execCommand('insertText') is used because it
// is the ONE path that works for BOTH a ProseMirror contenteditable (claude.ai)
// and a plain textarea (grok.com): it goes through the browser's own editing
// pipeline, so React/ProseMirror see real beforeinput/input events and their
// internal state stays in sync. Assigning .value or .textContent leaves React's
// state stale and the send button disabled.
// The composer is mounted by client-side hydration, NOT present at load. A single
// querySelector races it and fails the whole cell (observed on grok.com, whose
// tiptap/ProseMirror editor appears well after the page paints), so poll for it.
const COMPOSE_FN = `async (selectors, text) => {
  const findEl = () => {
    for (const s of selectors) { const e = document.querySelector(s); if (e) return e; }
    return null;
  };
  let el = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    el = findEl();
    // Require it to be laid out, not merely attached — a 0-height editor is still hydrating.
    if (el && el.getBoundingClientRect().height > 0) break;
    el = null;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!el) return { ok: false, error: 'composer not found', tried: selectors };
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') { el.select(); }
  else {
    const r = document.createRange(); r.selectNodeContents(el);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }
  document.execCommand('insertText', false, text);
  const read = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText;
  return { ok: true, tag: el.tagName, read };
}`;

/**
 * Put the prompt in the composer and VERIFY it landed intact — but do NOT submit.
 * A silently truncated prompt would invalidate the run and read as a model
 * failure, so a mismatch throws. Exported so the composer path can be tested on a
 * live site without ever sending a message.
 */
export async function composePrompt(site, text, { verify = true } = {}) {
  await switchToTab(site.urlMatch);
  await dismissUpsell(site);
  const res = await evalIn(null, COMPOSE_FN, [site.composerSelectors, text]);
  if (!res?.ok) throw new Error(`composer not reachable on ${site.label}: ${res?.error} (tried ${q(res?.tried || site.composerSelectors)})`);
  const got = String(res.read || '').replace(/\s+/g, ' ').trim();
  const want = text.replace(/\s+/g, ' ').trim();
  if (verify && got !== want) {
    throw new Error(
      `composed text does NOT match the prompt — refusing to send.\n  want (${want.length} ch): ${want}\n  got  (${got.length} ch): ${got}`,
    );
  }
  return { tag: res.tag, chars: got.length, matched: got === want };
}

export async function sendPrompt(site, text, { verify = true } = {}) {
  await composePrompt(site, text, { verify });
  // Submit. Enter sends on both sites; the composer already holds focus.
  await fl('fast_key_press', { key: 'Enter' });
  const submittedAt = Date.now();
  await sleep(1200);
  // Confirm the composer actually emptied — if Enter inserted a newline instead of
  // sending, the text is still sitting there and the run never started.
  const after = await evalIn(null, `(selectors) => {
    for (const s of selectors) { const el = document.querySelector(s); if (el) return (el.value ?? el.innerText ?? '').trim(); }
    return null;
  }`, [site.composerSelectors]);
  if (after && after.length > 20) throw new Error(`Enter did not submit on ${site.label} — the composer still holds the prompt`);
  return { submittedAt };
}

// TOOL-PERMISSION GATE. claude.ai asks for approval PER TOOL ("Claude wants to use
// Fast snapshot from Fastlink — Deny / Always allow / Allow once") and blocks the
// whole turn until a human clicks. Observed live: a cell issued ONE tool call, hit
// this dialog, went silent, and the quiet period recorded it as FINISHED with
// score 2/10 — indistinguishable from a model that gave up. Every not-yet-granted
// tool re-arms it, so this must be cleared automatically or runs die at random.
//
// Deliberately clicks "Always allow" (not "Allow once") so a given tool is asked
// about at most once per account, and MATCHES ON THE BUTTON'S OWN TEXT rather than
// on a container selector — the dialog markup is unversioned and changes often.
const APPROVE_FN = `() => {
  const btns = [...document.querySelectorAll('button')];
  const hit = btns.find((b) => /^\\s*always allow/i.test((b.innerText || '').trim()));
  if (!hit) return { approved: false };
  hit.click();
  return { approved: true, label: (hit.innerText || '').trim().slice(0, 40) };
}`;

/** Approve any pending tool-permission dialog. Returns how many it cleared. */
export async function approveToolPrompts(site, { rounds = 4, gapMs = 700 } = {}) {
  let cleared = 0;
  for (let i = 0; i < rounds; i++) {
    const r = await evalIn(site.urlMatch, APPROVE_FN, []);
    if (!r || !r.approved) break;   // nothing pending — done
    cleared++;
    await sleep(gapMs);             // the next tool's prompt may render right after
  }
  return cleared;
}

/** Secondary, UI-side completion signal. The PRIMARY signal is the relay-trace
 *  quiet period in monitor.js, which is independent of how the page renders.
 *  BOTH of these switch focus to the chat tab, so they are post-quiet only. */
export async function isGenerating(site) {
  const r = await evalIn(site.urlMatch, `(sel) => sel.some(s => !!document.querySelector(s))`, [site.stopSelectors]);
  return r === true;
}

/** Confirm the answer has stopped streaming before it is read. Called only AFTER
 *  the trace goes quiet — the tool calls can finish a beat before the last tokens
 *  render, and reading mid-stream would truncate the final message and cause
 *  spurious `live` checkpoint failures. Never blocks the run: on timeout it just
 *  reports that the UI never went idle. */
export async function waitForIdle(site, { timeoutMs = 20000, pollMs = 1500 } = {}) {
  const until = Date.now() + timeoutMs;
  let sawGenerating = false;
  while (Date.now() < until) {
    if (!await isGenerating(site)) return { idle: true, sawGenerating };
    sawGenerating = true;
    await sleep(pollMs);
  }
  return { idle: false, sawGenerating };
}

/**
 * The chat's final message. Read ONLY after the run is confirmed finished — this
 * switches focus back to the chat tab.
 * Strategy 1: the last rendered assistant block via site selectors.
 * Strategy 2 (fallback, and surprisingly robust): everything in the page text
 * after the LAST occurrence of the prompt's tail — the answer always follows the
 * echoed prompt, whatever the markup is called this month.
 */
export async function readFinalMessage(site, { promptTail = '' } = {}) {
  await switchToTab(site.urlMatch);
  await sleep(800);
  const FN = `(selectors, tail) => {
    for (const s of selectors) {
      const nodes = [...document.querySelectorAll(s)];
      if (nodes.length) {
        const txt = (nodes[nodes.length - 1].innerText || '').trim();
        if (txt) return { via: s, text: txt };
      }
    }
    const body = document.body.innerText || '';
    if (tail) {
      const i = body.lastIndexOf(tail);
      if (i >= 0) return { via: 'prompt-tail', text: body.slice(i + tail.length).trim() };
    }
    return { via: 'body', text: body.slice(-6000) };
  }`;
  const r = await evalIn(null, FN, [site.messageSelectors, promptTail.slice(-60)]);
  return { via: r?.via || 'none', text: String(r?.text || '') };
}

// --- CLI probe -------------------------------------------------------------
// node bench/drive-web.js probe claude   → confirm the composer + message
// selectors still resolve on the live site, without sending anything.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, siteId] = process.argv.slice(2);
  if (cmd !== 'probe' || !SITES[siteId]) {
    console.error('usage: node bench/drive-web.js probe <claude|grok>');
    process.exit(2);
  }
  const site = await openChat(siteId, { fresh: false });
  const r = await evalIn(site.urlMatch, `(c, m, s) => ({
    composer: c.map(x => ({ sel: x, found: !!document.querySelector(x) })),
    messages: m.map(x => ({ sel: x, n: document.querySelectorAll(x).length })),
    stop:     s.map(x => ({ sel: x, found: !!document.querySelector(x) })),
    url: location.href,
  })`, [site.composerSelectors, site.messageSelectors, site.stopSelectors]);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}
