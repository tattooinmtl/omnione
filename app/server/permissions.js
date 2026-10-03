// Permission layer.
//
// Filesystem and shell tools are the point where a wrong model turn stops
// being a bad answer and starts being a deleted file. Every tool declares a
// permission class in the registry; this decides whether a given call runs,
// is refused, or has to wait for the user.
//
// Session modes:
//   plan         nothing but reads — the agent can look, not touch
//   default      reads run; writes and commands ask
//   acceptEdits  reads and writes run; commands still ask
//   bypass       everything runs (explicitly chosen, never the default)
//   autonomous   the heartbeat: nobody is there to ask, so reads and
//                (checkpointed) writes run, and commands are refused — the
//                agent files a proposal for the user instead
//
// The 'admin' permission class (run_as_admin) sits above every mode: it
// always asks, bypass included, is never remembered for the session, and is
// refused in plan mode and on the heartbeat. Windows' UAC prompt follows.
//
// An approval is a promise the agent loop awaits. The SSE stream carries the
// request to the browser, the browser POSTs a decision, and the promise
// settles. Nothing resolves itself: an unanswered request times out as a
// denial rather than quietly proceeding.

import crypto from 'node:crypto';

export const MODES = ['plan', 'default', 'acceptEdits', 'bypass', 'autonomous'];
export const DEFAULT_MODE = 'default';
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

const modes = new Map();        // sessionId -> mode
const sessionAllows = new Map(); // sessionId -> Set of "allow for the rest of this session" keys
const pending = new Map();      // approvalId -> { resolve, timer, request }

export function getMode(sessionId) {
  return modes.get(sessionId) || DEFAULT_MODE;
}

export function setMode(sessionId, mode) {
  if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}". Valid: ${MODES.join(', ')}`);
  modes.set(sessionId, mode);
  return mode;
}

export function clearSession(sessionId) {
  modes.delete(sessionId);
  sessionAllows.delete(sessionId);
}

/* The key an "allow for this session" decision is remembered under. Keyed by
 * tool plus the significant argument, so approving `bash: npm test` does not
 * also approve `bash: rm -rf /`. */
export function allowKey(toolName, args) {
  const significant = args?.command ?? args?.path ?? args?.file_path ?? '';
  return `${toolName}:${String(significant).slice(0, 200)}`;
}

/* write_file / edit_file on plan.md at the workspace root, and nothing else. */
export function isPlanFileWrite(tool, args) {
  if (tool?.name !== 'write_file' && tool?.name !== 'edit_file') return false;
  const p = String(args?.path ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  return p.toLowerCase() === 'plan.md';
}

/**
 * Decide what to do with a tool call.
 * @returns {{ decision: 'allow'|'deny'|'ask', reason?: string }}
 */
export function checkPermission({ sessionId, tool, args }) {
  const mode = getMode(sessionId);
  const permission = tool.permission || 'read';

  // Administrator rights: one explicit yes per call, whatever the mode.
  if (permission === 'admin') {
    if (mode === 'plan' || mode === 'autonomous') {
      return {
        decision: 'deny',
        reason: mode === 'plan'
          ? `Plan mode: "${tool.name}" needs administrator rights and is not allowed. Describe what you would run instead.`
          : `Autonomous mode: "${tool.name}" needs administrator rights, and nobody is here to approve it. Use propose_task to ask the user instead.`,
      };
    }
    return { decision: 'ask' };
  }

  if (mode === 'bypass') return { decision: 'allow' };

  if (permission === 'read') return { decision: 'allow' };

  if (mode === 'plan') {
    // The plan itself is what plan mode is for: writing plan.md is allowed.
    if (isPlanFileWrite(tool, args)) return { decision: 'allow' };
    return {
      decision: 'deny',
      reason: `Plan mode: "${tool.name}" would ${permission === 'execute' ? 'run a command' : 'modify files'}, which is not allowed. Describe what you would do instead, or ask the user to leave plan mode.`,
    };
  }

  if (mode === 'acceptEdits' && permission === 'write') return { decision: 'allow' };

  // Unattended: an 'ask' would sit unanswered for five minutes and then deny,
  // so decide now. Edits are checkpointed and can be reverted; commands and
  // anything that spends money cannot be taken back.
  if (mode === 'autonomous') {
    if (permission === 'write') return { decision: 'allow' };
    return {
      decision: 'deny',
      reason: `Autonomous mode: "${tool.name}" runs commands or spends credits, and nobody is here to approve it. Use propose_task to ask the user instead.`,
    };
  }

  if (sessionAllows.get(sessionId)?.has(allowKey(tool.name, args))) {
    return { decision: 'allow' };
  }

  return { decision: 'ask' };
}

/**
 * Open an approval request and return { id, promise }. The caller streams the
 * id to the client and awaits the promise.
 */
export function requestApproval({ sessionId, tool, args, preview }) {
  const id = `ap_${crypto.randomBytes(8).toString('hex')}`;
  const request = {
    id,
    sessionId,
    tool: tool.name,
    permission: tool.permission,
    args,
    preview: preview || null,
    createdAt: Date.now(),
  };

  let resolve;
  const promise = new Promise((res) => { resolve = res; });

  // An approval nobody answers must fail closed. Leaving the run parked
  // forever is not safer — it just hides the stall.
  const timer = setTimeout(() => {
    pending.delete(id);
    resolve({ approved: false, reason: 'No answer within 5 minutes — treated as denied.' });
  }, APPROVAL_TIMEOUT_MS);
  timer.unref?.();

  pending.set(id, { resolve, timer, request });
  return { id, request, promise };
}

/**
 * Answer an approval.
 * @param {'once'|'session'|'deny'} decision
 */
export function resolveApproval(id, decision) {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  clearTimeout(entry.timer);

  // An administrator request is approved once at a time, never for the session.
  if (decision === 'session' && entry.request.permission !== 'admin') {
    const { sessionId, tool, args } = entry.request;
    if (!sessionAllows.has(sessionId)) sessionAllows.set(sessionId, new Set());
    sessionAllows.get(sessionId).add(allowKey(tool, args));
  }

  entry.resolve({
    approved: decision === 'once' || decision === 'session',
    reason: decision === 'deny' ? 'The user denied this call.' : undefined,
  });
  return true;
}

export function listPending(sessionId) {
  return Array.from(pending.values())
    .map((e) => e.request)
    .filter((r) => !sessionId || r.sessionId === sessionId);
}

/* Cancel everything outstanding for a session — used when a run is aborted,
 * so a stale prompt does not authorize a call nobody is waiting on. */
export function cancelPending(sessionId) {
  for (const [id, entry] of pending) {
    if (sessionId && entry.request.sessionId !== sessionId) continue;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve({ approved: false, reason: 'The run was cancelled.' });
  }
}
