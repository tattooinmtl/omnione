// Todo tool.
//
// A task list the model maintains for itself across a multi-turn run. Without
// one, a long task drifts: the model finishes step two, forgets steps four
// and five existed, and declares victory. Writing the plan down and ticking
// it off is the cheapest fix, and it doubles as the progress display for the
// human watching the trace panel.
//
// The list is per session and lives in memory: it describes the current run,
// not a durable record, and a stale list restored from disk three days later
// would be worse than no list at all.

import { registerTool } from '../toolRegistry.js';

/** @type {Map<string, Array<{content: string, status: string, activeForm?: string}>>} */
const lists = new Map();

const STATUSES = ['pending', 'in_progress', 'completed'];

export function getTodos(sessionId) {
  return lists.get(sessionId) || [];
}

export function clearTodos(sessionId) {
  lists.delete(sessionId);
}

registerTool({
  name: 'todo_write',
  description: 'Record or update your task list for the current job. Use it for any task with three or more steps: write the whole plan first, then mark exactly one item in_progress as you work and completed the moment it is done. Send the full list each time — it replaces the previous one.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The complete task list, in order.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The task, in the imperative: "Wire the serial monitor".' },
            activeForm: { type: 'string', description: 'The same task in progress form, shown while it runs: "Wiring the serial monitor".' },
            status: { type: 'string', enum: STATUSES },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  handler: async ({ todos }, ctx = {}) => {
    if (!Array.isArray(todos)) return { ok: false, error: 'todos must be an array.' };

    const cleaned = [];
    for (const [i, t] of todos.entries()) {
      const content = String(t?.content ?? '').trim();
      if (!content) return { ok: false, error: `Task ${i + 1} has no content.` };
      const status = String(t?.status ?? 'pending');
      if (!STATUSES.includes(status)) {
        return { ok: false, error: `Task ${i + 1} has status "${status}". Use one of: ${STATUSES.join(', ')}.` };
      }
      cleaned.push({ content, status, activeForm: String(t?.activeForm ?? content).trim() });
    }

    // One in-progress item at a time. A model that marks five things
    // in_progress is not tracking work, it is narrating.
    const running = cleaned.filter((t) => t.status === 'in_progress');
    if (running.length > 1) {
      return {
        ok: false,
        error: `${running.length} tasks are marked in_progress. Exactly one task may be in progress at a time.`,
      };
    }

    lists.set(ctx.sessionId || '_', cleaned);
    const done = cleaned.filter((t) => t.status === 'completed').length;
    return {
      ok: true,
      result: {
        total: cleaned.length,
        completed: done,
        remaining: cleaned.length - done,
        current: running[0]?.activeForm || null,
      },
    };
  },
});

registerTool({
  name: 'todo_read',
  description: 'Read back the current task list. Use it if you have lost track of what is left.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: async (_args, ctx = {}) => {
    const todos = getTodos(ctx.sessionId || '_');
    return { ok: true, result: { count: todos.length, todos } };
  },
});
