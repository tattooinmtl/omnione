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
//
// Memories are linked, like notes in Obsidian. A new memory links itself to
// the few it is most related to (and an episode to the one before it in the
// same conversation), links are kept both ways, and recall follows them:
// what comes to mind brings its neighbours with it. The whole stream is
// mirrored as a folder of Markdown notes with [[wiki-links]] (vault.js), so
// it can be opened, read and edited in Obsidian.

import { readJson, writeJson, readJsonl, writeJsonl, newId } from './store.js';
import { activeProject, getProjectNotes, setProjectNotes, migrateFromSingleProject } from '../projects.js';
import { fileGoalsUnder } from './state.js';
import { isValidSessionId } from '../sessions.js';

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

export function remember({ text, kind = 'observation', importance = 5, tags = [], source = 'agent', links = [], now = Date.now() }) {
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
    links: [],
    createdAt: now,
    lastAccessed: now,
  };
  const rows = allMemories();
  const ids = new Set(rows.map((r) => r.id));
  const wanted = (Array.isArray(links) ? links : []).map(String).filter((id) => ids.has(id));
  entry.links = [...new Set([...wanted, ...relatedTo(entry, rows)])];
  // Both ways: the memories it links to link back to it.
  const back = new Set(entry.links);
  const next = rows.map((r) => (back.has(r.id) ? { ...r, links: [...new Set([...(r.links || []), entry.id])] } : r));
  next.push(entry);
  writeJsonl(STREAM_FILE, next);
  changed([entry.id, ...entry.links]);
  maybeTrim();
  return entry;
}

/* Which existing memories a new one should link to: the previous episode of
 * the same conversation, and up to three others that share distinctive words
 * with it. Common words ("user", "asked") are in almost every episode and
 * would link everything to everything, so only words found in at most a
 * quarter of the stream count, and two of them must be shared. */
const AUTO_LINKS = 3;
export function relatedTo(entry, rows) {
  const out = [];
  const session = (entry.tags || []).find((t) => isValidSessionId(t));
  if (session && entry.kind === 'episode') {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].id !== entry.id && rows[i].kind === 'episode' && (rows[i].tags || []).includes(session)) { out.push(rows[i].id); break; }
    }
  }
  const others = rows.filter((r) => r.id !== entry.id);
  if (!others.length) return out;
  const q = new Set(tokenize(`${entry.text} ${topicsOf(entry).join(' ')}`));
  const docs = others.map((r) => new Set(tokenize(`${r.text} ${topicsOf(r).join(' ')}`)));
  const df = new Map();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) || 0) + 1);
  const N = others.length;
  const rare = (w) => (df.get(w) || 0) <= Math.max(1, N * 0.25);
  const scored = others.map((r, i) => {
    let score = 0; let shared = 0;
    for (const w of q) {
      if (!docs[i].has(w) || !rare(w)) continue;
      shared += 1;
      score += Math.log(1 + N / (df.get(w) || 1));
    }
    return { id: r.id, score: score / Math.sqrt(1 + docs[i].size / 20), shared };
  }).filter((x) => x.shared >= 2 && !out.includes(x.id));
  scored.sort((a, b) => b.score - a.score);
  return [...out, ...scored.slice(0, AUTO_LINKS).map((x) => x.id)];
}

/* Memories from before links existed have no `links` field: link each to
 * what came before it, as if it had just been remembered. Runs once per
 * memory; returns how many were linked. */
export function linkUnlinked() {
  const rows = allMemories();
  const todo = rows.filter((r) => !Array.isArray(r.links));
  if (!todo.length) return 0;
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) if (!Array.isArray(r.links)) r.links = [];
  rows.forEach((r, i) => {
    if (!todo.includes(r)) return;
    for (const l of relatedTo(r, rows.slice(0, i))) {
      r.links = [...new Set([...r.links, l])];
      const o = byId.get(l);
      o.links = [...new Set([...o.links, r.id])];
    }
  });
  writeJsonl(STREAM_FILE, rows);
  changed(rows.map((r) => r.id));
  return todo.length;
}

/* Link two memories, both ways. */
export function linkMemories(a, b) {
  if (a === b) throw new Error('A memory cannot link to itself.');
  const rows = allMemories();
  const A = rows.find((r) => r.id === a);
  const B = rows.find((r) => r.id === b);
  if (!A || !B) throw new Error(`No memory "${A ? b : a}".`);
  A.links = [...new Set([...(A.links || []), b])];
  B.links = [...new Set([...(B.links || []), a])];
  writeJsonl(STREAM_FILE, rows);
  changed([a, b]);
  return { linked: [a, b] };
}

/* The topics a memory is about: its tags, minus bookkeeping (the session id
 * and the "conversation" label every episode carries). */
export function topicsOf(m) {
  return (m.tags || [])
    .map((t) => String(t).trim().toLowerCase())
    .filter((t) => t && t !== 'conversation' && !isValidSessionId(t) && t.length <= 40);
}

// The vault listens here, so this file never has to import it.
const listeners = new Set();
export function onMemoryChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(ids, removed = []) {
  for (const fn of listeners) { try { fn(ids, removed); } catch { /* a mirror must not break memory */ } }
}

/* Change a memory's text, kind, importance, topics or links — what the user
 * does by editing its note in the vault. Links are kept both ways. */
export function updateMemory(id, patch = {}) {
  const rows = allMemories();
  const m = rows.find((r) => r.id === id);
  if (!m) throw new Error(`No memory "${id}".`);
  if (patch.text != null) {
    const t = String(patch.text).trim();
    if (t) m.text = t.slice(0, 4000);
  }
  if (patch.kind && MEMORY_KINDS.includes(patch.kind)) m.kind = patch.kind;
  if (patch.importance != null) m.importance = Math.max(1, Math.min(10, Math.round(Number(patch.importance) || m.importance)));
  if (Array.isArray(patch.tags)) {
    // Bookkeeping tags are not shown in the note, so an edit cannot drop them.
    const kept = (m.tags || []).filter((t) => !topicsOf({ tags: [t] }).length);
    m.tags = [...new Set([...kept, ...patch.tags.map(String)])].slice(0, 10);
  }
  const touched = [id];
  if (Array.isArray(patch.links)) {
    const ids = new Set(rows.map((r) => r.id));
    const next = new Set(patch.links.filter((l) => l !== id && ids.has(l)));
    const prev = new Set(m.links || []);
    m.links = [...next];
    for (const r of rows) {
      if (r === m) continue;
      const has = (r.links || []).includes(id);
      if (next.has(r.id) && !has) { r.links = [...(r.links || []), id]; touched.push(r.id); }
      if (!next.has(r.id) && prev.has(r.id) && has) { r.links = r.links.filter((l) => l !== id); touched.push(r.id); }
    }
  }
  writeJsonl(STREAM_FILE, rows);
  changed(touched);
  return m;
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
  const kept = rows.filter((_, i) => keep.has(i));
  const ids = new Set(kept.map((r) => r.id));
  const removed = rows.filter((r) => !ids.has(r.id)).map((r) => r.id);
  const dropped = new Set(removed);
  const touched = kept.filter((r) => (r.links || []).some((l) => dropped.has(l))).map((r) => r.id);
  writeJsonl(STREAM_FILE, kept.map((r) => ({ ...r, links: (r.links || []).filter((l) => ids.has(l)) })));
  changed(touched, removed);
}

const STOP = new Set('a an and are as at be but by for from has have i if in into is it its me my of on or our so that the their them then there these they this to was we were what when which who will with you your'.split(' '));

/* Lightly stemmed, so "boards" finds "board" and "flashing" finds "flash".
 * Deliberately crude: no dictionary, just the common English endings. */
export function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function tokenize(s) {
  return String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
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
  const direct = raw
    // With a query, something must actually match; otherwise it is just "recent and important".
    .filter((x) => !q.length || x.rel > 0)
    .map((x) => ({ ...x.r, score: +(x.recency + x.importance + (q.length ? x.rel / maxRel : 0)).toFixed(3) }))
    .sort((a, b) => b.score - a.score);

  // Spreading activation: the best direct matches bring the memories they
  // link to along, at half their strength, even when those share no words
  // with the query. That is what the links are for.
  let scored = direct.slice(0, limit);
  if (q.length && scored.length) {
    const byId = new Map(raw.map((x) => [x.r.id, x]));
    const have = new Set(scored.map((m) => m.id));
    const spread = new Map();
    for (const m of direct.slice(0, Math.max(3, Math.ceil(limit / 2)))) {
      for (const l of m.links || []) {
        const x = byId.get(l);
        if (!x || have.has(l)) continue;
        const s = +(0.5 * m.score + 0.5 * (x.recency + x.importance)).toFixed(3);
        if (!spread.has(l) || spread.get(l).score < s) spread.set(l, { ...x.r, score: s, via: m.id });
      }
    }
    scored = [...scored, ...spread.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    // Association never crowds out the best direct match.
    if (!scored.some((m) => !m.via)) scored = [direct[0], ...scored.slice(0, limit - 1)];
  }

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
