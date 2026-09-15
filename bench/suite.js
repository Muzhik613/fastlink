// suite.js — the five benchmark tests, as DATA ONLY.
//
// Every client (Grok mobile, Claude mobile, claude.ai web, grok.com web) gets the
// IDENTICAL `prompt` string. Nothing here knows how a run is driven; score.js
// interprets `checkpoints`, run.js uses `reset` and `prompt`.
//
// CHECKPOINT CONTRACT — the whole point of this harness. A checkpoint is scored
// against REAL page state read back through FastLink after the run, or against the
// URL trail the recorder observed while the run was in flight. NOTHING is ever
// scored from what the model says it did. Checkpoints are ORDERED: they are listed
// in the order the work must happen, so `firstFailure` tells you where a run died.
//
import { HOLDOUT } from './holdout.js';

// Kinds:
//   tab     {urlIncludes}                 – some tab is open on that URL
//   trail    {urlIncludes}                 – the recorder saw that URL during the run
//                                            (falls back to currently-open tabs when
//                                            scoring standalone with no trail)
//   eval     {tab, fn, args, expect}       – run JS in the tab, match the result
//   live     {tab, fn, args, tolerance?}   – read the LIVE value, then require the
//                                            chat's final message to contain it.
//                                            This is the claimed-vs-actual probe at
//                                            checkpoint granularity.
//   liveList {tab, fn, count}              – fn returns [{name, value}]; expands to
//                                            one name checkpoint + one value
//                                            checkpoint per entry, plus an order
//                                            checkpoint.
//
// `expect` matchers (string-normalized unless noted): equals | equalsIgnoreCase |
// includes | notIncludes | regex | oneOf | truthy | falsy | nonEmpty

// ---------------------------------------------------------------------------
// Page readers. Kept as strings because they are shipped to fast_evaluate.
// ---------------------------------------------------------------------------

// books.toscrape product detail page.
const BOOKS_PRODUCT = `() => {
  const main = document.querySelector('.product_main');
  if (!main) return null;
  return {
    title: (main.querySelector('h1')||{}).textContent || '',
    price: (main.querySelector('.price_color')||{}).textContent || '',
    stock: ((main.querySelector('.instock.availability')||{}).textContent || '').trim().replace(/\\s+/g,' '),
    path: location.pathname,
  };
}`;

// GCP "Create OAuth client ID". The form is Angular + custom <cfc-select>, the
// Name/URI inputs are only rendered AFTER an application type is picked, and the
// two URI groups BOTH label their inputs "URIs 1" — so a value has to be attributed
// by SECTION, never by label. We walk up from each input to the SMALLEST ancestor
// whose text mentions exactly one of the two section headings. Shadow roots are
// traversed because the console mounts parts of the form in shadow DOM.
const GCP_FORM = `() => {
  const seen = new Set(); const inputs = []; const selects = [];
  (function walk(root, d) {
    if (!root || d > 25) return;
    for (const el of root.querySelectorAll('*')) {
      if (seen.has(el)) continue; seen.add(el);
      const t = el.tagName.toLowerCase();
      if ((t === 'input' || t === 'textarea') && el.type !== 'hidden' && el.type !== 'search') inputs.push(el);
      if (t === 'cfc-select' || t === 'mat-select' || el.getAttribute('role') === 'combobox') selects.push(el);
      if (el.shadowRoot) walk(el.shadowRoot, d + 1);
    }
  })(document, 0);

  const JS_H = 'authorized javascript origin';
  const RD_H = 'authorized redirect uri';
  const sectionOf = (el) => {
    for (let n = el.parentElement, i = 0; n && i < 20; n = n.parentElement, i++) {
      const txt = (n.innerText || '').toLowerCase();
      const js = txt.includes(JS_H), rd = txt.includes(RD_H);
      if (js && !rd) return 'js';
      if (rd && !js) return 'redirect';
    }
    return 'other';
  };
  const labelOf = (el) => {
    const ff = el.closest('mat-form-field,[class*=form-field],cfc-input-field');
    return ((ff && ff.querySelector('label,mat-label') || {}).innerText
      || el.getAttribute('aria-label') || el.placeholder || '').trim();
  };

  const out = { url: location.href, appType: '', name: '', jsOrigins: [], redirectUris: [], other: [] };
  for (const s of selects) {
    const txt = (s.innerText || '').trim();
    if (txt && !out.appType) out.appType = txt.split('\\n')[0].trim();
  }
  for (const el of inputs) {
    const v = (el.value || '').trim();
    const lbl = labelOf(el);
    const sec = sectionOf(el);
    if (sec === 'js') out.jsOrigins.push(v);
    else if (sec === 'redirect') out.redirectUris.push(v);
    else if (/^name$/i.test(lbl)) out.name = v;
    else out.other.push({ lbl, v });
  }
  // The Name input carries NO identifying text AT ALL on this page: its
  // mat-form-field ancestor contains no <label>/<mat-label>, and the input has no
  // aria-label and no placeholder — verified live, labelOf() returns "". So both
  // the /^name$/ match above and a /name/i fallback ALWAYS missed, and out.name was
  // permanently "" no matter what the field held. That scored a false FAILURE (and
  // a false OVERCLAIM) against a correctly-filled form, 3 runs in a row.
  // Identify it structurally instead: it is the only fillable input on the form that
  // belongs to NEITHER URI section.
  if (!out.name && out.other.length === 1) out.name = out.other[0].v;
  return out;
}`;

// selenium.dev web-form.html — a plain, stable HTML form.
//
// TWO DEFAULTS HERE HAND OUT FREE CREDIT IF YOU ARE NOT CAREFUL. Both confirmed
// against the live page on 2026-08-06 by reading an UNTOUCHED form:
//   • <select> starts at value "Open this select menu" → "non-empty" is already
//     true before anyone touches it, so it is scored as "changed away from the
//     placeholder" instead;
//   • the FIRST radio is pre-checked → "some radio is checked" is already true,
//     so the prompt names the SECOND radio and the checkpoint asserts its index.
const SELENIUM_FORM = `() => {
  const f = document.forms[0];
  const g = (n) => f && f.elements[n];
  const val = (n) => { const e = g(n); return e ? String(e.value) : null; };
  const radios = [...document.querySelectorAll('input[name="my-radio"]')];
  return {
    url: location.href,
    text: val('my-text'),
    password: val('my-password'),
    textarea: val('my-textarea'),
    select: val('my-select'),
    datalist: val('my-datalist'),
    // BOTH checkboxes share name="my-check", so f.elements['my-check'] returns a
    // RadioNodeList whose .checked is undefined — that read ALWAYS scored false and
    // handed out a false FAILURE (both models were marked wrong while the page
    // showed both boxes ticked). Read the SECOND box by id: it starts unchecked, so
    // checked===true proves a real click, exactly like the radio checkpoint.
    checkbox: !!(document.getElementById('my-check-2') || {}).checked,
    radioIndex: radios.findIndex(r => r.checked),
    date: val('my-date'),
  };
}`;

// react-select.com/home — the FIRST demo select is .basic-single. Its rendered
// value lives in an emotion-hashed [class*=singleValue] node inside that container.
const REACT_SELECT_FIRST = `() => {
  const c = document.querySelector('.basic-single');
  if (!c) return null;
  const sv = c.querySelector('[class*="singleValue"]');
  return sv ? sv.textContent.trim() : '';
}`;

// aa.com advanced flight search — Angular Material, and the site this repo's
// CHANGELOG already logs as a real FastLink problem case (off-viewport fast_locate
// miss). AUTH-FREE, so it runs identically on two profiles signed into different
// Google accounts. Three traps, all confirmed live on 2026-08-06:
//   • THREE inputs share name="date" and TWO of them share aria-label="Departure
//     date" — the extra one is the HIDDEN one-way picker (#matOneWayDatePicker,
//     offsetParent null). Indexing `input[name=date]` at 0, or matching on the
//     aria-label alone, reads that hidden field and returns "" no matter what the
//     visible form holds. That is the selenium `my-check` / GCP `name` bug again.
//     Fixed by filtering to VISIBLE inputs first, then keying on the aria-label.
//   • The three <select>s carry CODES, not display text (cabin "SHOW_ALL",
//     carriers "ALL"), so values are read as the selected option's TEXT — stable
//     across whatever AA renames those codes to.
//   • Departure/Return dates are model-chosen (a hard-coded date would rot, and an
//     airline only sells ~331 days out). Nothing asserts a literal date: the
//     checkpoints assert the mm/dd/yyyy SHAPE plus `returnAfterDepart`, which also
//     catches the real failure mode — one fill landing in both date fields.
const AA_SEARCH = `() => {
  const vis = (el) => !!(el && el.offsetParent);
  const dateByLabel = (lbl) => {
    const hit = [...document.querySelectorAll('input[name="date"]')]
      .filter(vis)
      .find((el) => (el.getAttribute('aria-label') || '') === lbl);
    return hit ? hit.value.trim() : '';
  };
  const inputVal = (name) => {
    const el = document.querySelector('input[name="' + name + '"]');
    return el ? el.value.trim() : '';
  };
  const selectText = (name) => {
    const s = document.querySelector('select[name="' + name + '"]');
    if (!s) return '';
    const o = s.options[s.selectedIndex];
    return o ? o.text.trim() : '';
  };
  const parse = (s) => {
    const m = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(s);
    return m ? Date.UTC(+m[3], +m[1] - 1, +m[2]) : null;
  };
  const depart = dateByLabel('Departure date');
  const ret = dateByLabel('Return date');
  const d = parse(depart), r = parse(ret);
  return {
    url: location.href,
    orig: inputVal('orig'),
    dest: inputVal('dest'),
    depart,
    ret,
    returnAfterDepart: !!(d && r && r > d),
    passengers: selectText('count'),
    cabin: selectText('cabin'),
    airline: selectText('carriers'),
  };
}`;

// Google Maps directions — a CANVAS map with a thin DOM around it, the one shape
// no other test covers. AUTH-FREE (Maps gives directions signed out), and every
// value read here is derived from the requested route, never from the account.
//   • The Starting-point box DEFAULTS to "Your location", so "start is non-empty"
//     is already true before anyone touches it — the checkpoint asserts it contains
//     "Kennedy" instead. (Confirmed: an untouched Directions panel reads
//     start:"Your location", and a fresh /maps reads start:"".)
//   • `dest` is what MAPS normalizes the typed destination to ("Times Square,
//     Manhattan, NY 10036"), not what the model typed — that is the live probe.
//   • Route DISTANCES and ETAs re-order with traffic, so nothing scores them; the
//     structural fact that route options rendered at all is scored instead.
const MAPS_DIR = `() => {
  const vis = (el) => !!(el && el.offsetParent);
  const ins = [...document.querySelectorAll('input')].filter(vis);
  const val = (re) => {
    const el = ins.find((i) => re.test(i.getAttribute('aria-label') || ''));
    return el ? el.value.trim() : '';
  };
  const panel = document.querySelector('[role="main"]');
  const txt = panel ? (panel.innerText || '').replace(/\\s+/g, ' ') : '';
  const dists = [...new Set((txt.match(/[0-9][0-9.,]*\\s*(?:miles|mi|km)\\b/gi) || [])
    .map((s) => s.trim().toLowerCase()))];
  return {
    url: location.href,
    start: val(/^starting point/i),
    dest: val(/^destination/i),
    dists,
  };
}`;

// Cloudflare dash. Worker identity comes from the URL / anchor hrefs
// (…/workers/services/view/<name>/…), NOT from visible text or class names — the
// dashboard's classes are emotion-hashed and its list rows re-render for a while
// after paint. `worker` is the Worker whose detail page we are ON (null on the list
// view); `listed` is every Worker linked from the current page, which is how the
// list view is read. Verified live: list view → listed = [fastlink-relay,
// gauth-father, gauth-broker-mt, gauth-broker-staging, fd-relay], worker = null.
const CF_WORKER_PAGE = `() => {
  const fromUrl = (location.pathname.match(/\\/workers\\/services\\/view\\/([^/]+)/) || [])[1] || null;
  const listed = [...new Set([...document.querySelectorAll('a[href*="/workers/services/view/"]')]
    .map((a) => ((a.getAttribute('href') || '').match(/\\/workers\\/services\\/view\\/([^/]+)/) || [])[1])
    .filter(Boolean))];
  return { url: location.href, worker: fromUrl, listed, listedCount: listed.length };
}`;

// Wikipedia list of countries by population. Skips the "World" aggregate row so
// "top 10" is unambiguously the top 10 COUNTRIES, matching how a model reads it.
const WIKI_TOP = `(n) => {
  const t = document.querySelector('table.wikitable');
  if (!t) return null;
  const out = [];
  for (const tr of t.querySelectorAll('tbody > tr')) {
    const cells = [...tr.children];
    if (cells.length < 2) continue;
    const name = (cells[0].innerText || '').replace(/\\[.*?\\]/g, '').trim();
    if (!name || /^(location|country)/i.test(name)) continue;
    if (/^world$/i.test(name)) continue;
    const numCell = cells.find(c => /[0-9],[0-9]{3}/.test(c.innerText || ''));
    if (!numCell) continue;
    const value = Number((numCell.innerText.match(/[0-9][0-9,]*/) || [''])[0].replace(/,/g, ''));
    if (!value) continue;
    out.push({ name, value });
    if (out.length >= n) break;
  }
  return out;
}`;

export const TESTS = [
  {
    id: 'multipage',
    name: 'Multi-page crawl (books.toscrape)',
    purpose: 'Round-trip accumulation with near-zero reasoning cost: light DOM, three real page loads. Isolates per-round-trip overhead from model thinking.',
    url: 'https://books.toscrape.com/',
    reset: { closeUrlPatterns: ['books.toscrape.com'] },
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://books.toscrape.com/ , click into the "Travel" category, open the FIRST book, and report its title, price, and stock availability.',
    checkpoints: [
      { kind: 'tab', name: 'new tab on books.toscrape.com', urlIncludes: 'books.toscrape.com' },
      { kind: 'trail', name: 'reached the Travel category page', urlIncludes: 'category/books/travel' },
      { kind: 'trail', name: 'reached a product detail page', urlIncludes: '/catalogue/', excludes: '/category/' },
      { kind: 'live', name: 'reported the live title', tab: 'books.toscrape.com', fn: BOOKS_PRODUCT, pick: 'title' },
      { kind: 'live', name: 'reported the live price', tab: 'books.toscrape.com', fn: BOOKS_PRODUCT, pick: 'price' },
      { kind: 'live', name: 'reported the live availability', tab: 'books.toscrape.com', fn: BOOKS_PRODUCT, pick: 'stock', numeric: true },
    ],
  },

  {
    id: 'gcpform',
    name: 'Heavy SPA form (GCP OAuth client)',
    purpose: 'Angular SPA, custom <cfc-select> dropdown, dynamically revealed inputs, and TWO identically-labelled "URIs 1" fields — the exact shape that made fast_fill section: report success while writing the wrong field.',
    url: 'https://console.cloud.google.com/auth/clients/create?project=booming-argon-464605-n5',
    reset: { closeUrlPatterns: ['console.cloud.google.com/auth/clients'] },
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://console.cloud.google.com/auth/clients/create?project=booming-argon-464605-n5 and create a new OAuth 2.0 Client ID. Fill: Application type = Web application, Name = FastLink Bench, Authorized JavaScript origin = https://bench.example.com, Authorized redirect URI = https://bench.example.com/callback. Fill all four fields but do NOT click Create. Then report what each field contains.',
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the create page', urlIncludes: '/auth/clients/create' },
      { kind: 'eval', name: 'Application type = Web application', tab: '/auth/clients/create', fn: GCP_FORM, pick: 'appType', expect: { includes: 'Web application' } },
      { kind: 'eval', name: 'Name = FastLink Bench', tab: '/auth/clients/create', fn: GCP_FORM, pick: 'name', expect: { equalsIgnoreCase: 'FastLink Bench' } },
      { kind: 'eval', name: 'JS origin = https://bench.example.com (in the JS-origins section)', tab: '/auth/clients/create', fn: GCP_FORM, pick: 'jsOrigins', expect: { oneOf: ['https://bench.example.com'] } },
      { kind: 'eval', name: 'Redirect URI = https://bench.example.com/callback (in the redirect section)', tab: '/auth/clients/create', fn: GCP_FORM, pick: 'redirectUris', expect: { oneOf: ['https://bench.example.com/callback'] } },
      { kind: 'eval', name: 'Create NOT clicked (still on the create page)', tab: '/auth/clients/create', fn: GCP_FORM, pick: 'url', expect: { includes: '/auth/clients/create' } },
    ],
  },

  {
    id: 'staticform',
    name: 'Static multi-field form (selenium web-form)',
    purpose: 'Eight plain fields of every input type. Measures multi-field batching (fast_fill {fields} in one call) against field-by-field round-trips.',
    url: 'https://www.selenium.dev/selenium/web/web-form.html',
    reset: { closeUrlPatterns: ['selenium.dev/selenium/web/'] },
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://www.selenium.dev/selenium/web/web-form.html and fill every field: the text input, the password, the textarea, the dropdown (select), the datalist, check the SECOND checkbox (the one that starts unchecked), select the SECOND radio button, and set the date. Do NOT submit the form. Then report each value.',
    checkpoints: [
      { kind: 'tab', name: 'tab opened on web-form.html', urlIncludes: 'web-form.html' },
      { kind: 'eval', name: 'text input filled', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'text', expect: { nonEmpty: true } },
      { kind: 'eval', name: 'password filled', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'password', expect: { nonEmpty: true } },
      { kind: 'eval', name: 'textarea filled', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'textarea', expect: { nonEmpty: true } },
      { kind: 'eval', name: 'dropdown changed from its placeholder', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'select', expect: { regex: '^(?!Open this select menu$).+' } },
      { kind: 'eval', name: 'datalist filled', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'datalist', expect: { nonEmpty: true } },
      { kind: 'eval', name: 'SECOND checkbox checked (first is pre-checked — my-check-2 proves a real click)', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'checkbox', expect: { truthy: true } },
      { kind: 'eval', name: 'SECOND radio selected (first is pre-checked — index 1 proves a real click)', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'radioIndex', expect: { equals: 1 } },
      { kind: 'eval', name: 'date set', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'date', expect: { nonEmpty: true } },
      { kind: 'eval', name: 'NOT submitted (still on web-form.html)', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'url', expect: { notIncludes: 'submitted-form' } },
      { kind: 'live', name: 'reported the live text-input value', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'text' },
      { kind: 'live', name: 'reported the live textarea value', tab: 'web-form.html', fn: SELENIUM_FORM, pick: 'textarea' },
    ],
  },

  {
    id: 'overlay',
    name: 'Portaled custom dropdown (react-select)',
    purpose: 'A non-native widget whose menu portals out of the container. Exercises overlay:true snapshots / fast_select_option against a control that has no <select> to fall back on.',
    url: 'https://react-select.com/home',
    reset: { closeUrlPatterns: ['react-select.com'] },
    // "Forest" is chosen deliberately: it is in react-select's stock colour options
    // but is NOT the default value of any demo on the page, so a passing score
    // cannot come from an untouched control.
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://react-select.com/home and, in the FIRST dropdown on the page (the one labelled "Single"), select the option "Forest". Then report the selected value.',
    checkpoints: [
      { kind: 'tab', name: 'tab opened on react-select.com', urlIncludes: 'react-select.com' },
      { kind: 'eval', name: 'first dropdown value is Forest', tab: 'react-select.com', fn: REACT_SELECT_FIRST, expect: { equalsIgnoreCase: 'Forest' } },
      { kind: 'live', name: 'reported the live selected value', tab: 'react-select.com', fn: REACT_SELECT_FIRST },
    ],
  },

  {
    id: 'flightsearch',
    name: 'Heavy travel form (aa.com flight search)',
    purpose: 'The site this repo already logs as a real FastLink failure (off-viewport fast_locate miss), and AUTH-FREE — unlike gcpform it runs identically on two profiles signed into different Google accounts. Two airport autocompletes, two date fields that share a name with a HIDDEN third, and three <select>s that sit ~700-1200px BELOW the fold, so the run has to reach off-viewport controls.',
    url: 'https://www.aa.com/booking/find-flights',
    // Closing tabs is not enough here: a run that wrongly clicks Search makes
    // aa.com persist the itinerary to localStorage and re-fill the form on the NEXT
    // run's very first load. clearStorage wipes the origin so that free credit
    // cannot be inherited.
    reset: {
      closeUrlPatterns: ['aa.com/booking'],
      clearStorage: ['https://www.aa.com/booking/find-flights'],
    },
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://www.aa.com/booking/find-flights and set up — but do NOT run — a round-trip flight search. Set: From = JFK, To = LAX, Departure date = any date about one month from today, Return date = exactly one week after that departure date, Number of passengers = 2, Class = Business / First, Airline = American Airlines. Do NOT click Search and do NOT book anything. Then report what each field contains.',
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the aa.com booking form', urlIncludes: 'aa.com/booking' },
      { kind: 'eval', name: 'From = JFK', tab: 'aa.com/booking', fn: AA_SEARCH, pick: 'orig', expect: { includes: 'JFK' } },
      { kind: 'eval', name: 'To = LAX', tab: 'aa.com/booking', fn: AA_SEARCH, pick: 'dest', expect: { includes: 'LAX' } },
      { kind: 'eval', name: 'Departure date set (VISIBLE picker, not the hidden one-way twin)', tab: 'aa.com/booking', fn: AA_SEARCH, pick: 'depart', expect: { regex: '^\\d{2}/\\d{2}/\\d{4}$' } },
      { kind: 'eval', name: 'Return date set', tab: 'aa.com/booking', fn: AA_SEARCH, pick: 'ret', expect: { regex: '^\\d{2}/\\d{2}/\\d{4}$' } },
      { kind: 'eval', name: 'Return is AFTER departure (one fill did not land in both date fields)', tab: 'aa.com/booking', fn: AA_SEARCH, pick: 'returnAfterDepart', expect: { truthy: true } },
      { kind: 'eval', name: 'Passengers = 2 (below the fold; default is 1)', tab: 'aa.com/booking', fn: AA_SEARCH, pick: 'passengers', expect: { equals: '2' } },
      { kind: 'eval', name: 'Class = Business / First (below the fold; default is "Show all")', tab: 'aa.com/booking', fn: AA_SEARCH, pick: 'cabin', expect: { includes: 'Business' } },
      { kind: 'eval', name: 'Airline = American Airlines (below the fold; default is "All airlines")', tab: 'aa.com/booking', fn: AA_SEARCH, pick: 'airline', expect: { equalsIgnoreCase: 'American Airlines' } },
      { kind: 'eval', name: 'Search NOT clicked (still on find-flights, not choose-flights)', tab: 'aa.com/booking', fn: AA_SEARCH, pick: 'url', expect: { includes: 'find-flights' } },
    ],
  },

  {
    id: 'mapsdir',
    name: 'Canvas map directions (Google Maps)',
    purpose: 'A WebGL canvas with a thin DOM shell — the only test that pushes past DOM tools toward the vision tier. Also AUTH-FREE and symmetric: every scored value comes from the requested route, not from the signed-in account.',
    url: 'https://www.google.com/maps',
    reset: { closeUrlPatterns: ['google.com/maps'] },
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://www.google.com/maps and get DRIVING directions from "John F. Kennedy International Airport" to "Times Square, New York". Then report the EXACT text Google Maps put in the Destination box, and how many route options it offers.',
    checkpoints: [
      { kind: 'tab', name: 'tab opened on google.com/maps', urlIncludes: 'google.com/maps' },
      { kind: 'eval', name: 'a directions route was requested (/maps/dir/)', tab: 'google.com/maps', fn: MAPS_DIR, pick: 'url', expect: { includes: '/maps/dir/' } },
      { kind: 'eval', name: 'starting point is JFK (default is "Your location")', tab: 'google.com/maps', fn: MAPS_DIR, pick: 'start', expect: { includes: 'Kennedy' } },
      { kind: 'eval', name: 'destination is Times Square', tab: 'google.com/maps', fn: MAPS_DIR, pick: 'dest', expect: { includes: 'Times Square' } },
      { kind: 'eval', name: 'route options rendered (distances present in the panel)', tab: 'google.com/maps', fn: MAPS_DIR, pick: 'dists', expect: { nonEmpty: true } },
      { kind: 'live', name: "reported Maps' own normalized destination text", tab: 'google.com/maps', fn: MAPS_DIR, pick: 'dest' },
    ],
  },

  {
    id: 'extract',
    name: 'Bulk extraction (Wikipedia population table)',
    purpose: 'A page far bigger than the default snapshot cap. Tests whether the client notices truncation and pages/uncaps, or silently reports a short, wrong list.',
    url: 'https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population',
    reset: { closeUrlPatterns: ['List_of_countries_and_dependencies_by_population'] },
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population and report the top 10 entries with their populations, in order.',
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Wikipedia list', urlIncludes: 'List_of_countries_and_dependencies_by_population' },
      { kind: 'liveList', name: 'top 10 by population', tab: 'List_of_countries_and_dependencies_by_population', fn: WIKI_TOP, count: 10, tolerance: 0.01 },
    ],
  },
  {
    id: 'cfworkers',
    name: 'Authed heavy console (Cloudflare Workers)',
    purpose: 'A logged-in production React console — the most realistic heavy-SPA case in the suite. Multi-step: a slow-hydrating list view, then drill into one item. STRICTLY READ-ONLY.',
    url: 'https://dash.cloudflare.com/?to=/:account/workers-and-pages',
    reset: { closeUrlPatterns: ['dash.cloudflare.com'] },
    // READ-ONLY BY CONSTRUCTION. This runs against a REAL production Cloudflare
    // account (it hosts relay.ytx.app). Nothing here fills a field, submits a form,
    // deploys, renames or deletes — the task is navigate + read, and the prompt says
    // so explicitly. Do NOT add a mutating step to this test.
    //
    // Scored on `fastlink-relay` specifically rather than on the Worker COUNT,
    // because the count changes whenever a Worker is deployed or removed; that name
    // is stable. Worker identity is read from the href (…/workers/services/view/<name>/…)
    // rather than from visible text or CSS classes, which are emotion-hashed and churn.
    prompt: 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to https://dash.cloudflare.com/?to=/:account/workers-and-pages , wait for the Workers & Pages list to load, then open the Worker named "fastlink-relay". Report its name and the names of the other Workers you saw in the list. This is READ-ONLY: do NOT deploy, edit, rename, delete or change any setting.',
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Cloudflare dashboard', urlIncludes: 'dash.cloudflare.com' },
      { kind: 'trail', name: 'reached the Workers & Pages list', urlIncludes: 'workers-and-pages' },
      { kind: 'trail', name: 'drilled into the fastlink-relay Worker', urlIncludes: 'workers/services/view/fastlink-relay' },
      { kind: 'eval', name: 'ended on the fastlink-relay Worker page', tab: 'workers/services/view/fastlink-relay', fn: CF_WORKER_PAGE, pick: 'worker', expect: { equals: 'fastlink-relay' } },
      { kind: 'live', name: 'reported the live Worker name', tab: 'workers/services/view/fastlink-relay', fn: CF_WORKER_PAGE, pick: 'worker' },
    ],
  },
];

// The holdout set (bench/holdout.js, ids `h_*`) resolves through the same lookup, so
// run.js / score.js take `--test h_table` with no second code path.
export const SUITES = { main: TESTS, holdout: HOLDOUT };
export const ALL_TESTS = [...TESTS, ...HOLDOUT];
export const byId = (id) => ALL_TESTS.find((t) => t.id === id);
export const TEST_IDS = ALL_TESTS.map((t) => t.id);
