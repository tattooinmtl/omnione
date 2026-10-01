// The doctor scan behind the pc_diag tool. Read-only from start to finish:
// it looks at Windows, PATH, installed tools, environment variables, the
// network and OmniOne's own dependencies, and reports findings with a
// suggestion each. Fixing is a separate, accepted step (fixes.js).

import { execFile } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROJECT_ROOT } from './auth.js';
import { resolveReadable } from './pcAccess.js';

function run(cmd, args, { timeout = 15_000, cwd } = {}) {
  // Node won't start .cmd/.bat files directly (npm.cmd, npx.cmd…); cmd.exe
  // runs them. Only our own fixed arguments ever reach this.
  let verbatim = false;
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    args = ['/d', '/s', '/c', `""${cmd}" ${args.join(' ')}"`];
    cmd = 'cmd.exe';
    verbatim = true;
  }
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, windowsVerbatimArguments: verbatim, encoding: 'utf8', timeout, cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const isWin = process.platform === 'win32';
const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
const expand = (s) => String(s).replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);

async function regValue(key, name) {
  const r = await run('reg', ['query', key, '/v', name]);
  if (!r.ok) return null;
  const m = r.stdout.match(new RegExp(`\\s${name}\\s+(REG_\\w+)\\s+(.*)`, 'i'));
  return m ? { type: m[1], value: m[2].trim() } : null;
}

// --- sections ----------------------------------------------------------------

async function system(f) {
  const out = {
    os: `${os.type()} ${os.release()}`, version: os.version?.() || '', arch: os.arch(),
    cpu: `${os.cpus()[0]?.model?.trim() || '?'} × ${os.cpus().length}`,
    memoryGB: { total: +(os.totalmem() / 2 ** 30).toFixed(1), free: +(os.freemem() / 2 ** 30).toFixed(1) },
    uptimeHours: +(os.uptime() / 3600).toFixed(1),
  };
  if (out.memoryGB.free / out.memoryGB.total < 0.1) f.push({ severity: 'warning', area: 'system', message: `Only ${out.memoryGB.free} GB of ${out.memoryGB.total} GB memory is free.`, suggestion: 'Close programs you are not using.' });
  if (isWin) {
    const disks = await run('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress']);
    try {
      const list = [].concat(JSON.parse(disks.stdout || '[]'));
      out.disks = list.map((d) => ({ drive: d.DeviceID, sizeGB: +(d.Size / 2 ** 30).toFixed(0), freeGB: +(d.FreeSpace / 2 ** 30).toFixed(1) }));
      for (const d of out.disks) {
        if (d.sizeGB && d.freeGB / d.sizeGB < 0.1) f.push({ severity: d.freeGB < 5 ? 'problem' : 'warning', area: 'system', message: `Drive ${d.drive} has only ${d.freeGB} GB free of ${d.sizeGB} GB.`, suggestion: 'Free up space: Windows gets slow and updates fail when a drive is nearly full.' });
      }
    } catch { /* disk info is optional */ }
    const pending = (await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'])).ok
      || (await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'])).ok;
    out.rebootPending = pending;
    if (pending) f.push({ severity: 'warning', area: 'system', message: 'Windows is waiting for a restart to finish installing updates.', suggestion: 'Restart the PC when convenient.' });
  }
  return out;
}

async function pathSection(f) {
  const out = { entries: [] };
  let user = null;
  let machine = null;
  if (isWin) {
    user = await regValue('HKCU\\Environment', 'Path');
    machine = await regValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path');
  }
  const sources = machine || user
    ? [['system', machine?.value || ''], ['user', user?.value || '']]
    : [['process', process.env.PATH || '']];
  const seen = new Map();
  for (const [scope, raw] of sources) {
    const parts = raw.split(';');
    parts.forEach((entry, i) => {
      if (!entry.trim()) {
        if (i < parts.length - 1) f.push({ severity: 'info', area: 'path', message: `The ${scope} PATH has an empty entry.`, suggestion: 'Harmless, but can be removed.' });
        return;
      }
      const real = expand(entry.trim());
      const exists = fs.existsSync(real);
      out.entries.push({ scope, entry: entry.trim(), exists });
      const key = norm(real);
      if (seen.has(key)) {
        f.push({ severity: 'info', area: 'path', message: `"${entry.trim()}" is in the PATH twice (${seen.get(key)} and ${scope}).`, suggestion: scope === 'user' ? 'Remove the duplicate from your user PATH.' : 'Remove the duplicate.' });
      } else seen.set(key, scope);
      if (!exists) f.push({ severity: 'warning', area: 'path', message: `${scope} PATH entry "${entry.trim()}" points to a folder that doesn't exist.`, suggestion: scope === 'user' ? 'Remove it from your user PATH (prepare a fix).' : 'Remove it from the system PATH (needs an administrator; OmniOne can only explain how).', fixable: scope === 'user' });
    });
  }
  out.userType = user?.type || null;
  out.length = { system: machine?.value?.length || 0, user: user?.value?.length || 0 };
  if (user && user.value.length > 2047) f.push({ severity: 'problem', area: 'path', message: `Your user PATH is ${user.value.length} characters; past about 2047 Windows tools may cut it off.`, suggestion: 'Remove dead or duplicate entries.' });
  return out;
}

const TOOLS = ['node', 'npm', 'npx', 'git', 'python', 'py', 'pip', 'go', 'cargo', 'rustc', 'java', 'dotnet', 'php', 'ruby', 'gcc', 'cmake', 'docker', 'code'];

async function tools(f) {
  const out = {};
  await Promise.all(TOOLS.map(async (t) => {
    const w = isWin ? await run('where.exe', [t], { timeout: 8000 }) : await run('which', ['-a', t], { timeout: 8000 });
    const all = w.ok ? w.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    if (!all.length) return;
    const entry = { found: all };
    const flag = t === 'go' ? 'version' : t === 'java' ? '-version' : '--version';
    // where.exe also lists extensionless shell scripts (npm, npx); Windows runs the .exe/.cmd.
    const runnable = isWin ? all.find((p) => /\.(exe|cmd|bat)$/i.test(p)) || all[0] : all[0];
    const v = await run(runnable, [flag], { timeout: 8000 });
    entry.version = (v.stdout || v.stderr).split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 120) || null;
    out[t] = entry;
    const exes = all.filter((p) => /\.(exe|cmd|bat)$/i.test(p) || !isWin);
    // One install often puts the same tool in several of its own folders
    // (Git\cmd and Git\mingw64\bin): compare install folders, not bin folders.
    const installDir = (p) => norm(path.dirname(p)).replace(/([\\/](cmd|bin|scripts|usr|mingw64))+$/i, '');
    const dirs = [...new Set(exes.map(installDir))];
    if (dirs.length > 1 && !['py', 'code'].includes(t)) {
      f.push({ severity: 'warning', area: 'tools', message: `${t} is installed ${dirs.length} times; Windows uses ${runnable}.`, suggestion: `If that's not the one you want, change the PATH order or remove the extra copy.` });
    }
  }));
  if (isWin && out.python?.found?.[0]?.toLowerCase().includes('windowsapps')) {
    f.push({ severity: 'warning', area: 'tools', message: '"python" opens the Microsoft Store placeholder, not a real Python.', suggestion: 'Turn off the "python.exe" App execution alias in Windows Settings, or put your Python first in PATH.' });
  }
  return out;
}

const PATHY_VARS = ['JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'GOPATH', 'GOROOT', 'PYTHONHOME', 'NODE_PATH', 'NVM_HOME', 'NVM_SYMLINK', 'CARGO_HOME', 'RUSTUP_HOME', 'MAVEN_HOME', 'GRADLE_HOME', 'VCPKG_ROOT', 'TEMP', 'TMP'];

async function env(f) {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!v || k.toUpperCase() === 'PATH') continue;
    const looksLikePath = PATHY_VARS.includes(k.toUpperCase()) || /^[A-Za-z]:\\[^;]*$/.test(v);
    if (!looksLikePath) continue;
    const exists = fs.existsSync(expand(v));
    out[k] = { value: v, exists };
    if (!exists) f.push({ severity: PATHY_VARS.includes(k.toUpperCase()) ? 'warning' : 'info', area: 'env', message: `${k} points to "${v}", which doesn't exist.`, suggestion: 'Point it at the right folder or remove it (prepare a fix).', fixable: true });
  }
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) if (process.env[k]) out[k] = { value: process.env[k] };
  return out;
}

async function network(f) {
  const out = {};
  const targets = [['OmniOne website', 'omnione.globalwarningnetworks.com'], ['MiniMax', 'api.minimax.io'], ['npm registry', 'registry.npmjs.org']];
  await Promise.all(targets.map(async ([label, host]) => {
    try {
      await dns.lookup(host);
      const ctrl = AbortSignal.timeout(8000);
      const r = await fetch(`https://${host}/`, { method: 'HEAD', signal: ctrl }).catch((e) => ({ error: e }));
      out[label] = r.error ? `DNS ok, but no answer (${r.error.name})` : `reachable (HTTP ${r.status})`;
      if (r.error) f.push({ severity: 'warning', area: 'network', message: `${label} (${host}) doesn't answer.`, suggestion: 'Check the connection, a VPN or firewall.' });
    } catch {
      out[label] = 'DNS lookup failed';
      f.push({ severity: 'problem', area: 'network', message: `Can't look up ${host}.`, suggestion: 'Check the internet connection or DNS settings.' });
    }
  }));
  if (isWin) {
    const p = await run('netsh', ['winhttp', 'show', 'proxy']);
    out.systemProxy = /Direct access/i.test(p.stdout) ? 'none' : p.stdout.trim().split(/\r?\n/).slice(-2).join(' ').trim();
  }
  return out;
}

// Node.js release lines and when they stop getting security fixes.
const NODE_EOL = { 18: '2025-04-30', 20: '2026-04-30', 22: '2027-04-30', 24: '2028-04-30', 26: '2029-04-30' };

async function audit(dir, label, f, { runtimeOnly = false } = {}) {
  if (!fs.existsSync(path.join(dir, 'package-lock.json'))) return { skipped: 'no package-lock.json' };
  // The full path: cmd.exe mis-resolves a quoted batch file found on PATH.
  let npm = 'npm';
  if (isWin) {
    const w = await run('where.exe', ['npm.cmd']);
    npm = w.stdout.split(/\r?\n/).map((x) => x.trim()).find(Boolean);
    if (!npm) return { error: 'npm was not found' };
  }
  const r = await run(npm, ['audit', '--json', ...(runtimeOnly ? ['--omit=dev'] : [])], { cwd: dir, timeout: 90_000 });
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { error: 'npm audit gave no answer (offline?)' }; }
  const counts = j.metadata?.vulnerabilities || {};
  const items = Object.values(j.vulnerabilities || {}).map((v) => ({
    package: v.name, severity: v.severity, direct: v.isDirect,
    fix: v.fixAvailable === true ? 'npm audit fix' : v.fixAvailable && typeof v.fixAvailable === 'object' ? `upgrade ${v.fixAvailable.name} to ${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (major version)' : ''}` : 'no fix yet',
    advisories: (v.via || []).filter((x) => typeof x === 'object').map((x) => x.title).slice(0, 3),
  }));
  const serious = (counts.critical || 0) + (counts.high || 0);
  if (serious) f.push({ severity: 'problem', area: 'security', message: `${label}: ${serious} high or critical known vulnerabilities in its dependencies.`, suggestion: 'Prepare a fix that upgrades the affected packages (see the list), then test.', fixable: true });
  else if (counts.total) f.push({ severity: 'info', area: 'security', message: `${label}: ${counts.total} low or moderate known vulnerabilities in its dependencies.`, suggestion: 'Worth upgrading when convenient.' });
  return { counts, items: items.slice(0, 30) };
}

async function omnione(f) {
  const major = Number(process.versions.node.split('.')[0]);
  const eol = NODE_EOL[major];
  const out = { node: process.version, nodeSupportedUntil: eol || (major % 2 ? 'short-lived release' : 'unknown') };
  const today = new Date().toISOString().slice(0, 10);
  if ((eol && eol < today) || major % 2 === 1) {
    f.push({ severity: 'problem', area: 'security', message: `Node.js ${process.version} no longer gets security fixes${eol ? ` (since ${eol})` : ''}.`, suggestion: 'Install the current LTS from https://nodejs.org (OmniOne keeps working).' });
  }
  // Only what runs on users' PCs: build and test tools (Vite, Vitest) never run as servers there.
  out.dependencies = await audit(PROJECT_ROOT, 'OmniOne', f, { runtimeOnly: true });
  return out;
}

const SECTIONS = { system, path: pathSection, tools, env, network, omnione };

export async function runDiagnostics({ sections, project } = {}) {
  const findings = [];
  const wanted = Array.isArray(sections) && sections.length ? sections.filter((s) => SECTIONS[s]) : Object.keys(SECTIONS);
  const report = {};
  await Promise.all(wanted.map(async (s) => {
    try { report[s] = await SECTIONS[s](findings); } catch (e) { report[s] = { error: e.message }; }
  }));
  if (project) {
    const dir = resolveReadable(project);
    report.project = { path: dir, dependencies: await audit(dir, path.basename(dir), findings) };
  }
  const rank = { problem: 0, warning: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return {
    summary: `${findings.filter((x) => x.severity === 'problem').length} problems, ${findings.filter((x) => x.severity === 'warning').length} warnings, ${findings.filter((x) => x.severity === 'info').length} notes.`,
    findings,
    report,
    next: 'To fix something, prepare it with propose_fix. Nothing changes until the user accepts it.',
  };
}
