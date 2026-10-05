import { useEffect, useState } from 'react';
import { api, Msg, Section } from './shared.jsx';

const LEVELS = ['none', 'little', 'some', 'lots'];
const BLANK = { id: '', name: '', tagline: '', tone: '', backstory: '', style: '', language: '', emoji: 'some', humor: 'some', voiceId: '', faceColor: '#5fa8ff' };

/* Personalities: pick one of the built-in roles or write your own. */
export default function PersonalityTab() {
  const [data, setData] = useState(null);
  const [voices, setVoices] = useState([]);
  const [editing, setEditing] = useState(null);
  const [msg, setMsg] = useState({ text: '', error: false });

  const load = () => api('/api/personalities').then(setData).catch((e) => setMsg({ text: e.message, error: true }));
  useEffect(() => {
    load();
    api('/api/prefs').then((p) => setVoices(p.voice.clones || [])).catch(() => {});
  }, []);

  const choose = async (id) => {
    try {
      await api('/api/personalities/active', { method: 'POST', body: { id } });
      setData((d) => ({ ...d, active: id }));
      const p = data.list.find((x) => x.id === id);
      setMsg({ text: `Omi-One is now ${p?.name || id}. It applies from the next message.`, error: false });
    } catch (e) { setMsg({ text: e.message, error: true }); }
  };

  const saveCustom = async (e) => {
    e.preventDefault();
    try {
      const j = await api('/api/personalities', { method: 'POST', body: { ...editing, id: editing.id || editing.name, activate: true } });
      setData({ active: j.active, list: j.list });
      setEditing(null);
      setMsg({ text: `Saved "${j.saved.name}" and switched to it.`, error: false });
    } catch (err) { setMsg({ text: err.message, error: true }); }
  };

  const remove = async (id) => {
    try {
      const j = await api(`/api/personalities/${encodeURIComponent(id)}`, { method: 'DELETE' });
      setData(j);
      setMsg({ text: 'Deleted.', error: false });
    } catch (e) { setMsg({ text: e.message, error: true }); }
  };

  if (!data) return <Msg msg={msg} />;
  const set = (k) => (e) => setEditing((p) => ({ ...p, [k]: e.target.value }));

  return (
    <>
      <Section
        title="Personality"
        lead="A role Omi-One plays when it talks to you, with its own tone and voice. It sits on top of SOUL.md, which stays yours. Code, commands and facts never change with the role."
      >
        <div className="settings-persona__grid" role="radiogroup" aria-label="Personality">
          {data.list.map((p) => (
            <div key={p.id} className={`settings-persona${data.active === p.id ? ' is-on' : ''}`}>
              <button type="button" role="radio" aria-checked={data.active === p.id} onClick={() => choose(p.id)}>
                <span className="settings-persona__dot" style={{ background: p.faceColor }} />
                <b>{p.name}</b>
                <span>{p.tagline || (p.preset ? '' : 'Your own')}</span>
              </button>
              {!p.preset && (
                <div className="settings-persona__actions">
                  <button type="button" className="settings-modal__ghost" onClick={() => setEditing({ ...BLANK, ...p, voiceId: p.voiceId || '' })}>Edit</button>
                  <button type="button" className="settings-modal__ghost" onClick={() => remove(p.id)}>Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
        {!editing && <button type="button" className="settings-modal__save" onClick={() => setEditing({ ...BLANK })}>New personality…</button>}
        <Msg msg={msg} />
      </Section>

      {editing && (
        <Section title={editing.id ? `Edit ${editing.name}` : 'New personality'} lead="Describe the character. Short and concrete works best.">
          <form className="settings-form" onSubmit={saveCustom}>
            <label><span>Name</span><input id="persona-name" required maxLength={40} value={editing.name} onChange={set('name')} placeholder="Sage" /></label>
            <label><span>One line about it</span><input id="persona-tagline" maxLength={120} value={editing.tagline} onChange={set('tagline')} placeholder="An old wizard who explains code with stories" /></label>
            <label><span>Tone</span><input id="persona-tone" maxLength={200} value={editing.tone} onChange={set('tone')} placeholder="wise, gentle, a bit theatrical" /></label>
            <label><span>Backstory</span><textarea id="persona-backstory" rows={3} maxLength={1500} value={editing.backstory} onChange={set('backstory')} /></label>
            <label><span>How it talks</span><textarea id="persona-style" rows={3} maxLength={1500} value={editing.style} onChange={set('style')} placeholder="Starts answers with a short metaphor, then gets practical." /></label>
            <div className="settings-form__row">
              <label><span>Language</span><input id="persona-language" maxLength={40} value={editing.language} onChange={set('language')} placeholder="same as you" /></label>
              <label><span>Emoji</span><select id="persona-emoji" value={editing.emoji} onChange={set('emoji')}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select></label>
              <label><span>Humour</span><select id="persona-humor" value={editing.humor} onChange={set('humor')}>{LEVELS.map((l) => <option key={l}>{l}</option>)}</select></label>
              <label><span>Face colour</span><input id="persona-color" type="color" value={editing.faceColor} onChange={set('faceColor')} /></label>
            </div>
            <label>
              <span>Voice</span>
              <select id="persona-voice" value={editing.voiceId} onChange={set('voiceId')}>
                <option value="">The voice from the Voice tab</option>
                {voices.map((v) => <option key={v.voiceId} value={v.voiceId}>{v.name} (cloned)</option>)}
                <option value="English_expressive_narrator">Expressive narrator</option>
                <option value="English_Graceful_Lady">Graceful lady</option>
                <option value="English_Persuasive_Man">Persuasive man</option>
              </select>
            </label>
            <div className="settings-modal__form-row">
              <button type="submit" className="settings-modal__save">Save and use</button>
              <button type="button" className="settings-modal__ghost" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </form>
        </Section>
      )}
    </>
  );
}
