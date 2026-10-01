// Subagents.
//
// A `task` tool that runs a nested agent loop with its own conversation, its
// own tool subset, and a summary as its only output.
//
// The point is context economy, not parallelism. "Find every place the serial
// baud rate is hard-coded" might take fifteen greps and reads; done inline
// that is fifteen tool results wedged into the main conversation forever,
// crowding out the actual task. Delegated, the parent sees one paragraph.
//
// Constraints that matter:
// - A subagent never spawns another. Recursion here is how you turn one
//   prompt into a bill, and nothing needs it.
// - Subagents run with the parent's permission mode. A subagent that could
//   quietly write files while the parent is in plan mode would be a hole
//   straight through the permission layer.
// - Definitions live in agents/<name>.md with the same frontmatter shape as
//   skills, so the format is already familiar.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');

export const DEFAULT_SUBAGENT_ITERATIONS = 15;

/* Tool sets a subagent may be given. `task` is absent from all of them — see
 * the no-recursion rule above. */
export const TOOL_PRESETS = {
  // Look, report back. Safe to run without supervision.
  readonly: [
    'read_file', 'list_dir', 'glob', 'grep',
    'web_search', 'browser_open',
    'list_skills', 'load_skill', 'load_skill_file',
    'search_memory', 'recall_session',
  ],
  // Everything the parent has, minus task itself.
  full: null,
};

let catalog = null;

export function ensureAgentsDir() {
  if (!fs.existsSync(AGENTS_DIR)) fs.mkdirSync(AGENTS_DIR, { recursive: true });
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

/* Read agents/*.md. A definition is a name, a description telling the parent
 * when to delegate, a tool preset, and a system prompt body. */
export function scanAgents() {
  const out = [];
  if (fs.existsSync(AGENTS_DIR)) {
    for (const entry of fs.readdirSync(AGENTS_DIR)) {
      if (!entry.endsWith('.md')) continue;
      try {
        const raw = fs.readFileSync(path.join(AGENTS_DIR, entry), 'utf8');
        const { meta, body } = parseFrontmatter(raw);
        const name = meta.name || path.basename(entry, '.md');
        out.push({
          name,
          description: meta.description || '',
          tools: meta.tools === 'full' ? 'full' : 'readonly',
          prompt: body.trim(),
        });
      } catch { /* unreadable definition; skip it */ }
    }
  }
  // A built-in so the tool is useful with an empty agents/ folder.
  if (!out.some((a) => a.name === 'explore')) {
    out.unshift({
      name: 'explore',
      description: 'Search the workspace and report findings. Use for open-ended questions that need many reads or greps — it keeps that search out of your context.',
      tools: 'readonly',
      prompt: 'You are a focused research subagent. Investigate what you were asked, using reads and searches. You cannot modify anything. Report your findings concisely: what you found, the file paths and line numbers that matter, and anything that contradicts the premise of the question. Do not pad the answer.',
    });
  }
  catalog = out;
  return out;
}

export function getAgents() {
  if (!catalog) return scanAgents();
  return catalog;
}

export function getAgent(name) {
  return getAgents().find((a) => a.name === name) || null;
}

/* The tool list for a subagent, resolved against what the parent can call. */
export function toolsForAgent(agent, allTools) {
  const usable = allTools.filter((t) => t.name !== 'task');
  if (agent.tools === 'full') return usable;
  const allowed = new Set(TOOL_PRESETS.readonly);
  return usable.filter((t) => allowed.has(t.name));
}
