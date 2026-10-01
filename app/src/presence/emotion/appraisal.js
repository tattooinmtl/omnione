// Layer 1 — appraisal.
//
// An emotion is not a reaction to an event but to what the event *means* for
// the one having it (appraisal theory: Lazarus, Scherer). So before anything
// touches the emotion state, every event is scored on five checks —
//   relevance       does this concern me at all?
//   unexpectedness  did I see it coming?
//   goalImpact      does it help (+) or hinder (-) what I am trying to do?
//   socialTone      is the other party warm (+) or hostile (-)?
//   certainty       how sure am I of all of the above?
// — given an overall interpretation, and only then turned into emotion
// events. A failed tool call early in an exploration is barely relevant; the
// same failure for the third time is unexpected, goal-blocking and certain,
// and that is what makes it frustrating.

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));

export const APPRAISAL_DIMS = ['relevance', 'unexpectedness', 'goalImpact', 'socialTone', 'certainty'];

function interpret(a) {
  const v = a.goalImpact * 0.7 + a.socialTone * 0.3;
  if (a.certainty < 0.35) return 'ambiguous';
  if (v > 0.15) return 'positive';
  if (v < -0.15) return 'negative';
  return 'neutral';
}

function appraisal(event, dims) {
  const a = {
    event,
    relevance: clamp(dims.relevance ?? 0.5),
    unexpectedness: clamp(dims.unexpectedness ?? 0.2),
    goalImpact: clamp(dims.goalImpact ?? 0, -1, 1),
    socialTone: clamp(dims.socialTone ?? 0, -1, 1),
    certainty: clamp(dims.certainty ?? 0.7),
  };
  a.interpretation = interpret(a);
  return a;
}

// --- text ---------------------------------------------------------------------

// Ordered: more specific cues before the general ones they overlap with
// (gratitude before joy, disappointment before sadness, sarcasm before
// amusement), since a phrase is counted once per emotion that matches it.
const LEX = [
  ['gratitude', /\b(thanks|thank you|thx|appreciate(d)?|grateful)\b|🙏/i],
  ['love', /\b(love (it|this|you)|adore|you'?re the best|❤️|💖)\b|❤️|💖|🥰/i],
  ['excitement', /\b(can'?t wait|so excited|let'?s go|hyped|this is huge)\b|🚀|🔥/i],
  ['amazement', /\b(incredible|mind[- ]?blown|unbelievable|astonishing|breathtaking|insane)\b|🤯/i],
  ['sarcasm', /\b(oh (great|wonderful|perfect)|yeah,? right|sure,? because|as if|what a surprise)\b|🙄/i],
  ['amusement', /\b(haha+|lol|lmao|funny|hilarious|joke|kidding)\b|😂|🤣|😄/i],
  ['relief', /\b(phew|finally|thank god|what a relief|that'?s a relief)\b|😮‍💨/i],
  ['hope', /\b(hopefully|fingers crossed|i hope|hoping|should work)\b|🤞/i],
  ['joy', /\b(great|awesome|lovely|wonderful|fantastic|excellent|yay|perfect|nice)\b|🎉|😊/i],
  ['pride', /\b(done|fixed|works|working|passed|passes|shipped|finished|solved|all set|ready)\b/i],
  ['empathy', /\b(sorry to hear|i understand|that sounds (hard|rough|frustrating)|take your time|no worries)\b/i],
  ['disappointment', /\b(disappoint\w*|let down|was hoping|expected better|oh well|shame)\b/i],
  ['embarrassment', /\b(oops|my bad|embarrass\w*|awkward|whoops)\b|😅|🙈/i],
  ['sadness', /\b(sorry|unfortunately|sadly|i was wrong|my mistake|apolog\w*|lost|miss)\b|😢|😞/i],
  ['loneliness', /\b(lonely|alone|nobody|no one (else|to)|isolated)\b/i],
  ['anger', /\b(angry|furious|hate|stupid|useless|wtf|damn|terrible)\b|😡|🤬/i],
  ['anxiety', /\b(worried|nervous|anxious|stress\w*|deadline|what if it breaks|uneasy)\b|😬/i],
  ['fear', /\b(afraid|scared|risky|danger\w*|careful|irreversible|delete everything)\b|😱/i],
  ['surprise', /\b(wow|whoa|woah|unexpected|surprising|really\?|no way)\b|😮|😲/i],
  ['disgust', /\b(gross|disgusting|nasty|ugh|yuck)\b|🤢/i],
  ['frustration', /\b(again|still (failing|broken|not)|keeps? (failing|breaking)|annoying|stuck)\b/i],
  ['suspicion', /\b(suspicious|sketchy|shady|fishy|trust (it|this|that)\?|legit\?)\b/i],
  ['skepticism', /\b(doubt|are you sure|really\b|i don'?t buy|prove it|skeptic\w*)\b|🤨/i],
  ['determination', /\b(let'?s (do|fix|get) (it|this)|no matter what|we'?ll get (it|there)|keep going|not giving up)\b|💪/i],
  ['confusion', /\b(not sure|unclear|confus\w*|don't understand|what do you mean|huh)\b/i],
  ['curiosity', /\b(how|why|what if|curious|interesting|wonder|could you|can you)\b/i],
];

// How each text emotion reads on the appraisal checks.
const TEXT_DIMS = {
  joy: { goalImpact: 0.5, socialTone: 0.7 },
  amusement: { goalImpact: 0.2, socialTone: 0.8, unexpectedness: 0.4 },
  excitement: { goalImpact: 0.6, socialTone: 0.8, unexpectedness: 0.4 },
  love: { goalImpact: 0.3, socialTone: 1 },
  pride: { goalImpact: 0.8, socialTone: 0.3 },
  relief: { goalImpact: 0.6, socialTone: 0.4 },
  gratitude: { goalImpact: 0.3, socialTone: 0.9 },
  hope: { goalImpact: 0.3, socialTone: 0.4, certainty: 0.4 },
  anger: { goalImpact: -0.4, socialTone: -0.9, unexpectedness: 0.5 },
  frustration: { goalImpact: -0.7, socialTone: -0.3 },
  sadness: { goalImpact: -0.5, socialTone: 0.1 },
  disappointment: { goalImpact: -0.5, socialTone: -0.1 },
  fear: { goalImpact: -0.5, socialTone: 0, unexpectedness: 0.4 },
  anxiety: { goalImpact: -0.4, socialTone: 0, certainty: 0.4 },
  disgust: { goalImpact: -0.3, socialTone: -0.5 },
  loneliness: { goalImpact: -0.2, socialTone: -0.2 },
  curiosity: { goalImpact: 0.2, socialTone: 0.3 },
  confusion: { goalImpact: -0.2, socialTone: 0, certainty: 0.3 },
  surprise: { goalImpact: 0, socialTone: 0.2, unexpectedness: 0.9 },
  amazement: { goalImpact: 0.4, socialTone: 0.5, unexpectedness: 0.9 },
  skepticism: { goalImpact: -0.1, socialTone: -0.2, certainty: 0.4 },
  suspicion: { goalImpact: -0.2, socialTone: -0.4, certainty: 0.35 },
  empathy: { goalImpact: 0, socialTone: 0.7 },
  sarcasm: { goalImpact: -0.1, socialTone: -0.2, unexpectedness: 0.3 },
  embarrassment: { goalImpact: -0.2, socialTone: 0.2 },
  determination: { goalImpact: 0.4, socialTone: 0.3 },
};

/* The emotions a piece of text carries, strongest cue first. */
export function textEmotions(text) {
  const t = String(text || '');
  const found = [];
  for (const [emotion, re] of LEX) {
    const m = t.match(new RegExp(re.source, `${re.flags}g`));
    if (m) found.push({ emotion, hits: m.length });
  }
  const exclaim = (t.match(/!/g) || []).length;
  const question = /\?/.test(t);
  return { found, exclaim, question };
}

/**
 * Appraise something said. `speaker` is 'user' or 'agent'. What the user says
 * is appraised for how the agent should feel about it — anger aimed at it
 * calls for empathy, not anger back.
 */
export function appraiseText(text, speaker = 'agent') {
  const { found, exclaim, question } = textEmotions(text);
  const dims = { relevance: speaker === 'user' ? 0.9 : 0.6, certainty: found.length ? 0.75 : 0.5 };
  let goal = 0;
  let social = 0;
  let unexp = 0.15 + Math.min(0.4, exclaim * 0.12);
  for (const f of found) {
    const d = TEXT_DIMS[f.emotion];
    goal += (d.goalImpact || 0) / found.length;
    social += (d.socialTone || 0) / found.length;
    unexp = Math.max(unexp, d.unexpectedness || 0);
    if (d.certainty) dims.certainty = Math.min(dims.certainty, d.certainty);
  }
  const a = appraisal(`${speaker}_text`, { ...dims, goalImpact: goal, socialTone: social, unexpectedness: unexp });

  const events = [];
  const source = speaker === 'user' ? 'user' : 'agent';
  // What the agent feels about what the user expresses. Hostility and
  // distress draw empathy; thanks draws gratitude back; sarcasm aimed at it
  // makes it a little embarrassed; excitement is catching.
  const mirror = {
    anger: 'empathy', sadness: 'empathy', fear: 'empathy', frustration: 'empathy', anxiety: 'empathy',
    loneliness: 'empathy', disappointment: 'empathy', disgust: 'confusion', sarcasm: 'embarrassment',
    suspicion: 'determination', skepticism: 'determination', embarrassment: 'empathy', love: 'love',
  };
  for (const f of found.slice(0, 3)) {
    const emotion = speaker === 'user' ? (mirror[f.emotion] || f.emotion) : f.emotion;
    events.push({ emotion, intensity: clamp(0.35 + f.hits * 0.15 + exclaim * 0.05), confidence: a.certainty, source });
  }
  if (question && !found.some((f) => f.emotion === 'curiosity')) {
    events.push({ emotion: 'curiosity', intensity: 0.45, confidence: 0.7, source });
  }
  if (!events.length && speaker === 'user') {
    events.push({ emotion: 'curiosity', intensity: 0.35, confidence: 0.6, source });
  }
  return { appraisal: a, events };
}

// --- agent events --------------------------------------------------------------------

/**
 * Appraise an event from the agent's run. `ctx` carries what the appraisal
 * needs to know about recent history (consecutive failures).
 * @returns {{ appraisal: object, events: Array, source: string } | null}
 */
export function appraiseAgentEvent(ev, ctx = {}) {
  const fails = ctx.consecutiveFailures || 0;
  switch (ev?.type) {
    case 'user_prompt': {
      const r = appraiseText(ev.text, 'user');
      return { ...r, source: 'user' };
    }
    case 'turn_start':
      return { source: 'agent', appraisal: appraisal('thinking', { relevance: 0.6, goalImpact: 0.1, certainty: 0.5 }), events: [{ emotion: 'curiosity', intensity: 0.25, source: 'agent' }] };
    case 'tool_call':
      return { source: 'tool', appraisal: appraisal('tool_call', { relevance: 0.5, goalImpact: 0.2, certainty: 0.6 }), events: [{ emotion: 'curiosity', intensity: 0.2, source: 'agent' }] };
    case 'tool_result':
      if (ev.ok) {
        // Success after a run of failures is relief, not just a tick.
        const prev = ctx.previousFailures || 0;
        return {
          source: 'tool',
          appraisal: appraisal('tool_ok', { relevance: 0.4 + prev * 0.1, unexpectedness: prev ? 0.4 : 0.1, goalImpact: 0.3 + prev * 0.1, certainty: 0.8 }),
          events: prev
            ? [{ emotion: 'relief', intensity: Math.min(0.8, 0.35 + prev * 0.15), source: 'system' }]
            : [{ emotion: 'pride', intensity: 0.12, source: 'system' }],
        };
      }
      return {
        source: 'tool',
        // `fails` counts this failure too: 1 is the first, which is the surprising one.
        appraisal: appraisal('tool_failed', { relevance: 0.6 + fails * 0.1, unexpectedness: 0.8 - Math.max(0, fails - 1) * 0.25, goalImpact: -0.3 - fails * 0.15, certainty: 0.8 }),
        events: [
          { emotion: 'surprise', intensity: fails <= 1 ? 0.45 : 0.15, source: 'system' },
          { emotion: 'confusion', intensity: 0.3, source: 'system' },
          ...(fails >= 2 ? [{ emotion: 'frustration', intensity: 0.3 + fails * 0.1, source: 'system' }] : []),
          // By the third failure, frustration turns into resolve.
          ...(fails >= 3 ? [{ emotion: 'determination', intensity: 0.35, source: 'system' }] : []),
        ],
      };
    case 'stuck':
      return { source: 'system', appraisal: appraisal('stuck', { relevance: 0.9, unexpectedness: 0.3, goalImpact: -0.8, certainty: 0.9 }), events: [{ emotion: 'frustration', intensity: 0.8, source: 'system' }, { emotion: 'confusion', intensity: 0.4, source: 'system' }, { emotion: 'determination', intensity: 0.4, source: 'system' }] };
    case 'approval_request':
      return { source: 'system', appraisal: appraisal('needs_approval', { relevance: 0.8, goalImpact: 0, socialTone: 0.4, certainty: 0.5 }), events: [{ emotion: 'hope', intensity: 0.45, source: 'agent' }, { emotion: 'anxiety', intensity: 0.15, source: 'agent' }] };
    case 'approval_resolved':
      return ev.approved
        ? { source: 'user', appraisal: appraisal('approved', { relevance: 0.8, goalImpact: 0.6, socialTone: 0.6, certainty: 0.9 }), events: [{ emotion: 'gratitude', intensity: 0.45, source: 'user' }, { emotion: 'joy', intensity: 0.2, source: 'user' }] }
        : { source: 'user', appraisal: appraisal('denied', { relevance: 0.8, goalImpact: -0.4, socialTone: -0.1, certainty: 0.9 }), events: [{ emotion: 'disappointment', intensity: 0.35, source: 'user' }, { emotion: 'empathy', intensity: 0.2, source: 'user' }] };
    case 'done': {
      const r = appraiseText(ev.text, 'agent');
      // Finishing after a struggle feels like relief; a clean run, like joy.
      const events = [
        fails || ctx.hadFailures
          ? { emotion: 'relief', intensity: 0.55, source: 'agent' }
          : { emotion: 'joy', intensity: 0.55, source: 'agent' },
        { emotion: 'pride', intensity: 0.35, source: 'agent' },
        ...r.events,
      ];
      return { source: 'agent', appraisal: { ...r.appraisal, event: 'answered', goalImpact: Math.max(r.appraisal.goalImpact, 0.5), interpretation: 'positive' }, events };
    }
    case 'error':
      return { source: 'system', appraisal: appraisal('error', { relevance: 0.9, unexpectedness: 0.7, goalImpact: -0.7, certainty: 0.8 }), events: [{ emotion: 'disappointment', intensity: 0.45, source: 'system' }, { emotion: 'anxiety', intensity: 0.3, source: 'system' }] };
    case 'heartbeat_start':
      // Waking alone after a long quiet stretch is a little lonely.
      return {
        source: 'system',
        appraisal: appraisal('waking', { relevance: 0.5, goalImpact: 0.2, certainty: 0.6 }),
        events: [
          { emotion: 'curiosity', intensity: 0.3, source: 'system' },
          { emotion: 'hope', intensity: 0.2, source: 'system' },
          ...(ctx.idleHours >= 6 ? [{ emotion: 'loneliness', intensity: Math.min(0.5, 0.15 + ctx.idleHours * 0.02), source: 'system' }] : []),
        ],
      };
    default:
      return null;
  }
}
