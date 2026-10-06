import { useEffect, useRef, useState, useCallback } from 'react';
import ContextMeter from './ContextMeter.jsx';
import CommandPalette, { parseCommand } from './CommandPalette.jsx';
import { MAIN_ORIGIN } from '../widgets/liveFeed.js';
import ApprovalModal from './ApprovalModal.jsx';
import { uploadAttachments, ACCEPT } from '../utils/attachments.js';
import { useCamera, useCameraPreview } from '../utils/camera.js';
import ProjectBar from './ProjectBar.jsx';
import { useProviderTokenBudget, fetchSettings } from '../hooks/useProviderTokenBudget';
import './AiPanel.css';
import { subscribeStream } from '../utils/stream.js';

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
  // Files waiting to go with the next message, already saved in attachments/.
  const [attached, setAttached] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // The live camera: while it's on, the server adds a picture to each message.
  const camera = useCamera();
  const cameraOn = Boolean(camera.state?.on);
  const preview = useCameraPreview(cameraOn);
  useEffect(() => {
    if (camera.error) api.toast && api.toast(camera.error, 'error');
  }, [camera.error]);
  // Settings → AI → Show thinking. Re-read when the window regains focus,
  // which is when someone comes back from Settings.
  const [showThinking, setShowThinking] = useState(true);
  // Settings → Agent → Custom commands (/name in this box).
  const [customCommands, setCustomCommands] = useState([]);
  const customRef = useRef(customCommands);
  customRef.current = customCommands;
  useEffect(() => {
    const read = () => fetch('/api/prefs').then((r) => r.json()).then((p) => {
      setShowThinking(p?.ai?.thinking !== false);
      setCustomCommands(Array.isArray(p?.agent?.commands) ? p.agent.commands : []);
    }).catch(() => {});
    read();
    window.addEventListener('focus', read);
    window.addEventListener('gwn:prefs-changed', read);
    return () => { window.removeEventListener('focus', read); window.removeEventListener('gwn:prefs-changed', read); };
  }, []);
  const fileInputRef = useRef(null);
  // Handed from submitText to the request handler (the prompt makes a round
  // trip through AppShell on the way, the files don't).
  const outgoingFilesRef = useRef([]);
  const budget = useProviderTokenBudget();
  const taRef = useRef(null);
  const histEndRef = useRef(null);
  // Held in a ref as well as state: the SSE handler is registered once and
  // would otherwise close over the session id from first render.
  const sessionIdRef = useRef(null);
  // The in-flight run's AbortController, for the Stop button.
  const abortRef = useRef(null);

  useEffect(() => { fetchSettings().then(setSettings); }, []);

  // Show a saved chat (null = an empty, new one).
  const showSession = (session) => {
    sessionIdRef.current = session?.id || null;
    setSessionId(session?.id || null);
    setHistory(
      (session?.messages || [])
        .filter((m) => m.role === 'user')
        .map((m) => ({ role: 'user', text: textFromMessage(m) })),
    );
  };

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
        showSession(session);
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
  useEffect(() => subscribeStream('skills', (ev) => {
    if (ev.type === 'changed' || ev.type === 'hello') refreshSkills();
  }), [refreshSkills]);

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
      const outgoingFiles = outgoingFilesRef.current.map((f) => ({ path: f.path, name: f.name }));
      outgoingFilesRef.current = [];
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
            // The origin tags this run's events on the live channel, so the
            // floating windows see it and this window skips its own echo.
            headers: { 'Content-Type': 'application/json', 'X-Omni-Origin': MAIN_ORIGIN },
            body: JSON.stringify({ prompt: p, currentCode, sessionId: sessionIdRef.current, attachments: outgoingFiles }),
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
              } else if (ev.type === 'tool_result' && ev.ok && mediaFrom(ev.result).length) {
                // Pictures, songs and videos Omi-One made show up in the chat.
                const items = mediaFrom(ev.result);
                setHistory((h) => [...h, { role: 'media', id: `m-${ev.id}`, items }]);
                setShowHistory(true);
                dispatchProgress({
                  step: { id: `tool-${ev.id}`, label: `${ev.tool}(${summarizeArgs(ev.args)})`, status: 'done', detail: `${ev.durationMs}ms` },
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

  // Prompts that arrive from outside the composer — typed or spoken in the
  // Presence view, or a proposal the user accepted — go through exactly the
  // same path as a typed one (submitText): /btw is a side question, anything
  // else interrupts a run in progress or starts one.
  const onGenerateRef = useRef(onGenerate);
  onGenerateRef.current = onGenerate;
  const generatingRef = useRef(generating);
  generatingRef.current = generating;
  useEffect(() => {
    const onSubmit = (e) => {
      const text = String(e.detail?.text || '').trim();
      if (text) submitTextRef.current?.(text);
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
    openTools: () => { setPaletteOpen(false); listTools(); },
    openHooks: () => { setPaletteOpen(false); listHooks(); },
    clearPrompt: () => { setPaletteOpen(false); setPrompt(''); setActiveSkill(null); setTimeout(() => taRef.current?.focus(), 30); },
    newSession: ({ quiet = false, keepView = false } = {}) => {
      if (keepView) {
        // Omi-One switched project: the answer stays on screen, the next
        // message starts a chat in the new project.
        sessionIdRef.current = null;
        setSessionId(null);
        return;
      }
      setPaletteOpen(false);
      setPrompt('');
      setActiveSkill(null);
      // Stop whatever is running first: otherwise the old run keeps writing
      // into the session we are walking away from, and its lock stays held.
      stopRun();
      // Dropping the id is enough: the next request arrives without one and
      // the server opens a fresh session. The old transcript stays on disk.
      showSession(null);
      if (!quiet) api.toast && api.toast('Started a new conversation', 'info');
      setTimeout(() => taRef.current?.focus(), 30);
    },
    runSkill: (name) => runSkill(name),
  };

  /* A command's answer, shown in the conversation (and in the Presence chat)
   * like a message, but never sent to the agent. sections: [{ heading, items:
   * [{ name, detail }] }]. */
  const showCommandOutput = (title, { sections = [], note = '' } = {}) => {
    const out = { role: 'cmd', id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title, sections, note };
    setHistory((h) => [...h, out]);
    setShowHistory(true);
    window.dispatchEvent(new CustomEvent('gwn:command-output', { detail: out }));
  };
  const dismissCmd = (id) => setHistory((h) => h.filter((m) => m.id !== id));

  const listHooks = async () => {
    try {
      const r = await fetch('/api/hooks');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `status ${r.status}`);
      const events = j.events || [];
      const hooks = j.hooks || [];
      showCommandOutput(`/hooks — ${hooks.length} registered`, {
        sections: events.map((ev) => ({
          heading: ev,
          items: hooks.filter((h) => h.event === ev).map((h) => ({
            name: `${h.name}${h.runtime ? ` (.${h.runtime})` : ''}`,
            detail: h.description || '',
          })),
        })),
        note: hooks.length
          ? 'Each runs at its event: UserPromptSubmit before a prompt is sent, PreToolUse before a tool runs (it can block it), PostToolUse after.'
          : 'No hooks yet. Put a script in the app\'s hooks/<Event>/ folder (UserPromptSubmit, PreToolUse or PostToolUse) and it is picked up automatically.',
      });
    } catch (e) {
      showCommandOutput('/hooks', { note: `Could not read the hooks: ${e.message}` });
    }
  };

  const listTools = async () => {
    try {
      const r = await fetch('/api/tools');
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `status ${r.status}`);
      const tools = j.tools || [];
      const groups = new Map();
      for (const t of tools) {
        const key = t.source && t.source !== 'builtin' ? `MCP: ${String(t.source).replace(/^mcp:?/, '')}` : 'Built in';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(t);
      }
      const ASK = { read: 'runs freely', write: 'asks to change files', execute: 'asks first', admin: 'administrator, asks every time' };
      showCommandOutput(`/tools — ${tools.length} the AI can call`, {
        sections: [...groups.entries()].map(([heading, list]) => ({
          heading,
          items: list.sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({
            name: t.name,
            detail: `${ASK[t.permission] || t.permission} · ${String(t.description || '').split(/(?<=\.)\s/)[0].slice(0, 120)}`,
          })),
        })),
      });
    } catch (e) {
      showCommandOutput('/tools', { note: `Could not read the tools: ${e.message}` });
    }
  };

  // /btw <question>: a quick side question. Works while Omi-One is busy;
  // the answer shows here but isn't added to the conversation (see server/btw.js).
  const askBtw = async (question) => {
    const id = `btw-${Date.now()}`;
    setHistory((h) => [...h, { role: 'btw', id, text: question, answer: null }]);
    setShowHistory(true);
    const tell = (detail) => window.dispatchEvent(new CustomEvent('gwn:btw', { detail: { id, question, ...detail } }));
    tell({ answer: null });
    const set = (patch) => {
      setHistory((h) => h.map((m) => (m.id === id ? { ...m, ...patch } : m)));
      tell(patch);
    };
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

  /* Everything anyone sends, from any chat box or the voice: /btw asks on
   * the side without stopping anything; any other message interrupts the
   * task in progress (it goes out the moment that task has stopped) or
   * starts a new one. Returns false when there was nothing to send. */
  const submitText = (raw) => {
    const text = String(raw || '').trim();
    const btw = text.match(/^\/btw(?:\s+([\s\S]*))?$/i);
    if (btw) {
      const question = (btw[1] || '').trim();
      if (!question) { api.toast && api.toast('Type your question after /btw', 'info'); return false; }
      askBtw(question);
      return true;
    }
    // Slash commands run here and never reach the agent.
    const command = parseCommand(text, customRef.current);
    if (command?.kind === 'custom') {
      // Sent as a normal message: the history shows what was typed.
      setHistory((h) => [...h, { role: 'user', text }]);
      setActiveSkill(null);
      if (generatingRef.current) {
        interruptRef.current = command.prompt;
        if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
        return true;
      }
      onGenerateRef.current(command.prompt);
      return true;
    }
    if (command) {
      if (command.kind === 'unknown') {
        api.toast && api.toast(`Unknown command /${command.name}. Type / to see the commands.`, 'error');
        return false;
      }
      if (command.kind === 'skill') {
        if (!command.name) { api.toast && api.toast('Name the skill: /run <name>', 'info'); return false; }
        runSkill(command.name); // fills the prompt with the skill template
        return 'keep';
      }
      command.cmd.run(paletteApi);
      return true;
    }
    const sending = filesRef.current;
    if (!text && !sending.length) return false;
    const message = text || 'Have a look at what I attached.';
    outgoingFilesRef.current = sending;
    setAttached([]);
    setHistory((h) => [...h, { role: 'user', text: message, files: sending }]);
    setActiveSkill(null);
    if (generatingRef.current) {
      interruptRef.current = message;
      if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
      api.toast && api.toast('Stopping the current task to start yours…', 'info');
      return true;
    }
    onGenerateRef.current(message);
    return true;
  };

  const filesRef = useRef(attached);
  filesRef.current = attached;

  /* Picked, pasted or dropped files: upload now, send with the next message. */
  const addFiles = async (list) => {
    const picked = [...(list || [])];
    if (!picked.length) return;
    if (filesRef.current.length + picked.length > 10) {
      api.toast && api.toast('Up to 10 files per message.', 'info');
      return;
    }
    setUploading(true);
    try {
      const saved = await uploadAttachments(picked);
      setAttached((cur) => [...cur, ...saved]);
    } catch (e) {
      api.toast && api.toast(e.message || 'Could not attach that file', 'error');
    } finally {
      setUploading(false);
    }
  };
  const removeFile = (path) => setAttached((cur) => cur.filter((f) => f.path !== path));
  const onPaste = (e) => {
    const pasted = [...(e.clipboardData?.files || [])];
    if (pasted.length) { e.preventDefault(); addFiles(pasted); }
  };
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(e.dataTransfer?.files);
  };
  const submitTextRef = useRef(submitText);
  submitTextRef.current = submitText;

  const submit = () => {
    if (paletteOpen) return;
    const sent = submitText(prompt);
    if (!sent || sent === 'keep') return;
    setPrompt('');
    if (taRef.current) taRef.current.style.height = 'auto';
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
    // Open while choosing a command; closed once its text is being typed
    // ("/review src/app.js"), so Enter sends it. /run keeps it to pick a skill.
    setPaletteOpen(v.startsWith('/') && !/^\/(?!run\s)[\w-]+\s/i.test(v));
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
    if (cmd.custom) {
      // Leave "/name " in the box so anything typed after it fills {input}.
      setPaletteOpen(false);
      setPrompt(`/${trigger} `);
      setTimeout(() => taRef.current?.focus(), 30);
      return;
    }
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
    setPaletteOpen(false);
    setTimeout(() => taRef.current?.focus(), 30);
    // Commands without arguments execute immediately, and leave the box empty
    // so a second Enter can't send "/hooks" to the agent as a task.
    const argless = ['help', 'skills', 'drafts', 'save', 'zip', 'settings', 'clear', 'new', 'tools', 'hooks'];
    setPrompt(argless.includes(trigger) ? '' : `/${trigger} `);
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

      <ProjectBar
        sessionId={sessionId}
        busy={generating}
        toast={api.toast}
        onNewChat={(opts) => paletteApi.newSession(opts)}
        onOpenSession={(s) => { stopRun(); showSession(s); setShowHistory(true); }}
      />

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
            ) : m.role === 'cmd' ? (
              <div key={m.id} className="ai-panel__cmd" role="note">
                <div className="ai-panel__btw-head">
                  <span className="ai-panel__cmd-tag">COMMAND</span>
                  <span className="ai-panel__btw-q">{m.title}</span>
                  <button type="button" className="ai-panel__btw-x" onClick={() => dismissCmd(m.id)} aria-label="Dismiss" title="Dismiss">×</button>
                </div>
                <CommandOutput m={m} />
              </div>
            ) : m.role === 'media' ? (
              <div key={m.id} className="ai-panel__media">
                {m.items.map((it) => <MediaItem key={it.path} item={it} />)}
              </div>
            ) : (
              <div key={i} className={`ai-panel__row ai-panel__row-${m.role}`}>
                <span className="ai-panel__row-role">{m.role === 'user' ? 'You' : 'AI'}</span>
                <span className="ai-panel__row-text">
                  {m.text}
                  {m.files?.length > 0 && <FileChips files={m.files} />}
                </span>
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

        {showThinking && trace && trace.thinking && (
          <details className="ai-panel__thinking" open>
            <summary>Thinking…</summary>
            <ThinkingBody text={trace.thinking} />
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

        {cameraOn && (
          <div className="ai-panel__cam" role="status">
            {preview.src ? <img src={preview.src} alt="Live camera" /> : <span className="ai-panel__cam-wait">{preview.error || 'Connecting…'}</span>}
            <div>
              <b><span className="ai-panel__cam-dot" aria-hidden="true" /> Camera on</b>
              <span>{camera.state?.label || 'Camera'}: each message you send takes one picture.</span>
            </div>
            <button type="button" onClick={camera.toggle} aria-label="Turn the camera off" title="Turn the camera off">×</button>
          </div>
        )}
        {attached.length > 0 && <FileChips files={attached} onRemove={removeFile} />}

        <div
          className={`ai-panel__prompt-wrap${dragOver ? ' is-drop' : ''}`}
          onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <CommandPalette
            open={paletteOpen}
            query={paletteState ? paletteState.query : ''}
            onSelect={onPaletteSelect}
            onClose={() => setPaletteOpen(false)}
            skills={skills}
            custom={customCommands}
            api={paletteApi}
          />
          <div className="ai-panel__row">
            <input
              ref={fileInputRef}
              id="ai-panel-file-input"
              type="file"
              multiple
              accept={ACCEPT}
              hidden
              onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
            />
            <button
              type="button"
              className={`ai-panel__attach ai-panel__camera${cameraOn ? ' is-on' : ''}`}
              onClick={camera.toggle}
              aria-pressed={cameraOn}
              aria-label={cameraOn ? 'Turn the camera off' : 'Turn the camera on'}
              title={camera.state?.configured ? (cameraOn ? 'Camera on: each message takes a picture. Click to turn off.' : 'Turn the live camera on') : 'Choose a camera in Settings → Camera'}
            >
              <svg className="ai-panel__camera-icon" viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M3 8.5h4l2-2.5h6l2 2.5h4v10H3z" /><circle cx="12" cy="13" r="3.4" /></svg>
              {cameraOn && <span className="ai-panel__cam-dot ai-panel__cam-dot--badge" aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="ai-panel__attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              title="Attach pictures, PDFs, Word or Excel files (or paste / drop them here)"
              aria-label="Attach files"
            >
              {uploading ? '…' : '+'}
            </button>
            <textarea
              ref={taRef}
              className="ai-panel__input"
              rows={1}
              value={prompt}
              onChange={onChange}
              onKeyDown={onKey}
              onInput={onInput}
              onPaste={onPaste}
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
            {generating && !prompt.trim() && !attached.length ? (
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
              disabled={(!prompt.trim() && !attached.length) || uploading || paletteOpen}
              title={generating ? (/^\/btw\s/i.test(prompt) ? 'Ask on the side' : 'Interrupt and send') : 'Send'}
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


const MEDIA_RE = /\.(png|jpe?g|gif|webp|mp3|wav|m4a|mp4|webm|mov)$/i;

/* Workspace media paths in a tool result ({ saved: [...] } or { path }). */
function mediaFrom(result) {
  if (!result || typeof result !== 'object') return [];
  const paths = [...(Array.isArray(result.saved) ? result.saved : []), result.path, result.preview]
    .filter((p) => typeof p === 'string' && MEDIA_RE.test(p));
  return [...new Set(paths)].map((p) => ({
    path: p,
    kind: /\.(mp3|wav|m4a)$/i.test(p) ? 'audio' : /\.(mp4|webm|mov)$/i.test(p) ? 'video' : 'image',
  }));
}

function MediaItem({ item }) {
  const src = `/api/workspace/media?path=${encodeURIComponent(item.path)}`;
  return (
    <figure className={`ai-panel__media-item ai-panel__media-item--${item.kind}`}>
      {item.kind === 'image' && <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={item.path} loading="lazy" /></a>}
      {item.kind === 'audio' && <audio src={src} controls preload="none" />}
      {item.kind === 'video' && <video src={src} controls preload="metadata" />}
      <figcaption>{item.path}</figcaption>
    </figure>
  );
}

/* Attached files as small chips: a thumbnail for pictures, the name for the rest. */
function FileChips({ files, onRemove }) {
  return (
    <div className="ai-panel__files">
      {files.map((f) => (
        <span key={f.path} className={`ai-panel__file ai-panel__file--${f.kind}`} title={f.path}>
          {f.preview ? <img src={f.preview} alt="" /> : <span className="ai-panel__file-ext">{(f.name.split('.').pop() || 'file').slice(0, 4)}</span>}
          <span className="ai-panel__file-name">{f.name}</span>
          {onRemove && (
            <button type="button" onClick={() => onRemove(f.path)} aria-label={`Remove ${f.name}`} title="Remove">×</button>
          )}
        </span>
      ))}
    </div>
  );
}

/* The model's thinking, in a box of its own that scrolls. It follows the
 * newest text while you are at the bottom, and stays put once you scroll up
 * to read, until you scroll back down. */
function ThinkingBody({ text }) {
  const ref = useRef(null);
  const follow = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  const onScroll = () => {
    const el = ref.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  return <div ref={ref} className="ai-panel__thinking-body" onScroll={onScroll} tabIndex={0}>{text}</div>;
}

/* A command's answer: headed lists, or a note. */
export function CommandOutput({ m }) {
  return (
    <div className="cmd-out">
      {(m.sections || []).map((sec) => (
        <div key={sec.heading} className="cmd-out__sec">
          <div className="cmd-out__head">{sec.heading} <span>{sec.items.length}</span></div>
          {sec.items.length === 0
            ? <div className="cmd-out__none">none</div>
            : (
              <ul>
                {sec.items.map((it) => (
                  <li key={it.name}><code>{it.name}</code>{it.detail ? <span> — {it.detail}</span> : null}</li>
                ))}
              </ul>
            )}
        </div>
      ))}
      {m.note && <p className="cmd-out__note">{m.note}</p>}
    </div>
  );
}
