// Vercel, through its REST API and a personal access token (free to create at
// vercel.com/account/tokens). The token lives in .gwn-secrets.json and is
// only ever used here, on this PC.
//
// Deploying a folder works like the Vercel CLI: hash every file, ask Vercel to
// create the deployment, upload only the files it reports missing, ask again.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getConnection, setConnection } from './secrets.js';

const API = 'https://api.vercel.com';
const TIMEOUT_MS = 60_000;
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Never uploaded: Vercel's own ignore list, plus secrets and OmniOne's files.
const SKIP_DIRS = new Set(['.git', '.hg', '.svn', '.cache', '.next', '.now', '.vercel', 'node_modules', '__pycache__', 'venv', '.venv', '.yarn', '.sessions', '.checkpoints', '.gwn-mind', '.gwn-fixes']);
const SKIP_FILE = /^(\.env(\..*)?|\.DS_Store|npm-debug\.log|\.gwn-.*|.*\.pem|.*\.key|id_rsa.*|\.npmrc)$/i;

export class VercelError extends Error {
  constructor(message, { status, code, missing } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.missing = missing;
  }
}

function auth(override) {
  const c = override || getConnection('vercel');
  if (!c?.token) throw new VercelError('Vercel is not connected. Add a token in Settings → Connections → Vercel.', { code: 'not_connected' });
  return c;
}

/* One API call. `body` may be an object (JSON) or a Buffer (file upload). */
async function call(method, route, { body, headers = {}, query = {}, conn, signal, timeoutMs = TIMEOUT_MS } = {}) {
  const c = auth(conn);
  const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== ''));
  if (c.teamId && !q.has('teamId')) q.set('teamId', c.teamId);
  const url = `${API}${route}${q.toString() ? `?${q}` : ''}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${c.token}`,
        ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('Run cancelled.'), { name: 'AbortError' });
    throw new VercelError(ac.signal.aborted ? `Vercel didn't answer within ${timeoutMs / 1000}s.` : `Can't reach Vercel: ${e.cause?.message || e.message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!resp.ok) {
    const err = data?.error || {};
    const message = resp.status === 401 || resp.status === 403
      ? `Vercel refused the token (${resp.status}${err.message ? `: ${err.message}` : ''}). Check that all of it was copied, that it hasn't expired, and that its scope includes this account or team.`
      : `Vercel ${resp.status}: ${err.message || text.slice(0, 300)}`;
    throw new VercelError(message, { status: resp.status, code: err.code, missing: err.missing });
  }
  return data;
}

// --- connecting -------------------------------------------------------------------

/* Check a token and keep it. Returns who it belongs to and their teams. */
export async function connectVercel({ token, teamId } = {}) {
  const t = String(token || '').trim();
  if (!t) throw new VercelError('Paste a Vercel token.');
  const conn = { token: t, teamId: teamId || undefined };
  const user = await call('GET', '/v2/user', { conn: { token: t } });
  const teams = await call('GET', '/v2/teams', { conn: { token: t }, query: { limit: 50 } }).catch(() => ({ teams: [] }));
  const u = user?.user || user || {};
  setConnection('vercel', { ...conn, user: u.username || u.name || u.email || 'you', connectedAt: Date.now() });
  return { user: u.username || u.name, email: u.email, teams: (teams?.teams || []).map((x) => ({ id: x.id, name: x.name, slug: x.slug })) };
}

export function setVercelTeam(teamId) {
  const c = auth();
  setConnection('vercel', { ...c, teamId: teamId || undefined });
}

export function disconnectVercel() {
  setConnection('vercel', null);
}

/* Safe for the browser: never the token. */
export function vercelStatus() {
  const c = getConnection('vercel');
  if (!c?.token) return { connected: false };
  return { connected: true, user: c.user, teamId: c.teamId || null, tokenHint: `…${c.token.slice(-4)}`, connectedAt: c.connectedAt };
}

export async function listTeams() {
  const r = await call('GET', '/v2/teams', { query: { limit: 50, teamId: '' } });
  return (r?.teams || []).map((x) => ({ id: x.id, name: x.name, slug: x.slug }));
}

// --- reading -------------------------------------------------------------------

export async function listProjects({ search, limit = 20 } = {}, { signal } = {}) {
  const r = await call('GET', '/v10/projects', { query: { search, limit }, signal });
  return (r?.projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    framework: p.framework || null,
    updated: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
    productionUrl: p.targets?.production?.alias?.[0] ? `https://${p.targets.production.alias[0]}` : null,
    latest: p.latestDeployments?.[0] ? { state: p.latestDeployments[0].readyState, url: `https://${p.latestDeployments[0].url}` } : null,
  }));
}

export async function listDeployments({ project, limit = 10, target } = {}, { signal } = {}) {
  const r = await call('GET', '/v6/deployments', { query: { projectId: project, limit, target }, signal });
  return (r?.deployments || []).map(shortDeployment);
}

function shortDeployment(d) {
  return {
    id: d.uid || d.id,
    project: d.name,
    state: d.state || d.readyState,
    target: d.target || 'preview',
    url: d.url ? `https://${d.url}` : null,
    created: d.created || d.createdAt ? new Date(d.created || d.createdAt).toISOString() : null,
    inspector: d.inspectorUrl || null,
    commit: d.meta?.githubCommitMessage ? d.meta.githubCommitMessage.slice(0, 120) : undefined,
  };
}

export async function getDeployment(idOrUrl, { signal } = {}) {
  const id = String(idOrUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const d = await call('GET', `/v13/deployments/${encodeURIComponent(id)}`, { signal });
  return {
    ...shortDeployment(d),
    state: d.readyState,
    error: d.errorMessage || d.errorCode || undefined,
    aliases: (d.alias || []).map((a) => `https://${a}`),
  };
}

/* The build log, newest lines last. `errorsOnly` keeps stderr and errors. */
export async function getBuildLogs(idOrUrl, { limit = 120, errorsOnly = false } = {}, { signal } = {}) {
  const id = String(idOrUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const events = await call('GET', `/v3/deployments/${encodeURIComponent(id)}/events`, { query: { builds: 1, limit: -1, direction: 'forward' }, signal });
  let lines = (Array.isArray(events) ? events : []).map((e) => ({
    type: e.type,
    text: String(e.payload?.text ?? e.text ?? '').trimEnd(),
  })).filter((l) => l.text);
  if (errorsOnly) lines = lines.filter((l) => /stderr|error|fatal|exit/i.test(l.type) || /error|failed|cannot|not found/i.test(l.text));
  return lines.slice(-Math.max(1, Math.min(1000, limit))).map((l) => l.text).join('\n');
}

// --- deploying -------------------------------------------------------------------

/* Every file to upload from a folder: [{ file (posix, relative), abs, sha, size }]. */
export function collectFiles(root) {
  const out = [];
  let total = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) walk(abs);
        continue;
      }
      if (!ent.isFile() || SKIP_FILE.test(ent.name)) continue;
      const size = fs.statSync(abs).size;
      if (size > MAX_FILE_BYTES) throw new VercelError(`${path.relative(root, abs)} is over 50 MB; Vercel won't take it.`);
      total += size;
      if (out.length >= MAX_FILES) throw new VercelError(`More than ${MAX_FILES} files: is node_modules or a build folder in there?`);
      if (total > MAX_TOTAL_BYTES) throw new VercelError('The folder is over 200 MB. Deploy the built site folder instead.');
      out.push({ file: path.relative(root, abs).split(path.sep).join('/'), abs, size });
    }
  };
  walk(root);
  for (const f of out) f.sha = crypto.createHash('sha1').update(fs.readFileSync(f.abs)).digest('hex');
  return out;
}

/* A guess at the framework from package.json, so Vercel builds it right.
 * null = a static site, served as it is. */
export function detectFramework(root) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')); } catch { return null; }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const order = [['next', 'nextjs'], ['@sveltejs/kit', 'sveltekit'], ['nuxt', 'nuxtjs'], ['astro', 'astro'], ['@remix-run/react', 'remix'], ['gatsby', 'gatsby'], ['vite', 'vite'], ['react-scripts', 'create-react-app']];
  for (const [dep, fw] of order) if (deps[dep]) return fw;
  return null;
}

async function projectExists(name, signal) {
  try {
    await call('GET', `/v9/projects/${encodeURIComponent(name)}`, { signal });
    return true;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

/* Deploy a folder. target 'production' or 'preview'. Returns the new
 * deployment (still building: check it with getDeployment). */
export async function deployFolder(root, { project, target = 'preview', framework } = {}, { signal, onProgress } = {}) {
  const name = String(project || path.basename(root)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  if (!name) throw new VercelError('Give the project a name.');
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new VercelError(`${root} is not a folder.`);
  const files = collectFiles(root);
  if (!files.length) throw new VercelError('That folder has nothing to deploy.');

  const exists = await projectExists(name, signal);
  const body = {
    name,
    project: exists ? name : undefined,
    files: files.map(({ file, sha, size }) => ({ file, sha, size })),
    ...(target === 'production' ? { target: 'production' } : {}),
    ...(exists ? {} : { projectSettings: { framework: framework === undefined ? detectFramework(root) : framework } }),
  };

  let uploaded = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const d = await call('POST', '/v13/deployments', { body, query: { skipAutoDetectionConfirmation: 1 }, signal, timeoutMs: 120_000 });
      return { ...shortDeployment(d), state: d.readyState, newProject: !exists, files: files.length, uploaded };
    } catch (e) {
      if (e.code !== 'missing_files' || !Array.isArray(e.missing)) throw e;
      const want = new Set(e.missing);
      const todo = files.filter((f) => want.has(f.sha));
      onProgress?.(`Uploading ${todo.length} file(s)`);
      for (const f of todo) {
        await call('POST', '/v2/files', {
          body: fs.readFileSync(f.abs),
          headers: { 'Content-Type': 'application/octet-stream', 'x-vercel-digest': f.sha, 'Content-Length': String(f.size) },
          signal,
          timeoutMs: 180_000,
        });
        uploaded += 1;
      }
    }
  }
  throw new VercelError('Vercel kept asking for files after uploading them.');
}

export async function redeploy(deploymentId, { target } = {}, { signal } = {}) {
  const d = await getDeployment(deploymentId, { signal });
  const r = await call('POST', '/v13/deployments', {
    body: { name: d.project, deploymentId: d.id, ...(target === 'production' ? { target: 'production' } : {}) },
    query: { forceNew: 1 },
    signal,
  });
  return { ...shortDeployment(r), state: r.readyState };
}

export async function promote(project, deploymentId, { signal } = {}) {
  await call('POST', `/v10/projects/${encodeURIComponent(project)}/promote/${encodeURIComponent(deploymentId)}`, { signal });
  return { promoted: deploymentId, project };
}
