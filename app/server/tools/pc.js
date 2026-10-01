// Whole-PC reading tools: look anywhere, change nothing.
//
// These take full paths (C:\…) and can reach every drive, so Omi-One can
// follow a problem wherever it is: a broken PATH entry, a tool installed
// twice, a project's lockfile. Secrets are refused (see pcAccess.js), and
// none of these change anything: changes outside Omi-One's folder are fixes
// it prepares with propose_fix, which you accept or reject.

import fs from 'node:fs';
import path from 'node:path';
import { registerTool } from '../toolRegistry.js';
import { resolveReadable, isSecretPath, AccessError } from '../pcAccess.js';
import { runDiagnostics } from '../doctor.js';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

const wrap = (fn) => async (args) => {
  try { return await fn(args); } catch (e) {
    if (e instanceof AccessError) return { ok: false, error: e.message };
    if (e?.code === 'EPERM' || e?.code === 'EACCES') return { ok: false, error: `Windows doesn't allow reading that (${e.code}).` };
    throw e;
  }
};

registerTool({
  name: 'pc_list_dir',
  description: 'List a folder anywhere on the PC (full path, e.g. C:\\Users\\you\\projects or %APPDATA%). Read-only. Folders that hold secrets are marked and never opened.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Full path of the folder. %VARS% and ~ are expanded.' } },
    required: ['path'],
  },
  handler: wrap(async ({ path: p }) => {
    const abs = resolveReadable(p);
    if (!fs.existsSync(abs)) return { ok: false, error: `No such folder: ${abs}` };
    if (!fs.statSync(abs).isDirectory()) return { ok: false, error: `${abs} is a file. Use pc_read_file.` };
    const entries = [];
    for (const d of fs.readdirSync(abs, { withFileTypes: true }).slice(0, 2000)) {
      const full = path.join(abs, d.name);
      const e = { name: d.name, type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : 'file' };
      if (isSecretPath(full)) e.secret = true;
      else if (e.type === 'file') {
        try { const st = fs.statSync(full); e.size = st.size; e.modified = st.mtime.toISOString().slice(0, 16); } catch { e.unreadable = true; }
      }
      entries.push(e);
    }
    return { ok: true, result: { path: abs, count: entries.length, entries } };
  }),
});

registerTool({
  name: 'pc_read_file',
  description: 'Read a text file anywhere on the PC (full path). Read-only. Secrets (keys, passwords, logins, .env files) are refused because anything read is sent to the AI provider.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Full path of the file. %VARS% and ~ are expanded.' },
      offset: { type: 'integer', description: '1-based line to start from.', default: 1 },
      limit: { type: 'integer', description: 'How many lines to return.', default: DEFAULT_READ_LINES },
    },
    required: ['path'],
  },
  handler: wrap(async ({ path: p, offset = 1, limit = DEFAULT_READ_LINES }) => {
    const abs = resolveReadable(p);
    if (!fs.existsSync(abs)) return { ok: false, error: `No such file: ${abs}` };
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { ok: false, error: `${abs} is a folder. Use pc_list_dir.` };
    if (st.size > MAX_READ_BYTES) return { ok: false, error: `${abs} is ${st.size} bytes, over the ${MAX_READ_BYTES} limit.` };
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return { ok: false, error: `${abs} looks like a binary file.` };
    const lines = buf.toString('utf8').split('\n');
    const start = Math.max(1, Number(offset) || 1);
    const slice = lines.slice(start - 1, start - 1 + Math.max(1, Number(limit) || DEFAULT_READ_LINES));
    const width = String(start + slice.length - 1).length;
    return {
      ok: true,
      result: {
        path: abs,
        totalLines: lines.length,
        shown: `${start}-${start + slice.length - 1}`,
        truncated: start - 1 + slice.length < lines.length,
        content: slice.map((l, i) => `${String(start + i).padStart(width)}\t${l}`).join('\n'),
      },
    };
  }),
});

/* Simple wildcards: * and ?, case-insensitive. */
function wildcard(pattern) {
  const re = String(pattern || '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`, 'i');
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'winsxs', '$recycle.bin', 'system volume information', 'windowsapps', 'installer']);

registerTool({
  name: 'pc_find',
  description: 'Find files by name anywhere on the PC, optionally only those containing some text. Read-only; searches under one folder, skips secrets, node_modules and .git (unless the folder itself is one). Stops after maxResults or 20 seconds.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      root: { type: 'string', description: 'Full path of the folder to search under.' },
      name: { type: 'string', description: 'File name pattern with * and ?, e.g. "package.json" or "*.log".', default: '*' },
      contains: { type: 'string', description: 'Only files containing this text (case-insensitive). Text files under 1 MB only.' },
      maxResults: { type: 'integer', default: 100 },
      maxDepth: { type: 'integer', default: 8 },
    },
    required: ['root'],
  },
  handler: wrap(async ({ root, name = '*', contains, maxResults = 100, maxDepth = 8 }) => {
    const start = resolveReadable(root);
    if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) return { ok: false, error: `No such folder: ${start}` };
    const match = wildcard(name);
    const needle = contains ? String(contains).toLowerCase() : null;
    const limit = Math.min(Math.max(1, Number(maxResults) || 100), 500);
    const deadline = Date.now() + 20_000;
    const found = [];
    let scanned = 0;
    let stopped = null;
    const stack = [[start, 0]];
    while (stack.length) {
      if (Date.now() > deadline) { stopped = 'time limit (20 s)'; break; }
      const [dir, depth] = stack.pop();
      let list;
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of list) {
        const full = path.join(dir, d.name);
        if (isSecretPath(full)) continue;
        if (d.isDirectory()) {
          if (depth < maxDepth && !SKIP_DIRS.has(d.name.toLowerCase())) stack.push([full, depth + 1]);
          continue;
        }
        if (!d.isFile() || !match.test(d.name)) continue;
        scanned++;
        if (needle) {
          try {
            const st = fs.statSync(full);
            if (st.size > 1024 * 1024) continue;
            const buf = fs.readFileSync(full);
            if (looksBinary(buf) || !buf.toString('utf8').toLowerCase().includes(needle)) continue;
          } catch { continue; }
        }
        found.push(full);
        if (found.length >= limit) { stopped = `${limit} results`; break; }
      }
      if (found.length >= limit) break;
    }
    return { ok: true, result: { root: start, matches: found, count: found.length, stoppedAt: stopped } };
  }),
});

registerTool({
  name: 'pc_diag',
  description: 'Doctor scan of this PC. Read-only. Sections: system (Windows, CPU, RAM, disks, pending reboot), path (user and system PATH: missing folders, duplicates, length), tools (which node/npm/git/python/… wins and versions; conflicts), env (variables pointing at missing folders), network (DNS, reachability, proxy), omnione (Node version support, known vulnerabilities in OmniOne\'s dependencies). Give `project` (a folder with package-lock.json) to also check that project\'s dependencies for known vulnerabilities. Returns findings with suggestions; to change anything, prepare a fix with propose_fix.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      sections: { type: 'array', items: { type: 'string', enum: ['system', 'path', 'tools', 'env', 'network', 'omnione'] }, description: 'Which parts to run. Default: all.' },
      project: { type: 'string', description: 'Optional full path of a Node project to audit (npm audit).' },
    },
  },
  handler: wrap(async ({ sections, project } = {}) => ({ ok: true, result: await runDiagnostics({ sections, project }) })),
});
