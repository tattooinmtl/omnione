// /btw: a quick side question.
//
// The user asks something "by the way" (often while Omi-One is busy with a
// task). Omi-One answers from the conversation so far and what it knows,
// in one model call with no tools: it can't start, change or interrupt any
// work. The question and the answer are not added to the conversation, so
// the task carries on exactly as before.

import { runOpenAI, runAnthropic } from './adapters.js';
import { renderTranscript } from './reflection.js';
import { getMessages, sessionExists } from './sessions.js';

const MAX_QUESTION = 2000;

const SYSTEM = [
  'You are Omi-One, the AI inside OmniOne.',
  'The user is asking a quick side question ("by the way"), possibly while you are in the middle of a task.',
  'Answer briefly and directly, from the conversation below and what you know.',
  'For this answer you have no tools: you cannot run, read, change or start anything, and the task in progress continues unchanged.',
  'If a real answer needs tools or more work, say so in one line and suggest asking in the main chat.',
  'Plain text, a few sentences at most unless the question needs a list.',
].join(' ');

export class BtwError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/**
 * Answer a side question. Returns { answer, usage }.
 * @param {object} o
 * @param {string} o.question
 * @param {string} [o.sessionId]  the conversation to use as context
 * @param {object} o.provider     a row from providers.js
 * @param {string} o.model
 * @param {string} [o.apiKey]
 * @param {AbortSignal} [o.signal]
 */
export async function askBtw({ question, sessionId, provider, model, apiKey, signal }) {
  const q = String(question || '').trim();
  if (!q) throw new BtwError('Ask something after /btw, like: /btw what does this error mean?');
  if (q.length > MAX_QUESTION) throw new BtwError(`Keep /btw questions under ${MAX_QUESTION} characters.`);
  if (provider.apiStyle === 'stub') {
    return { answer: '/btw needs a real AI provider. Pick one and add its key in Settings → AI.', usage: null };
  }
  const run = provider.apiStyle === 'anthropic' ? runAnthropic : provider.apiStyle === 'openai' ? runOpenAI : null;
  if (!run) throw new BtwError(`${provider.label} can't answer /btw questions.`);

  const context = sessionId && sessionExists(sessionId)
    ? renderTranscript({ messages: getMessages(sessionId) })
    : '';
  const userText = context
    ? `The conversation so far (most recent at the end):\n\n${context}\n\n---\n\nSide question (/btw): ${q}`
    : `Side question (/btw), with no conversation yet: ${q}`;

  let answer = '';
  let usage = null;
  for await (const ev of run({
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    tools: [],
    model,
    apiKey,
    baseUrl: provider.baseUrl,
    signal,
    maxTokens: 1500,
  })) {
    if (ev.type === 'delta') answer += ev.text;
    else if (ev.type === 'assistant') usage = ev.usage || null;
    else if (ev.type === 'error') throw new BtwError(ev.message, 502);
  }
  answer = answer.trim();
  if (!answer) throw new BtwError('No answer came back. Try again.', 502);
  return { answer, usage };
}
