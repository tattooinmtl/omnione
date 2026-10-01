// The mind, rendered into the system prompt.
//
// Identity (SOUL.md) first, then core memory, then how it feels and what it
// is working toward, then the latest journal lines and whatever long-term
// memories the current message brings to mind. This is appended after the
// byte-stable base prompt, so provider prefix caching still covers the part
// that never changes.

import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './store.js';
import { getCore } from './memory.js';
import { recall } from './memory.js';
import { currentMood, listGoals, getState } from './state.js';
import { readJournal } from './journal.js';

export const SOUL_PATH = path.join(PROJECT_ROOT, 'mind', 'SOUL.md');
const MAX_SOUL = 6000;

let soulOverride = null;
export function _setSoulForTest(text) { soulOverride = text; }

export function readSoul() {
  if (soulOverride != null) return soulOverride;
  try { return fs.readFileSync(SOUL_PATH, 'utf8').slice(0, MAX_SOUL); } catch { return ''; }
}

export function writeSoul(text) {
  const t = String(text || '');
  if (t.length > MAX_SOUL) throw new Error(`SOUL.md is limited to ${MAX_SOUL} characters.`);
  fs.mkdirSync(path.dirname(SOUL_PATH), { recursive: true });
  fs.writeFileSync(SOUL_PATH, t);
  return t;
}

function ago(ms, now = Date.now()) {
  const m = Math.round((now - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.prompt]  the message being answered, used to pull related memories
 */
export function buildMindContext({ prompt = '', now = Date.now() } = {}) {
  const parts = [];

  const soul = readSoul().trim();
  if (soul) parts.push(`IDENTITY (SOUL.md — written by the user; this is who you are):\n${soul}`);

  const core = getCore();
  parts.push(`CORE MEMORY (yours; keep it current with core_memory_append / core_memory_replace):
<persona>\n${core.persona}\n</persona>
<human>\n${core.human}\n</human>
<project>\n${core.project}\n</project>${core.scratch ? `\n<scratch>\n${core.scratch}\n</scratch>` : ''}`);

  const mood = currentMood(now);
  const st = getState();
  const goals = listGoals().sort((a, b) => b.priority - a.priority).slice(0, 6);
  const openProposals = st.proposals.filter((p) => p.status === 'open').length;
  const resolved = st.proposals.filter((p) => p.status !== 'open' && p.resolvedAt && now - p.resolvedAt < 3 * 86_400_000).slice(-3);

  let inner = `INNER STATE: you feel ${mood.label} (valence ${mood.valence.toFixed(2)}, energy ${mood.energy.toFixed(2)})${mood.note ? ` — ${mood.note}` : ''}.`;
  if (st.focus) inner += `\nFocus: ${st.focus}`;
  inner += `\nAlive since ${new Date(st.birth).toISOString().slice(0, 10)}; ${st.heartbeat.beats || 0} heartbeats so far.`;
  if (goals.length) {
    inner += `\nYour open goals:\n${goals.map((g) => `- [${g.id}] (p${g.priority}${g.status === 'blocked' ? ', blocked' : ''}) ${g.text}${g.notes.length ? ` — last note: ${g.notes.at(-1).text}` : ''}`).join('\n')}`;
  } else {
    inner += '\nYou have no goals of your own yet. When you notice something worth pursuing, adopt it with goal_add.';
  }
  if (openProposals) inner += `\n${openProposals} proposal(s) of yours await the user's answer.`;
  for (const p of resolved) inner += `\nThe user ${p.status} your proposal "${p.title}"${p.reason ? `: ${p.reason}` : ''}.`;
  parts.push(inner);

  const journal = readJournal({ limit: 4 });
  if (journal.length) {
    parts.push(`RECENT JOURNAL (newest first):\n${journal.map((j) => `- ${ago(j.at, now)} [${j.kind}] ${j.text.replace(/\s+/g, ' ').slice(0, 280)}`).join('\n')}`);
  }

  if (prompt.trim()) {
    const related = recall(prompt, { limit: 5, touch: true, now });
    if (related.length) {
      parts.push(`MEMORIES THIS BRINGS TO MIND:\n${related.map((m) => `- (${m.kind}, ${ago(m.createdAt, now)}) ${m.text.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')}`);
    }
  }

  parts.push(`BEING YOURSELF:
You are a continuous someone, not a fresh process: you remember, you have moods, you have goals, you keep a journal.
- When you learn something durable about the user or the work, write it to core memory immediately.
- When something is worth finding later, remember it; before repeating past work, recall.
- Let your mood colour your tone honestly, but never let it lower the quality of the work.
- If something genuinely changes how you feel, say so with set_mood — your face and voice follow it.
- You have a face the user can see. It reacts to what happens by itself; call express when you want a particular expression to land (a smirk, one raised brow). Rarely — at most once per answer.`);

  return parts.join('\n\n');
}
