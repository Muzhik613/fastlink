// holdout2.js — the SECOND holdout set: public sites no FastLink builder has seen, as DATA
// ONLY, same shape as suite.js / holdout.js. Same rule as holdout 1 ("every website is
// different — it has to work everywhere"): nothing in fast-ext/ or fast-runner/ may ever
// special-case one of these sites, and no fix may be validated ONLY here and then tuned
// until it passes. It exists to check whether generic tool fixes CARRY OVER to sites
// that were unseen when those fixes were written.
//
// One site per widget family, none shared with suite.js, holdout.js or any earlier proof,
// and each a different UI stack from holdout 1:
//   h2_wizard        Syncfusion EJ2 Tab wizard  – 4-step booking; the train list is generated
//                                                  from step 1's answers, the fare from its class
//   h2_slider        Mantine (React)            – role=slider thumb + role=switch toggle
//   h2_tree          Wunderbaum                 – 100k-node checkbox tree, virtualized rows,
//                                                  target nested under a COLLAPSED node far below
//   h2_autocomplete  National Rail live trains  – live station typeahead; commit fills hidden fields
//   h2_modal         Element Plus (Vue 3)       – form in a dialog opened by a button, el-select popper
//   h2_infinite      itch.io browse grid        – infinite scroll; the answer is two loads past the first
//
// CHECKPOINT CONTRACT as suite.js. Every checkpoint must FAIL on an untouched page and PASS
// after the task is done by hand through the local FastLink tools (validated both ways on
// hvm — see docs/GROK_RUNNER_HOLDOUT2_2026-09-15.md). "Not submitted" guards are folded
// into a checkpoint that also needs real work, never scored alone.
//
// Readers key on ids / name attributes / ARIA / the widget's own API — never on hashed
// classes. HARNESS TRAP: no reader returns a field named `value` or `result`
// (bench/fastlink.js evalIn unwraps those). All tasks are READ-ONLY or stop before submit.

// Syncfusion Tab wizard (train booking). Every control is an EJ2 component whose instance
// hangs off its host element (`el.ej2_instances[0]`). The four step panels are plain divs
// (#booking, #selectTrain, #passangerdetails [sic], #confirm); the visible one is the step.
// Train numbers and seat counts are RANDOM per search, so "the train with the most seats"
// is judged against the grid's own dataSource after the run. The fare is computed from the
// class (the demo's per-city fare loop never runs), read as shown in #amount.
const SF_WIZARD = `() => {
  const inst = (id) => { const e = document.getElementById(id); return (e && e.ej2_instances && e.ej2_instances[0]) || null; };
  const tab = inst('tab_wizard');
  if (!tab) return null;
  const shown = (id) => { const e = document.getElementById(id); return !!(e && e.offsetParent !== null && e.getClientRects().length); };
  const step = ['booking', 'selectTrain', 'passangerdetails', 'confirm'].findIndex(shown);
  const from = inst('startPoint'), to = inst('endPoint'), cls = inst('ticket_type');
  const trains = (((inst('availableTrain') || {}).dataSource) || []).map((t) => ({ no: String(t.TrainNo), seats: Number(t.Availability) }));
  const most = trains.length ? Math.max(...trains.map((t) => t.seats)) : null;
  const booked = ((inst('ticketDetailGrid') || {}).dataSource) || [];
  const p1 = booked[0] || {};
  const age1 = inst('pass_age1');
  const dlg = inst('alertDialog');
  const paid = !!(dlg && dlg.visible);
  const amountTxt = ((document.getElementById('amount') || {}).innerText || '').trim();
  return {
    url: location.href,
    step,
    route: (from ? from.value : '') + '->' + (to ? to.value : ''),
    ticketClass: cls && cls.value ? String(cls.value) : '',
    bookedTrain: p1.TrainNo ? String(p1.TrainNo) : '',
    bookedMostSeats: !!(p1.TrainNo && trains.some((t) => t.no === String(p1.TrainNo) && t.seats === most)),
    passenger1: p1.PassName ? [p1.PassName, age1 ? age1.value : '', p1.Gender, p1.Berth].join('|') : '',
    onConfirmUnpaid: step === 3 && booked.length === 1 && !paid,
    amount: (amountTxt.match(/\\$\\s*[\\d,]+/) || [''])[0],
  };
}`;

// Mantine Slider docs, first demo ("Usage" configurator): a preview <Slider> (0–100,
// starts at 40, marks 20/50/80 %) beside a controls panel (color, size, radius sliders,
// "Show label on hover" switch ON, "Label always on" switch OFF). The demo's code snippet
// lists only props that differ from the library default, so it is the structural proof of
// WHICH controls changed. The demo root is found from the switch's own label, never from
// Mantine's hashed m_* classes; the preview is the only 0–100 slider in that root (the
// size/radius controls are xs–xl sliders).
const MANTINE_USAGE = `() => {
  const lab = (i) => (((i.labels && i.labels[0]) || {}).textContent || i.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
  const sws = [...document.querySelectorAll('input[role="switch"]')];
  const always = sws.find((i) => /label always on/i.test(lab(i)));
  const hover = sws.find((i) => /show label on hover/i.test(lab(i)));
  if (!always) return null;
  // demo root = nearest ancestor of the switch that also holds the demo's code snippet
  let root = always.parentElement;
  while (root && !root.querySelector('pre')) root = root.parentElement;
  if (!root) return null;
  // The controls panel has its OWN 0–100 sliders (size md=50, radius xl=100 — verified live),
  // so the preview is the slider whose own track carries the 20% / 50% / 80% mark labels.
  const marked = (el) => { for (let n = el, i = 0; n && n !== root && i < 4; n = n.parentElement, i++) if (/20%[\\s\\S]*50%[\\s\\S]*80%/.test(n.textContent || '')) return true; return false; };
  const slider = [...root.querySelectorAll('[role="slider"]')].find(marked) || null;
  const code = (root.querySelector('pre') || {}).textContent || '';
  return {
    url: location.href,
    sliderAt: slider ? Number(slider.getAttribute('aria-valuenow')) : null,
    alwaysOn: !!always.checked,
    hoverOn: !!(hover && hover.checked),
    // Only the label toggle changed: the snippet gained labelAlwaysOn and nothing else.
    // It ALWAYS prints color="blue" (verified live on the untouched page), so color counts as
    // changed only when it is not blue; size/radius print only when moved off md/xl.
    onlyLabelToggled: /labelAlwaysOn/.test(code) && !/\\b(size|radius)=/.test(code) && !/\\bcolor="(?!blue")/.test(code) && !/showLabelOnHover=\\{false\\}/.test(code) && !!(hover && hover.checked),
  };
}`;

// Wunderbaum "Plain" demo: a 100k-node FMEA checkbox tree (tree id "demo"). Rows are
// VIRTUALIZED — only the visible rows exist in the DOM — and every "failure" node AND its
// "Causes"/"Effects" groups start collapsed (verified live: the type map says expanded, the
// rendered tree does not). Target path: top-level "Deliver reaching" (the 41st of 200
// top-level nodes, ~800 rows below the fold) > "Meaning is second-hand" (collapsed) >
// "Causes" (collapsed) > "Spots not provided". Every title on that path is unique among its
// siblings (checked offline against the tree's source JSON). Read through the tree's own
// API, nothing from the DOM.
const WB_TREE = `() => {
  const W = window.mar10 && window.mar10.Wunderbaum;
  const tree = W && W.getTree ? W.getTree('demo') : null;
  if (!tree || !tree.root) return null;
  const kid = (n, t) => ((n && n.children) || []).find((c) => c.title === t) || null;
  const top = kid(tree.root, 'Deliver reaching');
  const fail = kid(top, 'Meaning is second-hand');
  const causes = kid(fail, 'Causes');
  const target = kid(causes, 'Spots not provided');
  const sel = tree.getSelectedNodes ? tree.getSelectedNodes() : [];
  return {
    url: location.href,
    failExpanded: !!(fail && fail.isExpanded()),
    targetTicked: !!(target && target.isSelected()),
    onlyTarget: sel.length === 1 && sel[0] === target,
    causeCount: causes && causes.children ? causes.children.length : null,
  };
}`;

// National Rail "Live trains" finder. Each station box is an ARIA combobox
// (name=live_trains_origin / live_trains_destination) backed by a live station search; a
// sibling hidden input (hidden_live_trains_*) is filled ONLY when a suggestion is
// committed, so typed-but-not-picked text scores nothing. Searching navigates away from
// /live-trains/ to a results path — that guard is folded into the last eval.
const NR_LIVE = `() => {
  const v = (n) => ((document.querySelector('input[name="' + n + '"]') || {}).value || '').trim();
  const mode = (document.querySelector('input[name="live_trains_finder_type"]:checked') || {}).value || '';
  const fromText = v('live_trains_origin'), toText = v('live_trains_destination');
  const fromCode = v('hidden_live_trains_origin'), toCode = v('hidden_live_trains_destination');
  // The hidden field holds the committed station's CRS code (verified live: picking
  // "London Euston (EUS)" wrote "EUS"; typed text alone leaves it "").
  const fromCommitted = fromCode === 'MAN' && /manchester piccadilly/i.test(fromText);
  const toCommitted = toCode === 'EUS' && /london euston/i.test(toText);
  return {
    url: location.href,
    fromText, toText, fromCode, toCode,
    fromCommitted, toCommitted,
    departuresNotSearched: fromCommitted && toCommitted && mode === 'departures' && /^\\/live-trains\\/?$/.test(location.pathname),
  };
}`;

// Element Plus Dialog docs, "Customized Content" example: two buttons open two dialogs
// that BOTH carry the title "Shipping address" (a table one and a form one) — only the
// form one has "Promotion name". Dialog content is lazily rendered on first open and then
// kept (hidden) after Confirm/Cancel, so values are read whether or not it is still open,
// and "still open" is scored separately. el-form-item / el-select are Element Plus's own
// stable component classes (no ids or label-for on this example).
const EP_FORM_DIALOG = `() => {
  const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => /promotion name/i.test(x.textContent || ''));
  if (!d) return { url: location.href, open: false, promo: '', zone: '', leftOpenFilled: false };
  // The dialog is position:fixed, so offsetParent is ALWAYS null (read "closed" on an open
  // dialog — verified live). Closed = v-show display:none on the overlay → no client rects.
  const open = d.getClientRects().length > 0 && getComputedStyle(d).visibility !== 'hidden';
  const item = (re) => [...d.querySelectorAll('.el-form-item')].find((fi) => re.test(((fi.querySelector('label') || {}).textContent || '')));
  const pi = item(/promotion name/i), zi = item(/zones/i);
  const promo = ((pi && pi.querySelector('input')) || {}).value || '';
  const sel = zi && zi.querySelector('.el-select');
  let zone = sel ? (sel.innerText || '').replace(/\\s+/g, ' ').trim() : '';
  if (/please select/i.test(zone)) zone = '';
  return {
    url: location.href,
    open,
    promo: promo.trim(),
    zone,
    leftOpenFilled: open && promo.trim() === 'Spring Rail Sale' && zone === 'Zone No.2',
  };
}`;

// itch.io browse grid (/games, popular). The grid renders 36 games; each scroll to the
// bottom appends the next 36 (verified live: 36 → 72 → 108 …, no duplicate ids). Popularity
// order drifts over hours, which is fine: the 100th cell is read from the SAME live page after
// the run, never from a stored answer. Cell = .game_cell carrying data-game_id; title / author
// use itch.io's own plain class names (.game_title / .game_author — not hashed).
// Dropped before it: DEV's top feed (logged out it never loads past 18 cards) and Discourse
// Meta's top list (hvm's IP got network-errors on every load after ~10 quick page loads).
const ITCH_GRID = `(n) => {
  const cells = [...document.querySelectorAll('.game_cell[data-game_id]')];
  const ids = cells.map((c) => c.getAttribute('data-game_id'));
  const c = cells[n - 1];
  const txt = (sel) => (c ? (((c.querySelector(sel) || {}).textContent) || '').replace(/\\s+/g, ' ').trim() : '');
  return {
    url: location.href,
    loaded: cells.length,
    loadedEnough: cells.length >= n && new Set(ids).size === ids.length && /^\\/games\\/?$/.test(location.pathname),
    title: txt('.game_title a') || txt('.game_title'),
    author: txt('.game_author a') || txt('.game_author'),
  };
}`;

const LEAD = 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to';

export const HOLDOUT2 = [
  {
    id: 'h2_wizard',
    name: 'Dependent multi-step wizard (Syncfusion Tab wizard)',
    purpose: 'A 4-step wizard whose later steps are generated from earlier answers: the train list is built from From/To (random trains, so the pick must be READ, not guessed), the fare from the class; steps unlock only after validation. EJ2 dropdowns, a numeric box and a selectable grid.',
    url: 'https://ej2.syncfusion.com/demos/tab/wizard/',
    reset: { closeUrlPatterns: ['ej2.syncfusion.com/demos'] },
    prompt: `${LEAD} https://ej2.syncfusion.com/demos/tab/wizard/ . In the train-booking wizard: on "New Booking" set From = Chicago, To = Seattle and Ticket Type = Business Class (leave the journey date as it is), then press "Search Train". On "Train List" select the train with the MOST seats available and press Continue. On "Add Passenger" fill ONLY the first passenger row: Name = Grace Hopper, Age = 45, Gender = Female, Berth Preference = Window, then press Continue. Stop on the "Make Payment" step — do NOT make the payment. Then report the train number you booked and the total payable amount shown.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Syncfusion tab wizard demo', urlIncludes: 'tab/wizard' },
      { kind: 'eval', name: 'route = Chicago → Seattle (EJ2 dropdowns committed)', tab: 'tab/wizard', fn: SF_WIZARD, pick: 'route', expect: { equals: 'Chicago->Seattle' } },
      { kind: 'eval', name: 'ticket type = Business Class', tab: 'tab/wizard', fn: SF_WIZARD, pick: 'ticketClass', expect: { equals: 'Business Class' } },
      { kind: 'eval', name: 'booked the train with the most seats (from the generated list)', tab: 'tab/wizard', fn: SF_WIZARD, pick: 'bookedMostSeats', expect: { truthy: true } },
      { kind: 'eval', name: 'passenger 1 = Grace Hopper | 45 | Female | Window', tab: 'tab/wizard', fn: SF_WIZARD, pick: 'passenger1', expect: { equals: 'Grace Hopper|45|Female|Window' } },
      { kind: 'eval', name: 'on Make Payment with exactly 1 passenger, NOT paid', tab: 'tab/wizard', fn: SF_WIZARD, pick: 'onConfirmUnpaid', expect: { truthy: true } },
      { kind: 'live', name: 'reported the live booked train number', tab: 'tab/wizard', fn: SF_WIZARD, pick: 'bookedTrain', numeric: true },
      { kind: 'live', name: 'reported the live payable amount', tab: 'tab/wizard', fn: SF_WIZARD, pick: 'amount', numeric: true },
    ],
  },

  {
    id: 'h2_slider',
    name: 'Slider + switch (Mantine configurator)',
    purpose: 'A div-based ARIA slider (no <input type=range>) that has to land on an exact value, plus a role=switch toggle whose input is visually hidden behind its track — and neighbouring controls of the same kinds (size/radius sliders, another switch) that must stay untouched.',
    url: 'https://mantine.dev/core/slider/',
    reset: { closeUrlPatterns: ['mantine.dev'] },
    prompt: `${LEAD} https://mantine.dev/core/slider/ . In the FIRST demo on the page (the "Usage" playground: a slider that starts at 40 with 20% / 50% / 80% marks, next to a panel of controls), set the demo slider to exactly 70 and switch ON the "Label always on" toggle in that panel. Leave every other control as it is. Then report the demo slider's value.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Mantine slider docs', urlIncludes: 'mantine.dev/core/slider' },
      { kind: 'eval', name: 'demo slider = 70 (starts at 40)', tab: 'mantine.dev/core/slider', fn: MANTINE_USAGE, pick: 'sliderAt', expect: { equals: 70 } },
      { kind: 'eval', name: '"Label always on" switch ON (starts off)', tab: 'mantine.dev/core/slider', fn: MANTINE_USAGE, pick: 'alwaysOn', expect: { truthy: true } },
      { kind: 'eval', name: 'code snippet shows labelAlwaysOn and NO other prop changed', tab: 'mantine.dev/core/slider', fn: MANTINE_USAGE, pick: 'onlyLabelToggled', expect: { truthy: true } },
      { kind: 'live', name: 'reported the live slider value', tab: 'mantine.dev/core/slider', fn: MANTINE_USAGE, pick: 'sliderAt', numeric: true },
    ],
  },

  {
    id: 'h2_tree',
    name: 'Nested, collapsed, virtualized tree (Wunderbaum)',
    purpose: 'The target is 4 levels deep under TWO collapsed nodes, ~800 rows below the fold in a tree that renders only the visible rows — so it is not in the DOM until the tree is scrolled and both nodes expanded. Checkbox must land on exactly one node.',
    url: 'https://mar10.github.io/wunderbaum/demo/#demo-plain',
    reset: { closeUrlPatterns: ['mar10.github.io/wunderbaum'] },
    prompt: `${LEAD} https://mar10.github.io/wunderbaum/demo/#demo-plain . In the big tree on that page, find the top-level node "Deliver reaching", expand its child "Meaning is second-hand", then expand that node's "Causes" group and tick the checkbox of "Spots not provided". Tick nothing else, and do not rename, move or delete any node. Then report how many causes are listed under "Meaning is second-hand".`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Wunderbaum demo', urlIncludes: 'wunderbaum/demo' },
      { kind: 'eval', name: '"Meaning is second-hand" (under "Deliver reaching") expanded', tab: 'wunderbaum/demo', fn: WB_TREE, pick: 'failExpanded', expect: { truthy: true } },
      { kind: 'eval', name: '"Spots not provided" ticked (at that exact path)', tab: 'wunderbaum/demo', fn: WB_TREE, pick: 'targetTicked', expect: { truthy: true } },
      { kind: 'eval', name: 'ONLY that node is ticked', tab: 'wunderbaum/demo', fn: WB_TREE, pick: 'onlyTarget', expect: { truthy: true } },
      { kind: 'live', name: 'reported the live cause count', tab: 'wunderbaum/demo', fn: WB_TREE, pick: 'causeCount', numeric: true },
    ],
  },

  {
    id: 'h2_autocomplete',
    name: 'Live typeahead that must be committed (National Rail)',
    purpose: 'Two station comboboxes backed by a live station search. Typed text is not a station: only picking a suggestion fills the hidden commit field. Stop before search.',
    url: 'https://www.nationalrail.co.uk/live-trains/',
    // Clear the origin too, in case the site remembers recent stations and pre-fills them.
    reset: {
      closeUrlPatterns: ['nationalrail.co.uk'],
      clearStorage: ['https://www.nationalrail.co.uk/live-trains/'],
    },
    prompt: `${LEAD} https://www.nationalrail.co.uk/live-trains/ . In the live trains finder keep "Departures" selected, set the departure station to Manchester Piccadilly and the destination ("to") station to London Euston — for each, type part of the name and pick the matching station from the suggestions the site shows. Do NOT press the search button. Then report the two station names exactly as the form shows them.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on National Rail live trains', urlIncludes: 'nationalrail.co.uk/live-trains' },
      { kind: 'eval', name: 'departure station committed = Manchester Piccadilly (hidden field filled)', tab: 'nationalrail.co.uk/live-trains', fn: NR_LIVE, pick: 'fromCommitted', expect: { truthy: true } },
      { kind: 'eval', name: 'destination station committed = London Euston (hidden field filled)', tab: 'nationalrail.co.uk/live-trains', fn: NR_LIVE, pick: 'toCommitted', expect: { truthy: true } },
      { kind: 'eval', name: 'both committed, Departures kept, search NOT run', tab: 'nationalrail.co.uk/live-trains', fn: NR_LIVE, pick: 'departuresNotSearched', expect: { truthy: true } },
      { kind: 'live', name: 'reported the live departure station text', tab: 'nationalrail.co.uk/live-trains', fn: NR_LIVE, pick: 'fromText' },
      { kind: 'live', name: 'reported the live destination station text', tab: 'nationalrail.co.uk/live-trains', fn: NR_LIVE, pick: 'toText' },
    ],
  },

  {
    id: 'h2_modal',
    name: 'Form inside a modal dialog (Element Plus)',
    purpose: 'The form does not exist until a button opens a teleported modal; a SECOND button opens a different dialog with the SAME title; the select inside the modal opens a popper outside it. Stop before Confirm.',
    url: 'https://element-plus.org/en-US/component/dialog.html',
    reset: { closeUrlPatterns: ['element-plus.org'] },
    prompt: `${LEAD} https://element-plus.org/en-US/component/dialog.html . In the "Customized Content" example click "Open a Form nested Dialog". In the "Shipping address" dialog that opens, set Promotion name = Spring Rail Sale and Zones = Zone No.2. Do NOT click Confirm or Cancel — leave the dialog open with those values. Then report both values as the dialog shows them.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Element Plus dialog docs', urlIncludes: 'element-plus.org/en-US/component/dialog' },
      { kind: 'eval', name: 'Promotion name = Spring Rail Sale (in the FORM dialog)', tab: 'element-plus.org/en-US/component/dialog', fn: EP_FORM_DIALOG, pick: 'promo', expect: { equals: 'Spring Rail Sale' } },
      { kind: 'eval', name: 'Zones = Zone No.2 (el-select committed)', tab: 'element-plus.org/en-US/component/dialog', fn: EP_FORM_DIALOG, pick: 'zone', expect: { equals: 'Zone No.2' } },
      { kind: 'eval', name: 'dialog still open with both values (Confirm/Cancel NOT clicked)', tab: 'element-plus.org/en-US/component/dialog', fn: EP_FORM_DIALOG, pick: 'leftOpenFilled', expect: { truthy: true } },
      { kind: 'live', name: 'reported the live promotion name', tab: 'element-plus.org/en-US/component/dialog', fn: EP_FORM_DIALOG, pick: 'promo' },
      { kind: 'live', name: 'reported the live zone', tab: 'element-plus.org/en-US/component/dialog', fn: EP_FORM_DIALOG, pick: 'zone' },
    ],
  },

  {
    id: 'h2_infinite',
    name: 'Infinite-scroll grid (itch.io browse)',
    purpose: 'The answer is two loads past the first batch: the grid renders 36 games and appends 36 more only when scrolled to the bottom, so the 100th cell does not exist until the grid has been scrolled twice. Tests loading more instead of answering from the first screen.',
    url: 'https://itch.io/games',
    reset: { closeUrlPatterns: ['itch.io/games'] },
    prompt: `${LEAD} https://itch.io/games (itch.io's browse page of popular games). The grid loads more games as you scroll. Scroll until at least 100 games are loaded, then report the title and the author (creator) of the 100th game in the grid, counting in reading order (left to right, top to bottom). Do not sign in, download, buy or follow anything.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the itch.io games grid', urlIncludes: 'itch.io/games' },
      { kind: 'eval', name: 'at least 100 games loaded (36 on first load), no duplicates, still on /games', tab: 'itch.io/games', fn: ITCH_GRID, args: [100], pick: 'loadedEnough', expect: { truthy: true } },
      { kind: 'live', name: 'reported the live 100th game title', tab: 'itch.io/games', fn: ITCH_GRID, args: [100], pick: 'title' },
      { kind: 'live', name: 'reported the live 100th game author', tab: 'itch.io/games', fn: ITCH_GRID, args: [100], pick: 'author' },
    ],
  },
];
