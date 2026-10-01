// Cross-session recall.
//
// Session transcripts existed but nothing could read across them: the agent
// could remember the current conversation and nothing before it. That is the
// amnesia problem Hermes Agent's session search addresses — solve something
// on Tuesday, and on Friday the agent has no idea it ever happened.
//
// Full-text search over every transcript in .sessions/, plus a tool to read
// one back. Deliberately plain substring/regex matching over the JSONL rather
// than an index: the corpus is a few hundred files on one machine, scanning
// is milliseconds, and an index is another thing to keep in sync and to
// corrupt. If .sessions/ ever grows past that, SQLite FTS5 is the upgrade.

import fs from 'node:fs';
import path from 'node:path';
import { registerTool } from '../toolRegistry.js';
import {
  SESSIONS_DIR, isValidSessionId, getSession, getMeta, textOf,
} from '../sessions.js';

const MAX_SNIPPET = 240;
const MAX_TRANSCRIPT_CHARS = 20_000;

/* Search every transcript. Returns one hit per session, newest first. */
export function searchSessions(query, { limit = 20, excludeSessionId } = {}) {
  if (!query || String(query).trim().length < 2) {
    throw new Error('Search needs at least 2 characters.');
  }
  const needle = String(query).toLowerCase();
  if (!fs.existsSync(SESSIONS_DIR)) return [];

  const hits = [];
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith('.jsonl')) continue;
    const id = file.replace(/\.jsonl$/, '');
    if (!isValidSessionId(id) || id === excludeSessionId) continue;

    // Same readdir/stat race the session listing had: a transcript deleted
    // mid-scan must be skipped, not thrown.
    let raw;
    let mtimeMs;
    try {
      const full = path.join(SESSIONS_DIR, file);
      mtimeMs = fs.statSync(full).mtimeMs;
      raw = fs.readFileSync(full, 'utf8');
    } catch { continue; }

    const lower = raw.toLowerCase();
    const at = lower.indexOf(needle);
    if (at < 0) continue;

    let meta = null;
    try { meta = getMeta(id); } catch { /* header unreadable */ }

    hits.push({
      sessionId: id,
      title: meta?.title || '(untitled)',
      workspaceRoot: meta?.workspaceRoot || '',
      createdAt: meta?.createdAt || null,
      updatedAt: new Date(mtimeMs).toISOString(),
      matches: countOccurrences(lower, needle),
      snippet: snippetAround(raw, at),
      mtimeMs,
    });
  }

  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hits.slice(0, limit).map(({ mtimeMs, ...rest }) => rest);
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i >= 0 && n < 500) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

/* A readable window around the match. The raw file is JSONL, so trim to the
 * surrounding text rather than handing back half an escaped JSON object. */
function snippetAround(raw, at) {
  const start = Math.max(0, at - MAX_SNIPPET / 2);
  const end = Math.min(raw.length, at + MAX_SNIPPET / 2);
  return raw
    .slice(start, end)
    .replace(/\\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- tools -----------------------------------------------------------------

registerTool({
  name: 'search_memory',
  description: 'Search your own past conversations for something you worked on before — an error you fixed, a decision you made, a file you touched. Use it before re-deriving something you may already have solved.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to look for. Substring match, case-insensitive.' },
      limit: { type: 'integer', description: 'Maximum sessions to return.', default: 10 },
    },
    required: ['query'],
  },
  handler: async ({ query, limit = 10 }, ctx = {}) => {
    let results;
    try {
      // Exclude the current conversation: the model already has it in context
      // and matching itself is pure noise.
      results = searchSessions(query, { limit, excludeSessionId: ctx.sessionId });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    return {
      ok: true,
      result: {
        query,
        count: results.length,
        sessions: results,
        ...(results.length ? { note: 'Read one in full with recall_session.' } : {}),
      },
    };
  },
});

registerTool({
  name: 'recall_session',
  description: 'Read back a past conversation in full, by id, as reported by search_memory.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'The sessionId from search_memory.' },
    },
    required: ['session_id'],
  },
  handler: async ({ session_id: sessionId }) => {
    if (!isValidSessionId(sessionId)) {
      return { ok: false, error: `"${sessionId}" is not a valid session id.` };
    }
    const session = getSession(sessionId);
    if (!session) return { ok: false, error: `No session "${sessionId}".` };

    // Render to plain text: the model does not need the block structure, and
    // the raw shape costs several times the tokens.
    const lines = [];
    let budget = MAX_TRANSCRIPT_CHARS;
    for (const m of session.messages) {
      const text = m.role === 'tool'
        ? (m.content || []).map((b) => `[${b.name} result] ${String(b.text).slice(0, 400)}`).join('\n')
        : textOf(m);
      const toolUses = (m.content || []).filter((b) => b.type === 'tool_use');
      const calls = toolUses.length ? ` [called: ${toolUses.map((b) => b.name).join(', ')}]` : '';
      const line = `${m.role}: ${text}${calls}`.trim();
      if (!line || line === `${m.role}:`) continue;
      if (budget - line.length < 0) { lines.push('…(truncated)'); break; }
      budget -= line.length;
      lines.push(line);
    }

    return {
      ok: true,
      result: {
        sessionId,
        title: session.title || '',
        createdAt: session.createdAt || null,
        messageCount: session.messageCount,
        transcript: lines.join('\n'),
      },
    };
  },
});
