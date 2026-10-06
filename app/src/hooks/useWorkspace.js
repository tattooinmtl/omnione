import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { subscribeStream } from '../utils/stream.js';
import {
  ws, isPlanFile, isUnder, reparent, baseName,
} from '../utils/workspaceApi.js';

/* The coding page's view of the real project folder.
 *
 *   entries   the file list (what the explorer shows), from the server
 *   tabs      open files, in tab order, plan.md always first:
 *             { path, content, saved, mtimeMs, binary, tooLarge, changedOnDisk }
 *   active    the path of the tab in front
 *
 * Tabs hold real files: they are read from disk, saved to disk, and refreshed
 * when something else changes them (Omi-One, a build, another editor). A tab
 * with unsaved edits is never overwritten; it is marked changedOnDisk instead.
 */

const MAX_AUTO_OPEN = 12;

export function sortTabs(tabs) {
  const plan = tabs.filter((t) => isPlanFile(t.path));
  return plan.length ? [...plan, ...tabs.filter((t) => !isPlanFile(t.path))] : tabs;
}

export const isDirty = (t) => !t.binary && !t.tooLarge && t.content !== t.saved;

export default function useWorkspace({ toast } = {}) {
  const [root, setRoot] = useState('');
  const [entries, setEntries] = useState([]);
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState(null);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const autoOpenRef = useRef(false); // open files Omi-One writes, while it runs
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const say = (msg, kind = 'info') => toastRef.current?.(msg, kind);

  const refreshTree = useCallback(async () => {
    try {
      const j = await ws.tree();
      setRoot(j.root || '');
      setEntries(j.entries || []);
      return j.entries || [];
    } catch {
      return entriesRef.current;
    }
  }, []);

  const putTab = useCallback((tab, { activate = false } = {}) => {
    setTabs((cur) => {
      const i = cur.findIndex((t) => t.path === tab.path);
      const next = i < 0 ? [...cur, tab] : cur.map((t, k) => (k === i ? { ...t, ...tab } : t));
      return sortTabs(next);
    });
    if (activate) setActive(tab.path);
  }, []);

  const load = async (path) => {
    const f = await ws.read(path);
    return {
      path: f.path,
      content: f.content ?? '',
      saved: f.content ?? '',
      mtimeMs: f.mtimeMs,
      binary: Boolean(f.binary),
      tooLarge: Boolean(f.tooLarge),
      size: f.size,
      changedOnDisk: false,
    };
  };

  /* Open a file in a tab (or bring its tab to the front). */
  const openFile = useCallback(async (path, { activate = true } = {}) => {
    if (tabsRef.current.some((t) => t.path === path)) {
      if (activate) setActive(path);
      return;
    }
    try {
      putTab(await load(path), { activate });
    } catch (e) {
      say(e.message, 'error');
    }
  }, [putTab]);

  const closeTab = useCallback((path) => {
    setTabs((cur) => {
      const i = cur.findIndex((t) => t.path === path);
      if (i < 0) return cur;
      const next = cur.filter((t) => t.path !== path);
      setActive((a) => (a === path ? (next[i] || next[i - 1] || null)?.path ?? null : a));
      return next;
    });
  }, []);

  const closeOthers = useCallback((path) => {
    setTabs((cur) => cur.filter((t) => t.path === path || isDirty(t)));
    setActive(path);
  }, []);

  const setContent = useCallback((path, content) => {
    setTabs((cur) => cur.map((t) => (t.path === path ? { ...t, content } : t)));
  }, []);

  const save = useCallback(async (path) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab || tab.binary || tab.tooLarge) return false;
    try {
      const r = await ws.write(path, tab.content);
      setTabs((cur) => cur.map((t) => (t.path === path ? { ...t, saved: tab.content, mtimeMs: r.mtimeMs, changedOnDisk: false } : t)));
      return true;
    } catch (e) {
      say(`Couldn't save ${baseName(path)}: ${e.message}`, 'error');
      return false;
    }
  }, []);

  const saveAll = useCallback(async () => {
    const dirty = tabsRef.current.filter(isDirty);
    let ok = 0;
    for (const t of dirty) if (await save(t.path)) ok += 1;
    return { dirty: dirty.length, saved: ok };
  }, [save]);

  /* Save as: write the tab's text to a new file and switch the tab to it. The
   * original file stays as it was on disk. */
  const saveAs = useCallback(async (path, to) => {
    const tab = tabsRef.current.find((t) => t.path === path);
    if (!tab) return false;
    try {
      const r = await ws.write(to, tab.content, { overwrite: false });
      setTabs((cur) => sortTabs(cur
        .filter((t) => t.path !== r.path)
        .map((t) => (t.path === path ? { ...t, path: r.path, saved: tab.content, mtimeMs: r.mtimeMs, changedOnDisk: false } : t))));
      setActive(r.path);
      await refreshTree();
      return true;
    } catch (e) {
      say(e.message, 'error');
      return false;
    }
  }, [refreshTree]);

  const newFile = useCallback(async (path) => {
    try {
      const r = await ws.write(path, '', { overwrite: false });
      await refreshTree();
      putTab({ path: r.path, content: '', saved: '', mtimeMs: r.mtimeMs, binary: false, tooLarge: false, changedOnDisk: false }, { activate: true });
      return r.path;
    } catch (e) {
      say(e.message, 'error');
      return null;
    }
  }, [refreshTree, putTab]);

  const newFolder = useCallback(async (path) => {
    try {
      const r = await ws.folder(path);
      await refreshTree();
      return r.path;
    } catch (e) {
      say(e.message, 'error');
      return null;
    }
  }, [refreshTree]);

  /* Rename or move a file or folder; open tabs follow it. */
  const move = useCallback(async (from, to) => {
    try {
      const r = await ws.move(from, to);
      setTabs((cur) => sortTabs(cur.map((t) => (isUnder(t.path, from) ? { ...t, path: reparent(t.path, from, r.path) } : t))));
      setActive((a) => (a && isUnder(a, from) ? reparent(a, from, r.path) : a));
      await refreshTree();
      return r.path;
    } catch (e) {
      say(e.message, 'error');
      return null;
    }
  }, [refreshTree]);

  const duplicate = useCallback(async (path) => {
    try {
      const r = await ws.copy(path);
      await refreshTree();
      return r.path;
    } catch (e) {
      say(e.message, 'error');
      return null;
    }
  }, [refreshTree]);

  /* Delete = Recycle Bin. Tabs of what was deleted close. */
  const remove = useCallback(async (path) => {
    try {
      await ws.remove(path);
      for (const t of tabsRef.current) if (isUnder(t.path, path)) closeTab(t.path);
      await refreshTree();
      return true;
    } catch (e) {
      say(e.message, 'error');
      return false;
    }
  }, [refreshTree, closeTab]);

  const reveal = useCallback(async (path) => {
    try { await ws.reveal(path || '.'); } catch (e) { say(e.message, 'error'); }
  }, []);

  /* Take the disk's version of a tab (after "changed on disk"). */
  const reloadTab = useCallback(async (path) => {
    try { putTab(await load(path)); } catch (e) { say(e.message, 'error'); }
  }, [putTab]);

  /* Write several files at once (a FILE-marked answer) and open them. */
  const writeFiles = useCallback(async (files) => {
    const written = [];
    for (const [name, content] of Object.entries(files)) {
      try {
        const r = await ws.write(name, content);
        written.push(r.path);
        putTab({ path: r.path, content, saved: content, mtimeMs: r.mtimeMs, binary: false, tooLarge: false, changedOnDisk: false });
      } catch (e) {
        say(`Couldn't write ${name}: ${e.message}`, 'error');
      }
    }
    if (written.length) setActive(written[0]);
    await refreshTree();
    return written;
  }, [putTab, refreshTree]);

  /* While Omi-One runs, files it creates or changes open as tabs. */
  const setAutoOpen = useCallback((on) => { autoOpenRef.current = Boolean(on); }, []);

  // Something changed on disk: refresh the list, then each affected tab.
  const onDiskChange = useCallback(async (paths) => {
    const list = await refreshTree();
    const files = new Set(list.filter((e) => e.type === 'file').map((e) => e.path));
    const touched = new Set((paths || []).filter(Boolean));
    const everything = touched.size === 0;

    for (const t of tabsRef.current) {
      if (!everything && !touched.has(t.path)) continue;
      if (!files.has(t.path)) {
        // Gone (deleted or renamed elsewhere): keep unsaved work, drop the rest.
        if (!isDirty(t)) closeTab(t.path);
        continue;
      }
      try {
        const f = await ws.read(t.path);
        if (f.mtimeMs === t.mtimeMs) continue;
        if (isDirty(t)) {
          setTabs((cur) => cur.map((x) => (x.path === t.path ? { ...x, changedOnDisk: true } : x)));
        } else {
          putTab({
            path: t.path, content: f.content ?? '', saved: f.content ?? '', mtimeMs: f.mtimeMs,
            binary: Boolean(f.binary), tooLarge: Boolean(f.tooLarge), changedOnDisk: false,
          });
        }
      } catch { /* vanished between the list and the read */ }
    }

    // plan.md appeared: open it as the first tab and show it.
    const plan = [...files].find((p) => isPlanFile(p));
    if (plan && touched.has(plan) && !tabsRef.current.some((t) => t.path === plan)) {
      await openFile(plan, { activate: true });
    }

    if (autoOpenRef.current) {
      const fresh = [...touched].filter((p) => files.has(p) && !tabsRef.current.some((t) => t.path === p));
      const room = Math.max(0, MAX_AUTO_OPEN - tabsRef.current.length);
      for (const p of fresh.slice(0, room)) await openFile(p, { activate: false });
    }
  }, [refreshTree, closeTab, putTab, openFile]);

  // First load, and the live change feed.
  useEffect(() => {
    let alive = true;
    refreshTree().then((list) => {
      if (!alive) return;
      const plan = list.find((e) => e.type === 'file' && isPlanFile(e.path));
      if (plan) openFile(plan.path, { activate: true });
    });
    const offStream = subscribeStream('workspace', (ev) => {
      if (ev.type === 'changed') onDiskChange(ev.paths);
      else if (ev.type === 'root') {
        // Another project folder: its files, not the old tabs.
        setTabs((cur) => cur.filter(isDirty));
        setActive(null);
        onDiskChange([]);
      }
    });
    const onResult = () => onDiskChange([]);
    window.addEventListener('gwn:generation-result', onResult);
    return () => {
      alive = false;
      offStream();
      window.removeEventListener('gwn:generation-result', onResult);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirtyCount = useMemo(() => tabs.filter(isDirty).length, [tabs]);

  return {
    root, entries, tabs, active, dirtyCount,
    setActive, openFile, closeTab, closeOthers, setContent,
    save, saveAll, saveAs, newFile, newFolder, move, duplicate, remove, reveal,
    reloadTab, writeFiles, refreshTree, setAutoOpen,
  };
}
