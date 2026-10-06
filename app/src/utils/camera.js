// The live camera, for the windows: its state (shared with every window
// through the live channel), switching it on and off, and a preview that
// refreshes while it's on. The pictures themselves are taken by the server.

import { useCallback, useEffect, useRef, useState } from 'react';

export async function cameraApi(method = 'GET', body) {
  const r = await fetch('/api/camera', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `status ${r.status}`);
  return j;
}

/* { state, toggle(), error } — state.on, state.configured, state.label… */
export function useCamera() {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    cameraApi().then((s) => alive && setState(s)).catch(() => {});
    let es;
    try {
      es = new EventSource('/api/live');
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data);
          if (ev.type === 'camera') cameraApi().then((s) => alive && setState(s)).catch(() => {});
        } catch { /* keep-alive */ }
      };
    } catch { /* no live channel: state still loads once */ }
    return () => { alive = false; es?.close(); };
  }, []);

  const toggle = useCallback(async () => {
    setError('');
    try {
      setState(await cameraApi('POST', { on: !state?.on }));
    } catch (e) {
      setError(e.message);
    }
  }, [state]);

  return { state, toggle, error, setError };
}

/* An <img> source that refreshes every `ms` while `active`. Waits for each
 * picture before asking for the next, so a slow camera isn't flooded. */
export function useCameraPreview(active, ms = 1500) {
  const [src, setSrc] = useState(null);
  const [error, setError] = useState('');
  const last = useRef(null);
  useEffect(() => {
    if (!active) { setSrc(null); return undefined; }
    let stop = false;
    let timer = 0;
    const tick = async () => {
      try {
        const r = await fetch(`/api/camera/frame?t=${Date.now()}`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `status ${r.status}`);
        const url = URL.createObjectURL(await r.blob());
        if (stop) { URL.revokeObjectURL(url); return; }
        if (last.current) URL.revokeObjectURL(last.current);
        last.current = url;
        setSrc(url);
        setError('');
      } catch (e) {
        if (!stop) setError(e.message);
      }
      if (!stop) timer = setTimeout(tick, ms);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [active, ms]);
  useEffect(() => () => { if (last.current) URL.revokeObjectURL(last.current); }, []);
  return { src, error };
}
