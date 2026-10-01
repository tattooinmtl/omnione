// Reflection — the agent proposing skills from its own execution traces.
//
// This is the piece that makes the harness self-evolving in the Hermes sense:
// after a substantial run, look back over what actually happened and ask
// whether it contains a reusable procedure worth writing down. A sequence
// that took nine tool calls to get right the first time should take one
// loaded skill the next time.
//
// Three deliberate constraints:
//
// 1. Output goes to skills/_drafts/, never to skills/. Nothing the agent
//    writes about how to work becomes instructions it follows without a
//    human reading it first. An agent that teaches itself a mistake will
//    repeat that mistake in every future session.
// 2. Previously rejected proposals are fed back in. Without that the same
//    rejected skill is re-proposed after every session and the human is
//    stuck saying no to it forever.
// 3. One reflection per session, and only for runs that did real work. The
//    analysis costs a model call; a two-turn chat has nothing to learn from.

import { runOpenAI, runAnthropic } from './adapters.js';
import { getSession } from './sessions.js';
import { getSkills } from './skills.js';
import { saveDraft, getRejections, listDrafts } from './skillDrafts.js';

export const MIN_TOOL_CALLS_TO_REFLECT = 6;
const MAX_TRANSCRIPT_CHARS = 24_000;
const MAX_PROPOSALS = 3;

const reflected = new Set();

export function hasReflected(sessionId) {
  return reflected.has(sessionId);
}

export function markReflected(sessionId) {
  reflected.add(sessionId);
}

/* Is this session worth spending a model call on? */
export function isWorthReflecting(sessionId) {
  const session = getSession(sessionId);
  if (!session) return { worth: false, reason: 'no such session' };
  if (reflected.has(sessionId)) return { worth: false, reason: 'already reflected' };

  let toolCalls = 0;
  for (const m of session.messages) {
    if (m.role !== 'assistant') continue;
    toolCalls += (m.content || []).filter((b) => b.type === 'tool_use').length;
  }
  if (toolCalls < MIN_TOOL_CALLS_TO_REFLECT) {
    return { worth: false, reason: `only ${toolCalls} tool calls`, toolCalls };
  }
  return { worth: true, toolCalls };
}

/* Flatten a session into something a model can read, keeping the shape of
 * the work — which tools ran, in what order, what failed — because that is
 * what a reusable procedure is made of. */
export function renderTranscript(session) {
  const lines = [];
  for (const m of session.messages) {
    if (m.role === 'user') {
      lines.push(`USER: ${text(m)}`);
    } else if (m.role === 'assistant') {
      const t = text(m);
      if (t.trim()) lines.push(`ASSISTANT: ${t.slice(0, 1500)}`);
      for (const b of (m.content || []).filter((x) => x.type === 'tool_use')) {
        lines.push(`  CALL ${b.name}(${JSON.stringify(b.input).slice(0, 300)})`);
      }
    } else if (m.role === 'tool') {
      for (const b of m.content || []) {
        const head = String(b.text || '').slice(0, 300).replace(/\s+/g, ' ');
        lines.push(`  ${b.isError ? 'FAILED' : 'RESULT'} ${b.name}: ${head}`);
      }
    }
  }
  const joined = lines.join('\n');
  // Keep the tail: how a task ended — the fix that finally worked — is more
  // instructive than how it started.
  return joined.length > MAX_TRANSCRIPT_CHARS
    ? `…(earlier turns omitted)\n${joined.slice(-MAX_TRANSCRIPT_CHARS)}`
    : joined;
}

function text(m) {
  return (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function buildPrompt(session) {
  const existing = getSkills().map((s) => `- ${s.name}: ${s.description}`).join('\n') || '(none)';
  const pending = listDrafts().map((d) => `- ${d.name}: ${d.description}`).join('\n') || '(none)';
  const rejected = getRejections({ limit: 30 })
    .map((r) => `- ${r.name}${r.reason ? ` (rejected: ${r.reason})` : ' (rejected)'}`)
    .join('\n') || '(none)';

  return `Below is a transcript of an agent session. Decide whether it contains a reusable procedure worth saving as a skill.

A skill is worth proposing only when ALL of these hold:
- The task took real work to get right — several steps, or a wrong turn that had to be corrected.
- The same shape of task will plausibly come up again.
- Writing it down would genuinely save time or avoid the same mistake.

Do NOT propose a skill for: a one-off question, something already covered by an existing skill, a generic restatement of how to use a tool, or anything already proposed or rejected below.

It is entirely normal to propose nothing. Most sessions do not warrant a skill. Returning an empty list is the right answer far more often than not.

EXISTING SKILLS:
${existing}

ALREADY PROPOSED, AWAITING REVIEW:
${pending}

PREVIOUSLY REJECTED — do not propose these again:
${rejected}

TRANSCRIPT:
${renderTranscript(session)}

Reply with JSON only, no prose and no code fence:
{"skills":[{"name":"lowercase-hyphenated-name","description":"One line saying when to use this skill.","body":"Markdown instructions. Concrete and specific: the actual steps, the actual commands, the specific mistake to avoid. Not general advice.","evidence":"What in the transcript justifies this — the failure that was corrected, or the sequence that was non-obvious."}]}

At most ${MAX_PROPOSALS} skills. Use {"skills":[]} if nothing qualifies.`;
}

/* Run the analysis. Returns the drafts written. */
export async function reflectOnSession({ sessionId, provider, model, apiKey, signal }) {
  const session = getSession(sessionId);
  if (!session) throw new Error(`No session "${sessionId}"`);
  if (!provider || provider.apiStyle === 'stub') {
    throw new Error('Reflection needs a real provider — the local stub cannot analyse a transcript.');
  }

  markReflected(sessionId);

  const run = provider.apiStyle === 'anthropic' ? runAnthropic : runOpenAI;
  const messages = [{ role: 'user', content: [{ type: 'text', text: buildPrompt(session) }] }];

  let out = '';
  for await (const ev of run({
    system: 'You analyse agent transcripts and propose reusable skills. You reply with JSON and nothing else.',
    messages,
    tools: [],
    model,
    apiKey,
    baseUrl: provider.baseUrl,
    signal,
    maxTokens: 4000,
  })) {
    if (ev.type === 'delta') out += ev.text;
    else if (ev.type === 'error') throw new Error(ev.message);
  }

  const proposals = parseProposals(out);
  const written = [];
  for (const p of proposals.slice(0, MAX_PROPOSALS)) {
    try {
      written.push(saveDraft({
        name: p.name,
        description: p.description,
        body: p.body,
        provenance: {
          sessionId,
          sessionTitle: session.title || '',
          evidence: p.evidence || '',
          model,
          provider: provider.id,
        },
      }));
    } catch (e) {
      // A bad name from the model should not lose the other proposals.
      written.push({ name: p.name, error: e.message });
    }
  }
  return written;
}

/* Models wrap JSON in fences and prose no matter how firmly you ask them not
 * to. Pull out the first balanced object rather than trusting the whole
 * response to parse. */
export function parseProposals(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];

  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  candidates.push(text);

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      const skills = Array.isArray(parsed) ? parsed : parsed?.skills;
      if (!Array.isArray(skills)) continue;
      return skills
        .filter((s) => s && typeof s.name === 'string' && typeof s.body === 'string')
        .map((s) => ({
          name: String(s.name).trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, ''),
          description: String(s.description || '').trim(),
          body: String(s.body).trim(),
          evidence: String(s.evidence || '').trim(),
        }))
        .filter((s) => s.name && s.body);
    } catch { /* try the next candidate */ }
  }
  return [];
}
