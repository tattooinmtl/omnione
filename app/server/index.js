// OmniOne — local API proxy.
//
// Runs on http://localhost:5180. The Vite dev server proxies /api/* here so
// the React app can call /api/generate, /api/providers, /api/settings
// without CORS pain.
//
// Stores API keys in <project>/.gwn-secrets.json (mode 0o600). The key never
// leaves this process; the client only ever receives a 4-char hint.

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, providerById } from './providers.js';
import { runAgent } from './agent.js';
import { listProjects, activeProject, createProject, switchProject, renameProject, deleteProject } from './projects.js';
import { publicTools, executeTool, syncMcpTools } from './toolRegistry.js';
import './tools/register.js';
import { killAllJobs } from './tools/shell.js';
import { webSearch, browserOpen } from './tools.js';
import { recentSearches } from './searchLog.js';
import { getWorkspaceRoot, setWorkspaceRoot, resetWorkspaceRoot, isDefaultWorkspace, walkWorkspace } from './workspace.js';
import {
  readFile as readWorkspaceFile, writeFile as writeWorkspaceFile, makeFolder, movePath, copyPath, copyName,
  recyclePath, revealPath, watchWorkspace, workspaceRootChanged,
} from './workspaceFiles.js';
import { pickFolder } from './folderPicker.js';
import { resolveInWorkspace, toWorkspaceRelative } from './workspace.js';
import { imageTypeOf, isDocument, extractDocumentText, safeUploadName } from './attachments.js';
import { serveBuiltUi } from './ui.js';
import { desktopExe, getAutostart, setAutostart, isElevated } from './desktop.js';
import { listFixes, getFix, applyFix, rejectFix, undoFix } from './fixes.js';
import {
  MODES, getMode, setMode, listPending, resolveApproval, cancelPending,
} from './permissions.js';
import {
  listCheckpoints, revertCheckpoint, deleteCheckpoint,
} from './checkpoints.js';
import {
  listDrafts, approveDraft, rejectDraft, getRejections, ensureDraftsDir,
} from './skillDrafts.js';
import { reflectOnSession, isWorthReflecting } from './reflection.js';
import { scanAgents, ensureAgentsDir, getAgents } from './subagent.js';
import {
  ensureSessionsDir,
  createSession,
  getSession,
  listSessions,
  deleteSession,
  forkSession,
  sessionExists,
  findLatestSessionForWorkspace,
  findLatestSessionForProject,
  acquireSessionRun,
  releaseSessionRun,
} from './sessions.js';
import {
  getMcpConfig,
  reloadMcpConfig,
  listMcpTools,
  callMcpTool,
  getClients,
  addServer as addMcpServer,
  removeServer as removeMcpServer,
  setServerDisabled as setMcpServerDisabled,
  testServer as testMcpServer,
  PRESETS as MCP_PRESETS,
  CONFIG_PATH as MCP_CONFIG_PATH,
} from './mcp.js';
import {
  scanHooks,
  getHooks,
  fireHook,
  ensureHooksDir,
  EVENTS as HOOK_EVENTS,
  HOOKS_DIR,
} from './hooks.js';
import {
  getSecrets,
  publicSettings,
  setActiveSettings,
  saveProviderKey,
  clearProviderKey,
  getProviderKey,
  getActiveSettings,
  resolveModel,
  getMaxSteps,
  setMaxSteps,
  STEP_CHOICES,
} from './secrets.js';
import { authMiddleware, ensureToken, TOKEN_HEADER, TOKEN_PATH } from './auth.js';
import { getCore, CORE_LIMITS, recentMemories } from './mind/memory.js';
import { getState as getMindState, currentMood, listGoals, setHeartbeat, resolveProposal } from './mind/state.js';
import { readJournal } from './mind/journal.js';
import { readSoul, writeSoul } from './mind/prompt.js';
import { brainGraph, recordFeel } from './brain.js';
import { subscribeLive, publishLive, originOf } from './live.js';
import { listener as speechListener } from './listen.js';
import { beat, startHeartbeat, heartbeatStatus, onHeartbeatEvent } from './mind/heartbeat.js';
import { synthesizeSpeech } from './tools/media.js';
import { speakingVoice, allPersonalities, sanitizePersonality, PRESETS } from './personality.js';
import { getPrefs, setPrefs } from './prefs.js';
import { cloneVoice } from './tools/create.js';
import { webchatStatus, setWebchat, startWebchat } from './webchat.js';
import { cameraState, setCamera, takePicture, listWebcams, findNetworkCameras, CameraError, ESP32_SIZES, cameraAttachment } from './camera.js';
import { connectVercel, disconnectVercel, vercelStatus, setVercelTeam, listTeams as listVercelTeams, VercelError } from './vercel.js';
import { listSchedules, addSchedule, updateSchedule, removeSchedule, runSchedule, startSchedules, getSchedule } from './schedules.js';
import { publicAccount, startConnect, pollConnect, cancelConnect, refreshAccount, disconnect, syncUsage, CloudError } from './cloud.js';
import { getStats, usageEntries, flushStats, recordUsage } from './stats.js';
import { askBtw, BtwError } from './btw.js';
import {
  scanSkills,
  getSkills,
  getSkill,
  importSkillDir,
  deleteSkill,
  ensureSkillsDir,
  onSkillsChanged,
  PROJECT_ROOT,
  SKILLS_DIR,
} from './skills.js';

const PORT = Number(process.env.PORT) || 5180;
const HOST = process.env.HOST || '127.0.0.1'; // loopback only — see auth.js
const app = express();
// CORS is permissive because the token, not the origin, is what gates access.
// A cross-origin page can send the request but cannot read .gwn-token.
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(authMiddleware);

// Multer is used for skill uploads. Every file in a request lands flat in one
// per-request temp dir under a random name; the handler rebuilds the folder
// tree from `originalname` after validating each path. Storing files under
// `originalname` directly would be wrong twice over: it carries '/' separators
// from the directory picker (invalid as a filename on Windows), and it is
// attacker-controlled, so '../../..' segments could escape the staging dir.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      if (!req._gwnUploadDir) {
        req._gwnUploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gwn-upload-'));
      }
      cb(null, req._gwnUploadDir);
    },
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 200 },
});

/* Turn a browser-supplied `originalname` into a relative path that is safe to
 * join onto a staging root, or null if it isn't one.
 *
 * webkitdirectory sends paths like "my-skill/lib/foo.js" — the first segment
 * is the picked folder and gets dropped, since the destination folder name
 * comes from the validated `name` field instead. */
export function safeRelativePath(originalname) {
  const raw = String(originalname || '').replace(/\\/g, '/').trim();
  if (!raw) return null;
  const slash = raw.indexOf('/');
  const withoutRoot = slash >= 0 ? raw.slice(slash + 1) : raw;
  if (!withoutRoot) return null;
  // Reject absolute paths, drive letters, and UNC paths before normalizing.
  if (withoutRoot.startsWith('/') || /^[A-Za-z]:/.test(withoutRoot)) return null;
  const normalized = path.normalize(withoutRoot);
  if (!normalized || normalized === '.' || path.isAbsolute(normalized)) return null;
  // path.normalize collapses "a/../b" but leaves a leading "../" in place,
  // which is exactly the case we must refuse.
  if (normalized.split(/[\\/]/).some((seg) => seg === '..')) return null;
  return normalized;
}

// Boot: ensure the skills/ folder exists and the index is warm.
ensureSkillsDir();
scanSkills();
ensureHooksDir();
scanHooks();
ensureSessionsDir();
ensureDraftsDir();
ensureAgentsDir();
scanAgents();

// --- health ----------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// --- provider catalog ------------------------------------------------------
app.get('/api/providers', (_req, res) => {
  // Augment each provider with whether the user has saved a key for it.
  const s = getSecrets();
  const providers = PROVIDERS.map((p) => {
    const row = s.providers?.[p.id] || {};
    return {
      ...p,
      hasOwnKey: Boolean(row.apiKey),
      keyHint: row.apiKey ? `…${String(row.apiKey).slice(-4)}` : null,
    };
  });
  res.json({ providers });
});

// --- settings --------------------------------------------------------------
// Steps per task (Settings → AI): how long Omi-One may work on one task
// before it stops, sums up and offers to continue.
app.get('/api/settings/steps', (_req, res) => res.json({ maxSteps: getMaxSteps(), choices: STEP_CHOICES }));
app.post('/api/settings/steps', (req, res) => {
  try { res.json({ maxSteps: setMaxSteps(req.body?.maxSteps), choices: STEP_CHOICES }); } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/settings', (_req, res) => {
  res.json(publicSettings());
});

app.post('/api/settings', (req, res) => {
  const { provider, model, apiKey } = req.body || {};
  if (!provider || !providerById(provider)) {
    return res.status(400).json({ error: `Unknown provider "${provider}"` });
  }
  setActiveSettings({ provider, model: model || '' });
  let next = { provider, model: model || '' };
  if (apiKey != null && apiKey !== '') {
    if (provider === 'gwn-local') {
      return res.status(400).json({ error: 'OmniOne Local does not use an API key.' });
    }
    saveProviderKey(provider, { apiKey, model: model || undefined });
    next.hasOwnKey = true;
    next.keyHint = `…${String(apiKey).slice(-4)}`;
  } else if (apiKey === '') {
    clearProviderKey(provider);
  }
  res.json({ ...publicSettings(), ...next });
});

// --- tools -----------------------------------------------------------------
app.get('/api/tools', async (_req, res) => {
  // Include MCP tools so the catalog matches what the agent can actually call.
  try { await syncMcpTools(); } catch { /* MCP is optional */ }
  res.json({ tools: publicTools() });
});

/* Run a tool directly.
 *
 * Deliberately not behind the approval gate: this endpoint is the *user*
 * invoking a tool themselves, authenticated with the token, not the model
 * asking to. The gate exists to put a human between the model and a
 * destructive action, and there is already a human here. Workspace
 * containment still applies — the tools enforce that themselves. */
app.post('/api/tools/run', async (req, res) => {
  const { name, args } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  // MCP tools are loaded when a chat run starts; load them here too.
  if (String(name).startsWith('mcp__')) { try { await syncMcpTools(); } catch { /* reported by the call */ } }
  const r = await executeTool(name, args || {});
  res.json(r);
});

app.post('/api/tools/web-search', async (req, res) => {
  const { q, max } = req.body || {};
  res.json(await webSearch({ q, max }));
});

/* The search log. It was being written with nothing able to read it back. */
app.get('/api/tools/searches', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  res.json({ searches: recentSearches(limit) });
});

app.post('/api/tools/browser-open', async (req, res) => {
  const { url, maxChars } = req.body || {};
  res.json(await browserOpen({ url, maxChars }));
});

// --- MCP -------------------------------------------------------------------
app.get('/api/mcp/config', (_req, res) => {
  res.json({ path: MCP_CONFIG_PATH, config: getMcpConfig() });
});

app.post('/api/mcp/reload', (_req, res) => {
  res.json({ config: reloadMcpConfig() });
});

app.get('/api/mcp/servers', (_req, res) => {
  res.json({
    servers: getClients(),
    presets: Object.entries(MCP_PRESETS).map(([id, p]) => ({ id, label: p.label, ...p.def })),
  });
});

// Settings → Connections: add (or replace) a server, then try to connect so
// the answer says at once whether it works.
app.post('/api/mcp/servers', async (req, res) => {
  const { name, preset, ...def } = req.body || {};
  try {
    const usePreset = preset ? MCP_PRESETS[preset] : null;
    if (preset && !usePreset) return res.status(400).json({ error: `No preset "${preset}".` });
    const serverName = name || preset;
    addMcpServer(serverName, usePreset ? usePreset.def : def);
    let test = null;
    try { test = { ok: true, ...(await testMcpServer(serverName)) }; } catch (e) { test = { ok: false, error: e.message }; }
    res.json({ name: serverName, test, servers: getClients() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.post('/api/mcp/servers/:name/test', async (req, res) => {
  try { res.json({ ok: true, ...(await testMcpServer(req.params.name)), servers: getClients() }); } catch (e) { res.json({ ok: false, error: e.message, servers: getClients() }); }
});
app.post('/api/mcp/servers/:name/enabled', (req, res) => {
  try { setMcpServerDisabled(req.params.name, !req.body?.enabled); res.json({ servers: getClients() }); } catch (e) { res.status(404).json({ error: e.message }); }
});
app.delete('/api/mcp/servers/:name', (req, res) => {
  try { removeMcpServer(req.params.name); res.json({ servers: getClients() }); } catch (e) { res.status(404).json({ error: e.message }); }
});

app.get('/api/mcp/tools', async (_req, res) => {
  try {
    const tools = await listMcpTools();
    res.json({ tools });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/mcp/call', async (req, res) => {
  const { server, name, args } = req.body || {};
  if (!server || !name) return res.status(400).json({ error: 'server and name are required' });
  try {
    const r = await callMcpTool({ server, name, args });
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- hooks -----------------------------------------------------------------
app.get('/api/hooks', (_req, res) => {
  res.json({ events: HOOK_EVENTS, hooks: getHooks() });
});

app.post('/api/hooks/scan', (_req, res) => {
  const hooks = scanHooks();
  res.json({ hooks });
});

// Fire a hook event. Used by the AI flow (UserPromptSubmit fires before
// generation, PreToolUse fires before a tool call, PostToolUse fires after).
// Body: { event, payload }.
app.post('/api/hooks/fire', async (req, res) => {
  const { event, payload } = req.body || {};
  if (!HOOK_EVENTS.includes(event)) {
    return res.status(400).json({ error: `Unknown event "${event}". Valid: ${HOOK_EVENTS.join(', ')}` });
  }
  try {
    const r = await fireHook({ event, payload: payload || {} });
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- workspace -------------------------------------------------------------
// The one folder Omi-One's file tools can see and change. Set in Settings.
app.get('/api/workspace', (_req, res) => {
  res.json({ root: getWorkspaceRoot(), isDefault: isDefaultWorkspace() });
});

app.post('/api/workspace', (req, res) => {
  try {
    const root = req.body?.reset ? resetWorkspaceRoot() : setWorkspaceRoot(req.body?.root);
    workspaceRootChanged();
    res.json({ root, isDefault: isDefaultWorkspace() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- Doctor & fixes ------------------------------------------------------------
// Omi-One prepares fixes (propose_fix); only these routes, called from the
// page when the user presses a button, change anything.
app.get('/api/fixes', (_req, res) => res.json({ fixes: listFixes() }));

app.post('/api/fixes/:id/:action', async (req, res) => {
  const { id, action } = req.params;
  if (!getFix(id)) return res.status(404).json({ error: 'No such fix.' });
  try {
    const fn = { apply: applyFix, reject: rejectFix, undo: undoFix }[action];
    if (!fn) return res.status(404).json({ error: 'Unknown action.' });
    res.json({ fix: await fn(id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- the desktop app ------------------------------------------------------------
app.get('/api/app', async (_req, res) => {
  res.json({
    desktop: Boolean(desktopExe()),
    version: (() => { try { return JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')).version; } catch { return ''; } })(),
    platform: process.platform,
  });
});

app.get('/api/app/autostart', async (_req, res) => {
  try { res.json(await getAutostart()); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/app/autostart', async (req, res) => {
  try { res.json(await setAutostart(Boolean(req.body?.enabled))); } catch (e) { res.status(400).json({ error: e.message }); }
});

/* Opens Windows' own "choose a folder" dialog on this PC. Only picks: the
 * page saves the choice with POST /api/workspace. */
app.post('/api/workspace/browse', async (_req, res) => {
  try {
    res.json({ root: await pickFolder(getWorkspaceRoot()) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* The file tree the editor renders. Ignored paths are omitted, matching what
 * the agent can see. */
app.get('/api/workspace/tree', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 5000, 20000);
  const entries = [];
  try {
    for (const e of walkWorkspace(req.query.path || '.', { maxEntries: limit })) {
      entries.push({ path: e.relPath, type: e.isDir ? 'dir' : 'file' });
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  res.json({ root: getWorkspaceRoot(), count: entries.length, entries });
});

// The editor's file actions (server/workspaceFiles.js). Paths are relative to
// the workspace and can't leave it.
const fileRoute = (fn) => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (e) {
    res.status(e?.name === 'WorkspaceError' ? 400 : 500).json({ error: e.message });
  }
};
app.get('/api/workspace/file', fileRoute((req) => readWorkspaceFile(String(req.query.path || ''))));
app.put('/api/workspace/file', fileRoute((req) => writeWorkspaceFile(req.body?.path, req.body?.content, { overwrite: req.body?.overwrite !== false })));
app.post('/api/workspace/folder', fileRoute((req) => makeFolder(req.body?.path)));
app.post('/api/workspace/move', fileRoute((req) => movePath(req.body?.from, req.body?.to)));
app.post('/api/workspace/copy', fileRoute((req) => copyPath(req.body?.from, req.body?.to || copyName(req.body?.from))));
app.post('/api/workspace/delete', fileRoute((req) => recyclePath(req.body?.path)));
app.post('/api/workspace/reveal', fileRoute((req) => revealPath(req.body?.path || '.')));

/* Live changes in the workspace (the agent writing, a build, another editor),
 * so open tabs and the file list stay the real files. */
app.get('/api/workspace/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  send({ type: 'hello', root: getWorkspaceRoot() });
  const stop = watchWorkspace(send);
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 25_000);
  res.on('close', () => { clearInterval(ping); stop(); });
});

// --- permissions -----------------------------------------------------------
app.get('/api/permissions/mode', (req, res) => {
  const sessionId = req.query.sessionId;
  res.json({ modes: MODES, mode: getMode(sessionId), sessionId: sessionId || null });
});

app.post('/api/permissions/mode', (req, res) => {
  const { sessionId, mode } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  try {
    res.json({ sessionId, mode: setMode(sessionId, mode) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/approvals', (req, res) => {
  res.json({ pending: listPending(req.query.sessionId) });
});

/* The browser answers an approval request here; the paused agent run
 * resumes. `decision` is once | session | deny. */
app.post('/api/approvals/:id', (req, res) => {
  const decision = req.body?.decision;
  if (!['once', 'session', 'deny'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be one of: once, session, deny' });
  }
  if (!resolveApproval(req.params.id, decision)) {
    return res.status(404).json({ error: `No pending approval "${req.params.id}" (it may have timed out).` });
  }
  res.json({ ok: true, id: req.params.id, decision });
});

// --- checkpoints -----------------------------------------------------------
app.get('/api/checkpoints', (req, res) => {
  res.json({ checkpoints: listCheckpoints({ sessionId: req.query.sessionId }) });
});

app.post('/api/checkpoints/:id/revert', (req, res) => {
  const r = revertCheckpoint(req.params.id);
  if (!r) return res.status(404).json({ error: `No checkpoint "${req.params.id}"` });
  res.json({ ok: true, ...r });
});

app.delete('/api/checkpoints/:id', (req, res) => {
  if (!deleteCheckpoint(req.params.id)) {
    return res.status(404).json({ error: `No checkpoint "${req.params.id}"` });
  }
  res.json({ ok: true });
});

// --- sessions --------------------------------------------------------------
app.get('/api/sessions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  let sessions = listSessions({ limit: req.query.project ? 500 : limit });
  // ?project=current: only the open project's chats (or the general ones).
  if (req.query.project === 'current') {
    const pid = activeProject()?.id || null;
    sessions = sessions.filter((x) => x.projectId === pid).slice(0, limit);
  }
  res.json({ sessions });
});

/* The session to reopen for the current workspace, if any — the client calls
 * this once on load so returning to a project resumes its last conversation
 * automatically. Starting a new chat is a purely client-side choice (it just
 * stops sending the old session id); this endpoint never forces a session on
 * the client, it only offers the most recent one for this project. */
app.get('/api/sessions/resume', (_req, res) => {
  res.json({ session: findLatestSessionForProject(activeProject()?.id || null) });
});

// --- projects ---------------------------------------------------------------------
// Separate threads of work, each with its own notes, goals and chats.
app.get('/api/projects', (_req, res) => {
  res.json({ projects: listProjects(), active: activeProject()?.id || null });
});

app.post('/api/projects', (req, res) => {
  try {
    const p = createProject({ name: req.body?.name, notes: req.body?.notes || '', open: req.body?.open !== false });
    res.json({ project: { id: p.id, name: p.name }, projects: listProjects(), active: activeProject()?.id || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/projects/switch', (req, res) => {
  try {
    switchProject(req.body?.id ?? null);
    res.json({ projects: listProjects(), active: activeProject()?.id || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/projects/:id/rename', (req, res) => {
  try {
    renameProject(req.params.id, req.body?.name);
    res.json({ projects: listProjects(), active: activeProject()?.id || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    deleteProject(req.params.id);
    res.json({ projects: listProjects(), active: activeProject()?.id || null });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/sessions', (req, res) => {
  const active = getActiveSettings();
  const provider = providerById(active.provider);
  const id = createSession({
    title: (req.body?.title || '').slice(0, 200),
    provider: active.provider,
    model: provider ? resolveModel(provider.id, provider.defaultModel) : '',
    workspaceRoot: getWorkspaceRoot(),
  });
  res.json({ id, session: getSession(id) });
});

app.get('/api/sessions/:id', (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: `Session "${req.params.id}" not found` });
  res.json({ session: s });
});

app.delete('/api/sessions/:id', (req, res) => {
  if (!deleteSession(req.params.id)) {
    return res.status(404).json({ error: `Session "${req.params.id}" not found` });
  }
  res.json({ ok: true });
});

app.post('/api/sessions/:id/fork', (req, res) => {
  const upTo = req.body?.upToMessage;
  const id = forkSession(req.params.id, { upToMessage: upTo == null ? undefined : Number(upTo) });
  if (!id) return res.status(404).json({ error: `Session "${req.params.id}" not found` });
  res.json({ id, session: getSession(id) });
});

// --- generate --------------------------------------------------------------
// Streams SSE: data: {json}\n\n  — the shape the React client parses.
//
// This drives the full agent loop (server/agent.js): the model may call
// tools, see their results, and call again, for up to `maxIterations` turns.
// The conversation is persisted per session, so a follow-up prompt continues
// where the last one left off.
//
// Hooks fire around the run:
//   UserPromptSubmit — before the first model call, can rewrite the prompt
//   PreToolUse       — before each tool call, can rewrite args or block
//   PostToolUse      — after each tool call
// /btw: a quick side question. One model call, no tools, nothing saved to
// the conversation, and it doesn't wait for (or disturb) a run in progress.
app.post('/api/btw', async (req, res) => {
  const { question, sessionId } = req.body || {};
  const active = getActiveSettings();
  const provider = providerById(active.provider);
  if (!provider) return res.status(400).json({ error: `Unknown provider "${active.provider}"` });
  const model = resolveModel(provider.id, provider.defaultModel);
  const apiKey = getProviderKey(provider.id);
  if (provider.apiStyle !== 'stub' && !apiKey) {
    return res.status(400).json({ error: `No API key saved for ${provider.label}. Open Settings and add one.` });
  }
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    const { answer, usage } = await askBtw({ question, sessionId: typeof sessionId === 'string' ? sessionId : null, provider, model, apiKey, signal: ac.signal });
    if (usage) recordUsage({ provider: provider.id, model, usage, kind: 'btw' });
    res.json({ answer });
  } catch (e) {
    if (ac.signal.aborted) return;
    res.status(e instanceof BtwError ? e.status : 500).json({ error: e.message || 'The side question failed.' });
  }
});

// --- attachments -------------------------------------------------------------

// Files dropped or pasted into the chat. They are saved into the workspace's
// attachments/ folder, so Omi-One can open them again later with read_file or
// view_image, and so the user can find them. The chat shrinks pictures before
// sending, so the 25 MB cap is mostly for PDFs and spreadsheets.
const attachUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
});

app.post('/api/attachments', (req, res) => {
  attachUpload.array('files', 10)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is over 25 MB.' : err.message });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'No files received.' });
    const dir = path.join(getWorkspaceRoot(), 'attachments');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const saved = files.map((f) => {
      const name = safeUploadName(f.originalname);
      let file = path.join(dir, `${stamp}-${name}`);
      for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stamp}-${n}-${name}`);
      fs.writeFileSync(file, f.buffer);
      return { name: f.originalname, path: toWorkspaceRelative(file), size: f.size, kind: attachmentKind(file) };
    });
    res.json({ files: saved });
  });
});

function attachmentKind(file) {
  if (imageTypeOf(file)) return 'image';
  if (isDocument(file)) return 'document';
  return 'file';
}

/* The attachments a /api/generate request names, checked and made ready for
 * the user message: workspace paths only, pictures by path, documents read. */
async function resolveAttachments(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list.slice(0, 10) : []) {
    const rel = typeof a === 'string' ? a : a?.path;
    if (!rel) continue;
    let abs;
    try { abs = resolveInWorkspace(rel); } catch { continue; }
    if (!fs.existsSync(abs)) continue;
    const name = (typeof a === 'object' && a.name) || path.basename(abs);
    const kind = attachmentKind(abs);
    if (kind === 'image') out.push({ kind, path: abs, mediaType: imageTypeOf(abs), name });
    else if (kind === 'document') {
      let text;
      try { text = await extractDocumentText(abs); } catch (e) { text = `(Couldn't read it: ${e.message})`; }
      out.push({ kind, path: toWorkspaceRelative(abs), name, text });
    } else out.push({ kind, path: toWorkspaceRelative(abs), name });
  }
  return out;
}

app.post('/api/generate', async (req, res) => {
  let { prompt, currentCode, sessionId, maxIterations } = req.body || {};
  let attachments = [];
  try { attachments = await resolveAttachments(req.body?.attachments); } catch { attachments = []; }
  // The live camera: while it's on, every message takes one picture with it.
  const cam = await cameraAttachment();
  if (cam) attachments.push(cam);
  // A message can be only an attachment: "what's in this picture?" is implied.
  if ((!prompt || typeof prompt !== 'string' || !prompt.trim()) && attachments.length) {
    prompt = 'Have a look at what I attached.';
  }
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Missing `prompt`.' });
  }

  const active = getActiveSettings();
  const provider = providerById(active.provider);
  if (!provider) {
    return res.status(400).json({ error: `Unknown provider "${active.provider}"` });
  }
  const model = resolveModel(provider.id, provider.defaultModel);
  const apiKey = getProviderKey(provider.id);

  if (provider.apiStyle !== 'stub' && !apiKey) {
    return res.status(400).json({ error: `No API key saved for ${provider.label}. Open ⚙ Settings and add one.` });
  }

  // An unknown or absent session id starts a new conversation rather than
  // failing — the client should not have to create one before its first turn.
  if (!sessionId || !sessionExists(sessionId)) {
    sessionId = createSession({
      title: prompt.slice(0, 120),
      provider: provider.id,
      model,
      workspaceRoot: getWorkspaceRoot(),
    });
  }

  // One run at a time per session — see the run lock in sessions.js. This is
  // rejected before the stream opens so the client gets a real status code.
  if (!acquireSessionRun(sessionId)) {
    return res.status(409).json({
      error: 'That conversation already has a run in progress. Wait for it to finish, or stop it first.',
      sessionId,
    });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Every event also goes to the live channel, so the other windows (the
  // Presence widget, the emotion and neural windows) see this run too.
  const origin = originOf(req);
  const send = (ev) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    publishLive(ev, origin);
  };
  publishLive({ type: 'user_prompt', text: prompt, sessionId }, origin);

  // Abort the run when the client goes away.
  //
  // This must listen on `res`, not `req`: on Node 18+, IncomingMessage emits
  // 'close' as soon as the request *body* has been fully read, which for a
  // POST is immediately. Listening on req aborted every run before the first
  // model call — the stream ended after the `session` event with no error,
  // because the loop checks `signal.aborted` and returns quietly.
  const ac = new AbortController();
  let finished = false;
  res.on('close', () => {
    if (finished) return;
    ac.abort();
    // Drop any approval prompt still on screen: a decision made after the
    // run died would authorize a call nobody is waiting on.
    cancelPending(sessionId);
  });

  // Tell the client which session this turn belongs to, so it can send the
  // same id next time.
  send({ type: 'session', sessionId, provider: provider.id, model });

  // Everything past the lock acquisition runs inside try/finally, so no exit
  // path — a hook rejection, a thrown adapter, a client disconnect — can
  // leave the session permanently marked busy.
  try {
    // UserPromptSubmit hooks may rewrite the prompt or reject the request.
    let rejected = false;
    try {
      const ups = await fireHook({
        event: 'UserPromptSubmit',
        payload: { prompt, currentCode, provider: provider.id, model, sessionId },
      });
      for (const r of ups.results) {
        if (!r.ok) {
          send({ type: 'error', message: `UserPromptSubmit hook "${r.hook}" rejected: ${r.error}` });
          rejected = true;
          break;
        }
        if (typeof r.result?.prompt === 'string') prompt = r.result.prompt;
        if (typeof r.result?.currentCode === 'string') currentCode = r.result.currentCode;
      }
    } catch (e) {
      // Hooks are best-effort; a broken one must not block the run.
      send({ type: 'step', step: { id: 'hook', label: `Hook error: ${e.message}`, status: 'error' } });
    }

    if (!rejected) {
      // The request may ask for fewer; otherwise the user's setting (Settings → AI).
      const cap = Number(maxIterations) > 0
        ? Math.min(Number(maxIterations), 500)
        : getMaxSteps();
      for await (const ev of runAgent({
        sessionId,
        prompt,
        currentCode,
        provider,
        model,
        apiKey,
        signal: ac.signal,
        maxIterations: cap,
        attachments,
      })) {
        send(ev);
      }
    }
  } catch (e) {
    if (e?.name !== 'AbortError') send({ type: 'error', message: e?.message || String(e) });
  } finally {
    releaseSessionRun(sessionId);
    cancelPending(sessionId);
    finished = true;
    res.end();
  }

  // Self-evolution: look back over what just happened and propose skills.
  //
  // After res.end(), so it never delays the user's answer, and only for runs
  // that did real work (>= 6 tool calls, once per session) — a short chat has
  // nothing to teach. Costs one extra model call on a substantial session.
  // Set GWN_AUTO_REFLECT=0 to turn it off; output is inert either way, since
  // drafts are not loadable until a human approves them.
  if (process.env.GWN_AUTO_REFLECT !== '0' && !ac.signal.aborted) {
    const verdict = isWorthReflecting(sessionId);
    if (verdict.worth) {
      reflectOnSession({
        sessionId,
        provider,
        model,
        apiKey,
      })
        .then((drafts) => {
          if (drafts.length) {
            console.log(`[omnione] reflection proposed ${drafts.length} skill draft(s) from ${sessionId}`);
            notifySkillsChanged();
          }
        })
        .catch((e) => console.error('[omnione] reflection failed:', e.message));
    }
  }
});

// --- skills ----------------------------------------------------------------

// Lightweight SSE channel so the React app learns when the skills folder
// changed (upload, delete, scan). Same shape as /api/generate events.
const sseClients = new Set();

/* Push a skills-changed event. A function declaration so the reflection
 * callback above — which runs long after module init, but is written earlier
 * in the file — can call it. */
function notifySkillsChanged() {
  const ev = { type: 'changed', count: getSkills().length, drafts: listDrafts().length };
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const r of sseClients) {
    try { r.write(payload); } catch { /* client gone */ }
  }
  for (const fn of skillsStreamSubs) {
    try { fn(ev); } catch { /* client gone */ }
  }
}
const skillsStreamSubs = new Set();

app.get('/api/skills/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(`data: ${JSON.stringify({ type: 'hello', count: getSkills().length })}\n\n`);
  sseClients.add(res);
  const ka = setInterval(() => res.write(`: keep-alive ${Date.now()}\n\n`), 15000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
});

onSkillsChanged(() => {
  const payload = `data: ${JSON.stringify({ type: 'changed', count: getSkills().length })}\n\n`;
  for (const r of sseClients) { try { r.write(payload); } catch { /* ignore */ } }
});

app.get('/api/skills', (_req, res) => {
  res.json({ skills: getSkills().map(publicSkill) });
});

// --- skill drafts (self-evolution) -----------------------------------------
//
// Skills the agent proposed from its own transcripts. Inert until approved:
// the scanner skips skills/_drafts entirely, so nothing here is loadable by
// the agent no matter what it says.

app.get('/api/skills/drafts', (_req, res) => {
  res.json({ drafts: listDrafts(), rejected: getRejections({ limit: 50 }) });
});

app.post('/api/skills/drafts/:name/approve', (req, res) => {
  try {
    const r = approveDraft(req.params.name);
    if (!r) return res.status(404).json({ error: `No draft "${req.params.name}"` });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/skills/drafts/:name/reject', (req, res) => {
  const ok = rejectDraft(req.params.name, req.body?.reason || '');
  if (!ok) return res.status(404).json({ error: `No draft "${req.params.name}"` });
  res.json({ ok: true });
});

/* Analyse a session and propose skills from it. Normally fired automatically
 * after a substantial run; exposed so it can be triggered by hand too. */
app.post('/api/skills/reflect', async (req, res) => {
  const { sessionId, force } = req.body || {};
  if (!sessionId || !sessionExists(sessionId)) {
    return res.status(400).json({ error: 'A valid sessionId is required.' });
  }
  const active = getActiveSettings();
  const provider = providerById(active.provider);
  if (!provider) return res.status(400).json({ error: `Unknown provider "${active.provider}"` });

  if (!force) {
    const verdict = isWorthReflecting(sessionId);
    if (!verdict.worth) {
      return res.json({ ok: true, skipped: true, reason: verdict.reason, drafts: [] });
    }
  }
  try {
    const drafts = await reflectOnSession({
      sessionId,
      provider,
      model: resolveModel(provider.id, provider.defaultModel),
      apiKey: getProviderKey(provider.id),
    });
    res.json({ ok: true, drafts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Declared after /api/skills/drafts: Express matches in order, so a ":name"
 * route registered first would swallow "drafts" as a skill name. */
app.get('/api/skills/:name', (req, res) => {
  const s = getSkill(req.params.name);
  if (!s) return res.status(404).json({ error: `Skill "${req.params.name}" not found` });
  res.json(publicSkill(s, true));
});

app.post('/api/skills/scan', (_req, res) => {
  const skills = scanSkills();
  res.json({ skills: skills.map(publicSkill), scanned: skills.length });
});

app.delete('/api/skills/:name', (req, res) => {
  const ok = deleteSkill(req.params.name);
  if (!ok) return res.status(404).json({ error: `Skill "${req.params.name}" not found` });
  res.json({ ok: true });
});

// Upload a skill. The browser uses webkitdirectory to pick a folder; all
// files in that folder are uploaded with their relative paths preserved.
// Server stages them in a temp dir, then copies into skills/<name>/.
app.post('/api/skills/upload', upload.array('files', 200), (req, res) => {
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

  // The name comes from the form field, or from the first file's path
  // (the root folder name from webkitdirectory), or from SKILL.md's
  // frontmatter, in that order.
  let name = (req.body && req.body.name) || '';
  if (!name) {
    // webkitdirectory uses paths like "my-skill/SKILL.md" or "my-skill/lib/foo.js".
    const first = files[0];
    const seg = (first.originalname || '').split(/[\\/]/)[0];
    if (seg) name = seg;
  }
  // `name` is validated by importSkillDir before it becomes a directory.
  if (!name) {
    // Last resort: try to read name from SKILL.md's frontmatter.
    const md = files.find((f) => /SKILL\.md$/i.test(f.originalname));
    if (md) {
      try {
        const raw = fs.readFileSync(md.path, 'utf8');
        const m = raw.match(/^\s*name\s*:\s*(.+)$/m);
        if (m) name = m[1].trim().replace(/^['"]|['"]$/g, '');
      } catch { /* ignore */ }
    }
  }
  if (!name) return res.status(400).json({ error: 'Could not determine skill name. Pass ?name= or include a folder/SKILL.md with name: frontmatter.' });

  // Uploaded files are flat and randomly named; rebuild the folder tree in a
  // staging dir, validating every path, then hand the tree to importSkillDir.
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gwn-skill-stage-'));
  const rejected = [];
  try {
    let copied = 0;
    for (const f of files) {
      const rel = safeRelativePath(f.originalname);
      if (!rel) {
        rejected.push(f.originalname || '(unnamed)');
        continue;
      }
      const dest = path.join(stageRoot, rel);
      // Belt and braces: even with a validated `rel`, confirm the resolved
      // destination is still inside the staging root before writing.
      const resolved = path.resolve(dest);
      if (resolved !== path.resolve(stageRoot) && !resolved.startsWith(path.resolve(stageRoot) + path.sep)) {
        rejected.push(f.originalname || '(unnamed)');
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.path, dest);
      copied += 1;
    }
    if (rejected.length) {
      return res.status(400).json({
        error: `Rejected ${rejected.length} file path(s) that escape the skill folder.`,
        rejected: rejected.slice(0, 10),
      });
    }
    if (!copied) return res.status(400).json({ error: 'No usable files in upload.' });

    const skill = importSkillDir({ name, sourceDir: stageRoot });
    res.json({ ok: true, skill: publicSkill(skill, true), files: copied });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Upload failed' });
  } finally {
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    // One temp dir per request now, so this actually cleans up everything.
    if (req._gwnUploadDir) {
      try { fs.rmSync(req._gwnUploadDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
});

function publicSkill(s, includeBody = false) {
  if (!s) return null;
  return {
    name: s.name,
    description: s.description,
    path: s.path,
    skillMd: s.skillMd,
    ...(includeBody ? { body: s.body } : {}),
  };
}

// --- mind -------------------------------------------------------------------
// The agent's inner life, for the Presence view: identity, memory, mood,
// goals, journal, proposals, and the heartbeat that runs between
// conversations.

app.get('/api/mind', (_req, res) => {
  const st = getMindState();
  res.json({
    soul: readSoul(),
    core: getCore(),
    coreLimits: CORE_LIMITS,
    mood: currentMood(),
    focus: st.focus,
    birth: st.birth,
    goals: listGoals({ includeClosed: true }).slice(-30),
    proposals: st.proposals.slice(-30).reverse(),
    journal: readJournal({ limit: 40 }),
    memories: recentMemories(15),
    heartbeat: heartbeatStatus(),
  });
});

// The brain network for the Presence view: conversations, tools and skills,
// and the emotions felt while each action ran.
app.get('/api/brain', (_req, res) => {
  res.json(brainGraph());
});

app.post('/api/brain/feel', (req, res) => {
  const { emotion, action } = req.body || {};
  try {
    res.json({ count: recordFeel(emotion, action) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/mind/soul', (req, res) => {
  try {
    res.json({ soul: writeSoul(req.body?.soul) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/mind/heartbeat', (req, res) => {
  setHeartbeat(req.body || {});
  res.json(heartbeatStatus());
});

// Wake it now, outside the schedule. Still refuses when a user run is in
// flight or the day's budget is spent; the answer says why.
app.post('/api/mind/beat', async (_req, res) => {
  const r = await beat({ force: true, reason: 'manual' });
  res.json(r);
});

app.post('/api/mind/proposals/:id', (req, res) => {
  const { status, reason } = req.body || {};
  try {
    res.json(resolveProposal(req.params.id, status, reason));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Live channel for what the agent does on its own time, so the face can
// react to a heartbeat nobody started.
app.get('/api/mind/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  send({ type: 'hello', mood: currentMood(), heartbeat: heartbeatStatus() });
  const off = onHeartbeatEvent(send);
  const ping = setInterval(() => send({ type: 'ping', mood: currentMood() }), 30_000);
  ping.unref?.();
  req.on('close', () => { off(); clearInterval(ping); });
});

// One stream per window for everything live (see src/utils/stream.js).
//
// A browser keeps at most 6 connections to one address, shared by every
// OmniOne window (they run in one WebView2). With a separate stream per
// feature, the main window and the widgets used all 6, and the next request
// (a question, the voice) waited forever. Each window now opens just this
// one, with the topics it needs; every event carries `ch` (its topic).
//   live       every run's events (live.js)            mind   the heartbeat and mood
//   skills     the skills folder changed               workspace  files changed
//   listen     the wake-word recognizer (when it's on in Settings → Voice)
const STREAM_TOPICS = new Set(['live', 'mind', 'skills', 'workspace', 'listen']);
const streamListeners = new Set();
app.get('/api/stream', (req, res) => {
  const topics = new Set(String(req.query.topics || '').split(',').filter((t) => STREAM_TOPICS.has(t)));
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (ch) => (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ ...ev, ch })}\n\n`); };
  const offs = [];
  if (topics.has('live')) { send('live')({ type: 'hello' }); offs.push(subscribeLive(send('live'))); }
  if (topics.has('mind')) {
    send('mind')({ type: 'hello', mood: currentMood(), heartbeat: heartbeatStatus() });
    offs.push(onHeartbeatEvent(send('mind')));
  }
  if (topics.has('skills')) {
    const fn = send('skills');
    fn({ type: 'hello', count: getSkills().length });
    skillsStreamSubs.add(fn);
    offs.push(() => skillsStreamSubs.delete(fn));
  }
  if (topics.has('workspace')) { send('workspace')({ type: 'hello', root: getWorkspaceRoot() }); offs.push(watchWorkspace(send('workspace'))); }
  if (topics.has('listen')) {
    streamListeners.add(res);
    offs.push(() => streamListeners.delete(res));
    if (getPrefs().voice.wakeWord) offs.push(speechListener().subscribe(send('listen')));
    else send('listen')({ type: 'state', state: 'off', reason: 'The wake word is off (Settings → Voice).' });
  }
  const ping = setInterval(() => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'ping', ch: 'stream', mood: topics.has('mind') ? currentMood() : undefined })}\n\n`); }, 25_000);
  ping.unref?.();
  res.on('close', () => { clearInterval(ping); for (const off of offs) { try { off(); } catch { /* already gone */ } } });
});

// Every run's events, for every window (see live.js).
app.get('/api/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  send({ type: 'hello' });
  const off = subscribeLive(send);
  const ping = setInterval(() => send({ type: 'ping' }), 30_000);
  ping.unref?.();
  res.on('close', () => { off(); clearInterval(ping); });
});

// Always-listening voice input for the Presence widget: Windows' offline
// recognizer, wake word "Omi-One". Runs only while someone is connected.
app.get('/api/listen', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
  // Settings → Voice can turn the wake word off: then nothing listens.
  if (!getPrefs().voice.wakeWord) {
    send({ type: 'state', state: 'off', reason: 'The wake word is off (Settings → Voice).' });
    return res.end();
  }
  listenStreams.add(res);
  const off = speechListener().subscribe(send);
  const ping = setInterval(() => send({ type: 'ping' }), 30_000);
  ping.unref?.();
  res.on('close', () => { off(); clearInterval(ping); listenStreams.delete(res); });
});
const listenStreams = new Set();

app.get('/api/listen/status', (_req, res) => {
  res.json(speechListener().status());
});

// The voice. Synthesizes with MiniMax and returns the audio itself, so the
// browser can play it through an analyser and move the mouth with it. The
// client falls back to the browser's own speech synthesis on any error.
// --- scheduled tasks ----------------------------------------------------------------

app.get('/api/schedules', (_req, res) => res.json(listSchedules()));
app.post('/api/schedules', (req, res) => {
  try { res.json(addSchedule(req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/schedules/:id', (req, res) => {
  try { res.json(updateSchedule(req.params.id, req.body || {})); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/schedules/:id', (req, res) => {
  try { removeSchedule(req.params.id); res.json({ ok: true }); } catch (e) { res.status(404).json({ error: e.message }); }
});
// Run now: answers at once; the result arrives on the live channel and in the history.
app.post('/api/schedules/:id/run', (req, res) => {
  if (!getSchedule(req.params.id)) return res.status(404).json({ error: 'No such scheduled task.' });
  runSchedule(req.params.id, { reason: 'manual' }).catch((e) => console.error('[omnione] schedule run:', e.message));
  res.json({ started: true });
});

// --- Vercel ---------------------------------------------------------------------------
// The token goes in once and stays in .gwn-secrets.json; the browser only ever
// gets the account name and the last 4 characters.

const vercelFail = (res, e) => res.status(e instanceof VercelError ? (e.status === 401 || e.status === 403 ? 401 : 400) : 500).json({ error: e.message });
app.get('/api/connections/vercel', async (_req, res) => {
  const st = vercelStatus();
  if (!st.connected) return res.json(st);
  let teams = [];
  try { teams = await listVercelTeams(); } catch { /* offline or token revoked: still show the status */ }
  res.json({ ...st, teams });
});
app.post('/api/connections/vercel', async (req, res) => {
  try {
    const r = await connectVercel({ token: req.body?.token, teamId: req.body?.teamId });
    res.json({ ...vercelStatus(), teams: r.teams, email: r.email });
  } catch (e) { vercelFail(res, e); }
});
app.post('/api/connections/vercel/team', (req, res) => {
  try { setVercelTeam(req.body?.teamId || null); res.json(vercelStatus()); } catch (e) { vercelFail(res, e); }
});
app.delete('/api/connections/vercel', (_req, res) => {
  disconnectVercel();
  res.json(vercelStatus());
});

// --- website chat ---------------------------------------------------------------------
// The account's chat room on the website: on/off and the approval PIN. The PIN
// goes straight to the website, which keeps only its hash.

app.get('/api/connections/webchat', (_req, res) => res.json(webchatStatus()));
app.post('/api/connections/webchat', async (req, res) => {
  try {
    const { enabled, pin } = req.body || {};
    res.json(await setWebchat({ enabled, pin }));
  } catch (e) {
    res.status(e instanceof CloudError ? (e.code === 'not_connected' ? 409 : 400) : 500).json({ error: e.message });
  }
});

// --- live camera --------------------------------------------------------------------

const cameraFail = (res, e) => res.status(e instanceof CameraError ? 400 : 500).json({ error: e.message });
app.get('/api/camera', async (req, res) => {
  const out = { ...cameraState(), esp32Sizes: ESP32_SIZES };
  if (req.query.webcams) out.webcams = await listWebcams().catch(() => []);
  res.json(out);
});
app.post('/api/camera', (req, res) => {
  try { res.json(setCamera(req.body || {})); } catch (e) { cameraFail(res, e); }
});
// A fresh picture for the preview (not saved). Works while the camera is on,
// or for "Test" in Settings with ?test=1.
app.get('/api/camera/frame', async (req, res) => {
  try {
    const { jpg } = await takePicture({ save: false, ignoreOff: req.query.test === '1' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.end(jpg);
  } catch (e) { cameraFail(res, e); }
});
app.post('/api/camera/find', async (_req, res) => {
  try { res.json({ cameras: await findNetworkCameras() }); } catch (e) { cameraFail(res, e); }
});

// --- preferences, personalities, voices -------------------------------------------

app.get('/api/prefs', (_req, res) => res.json(getPrefs()));
app.post('/api/prefs', (req, res) => {
  try {
    const next = setPrefs(req.body || {});
    // The wake word just went off: close the open listening streams (their
    // windows reconnect and are told it is off).
    if (!next.voice.wakeWord) for (const r of listenStreams) r.end();
    // Shared streams re-open and re-check the wake word either way.
    for (const r of streamListeners) r.end();
    publishLive({ type: 'prefs' }, 'settings');
    res.json(next);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/personalities', (_req, res) => {
  const prefs = getPrefs();
  res.json({ active: prefs.personality.active, list: allPersonalities(prefs) });
});
app.post('/api/personalities', (req, res) => {
  try {
    const p = sanitizePersonality(req.body || {});
    const custom = getPrefs().personality.custom.filter((x) => x.id !== p.id);
    const prefs = setPrefs({ personality: { custom: [...custom, p], ...(req.body?.activate ? { active: p.id } : {}) } });
    res.json({ saved: p, active: prefs.personality.active, list: allPersonalities(prefs) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/personalities/active', (req, res) => {
  const id = String(req.body?.id || '');
  if (!allPersonalities().some((p) => p.id === id)) return res.status(404).json({ error: `No personality "${id}".` });
  const prefs = setPrefs({ personality: { active: id } });
  publishLive({ type: 'personality', id }, 'settings');
  res.json({ active: prefs.personality.active });
});
app.delete('/api/personalities/:id', (req, res) => {
  const id = req.params.id;
  if (PRESETS.some((p) => p.id === id)) return res.status(400).json({ error: 'Built-in personalities can\'t be deleted.' });
  const cur = getPrefs().personality;
  const prefs = setPrefs({ personality: { custom: cur.custom.filter((p) => p.id !== id), active: cur.active === id ? 'omi-one' : cur.active } });
  res.json({ active: prefs.personality.active, list: allPersonalities(prefs) });
});

// Cloning from Settings → Voice: the user records or picks a sample. It is
// saved into the workspace (voice-samples/) so the clone can be redone, and
// the user clicked the button, so no approval prompt.
const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
app.post('/api/voices/clone', (req, res) => {
  voiceUpload.single('sample')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'The sample is over 20 MB.' : err.message });
    if (!req.file) return res.status(400).json({ error: 'No recording received.' });
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Give the voice a name.' });
    if (req.body?.consent !== 'yes') return res.status(400).json({ error: 'Confirm it is your voice or that you have permission to clone it.' });
    const dir = path.join(getWorkspaceRoot(), 'voice-samples');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${safeUploadName(req.file.originalname || 'sample.webm')}`);
    fs.writeFileSync(file, req.file.buffer);
    try {
      const r = await cloneVoice({ sample: toWorkspaceRelative(file), name, previewText: req.body?.previewText || 'Hi, this is my new voice. How do I sound?' });
      if (!r.ok) return res.status(502).json({ error: r.error });
      if (req.body?.use === 'yes') setPrefs({ voice: { voiceId: r.result.voiceId } });
      res.json({ ...r.result, prefs: getPrefs().voice });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});
app.delete('/api/voices/:id', (req, res) => {
  const v = getPrefs().voice;
  const prefs = setPrefs({ voice: {
    clones: v.clones.filter((c) => c.voiceId !== req.params.id),
    voiceId: v.voiceId === req.params.id ? 'English_expressive_narrator' : v.voiceId,
  } });
  res.json(prefs.voice);
});

// Pictures, sound and video from the workspace, for the chat to show what
// Omi-One made. Media types only: this isn't a general file server.
const MEDIA_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.webm': 'video/webm',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};
app.get('/api/workspace/media', (req, res) => {
  let abs;
  try { abs = resolveInWorkspace(String(req.query.path || '')); } catch (e) { return res.status(400).json({ error: e.message }); }
  const type = MEDIA_TYPES[path.extname(abs).toLowerCase()];
  if (!type) return res.status(415).json({ error: 'Not a picture, sound or video file.' });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return res.status(404).json({ error: 'No such file.' });
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(abs);
});

app.post('/api/speak', async (req, res) => {
  const { text, voice_id, emotion, speed, pitch, model } = req.body || {};
  const t = String(text || '').trim();
  if (!t) return res.status(400).json({ error: 'text is required' });
  if (t.length > 3000) return res.status(400).json({ error: 'text is over 3000 characters' });
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    // The voice from Settings → Voice (or the personality's own voice); the
    // emotion engine's speed and pitch are nudges on top of it.
    const v = speakingVoice();
    const r = await synthesizeSpeech({
      text: t,
      model: model || v.model,
      voice_id: voice_id || v.voiceId,
      emotion: emotion || undefined,
      speed: Math.max(0.5, Math.min(2, v.speed * (speed == null ? 1 : Number(speed) || 1))),
      pitch: Math.max(-12, Math.min(12, Math.round(v.pitch + (pitch == null ? 0 : Number(pitch) || 0)))),
      format: 'mp3',
    }, { signal: ac.signal });
    if (!r.ok) return res.status(502).json({ error: r.error });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('X-Audio-Length-Ms', String(r.info.audio_length || ''));
    res.end(r.buf);
  } catch (e) {
    if (e?.name !== 'AbortError') res.status(500).json({ error: e?.message || String(e) });
  }
});

// --- account (optional connection to the website) ------------------------------
// The token stays in this server; the browser only ever sees the profile.

const cloudFail = (res, e) => res.status(e instanceof CloudError && e.code === 'not_connected' ? 409 : 502)
  .json({ error: e.message, code: e.code || 'cloud_error' });

app.get('/api/account', (_req, res) => {
  res.json(publicAccount());
});

app.post('/api/account/connect', async (_req, res) => {
  try {
    res.json({ pending: await startConnect() });
  } catch (e) {
    cloudFail(res, e);
  }
});

app.post('/api/account/connect/poll', async (_req, res) => {
  try {
    const r = await pollConnect();
    if (r.status === 'approved') syncUsageNow();
    res.json(r);
  } catch (e) {
    cloudFail(res, e);
  }
});

app.post('/api/account/connect/cancel', (_req, res) => {
  cancelConnect();
  res.json(publicAccount());
});

app.post('/api/account/refresh', async (_req, res) => {
  try {
    res.json(await refreshAccount());
  } catch (e) {
    cloudFail(res, e);
  }
});

app.post('/api/account/disconnect', async (_req, res) => {
  res.json(await disconnect());
});

// --- stats ---------------------------------------------------------------------------

app.get('/api/stats', (req, res) => {
  res.json(getStats({ days: Number(req.query.days) || 30 }));
});

/* Push the last two days' totals to the website profile, when connected.
 * Never throws: a failed sync just tries again next time. */
function syncUsageNow() {
  if (!publicAccount().connected) return;
  syncUsage(usageEntries({ days: 2 })).catch((e) => console.warn('[omnione] usage sync:', e.message));
}

// --- error surface ---------------------------------------------------------
//
// Registered last, after every route. Without these, an unknown /api path
// fell through to Express's HTML 404 and an unhandled throw returned an HTML
// stack trace — both of which a client doing `await r.json()` parses as a
// crash rather than an error it can report.

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'No such endpoint.' });
});

// Four arguments: this is Express's error handler signature, and omitting
// `next` silently turns it back into ordinary middleware.
// eslint-disable-next-line no-unused-vars
app.use('/api', (err, _req, res, _next) => {
  // Body-parser rejects malformed JSON with a 400 already on the error.
  const status = err?.status || err?.statusCode || 500;
  if (status >= 500) console.error('[omnione]', err);
  res.status(status).json({
    error: err?.message || 'Internal error',
  });
});

// --- boot ------------------------------------------------------------------
// Declared last so every route is registered before the socket opens, and
// exported so tests can drive the app without binding a port.
// OmniOne.exe runs the server with --serve-ui: it serves the built app
// (dist/) itself, so users don't run the Vite dev server at all.
const SERVE_UI = process.argv.includes('--serve-ui') || process.env.OMNIONE_SERVE_UI === '1';
if (SERVE_UI) serveBuiltUi(app);

export { app };

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && desktopExe() && await isElevated()) {
  // OmniOne.exe never runs as administrator, so nothing Omi-One does can
  // touch Windows' own files. The exe checks too; this is the second lock.
  console.error('[omnione] refusing to run as administrator. Start OmniOne normally.');
  process.exit(3);
}

if (isMain) {
  ensureToken();
  app.listen(PORT, HOST, () => {
    console.log(`[omnione] listening on http://${HOST}:${PORT} (loopback only)`);
    console.log(`[omnione] token:     ${TOKEN_PATH} (send as ${TOKEN_HEADER})`);
    console.log(`[omnione] secrets:   ${path.join(PROJECT_ROOT, '.gwn-secrets.json')}`);
    console.log(`[omnione] workspace: ${getWorkspaceRoot()}`);
    console.log(`[omnione] skills:    ${SKILLS_DIR}`);
    console.log(`[omnione] hooks:     ${HOOKS_DIR}`);
    console.log(`[omnione] mcp:       ${MCP_CONFIG_PATH}`);
  });

  // The heartbeat: the agent's own time between conversations.
  if (startHeartbeat()) console.log('[omnione] heartbeat: on (see /api/mind; GWN_HEARTBEAT=0 disables)');
  if (startSchedules()) console.log('[omnione] scheduled tasks: on (GWN_SCHEDULES=0 disables)');
  if (startWebchat()) console.log('[omnione] website chat: on (GWN_WEBCHAT=0 disables)');

  // Usage totals to the website profile every 10 minutes, when connected.
  const syncTimer = setInterval(syncUsageNow, 10 * 60 * 1000);
  syncTimer.unref?.();

  // A background job the agent started must not outlive the harness.
  const shutdown = () => { killAllJobs(); flushStats(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
