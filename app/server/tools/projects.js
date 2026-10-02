// Projects, as tools: the user can just say "start a new project called X"
// or "switch to the ESP32 project". See ../projects.js.
//
// The switch takes effect from the next message: the chat window notices and
// opens that project (its own notes, goals and chats).

import { registerTool } from '../toolRegistry.js';
import { listProjects, activeProject, createProject, switchProject, ProjectError } from '../projects.js';

const wrap = (fn) => async (args = {}) => {
  try { return { ok: true, result: fn(args) }; } catch (e) {
    if (e instanceof ProjectError) return { ok: false, error: e.message };
    throw e;
  }
};

registerTool({
  name: 'project_list',
  description: "The user's projects (separate threads of work, each with its own notes, goals and chats) and which one is open. No project open = a general conversation.",
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: wrap(() => ({ open: activeProject()?.name || null, projects: listProjects().map((p) => p.name) })),
});

registerTool({
  name: 'project_create',
  description: 'Create a new project and open it, when the user starts a distinct piece of work or asks for one. Give it a short name and, optionally, starting notes (goal, hardware, decisions). Its notes become your "project" memory block while it is open.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short name, e.g. "Weather station" or "Website redesign".' },
      notes: { type: 'string', description: 'Starting notes for the project (optional).' },
    },
    required: ['name'],
  },
  handler: wrap(({ name, notes = '' }) => {
    const p = createProject({ name, notes, open: true });
    return { created: p.name, open: true, note: 'It is open from the user\'s next message: a fresh chat with this project\'s notes and goals.' };
  }),
});

registerTool({
  name: 'project_switch',
  description: 'Open another project by name, or none ("") to go back to a general conversation. Use when the user asks to work on a different project.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'Project name (a close match works), or "" for no project.' } },
    required: ['name'],
  },
  handler: wrap(({ name }) => {
    const p = switchProject(name ? name : null);
    return { open: p ? p.name : null, note: p ? `"${p.name}" opens from the user's next message, with its own notes, goals and chats.` : 'No project open from the next message: a general conversation.' };
  }),
});
