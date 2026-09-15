#!/usr/bin/env node
// MCP stdio server `fastrun`: Claude dispatches Grok runs and answers its questions.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runTask, answer, status, cancel } from './runner.mjs';

const TOOLS = [
  {
    name: 'grok_run',
    description: 'Dispatch a browser task to Grok (grok-4.6 driving FastLink). Holds up to 240s and returns {status:"done",result,evidence} | {status:"question",run_id,question,so_far} (answer with grok_answer) | {status:"running",run_id} (poll with grok_status). Write the task like a brief to a capable operator: goal, site, what to report back.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task, in plain language.' },
        transport: { type: 'string', enum: ['relay', 'local'], description: 'relay (default, relay.ytx.app) or local (spawn fast-dxt server on this machine).' },
        browser: { type: 'string', description: 'Relay browser name to pin (fast_profile), e.g. browser-1.' },
        toolset: { type: 'string', description: 'Which tool list Grok sees: "default" (all tools, baseline), a name like "phase2" or "no-cdp" (fast-runner/toolset.<name>.json), or a path to a toolset JSON. Default: FASTRUN_TOOLSET env or "default". Recorded per run in runs.jsonl.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'grok_answer',
    description: 'Answer a question Grok asked via ask_caller. Same hold/return semantics as grok_run.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' }, answer: { type: 'string' } }, required: ['run_id', 'answer'] },
  },
  {
    name: 'grok_status',
    description: 'Current state of a run: status, last 10 tool calls, last assistant note, result when done.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
  },
  {
    name: 'grok_cancel',
    description: 'Stop a run. Returns what it had so far.',
    inputSchema: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
  },
];

const server = new Server({ name: 'fastrun', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments || {};
  let out;
  try {
    switch (req.params.name) {
      case 'grok_run': out = await runTask({ task: a.task, transport: a.transport || 'relay', browser: a.browser, toolset: a.toolset }); break;
      case 'grok_answer': out = await answer(a.run_id, a.answer); break;
      case 'grok_status': out = status(a.run_id); break;
      case 'grok_cancel': out = cancel(a.run_id); break;
      default: out = { status: 'error', error: `unknown tool ${req.params.name}` };
    }
  } catch (e) {
    out = { status: 'error', error: e.message };
  }
  return { content: [{ type: 'text', text: JSON.stringify(out) }], isError: out.status === 'error' };
});
await server.connect(new StdioServerTransport());
