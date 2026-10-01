import { useEffect, useState, useCallback } from 'react';
import './DraftsModal.css';

/* Skill drafts — the human gate on self-evolution.
 *
 * The agent proposes skills from its own transcripts; nothing it proposes is
 * loadable until someone approves it here. That is the whole safety property,
 * so this screen has to show enough to judge by: the instructions themselves,
 * and the evidence from the session that produced them.
 *
 * Rejecting asks for a reason, which is logged and fed back into the next
 * reflection pass — otherwise the same draft comes back after every session.
 */
export default function DraftsModal({ onClose, onApproved, toast }) {
  const [drafts, setDrafts] = useState([]);
  const [rejected, setRejected] = useState([]);
  const [selected, setSelected] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(null); // draft name awaiting a reason
  const [reason, setReason] = useState('');

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/skills/drafts');
      if (!r.ok) return;
      const j = await r.json();
      setDrafts(j.drafts || []);
      setRejected(j.rejected || []);
      setSelected((cur) => {
        if (cur && (j.drafts || []).some((d) => d.name === cur.name)) return cur;
        return (j.drafts || [])[0] || null;
      });
    } catch { /* server down; the empty state covers it */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (rejecting) { setRejecting(null); setReason(''); }
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, rejecting]);

  const approve = async (name) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/skills/drafts/${encodeURIComponent(name)}/approve`, { method: 'POST' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { toast?.(j.error || `Approve failed (${r.status})`, 'error'); return; }
      toast?.(`Approved "${name}" — the agent can load it now`, 'info');
      onApproved?.(name);
      await refresh();
    } finally { setBusy(false); }
  };

  const reject = async (name) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/skills/drafts/${encodeURIComponent(name)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast?.(j.error || `Reject failed (${r.status})`, 'error');
        return;
      }
      toast?.(`Rejected "${name}"`, 'info');
      setRejecting(null);
      setReason('');
      await refresh();
    } finally { setBusy(false); }
  };

  return (
    <div className="drafts" role="dialog" aria-modal="true" aria-labelledby="drafts-title">
      <div className="drafts__backdrop" onClick={onClose} />
      <div className="drafts__panel">
        <header className="drafts__head">
          <h3 id="drafts-title">PROPOSED SKILLS</h3>
          <span className="drafts__count">{drafts.length} awaiting review</span>
          <button type="button" className="drafts__close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {drafts.length === 0 ? (
          <div className="drafts__empty">
            <p>Nothing proposed yet.</p>
            <p className="drafts__empty-sub">
              After a session that takes real work — several tool calls, or a wrong turn
              it had to correct — the agent reviews what it did and may propose a reusable
              skill. Proposals land here. Nothing it writes is loadable until you approve it.
            </p>
            {rejected.length > 0 && (
              <p className="drafts__empty-sub">
                {rejected.length} previously rejected, and it will not propose those again.
              </p>
            )}
          </div>
        ) : (
          <div className="drafts__body">
            <ul className="drafts__list">
              {drafts.map((d) => (
                <li key={d.name}>
                  <button
                    type="button"
                    className={`drafts__item ${selected?.name === d.name ? 'is-selected' : ''}`}
                    onClick={() => setSelected(d)}
                  >
                    <span className="drafts__item-name">{d.name}</span>
                    <span className="drafts__item-desc">{d.description || 'no description'}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="drafts__detail">
              {selected && (
                <>
                  <h4>{selected.name}</h4>
                  <p className="drafts__desc">{selected.description}</p>

                  {selected.provenance?.evidence && (
                    <div className="drafts__evidence">
                      <div className="drafts__label">Why the agent proposed this</div>
                      <p>{selected.provenance.evidence}</p>
                    </div>
                  )}

                  <div className="drafts__label">Instructions it would follow</div>
                  <pre className="drafts__code">{selected.body}</pre>

                  <div className="drafts__meta">
                    {selected.provenance?.sessionTitle && <span>from: {selected.provenance.sessionTitle}</span>}
                    {selected.provenance?.model && <span>model: {selected.provenance.model}</span>}
                    {selected.provenance?.proposedAt && (
                      <span>{new Date(selected.provenance.proposedAt).toLocaleString()}</span>
                    )}
                  </div>

                  {rejecting === selected.name ? (
                    <div className="drafts__reject-form">
                      <label htmlFor="reject-reason">
                        Why? This is fed back so it stops proposing the same thing.
                      </label>
                      <input
                        id="reject-reason"
                        className="drafts__reason"
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="too generic / already covered / just wrong"
                        autoFocus
                      />
                      <div className="drafts__actions">
                        <button type="button" className="drafts__btn" onClick={() => { setRejecting(null); setReason(''); }}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="drafts__btn drafts__btn--danger"
                          disabled={busy}
                          onClick={() => reject(selected.name)}
                        >
                          Reject it
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="drafts__actions">
                      <button
                        type="button"
                        className="drafts__btn drafts__btn--danger"
                        disabled={busy}
                        onClick={() => setRejecting(selected.name)}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        className="drafts__btn drafts__btn--primary"
                        disabled={busy}
                        onClick={() => approve(selected.name)}
                      >
                        Approve — add to skills
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
