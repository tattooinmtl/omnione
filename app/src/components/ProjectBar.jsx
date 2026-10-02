import { useCallback, useEffect, useRef, useState } from 'react';
import './ProjectBar.css';

/* The project bar at the top of the chat.
 *
 *   [ ▣ ESP32 ▾ ]  [ Chats ▾ ]  [ + New chat ]
 *
 * A project is a separate thread of work with its own notes, goals and chats
 * (server/projects.js). "General" is no project: nothing project-specific is
 * loaded. Switching opens the project's latest chat. Omi-One can also create
 * or switch projects itself; the bar notices after each answer.
 */

async function call(url, opts = {}) {
  const r = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `status ${r.status}`);
  return j;
}

function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(s)) return '';
  if (s < 90) return 'now';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export default function ProjectBar({ sessionId, onOpenSession, onNewChat, toast, busy }) {
  const [state, setState] = useState({ projects: [], active: null });
  const [menu, setMenu] = useState(null); // 'projects' | 'chats' | null
  const [chats, setChats] = useState([]);
  const [naming, setNaming] = useState(false);
  const [newName, setNewName] = useState('');
  const root = useRef(null);
  const known = useRef(undefined); // the project the chat is showing
  // The parent's callbacks change every render; read them through a ref so
  // the listeners below are registered once.
  const cb = useRef({});
  cb.current = { onOpenSession, onNewChat, toast };

  const active = state.projects.find((p) => p.id === state.active) || null;

  // Open a project's latest chat (or a fresh one).
  const openProjectChat = useCallback(async () => {
    try {
      const { session } = await call('/api/sessions/resume');
      cb.current.onOpenSession(session || null);
    } catch { cb.current.onOpenSession(null); }
  }, []);

  const refresh = useCallback(async ({ follow = true } = {}) => {
    try {
      const j = await call('/api/projects');
      setState(j);
      // Omi-One switched or created a project: the next message goes to it.
      if (follow && known.current !== undefined && j.active !== known.current) {
        known.current = j.active;
        cb.current.onNewChat({ quiet: true, keepView: true });
        const p = j.projects.find((x) => x.id === j.active);
        cb.current.toast?.(p ? `Now in project "${p.name}"` : 'Back to general chat', 'info');
      }
      known.current = j.active;
    } catch { /* server not up yet */ }
  }, []);

  useEffect(() => { refresh({ follow: false }); }, [refresh]);
  useEffect(() => {
    const onResult = () => refresh();
    window.addEventListener('gwn:generation-result', onResult);
    return () => window.removeEventListener('gwn:generation-result', onResult);
  }, [refresh]);

  // Close menus on outside click / Escape.
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => { if (root.current && !root.current.contains(e.target)) { setMenu(null); setNaming(false); } };
    const onKey = (e) => { if (e.key === 'Escape') { setMenu(null); setNaming(false); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const switchTo = async (id) => {
    setMenu(null);
    if (id === state.active) return;
    try {
      const j = await call('/api/projects/switch', { method: 'POST', body: JSON.stringify({ id }) });
      setState(j);
      known.current = j.active;
      await openProjectChat();
      const p = j.projects.find((x) => x.id === j.active);
      toast?.(p ? `Project "${p.name}"` : 'General chat (no project)', 'info');
    } catch (e) { toast?.(e.message, 'error'); }
  };

  const create = async (e) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const j = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
      setState(j);
      known.current = j.active;
      setNaming(false);
      setNewName('');
      setMenu(null);
      onNewChat({ quiet: true });
      toast?.(`New project "${j.project.name}"`, 'info');
    } catch (err) { toast?.(err.message, 'error'); }
  };

  const openChats = async () => {
    if (menu === 'chats') { setMenu(null); return; }
    setMenu('chats');
    try {
      const j = await call('/api/sessions?project=current&limit=20');
      setChats(j.sessions || []);
    } catch { setChats([]); }
  };

  const openChat = async (id) => {
    setMenu(null);
    if (id === sessionId) return;
    try {
      const j = await call(`/api/sessions/${encodeURIComponent(id)}`);
      onOpenSession(j.session || j);
    } catch (e) { toast?.(e.message, 'error'); }
  };

  return (
    <div className="pbar" ref={root}>
      <button
        type="button"
        className={`pbar__project${active ? '' : ' is-general'}`}
        onClick={() => { setMenu(menu === 'projects' ? null : 'projects'); setNaming(false); }}
        aria-haspopup="menu"
        aria-expanded={menu === 'projects'}
        title="Projects: each has its own notes, goals and chats"
        disabled={busy}
      >
        <span className="pbar__icon" aria-hidden="true">{active ? '▣' : '○'}</span>
        <span className="pbar__name">{active ? active.name : 'General'}</span>
        <span aria-hidden="true">▾</span>
      </button>
      <button type="button" className="pbar__btn" onClick={openChats} aria-haspopup="menu" aria-expanded={menu === 'chats'} disabled={busy} title="Chats in this project">
        Chats ▾
      </button>
      <button type="button" className="pbar__btn pbar__btn--new" onClick={() => onNewChat()} disabled={busy} title="Start a new chat in this project">
        + New chat
      </button>

      {menu === 'projects' && (
        <div className="pbar__menu" role="menu">
          <button type="button" role="menuitem" className={`pbar__item${!state.active ? ' is-on' : ''}`} onClick={() => switchTo(null)}>
            <span className="pbar__check">{!state.active ? '✓' : ''}</span>
            <span>General <em>no project</em></span>
          </button>
          {state.projects.map((p) => (
            <button type="button" role="menuitem" key={p.id} className={`pbar__item${p.active ? ' is-on' : ''}`} onClick={() => switchTo(p.id)}>
              <span className="pbar__check">{p.active ? '✓' : ''}</span>
              <span>{p.name}</span>
            </button>
          ))}
          <div className="pbar__sep" />
          {naming ? (
            <form className="pbar__new" onSubmit={create}>
              <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Project name" maxLength={60} />
              <button type="submit" disabled={!newName.trim()}>Create</button>
            </form>
          ) : (
            <button type="button" role="menuitem" className="pbar__item pbar__item--new" onClick={() => setNaming(true)}>
              <span className="pbar__check">+</span>
              <span>New project…</span>
            </button>
          )}
        </div>
      )}

      {menu === 'chats' && (
        <div className="pbar__menu pbar__menu--chats" role="menu">
          <div className="pbar__menu-head">{active ? active.name : 'General'} · chats</div>
          {chats.length === 0 && <div className="pbar__empty">No chats yet.</div>}
          {chats.map((c) => (
            <button type="button" role="menuitem" key={c.id} className={`pbar__item${c.id === sessionId ? ' is-on' : ''}`} onClick={() => openChat(c.id)}>
              <span className="pbar__check">{c.id === sessionId ? '●' : ''}</span>
              <span className="pbar__chat-title">{c.title}</span>
              <span className="pbar__when">{ago(c.updatedAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
