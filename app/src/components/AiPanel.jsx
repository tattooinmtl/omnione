import { useEffect, useRef, useState, useCallback } from 'react';
import ContextMeter from './ContextMeter.jsx';
import CommandPalette from './CommandPalette.jsx';
import ApprovalModal from './ApprovalModal.jsx';
import { useProviderTokenBudget, fetchSettings } from '../hooks/useProviderTokenBudget';
import './AiPanel.css';

const SUGGESTIONS = [
  '🎮 Make a neon asteroid shooter',
  '🏃 Build a pixel platformer',
  '📝 Build a todo app',
  '🐍 Make a snake game',
  '🌤️ Design a weather dashboard',
  '💬 Create a chat interface',
];

const SKILL_PREFIX = (name, body) =>
  `[SKILL: ${name}]\n${body}\n[/SKILL]\n\nDescribe what you want this skill to build:\n`;

/* Flatten a session message's content blocks to plain text — the client-side
 * mirror of server/sessions.js's textOf, used only to rebuild the prompt
 * history display when resuming a session. */
function textFromMessage(message) {
  if (!message?.content) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/* A one-line rendering of tool arguments for the trace panel. */
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const parts = Object.entries(args).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${s.length > 40 ? `${s.slice(0, 40)}…` : s}`;
  });
  const joined = parts.join(', ');
  return joined.length > 80 ? `${joined.slice(0, 80)}…` : joined;
}

export default function AiPanel({ onGenerate, generating, trace, files, api }) {
  const [prompt, setPrompt] = useState('');
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [settings, setSettings] = useState({ provider: 'minimax', model: '', hasOwnKey: false, keyHint: null });
  const [skills, setSkills] = useState([]);
  const [activeSkill, setActiveSkill] = useState(null); // { name, body }
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sessionId, setSessionId] = useState(null);
  // The agent is paused waiting on this. Null when nothing is pending.
  const [approval, setApproval] = useState(null);
  const budget = useProviderTokenBudget();
  const taRef = useRef(null);
  const histEndRef = useRef(null);
  // Held in a ref as well as state: the SSE handler is registered once and
  // would otherwise close over the session id from first render.
  const sessionIdRef = useRef(null);
  // The in-flight run's AbortController, for the Stop button.
  const abortRef = useRef(null);

  useEffect(() => { fetchSettings().then(setSettings); }, []);

  // Resume the last conversation for this project on load, so leaving and
  // coming back picks up where it left off. Runs once, on mount, before any
  // prompt is sent — an explicit "new chat" (paletteApi.newSession) only
  // happens after that and is never overridden by this effect re-running.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/sessions/resume');
        if (!r.ok) return;
        const { session } = await r.json();
        if (!session || !session.id) return;
        sessionIdRef.current = session.id;
        setSessionId(session.id);
        setHistory(
          (session.messages || [])
            .filter((m) => m.role === 'user')
            .map((m) => ({ role: 'user', text: textFromMessage(m) })),
        );
      } catch { /* no session to resume, or the server isn't up yet */ }
    })();
  }, []);

  // Live skills list (with SSE so uploads appear without a refresh)
  const refreshSkills = useCallback(async () => {
    try {
      const r = await fetch('/api/skills');
      const j = await r.json();
      setSkills(j.skills || []);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { refreshSkills(); }, [refreshSkills]);
  useEffect(() => {
    let es;
    try {
      es = new EventSource('/api/skills/events');
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type === 'changed' || ev.type === 'hello') refreshSkills();
        } catch { /* ignore */ }
      };
    } catch { /* ignore */ }
    return () => { if (es) es.close(); };
  }, [refreshSkills]);

  // The SkillsModal's RUN button dispatches this; we prefilled the prompt
  // the same way the /run <name> command does. Use a ref so the listener
  // always sees the latest runSkill without the temporal-dead-zone issue
  // of referencing a const declared further down in the component.
  const runSkillRef = useRef(null);
  useEffect(() => {
    const onRun = (ev) => {
      const name = ev.detail && ev.detail.name;
      if (name && runSkillRef.current) runSkillRef.current(name);
    };
    window.addEventListener('gwn:run-skill-from-modal', onRun);
    return () => window.removeEventListener('gwn:run-skill-from-modal', onRun);
  }, []);

  useEffect(() => {
    if (showHistory && histEndRef.current) histEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [history, showHistory]);

  // The request channel. AppShell dispatches gwn:request-generation; we POST
  // to /api/generate and stream SSE back.
  //
  // One request can now span several model turns: the agent may call tools,
  // read the results, and call the model again. `done` carries the text of
  // the final turn — accumulating every delta across turns would splice the
  // model's intermediate narration into the project files.
  useEffect(() => {
    const onRequest = async (ev) => {
      const { prompt: p, currentCode } = ev.detail || {};
      const ac = new AbortController();
      // Exposed so the Stop button can cancel. Aborting the fetch closes the
      // response, which the server sees as res 'close' and turns into the
      // run's AbortSignal — so stopping here really does kill an in-flight
      // command or request on the other side, not just hide the output.
      abortRef.current = ac;
      window.dispatchEvent(new CustomEvent('gwn:agent-event', { detail: { type: 'user_prompt', text: p } }));
      let acc = '';
      const dispatchProgress = (patch) => {
        window.dispatchEvent(new CustomEvent('gwn:generation-progress', { detail: patch }));
      };
      try {
        let resp;
        for (let attempt = 0; ; attempt++) {
          resp = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: p, currentCode, sessionId: sessionIdRef.current }),
            signal: ac.signal,
          });
          // 409: the run just interrupted is still winding down on the
          // server. Give it a moment rather than refusing the new message.
          if (resp.status !== 409 || attempt >= 20) break;
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          let msg = `API ${resp.status}`;
          try { msg = JSON.parse(t).error || t.slice(0, 200) || msg; } catch { msg = `${msg}: ${t.slice(0, 200)}`; }
          window.dispatchEvent(new CustomEvent('gwn:generation-result', { detail: { error: msg } }));
          return;
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
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
              // Every raw event, re-broadcast for the presence (face, voice,
              // emotion engine), which reacts to the run as it happens.
              window.dispatchEvent(new CustomEvent('gwn:agent-event', { detail: ev }));
              if (ev.type === 'session') {
                sessionIdRef.current = ev.sessionId;
                setSessionId(ev.sessionId);
              } else if (ev.type === 'step') dispatchProgress({ step: ev.step });
              else if (ev.type === 'thinking') dispatchProgress({ thinking: ev.text });
              else if (ev.type === 'turn_start') {
                // Each model turn starts a fresh answer; drop the previous
                // turn's text so only the final one reaches the editor.
                acc = '';
              } else if (ev.type === 'delta') {
                acc += ev.text;
                dispatchProgress({ delta: ev.text, chars: acc.length });
              } else if (ev.type === 'tool_call') {
                dispatchProgress({
                  step: { id: `tool-${ev.id}`, label: `${ev.name}(${summarizeArgs(ev.input)})`, status: 'run' },
                });
              } else if (ev.type === 'tool_result') {
                dispatchProgress({
                  step: {
                    id: `tool-${ev.id}`,
                    label: `${ev.tool}(${summarizeArgs(ev.args)})`,
                    status: ev.ok ? 'done' : 'error',
                    detail: ev.ok ? `${ev.durationMs}ms` : ev.error,
                  },
                });
              } else if (ev.type === 'approval_request') {
                // The run is blocked on the server until we answer.
                setApproval(ev);
                dispatchProgress({
                  step: { id: `ap-${ev.id}`, label: `Waiting for your approval: ${ev.tool}`, status: 'run' },
                });
              } else if (ev.type === 'approval_resolved') {
                setApproval((cur) => (cur && cur.id === ev.id ? null : cur));
                dispatchProgress({
                  step: {
                    id: `ap-${ev.id}`,
                    label: ev.approved ? 'Approved' : 'Denied',
                    status: ev.approved ? 'done' : 'error',
                  },
                });
              } else if (ev.type === 'checkpoint') {
                dispatchProgress({
                  step: { id: `cp-${ev.id}`, label: `Checkpoint before ${ev.tool}`, status: 'done', detail: ev.id },
                });
              } else if (ev.type === 'usage') {
                dispatchProgress({ usage: ev.usage });
              } else if (ev.type === 'done') {
                window.dispatchEvent(new CustomEvent('gwn:generation-result', {
                  detail: { result: ev.text ?? acc, iterations: ev.iterations },
                }));
                setHistory((h) => [
                  ...h,
                  { role: 'assistant', text: (ev.text ?? acc).slice(0, 4000) },
                  // Out of steps: Omi-One summed up; offer to carry on.
                  ...(ev.limitReached ? [{ role: 'limit', id: `limit-${Date.now()}`, steps: ev.maxIterations }] : []),
                ]);
                if (ev.limitReached) setShowHistory(true);
                return;
              } else if (ev.type === 'error') {
                window.dispatchEvent(new CustomEvent('gwn:generation-result', { detail: { error: ev.message } }));
                return;
              }
            }
          }
        }
        window.dispatchEvent(new CustomEvent('gwn:generation-result', { detail: { result: acc } }));
      } catch (e) {
        if (e.name === 'AbortError') {
          // A stop still has to report back, or AppShell never clears its
          // `generating` flag and the composer stays disabled forever.
          window.dispatchEvent(new CustomEvent('gwn:generation-result', { detail: { stopped: true } }));
        } else {
          window.dispatchEvent(new CustomEvent('gwn:generation-result', { detail: { error: e.message || String(e) } }));
        }
      } finally {
        abortRef.current = null;
        // A run that ends while an approval is on screen leaves a prompt
        // nothing is waiting on.
        setApproval(null);
      }
    };
    window.addEventListener('gwn:request-generation', onRequest);
    return () => window.removeEventListener('gwn:request-generation', onRequest);
  }, []);

  // Prompts that arrive from outside the composer — spoken in the Presence
  // view, or a proposal the user accepted — go through the same path as a
  // typed one, so they show up in the history too.
  const onGenerateRef = useRef(onGenerate);
  onGenerateRef.current = onGenerate;
  const generatingRef = useRef(generating);
  generatingRef.current = generating;
  useEffect(() => {
    const onSubmit = (e) => {
      const text = String(e.detail?.text || '').trim();
      if (!text || generatingRef.current) return;
      setHistory((h) => [...h, { role: 'user', text }]);
      onGenerateRef.current(text);
    };
    window.addEventListener('gwn:submit-prompt', onSubmit);
    return () => window.removeEventListener('gwn:submit-prompt', onSubmit);
  }, []);

  // Trigger the skill: fetch its body and prefill the prompt with a clear
  // "[SKILL: name]...[/SKILL]\n\nDescribe what you want this skill to build:\n"
  // template so the user just types the task and hits send.
  const runSkill = useCallback(async (name) => {
    try {
      const r = await fetch(`/api/skills/${encodeURIComponent(name)}`);
      if (!r.ok) {
        api.toast && api.toast(`Skill "${name}" not found`, 'error');
        return;
      }
      const j = await r.json();
      setActiveSkill({ name, body: j.body || '' });
      setPrompt(SKILL_PREFIX(name, j.body || ''));
      setPaletteOpen(false);
      setTimeout(() => taRef.current?.focus(), 30);
    } catch (e) {
      api.toast && api.toast(e.message || 'Failed to load skill', 'error');
    }
  }, [api]);
  useEffect(() => { runSkillRef.current = runSkill; }, [runSkill]);

  const clearActiveSkill = () => {
    setActiveSkill(null);
    setPrompt('');
    setTimeout(() => taRef.current?.focus(), 30);
  };

  /* Cancel the run in flight. Aborting the fetch closes the response, the
   * server sees res 'close', and that becomes the run's AbortSignal — which
   * kills an in-flight command and releases the session's run lock. */
  // A message sent while Omi-One was working: it goes out as soon as the
  // interrupted task has stopped.
  const interruptRef = useRef(null);
  useEffect(() => {
    if (generating || !interruptRef.current) return;
    const text = interruptRef.current;
    interruptRef.current = null;
    onGenerate(text);
  }, [generating, onGenerate]);

  const stopRun = useCallback(() => {
    if (!abortRef.current) return;
    abortRef.current.abort();
    abortRef.current = null;
    api.toast && api.toast('Stopped', 'info');
  }, [api]);

  // Esc stops a run — but only when nothing else owns Esc (the approval
  // modal handles its own, and the palette closes with it).
  useEffect(() => {
    if (!generating || approval) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !paletteOpen) {
        e.preventDefault();
        stopRun();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [generating, approval, paletteOpen, stopRun]);

  // Build the api object the CommandPalette calls back into. Anything that
  // opens a modal routes through AppShell via the passed-in `api` prop.
  const paletteApi = {
    runHelp: () => api.openHelp && api.openHelp(),
    openSkills: () => { setPaletteOpen(false); api.openSkills && api.openSkills(); },
    openDrafts: () => { setPaletteOpen(false); api.openDrafts && api.openDrafts(); },
    saveProject: () => { setPaletteOpen(false); api.saveProject && api.saveProject(); },
    downloadZip: () => { setPaletteOpen(false); api.downloadZip && api.downloadZip(); },
    openSettings: () => { setPaletteOpen(false); api.openSettings && api.openSettings(); },
    openTools: () => { setPaletteOpen(false); api.openTools && api.openTools(); },
    openHooks: () => { setPaletteOpen(false); api.openHooks && api.openHooks(); },
    clearPrompt: () => { setPaletteOpen(false); setPrompt(''); setActiveSkill(null); setTimeout(() => taRef.current?.focus(), 30); },
    newSession: () => {
      setPaletteOpen(false);
      setPrompt('');
      setActiveSkill(null);
      // Stop whatever is running first: otherwise the old run keeps writing
      // into the session we are walking away from, and its lock stays held.
      stopRun();
      // Dropping the id is enough: the next request arrives without one and
      // the server opens a fresh session. The old transcript stays on disk.
      sessionIdRef.current = null;
      setSessionId(null);
      setHistory([]);
      api.toast && api.toast('Started a new conversation', 'info');
      setTimeout(() => taRef.current?.focus(), 30);
    },
    runSkill: (name) => runSkill(name),
  };

  // /btw <question>: a quick side question. Works while Omi-One is busy;
  // the answer shows here but isn't added to the conversation (see server/btw.js).
  const askBtw = async (question) => {
    const id = `btw-${Date.now()}`;
    setHistory((h) => [...h, { role: 'btw', id, text: question, answer: null }]);
    setShowHistory(true);
    const set = (patch) => setHistory((h) => h.map((m) => (m.id === id ? { ...m, ...patch } : m)));
    try {
      const r = await fetch('/api/btw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, sessionId: sessionIdRef.current }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `status ${r.status}`);
      set({ answer: j.answer });
    } catch (e) {
      set({ answer: e.message || 'The side question failed.', failed: true });
    }
  };
  const dismissBtw = (id) => setHistory((h) => h.filter((m) => m.id !== id));

  const submit = () => {
    if (paletteOpen) return;
    const text = prompt.trim();
    const btw = text.match(/^\/btw(?:\s+([\s\S]*))?$/i);
    if (btw) {
      const question = (btw[1] || '').trim();
      if (!question) { api.toast && api.toast('Type your question after /btw', 'info'); return; }
      setPrompt('');
      if (taRef.current) taRef.current.style.height = 'auto';
      askBtw(question);
      return;
    }
    if (!text) return;
    if (generating) {
      // Interrupt: stop the current task, then send this the moment it has
      // stopped (the effect below). /btw asks without interrupting.
      setHistory((h) => [...h, { role: 'user', text }]);
      setPrompt('');
      setActiveSkill(null);
      if (taRef.current) taRef.current.style.height = 'auto';
      interruptRef.current = text;
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
      api.toast && api.toast('Stopping the current task to start yours…', 'info');
      return;
    }
    setHistory((h) => [...h, { role: 'user', text }]);
    setPrompt('');
    setActiveSkill(null);
    if (taRef.current) taRef.current.style.height = 'auto';
    onGenerate(text);
  };

  // Compute the slash-palette state from the current prompt
  const paletteState = (() => {
    if (!prompt.startsWith('/')) return null;
    const after = prompt.slice(1);
    // The first whitespace breaks command vs argument
    const sp = after.search(/\s/);
    if (sp < 0) return { query: after, arg: '' };
    return { query: after.slice(0, sp), arg: after.slice(sp + 1) };
  })();

  const onChange = (e) => {
    const v = e.target.value;
    setPrompt(v);
    setPaletteOpen(v.startsWith('/') && !/^\/btw\s/i.test(v));
  };

  const onKey = (e) => {
    // Hand the keys to the palette while it's open
    if (paletteOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab')) {
      // The palette is rendered as a sibling, not a child, so we can't trap
      // focus there. Instead, the palette listens on the document via its
      // own keydown. We prevent the textarea's default for these keys.
      if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const onInput = () => {
    if (taRef.current) {
      taRef.current.style.height = 'auto';
      taRef.current.style.height = Math.min(taRef.current.scrollHeight, 140) + 'px';
    }
  };

  const onPaletteSelect = (cmd) => {
    // Tab/Enter from the palette: replace the prompt with the trigger
    // (so the user can finish typing the argument, like /run <name>)
    // unless the command is a no-arg one with a `run` action, in which
    // case we run it.
    const trigger = cmd.trigger;
    if (cmd.skill) {
      // /run <name> — strip the prefix and run
      const name = cmd.skill;
      setPaletteOpen(false);
      runSkill(name);
      return;
    }
    // Static command: replace the prompt with /<trigger> and run if it
    // takes no argument. Otherwise leave the cursor in the textarea for
    // the user to type the argument.
    setPrompt(`/${trigger} `);
    setPaletteOpen(false);
    setTimeout(() => taRef.current?.focus(), 30);
    // Commands without arguments execute immediately
    const argless = ['help', 'skills', 'drafts', 'save', 'zip', 'settings', 'clear', 'new', 'tools', 'hooks'];
    if (argless.includes(trigger)) {
      setTimeout(() => cmd.run(paletteApi), 50);
    }
  };

  const codeBlob = files && Object.keys(files).length
    ? Object.entries(files).map(([n, c]) => `${n}\n${c}`).join('\n\n')
    : '';

  return (
    <div className="ai-panel">
      <div className="ai-panel__head">
        <h2>AGENT PROMPT</h2>
        <div className="ai-panel__head-actions">
          {history.length > 0 && (
            <button type="button" className="ai-panel__toggle" onClick={() => setShowHistory((s) => !s)}>
              {showHistory ? '▴' : '▾'} {history.length} msg
            </button>
          )}
        </div>
      </div>

      <div className="ai-panel__middle">
        {showHistory && history.length > 0 && (
          <div className="ai-panel__history">
            {history.map((m, i) => (m.role === 'limit' ? (
              <div key={m.id} className="ai-panel__limit" role="note">
                <span>Omi-One used all {m.steps} steps allowed for one task.</span>
                <button
                  type="button"
                  className="ai-panel__limit-go"
                  disabled={generating}
                  onClick={() => {
                    setHistory((h) => h.filter((x) => x.id !== m.id));
                    window.dispatchEvent(new CustomEvent('gwn:submit-prompt', { detail: { text: 'Continue where you left off.' } }));
                  }}
                >
                  Continue
                </button>
              </div>
            ) : m.role === 'btw' ? (
              <div key={m.id} className="ai-panel__btw" role="note">
                <div className="ai-panel__btw-head">
                  <span className="ai-panel__btw-tag">BTW</span>
                  <span className="ai-panel__btw-q">{m.text}</span>
                  <button type="button" className="ai-panel__btw-x" onClick={() => dismissBtw(m.id)} aria-label="Dismiss" title="Dismiss">×</button>
                </div>
                <div className={`ai-panel__btw-a${m.failed ? ' is-failed' : ''}`}>
                  {m.answer === null ? <span className="ai-panel__btw-wait">Omi-One is answering…</span> : m.answer}
                </div>
              </div>
            ) : (
              <div key={i} className={`ai-panel__row ai-panel__row-${m.role}`}>
                <span className="ai-panel__row-role">{m.role === 'user' ? 'You' : 'AI'}</span>
                <span className="ai-panel__row-text">{m.text}</span>
              </div>
            )))}
            <div ref={histEndRef} />
          </div>
        )}

        {history.length === 0 && (
          <div className="ai-panel__suggestions">
            {SUGGESTIONS.map((s, i) => (
              <button
                key={i}
                type="button"
                className="ai-panel__suggestion"
                onClick={() => { setPrompt(s.replace(/^[^a-zA-Z]+/, '').trim()); taRef.current?.focus(); }}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {trace && trace.steps && trace.steps.length > 0 && (
          <ul className="ai-panel__steps">
            {trace.steps.map((s, i) => (
              <li key={i} className={`ai-panel__step ai-panel__step-${s.status || 'run'}`}>
                <span className="ai-panel__step-dot" />
                {s.label}
              </li>
            ))}
          </ul>
        )}

        {trace && trace.thinking && (
          <details className="ai-panel__thinking" open>
            <summary>Thinking…</summary>
            <div className="ai-panel__thinking-body">{trace.thinking}</div>
          </details>
        )}
      </div>

      <div className="ai-panel__footer">
        <ContextMeter prompt={prompt} code={codeBlob} budget={budget} />

        {activeSkill && (
          <div className="ai-panel__skill-tag">
            <span className="ai-panel__skill-tag-icon">⚙</span>
            <span>running skill: <strong>/{activeSkill.name}</strong></span>
            <button type="button" className="ai-panel__skill-tag-x" onClick={clearActiveSkill} title="Clear skill">×</button>
          </div>
        )}

        <div className="ai-panel__prompt-wrap">
          <CommandPalette
            open={paletteOpen}
            query={paletteState ? paletteState.query : ''}
            onSelect={onPaletteSelect}
            onClose={() => setPaletteOpen(false)}
            skills={skills}
            api={paletteApi}
          />
          <div className="ai-panel__row">
            <textarea
              ref={taRef}
              className="ai-panel__input"
              rows={1}
              value={prompt}
              onChange={onChange}
              onKeyDown={onKey}
              onInput={onInput}
              placeholder={
                generating
                  ? 'Omi-One is working… send a message to interrupt, or /btw to ask on the side'
                  : settings.hasOwnKey
                  ? 'Describe a project, type "/" for commands, or pick a skill…'
                  : settings.provider === 'gwn-local'
                    ? 'Describe a project, or type "/" to browse commands and skills…'
                    : 'Add an API key in Settings, or switch provider to OmniOne Local…'
              }
            />
            {generating ? (
              <button
                type="button"
                className="ai-panel__send ai-panel__send--stop"
                onClick={stopRun}
                title="Stop this run (Esc)"
                aria-label="Stop this run"
              >
                ◼
              </button>
            ) : (
            <button
              type="button"
              className="ai-panel__send"
              onClick={submit}
              disabled={!prompt.trim() || paletteOpen}
              title="Send"
            >
              {'➤'}
            </button>
            )}
          </div>
        </div>

        {!settings.hasOwnKey && settings.provider !== 'gwn-local' && (
          <div className="ai-panel__hint">
            ⚙ Add an API key in Settings to enable a real provider. The built-in
            <strong> OmniOne Local</strong> stub streams a working starter so the UI is
            usable end-to-end without one.
          </div>
        )}
      </div>

      {approval && (
        <ApprovalModal
          request={approval}
          onDecide={async (decision) => {
            const id = approval.id;
            // Clear immediately so the prompt cannot be answered twice; the
            // approval_resolved event will confirm what the server did.
            setApproval(null);
            try {
              const r = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision }),
              });
              if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                api.toast && api.toast(j.error || `Could not answer the approval (${r.status})`, 'error');
              }
            } catch (e) {
              api.toast && api.toast(e.message || 'Could not answer the approval', 'error');
            }
          }}
        />
      )}
    </div>
  );
}

