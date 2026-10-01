// The desktop app's own settings: start with Windows, and the "never as
// administrator" rule.
//
// OmniOne.exe starts the server with OMNIONE_EXE set to its own path. Without
// it (npm run dev, a browser), these features report themselves unavailable.

import { execFile } from 'node:child_process';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'OmniOne';

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 15_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// The registry calls, swappable so tests never touch the real registry.
let registry = {
  async get() {
    const r = await run('reg', ['query', RUN_KEY, '/v', RUN_VALUE]);
    if (r.code !== 0) return null;
    const m = r.stdout.match(new RegExp(`${RUN_VALUE}\\s+REG_SZ\\s+(.+)`));
    return m ? m[1].trim() : null;
  },
  async set(value) {
    const r = await run('reg', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', value, '/f']);
    if (r.code !== 0) throw new Error('Windows refused to save the setting.');
  },
  async remove() {
    const r = await run('reg', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    if (r.code !== 0 && !/unable to find/i.test(r.stderr)) throw new Error('Windows refused to change the setting.');
  },
};
export function _setRegistryForTest(fake) { registry = fake; }

export function desktopExe() {
  return process.platform === 'win32' ? (process.env.OMNIONE_EXE || '') : '';
}

/* The command Windows runs at sign-in: the app, straight to the tray. */
function autostartCommand(exe) {
  return `"${exe}" --background`;
}

export async function getAutostart() {
  const exe = desktopExe();
  if (!exe) return { available: false, enabled: false };
  const current = await registry.get();
  return { available: true, enabled: Boolean(current), points: current || null, upToDate: current === autostartCommand(exe) };
}

export async function setAutostart(enabled) {
  const exe = desktopExe();
  if (!exe) throw new Error('Start with Windows is available in the OmniOne app, not in a browser.');
  if (enabled) await registry.set(autostartCommand(exe));
  else await registry.remove();
  return getAutostart();
}

/* True when this process runs as administrator (high or system integrity). */
export async function isElevated() {
  if (process.platform !== 'win32') return typeof process.getuid === 'function' && process.getuid() === 0;
  const r = await run('whoami', ['/groups']);
  return /S-1-16-12288|S-1-16-16384/.test(r.stdout);
}
