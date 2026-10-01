// Hook system for OmniOne.
//
// Hooks are user-editable scripts under <project>/hooks/<event>/<name>.{js,ps1,...}.
// Each event (UserPromptSubmit, PreToolUse, PostToolUse) has its own subdir.
// When an event fires, the server runs every matching script with the
// event payload as JSON on stdin, and reads a JSON reply on stdout. A
// non-zero exit code means the hook rejected the event.
//
// The catalog is exposed at /api/hooks. Hooks are easy to add — drop a
// file in the right folder and call /api/hooks/scan to reindex.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const HOOKS_DIR = path.join(PROJECT_ROOT, 'hooks');

// Hooks live on disk and fire for every run, which makes them global state.
// Tests that install a hook must not have it fire inside some other test's
// agent run — so the directory is resolved through a variable a test can
// point somewhere disposable, the same way workspace.js does.
let hooksDir = HOOKS_DIR;
export function getHooksDir() { return hooksDir; }
export function _setHooksDirForTest(dir) {
  hooksDir = dir || HOOKS_DIR;
  catalog = null;
  return hooksDir;
}

export const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'];

let catalog = null;
let catalogMtime = 0;

const listeners = new Set();
export function onHooksChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }

function listDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name));
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: raw };
  const meta = {};
  for (const line of raw.slice(3, end).split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  let bodyStart = end + 4;
  if (raw[bodyStart] === '\n') bodyStart += 1;
  return { meta, body: raw.slice(bodyStart) };
}

function scanEvent(event) {
  const dir = path.join(getHooksDir(), event);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const full = path.join(dir, d.name);
      const stat = fs.statSync(full);
      const ext = path.extname(d.name).slice(1);
      const baseName = path.basename(d.name, path.extname(d.name));
      // Best-effort: parse .md sidecar as a README
      const sidecar = path.join(dir, baseName + '.md');
      let meta = { name: baseName, description: '' };
      if (fs.existsSync(sidecar)) {
        try {
          const { meta: m } = parseFrontmatter(fs.readFileSync(sidecar, 'utf8'));
          meta = { name: m.name || baseName, description: m.description || '' };
        } catch { /* ignore */ }
      }
      return {
        event,
        name: baseName,
        runtime: ext,
        path: full,
        size: stat.size,
        mtime: stat.mtimeMs,
        ...meta,
      };
    });
}

export function scanHooks() {
  const all = [];
  for (const ev of EVENTS) all.push(...scanEvent(ev));
  catalog = all;
  catalogMtime = Date.now();
  emit();
  return catalog;
}

export function getHooks() {
  if (!catalog) return scanHooks();
  return catalog;
}

export function hooksForEvent(event) {
  return getHooks().filter((h) => h.event === event);
}

/* Fire a hook. Runs the script with the JSON payload on stdin, parses the
 * stdout as JSON (or wraps as {output: <string>}). Returns the parsed
 * result on success, or { error } on failure. Hooks that need to BLOCK
 * should exit 0 with no output (default allow) or exit 1 to reject.
 */
export async function fireHook({ event, payload }) {
  if (!EVENTS.includes(event)) throw new Error(`Unknown event "${event}"`);
  const hooks = hooksForEvent(event);
  const out = { event, results: [] };
  for (const h of hooks) {
    const r = await runOne(h, payload);
    out.results.push({ hook: h.name, ...r });
  }
  return out;
}

// A hook runs inside the request path: UserPromptSubmit blocks the first
// model call, PreToolUse blocks every tool. A hook that never exits used to
// block them forever, with no timeout and no kill — one bad script and the
// whole harness wedged with no diagnostic. Treat a slow hook as a failed one.
export const HOOK_TIMEOUT_MS = Number(process.env.GWN_HOOK_TIMEOUT_MS) || 10_000;
const MAX_HOOK_OUTPUT = 256 * 1024;

async function runOne(hook, payload) {
  const start = Date.now();
  return new Promise((resolve) => {
    const isJs = hook.runtime === 'js' || hook.runtime === 'cjs' || hook.runtime === 'mjs';
    const cmd = isJs ? process.execPath : hook.runtime === 'ps1' ? 'powershell' : hook.runtime === 'sh' ? 'bash' : hook.runtime === 'py' ? 'python' : null;
    if (!cmd) {
      resolve({ ok: false, error: `No runner for .${hook.runtime}`, ms: 0 });
      return;
    }
    const args = isJs ? [hook.path] : hook.runtime === 'ps1' ? ['-NoProfile', '-NonInteractive', '-File', hook.path] : hook.runtime === 'sh' ? [hook.path] : hook.runtime === 'py' ? [hook.path] : [hook.path];
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    } catch (e) {
      resolve({ ok: false, error: e.message, ms: 0 });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const timer = setTimeout(() => {
      killHook(proc);
      finish({
        ok: false,
        error: `Hook "${hook.name}" timed out after ${HOOK_TIMEOUT_MS}ms and was killed.`,
        ms: Date.now() - start,
        timedOut: true,
      });
    }, HOOK_TIMEOUT_MS);
    timer.unref?.();

    // Bounded: a hook that prints in a loop must not grow the heap while we
    // wait for it.
    proc.stdout.on('data', (c) => { stdout = (stdout + c.toString('utf8')).slice(0, MAX_HOOK_OUTPUT); });
    proc.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(0, MAX_HOOK_OUTPUT); });

    proc.on('error', (err) => finish({ ok: false, error: err.message, ms: Date.now() - start }));
    proc.on('close', (code) => {
      const ms = Date.now() - start;
      if (code !== 0) {
        finish({ ok: false, error: stderr.trim() || `exit ${code}`, ms });
        return;
      }
      const parsed = stdout.trim();
      let result;
      if (!parsed) result = { output: '' };
      else {
        try { result = JSON.parse(parsed); }
        catch { result = { output: parsed }; }
      }
      finish({ ok: true, result, ms });
    });

    try {
      proc.stdin.write(JSON.stringify(payload || {}));
      proc.stdin.end();
    } catch (e) {
      // EPIPE here means the hook exited without reading stdin, which is
      // legitimate. Let the close handler decide; only a write that fails
      // with the process still alive is a real error.
      if (proc.exitCode === null && !proc.killed) {
        killHook(proc);
        finish({ ok: false, error: e.message, ms: Date.now() - start });
      }
    }
  });
}

/* Kill the hook and any children it spawned. */
function killHook(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      return;
    } catch { /* fall through */ }
  }
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

export function ensureHooksDir() {
  const root = getHooksDir();
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  for (const ev of EVENTS) {
    const d = path.join(root, ev);
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
