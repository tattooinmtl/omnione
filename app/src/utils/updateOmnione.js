/* /update-omnione and "Omi, update yourself", for every chat box and the
 * Presence widget: ask the server whether a newer build is out
 * (server/selfUpdate.js), then, once the user said yes, have OmniOne.exe
 * update and restart. */

async function call(method) {
  const r = await fetch('/api/app/update', { method, headers: { 'Content-Type': 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `status ${r.status}`);
  return j;
}

/* { installed, latest, newer, canUpdate, message } */
export const checkUpdate = () => call('GET');

/* { started, message }. OmniOne restarts right after, so nothing after this
 * call should count on the server still being there. */
export const startUpdate = () => call('POST');

/* Said to Omi-One (after the wake word, or with the Presence page's mic):
 * is it the update command rather than a question? "update OmniOne",
 * "update yourself", "check for updates". Dictation writes the name a few
 * ways (Omni One, Omni 1, OmniOne, Omi). */
const UPDATE_RE = /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:update|upgrade)\s+(?:yourself|(?:the\s+)?(?:app|omn?i[\s-]*(?:one|1|won)?))(?:\s+(?:now|please))*$|^(?:please\s+)?check\s+for\s+(?:an?\s+)?updates?(?:\s+(?:now|please))*$/i;
export function isUpdateRequest(text) {
  return UPDATE_RE.test(String(text || '').trim().replace(/[.,!?]+$/g, '').replace(/\s+/g, ' '));
}

/* A spoken answer to "Update now?": 'yes', 'no', or null when it's neither
 * (then it's an ordinary question and the update stays on hold). */
export function spokenAnswer(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.,!?]+$/g, '');
  if (/^(yes|yeah|yep|sure|ok(ay)?|do it|go( ahead)?|update( now)?|restart( now)?)\b/.test(t)) return 'yes';
  if (/^(no|nope|not now|cancel|stop|later|don'?t|wait)\b/.test(t)) return 'no';
  return null;
}
