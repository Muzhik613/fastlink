// MCP tool definitions. Edit descriptions/schemas here only.
// Descriptions stay short: what the tool does, its key arguments, at most one gotcha (<= 300 chars).
// fastlink-relay/tools.js carries the same set (minus the local-only fast_ext_reload).

export const TOOLS = [
  {
    name: 'fast_status',
    description: 'Whether a browser is connected, which profiles are paired, and which one this connection drives. Call when other tools say the extension is not connected.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'fast_profile',
    description: 'Pin this connection to one browser profile by name, or "auto" to release. Needed while several profiles are connected; a pinned profile that is offline errors, never redirects.',
    inputSchema: {
      type: 'object',
      properties: {
        install: { type: 'string', description: 'Profile name (e.g. "primary", "work") or "auto".' },
      },
      required: ['install'],
    },
  },
  {
    name: 'fast_snapshot',
    description: 'Read the page: `items` are controls as {i, tag, label, value} (offscreen:true when below the fold; an open dialog first) plus `content` text. Visible frames are under `frames`, their ids "f<frameId>:<i>". truncated:true means this read was cut: call again with full:true.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'Part of a frame URL: act inside that frame (see fast_snapshot `frames`).' },
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
        frame: { type: 'string', description: 'Part of a frame URL: act inside that frame (see fast_snapshot `frames`).' },
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
        frame: { type: 'string', description: 'Part of a frame URL: act inside that frame (see fast_snapshot `frames`).' },
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
        background: { type: 'boolean', description: 'Do not focus the new tab.' },
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
      },
    },
  },
  {
    name: 'fast_wait',
    description: 'Wait until `text` appears (frames included) or `selector` matches; networkIdle:true waits for requests to settle. Returns the match and a page preview, or the visible headings on timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        frame: { type: 'string', description: 'Part of a frame URL: act inside that frame (see fast_snapshot `frames`).' },
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
    name: 'fast_evaluate',
    description: 'Run a JS function in the page and return its JSON result. For reads that fast_snapshot and fast_text cannot do.',
    inputSchema: {
      type: 'object',
      properties: {
        fn: { type: 'string', description: 'Function source, e.g. "() => document.title".' },
        args: {
          type: 'array',
          items: {},
          description: 'Arguments passed to fn.',
        },
      },
      required: ['fn'],
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
        frame: { type: 'string', description: 'Part of a frame URL: act inside that frame (see fast_snapshot `frames`).' },
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
        frame: { type: 'string', description: 'Part of a frame URL: act inside that frame (see fast_snapshot `frames`).' },
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
    description: 'Run steps you already know in one call: `actions`:[{name, args}], or {ifFound, then, else} to branch without a turn. Every step runs; the result leads with a per-step summary and ends with one page preview.',
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
