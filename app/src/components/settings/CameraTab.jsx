import { useEffect, useState } from 'react';
import { api, Msg, Section, Switch } from './shared.jsx';

/* Settings → Camera: which camera Omi-One sees through, a test picture, and
 * the on/off switch (the same one as the camera button in the chat). */
export default function CameraTab() {
  const [st, setSt] = useState(null);
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState('');
  const [test, setTest] = useState(null);
  const [msg, setMsg] = useState({ text: '', error: false });

  const load = () => api('/api/camera?webcams=1').then((s) => { setSt(s); setUrl(s.url || ''); setLabel(s.label || ''); }).catch((e) => setMsg({ text: e.message, error: true }));
  useEffect(() => { load(); }, []);
  useEffect(() => () => { if (test) URL.revokeObjectURL(test); }, [test]);

  const save = async (patch, okText = 'Saved.') => {
    try {
      const s = await api('/api/camera', { method: 'POST', body: patch });
      setSt((cur) => ({ ...cur, ...s }));
      setMsg({ text: okText, error: false });
      return s;
    } catch (e) { setMsg({ text: e.message, error: true }); return null; }
  };

  const find = async () => {
    setBusy('find');
    setFound(null);
    setMsg({ text: 'Looking for cameras on your home network (about 5 seconds)…', error: false });
    try {
      const j = await api('/api/camera/find', { method: 'POST' });
      setFound(j.cameras);
      setMsg(j.cameras.length
        ? { text: `Found ${j.cameras.length} camera${j.cameras.length > 1 ? 's' : ''}.`, error: false }
        : { text: 'No camera answered. Is it powered, and on the same Wi-Fi as this PC?', error: true });
    } catch (e) { setMsg({ text: e.message, error: true }); } finally { setBusy(''); }
  };

  const takeTest = async () => {
    setBusy('test');
    try {
      const r = await fetch(`/api/camera/frame?test=1&t=${Date.now()}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `status ${r.status}`);
      setTest(URL.createObjectURL(await r.blob()));
      setMsg({ text: 'That is what Omi-One will see.', error: false });
    } catch (e) { setTest(null); setMsg({ text: e.message, error: true }); } finally { setBusy(''); }
  };

  if (!st) return <Msg msg={msg} />;
  const sizes = Object.entries(st.esp32Sizes || {});

  return (
    <>
      <Section
        title="Live camera"
        lead="When the camera is on, every message you send (typed or spoken) takes one picture with it, so you can ask “what is this?” or “does this look right?”. Nothing is recorded in between. A red dot shows while it is on, and it is never used when Omi-One works on its own."
      >
        <Switch
          id="camera-on"
          on={st.on}
          onChange={(on) => save({ on }, on ? 'Camera on: your next message takes a picture.' : 'Camera off.')}
          label={st.on ? 'Camera on' : 'Camera off'}
          hint={st.configured ? `Using ${st.label || st.url || st.device}` : 'Choose a camera below first.'}
          disabled={!st.configured}
        />
        <Msg msg={msg} />
      </Section>

      <Section title="Which camera">
        <div className="settings-form">
          <label>
            <span>Kind</span>
            <select id="camera-source" value={st.source} onChange={(e) => save({ source: e.target.value })}>
              <option value="url">ESP32 camera or a picture address</option>
              <option value="webcam">A webcam on this PC</option>
            </select>
          </label>

          {st.source === 'url' ? (
            <>
              <div className="settings-modal__form-row">
                <button type="button" className="settings-modal__save" onClick={find} disabled={busy === 'find'}>{busy === 'find' ? 'Looking…' : 'Find my ESP32 camera'}</button>
              </div>
              {found?.length > 0 && (
                <ul className="settings-list">
                  {found.map((c) => (
                    <li key={c.ip}>
                      <div><b>{c.ip}</b><span>{c.url}</span></div>
                      <button type="button" className="settings-modal__ghost" onClick={() => { setUrl(c.url); setLabel(label || 'ESP32 camera'); save({ url: c.url, label: label || 'ESP32 camera' }, `Using the camera at ${c.ip}.`); }}>Use this one</button>
                    </li>
                  ))}
                </ul>
              )}
              <form onSubmit={(e) => { e.preventDefault(); save({ url, label }); }}>
                <div className="settings-form__row">
                  <label><span>Picture address</span><input id="camera-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://192.168.1.50/capture or http://localhost:8080/shot.jpg" spellCheck={false} /></label>
                  <label><span>Name</span><input id="camera-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="ESP32 camera" maxLength={60} /></label>
                </div>
                <div className="settings-modal__form-row">
                  <button type="submit" className="settings-modal__ghost" disabled={url === (st.url || '') && label === (st.label || '')}>Save address</button>
                </div>
              </form>
              {sizes.length > 0 && /\/capture$/.test(st.url || '') && (
                <label>
                  <span>Picture size (ESP32)</span>
                  <select id="camera-size" value={st.esp32Size} onChange={(e) => save({ esp32Size: Number(e.target.value) }, 'Saved. It applies when the camera is turned on.')}>
                    {sizes.map(([n, l]) => <option key={n} value={n}>{l}</option>)}
                  </select>
                </label>
              )}
              <p className="settings-modal__note">
                An ESP32 camera running the CameraWebServer sketch shows its address on the serial monitor at start-up. A sketch can only give pictures as large as the size it starts the camera with: start it at FRAMESIZE_UXGA to allow every size.
              </p>
            </>
          ) : (
            <label>
              <span>Webcam</span>
              <select id="camera-device" value={st.device} onChange={(e) => save({ device: e.target.value, label: e.target.value })}>
                <option value="">{(st.webcams || []).length ? 'Choose…' : 'No webcam found on this PC'}</option>
                {(st.webcams || []).map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
          )}

          <div className="settings-modal__form-row">
            <button type="button" className="settings-modal__ghost" onClick={takeTest} disabled={!st.configured || busy === 'test'}>{busy === 'test' ? 'Taking a picture…' : 'Test picture'}</button>
          </div>
          {test && <img className="settings-camera__test" src={test} alt="Test picture from the camera" />}
        </div>
      </Section>
    </>
  );
}
