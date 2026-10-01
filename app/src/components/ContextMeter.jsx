import React from 'react';
import { estimateTokens, fmtTok, FALLBACK_OUTPUT_CAP } from '../hooks/useProviderTokenBudget';
import './ContextMeter.css';

/* ContextMeter — ported shape from GameForgerAI/ContextMeter.jsx.
 * Uses the provider CONTEXT window as the gauge denominator.
 */

export default function ContextMeter({ prompt = '', code = '', budget, reserveTokens = 0 }) {
  const promptTok = estimateTokens(prompt);
  const codeTok = estimateTokens(code);
  const userTok = promptTok + codeTok;
  const totalTok = userTok === 0 ? 0 : userTok + (reserveTokens || 0);
  const ctx = budget && budget.contextTokens > 0 ? budget.contextTokens : null;
  const out = budget && Number.isFinite(budget.outputCap) ? budget.outputCap : FALLBACK_OUTPUT_CAP;
  const tools = budget && budget.maxToolCalls > 0 ? budget.maxToolCalls : null;
  const cap = ctx || (out > 0 ? out : FALLBACK_OUTPUT_CAP);
  const pct = Math.min(100, Math.round((totalTok / cap) * 100));
  const state = pct >= 90 ? 'danger' : pct >= 60 ? 'warn' : 'ok';
  const remaining = Math.max(0, cap - totalTok);
  const title = [
    budget && budget.label
      ? `${budget.label}${ctx ? ` · context ${ctx.toLocaleString()}` : ''}`
      : null,
    `prompt: ~${promptTok.toLocaleString()} tok`,
    codeTok ? `current code: ~${codeTok.toLocaleString()} tok` : null,
    ctx ? `context window: ${ctx.toLocaleString()} tok` : null,
    `output cap: ${out > 0 ? out.toLocaleString() : 'no clamp'}`,
    tools != null ? `tool calls: ${tools}` : 'tool calls: not published',
    `remaining context: ~${remaining.toLocaleString()} tok`,
  ].filter(Boolean).join(' · ');

  return (
    <div className={`gf-ctx gf-ctx-${state}`} title={title}>
      <div className="gf-ctx-bar" style={{ width: `${pct}%` }} />
      <span className="gf-ctx-text">
        ~{fmtTok(totalTok)} / {fmtTok(cap)} ctx
        {' · '}
        {fmtTok(out, { zero: 'no clamp' })} out
        {' · '}
        {tools != null ? `${tools} tools` : 'tools —'}
        {' · '}
        <span className="gf-ctx-remaining">{fmtTok(remaining)} left</span>
      </span>
    </div>
  );
}
