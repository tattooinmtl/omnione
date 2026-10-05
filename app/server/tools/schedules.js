// Scheduled tasks, for Omi-One: "remind me / check / summarise X every …".
//
// Adding or removing one changes what runs on its own later, so both ask the
// user first ('execute'), and a scheduled run (autonomous mode) can never
// schedule more work by itself.

import { registerTool } from '../toolRegistry.js';
import { addSchedule, listSchedules, removeSchedule, KINDS } from '../schedules.js';

const asResult = (fn) => (args) => {
  try { return { ok: true, result: fn(args) }; } catch (e) { return { ok: false, error: e.message }; }
};

registerTool({
  name: 'schedule_add',
  description: 'Set up a task that runs on its own on a schedule, in a fresh conversation: e.g. "every weekday at 08:00, summarise the news about X". It runs while OmniOne is running; commands and paid calls are refused during the run (they become proposals). The user is notified with the summary. Times are the user\'s local time.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short name shown in the list and the notification.' },
      prompt: { type: 'string', description: 'What to do each time, written as an instruction to yourself with everything needed (the run has no memory of this chat).' },
      kind: { type: 'string', enum: KINDS },
      time: { type: 'string', description: 'HH:MM, 24-hour, for daily/weekdays/weekly/monthly.' },
      weekday: { type: 'integer', minimum: 0, maximum: 6, description: 'For weekly: 0 Sunday … 6 Saturday.' },
      day: { type: 'integer', minimum: 1, maximum: 31, description: 'For monthly.' },
      at: { type: 'string', description: 'For once: local date and time, e.g. 2026-10-06T09:30.' },
      every_min: { type: 'integer', minimum: 15, description: 'For interval: minutes between runs.' },
      max_turns: { type: 'integer', minimum: 3, maximum: 100, description: 'Step limit per run. Default 30.' },
    },
    required: ['prompt', 'kind'],
  },
  handler: asResult((a) => addSchedule({
    title: a.title,
    prompt: a.prompt,
    maxTurns: a.max_turns,
    schedule: { kind: a.kind, time: a.time, weekday: a.weekday, day: a.day, at: a.at, everyMin: a.every_min },
  })),
});

registerTool({
  name: 'schedule_list',
  description: 'List the scheduled tasks (with when they run next) and the latest runs with their summaries.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: asResult(() => {
    const { tasks, runs } = listSchedules();
    return {
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, when: t.when, enabled: t.enabled, nextRunAt: t.nextRunAt && new Date(t.nextRunAt).toLocaleString() })),
      recentRuns: runs.slice(0, 10).map((r) => ({ title: r.title, at: new Date(r.startedAt).toLocaleString(), ok: r.ok, summary: r.summary?.slice(0, 400), error: r.error })),
    };
  }),
});

registerTool({
  name: 'schedule_remove',
  description: 'Delete a scheduled task by id (see schedule_list).',
  permission: 'execute',
  schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  handler: asResult(({ id }) => { removeSchedule(String(id)); return { removed: id }; }),
});
