// Skill tools.
//
// The skills folder, its scanner, its API and its browser UI all existed, but
// the agent could not reach any of it: there was no tool, and the only way a
// skill ever entered context was the user manually pasting one in with
// `/run <name>`. The system prompt even referred to `[SKILL: ...]` blocks the
// model had no way to obtain. So the feature was half-built — a database the
// agent was blind to.
//
// Two tools rather than one, deliberately. Skill bodies are long; loading
// every one into every request would waste most of the context window on
// instructions for tasks the user did not ask about. `list_skills` is cheap
// and tells the model what exists; `load_skill` pulls one body in on demand.
// The index also goes into the system prompt (see prompts.js) so the model
// knows to look without spending a turn to find out.

import fs from 'node:fs';
import path from 'node:path';
import { registerTool } from '../toolRegistry.js';
import { getSkills, getSkill, SKILLS_DIR } from '../skills.js';

const MAX_SKILL_BODY = 60_000;
const MAX_SKILL_FILE = 40_000;

registerTool({
  name: 'list_skills',
  description: 'List the installed skills — each is a set of instructions for a particular kind of task. Returns names and descriptions only; use load_skill to read one.',
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: async () => {
    const skills = getSkills().map((s) => ({ name: s.name, description: s.description }));
    return { ok: true, result: { count: skills.length, skills } };
  },
});

registerTool({
  name: 'load_skill',
  description: 'Read a skill\'s full instructions by name. Do this when a skill from list_skills matches the task, then follow its instructions.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name, exactly as list_skills reported it.' },
    },
    required: ['name'],
  },
  handler: async ({ name }) => {
    const skill = getSkill(name);
    if (!skill) {
      const available = getSkills().map((s) => s.name);
      return {
        ok: false,
        error: `No skill named "${name}". Installed: ${available.join(', ') || '(none)'}`,
      };
    }
    const body = skill.body.length > MAX_SKILL_BODY
      ? `${skill.body.slice(0, MAX_SKILL_BODY)}\n…(truncated)`
      : skill.body;

    // Many skills ship supporting files next to SKILL.md. Name them so the
    // model knows it can ask for one rather than guessing at their contents.
    let files = [];
    try {
      files = listSkillFiles(skill.path);
    } catch { /* unreadable skill folder; the body is the useful part */ }

    return {
      ok: true,
      result: {
        name: skill.name,
        description: skill.description,
        body,
        ...(files.length ? { files, note: 'Read one with load_skill_file.' } : {}),
      },
    };
  },
});

registerTool({
  name: 'load_skill_file',
  description: 'Read one of a skill\'s supporting files, as listed by load_skill.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name.' },
      file: { type: 'string', description: 'The file path relative to the skill folder, as listed by load_skill.' },
    },
    required: ['name', 'file'],
  },
  handler: async ({ name, file }) => {
    const skill = getSkill(name);
    if (!skill) return { ok: false, error: `No skill named "${name}".` };

    // The skill folder is the boundary. `file` comes from the model, so it is
    // untrusted even though the listing it came from was ours.
    const root = path.resolve(skill.path);
    const abs = path.resolve(root, String(file));
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      return { ok: false, error: `"${file}" is outside the skill folder.` };
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return { ok: false, error: `No such file in skill "${name}": ${file}` };
    }
    const raw = fs.readFileSync(abs, 'utf8');
    return {
      ok: true,
      result: {
        skill: name,
        file: path.relative(root, abs).split(path.sep).join('/'),
        content: raw.length > MAX_SKILL_FILE ? `${raw.slice(0, MAX_SKILL_FILE)}\n…(truncated)` : raw,
      },
    };
  },
});

/* The supporting files in a skill folder, relative and forward-slashed.
 * SKILL.md itself is excluded — load_skill already returned it. */
function listSkillFiles(dir, { maxEntries = 60 } = {}) {
  const root = path.resolve(dir);
  const out = [];
  const queue = [root];
  while (queue.length && out.length < maxEntries) {
    const current = queue.shift();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (out.length >= maxEntries) break;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        queue.push(abs);
        continue;
      }
      if (/^SKILL\.md$/i.test(entry.name) && current === root) continue;
      out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

/* A compact index for the system prompt: one line per skill. Cheap enough to
 * send every turn, and it is what makes the model aware skills exist at all.
 * Returns '' when nothing is installed, so the prompt stays byte-stable
 * rather than growing an empty section. */
export function buildSkillIndex() {
  const skills = getSkills();
  if (!skills.length) return '';
  const lines = skills.map((s) => {
    const desc = (s.description || '').replace(/\s+/g, ' ').trim();
    return `- ${s.name}${desc ? `: ${desc.slice(0, 160)}` : ''}`;
  });
  return `INSTALLED SKILLS (call load_skill to read one in full before following it):\n${lines.join('\n')}`;
}

export { SKILLS_DIR };
