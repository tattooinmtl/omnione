// The website chat bridge: Omi-One answering in the account's chat room on
// the website (omnione.globalwarningnetworks.com/chat.php), so the user can
// talk to it from a phone.
//
// OmniOne only ever calls out (website API chat/*), so it works behind any
// router. It checks the room every 2 s while the chat page is open or a reply
// is being written, every 8 s otherwise. Each message from the phone becomes
// a run in one dedicated conversation; the reply streams back as it's
// written, pictures and files Omi-One makes go along, and approvals can be
// answered on the phone (with the PIN, checked by the website) or on the PC
// (the Presence widget shows them, as for any run).

import fs from 'node:fs';
import path from 'node:path';
import { getPrefs, setPrefs } from './prefs.js';
import { cloudCall, cloudDownload, cloudUpload, isConnected, CloudError, siteUrl } from './cloud.js';
import { providerById } from './providers.js';
import { getActiveSettings, getProviderKey, resolveModel } from './secrets.js';
import { createSession, sessionExists, acquireSessionRun, releaseSessionRun } from './sessions.js';
import { resolveApproval } from './permissions.js';
import { getWorkspaceRoot, resolveInWorkspace, toWorkspaceRelative } from './workspace.js';
import { imageTypeOf, isDocument } from './attachments.js';
import { cameraAttachment } from './camera.js';
import { publishLive } from './live.js';

const FAST_MS = 2000;
const SLOW_MS = 8000;
const ERROR_MS = 15000;
const FLUSH_MS = 1200;           // how often a growing reply is sent to the website
const MAX_SEND_BYTES = 25 * 1024 * 1024;
const MEDIA_RE = /\.(png|jpe?g|gif|webp|mp3|wav|m4a|mp4|webm|mov|pdf|zip|txt|md|csv|json|docx|xlsx)$/i;

let timer = null;
let busy = false;                // a message is being answered
let phoneActive = false;
let lastCheck = null;
let lastError = null;
let stopped = true;
let runner = null;               // tests swap in a fake agent

export function _setRunnerForTest(fn) { runner = fn; }

export function webchatStatus() {
  const w = getPrefs().webchat;
  return {
    enabled: w.enabled,
    pinSet: w.pinSet,
    connected: isConnected(),
    running: !stopped,
    busy,
    phoneActive,
    lastCheck,
    lastError,
    chatUrl: `${siteUrl()}/chat.php`,
  };
}

/* Switch the room on or off (and set or clear the PIN) on the website, then
 * start or stop checking it. */
export async function setWebchat({ enabled, pin } = {}) {
  if (!isConnected()) throw new CloudError('not_connected', 'Connect OmniOne to your account first (account menu, bottom left).');
  const cur = getPrefs().webchat;
  const on = enabled == null ? cur.enabled : Boolean(enabled);
  const body = { on };
  if (pin !== undefined) {
    const p = String(pin ?? '');
    if (p !== '' && !/^\d{4,8}$/.test(p)) throw new CloudError('bad_pin', 'The PIN is 4 to 8 digits.');
    body.pin = p;
  }
  const r = await cloudCall('POST', 'chat/bridge', { body });
  setPrefs({ webchat: { enabled: r.on, pinSet: r.pin_set } });
  // The first time: start after what's already in the room, so old messages
  // aren't answered again.
  if (r.on && !getPrefs().webchat.lastId && r.last_id) setPrefs({ webchat: { lastId: r.last_id } });
  if (r.on) startWebchat(); else stopWebchat();
  publishLive({ type: 'webchat', enabled: r.on }, 'webchat');
  return webchatStatus();
}

export function startWebchat() {
  if (process.env.GWN_WEBCHAT === '0') return false;
  if (!getPrefs().webchat.enabled) return false;
  stopped = false;
  schedule(0);
  return true;
}

export function stopWebchat() {
  stopped = true;
  clearTimeout(timer);
  timer = null;
}

function schedule(ms) {
  clearTimeout(timer);
  if (stopped) return;
  timer = setTimeout(() => { tick().catch(() => {}); }, ms);
  timer.unref?.();
}

/* One check of the room. Keeps going while a reply is being written, because
 * that's when the phone's answer to an approval has to get through; new
 * messages wait in a queue and are answered one at a time. Exported for tests
 * (force: true checks even when the timer is stopped). */
const queue = [];
const queued = new Set();
let working = null;

export async function tick({ force = false } = {}) {
  if (stopped && !force) return;
  if (!isConnected()) { lastError = 'OmniOne is not connected to an account.'; schedule(SLOW_MS); return; }
  let r;
  try {
    r = await cloudCall('GET', `chat/poll?after=${getPrefs().webchat.lastId || 0}`);
    lastCheck = Date.now();
    lastError = null;
  } catch (e) {
    lastError = e.message;
    if (e.status === 401) { stopWebchat(); return; }
    schedule(ERROR_MS);
    return;
  }
  phoneActive = Boolean(r.phone_active);
  if (!r.on) {
    // Switched off on the website side (or never on there): stop asking.
    setPrefs({ webchat: { enabled: false } });
    stopWebchat();
    return;
  }
  for (const d of r.decisions || []) {
    if (['once', 'deny'].includes(d.status)) resolveApproval(d.request_id, d.status);
  }
  for (const m of r.messages || []) {
    if (queued.has(m.id)) continue;
    queued.add(m.id);
    queue.push(m);
  }
  if (queue.length && !working) working = work();
  schedule(phoneActive || busy || queue.length ? FAST_MS : SLOW_MS);
  return working;
}

async function work() {
  while (queue.length) {
    const m = queue.shift();
    busy = true;
    try {
      await answer(m);
    } catch (e) {
      lastError = e.message;
    } finally {
      setPrefs({ webchat: { lastId: Math.max(getPrefs().webchat.lastId || 0, m.id) } });
      busy = false;
    }
  }
  working = null;
}

function chatSession(provider, model) {
  const w = getPrefs().webchat;
  if (w.sessionId && sessionExists(w.sessionId)) return w.sessionId;
  const id = createSession({ title: '📱 Website chat', provider: provider.id, model, workspaceRoot: getWorkspaceRoot(), sessionKind: 'webchat' });
  setPrefs({ webchat: { sessionId: id } });
  return id;
}

/* Files from the phone, saved into attachments/ like files dropped in the chat. */
async function downloadFiles(files) {
  const out = [];
  if (!files?.length) return out;
  const dir = path.join(getWorkspaceRoot(), 'attachments');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const { buf } = await cloudDownload(`chat/file?id=${f.id}`);
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const safe = String(f.name || 'file').replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-100) || 'file';
    let file = path.join(dir, `phone-${stamp}-${safe}`);
    for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `phone-${stamp}-${n}-${safe}`);
    fs.writeFileSync(file, buf);
    const rel = toWorkspaceRelative(file);
    if (imageTypeOf(file)) out.push({ kind: 'image', path: file, mediaType: imageTypeOf(file), name: f.name });
    else if (isDocument(file)) {
      const { extractDocumentText } = await import('./attachments.js');
      let text;
      try { text = await extractDocumentText(file); } catch (e) { text = `(Couldn't read it: ${e.message})`; }
      out.push({ kind: 'document', path: rel, name: f.name, text });
    } else out.push({ kind: 'file', path: rel, name: f.name });
  }
  return out;
}

/* Workspace media paths in a tool result ({ saved: [...] } or { path }). */
export function mediaPaths(result) {
  if (!result || typeof result !== 'object') return [];
  const list = [...(Array.isArray(result.saved) ? result.saved : []), result.path, result.preview];
  return [...new Set(list.filter((p) => typeof p === 'string' && MEDIA_RE.test(p)))];
}

const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', pdf: 'application/pdf' };

function summarize(preview, args) {
  if (!preview) return JSON.stringify(args || {}).slice(0, 1500);
  if (preview.command) return `${preview.command}${preview.cwd ? `\n(in ${preview.cwd})` : ''}`;
  if (preview.kind === 'write') return `Write ${preview.path} (${preview.lines} lines)\n${String(preview.excerpt || '').slice(0, 800)}`;
  if (preview.kind === 'edit') return `Edit ${preview.path}\n- ${String(preview.oldString || '').slice(0, 300)}\n+ ${String(preview.newString || '').slice(0, 300)}`;
  if (preview.kind === 'post') return `Post: ${preview.title || ''}\n${String(preview.body || '').slice(0, 800)}`;
  return JSON.stringify(preview.args ?? preview).slice(0, 1500);
}

/* Answer one message from the phone. */
async function answer(m) {
  const active = getActiveSettings();
  const provider = providerById(active.provider);
  const apiKey = provider ? getProviderKey(provider.id) : null;
  const say = (body) => cloudCall('POST', 'chat/say', { body });
  if (!provider || provider.apiStyle === 'stub' || !apiKey) {
    await say({ text: 'I can’t answer yet: no AI provider with a key is set up in OmniOne (Settings → AI on the PC).', status: 'error' });
    return;
  }
  const model = resolveModel(provider.id, provider.defaultModel);
  const sessionId = chatSession(provider, model);

  let attachments = [];
  try { attachments = await downloadFiles(m.files); } catch (e) { attachments.push({ kind: 'note', text: `[A file from the phone couldn't be downloaded: ${e.message}]` }); }
  attachments.unshift({ kind: 'note', text: '[Sent from the website chat, probably on a phone: keep replies short and easy to read on a small screen.]' });
  const cam = await cameraAttachment();
  if (cam) attachments.push(cam);
  const prompt = m.body || 'Have a look at what I attached.';

  // One run at a time in this conversation.
  for (let i = 0; i < 100 && !acquireSessionRun(sessionId); i++) await new Promise((r) => setTimeout(r, 300));

  const { id: replyId } = await say({ text: '', status: 'writing' });
  let text = '';
  let flushed = '';
  let lastFlush = 0;
  let failure = null;
  const media = new Set();
  const flush = async (force = false) => {
    if (text === flushed || (!force && Date.now() - lastFlush < FLUSH_MS)) return;
    flushed = text;
    lastFlush = Date.now();
    await say({ id: replyId, text }).catch(() => {});
  };
  const status = (s) => cloudCall('POST', 'chat/status', { body: { text: s } }).catch(() => {});
  publishLive({ type: 'user_prompt', text: prompt, sessionId, from: 'website' }, 'webchat');

  try {
    const run = runner || (await import('./agent.js')).runAgent;
    for await (const ev of run({ sessionId, prompt, provider, model, apiKey, attachments, maxIterations: 60 })) {
      publishLive({ ...ev, sessionId }, 'webchat');
      switch (ev.type) {
        case 'turn_start': text = ''; status('thinking…'); break;
        case 'delta': text += ev.text; await flush(); break;
        case 'tool_call': status(`using ${ev.name}`); break;
        case 'tool_result':
          if (ev.ok) for (const p of mediaPaths(ev.result)) media.add(p);
          break;
        case 'approval_request':
          await cloudCall('POST', 'chat/approval', { body: { request_id: ev.id, tool: ev.tool, summary: summarize(ev.preview, ev.args) } }).catch(() => {});
          status(`waiting for your approval: ${ev.tool}`);
          break;
        case 'approval_resolved':
          await cloudCall('POST', 'chat/approval/close', { body: { request_id: ev.id } }).catch(() => {});
          break;
        case 'done': if (ev.text) text = ev.text; break;
        case 'error': failure = ev.message; break;
        default: break;
      }
    }
  } catch (e) {
    failure = e?.message || String(e);
  } finally {
    releaseSessionRun(sessionId);
    status('');
  }

  // Pictures, songs and files it made go along with the reply.
  for (const rel of media) {
    try {
      const abs = resolveInWorkspace(rel);
      const st = fs.statSync(abs);
      if (st.size > MAX_SEND_BYTES) { text += `\n\n(${rel} is too big to send here: it's in OmniOne's folder on your PC.)`; continue; }
      const ext = path.extname(abs).slice(1).toLowerCase();
      await cloudUpload('chat/file', { buf: fs.readFileSync(abs), name: path.basename(abs), type: TYPES[ext] || 'application/octet-stream', fields: { message_id: replyId } });
    } catch (e) {
      text += `\n\n(Couldn't send ${rel}: ${e.message})`;
    }
  }
  if (failure) text = `${text}${text ? '\n\n' : ''}Something went wrong: ${failure}`;
  await say({ id: replyId, text: text || '(no answer)', status: failure ? 'error' : 'done' });
}
