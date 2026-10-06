// The `task` tool — delegate a sub-job to a subagent.
//
// Runs a nested agent loop in its own session with its own tool subset, and
// returns only the final summary. The parent pays one tool result for work
// that might have cost it twenty.
//
// agent.js is imported lazily inside the handler: this module is loaded by
// tools/register.js, which agent.js itself imports, so a static import here
// would close the cycle.

import { registerTool, listTools } from '../toolRegistry.js';
import { createSession, deleteSession, textOf } from '../sessions.js';
import { getAgents, getAgent, toolsForAgent, DEFAULT_SUBAGENT_ITERATIONS } from '../subagent.js';
import { getWorkspaceRoot } from '../workspace.js';
import { acquireSlot } from '../agentSlots.js';
import { agentSettings } from '../agentConfig.js';

const MAX_SUMMARY_CHARS = 12_000;

registerTool({
  name: 'task',
  description: 'Delegate a self-contained sub-job to a subagent, which works in its own context and reports back a summary. Use it for open-ended searching or investigation that would otherwise fill your context with dozens of reads. Give it everything it needs in one prompt — it cannot ask you follow-up questions. To split independent work (research several topics, inspect several folders), call task several times in the same turn: read-only subagents run at the same time, up to the limit in Settings (4 by default).',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: 'Which subagent to use. Call with no arguments first if you are unsure what is available.',
        default: 'explore',
      },
      prompt: {
        type: 'string',
        description: 'The complete instruction for the subagent, including what to report back.',
      },
      max_iterations: {
        type: 'integer',
        description: `Model turns the subagent may take. Default ${DEFAULT_SUBAGENT_ITERATIONS}.`,
      },
    },
    required: ['prompt'],
  },
  handler: async ({ agent: agentName = 'explore', prompt, max_iterations: maxIterations }, ctx = {}) => {
    if (!prompt || !String(prompt).trim()) {
      return { ok: false, error: 'prompt is required — describe the whole sub-job.' };
    }

    // The provider config rides along on ctx from the parent run. Without it
    // there is no model to call, which is the case when a tool is invoked
    // directly over /api/tools/run rather than by the agent.
    const { provider, model, apiKey, signal, sessionId: parentSessionId } = ctx;
    if (!provider) {
      return { ok: false, error: 'The task tool can only be used inside an agent run.' };
    }
    if (provider.apiStyle === 'stub') {
      return { ok: false, error: 'The local stub provider cannot run subagents. Configure a real provider in Settings.' };
    }

    const agent = getAgent(agentName);
    if (!agent) {
      return {
        ok: false,
        error: `No subagent "${agentName}". Available: ${getAgents().map((a) => `${a.name} (${a.description})`).join('; ')}`,
      };
    }

    const tools = toolsForAgent(agent, listTools());
    const cap = Number(maxIterations) > 0
      ? Math.min(Number(maxIterations), 40)
      : (agentSettings().subagentSteps || DEFAULT_SUBAGENT_ITERATIONS);

    const childId = createSession({
      title: `[${agent.name}] ${String(prompt).slice(0, 100)}`,
      provider: provider.id,
      model,
      workspaceRoot: safeWorkspaceRoot(),
      sessionKind: 'subagent',
      parentSessionId: parentSessionId || '',
    });

    const { runAgent } = await import('../agent.js');

    let summary = '';
    let iterations = 0;
    let failure = null;
    const toolsUsed = [];

    // One model slot per subagent, shared by every run (see agentSlots.js).
    let release;
    try {
      release = await acquireSlot(signal);
    } catch {
      deleteSession(childId);
      return { ok: false, error: 'Run cancelled.' };
    }

    try {
      for await (const ev of runAgent({
        sessionId: childId,
        prompt: String(prompt),
        provider,
        model,
        apiKey,
        signal,
        maxIterations: cap,
        toolsOverride: tools,
        systemOverride: buildSubagentPrompt(agent),
      })) {
        if (ev.type === 'turn_start') iterations = ev.iteration;
        else if (ev.type === 'tool_call') toolsUsed.push(ev.name);
        else if (ev.type === 'done') summary = ev.text || '';
        else if (ev.type === 'error') failure = ev.message;
      }
    } catch (e) {
      if (e?.name === 'AbortError') {
        // Leave no orphan transcript behind for a run nobody waited for.
        deleteSession(childId);
        return { ok: false, error: 'Run cancelled.' };
      }
      failure = e?.message || String(e);
    } finally {
      release();
    }

    if (failure && !summary) {
      return { ok: false, error: `Subagent "${agent.name}" failed: ${failure}`, result: { sessionId: childId } };
    }
    if (!summary.trim()) {
      return {
        ok: false,
        error: `Subagent "${agent.name}" finished without reporting anything after ${iterations} turn(s). Its transcript is ${childId}.`,
      };
    }

    return {
      ok: true,
      result: {
        agent: agent.name,
        summary: summary.length > MAX_SUMMARY_CHARS
          ? `${summary.slice(0, MAX_SUMMARY_CHARS)}\n…(truncated)`
          : summary,
        iterations,
        toolsUsed: [...new Set(toolsUsed)],
        // Kept so a human — or the reflection pass — can audit what it did.
        sessionId: childId,
      },
    };
  },
});

/* A subagent gets its own system prompt: it has no preview pane, no file
 * marker format to honour, and one job — answer and stop. */
function buildSubagentPrompt(agent) {
  let out = agent.prompt;
  try {
    out += `\n\nWORKSPACE ROOT: ${getWorkspaceRoot()}`;
  } catch { /* workspace unusable; omit */ }
  out += `

You are running as a subagent. You were given one instruction and you cannot
ask follow-up questions — work with what you have. Your final message is the
only thing the calling agent will see, so make it a complete answer rather
than a note about what you did. Do not emit file markers.`;
  return out;
}

function safeWorkspaceRoot() {
  try { return getWorkspaceRoot(); } catch { return ''; }
}

export { textOf };
