// /update-omnione and "Omi, update yourself": update now instead of at the
// next start.
//
// The check is done here: installed.json (what the installer wrote) against
// the newest manifest.json on the distribution repo, read the same way
// shell/internal/install does (latest commit of main, then that commit's
// manifest). The update itself is not: the server asks the running
// OmniOne.exe (OmniOne.exe --update-now) to do what its tray's "Check for
// updates" does, because only the exe can stop this server, replace the files
// and start it again. There is one updater, and it stays in the exe.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { desktopExe } from './desktop.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');
export const DIST_REPO = 'tattooinmtl/omnione';

// Swappable for tests: where the app is installed, how GitHub is reached and
// how the exe is started.
let appDir = APP_DIR;
let fetchFn = (...a) => fetch(...a);
let spawnFn = spawn;
export function _setForTest({ dir, fetch: f, spawn: s } = {}) {
  if (dir !== undefined) appDir = dir;
  if (f) fetchFn = f;
  if (s) spawnFn = s;
}

/* The installed release, or null when this copy wasn't installed by the
 * installer (a source checkout, npm run dev). The installer puts the app in
 * <home>\app and installed.json in <home>. */
export function installedRelease(dir = appDir) {
  if (path.basename(dir).toLowerCase() !== 'app') return null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'installed.json'), 'utf8'));
    return st?.version ? { version: String(st.version), build: String(st.build || ''), commit: String(st.commit || '') } : null;
  } catch {
    return null;
  }
}

async function get(url, accept) {
  const r = await fetchFn(url, { headers: { 'User-Agent': 'OmniOne', ...(accept ? { Accept: accept } : {}) }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
  return r.text();
}

/* The newest release on the distribution repo. */
export async function latestRelease() {
  let ref = 'main';
  try {
    const sha = (await get(`https://api.github.com/repos/${DIST_REPO}/commits/main`, 'application/vnd.github.sha')).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) ref = sha;
  } catch { /* the raw file on main still works */ }
  let m;
  try {
    m = JSON.parse(await get(`https://raw.githubusercontent.com/${DIST_REPO}/${ref}/manifest.json`));
  } catch (e) {
    throw new Error(`Could not reach GitHub: ${e.message}`);
  }
  if (!m?.version || !m?.build) throw new Error('The release list on GitHub is unreadable.');
  return { version: String(m.version), build: String(m.build), commit: String(m.commit || '') };
}

/* Is there something newer? Same rule as the exe's updater: a different
 * build is an update. canUpdate says whether this copy can update itself. */
export async function checkForUpdate() {
  const installed = installedRelease();
  const exe = desktopExe();
  if (!installed) {
    return { installed: null, latest: null, newer: false, canUpdate: false, message: 'This copy of OmniOne wasn’t installed with the OmniOne installer, so it can’t update itself.' };
  }
  const latest = await latestRelease();
  const newer = latest.build !== installed.build;
  const canUpdate = Boolean(exe);
  let message;
  if (!newer) message = `OmniOne is already up to date (v${installed.version}).`;
  else if (!canUpdate) message = `OmniOne v${latest.version} is available (you have v${installed.version}). Update from the OmniOne app: this window isn’t running in it.`;
  else message = `OmniOne v${latest.version} is available (you have v${installed.version}). Updating restarts OmniOne and stops anything Omi-One is doing.`;
  return { installed, latest, newer, canUpdate, message };
}

/* Ask the running OmniOne.exe to update and restart. It stops this server,
 * so the answer goes out before anything happens. */
export async function startUpdate() {
  const check = await checkForUpdate();
  if (!check.newer) return { started: false, ...check };
  if (!check.canUpdate) throw new Error(check.message);
  const child = spawnFn(desktopExe(), ['--update-now'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on?.('error', () => {});
  child.unref?.();
  return { started: true, ...check, message: `Updating to v${check.latest.version}: OmniOne restarts in a moment.` };
}
