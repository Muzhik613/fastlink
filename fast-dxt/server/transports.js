import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS } from './tools.js';
import { handleCall } from './handlers.js';
import { log } from './log.js';

// Guidance the client (Claude) sees in the initialize result — steers it toward
// the FAST tools instead of its default "screenshot + read it myself" instinct.
const INSTRUCTIONS = [
  'THIS IS THE LOCAL FastLink connector (named "fastlink") — Claude Code on the user\'s own machine drives the browser through the local broker. No pairing, no token, no OAuth. If a separate CLOUD connector is ALSO listed (server "fastlink-relay" / shown as "claude.ai Fastlink"), PREFER THIS LOCAL ONE for CLI sessions; that cloud connector is for claude.ai web and needs the browser paired to a relay account. FASTLINK_TOKEN is NOT used here; never treat a missing FASTLINK_TOKEN as the cause of a connection problem.',
  '',
  'FastLink drives the user\'s real Chrome tab. Use it efficiently:',
  '- READ a page with fast_snapshot — a fast, structured index of the DOM (readable text + clickable elements with coords). Do NOT take a screenshot to read content.',
  '- CROSS-ORIGIN FRAMES (embedded checkout/card forms, portal blades) are ordinary DOM targets: fast_snapshot lists their items under `frames`, and fast_click / fast_fill / fast_select_option act inside them directly. If a frame is still loading, snapshot again once it has rendered. Never use a screenshot to read ordinary page content — fast_snapshot does that.',
  '- CHAIN a known multi-step sequence in ONE call with fast_batch (e.g. navigate → fill → click → wait) to cut round-trips.',
  '- Fill multi-field forms with ONE fast_fill {fields:{label:value}} (or one fast_batch), never field-by-field.',
  '- Action results (fast_click / fast_fill / fast_wait) already include a snapshot — chain off THAT; do not issue a separate fast_snapshot right after.',
  '- Do NOT add artificial waits/sleeps — tabs load fast. Use fast_wait only when there is a real async signal (new view text, network idle), not as a reflex after every action.',
  '',
  'WHICH TOOL WHEN (rule of thumb: snapshot to read → DOM tools to act → vision only when the element is not in the DOM or the page is too heavy → batch when the path is known):',
  '- DEFAULT TO DOM TOOLS for normal HTML pages (the vast majority). Read with fast_snapshot; act with fast_click / fast_fill / fast_select_option. They are the fastest and most precise — TRY DOM FIRST.',
  '- USE the screenshot → fast_click_xy / fast_type path ONLY as a last resort, when DOM tools cannot reach the target at all: canvas/WebGL, image-only UIs, or a frame a snapshot\'s frameNotice names as unreadable. Coordinates you estimate from an image are often off, so prefer any DOM route first.',
  '- USE fast_batch when you already KNOW the full step sequence (navigate → fill → click → wait) to cut round-trips. DON\'T batch when you must SEE a step\'s result before deciding the next (exploratory/branching flows) — run those one at a time.',
].join('\n');

function createMcpServer() {
  const server = new Server({ name: 'fastlink', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => handleCall(req.params.name, req.params.arguments));
  return server;
}

export async function startStdio() {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  log('stdio transport connected');
}
