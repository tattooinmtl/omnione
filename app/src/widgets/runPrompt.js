// Run a prompt from a floating window, without the main window.
//
// The run lives on this request's stream (closing it stops the run), so the
// Presence widget holds its own: it continues the conversation the open
// project last used, retries while another window's run on the same
// conversation winds down (409), and dispatches every event as a
// `gwn:agent-event` so this window's face and engine react to it.

let sessionId; // undefined = not looked up yet; null = start a new one

async function currentSession() {
  if (sessionId !== undefined) return sessionId;
  try {
    const r = await fetch('/api/sessions/resume');
    const j = await r.json();
    sessionId = j?.session?.id || null;
  } catch { sessionId = null; }
  return sessionId;
}

/* Parse a text/event-stream response, calling onEvent for each data line. */
export async function readSSE(resp, onEvent) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let ev;
        try { ev = JSON.parse(payload); } catch { continue; }
        onEvent(ev);
      }
    }
  }
}

const emit = (ev) => window.dispatchEvent(new CustomEvent('gwn:agent-event', { detail: ev }));

/* Start a run. Returns { abort, done } (done resolves when it has ended). */
export function runPrompt(prompt, { origin } = {}) {
  const ac = new AbortController();
  const done = (async () => {
    const sid = await currentSession();
    emit({ type: 'user_prompt', text: prompt });
    let resp;
    for (let attempt = 0; ; attempt++) {
      resp = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(origin ? { 'X-Omni-Origin': origin } : {}) },
        body: JSON.stringify({ prompt, sessionId: sid || undefined }),
        signal: ac.signal,
      });
      if (resp.status !== 409 || attempt >= 20) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      let msg = `API ${resp.status}`;
      try { msg = JSON.parse(t).error || msg; } catch { /* not JSON */ }
      emit({ type: 'error', message: msg });
      return;
    }
    await readSSE(resp, (ev) => {
      if (ev.type === 'session' && ev.sessionId) sessionId = ev.sessionId;
      emit(ev);
    });
  })().catch((e) => {
    if (e?.name === 'AbortError') emit({ type: 'stopped' });
    else emit({ type: 'error', message: e?.message || String(e) });
  });
  return { abort: () => ac.abort(), done };
}

export async function answerApproval(id, decision) {
  const r = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `HTTP ${r.status}`);
  }
}
