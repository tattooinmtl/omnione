// What a session has let in from outside.
//
// Two questions the permission layer asks about a session:
//   - Has it read outside content (a web page, search results, a forum post,
//     MCP output, a subagent's report)? Then text in its context may have
//     been written by someone else, and memory writes from it are held for
//     the user to review (see mind/held.js) rather than saved.
//   - Which URLs came from the user or a search? Opening one of those is
//     reading, not sending: a URL the agent built itself can carry data out
//     in its query or path, so browser_open asks first (permissions.js).
//
// In memory only. A session resumed after a restart is tainted again by its
// next outside read.

const TAINTING = new Set([
  'browser_open', 'web_search', 'computer_browse', 'computer_view', 'computer_screenshot',
  'forum_read', 'forum_list', 'task',
]);

const tainted = new Map();   // sessionId -> the tool that tainted it
const knownUrls = new Map(); // sessionId -> Set of normalized URLs

export function isTaintingTool(name) {
  return TAINTING.has(name) || String(name).startsWith('mcp__');
}

/* Call after every tool call. */
export function noteToolResult(sessionId, name, r) {
  if (!sessionId || !r?.ok) return;
  if (isTaintingTool(name) && !tainted.has(sessionId)) tainted.set(sessionId, name);
  if (name === 'web_search') noteUrls(sessionId, JSON.stringify(r.result ?? ''));
}

export function taintOf(sessionId) { return tainted.get(sessionId) || null; }
export function isTainted(sessionId) { return tainted.has(sessionId); }

const normalize = (u) => {
  try { const x = new URL(u); x.hash = ''; return x.href; } catch { return null; }
};

/* Remember every http(s) URL in a piece of text (a user message, results). */
export function noteUrls(sessionId, text) {
  if (!sessionId) return;
  let set = knownUrls.get(sessionId);
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s"'<>\)\]]+/g)) {
    const n = normalize(m[0].replace(/[.,;:!?]+$/, ''));
    if (!n) continue;
    if (!set) knownUrls.set(sessionId, (set = new Set()));
    set.add(n);
  }
}

export function isKnownUrl(sessionId, url) {
  const n = normalize(url);
  return !!n && !!knownUrls.get(sessionId)?.has(n);
}

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/* Whether a URL could be carrying data out: a query string, or a path
 * segment that looks like an encoded blob rather than a word or a slug. */
export function urlCarriesData(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.search.length > 1) return true;
  // A slug ("how-to-flash-an-esp32-over-usb") is short words; a blob is one long run.
  return u.pathname.split('/').some((seg) => decode(seg).split(/[-_.\s]+/).some((w) => w.length >= 24));
}

export function clearTaint(sessionId) {
  tainted.delete(sessionId);
  knownUrls.delete(sessionId);
}
