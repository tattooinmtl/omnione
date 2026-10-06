// Settings → Agent: the user's own instructions, the project's instruction
// files, custom commands, and the values that tune how the agent works.
//
// Everything is read when it's used, so a change applies from the next
// message without a restart. Values are clamped here: the preferences file
// can be edited by hand.

import fs from 'node:fs';
import path from 'node:path';
import { getPrefs } from './prefs.js';
import { getWorkspaceRoot } from './workspace.js';

export const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md', 'OMNI.md'];
export const MAX_INSTRUCTIONS = 20_000;
const MAX_PROJECT_FILE = 30_000;
export const MODES_FOR_NEW_CHATS = ['default', 'acceptEdits', 'plan'];

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

/* The tuning values, always in range. */
export function agentSettings() {
  const a = getPrefs().agent || {};
  return {
    defaultMode: MODES_FOR_NEW_CHATS.includes(a.defaultMode) ? a.defaultMode : 'default',
    approvalMs: clamp(a.approvalMinutes, 1, 30, 5) * 60_000,
    autoReflect: a.autoReflect !== false,
    reflectMinTools: clamp(a.reflectMinTools, 2, 50, 6),
    stuckRepeat: clamp(a.stuckRepeat, 2, 6, 3),
    compactAt: clamp(a.compactAt, 60, 95, 80) / 100,
    maxOutputTokens: a.maxOutputTokens ? clamp(a.maxOutputTokens, 1024, 131072, 0) : 0,
    retries: clamp(a.retries, 0, 6, 3),
    imagesKept: clamp(a.imagesKept, 1, 20, 8),
    subagentSteps: clamp(a.subagentSteps, 3, 40, 15),
  };
}

/* The project's instruction files that exist in the open folder. */
export function projectInstructionFiles(root = getWorkspaceRoot()) {
  const out = [];
  for (const name of PROJECT_FILES) {
    const file = path.join(root, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) out.push({ name, path: file, bytes: st.size });
    } catch { /* not there */ }
  }
  return out;
}

/* What goes into the system prompt: the user's instructions (Settings →
 * Agent) and the project's AGENTS.md / CLAUDE.md / OMNI.md. Empty when there
 * is neither. */
export function instructionsPrompt() {
  const a = getPrefs().agent || {};
  const parts = [];
  const mine = String(a.instructions || '').trim().slice(0, MAX_INSTRUCTIONS);
  if (mine) {
    parts.push(`INSTRUCTIONS FROM THE USER (Settings → Agent; follow them in every conversation, unless they conflict with safety rules or approvals):\n${mine}`);
  }
  if (a.readProjectFiles !== false) {
    for (const f of projectInstructionFiles()) {
      let text = '';
      try { text = fs.readFileSync(f.path, 'utf8'); } catch { continue; }
      text = text.trim();
      if (!text) continue;
      if (text.length > MAX_PROJECT_FILE) text = `${text.slice(0, MAX_PROJECT_FILE)}\n…(cut off: read the rest with read_file ${f.name})`;
      parts.push(`PROJECT INSTRUCTIONS (${f.name} in the project folder; they describe how to work on this project):\n${text}`);
    }
  }
  return parts.join('\n\n');
}

/* Clean up the custom commands coming from the Settings form. */
export function sanitizeCommands(list) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(list) ? list.slice(0, 50) : []) {
    const name = String(c?.name || '').toLowerCase().replace(/^\/+/, '').replace(/[^a-z0-9-]/g, '').slice(0, 30);
    const prompt = String(c?.prompt || '').trim().slice(0, 8000);
    if (!name || !prompt || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: String(c?.description || '').slice(0, 120), prompt });
  }
  return out;
}
