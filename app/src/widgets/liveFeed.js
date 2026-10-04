// Every window hears every run.
//
// Each window has an origin id, sent with its own prompts (X-Omni-Origin).
// The server republishes every run's events on /api/live tagged with that
// origin; here they are re-dispatched as the usual `gwn:agent-event`, so the
// face, the emotion engine and the brain react to runs started in any
// window, while a window's own events (which it already has) are skipped.
// With `mind`, what Omi-One does on its own time (/api/mind/events) is fed
// in the same way, and its mood is reported.

const rand = () => Math.random().toString(36).slice(2, 8);

export function makeOrigin(kind) {
  return `${kind}-${rand()}`;
}

/* The main window's id: its prompts carry it, and its live feed skips it. */
export const MAIN_ORIGIN = makeOrigin('main');

function dispatch(ev) {
  window.dispatchEvent(new CustomEvent('gwn:agent-event', { detail: ev }));
}

export function startLiveFeed({ origin, mind = false, onMood } = {}) {
  const sources = [];
  const open = (url, onMessage) => {
    try {
      const es = new EventSource(url);
      es.onmessage = (m) => {
        let ev;
        try { ev = JSON.parse(m.data); } catch { return; }
        onMessage(ev);
      };
      sources.push(es);
    } catch { /* no SSE in this environment */ }
  };

  open('/api/live', (ev) => {
    if (!ev || ev.type === 'hello' || ev.type === 'ping') return;
    if (origin && ev.origin === origin) return;
    dispatch(ev);
  });

  if (mind) {
    open('/api/mind/events', (ev) => {
      if (ev?.mood) onMood?.(ev.mood);
      if (!ev || ev.type === 'hello' || ev.type === 'ping') return;
      dispatch(ev.type === 'tool_result' || ev.type === 'tool_call' ? { ...ev, heartbeat: true } : ev);
    });
  }

  return () => sources.forEach((es) => es.close());
}
