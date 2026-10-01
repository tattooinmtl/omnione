// Checkpoints — undo for the agent.
//
// Before a tool modifies a file, the current contents are copied into
// .checkpoints/<id>/. Reverting restores every file the checkpoint captured,
// including deleting files the agent created (recorded as "absent").
//
// Deliberately not git: the workspace may not be a repo, and if it is, the
// user's own staged work should not be disturbed by the agent's undo.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getWorkspaceRoot, toWorkspaceRelative } from './workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const CHECKPOINTS_DIR = path.join(PROJECT_ROOT, '.checkpoints');

const MAX_CHECKPOINT_BYTES = 5 * 1024 * 1024;

function ensureDir() {
  if (!fs.existsSync(CHECKPOINTS_DIR)) fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
}

function metaPath(id) {
  return path.join(CHECKPOINTS_DIR, id, 'checkpoint.json');
}

/* Snapshot the current state of `absPaths` before they are modified.
 * Returns the checkpoint id, or null if there was nothing worth saving. */
export function createCheckpoint({ sessionId, label, absPaths }) {
  const paths = [...new Set(absPaths || [])];
  if (!paths.length) return null;

  ensureDir();
  const id = `cp_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(CHECKPOINTS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const entries = [];
  for (const abs of paths) {
    const rel = toWorkspaceRelative(abs);
    if (!fs.existsSync(abs)) {
      // The tool is about to create this file; reverting means deleting it.
      entries.push({ rel, state: 'absent' });
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) continue;
    if (stat.size > MAX_CHECKPOINT_BYTES) {
      entries.push({ rel, state: 'too-large', size: stat.size });
      continue;
    }
    const stored = path.join(dir, 'files', rel);
    fs.mkdirSync(path.dirname(stored), { recursive: true });
    fs.copyFileSync(abs, stored);
    entries.push({ rel, state: 'saved', size: stat.size });
  }

  const meta = { id, sessionId, label: label || '', createdAt: new Date().toISOString(), entries };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  return id;
}

export function listCheckpoints({ sessionId, limit = 50 } = {}) {
  ensureDir();
  const out = [];
  for (const name of fs.readdirSync(CHECKPOINTS_DIR)) {
    if (!name.startsWith('cp_')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath(name), 'utf8'));
      if (sessionId && meta.sessionId !== sessionId) continue;
      out.push({ ...meta, fileCount: meta.entries.length });
    } catch { /* half-written checkpoint */ }
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out.slice(0, limit);
}

export function getCheckpoint(id) {
  if (!/^cp_[a-z0-9]+_[0-9a-f]{8}$/.test(String(id))) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch {
    return null;
  }
}

/* Put the workspace back the way it was. Returns a per-file report rather
 * than throwing on the first problem, so a partial revert is visible. */
export function revertCheckpoint(id) {
  const meta = getCheckpoint(id);
  if (!meta) return null;
  const root = getWorkspaceRoot();
  const dir = path.join(CHECKPOINTS_DIR, id);
  const restored = [];
  const removed = [];
  const skipped = [];

  for (const entry of meta.entries) {
    const abs = path.join(root, entry.rel);
    // The checkpoint was written from validated paths, but re-check: a
    // tampered checkpoint.json must not be able to write outside.
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      skipped.push({ ...entry, reason: 'outside workspace' });
      continue;
    }
    if (entry.state === 'absent') {
      if (fs.existsSync(abs)) { fs.rmSync(abs, { force: true }); removed.push(entry.rel); }
      continue;
    }
    if (entry.state !== 'saved') {
      skipped.push({ ...entry, reason: entry.state });
      continue;
    }
    const stored = path.join(dir, 'files', entry.rel);
    if (!fs.existsSync(stored)) {
      skipped.push({ ...entry, reason: 'snapshot missing' });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(stored, abs);
    restored.push(entry.rel);
  }

  return { id, restored, removed, skipped };
}

export function deleteCheckpoint(id) {
  if (!getCheckpoint(id)) return false;
  fs.rmSync(path.join(CHECKPOINTS_DIR, id), { recursive: true, force: true });
  return true;
}
