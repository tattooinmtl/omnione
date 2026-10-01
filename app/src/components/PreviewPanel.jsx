import { useEffect, useRef, useState } from 'react';
import './PreviewPanel.css';

/* Live HTML/Three.js preview. Renders the combined srcDoc inside a sandboxed
 * iframe. The error forwarder (injected by gameFiles.combineForPreview) posts
 * runtime errors up via postMessage so the parent can surface them as toasts.
 */
export default function PreviewPanel({ srcDoc, epoch, onError }) {
  const iframeRef = useRef(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (iframeRef.current) {
      iframeRef.current.srcdoc = srcDoc || '<!doctype html><html><body style="background:#000;color:#8a96a8;font-family:sans-serif;padding:24px">No project yet — describe one in the prompt above.</body></html>';
    }
  }, [srcDoc, reloadKey, epoch]);

  useEffect(() => {
    const onMessage = (e) => {
      const data = e.data;
      if (!data || data.__gwnPreview !== true) return;
      if (data.type === 'runtime-error' && onError) {
        onError(`Runtime error in preview: ${data.message || 'unknown'}`);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onError]);

  return (
    <div className="preview-panel">
      <div className="preview-panel__head">
        <h2>PREVIEW</h2>
        <button
          type="button"
          className="preview-panel__reload"
          onClick={() => setReloadKey((k) => k + 1)}
          title="Reload preview"
        >
          ↻
        </button>
      </div>
      <div className="preview-panel__viewport">
        <iframe
          ref={iframeRef}
          className="preview-panel__iframe"
          title="preview"
          sandbox="allow-scripts allow-pointer-lock allow-same-origin"
        />
      </div>
    </div>
  );
}
