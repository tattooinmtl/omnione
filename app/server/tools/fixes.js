// Omi-One prepares fixes; you accept them. See ../fixes.js.
//
// There is deliberately no tool to apply a fix: only you can, from Doctor &
// fixes. Preparing one changes nothing on the PC.

import { registerTool } from '../toolRegistry.js';
import { proposeFix, listFixes, pendingCount } from '../fixes.js';
import { AccessError } from '../pcAccess.js';

const MAX_PENDING = 20;

registerTool({
  name: 'propose_fix',
  description: [
    'Prepare a fix for something outside your own folder (found with pc_diag, pc_read_file, etc.).',
    'It is NOT applied: it waits in "Doctor & fixes" until the user reads it and presses Apply.',
    'Steps run in order and stop at the first failure; files and settings are backed up so the user can undo.',
    'Step kinds: edit_file {path, old_string, new_string} (old_string must appear exactly once),',
    'write_file {path, content}, recycle {path} (Recycle Bin, never a hard delete),',
    'set_env {name, value|null} (the user\'s own variables), path_add {entry} / path_remove {entry} (the user\'s PATH),',
    'run_command {command, cwd?}. Paths are full paths. Windows\' own folders, other users\' files and secrets are refused.',
    'Keep each fix to one problem, explain why in plain words, and tell the user it is waiting for them.',
  ].join(' '),
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Short title, e.g. "Remove 2 dead folders from your PATH".' },
      why: { type: 'string', description: 'Plain explanation: what is wrong, what the fix does, any risk.' },
      findings: { type: 'array', items: { type: 'string' }, description: 'The findings this fixes (optional).' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['edit_file', 'write_file', 'recycle', 'set_env', 'path_add', 'path_remove', 'run_command'] },
            note: { type: 'string', description: 'What this step does, in a few words.' },
            path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, content: { type: 'string' },
            name: { type: 'string' }, value: { type: ['string', 'null'] }, entry: { type: 'string' },
            command: { type: 'string' }, cwd: { type: 'string' },
          },
          required: ['kind'],
        },
      },
    },
    required: ['title', 'why', 'steps'],
  },
  handler: async (args) => {
    if (pendingCount() >= MAX_PENDING) return { ok: false, error: `There are already ${MAX_PENDING} fixes waiting. Ask the user to review them first.` };
    try {
      const fix = proposeFix(args);
      return { ok: true, result: { id: fix.id, status: 'pending', steps: fix.steps.length, message: 'Prepared. Nothing has changed yet: it is waiting for the user in Doctor & fixes.' } };
    } catch (e) {
      if (e instanceof AccessError) return { ok: false, error: e.message };
      throw e;
    }
  },
});

registerTool({
  name: 'list_fixes',
  description: 'The fixes you prepared and what happened to them (pending, applied, failed, rejected, undone), with each step\'s result.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: async () => ({
    ok: true,
    result: listFixes().slice(0, 30).map((f) => ({
      id: f.id, title: f.title, status: f.status, createdAt: f.createdAt,
      results: (f.results || []).map((r) => ({ step: r.step + 1, ok: r.ok, output: String(r.output || '').slice(0, 600) })),
    })),
  }),
});
