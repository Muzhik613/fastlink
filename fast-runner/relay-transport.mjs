// relay-transport.mjs — MCP client over Streamable HTTP to the cloud relay,
// authenticated exactly like claude.ai / grok.com: OAuth 2.1 dynamic client
// ("fastrun") + authorization_code/PKCE. Tokens cached in ~/.config/fastrun/
// relay-token.json (mode 600), refreshed silently by the SDK. ONE MCP session
// per connect. Browser pinning = fast_profile on this client's own OAuth cid.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RELAY_URL = process.env.FASTLINK_RELAY_URL || 'https://relay.ytx.app/mcp';
export const TOKEN_DIR = join(homedir(), '.config', 'fastrun');
export const TOKEN_FILE = join(TOKEN_DIR, 'relay-token.json');
// Fixed loopback port: the redirect_uri is registered with the relay at DCR time
// and must match byte-for-byte on every later login.
export const CALLBACK_PORT = Number(process.env.FASTRUN_CALLBACK_PORT || 47821);
const REDIRECT_URL = `http://127.0.0.1:${CALLBACK_PORT}/callback`;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

// --- token store: one JSON file {client, tokens, verifier, state} -------------
function readStore() {
  try { return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')); } catch { return {}; }
}
function writeStore(store) {
  mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
  chmodSync(TOKEN_FILE, 0o600);
}
export function clearStore() { try { unlinkSync(TOKEN_FILE); } catch { /* none */ } }

// OAuthClientProvider (SDK contract) backed by the file store.
class FileOAuthProvider {
  constructor() { this.pendingAuthUrl = null; }
  get redirectUrl() { return REDIRECT_URL; }
  get clientMetadata() {
    return {
      client_name: 'fastrun',
      redirect_uris: [REDIRECT_URL],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'browser.drive',
    };
  }
  state() { const s = randomBytes(16).toString('hex'); writeStore({ ...readStore(), state: s }); return s; }
  clientInformation() { return readStore().client; }
  saveClientInformation(client) { writeStore({ ...readStore(), client }); }
  tokens() { return readStore().tokens; }
  saveTokens(tokens) { writeStore({ ...readStore(), tokens }); }
  redirectToAuthorization(url) { this.pendingAuthUrl = url.toString(); }
  saveCodeVerifier(verifier) { writeStore({ ...readStore(), verifier }); }
  codeVerifier() {
    const v = readStore().verifier;
    if (!v) throw new Error('no PKCE verifier saved — restart the login');
    return v;
  }
  invalidateCredentials(scope) {
    const s = readStore();
    if (scope === 'all') return clearStore();
    if (scope === 'client') delete s.client;
    if (scope === 'tokens') delete s.tokens;
    if (scope === 'verifier') delete s.verifier;
    writeStore(s);
  }
}

// Serve the loopback redirect once; resolve with the authorization code.
function waitForCallback(expectState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, `http://127.0.0.1:${CALLBACK_PORT}`);
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const finish = (ok, msg) => {
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>fastrun</title><p style="font:16px system-ui">${msg}</p>`);
        clearTimeout(timer); server.close();
      };
      if (err) { finish(false, `Login failed: ${err}`); reject(new Error(`oauth error: ${err}`)); return; }
      if (!code) { finish(false, 'Missing code.'); reject(new Error('callback without code')); return; }
      if (expectState && state !== expectState) { finish(false, 'State mismatch.'); reject(new Error('oauth state mismatch')); return; }
      finish(true, 'fastrun is signed in to the FastLink relay. You can close this tab.');
      resolve(code);
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('login timed out')); }, LOGIN_TIMEOUT_MS);
    server.on('error', (e) => { clearTimeout(timer); reject(new Error(`loopback ${CALLBACK_PORT}: ${e.message}`)); });
    server.listen(CALLBACK_PORT, '127.0.0.1');
  });
}

async function openSession(provider) {
  const transport = new StreamableHTTPClientTransport(new URL(RELAY_URL), { authProvider: provider });
  const client = new Client({ name: 'fastrun', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

/**
 * connectRelay({ browser, onAuthUrl }) → { listTools, callTool, close, client }
 * First run: prints (and hands to onAuthUrl) the relay authorize URL; the human
 * (or an agent driving Chrome) completes Google sign-in, the loopback callback
 * captures the code, tokens are cached. Later runs are silent.
 */
export async function connectRelay({ browser = null, onAuthUrl = null } = {}) {
  const provider = new FileOAuthProvider();
  let session;
  try {
    session = await openSession(provider);
  } catch (e) {
    // A dead refresh token surfaces as an OAuthError (invalid_grant): drop the
    // tokens and go through the login once, same path as a first run.
    if (e instanceof OAuthError && !(e instanceof UnauthorizedError)) {
      provider.invalidateCredentials('tokens');
      try { session = await openSession(provider); } catch (e2) { if (!(e2 instanceof UnauthorizedError)) throw e2; }
    } else if (!(e instanceof UnauthorizedError)) throw e;
    if (!session) {
      const url = provider.pendingAuthUrl;
      if (!url) throw new Error('relay demanded auth but no authorize URL was produced');
      const expectState = readStore().state;
      const pending = waitForCallback(expectState);
      process.stderr.write(`[fastrun] sign in to the FastLink relay:\n${url}\n`);
      if (onAuthUrl) await onAuthUrl(url);
      const code = await pending;
      const t = new StreamableHTTPClientTransport(new URL(RELAY_URL), { authProvider: provider });
      await t.finishAuth(code); // code → tokens (saveTokens)
      session = await openSession(provider);
    }
  }
  const { client, transport } = session;

  // 120s > the relay/broker 30s request ceiling, so a slow call errors from the
  // server side (visible to the model), never from the SDK's 60s default.
  const callTool = async (name, args = {}) =>
    client.callTool({ name, arguments: args || {} }, undefined, { timeout: 120_000 });
  if (browser) {
    const r = await callTool('fast_profile', { install: browser });
    const txt = r?.content?.[0]?.text || '';
    if (r?.isError || /"error"/.test(txt)) throw new Error(`fast_profile ${browser}: ${txt}`);
  }
  return {
    client,
    listTools: async () => (await client.listTools()).tools,
    callTool,
    close: () => transport.close(),
  };
}
