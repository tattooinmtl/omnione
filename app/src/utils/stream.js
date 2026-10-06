// One live connection per window (GET /api/stream), shared by everything in
// it that needs pushed updates: run events, the mind, skills, files, the
// wake-word listener.
//
// Why: every OmniOne window runs in one WebView2, which allows 6 open
// connections to OmniOne in total. One stream per feature used them all up,
// and then a question or the voice waited forever. Subscribing here opens (or
// widens) this window's single stream instead.

const subs = new Map();      // topic -> Set(handler)
let es = null;
let openTopics = '';
let reopenTimer = 0;

function wanted() {
  return [...subs.entries()].filter(([, set]) => set.size).map(([t]) => t).sort().join(',');
}

function open() {
  const topics = wanted();
  if (topics === openTopics && es) return;
  es?.close();
  es = null;
  openTopics = topics;
  if (!topics) return;
  try {
    es = new EventSource(`/api/stream?topics=${topics}`);
    es.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.ch === 'stream') {
        // Keep-alive; the mind's mood rides along for those who want it.
        if (ev.mood) for (const fn of subs.get('mind') || []) fn({ type: 'ping', mood: ev.mood });
        return;
      }
      for (const fn of subs.get(ev.ch) || []) {
        try { fn(ev); } catch (e) { console.error('[stream]', e); }
      }
    };
    es.onerror = () => {
      for (const fn of subs.get('listen') || []) fn({ type: 'stream_error' });
    };
  } catch { /* no SSE here (tests) */ }
}

/* Listen to one topic: live | mind | skills | workspace | listen. Returns the
 * unsubscribe function. Several subscribes in a row reopen the stream once. */
export function subscribeStream(topic, handler) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(handler);
  clearTimeout(reopenTimer);
  reopenTimer = setTimeout(open, 0);
  return () => {
    subs.get(topic)?.delete(handler);
    clearTimeout(reopenTimer);
    reopenTimer = setTimeout(open, 50);
  };
}
