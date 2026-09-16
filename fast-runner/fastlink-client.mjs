// MCP client for FastLink. Both transports expose { listTools, callTool, close }.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER = new URL('../fast-dxt/server/index.js', import.meta.url).pathname;

export async function connect({ transport = 'relay', browser } = {}) {
  if (transport === 'relay') {
    const { connectRelay } = await import('./relay-transport.mjs');
    return connectRelay({ browser });
  }
  if (transport !== 'local') throw new Error(`unknown transport: ${transport}`);
  // local: spawn fast-dxt/server over stdio; it attaches to the running broker (or spawns one).
  const t = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: process.env,
    stderr: process.env.FASTRUN_DEBUG ? 'inherit' : 'ignore',
  });
  const client = new Client({ name: 'fast-runner', version: '0.1.0' });
  await client.connect(t);
  // broker refuses unpinned calls when >1 profile is connected (8498cbe): pin first, fail loud.
  if (browser) {
    const r = await client.callTool({ name: 'fast_profile', arguments: { install: browser } });
    const txt = r?.content?.[0]?.text || '';
    if (r?.isError || /"error"/.test(txt)) { await client.close(); throw new Error(`fast_profile ${browser}: ${txt.slice(0, 300)}`); }
  }
  return {
    async listTools() { return (await client.listTools()).tools; },
    async callTool(name, args) {
      return client.callTool({ name, arguments: args || {} }, undefined, { timeout: 120_000 });
    },
    async close() { await client.close(); },
  };
}
