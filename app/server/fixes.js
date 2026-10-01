// Fixes: changes outside Omi-One's folder, prepared by Omi-One and held
// until you accept them.
//
// The doctor finds a problem; Omi-One prepares a fix with propose_fix. The
// fix is only a plan, saved in .gwn-fixes/: nothing on the PC changes. You
// read it in Doctor & fixes and press Apply (or Reject). Applying runs the
// steps in order, keeps a backup of everything it changes, and stops at the
// first step that fails. Undo puts files and settings back.
//
// What a fix may do:
//   edit_file    replace one exact piece of text in a file
//   write_file   create or replace a whole file
//   recycle      send a file or folder to the Recycle Bin (never a hard delete)
//   set_env      set or remove one of YOUR environment variables
//   path_add     add a folder to YOUR PATH        path_remove  remove one
//   run_command  run a command (shown in full before you accept)
// Never: anything in Windows' own folders, other users' files, or secrets
// (pcAccess.js), and never as administrator, so Windows refuses those too.

import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './auth.js';
import { resolveChangeable, AccessError } from './pcAccess.js';

let FIXES_DIR = path.join(PROJECT_ROOT, '.gwn-fixes');
export function _setFixesDirForTest(dir) { FIXES_DIR = dir; }

const STEP_KINDS = ['edit_file', 'write_file', 'recycle', 'set_env', 'path_add', 'path_remove', 'run_command'];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
// Windows' own variables: changing these at user level breaks things in confusing ways.
const RESERVED_ENV = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'PATH']);

// --- running things ---------------------------------------------------------------

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 60_000, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 });
    });
  });
}

// The user-environment calls, swappable so tests never touch the real registry.
let userEnv = {
  async get(name) {
    const r = await run('reg', ['query', 'HKCU\\Environment', '/v', name]);
    if (!r.ok) return null;
    const m = r.stdout.match(new RegExp(`^\\s*${name.replace(/[()]/g, '\\$&')}\\s+(REG_\\w+)\\s+(.*)$`, 'im'));
    return m ? { type: m[1], value: m[2].trim() } : { type: 'REG_SZ', value: '' };
  },
  async set(name, value, type = 'REG_EXPAND_SZ') {
    const r = await run('reg', ['add', 'HKCU\\Environment', '/v', name, '/t', type, '/d', value, '/f']);
    if (!r.ok) throw new Error(`Windows refused to set ${name}.`);
    await broadcastEnvChange();
  },
  async remove(name) {
    const r = await run('reg', ['delete', 'HKCU\\Environment', '/v', name, '/f']);
    if (!r.ok && !/unable to find/i.test(r.stderr)) throw new Error(`Windows refused to remove ${name}.`);
    await broadcastEnvChange();
  },
};
export function _setUserEnvForTest(fake) { userEnv = fake; }

/* Tell running programs (Explorer, new terminals) that the environment changed. */
async function broadcastEnvChange() {
  if (process.platform !== 'win32') return;
  const ps = `Add-Type -Namespace W -Name N -MemberDefinition '[DllImport("user32.dll",CharSet=CharSet.Auto)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h,uint m,System.UIntPtr w,string l,uint f,uint t,out System.UIntPtr r);'; $r=[UIntPtr]::Zero; [void][W.N]::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,3000,[ref]$r)`;
  await run('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 15_000 });
}

/* Send to the Recycle Bin, so it can be restored from there. */
let recycleImpl = async (abs) => {
  const isDir = fs.statSync(abs).isDirectory();
  const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${isDir ? 'DeleteDirectory' : 'DeleteFile'}($env:OMNI_RECYCLE,'OnlyErrorDialogs','SendToRecycleBin')`;
  const r = await run('powershell.exe', ['-NoProfile', '-Command', ps], { env: { ...process.env, OMNI_RECYCLE: abs } });
  if (!r.ok || fs.existsSync(abs)) throw new Error(`Could not move ${abs} to the Recycle Bin.`);
};
export function _setRecycleForTest(fn) { recycleImpl = fn; }

function runCommand(command, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh', windowsHide: true });
    let out = '';
    const add = (d) => { out = (out + d).slice(-20_000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, output: out }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, output: e.message }); });
  });
}

// --- storage ------------------------------------------------------------------------

const fixPath = (id) => path.join(FIXES_DIR, `${id}.json`);
function save(fix) {
  fs.mkdirSync(FIXES_DIR, { recursive: true });
  fs.writeFileSync(fixPath(fix.id), JSON.stringify(fix, null, 2));
  return fix;
}
export function getFix(id) {
  if (!/^fix_[a-z0-9]{8,24}$/.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(fixPath(id), 'utf8')); } catch { return null; }
}
export function listFixes() {
  if (!fs.existsSync(FIXES_DIR)) return [];
  return fs.readdirSync(FIXES_DIR).filter((f) => /^fix_.*\.json$/.test(f))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(FIXES_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
export function pendingCount() { return listFixes().filter((f) => f.status === 'pending').length; }

// --- proposing: check everything now, change nothing ------------------------------------

const str = (v, max = 100_000) => (typeof v === 'string' ? v.slice(0, max) : '');

function checkStep(raw, i) {
  const n = `Step ${i + 1}`;
  if (!raw || !STEP_KINDS.includes(raw.kind)) throw new AccessError(`${n}: kind must be one of ${STEP_KINDS.join(', ')}.`);
  const s = { kind: raw.kind, note: str(raw.note, 300) };
  switch (raw.kind) {
    case 'edit_file': {
      s.path = resolveChangeable(raw.path);
      s.old_string = str(raw.old_string); s.new_string = str(raw.new_string);
      if (!s.old_string) throw new AccessError(`${n}: old_string is required.`);
      if (!fs.existsSync(s.path)) throw new AccessError(`${n}: ${s.path} doesn't exist.`);
      const count = fs.readFileSync(s.path, 'utf8').split(s.old_string).length - 1;
      if (count !== 1) throw new AccessError(`${n}: the text to replace appears ${count} times in ${s.path}; it must appear exactly once.`);
      break;
    }
    case 'write_file':
      s.path = resolveChangeable(raw.path); s.content = str(raw.content, 2_000_000);
      s.replaces = fs.existsSync(s.path);
      break;
    case 'recycle':
      s.path = resolveChangeable(raw.path);
      if (!fs.existsSync(s.path)) throw new AccessError(`${n}: ${s.path} doesn't exist.`);
      if (/^[a-z]:\\?$/i.test(s.path)) throw new AccessError(`${n}: a whole drive can't be recycled.`);
      break;
    case 'set_env':
      s.name = str(raw.name, 100);
      if (!ENV_NAME.test(s.name) || RESERVED_ENV.has(s.name.toUpperCase())) throw new AccessError(`${n}: ${s.name || 'that'} can't be changed this way${s.name.toUpperCase() === 'PATH' ? ' (use path_add or path_remove)' : ''}.`);
      s.value = raw.value === null || raw.value === undefined ? null : str(raw.value, 8000);
      break;
    case 'path_add':
    case 'path_remove':
      s.entry = str(raw.entry, 500).trim().replace(/;/g, '');
      if (!s.entry) throw new AccessError(`${n}: entry (a folder) is required.`);
      break;
    case 'run_command':
      s.command = str(raw.command, 4000).trim();
      if (!s.command) throw new AccessError(`${n}: command is required.`);
      s.cwd = raw.cwd ? resolveChangeable(raw.cwd) : PROJECT_ROOT;
      break;
  }
  return s;
}

export function proposeFix({ title, why, steps, findings } = {}) {
  if (!str(title, 200).trim()) throw new AccessError('A fix needs a short title.');
  if (!Array.isArray(steps) || !steps.length || steps.length > 30) throw new AccessError('A fix needs 1 to 30 steps.');
  const checked = steps.map(checkStep);
  return save({
    id: `fix_${crypto.randomBytes(6).toString('hex')}`,
    title: str(title, 200).trim(),
    why: str(why, 4000).trim(),
    findings: Array.isArray(findings) ? findings.map((x) => str(x, 400)).slice(0, 20) : [],
    steps: checked,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
}

// --- applying: only when the user says so ----------------------------------------------

async function pathEntries() {
  const cur = await userEnv.get('Path');
  return { type: cur?.type || 'REG_EXPAND_SZ', list: (cur?.value || '').split(';').filter(Boolean) };
}
const same = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

async function applyStep(s, backupDir, i) {
  const undo = { kind: s.kind };
  switch (s.kind) {
    case 'edit_file':
    case 'write_file': {
      const p = resolveChangeable(s.path); // re-checked at apply time
      if (fs.existsSync(p)) {
        const b = path.join(backupDir, `${i}.bak`);
        fs.copyFileSync(p, b);
        Object.assign(undo, { path: p, backup: b });
      } else Object.assign(undo, { path: p, created: true });
      if (s.kind === 'edit_file') {
        const text = fs.readFileSync(p, 'utf8');
        if (text.split(s.old_string).length - 1 !== 1) throw new Error(`${p} changed since the fix was prepared; the text to replace is no longer there exactly once.`);
        fs.writeFileSync(p, text.replace(s.old_string, () => s.new_string));
      } else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, s.content);
      }
      return { undo, output: `${s.kind === 'edit_file' ? 'Edited' : 'Wrote'} ${p}` };
    }
    case 'recycle': {
      const p = resolveChangeable(s.path);
      await recycleImpl(p);
      return { undo: { kind: 'recycle', path: p, manual: true }, output: `Moved ${p} to the Recycle Bin` };
    }
    case 'set_env': {
      const before = await userEnv.get(s.name);
      if (s.value === null) await userEnv.remove(s.name);
      else await userEnv.set(s.name, s.value, before?.type || 'REG_EXPAND_SZ');
      return { undo: { kind: 'set_env', name: s.name, before: before && before.value !== '' ? before : null }, output: s.value === null ? `Removed ${s.name}` : `Set ${s.name}` };
    }
    case 'path_add':
    case 'path_remove': {
      const { type, list } = await pathEntries();
      const before = list.join(';');
      const next = s.kind === 'path_add'
        ? (list.some((e) => same(e, s.entry)) ? list : [...list, s.entry])
        : list.filter((e) => !same(e, s.entry));
      if (next.length === list.length && s.kind === 'path_remove') return { undo: { kind: 'noop' }, output: `${s.entry} was not in your PATH` };
      await userEnv.set('Path', next.join(';'), type);
      return { undo: { kind: 'set_env', name: 'Path', before: { type, value: before } }, output: `${s.kind === 'path_add' ? 'Added' : 'Removed'} ${s.entry} ${s.kind === 'path_add' ? 'to' : 'from'} your PATH` };
    }
    case 'run_command': {
      const r = await runCommand(s.command, s.cwd);
      if (r.code !== 0) { const e = new Error(`The command exited with code ${r.code}.`); e.output = r.output; throw e; }
      return { undo: { kind: 'run_command', manual: true }, output: r.output.trim().slice(-4000) || '(no output)' };
    }
  }
  throw new Error(`Unknown step ${s.kind}`);
}

export async function applyFix(id) {
  const fix = getFix(id);
  if (!fix) throw new AccessError('No such fix.');
  if (fix.status !== 'pending') throw new AccessError(`This fix is already ${fix.status}.`);
  const backupDir = path.join(FIXES_DIR, 'backups', fix.id);
  fs.mkdirSync(backupDir, { recursive: true });
  fix.status = 'applying';
  fix.results = [];
  save(fix);
  for (let i = 0; i < fix.steps.length; i++) {
    try {
      const { undo, output } = await applyStep(fix.steps[i], backupDir, i);
      fix.results.push({ step: i, ok: true, output, undo });
    } catch (e) {
      fix.results.push({ step: i, ok: false, output: [e.message, e.output].filter(Boolean).join('\n').slice(-4000) });
      fix.status = 'failed';
      fix.finishedAt = new Date().toISOString();
      return save(fix);
    }
  }
  fix.status = 'applied';
  fix.finishedAt = new Date().toISOString();
  return save(fix);
}

export function rejectFix(id) {
  const fix = getFix(id);
  if (!fix) throw new AccessError('No such fix.');
  if (fix.status !== 'pending') throw new AccessError(`This fix is already ${fix.status}.`);
  fix.status = 'rejected';
  fix.finishedAt = new Date().toISOString();
  return save(fix);
}

/* Put back what an applied (or partly applied) fix changed, newest first.
 * Commands and Recycle Bin moves can't be undone automatically; they're listed. */
export async function undoFix(id) {
  const fix = getFix(id);
  if (!fix) throw new AccessError('No such fix.');
  if (!['applied', 'failed'].includes(fix.status)) throw new AccessError('Only an applied fix can be undone.');
  const notes = [];
  for (const r of [...(fix.results || [])].reverse()) {
    const u = r.undo;
    if (!r.ok || !u) continue;
    if ((u.kind === 'edit_file' || u.kind === 'write_file') && u.backup) fs.copyFileSync(u.backup, u.path);
    else if ((u.kind === 'edit_file' || u.kind === 'write_file') && u.created) fs.rmSync(u.path, { force: true });
    else if (u.kind === 'set_env') {
      if (u.before) await userEnv.set(u.name, u.before.value, u.before.type);
      else await userEnv.remove(u.name);
    } else if (u.kind === 'recycle') notes.push(`Restore ${u.path} from the Recycle Bin if you want it back.`);
    else if (u.kind === 'run_command') notes.push(`Step ${r.step + 1} ran a command; its effects can't be undone automatically.`);
  }
  fix.status = 'undone';
  fix.undoneAt = new Date().toISOString();
  fix.undoNotes = notes;
  return save(fix);
}
