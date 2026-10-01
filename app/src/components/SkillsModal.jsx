import { useEffect, useState, useRef, useCallback } from 'react';
import './SkillsModal.css';

const API_BASE = '';

/* Skills modal — the arrow-key navigator for the /skills command and the
 * SKILLS top-bar button. Up/Down cycle through the list, Enter opens the
 * selected skill, U uploads a new skill, R re-scans the folder, Esc closes.
 */
export default function SkillsModal({ onClose, onRunSkill, onChange }) {
  const [skills, setSkills] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [openSkill, setOpenSkill] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const fileInputRef = useRef(null);
  const listRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/api/skills`);
      const j = await r.json();
      setSkills(j.skills || []);
    } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { onChange && onChange(skills); }, [skills, onChange]);

  // Live updates from the server (upload / delete / scan fire SSE)
  useEffect(() => {
    let es;
    try {
      es = new EventSource(`${API_BASE}/api/skills/events`);
      es.onmessage = (e) => {
        try {
          const ev = JSON.parse(e.data);
          if (ev.type === 'changed' || ev.type === 'hello') refresh();
        } catch { /* ignore */ }
      };
      es.onerror = () => { /* let the browser auto-reconnect */ };
    } catch { /* ignore */ }
    return () => { if (es) es.close(); };
  }, [refresh]);

  const filtered = skills.filter((s) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);
  });
  const idx = cursor >= filtered.length ? 0 : cursor;

  // Reset cursor on filter change
  useEffect(() => { setCursor(0); }, [filter]);

  // Keep selection in view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${idx}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [idx, filtered.length]);

  // Open the highlighted skill's full body
  const openAt = useCallback(async (i) => {
    const s = filtered[i];
    if (!s) return;
    try {
      const r = await fetch(`${API_BASE}/api/skills/${encodeURIComponent(s.name)}`);
      if (!r.ok) throw new Error(`status ${r.status}`);
      const j = await r.json();
      setOpenSkill(j);
    } catch (e) { setError(e.message); }
  }, [filtered]);

  // Trigger the OS file picker for folder selection
  const pickFolder = () => {
    if (fileInputRef.current) fileInputRef.current.click();
  };

  // Upload whatever the user picked
  const onFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) {
      setError('No files were selected. Make sure the folder contains a SKILL.md.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // The first file's path is always the folder name from webkitdirectory.
      // In some Chromium builds the input shows a picker but returns empty
      // webkitRelativePath when the input was display:none — fall back to
      // the parent dir of f.name when that's all we have.
      const folder = (files[0].webkitRelativePath || files[0].name || '').split(/[\\/]/)[0] || '';
      const fd = new FormData();
      if (folder) fd.append('name', folder);
      for (const f of files) {
        // Attach the file with the relative path as its filename so multer
        // sees file.originalname = "folder/SKILL.md" and the server can
        // extract the folder segment.
        const rel = f.webkitRelativePath || `${folder}/${f.name}`;
        const renamed = new File([f], rel, { type: f.type });
        fd.append('files', renamed, rel);
      }
      const r = await fetch(`${API_BASE}/api/skills/upload`, { method: 'POST', body: fd });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
      await refresh();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const onRescan = async () => {
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/skills/scan`, { method: 'POST' });
      await refresh();
    } finally { setBusy(false); }
  };

  const onDelete = async (s) => {
    if (!window.confirm(`Delete skill "${s.name}"? This removes it from the skills/ folder.`)) return;
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/skills/${encodeURIComponent(s.name)}`, { method: 'DELETE' });
      await refresh();
    } finally { setBusy(false); }
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => (c + 1) % Math.max(filtered.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => (c - 1 + filtered.length) % Math.max(filtered.length, 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (openSkill) { onRunSkill && onRunSkill(openSkill); onClose(); } else { openAt(idx); } }
    else if (e.key === 'Escape') { e.preventDefault(); if (openSkill) setOpenSkill(null); else onClose(); }
    else if (e.key === 'u' || e.key === 'U') { e.preventDefault(); pickFolder(); }
    else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); onRescan(); }
  };

  return (
    <div className="skills-modal" role="dialog" aria-modal="true" onKeyDown={onKey} tabIndex={-1}>
      <div className="skills-modal__backdrop" onClick={onClose} />
      <div className="skills-modal__panel">
        <header className="skills-modal__head">
          <h3>SKILLS</h3>
          <span className="skills-modal__count">{filtered.length} of {skills.length}</span>
          <button type="button" className="skills-modal__close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="skills-modal__toolbar">
          <input
            className="skills-modal__filter"
            type="text"
            placeholder="filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
          <button type="button" className="skills-modal__btn" onClick={pickFolder} disabled={busy} title="Upload a skill folder (U)">
            📁 UPLOAD
          </button>
          <button type="button" className="skills-modal__btn" onClick={onRescan} disabled={busy} title="Re-scan the skills/ folder (R)">
            ↻ RESCAN
          </button>
          <input
            ref={fileInputRef}
            type="file"
            // Off-screen instead of `hidden` (display:none) so Chromium
            // populates `webkitRelativePath` when the user picks a folder.
            // Many Chromium builds return an empty path for display:none
            // file inputs, which broke folder uploads.
            style={{ position: 'absolute', left: '-9999px', top: '-9999px', width: '1px', height: '1px', opacity: 0 }}
            webkitdirectory=""
            directory=""
            multiple
            onChange={onFiles}
          />
        </div>

        {error && <div className="skills-modal__error">{error}</div>}

        <div className="skills-modal__split">
          <ul className="skills-modal__list" ref={listRef} role="listbox">
            {filtered.length === 0 && (
              <li className="skills-modal__empty">No skills. Click UPLOAD to add one from a folder.</li>
            )}
            {filtered.map((s, i) => (
              <li
                key={s.name}
                data-idx={i}
                role="option"
                aria-selected={i === idx}
                className={`skills-modal__item ${i === idx ? 'is-active' : ''}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => openAt(i)}
              >
                <div className="skills-modal__item-name">/{s.name}</div>
                <div className="skills-modal__item-desc">{s.description || <em>no description</em>}</div>
                <button
                  type="button"
                  className="skills-modal__item-x"
                  onClick={(e) => { e.stopPropagation(); onDelete(s); }}
                  title="Delete this skill"
                >×</button>
              </li>
            ))}
          </ul>

          <div className="skills-modal__detail">
            {openSkill ? (
              <>
                <header className="skills-modal__detail-head">
                  <h4>/{openSkill.name}</h4>
                  <button
                    type="button"
                    className="skills-modal__btn skills-modal__btn--primary"
                    onClick={() => { onRunSkill && onRunSkill(openSkill); onClose(); }}
                  >
                    ▶ RUN
                  </button>
                </header>
                {openSkill.description && <p className="skills-modal__detail-desc">{openSkill.description}</p>}
                <pre className="skills-modal__detail-body">{openSkill.body}</pre>
              </>
            ) : (
              <div className="skills-modal__detail-empty">
                <p>Select a skill with ↑↓ and press Enter to read it.</p>
                <p>Press <kbd>U</kbd> to upload a folder, <kbd>R</kbd> to re-scan.</p>
              </div>
            )}
          </div>
        </div>

        <footer className="skills-modal__foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open / run</span>
          <span><kbd>U</kbd> upload · <kbd>R</kbd> rescan</span>
          <span><kbd>Esc</kbd> close</span>
        </footer>
      </div>
    </div>
  );
}
