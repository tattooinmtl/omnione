// The journal: the agent's first-person record of what it did and thought.
//
// Written at the end of every heartbeat and whenever the agent has something
// it wants to note. The last few entries are in the prompt, which gives it a
// sense of "earlier today" — the thread of continuity between one wake-up
// and the next. The user can read it, which is the main way to see what it
// has been up to while nobody was watching.

import { appendJsonl, readJsonl, writeJsonl, newId } from './store.js';

const FILE = 'journal.jsonl';
const MAX_ENTRIES = 2000;
export const JOURNAL_KINDS = ['thought', 'heartbeat', 'work', 'reflection', 'dream'];

export function writeJournal({ text, kind = 'thought', sessionId = null }) {
  const t = String(text || '').trim();
  if (!t) throw new Error('Journal entry is empty.');
  const entry = {
    id: newId('j'),
    kind: JOURNAL_KINDS.includes(kind) ? kind : 'thought',
    text: t.slice(0, 4000),
    sessionId,
    at: Date.now(),
  };
  appendJsonl(FILE, entry);
  const all = readJsonl(FILE);
  if (all.length > MAX_ENTRIES + 200) writeJsonl(FILE, all.slice(-MAX_ENTRIES));
  return entry;
}

export function readJournal({ limit = 30 } = {}) {
  return readJsonl(FILE).slice(-limit).reverse();
}
