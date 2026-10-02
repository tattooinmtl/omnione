/* The editor's calls to the workspace routes in server/index.js. Every path is
 * relative to the workspace root, with forward slashes. */

async function call(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `status ${r.status}`);
  return j;
}

const post = (url, body) => call(url, { method: 'POST', body: JSON.stringify(body) });

export const ws = {
  info: () => call('/api/workspace'),
  tree: () => call('/api/workspace/tree?limit=5000'),
  read: (path) => call(`/api/workspace/file?path=${encodeURIComponent(path)}`),
  write: (path, content, { overwrite = true } = {}) => call('/api/workspace/file', {
    method: 'PUT', body: JSON.stringify({ path, content, overwrite }),
  }),
  folder: (path) => post('/api/workspace/folder', { path }),
  move: (from, to) => post('/api/workspace/move', { from, to }),
  copy: (from, to) => post('/api/workspace/copy', { from, to }),
  remove: (path) => post('/api/workspace/delete', { path }),
  reveal: (path) => post('/api/workspace/reveal', { path }),
};

/* plan.md always comes first among the tabs. */
export const PLAN_FILE = 'plan.md';
export const isPlanFile = (p) => String(p || '').toLowerCase() === PLAN_FILE;

export function baseName(p) {
  const s = String(p || '');
  return s.slice(s.lastIndexOf('/') + 1);
}

export function dirName(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}

export function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

/* Clean a name or path the user typed: forward slashes, no leading "./" or
 * "/", no "..". The server checks containment again. */
export function cleanPath(input) {
  return String(input || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/');
}

/* Does p sit at or under folder? */
export function isUnder(p, folder) {
  return p === folder || p.startsWith(`${folder}/`);
}

/* Replace the folder prefix of p (after a folder was renamed or moved). */
export function reparent(p, from, to) {
  return p === from ? to : `${to}${p.slice(from.length)}`;
}
