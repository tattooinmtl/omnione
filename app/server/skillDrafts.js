// Skill drafts — the staging area for skills the agent proposes.
//
// Drafts live in skills/_drafts/<name>/, which the skill scanner ignores
// (it only indexes skills/<name>/SKILL.md, and _drafts is filtered out
// explicitly below). Nothing in here is visible to the agent until a human
// approves it, which is the whole design: an agent that writes its own
// instructions and then immediately follows them can teach itself a mistake
// and repeat it forever.
//
// Every draft carries provenance — which session produced it, what evidence
// justified it — so the human approving it can check the reasoning rather
// than just the prose.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSkills, SKILLS_DIR } from './skills.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DRAFTS_DIR = path.join(SKILLS_DIR, '_drafts');
const REJECTED_LOG = path.join(DRAFTS_DIR, '.rejected.jsonl');

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export function ensureDraftsDir() {
  if (!fs.existsSync(DRAFTS_DIR)) fs.mkdirSync(DRAFTS_DIR, { recursive: true });
}

export function isValidDraftName(name) {
  return typeof name === 'string' && NAME_RE.test(name) && !name.includes('..');
}

function draftDir(name) {
  if (!isValidDraftName(name)) throw new Error(`Invalid skill name "${name}". Use lowercase letters, digits and hyphens.`);
  return path.join(DRAFTS_DIR, name);
}

/* Write a proposed skill. Overwrites an existing draft of the same name —
 * a second run that reaches the same conclusion should sharpen the proposal,
 * not pile up near-duplicates. */
export function saveDraft({ name, description, body, provenance = {} }) {
  ensureDraftsDir();
  const dir = draftDir(name);
  fs.mkdirSync(dir, { recursive: true });

  const frontmatter = `---\nname: ${name}\ndescription: ${String(description || '').replace(/\n/g, ' ').trim()}\n---\n\n`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter + String(body || '').trim() + '\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'provenance.json'),
    JSON.stringify({ ...provenance, proposedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
  return getDraft(name);
}

export function listDrafts() {
  ensureDraftsDir();
  const out = [];
  for (const entry of fs.readdirSync(DRAFTS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const d = getDraft(entry.name);
    if (d) out.push(d);
  }
  out.sort((a, b) => String(b.provenance?.proposedAt || '').localeCompare(String(a.provenance?.proposedAt || '')));
  return out;
}

export function getDraft(name) {
  if (!isValidDraftName(name)) return null;
  const dir = path.join(DRAFTS_DIR, name);
  const md = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(md)) return null;
  let raw = '';
  try { raw = fs.readFileSync(md, 'utf8'); } catch { return null; }

  let description = '';
  let body = raw;
  if (raw.startsWith('---')) {
    const end = raw.indexOf('\n---', 3);
    if (end >= 0) {
      const head = raw.slice(3, end);
      const m = head.match(/^\s*description\s*:\s*(.*)$/m);
      if (m) description = m[1].trim();
      body = raw.slice(end + 4).replace(/^\n/, '');
    }
  }

  let provenance = {};
  try { provenance = JSON.parse(fs.readFileSync(path.join(dir, 'provenance.json'), 'utf8')); } catch { /* optional */ }

  return { name, description, body: body.trim(), path: dir, provenance };
}

/* Promote a draft into the live skill set. */
export function approveDraft(name) {
  const draft = getDraft(name);
  if (!draft) return null;
  const dest = path.join(SKILLS_DIR, name);
  if (fs.existsSync(dest)) {
    throw new Error(`A skill named "${name}" already exists. Rename or delete it first.`);
  }
  fs.mkdirSync(dest, { recursive: true });
  copyDir(draft.path, dest);
  fs.rmSync(draft.path, { recursive: true, force: true });
  scanSkills();
  return { name, path: dest };
}

/* Reject a draft, recording why.
 *
 * The rejection log is fed back into the next reflection pass: without it the
 * agent re-proposes the same rejected skill after every session, and the
 * human is stuck saying no to it forever. */
export function rejectDraft(name, reason = '') {
  const draft = getDraft(name);
  if (!draft) return false;
  ensureDraftsDir();
  const record = {
    name,
    description: draft.description,
    reason: String(reason).slice(0, 1000),
    rejectedAt: new Date().toISOString(),
    sessionId: draft.provenance?.sessionId || null,
  };
  try {
    fs.appendFileSync(REJECTED_LOG, JSON.stringify(record) + '\n', 'utf8');
  } catch { /* the removal matters more than the bookkeeping */ }
  fs.rmSync(draft.path, { recursive: true, force: true });
  return true;
}

export function getRejections({ limit = 100 } = {}) {
  if (!fs.existsSync(REJECTED_LOG)) return [];
  const out = [];
  let raw = '';
  try { raw = fs.readFileSync(REJECTED_LOG, 'utf8'); } catch { return []; }
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* torn line */ }
  }
  return out.slice(-limit).reverse();
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
