// Session store — the conversation the agent is having.
//
// Before this existed, /api/generate took a bare prompt and built a fresh
// two-message array for every call, so every turn was turn one: the agent
// could not be corrected, could not follow up, and could not remember the
// tool call it made a second earlier.
//
// One JSONL file per session under .sessions/. Append-only, so a crash
// mid-run loses at most the last line, and the transcript doubles as the
// audit log and as the input to the Phase 4 reflection pass.
//
// Messages use a neutral shape; the provider adapters translate it:
//   { role: 'user',      content: [{ type:'text', text }] }
//   { role: 'assistant', content: [{ type:'text', text } | { type:'tool_use', id, name, input }] }
//   { role: 'tool',      content: [{ type:'tool_result', toolUseId, name, text, isError }] }

import { activeProject, projectOfSession } from './projects.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const SESSIONS_DIR = path.join(PROJECT_ROOT, '.sessions');

export function ensureSessionsDir() {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

/* Session ids appear in file paths, so they are generated here and never
 * taken from the client unvalidated. */
export function newSessionId() {
  return `s_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

const ID_RE = /^s_[a-z0-9]+_[0-9a-f]{12}$/;
export function isValidSessionId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function sessionPath(id) {
  if (!isValidSessionId(id)) throw new Error(`Invalid session id "${id}"`);
  return path.join(SESSIONS_DIR, `${id}.jsonl`);
}

export function sessionExists(id) {
  return isValidSessionId(id) && fs.existsSync(sessionPath(id));
}

/* Create a session and write its header record.
 *
 * `workspaceRoot` ties the conversation to the project it was started in, so
 * a later reload of that same project can find its way back to it rather
 * than always starting fresh. Sessions from before this field existed simply
 * have no `workspaceRoot` and are never picked up by the resume lookup. */
export function createSession({
  title = '', provider = '', model = '', workspaceRoot = '',
  // The project the chat belongs to; defaults to the open one (null = general).
  projectId = activeProject()?.id || null,
  // 'subagent' marks a delegated run. Its transcript is kept for audit and
  // for the reflection pass, but it is not a conversation the user had: it
  // must not show in the session list, and it must never be the session a
  // project auto-resumes into.
  sessionKind = 'user',
  parentSessionId = '',
} = {}) {
  ensureSessionsDir();
  const id = newSessionId();
  appendRecord(id, {
    kind: 'meta',
    id,
    title,
    provider,
    model,
    workspaceRoot,
    projectId,
    sessionKind,
    ...(parentSessionId ? { parentSessionId } : {}),
    createdAt: new Date().toISOString(),
  });
  return id;
}

function appendRecord(id, record) {
  ensureSessionsDir();
  fs.appendFileSync(sessionPath(id), JSON.stringify({ ...record, at: record.at || new Date().toISOString() }) + '\n', 'utf8');
}

export function appendMessage(id, message) {
  appendRecord(id, { kind: 'message', message });
  return message;
}

/* Record something that is not part of the model's context but is worth
 * keeping: usage numbers, errors, hook decisions. */
export function appendEvent(id, event) {
  appendRecord(id, { kind: 'event', event });
}

function readRecords(id) {
  if (!sessionExists(id)) return [];
  const raw = fs.readFileSync(sessionPath(id), 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip a torn final line */ }
  }
  return out;
}

/* The message array to send to the model. */
export function getMessages(id) {
  return readRecords(id).filter((r) => r.kind === 'message').map((r) => r.message);
}

export function getMeta(id) {
  const meta = readRecords(id).find((r) => r.kind === 'meta');
  return meta || null;
}

export function getSession(id) {
  if (!sessionExists(id)) return null;
  const records = readRecords(id);
  const meta = records.find((r) => r.kind === 'meta') || { id };
  const messages = records.filter((r) => r.kind === 'message').map((r) => r.message);
  return { ...meta, kind: undefined, messages, messageCount: messages.length };
}

export function listSessions({ limit = 50, includeSubagents = false } = {}) {
  ensureSessionsDir();
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'));
  const rows = [];
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, '');
    if (!isValidSessionId(id)) continue;
    let meta = null;
    let messageCount = 0;
    let firstUserText = '';
    let stat = null;
    // The stat has to be inside the guard too. readdir gives a snapshot, and
    // a session deleted between the listing and the stat raises ENOENT —
    // which used to escape and turn the whole endpoint into a 500 because
    // one row vanished. A disappearing session is a skipped row, not a
    // failed request.
    try {
      for (const r of readRecords(id)) {
        if (r.kind === 'meta') meta = r;
        if (r.kind === 'message') {
          messageCount += 1;
          if (!firstUserText && r.message.role === 'user') {
            firstUserText = textOf(r.message).slice(0, 120);
          }
        }
      }
      stat = fs.statSync(path.join(SESSIONS_DIR, f));
    } catch { continue; }
    // Delegated runs are machinery, not conversations the user had.
    if (!includeSubagents && meta?.sessionKind === 'subagent') continue;
    rows.push({
      id,
      title: meta?.title || firstUserText || '(empty)',
      provider: meta?.provider || '',
      model: meta?.model || '',
      workspaceRoot: meta?.workspaceRoot || '',
      projectId: projectOfSession(meta),
      createdAt: meta?.createdAt || stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
      messageCount,
    });
  }
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return rows.slice(0, limit);
}

/* The chat to reopen for a project (null = general chat): its most recently
 * touched one, never a subagent's. */
export function findLatestSessionForProject(projectId) {
  ensureSessionsDir();
  let bestId = null;
  let bestMtime = -Infinity;
  for (const f of fs.readdirSync(SESSIONS_DIR).filter((x) => x.endsWith('.jsonl'))) {
    const id = f.replace(/\.jsonl$/, '');
    if (!isValidSessionId(id)) continue;
    try {
      const meta = getMeta(id);
      if (!meta || meta.sessionKind === 'subagent') continue;
      if (projectOfSession(meta) !== (projectId || null)) continue;
      const stat = fs.statSync(path.join(SESSIONS_DIR, f));
      if (stat.mtimeMs > bestMtime) { bestMtime = stat.mtimeMs; bestId = id; }
    } catch { continue; }
  }
  return bestId ? getSession(bestId) : null;
}

/* The session to resume when a project is reopened: the most recently
 * touched session whose `workspaceRoot` matches this one. Used so returning
 * to a project auto-continues its last conversation instead of starting a
 * new one, while an explicit "new chat" (no workspaceRoot match needed —
 * the client just stops sending the old id) is left alone. */
export function findLatestSessionForWorkspace(workspaceRoot) {
  if (!workspaceRoot) return null;
  ensureSessionsDir();
  const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'));
  let bestId = null;
  let bestMtime = -Infinity;
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, '');
    if (!isValidSessionId(id)) continue;
    // Same race as listSessions: a session removed between the readdir and
    // the stat must be skipped, not thrown.
    try {
      const meta = getMeta(id);
      if (!meta || meta.workspaceRoot !== workspaceRoot) continue;
      // Never resume into a subagent's transcript — that is not the
      // conversation the user was having.
      if (meta.sessionKind === 'subagent') continue;
      const stat = fs.statSync(path.join(SESSIONS_DIR, f));
      if (stat.mtimeMs > bestMtime) { bestMtime = stat.mtimeMs; bestId = id; }
    } catch { continue; }
  }
  return bestId ? getSession(bestId) : null;
}

export function deleteSession(id) {
  if (!sessionExists(id)) return false;
  fs.rmSync(sessionPath(id));
  releaseSessionRun(id);
  return true;
}

// --- run lock --------------------------------------------------------------
//
// One run at a time per session. The transcript is append-only and the agent
// loop reads it, appends an assistant turn, then appends the matching tool
// results; two runs interleaving those writes produce a transcript where a
// tool_use has no result and a user message lands mid-tool-loop. Both
// providers reject that on the next turn, so the session is bricked rather
// than merely confused. Cheap to prevent, expensive to debug.

const activeRuns = new Set();

export function isSessionBusy(id) {
  return activeRuns.has(id);
}

/* Returns false if a run is already in flight for this session. */
export function acquireSessionRun(id) {
  if (activeRuns.has(id)) return false;
  activeRuns.add(id);
  return true;
}

export function releaseSessionRun(id) {
  activeRuns.delete(id);
}

/* Copy a session so you can branch off an earlier conversation without
 * disturbing the original. */
export function forkSession(id, { upToMessage } = {}) {
  if (!sessionExists(id)) return null;
  const records = readRecords(id);
  const newId = newSessionId();
  const meta = records.find((r) => r.kind === 'meta') || {};
  appendRecord(newId, {
    ...meta,
    kind: 'meta',
    id: newId,
    forkedFrom: id,
    createdAt: new Date().toISOString(),
  });
  let seen = 0;
  for (const r of records) {
    if (r.kind !== 'message') continue;
    if (upToMessage != null && seen >= upToMessage) break;
    appendRecord(newId, r);
    seen += 1;
  }
  return newId;
}

// --- helpers ---------------------------------------------------------------

/* Flatten a neutral message's content blocks to plain text. */
export function textOf(message) {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/* A user turn. Attachments are files already saved into the workspace:
 *   { kind: 'image', path, mediaType, name }   sent to the model as a picture
 *   { kind: 'document', path, name, text }     its extracted text goes along
 *   { kind: 'file', path, name }               only its path is mentioned
 * Pictures are kept as paths; the adapters read them when sending. */
export function userMessage(text, attachments = []) {
  const content = [{ type: 'text', text }];
  for (const a of attachments || []) {
    if (!a?.path) continue;
    if (a.kind === 'image') {
      content.push({ type: 'image', path: a.path, mediaType: a.mediaType, name: a.name });
    } else if (a.kind === 'document' && typeof a.text === 'string') {
      content.push({ type: 'text', text: `[Attached document "${a.name}", saved at ${a.path}]
${a.text}` });
    } else {
      content.push({ type: 'text', text: `[Attached file "${a.name}", saved at ${a.path}]` });
    }
  }
  return { role: 'user', content };
}

export function toolResultMessage(results) {
  return {
    role: 'tool',
    content: results.map((r) => ({
      type: 'tool_result',
      toolUseId: r.toolUseId,
      name: r.name,
      text: r.text,
      isError: Boolean(r.isError),
      ...(r.images?.length ? { images: r.images } : {}),
    })),
  };
}

/* True while any conversation has a run in flight. The heartbeat waits for
 * quiet rather than thinking over the top of the user's own work. */
export function anySessionBusy() {
  return activeRuns.size > 0;
}
