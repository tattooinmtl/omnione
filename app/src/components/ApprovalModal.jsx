import { useEffect } from 'react';
import './ApprovalModal.css';

/* The human in the loop.
 *
 * The agent pauses when it wants to write a file or run a command, and this
 * is what it is waiting on. The prompt is only useful if it says what will
 * actually happen, so each kind of call renders its own preview: the exact
 * command line, the content about to be written, or the before/after of an
 * edit.
 *
 * "Allow for this session" is scoped to these exact arguments on the server,
 * not to the tool — approving `npm test` does not also approve `rm -rf /`.
 */
export default function ApprovalModal({ request, onDecide }) {
  // Enter allows once, Esc denies — but only those two, so a stray keypress
  // cannot grant a session-wide allow.
  //
  // And only when the keypress is meant for this dialog. Enter typed into
  // some other text box (the Presence chat, say, with this dialog hidden
  // behind it) must never approve a command the user has not seen. While
  // Presence is open it shows its own approval card, so this one stays
  // keyboard-silent altogether.
  useEffect(() => {
    const onKey = (e) => {
      if (document.querySelector('.presence')) return;
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (typing && !t.closest?.('.approval')) return;
      if (e.key === 'Escape') { e.preventDefault(); onDecide('deny'); }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onDecide('once'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDecide]);

  if (!request) return null;
  const { tool, permission, preview } = request;

  return (
    <div className="approval" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="approval__backdrop" />
      <div className="approval__panel">
        <header className="approval__head">
          <span className={`approval__badge approval__badge--${permission}`}>{permission}</span>
          <h3 id="approval-title">The agent wants to run <code>{tool}</code></h3>
        </header>

        <div className="approval__body">
          <Preview preview={preview} />
        </div>

        <footer className="approval__actions">
          <button type="button" className="approval__btn approval__btn--deny" onClick={() => onDecide('deny')}>
            Deny <kbd>Esc</kbd>
          </button>
          <button type="button" className="approval__btn" onClick={() => onDecide('session')}>
            Allow for this session
          </button>
          <button type="button" className="approval__btn approval__btn--primary" onClick={() => onDecide('once')}>
            Allow once <kbd>⏎</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}

export function Preview({ preview }) {
  if (!preview) return null;

  if (preview.kind === 'command') {
    return (
      <>
        <div className="approval__label">Command, in <code>{preview.cwd || '.'}</code></div>
        <pre className="approval__code approval__code--command">{preview.command}</pre>
      </>
    );
  }

  if (preview.kind === 'write') {
    return (
      <>
        <div className="approval__label">
          Write <code>{preview.path}</code> — {preview.lines} lines, {preview.bytes} bytes
        </div>
        <pre className="approval__code">{preview.excerpt}</pre>
      </>
    );
  }

  if (preview.kind === 'edit') {
    return (
      <>
        <div className="approval__label">Edit <code>{preview.path}</code></div>
        <pre className="approval__code approval__code--old">{preview.oldString}</pre>
        <div className="approval__arrow">↓</div>
        <pre className="approval__code approval__code--new">{preview.newString}</pre>
      </>
    );
  }

  if (preview.kind === 'post') {
    return (
      <>
        <div className="approval__label">
          {preview.title
            ? <>Post to the forum{preview.category ? <> in <code>{preview.category}</code></> : null}, publicly, under your account</>
            : <>Comment on forum post <code>#{preview.postId}</code>, publicly, under your account</>}
        </div>
        {preview.title && <pre className="approval__code approval__code--new"><b>{preview.title}</b></pre>}
        <pre className="approval__code">{preview.body}</pre>
      </>
    );
  }

  return <pre className="approval__code">{JSON.stringify(preview.args ?? preview, null, 2)}</pre>;
}
