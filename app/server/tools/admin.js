// run_as_admin: the one way Omi-One gets administrator rights, and only by
// asking.
//
// OmniOne itself never runs elevated, and nothing here changes that. A
// command that truly needs admin (a system-wide install, a driver, a
// Program Files change, a service) is run through Windows' own UAC prompt,
// after two separate yeses from the user:
//
//   1. OmniOne's approval window, in its own "administrator" style: the
//      command, the folder, and Omi-One's reason in plain words. This tool's
//      permission class is 'admin', which permissions.js always asks about —
//      in every mode, bypass included — never remembers for the session, and
//      refuses outright in plan mode and on the heartbeat.
//   2. Windows' UAC prompt, which OmniOne cannot answer or skip.
//
// The command runs in a hidden elevated cmd.exe; its output and exit code
// come back through files in a fresh temp folder, then the folder is removed.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTool } from '../toolRegistry.js';
import { getWorkspaceRoot } from '../workspace.js';

const MAX_TIMEOUT_MS = 30 * 60 * 1000;

/* The elevated batch file: cd, run, capture output and exit code. */
export function adminScript({ command, cwd, outFile, codeFile }) {
  return [
    '@echo off',
    'chcp 65001 >nul',
    `cd /d "${cwd}"`,
    `call :run > "${outFile}" 2>&1`,
    // Redirect first: "echo 0> file" would redirect stream 0 and write nothing.
    `> "${codeFile}" echo %ERRORLEVEL%`,
    'exit /b 0',
    ':run',
    command,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/* PowerShell that asks Windows to run the batch file elevated, and waits. */
export function elevateCommand(batPath) {
  const p = batPath.replace(/'/g, "''");
  return `$ErrorActionPreference='Stop'; try { Start-Process -FilePath '${p}' -Verb RunAs -WindowStyle Hidden -Wait } catch { Write-Output ('UAC: ' + $_.Exception.Message); exit 5 }`;
}

function runElevated({ command, cwd, timeoutMs, signal }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnione-admin-'));
  const outFile = path.join(dir, 'out.txt');
  const codeFile = path.join(dir, 'code.txt');
  const bat = path.join(dir, 'run.cmd');
  fs.writeFileSync(bat, adminScript({ command, cwd, outFile, codeFile }), 'utf8');
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still in use */ } };

  return new Promise((resolve) => {
    const child = execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', elevateCommand(bat)],
      { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', signal },
      (err, stdout) => {
        const said = String(stdout || '').trim();
        if (/^UAC:/m.test(said)) {
          cleanup();
          const declined = /cancel/i.test(said);
          return resolve({
            ok: false,
            error: declined
              ? 'The user said no at the Windows administrator (UAC) prompt. Nothing ran.'
              : `Windows did not start it as administrator: ${said.replace(/^UAC:\s*/, '')}`,
          });
        }
        if (err && (err.killed || err.name === 'AbortError')) {
          // An elevated process can't be stopped from here; say so.
          cleanup();
          return resolve({
            ok: false,
            error: err.name === 'AbortError'
              ? 'Cancelled while waiting. If Windows already started it as administrator, it may still be running.'
              : `No result within ${Math.round(timeoutMs / 60000)} minutes. The elevated command may still be running.`,
          });
        }
        let output = '';
        let exitCode = null;
        try { output = fs.readFileSync(outFile, 'utf8'); } catch { /* nothing printed */ }
        try { exitCode = Number(fs.readFileSync(codeFile, 'utf8').trim()); } catch { /* never reached the end */ }
        cleanup();
        resolve({
          ok: true,
          result: {
            elevated: true,
            exitCode,
            success: exitCode === 0,
            output: output.length > 12000 ? `…${output.slice(-12000)}` : output,
          },
        });
      });
    child.on?.('error', () => { /* reported through the callback */ });
  });
}

registerTool({
  name: 'run_as_admin',
  description: [
    'Run one command with administrator rights on Windows, after asking the user.',
    'Only for work that cannot be done without admin: a system-wide install, a driver, changes under Program Files or Windows, a service, firewall or registry machine settings.',
    'Try the no-admin way first (pip install --user, a per-user installer, a folder in the workspace).',
    'The user sees a red administrator window with your reason, then Windows\' own UAC prompt; both must say yes.',
    'Never use it to get around a denial, and never ask again for the same thing after a no.',
  ].join(' '),
  permission: 'admin',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The exact command, as for cmd.exe.' },
      reason: { type: 'string', description: 'Why it needs administrator rights, in one or two plain sentences for the user (what fails without it, and what it will change).' },
      cwd: { type: 'string', description: 'Folder to run in (absolute). Default: the workspace root.' },
      timeout_ms: { type: 'integer', description: 'Give up waiting after this long. Default 10 minutes, at most 30.' },
    },
    required: ['command', 'reason'],
  },
  handler: async ({ command, reason, cwd, timeout_ms: timeoutMs }, ctx = {}) => {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Administrator requests are only available on Windows. Ask the user to run it with sudo themselves.' };
    }
    const cmd = String(command || '').trim();
    if (!cmd) return { ok: false, error: 'command is required.' };
    if (/[\r\n]/.test(cmd)) return { ok: false, error: 'One command per request: no line breaks. Chain with && if they belong together.' };
    if (String(reason || '').trim().length < 10) {
      return { ok: false, error: 'Say why it needs administrator rights (reason), so the user can decide.' };
    }
    let dir = cwd ? String(cwd) : getWorkspaceRoot();
    if (!path.isAbsolute(dir)) dir = path.resolve(getWorkspaceRoot(), dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: false, error: `No such folder: ${dir}` };
    const limit = Math.min(Math.max(Number(timeoutMs) || 10 * 60 * 1000, 10_000), MAX_TIMEOUT_MS);
    return runElevated({ command: cmd, cwd: dir, timeoutMs: limit, signal: ctx.signal });
  },
});
