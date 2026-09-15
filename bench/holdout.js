// holdout.js — the HOLDOUT set: public sites FastLink was never tuned against, as DATA
// ONLY, same shape as suite.js. It exists to check that a fix generalizes ("every
// website is different — it has to work everywhere"): nothing in fast-ext/ or
// fast-runner/ may ever special-case one of these sites, and no fix may be validated
// ONLY here and then tuned until it passes.
//
// One site per widget family, none shared with suite.js or any earlier live proof:
//   h_conditional  GOV.UK design system  – a choice REVEALS the field to fill
//   h_datepicker   jQuery UI (inline)    – a calendar with NO input behind it
//   h_combobox     Select2               – searchable select that must be COMMITTED
//   h_table        DataTables            – sort + paginate to reach one specific row
//   h_repeat       Form.io data grid     – "Add Another" row, custom select, conditional field
//   h_spa          jsDelivr              – client-routed SPA: search → package → tab
//
// Same CHECKPOINT CONTRACT as suite.js (kinds, matchers, ordering). Every checkpoint
// here was validated in BOTH directions on the hvm rig — FAIL on an untouched page,
// PASS after the task was done by hand through the local FastLink tools — so
// there is no "not submitted" checkpoint that an untouched page passes for free: the
// guard is folded into a checkpoint that also needs real work.
//
// Readers key on ids / names / aria / the widget's own API — never on hashed classes.
// All tasks are READ-ONLY or stop before submit; nothing here sends data anywhere.

// GOV.UK "conditional reveal" radios. The three follow-up inputs exist in the DOM
// from load, inside panels carrying `govuk-radios__conditional--hidden`; picking a
// radio removes that class from ITS panel only. Nothing is pre-checked.
const GOVUK_CONTACT = `() => {
  const r = document.querySelector('input[name="contact"]:checked');
  const v = (id) => ((document.getElementById(id) || {}).value || '').trim();
  const panel = document.getElementById('conditional-contact-3');
  const email = v('contact-by-email'), phone = v('contact-by-phone'), text = v('contact-by-text');
  return {
    url: location.href,
    choice: r ? r.value : '',
    textPanelShown: !!(panel && !panel.classList.contains('govuk-radios__conditional--hidden')),
    textDigits: text.replace(/\\D/g, ''),
    text,
    onlyText: !!text && !email && !phone,
  };
}`;

// jQuery UI inline datepicker: a bare <div id="datepicker">, no input at all, so the
// only way to set it is to operate the calendar. Read through the widget's own API.
const JQUI_INLINE = `() => {
  const $ = window.jQuery;
  if (!$ || !$.datepicker) return null;
  const d = $('#datepicker').datepicker('getDate');
  const title = (document.querySelector('#datepicker .ui-datepicker-title') || {}).textContent || '';
  return {
    url: location.href,
    iso: d ? $.datepicker.formatDate('yy-mm-dd', d) : '',
    us: d ? $.datepicker.formatDate('mm/dd/yy', d) : '',
    shownMonth: title.replace(/\\s+/g, ' ').trim(),
  };
}`;

// Select2 "single select boxes" example. The <select> keeps the committed value; the
// widget's own data() is what the user sees. Both are read: a typed-but-uncommitted
// search changes neither. The page's first single select starts on Alaska (AK), 50
// states grouped by time zone; a plain native twin (`select.js-states`, no Select2)
// sits above it and also shows Alaska — only `.js-example-basic-single` is scored.
const SELECT2_SINGLE = `() => {
  const s = document.querySelector('select.js-example-basic-single');
  if (!s) return null;
  // What the user sees = the widget's rendered selection TEXT (Select2's own container,
  // the element right after the hidden <select>). Both select2('data')[0].text and the
  // rendered node's title attribute read the option VALUE ("AK") on this page — only
  // the text node carries "Alaska" (verified live on hvm).
  const w = s.nextElementSibling;
  const r = w && w.querySelector('.select2-selection__rendered');
  const shown = r ? (r.textContent || '') : '';
  return { url: location.href, value: s.value, shown: shown.replace(/^×/, '').trim() };
}`;

// DataTables zero-configuration example (#example, 57 employees, 10 per page).
// Order and page come from the table's own API; the first row is read from the
// CURRENT page, after the run, so the live probe is whatever the table shows.
const DT_EXAMPLE = `() => {
  if (!window.DataTable) return null;
  // retrieve:true hands back the page's existing instance (new DataTable.Api('#example')
  // throws on DT2 — verified live).
  const api = new DataTable('#example', { retrieve: true });
  const ord = api.order()[0] || [];
  const row = api.rows({ page: 'current', order: 'current', search: 'applied' }).data().toArray()[0] || [];
  const salaryIdx = [...document.querySelectorAll('#example thead th')].findIndex((th) => /salary/i.test(th.textContent));
  return {
    url: location.href,
    salaryDesc: ord[0] === salaryIdx && ord[1] === 'desc',
    page: api.page.info().page + 1,
    name: String(row[0] || '').trim(),
    office: String(row[2] || '').trim(),
    salary: String(row[5] || '').trim(),
  };
}`;

// Form.io data grid example. The page seeds two rows (Joe Smith, Mary Smith); read
// the renderer's own submission data, not the DOM. `submitted` = the success alert
// Form.io paints on submit — folded into the last checkpoint, never scored alone.
const FORMIO_GRID = `() => {
  const f = window.Formio && Formio.forms && Object.values(Formio.forms)[0];
  if (!f) return null;
  const rows = (f.submission && f.submission.data && f.submission.data.children) || [];
  const r3 = rows[2] || {};
  const submitted = !!document.querySelector('#formio .alert-success');
  return {
    url: location.href,
    count: rows.length,
    seedKept: rows.length === 3 && (rows[0] || {}).firstName === 'Joe' && (rows[1] || {}).firstName === 'Mary',
    first: r3.firstName || '',
    last: r3.lastName || '',
    gender: r3.gender || '',
    dependant: r3.dependant === true,
    birthdate: String(r3.birthdate || ''),
    birthdateNotSubmitted: /^2015-12-10/.test(String(r3.birthdate || '')) && !submitted,
  };
}`;

// jsDelivr package page. Identity and tab come from the client-routed URL; the version
// from the package header's "Version x.y.z" line (the same page lists other versions,
// e.g. "Top version - 1.10.4", further down — only the labelled one counts).
const JSD_PKG = `() => {
  const m = location.pathname.match(/\\/package\\/npm\\/([^/?#]+)/);
  const params = new URLSearchParams(location.search);
  const txt = document.body.innerText || '';
  const ver = m ? ((txt.match(/\\bVersion\\s+(\\d+\\.\\d+\\.\\d+[\\w.-]*)/) || [])[1] || '') : '';
  return { url: location.href, pkg: m ? m[1] : '', tab: params.get('tab') || '', version: ver };
}`;

const LEAD = 'Using the FastLink browser connector (drive my real Chrome tab; do NOT use your own web search or built-in browsing), open a NEW TAB to';

export const HOLDOUT = [
  {
    id: 'h_conditional',
    name: 'Conditional reveal (GOV.UK radios)',
    purpose: 'A field that does not exist for the user until a choice is made: the follow-up input is in the DOM but hidden until its radio is picked. Tests choose → re-read → fill the NEWLY revealed field, not a hidden twin.',
    url: 'https://design-system.service.gov.uk/components/radios/conditional-reveal/index.html',
    reset: { closeUrlPatterns: ['design-system.service.gov.uk'] },
    prompt: `${LEAD} https://design-system.service.gov.uk/components/radios/conditional-reveal/index.html . Answer "How would you prefer to be contacted?" with "Text message", then fill the mobile phone number field that appears with 07700 900982. Do NOT fill the email or phone fields and do not submit anything. Then report the value in the mobile phone number field.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the GOV.UK example', urlIncludes: 'conditional-reveal' },
      { kind: 'eval', name: 'Text message chosen (nothing is pre-checked)', tab: 'conditional-reveal', fn: GOVUK_CONTACT, pick: 'choice', expect: { equals: 'text' } },
      { kind: 'eval', name: 'the Text-message follow-up panel is revealed', tab: 'conditional-reveal', fn: GOVUK_CONTACT, pick: 'textPanelShown', expect: { truthy: true } },
      { kind: 'eval', name: 'mobile number = 07700 900982 (in the REVEALED field)', tab: 'conditional-reveal', fn: GOVUK_CONTACT, pick: 'textDigits', expect: { equals: '07700900982' } },
      { kind: 'eval', name: 'ONLY the mobile field is filled (email/phone twins untouched)', tab: 'conditional-reveal', fn: GOVUK_CONTACT, pick: 'onlyText', expect: { truthy: true } },
      { kind: 'live', name: 'reported the live mobile number', tab: 'conditional-reveal', fn: GOVUK_CONTACT, pick: 'text' },
    ],
  },

  {
    id: 'h_datepicker',
    name: 'Inline calendar, no input (jQuery UI datepicker)',
    purpose: 'A date picker with NO text input behind it — typing is impossible, the calendar must be operated (month navigation + day cell). The widget opens on today, so the target date is months away.',
    url: 'https://jqueryui.com/resources/demos/datepicker/inline.html',
    reset: { closeUrlPatterns: ['jqueryui.com/resources/demos/datepicker'] },
    prompt: `${LEAD} https://jqueryui.com/resources/demos/datepicker/inline.html and, in the calendar on that page, select the date 24 December 2026. Then report the selected date as MM/DD/YYYY.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the inline datepicker demo', urlIncludes: 'datepicker/inline' },
      { kind: 'eval', name: 'calendar navigated to December 2026', tab: 'datepicker/inline', fn: JQUI_INLINE, pick: 'shownMonth', expect: { equalsIgnoreCase: 'December 2026' } },
      { kind: 'eval', name: 'selected date = 2026-12-24 (widget API)', tab: 'datepicker/inline', fn: JQUI_INLINE, pick: 'iso', expect: { equals: '2026-12-24' } },
      { kind: 'live', name: 'reported the live selected date', tab: 'datepicker/inline', fn: JQUI_INLINE, pick: 'us' },
    ],
  },

  {
    id: 'h_combobox',
    name: 'Searchable select that must be committed (Select2)',
    purpose: 'The classic jQuery searchable select: the real <select> is hidden, the menu and search box portal to <body>, and typed text is NOT a value until an option is committed. Starts on Alaska, so any pass needs a real commit.',
    url: 'https://select2.org/getting-started/basic-usage',
    reset: { closeUrlPatterns: ['select2.org'] },
    prompt: `${LEAD} https://select2.org/getting-started/basic-usage and, in the "Single select boxes" example (the single-value state dropdown), search for and select "Oregon". Then report the selected value.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Select2 basic-usage page', urlIncludes: 'select2.org/getting-started/basic-usage' },
      { kind: 'eval', name: 'underlying <select> value = OR (committed, not just typed)', tab: 'select2.org', fn: SELECT2_SINGLE, pick: 'value', expect: { equals: 'OR' } },
      { kind: 'eval', name: 'widget shows Oregon', tab: 'select2.org', fn: SELECT2_SINGLE, pick: 'shown', expect: { equalsIgnoreCase: 'Oregon' } },
      { kind: 'live', name: 'reported the live selected value', tab: 'select2.org', fn: SELECT2_SINGLE, pick: 'shown' },
    ],
  },

  {
    id: 'h_table',
    name: 'Sort + paginate to one row (DataTables)',
    purpose: 'A client-side paginated table where the answer is one specific row that only exists on screen after a sort AND a page change. Tests operating table controls instead of guessing from the first page.',
    url: 'https://datatables.net/examples/basic_init/zero_configuration.html',
    reset: { closeUrlPatterns: ['datatables.net/examples'] },
    prompt: `${LEAD} https://datatables.net/examples/basic_init/zero_configuration.html . Using the table's own controls, sort the employee table by Salary from HIGHEST to lowest, then go to page 2 of the table. Leave the table in that state and report the Name, Office and Salary of the FIRST row on page 2.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the DataTables example', urlIncludes: 'zero_configuration' },
      { kind: 'eval', name: 'table sorted by Salary, descending (default is Name ascending)', tab: 'zero_configuration', fn: DT_EXAMPLE, pick: 'salaryDesc', expect: { truthy: true } },
      { kind: 'eval', name: 'table is on page 2', tab: 'zero_configuration', fn: DT_EXAMPLE, pick: 'page', expect: { equals: 2 } },
      { kind: 'live', name: 'reported the live first-row name', tab: 'zero_configuration', fn: DT_EXAMPLE, pick: 'name' },
      { kind: 'live', name: 'reported the live first-row office', tab: 'zero_configuration', fn: DT_EXAMPLE, pick: 'office' },
      { kind: 'live', name: 'reported the live first-row salary', tab: 'zero_configuration', fn: DT_EXAMPLE, pick: 'salary', numeric: true },
    ],
  },

  {
    id: 'h_repeat',
    name: 'Repeatable rows with an add button (Form.io data grid)',
    purpose: 'A repeatable section: the new row does not exist until "Add Another" is pressed, its fields share labels with the seeded rows above it, Gender is a Choices.js custom select, and Birthdate only appears once Dependant is ticked.',
    url: 'https://formio.github.io/formio.js/app/examples/datagrid.html',
    reset: { closeUrlPatterns: ['formio.github.io/formio.js'] },
    prompt: `${LEAD} https://formio.github.io/formio.js/app/examples/datagrid.html . The "Children" grid already has two rows (Joe Smith and Mary Smith) — leave them unchanged. Add a THIRD row with the grid's add button and fill it: First Name = Ada, Last Name = Lovelace, Gender = Female, tick Dependant, and then set the Birthdate that appears to 2015-12-10. Do NOT click Submit. Then report the third row's values.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on the Form.io data grid example', urlIncludes: 'examples/datagrid.html' },
      { kind: 'eval', name: 'exactly 3 rows, seeded Joe/Mary rows kept', tab: 'examples/datagrid.html', fn: FORMIO_GRID, pick: 'seedKept', expect: { truthy: true } },
      { kind: 'eval', name: 'row 3 First Name = Ada', tab: 'examples/datagrid.html', fn: FORMIO_GRID, pick: 'first', expect: { equals: 'Ada' } },
      { kind: 'eval', name: 'row 3 Last Name = Lovelace', tab: 'examples/datagrid.html', fn: FORMIO_GRID, pick: 'last', expect: { equals: 'Lovelace' } },
      { kind: 'eval', name: 'row 3 Gender = female (custom select committed)', tab: 'examples/datagrid.html', fn: FORMIO_GRID, pick: 'gender', expect: { equals: 'female' } },
      { kind: 'eval', name: 'row 3 Dependant ticked', tab: 'examples/datagrid.html', fn: FORMIO_GRID, pick: 'dependant', expect: { truthy: true } },
      { kind: 'eval', name: 'row 3 Birthdate = 2015-12-10 (revealed field) and form NOT submitted', tab: 'examples/datagrid.html', fn: FORMIO_GRID, pick: 'birthdateNotSubmitted', expect: { truthy: true } },
    ],
  },

  {
    id: 'h_spa',
    name: 'Client-routed SPA: search → package → tab (jsDelivr)',
    purpose: 'A single-page app whose views are client-routed (no document load between them): site search, a results list, a package detail page, then a tab inside it. Tests acting on views that appear without a page load.',
    url: 'https://www.jsdelivr.com/',
    reset: { closeUrlPatterns: ['jsdelivr.com'] },
    prompt: `${LEAD} https://www.jsdelivr.com/ , use the site's search box to search for "dayjs", open the npm package "dayjs" from the search results, then open its "Files" tab. Report the package version jsDelivr shows there.`,
    checkpoints: [
      { kind: 'tab', name: 'tab opened on jsdelivr.com', urlIncludes: 'jsdelivr.com' },
      { kind: 'trail', name: 'searched on the site (query in the URL)', urlIncludes: 'query=dayjs' },
      { kind: 'eval', name: 'ended on the dayjs package page', tab: 'jsdelivr.com', fn: JSD_PKG, pick: 'pkg', expect: { equals: 'dayjs' } },
      { kind: 'eval', name: 'Files tab open', tab: 'jsdelivr.com', fn: JSD_PKG, pick: 'tab', expect: { equals: 'files' } },
      { kind: 'live', name: 'reported the live version', tab: 'jsdelivr.com', fn: JSD_PKG, pick: 'version' },
    ],
  },
];
