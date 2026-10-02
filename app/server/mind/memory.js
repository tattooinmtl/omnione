// Memory, in two tiers.
//
// Core memory (after Letta / MemGPT): a handful of small, named blocks that
// are always in the system prompt, and that the agent rewrites itself as it
// learns. "persona" is who it thinks it is, "human" is what it knows about
// the user, "project" is the state of the work, "scratch" is working notes.
// Each block has a hard character limit, so the agent has to decide what is
// worth keeping instead of growing the prompt until it stops fitting.
//
// The memory stream (after Stanford's Generative Agents): an append-only log
// of observations, facts and reflections, far too large for the prompt. It is
// searched on demand and scored by recency, importance and relevance, so what
// comes back is what a person would actually think of in the moment — recent
// things, important things, and things related to the question — rather than
// whatever happens to share the most keywords.

import { readJson, writeJson, appendJsonl, readJsonl, writeJsonl, newId } from './store.js';
import { activeProject, getProjectNotes, setProjectNotes, migrateFromSingleProject } from '../projects.js';
import { fileGoalsUnder } from './state.js';

const CORE_FILE = 'core.json';
const STREAM_FILE = 'stream.jsonl';

export const CORE_LIMITS = {
  persona: 2000,
  human: 2000,
  project: 3000,
  scratch: 1500,
};

const DEFAULT_CORE = {
  persona: 'I am new. I have not yet learned much about myself. I am curious, and I want to become genuinely useful to the person I work with.',
  human: 'I have not learned anything about the user yet.',
  project: 'No project notes yet.',
  scratch: '',
};

export const MEMORY_KINDS = ['observation', 'fact', 'reflection', 'episode'];
const MAX_STREAM = 5000;

// --- core -------------------------------------------------------------------

/* The core blocks. "project" is the open project's notes (projects.js);
 * with no project open it is empty and the chat is general. */
export function getCore() {
  const stored = { ...DEFAULT_CORE, ...readJson(CORE_FILE, DEFAULT_CORE) };
  // Once: the old single project block becomes a project of its own.
  migrateFromSingleProject({ oldNotes: stored.project, fileGoals: fileGoalsUnder });
  const p = activeProject();
  return { ...stored, project: p ? getProjectNotes() : '', projectName: p ? p.name : null };
}

function checkBlock(block) {
  if (!(block in CORE_LIMITS)) {
    throw new Error(`Unknown memory block "${block}". Blocks: ${Object.keys(CORE_LIMITS).join(', ')}.`);
  }
}

function saveBlock(core, block, value) {
  const limit = CORE_LIMITS[block];
  if (value.length > limit) {
    throw new Error(`Block "${block}" would be ${value.length} characters; the limit is ${limit}. Condense it with core_memory_replace — decide what matters.`);
  }
  if (block === 'project') {
    // Project notes live with the open project.
    const p = setProjectNotes(value);
    return { block, project: p.name, chars: value.length, limit };
  }
  const stored = { ...DEFAULT_CORE, ...readJson(CORE_FILE, DEFAULT_CORE) };
  stored[block] = value;
  writeJson(CORE_FILE, stored);
  return { block, chars: value.length, limit };
}

export function coreAppend(block, text) {
  checkBlock(block);
  const core = getCore();
  const cur = core[block] || '';
  const add = String(text || '').trim();
  if (!add) throw new Error('Nothing to append.');
  return saveBlock(core, block, cur ? `${cur}\n${add}` : add);
}

/* Exact-substring replace, like edit_file: the agent has to quote what it is
 * changing, so it cannot silently rewrite a block it has not read. An empty
 * `newText` deletes the passage. */
export function coreReplace(block, oldText, newText) {
  checkBlock(block);
  const core = getCore();
  const cur = core[block] || '';
  if (!oldText) {
    // No anchor: replace the whole block. Used to condense a full one.
    return saveBlock(core, block, String(newText ?? '').trim());
  }
  const n = cur.split(oldText).length - 1;
  if (n === 0) throw new Error(`That text is not in the "${block}" block. Quote it exactly.`);
  if (n > 1) throw new Error(`That text appears ${n} times in "${block}". Quote more of it.`);
  return saveBlock(core, block, cur.replace(oldText, String(newText ?? '')).trim());
}

// --- memory stream ------------------------------------------------------------

export function remember({ text, kind = 'observation', importance = 5, tags = [], source = 'agent' }) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Memory text is empty.');
  if (!MEMORY_KINDS.includes(kind)) throw new Error(`kind must be one of: ${MEMORY_KINDS.join(', ')}.`);
  const entry = {
    id: newId('m'),
    text: t.slice(0, 4000),
    kind,
    importance: Math.max(1, Math.min(10, Math.round(Number(importance) || 5))),
    tags: (Array.isArray(tags) ? tags : []).map(String).slice(0, 10),
    source,
    createdAt: Date.now(),
    lastAccessed: Date.now(),
  };
  appendJsonl(STREAM_FILE, entry);
  maybeTrim();
  return entry;
}

export function allMemories() {
  return readJsonl(STREAM_FILE);
}

let appendsSinceTrim = 0;
/* Past the cap, forget the least important old observations first — never
 * reflections, which are the distilled version of many observations. */
function maybeTrim() {
  if (++appendsSinceTrim < 50) return;
  appendsSinceTrim = 0;
  const rows = allMemories();
  if (rows.length <= MAX_STREAM) return;
  const keep = new Set(
    rows
      .map((r, i) => ({ r, i, keepScore: (r.kind === 'reflection' ? 100 : 0) + r.importance * 2 + i / rows.length }))
      .sort((a, b) => b.keepScore - a.keepScore)
      .slice(0, MAX_STREAM)
      .map((x) => x.i),
  );
  writeJsonl(STREAM_FILE, rows.filter((_, i) => keep.has(i)));
}

const STOP = new Set('a an and are as at be but by for from has have i if in into is it its me my of on or our so that the their them then there these they this to was we were what when which who will with you your'.split(' '));

export function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
}

/* Generative Agents retrieval: score = recency + importance + relevance, each
 * scaled to 0..1. Recency decays by 0.995 per hour since the memory was last
 * used, so things the agent keeps coming back to stay fresh. Relevance is a
 * BM25-flavoured term overlap — enough to rank a few thousand short notes
 * without an embedding model or a second API bill. */
export function recall(query, { limit = 6, kinds = null, touch = true, now = Date.now() } = {}) {
  let rows = allMemories();
  if (kinds?.length) rows = rows.filter((r) => kinds.includes(r.kind));
  if (!rows.length) return [];

  const q = tokenize(query);
  const df = new Map();
  const docs = rows.map((r) => {
    const toks = tokenize(`${r.text} ${(r.tags || []).join(' ')}`);
    for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
    return toks;
  });
  const N = rows.length;
  const avgLen = docs.reduce((a, d) => a + d.length, 0) / N || 1;

  const raw = rows.map((r, i) => {
    let rel = 0;
    if (q.length) {
      const tf = new Map();
      for (const t of docs[i]) tf.set(t, (tf.get(t) || 0) + 1);
      for (const t of q) {
        const f = tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
        rel += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / avgLen));
      }
    }
    const hours = Math.max(0, (now - (r.lastAccessed || r.createdAt)) / 3_600_000);
    return { r, rel, recency: Math.pow(0.995, hours), importance: r.importance / 10 };
  });

  const maxRel = Math.max(...raw.map((x) => x.rel)) || 1;
  const scored = raw
    // With a query, something must actually match; otherwise it is just "recent and important".
    .filter((x) => !q.length || x.rel > 0)
    .map((x) => ({ ...x.r, score: +(x.recency + x.importance + (q.length ? x.rel / maxRel : 0)).toFixed(3) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (touch && scored.length) {
    const ids = new Set(scored.map((s) => s.id));
    const all = allMemories().map((r) => (ids.has(r.id) ? { ...r, lastAccessed: now } : r));
    writeJsonl(STREAM_FILE, all);
  }
  return scored;
}

/* Sum of importance since the last reflection. Generative Agents reflect when
 * this crosses a threshold: enough has happened that it is worth stepping back
 * and asking what it all means. */
export function importanceSinceReflection() {
  const rows = allMemories();
  let sum = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].kind === 'reflection') break;
    sum += rows[i].importance;
  }
  return sum;
}

export function recentMemories(limit = 20) {
  return allMemories().slice(-limit).reverse();
}
