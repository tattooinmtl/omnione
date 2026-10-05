import { useEffect, useState } from 'react';
import { api, Section } from './shared.jsx';

// Coming in 0.10.0 (see docs/PARITY-PLAN.md). Only services that are free to
// connect are planned.
const PLANNED = [
  ['GitHub', 'Repos, issues and pull requests. Free: a token you create on GitHub.'],
  ['Vercel', 'Deployments, logs and redeploys. Free: a token from your Vercel account.'],
  ['Telegram', 'Chat with Omi-One from your phone, answer approvals, get scheduled results. Free: a bot you make in two minutes.'],
  ['Discord', 'The same, in a Discord server or DM. Free.'],
];

/* Settings → Connections: outside services Omi-One can use. */
export default function ConnectionsTab() {
  const [servers, setServers] = useState(null);
  useEffect(() => { api('/api/mcp/servers').then((j) => setServers(j.servers || j || [])).catch(() => setServers([])); }, []);

  return (
    <>
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

      <Section title="MCP servers" lead="Tools from MCP servers listed in .gwn-mcp.json join Omi-One's own tools.">
        {servers === null ? <p className="settings-modal__note">…</p> : servers.length === 0 ? (
          <p className="settings-modal__note">None set up.</p>
        ) : (
          <ul className="settings-list">
            {servers.map((s) => (
              <li key={s.name || s.id}>
                <div><b>{s.name || s.id}</b><span>{s.status || (s.connected ? 'connected' : 'not connected')}{s.tools != null ? ` · ${Array.isArray(s.tools) ? s.tools.length : s.tools} tools` : ''}</span></div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
