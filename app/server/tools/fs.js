// Filesystem tools.
//
// Everything here goes through resolveInWorkspace, so the agent cannot read
// or write outside the workspace root no matter what path it produces.
//
// `edit_file` uses the exact-string-replace contract rather than line numbers
// or unified diffs: the model supplies a unique snippet of the current file
// and its replacement, and the edit is refused if the snippet is missing or
// appears more than once. Line numbers drift the moment anything else
// changes, and a model-authored diff that does not apply fails in ways that
// are hard to report back usefully.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  resolveInWorkspace,
  toWorkspaceRelative,
  getWorkspaceRoot,
  walkWorkspace,
  isIgnored,
} from '../workspace.js';
import { registerTool } from '../toolRegistry.js';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const DEFAULT_READ_LINES = 2000;

/* Binary files waste context and can break the JSON encoding. Sniff for NUL
 * bytes in the first chunk, which is what `git` and `grep` effectively do. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

// --- read ------------------------------------------------------------------

registerTool({
  name: 'read_file',
  description: 'Read a text file from the workspace. Returns numbered lines. Use offset/limit for large files.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      offset: { type: 'integer', description: '1-based line to start from.', default: 1 },
      limit: { type: 'integer', description: 'How many lines to return.', default: DEFAULT_READ_LINES },
    },
    required: ['path'],
  },
  handler: async ({ path: p, offset = 1, limit = DEFAULT_READ_LINES }) => {
    const abs = resolveInWorkspace(p);
    if (!fs.existsSync(abs)) return { ok: false, error: `No such file: ${p}` };
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return { ok: false, error: `${p} is a directory. Use list_dir.` };
    if (stat.size > MAX_READ_BYTES) {
      return { ok: false, error: `${p} is ${stat.size} bytes, over the ${MAX_READ_BYTES} limit. Use grep, or read it in pieces with offset/limit.` };
    }
    const buf = fs.readFileSync(abs);
    if (looksBinary(buf)) return { ok: false, error: `${p} looks like a binary file.` };

    const lines = buf.toString('utf8').split('\n');
    const start = Math.max(1, Number(offset) || 1);
    const count = Math.max(1, Number(limit) || DEFAULT_READ_LINES);
    const slice = lines.slice(start - 1, start - 1 + count);
    const width = String(start + slice.length - 1).length;
    const numbered = slice.map((l, i) => `${String(start + i).padStart(width)}\t${l}`).join('\n');

    return {
      ok: true,
      result: {
        path: toWorkspaceRelative(abs),
        totalLines: lines.length,
        shown: `${start}-${start + slice.length - 1}`,
        truncated: start - 1 + slice.length < lines.length,
        content: numbered,
      },
    };
  },
});

// --- write -----------------------------------------------------------------

registerTool({
  name: 'write_file',
  description: 'Write a file, creating it or replacing it entirely. To change part of an existing file, prefer edit_file.',
  permission: 'write',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      content: { type: 'string', description: 'The complete new file contents.' },
    },
    required: ['path', 'content'],
  },
  // The agent loop reads this to know which files to snapshot first.
  affectedPaths: ({ path: p }) => [p],
  handler: async ({ path: p, content }) => {
    const abs = resolveInWorkspace(p);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
      return { ok: false, error: `${p} is a directory.` };
    }
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content ?? ''), 'utf8');
    return {
      ok: true,
      result: {
        path: toWorkspaceRelative(abs),
        action: existed ? 'replaced' : 'created',
        bytes: Buffer.byteLength(String(content ?? ''), 'utf8'),
      },
    };
  },
});

registerTool({
  name: 'edit_file',
  description: 'Replace an exact snippet in a file. old_string must appear exactly once — include enough surrounding context to make it unique.',
  permission: 'write',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      old_string: { type: 'string', description: 'The exact text to replace, including indentation.' },
      new_string: { type: 'string', description: 'The replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.', default: false },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  affectedPaths: ({ path: p }) => [p],
  handler: async ({ path: p, old_string: oldStr, new_string: newStr, replace_all: replaceAll = false }) => {
    const abs = resolveInWorkspace(p);
    if (!fs.existsSync(abs)) return { ok: false, error: `No such file: ${p}` };
    if (oldStr === newStr) return { ok: false, error: 'old_string and new_string are identical.' };

    const before = fs.readFileSync(abs, 'utf8');
    const occurrences = before.split(oldStr).length - 1;

    if (occurrences === 0) {
      return { ok: false, error: `old_string not found in ${p}. It must match the file exactly, including whitespace and indentation.` };
    }
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, error: `old_string appears ${occurrences} times in ${p}. Add surrounding context to make it unique, or pass replace_all: true.` };
    }

    const after = replaceAll ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr);
    fs.writeFileSync(abs, after, 'utf8');
    return {
      ok: true,
      result: {
        path: toWorkspaceRelative(abs),
        replacements: replaceAll ? occurrences : 1,
        // A small diff hint, so the model can see what it did without re-reading.
        linesBefore: before.split('\n').length,
        linesAfter: after.split('\n').length,
      },
    };
  },
});

// --- list / glob / grep ----------------------------------------------------

registerTool({
  name: 'list_dir',
  description: 'List the entries of a directory in the workspace. Ignored paths (.gitignore, node_modules, .git) are omitted.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Directory relative to the workspace root.', default: '.' } },
  },
  handler: async ({ path: p = '.' }) => {
    const abs = resolveInWorkspace(p);
    if (!fs.existsSync(abs)) return { ok: false, error: `No such directory: ${p}` };
    if (!fs.statSync(abs).isDirectory()) return { ok: false, error: `${p} is not a directory.` };

    const root = getWorkspaceRoot();
    const entries = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const entryAbs = path.join(abs, e.name);
      const rel = path.relative(root, entryAbs).split(path.sep).join('/');
      const isDir = e.isDirectory();
      if (isIgnored(rel, { isDir })) continue;
      let size = null;
      try { size = isDir ? null : fs.statSync(entryAbs).size; } catch { /* vanished */ }
      entries.push({ name: e.name, type: isDir ? 'dir' : 'file', ...(size == null ? {} : { size }) });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, result: { path: toWorkspaceRelative(abs), count: entries.length, entries } };
  },
});

/* Translate a glob to a regex. Supports **, *, ?, and {a,b} alternation. */
function globToRegex(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // '**/' should also match zero directories.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') re += '(?:';
    else if (c === '}') re += ')';
    else if (c === ',') re += '|';
    else if ('\\^$.|+()[]'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

registerTool({
  name: 'glob',
  description: 'Find files by glob pattern, e.g. "src/**/*.js" or "**/*.{ino,cpp}". Returns workspace-relative paths.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'The glob pattern.' },
      limit: { type: 'integer', description: 'Maximum paths to return.', default: 200 },
    },
    required: ['pattern'],
  },
  handler: async ({ pattern, limit = 200 }) => {
    let re;
    try { re = globToRegex(String(pattern)); } catch (e) { return { ok: false, error: `Bad pattern: ${e.message}` }; }
    const matches = [];
    for (const { relPath, isDir } of walkWorkspace('.')) {
      if (isDir) continue;
      if (re.test(relPath)) matches.push(relPath);
      if (matches.length >= limit) break;
    }
    return { ok: true, result: { pattern, count: matches.length, files: matches } };
  },
});

/* Prefer ripgrep when it is installed — it is dramatically faster on a big
 * tree and already understands .gitignore. Fall back to a JS scan so the
 * tool works on a machine without it. */
function ripgrepAvailable() {
  try {
    return spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
}
let rgChecked = null;

registerTool({
  name: 'grep',
  description: 'Search file contents by regular expression. Returns matching lines with their file and line number.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "**/*.js".' },
      ignore_case: { type: 'boolean', default: false },
      limit: { type: 'integer', description: 'Maximum matching lines to return.', default: 100 },
    },
    required: ['pattern'],
  },
  handler: async ({ pattern, glob: globPat, ignore_case: ignoreCase = false, limit = 100 }) => {
    if (rgChecked === null) rgChecked = ripgrepAvailable();

    if (rgChecked) {
      const args = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(limit)];
      if (ignoreCase) args.push('--ignore-case');
      if (globPat) args.push('--glob', globPat);
      args.push('--regexp', String(pattern), '.');
      const r = spawnSync('rg', args, { cwd: getWorkspaceRoot(), encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
      // rg exits 1 for "no matches", which is a result, not an error.
      if (r.status === 0 || r.status === 1) {
        const matches = parseRipgrep(r.stdout || '', limit);
        return { ok: true, result: { pattern, engine: 'ripgrep', count: matches.length, matches } };
      }
      // Anything else (bad regex, missing binary) falls through to the JS path.
    }

    let re;
    try { re = new RegExp(String(pattern), ignoreCase ? 'i' : ''); } catch (e) {
      return { ok: false, error: `Bad regular expression: ${e.message}` };
    }
    const fileRe = globPat ? globToRegex(globPat) : null;
    const matches = [];
    for (const { relPath, abs, isDir } of walkWorkspace('.')) {
      if (isDir) continue;
      if (fileRe && !fileRe.test(relPath)) continue;
      let buf;
      try { buf = fs.readFileSync(abs); } catch { continue; }
      if (buf.length > MAX_READ_BYTES || looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!re.test(lines[i])) continue;
        matches.push({ file: relPath, line: i + 1, text: lines[i].slice(0, 400) });
        if (matches.length >= limit) {
          return { ok: true, result: { pattern, engine: 'js', count: matches.length, truncated: true, matches } };
        }
      }
    }
    return { ok: true, result: { pattern, engine: 'js', count: matches.length, matches } };
  },
});

function parseRipgrep(stdout, limit) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // "path:line:text" — the path may contain colons on Windows, so split
    // from the left only twice and trust rg's ordering.
    const first = line.indexOf(':');
    const second = line.indexOf(':', first + 1);
    if (first < 0 || second < 0) continue;
    const file = line.slice(0, first).replace(/^\.[\\/]/, '').split('\\').join('/');
    const num = Number(line.slice(first + 1, second));
    if (!Number.isFinite(num)) continue;
    out.push({ file, line: num, text: line.slice(second + 1).slice(0, 400) });
    if (out.length >= limit) break;
  }
  return out;
}

export { globToRegex };
