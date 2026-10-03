import { useEffect, useRef, useState } from 'react';
import './CommandPalette.css';

/* Slash command palette. Shown when the user types `/` at the start of
 * the prompt. Up/Down cycle, Enter selects, Esc closes. Tab/Enter
 * completes the trigger into the textarea; commands with a `run` action
 * execute immediately.
 *
 * Commands are a mix of static (built-in: /help, /skills, /save, ...) and
 * dynamic (each uploaded skill becomes a /run <name> command).
 */

export const STATIC_COMMANDS = [
  { trigger: 'help',     description: 'Show keyboard shortcuts and the full command list',     run: (api) => api.runHelp() },
  { trigger: 'btw',      description: 'Ask a quick side question, even while Omi-One is working', run: () => {} },
  { trigger: 'skills',   description: 'Open the skills list (arrow-key navigator)',            run: (api) => api.openSkills() },
  { trigger: 'drafts',   description: 'Review skills the agent proposed from its own sessions', run: (api) => api.openDrafts() },
  { trigger: 'save',     description: 'Save the current project as a JSON file',               run: (api) => api.saveProject() },
  { trigger: 'zip',      description: 'Download the current project as a ZIP',                 run: (api) => api.downloadZip() },
  { trigger: 'settings', description: 'Open AI settings (provider, model, key)',                run: (api) => api.openSettings() },
  { trigger: 'clear',    description: 'Clear the prompt textarea',                              run: (api) => api.clearPrompt() },
  { trigger: 'new',      description: 'Start a new conversation (forget the current history)',  run: (api) => api.newSession() },
  { trigger: 'tools',    description: 'List the tools the AI can call (web, browser, MCP)',    run: (api) => api.openTools() },
  { trigger: 'hooks',    description: 'List registered hooks',                                  run: (api) => api.openHooks() },
];

/* Is this text a slash command? Returns
 *   null                         — not a command (plain text, or a path like /usr/bin)
 *   { kind: 'static', cmd, arg } — one of the commands above
 *   { kind: 'skill', name }      — /run <skill>
 *   { kind: 'unknown', name }    — looks like a command, but there is no such command
 * Every chat box runs this before anything reaches the agent, so a command
 * is never sent to Omi-One as a task. (/btw is handled by its caller.) */
export function parseCommand(text) {
  const m = String(text || '').trim().match(/^\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  const arg = (m[2] || '').trim();
  if (name === 'run') return { kind: 'skill', name: arg };
  const cmd = STATIC_COMMANDS.find((c) => c.trigger === name);
  return cmd ? { kind: 'static', cmd, arg } : { kind: 'unknown', name };
}

function filterCommands(commands, query) {
  if (!query) return commands;
  const q = query.toLowerCase().trim();
  const rank = (c) => {
    const t = c.trigger.toLowerCase();
    if (t === q) return 0;            // /hooks → /hooks, first
    if (t.startsWith(q)) return 1;
    if (t.includes(q)) return 2;
    return 3;                          // matched on the description only
  };
  return commands
    .filter((c) => c.trigger.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

export default function CommandPalette({
  open, query, onSelect, onClose, skills = [], api,
}) {
  const [cursor, setCursor] = useState(0);
  const listRef = useRef(null);

  // Build the full command list: static + per-skill `/run <name>` entry
  const commands = useRef([
    ...STATIC_COMMANDS,
    ...skills.map((s) => ({
      trigger: `run ${s.name}`,
      description: s.description || `Run the "${s.name}" skill`,
      skill: s.name,
      run: (a) => a.runSkill(s.name),
    })),
  ]).current;

  const filtered = filterCommands(commands, query);
  const safe = filtered.length === 0 ? [] : filtered;
  const idx = cursor >= safe.length ? 0 : cursor;

  // Reset cursor when the result set changes
  useEffect(() => { setCursor(0); }, [query, open]);

  // Keep the selected row in view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${idx}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  // Keyboard nav. Focus stays in the prompt box while the palette is open,
  // so the keys are caught on the window: the palette itself never has focus.
  const onKey = (e) => {
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % Math.max(safe.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + safe.length) % Math.max(safe.length, 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = safe[idx];
      if (cmd) onSelect(cmd);
    } else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  useEffect(() => {
    if (!open) return undefined;
    const h = (e) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(e.key)) return;
      // Tab picks the highlighted command, like Enter.
      onKeyRef.current(e.key === 'Tab' ? { key: 'Enter', preventDefault: () => e.preventDefault() } : e);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);

  if (!open) return null;

  return (
    <div className="cmd-palette" tabIndex={-1} ref={listRef}>
      <div className="cmd-palette__head">
        <span className="cmd-palette__head-prefix">/</span>
        <span className="cmd-palette__head-query">{query}</span>
        <span className="cmd-palette__head-count">{safe.length} command{safe.length === 1 ? '' : 's'}</span>
      </div>
      {safe.length === 0 ? (
        <div className="cmd-palette__empty">No matching commands. Press Esc to close.</div>
      ) : (
        <ul className="cmd-palette__list" role="listbox">
          {safe.map((c, i) => (
            <li
              key={c.trigger}
              data-idx={i}
              role="option"
              aria-selected={i === idx}
              className={`cmd-palette__item ${i === idx ? 'is-active' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => { e.preventDefault(); onSelect(c); }}
            >
              <span className="cmd-palette__trigger">/{c.trigger}</span>
              <span className="cmd-palette__desc">{c.description}</span>
              {c.skill && <span className="cmd-palette__tag">SKILL</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="cmd-palette__foot">
        <kbd>↑↓</kbd> navigate · <kbd>Enter</kbd> select · <kbd>Esc</kbd> close
      </div>
    </div>
  );
}
