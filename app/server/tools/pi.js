// Raspberry Pi tools.
//
// A Pi Zero 2 W is not a flash target — it is a Linux box. So these are
// remote-execution tools over SSH rather than anything resembling the board
// flashing path.
//
// Built on the system `ssh` and `scp` through the bash tool rather than an
// SSH library. That keeps key handling, agent forwarding and known_hosts in
// OpenSSH's hands, where the user's existing config already lives, and it
// means an ssh invocation is subject to the same permission gate and
// timeouts as any other command. A library would have needed its own key
// loading, its own host verification and its own prompt for a passphrase —
// three more places to get security wrong.
//
// Password authentication is deliberately unsupported: OpenSSH prompts on a
// TTY that does not exist here, so a password login would hang until the
// timeout. Key-based auth is the only thing that works unattended, and it is
// what a headless Pi should be using anyway.

import { registerTool, executeTool } from '../toolRegistry.js';
import { resolveInWorkspace, toWorkspaceRelative } from '../workspace.js';
import { which } from '../boards/toolchains.js';

const SSH_OPTS = [
  // Fail fast instead of hanging on an unreachable host.
  '-o', 'ConnectTimeout=10',
  // No interactive prompts: there is no terminal to answer them.
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
].join(' ');

function quote(s) {
  return `"${String(s).replace(/"/g, '\\"')}"`;
}

/* A host string like pi@raspberrypi.local. Validated because it lands in a
 * shell command: anything with shell metacharacters is refused rather than
 * escaped, since a hostname has no business containing them. */
function validateHost(host) {
  const h = String(host || '').trim();
  if (!h) return { ok: false, error: 'host is required, e.g. pi@raspberrypi.local' };
  if (!/^[A-Za-z0-9._@-]+$/.test(h)) {
    return { ok: false, error: `Refusing host "${h}": only letters, digits, dot, dash, underscore and @ are allowed.` };
  }
  return { ok: true, host: h };
}

function sh(command, ctx, timeoutMs = 120_000) {
  return executeTool('bash', { command, timeout_ms: timeoutMs }, ctx);
}

function requireSsh() {
  if (which('ssh')) return null;
  return {
    ok: false,
    error: 'The ssh client was not found. On Windows: enable the OpenSSH Client optional feature, or install Git for Windows.',
  };
}

registerTool({
  name: 'pi_run',
  description: 'Run a shell command on a Raspberry Pi over SSH. Key-based authentication only — set up an SSH key first if it asks for a password.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      host: { type: 'string', description: 'user@host, e.g. pi@raspberrypi.local or pi@192.168.1.42.' },
      command: { type: 'string', description: 'The command to run on the Pi.' },
      timeout_ms: { type: 'integer', description: 'How long to wait.', default: 120000 },
    },
    required: ['host', 'command'],
  },
  handler: async ({ host, command, timeout_ms: timeoutMs }, ctx = {}) => {
    const missing = requireSsh();
    if (missing) return missing;
    const v = validateHost(host);
    if (!v.ok) return v;
    if (!command || !String(command).trim()) return { ok: false, error: 'command is required.' };

    const r = await sh(
      `ssh ${SSH_OPTS} ${v.host} ${quote(command)}`,
      ctx,
      Math.min(Number(timeoutMs) || 120_000, 600_000),
    );
    if (!r.ok) return r;

    const { exitCode, stdout, stderr } = r.result;
    return {
      ok: true,
      result: {
        host: v.host,
        command,
        exitCode,
        stdout: (stdout || '').slice(-8000),
        stderr: (stderr || '').slice(-4000),
        ...(exitCode === 255
          ? { hint: 'Exit 255 is an SSH connection failure, not a command failure: wrong host, no route, or key auth was refused. Check with pi_ping.' }
          : {}),
      },
    };
  },
});

registerTool({
  name: 'pi_ping',
  description: 'Check that a Raspberry Pi is reachable over SSH and report what it is — model, OS and kernel.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: { host: { type: 'string', description: 'user@host.' } },
    required: ['host'],
  },
  handler: async ({ host }, ctx = {}) => {
    const missing = requireSsh();
    if (missing) return missing;
    const v = validateHost(host);
    if (!v.ok) return v;

    const probe = 'uname -a; echo ---; cat /proc/device-tree/model 2>/dev/null || echo "unknown model"; echo ---; cat /etc/os-release 2>/dev/null | head -2';
    const r = await sh(`ssh ${SSH_OPTS} ${v.host} ${quote(probe)}`, ctx, 30_000);
    if (!r.ok) return r;

    const { exitCode, stdout, stderr } = r.result;
    if (exitCode !== 0) {
      return {
        ok: true,
        result: {
          host: v.host,
          reachable: false,
          exitCode,
          error: (stderr || '').trim().slice(-1000),
          hint: 'Check the Pi is powered and on the network, that SSH is enabled, and that your key is in ~/.ssh/authorized_keys on the Pi.',
        },
      };
    }
    const [uname = '', model = '', os = ''] = String(stdout || '').split('---');
    return {
      ok: true,
      result: {
        host: v.host,
        reachable: true,
        // The device-tree model is NUL-padded; strip it or it corrupts JSON.
        model: model.replace(/\0/g, '').trim() || null,
        kernel: uname.trim() || null,
        os: os.trim().replace(/\n/g, ' ') || null,
      },
    };
  },
});

registerTool({
  name: 'pi_put',
  description: 'Copy a file from the workspace to a Raspberry Pi over SCP.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      host: { type: 'string' },
      file: { type: 'string', description: 'Local file, relative to the workspace root.' },
      dest: { type: 'string', description: 'Destination path on the Pi, e.g. /home/pi/app.py.' },
    },
    required: ['host', 'file', 'dest'],
  },
  handler: async ({ host, file, dest }, ctx = {}) => {
    const missing = requireSsh();
    if (missing) return missing;
    const v = validateHost(host);
    if (!v.ok) return v;

    let abs;
    try { abs = resolveInWorkspace(file); } catch (e) { return { ok: false, error: e.message }; }

    const r = await sh(`scp ${SSH_OPTS} ${quote(abs)} ${v.host}:${quote(dest)}`, ctx, 300_000);
    if (!r.ok) return r;
    return {
      ok: true,
      result: {
        host: v.host,
        file: toWorkspaceRelative(abs),
        dest,
        success: r.result.exitCode === 0,
        output: `${r.result.stdout || ''}\n${r.result.stderr || ''}`.trim().slice(-2000),
      },
    };
  },
});

registerTool({
  name: 'pi_get',
  description: 'Copy a file from a Raspberry Pi into the workspace over SCP.',
  permission: 'write',
  schema: {
    type: 'object',
    properties: {
      host: { type: 'string' },
      remote: { type: 'string', description: 'Path on the Pi.' },
      dest: { type: 'string', description: 'Where to put it, relative to the workspace root.' },
    },
    required: ['host', 'remote', 'dest'],
  },
  // Declared so the agent loop checkpoints the destination before it is
  // overwritten by whatever comes off the Pi.
  affectedPaths: ({ dest }) => [dest],
  handler: async ({ host, remote, dest }, ctx = {}) => {
    const missing = requireSsh();
    if (missing) return missing;
    const v = validateHost(host);
    if (!v.ok) return v;

    let abs;
    try { abs = resolveInWorkspace(dest); } catch (e) { return { ok: false, error: e.message }; }

    const r = await sh(`scp ${SSH_OPTS} ${v.host}:${quote(remote)} ${quote(abs)}`, ctx, 300_000);
    if (!r.ok) return r;
    return {
      ok: true,
      result: {
        host: v.host,
        remote,
        dest: toWorkspaceRelative(abs),
        success: r.result.exitCode === 0,
        output: `${r.result.stdout || ''}\n${r.result.stderr || ''}`.trim().slice(-2000),
      },
    };
  },
});
