// The workspace: the one directory tree the agent is allowed to touch.
//
// Until now the "project" was a {filename: string} map in React state kept in
// localStorage, so the agent could not read a file, write a file, or run
// anything — it could only emit a blob that the client parsed into editor
// tabs. Everything in Phase 2 hangs off having a real directory instead.
//
// Every path the agent supplies is resolved against the workspace root and
// checked for containment before it reaches the filesystem. `path.join` alone
// is not enough: it happily produces an escaping path, and on Windows a
// drive-relative path ("C:evil") or a UNC path sidesteps a naive prefix test.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, '.gwn-workspace.json');
const DEFAULT_ROOT = path.join(PROJECT_ROOT, 'workspace');

let cachedRoot = null;

export class WorkspaceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (raw?.root && typeof raw.root === 'string') return raw.root;
  } catch { /* no config yet */ }
  return null;
}

/* The active workspace root, created on first use. */
export function getWorkspaceRoot() {
  if (cachedRoot) return cachedRoot;
  const configured = readConfig();
  const root = configured ? path.resolve(configured) : DEFAULT_ROOT;
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  cachedRoot = fs.realpathSync(root);
  return cachedRoot;
}

/* Point the agent at a different directory. Refuses anything that is not an
 * existing directory — silently creating a workspace from a typo'd path is a
 * good way to lose work. */
export function setWorkspaceRoot(dir) {
  if (!dir || typeof dir !== 'string') throw new WorkspaceError('A directory path is required.');
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) throw new WorkspaceError(`No such directory: ${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new WorkspaceError(`Not a directory: ${resolved}`);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ root: resolved }, null, 2));
  cachedRoot = fs.realpathSync(resolved);
  ignoreCache.clear();
  return cachedRoot;
}

/* Back to the default folder inside the app. */
export function resetWorkspaceRoot() {
  try { fs.rmSync(CONFIG_PATH, { force: true }); } catch { /* nothing to remove */ }
  cachedRoot = null;
  ignoreCache.clear();
  return getWorkspaceRoot();
}

export function isDefaultWorkspace() {
  return getWorkspaceRoot() === fs.realpathSync(DEFAULT_ROOT);
}

/* Test hook — swap the root without writing config. */
export function _setWorkspaceRootForTest(dir) {
  cachedRoot = dir ? fs.realpathSync(dir) : null;
  ignoreCache.clear();
  return cachedRoot;
}

/**
 * Resolve an agent-supplied path inside the workspace.
 *
 * @param {string} relPath  path relative to the workspace root
 * @returns {string} absolute path, guaranteed to be inside the root
 * @throws {WorkspaceError} if it escapes
 */
export function resolveInWorkspace(relPath) {
  const root = getWorkspaceRoot();
  if (relPath == null || relPath === '') return root;
  if (typeof relPath !== 'string') throw new WorkspaceError('Path must be a string.');

  // Reject absolute and drive-relative forms up front rather than letting
  // path.resolve quietly discard the root.
  if (path.isAbsolute(relPath)) {
    // An absolute path is allowed only if it is already inside the workspace,
    // because models often echo back a path we gave them.
    const abs = path.resolve(relPath);
    assertInside(root, abs, relPath);
    return abs;
  }
  if (/^[A-Za-z]:/.test(relPath)) {
    throw new WorkspaceError(`Refusing drive-relative path "${relPath}".`);
  }
  if (relPath.startsWith('\\\\')) {
    throw new WorkspaceError(`Refusing UNC path "${relPath}".`);
  }

  const abs = path.resolve(root, relPath);
  assertInside(root, abs, relPath);
  return abs;
}

function assertInside(root, abs, original) {
  const normalizedRoot = path.resolve(root);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) {
    throw new WorkspaceError(`Path "${original}" is outside the workspace (${normalizedRoot}).`);
  }
  // A symlink can point out of the workspace even when the path string looks
  // fine. Check the real path of the nearest existing ancestor.
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return; // nothing exists yet; the string check stands
    probe = parent;
  }
  let real;
  try { real = fs.realpathSync(probe); } catch { return; }
  if (real !== normalizedRoot && !real.startsWith(normalizedRoot + path.sep)) {
    throw new WorkspaceError(`Path "${original}" resolves through a link to outside the workspace.`);
  }
}

/* The path to show the model and the user: relative, forward slashes. */
export function toWorkspaceRelative(abs) {
  const rel = path.relative(getWorkspaceRoot(), abs);
  return rel.split(path.sep).join('/') || '.';
}

// --- ignore rules ----------------------------------------------------------
//
// A minimal .gitignore-compatible matcher. It covers the patterns that
// actually appear in ignore files — literal names, globs, directory-only
// rules, anchored rules and negation — without pulling in a dependency.

const ALWAYS_IGNORED = ['.git', 'node_modules', '.sessions', '.checkpoints'];
const ignoreCache = new Map();

function patternToRegex(pattern) {
  const anchored = pattern.startsWith('/');
  let p = anchored ? pattern.slice(1) : pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);

  let re = '';
  for (let i = 0; i < p.length; i += 1) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (p[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  // An unanchored pattern with no slash matches at any depth.
  const prefix = anchored || p.includes('/') ? '^' : '(^|.*/)';
  return { re: new RegExp(`${prefix}${re}(/.*)?$`), dirOnly };
}

function loadIgnore(root) {
  if (ignoreCache.has(root)) return ignoreCache.get(root);
  const rules = ALWAYS_IGNORED.map((n) => ({ ...patternToRegex(n), negate: false }));
  for (const file of ['.gitignore', '.agentignore']) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    let text = '';
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      const pattern = negate ? line.slice(1) : line;
      if (!pattern) continue;
      rules.push({ ...patternToRegex(pattern), negate });
    }
  }
  ignoreCache.set(root, rules);
  return rules;
}

/* Should this workspace-relative path be hidden from the agent? Later rules
 * win, so a negation can re-include something an earlier rule excluded. */
export function isIgnored(relPath, { isDir = false } = {}) {
  const rel = String(relPath).split(path.sep).join('/');
  if (rel === '.' || rel === '') return false;
  let ignored = false;
  for (const rule of loadIgnore(getWorkspaceRoot())) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.re.test(rel)) ignored = !rule.negate;
  }
  return ignored;
}

export function refreshIgnoreRules() {
  ignoreCache.clear();
}

/* Walk the workspace, skipping ignored entries.
 * Yields { relPath, abs, isDir }. */
export function* walkWorkspace(startRel = '.', { maxEntries = 20000 } = {}) {
  const root = getWorkspaceRoot();
  const startAbs = resolveInWorkspace(startRel);
  const queue = [startAbs];
  let seen = 0;

  while (queue.length) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip rather than abort the walk
    }
    for (const entry of entries) {
      if (seen >= maxEntries) return;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      const isDir = entry.isDirectory();
      if (isIgnored(rel, { isDir })) continue;
      seen += 1;
      yield { relPath: rel, abs, isDir };
      if (isDir) queue.push(abs);
    }
  }
}
