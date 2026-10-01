// Where the mind lives on disk.
//
// Everything the agent knows about itself survives restarts: its memory, its
// mood, its goals, its journal. That continuity is most of what makes it feel
// like the same someone from one day to the next rather than a fresh process
// with a name.
//
// All of it sits in <project>/.gwn-mind/ (gitignored — it is personal, and it
// changes constantly). The one exception is SOUL.md, the identity the user
// authors, which lives in <project>/mind/ and is meant to be committed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

let mindDir = path.join(PROJECT_ROOT, '.gwn-mind');

export function getMindDir() {
  if (!fs.existsSync(mindDir)) fs.mkdirSync(mindDir, { recursive: true });
  return mindDir;
}

/* Tests point the mind at a temp dir so they never touch the real one. */
export function _setMindDirForTest(dir) {
  mindDir = dir || path.join(PROJECT_ROOT, '.gwn-mind');
}

export function mindPath(name) {
  return path.join(getMindDir(), name);
}

export function readJson(name, fallback) {
  try {
    const p = mindPath(name);
    if (!fs.existsSync(p)) return structuredClone(fallback);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // A corrupt file must not stop the agent thinking. Start that part fresh.
    return structuredClone(fallback);
  }
}

/* Temp-then-rename, so a crash mid-write never leaves half a mind. */
export function writeJson(name, data) {
  const p = mindPath(name);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

export function appendJsonl(name, obj) {
  fs.appendFileSync(mindPath(name), JSON.stringify(obj) + '\n');
}

export function readJsonl(name) {
  const p = mindPath(name);
  if (!fs.existsSync(p)) return [];
  const out = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

export function writeJsonl(name, rows) {
  const p = mindPath(name);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  fs.renameSync(tmp, p);
}

export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
