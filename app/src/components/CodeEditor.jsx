import { useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { languageFor } from '../utils/gameFiles.js';
import './CodeEditor.css';

const SUGGESTED_FILES = [
  'index.html',
  'style.css',
  'main.js',
  'app.js',
  'scene.js',
  'utils.js',
];

/* Code editor with file tabs. Each file in the project gets a tab; click to
 * switch. The active file is edited in Monaco. "+" creates a new file
 * (prompts for a name); the trash button on a tab deletes that file.
 */
export default function CodeEditor({
  files,
  activeFile,
  onActiveChange,
  onFileChange,
  onAddFile,
  onDeleteFile,
}) {
  const [themeReady, setThemeReady] = useState(false);
  const names = Object.keys(files);
  const active = activeFile in files ? activeFile : names[0];

  useEffect(() => {
    if (active !== activeFile) onActiveChange(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Define a dark cyber-grunge theme once Monaco is mounted
  const handleBeforeMount = (monaco) => {
    monaco.editor.defineTheme('gwn-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '5a6478', fontStyle: 'italic' },
        { token: 'keyword', foreground: '5fa8ff' },
        { token: 'string', foreground: 'ff7a7a' },
        { token: 'number', foreground: 'ffb454' },
        { token: 'type', foreground: '5fa8ff' },
        { token: 'function', foreground: 'a8c8ff' },
      ],
      colors: {
        'editor.background': '#050810',
        'editor.foreground': '#e6edf3',
        'editorLineNumber.foreground': '#2a3a55',
        'editorLineNumber.activeForeground': '#5fa8ff',
        'editor.selectionBackground': '#1a3a7a',
        'editor.lineHighlightBackground': '#0a1226',
        'editorIndentGuide.background': '#0a1226',
        'editorCursor.foreground': '#5fa8ff',
        'editor.findMatchBackground': '#ff2d2d55',
        'editorWidget.background': '#050810',
        'editorWidget.border': '#2f7bff44',
      },
    });
  };

  const handleMount = (_, monaco) => {
    setThemeReady(true);
    monaco.editor.setTheme('gwn-dark');
  };

  return (
    <div className="code-editor">
      <div className="code-editor__tabs" role="tablist">
        {names.map((n) => (
          <button
            key={n}
            type="button"
            role="tab"
            aria-selected={n === active}
            className={`code-editor__tab ${n === active ? 'is-active' : ''}`}
            onClick={() => onActiveChange(n)}
            title={n}
          >
            <span className="code-editor__tab-dot" data-lang={languageFor(n)} />
            <span className="code-editor__tab-name">{n}</span>
            {names.length > 1 && (
              <span
                className="code-editor__tab-x"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`Delete ${n}?`)) onDeleteFile(n);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (window.confirm(`Delete ${n}?`)) onDeleteFile(n);
                  }
                }}
                aria-label={`Delete ${n}`}
              >×</span>
            )}
          </button>
        ))}
        <AddFileButton onAdd={onAddFile} existing={names} />
      </div>
      <div className="code-editor__body">
        {active && names.length > 0 ? (
          <Editor
            key={active}
            height="100%"
            path={active}
            language={languageFor(active)}
            value={files[active] || ''}
            theme="gwn-dark"
            beforeMount={handleBeforeMount}
            onMount={handleMount}
            onChange={(v) => onFileChange(active, v ?? '')}
            options={{
              fontFamily: "'JetBrains Mono', 'Cascadia Mono', 'Consolas', monospace",
              fontSize: 13,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderLineHighlight: 'all',
              padding: { top: 10, bottom: 10 },
              wordWrap: 'on',
              tabSize: 2,
              automaticLayout: true,
            }}
          />
        ) : (
          <div className="code-editor__empty">No file open</div>
        )}
      </div>
    </div>
  );
}

function AddFileButton({ onAdd, existing }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [open]);

  const submit = (e) => {
    e?.preventDefault?.();
    const cleaned = String(name || '').trim().replace(/^\.?\/+/, '').replace(/\.\.[\/\\]/g, '');
    if (!cleaned) return;
    if (existing.includes(cleaned)) {
      window.alert(`"${cleaned}" already exists.`);
      return;
    }
    onAdd(cleaned);
    setName('');
    setOpen(false);
  };

  return (
    <div className="code-editor__add-wrap">
      {open ? (
        <form onSubmit={submit} className="code-editor__add-form">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => !name && setOpen(false)}
            placeholder="filename.ext"
            className="code-editor__add-input"
            list="gwn-file-suggestions"
          />
          <datalist id="gwn-file-suggestions">
            {SUGGESTED_FILES.map((s) => <option key={s} value={s} />)}
          </datalist>
          <button type="submit" className="code-editor__add-go">+</button>
        </form>
      ) : (
        <button type="button" className="code-editor__add" onClick={() => setOpen(true)} title="Add file">
          +
        </button>
      )}
    </div>
  );
}
