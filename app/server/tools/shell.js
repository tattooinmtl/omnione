// Shell tool.
//
// The single most dangerous tool in the harness, and the one that makes
// compiling, flashing, testing and git possible. It is gated by the
// permission layer as `execute`, which means it asks in every mode except
// `bypass`.
//
// Deliberate choices:
// - Runs with cwd inside the workspace, and refuses a cwd outside it.
// - Always has a timeout. A hung build should fail, not park the run.
// - Output is captured and truncated from the middle, keeping the head and
//   tail: a compiler's first errors and its final summary are what matter,
//   and a 50k-line build log would otherwise eat the context window.
// - Background jobs are tracked so a dev server can be started and later
//   read or killed, rather than being orphaned.

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { resolveInWorkspace, getWorkspaceRoot, toWorkspaceRelative } from '../workspace.js';
import { registerTool } from '../toolRegistry.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

/** @type {Map<string, {id, command, proc, stdout, stderr, exitCode, startedAt, endedAt}>} */
const jobs = new Map();

/* On Windows, `shell: true` runs through cmd.exe; elsewhere through sh. The
 * agent writes ordinary shell one-liners, so a shell is the point — this is
 * not the place to try to avoid one. */
function shellFor() {
  return process.platform === 'win32'
    ? { shell: process.env.COMSPEC || 'cmd.exe' }
    : { shell: '/bin/sh' };
}

function truncateMiddle(s, max = MAX_OUTPUT_CHARS) {
  if (s.length <= max) return { text: s, truncated: false };
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return {
    text: `${s.slice(0, head)}\n\n… [${s.length - max} characters omitted] …\n\n${s.slice(-tail)}`,
    truncated: true,
  };
}

/* Kill the whole process tree, not just the shell.
 *
 * `spawn(cmd, { shell })` starts cmd.exe (or sh), which then starts the real
 * command as a child. Killing the shell leaves that child running and holding
 * the stdio pipes open, so 'close' never fires — a timeout would report
 * nothing and the build would keep going. Observed directly: a 700ms timeout
 * on `ping -n 20` took 19 seconds to return, because the kill hit cmd.exe and
 * ping carried on regardless. */
function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') {
    // /T includes descendants, /F is forceful.
    const r = spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5000,
    });
    if (r.status === 0) return;
  } else {
    // Spawned detached, so the child leads its own process group and a
    // negative pid signals the whole group.
    try {
      process.kill(-proc.pid, 'SIGKILL');
      return;
    } catch { /* group already gone; fall through */ }
  }
  try { proc.kill('SIGKILL'); } catch { /* already gone */ }
}

function resolveCwd(cwd) {
  if (!cwd) return getWorkspaceRoot();
  const abs = resolveInWorkspace(cwd); // throws if outside the workspace
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`cwd "${cwd}" is not a directory in the workspace.`);
  }
  return abs;
}

registerTool({
  name: 'bash',
  description: 'Run a shell command in the workspace. Use for builds, tests, git, package managers and board tooling. Returns stdout, stderr and the exit code.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      cwd: { type: 'string', description: 'Working directory relative to the workspace root.', default: '.' },
      timeout_ms: { type: 'integer', description: `Kill the command after this long. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.` },
      background: { type: 'boolean', description: 'Start it and return immediately. Use for dev servers and serial monitors; read it later with bash_output.', default: false },
    },
    required: ['command'],
  },
  handler: async ({ command, cwd, timeout_ms: timeoutMs, background = false }, ctx = {}) => {
    if (!command || typeof command !== 'string') return { ok: false, error: 'command is required' };

    let workingDir;
    try { workingDir = resolveCwd(cwd); } catch (e) { return { ok: false, error: e.message }; }

    const timeout = Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const { shell } = shellFor();

    const proc = spawn(command, {
      cwd: workingDir,
      shell,
      windowsHide: true,
      env: process.env,
      // On POSIX this puts the command in its own process group so killTree
      // can signal the group. On Windows detached would open a console
      // window, and taskkill /T walks the tree anyway.
      detached: process.platform !== 'win32',
    });

    const id = `job_${crypto.randomBytes(6).toString('hex')}`;
    const job = {
      id,
      command,
      cwd: toWorkspaceRelative(workingDir),
      proc,
      stdout: '',
      stderr: '',
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
    };
    jobs.set(id, job);

    proc.stdout.on('data', (c) => { job.stdout = (job.stdout + c.toString('utf8')).slice(-200_000); });
    proc.stderr.on('data', (c) => { job.stderr = (job.stderr + c.toString('utf8')).slice(-200_000); });

    const finished = new Promise((resolve) => {
      proc.on('close', (code) => {
        job.exitCode = code;
        job.endedAt = Date.now();
        resolve(code);
      });
      proc.on('error', (err) => {
        job.stderr += `\n${err.message}`;
        job.exitCode = -1;
        job.endedAt = Date.now();
        resolve(-1);
      });
    });

    if (background) {
      return {
        ok: true,
        result: {
          jobId: id,
          command,
          cwd: job.cwd,
          background: true,
          note: 'Started in the background. Read its output with bash_output, stop it with bash_kill.',
        },
      };
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc);
    }, timeout);

    // Cancelling a run has to stop the command too. Without this, hitting
    // stop during a build left the compiler running with nobody waiting for
    // it — burning CPU and still writing to the workspace.
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      killTree(proc);
    };
    if (ctx.signal) {
      if (ctx.signal.aborted) onAbort();
      else ctx.signal.addEventListener('abort', onAbort, { once: true });
    }

    const code = await finished;
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
    jobs.delete(id);

    if (cancelled) {
      return { ok: false, error: 'Run cancelled — the command was killed.' };
    }

    const out = truncateMiddle(job.stdout);
    const err = truncateMiddle(job.stderr);
    return {
      // A non-zero exit is a result the model must reason about (a failing
      // build, a test suite with failures), not a harness error.
      ok: true,
      result: {
        command,
        cwd: job.cwd,
        exitCode: timedOut ? 'timeout' : code,
        durationMs: job.endedAt - job.startedAt,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        ...(timedOut ? { note: `Killed after ${timeout}ms.` } : {}),
      },
    };
  },
});

registerTool({
  name: 'bash_output',
  description: 'Read the output of a background command started with bash(background: true).',
  permission: 'read',
  schema: {
    type: 'object',
    properties: { job_id: { type: 'string', description: 'The jobId returned by bash.' } },
    required: ['job_id'],
  },
  handler: async ({ job_id: jobId }) => {
    const job = jobs.get(jobId);
    if (!job) return { ok: false, error: `No such job "${jobId}". It may have already been collected.` };
    const out = truncateMiddle(job.stdout);
    const err = truncateMiddle(job.stderr);
    return {
      ok: true,
      result: {
        jobId,
        command: job.command,
        running: job.exitCode === null,
        exitCode: job.exitCode,
        stdout: out.text,
        stderr: err.text,
      },
    };
  },
});

registerTool({
  name: 'bash_kill',
  description: 'Stop a background command started with bash(background: true).',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: { job_id: { type: 'string' } },
    required: ['job_id'],
  },
  handler: async ({ job_id: jobId }) => {
    const job = jobs.get(jobId);
    if (!job) return { ok: false, error: `No such job "${jobId}".` };
    killTree(job.proc);
    jobs.delete(jobId);
    return { ok: true, result: { jobId, killed: true } };
  },
});

export function listJobs() {
  return Array.from(jobs.values()).map((j) => ({
    id: j.id,
    command: j.command,
    cwd: j.cwd,
    running: j.exitCode === null,
    exitCode: j.exitCode,
    startedAt: j.startedAt,
  }));
}

/* Kill everything still running — called on shutdown so a background dev
 * server does not outlive the harness. */
export function killAllJobs() {
  for (const job of jobs.values()) killTree(job.proc);
  jobs.clear();
}

export { killTree };
