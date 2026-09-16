// src/composite.js — server-side composite tool orchestration (relay-core)
//
// Ported from fast-dxt/server/handlers.js. These are the Gemini-backed tiers that
// orchestrate MULTIPLE browser primitives + model calls inside a single MCP tool
// call (so Claude/Opus is removed from the per-field loop). Each handler takes:
//   relay  — the UserRelay DO (relay.callExtension drives the browser)
//   scout  — a createScout() instance (the Gemini client)
//   args   — the tool arguments
//
// Differences from the WSL handlers.js:
//   • No filesystem: screenshots are never saved to /tmp here (mcp.js returns
//     fast_screenshot as MCP image content instead).
//   • refinePoint reads the viewport size from the capture metadata
//     (imgW/imgH/dpr) instead of fast_evaluate (which is OFF in cloud mode).
//
// See SPEC.md §3e and task #7.

const REFINE_SIZE_FRAC = 0.05;  // target narrower than 5% of width → crop-zoom
const REFINE_CONFIDENCE = 0.75; // coarse hit at/above this is trusted (skip refine)
const CLEAN_GAP_CSS = 44;       // nearest found neighbor ≥ this (px) for "clean spacing"

// === vision capture + point (shared by fast_point / fill_vision / locate) ====

// Fresh capture only (no warm-capture reuse in cloud v1).
async function captureForVision(relay) {
  const cap = await relay.callExtension('fast_vision_capture', {});
  const full = cap?.result;
  if (cap?.error || !full?.dataUrl) return { error: cap?.error || 'vision capture failed' };
  return full;
}

// Capture once, point at all targets, return per-target {found,xCss,yCss,refined}.
async function pointOnce(relay, scout, targets, refineMode, opts = {}) {
  const refine = refineMode !== false;
  const forced = refineMode === true || refineMode === 'always';
  const confidenceSkip = opts.confidenceSkip === true;
  // DOM-COORDS-WIN: resolve targets against the DOM first (exact snapshot rects
  // beat vision regression); only fall to Gemini vision for the leftovers.
  const domHits = await domLocate(relay, targets);
  const remaining = [];
  targets.forEach((t, k) => { if (!domHits[k]) remaining.push(t); });

  const assemble = (visionOut) => {
    const out = [];
    let vi = 0;
    for (let k = 0; k < targets.length; k++) {
      if (domHits[k]) out.push({ target: targets[k], found: true, xCss: domHits[k].xCss, yCss: domHits[k].yCss, refined: false, via: 'dom' });
      else out.push(visionOut[vi++] || { target: targets[k], found: false });
    }
    return { points: out };
  };

  if (!remaining.length) return assemble([]);

  const full = await captureForVision(relay);
  if (full.error) {
    if (domHits.some(Boolean)) return assemble(remaining.map((t) => ({ target: t, found: false })));
    return { error: full.error };
  }
  const { points } = await scout.pointByImage({ targets: remaining, base64: full.dataUrl });

  const coarse = remaining.map((t, k) => {
    const p = points.find((q) => q.k === k) || points[k];
    if (!p || !p.found) return { found: false };
    return {
      found: true,
      xCss: (p.xNorm / 1000) * full.imgW / full.dpr,
      yCss: (p.yNorm / 1000) * full.imgH / full.dpr,
      sizeFrac: p.sizeFrac,
      confidence: p.confidence,
    };
  });
  const foundYs = coarse.filter((c) => c.found).map((c) => c.yCss).sort((a, b) => a - b);
  const dense = remaining.length >= 3;

  const jobs = remaining.map((t, k) => {
    const c = coarse[k];
    if (!c.found) return null;
    const small = c.sizeFrac != null && c.sizeFrac < REFINE_SIZE_FRAC;
    const below = foundYs.filter((y) => y < c.yCss - 1).pop();
    const above = foundYs.filter((y) => y > c.yCss + 1).shift();
    const gap = Math.min(below != null ? c.yCss - below : Infinity, above != null ? above - c.yCss : Infinity);
    let want;
    if (confidenceSkip) {
      const confident = c.confidence != null && c.confidence >= REFINE_CONFIDENCE;
      const cleanSpacing = gap >= CLEAN_GAP_CSS;
      want = forced || small || !confident || !cleanSpacing;
    } else {
      want = forced || small || dense;
    }
    if (!(refine && want)) return null;
    return {
      k, target: t, xCss: c.xCss, yCss: c.yCss,
      loY: below != null ? (below + c.yCss) / 2 : 0,
      hiY: above != null ? (above + c.yCss) / 2 : Infinity,
    };
  });

  const refinedByK = new Map();
  await Promise.all(jobs.map((j) => {
    if (!j) return null;
    return refinePoint(relay, scout, j.target, j.xCss, j.yCss, full)
      .then((r) => { if (r && r.yCss >= j.loY && r.yCss <= j.hiY) refinedByK.set(j.k, r); })
      .catch(() => {});
  }));

  const visionOut = [];
  for (let k = 0; k < remaining.length; k++) {
    const c = coarse[k];
    if (!c.found) { visionOut.push({ target: remaining[k], found: false }); continue; }
    const r = refinedByK.get(k);
    const xCss = r ? r.xCss : c.xCss;
    const yCss = r ? r.yCss : c.yCss;
    visionOut.push({ target: remaining[k], found: true, xCss: Math.round(xCss), yCss: Math.round(yCss), refined: !!r, confidence: c.confidence, via: 'vision' });
  }
  return assemble(visionOut);
}

// Crop a short horizontal band centered on the coarse point, zoom, re-point.
// Viewport size comes from the capture metadata (no fast_evaluate in cloud mode).
async function refinePoint(relay, scout, target, xCss, yCss, full) {
  try {
    const vp = { w: full.imgW / full.dpr, h: full.imgH / full.dpr };
    if (!vp.w || !vp.h) return null;
    const cw = Math.round(vp.w * 0.40);
    const ch = Math.round(vp.h * 0.16);
    const crop = {
      x: Math.max(0, Math.min(Math.round(xCss - cw / 2), vp.w - cw)),
      y: Math.max(0, Math.min(Math.round(yCss - ch / 2), vp.h - ch)),
      w: cw, h: ch,
    };
    const cap = await relay.callExtension('fast_vision_capture', { crop, zoom: 3 });
    const z = cap?.result;
    if (cap?.error || !z?.dataUrl) return null;
    const { points } = await scout.pointByImage({ targets: [target], base64: z.dataUrl });
    const p = points[0];
    if (!p || !p.found) return null;
    return { xCss: crop.x + (p.xNorm / 1000) * crop.w, yCss: crop.y + (p.yNorm / 1000) * crop.h };
  } catch {
    return null;
  }
}

// === fast_point =============================================================

export async function handlePoint(relay, scout, args) {
  if (!scout.enabled) return { disabled: true, reason: 'set GEMINI_API_KEY (relay secret) to enable vision' };
  const targets = Array.isArray(args?.targets) ? args.targets : (args?.target ? [args.target] : []);
  if (!targets.length) return { error: 'fast_point needs target (string) or targets (array)' };
  const scroll = args?.scroll === true;

  let result = await pointOnce(relay, scout, targets, args?.refine);
  if (result.error) return result;
  if (!scroll) return result;

  const MAX_PASSES = 4;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const missing = result.points.filter((p) => !p.found);
    if (!missing.length) break;
    await relay.callExtension('fast_wheel', { x: 900, y: 400, deltaY: 500 }).catch(() => {});
    const retry = await pointOnce(relay, scout, missing.map((m) => m.target), args?.refine);
    if (retry.error || !retry.points) continue;
    for (const r of retry.points) {
      if (!r.found) continue;
      const slot = result.points.find((p) => p.target === r.target && !p.found);
      if (slot) { slot.found = true; slot.xCss = r.xCss; slot.yCss = r.yCss; slot.refined = r.refined; slot.scrolledTo = pass + 1; }
    }
  }
  return result;
}

// === fast_fill_vision =======================================================

export async function handleFillVision(relay, scout, args) {
  if (!scout.enabled) return { disabled: true, reason: 'set GEMINI_API_KEY (relay secret) to enable vision' };
  const fields = args?.fields;
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return { error: 'fast_fill_vision needs a fields object: { "<field description>": "<value>", ... }' };
  }
  const fieldKeys = Object.keys(fields);
  if (!fieldKeys.length) return { error: 'fast_fill_vision: fields object is empty' };
  const submit = (typeof args?.submit === 'string' && args.submit.trim()) ? args.submit.trim() : null;

  const targets = submit ? [...fieldKeys, submit] : fieldKeys;
  const located = await pointOnce(relay, scout, targets, args?.refine, { confidenceSkip: true });
  if (located.error) return located;
  const points = located.points || [];

  const filled = [];
  const missed = [];
  const clear = args?.clear !== false;
  for (const key of fieldKeys) {
    const p = points.find((q) => q.target === key);
    if (!p || !p.found) { missed.push(key); continue; }
    const value = String(fields[key] ?? '');
    if (clear) await relay.callExtension('fast_click_xy', { x: p.xCss, y: p.yCss, clickCount: 3 });
    else await relay.callExtension('fast_click_xy', { x: p.xCss, y: p.yCss });
    await relay.callExtension('fast_type', { text: value });
    filled.push({ field: key, found: true, value });
  }

  let submitted = false;
  if (submit) {
    let sp = points.find((q) => q.target === submit);
    if (!sp || !sp.found) {
      const re = await pointOnce(relay, scout, [submit], args?.refine, { confidenceSkip: true });
      sp = re.points && re.points[0];
    }
    if (sp && sp.found) { await relay.callExtension('fast_click_xy', { x: sp.xCss, y: sp.yCss }); submitted = true; }
    else missed.push(submit);
  }

  return { filled, missed, submitted };
}

// === DOM matching helpers ===================================================

function matchItem(items, target) {
  // Normalize for matching: lowercase, collapse whitespace, and strip a trailing
  // ":" / "：" (+ whitespace). A <label> is commonly rendered "Delivery
  // instructions:" while the caller's target is "Delivery instructions" (or vice
  // versa) — without trimming the trailing colon those never match exactly, and
  // a colon-terminated query fails the substring test against a colon-less field.
  const norm = (s) => (s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[:：\s]+$/, '').trim();
  const q = norm(target);
  if (!q) return null;
  const hasCoords = (it) => ['x', 'y', 'w', 'h'].every((k) => typeof it[k] === 'number');
  const fields = (it) => norm([it.text, it.label, it.ariaLabel, it.placeholder, it.name, it.role, it.href]
    .filter(Boolean).join(' '));
  let best = items.find((it) => hasCoords(it) && fields(it) === q);
  if (!best) best = items.find((it) => hasCoords(it) && fields(it).includes(q));
  if (!best) {
    const words = q.split(/\s+/).filter(Boolean);
    // Include the tag in the per-word search so a control phrased with its type
    // ("delivery instructions textarea", "submit button") still resolves — every
    // word must be present, so the tag only confirms an already-strong match.
    if (words.length) best = items.find((it) => {
      const f = (fields(it) + ' ' + norm(it.tag));
      return hasCoords(it) && words.every((w) => f.includes(w));
    });
  }
  if (!best) return null;
  return { xCss: Math.round(best.x + best.w / 2), yCss: Math.round(best.y + best.h / 2) };
}

const DOM_LOCATE_TIMEOUT_MS = 3000;
async function domLocate(relay, targets) {
  try {
    const snapP = relay.callExtension('fast_snapshot', { viewport: false });
    const timeoutP = new Promise((resolve) => setTimeout(() => resolve(null), DOM_LOCATE_TIMEOUT_MS));
    const snap = await Promise.race([snapP, timeoutP]);
    const items = snap?.result?.items;
    if (!Array.isArray(items)) return targets.map(() => null);
    return targets.map((t) => matchItem(items, String(t)));
  } catch {
    return targets.map(() => null);
  }
}
