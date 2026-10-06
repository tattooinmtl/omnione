import { useEffect, useState } from 'react';
import { api, Msg, Section, Switch, ago } from './shared.jsx';

const MODES = [
  ['default', 'Ask before changing files or running commands'],
  ['acceptEdits', 'Change files freely, ask before commands'],
  ['plan', 'Plan only: look around, change nothing'],
];
const EXAMPLE = `# How to work with me
- I build web apps in React + Vite and ESP32 projects in Arduino.
- Answer in English, short and direct. Show code, not essays.
- Before a big change, list the steps and wait for my OK.
- Use pnpm, not npm. Commit messages in English, imperative.`;

const blankCommand = () => ({ name: '', description: '', prompt: '' });

/* Settings → Agent: how Omi-One works. Instructions it always follows (like a
 * CLAUDE.md), the project's AGENTS.md/CLAUDE.md, custom /commands, its own
 * time (the heartbeat), and the values that tune a run. */
export default function AgentTab() {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [hb, setHb] = useState(null);
  const [cmd, setCmd] = useState(null);       // the command being edited
  const [msg, setMsg] = useState({ text: '', error: false });

  const load = () => api('/api/agent').then((d) => { setData(d); setText(d.agent.instructions || ''); }).catch((e) => setMsg({ text: e.message, error: true }));
  useEffect(() => {
    load();
    api('/api/mind').then((m) => setHb(m.heartbeat)).catch(() => {});
  }, []);

  const save = async (patch, okText = 'Saved.') => {
    try {
      const d = await api('/api/agent', { method: 'POST', body: patch });
      setData((cur) => ({ ...cur, ...d }));
      setMsg({ text: okText, error: false });
      return true;
    } catch (e) { setMsg({ text: e.message, error: true }); return false; }
  };
  const setBeat = async (patch, okText) => {
    try {
      setHb(await api('/api/mind/heartbeat', { method: 'POST', body: patch }));
      setMsg({ text: okText, error: false });
    } catch (e) { setMsg({ text: e.message, error: true }); }
  };
  const beatNow = async () => {
    setMsg({ text: 'Waking Omi-One up…', error: false });
    try {
      const r = await api('/api/mind/beat', { method: 'POST' });
      setMsg(r.skipped ? { text: `It didn't wake up: ${r.skipped}.`, error: true } : { text: `Done: ${r.toolCalls ?? 0} actions, ${(r.tokens ?? 0).toLocaleString()} tokens. See its journal in Presence.`, error: false });
      api('/api/mind').then((m) => setHb(m.heartbeat)).catch(() => {});
    } catch (e) { setMsg({ text: e.message, error: true }); }
  };

  if (!data) return <Msg msg={msg} />;
  const a = data.agent;
  const commands = a.commands || [];
  const dirty = text !== (a.instructions || '');
  const num = (key, value) => save({ [key]: Number(value) });

  const saveCommand = async (e) => {
    e.preventDefault();
    const list = commands.filter((c, i) => i !== cmd.index);
    list.push({ name: cmd.name, description: cmd.description, prompt: cmd.prompt });
    if (await save({ commands: list }, `Saved. Type /${cmd.name.replace(/^\/+/, '').toLowerCase()} in the chat.`)) setCmd(null);
  };

  return (
    <>
      <Section title="Omi-One's own time (heartbeat)" lead="When you're not using it, Omi-One wakes up now and then to work on its goals, reflect and tidy its notes. It can't run commands or spend credits on its own; those wait in the inbox for you.">
        {hb && (
          <>
            <Switch
              id="agent-heartbeat"
              on={hb.enabled}
              onChange={(on) => setBeat({ enabled: on }, on ? `Heartbeat on: every ${hb.intervalMin} minutes while you're away.` : 'Heartbeat off: Omi-One only acts when you ask.')}
              label={hb.enabled ? 'Heartbeat on' : 'Heartbeat off'}
              hint={`${hb.beats || 0} wake-ups so far · last ${ago(hb.lastBeat)} · today ${((hb.budget?.cap || 0) - (hb.budget?.remaining || 0)).toLocaleString()} of ${(hb.budget?.cap || 0).toLocaleString()} tokens`}
            />
            <div className="settings-form__row">
              <label><span>Wake up every</span>
                <select id="agent-hb-interval" value={hb.intervalMin} onChange={(e) => setBeat({ intervalMin: Number(e.target.value) }, 'Saved.')}>
                  {[...new Set([15, 30, 45, 60, 120, 240, 480, hb.intervalMin])].sort((x, y) => x - y).map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m > 60 ? 's' : ''}`}</option>)}
                </select>
              </label>
              <label><span>Daily budget</span>
                <select id="agent-hb-budget" value={hb.dailyTokenCap} onChange={(e) => setBeat({ dailyTokenCap: Number(e.target.value) }, 'Saved.')}>
                  {[...new Set([50_000, 100_000, 150_000, 300_000, 500_000, 1_000_000, hb.dailyTokenCap])].sort((x, y) => x - y).map((n) => <option key={n} value={n}>{n.toLocaleString()} tokens</option>)}
                </select>
              </label>
              <label><span>Steps per wake-up</span>
                <select id="agent-hb-steps" value={hb.maxTurnsPerBeat} onChange={(e) => setBeat({ maxTurnsPerBeat: Number(e.target.value) }, 'Saved.')}>
                  {[...new Set([4, 8, 12, 20, 30, hb.maxTurnsPerBeat])].sort((x, y) => x - y).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
            <div className="settings-modal__form-row">
              <button type="button" className="settings-modal__ghost" onClick={beatNow}>Wake it up now</button>
            </div>
          </>
        )}
      </Section>

      <Section title="Instructions" lead="Written once, read at the start of every message, in every conversation: who you are, how you like answers, rules for your projects. Like custom instructions on Claude.ai, or a CLAUDE.md. Personalities and SOUL.md still apply; these come on top.">
        <textarea id="agent-instructions" className="settings-form__code" rows={10} maxLength={data.maxInstructions} value={text} onChange={(e) => setText(e.target.value)} placeholder={EXAMPLE} spellCheck={false} />
        <div className="settings-modal__form-row">
          <button type="button" className="settings-modal__save" onClick={() => save({ instructions: text }, 'Saved. Omi-One follows them from your next message.')} disabled={!dirty}>Save instructions</button>
          {dirty && <button type="button" className="settings-modal__ghost" onClick={() => setText(a.instructions || '')}>Undo changes</button>}
          {!text && <button type="button" className="settings-modal__ghost" onClick={() => setText(EXAMPLE)}>Start from an example</button>}
          <span className="settings-modal__note">{text.length.toLocaleString()} / {data.maxInstructions.toLocaleString()} characters</span>
        </div>
      </Section>

      <Section title="Project instruction files">
        <Switch
          id="agent-project-files"
          on={a.readProjectFiles !== false}
          onChange={(on) => save({ readProjectFiles: on }, on ? 'Omi-One reads them from your next message.' : 'Project files are ignored.')}
          label={`Read ${data.projectFileNames.join(', ')} from the project folder`}
          hint="The way Claude Code reads CLAUDE.md: put one in a project to tell Omi-One how that project works (commands, conventions, what not to touch)."
        />
        <p className="settings-modal__note">
          {data.projectFiles.length
            ? `Found in the open project: ${data.projectFiles.map((f) => `${f.name} (${(f.bytes / 1024).toFixed(1)} KB)`).join(', ')}.`
            : 'None in the open project folder yet. Ask Omi-One: “write an AGENTS.md for this project”.'}
        </p>
      </Section>

      <Section title="Custom commands" lead="Your own /commands for things you ask often. Typing /name in the chat sends the prompt below; anything typed after the name replaces {input} in it (or is added at the end).">
        {commands.length > 0 && (
          <ul className="settings-list">
            {commands.map((c, i) => (
              <li key={c.name}>
                <div><b>/{c.name}</b><span>{c.description || c.prompt.slice(0, 90)}</span></div>
                <div className="settings-list__actions">
                  <button type="button" className="settings-modal__ghost" onClick={() => setCmd({ ...c, index: i })}>Edit</button>
                  <button type="button" className="settings-modal__ghost" onClick={() => save({ commands: commands.filter((_, j) => j !== i) }, 'Deleted.')}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {!cmd ? (
          <div className="settings-modal__form-row">
            <button type="button" className="settings-modal__save" onClick={() => setCmd({ ...blankCommand(), index: -1 })}>New command…</button>
            {commands.length === 0 && (
              <button type="button" className="settings-modal__ghost" onClick={() => setCmd({ index: -1, name: 'review', description: 'Review the code I point to', prompt: 'Review {input} for bugs, unclear names and missing error handling. List the problems by importance with the fix for each. Don\'t change files yet.' })}>Example: /review</button>
            )}
          </div>
        ) : (
          <form className="settings-form" onSubmit={saveCommand}>
            <div className="settings-form__row">
              <label><span>Name</span><input id="agent-cmd-name" required maxLength={30} value={cmd.name} onChange={(e) => setCmd({ ...cmd, name: e.target.value.replace(/[^a-zA-Z0-9-/]/g, '') })} placeholder="review" /></label>
              <label><span>What it does (shown in the / menu)</span><input id="agent-cmd-desc" maxLength={120} value={cmd.description} onChange={(e) => setCmd({ ...cmd, description: e.target.value })} placeholder="Review the code I point to" /></label>
            </div>
            <label><span>Prompt</span><textarea id="agent-cmd-prompt" rows={5} required maxLength={8000} value={cmd.prompt} onChange={(e) => setCmd({ ...cmd, prompt: e.target.value })} placeholder="Review {input} for bugs…" /></label>
            <div className="settings-modal__form-row">
              <button type="submit" className="settings-modal__save">Save command</button>
              <button type="button" className="settings-modal__ghost" onClick={() => setCmd(null)}>Cancel</button>
            </div>
          </form>
        )}
      </Section>

      <Section title="How it works" lead="Changes apply from the next message.">
        <div className="settings-form">
          <label><span>New chats start in</span>
            <select id="agent-mode" value={a.defaultMode} onChange={(e) => save({ defaultMode: e.target.value })}>
              {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <div className="settings-form__row">
            <label><span>An approval waits</span>
              <select id="agent-approval" value={a.approvalMinutes} onChange={(e) => num('approvalMinutes', e.target.value)}>
                {[1, 2, 5, 10, 15, 30].map((n) => <option key={n} value={n}>{n} min, then counts as no</option>)}
              </select>
            </label>
            <label><span>Steps a helper may take</span>
              <select id="agent-subagent" value={a.subagentSteps} onChange={(e) => num('subagentSteps', e.target.value)}>
                {[5, 10, 15, 25, 40].map((n) => <option key={n} value={n}>{n}{n === 15 ? ' (default)' : ''}</option>)}
              </select>
            </label>
          </div>
          <Switch id="agent-reflect" on={a.autoReflect} onChange={(on) => save({ autoReflect: on })} label="Learn skills from big tasks" hint="After a task with many steps, Omi-One proposes reusable skills; you approve them under /drafts." />
          {a.autoReflect && (
            <label><span>A big task is one with at least</span>
              <select id="agent-reflect-min" value={a.reflectMinTools} onChange={(e) => num('reflectMinTools', e.target.value)}>
                {[3, 6, 10, 20].map((n) => <option key={n} value={n}>{n} tool uses{n === 6 ? ' (default)' : ''}</option>)}
              </select>
            </label>
          )}
        </div>
      </Section>

      <Section title="Performance" lead="Fine-tuning. The defaults suit most work.">
        <div className="settings-form__row">
          <label><span>Longest reply</span>
            <select id="agent-max-out" value={a.maxOutputTokens} onChange={(e) => num('maxOutputTokens', e.target.value)}>
              <option value={0}>Provider default</option>
              {[4096, 8192, 16384, 32768, 65536].map((n) => <option key={n} value={n}>{(n / 1024)}k tokens</option>)}
            </select>
          </label>
          <label><span>Shrink the conversation at</span>
            <select id="agent-compact" value={a.compactAt} onChange={(e) => num('compactAt', e.target.value)}>
              {[60, 70, 80, 90, 95].map((n) => <option key={n} value={n}>{n}% of the context{n === 80 ? ' (default)' : ''}</option>)}
            </select>
          </label>
          <label><span>Retries when the AI is busy</span>
            <select id="agent-retries" value={a.retries} onChange={(e) => num('retries', e.target.value)}>
              {[0, 1, 2, 3, 4, 6].map((n) => <option key={n} value={n}>{n}{n === 3 ? ' (default)' : ''}</option>)}
            </select>
          </label>
          <label><span>Pictures it keeps in view</span>
            <select id="agent-images" value={a.imagesKept} onChange={(e) => num('imagesKept', e.target.value)}>
              {[2, 4, 8, 12, 20].map((n) => <option key={n} value={n}>{n}{n === 8 ? ' (default)' : ''}</option>)}
            </select>
          </label>
          <label><span>“Going in circles” after</span>
            <select id="agent-stuck" value={a.stuckRepeat} onChange={(e) => num('stuckRepeat', e.target.value)}>
              {[2, 3, 4, 6].map((n) => <option key={n} value={n}>{n} identical tries{n === 3 ? ' (default)' : ''}</option>)}
            </select>
          </label>
        </div>
        <p className="settings-modal__note">Steps per task, helpers at the same time, creativity and thinking are in the AI tab. Shrinking sooner saves tokens on long tasks; later keeps more detail. More pictures in view cost more tokens per message.</p>
        <Msg msg={msg} />
      </Section>
    </>
  );
}
