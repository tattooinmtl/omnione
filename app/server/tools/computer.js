// Omi-One's computer: a Linux desktop of its own on computers.globalwarningnetworks.com
// (one per account, in a gVisor container on the VPS, with Chromium, Python,
// Node and git; every site it reaches goes through a logging proxy).
//
// The website gives a connected account a 1-hour pass (cloud.js) and the
// tools talk to the computers gateway with it. Nothing here touches the
// user's PC: commands run on that remote computer.
//
// Up to 2 computers run on the server at once (shared), and an idle one
// stops by itself after 15 minutes; files in /home/bot are kept.

import fs from 'node:fs';
import path from 'node:path';
import { registerTool } from '../toolRegistry.js';
import { computerSession, CloudError } from '../cloud.js';
import { resolveInWorkspace, getWorkspaceRoot, toWorkspaceRelative } from '../workspace.js';

const TIMEOUT_MS = 60_000;

class ComputerError extends Error {}

/* One call to the computers gateway with this account's pass; a rejected
 * pass is renewed once. */
async function gw(method, route, { json, query, binary = false, signal, timeoutMs = TIMEOUT_MS } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pass = await computerSession({ signal, fresh: attempt > 0 });
    const url = `${pass.url}${route}${query ? `?${new URLSearchParams(query)}` : ''}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${pass.token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        body: json ? JSON.stringify(json) : undefined,
        signal: ac.signal,
      });
    } catch (e) {
      throw new ComputerError(ac.signal.aborted && !signal?.aborted ? 'The computer took too long to answer.' : `Can't reach the computer: ${e.message}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (res.status === 401 && attempt === 0) continue;
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).detail; } catch { /* not JSON */ }
      if (res.status === 429) throw new ComputerError(detail || 'All shared computers are busy right now. Try again in a few minutes.');
      if (res.status === 409) throw new ComputerError(detail || 'The computer is not running. Start it with computer_start.');
      throw new ComputerError(detail || `The computer answered ${res.status}.`);
    }
    return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
  }
  throw new ComputerError('The computer refused the pass.');
}

const wrap = (fn) => async (args = {}, ctx = {}) => {
  try {
    return { ok: true, result: await fn(args, ctx) };
  } catch (e) {
    if (e instanceof ComputerError || e instanceof CloudError) return { ok: false, error: e.message };
    throw e;
  }
};

async function ensureRunning(signal) {
  const s = await gw('GET', '/computer', { signal });
  if (!s.running) await gw('POST', '/computer/start', { signal, timeoutMs: 120_000 });
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

registerTool({
  name: 'computer_start',
  description: "Start your own computer: a Linux desktop on the Global Warning Networks server (Chromium, Python 3, Node, git), separate from the user's PC. Needs the user's account to be connected. Files in /home/bot are kept between sessions; it stops by itself after 15 idle minutes.",
  permission: 'write',
  schema: { type: 'object', properties: {} },
  handler: wrap(async (_a, ctx) => {
    await ensureRunning(ctx.signal);
    const s = await gw('GET', '/computer', { signal: ctx.signal });
    return { running: true, bot: s.bot, computersRunning: `${s.running_total} of ${s.max}`, home: '/home/bot' };
  }),
});

registerTool({
  name: 'computer_status',
  description: 'Is your computer running, and how many of the shared computers are in use.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: wrap(async (_a, ctx) => gw('GET', '/computer', { signal: ctx.signal })),
});

registerTool({
  name: 'computer_run',
  description: 'Run a shell command (bash) on your computer, not on the user\'s PC. Starts the computer if needed. Returns the exit code and output. Good for installing tools, running code, git, and fetching pages with curl.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The bash command line.' },
      timeoutSeconds: { type: 'integer', description: 'Kill it after this long (max 900).', default: 120 },
    },
    required: ['command'],
  },
  handler: wrap(async ({ command, timeoutSeconds = 120 }, ctx) => {
    if (!command || typeof command !== 'string') throw new ComputerError('command is required');
    await ensureRunning(ctx.signal);
    const t = Math.max(1, Math.min(900, Number(timeoutSeconds) || 120));
    const r = await gw('POST', '/computer/exec', { json: { cmd: command, timeout: t }, signal: ctx.signal, timeoutMs: (t + 30) * 1000 });
    return { exitCode: r.exit_code, timedOut: r.timed_out, output: String(r.output || '').slice(-20000) };
  }),
});

registerTool({
  name: 'computer_browse',
  description: "Open a web page in your computer's real Chromium (JavaScript runs) and return its text: for pages browser_open can't read because they're built by scripts. Starts the computer if needed.",
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL.' },
      maxChars: { type: 'integer', default: 15000 },
    },
    required: ['url'],
  },
  handler: wrap(async ({ url, maxChars = 15000 }, ctx) => {
    let u;
    try { u = new URL(url); } catch { throw new ComputerError(`Not a valid URL: ${url}`); }
    if (!/^https?:$/.test(u.protocol)) throw new ComputerError('Only http and https pages.');
    await ensureRunning(ctx.signal);
    // Headless Chromium renders the page; Python turns the DOM into text.
    const py = 'import sys,html,re\n'
      + 's=sys.stdin.read()\n'
      + "t=re.search(r'<title[^>]*>(.*?)</title>',s,re.S|re.I)\n"
      + "s=re.sub(r'(?is)<(script|style|noscript|svg)\\b.*?</\\1>',' ',s)\n"
      + "s=re.sub(r'(?i)<(br|/p|/div|/li|/h[1-6]|/tr)[^>]*>','\\n',s)\n"
      + "s=html.unescape(re.sub(r'<[^>]+>',' ',s))\n"
      + "s=re.sub(r'[ \\t]+',' ',s); s=re.sub(r'\\n\\s*\\n+','\\n\\n',s)\n"
      + "print('TITLE:',html.unescape(t.group(1).strip()) if t else '')\n"
      + 'print(s.strip())\n';
    const cmd = `timeout 60 chromium --headless=new --no-sandbox --disable-gpu --virtual-time-budget=8000 --dump-dom ${shQuote(u.href)} 2>/dev/null | python3 -c ${shQuote(py)}`;
    const r = await gw('POST', '/computer/exec', { json: { cmd, timeout: 90 }, signal: ctx.signal, timeoutMs: 120_000 });
    const out = String(r.output || '');
    const title = (out.match(/^TITLE: (.*)$/m) || [, ''])[1];
    const body = out.replace(/^TITLE: .*\n?/m, '').trim();
    if (!body) throw new ComputerError(`The page came back empty (exit ${r.exit_code}).`);
    const n = Math.max(1000, Math.min(60000, Number(maxChars) || 15000));
    return { url: u.href, title, text: body.slice(0, n), truncated: body.length > n };
  }),
});

registerTool({
  name: 'computer_screenshot',
  description: "Take a screenshot of your computer's screen. It's saved in your folder (computer/screen-<time>.png) for the user to look at; you get the path. You can't see images yourself: read the screen with computer_run or computer_browse instead.",
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: wrap(async (_a, ctx) => {
    const png = await gw('GET', '/computer/screenshot', { binary: true, signal: ctx.signal });
    const dir = path.join(getWorkspaceRoot(), 'computer');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `screen-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.png`);
    fs.writeFileSync(file, png);
    return { saved: toWorkspaceRelative(file), bytes: png.length };
  }),
});

registerTool({
  name: 'computer_input',
  description: 'Use the mouse and keyboard on your computer\'s screen: action "click" {x, y, button?}, "move" {x, y}, "type" {text}, or "key" {key} (e.g. Return, ctrl+l, Tab).',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['click', 'move', 'type', 'key'] },
      x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'integer', default: 1 },
      text: { type: 'string' }, key: { type: 'string' },
    },
    required: ['action'],
  },
  handler: wrap(async (a, ctx) => {
    const body = { action: a.action };
    if (a.action === 'click' || a.action === 'move') Object.assign(body, { x: a.x, y: a.y, button: a.button || 1 });
    if (a.action === 'type') body.text = String(a.text || '');
    if (a.action === 'key') body.key = String(a.key || '');
    return gw('POST', '/computer/input', { json: body, signal: ctx.signal });
  }),
});

registerTool({
  name: 'computer_upload',
  description: 'Copy a file from your folder on this PC to your computer (into /home/bot/...).',
  permission: 'write',
  schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Path relative to your folder.' },
      to: { type: 'string', description: 'Destination path on the computer, e.g. project/main.py (under /home/bot).' },
    },
    required: ['from', 'to'],
  },
  handler: wrap(async ({ from, to }, ctx) => {
    const abs = resolveInWorkspace(from);
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) throw new ComputerError(`No such file: ${from}`);
    const data = fs.readFileSync(abs);
    if (data.length > 50 * 1024 * 1024) throw new ComputerError('Files are limited to 50 MB.');
    await ensureRunning(ctx.signal);
    return gw('POST', '/computer/upload', { json: { path: to, content_b64: data.toString('base64') }, signal: ctx.signal, timeoutMs: 180_000 });
  }),
});

registerTool({
  name: 'computer_download',
  description: 'Copy a file from your computer (under /home/bot) into your folder on this PC.',
  permission: 'write',
  schema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Path on the computer, under /home/bot.' },
      to: { type: 'string', description: 'Path relative to your folder.' },
    },
    required: ['from', 'to'],
  },
  affectedPaths: (a) => [a.to],
  handler: wrap(async ({ from, to }, ctx) => {
    const abs = resolveInWorkspace(to);
    const data = await gw('GET', '/computer/download', { query: { path: from }, binary: true, signal: ctx.signal, timeoutMs: 180_000 });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    return { saved: toWorkspaceRelative(abs), bytes: data.length };
  }),
});

registerTool({
  name: 'computer_view',
  description: "A link for the user to watch your computer's screen live (valid 10 minutes). Give it to the user; set takeOver true if they want to use the mouse and keyboard themselves.",
  permission: 'read',
  schema: { type: 'object', properties: { takeOver: { type: 'boolean', default: false } } },
  handler: wrap(async ({ takeOver = false }, ctx) => {
    await ensureRunning(ctx.signal);
    const pass = await computerSession({ signal: ctx.signal });
    const r = await gw('POST', '/auth/screen-link', { json: { bot: pass.bot, view_only: !takeOver }, signal: ctx.signal });
    return { url: r.url, expiresInSeconds: r.expires_in, mode: takeOver ? 'take over' : 'watch only' };
  }),
});

registerTool({
  name: 'computer_stop',
  description: 'Stop your computer (it also stops by itself after 15 idle minutes). Files in /home/bot are kept.',
  permission: 'write',
  schema: { type: 'object', properties: {} },
  handler: wrap(async (_a, ctx) => gw('POST', '/computer/stop', { signal: ctx.signal })),
});
