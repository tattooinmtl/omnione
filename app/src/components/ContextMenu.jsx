import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ContextMenu.css';

/* A right-click menu at (x, y). items: { label, onClick, hint?, danger?,
 * disabled? } or 'sep'. Closes on a click outside, Escape, scroll or resize.
 * Arrow keys move, Enter picks. */
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const usable = items.map((it, i) => (it !== 'sep' && !it.disabled ? i : -1)).filter((i) => i >= 0);
  const [focus, setFocus] = useState(usable[0] ?? -1);

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    const onAway = (e) => { if (!ref.current?.contains(e?.target)) onClose(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('blur', onAway);
    window.addEventListener('resize', onAway);
    document.addEventListener('scroll', onAway, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('blur', onAway);
      window.removeEventListener('resize', onAway);
      document.removeEventListener('scroll', onAway, true);
    };
  }, [onClose]);

  const pick = (it) => {
    if (!it || it === 'sep' || it.disabled) return;
    onClose();
    it.onClick?.();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (!usable.length) return;
    const at = usable.indexOf(focus);
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(usable[(at + 1) % usable.length]); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(usable[(at - 1 + usable.length) % usable.length]); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[focus]); }
  };

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, i) => (it === 'sep'
        ? <div key={`s${i}`} className="ctx-menu__sep" role="separator" />
        : (
          <button
            key={it.label}
            type="button"
            role="menuitem"
            className={`ctx-menu__item${it.danger ? ' is-danger' : ''}${i === focus ? ' is-focus' : ''}`}
            disabled={it.disabled}
            onMouseEnter={() => setFocus(i)}
            onClick={() => pick(it)}
          >
            <span>{it.label}</span>
            {it.hint && <span className="ctx-menu__hint">{it.hint}</span>}
          </button>
        )))}
    </div>,
    document.body,
  );
}

/* Ask for a name or path, or confirm something. Resolves through onDone:
 * the text (ask) / true (confirm), or null when cancelled. */
export function Dialog({ title, message, initial = '', confirmLabel = 'OK', danger = false, ask = true, selectBase = true, onDone }) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef(null);
  const okRef = useRef(null);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus({ preventScroll: true });
      // Select the name without its extension, like Explorer does.
      const dot = initial.lastIndexOf('.');
      const slash = initial.lastIndexOf('/');
      const end = selectBase && dot > slash + 1 ? dot : initial.length;
      el.setSelectionRange(slash + 1, end);
    } else okRef.current?.focus({ preventScroll: true });
  }, [initial, selectBase]);

  const submit = (e) => {
    e.preventDefault();
    if (ask) {
      const v = value.trim();
      if (!v) return;
      onDone(v);
    } else onDone(true);
  };

  return createPortal(
    <div className="ctx-dialog" role="dialog" aria-modal="true" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onDone(null); } }}>
      <div className="ctx-dialog__backdrop" onMouseDown={() => onDone(null)} />
      <form className="ctx-dialog__panel" onSubmit={submit}>
        <h3>{title}</h3>
        {message && <p>{message}</p>}
        {ask && (
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        )}
        <div className="ctx-dialog__actions">
          <button type="button" onClick={() => onDone(null)}>Cancel</button>
          <button ref={okRef} type="submit" className={danger ? 'is-danger' : 'is-primary'} disabled={ask && !value.trim()}>{confirmLabel}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
