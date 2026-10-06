// Provider adapters.
//
// Each adapter is an async generator over ONE model call. It takes the
// neutral message format from sessions.js, translates to the provider's
// wire format, streams the response, and finishes by yielding the assistant
// message in neutral form so the agent loop can append it and decide whether
// to continue.
//
// Events yielded:
//   { type: 'thinking',  text }               reasoning tokens, where exposed
//   { type: 'delta',     text }               assistant text, token by token
//   { type: 'tool_call', id, name, input }    a complete tool request
//   { type: 'assistant', message, stopReason, usage }   always last on success
//   { type: 'error',     message }            terminal
//
// The previous version of this file supported neither tools nor history: it
// built a fresh [system, user] array per call and parsed tool requests out of
// HTML comments after the fact, which meant the model never saw a result.

import { toOpenAITools, toAnthropicTools } from './toolRegistry.js';
import { pickStubTemplate } from './stubTemplates.js';
import { readImage } from './attachments.js';
import { agentSettings } from './agentConfig.js';

/* Pictures re-sent on every turn cost tokens each time, so only the newest
 * few go as pictures; older ones become a line saying where they are. */
const MAX_IMAGES_SENT = 8;

const MAX_RETRIES = 3;
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/* Thrown when the provider says the conversation no longer fits. The agent
 * loop catches this specifically so it can compact and retry once. */
export class ContextOverflowError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContextOverflowError';
  }
}

/* POST with exponential backoff on the statuses that are worth retrying.
 * An overloaded provider is the single most common way a long agent run dies
 * halfway, and a bare fetch gives up on the first 429. */
async function fetchWithRetry(url, init, { signal, maxRetries = agentSettings().retries ?? MAX_RETRIES } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    let resp;
    try {
      resp = await fetch(url, init);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      lastErr = e;
      if (attempt === maxRetries) break;
      await backoff(attempt, null, signal);
      continue;
    }
    if (resp.ok) return resp;

    const body = await resp.text().catch(() => '');
    if (isContextOverflow(resp.status, body)) {
      throw new ContextOverflowError(body.slice(0, 300) || `HTTP ${resp.status}`);
    }
    if (!RETRYABLE_STATUS.has(resp.status) || attempt === maxRetries) {
      const err = new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
      err.status = resp.status;
      throw err;
    }
    await backoff(attempt, resp.headers.get('retry-after'), signal);
  }
  throw lastErr || new Error('Request failed');
}

function isContextOverflow(status, body) {
  if (status !== 400 && status !== 413) return false;
  return /context[_ ]length|too many tokens|maximum context|prompt is too long|request too large/i.test(body);
}

function backoff(attempt, retryAfterHeader, signal) {
  const headerMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : NaN;
  const base = Number.isFinite(headerMs) ? headerMs : Math.min(1000 * 2 ** attempt, 16000);
  // Jitter, so parallel runs do not synchronise their retries.
  const ms = base + Math.random() * 250;
  return sleep(ms, signal);
}

// --- tool calls and results, always in pairs ----------------------------------

/* Every provider requires each assistant tool call to be answered by its
 * result in the very next message (MiniMax: error 2013, "tool call result
 * does not follow tool call"). A saved conversation can break that: a run
 * stopped mid-tool, a server restart during an approval, a tool that threw.
 * One broken spot would then fail every later message in that chat, so the
 * history is repaired on the way out:
 *   - results scattered over several tool messages are gathered into one,
 *     right after their call;
 *   - a call with no result gets one saying it never ran;
 *   - results with no call right before them are dropped.
 * The saved session is left as it was. */
export function repairToolPairs(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool') continue; // reached only when orphaned
    out.push(m);
    if (m.role !== 'assistant') continue;
    const calls = blocks(m).filter((b) => b.type === 'tool_use');
    if (!calls.length) continue;
    const found = new Map();
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      for (const b of blocks(messages[j])) if (b.toolUseId) found.set(b.toolUseId, b);
      j++;
    }
    out.push({
      role: 'tool',
      content: calls.map((c) => found.get(c.id) || {
        type: 'tool_result',
        toolUseId: c.id,
        name: c.name,
        text: 'ERROR: Not run: the earlier run stopped before this tool finished.',
        isError: true,
      }),
    });
    i = j - 1;
  }
  return out;
}

// --- neutral -> OpenAI -----------------------------------------------------

export function toOpenAIMessages(system, messages, { images = false } = {}) {
  const out = [{ role: 'system', content: system }];
  const pics = imagePicker(messages, images);
  for (const m of repairToolPairs(messages)) {
    if (m.role === 'user') {
      const parts = userParts(m, pics);
      const onlyText = parts.every((p) => p.kind === 'text');
      out.push({
        role: 'user',
        content: onlyText
          ? parts.map((p) => p.text).join('\n')
          : parts.map((p) => (p.kind === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } })),
      });
    } else if (m.role === 'assistant') {
      const text = textFrom(m);
      const toolUses = blocks(m).filter((b) => b.type === 'tool_use');
      const msg = { role: 'assistant', content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((b) => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      // OpenAI wants one message per result, each keyed to its call id. Tool
      // messages carry text only, so pictures a tool returned follow as one
      // user message after the results.
      const extra = [];
      for (const b of blocks(m)) {
        const imgs = toolImages(b, pics);
        out.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.text + imgs.notes });
        extra.push(...imgs.loaded);
      }
      if (extra.length) {
        out.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Pictures returned by the tool calls above:' },
            ...extra.map((p) => ({ type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } })),
          ],
        });
      }
    }
  }
  return out;
}

/* Decides which picture blocks are sent as pictures: the newest
 * MAX_IMAGES_SENT, and none when the model can't see. */
function imagePicker(messages, enabled) {
  const send = new Set();
  if (!enabled) return { send, enabled };
  const all = [];
  for (const m of messages) {
    for (const b of blocks(m)) {
      if (b.type === 'image') all.push(b);
      if (b.type === 'tool_result') for (const i of b.images || []) all.push(i);
    }
  }
  for (const b of all.slice(-(agentSettings().imagesKept || MAX_IMAGES_SENT))) send.add(b);
  return { send, enabled };
}

function imageNote(b, pics) {
  const where = b.path ? ` at ${b.path}` : '';
  return pics.enabled
    ? `[Earlier picture${where}, not re-sent; use view_image to look again]`
    : `[Picture${where}: the current model can't see pictures. Say so, and suggest a model that can (MiniMax-M3, gpt-4o, Claude).]`;
}

/* A user message as ordered parts: {kind:'text', text} or {kind:'image', mediaType, data}. */
function userParts(m, pics) {
  const parts = [];
  for (const b of blocks(m)) {
    if (b.type === 'text' && b.text) parts.push({ kind: 'text', text: b.text });
    else if (b.type === 'image') {
      const img = pics.send.has(b) ? readImage(b.path) : null;
      if (img) parts.push({ kind: 'image', ...img });
      else parts.push({ kind: 'text', text: pics.send.has(b) ? `[Picture at ${b.path} is no longer there]` : imageNote(b, pics) });
    }
  }
  if (!parts.length) parts.push({ kind: 'text', text: '' });
  return parts;
}

/* Pictures attached to one tool result: those that load, plus text notes for the rest. */
function toolImages(b, pics) {
  const loaded = [];
  let notes = '';
  for (const i of b.images || []) {
    const img = pics.send.has(i) ? readImage(i.path) : null;
    if (img) loaded.push(img);
    else notes += `
${imageNote(i, pics)}`;
  }
  return { loaded, notes };
}

// --- neutral -> Anthropic --------------------------------------------------

export function toAnthropicMessages(messages, { images = false } = {}) {
  const out = [];
  const pics = imagePicker(messages, images);
  for (const m of repairToolPairs(messages)) {
    if (m.role === 'user') {
      out.push({
        role: 'user',
        content: userParts(m, pics).map((p) => (p.kind === 'text'
          ? { type: 'text', text: p.text || ' ' }
          : { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } })),
      });
    } else if (m.role === 'assistant') {
      const content = [];
      for (const b of blocks(m)) {
        if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
        else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
      }
      // Anthropic rejects an empty content array.
      if (content.length) out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      // Anthropic carries tool results in a user-role message, and a result
      // may hold pictures directly.
      out.push({
        role: 'user',
        content: blocks(m).map((b) => {
          const imgs = toolImages(b, pics);
          const text = b.text + imgs.notes;
          return {
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: imgs.loaded.length
              ? [{ type: 'text', text }, ...imgs.loaded.map((p) => ({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }))]
              : text,
            ...(b.isError ? { is_error: true } : {}),
          };
        }),
      });
    }
  }
  return out;
}

function blocks(m) {
  if (!m?.content) return [];
  return Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
}

function textFrom(m) {
  return blocks(m).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// --- OpenAI (and OpenAI-compatible: MiniMax) -------------------------------

export async function* runOpenAI({ system, messages, tools, model, apiKey, baseUrl, signal, maxTokens, images = false, temperature = null }) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/chat/completions`;
  const body = {
    model,
    messages: toOpenAIMessages(system, messages, { images }),
    stream: true,
    stream_options: { include_usage: true },
    // Settings → AI → Creativity; 0.7 when left at the default.
    temperature: typeof temperature === 'number' ? temperature : 0.7,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(tools?.length ? { tools: toOpenAITools(tools), tool_choice: 'auto' } : {}),
  };

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  }, { signal });

  let text = '';
  let usage = null;
  let stopReason = null;
  // tool_calls stream in fragments keyed by index; arguments arrive as a
  // partial JSON string that is only parseable once the stream ends.
  const partials = new Map();

  for await (const data of sseLines(resp, signal)) {
    if (data === '[DONE]') break;
    let obj;
    try { obj = JSON.parse(data); } catch { continue; }

    if (obj.usage) usage = normalizeUsage(obj.usage);
    const choice = obj.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) stopReason = choice.finish_reason;

    const delta = choice.delta || {};
    const reasoning = delta.reasoning_content ?? choice.reasoning_content;
    if (reasoning) yield { type: 'thinking', text: String(reasoning) };

    // Some OpenAI-compatible servers (MiniMax among them) occasionally send
    // a whole message rather than a delta.
    const chunk = delta.content ?? (choice.message?.content && !delta.content ? choice.message.content : '');
    if (chunk) {
      text += chunk;
      yield { type: 'delta', text: chunk };
    }

    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      if (!partials.has(idx)) partials.set(idx, { id: '', name: '', args: '' });
      const p = partials.get(idx);
      if (tc.id) p.id = tc.id;
      if (tc.function?.name) p.name += tc.function.name;
      if (tc.function?.arguments) p.args += tc.function.arguments;
    }
  }

  const toolUses = [];
  for (const p of partials.values()) {
    if (!p.name) continue;
    toolUses.push({ type: 'tool_use', id: p.id || `call_${toolUses.length}`, name: p.name, input: parseArgs(p.args) });
    yield { type: 'tool_call', id: p.id, name: p.name, input: parseArgs(p.args) };
  }

  yield {
    type: 'assistant',
    message: { role: 'assistant', content: assembleContent(text, toolUses) },
    stopReason: toolUses.length ? 'tool_use' : (stopReason || 'stop'),
    usage,
  };
}

// --- Anthropic -------------------------------------------------------------

export async function* runAnthropic({ system, messages, tools, model, apiKey, baseUrl, signal, maxTokens, images = false, temperature = null }) {
  const url = `${String(baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '')}/messages`;
  const body = {
    model,
    max_tokens: maxTokens || 8192,
    stream: true,
    // An array with cache_control lets Anthropic reuse the system prompt (and
    // the skill index inside it) across every turn of a run. Without it, a
    // long tool loop re-bills the full prefix on each iteration.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: toAnthropicMessages(messages, { images }),
    ...(typeof temperature === 'number' ? { temperature } : {}),
    ...(tools?.length ? { tools: toAnthropicTools(tools) } : {}),
  };

  const resp = await fetchWithRetry(url, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  }, { signal });

  let text = '';
  let usage = null;
  let stopReason = null;
  const open = new Map(); // content block index -> { type, id, name, json }

  for await (const data of sseLines(resp, signal)) {
    let obj;
    try { obj = JSON.parse(data); } catch { continue; }

    switch (obj.type) {
      case 'message_start':
        if (obj.message?.usage) usage = normalizeUsage(obj.message.usage);
        break;

      case 'content_block_start': {
        const cb = obj.content_block || {};
        if (cb.type === 'tool_use') {
          open.set(obj.index, { type: 'tool_use', id: cb.id, name: cb.name, json: '' });
        } else {
          open.set(obj.index, { type: cb.type });
        }
        break;
      }

      case 'content_block_delta': {
        const d = obj.delta || {};
        if (d.type === 'text_delta' && d.text) {
          text += d.text;
          yield { type: 'delta', text: d.text };
        } else if (d.type === 'thinking_delta' && d.thinking) {
          yield { type: 'thinking', text: d.thinking };
        } else if (d.type === 'input_json_delta') {
          const slot = open.get(obj.index);
          if (slot) slot.json += d.partial_json || '';
        }
        break;
      }

      case 'message_delta':
        if (obj.delta?.stop_reason) stopReason = obj.delta.stop_reason;
        if (obj.usage) usage = { ...(usage || {}), ...normalizeUsage(obj.usage) };
        break;

      case 'error':
        yield { type: 'error', message: obj.error?.message || 'Anthropic stream error' };
        return;

      case 'message_stop':
        break;

      default:
        break;
    }
  }

  const toolUses = [];
  for (const slot of open.values()) {
    if (slot.type !== 'tool_use') continue;
    const input = parseArgs(slot.json);
    toolUses.push({ type: 'tool_use', id: slot.id, name: slot.name, input });
    yield { type: 'tool_call', id: slot.id, name: slot.name, input };
  }

  yield {
    type: 'assistant',
    message: { role: 'assistant', content: assembleContent(text, toolUses) },
    stopReason: stopReason || (toolUses.length ? 'tool_use' : 'end_turn'),
    usage,
  };
}

// --- stub (OmniOne Local) ------------------------------------------------------

export async function* runStub({ messages, signal }) {
  // The stub has no model behind it, so it cannot call tools. It exists so
  // the whole pipeline stays exercisable with no API key.
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const prompt = textFrom(lastUser || {});
  const tpl = pickStubTemplate(prompt);

  let text = '';
  for (const chunk of tpl.text.match(/[\s\S]{1,160}/g) || []) {
    await sleep(40, signal);
    text += chunk;
    yield { type: 'delta', text: chunk };
  }
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stopReason: 'stop',
    usage: null,
  };
}

// --- shared helpers --------------------------------------------------------

/* Iterate the `data:` payloads of an SSE response body. */
async function* sseLines(resp, signal) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          yield line.slice(5).trim();
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

function assembleContent(text, toolUses) {
  const content = [];
  if (text) content.push({ type: 'text', text });
  content.push(...toolUses);
  // Never hand back an empty content array — both providers reject one on
  // the next turn.
  if (!content.length) content.push({ type: 'text', text: '' });
  return content;
}

/* Tool arguments arrive as a streamed JSON string. A model can emit malformed
 * JSON; returning {} rather than throwing lets the tool report a useful error
 * back to the model instead of killing the run. */
function parseArgs(s) {
  const t = String(s || '').trim();
  if (!t) return {};
  try { return JSON.parse(t); } catch { return {}; }
}

function normalizeUsage(u) {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens ?? u.prompt_tokens ?? null,
    outputTokens: u.output_tokens ?? u.completion_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    cacheWriteTokens: u.cache_creation_input_tokens ?? null,
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        return reject(new DOMException('Aborted', 'AbortError'));
      }
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
  });
}
