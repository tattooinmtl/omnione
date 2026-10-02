import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { languageFor } from '../utils/gameFiles.js';
import {
  baseName, dirName, joinPath, cleanPath, isPlanFile,
} from '../utils/workspaceApi.js';
import { isDirty } from '../hooks/useWorkspace.js';
import FileExplorer from './FileExplorer.jsx';
import ContextMenu, { Dialog } from './ContextMenu.jsx';
import './CodeEditor.css';

/* The code pane: the real files of the project folder.
 *
 *   [ ▤ FILES ]  plan.md | index.html ● | main.js |  +        ← code view
 *   [ ‹› CODE ]  PROJECT FILES                    + ▣ ↻        ← files view
 *
 * One button switches the pane between the open files (tabs + editor) and the
 * file explorer, so both fit in the same space. plan.md, when Omi-One has
 * written one, is always the first tab. Right-click a tab or a file for Save,
 * Save as, Rename, Move, Duplicate, Delete and the rest. Ctrl+S saves.
 *
 * `wsp` is the useWorkspace() object (src/hooks/useWorkspace.js).
 */

const VIEW_KEY = 'gwn:code-pane-view';

export default function CodeEditor({ wsp, toast }) {
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'files' ? 'files' : 'code'; } catch { return 'code'; }
  });
  const [menu, setMenu] = useState(null); // { x, y, items }
  const [dialog, setDialog] = useState(null); // Dialog props + resolve
  const activeRef = useRef(wsp.active);
  activeRef.current = wsp.active;
  const saveRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ }
  }, [view]);

  const tabs = wsp.tabs;
  const activeTab = tabs.find((t) => t.path === wsp.active) || null;
  const openPaths = useMemo(() => new Set(tabs.map((t) => t.path)), [tabs]);
  const dirtyPaths = useMemo(() => new Set(tabs.filter(isDirty).map((t) => t.path)), [tabs]);

  // Keep a tab in front whenever there are tabs.
  useEffect(() => {
    if (!activeTab && tabs.length) wsp.setActive(tabs[0].path);
  }, [activeTab, tabs, wsp]);

  // --- dialogs (promise style) -------------------------------------------------
  const ask = useCallback((props) => new Promise((resolve) => {
    setDialog({ ...props, onDone: (v) => { setDialog(null); resolve(v); } });
  }), []);
  const confirm = (props) => ask({ ...props, ask: false });

  const copyText = async (text) => {
    try { await navigator.clipboard.writeText(text); toast?.('Copied', 'info'); } catch { toast?.("Couldn't copy", 'error'); }
  };
  const fullPath = (p) => `${wsp.root}${wsp.root.includes('\\') ? '\\' : '/'}${p.replace(/\//g, wsp.root.includes('\\') ? '\\' : '/')}`;

  // --- actions -----------------------------------------------------------------
  const save = useCallback(async (path) => {
    if (await wsp.save(path)) toast?.(`Saved ${baseName(path)}`, 'info');
  }, [wsp, toast]);
  saveRef.current = save;

  const saveAs = async (path) => {
    const to = await ask({ title: 'Save as', message: 'New file path, inside the project folder.', initial: path, confirmLabel: 'Save' });
    if (to && cleanPath(to) && cleanPath(to) !== path) {
      if (await wsp.saveAs(path, cleanPath(to))) toast?.(`Saved as ${cleanPath(to)}`, 'info');
    }
  };

  const rename = async (path, isDir = false) => {
    const name = await ask({ title: `Rename ${isDir ? 'folder' : 'file'}`, initial: baseName(path), confirmLabel: 'Rename', selectBase: !isDir });
    const clean = name && cleanPath(name);
    if (!clean || clean.includes('/')) {
      if (name && clean?.includes('/')) toast?.('A name, not a path: use Move to put it in another folder.', 'error');
      return;
    }
    if (clean !== baseName(path)) await wsp.move(path, joinPath(dirName(path), clean));
  };

  const moveTo = async (path) => {
    const dest = await ask({
      title: `Move ${baseName(path)}`,
      message: 'Folder to move it to, inside the project (type / for the top folder). Missing folders are created.',
      initial: dirName(path) || '/',
      confirmLabel: 'Move',
      selectBase: false,
    });
    if (dest == null) return;
    const target = joinPath(cleanPath(dest), baseName(path));
    if (target !== path) {
      const r = await wsp.move(path, target);
      if (r) toast?.(`Moved to ${r}`, 'info');
    }
  };

  const duplicate = async (path) => {
    const r = await wsp.duplicate(path);
    if (r) toast?.(`Created ${r}`, 'info');
  };

  const newFile = async (folder = '') => {
    const name = await ask({ title: 'New file', message: folder ? `In ${folder}/` : 'In the project folder. Use a/b.js to put it in a folder.', initial: '', confirmLabel: 'Create' });
    const clean = name && cleanPath(name);
    if (!clean) return;
    if (await wsp.newFile(joinPath(folder, clean))) setView('code');
  };

  const newFolder = async (folder = '') => {
    const name = await ask({ title: 'New folder', message: folder ? `In ${folder}/` : 'In the project folder.', initial: '', confirmLabel: 'Create', selectBase: false });
    const clean = name && cleanPath(name);
    if (clean) await wsp.newFolder(joinPath(folder, clean));
  };

  const remove = async (path, isDir = false) => {
    const unsaved = [...dirtyPaths].some((p) => p === path || p.startsWith(`${path}/`));
    const ok = await confirm({
      title: `Delete ${baseName(path)}?`,
      message: `${isDir ? 'The folder and everything in it go' : 'It goes'} to the Recycle Bin, so you can restore it from there.${unsaved ? ' Unsaved changes in open tabs are lost.' : ''}`,
      confirmLabel: 'Move to Recycle Bin',
      danger: true,
    });
    if (ok && await wsp.remove(path)) toast?.(`${baseName(path)} is in the Recycle Bin`, 'info');
  };

  const closeTab = async (path) => {
    const t = tabs.find((x) => x.path === path);
    if (t && isDirty(t)) {
      const ok = await confirm({ title: `Close ${baseName(path)}?`, message: 'It has unsaved changes, which will be lost.', confirmLabel: 'Close without saving', danger: true });
      if (!ok) return;
    }
    wsp.closeTab(path);
  };

  const openFromList = (path) => {
    wsp.openFile(path);
    setView('code');
  };

  // --- menus -------------------------------------------------------------------
  const fileItems = (path) => {
    const t = tabs.find((x) => x.path === path);
    return [
      { label: 'Open', onClick: () => openFromList(path) },
      { label: 'Save', hint: 'Ctrl+S', disabled: !t || !isDirty(t), onClick: () => save(path) },
      { label: 'Save as…', disabled: !t || t.binary || t.tooLarge, onClick: () => saveAs(path) },
      'sep',
      { label: 'Rename…', hint: 'F2', onClick: () => rename(path) },
      { label: 'Move to…', onClick: () => moveTo(path) },
      { label: 'Duplicate', onClick: () => duplicate(path) },
      'sep',
      { label: 'New file here…', onClick: () => newFile(dirName(path)) },
      { label: 'New folder here…', onClick: () => newFolder(dirName(path)) },
      'sep',
      { label: 'Copy path', onClick: () => copyText(path) },
      { label: 'Copy full path', onClick: () => copyText(fullPath(path)) },
      { label: 'Show in Explorer', onClick: () => wsp.reveal(path) },
      'sep',
      { label: 'Delete', hint: 'Del', danger: true, onClick: () => remove(path) },
    ];
  };

  const folderItems = (path, expand) => [
    { label: 'New file…', onClick: () => { expand?.(path); newFile(path); } },
    { label: 'New folder…', onClick: () => { expand?.(path); newFolder(path); } },
    'sep',
    { label: 'Rename…', hint: 'F2', onClick: () => rename(path, true) },
    { label: 'Move to…', onClick: () => moveTo(path) },
    { label: 'Duplicate', onClick: () => duplicate(path) },
    'sep',
    { label: 'Copy path', onClick: () => copyText(path) },
    { label: 'Copy full path', onClick: () => copyText(fullPath(path)) },
    { label: 'Show in Explorer', onClick: () => wsp.reveal(path) },
    'sep',
    { label: 'Delete', hint: 'Del', danger: true, onClick: () => remove(path, true) },
  ];

  const rootItems = () => [
    { label: 'New file…', onClick: () => newFile('') },
    { label: 'New folder…', onClick: () => newFolder('') },
    'sep',
    { label: 'Save all', disabled: dirtyPaths.size === 0, onClick: async () => { const r = await wsp.saveAll(); toast?.(`Saved ${r.saved} file(s)`, 'info'); } },
    { label: 'Refresh', onClick: () => wsp.refreshTree() },
    { label: 'Copy full path', onClick: () => copyText(wsp.root) },
    { label: 'Show in Explorer', onClick: () => wsp.reveal('.') },
  ];

  const tabItems = (path) => {
    const t = tabs.find((x) => x.path === path);
    return [
      { label: 'Save', hint: 'Ctrl+S', disabled: !t || !isDirty(t), onClick: () => save(path) },
      { label: 'Save as…', disabled: !t || t.binary || t.tooLarge, onClick: () => saveAs(path) },
      { label: 'Rename…', onClick: () => rename(path) },
      'sep',
      { label: 'Close', onClick: () => closeTab(path) },
      { label: 'Close others', disabled: tabs.length < 2, onClick: () => wsp.closeOthers(path) },
      'sep',
      { label: 'Show in file list', onClick: () => setView('files') },
      { label: 'Copy path', onClick: () => copyText(path) },
      { label: 'Show in Explorer', onClick: () => wsp.reveal(path) },
      'sep',
      { label: 'Delete', danger: true, onClick: () => remove(path) },
    ];
  };

  const onExplorerMenu = ({ x, y, node, expand }) => {
    const items = !node ? rootItems() : node.type === 'dir' ? folderItems(node.path, expand) : fileItems(node.path);
    setMenu({ x, y, items });
  };

  // F2 / Delete on the selected row in the file list.
  const onExplorerKey = (e) => {
    const row = e.target.closest?.('[role="treeitem"] > .fx__row');
    const path = row?.getAttribute('title');
    if (!path) return;
    const isDir = row.classList.contains('is-dir');
    if (e.key === 'F2') { e.preventDefault(); rename(path, isDir); }
    else if (e.key === 'Delete') { e.preventDefault(); remove(path, isDir); }
  };

  // Ctrl+S anywhere in the pane (Monaco handles it inside the editor too).
  const onPaneKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (e.shiftKey && activeRef.current) saveAs(activeRef.current);
      else if (activeRef.current) save(activeRef.current);
    }
  };

  // --- Monaco ------------------------------------------------------------------
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

  const handleMount = (editor, monaco) => {
    monaco.editor.setTheme('gwn-dark');
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeRef.current) saveRef.current?.(activeRef.current);
    });
  };

  // --- render ------------------------------------------------------------------
  const toggle = (
    <button
      type="button"
      className={`code-editor__toggle${view === 'files' ? ' is-files' : ''}`}
      onClick={() => setView((v) => (v === 'files' ? 'code' : 'files'))}
      title={view === 'files' ? 'Back to the code editor' : 'Show the project files'}
      aria-pressed={view === 'files'}
    >
      {view === 'files' ? <><span aria-hidden="true">‹›</span> CODE</> : <><span aria-hidden="true">▤</span> FILES</>}
    </button>
  );

  return (
    <div className="code-editor" onKeyDown={onPaneKey}>
      <div className="code-editor__bar">
        {toggle}
        {view === 'files' ? (
          <div className="code-editor__bar-files">
            <span className="code-editor__bar-title">PROJECT FILES</span>
            <button type="button" className="code-editor__icon-btn" onClick={() => newFile('')} title="New file">+</button>
            <button type="button" className="code-editor__icon-btn" onClick={() => newFolder('')} title="New folder">▣</button>
            <button type="button" className="code-editor__icon-btn" onClick={() => wsp.refreshTree()} title="Refresh">↻</button>
          </div>
        ) : (
          <div className="code-editor__tabs" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.path}
                type="button"
                role="tab"
                aria-selected={t.path === wsp.active}
                className={`code-editor__tab${t.path === wsp.active ? ' is-active' : ''}${isPlanFile(t.path) ? ' is-plan' : ''}`}
                onClick={() => wsp.setActive(t.path)}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.path); } }}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: tabItems(t.path) }); }}
                title={t.path}
              >
                {isPlanFile(t.path)
                  ? <span className="code-editor__tab-plan" aria-hidden="true">PLAN</span>
                  : <span className="code-editor__tab-dot" data-lang={languageFor(t.path)} />}
                <span className="code-editor__tab-name">{baseName(t.path)}</span>
                {isDirty(t) && <span className="code-editor__tab-dirty" title="Unsaved changes">●</span>}
                <span
                  className="code-editor__tab-x"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); closeTab(t.path); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); closeTab(t.path); }
                  }}
                  aria-label={`Close ${baseName(t.path)}`}
                  title="Close"
                >×</span>
              </button>
            ))}
            <button type="button" className="code-editor__add" onClick={() => newFile('')} title="New file">+</button>
          </div>
        )}
      </div>

      <div className="code-editor__body">
        {view === 'files' ? (
          <div className="code-editor__files" onKeyDown={onExplorerKey}>
            <FileExplorer
              root={wsp.root}
              entries={wsp.entries}
              openPaths={openPaths}
              dirtyPaths={dirtyPaths}
              activePath={wsp.active}
              onOpen={openFromList}
              onMenu={onExplorerMenu}
            />
          </div>
        ) : activeTab ? (
          <>
            {activeTab.changedOnDisk && (
              <div className="code-editor__notice">
                <span>{baseName(activeTab.path)} changed on disk while you were editing it.</span>
                <button type="button" onClick={() => wsp.reloadTab(activeTab.path)}>Load the disk version</button>
                <button type="button" onClick={() => save(activeTab.path)}>Keep mine (save)</button>
              </div>
            )}
            {activeTab.binary || activeTab.tooLarge ? (
              <div className="code-editor__empty">
                {activeTab.binary
                  ? `${baseName(activeTab.path)} isn't a text file, so it can't be edited here.`
                  : `${baseName(activeTab.path)} is too large to edit here (${Math.round((activeTab.size || 0) / 1024)} KB).`}
                <button type="button" className="code-editor__link" onClick={() => wsp.reveal(activeTab.path)}>Show in Explorer</button>
              </div>
            ) : (
              <div className="code-editor__monaco">
              <Editor
                height="100%"
                path={activeTab.path}
                language={languageFor(activeTab.path)}
                value={activeTab.content}
                theme="gwn-dark"
                beforeMount={handleBeforeMount}
                onMount={handleMount}
                onChange={(v) => wsp.setContent(activeTab.path, v ?? '')}
                options={{
                  fontFamily: "'JetBrains Mono', 'Cascadia Mono', 'Consolas', monospace",
                  fontSize: 13,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  renderLineHighlight: 'all',
                  padding: { top: 10, bottom: 10 },
                  wordWrap: isPlanFile(activeTab.path) || /\.md$/i.test(activeTab.path) ? 'on' : 'off',
                  tabSize: 2,
                  automaticLayout: true,
                }}
              />
              </div>
            )}
          </>
        ) : (
          <div className="code-editor__empty">
            No file open.
            <button type="button" className="code-editor__link" onClick={() => setView('files')}>Open one from the project files</button>
          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
      {dialog && <Dialog {...dialog} />}
    </div>
  );
}
