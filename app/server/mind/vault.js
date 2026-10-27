// The memory vault: the memory stream as a folder of linked Markdown notes,
// laid out the way Obsidian expects, so it can be opened there as a vault.
//
//   vault/
//     Omi-One.md            home: topics, latest reflections, counts
//     Memories/<title>.md   one note per memory, its links as [[wiki-links]]
//     Topics/<topic>.md     one note per tag, linking every memory about it
//
// The stream (stream.jsonl) stays the source of truth: recall reads it, and
// every change to it is written out here at once. Edits go the other way
// too. Change a note's text, frontmatter or links in Obsidian and the next
// sync takes them in; write a new note in Memories/ and it becomes a memory.
// Topic notes and the home note are generated and rewritten every time.
//
// A deleted memory note is written back rather than read as "forget this":
// deleting the whole folder must never wipe the memory.

import fs from 'node:fs';
import path from 'node:path';
import { getMindDir, readJson, writeJson } from './store.js';
import {
  allMemories, remember, updateMemory, linkUnlinked, tidyEpisodes, topicsOf, onMemoryChange, MEMORY_KINDS,
} from './memory.js';

const INDEX_FILE = 'vault.json';
const LINKED_HEADING = '## Linked memories';
const SYNC_EVERY_MS = 30_000;

export function vaultDir() { return path.join(getMindDir(), 'vault'); }
const memDir = () => path.join(vaultDir(), 'Memories');
const topicDir = () => path.join(vaultDir(), 'Topics');

// --- index: memory id → the note that holds it --------------------------------

function readIndex() {
  const j = readJson(INDEX_FILE, {});
  return j && typeof j.notes === 'object' && j.notes ? j : { notes: {} };
}
function saveIndex(ix) { writeJson(INDEX_FILE, ix); }

// --- names ------------------------------------------------------------------

/* A note name that Windows, macOS and Obsidian all accept. */
export function safeName(s, max = 60) {
  const t = String(s || '')
    .replace(/[\\/:*?"<>|#^[\]\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (t.length <= max) return t || 'Untitled';
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[. ]+$/, '');
}

/* The full title of a memory: for an episode, what was asked; otherwise
 * its first sentence. Kept whole, in the note's frontmatter. Sentences end
 * at ". " followed by a capital, so "v3.1" and ".gwn-mind" don't end one. */
export function fullTitleOf(m) {
  const asked = /^The user asked: "([\s\S]*?)"\./.exec(m.text || '');
  if (m.kind === 'episode' && asked) return `Asked: ${asked[1].replace(/\s+/g, ' ').trim()}`.slice(0, 200);
  const first = String(m.text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z("'])/)[0];
  return first.slice(0, 200);
}

/* A short label for the neural network view. */
export function titleOf(m) { return safeName(fullTitleOf(m)); }

// Filler that says nothing about what a memory is about.
const SLUG_STOP = new Set(('a an and are as at be but by for from has have i if in into is it its me my of on or our so that the their them then there '
  + 'these they this to was we were what when which who will with you your can could would should do does did just also now yes ok okay im '
  + 'dont not all any how whats hey hi please thx thanks really very about some been being had more most much one only own same than too '
  + 'up out over under again here why where while').split(' '));

/* A note's filename: a short, lowercase slug of what it is about, e.g.
 * "esp32-com5-genuine-d0wd-v3-rev". Assigned once and never changed, so
 * links to it keep working whatever happens to its text or title. */
export function slugOf(m) {
  const words = fullTitleOf(m).replace(/^Asked: /, '')
    .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .split(/[^a-z0-9]+/).filter((w) => w && !SLUG_STOP.has(w));
  const picked = [];
  let len = 0;
  for (const w of words) {
    if (picked.includes(w)) continue;
    if (picked.length >= 6 || len + w.length + 1 > 50) break;
    picked.push(w);
    len += w.length + 1;
  }
  const core = picked.join('-') || `${m.kind}-${String(m.id).slice(-6)}`;
  return m.kind === 'episode' ? `asked-${core}` : core;
}

// Version of the naming scheme. Notes named by an older one are renamed
// once; links are rebuilt from ids, so nothing breaks.
const NAMING = 2;

function claimName(ix, m) {
  if (ix.notes[m.id]?.file) return ix.notes[m.id].file;
  const taken = new Set(Object.values(ix.notes).map((n) => n.file.toLowerCase()));
  const base = slugOf(m);
  let name = base;
  for (let i = 2; taken.has(`${name}.md`.toLowerCase()); i++) name = `${base}-${i}`;
  ix.notes[m.id] = { file: `${name}.md`, writtenAt: 0 };
  return ix.notes[m.id].file;
}

const noteLink = (file, label) => `[[Memories/${file.replace(/\.md$/, '')}|${String(label || file.replace(/\.md$/, '')).replace(/[[\]|]/g, ' ')}]]`;
const topicLink = (t) => `[[Topics/${safeName(t)}|${t}]]`;

// --- writing ------------------------------------------------------------------

export function renderNote(m, nameOf, titleById = () => '') {
  const topics = topicsOf(m);
  const title = JSON.stringify(fullTitleOf(m)); // a YAML double-quoted string
  const fm = [
    '---',
    `id: ${m.id}`,
    `title: ${title}`,
    `aliases: [${title}]`,
    `kind: ${m.kind}`,
    `importance: ${m.importance}`,
    `tags: [${topics.map((t) => t.replace(/[,[\]]/g, ' ').trim()).join(', ')}]`,
    `created: ${new Date(m.createdAt).toISOString()}`,
    `source: ${m.source || 'agent'}`,
    // How often it was actually used: found by a search, or built on by a
    // new memory or a link. Kept by Omi-One; an edit here is ignored.
    `used: ${m.uses || 0}`,
    ...(m.lastUsed ? [`last_used: ${new Date(m.lastUsed).toISOString()}`] : []),
    '---',
  ].join('\n');
  const links = (m.links || []).map((id) => [nameOf(id), titleById(id)]).filter(([f]) => f);
  const linked = links.length ? links.map(([f, t]) => `- ${noteLink(f, t)}`).join('\n') : '_None yet._';
  const about = topics.length ? `\n\nTopics: ${topics.map(topicLink).join(' · ')}` : '';
  return `${fm}\n${m.text.trim()}\n\n${LINKED_HEADING}\n${linked}${about}\n`;
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
  return fs.statSync(file).mtimeMs;
}

function writeNotes(ix, rows, ids) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) claimName(ix, r);
  const nameOf = (id) => ix.notes[id]?.file;
  const titleById = (id) => (byId.has(id) ? titleOf(byId.get(id)) : '');
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) continue;
    ix.notes[id].writtenAt = writeFile(path.join(memDir(), nameOf(id)), renderNote(m, nameOf, titleById));
  }
}

function removeNotes(ix, ids) {
  for (const id of ids) {
    const n = ix.notes[id];
    if (!n) continue;
    try { fs.rmSync(path.join(memDir(), n.file), { force: true }); } catch { /* already gone */ }
    delete ix.notes[id];
  }
}

/* Topic notes and the home note: generated, rewritten whole every time. */
function writeHubs(ix, rows) {
  const byTopic = new Map();
  for (const r of rows) for (const t of topicsOf(r)) {
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t).push(r);
  }
  fs.mkdirSync(topicDir(), { recursive: true });
  const want = new Set();
  for (const [t, ms] of byTopic) {
    const file = `${safeName(t)}.md`;
    want.add(file.toLowerCase());
    const list = ms
      .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)
      .map((m) => `- ${noteLink(ix.notes[m.id].file, titleOf(m))} (${m.kind}, importance ${m.importance}${m.uses ? `, used ${m.uses}×` : ''})`)
      .join('\n');
    writeFile(path.join(topicDir(), file), `---\ntype: topic\n---\n<!-- Written by Omi-One from the memories tagged "${t}". Edits here are overwritten. -->\n\n${list}\n`);
  }
  for (const f of fs.readdirSync(topicDir())) {
    if (f.endsWith('.md') && !want.has(f.toLowerCase())) fs.rmSync(path.join(topicDir(), f), { force: true });
  }

  const reflections = rows.filter((r) => r.kind === 'reflection').slice(-12).reverse();
  const links = rows.reduce((n, r) => n + (r.links || []).length, 0) / 2;
  const topics = [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length);
  const home = [
    '<!-- Written by Omi-One. Edits here are overwritten; edit the notes in Memories/ instead. -->',
    '# Omi-One\'s memory',
    '',
    `${rows.length} memories, ${Math.round(links)} links between them, ${byTopic.size} topics.`,
    '',
    '## How this vault works',
    '',
    '- The memory itself is `.gwn-mind/stream.jsonl`; these notes are written from it, and **regenerated** from it, never merged into. Every note is rewritten whenever its memory changes.',
    '- Edits flow back. Change a note\'s text, its `importance` / `kind` / `tags`, or the links under "Linked memories", and Omi-One takes the change in within a minute. A new note written in Memories/ becomes a new memory. `used`, `title` and `aliases` are Omi-One\'s and are not read back.',
    '- Filenames are short slugs, assigned once and never changed, so links never break. The full title is in each note\'s `title` (and `aliases`, so Obsidian finds it by its title).',
    '- Renaming a note is safe (it is followed by its `id`). Deleting a note does not forget the memory; the note is written back.',
    '',
    '## Topics',
    topics.length ? topics.map(([t, ms]) => `- ${topicLink(t)} (${ms.length})`).join('\n') : '_None yet._',
    '',
    '## Latest reflections',
    reflections.length ? reflections.map((r) => `- ${noteLink(ix.notes[r.id].file, titleOf(r))}`).join('\n') : '_None yet._',
    '',
    '## Most used',
    (() => {
      const used = rows.filter((r) => r.uses > 0).sort((a, b) => b.uses - a.uses).slice(0, 10);
      return used.length ? used.map((r) => `- ${noteLink(ix.notes[r.id].file, titleOf(r))} (${r.uses}×)`).join('\n') : '_Nothing yet._';
    })(),
    '',
  ].join('\n');
  writeFile(path.join(vaultDir(), 'Omi-One.md'), home);
}

// --- reading edits back ----------------------------------------------------------

/* Frontmatter, body text and wiki-link targets of a note. */
export function parseNote(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const fm = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    body = text.slice(m[0].length);
    for (const line of m[1].split('\n')) {
      const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
  }
  const cut = body.indexOf(LINKED_HEADING);
  const own = (cut >= 0 ? body.slice(0, cut) : body).trim();
  const targets = [...body.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)].map((x) => x[1].trim());
  const tags = fm.tags != null
    ? fm.tags.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean)
    : null;
  return { fm, text: own, targets, tags };
}

const linkKey = (target) => target.replace(/\\/g, '/').split('/').pop().replace(/\.md$/i, '').toLowerCase();

/* Take in what was changed in the vault since it was last written. */
function importEdits(ix) {
  if (!fs.existsSync(memDir())) return 0;
  let rows = allMemories();
  const ids = new Set(rows.map((r) => r.id));
  const files = fs.readdirSync(memDir()).filter((f) => f.endsWith('.md'));
  const parsed = new Map();
  const read = (f) => {
    if (!parsed.has(f)) {
      try {
        const full = path.join(memDir(), f);
        parsed.set(f, { ...parseNote(fs.readFileSync(full, 'utf8')), mtimeMs: fs.statSync(full).mtimeMs });
      } catch { parsed.set(f, null); }
    }
    return parsed.get(f);
  };

  // A note renamed in Obsidian keeps its id: follow it to its new name.
  const fileOf = new Map(Object.entries(ix.notes).map(([id, n]) => [n.file.toLowerCase(), id]));
  for (const f of files) {
    if (fileOf.has(f.toLowerCase())) continue;
    const p = read(f);
    const id = p?.fm.id;
    if (id && ids.has(id) && ix.notes[id]) {
      const old = ix.notes[id].file;
      if (!fs.existsSync(path.join(memDir(), old))) {
        fileOf.delete(old.toLowerCase());
        ix.notes[id].file = f;
        fileOf.set(f.toLowerCase(), id);
      }
    }
  }

  let n = 0;
  const fresh = new Set();
  // New notes the user wrote: each one becomes a memory, in its own file.
  for (const f of files) {
    if (fileOf.has(f.toLowerCase())) continue;
    const p = read(f);
    if (!p || !p.text || (p.fm.id && ids.has(p.fm.id))) continue;
    const m = muted(() => remember({
      text: p.text,
      kind: MEMORY_KINDS.includes(p.fm.kind) ? p.fm.kind : 'fact',
      importance: Number(p.fm.importance) || 6,
      tags: p.tags || [],
      source: 'user',
    }));
    ix.notes[m.id] = { file: f, writtenAt: 0 };
    fileOf.set(f.toLowerCase(), m.id);
    ids.add(m.id);
    fresh.add(m.id);
    n += 1;
  }
  rows = allMemories();
  const linksOf = new Map(rows.map((r) => [r.id, r.links || []]));

  // Edited notes. Links are resolved by note name, after renames and new notes.
  const idByName = new Map([...fileOf].map(([f, id]) => [f.replace(/\.md$/, ''), id]));
  for (const [id, note] of Object.entries(ix.notes)) {
    if (!ids.has(id)) continue;
    const p = read(note.file);
    if (!p || !(p.mtimeMs > (note.writtenAt || 0) + 1)) continue;
    const linked = p.targets.map(linkKey).map((k) => idByName.get(k)).filter((x) => x && x !== id);
    if (fresh.has(id)) {
      // Just remembered: keep the links it found itself, add the ones written in it.
      if (linked.length) muted(() => updateMemory(id, { links: [...new Set([...linksOf.get(id), ...linked])] }));
      continue;
    }
    muted(() => updateMemory(id, {
      text: p.text || undefined,
      kind: p.fm.kind,
      importance: p.fm.importance != null ? Number(p.fm.importance) : undefined,
      tags: p.tags ?? undefined,
      links: [...new Set(linked)],
    }));
    note.writtenAt = 0; // write it back in the house style
    n += 1;
  }
  return n;
}

// --- sync -----------------------------------------------------------------------

let quiet = 0;
function muted(fn) { quiet += 1; try { return fn(); } finally { quiet -= 1; } }

let lastSync = 0;
/* Bring vault and stream into line: link old memories, take in edits made in
 * the vault, write every note that is missing or stale, refresh the hubs.
 * Cheap enough to call often; throttled unless forced. Never throws. */
export function syncVault({ force = false, now = Date.now() } = {}) {
  if (!force && now - lastSync < SYNC_EVERY_MS) return null;
  lastSync = now;
  try {
    const ix = readIndex();
    // Old episodes are tidied once; after that an importance set by hand in
    // the vault is the user's call and stays.
    const linked = muted(() => linkUnlinked() + (ix.tidied ? 0 : tidyEpisodes()));
    ix.tidied = true;
    const imported = importEdits(ix);
    const rows = allMemories();
    const live = new Set(rows.map((r) => r.id));
    removeNotes(ix, Object.keys(ix.notes).filter((id) => !live.has(id)));
    // Notes named by an older scheme get today's slugs, once. Edits in them
    // were taken in just above. A note the user wrote keeps its own name.
    const renamed = (ix.naming || 1) < NAMING;
    if (renamed) {
      const byId = new Map(rows.map((r) => [r.id, r]));
      removeNotes(ix, Object.keys(ix.notes).filter((id) => byId.get(id)?.source !== 'user'));
      ix.naming = NAMING;
    }
    for (const r of rows) claimName(ix, r);
    // Linking, an import or a rename can change the links of notes nobody
    // touched, so after any of them, every note is rewritten.
    const all = linked > 0 || imported > 0 || renamed;
    const stale = rows.filter((r) => {
      const n = ix.notes[r.id];
      return all || !n.writtenAt || !fs.existsSync(path.join(memDir(), n.file));
    }).map((r) => r.id);
    writeNotes(ix, rows, stale);
    writeHubs(ix, rows);
    saveIndex(ix);
    return { dir: vaultDir(), memories: rows.length, written: stale.length, imported, linked };
  } catch (e) {
    return { dir: vaultDir(), error: e.message };
  }
}

/* Mirror every change to the stream as it happens. */
let unlisten = null;
export function startVault() {
  if (unlisten) return;
  unlisten = onMemoryChange((ids, removed) => {
    if (quiet) return;
    try {
      const ix = readIndex();
      const rows = allMemories();
      removeNotes(ix, removed);
      writeNotes(ix, rows, ids);
      writeHubs(ix, rows);
      saveIndex(ix);
    } catch { /* the vault is a mirror; memory itself already saved */ }
  });
  syncVault({ force: true });
}

export function stopVault() { unlisten?.(); unlisten = null; lastSync = 0; }

export function vaultStatus() {
  const ix = readIndex();
  return { dir: vaultDir(), notes: Object.keys(ix.notes).length };
}
