// src/scout.js — the Gemini vision calls behind fast_point / fast_fill_vision (relay-core)
//
// Workers port of fast-dxt/server/scout.js. The original already talks to the
// Gemini Generative Language API over `fetch` (no Node deps in the call path), so
// the logic + prompts are carried over verbatim. Cloud-relay changes:
//
//   1. BYO-KEY (SPEC §12): the Gemini API key is resolved PER CALL by the DO
//      (`db.getUserGeminiKey(env.DB, userId, env.KEY_ENC_SECRET) ?? env.GEMINI_API_KEY`)
//      and passed IN — the
//      model helpers take the key as a parameter; this module never reads env.
//      The DO creates the factory once and binds a key per call via
//      `createScout({model}).withKey(apiKey)`.
//
// Usage (in the DO):
//   const base  = createScout({ model });            // once per DO
//   const scout = base.withKey(resolvedApiKey);      // per call, binds the key
//   if (scout.enabled) await scout.pointByImage({ targets, base64 });
//
// See SPEC.md §3e, §12 and task #7.

// Bound the fetch so a stuck Gemini call can't hang the tool call.
const GEMINI_TIMEOUT_MS = 12_000;

export function createScout({ model } = {}) {
  const GEMINI_MODEL = model || 'gemini-2.5-flash-lite';

  // Per-instance (per-user-DO) caches — NOT module-level.
  const DISABLED = 'no Gemini API key — set your own in relay settings, or configure the operator GEMINI_API_KEY secret';

  // --- core Gemini call (key is a PARAMETER) --------------------------------

  async function callModelParts(apiKey, { system, parts, maxTokens }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    // Bound the fetch — a slow/stuck Gemini call must never hang the tool call.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`scout gemini timed out (${GEMINI_TIMEOUT_MS}ms)`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`scout gemini ${res.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('') || '{}';
    return safeJson(content);
  }

  // --- multimodal locate primitives ----------------------------------------

  async function pointByImage(apiKey, { targets, base64 }) {
    if (!apiKey) return { points: [], reason: DISABLED };
    if (!base64 || typeof base64 !== 'string') return { points: [], reason: 'no image' };
    const list = Array.isArray(targets) ? targets : [targets];
    const img = base64.replace(/^data:image\/\w+;base64,/, '');
    const prompt = [
      'Locate each requested target in this browser screenshot. For each, return',
      'the point at the CENTER of the element you would click (for an input field,',
      'the middle of its empty box), as NORMALIZED integers 0-1000 in [y, x] order',
      '(y first), where [0,0] is top-left and [1000,1000] is bottom-right.',
      'STRICT RULE: only return a point if you can ACTUALLY SEE that exact element',
      'in the image right now. If it is off-screen, below the visible area, or not',
      'present, you MUST return {"found":false,"point":null} for it — do NOT guess,',
      'do NOT approximate a location, do NOT return a point for something you cannot',
      'see. A wrong guess is far worse than found:false.',
      'Also return "confidence" (0-1, how sure you are this is the right visible',
      'element) and "sizeFrac" (target width as fraction of image width).',
      'Targets, in order: ' + list.map((t, k) => `(${k}) ${t}`).join('; ') + '.',
      'Reply strict JSON: {"points":[{"k":int,"found":bool,"point":[y,x]|null,"confidence":number,"sizeFrac":number}]}.',
    ].join(' ');
    const out = await callModelParts(apiKey, {
      parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: img } }],
      maxTokens: 500,
    });
    const raw = Array.isArray(out && out.points) ? out.points : [];
    const points = raw.map((p) => {
      const pt = Array.isArray(p && p.point) ? p.point : null;
      const y = pt ? Number(pt[0]) : null;
      const x = pt ? Number(pt[1]) : null;
      const conf = typeof p.confidence === 'number' ? p.confidence : 1;
      const found = p.found !== false && x != null && y != null && conf >= 0.4;
      return { k: typeof p.k === 'number' ? p.k : null, found, xNorm: x, yNorm: y, confidence: conf, sizeFrac: typeof p.sizeFrac === 'number' ? p.sizeFrac : null };
    });
    return { points };
  }

  // Bind a resolved API key into a stable surface (the shape composite.js uses).
  // Caches are shared across binds (they live on the factory), so per-call key
  // resolution doesn't cost a cache. enabled reflects whether a key is present.
  function withKey(apiKey) {
    return {
      enabled: !!apiKey,
      model: GEMINI_MODEL,
      pointByImage: (a) => pointByImage(apiKey, a),
    };
  }

  return { withKey };
}

// --- pure helpers (no instance state, no key) -------------------------------

function safeJson(s) {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return {};
}
