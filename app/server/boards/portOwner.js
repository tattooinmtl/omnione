// Who has a serial port open.
//
// The usual reason a flash or a chip read fails is not the board: another
// program holds the port. Windows will only say "access denied", so this
// answers the next question in one call: is the port free, busy or missing,
// and which process is the likely holder.
//
// Windows has no supported, non-admin way to map an open handle to a port
// (Sysinternals' handle.exe needs elevation, and OmniOne never runs elevated).
// So holders are found the way a person would: a process whose command line
// names the port (esptool --port COM5, arduino-cli monitor -p COM5, a Python
// miniterm) is reported as the holder; known serial programs that don't name
// the port on their command line (the Arduino IDE, PuTTY, a terminal) are
// reported as candidates. OmniOne's own monitor is known exactly.

import { spawnSync } from 'node:child_process';

// Ports OmniOne itself has open right now (board_monitor, board_send).
export const ownOpenPorts = new Map(); // port (upper-case) → what opened it

const SERIAL_APPS = [
  [/^arduino ide\.exe$/i, 'Arduino IDE (its Serial Monitor or an upload holds the port)'],
  [/^serial-monitor(\.exe)?$/i, 'Arduino serial-monitor'],
  [/^arduino-cli(\.exe)?$/i, 'arduino-cli'],
  [/^esptool(\.exe|\.py)?$/i, 'esptool'],
  [/^(putty|kitty)\.exe$/i, 'PuTTY'],
  [/^ttermpro\.exe$/i, 'Tera Term'],
  [/^realterm\.exe$/i, 'RealTerm'],
  [/^coolterm\.exe$/i, 'CoolTerm'],
  [/^(pio|platformio)(\.exe)?$/i, 'PlatformIO'],
  [/^mpremote(\.exe)?$/i, 'mpremote'],
  [/^thonny\.exe$/i, 'Thonny'],
  [/^cura\.exe$/i, 'Cura (it probes serial ports for 3D printers)'],
];
// A Python or Node process counts when its command line is serial work.
const SERIAL_SCRIPT = /esptool|miniterm|serial\.tools|mpremote|platformio|pyserial|serialport|ampy|rshell/i;

const SHELL = /^(bash|sh|zsh|cmd|powershell|pwsh|conhost|wsl|mintty)(\.exe)?$/i;

/* Match processes to a port. processes: [{ pid, ppid, name, path, commandLine }].
 * A command that names the port is usually started by a shell whose own
 * command line names it too (cmd /c "esptool --port COM5"); the process that
 * actually opens the port is the bottom of that chain, so ancestors of
 * another match are dropped, and shells only count when nothing else does. */
export function matchPortHolders(processes, port, { selfPid = -1 } = {}) {
  const p = String(port || '').trim();
  const portRe = /^COM\d+$/i.test(p)
    ? new RegExp(`(^|[^A-Za-z0-9_.-])${p}(?![A-Za-z0-9_.-])`, 'i')
    : new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const holders = [];
  const candidates = [];
  for (const pr of processes || []) {
    if (!pr || pr.pid === selfPid) continue;
    const cmd = String(pr.commandLine || '');
    const name = String(pr.name || '');
    const entry = { pid: pr.pid, name, path: pr.path || null, commandLine: cmd.slice(0, 400) || null };
    if (cmd && portRe.test(cmd)) {
      holders.push({ ...entry, ppid: pr.ppid, why: `its command line names ${p}` });
      continue;
    }
    const app = SERIAL_APPS.find(([re]) => re.test(name));
    if (app) { candidates.push({ ...entry, why: app[1] }); continue; }
    if (/^(python|pythonw|py|node)(\d|\.)*(\.exe)?$/i.test(name) && SERIAL_SCRIPT.test(cmd)) {
      candidates.push({ ...entry, why: 'a script doing serial work' });
    }
  }
  const byPid = new Map((processes || []).map((x) => [x.pid, x]));
  const matched = new Set(holders.map((h) => h.pid));
  const isAncestorOfMatch = new Set();
  for (const h of holders) {
    let cur = byPid.get(h.ppid);
    for (let depth = 0; cur && depth < 32; depth++) {
      if (matched.has(cur.pid)) isAncestorOfMatch.add(cur.pid);
      cur = cur.ppid && cur.ppid !== cur.pid ? byPid.get(cur.ppid) : null;
    }
  }
  const leaves = holders.filter((h) => !isAncestorOfMatch.has(h.pid));
  const real = leaves.filter((h) => !SHELL.test(h.name));
  const shells = leaves.filter((h) => SHELL.test(h.name));
  const strip = ({ ppid, ...h }) => h;
  if (real.length) return { holders: real.map(strip), candidates };
  return {
    holders: [],
    candidates: [...shells.map((h) => ({ ...strip(h), why: `a shell running a command that names ${p}` })), ...candidates],
  };
}

/* Every process with its command line (Windows: CIM; elsewhere: ps). */
export function listProcesses() {
  if (process.platform === 'win32') {
    const ps = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress';
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error((r.stderr || 'could not list processes').trim().slice(0, 300));
    const rows = JSON.parse(r.stdout || '[]');
    return [].concat(rows).map((x) => ({ pid: x.ProcessId, ppid: x.ParentProcessId, name: x.Name, path: x.ExecutablePath, commandLine: x.CommandLine }));
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 15000 });
  return String(r.stdout || '').split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), name: m[3], path: null, commandLine: m[4] } : null;
  }).filter(Boolean);
}

/* On Linux and macOS the kernel knows exactly who has a device open. */
function exactHoldersUnix(port) {
  for (const [cmd, args] of [['lsof', ['-t', port]], ['fuser', [port]]]) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 });
    if (r.error) continue;
    const pids = `${r.stdout || ''} ${r.stderr || ''}`.match(/\d+/g);
    return pids ? [...new Set(pids.map(Number))] : [];
  }
  return null;
}

/* free | busy | missing, by trying to open it (and closing it at once). */
export async function portState(port) {
  let SerialPort;
  try { ({ SerialPort } = await import('serialport')); } catch (e) {
    return { state: 'unknown', error: `serialport is unavailable: ${e.message}` };
  }
  return new Promise((resolve) => {
    let sp;
    const done = (state, error) => resolve(error ? { state, error } : { state });
    try {
      sp = new SerialPort({ path: port, baudRate: 115200, autoOpen: false, hupcl: false });
    } catch (e) { return done('missing', e.message); }
    sp.open((err) => {
      if (!err) { sp.close(() => done('free')); return; }
      const m = err.message || String(err);
      if (/access denied|busy|in use|EBUSY|EACCES|lock/i.test(m)) done('busy', m);
      else if (/not found|cannot find|ENOENT|No such file|File not found/i.test(m)) done('missing', m);
      else done('busy', m);
    });
  });
}

export async function whoHoldsPort(port) {
  const key = String(port).toUpperCase();
  const own = ownOpenPorts.get(key);
  const { state, error } = own ? { state: 'busy' } : await portState(port);
  const out = { port, state, ...(error ? { detail: error } : {}), holders: [], candidates: [] };
  if (own) {
    out.holders.push({ pid: process.pid, name: 'OmniOne', path: process.execPath, why: `OmniOne itself (${own}); it lets go when that finishes` });
    return out;
  }
  if (state !== 'busy') return out;

  if (process.platform !== 'win32') {
    const pids = exactHoldersUnix(port);
    if (pids) {
      const procs = listProcesses();
      out.holders = pids.map((pid) => {
        const pr = procs.find((x) => x.pid === pid) || { pid };
        return { pid, name: pr.name || null, path: pr.path || null, commandLine: pr.commandLine || null, why: 'the kernel reports it has the device open' };
      });
      return out;
    }
  }
  try {
    const { holders, candidates } = matchPortHolders(listProcesses(), port, { selfPid: process.pid });
    out.holders = holders;
    out.candidates = candidates;
  } catch (e) {
    out.error = `Could not list processes: ${e.message}`;
  }
  if (!out.holders.length) {
    out.note = out.candidates.length
      ? 'No process names the port on its command line; the candidates are programs that hold serial ports without saying which. Closing the right one frees it.'
      : 'Busy, but no known serial program is running. Another app (a slicer, a phone sync tool, a stuck esptool) may hold it; unplugging and replugging the board always frees it.';
  }
  return out;
}
