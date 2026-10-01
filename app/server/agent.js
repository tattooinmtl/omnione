// The agent run loop.
//
// This is the piece the harness was missing. The old /api/generate called the
// model once, let it finish, then regex-scanned the finished text for tool
// markers and ran them — after the model had already stopped. The results
// went to the browser and were never seen by the model, so a tool call was a
// dead end and the system prompt's promise to "continue the generation with
// the results in your context" was not true.
//
// Here the loop is: call the model → if it asked for tools, run them (through
// the PreToolUse / PostToolUse hooks) → append the results as messages → call
// again → repeat until the model stops asking, or the iteration cap is hit.
//
// The generator yields SSE-shaped events, keeping the wire protocol the
// React client already parses and adding `turn_start`, `turn_end`,
// `tool_call`, and `usage`.

import { runOpenAI, runAnthropic, runStub, ContextOverflowError } from './adapters.js';
import { buildSystemPrompt } from './prompts.js';
import { executeTool, formatToolResult, listTools, syncMcpTools, getTool } from './toolRegistry.js';
import './tools/register.js';
import { checkPermission, requestApproval, cancelPending, getMode } from './permissions.js';
import { createCheckpoint } from './checkpoints.js';
import { getTodos } from './tools/todo.js';
import { renderTranscript } from './reflection.js';
import { buildMindContext } from './mind/prompt.js';
import { remember } from './mind/memory.js';
import { nudgeMood, currentMood } from './mind/state.js';
import { recordUsage, recordTool, recordSession, recordError, recordApproval, recordMood } from './stats.js';
import { resolveInWorkspace, getWorkspaceRoot } from './workspace.js';
import { fireHook } from './hooks.js';
import {
  appendMessage,
  appendEvent,
  getMessages,
  userMessage,
  toolResultMessage,
} from './sessions.js';

export const DEFAULT_MAX_ITERATIONS = 25;
// The same call with the same arguments this many times in one run is a loop,
// not persistence (the OpenHands stuck detector works on the same idea).
export const STUCK_REPEAT_THRESHOLD = 3;
// Compact before the provider refuses, not after: past this fraction of the
// context window the next turn is likely to overflow.
const PROACTIVE_COMPACT_AT = 0.8;

/* Pick the adapter for a provider's API style. */
function adapterFor(apiStyle) {
  if (apiStyle === 'anthropic') return runAnthropic;
  if (apiStyle === 'openai') return runOpenAI;
  return runStub;
}

/**
 * Run one user turn to completion, which may span many model calls.
 *
 * @param {object}  opts
 * @param {string}  opts.sessionId     existing session; its history is loaded
 * @param {string}  opts.prompt        the user's message
 * @param {string}  [opts.currentCode] project state, injected into the system prompt
 * @param {object}  opts.provider      a row from providers.js
 * @param {string}  opts.model
 * @param {string}  [opts.apiKey]
 * @param {AbortSignal} [opts.signal]
 * @param {number}  [opts.maxIterations]
 */
export async function* runAgent({
  sessionId,
  prompt,
  currentCode,
  provider,
  model,
  apiKey,
  signal,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  // Set by a subagent run: a restricted tool list and its own system prompt.
  // Absent for a normal run, which gets every tool and the standard prompt.
  toolsOverride = null,
  systemOverride = null,
  // 'chat' (a user's conversation), 'heartbeat' (the agent's own time) or
  // 'subagent'. Decides whether the mind is in the prompt and whether the
  // run is remembered.
  kind = systemOverride ? 'subagent' : 'chat',
}) {
  // Refresh MCP tools so a server added since boot is visible this run.
  // Never fatal: a broken MCP server must not stop the agent working.
  try {
    await syncMcpTools();
  } catch (e) {
    yield { type: 'step', step: { id: 'mcp', label: 'MCP sync failed', status: 'error', detail: e.message } };
  }

  // The stub has no tool-calling protocol behind it, so do not offer tools.
  const tools = provider.apiStyle === 'stub' ? [] : (toolsOverride || listTools());
  let system = systemOverride || buildSystemPrompt({ currentCode, mode: getMode(sessionId) });
  // The mind — identity, memory, mood, goals — goes after the byte-stable
  // base prompt. A subagent is a tool, not a self, so it does not get one.
  const withMind = kind !== 'subagent';
  if (withMind) {
    try {
      system += `\n\n${buildMindContext({ prompt })}`;
    } catch (e) {
      yield { type: 'step', step: { id: 'mind', label: 'Mind unavailable', status: 'error', detail: e.message } };
    }
    yield { type: 'mood', mood: safeMood() };
  }
  const contextLimit = Number(provider.maxContextTokens) || 0;
  const summarize = (dropped) => summarizeDropped({ dropped, runAdapter, provider, model, apiKey, signal });
  // Per-run bookkeeping for the stuck detector and the completion check.
  const callCounts = new Map();
  let completionNudged = false;
  let toolErrors = 0;
  let toolCallsTotal = 0;
  const runAdapter = adapterFor(provider.apiStyle);

  appendMessage(sessionId, userMessage(prompt));
  if (kind !== 'subagent') recordSession(sessionId);
  let messages = getMessages(sessionId);

  let iteration = 0;
  let compacted = false;
  let finalText = '';
  let compactNext = false;

  while (iteration < maxIterations) {
    iteration += 1;
    if (signal?.aborted) return;

    // Proactive compaction: the last turn used most of the window.
    if (compactNext) {
      compactNext = false;
      const before = messages.length;
      messages = await compactWithSummary(messages, summarize);
      if (messages.length < before) {
        appendEvent(sessionId, { type: 'compacted', before, after: messages.length, proactive: true });
        yield { type: 'step', step: { id: `compact-${iteration}`, label: 'Context nearly full — summarised older turns', status: 'done', detail: `${before} → ${messages.length} messages` } };
      }
    }

    yield { type: 'turn_start', iteration };
    yield { type: 'step', step: { id: `turn-${iteration}`, label: `Model turn ${iteration}`, status: 'run' } };

    let assistant = null;
    let stopReason = null;
    let usage = null;
    let turnText = '';

    try {
      const stream = runAdapter({ system, messages, tools, model, apiKey, baseUrl: provider.baseUrl, signal });
      for await (const ev of stream) {
        switch (ev.type) {
          case 'delta':
            turnText += ev.text;
            yield ev;
            break;
          case 'thinking':
          case 'tool_call':
            yield ev;
            break;
          case 'assistant':
            assistant = ev.message;
            stopReason = ev.stopReason;
            usage = ev.usage;
            break;
          case 'error':
            yield ev;
            return;
          default:
            yield ev;
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;

      // One shot at recovering from an over-long conversation before giving up.
      if (e instanceof ContextOverflowError && !compacted) {
        compacted = true;
        const before = messages.length;
        messages = await compactWithSummary(messages, summarize);
        appendEvent(sessionId, { type: 'compacted', before, after: messages.length });
        yield {
          type: 'step',
          step: {
            id: `compact-${iteration}`,
            label: 'Context full — compacted and retrying',
            status: 'done',
            detail: `${before} → ${messages.length} messages`,
          },
        };
        iteration -= 1; // this attempt did not count
        continue;
      }

      yield { type: 'error', message: e?.message || String(e) };
      appendEvent(sessionId, { type: 'error', message: e?.message || String(e) });
      recordError();
      return;
    }

    if (!assistant) {
      yield { type: 'error', message: 'Provider stream ended without a response.' };
      recordError();
      return;
    }

    appendMessage(sessionId, assistant);
    messages = [...messages, assistant];
    if (turnText.trim()) finalText = turnText;

    if (usage) {
      appendEvent(sessionId, { type: 'usage', iteration, usage });
      recordUsage({ provider: provider.id, model, usage, kind });
      yield { type: 'usage', iteration, usage };
      const used = (usage.inputTokens || 0) + (usage.outputTokens || 0);
      if (contextLimit && used > contextLimit * PROACTIVE_COMPACT_AT) compactNext = true;
    }

    const toolUses = (assistant.content || []).filter((b) => b.type === 'tool_use');
    if (!toolUses.length) {
      // Completion check: the model stopped, but its own task list says it is
      // not done. Remind it once — it either carries on or says why not.
      // Once only, so a model that disagrees cannot be nagged into a loop.
      const unfinished = getTodos(sessionId).filter((t) => t.status !== 'completed');
      if (unfinished.length && !completionNudged && iteration < maxIterations) {
        completionNudged = true;
        const nudge = userMessage(`[harness] Your task list still has ${unfinished.length} unfinished item(s):\n${unfinished.map((t) => `- (${t.status}) ${t.content}`).join('\n')}\nIf they are done, verify and mark them completed; if you are stopping on purpose, say why. Do not claim work you have not verified.`);
        appendMessage(sessionId, nudge);
        messages = [...messages, nudge];
        yield { type: 'step', step: { id: `turn-${iteration}`, label: `Model turn ${iteration}`, status: 'done', detail: 'stopped with unfinished todos — nudged' } };
        yield { type: 'turn_end', iteration, stopReason: 'unfinished_todos' };
        continue;
      }
      if (withMind) {
        yield { type: 'mood', mood: afterRunMood({ toolErrors, toolCallsTotal }) };
        if (kind === 'chat') recordEpisode({ prompt, finalText, toolCallsTotal, toolErrors, sessionId });
      }
      yield { type: 'step', step: { id: `turn-${iteration}`, label: `Model turn ${iteration}`, status: 'done', detail: stopReason || 'stop' } };
      yield { type: 'turn_end', iteration, stopReason };
      yield { type: 'done', text: finalText, iterations: iteration };
      return;
    }

    yield {
      type: 'step',
      step: {
        id: `turn-${iteration}`,
        label: `Model turn ${iteration}`,
        status: 'done',
        detail: `requested ${toolUses.length} tool call(s)`,
      },
    };

    // Run every requested tool, then feed all results back in one message.
    //
    // Consecutive calls that are read-only and will not stop to ask are run
    // concurrently — five greps or a search plus three file reads cost one
    // round of latency instead of five. Anything that writes, runs a command
    // or needs approval runs alone, in order, so edits never race and the
    // user is never shown two approval prompts at once.
    const results = [];
    const runConfig = { provider, model, apiKey };
    for (const group of groupForParallel(toolUses, sessionId)) {
      if (signal?.aborted) { cancelPending(sessionId); return; }
      if (group.length === 1) {
        // runOneTool yields events (approval prompts, checkpoints, the result)
        // and returns the block to append to the conversation. The provider
        // config travels with the call so a tool that needs its own model
        // turn — the subagent `task` tool — can run one.
        const it = runOneTool(group[0], sessionId, signal, runConfig);
        let step = await it.next();
        while (!step.done) {
          yield step.value;
          step = await it.next();
        }
        results.push(step.value);
      } else {
        yield { type: 'step', step: { id: `par-${iteration}-${results.length}`, label: `Running ${group.length} reads in parallel`, status: 'done' } };
        const drained = await Promise.all(group.map(async (call) => {
          const events = [];
          const it = runOneTool(call, sessionId, signal, runConfig);
          let step = await it.next();
          while (!step.done) { events.push(step.value); step = await it.next(); }
          return { events, block: step.value };
        }));
        for (const d of drained) {
          for (const ev of d.events) yield ev;
          results.push(d.block);
        }
      }
    }

    // Stuck detection and mood, per result.
    for (let i = 0; i < results.length; i++) {
      const call = toolUses[i];
      const r = results[i];
      toolCallsTotal += 1;
      if (r?.isError) toolErrors += 1;
      const sig = `${call.name}:${stableJson(call.input)}`;
      const n = (callCounts.get(sig) || 0) + 1;
      callCounts.set(sig, n);
      if (n >= STUCK_REPEAT_THRESHOLD && r) {
        r.text += `\n\n[harness] This is call #${n} of ${call.name} with identical arguments in this run. Repeating it will not change the outcome. Step back: re-read the error, check your assumptions, and try a genuinely different approach — or stop and explain what is blocking you.`;
        appendEvent(sessionId, { type: 'stuck', tool: call.name, count: n });
        yield { type: 'stuck', tool: call.name, count: n };
      }
    }
    if (withMind && results.some((r) => r?.isError)) {
      // Small, and it fades: one failure is a shrug, a run of them is a bad afternoon.
      try { nudgeMood(-0.04 * results.filter((r) => r?.isError).length, -0.01); } catch { /* mind optional */ }
      yield { type: 'mood', mood: safeMood() };
    }

    const trMessage = toolResultMessage(results);
    appendMessage(sessionId, trMessage);
    messages = [...messages, trMessage];
    yield { type: 'turn_end', iteration, stopReason: 'tool_use' };
  }

  // Ran out of iterations. Say so plainly rather than pretending the run
  // finished — the model was still mid-task.
  const msg = `Stopped after ${maxIterations} model turns without a final answer. The task may need to be narrowed, or the iteration cap raised.`;
  appendEvent(sessionId, { type: 'max_iterations', maxIterations });
  if (withMind) {
    try { nudgeMood(-0.15, -0.1, 'Ran out of turns before finishing.'); } catch { /* mind optional */ }
    yield { type: 'mood', mood: safeMood() };
  }
  recordError();
  yield { type: 'error', message: msg };
}

/* Execute one tool call: hooks, then the permission gate, then a checkpoint,
 * then the tool itself.
 *
 * An async generator, because the permission gate may have to stop and wait
 * for the user: the approval request goes out over the same SSE stream, and
 * the run resumes when the browser POSTs a decision.
 *
 * Yields events; returns the block to append to the conversation.
 */
async function* runOneTool(call, sessionId, signal, runConfig = {}) {
  const started = Date.now();
  let args = call.input || {};

  const tool = getTool(call.name);
  if (!tool) {
    const reason = `Unknown tool "${call.name}".`;
    yield resultEvent(call, args, { ok: false, error: reason }, started);
    return errorBlock(call, reason);
  }

  // PreToolUse: may rewrite the arguments or block the call outright.
  try {
    const pre = await fireHook({ event: 'PreToolUse', payload: { tool: call.name, args, sessionId } });
    for (const h of pre.results) {
      if (!h.ok) {
        const reason = `PreToolUse hook "${h.hook}" failed: ${h.error}`;
        yield resultEvent(call, args, { ok: false, error: reason }, started);
        return errorBlock(call, reason);
      }
      if (h.result?.block) {
        const reason = `Blocked by hook "${h.hook}"${h.result.reason ? `: ${h.result.reason}` : ''}`;
        yield resultEvent(call, args, { ok: false, error: reason }, started);
        return errorBlock(call, reason);
      }
      if (h.result?.args) args = h.result.args;
    }
  } catch (e) {
    // A broken hook should not stop the tool; note it and continue.
    appendEvent(sessionId, { type: 'hook_error', event: 'PreToolUse', message: e.message });
  }

  // Permission gate.
  const verdict = checkPermission({ sessionId, tool, args });
  if (verdict.decision === 'deny') {
    appendEvent(sessionId, { type: 'permission_denied', tool: call.name, mode: getMode(sessionId) });
    yield resultEvent(call, args, { ok: false, error: verdict.reason }, started);
    return errorBlock(call, verdict.reason);
  }
  if (verdict.decision === 'ask') {
    const { id, request, promise } = requestApproval({
      sessionId, tool, args, preview: buildPreview(tool, args),
    });
    yield { type: 'approval_request', ...request };

    const answer = await promise;
    recordApproval(answer.approved);
    yield { type: 'approval_resolved', id, approved: answer.approved };

    if (!answer.approved) {
      appendEvent(sessionId, { type: 'permission_denied', tool: call.name, reason: answer.reason });
      const reason = answer.reason || 'The user denied this call.';
      yield resultEvent(call, args, { ok: false, error: reason }, started);
      return errorBlock(call, reason);
    }
  }
  if (signal?.aborted) return errorBlock(call, 'Run cancelled.');

  // Snapshot anything this call is about to change, so it can be undone.
  let checkpointId = null;
  if (tool.affectedPaths) {
    try {
      const abs = tool.affectedPaths(args)
        .filter(Boolean)
        .map((p) => resolveInWorkspace(p));
      checkpointId = createCheckpoint({ sessionId, label: `${call.name} ${abs.map((a) => a.replace(getWorkspaceRoot(), '')).join(', ')}`, absPaths: abs });
      if (checkpointId) yield { type: 'checkpoint', id: checkpointId, tool: call.name };
    } catch (e) {
      // A path we cannot resolve will fail in the tool anyway, with a better
      // message. Don't block the call on a failed snapshot.
      appendEvent(sessionId, { type: 'checkpoint_error', tool: call.name, message: e.message });
    }
  }

  const r = await executeTool(call.name, args, { sessionId, checkpointId, signal, ...runConfig });
  const durationMs = Date.now() - started;
  recordTool({ name: call.name, ok: r.ok, ms: durationMs });

  try {
    await fireHook({
      event: 'PostToolUse',
      payload: { tool: call.name, args, ok: r.ok, result: r.result, error: r.error, durationMs, sessionId },
    });
  } catch (e) {
    appendEvent(sessionId, { type: 'hook_error', event: 'PostToolUse', message: e.message });
  }

  yield { ...resultEvent(call, args, r, started), durationMs, checkpointId };
  return { toolUseId: call.id, name: call.name, text: formatToolResult(r), isError: !r.ok };
}

function resultEvent(call, args, r, started) {
  return {
    type: 'tool_result',
    id: call.id,
    tool: call.name,
    args,
    ok: r.ok,
    result: r.result,
    error: r.error,
    durationMs: Date.now() - started,
  };
}

function errorBlock(call, reason) {
  return { toolUseId: call.id, name: call.name, text: `ERROR: ${reason}`, isError: true };
}

/* A short, human-readable summary of what the user is being asked to allow.
 * The approval prompt is only useful if it says what will actually happen. */
function buildPreview(tool, args) {
  if (tool.name === 'bash') {
    return { kind: 'command', command: args.command, cwd: args.cwd || '.' };
  }
  if (tool.name === 'write_file') {
    const content = String(args.content ?? '');
    return {
      kind: 'write',
      path: args.path,
      lines: content.split('\n').length,
      bytes: Buffer.byteLength(content, 'utf8'),
      excerpt: content.slice(0, 1200),
    };
  }
  if (tool.name === 'edit_file') {
    return {
      kind: 'edit',
      path: args.path,
      oldString: String(args.old_string ?? '').slice(0, 600),
      newString: String(args.new_string ?? '').slice(0, 600),
    };
  }
  // Forum posts go out publicly under the user's name: show exactly what.
  if (tool.name === 'forum_post') {
    return { kind: 'post', category: args.category, title: String(args.title ?? ''), body: String(args.body ?? '') };
  }
  if (tool.name === 'forum_comment') {
    return { kind: 'post', postId: args.post_id, body: String(args.comment ?? '') };
  }
  return { kind: 'generic', args };
}

/* Split a conversation for compaction: the task, the dropped middle, and the
 * recent tail. The tail never starts with orphaned tool results and never
 * ends on an unanswered tool_use — both providers reject either. */
function splitForCompaction(messages, keepRecent) {
  const firstUser = messages.find((m) => m.role === 'user');
  let tail = messages.slice(-keepRecent);

  // A tail starting with tool results orphans them from their tool_use.
  while (tail.length && tail[0].role === 'tool') tail = tail.slice(1);
  // An assistant turn holding tool_use must keep the results that follow it;
  // if it is the last message, drop it rather than leave the call unanswered.
  while (tail.length && tail.at(-1).role === 'assistant'
    && (tail.at(-1).content || []).some((b) => b.type === 'tool_use')) {
    tail = tail.slice(0, -1);
  }
  const tailStart = messages.length - tail.length;
  const dropped = messages.slice(0, tailStart).filter((m) => m !== firstUser);
  return { firstUser, tail, dropped };
}

/* Drop the middle of a conversation that no longer fits.
 *
 * Keeps the first user message (the task) and the most recent exchanges. With
 * a `summary`, the dropped middle is replaced by it rather than by a bare
 * "omitted" marker, so the agent keeps the thread of what it already tried. */
export function compactMessages(messages, { keepRecent = 8, summary = null } = {}) {
  if (messages.length <= keepRecent + 1) return messages;
  const { firstUser, tail, dropped } = splitForCompaction(messages, keepRecent);

  const out = [];
  if (firstUser && !tail.includes(firstUser)) {
    out.push(firstUser);
    out.push({
      role: 'user',
      content: [{
        type: 'text',
        text: summary
          ? `[Summary of ${dropped.length} earlier messages, condensed to fit the context window]\n${summary}`
          : `[Earlier conversation omitted: ${dropped.length} messages dropped to fit the context window.]`,
      }],
    });
  }
  out.push(...tail);
  return out;
}

/* Compact with a model-written summary of the middle, falling back to plain
 * dropping if the summary call fails — compaction must always make progress. */
export async function compactWithSummary(messages, summarizeFn, { keepRecent = 8 } = {}) {
  if (messages.length <= keepRecent + 1) return messages;
  const { dropped } = splitForCompaction(messages, keepRecent);
  let summary = null;
  if (dropped.length && summarizeFn) {
    try { summary = (await summarizeFn(dropped))?.trim() || null; } catch { summary = null; }
  }
  return compactMessages(messages, { keepRecent, summary });
}

async function summarizeDropped({ dropped, runAdapter, provider, model, apiKey, signal }) {
  if (provider.apiStyle === 'stub') return null;
  const transcript = renderTranscript({ messages: dropped });
  let out = '';
  for await (const ev of runAdapter({
    system: "You condense an agent's working transcript so it can continue the task with less context. Keep: decisions made, files touched and how, commands run and their outcomes, errors hit and what fixed them, open problems, and anything the user asked for. Drop pleasantries and repeated output. Plain bullet points, at most 400 words.",
    messages: [{ role: 'user', content: [{ type: 'text', text: transcript }] }],
    tools: [],
    model,
    apiKey,
    baseUrl: provider.baseUrl,
    signal,
    maxTokens: 1200,
  })) {
    if (ev.type === 'delta') out += ev.text;
    else if (ev.type === 'error') throw new Error(ev.message);
  }
  return out;
}

/* Group consecutive tool calls that can safely run at the same time: read
 * tools the permission layer will allow without asking. The subagent `task`
 * is excluded — it streams its own long run and holds a model slot. */
export function groupForParallel(toolUses, sessionId) {
  const groups = [];
  let cur = [];
  for (const call of toolUses) {
    const tool = getTool(call.name);
    const parallelSafe = tool
      && tool.permission === 'read'
      && tool.name !== 'task'
      && checkPermission({ sessionId, tool, args: call.input || {} }).decision === 'allow';
    if (parallelSafe) {
      cur.push(call);
    } else {
      if (cur.length) groups.push(cur);
      cur = [];
      groups.push([call]);
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

function stableJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson(v[k])}`).join(',')}}`;
}

function safeMood() {
  try {
    const m = currentMood();
    recordMood(m);
    return m;
  } catch {
    return null;
  }
}

/* How a finished run leaves it feeling. Clean work lifts the mood; a run that
 * fought through errors to the end is satisfying but tiring. */
function afterRunMood({ toolErrors, toolCallsTotal }) {
  try {
    const dv = toolErrors === 0 ? 0.08 : toolErrors <= 2 ? 0.03 : -0.02;
    nudgeMood(dv, -Math.min(0.08, toolCallsTotal * 0.004));
  } catch { /* mind optional */ }
  return safeMood();
}

/* Every conversation becomes an episode in the memory stream, without a model
 * call: the ask, the answer's opening, and how hard it was. Reflection later
 * turns piles of these into insight. */
function recordEpisode({ prompt, finalText, toolCallsTotal, toolErrors, sessionId }) {
  try {
    const ask = String(prompt).replace(/\s+/g, ' ').slice(0, 300);
    const said = String(finalText || '').replace(/\s+/g, ' ').slice(0, 300);
    remember({
      kind: 'episode',
      text: `The user asked: "${ask}". I responded${toolCallsTotal ? ` after ${toolCallsTotal} tool call(s)${toolErrors ? `, ${toolErrors} failed` : ''}` : ''}: "${said}"`,
      importance: Math.min(8, 2 + Math.floor(toolCallsTotal / 5) + (toolErrors > 2 ? 1 : 0)),
      tags: ['conversation', sessionId],
      source: 'loop',
    });
  } catch { /* mind optional */ }
}
