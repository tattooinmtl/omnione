// Tool registry.
//
// One definition per tool, carrying everything the rest of the system needs:
// a JSON Schema for the provider, a handler to run, and a permission class
// the approval layer will read in Phase 2.
//
// Providers disagree about the shape of a tool declaration, so the registry
// owns the translation: `toOpenAITools` and `toAnthropicTools` render the
// same definitions into each provider's native format. Nothing else in the
// codebase should be constructing tool schemas by hand.

import { webSearch, browserOpen } from './tools.js';
import { listMcpTools, callMcpTool } from './mcp.js';

/** @typedef {'read'|'write'|'execute'} Permission */

const registry = new Map();

/* Register a tool. Later registrations with the same name replace earlier
 * ones, which is how MCP tools refresh on reload. */
export function registerTool(def) {
  if (!def?.name) throw new Error('Tool definition needs a name');
  if (typeof def.handler !== 'function') throw new Error(`Tool "${def.name}" needs a handler`);
  registry.set(def.name, {
    name: def.name,
    description: def.description || '',
    // JSON Schema. Providers are strict about this: it must be an object
    // schema even when the tool takes nothing.
    schema: def.schema || { type: 'object', properties: {} },
    permission: def.permission || 'read',
    source: def.source || 'builtin',
    // Optional: given the call's arguments, which workspace paths is this
    // about to modify? The agent loop snapshots them into a checkpoint
    // before the tool runs, so the edit can be undone.
    affectedPaths: typeof def.affectedPaths === 'function' ? def.affectedPaths : null,
    handler: def.handler,
  });
  return registry.get(def.name);
}

export function getTool(name) {
  return registry.get(name) || null;
}

export function listTools() {
  return Array.from(registry.values());
}

/* What the client shows in /api/tools — no handlers. */
export function publicTools() {
  return listTools().map(({ name, description, schema, permission, source }) => ({
    name, description, schema, permission, source,
  }));
}

export function clearTools({ source } = {}) {
  if (!source) return registry.clear();
  for (const [name, def] of registry) {
    if (def.source === source) registry.delete(name);
  }
}

// --- provider translation --------------------------------------------------

export function toOpenAITools(tools = listTools()) {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema },
  }));
}

export function toAnthropicTools(tools = listTools()) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
  }));
}

// --- execution -------------------------------------------------------------

/* Run a tool by name. Never throws: a tool blowing up is a result the model
 * should see and react to, not a crash that kills the run.
 *
 * `ctx.signal` is the run's AbortSignal. Handlers that do anything slow —
 * a network request, a subprocess — are expected to honour it, so that
 * cancelling a run actually stops the work rather than leaving it running
 * with nobody waiting on the result. */
export async function executeTool(name, args, ctx = {}) {
  const tool = getTool(name);
  if (!tool) {
    return { ok: false, error: `Unknown tool "${name}". Available: ${listTools().map((t) => t.name).join(', ')}` };
  }
  if (ctx.signal?.aborted) {
    return { ok: false, error: 'Run cancelled before the tool started.' };
  }
  try {
    const out = await tool.handler(args || {}, ctx);
    // Handlers may return the {ok,result} envelope already, or a bare value.
    if (out && typeof out === 'object' && 'ok' in out) return out;
    return { ok: true, result: out };
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, error: 'Run cancelled.' };
    return { ok: false, error: e?.message || String(e) };
  }
}

/* Render a tool result as the text the model receives. Models do better with
 * compact JSON than with prose wrappers. */
export function formatToolResult(r, { maxChars = 30000 } = {}) {
  if (!r.ok) return `ERROR: ${r.error}`;
  const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result, null, 2);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n…(truncated, ${text.length - maxChars} more chars)`;
}

// --- built-in tools --------------------------------------------------------

registerTool({
  name: 'web_search',
  description: 'Search the web. Returns a list of {title, url, snippet}. Use this to find pages; use browser_open to read one.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'The search query.' },
      max: { type: 'integer', description: 'Maximum results to return.', default: 8 },
    },
    required: ['q'],
  },
  handler: (args, ctx) => webSearch(args, ctx),
});

registerTool({
  name: 'browser_open',
  description: 'Fetch a URL and return its text content. Use to read a specific page, documentation, or datasheet.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch.' },
      maxChars: { type: 'integer', description: 'Truncate the body to this many characters.', default: 12000 },
    },
    required: ['url'],
  },
  handler: (args, ctx) => browserOpen(args, ctx),
});

// --- MCP tools -------------------------------------------------------------

/* Pull the tool list from every configured MCP server and register each one
 * under a namespaced name, so an MCP tool called "read_file" cannot shadow a
 * built-in. Safe to call repeatedly; each call replaces the previous set. */
export async function syncMcpTools() {
  clearTools({ source: 'mcp' });
  let mcpTools = [];
  try {
    mcpTools = await listMcpTools();
  } catch {
    return []; // No MCP configured, or every server failed. Not fatal.
  }
  const added = [];
  for (const t of mcpTools) {
    if (t.name === '_error') continue; // listMcpTools reports failures this way
    const name = `mcp__${t.server}__${t.name}`;
    registerTool({
      name,
      description: t.description || `MCP tool ${t.name} from ${t.server}`,
      schema: t.inputSchema || { type: 'object', properties: {} },
      // An MCP server can do anything; treat its tools as side-effecting
      // until the permission layer can ask the server what it actually does.
      permission: 'write',
      source: 'mcp',
      handler: (args) => callMcpTool({ server: t.server, name: t.name, args }),
    });
    added.push(name);
  }
  return added;
}
