// Projects: separate threads of work, each with its own notes, goals and
// chats, so one project's details don't follow you into every conversation.
//
// Omi-One's core memory used to have a single "project" block, always in the
// prompt: whatever the last big job was (an ESP32 board, say) came up in every
// chat. Now that block belongs to the open project. With no project open the
// chat is general, and no project notes are loaded at all.
//
// Stored in the mind folder (projects.json): the projects, and which is open.

import { readJson, writeJson, newId } from './mind/store.js';

const FILE = 'projects.json';
export const NOTES_LIMIT = 3000;
const MAX_PROJECTS = 50;

function load() {
  const s = readJson(FILE, null);
  return s && Array.isArray(s.projects) ? s : { active: null, projects: [], migrated: false };
}

function save(s) {
  writeJson(FILE, s);
  return s;
}

export class ProjectError extends Error {}

const clean = (name) => String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);

export function listProjects() {
  const s = load();
  return s.projects
    .map((p) => ({ id: p.id, name: p.name, active: p.id === s.active, updatedAt: p.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/* The open project ({id, name, notes}), or null for a general chat. */
export function activeProject() {
  const s = load();
  return s.projects.find((p) => p.id === s.active) || null;
}

/* Find by id, or by name (exact, then starting with, then containing; any case). */
export function findProject(ref) {
  const s = load();
  const r = String(ref || '').trim().toLowerCase();
  if (!r) return null;
  return s.projects.find((p) => p.id === ref)
    || s.projects.find((p) => p.name.toLowerCase() === r)
    || s.projects.find((p) => p.name.toLowerCase().startsWith(r))
    || s.projects.find((p) => p.name.toLowerCase().includes(r))
    || null;
}

export function createProject({ name, notes = '', open = true } = {}) {
  const n = clean(name);
  if (!n) throw new ProjectError('A project needs a name.');
  const s = load();
  if (s.projects.some((p) => p.name.toLowerCase() === n.toLowerCase())) throw new ProjectError(`There is already a project called "${n}".`);
  if (s.projects.length >= MAX_PROJECTS) throw new ProjectError(`There are already ${MAX_PROJECTS} projects. Delete one first.`);
  const p = { id: newId('p'), name: n, notes: String(notes || '').trim().slice(0, NOTES_LIMIT), createdAt: Date.now(), updatedAt: Date.now() };
  s.projects.push(p);
  if (open) s.active = p.id;
  save(s);
  return p;
}

/* Open a project (by id or name), or none (null) for general chat. */
export function switchProject(ref) {
  const s = load();
  if (ref === null || ref === '' || ref === undefined) {
    s.active = null;
    save(s);
    return null;
  }
  const p = findProject(ref);
  if (!p) throw new ProjectError(`No project called "${ref}". Projects: ${s.projects.map((x) => x.name).join(', ') || 'none yet'}.`);
  s.active = p.id;
  const row = s.projects.find((x) => x.id === p.id);
  row.updatedAt = Date.now();
  save(s);
  return row;
}

export function renameProject(ref, name) {
  const n = clean(name);
  if (!n) throw new ProjectError('The new name is empty.');
  const s = load();
  const p = s.projects.find((x) => x.id === findProject(ref)?.id);
  if (!p) throw new ProjectError(`No project called "${ref}".`);
  if (s.projects.some((x) => x.id !== p.id && x.name.toLowerCase() === n.toLowerCase())) throw new ProjectError(`There is already a project called "${n}".`);
  p.name = n;
  p.updatedAt = Date.now();
  save(s);
  return p;
}

/* Remove a project: its notes go; its chats and goals stay (no longer filed). */
export function deleteProject(ref) {
  const s = load();
  const p = findProject(ref);
  if (!p) throw new ProjectError(`No project called "${ref}".`);
  s.projects = s.projects.filter((x) => x.id !== p.id);
  if (s.active === p.id) s.active = null;
  save(s);
  return p;
}

/* Which project a chat belongs to: its own tag, or, for a chat from before
 * projects existed, the project its notes moved into. null = general. */
export function projectOfSession(meta) {
  if (!meta) return null;
  if (meta.projectId !== undefined) return meta.projectId || null;
  const s = load();
  const created = Date.parse(meta.createdAt || '') || 0;
  return s.legacyProject && created < (s.legacyBefore || 0) ? s.legacyProject : null;
}

/* The open project's notes: what core memory's "project" block now is. */
export function getProjectNotes() {
  return activeProject()?.notes || '';
}

export function setProjectNotes(text) {
  const s = load();
  const p = s.projects.find((x) => x.id === s.active);
  if (!p) throw new ProjectError('No project is open, so there are no project notes to change. Create or open one first (project_create / project_switch), or keep general facts in the "human" or "scratch" block.');
  const v = String(text ?? '');
  if (v.length > NOTES_LIMIT) throw new ProjectError(`Project notes would be ${v.length} characters; the limit is ${NOTES_LIMIT}. Condense them.`);
  p.notes = v;
  p.updatedAt = Date.now();
  save(s);
  return p;
}

/**
 * One-time move from the single "project" block: what was in it becomes a
 * project (named after what it's mostly about) and the goals that existed
 * then are filed under it. Chats then start general (no project open). Returns the new project, or null.
 */
export function migrateFromSingleProject({ oldNotes, fileGoals }) {
  const s = load();
  if (s.migrated) return null;
  s.migrated = true;
  const notes = String(oldNotes || '').trim();
  if (!notes || notes === 'No project notes yet.') { save(s); return null; }
  const esp = (notes.match(/esp32/gi) || []).length;
  const first = notes.split('\n').map((l) => l.replace(/^[#*\-\s]+/, '').trim()).find(Boolean) || '';
  let name = esp >= 2 ? 'ESP32' : clean(first.split(/[.:;,(]/)[0]).slice(0, 40) || 'My first project';
  if (s.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) name = `${name} (earlier)`;
  const p = { id: newId('p'), name, notes: notes.slice(0, NOTES_LIMIT), createdAt: Date.now(), updatedAt: Date.now() };
  s.projects.push(p);
  // Not opened: after the move, chats start general; the old work is one
  // switch away. Chats from before projects existed belong to it.
  s.legacyProject = p.id;
  s.legacyBefore = Date.now();
  save(s);
  if (fileGoals) fileGoals(p.id);
  return p;
}
