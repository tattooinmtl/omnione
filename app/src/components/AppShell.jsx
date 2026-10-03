import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import NeuralBackdrop from '../three/NeuralBackdrop.jsx';
import AiPanel from './AiPanel.jsx';
import PreviewPanel from './PreviewPanel.jsx';
import CodeEditor from './CodeEditor.jsx';
import SettingsModal from './SettingsModal.jsx';
import SkillsModal from './SkillsModal.jsx';
import DraftsModal from './DraftsModal.jsx';
import PresenceView, { PresenceOrb } from './PresenceView.jsx';
import { STATIC_COMMANDS } from './CommandPalette.jsx';
import AccountBar from './account/AccountBar.jsx';
import StatsView from './stats/StatsView.jsx';
import DoctorView from './doctor/DoctorView.jsx';
import { parseFiles, combineForPreview, FILE_MARKER_RE } from '../utils/gameFiles.js';
import { downloadZip } from '../utils/projectIO.js';
import { loadProject } from '../utils/projectStore.js';
import useWorkspace from '../hooks/useWorkspace.js';
import { ws, baseName } from '../utils/workspaceApi.js';
import { pickPreviewPage, pageRefs } from '../utils/previewFiles.js';
import './AppShell.css';
import './HelpModal.css';

/* OmniOne Agent Harness.
 *
 * Three vertically stacked, user-resizable panels:
 *   1. AI prompt + chat + context meter
 *   2. Live HTML / Three.js preview iframe
 *   3. The project's real files: tabs (plan.md first) + Monaco, or the file
 *      explorer, switched with one button (CodeEditor.jsx)
 *
 * The project is the workspace folder on disk (useWorkspace). The preview is
 * built from its real files. Top bar: Save all, and Export project (a ZIP).
 * Settings modal (⚙) holds the AI provider config and a token chart.
 *
 * Layout: CSS grid with three `auto` rows whose fr values are driven by
 * `sizes` (percent of available height). The drag handle updates the two
 * surrounding fr values while preserving the third.
 */

const DEFAULT_SIZES = [38, 34, 28]; // AI, Preview, Editor (sum = 100)
const MIN_SIZE = 12;

export default function AppShell() {
  const navigate = useNavigate();
  const [sizes, setSizes] = useState(() => {
    try {
      const raw = localStorage.getItem('gwn:layout-sizes');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length === 3) return parsed;
      }
    } catch { /* ignore */ }
    return DEFAULT_SIZES;
  });
  const [previewEpoch, setPreviewEpoch] = useState(0);
  const [toast, setToast] = useState({ msg: '', kind: 'info' });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const [presenceOpen, setPresenceOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('ai');
  const [doctorOpen, setDoctorOpen] = useState(false);
  const [fixesPending, setFixesPending] = useState(0);
  const openSettings = useCallback((tab = 'ai') => { setSettingsTab(tab); setSettingsOpen(true); }, []);

  // The tray icon opens the window at #settings, #settings-access,
  // #settings-app or #doctor; so can a link. The hash is cleared after use.
  useEffect(() => {
    const route = () => {
      const h = window.location.hash.replace(/^#/, '');
      if (!h) return;
      if (h === 'doctor') { setSettingsOpen(false); setDoctorOpen(true); }
      else if (h.startsWith('settings')) { setDoctorOpen(false); openSettings(h.split('-')[1] || 'ai'); }
      else return;
      history.replaceState(null, '', window.location.pathname + window.location.search);
    };
    route();
    window.addEventListener('hashchange', route);
    return () => window.removeEventListener('hashchange', route);
  }, [openSettings]);

  // Fixes Omi-One prepared and nobody has looked at: a badge in the account menu.
  useEffect(() => {
    let alive = true;
    const check = () => fetch('/api/fixes').then((r) => r.json())
      .then((j) => { if (alive) setFixesPending((j.fixes || []).filter((f) => f.status === 'pending').length); })
      .catch(() => {});
    check();
    const t = setInterval(check, 20_000);
    window.addEventListener('gwn:fixes-changed', check);
    window.addEventListener('gwn:generation-result', check);
    return () => { alive = false; clearInterval(t); window.removeEventListener('gwn:fixes-changed', check); window.removeEventListener('gwn:generation-result', check); };
  }, []);
  const [account, setAccount] = useState(null);
  useEffect(() => {
    const onAccount = (e) => setAccount(e.detail || null);
    window.addEventListener('gwn:account', onAccount);
    return () => window.removeEventListener('gwn:account', onAccount);
  }, []);
  // Skills the agent has proposed and nobody has reviewed. Surfaced as a
  // badge, because a proposal nobody looks at is the same as no proposal.
  const [draftCount, setDraftCount] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [trace, setTrace] = useState({ steps: [], status: 'idle', narration: '' });


  // Persist layout sizes
  useEffect(() => {
    try { localStorage.setItem('gwn:layout-sizes', JSON.stringify(sizes)); } catch { /* ignore */ }
  }, [sizes]);

  // Poll the draft count on mount and whenever the skills SSE channel says
  // something changed — reflection runs after a response is sent, so a draft
  // can appear with no user action to hang an update off.
  useEffect(() => {
    let cancelled = false;
    const refreshDrafts = async () => {
      try {
        const r = await fetch('/api/skills/drafts');
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setDraftCount((j.drafts || []).length);
      } catch { /* server not up yet */ }
    };
    refreshDrafts();

    let es;
    try {
      es = new EventSource('/api/skills/events');
      es.onmessage = () => refreshDrafts();
    } catch { /* no SSE; the mount fetch still populated it */ }
    return () => { cancelled = true; if (es) es.close(); };
  }, []);

  const showToast = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind });
  }, []);

  // The project = the real files in the workspace folder.
  const wsp = useWorkspace({ toast: showToast });

  // Before 0.4 the project lived in the browser. Once, if the project folder
  // is empty, write that project into it so nothing is lost.
  useEffect(() => {
    const MOVED = 'gwn:project-moved-to-disk';
    try { if (localStorage.getItem(MOVED)) return; } catch { return; }
    const stored = loadProject();
    ws.tree().then(async (t) => {
      if ((t.entries || []).length || !stored?.files || !Object.keys(stored.files).length) {
        try { localStorage.setItem(MOVED, '1'); } catch { /* ignore */ }
        return;
      }
      const written = await wsp.writeFiles(stored.files);
      if (written.length === Object.keys(stored.files).length) {
        try { localStorage.setItem(MOVED, '1'); } catch { /* ignore */ }
        showToast(`Your project is now saved as real files (${written.length}) in the project folder`, 'info');
      }
    }).catch(() => { /* server not up yet: try again next time */ });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize handling: dragging changes sizes[0] and sizes[1] (sizes[2] absorbs the rest).
  // Layout is left-to-right, so we track clientX against the container width.
  const dragRef = useRef(null);
  const onHandleDown = (which) => (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startSizes = [...sizes];
    const containerWidth = e.currentTarget.parentElement.getBoundingClientRect().width;
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dPct = (dx / containerWidth) * 100;
      const next = [...startSizes];
      if (which === 'ai-preview') {
        next[0] = clamp(startSizes[0] + dPct, MIN_SIZE, 100 - MIN_SIZE - next[2]);
        next[1] = clamp(startSizes[1] - dPct, MIN_SIZE, 100 - MIN_SIZE - next[2]);
      } else {
        next[1] = clamp(startSizes[1] + dPct, MIN_SIZE, 100 - MIN_SIZE - next[0]);
        next[2] = clamp(startSizes[2] - dPct, MIN_SIZE, 100 - MIN_SIZE - next[0]);
      }
      setSizes(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  // The preview: the page chosen by pickPreviewPage and the files it links,
  // read from disk, with unsaved edits in open tabs on top (so the preview
  // follows typing). Rebuilt when files change on disk or in a tab.
  const [previewSrcDoc, setPreviewSrcDoc] = useState('');
  const filePaths = useMemo(() => wsp.entries.filter((e) => e.type === 'file').map((e) => e.path), [wsp.entries]);
  const tabText = useMemo(() => {
    const m = new Map();
    for (const t of wsp.tabs) if (!t.binary && !t.tooLarge) m.set(t.path, t.content);
    return m;
  }, [wsp.tabs]);
  const page = pickPreviewPage(filePaths, wsp.active);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(async () => {
      if (!page) { if (alive) setPreviewSrcDoc(''); return; }
      const text = async (p) => (tabText.has(p) ? tabText.get(p) : (await ws.read(p)).content ?? '');
      try {
        const html = await text(page);
        const files = { 'index.html': html };
        for (const { ref, path } of pageRefs(page, html)) {
          if (filePaths.includes(path)) files[ref] = await text(path);
        }
        if (alive) setPreviewSrcDoc(combineForPreview(files));
      } catch { /* a file vanished mid-read; the next change rebuilds */ }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [page, filePaths, tabText, previewEpoch]);

  // AI flow: parseFiles on the response, then ingest. Listens for progress
  // events from AiPanel during streaming so the trace stays live.
  useEffect(() => {
    const onProgress = (ev) => {
      const { step, thinking, delta, chars } = ev.detail || {};
      setTrace((t) => {
        let nextSteps = t.steps;
        if (step) {
          const i = nextSteps.findIndex((s) => s.id === step.id);
          if (i === -1) nextSteps = [...nextSteps, step];
          else {
            nextSteps = [...nextSteps];
            nextSteps[i] = { ...nextSteps[i], ...step };
          }
        }
        const nextThinking = thinking != null
          ? (t.thinking || '') + thinking
          : t.thinking;
        const narration = delta != null
          ? `Writing code… ${(chars || 0).toLocaleString()} chars`
          : t.narration;
        return { ...t, steps: nextSteps, thinking: nextThinking, narration, status: 'running' };
      });
    };
    window.addEventListener('gwn:generation-progress', onProgress);
    return () => window.removeEventListener('gwn:generation-progress', onProgress);
  }, []);

  const onGenerate = useCallback(async (promptText) => {
    if (generating) return;
    setGenerating(true);
    setTrace({ steps: [], status: 'running', narration: `Working on: ${promptText.slice(0, 80)}`, thinking: '' });

    const handler = (ev) => {
      const { result, error, stopped } = ev.detail || {};
      window.removeEventListener('gwn:generation-result', handler);
      setGenerating(false);
      wsp.setAutoOpen(false);
      if (stopped) {
        // A cancelled run is not a failure and has no output to ingest —
        // partial text would splice half a file into the editor.
        setTrace((t) => ({ ...t, status: 'stopped', narration: 'Stopped' }));
        return;
      }
      if (error) {
        setTrace((t) => ({ ...t, status: 'error', narration: `Error: ${error}` }));
        showToast(error, 'error');
        return;
      }
      if (typeof result === 'string' && result.trim()) {
        // Only an answer that IS code becomes files: FILE markers, or a whole
        // HTML page. A plain answer stays in the chat and touches no file.
        const isCode = new RegExp(FILE_MARKER_RE.source, 'im').test(result) || /<!doctype html|<html[\s>]/i.test(result);
        if (isCode) {
          const files = parseFiles(result);
          wsp.writeFiles(files).then((written) => {
            setPreviewEpoch((n) => n + 1);
            if (written.length) showToast(`Saved ${written.length} file(s) in the project`, 'info');
          });
          setTrace((t) => ({ ...t, status: 'done', steps: [...t.steps, { id: 'write', label: 'Write files', status: 'done' }] }));
        } else {
          setTrace((t) => ({ ...t, status: 'done' }));
        }
      } else {
        setTrace((t) => ({ ...t, status: 'error', narration: 'Empty response from AI' }));
        showToast('Empty response from AI', 'error');
      }
    };
    window.addEventListener('gwn:generation-result', handler);
    // Files Omi-One writes during this run open as tabs.
    wsp.setAutoOpen(true);

    // Omi-One reads the project's files itself with its tools; the editor
    // no longer pastes them into every prompt.
    window.dispatchEvent(new CustomEvent('gwn:request-generation', {
      detail: { prompt: promptText },
    }));
  }, [generating, showToast, wsp]);

  // SAVE: every open file with unsaved changes, to disk.
  const onSave = useCallback(async () => {
    const r = await wsp.saveAll();
    showToast(r.dirty ? `Saved ${r.saved} of ${r.dirty} file(s)` : 'Everything is saved', r.saved < r.dirty ? 'error' : 'info');
  }, [wsp, showToast]);

  // EXPORT PROJECT: the project's text files as a ZIP (unsaved edits included).
  const onDownloadZip = useCallback(async () => {
    try {
      const files = {};
      let skipped = 0;
      for (const p of filePaths.slice(0, 2000)) {
        if (tabText.has(p)) { files[p] = tabText.get(p); continue; }
        const f = await ws.read(p);
        if (typeof f.content === 'string') files[p] = f.content; else skipped += 1;
      }
      const filename = await downloadZip(files, baseName(wsp.root.replace(/\\/g, '/')) || 'omnione-project');
      showToast(`Downloaded ${filename}${skipped ? ` (${skipped} non-text file(s) left out)` : ''}`, 'info');
    } catch (e) {
      showToast(e.message || 'ZIP failed', 'error');
    }
  }, [filePaths, tabText, wsp.root, showToast]);

  return (
    <div className="shell">
      <div className="shell__backdrop"><NeuralBackdrop /></div>
      <div className="grain-overlay" />
      <div className="scanlines-overlay" />

      <header className="shell__topbar">
        <div className="shell__brand">
          <span className="shell__brand-name">OmniOne</span>
          <span className="shell__brand-sep">/</span>
          <span className="shell__brand-sub">AGENT-HARNESS</span>
        </div>
        <div className="shell__topbar-actions">
          <PresenceOrb onClick={() => setPresenceOpen(true)} />
          <button type="button" className="shell__btn" onClick={() => setHelpOpen(true)} title="Help (/)">?</button>
          <button type="button" className="shell__btn" onClick={() => setSkillsOpen(true)} title="Skills (type /skills)">SKILLS</button>
          {draftCount > 0 && (
            <button
              type="button"
              className="shell__btn shell__btn--drafts"
              onClick={() => setDraftsOpen(true)}
              title={`${draftCount} skill(s) the agent proposed, awaiting your review`}
            >
              PROPOSED <span className="shell__badge">{draftCount}</span>
            </button>
          )}
          <button type="button" className="shell__btn" onClick={onSave} title="Save every open file with unsaved changes (Ctrl+S saves the one in front)">SAVE{wsp.dirtyCount > 0 && <span className="shell__badge">{wsp.dirtyCount}</span>}</button>
          <button type="button" className="shell__btn shell__btn--primary" onClick={onDownloadZip} title="Download the project folder's files as a ZIP">EXPORT PROJECT</button>
          <button type="button" className="shell__btn shell__btn--icon" onClick={() => setSettingsOpen(true)} title="AI settings">⚙</button>
          <button type="button" className="shell__btn shell__btn--icon" onClick={() => navigate('/')} title="Back to splash">↩</button>
        </div>
      </header>

      <main
        className="shell__panes"
        style={{
          gridTemplateColumns: `${sizes[0]}fr 6px ${sizes[1]}fr 6px ${sizes[2]}fr`,
        }}
      >
        <section className="shell__pane shell__pane--ai">
          <div className="shell__ai-main">
          <AiPanel
            onGenerate={onGenerate}
            generating={generating}
            trace={trace}
            api={{
              // A command typed in Presence opens its panel in front:
              // Presence covers everything, so it closes first.
              openHelp: () => { setPresenceOpen(false); setHelpOpen(true); },
              openSkills: () => { setPresenceOpen(false); setSkillsOpen(true); },
              openDrafts: () => { setPresenceOpen(false); setDraftsOpen(true); },
              openSettings: () => { setPresenceOpen(false); setSettingsOpen(true); },
              saveProject: onSave,
              downloadZip: onDownloadZip,
              toast: showToast,
            }}
          />
          </div>
          <AccountBar
            onOpenSettings={() => openSettings('ai')}
            onOpenStats={() => setStatsOpen(true)}
            onOpenDoctor={() => setDoctorOpen(true)}
            fixesPending={fixesPending}
            onOpenHelp={() => setHelpOpen(true)}
            toast={showToast}
          />
        </section>
        <div className="shell__handle" onMouseDown={onHandleDown('ai-preview')} role="separator" aria-orientation="vertical" />

        <section className="shell__pane shell__pane--preview">
          <PreviewPanel
            srcDoc={previewSrcDoc}
            epoch={previewEpoch}
            onError={(msg) => showToast(msg, 'error')}
          />
        </section>
        <div className="shell__handle" onMouseDown={onHandleDown('preview-editor')} role="separator" aria-orientation="vertical" />

        <section className="shell__pane shell__pane--editor">
          <CodeEditor wsp={wsp} toast={showToast} />
        </section>
      </main>

      {settingsOpen && (
        <SettingsModal
          initialTab={settingsTab}
          onClose={() => setSettingsOpen(false)}
          onOpenDoctor={() => { setSettingsOpen(false); setDoctorOpen(true); }}
        />
      )}
      {skillsOpen && (
        <SkillsModal
          onClose={() => setSkillsOpen(false)}
          onRunSkill={(s) => {
            setSkillsOpen(false);
            // Fire a window event so AiPanel can pick it up and prefill the prompt
            window.dispatchEvent(new CustomEvent('gwn:run-skill-from-modal', { detail: { name: s.name } }));
            showToast(`Loaded skill /${s.name} into the prompt`, 'info');
          }}
        />
      )}
      {draftsOpen && (
        <DraftsModal
          onClose={() => setDraftsOpen(false)}
          toast={showToast}
          onApproved={() => setDraftCount((n) => Math.max(0, n - 1))}
        />
      )}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      {presenceOpen && <PresenceView onClose={() => setPresenceOpen(false)} toast={showToast} />}
      {statsOpen && <StatsView onClose={() => setStatsOpen(false)} account={account} />}
      {doctorOpen && <DoctorView onClose={() => setDoctorOpen(false)} />}

      {toast.msg && (
        <div className={`shell__toast shell__toast-${toast.kind}`} onAnimationEnd={() => setToast({ msg: '', kind: 'info' })}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function HelpModal({ onClose }) {
  return (
    <div className="help-modal" role="dialog" aria-modal="true">
      <div className="help-modal__backdrop" onClick={onClose} />
      <div className="help-modal__panel">
        <header className="help-modal__head">
          <h3>OmniOne · HELP</h3>
          <button type="button" className="help-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="help-modal__body">
          <h4>Slash commands</h4>
          <p>Type <code>/</code> in the prompt to open the command palette. <kbd>↑</kbd>/<kbd>↓</kbd> to navigate, <kbd>Enter</kbd> to select. Commands work the same in the Presence chat, and are never sent to Omi-One as a task.</p>
          <table className="help-modal__table">
            <tbody>
              {/* The same list the palette and the command parser use, so it can't drift. */}
              {STATIC_COMMANDS.map((c) => (
                <tr key={c.trigger}><td><code>/{c.trigger}{c.trigger === 'btw' ? ' <question>' : ''}</code></td><td>{c.description}</td></tr>
              ))}
              <tr><td><code>/run &lt;name&gt;</code></td><td>Load a skill into the prompt (one entry per installed skill)</td></tr>
            </tbody>
          </table>

          <h4>Conversations</h4>
          <p>The agent remembers the current conversation, so you can correct it or ask a follow-up and it keeps the context. One prompt can take several model turns: if the agent calls a tool, it reads the result and decides what to do next, up to 25 turns. Watch the trace panel to see each turn and each tool call. <code>/new</code> starts a fresh conversation; old transcripts are kept under <code>.sessions/</code>.</p>

          <h4>Three panes</h4>
          <p>Drag the vertical splitters between the AI / Preview / Code panels to resize. Layout is persisted in <code>localStorage</code>.</p>

          <h4>Your project's files</h4>
          <p>The code pane shows the real files in the project folder (⚙ Settings → workspace). <strong>▤ FILES</strong> switches it to the file list; the same button, now <strong>‹› CODE</strong>, switches back. Click a file to open it in a tab. Right-click a file, folder or tab for Save, Save as, Rename, Move, Duplicate, New file/folder, Copy path, Show in Explorer and Delete (to the Recycle Bin). <kbd>Ctrl</kbd>+<kbd>S</kbd> saves, <kbd>F2</kbd> renames, <kbd>Del</kbd> deletes. When Omi-One builds something, it writes <code>plan.md</code> first; it is always the first tab, and Omi-One ticks the steps off as it goes. The preview shows the project's HTML page (the one in front, or <code>index.html</code>).</p>

          <h4>Skills</h4>
          <p>Click the <strong>SKILLS</strong> button (or <code>/skills</code>) to open the navigator. <kbd>U</kbd> uploads a folder from your file system, <kbd>R</kbd> re-scans the <code>skills/</code> folder. Every skill is a <code>SKILL.md</code> with YAML frontmatter (name + description) and a body of instructions the AI follows when the skill is run.</p>

          <h4>AI providers</h4>
          <p>Open <strong>⚙ Settings</strong>. The built-in <code>OmniOne Local</code> stub needs no key; the other providers (MiniMax, OpenAI, Anthropic) require a key, which is stored locally in <code>.gwn-secrets.json</code> — the UI only ever sees a 4-character hint.</p>

          <h4>Hooks &amp; tools</h4>
          <p>The agent calls tools through the provider's native tool-calling API: <code>web_search</code>, <code>browser_open</code>, and every tool exposed by the MCP servers registered in <code>.gwn-mcp.json</code>. Registered hooks fire on <code>UserPromptSubmit</code> (can rewrite the prompt), <code>PreToolUse</code> (can rewrite arguments or block the call), and <code>PostToolUse</code>.</p>
        </div>
      </div>
    </div>
  );
}
