import { useMemo, useState } from 'react';
import { languageFor } from '../utils/gameFiles.js';
import { baseName, dirName, isPlanFile } from '../utils/workspaceApi.js';
import './FileExplorer.css';

/* The project folder as a tree. Folders open and close; a click on a file opens
 * it in the editor. Right-click (or the ⋯ button, or Shift+F10) opens the
 * context menu, which the parent builds (onMenu). */

function buildTree(entries) {
  const root = { path: '', name: '', type: 'dir', children: [] };
  const dirs = new Map([['', root]]);
  const ensureDir = (p) => {
    if (dirs.has(p)) return dirs.get(p);
    const parent = ensureDir(dirName(p));
    const node = { path: p, name: baseName(p), type: 'dir', children: [] };
    parent.children.push(node);
    dirs.set(p, node);
    return node;
  };
  for (const e of entries) {
    if (e.type === 'dir') ensureDir(e.path);
    else ensureDir(dirName(e.path)).children.push({ path: e.path, name: baseName(e.path), type: 'file' });
  }
  const sort = (node) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      if (isPlanFile(a.path) !== isPlanFile(b.path)) return isPlanFile(a.path) ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    });
    node.children.forEach((c) => c.type === 'dir' && sort(c));
  };
  sort(root);
  return root;
}

export default function FileExplorer({ root, entries, openPaths, dirtyPaths, activePath, onOpen, onMenu }) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [open, setOpen] = useState(() => new Set());
  const [selected, setSelected] = useState(null);

  const toggle = (p) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p); else n.add(p);
    return n;
  });

  const menuAt = (e, node) => {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX || r.left + 24;
    const y = e.clientY || r.bottom;
    if (node) setSelected(node.path);
    onMenu({ x, y, node: node || null, expand: (p) => setOpen((s) => new Set(s).add(p)) });
  };

  const row = (node, depth) => {
    const isDir = node.type === 'dir';
    const isOpen = open.has(node.path);
    const cls = [
      'fx__row',
      isDir ? 'is-dir' : 'is-file',
      node.path === selected ? 'is-selected' : '',
      node.path === activePath ? 'is-active' : '',
      openPaths.has(node.path) ? 'is-open' : '',
    ].join(' ');
    return (
      <li key={node.path} role="treeitem" aria-expanded={isDir ? isOpen : undefined} aria-selected={node.path === selected}>
        <div
          className={cls}
          style={{ paddingLeft: 8 + depth * 14 }}
          tabIndex={0}
          title={node.path}
          onClick={() => { setSelected(node.path); if (isDir) toggle(node.path); else onOpen(node.path); }}
          onContextMenu={(e) => menuAt(e, node)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (isDir) toggle(node.path); else onOpen(node.path); }
            else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) menuAt(e, node);
            else if (isDir && e.key === 'ArrowRight' && !isOpen) toggle(node.path);
            else if (isDir && e.key === 'ArrowLeft' && isOpen) toggle(node.path);
          }}
        >
          <span className="fx__twisty" aria-hidden="true">{isDir ? (isOpen ? '▾' : '▸') : ''}</span>
          {isDir
            ? <span className="fx__icon fx__icon--dir" aria-hidden="true" />
            : <span className="fx__dot" data-lang={languageFor(node.name)} aria-hidden="true" />}
          <span className="fx__name">{node.name}</span>
          {dirtyPaths.has(node.path) && <span className="fx__dirty" title="Unsaved changes">●</span>}
          <button type="button" className="fx__more" tabIndex={-1} aria-label={`Actions for ${node.name}`} onClick={(e) => menuAt(e, node)}>⋯</button>
        </div>
        {isDir && isOpen && node.children.length > 0 && (
          <ul role="group">{node.children.map((c) => row(c, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <div className="fx" onContextMenu={(e) => menuAt(e, null)}>
      <div className="fx__root" title={root}>
        <span className="fx__icon fx__icon--dir" aria-hidden="true" />
        <span className="fx__root-name">{baseName(root.replace(/\\/g, '/')) || root || 'Project'}</span>
        <button type="button" className="fx__more fx__more--root" aria-label="Project folder actions" onClick={(e) => menuAt(e, null)}>⋯</button>
      </div>
      {tree.children.length === 0 ? (
        <div className="fx__empty">
          This project folder is empty.
          <br />
          Right-click to add a file, or ask Omi-One to build something.
        </div>
      ) : (
        <ul className="fx__tree" role="tree">{tree.children.map((c) => row(c, 0))}</ul>
      )}
    </div>
  );
}
