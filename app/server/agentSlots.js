// How many subagents may call the model at the same time, across every run
// (chats, the heartbeat, scheduled tasks). MiniMax allows 4 requests at
// once per key, so 4 is the default; Settings → AI changes it.

import { getPrefs } from './prefs.js';

export const MAX_PARALLEL_AGENTS = 8;
let busy = 0;
const waiting = [];

export function parallelLimit() {
  const n = Math.round(Number(getPrefs().ai.parallelAgents));
  return Math.max(1, Math.min(MAX_PARALLEL_AGENTS, Number.isFinite(n) ? n : 4));
}

/* Wait for a free slot. Resolves to a release function; rejects with an
 * AbortError when the run is cancelled while waiting. */
export function acquireSlot(signal) {
  if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  if (busy < parallelLimit()) {
    busy += 1;
    return Promise.resolve(releaser());
  }
  return new Promise((resolve, reject) => {
    const entry = { resolve, reject };
    waiting.push(entry);
    signal?.addEventListener('abort', () => {
      const i = waiting.indexOf(entry);
      if (i >= 0) { waiting.splice(i, 1); reject(new DOMException('Aborted', 'AbortError')); }
    }, { once: true });
  });
}

function releaser() {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    busy -= 1;
    while (waiting.length && busy < parallelLimit()) {
      busy += 1;
      waiting.shift().resolve(releaser());
    }
  };
}

export function slotsInUse() { return { busy, waiting: waiting.length, limit: parallelLimit() }; }
