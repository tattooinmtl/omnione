// MCP (Model Context Protocol) server registry for OmniOne.
//
// Reads .gwn-mcp.json ({ mcpServers: { name: def } }, the Claude Desktop
// format, or a flat array). A def is either
//   { url, headers? }                   an MCP server over HTTP (e.g. Blender)
//   { command, args?, env? }            a program OmniOne starts (stdio)
// plus optional { description, disabled, permission: 'read'|'write'|'execute',
// readOnlyTools: [names that run without asking] }.
// Servers connect on demand and stay connected; one that is offline is not
// retried for RETRY_MS, so a closed Blender doesn't slow down every message.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from './tools.js';
import { McpHttpClient } from './mcpHttp.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
let CONFIG_PATH = path.join(PROJECT_ROOT, '.gwn-mcp.json');
const RETRY_MS = 30_000;

export function _setMcpConfigPathForTest(p) { CONFIG_PATH = p; reloadMcpConfig(); }

/* Servers the Settings page offers with one click. */
export const PRESETS = {
  blender: {
    label: 'Blender (port 8765)',
    def: {
      url: 'http://127.0.0.1:8765/mcp',
      description: 'Blender 5.2 through the Blender MCP add-on (C:\\blender_addon_mcp). In Blender: Edit → Preferences → Add-ons → Blender MCP → Start Server.',
      // Looking runs freely; changing the scene, rendering and code ask first.
      readOnlyTools: ['get_addon_info', 'scene_info', 'list_objects', 'get_object', 'frame_get', 'dominator_health_check', 'dominator_list_units', 'dominator_list_buildings'],
    },
  },
};

let config = null;
const clients = new Map(); // name -> { client, startedAt, status, error, failedAt }

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { mcpServers: {} };
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    if (parsed.mcpServers) return parsed;
    if (Array.isArray(parsed)) return { mcpServers: Object.fromEntries(parsed.map((s) => [s.name, s])) };
    return { mcpServers: {} };
  } catch (e) {
    return { mcpServers: {}, _error: e.message };
  }
}

function saveConfig(next) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ mcpServers: next.mcpServers }, null, 2));
  config = next;
}

export function getMcpConfig() {
  if (!config) config = loadConfig();
  return config;
}

export function reloadMcpConfig() {
  for (const c of clients.values()) {
    try { c.client?.stop(); } catch { /* ignore */ }
  }
  clients.clear();
  config = loadConfig();
  return config;
}

export function getServerNames({ includeDisabled = false } = {}) {
  const all = getMcpConfig().mcpServers || {};
  return Object.keys(all).filter((n) => includeDisabled || !all[n].disabled);
}

export function getServer(name) {
  const cfg = getMcpConfig().mcpServers || {};
  return cfg[name] || null;
}

/* Check a server definition from the Settings form. Throws a readable error. */
export function validateServer(name, def) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(String(name || ''))) {
    throw new Error('Name: letters, digits, - and _ only (it becomes part of each tool name).');
  }
  const out = {};
  if (def.url) {
    let u;
    try { u = new URL(String(def.url)); } catch { throw new Error('That URL isn\'t valid.'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error('The URL must start with http:// or https://.');
    out.url = u.toString();
    if (def.headers && typeof def.headers === 'object') out.headers = Object.fromEntries(Object.entries(def.headers).map(([k, v]) => [String(k), String(v)]));
  } else if (def.command) {
    out.command = String(def.command);
    out.args = Array.isArray(def.args) ? def.args.map(String) : [];
    if (def.env && typeof def.env === 'object') out.env = def.env;
  } else {
    throw new Error('Give either a URL (an HTTP MCP server) or a command (a program to start).');
  }
  if (def.description) out.description = String(def.description).slice(0, 300);
  if (['read', 'write', 'execute'].includes(def.permission)) out.permission = def.permission;
  if (Array.isArray(def.readOnlyTools)) out.readOnlyTools = def.readOnlyTools.map(String).slice(0, 200);
  if (def.disabled) out.disabled = true;
  return out;
}

export function addServer(name, def) {
  const clean = validateServer(name, def);
  const cfg = getMcpConfig();
  const next = { mcpServers: { ...(cfg.mcpServers || {}), [name]: clean } };
  dropClient(name);
  saveConfig(next);
  return clean;
}

export function removeServer(name) {
  const cfg = getMcpConfig();
  if (!cfg.mcpServers?.[name]) throw new Error(`No MCP server "${name}".`);
  const { [name]: _gone, ...rest } = cfg.mcpServers;
  dropClient(name);
  saveConfig({ mcpServers: rest });
}

export function setServerDisabled(name, disabled) {
  const cfg = getMcpConfig();
  const def = cfg.mcpServers?.[name];
  if (!def) throw new Error(`No MCP server "${name}".`);
  dropClient(name);
  saveConfig({ mcpServers: { ...cfg.mcpServers, [name]: { ...def, disabled: Boolean(disabled) || undefined } } });
}

function dropClient(name) {
  const c = clients.get(name);
  try { c?.client?.stop(); } catch { /* ignore */ }
  clients.delete(name);
}

export async function ensureClient(name, { force = false } = {}) {
  const prev = clients.get(name);
  if (prev?.client?.ready) return prev.client;
  // Offline a moment ago: don't knock again on every message.
  if (!force && prev?.status === 'error' && Date.now() - prev.failedAt < RETRY_MS) throw new Error(prev.error);
  const def = getServer(name);
  if (!def) throw new Error(`MCP server "${name}" not found in .gwn-mcp.json`);
  const client = def.url
    ? new McpHttpClient({ url: def.url, headers: def.headers })
    : new McpStdioClient({ command: def.command, args: def.args, env: def.env });
  try {
    await client.start();
    await client.listTools();
    clients.set(name, { client, startedAt: Date.now(), status: 'ok' });
    return client;
  } catch (e) {
    try { client.stop(); } catch { /* ignore */ }
    clients.set(name, { client: null, startedAt: Date.now(), status: 'error', error: e.message, failedAt: Date.now() });
    throw e;
  }
}

/* Connect now (Settings → Test) and report what the server offers. */
export async function testServer(name) {
  dropClient(name);
  const c = await ensureClient(name, { force: true });
  return { tools: c.tools.map((t) => t.name), serverInfo: c.serverInfo || null };
}

export async function listMcpTools() {
  const out = [];
  for (const name of getServerNames()) {
    try {
      const c = await ensureClient(name);
      for (const t of c.tools) {
        out.push({ server: name, name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });
      }
    } catch (e) {
      out.push({ server: name, name: '_error', error: e.message });
    }
  }
  return out;
}

export async function callMcpTool({ server, name, args, signal }) {
  const c = await ensureClient(server);
  try {
    return await c.callTool(name, args || {}, { signal });
  } catch (e) {
    // The server went away mid-session (Blender closed): reconnect next time.
    if (/answering|reach|closed|ECONN/i.test(e.message)) dropClient(server);
    throw e;
  }
}

/* What the server told us about itself, for the system prompt. */
export function serverInstructions() {
  const out = [];
  for (const [name, c] of clients.entries()) {
    if (c.client?.instructions) out.push({ server: name, text: c.client.instructions.slice(0, 2000) });
  }
  return out;
}

export function getClients() {
  const all = getMcpConfig().mcpServers || {};
  return Object.entries(all).map(([name, def]) => {
    const c = clients.get(name);
    return {
      name,
      kind: def.url ? 'http' : 'program',
      where: def.url || [def.command, ...(def.args || [])].join(' '),
      description: def.description || '',
      disabled: Boolean(def.disabled),
      status: def.disabled ? 'off' : c ? c.status : 'not connected yet',
      error: c?.error,
      tools: c?.client ? c.client.tools.map((t) => t.name) : [],
    };
  });
}

export { CONFIG_PATH };
