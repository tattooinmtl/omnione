import { useEffect, useMemo, useRef, useState } from 'react';

/* A line chart for the Stats page, in plain SVG.
 *
 * Follows the house chart rules: one y-axis, 2px round lines, a 10% wash
 * under a single series, an end dot (r 4, 2px surface ring) with the last
 * value beside it, a legend whenever there are two series, recessive
 * hairline grid, text in text colours (never the series colour), a
 * crosshair + tooltip on hover or arrow keys, and a table view for anyone
 * who would rather read numbers.
 *
 * series: [{ key, label, color, values: number[] (null = no data) }]
 * labels: string[] (x, one per value — ISO days)
 */

const PAD = { top: 14, right: 64, bottom: 26, left: 48 };

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function fmt(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(a >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return Math.round(n / 1e3) + 'k';
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  if (!Number.isInteger(n)) return String(Number(n.toFixed(2)));
  return String(n);
}

const shortDay = (iso) => {
  const d = new Date(iso + 'T00:00:00Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

export default function LineChart({ series, labels, height = 200, yMin = 0, yMaxHint = 0, format = fmt, title }) {
  const wrap = useRef(null);
  const [width, setWidth] = useState(560);
  const [hover, setHover] = useState(null);
  const [table, setTable] = useState(false);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(260, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = labels.length;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - PAD.top - PAD.bottom;
  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  const dataMax = all.length ? Math.max(...all) : 0;
  const yMax = yMin < 0 ? 1 : niceMax(Math.max(dataMax, yMaxHint));
  const x = (i) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;
  const ticks = yMin < 0 ? [-1, -0.5, 0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  const paths = useMemo(() => series.map((s) => {
    let d = '';
    let pen = false;
    s.values.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    const lastI = s.values.reduce((a, v, i) => (v != null ? i : a), -1);
    let area = '';
    if (series.length === 1 && lastI >= 0) {
      const firstI = s.values.findIndex((v) => v != null);
      area = `${d}L${x(lastI).toFixed(1)},${y(yMin < 0 ? yMin : 0)}L${x(firstI).toFixed(1)},${y(yMin < 0 ? yMin : 0)}Z`;
    }
    return { ...s, d, area, lastI };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [series, width, height, yMax, yMin, n]);

  const xTickIdx = n <= 1 ? [0] : [0, Math.round((n - 1) / 2), n - 1];

  const moveTo = (clientX) => {
    const r = wrap.current.getBoundingClientRect();
    const px = clientX - r.left - PAD.left;
    setHover(Math.max(0, Math.min(n - 1, Math.round((px / plotW) * (n - 1)))));
  };

  const onKey = (e) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); setHover((h) => Math.max(0, (h ?? n) - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setHover((h) => Math.min(n - 1, (h ?? -1) + 1)); }
    else if (e.key === 'Escape') setHover(null);
  };

  const tipLeft = hover != null ? Math.min(width - 170, Math.max(0, x(hover) + 12)) : 0;

  return (
    <div className="lc">
      {series.length > 1 && (
        <ul className="lc__legend" aria-label="Legend">
          {series.map((s) => (
            <li key={s.key}><i style={{ background: s.color }} aria-hidden="true" />{s.label}</li>
          ))}
        </ul>
      )}
      <div
        ref={wrap}
        className="lc__plot"
        tabIndex={0}
        role="img"
        aria-label={`${title || 'Chart'}. Use the left and right arrow keys to read each day.`}
        onMouseMove={(e) => moveTo(e.clientX)}
        onMouseLeave={() => setHover(null)}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="lc__grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text className="lc__ytick" x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {xTickIdx.map((i) => (
            <text key={i} className="lc__xtick" x={x(i)} y={height - 8} textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}>
              {labels[i] ? shortDay(labels[i]) : ''}
            </text>
          ))}
          {paths.map((p) => p.area && <path key={p.key + '-a'} d={p.area} fill={p.color} opacity="0.1" />)}
          {paths.map((p) => (
            <path key={p.key} d={p.d} fill="none" stroke={p.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {hover != null && (
            <line className="lc__cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} />
          )}
          {paths.map((p) => {
            const i = hover != null ? hover : p.lastI;
            const v = i >= 0 ? p.values[i] : null;
            if (v == null) return null;
            return (
              <g key={p.key + '-d'}>
                <circle cx={x(i)} cy={y(v)} r="4" fill={p.color} stroke="var(--stats-surface)" strokeWidth="2" />
                {hover == null && (
                  <text className="lc__end" x={x(i) + 9} y={y(v)} dy="0.32em">{format(v)}</text>
                )}
              </g>
            );
          })}
        </svg>
        {hover != null && (
          <div className="lc__tip" style={{ left: tipLeft }}>
            <b>{shortDay(labels[hover])}</b>
            {series.map((s) => (
              <span key={s.key}><i style={{ background: s.color }} aria-hidden="true" />{s.label}<em>{format(s.values[hover])}</em></span>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="lc__table-toggle" onClick={() => setTable((t) => !t)}>
        {table ? 'Hide table' : 'Show table'}
      </button>
      {table && (
        <div className="lc__table">
          <table>
            <thead><tr><th>Day</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
            <tbody>
              {labels.map((d, i) => (
                <tr key={d}><td>{d}</td>{series.map((s) => <td key={s.key}>{format(s.values[i])}</td>)}</tr>
              )).reverse()}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
