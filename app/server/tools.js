// Tool implementations for OmniOne.
//
// Each tool is a function that takes args and returns { ok, result | error }.
// Real tools (web_search, browser_open) are wired here. The AI calls them
// either directly (via a `<!-- TOOL: name {args} -->` marker) or through
// the AI's own tool-calling protocol (OpenAI function-calling / Anthropic
// tool-use) once that wiring is in place.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { logSearch } from './searchLog.js';

// --- web search ------------------------------------------------------------
// DuckDuckGo's HTML endpoint. No key, no quota. We strip the page down to
// { title, url, snippet } for the AI.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// A bare fetch() has no timeout. A server that accepts the connection and
// then says nothing would park the agent loop indefinitely — no error, no
// progress, nothing to see. Every outbound request gets a deadline, and an
// in-flight request is cancelled when the run it belongs to is aborted.
const NET_TIMEOUT_MS = 30_000;
// Bound the response body too: a tool result is going into the model's
// context, and some URLs stream forever.
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/* fetch with a deadline, honouring an outer AbortSignal as well. */
async function fetchWithTimeout(url, init = {}, { signal, timeoutMs = NET_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  timer.unref?.();
  const onOuterAbort = () => ac.abort(new Error('cancelled'));
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/* Read a response body with a hard cap, so a URL that streams without end
 * cannot exhaust memory. */
async function readCapped(resp, maxBytes = MAX_RESPONSE_BYTES) {
  if (!resp.body) return { text: await resp.text(), capped: false };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (bytes >= maxBytes) return { text, capped: true };
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return { text, capped: false };
}

/* Describe a failed fetch in terms the model can act on. */
function describeFetchError(e) {
  if (e?.name === 'AbortError' || /timeout/i.test(e?.message || '')) {
    return `request timed out after ${NET_TIMEOUT_MS}ms`;
  }
  return `fetch failed: ${e?.message || e}`;
}

export async function webSearch({ q, max = 8 }, ctx = {}) {
  if (!q || typeof q !== 'string') return { ok: false, error: 'q is required' };
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
  let html;
  try {
    const r = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
    }, { signal: ctx.signal });
    if (!r.ok) return { ok: false, error: `DuckDuckGo ${r.status}` };
    html = (await readCapped(r)).text;
  } catch (e) {
    return { ok: false, error: describeFetchError(e) };
  }
  // Pull out result blocks. DDG's HTML layout has changed several times;
  // we use a couple of resilient patterns and stop at the first one that
  // produces hits.
  const results = [];
  let m;
  // Pattern A: modern layout — <a class="result__a" href="...">title</a> + sibling .result__snippet
  const aRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = aRe.exec(html)) && results.length < max) {
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3]);
    if (!title) continue;
    const link = decodeDdgRedirect(decodeHtml(m[1]));
    if (!/^https?:\/\//i.test(link)) continue;
    results.push({ title, url: link, snippet });
  }
  // Pattern B: legacy <h2 class="result__title"><a>...</a></h2> + <a class="result__snippet">
  if (results.length === 0) {
    const bRe = /<h2[^>]+class="result__title"[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    while ((m = bRe.exec(html)) && results.length < max) {
      const link = decodeDdgRedirect(decodeHtml(m[1]));
      if (!/^https?:\/\//i.test(link)) continue;
      results.push({ title: stripTags(m[2]), url: link, snippet: stripTags(m[3]) });
    }
  }
  // Pattern C: any anchor with a real external href inside the result region
  if (results.length === 0) {
    const cRe = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([^<]{8,200})<\/a>/g;
    while ((m = cRe.exec(html)) && results.length < max) {
      const url = m[1];
      if (/duckduckgo\.com/i.test(url)) continue;
      const title = stripTags(m[2]);
      if (!title) continue;
      results.push({ title, url, snippet: '' });
    }
  }
  logSearch(q, results);
  return { ok: true, result: { query: q, count: results.length, results } };
}

// DDG wraps every result in a redirect like
//   //duckduckgo.com/l/?uddg=<urlencoded-real-url>&rut=...
// Pull out the real target from the `uddg` query param.
function decodeDdgRedirect(href) {
  if (!href) return '';
  let h = href;
  if (h.startsWith('//')) h = 'https:' + h;
  try {
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch {
    return h;
  }
}

// --- browser ---------------------------------------------------------------
// Fetches a URL, returns the page title and a text-rendered version of the
// body (HTML stripped, scripts removed, whitespace collapsed). No headless
// browser required.
export async function browserOpen({ url, maxChars = 12000 }, ctx = {}) {
  if (!url || typeof url !== 'string') return { ok: false, error: 'url is required' };
  // Only http(s). Without this the tool would happily read file:// URLs,
  // which is a way straight around the workspace containment that every
  // filesystem tool enforces.
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Not a valid URL: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Refusing ${parsed.protocol} — browser_open handles http and https only.` };
  }

  let resp;
  try {
    resp = await fetchWithTimeout(url, {
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow',
    }, { signal: ctx.signal });
  } catch (e) {
    return { ok: false, error: describeFetchError(e) };
  }
  if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
  const ctype = resp.headers.get('content-type') || '';
  const { text: raw, capped } = await readCapped(resp);

  if (!ctype.includes('text/html') && !ctype.includes('application/xhtml')) {
    // Non-HTML: return the raw text (truncated)
    return {
      ok: true,
      result: { url, contentType: ctype, body: raw.slice(0, maxChars), truncated: capped || raw.length > maxChars },
    };
  }
  const title = (raw.match(/<title[^>]*>([^<]+)<\/title>/i) || [, ''])[1].trim();
  const body = htmlToText(raw, maxChars);
  return { ok: true, result: { url, contentType: ctype, title, body, truncated: capped || raw.length > maxChars } };
}

function htmlToText(html, maxChars) {
  // Drop scripts, styles, and HTML comments
  let s = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  // Convert <br>, <p>, <div>, headings to newlines
  s = s.replace(/<\/?(br|p|div|li|h[1-6]|tr|td)[^>]*>/gi, '\n');
  // Strip remaining tags
  s = stripTags(s);
  // Decode HTML entities
  s = decodeHtml(s);
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  if (s.length > maxChars) s = s.slice(0, maxChars) + '\n…(truncated)';
  return s;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, '').trim();
}

function decodeHtml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// --- tool catalog ---------------------------------------------------------
// Exposed via /api/tools. The AI uses this to know what it can call.
export const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for information. Returns a list of {title, url, snippet} results.',
    input: { q: 'string (the search query)', max: 'number? (default 8)' },
    example: '<!-- TOOL: web_search {"q":"MiniMax H3 model card"} -->',
  },
  {
    name: 'browser_open',
    description: 'Fetch a URL and return the page text. Use when you need to read a specific page.',
    input: { url: 'string (the URL to fetch)', maxChars: 'number? (default 12000)' },
    example: '<!-- TOOL: browser_open {"url":"https://example.com/docs"} -->',
  },
];

export async function runTool(name, args) {
  switch (name) {
    case 'web_search':   return webSearch(args || {});
    case 'browser_open': return browserOpen(args || {});
    default: return { ok: false, error: `Unknown tool "${name}"` };
  }
}

// --- MCP stdio client ------------------------------------------------------
// A minimal JSON-RPC client over the MCP stdio transport. The MCP spec is
// rich; this implements just initialize + tools/list + tools/call, which is
// what the AI needs to call user-registered MCP servers.
//
// Framing: the MCP stdio transport is newline-delimited JSON — one complete
// JSON object per line, with no embedded newlines and no header. (This is the
// point where MCP differs from LSP, which uses Content-Length headers. An
// earlier version of this file used LSP framing, so `initialize` never
// resolved and no server could ever connect.)
const JSONRPC_VERSION = '2.0';
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/* Work out how to actually launch an MCP server command on this platform.
 *
 * Almost every published MCP server is configured as `npx -y <package>`, and
 * on Windows `npx` is `npx.cmd`. Two things go wrong there:
 *   1. spawn() does not apply PATHEXT, so bare "npx" is ENOENT.
 *   2. Since the CVE-2024-27980 fix, Node refuses to spawn .cmd/.bat without
 *      a shell (EINVAL), so resolving to npx.cmd is not enough either.
 * Routing those through `cmd.exe /d /s /c` handles both. Passing the parts as
 * an array (rather than setting shell:true and letting Node flatten them)
 * keeps Node's argument quoting in charge.
 *
 * Returns { command, args } ready for spawn. */
export function resolveSpawn(command, args = []) {
  if (process.platform !== 'win32') return { command, args };

  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean);

  let resolved = command;
  const ext = path.extname(command).toLowerCase();
  const hasKnownExt = ext && pathext.some((e) => e.toLowerCase() === ext);

  if (!hasKnownExt && !path.isAbsolute(command)) {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    outer: for (const dir of dirs) {
      for (const e of pathext) {
        const candidate = path.join(dir, command + e);
        if (existsSync(candidate)) {
          resolved = candidate;
          break outer;
        }
      }
    }
  }

  const resolvedExt = path.extname(resolved).toLowerCase();
  if (resolvedExt === '.cmd' || resolvedExt === '.bat') {
    return { command: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', resolved, ...args] };
  }
  return { command: resolved, args };
}

export class McpStdioClient {
  constructor({ command, args, env, timeoutMs }) {
    this.command = command;
    this.args = args || [];
    this.env = env || {};
    this.timeoutMs = timeoutMs || DEFAULT_RPC_TIMEOUT_MS;
    this.proc = null;
    this.id = 0;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.buffer = '';
    this.stderr = '';       // kept for error messages; servers log diagnostics here
    this.tools = [];
    this.ready = false;
  }

  async start() {
    const { command, args } = resolveSpawn(this.command, this.args);
    this.proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.env },
      shell: false,
    });

    // A spawn failure (ENOENT for a missing command, most often) surfaces as
    // an 'error' event rather than a throw, and can arrive after start()
    // returns. Capture it so in-flight and later calls fail with a useful
    // message instead of hanging until the timeout.
    this.spawnError = null;
    this.proc.on('error', (err) => {
      this.spawnError = err;
      this._failAll(err);
    });
    this.proc.stdout.on('data', (chunk) => this._onData(chunk));
    this.proc.stderr.on('data', (chunk) => {
      // Bounded: a chatty server should not grow this without limit.
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-4000);
    });
    this.proc.on('close', (code) => this._onClose(code));

    await this._send({
      jsonrpc: JSONRPC_VERSION,
      id: ++this.id,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'omnione', version: '0.2.0' },
      },
    });
    await this._send({ jsonrpc: JSONRPC_VERSION, method: 'notifications/initialized' });
    this.ready = true;
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    let nl;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // Not JSON — some servers print banners to stdout. Skip it.
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id == null || !this.pending.has(msg.id)) return; // notification, or a reply we no longer want
    const { resolve, reject, timer } = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    clearTimeout(timer);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  }

  _failAll(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
    this.ready = false;
  }

  _onClose(code) {
    const detail = this.stderr.trim() ? `: ${this.stderr.trim().slice(-500)}` : '';
    this._failAll(new Error(`MCP server closed (code ${code})${detail}`));
  }

  _send(msg) {
    return new Promise((resolve, reject) => {
      if (this.spawnError) return reject(this.spawnError);
      if (msg.id != null) {
        // Without this, a server that accepts the request and never answers
        // hangs the caller — and with it /api/mcp/tools — forever.
        const timer = setTimeout(() => {
          this.pending.delete(msg.id);
          reject(new Error(`MCP request "${msg.method}" timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
        timer.unref?.();
        this.pending.set(msg.id, { resolve, reject, timer });
      }
      try {
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
        if (msg.id == null) resolve(); // notifications don't get a reply
      } catch (e) {
        if (msg.id != null) {
          clearTimeout(this.pending.get(msg.id)?.timer);
          this.pending.delete(msg.id);
        }
        reject(e);
      }
    });
  }

  async listTools() {
    const res = await this._send({ jsonrpc: JSONRPC_VERSION, id: ++this.id, method: 'tools/list', params: {} });
    this.tools = res?.tools || [];
    return this.tools;
  }

  async callTool(name, args) {
    return this._send({
      jsonrpc: JSONRPC_VERSION,
      id: ++this.id,
      method: 'tools/call',
      params: { name, arguments: args || {} },
    });
  }

  async stop() {
    if (!this.proc) return;
    this._failAll(new Error('MCP client stopped'));
    try { this.proc.kill(); } catch { /* already gone */ }
    await wait(50);
  }
}
