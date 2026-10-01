import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Preview } from './ApprovalModal.jsx';

/* Text chat inside Presence.
 *
 * Sending goes through gwn:submit-prompt — the same path as the main
 * composer — so it is the same conversation, and the reply drives the face,
 * the emotion engine and the voice exactly as a spoken question does.
 *
 * The log is built from gwn:agent-event, which AiPanel re-broadcasts for
 * every run, so replies to prompts typed in the main panel show up here too.
 * It lives at module level and starts listening as soon as the app loads, so
 * closing and reopening Presence does not lose the conversation.
 */

const MAX_MESSAGES = 200;
let messages = [];
let busy = false;
let seq = 0;
const subs = new Set();
let snapshot = { messages, busy };

function emit() {
  snapshot = { messages, busy };
  for (const fn of subs) fn();
}
function push(m) {
  messages = [...messages, { id: ++seq, at: Date.now(), ...m }].slice(-MAX_MESSAGES);
}
function patchLast(role, fn) {
  const i = messages.findLastIndex((m) => m.role === role && m.live);
  if (i < 0) return false;
  messages = messages.map((m, k) => (k === i ? fn(m) : m));
  return true;
}

/* A reply as it should read in a chat bubble: code files the agent wrote to
 * the preview are summarised rather than dumped in full. */
export function chatText(text) {
  const t = String(text || '');
  const files = [...t.matchAll(/<!--\s*FILE:\s*([^\s]+)\s*-->/g)].map((m) => m[1]);
  if (files.length) {
    const before = t.split(/<!--\s*FILE:/)[0].trim();
    return `${before ? `${before}\n\n` : ''}📄 wrote ${files.join(', ')}`;
  }
  if (/^\s*<!doctype html|^\s*<html/i.test(t)) return '📄 wrote a preview page';
  return t.trim();
}

function onAgentEvent(e) {
  const ev = e.detail || {};
  if (ev.heartbeat) return; // its own time, shown in the journal instead
  switch (ev.type) {
    case 'user_prompt':
      push({ role: 'user', text: ev.text });
      busy = true;
      break;
    case 'turn_start':
      // A new model turn replaces the last one's streaming text.
      if (!patchLast('bot', (m) => ({ ...m, text: '' }))) push({ role: 'bot', text: '', live: true });
      break;
    case 'delta':
      if (!patchLast('bot', (m) => ({ ...m, text: m.text + ev.text }))) push({ role: 'bot', text: ev.text, live: true });
      break;
    case 'tool_call':
      push({ role: 'tool', text: ev.name.replace(/^mcp__[^_]+__/, '').replace(/_/g, ' ') });
      break;
    case 'approval_request':
      // Answerable right here: the run is paused until someone decides.
      push({ role: 'approval', request: ev, state: 'pending' });
      break;
    case 'approval_resolved': {
      const i = messages.findLastIndex((m) => m.role === 'approval' && m.request.id === ev.id);
      if (i >= 0) messages = messages.map((m, k) => (k === i ? { ...m, state: ev.approved ? 'approved' : 'denied' } : m));
      break;
    }
    case 'done':
      expirePending();
      if (!patchLast('bot', (m) => ({ ...m, text: chatText(ev.text ?? m.text), live: false }))) {
        push({ role: 'bot', text: chatText(ev.text) });
      }
      busy = false;
      break;
    case 'error':
      patchLast('bot', (m) => ({ ...m, live: false }));
      expirePending();
      push({ role: 'system', text: `Error: ${ev.message}` });
      busy = false;
      break;
    default:
      return;
  }
  emit();
}

/* A run that ends leaves any unanswered approval moot. */
function expirePending() {
  messages = messages.map((m) => (m.role === 'approval' && m.state === 'pending' ? { ...m, state: 'expired' } : m));
}

async function decide(id, decision) {
  messages = messages.map((m) => (m.role === 'approval' && m.request.id === id ? { ...m, state: 'sending' } : m));
  emit();
  try {
    const r = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    // The approval_resolved event marks the card; this covers a lost stream.
    messages = messages.map((m) => (m.role === 'approval' && m.request.id === id && m.state === 'sending'
      ? { ...m, state: decision === 'deny' ? 'denied' : 'approved' } : m));
  } catch (err) {
    messages = messages.map((m) => (m.role === 'approval' && m.request.id === id ? { ...m, state: 'expired', error: err.message } : m));
  }
  emit();
}

function ApprovalCard({ m }) {
  const { request, state } = m;
  const verb = request.permission === 'execute' ? 'run' : request.permission === 'write' ? 'change a file with' : 'use';
  return (
    <div className={`pchat__approval is-${state}`}>
      <div className="pchat__approval-head">
        <span className={`pchat__perm is-${request.permission}`}>{request.permission}</span>
        It wants to {verb} <code>{request.tool}</code>
      </div>
      <div className="pchat__approval-body"><Preview preview={request.preview} /></div>
      {state === 'pending' && (
        <div className="pchat__approval-actions">
          <button type="button" className="is-deny" onClick={() => decide(request.id, 'deny')}>Deny</button>
          <button type="button" onClick={() => decide(request.id, 'session')}>Allow for session</button>
          <button type="button" className="is-allow" onClick={() => decide(request.id, 'once')}>Allow once</button>
        </div>
      )}
      {state === 'sending' && <div className="pchat__approval-state">sending…</div>}
      {state === 'approved' && <div className="pchat__approval-state is-ok">✓ allowed</div>}
      {state === 'denied' && <div className="pchat__approval-state is-no">✕ denied</div>}
      {state === 'expired' && <div className="pchat__approval-state">{m.error || 'no longer waiting'}</div>}
    </div>
  );
}

function onResult(e) {
  // A stopped or rejected run never sends done/error through the stream.
  if (!busy) return;
  const d = e.detail || {};
  if (d.stopped || d.error) {
    patchLast('bot', (m) => ({ ...m, live: false }));
    if (d.error && !messages.at(-1)?.text?.includes(d.error)) push({ role: 'system', text: `Error: ${d.error}` });
    if (d.stopped) push({ role: 'system', text: 'Stopped.' });
    expirePending();
    busy = false;
    emit();
  }
}

// One set of listeners per page. On a hot reload the new module replaces
// the old one's, rather than leaving it attached and feeding a stale log.
if (typeof window !== 'undefined') {
  const prev = window.__gwnPresenceChat;
  if (prev) {
    window.removeEventListener('gwn:agent-event', prev.onAgentEvent);
    window.removeEventListener('gwn:generation-result', prev.onResult);
  }
  window.__gwnPresenceChat = { onAgentEvent, onResult };
  window.addEventListener('gwn:agent-event', onAgentEvent);
  window.addEventListener('gwn:generation-result', onResult);
}

const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const getSnapshot = () => snapshot;

export default function PresenceChat() {
  const { messages: log, busy: running } = useSyncExternalStore(subscribe, getSnapshot);
  const [text, setText] = useState('');
  const listRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => { taRef.current?.focus(); }, []);

  const send = () => {
    const t = text.trim();
    if (!t || running) return;
    window.dispatchEvent(new CustomEvent('gwn:submit-prompt', { detail: { text: t } }));
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
    // Esc closes Presence; do not let a stray one while typing do that.
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (text) setText('');
      else taRef.current?.blur();
    }
  };

  return (
    <div className="pchat">
      <div className="pchat__log" ref={listRef} aria-live="polite">
        {log.length === 0 && (
          <p className="presence__empty">Ask Omi-One anything. It answers here, out loud, and with its face.</p>
        )}
        {log.map((m) => (m.role === 'approval'
          ? <ApprovalCard key={m.id} m={m} />
          : (
            <div key={m.id} className={`pchat__msg is-${m.role}${m.live ? ' is-live' : ''}`}>
              {m.role === 'tool' ? <span>⚙ {m.text}</span> : (m.text || (m.live ? '…' : ''))}
            </div>
          )))}
        {running && !log.some((m) => m.live) && <div className="pchat__msg is-bot is-live">…</div>}
      </div>
      <div className="pchat__input">
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={running ? 'It is working…' : 'Type a message — Enter to send'}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(140, e.target.scrollHeight)}px`;
          }}
          onKeyDown={onKey}
        />
        <button type="button" onClick={send} disabled={running || !text.trim()} aria-label="Send">➤</button>
      </div>
    </div>
  );
}
