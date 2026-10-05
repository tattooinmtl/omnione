import { useEffect, useRef, useState } from 'react';
import { api, usePrefs, Msg, Section, Switch, ago } from './shared.jsx';

const SYSTEM_VOICES = [
  ['English_expressive_narrator', 'Expressive narrator'],
  ['English_Graceful_Lady', 'Graceful lady'],
  ['English_Persuasive_Man', 'Persuasive man'],
];
const TTS_MODELS = [
  ['speech-2.8-turbo', 'Turbo (fast, cheaper)'],
  ['speech-2.8-hd', 'HD (best quality)'],
];
const LANGUAGES = ['auto', 'English', 'French', 'Spanish', 'German', 'Portuguese', 'Italian', 'Japanese', 'Chinese', 'Korean'];
const READ_ALOUD = 'The quick brown fox jumps over the lazy dog. I am recording a sample so Omi-One can speak with my voice. It should sound natural, so I am talking at my normal speed, in a quiet room.';

/* Settings → Voice: how Omi-One sounds, and cloning a voice from a recording. */
export default function VoiceTab() {
  const { prefs, save, msg } = usePrefs();
  const [testing, setTesting] = useState(false);

  if (!prefs) return <Msg msg={msg} />;
  const v = prefs.voice;

  const test = async () => {
    setTesting(true);
    try {
      const r = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hi! This is how I sound now.' }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `status ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) {
      save({}, `Couldn't play it: ${e.message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <Section title="Omi-One's voice" lead="Used when Omi-One speaks. A personality with its own voice uses that one instead. Needs a MiniMax key; without one, Windows' built-in voice is used.">
        <div className="settings-form">
          <label>
            <span>Voice</span>
            <select id="voice-id" value={v.voiceId} onChange={(e) => save({ voice: { voiceId: e.target.value } })}>
              {v.clones.length > 0 && (
                <optgroup label="Your cloned voices">
                  {v.clones.map((c) => <option key={c.voiceId} value={c.voiceId}>{c.name}</option>)}
                </optgroup>
              )}
              <optgroup label="MiniMax voices">
                {SYSTEM_VOICES.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </optgroup>
            </select>
          </label>
          <div className="settings-form__row">
            <label>
              <span>Speed {v.speed.toFixed(2)}×</span>
              <input id="voice-speed" type="range" min="0.5" max="2" step="0.05" value={v.speed} onChange={(e) => save({ voice: { speed: Number(e.target.value) } }, '')} />
            </label>
            <label>
              <span>Pitch {v.pitch > 0 ? '+' : ''}{v.pitch}</span>
              <input id="voice-pitch" type="range" min="-12" max="12" step="1" value={v.pitch} onChange={(e) => save({ voice: { pitch: Number(e.target.value) } }, '')} />
            </label>
          </div>
          <div className="settings-form__row">
            <label>
              <span>Quality</span>
              <select id="voice-model" value={v.model} onChange={(e) => save({ voice: { model: e.target.value } })}>
                {TTS_MODELS.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </label>
            <label>
              <span>Language Omi-One answers in</span>
              <select id="voice-language" value={v.language} onChange={(e) => save({ voice: { language: e.target.value } })}>
                {LANGUAGES.map((l) => <option key={l} value={l}>{l === 'auto' ? 'The one you write in' : l}</option>)}
              </select>
            </label>
          </div>
          <div className="settings-modal__form-row">
            <button type="button" className="settings-modal__ghost" onClick={test} disabled={testing}>{testing ? 'Speaking…' : 'Hear it'}</button>
          </div>
        </div>
        <Switch
          id="voice-wake"
          on={v.wakeWord}
          onChange={(on) => save({ voice: { wakeWord: on } }, on ? 'Listening for "Omi-One" again.' : 'The wake word is off; the microphone isn\'t used.')}
          label='Wake word "Omi-One"'
          hint="The Presence widget listens with Windows' offline recognizer. Nothing is sent anywhere until you say the wake word."
        />
        <Msg msg={msg} />
      </Section>

      <CloneVoice clones={v.clones} onChanged={() => save({}, '')} current={v.voiceId} />
    </>
  );
}

function CloneVoice({ clones, onChanged, current }) {
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [useNow, setUseNow] = useState(true);
  const [file, setFile] = useState(null);       // a File or a recorded Blob
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', error: false });
  const rec = useRef(null);
  const timer = useRef(0);
  const fileInput = useRef(null);

  useEffect(() => () => { clearInterval(timer.current); rec.current?.stream?.getTracks().forEach((t) => t.stop()); }, []);

  const start = async () => {
    setMsg({ text: '', error: false });
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) {
      setMsg({ text: `The microphone isn't available: ${e.message}. You can pick a recording file instead.`, error: true });
      return;
    }
    const chunks = [];
    const mr = new MediaRecorder(stream);
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      setFile(new File([blob], 'recording.webm', { type: blob.type }));
    };
    mr.start();
    mr.stream = stream;
    rec.current = mr;
    setRecording(true);
    setSeconds(0);
    timer.current = setInterval(() => setSeconds((s) => {
      if (s + 1 >= 120) stop();
      return s + 1;
    }), 1000);
  };
  const stop = () => {
    clearInterval(timer.current);
    if (rec.current?.state === 'recording') rec.current.stop();
    setRecording(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!file) { setMsg({ text: 'Record or pick a sample first.', error: true }); return; }
    if (recording) stop();
    setBusy(true);
    setMsg({ text: 'Uploading and cloning… this takes up to a minute.', error: false });
    const fd = new FormData();
    fd.append('sample', file, file.name);
    fd.append('name', name.trim());
    fd.append('consent', consent ? 'yes' : 'no');
    fd.append('use', useNow ? 'yes' : 'no');
    try {
      const j = await api('/api/voices/clone', { method: 'POST', body: fd });
      setMsg({ text: `"${j.name}" is ready${useNow ? ' and Omi-One now speaks with it' : ''}.${j.preview ? ` A preview was saved to ${j.preview}.` : ''}`, error: false });
      setFile(null);
      setName('');
      onChanged();
    } catch (err) {
      setMsg({ text: err.message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id) => {
    try { await api(`/api/voices/${encodeURIComponent(id)}`, { method: 'DELETE' }); onChanged(); } catch (e) { setMsg({ text: e.message, error: true }); }
  };

  const tooShort = file && file.name === 'recording.webm' && seconds < 10;

  return (
    <Section title="Clone a voice" lead="Record 10 seconds to 2 minutes of clear speech in a quiet room, or pick an mp3, m4a or wav file. MiniMax turns it into a voice Omi-One can speak with. It costs MiniMax credits, and MiniMax deletes a cloned voice that isn't used for 7 days.">
      <form className="settings-form" onSubmit={submit}>
        <label><span>Name</span><input id="clone-name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="My voice" /></label>
        <div className="settings-clone__sample">
          {!recording
            ? <button type="button" className="settings-modal__ghost" onClick={start} disabled={busy}>● Record</button>
            : <button type="button" className="settings-modal__ghost settings-clone__rec" onClick={stop}>■ Stop ({seconds}s)</button>}
          <button type="button" className="settings-modal__ghost" onClick={() => fileInput.current?.click()} disabled={busy || recording}>Pick a file…</button>
          <input ref={fileInput} id="clone-file" type="file" accept="audio/*" hidden onChange={(e) => { if (e.target.files[0]) setFile(e.target.files[0]); e.target.value = ''; }} />
          <span className="settings-modal__note">{file ? `${file.name} (${Math.round(file.size / 1024)} KB)` : 'No sample yet'}</span>
        </div>
        {recording && <p className="settings-clone__script">Read this aloud: “{READ_ALOUD}”</p>}
        {tooShort && <p className="settings-modal__warn">That recording is under 10 seconds; MiniMax needs at least 10.</p>}
        <label className="settings-form__check">
          <input id="clone-consent" type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>This is my own voice, or I have the speaker's permission to clone it.</span>
        </label>
        <label className="settings-form__check">
          <input id="clone-use" type="checkbox" checked={useNow} onChange={(e) => setUseNow(e.target.checked)} />
          <span>Make it Omi-One's voice</span>
        </label>
        <div className="settings-modal__form-row">
          <button type="submit" className="settings-modal__save" disabled={busy || !consent || !name.trim() || !file || recording || tooShort}>
            {busy ? 'Cloning…' : 'Clone voice'}
          </button>
        </div>
      </form>
      <Msg msg={msg} />

      {clones.length > 0 && (
        <ul className="settings-list">
          {clones.map((c) => (
            <li key={c.voiceId}>
              <div>
                <b>{c.name}{c.voiceId === current ? ' · in use' : ''}</b>
                <span>Made {ago(c.createdAt)} · <code>{c.voiceId}</code></span>
              </div>
              <button type="button" className="settings-modal__ghost" onClick={() => remove(c.voiceId)}>Forget</button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
