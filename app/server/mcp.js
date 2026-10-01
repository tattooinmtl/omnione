// MCP (Model Context Protocol) server registry for OmniOne.
//
// Reads .gwn-mcp.json (array of { name, command, args, env, description? })
// and exposes the listed servers over /api/mcp/*. Each server is spawned on
// demand, kept alive for the session, and shut down when the process exits.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpStdioClient } from './tools.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, '.gwn-mcp.json');

let config = null;
const clients = new Map(); // name -> { client, startedAt, status, error }

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { mcpServers: {} };
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    // Support both { mcpServers: { name: {...} } } (Claude Desktop format)
    // and a flat array of server definitions.
    if (parsed.mcpServers) return parsed;
    if (Array.isArray(parsed)) return { mcpServers: Object.fromEntries(parsed.map((s) => [s.name, s])) };
    return { mcpServers: {} };
  } catch (e) {
    return { mcpServers: {}, _error: e.message };
  }
}

export function getMcpConfig() {
  if (!config) config = loadConfig();
  return config;
}

export function reloadMcpConfig() {
  for (const c of clients.values()) {
    try { c.client.stop(); } catch { /* ignore */ }
  }
  clients.clear();
  config = loadConfig();
  return config;
}

export function getServerNames() {
  return Object.keys(getMcpConfig().mcpServers || {});
}

export function getServer(name) {
  const cfg = getMcpConfig().mcpServers || {};
  return cfg[name] || null;
}

export async function ensureClient(name) {
  if (clients.has(name)) {
    const c = clients.get(name);
    if (c.client && c.client.ready) return c.client;
  }
  const def = getServer(name);
  if (!def) throw new Error(`MCP server "${name}" not found in .gwn-mcp.json`);
  const client = new McpStdioClient({ command: def.command, args: def.args, env: def.env });
  try {
    await client.start();
    await client.listTools();
    clients.set(name, { client, startedAt: Date.now(), status: 'ok' });
    return client;
  } catch (e) {
    clients.set(name, { client: null, startedAt: Date.now(), status: 'error', error: e.message });
    throw e;
  }
}

export async function listMcpTools() {
  const out = [];
  for (const name of getServerNames()) {
    try {
      const c = await ensureClient(name);
      for (const t of c.tools) {
        out.push({ server: name, name: t.name, description: t.description, inputSchema: t.inputSchema });
      }
    } catch (e) {
      out.push({ server: name, name: '_error', error: e.message });
    }
  }
  return out;
}

export async function callMcpTool({ server, name, args }) {
  const c = await ensureClient(server);
  return c.callTool(name, args || {});
}

export function getClients() {
  return Array.from(clients.entries()).map(([name, c]) => ({
    name,
    status: c.status,
    error: c.error,
    tools: c.client ? c.client.tools.map((t) => t.name) : [],
  }));
}

export { CONFIG_PATH };
