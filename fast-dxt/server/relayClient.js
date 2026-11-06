// relayClient.js — JSON-RPC to the relay's /mcp over Streamable HTTP.
// Authenticates with the machine's agent token, keeps the relay's Mcp-Session-Id,
// and reads either a plain JSON body or a text/event-stream body.

export class RelayError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

export function createRelayClient({ relay, agentToken }) {
  const url = `${relay.replace(/\/+$/, '')}/mcp`;
  let sessionId = null;
  let nextId = 1;

  async function post(message) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${agentToken}`,
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(message) });
    } catch (e) {
      throw new RelayError(`can't reach the FastLink relay at ${relay} (${e.cause?.code || e.message})`);
    }
    const sid = res.headers.get('mcp-session-id');
    if (sid) sessionId = sid;
    if (res.status === 401 || res.status === 403) {
      throw new RelayError(`the relay rejected this machine's pairing (HTTP ${res.status}). Pair again: node <fast-dxt>/server/index.js pair <CODE>`, res.status);
    }
    if (res.status === 202) return null; // notification accepted
    if (!res.ok) throw new RelayError(`relay HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    if (type.includes('text/event-stream')) return pickFromSse(body, message.id);
    return body ? JSON.parse(body) : null;
  }

  // Send a request; resolves with `result`, throws RelayError on a JSON-RPC error.
  async function request(method, params) {
    const id = nextId++;
    const reply = await post({ jsonrpc: '2.0', id, method, params });
    if (!reply) throw new RelayError(`relay sent no reply to ${method}`);
    if (reply.error) throw new RelayError(`relay error ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
  }

  const notify = (method, params) => post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });

  return { request, notify, get sessionId() { return sessionId; } };
}

// An SSE body holds one or more `data:` events; return the JSON-RPC response for `id`.
function pickFromSse(body, id) {
  let last = null;
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    let msg;
    try { msg = JSON.parse(data); } catch { continue; }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      if (m && m.id === id && ('result' in m || 'error' in m)) return m;
      last = m;
    }
  }
  return last;
}
