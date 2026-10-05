import { useEffect, useState } from 'react';
import { api, Msg, Section, Switch, ago } from './shared.jsx';

const KINDS = [
  ['daily', 'Every day'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Every week'],
  ['monthly', 'Every month'],
  ['interval', 'Every few hours'],
  ['once', 'Once'],
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EXAMPLES = [
  ['Morning news', 'weekdays', 'Search the web for news from the last 24 hours about AI agents and ESP32 projects. Give me the 5 most important items, one line each, with links.'],
  ['Forum check', 'daily', 'Read the newest posts on the OmniOne forum and tell me which ones need an answer from me.'],
  ['Weekly project review', 'weekly', 'Look at the project files changed in the last week and write a short status: what was done, what looks unfinished, what to do next.'],
];
const blank = () => ({ title: '', prompt: '', kind: 'daily', time: '08:00', weekday: 1, day: 1, everyMin: 180, at: '' });

/* Settings → Schedules: tasks Omi-One runs on its own, and their results. */
export default function SchedulesTab() {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [open, setOpen] = useState(null);   // run id whose summary is expanded
  const [msg, setMsg] = useState({ text: '', error: false });

  const load = () => api('/api/schedules').then(setData).catch((e) => setMsg({ text: e.message, error: true }));
  useEffect(() => {
    load();
    // Runs finishing while this is open.
    let es;
    try {
      es = new EventSource('/api/live');
      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data);
          if (['schedule_run', 'schedule_start', 'schedules_changed'].includes(ev.type)) load();
        } catch { /* keep-alive */ }
      };
    } catch { /* no live channel */ }
    return () => es?.close();
  }, []);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e) => {
    e.preventDefault();
    const schedule = { kind: form.kind, time: form.time, weekday: Number(form.weekday), day: Number(form.day), everyMin: Number(form.everyMin), at: form.at };
    try {
      const t = await api('/api/schedules', { method: 'POST', body: { title: form.title, prompt: form.prompt, schedule } });
      setForm(null);
      setMsg({ text: `Added. It runs ${t.when}; next at ${new Date(t.nextRunAt).toLocaleString()}.`, error: false });
      load();
    } catch (err) { setMsg({ text: err.message, error: true }); }
  };
  const toggle = async (t, enabled) => {
    try { await api(`/api/schedules/${t.id}`, { method: 'PATCH', body: { enabled } }); load(); } catch (e) { setMsg({ text: e.message, error: true }); }
  };
  const runNow = async (t) => {
    try { await api(`/api/schedules/${t.id}/run`, { method: 'POST' }); setMsg({ text: `Running "${t.title}" now. The result appears below when it finishes.`, error: false }); load(); } catch (e) { setMsg({ text: e.message, error: true }); }
  };
  const remove = async (t) => {
    try { await api(`/api/schedules/${t.id}`, { method: 'DELETE' }); load(); } catch (e) { setMsg({ text: e.message, error: true }); }
  };

  if (!data) return <Msg msg={msg} />;

  return (
    <>
      <Section
        title="Scheduled tasks"
        lead="Things Omi-One does on its own at set times. Each run is a fresh conversation in the same safe mode as its heartbeat: it can read, search the web and edit its folder, but commands and paid tools wait for you in the inbox. Tasks run only while OmniOne is open (it can start with Windows: see App). You can also just ask Omi-One: “every weekday at 8, …”."
      >
        {data.tasks.length === 0 && !form && <p className="settings-modal__note">No scheduled tasks yet.</p>}
        <ul className="settings-list">
          {data.tasks.map((t) => (
            <li key={t.id} className={t.enabled ? '' : 'is-off'}>
              <div>
                <b>{t.title}{t.running ? ' · running now' : ''}</b>
                <span>{t.when}{t.enabled && t.nextRunAt ? ` · next ${new Date(t.nextRunAt).toLocaleString()}` : t.enabled ? '' : ' · paused'} · last run {ago(t.lastRunAt)}</span>
              </div>
              <div className="settings-list__actions">
                <button type="button" className="settings-modal__ghost" onClick={() => runNow(t)} disabled={Boolean(data.running)}>Run now</button>
                <Switch id={`sched-${t.id}`} on={t.enabled} onChange={(on) => toggle(t, on)} label="" />
                <button type="button" className="settings-modal__ghost" onClick={() => remove(t)} aria-label={`Delete ${t.title}`}>Delete</button>
              </div>
            </li>
          ))}
        </ul>

        {!form ? (
          <div className="settings-modal__form-row">
            <button type="button" className="settings-modal__save" onClick={() => setForm(blank())}>New task…</button>
            {EXAMPLES.map(([title, kind, prompt]) => (
              <button key={title} type="button" className="settings-modal__ghost" onClick={() => setForm({ ...blank(), title, kind, prompt, time: kind === 'weekly' ? '17:00' : '08:00', weekday: 5 })}>{title}</button>
            ))}
          </div>
        ) : (
          <form className="settings-form" onSubmit={submit}>
            <label><span>Name</span><input id="sched-title" maxLength={80} value={form.title} onChange={set('title')} placeholder="Morning news" /></label>
            <label><span>What Omi-One should do</span><textarea id="sched-prompt" required rows={4} maxLength={4000} value={form.prompt} onChange={set('prompt')} placeholder="Write it as a full instruction: the run doesn't see this chat." /></label>
            <div className="settings-form__row">
              <label><span>How often</span><select id="sched-kind" value={form.kind} onChange={set('kind')}>{KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
              {['daily', 'weekdays', 'weekly', 'monthly'].includes(form.kind) && <label><span>Time</span><input id="sched-time" type="time" required value={form.time} onChange={set('time')} /></label>}
              {form.kind === 'weekly' && <label><span>Day</span><select id="sched-weekday" value={form.weekday} onChange={set('weekday')}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>}
              {form.kind === 'monthly' && <label><span>Day of month</span><input id="sched-day" type="number" min="1" max="31" value={form.day} onChange={set('day')} /></label>}
              {form.kind === 'interval' && (
                <label><span>Every</span><select id="sched-every" value={form.everyMin} onChange={set('everyMin')}>
                  {[30, 60, 120, 180, 360, 720].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>)}
                </select></label>
              )}
              {form.kind === 'once' && <label><span>When</span><input id="sched-at" type="datetime-local" required value={form.at} onChange={set('at')} /></label>}
            </div>
            <div className="settings-modal__form-row">
              <button type="submit" className="settings-modal__save">Add task</button>
              <button type="button" className="settings-modal__ghost" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </form>
        )}
        <Msg msg={msg} />
      </Section>

      <Section title="Recent runs">
        {data.runs.length === 0 ? <p className="settings-modal__note">Nothing has run yet.</p> : (
          <ul className="settings-runs">
            {data.runs.slice(0, 20).map((r) => (
              <li key={r.id} className={r.ok ? 'is-ok' : 'is-bad'}>
                <button type="button" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
                  <span className="settings-runs__state">{r.missed ? 'Missed' : r.ok ? 'Done' : 'Failed'}</span>
                  <b>{r.title}</b>
                  <span>{new Date(r.startedAt).toLocaleString()}</span>
                </button>
                {open === r.id && <div className="settings-runs__body">{r.error || r.summary || 'No summary.'}</div>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
