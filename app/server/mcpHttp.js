// MCP over HTTP ("Streamable HTTP"): the transport for MCP servers that run
// as a web endpoint instead of a program OmniOne starts, such as the Blender
// add-on at http://127.0.0.1:8765/mcp, GitHub's or Vercel's hosted servers.
//
// Each JSON-RPC message is one POST. The answer is either plain JSON or a
// short SSE stream carrying it; both are handled. A server that hands out a
// session id (Mcp-Session-Id) gets it back on every later request.
// Same interface as McpStdioClient in tools.js: start, listTools, callTool,
// stop, tools, ready.

const JSONRPC_VERSION = '2.0';
const DEFAULT_TIMEOUT_MS = 30_000;
// A render or a long bpy script can take minutes; tool calls get longer.
const CALL_TIMEOUT_MS = 10 * 60_000;

export class McpHttpClient {
  constructor({ url, headers, timeoutMs }) {
    this.url = String(url);
    this.headers = headers || {};
    this.timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;
    this.sessionId = null;
    this.id = 0;
    this.tools = [];
    this.ready = false;
    this.serverInfo = null;
    this.instructions = '';
  }

  async start() {
    const res = await this._rpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'omnione', version: '1' },
    });
    this.serverInfo = res?.serverInfo || null;
    this.instructions = typeof res?.instructions === 'string' ? res.instructions : '';
    await this._post({ jsonrpc: JSONRPC_VERSION, method: 'notifications/initialized' }).catch(() => {});
    this.ready = true;
  }

  async listTools() {
    const res = await this._rpc('tools/list', {});
    this.tools = res?.tools || [];
    return this.tools;
  }

  async callTool(name, args, { signal } = {}) {
    return this._rpc('tools/call', { name, arguments: args || {} }, { timeoutMs: CALL_TIMEOUT_MS, signal });
  }

  async stop() {
    this.ready = false;
    if (!this.sessionId) return;
    // Polite goodbye; servers without sessions ignore it.
    try {
      await fetch(this.url, { method: 'DELETE', headers: this._headers(), signal: AbortSignal.timeout(2000) });
    } catch { /* gone already */ }
  }

  _headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      ...this.headers,
      ...extra,
    };
  }

  async _rpc(method, params, opts = {}) {
    const id = ++this.id;
    const msg = await this._post({ jsonrpc: JSONRPC_VERSION, id, method, params }, { ...opts, wantId: id });
    if (msg?.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
    return msg?.result;
  }

  async _post(body, { timeoutMs = this.timeoutMs, signal, wantId = null } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
    timer.unref?.();
    const onAbort = () => ac.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    let resp;
    try {
      resp = await fetch(this.url, { method: 'POST', headers: this._headers(), body: JSON.stringify(body), signal: ac.signal });
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw Object.assign(new Error('Run cancelled.'), { name: 'AbortError' });
      if (ac.signal.aborted) throw new Error(`MCP request "${body.method}" timed out after ${Math.round(timeoutMs / 1000)}s`);
      const code = e?.cause?.code || '';
      if (code === 'ECONNREFUSED') throw new Error(`Nothing is answering at ${this.url}. Is the program running and its MCP server started?`);
      throw new Error(`Can't reach ${this.url}: ${e?.cause?.message || e.message}`);
    }
    try {
      const sid = resp.headers.get('mcp-session-id');
      if (sid) this.sessionId = sid;
      if (resp.status === 202 || resp.status === 204) return null;
      const text = await resp.text();
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) throw new Error(`${this.url} refused the request (${resp.status}): check its token.`);
        throw new Error(`MCP HTTP ${resp.status}: ${text.slice(0, 300)}`);
      }
      const type = resp.headers.get('content-type') || '';
      const messages = type.includes('text/event-stream') ? parseSse(text) : parseJson(text);
      if (wantId == null) return null;
      return messages.find((m) => m && m.id === wantId) || messages.find((m) => m && ('result' in m || 'error' in m)) || null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

function parseJson(text) {
  if (!text.trim()) return [];
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch {
    throw new Error(`MCP server sent something that isn't JSON: ${text.slice(0, 200)}`);
  }
}

/* The JSON-RPC messages in an SSE body ("data:" lines, events split by a
 * blank line). */
export function parseSse(text) {
  const out = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* not JSON, e.g. an endpoint event */ }
  }
  return out;
}
