// MCP tool definitions — THE one schema source (docs/PIN-REDESIGN.md §1). The
// fast-dxt helper fetches tools/list from the relay and passes it through
// (it fills `browser`/`tabId` itself and adds its local fast_profile).
// Descriptions stay short: what the tool does, its key arguments, at most one gotcha (<= 300 chars).
// Every browser-touching tool also takes `browser` and `tabId` (added by withTarget below).

const BROWSER_ARG = { type: 'string', description: 'Browser name to drive (see fast_status). Omitted: the only online browser.' };
const TAB_ARG = { type: 'number', description: 'Tab id to act on, without changing the browser\'s target tab. Omitted: the target tab.' };

const RELAY_TOOLS = [
  {
    name: 'fast_status',
    description: 'Which browsers are paired and online, and which browser a call is routed to. Call when other tools say a browser is not connected.',
    inputSchema: {
      type: 'object',
      properties: {
        browser: { type: 'string', description: 'Report routing for this browser name instead of the default.' },
      },
      required: [],
    },
  },
  {
    name: 'fast_feedback',
    description: 'Send a note to the FastLink developers: a bug, a missing feature, or something confusing. Works with no browser connected.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', maxLength: 4000, description: 'What happened or what you need (up to 4000 characters).' },
        kind: { type: 'string', enum: ['bug', 'idea', 'other'], description: 'Default "other".' },
        browser: { type: 'string', description: 'Browser name the note is about (optional).' },
      },
      required: ['text'],
    },
  },
  {
    name: 'fast_handoff_cancel',
    description: 'End a fast_handoff link that is no longer needed (the check went away or was solved another way). The link stops working at once.',
    inputSchema: {
      type: 'object',
      properties: { handoffId: { type: 'string', description: 'The handoffId fast_handoff returned.' } },
      required: ['handoffId'],
    },
  },
  {
    name: 'fast_handoff_wait',
    description: 'Wait (up to 25 s per call) for a fast_handoff to finish. Returns status pending, done (the person tapped Done), or expired. Call again while pending.',
    inputSchema: {
      type: 'object',
      properties: {
        handoffId: { type: 'string', description: 'The handoffId fast_handoff returned.' },
        waitSec: { type: 'number', description: 'Seconds to wait, 0-25 (default 20).' },
      },
      required: ['handoffId'],
    },
  },
];

const BROWSER_TOOLS = [
  {
    name: 'fast_fetch',
    description: 'Service tokens only: fetch(url) from inside an open tab on the same site, with the page\'s own cookies. Returns {status, body} (body cut at 512 KB). Only origins allowed for the token; GET, POST or HEAD.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute https URL on the tab\'s own origin.' },
        method: { type: 'string', enum: ['GET', 'POST', 'HEAD'], description: 'Default GET.' },
        headers: { type: 'object', description: 'Extra request headers (strings).' },
        body: { type: 'string', description: 'Request body for POST (up to 64 KB).' },
      },
      required: ['url', 'tabId'],
    },
  },
  {
    name: 'fast_update',
    description: 'Restart FastLink in a browser to load a newer version (from its update feed, or from disk for an unpacked copy). It answers first, then reconnects within seconds; check fast_status for the version. Tabs and pairing are kept.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'fast_handoff',
    description: 'A captcha or "are you human" check you must not solve: get a short-lived link for the user to open on their phone. It shows only the check, and their taps click it. Send them the link, then call fast_handoff_wait. Never solve the check yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', maxLength: 200, description: 'One line shown above the check (default: tap the check, then Done).' },
        minutes: { type: 'number', description: 'How long the link works, 1-30 (default 10).' },
        region: {
          type: 'object', description: 'Only if the check is not found automatically: the area to show, in viewport CSS px.',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        },
      },
      required: [],
    },
  },
  {
    name: 'fast_snapshot',
    description: 'Read the page: `items` are controls as {i, tag, label, value} (offscreen:true when below the fold; an open dialog first) plus `content` text. Visible frames are under `frames`, their ids "f<frameId>:<i>". truncated:true means this read was cut: call again with full:true.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'A frame by origin or id ("f7"): act inside it (see fast_snapshot `frames`).' },
        viewport: { type: 'boolean', description: 'Only on-screen items.' },
        overlay: { type: 'boolean', description: 'Also list items of an open menu or popover.' },
        full: { type: 'boolean', description: 'No item cap.' },
        limit: { type: 'number', description: 'Item cap (default ~70).' },
        screenshot: { type: 'boolean', description: 'Also save a screenshot.' },
        screenshotFormat: { type: 'string', enum: ['png', 'jpeg'], description: 'png (default) or jpeg.' },
      },
    },
  },
  {
    name: 'fast_click',
    description: 'Click by `id` (a snapshot item\'s i, e.g. "42" or "f7:42") or by `text`; `role`/`tag` narrow a text match. Returns what changed (url, dialog, focus) and a page preview. For a dropdown use fast_select_option.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible text, label, aria-label or placeholder to match.' },
        id: { type: 'string', description: 'Snapshot item id: "42", or "f7:42" inside a frame.' },
        frame: { type: 'string', description: 'A frame by origin or id ("f7"): act inside it (see fast_snapshot `frames`).' },
        role: { type: 'string', description: 'Only elements with this role (e.g. "button", "tab", "option").' },
        tag: { type: 'string', description: 'Only elements with this tag (e.g. "a").' },
        index: { type: 'number', description: 'With `text` only: the N-th match (0-based). Never an item id.' },
        screenshot: { type: 'boolean', description: 'Also save a screenshot after the click.' },
        screenshotFormat: { type: 'string', enum: ['png', 'jpeg'], description: 'png (default) or jpeg.' },
        noSnapshot: { type: 'boolean', description: 'Skip the page preview.' },
      },
    },
  },
  {
    name: 'fast_fill',
    description: 'Set text fields by label: one with `match`+`value`, or many with `fields`:{label: value}. Returns each field\'s read-back `value` (report that, not what you sent). For a dropdown use fast_select_option.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'A frame by origin or id ("f7"): act inside it (see fast_snapshot `frames`).' },
        match: { type: 'string', description: 'Label, placeholder or name of ONE field.' },
        value: { type: 'string', description: 'Value for `match` ("" clears).' },
        fields: { type: 'object', description: '{label: value} for several fields; a value may be {value, index, section}.' },
        append: { type: 'boolean', description: 'Append instead of replacing.' },
        index: { type: 'number', description: 'N-th field matching `match` (0-based).' },
        section: { type: 'string', description: 'Only fields under this heading.' },
        near: { type: 'string', description: 'Alias of `section`.' },
        noSnapshot: { type: 'boolean', description: 'Skip the page preview.' },
      },
    },
  },
  {
    name: 'fast_tab',
    description: 'Open `url` in a new tab and wait for it to load. Returns the tab id and a page preview to act on.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open.' },
        background: { type: 'boolean', description: 'Default true: opens without raising Chrome. false: bring it to the front.' },
        waitMs: { type: 'number', description: 'Max load wait in ms (default 10000).' },
        noSnapshot: { type: 'boolean', description: 'Skip the page preview.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'fast_nav',
    description: 'Load `url` in the current tab and wait for it to load. Returns a page preview to act on.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to load.' },
        waitMs: { type: 'number', description: 'Max load wait in ms (default 10000).' },
        noSnapshot: { type: 'boolean', description: 'Skip the page preview.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'fast_list',
    description: 'List open tabs in every window: id, windowId, url, title, active.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'fast_switch',
    description: 'Target another tab, by `tabId` or URL/title `match`.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab id from fast_list.' },
        match: { type: 'string', description: 'URL or title substring.' },
        focus: { type: 'boolean', description: 'Default false: target it without raising Chrome. true: bring it to the front.' },
      },
    },
  },
  {
    name: 'fast_wait',
    description: 'Wait until `text` appears (frames included) or `selector` matches; networkIdle:true waits for requests to settle. Returns the match and a page preview, or the visible headings on timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'A frame by origin or id ("f7"): act inside it (see fast_snapshot `frames`).' },
        text: { type: 'string', description: 'Text to wait for (use 2+ words).' },
        selector: { type: 'string', description: 'CSS selector of a visible element.' },
        networkIdle: { type: 'boolean', description: 'Wait for the network to go quiet.' },
        idleMs: { type: 'number', description: 'Quiet time for networkIdle (default 500).' },
        timeoutMs: { type: 'number', description: 'Max wait in ms (default 5000).' },
        noSnapshot: { type: 'boolean', description: 'Skip the page preview.' },
      },
    },
  },
  {
    name: 'fast_frame_read',
    description: 'Scorer only, never offered to a model: read labelled field values inside frames whose URL contains `frame`.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'Part of the frame URL.' },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Field labels to read.',
        },
      },
      required: ['frame', 'fields'],
    },
  },
  {
    name: 'fast_text',
    description: 'Page text, or one element\'s via `selector` (a form control returns its live value). truncated:true means cut: raise `maxLen` or narrow the selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector (default body).' },
        html: { type: 'boolean', description: 'Return HTML instead of text.' },
        maxLen: { type: 'number', description: 'Max characters.' },
      },
    },
  },
  {
    name: 'fast_select_option',
    description: 'Choose `option` in the dropdown labelled `field`, or several at once with `selections`:{field: option}. Returns the value the control now shows.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'A frame by origin or id ("f7"): act inside it (see fast_snapshot `frames`).' },
        field: { type: 'string', description: 'Dropdown label, name or id.' },
        option: { type: 'string', description: 'Option text.' },
        selections: { type: 'object', description: '{field: option} for several dropdowns.' },
        index: { type: 'number', description: 'N-th dropdown matching `field` (0-based).' },
        section: { type: 'string', description: 'Only dropdowns under this heading.' },
        noSnapshot: { type: 'boolean', description: 'Skip the page preview.' },
      },
    },
  },
  {
    name: 'fast_screenshot',
    description: 'Capture the tab as an image. Last resort, for what the DOM cannot show (canvas, images): read and act with fast_snapshot first.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['png', 'jpeg'], description: 'png (default) or jpeg.' },
        quality: { type: 'number', description: 'JPEG quality 0-100.' },
        fresh: { type: 'boolean', description: 'Force a new frame if the last image looked stale.' },
      },
    },
  },
  {
    name: 'fast_key_press',
    description: 'Press one `key` (Enter, Escape, Tab, ArrowDown…) on the focused element. Returns url change and a page preview.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name, e.g. "Enter".' },
      },
      required: ['key'],
    },
  },
  {
    name: 'fast_scroll',
    description: 'Scroll the page, a container (`selector`) or a frame: `to` top/bottom/"50%", `pixels`, or one screen down by default. Returns how far it moved and a page preview.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'A frame by origin or id ("f7"): act inside it (see fast_snapshot `frames`).' },
        to: { type: 'string', description: 'top, bottom or a percentage like "50%".' },
        pixels: { type: 'number', description: 'Pixels (negative = up).' },
        selector: { type: 'string', description: 'CSS selector of the scroll container.' },
        noSnapshot: { type: 'boolean', description: 'Skip the page preview.' },
      },
    },
  },
  {
    name: 'fast_close',
    description: 'Close a tab by `tabId` or URL/title `match`.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Tab id from fast_list.' },
        match: { type: 'string', description: 'URL or title substring.' },
      },
    },
  },
  {
    name: 'fast_batch',
    description: 'Chain steps you already know in one call: `actions`:[{name, args}], or {ifFound, then, else} to branch without a turn. Every step runs and the summary says what each step changed; one page preview comes at the end.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              args: { type: 'object' },
              ifFound: { type: 'string', description: 'Text or CSS selector to probe; then/else run instead of name/args.' },
              then: {
                type: 'array',
                items: { type: 'object' },
              },
              else: {
                type: 'array',
                items: { type: 'object' },
              },
              waitMs: { type: 'number', description: 'How long ifFound may wait (default 1000).' },
            },
          },
          description: 'Steps in order.',
        },
      },
      required: ['actions'],
    },
  },
  {
    name: 'fast_click_xy',
    description: 'Real mouse click at top-page CSS pixels `x`,`y`. Reports where focus landed. Only when click by id or text cannot reach the element.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X in CSS pixels.' },
        y: { type: 'number', description: 'Y in CSS pixels.' },
        button: { type: 'string', description: 'left (default), right or middle.' },
        clickCount: { type: 'number', description: '2 for a double-click.' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'fast_type',
    description: 'Type `text` into the focused element (focus it first); `clear:true` replaces the current value. Returns whether the field reads back the text.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type.' },
        clear: { type: 'boolean', description: 'Replace the current value.' },
        force: { type: 'boolean', description: 'Set right after a fast_click_xy focused this field.' },
      },
      required: ['text'],
    },
  },
];

// fast_list and fast_tab act on the browser, not a tab, so they take no TAB_ARG;
// fast_switch and fast_close keep their own `tabId` (the tab to target / close).
const NO_TAB_ARG = new Set(['fast_list', 'fast_tab', 'fast_update']);

function withTarget(tool) {
  const props = { ...tool.inputSchema.properties, browser: BROWSER_ARG };
  if (!('tabId' in props) && !NO_TAB_ARG.has(tool.name)) props.tabId = TAB_ARG;
  return { ...tool, inputSchema: { ...tool.inputSchema, properties: props } };
}

export const TOOLS = [...RELAY_TOOLS, ...BROWSER_TOOLS.map(withTarget)];

// Page JavaScript: listed only for accounts with users.allow_evaluate, and run only on a
// browser whose hello says evaluate:"on" (the operator build, scripts/build-operator.sh).
// Never in the Web Store / feed extension.
export const EVALUATE_TOOL = withTarget({
  name: 'fast_evaluate',
  description: 'Run a JS function in the page (main world) and return its JSON result. Only on operator browsers; for what fast_snapshot / fast_text and the DOM tools cannot do.',
  inputSchema: {
    type: 'object',
    properties: {
      fn: { type: 'string', description: 'Function source, e.g. "() => document.title". May be async.' },
      args: { type: 'array', items: {}, description: 'Arguments passed to fn.' },
    },
    required: ['fn'],
  },
});
