// Skills database for OmniOne.
//
// Skills live as folders under <project>/skills/. Each folder contains a
// SKILL.md file with YAML frontmatter (name, description) and a Markdown
// body. The scanner walks the folder, parses every SKILL.md, and exposes
// the catalog via /api/skills. Upload copies the user's file into skills/
// and re-scans; the scan-to-register step fires a 'gwn:skills-changed'
// event the frontend listens to so its list stays live.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const SKILLS_DIR = path.join(PROJECT_ROOT, 'skills');

// Lightweight in-process event bus. The server emits 'gwn:skills-changed'
// after every upload/scan; the React app polls /api/skills on that event.
const listeners = new Set();
export function onSkillsChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) { try { fn(); } catch { /* ignore */ } } }

let cache = null;
let cacheMtime = 0;

function listDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name));
}

function parseFrontmatter(raw) {
  // Tiny YAML-ish parser — supports only the keys we use: name, description.
  // Avoids pulling in a YAML dep.
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

function readSkillFile(skillMdPath) {
  try {
    const raw = fs.readFileSync(skillMdPath, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const dir = path.dirname(skillMdPath);
    const name = meta.name || path.basename(dir);
    return {
      name,
      description: meta.description || '',
      path: dir,
      skillMd: skillMdPath,
      body: body.trim(),
    };
  } catch {
    return null;
  }
}

/* Walk the skills dir and rebuild the index. */
export function scanSkills() {
  const skills = [];
  for (const dir of listDirs(SKILLS_DIR)) {
    // _drafts holds skills the agent proposed that no human has approved.
    // They are inert by construction — never indexed, never loadable — which
    // is the point: an agent that writes its own instructions and then
    // immediately follows them can teach itself a mistake and repeat it.
    if (path.basename(dir) === '_drafts') continue;
    // Two layouts: <skills>/<name>/SKILL.md (preferred) and <skills>/SKILL.md
    // (single-file skills at the top level).
    let s = null;
    const nested = path.join(dir, 'SKILL.md');
    const flat = path.join(SKILLS_DIR, 'SKILL.md');
    if (fs.existsSync(nested)) s = readSkillFile(nested);
    else if (dir === SKILLS_DIR && fs.existsSync(flat)) s = readSkillFile(flat);
    if (s) skills.push(s);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  cache = skills;
  cacheMtime = Date.now();
  return skills;
}

export function getSkills() {
  if (!cache) return scanSkills();
  return cache;
}

export function getSkill(name) {
  return getSkills().find((s) => s.name === name) || null;
}

/* Upload a skill. `sourceDir` is a directory the caller has already staged
 * (typically the result of multer). The folder is copied into skills/<name>
 * and the index is rebuilt.
 */
export function importSkillDir({ name, sourceDir }) {
  if (!name) throw new Error('Skill name required');
  // Allow letters, digits, hyphens, underscores, and dots. Reject path
  // separators, leading dots, and the empty string. The `..` segment is
  // also forbidden so the name can't escape skills/<name>/.
  const cleaned = String(name).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cleaned) || cleaned.includes('..')) {
    throw new Error(`Skill name "${cleaned}" is invalid. Use letters, digits, dots, hyphens, underscores (no leading dot, no "..").`);
  }
  name = cleaned;
  const dest = path.join(SKILLS_DIR, name);
  if (fs.existsSync(dest)) {
    // Replace the existing folder. The user explicitly asked for the
    // skills/ folder to fill up with copies, so overwriting is the intent.
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });
  copyDir(sourceDir, dest);
  scanSkills();
  emit();
  return getSkill(name);
}

/* Copy a directory recursively. */
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

export function deleteSkill(name) {
  const dir = path.join(SKILLS_DIR, name);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  scanSkills();
  emit();
  return true;
}

export function ensureSkillsDir() {
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
}
