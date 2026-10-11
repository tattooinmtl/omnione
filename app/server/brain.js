// The brain: what Omi-One has done, as a network.
//
// One neuron per conversation it has had, linked to the brain at the centre
// and to every tool it called and skill it loaded in that conversation; one
// neuron per installed tool and skill, whether used yet or not, so a path can
// light up the first time one is. Emotions are linked to the actions they
// were felt during: the Presence view reports each pairing (an emotion the
// engine was feeling when a tool ran) and the counts are kept in the mind
// folder, so the links build up across sessions.
//
// Its memories are neurons too, wired the way they are linked: memory to
// memory, memory to the topics it is about, and an episode to the
// conversation it happened in. That part is the knowledge graph, the same
// one the memory vault shows in Obsidian.
//
// Everything here is read from what already exists: the session transcripts,
// the tool registry, the skills folder and the memory stream. Nothing is
// invented.

import { listSessions, getMessages } from './sessions.js';
import { publicTools } from './toolRegistry.js';
import { getSkills } from './skills.js';
import { readJson, writeJson } from './mind/store.js';
import { allMemories, topicsOf } from './mind/memory.js';
import { titleOf, syncVault } from './mind/vault.js';
import { isValidSessionId } from './sessions.js';

const FEEL_FILE = 'brain.json';
const MAX_CONVERSATIONS = 160;
// The most important and most recent memories, so the view stays readable.
const MAX_MEMORIES = 400;
// Loading a skill is how a skill gets used; these tools name it in `name`.
export const SKILL_TOOLS = new Set(['load_skill', 'load_skill_file']);

const shortTool = (name) => String(name || '').replace(/^mcp__[^_]+__/, '');

/* What one conversation used: tool name → calls, skill name → loads. */
export function usageOf(messages) {
  const tools = new Map();
  const skills = new Map();
  for (const m of messages || []) {
    if (m?.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c?.type !== 'tool_use' || !c.name) continue;
      tools.set(c.name, (tools.get(c.name) || 0) + 1);
      const skill = SKILL_TOOLS.has(c.name) && typeof c.input?.name === 'string' ? c.input.name : '';
      if (skill) skills.set(skill, (skills.get(skill) || 0) + 1);
    }
  }
  return { tools, skills };
}

// Transcripts only grow, so a session's usage is cached until its file changes.
const usageCache = new Map();
function cachedUsage(s) {
  const hit = usageCache.get(s.id);
  if (hit && hit.updatedAt === s.updatedAt) return hit.usage;
  let usage;
  try { usage = usageOf(getMessages(s.id)); } catch { usage = { tools: new Map(), skills: new Map() }; }
  usageCache.set(s.id, { updatedAt: s.updatedAt, usage });
  return usage;
}

/* The graph, from plain inputs, so it can be tested without a disk.
 *   conversations: [{ id, title, updatedAt, usage: { tools: Map, skills: Map } }]
 *   tools: [{ name, description }]   skills: [{ name, description }]
 *   feel: { "<emotion>|<action id>": count }
 *   memories: [{ id, text, kind, importance, tags, links, createdAt }]
 */
export function buildBrainGraph({ conversations = [], tools = [], skills = [], feel = {}, memories = [] }) {
  const nodes = [{ id: 'brain', kind: 'brain', label: 'Central Brain', weight: conversations.length }];
  const links = [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const add = (n) => {
    if (!byId.has(n.id)) { byId.set(n.id, n); nodes.push(n); }
    return byId.get(n.id);
  };

  for (const t of tools) add({ id: `tool:${t.name}`, kind: 'tool', label: shortTool(t.name), detail: t.description || '', weight: 0 });
  for (const s of skills) add({ id: `skill:${s.name}`, kind: 'skill', label: s.name, detail: s.description || '', weight: 0 });

  for (const c of conversations) {
    const id = `conv:${c.id}`;
    add({ id, kind: 'conversation', label: c.title || '(untitled)', weight: 0, at: c.updatedAt });
    links.push({ source: 'brain', target: id, weight: 1 });
    for (const [name, n] of c.usage.tools) {
      // A tool that has since been removed still happened; keep its neuron.
      const t = add({ id: `tool:${name}`, kind: 'tool', label: shortTool(name), detail: '', weight: 0 });
      t.weight += n;
      links.push({ source: id, target: t.id, weight: n });
    }
    for (const [name, n] of c.usage.skills) {
      const s = add({ id: `skill:${name}`, kind: 'skill', label: name, detail: '', weight: 0 });
      s.weight += n;
      links.push({ source: id, target: s.id, weight: n });
    }
    byId.get(id).weight = c.usage.tools.size + c.usage.skills.size;
  }

  // Memories: linked to each other, to their topics and to the conversation
  // they happened in. One with none of those hangs off the brain itself.
  const shown = new Set(memories.map((m) => m.id));
  const seen = new Set();
  for (const m of memories) {
    const id = `memory:${m.id}`;
    add({ id, kind: 'memory', label: titleOf(m), detail: `${m.kind} · importance ${m.importance}`, weight: m.importance, at: m.createdAt });
  }
  for (const m of memories) {
    const id = `memory:${m.id}`;
    let wired = false;
    for (const l of m.links || []) {
      if (!shown.has(l)) continue;
      wired = true;
      const k = m.id < l ? `${m.id}|${l}` : `${l}|${m.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ source: id, target: `memory:${l}`, weight: 1 });
    }
    for (const t of topicsOf(m)) {
      const tid = `topic:${t}`;
      if (!byId.has(tid)) {
        add({ id: tid, kind: 'topic', label: t, weight: 0 });
        links.push({ source: 'brain', target: tid, weight: 1 });
      }
      byId.get(tid).weight += 1;
      links.push({ source: tid, target: id, weight: 1 });
      wired = true;
    }
    const session = (m.tags || []).find((t) => isValidSessionId(t));
    if (session && byId.has(`conv:${session}`)) {
      links.push({ source: `conv:${session}`, target: id, weight: 1 });
      wired = true;
    }
    if (!wired) links.push({ source: 'brain', target: id, weight: 1 });
  }

  // Emotion → action, as felt. Emotion nodes themselves are the engine's own
  // and are added by the view, which knows all of them.
  for (const [key, n] of Object.entries(feel || {})) {
    const [emotion, action] = key.split('|');
    if (!emotion || !action || !byId.has(action) || !(n > 0)) continue;
    links.push({ source: `emotion:${emotion}`, target: action, weight: n });
  }

  return { nodes, links };
}

export function readFeel() {
  const j = readJson(FEEL_FILE, {});
  return j && typeof j.feel === 'object' && j.feel ? j.feel : {};
}

/* Record that `emotion` was felt while `action` (a tool or skill node id)
 * ran. Ids are checked against a tight shape: they become JSON keys and are
 * echoed back to the view. */
const EMOTION_RE = /^[a-z][a-z_-]{1,30}$/;
const ACTION_RE = /^(tool|skill):[\w.:@/+-]{1,160}$/;
export function recordFeel(emotion, action) {
  if (!EMOTION_RE.test(String(emotion)) || !ACTION_RE.test(String(action))) {
    throw new Error('emotion and action must be an emotion name and a tool:/skill: id');
  }
  const j = readJson(FEEL_FILE, {}) || {};
  const feel = j.feel && typeof j.feel === 'object' ? j.feel : {};
  const key = `${emotion}|${action}`;
  feel[key] = (feel[key] || 0) + 1;
  // Bounded: keep the strongest pairings if it ever grows past this.
  const entries = Object.entries(feel);
  const kept = entries.length > 4000 ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, 3000)) : feel;
  writeJson(FEEL_FILE, { ...j, feel: kept });
  return kept[key] || feel[key];
}

export function brainGraph() {
  const conversations = listSessions({ limit: MAX_CONVERSATIONS }).map((s) => ({
    id: s.id, title: s.title, updatedAt: s.updatedAt, usage: cachedUsage(s),
  }));
  let tools = [];
  try { tools = publicTools(); } catch { /* registry not ready */ }
  let skills = [];
  try { skills = getSkills(); } catch { /* no skills folder */ }
  let memories = [];
  try {
    syncVault();
    memories = allMemories()
      .map((m, i, all) => ({ m, keep: m.importance + 6 * (i / Math.max(1, all.length)) + (m.kind === 'reflection' ? 4 : 0) }))
      .sort((a, b) => b.keep - a.keep)
      .slice(0, MAX_MEMORIES)
      .map((x) => x.m);
  } catch { /* no mind yet */ }
  return buildBrainGraph({ conversations, tools, skills, feel: readFeel(), memories });
}
