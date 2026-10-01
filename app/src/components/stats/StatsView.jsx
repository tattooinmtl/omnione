import { useCallback, useEffect, useState } from 'react';
import LineChart, { fmt } from './LineChart.jsx';
import './StatsView.css';

/* Usage & stats — everything OmniOne has counted on this machine.
 *
 * Colours are fixed per series and validated for the dark surface
 * (colour-blind separation included): teal #0fa89a, purple #8b5cf6,
 * orange #dd6b1f, green #3fa34d, and red #e5484d reserved for failures.
 * Green and orange never share a chart, and neither do green and red —
 * those pairs are too close for red-green colour blindness.
 */
const C = {
  teal: '#0fa89a',
  purple: '#8b5cf6',
  orange: '#dd6b1f',
  green: '#3fa34d',
  red: '#e5484d',
};

const RANGES = [7, 30, 90];

function Tile({ label, value, sub }) {
  return (
    <div className="st-tile">
      <span className="st-tile__label">{label}</span>
      <b className="st-tile__value">{value}</b>
      {sub && <span className="st-tile__sub">{sub}</span>}
    </div>
  );
}

function Section({ id, title, subtitle, children }) {
  return (
    <section className="st-section" aria-labelledby={`st-${id}`}>
      <header>
        <h3 id={`st-${id}`}>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

export default function StatsView({ onClose, account }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/stats?days=${days}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
      setErr('');
    } catch (e) {
      setErr(e.message);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 30_000);
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(t); window.removeEventListener('keydown', onKey); };
  }, [load, onClose]);

  const s = data?.series || [];
  const labels = s.map((d) => d.day);
  const col = (k) => s.map((d) => d[k]);
  const t = data?.totals;
  const empty = t && t.requests === 0 && t.toolCalls === 0;
  const maxModel = Math.max(1, ...(data?.models || []).map((m) => m.in + m.out));

  return (
    <div className="stats" role="dialog" aria-label="Usage and stats">
      <header className="stats__bar">
        <span className="stats__title">USAGE &amp; STATS</span>
        <div className="stats__ranges" role="tablist" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r} type="button" role="tab" aria-selected={days === r} className={days === r ? 'is-on' : ''} onClick={() => setDays(r)}>
              {r} days
            </button>
          ))}
        </div>
        <span className="stats__sync">
          {account?.connected
            ? `Synced to ${account.user?.name || 'your account'}${account.lastSync ? ` · ${new Date(account.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
            : 'On this computer only'}
        </span>
        <button type="button" className="stats__close" onClick={onClose} aria-label="Close">×</button>
      </header>

      <div className="stats__body">
        {err && <p className="stats__err">Couldn’t load stats: {err}</p>}
        {!data && !err && <p className="stats__empty">Loading…</p>}
        {data && (
          <>
            {empty && (
              <p className="stats__empty">Nothing counted in the last {days} days yet. Talk to Omi-One and this fills in: tokens, tools, the heartbeat, mood.</p>
            )}

            <div className="st-tiles">
              <Tile label="Tokens in" value={fmt(t.in)} sub={t.cacheRead ? `${fmt(t.cacheRead)} from cache` : 'sent to models'} />
              <Tile label="Tokens out" value={fmt(t.out)} sub="written by models" />
              <Tile label="Model requests" value={fmt(t.requests)} sub={`${fmt(t.sessions)} conversations`} />
              <Tile label="Tool calls" value={fmt(t.toolCalls)} sub={t.toolCalls ? `${Math.round((t.toolErrors / t.toolCalls) * 100)}% failed` : 'none yet'} />
              <Tile label="Heartbeat" value={fmt(t.heartbeatTokens)} sub={`${fmt(t.beats)} beats`} />
              <Tile label="Approvals" value={fmt(t.asked)} sub={t.asked ? `${fmt(t.approved)} allowed · ${fmt(t.denied)} denied` : 'none asked'} />
            </div>

            <Section id="tokens" title="Tokens" subtitle="Sent to the model (in) and written by it (out), per day.">
              <LineChart
                title="Tokens in and out per day"
                labels={labels}
                series={[
                  { key: 'in', label: 'In', color: C.teal, values: col('in') },
                  { key: 'out', label: 'Out', color: C.purple, values: col('out') },
                ]}
              />
            </Section>

            <Section id="models" title="By model" subtitle={`Where the ${fmt(t.in + t.out)} tokens went.`}>
              {data.models.length === 0 ? <p className="stats__none">No model calls in this range.</p> : (
                <ul className="st-bars">
                  {data.models.map((m) => (
                    <li key={m.key}>
                      <span className="st-bars__name">{m.model}<small>{m.provider}</small></span>
                      <span className="st-bars__track"><i style={{ width: `${((m.in + m.out) / maxModel) * 100}%`, background: C.teal }} /></span>
                      <span className="st-bars__val">{fmt(m.in + m.out)}<small>{fmt(m.requests)} req</small></span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <div className="st-grid">
              <Section id="heartbeat" title="Heartbeat" subtitle="Tokens Omi-One spent on its own time.">
                <LineChart title="Heartbeat tokens per day" labels={labels} height={170} series={[{ key: 'hb', label: 'Heartbeat tokens', color: C.orange, values: col('heartbeatTokens') }]} />
              </Section>

              <Section id="activity" title="Activity" subtitle="Model requests and conversations per day.">
                <LineChart
                  title="Requests and conversations per day"
                  labels={labels}
                  height={170}
                  series={[
                    { key: 'req', label: 'Requests', color: C.teal, values: col('requests') },
                    { key: 'ses', label: 'Conversations', color: C.purple, values: col('sessions') },
                  ]}
                />
              </Section>
            </div>

            <Section id="tools" title="Tools" subtitle="Every tool Omi-One ran, and the ones that failed.">
              <div className="st-grid">
                <div>
                  <h4 className="st-sub">Calls per day</h4>
                  <LineChart title="Tool calls per day" labels={labels} height={170} series={[{ key: 'tc', label: 'Tool calls', color: C.green, values: col('toolCalls') }]} />
                </div>
                <div>
                  <h4 className="st-sub">Failures per day</h4>
                  <LineChart title="Failed tool calls per day" labels={labels} height={170} series={[{ key: 'te', label: 'Failed', color: C.red, values: col('toolErrors') }]} />
                </div>
              </div>
              {data.tools.length > 0 && (
                <div className="st-table">
                  <table>
                    <thead><tr><th>Tool</th><th>Calls</th><th>Failed</th><th>Avg time</th></tr></thead>
                    <tbody>
                      {data.tools.slice(0, 12).map((x) => (
                        <tr key={x.name}>
                          <td>{x.name}</td>
                          <td>{fmt(x.calls)}</td>
                          <td>{x.errors ? <span className="st-fail">⚠ {fmt(x.errors)}</span> : '0'}</td>
                          <td>{x.avgMs < 1000 ? `${x.avgMs} ms` : `${(x.avgMs / 1000).toFixed(1)} s`}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Section>

            <div className="st-grid">
              <Section id="approvals" title="Approvals" subtitle="Commands, edits and posts that asked you first.">
                <LineChart
                  title="Approvals per day"
                  labels={labels}
                  height={170}
                  series={[
                    { key: 'ok', label: 'Allowed', color: C.teal, values: col('approved') },
                    { key: 'no', label: 'Denied', color: C.orange, values: col('denied') },
                  ]}
                />
              </Section>

              <Section id="mood" title="Mood" subtitle="Omi-One’s average valence (−1 to 1) and energy (0 to 1) per day.">
                <LineChart
                  title="Mood per day"
                  labels={labels}
                  height={170}
                  yMin={-1}
                  format={(v) => (v == null ? '—' : v.toFixed(2))}
                  series={[
                    { key: 'val', label: 'Valence', color: C.teal, values: data.mood.map((m) => m.valence) },
                    { key: 'en', label: 'Energy', color: C.orange, values: data.mood.map((m) => m.energy) },
                  ]}
                />
              </Section>
            </div>

            <p className="stats__foot">
              Counted on this computer: numbers only, never what was said. Run errors in this range: {fmt(t.errors)}.
              {account?.connected ? ' Daily totals sync to your profile on the website.' : ' Connect your account to see them on the website too.'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
