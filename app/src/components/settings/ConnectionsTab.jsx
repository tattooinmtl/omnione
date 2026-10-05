import { useEffect, useState } from 'react';
import { api, Msg, Section, Switch } from './shared.jsx';

// Coming in 0.10.0 (see docs/PARITY-PLAN.md). Only services that are free to
// connect are planned.
const PLANNED = [
  ['GitHub', 'Repos, issues and pull requests. Free: a token you create on GitHub.'],
  ['Telegram', 'Chat with Omi-One from your phone, answer approvals, get scheduled results. Free: a bot you make in two minutes.'],
  ['Discord', 'The same, in a Discord server or DM. Free.'],
];

const blankForm = () => ({ name: '', kind: 'http', url: '', command: '', args: '' });

/* Settings → Connections: MCP servers (Blender and others) and what's next. */
export default function ConnectionsTab() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState({ text: '', error: false });

  const load = () => api('/api/mcp/servers').then(setData).catch((e) => setMsg({ text: e.message, error: true }));
  useEffect(() => { load(); }, []);

  const report = (name, test) => {
    if (!test) return;
    setMsg(test.ok
      ? { text: `${name} is connected: ${test.tools.length} tools (${test.tools.slice(0, 6).join(', ')}${test.tools.length > 6 ? ', …' : ''}).`, error: false }
      : { text: `${name} was saved but isn't answering: ${test.error}`, error: true });
  };

  const addPreset = async (id) => {
    setBusy(id);
    try {
      const j = await api('/api/mcp/servers', { method: 'POST', body: { preset: id } });
      setData((d) => ({ ...d, servers: j.servers }));
      report(j.name, j.test);
    } catch (e) { setMsg({ text: e.message, error: true }); } finally { setBusy(''); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy('form');
    const body = form.kind === 'http'
      ? { name: form.name.trim(), url: form.url.trim() }
      : { name: form.name.trim(), command: form.command.trim(), args: form.args.trim() ? form.args.trim().split(/\s+/) : [] };
    try {
      const j = await api('/api/mcp/servers', { method: 'POST', body });
      setData((d) => ({ ...d, servers: j.servers }));
      setForm(null);
      report(j.name, j.test);
    } catch (err) { setMsg({ text: err.message, error: true }); } finally { setBusy(''); }
  };

  const test = async (name) => {
    setBusy(name);
    try {
      const j = await api(`/api/mcp/servers/${encodeURIComponent(name)}/test`, { method: 'POST' });
      setData((d) => ({ ...d, servers: j.servers }));
      report(name, j);
    } catch (e) { setMsg({ text: e.message, error: true }); } finally { setBusy(''); }
  };
  const toggle = async (name, enabled) => {
    try { const j = await api(`/api/mcp/servers/${encodeURIComponent(name)}/enabled`, { method: 'POST', body: { enabled } }); setData((d) => ({ ...d, servers: j.servers })); } catch (e) { setMsg({ text: e.message, error: true }); }
  };
  const remove = async (name) => {
    try { const j = await api(`/api/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' }); setData((d) => ({ ...d, servers: j.servers })); setMsg({ text: `Removed ${name}.`, error: false }); } catch (e) { setMsg({ text: e.message, error: true }); }
  };

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const servers = data?.servers || [];
  const presets = (data?.presets || []).filter((p) => !servers.some((s) => s.name === p.id));

  return (
    <>
      <VercelCard />

      <Section
        title="MCP servers"
        lead="Programs that give Omi-One more tools, such as Blender. Looking around runs freely; anything that changes something asks you first, and running code always asks."
      >
        {!data ? <Msg msg={msg} /> : (
          <>
            {servers.length === 0 && <p className="settings-modal__note">None set up yet.</p>}
            <ul className="settings-list">
              {servers.map((s) => (
                <li key={s.name} className={s.disabled ? 'is-off' : ''}>
                  <div>
                    <b>{s.name} · <span className={`settings-mcp__state is-${s.status === 'ok' ? 'ok' : s.status === 'error' ? 'bad' : 'idle'}`}>{s.status === 'ok' ? `connected, ${s.tools.length} tools` : s.status}</span></b>
                    <span><code>{s.where}</code></span>
                    {s.error && <span className="settings-mcp__err">{s.error}</span>}
                  </div>
                  <div className="settings-list__actions">
                    <button type="button" className="settings-modal__ghost" onClick={() => test(s.name)} disabled={busy === s.name}>{busy === s.name ? 'Testing…' : 'Test'}</button>
                    <Switch id={`mcp-${s.name}`} on={!s.disabled} onChange={(on) => toggle(s.name, on)} label="" />
                    <button type="button" className="settings-modal__ghost" onClick={() => remove(s.name)} aria-label={`Remove ${s.name}`}>Remove</button>
                  </div>
                </li>
              ))}
            </ul>

            {!form ? (
              <div className="settings-modal__form-row">
                {presets.map((p) => (
                  <button key={p.id} type="button" className="settings-modal__save" onClick={() => addPreset(p.id)} disabled={busy === p.id}>
                    {busy === p.id ? 'Connecting…' : `Add ${p.label}`}
                  </button>
                ))}
                <button type="button" className="settings-modal__ghost" onClick={() => setForm(blankForm())}>Add another…</button>
              </div>
            ) : (
              <form className="settings-form" onSubmit={submit}>
                <div className="settings-form__row">
                  <label><span>Name</span><input id="mcp-name" required maxLength={40} value={form.name} onChange={set('name')} placeholder="blender" /></label>
                  <label><span>Kind</span>
                    <select id="mcp-kind" value={form.kind} onChange={set('kind')}>
                      <option value="http">A web address (HTTP)</option>
                      <option value="program">A program to start</option>
                    </select>
                  </label>
                </div>
                {form.kind === 'http'
                  ? <label><span>Address</span><input id="mcp-url" required value={form.url} onChange={set('url')} placeholder="http://127.0.0.1:8765/mcp" spellCheck={false} /></label>
                  : (
                    <div className="settings-form__row">
                      <label><span>Command</span><input id="mcp-command" required value={form.command} onChange={set('command')} placeholder="npx" spellCheck={false} /></label>
                      <label><span>Arguments</span><input id="mcp-args" value={form.args} onChange={set('args')} placeholder="-y @modelcontextprotocol/server-filesystem C:\\Projects" spellCheck={false} /></label>
                    </div>
                  )}
                <div className="settings-modal__form-row">
                  <button type="submit" className="settings-modal__save" disabled={busy === 'form'}>{busy === 'form' ? 'Connecting…' : 'Add and test'}</button>
                  <button type="button" className="settings-modal__ghost" onClick={() => setForm(null)}>Cancel</button>
                </div>
              </form>
            )}
            <Msg msg={msg} />
            {servers.some((s) => s.name === 'blender' && s.status !== 'ok') && (
              <p className="settings-modal__note">
                Blender has to be open with its server started: in Blender, Edit → Preferences → Add-ons → Blender MCP → Start Server
                (or the Blender MCP panel in the 3D view's sidebar). Then press Test.
              </p>
            )}
          </>
        )}
      </Section>

      <Section title="Coming next" lead="These arrive in the next update. Only services that are free to connect are planned; Google, WhatsApp and X are left out because they charge to connect.">
        <ul className="settings-list">
          {PLANNED.map(([name, what]) => (
            <li key={name} className="is-off">
              <div><b>{name}</b><span>{what}</span></div>
              <span className="settings-modal__ws-tag">soon</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/* Vercel: paste a token once; Omi-One can then list, deploy and promote. */
function VercelCard() {
  const [st, setSt] = useState(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ text: '', error: false });

  useEffect(() => { api('/api/connections/vercel').then(setSt).catch((e) => setMsg({ text: e.message, error: true })); }, []);

  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg({ text: '', error: false });
    try {
      const j = await api('/api/connections/vercel', { method: 'POST', body: { token: token.trim() } });
      setSt(j);
      setToken('');
      setMsg({ text: `Connected as ${j.user}. Ask Omi-One: “deploy my-site to Vercel”.`, error: false });
    } catch (err) { setMsg({ text: err.message, error: true }); } finally { setBusy(false); }
  };
  const pickTeam = async (e) => {
    try {
      const j = await api('/api/connections/vercel/team', { method: 'POST', body: { teamId: e.target.value || null } });
      setSt((cur) => ({ ...cur, ...j }));
      setMsg({ text: e.target.value ? 'Omi-One now works in that team.' : 'Omi-One now works in your personal account.', error: false });
    } catch (err) { setMsg({ text: err.message, error: true }); }
  };
  const disconnect = async () => {
    try { setSt(await api('/api/connections/vercel', { method: 'DELETE' })); setMsg({ text: 'Disconnected. The token is deleted from this PC.', error: false }); } catch (err) { setMsg({ text: err.message, error: true }); }
  };

  return (
    <Section
      title="Vercel"
      lead="Lets Omi-One put a site from its folder online, check builds and read their logs. Deploying and going live always ask you first. Free: it uses a token from your Vercel account."
    >
      {!st ? null : st.connected ? (
        <div className="settings-form">
          <ul className="settings-list">
            <li className="settings-vercel__row">
              <div>
                <b>Connected as {st.user} <span className="settings-mcp__state is-ok">· ready</span></b>
                <span>Token {st.tokenHint}, kept on this PC only.</span>
              </div>
              <button type="button" className="settings-modal__ghost" onClick={disconnect}>Disconnect</button>
            </li>
          </ul>
          {st.teams?.length > 0 && (
            <label>
              <span>Account Omi-One works in</span>
              <select id="vercel-team" value={st.teamId || ''} onChange={pickTeam}>
                <option value="">Personal account</option>
                {st.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
          )}
        </div>
      ) : (
        <form className="settings-form" onSubmit={connect}>
          <ol className="settings-steps">
            <li>Open <b>vercel.com/account/tokens</b> (<a href="https://vercel.com/account/tokens" target="_blank" rel="noreferrer">open</a>) and sign in.</li>
            <li>Create a token: any name (e.g. “OmniOne”), scope your account or team, an expiry you like.</li>
            <li>Paste it here.</li>
          </ol>
          <label>
            <span>Vercel token</span>
            <div className="settings-modal__key-row">
              <input id="vercel-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste the token" spellCheck={false} />
              <button type="submit" className="settings-modal__save" disabled={busy || token.trim().length < 10}>{busy ? 'Checking…' : 'Connect'}</button>
            </div>
          </label>
        </form>
      )}
      <Msg msg={msg} />
    </Section>
  );
}
