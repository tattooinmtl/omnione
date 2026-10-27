// Memory writes held for the user's review.
//
// Omi-One remembers on its own: asking first would mean it remembers
// nothing. But a run that has read outside content (a web page, search
// results, a forum post, MCP output; see taint.js) may have been told what
// to "remember" by whoever wrote it, and memories load into every later
// session. So writes from such a run wait here, outside the mind, until the
// user approves them in Settings → Memory. Approving runs the write exactly
// as the agent asked; discarding drops it.

import { readJson, writeJson, newId } from './store.js';

const FILE = 'held.json';
const MAX_HELD = 200;
const appliers = new Map(); // tool name -> the tool's own handler

/* tools/mind.js registers the real handler of each tool that can be held. */
export function registerHoldable(tool, handler) { appliers.set(tool, handler); }
export function isHoldable(tool) { return appliers.has(tool); }

export function listHeld() {
  const rows = readJson(FILE, []);
  return Array.isArray(rows) ? rows : [];
}

export function holdWrite({ tool, args, sessionId = null, taintedBy = '', now = Date.now() }) {
  const entry = { id: newId('held'), tool, args: args || {}, sessionId, taintedBy, at: now };
  writeJson(FILE, [...listHeld(), entry].slice(-MAX_HELD));
  return entry;
}

function take(id) {
  const rows = listHeld();
  const entry = rows.find((r) => r.id === id);
  if (entry) writeJson(FILE, rows.filter((r) => r !== entry));
  return entry || null;
}

/* Apply a held write. Resolves to the tool's result, or null if there is no such entry. */
export async function approveHeld(id) {
  const entry = take(id);
  if (!entry) return null;
  const apply = appliers.get(entry.tool);
  if (!apply) return { ok: false, error: `"${entry.tool}" can't be applied any more.` };
  return apply(entry.args, {});
}

export function discardHeld(id) {
  return take(id) !== null;
}
