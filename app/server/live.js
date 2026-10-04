// The live channel: every run's events, for every window.
//
// A run's events stream back on the HTTP response of the /api/generate
// request that started it, so only the window that asked could see them.
// With floating windows (the Presence widget, the emotion engine, the neural
// network) each one needs to react to every run, wherever it started, so the
// generate handler also publishes each event here, tagged with the window it
// came from (X-Omni-Origin). Windows subscribe to /api/live and skip their
// own events, which they already have.

const subscribers = new Set();

export function subscribeLive(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function publishLive(ev, origin = '') {
  if (!subscribers.size) return;
  const tagged = { ...ev, origin: String(origin || '').slice(0, 64) };
  for (const fn of subscribers) {
    try { fn(tagged); } catch { /* one broken listener must not stop the rest */ }
  }
}

export function liveSubscriberCount() {
  return subscribers.size;
}

/* A window id from the X-Omni-Origin header: short, plain characters only. */
export function originOf(req) {
  const o = String(req.get?.('x-omni-origin') || '');
  return /^[\w.:-]{1,64}$/.test(o) ? o : '';
}
