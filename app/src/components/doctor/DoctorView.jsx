import { useCallback, useEffect, useState } from 'react';
import './DoctorView.css';

/* Doctor & fixes.
 *
 * Omi-One scans the PC (pc_diag) and prepares fixes (propose_fix). A fix is
 * only a plan until you press Apply here: this is the one place where
 * anything outside Omi-One's folder gets changed. Applied fixes can be
 * undone (files and settings are backed up).
 */

const SCAN_PROMPT = 'Run a doctor scan of this PC with pc_diag. Explain what you find in plain words, most important first. '
  + 'For problems worth fixing, prepare fixes with propose_fix (one problem per fix) and tell me they are waiting in Doctor & fixes. Don\'t change anything yourself.';

const STATUS = {
  pending: { label: 'Waiting for you', tone: 'hold' },
  applying: { label: 'Applying…', tone: 'hold' },
  applied: { label: 'Applied', tone: 'ok' },
  failed: { label: 'Failed', tone: 'bad' },
  rejected: { label: 'Rejected', tone: 'muted' },
  undone: { label: 'Undone', tone: 'muted' },
};

function Step({ s, i, result }) {
  let detail = null;
  switch (s.kind) {
    case 'edit_file':
      detail = (
        <>
          <code className="doc-path">{s.path}</code>
          <div className="doc-diff">
            <pre className="doc-diff__old">{s.old_string}</pre>
            <pre className="doc-diff__new">{s.new_string}</pre>
          </div>
        </>
      );
      break;
    case 'write_file':
      detail = (
        <>
          <code className="doc-path">{s.path}</code> <span className="doc-muted">{s.replaces ? '(replaces the file)' : '(new file)'}</span>
          <pre className="doc-pre">{s.content.length > 1500 ? `${s.content.slice(0, 1500)}\n…` : s.content}</pre>
        </>
      );
      break;
    case 'recycle':
      detail = <><code className="doc-path">{s.path}</code> <span className="doc-muted">goes to the Recycle Bin</span></>;
      break;
    case 'set_env':
      detail = <><code>{s.name}</code> {s.value === null ? <span className="doc-muted">removed</span> : <>= <code>{s.value}</code></>}</>;
      break;
    case 'path_add':
    case 'path_remove':
      detail = <code className="doc-path">{s.entry}</code>;
      break;
    case 'run_command':
      detail = (
        <>
          <pre className="doc-pre doc-pre--cmd">{s.command}</pre>
          <span className="doc-muted">in <code>{s.cwd}</code></span>
        </>
      );
      break;
    default:
  }
  const KIND = { edit_file: 'Edit a file', write_file: 'Write a file', recycle: 'Recycle', set_env: 'Environment variable', path_add: 'Add to your PATH', path_remove: 'Remove from your PATH', run_command: 'Run a command' };
  return (
    <li className={`doc-step${result ? (result.ok ? ' is-ok' : ' is-bad') : ''}`}>
      <div className="doc-step__head">
        <span className="doc-step__n">{i + 1}</span>
        <b>{KIND[s.kind] || s.kind}</b>
        {s.note && <span className="doc-muted">: {s.note}</span>}
        {result && <span className="doc-step__res">{result.ok ? '✓ done' : '✕ failed'}</span>}
      </div>
      <div className="doc-step__body">{detail}</div>
      {result?.output && <pre className="doc-pre doc-pre--out">{result.output}</pre>}
    </li>
  );
}

function FixCard({ fix, onAct, busy }) {
  const st = STATUS[fix.status] || { label: fix.status, tone: 'muted' };
  const [open, setOpen] = useState(fix.status === 'pending');
  const results = Object.fromEntries((fix.results || []).map((r) => [r.step, r]));
  const hasCommand = fix.steps.some((s) => s.kind === 'run_command');
  return (
    <article className={`doc-fix doc-fix--${st.tone}`}>
      <header className="doc-fix__head">
        <button type="button" className="doc-fix__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {fix.title}
        </button>
        <span className={`doc-badge doc-badge--${st.tone}`}>{st.label}</span>
      </header>
      {open && (
        <>
          {fix.why && <p className="doc-fix__why">{fix.why}</p>}
          <ol className="doc-steps">
            {fix.steps.map((s, i) => <Step key={i} s={s} i={i} result={results[i]} />)}
          </ol>
          {fix.undoNotes?.length > 0 && <ul className="doc-notes">{fix.undoNotes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
          <footer className="doc-fix__actions">
            {fix.status === 'pending' && (
              <>
                <button type="button" className="doc-btn doc-btn--go" disabled={busy} onClick={() => onAct(fix.id, 'apply')}>{busy ? 'Applying…' : 'Apply fix'}</button>
                <button type="button" className="doc-btn" disabled={busy} onClick={() => onAct(fix.id, 'reject')}>Reject</button>
                {hasCommand && <span className="doc-muted">Includes a command: read it before applying.</span>}
              </>
            )}
            {['applied', 'failed'].includes(fix.status) && (
              <button type="button" className="doc-btn" disabled={busy} onClick={() => onAct(fix.id, 'undo')}>Undo</button>
            )}
            <span className="doc-when">{new Date(fix.finishedAt || fix.createdAt).toLocaleString()}</span>
          </footer>
        </>
      )}
    </article>
  );
}

export default function DoctorView({ onClose }) {
  const [fixes, setFixes] = useState(null);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/fixes');
      const j = await r.json();
      setFixes(j.fixes || []);
    } catch {
      setError('Could not load fixes.');
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(t); window.removeEventListener('keydown', onKey); };
  }, [load, onClose]);

  const act = async (id, action) => {
    setBusyId(id);
    setError('');
    try {
      const r = await fetch(`/api/fixes/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `status ${r.status}`);
      window.dispatchEvent(new CustomEvent('gwn:fixes-changed'));
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusyId('');
    }
  };

  const scan = () => {
    window.dispatchEvent(new CustomEvent('gwn:submit-prompt', { detail: { text: SCAN_PROMPT } }));
    onClose?.();
  };

  const pending = (fixes || []).filter((f) => f.status === 'pending' || f.status === 'applying');
  const history = (fixes || []).filter((f) => f.status !== 'pending' && f.status !== 'applying');

  return (
    <div className="doc" role="dialog" aria-modal="true" aria-label="Doctor and fixes">
      <div className="doc__bar">
        <span className="doc__title">DOCTOR &amp; FIXES</span>
        <button type="button" className="doc-btn doc-btn--go" onClick={scan}>Run a doctor scan</button>
        <span className="doc__hint">Omi-One scans and prepares fixes. Nothing changes until you press Apply.</span>
        <button type="button" className="doc__close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="doc__body">
        {error && <p className="doc__err">{error}</p>}
        {fixes === null ? <p className="doc-muted">Loading…</p> : (
          <>
            <section>
              <h2 className="doc__h">Waiting for you {pending.length > 0 && <span className="doc-count">{pending.length}</span>}</h2>
              {pending.length === 0
                ? <p className="doc__empty">No fixes waiting. Run a doctor scan, or ask Omi-One to look into a problem; the fixes it prepares appear here.</p>
                : pending.map((f) => <FixCard key={f.id} fix={f} onAct={act} busy={busyId === f.id} />)}
            </section>
            {history.length > 0 && (
              <section>
                <h2 className="doc__h">History</h2>
                {history.map((f) => <FixCard key={f.id} fix={f} onAct={act} busy={busyId === f.id} />)}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
