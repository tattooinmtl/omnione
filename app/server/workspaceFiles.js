// The editor's file actions on the workspace: open, save, save as, rename,
// move, duplicate, new folder, delete (to the Recycle Bin), and a change feed.
//
// These run when the user clicks something in the editor, so they don't go
// through the agent's permission modes, but every path still goes through
// resolveInWorkspace: nothing outside the workspace can be read or changed.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getWorkspaceRoot, resolveInWorkspace, toWorkspaceRelative, WorkspaceError } from './workspace.js';
import { sendToRecycleBin } from './fixes.js';

export const MAX_OPEN_BYTES = 2 * 1024 * 1024;

/* A workspace path that must name something inside the root, not the root itself. */
function inner(rel, what = 'Path') {
  const abs = resolveInWorkspace(rel);
  if (abs === getWorkspaceRoot()) throw new WorkspaceError(`${what} can't be the project folder itself.`);
  return abs;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

export function readFile(rel) {
  const abs = inner(rel);
  if (!fs.existsSync(abs)) throw new WorkspaceError(`No such file: ${rel}`);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new WorkspaceError(`${rel} is a folder.`);
  const out = { path: toWorkspaceRelative(abs), size: st.size, mtimeMs: st.mtimeMs };
  if (st.size > MAX_OPEN_BYTES) return { ...out, tooLarge: true };
  const buf = fs.readFileSync(abs);
  if (looksBinary(buf)) return { ...out, binary: true };
  return { ...out, content: buf.toString('utf8') };
}

/* Save. `overwrite: false` (Save as, New file) refuses to replace an existing file. */
export function writeFile(rel, content, { overwrite = true } = {}) {
  if (typeof content !== 'string') throw new WorkspaceError('content must be text.');
  const abs = inner(rel);
  if (fs.existsSync(abs)) {
    if (fs.statSync(abs).isDirectory()) throw new WorkspaceError(`${rel} is a folder.`);
    if (!overwrite) throw new WorkspaceError(`${toWorkspaceRelative(abs)} already exists.`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  const st = fs.statSync(abs);
  return { path: toWorkspaceRelative(abs), size: st.size, mtimeMs: st.mtimeMs };
}

export function makeFolder(rel) {
  const abs = inner(rel, 'The new folder');
  if (fs.existsSync(abs)) throw new WorkspaceError(`${toWorkspaceRelative(abs)} already exists.`);
  fs.mkdirSync(abs, { recursive: true });
  return { path: toWorkspaceRelative(abs) };
}

/* Rename and move are the same thing: a new path for a file or folder. */
export function movePath(from, to) {
  const src = inner(from);
  const dest = inner(to, 'The destination');
  if (!fs.existsSync(src)) throw new WorkspaceError(`No such file or folder: ${from}`);
  if (src === dest) return { path: toWorkspaceRelative(dest) };
  // Only a change of letter case on Windows: same file, so no "already exists".
  const caseOnly = src.toLowerCase() === dest.toLowerCase();
  if (fs.existsSync(dest) && !caseOnly) throw new WorkspaceError(`${toWorkspaceRelative(dest)} already exists.`);
  if (dest.startsWith(src + path.sep)) throw new WorkspaceError("A folder can't be moved into itself.");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return { path: toWorkspaceRelative(dest) };
}

export function copyPath(from, to) {
  const src = inner(from);
  const dest = inner(to, 'The copy');
  if (!fs.existsSync(src)) throw new WorkspaceError(`No such file or folder: ${from}`);
  if (fs.existsSync(dest)) throw new WorkspaceError(`${toWorkspaceRelative(dest)} already exists.`);
  if (dest.startsWith(src + path.sep)) throw new WorkspaceError("A folder can't be copied into itself.");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, errorOnExist: true, force: false });
  return { path: toWorkspaceRelative(dest) };
}

/* A free name next to `rel` for Duplicate: "a.js" → "a copy.js", "a copy 2.js", … */
export function copyName(rel) {
  const abs = inner(rel);
  const dir = path.dirname(abs);
  const ext = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? '' : path.extname(abs);
  const base = path.basename(abs, ext);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, `${base} copy${i > 1 ? ` ${i}` : ''}${ext}`);
    if (!fs.existsSync(candidate)) return toWorkspaceRelative(candidate);
  }
  throw new WorkspaceError('No free name for the copy.');
}

/* Delete = Recycle Bin, never a permanent delete, so it can be restored. */
export async function recyclePath(rel) {
  const abs = inner(rel);
  if (!fs.existsSync(abs)) throw new WorkspaceError(`No such file or folder: ${rel}`);
  await sendToRecycleBin(abs);
  return { path: toWorkspaceRelative(abs) };
}

/* Show it in Windows Explorer. */
export function revealPath(rel) {
  const abs = resolveInWorkspace(rel);
  if (!fs.existsSync(abs)) throw new WorkspaceError(`No such file or folder: ${rel}`);
  if (process.platform !== 'win32') throw new WorkspaceError('Showing files is only available on Windows.');
  const args = abs === getWorkspaceRoot() ? [abs] : [`/select,${abs}`];
  spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { path: toWorkspaceRelative(abs) };
}

// --- change feed -------------------------------------------------------------
//
// One recursive watcher on the workspace, shared by every open editor. Changes
// are batched for 150 ms, so an agent writing ten files sends one event.

const NOISY = /(^|\/)(\.git|node_modules|\.sessions|\.checkpoints)(\/|$)/;
const listeners = new Set();
let watcher = null;
let watchedRoot = null;
let pending = new Set();
let timer = null;

function flush() {
  timer = null;
  const paths = [...pending];
  pending = new Set();
  for (const fn of listeners) {
    try { fn({ type: 'changed', paths }); } catch { /* listener gone */ }
  }
}

function startWatcher() {
  const root = getWorkspaceRoot();
  if (watcher && watchedRoot === root) return;
  stopWatcher();
  watchedRoot = root;
  try {
    watcher = fs.watch(root, { recursive: true }, (_event, name) => {
      const rel = name ? String(name).split(path.sep).join('/') : '';
      if (rel && NOISY.test(rel)) return;
      pending.add(rel);
      if (!timer) timer = setTimeout(flush, 150);
    });
    watcher.on('error', () => stopWatcher());
  } catch {
    watcher = null; // no watching on this filesystem; the editor still refreshes after each answer
  }
}

function stopWatcher() {
  try { watcher?.close(); } catch { /* already closed */ }
  watcher = null;
  watchedRoot = null;
}

/* Subscribe to changes; returns the unsubscribe function. Follows the
 * workspace when it is switched to another folder. */
export function watchWorkspace(fn) {
  listeners.add(fn);
  startWatcher();
  return () => {
    listeners.delete(fn);
    if (!listeners.size) stopWatcher();
  };
}

/* Call after the workspace root changes, so the watcher follows it. */
export function workspaceRootChanged() {
  if (!listeners.size) return;
  stopWatcher();
  startWatcher();
  for (const fn of listeners) {
    try { fn({ type: 'root', root: getWorkspaceRoot() }); } catch { /* listener gone */ }
  }
}
