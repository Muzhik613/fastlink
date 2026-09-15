import { injectInTab } from '../util.js';

export async function getText(args = {}) {
  const r = await injectInTab({
    world: 'ISOLATED',
    func: extractText,
    args: [args.selector || null, args.maxLen || null, !!args.html],
  });
  // JSON string across executeScript (Chrome sorts returned object keys) so
  // `truncated` stays the first field.
  return r.error ? r : JSON.parse(r.result);
}

// Runs in the page (self-contained: executeScript serializes this function).
// A form control's text is its live VALUE, never its (empty) textContent: a
// selector matching input / textarea / select / [contenteditable] /
// role=combobox|textbox|searchbox returns the value as `text` plus
// field:{tag, label, value} (fields:[…] for several matches). A read whose text
// is empty says so (empty:true) — Maps run 61581163 read "" from the Destination
// <input> and took it as "nothing contradicts me".
export function extractText(selector, maxLen, html) {
  const EMPTY_HINT = 'the element has no text; if it is a form field its value is in value (shown here) — an empty read is not confirmation';
  const MAX_FIELDS = 50;
  const CONTROL_ROLE = /^(combobox|textbox|searchbox)$/;
  const isControl = (el) => {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    const ce = el.getAttribute('contenteditable');
    if (ce != null && ce.toLowerCase() !== 'false') return true;
    return CONTROL_ROLE.test(String(el.getAttribute('role') || '').trim().toLowerCase());
  };
  const readValue = (el) => {
    const tag = el.tagName;
    if (tag === 'SELECT') {
      const opts = Array.from(el.selectedOptions || []);
      return { value: opts.map(o => String(o.text || '').trim()).join(', '), optionValue: el.multiple ? opts.map(o => o.value) : el.value };
    }
    if (tag === 'INPUT' && /^(checkbox|radio)$/i.test(el.type || '')) return { value: el.value, checked: !!el.checked };
    if (tag === 'INPUT' || tag === 'TEXTAREA') return { value: /^password$/i.test(el.type || '') ? '•'.repeat(String(el.value || '').length) : String(el.value ?? '') };
    // a role=combobox/textbox wrapper holds its real control inside; else its shown text
    const inner = el.querySelector && el.querySelector('input, textarea, select');
    if (inner) return readValue(inner);
    return { value: String(el.getAttribute('aria-valuetext') ?? (el.innerText || el.textContent || '')) };
  };
  const labelOf = (el) => {
    const aria = String(el.getAttribute('aria-label') || '').trim();
    if (aria) return aria;
    const by = String(el.getAttribute('aria-labelledby') || '').trim();
    if (by) {
      const t = by.split(/\s+/).map(id => { const n = document.getElementById(id); return n ? (n.innerText || n.textContent || '') : ''; }).join(' ').trim();
      if (t) return t;
    }
    // a <label> that WRAPS its control: only the label's own text, never the control's (a
    // wrapped <select> would add every option — selenium web-form)
    const l = el.labels && el.labels[0];
    const own = (n) => (typeof n.contains === 'function' && n.contains(el))
      ? Array.from(n.childNodes || []).filter(c => c !== el && !(typeof c.contains === 'function' && c.contains(el))).map(c => c.textContent || '').join(' ')
      : (n.innerText || n.textContent || '');
    const lt = l ? String(own(l)).replace(/\s+/g, ' ').trim() : '';
    if (lt) return lt;
    return String(el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '');
  };
  const fieldOf = (el) => ({ tag: el.tagName.toLowerCase(), label: labelOf(el), ...readValue(el) });

  const roots = selector ? Array.from(document.querySelectorAll(selector)) : [document.body];
  if (!roots.length) return JSON.stringify({ error: `selector "${selector}" not found` });
  const controls = !html && selector ? roots.filter(isControl) : [];
  let raw, kind, extra = {};
  if (controls.length) {
    // every match in document order: a control as its value, anything else as its text
    const fields = controls.slice(0, MAX_FIELDS).map(fieldOf);
    const one = roots.length === 1;
    raw = one ? fields[0].value : roots.slice(0, MAX_FIELDS).map(el => {
      if (!isControl(el)) return String(el.innerText || el.textContent || '');
      const f = fields[controls.indexOf(el)];
      return f ? `${f.label}: ${f.value}` : '';
    }).join('\n');
    kind = 'value';
    extra = one ? { field: fields[0] } : { fields, ...(roots.length > MAX_FIELDS ? { more: roots.length - MAX_FIELDS } : {}) };
  } else {
    const root = roots[0];
    raw = html ? (root.outerHTML || '') : (root.innerText || root.textContent || '');
    kind = html ? 'outerHTML' : 'innerText';
  }
  const text = String(raw);
  const limit = typeof maxLen === 'number' && maxLen > 0 ? maxLen : 0;
  const truncated = !!(limit && text.length > limit);
  const body = { text: truncated ? text.slice(0, limit) : text, length: text.length, kind, from: selector || 'body', ...(roots.length > 1 ? { matches: roots.length } : {}), ...extra };
  if (!text.trim()) return JSON.stringify({ truncated: false, empty: true, hint: EMPTY_HINT, ...body });
  // A cut result says so FIRST, with the exact call that returns the rest.
  if (!truncated) return JSON.stringify({ truncated: false, ...body });
  return JSON.stringify({
    truncated: true,
    dropped: { chars: text.length - limit },
    hint: `only the first ${limit} of ${text.length} chars are shown — call fast_text again with maxLen:${text.length} (or omit maxLen), or a narrower selector, before relying on this text`,
    ...body,
  });
}
