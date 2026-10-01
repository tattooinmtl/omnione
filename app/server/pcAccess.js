// Whole-PC access rules.
//
// Omi-One may READ anywhere on the PC, so a doctor scan can follow a problem
// wherever it leads, with one exception: secrets. Whatever it reads is sent
// to the AI provider, so passwords, keys, tokens, browser logins and the like
// are never read, listed as readable, or searched.
//
// It never CHANGES anything outside its own folder by itself. Changes
// elsewhere are fixes it prepares and you accept (fixes.js), and even those
// can't touch Windows' own files: those paths are refused here, and Windows
// refuses them too because OmniOne never runs as administrator.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const lower = (s) => String(s).toLowerCase().replace(/\//g, '\\');

/* Folders whose contents are secrets, matched anywhere in a path. */
const SECRET_DIRS = [
  '\\windows\\system32\\config\\',            // SAM, SECURITY, SYSTEM hives
  '\\appdata\\roaming\\microsoft\\credentials\\',
  '\\appdata\\local\\microsoft\\credentials\\',
  '\\appdata\\roaming\\microsoft\\protect\\',
  '\\appdata\\roaming\\microsoft\\vault\\',
  '\\appdata\\local\\microsoft\\vault\\',
  '\\appdata\\local\\google\\chrome\\user data\\',
  '\\appdata\\local\\microsoft\\edge\\user data\\',
  '\\appdata\\local\\bravesoftware\\',
  '\\appdata\\roaming\\mozilla\\firefox\\profiles\\',
  '\\appdata\\roaming\\opera software\\',
  '\\appdata\\roaming\\coreftp\\',
  '\\appdata\\roaming\\filezilla\\',
  '\\appdata\\roaming\\smartftp\\',
  '\\appdata\\roaming\\github cli\\',
  '\\.ssh\\', '\\.aws\\', '\\.azure\\', '\\.gnupg\\', '\\.kube\\', '\\.docker\\',
  '\\_private\\', '\\secure\\', '\\secrets\\',
];

/* File names that are secrets wherever they are. */
const SECRET_FILES = [
  /^\.env(\..+)?$/,
  /\.(pem|key|pfx|p12|kdbx|keystore|jks|ppk|ovpn)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^(\.npmrc|\.yarnrc|\.pypirc|\.netrc|_netrc|\.git-credentials|credentials|credentials\.json|wp-config\.php)$/,
  /^\.gwn-(secrets\.json|token|cloud\.json)$/,
  /(api[_-]?key|secret|passw(or)?d)/,
  /^(pagefile|hiberfil|swapfile)\.sys$/,
];

export function isSecretPath(abs) {
  const p = lower(abs);
  const asDir = p.endsWith('\\') ? p : p + '\\';
  if (SECRET_DIRS.some((d) => asDir.includes(d))) return true;
  const name = path.basename(p);
  return SECRET_FILES.some((re) => re.test(name));
}

/* Windows' own files and other people's: never changed, even by an accepted fix. */
export function isProtectedSystemPath(abs) {
  const p = lower(path.resolve(abs));
  const env = process.env;
  const sysDrive = lower(env.SystemDrive || 'C:');
  const roots = [
    env.SystemRoot || `${sysDrive}\\Windows`,
    env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432,
    env.ProgramData && path.join(env.ProgramData, 'Microsoft'),
    `${sysDrive}\\System Volume Information`, `${sysDrive}\\$Recycle.Bin`,
    `${sysDrive}\\Recovery`, `${sysDrive}\\Boot`, `${sysDrive}\\EFI`,
  ].filter(Boolean).map(lower);
  if (roots.some((r) => p === r || p.startsWith(r + '\\'))) return true;
  if (/^[a-z]:\\(bootmgr|bootnxt|pagefile\.sys|hiberfil\.sys|swapfile\.sys|dumpstack\.log(\.tmp)?)$/.test(p)) return true;
  // Other people's profiles.
  const users = lower(path.join(sysDrive + '\\', 'Users'));
  if (p.startsWith(users + '\\')) {
    const who = p.slice(users.length + 1).split('\\')[0];
    const me = lower(os.userInfo().username);
    if (who && who !== me && who !== 'public') return true;
  }
  return false;
}

export class AccessError extends Error {
  constructor(message) { super(message); this.name = 'AccessError'; }
}

/* An absolute, real path that may be read, or an AccessError. Follows
 * junctions and links first, so a link can't lead into a secret. */
export function resolveReadable(input) {
  if (!input || typeof input !== 'string') throw new AccessError('A full path is required, like C:\\Users\\you\\project.');
  const expanded = input.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m).replace(/^~(?=$|[\\/])/, os.homedir());
  if (!path.isAbsolute(expanded)) throw new AccessError(`Use a full path (got "${input}"). For files in Omi-One's folder, use read_file.`);
  const asGiven = path.resolve(expanded);
  let abs = asGiven;
  try { abs = fs.realpathSync.native(asGiven); } catch { /* doesn't exist: checked by the caller */ }
  if (isSecretPath(asGiven) || isSecretPath(abs)) throw new AccessError(`${abs} holds secrets (passwords, keys or logins). Omi-One never reads those: anything it reads is sent to the AI provider.`);
  return abs;
}

/* A path a fix may change, or an AccessError. */
export function resolveChangeable(input) {
  const abs = resolveReadable(input);
  if (isProtectedSystemPath(abs)) throw new AccessError(`${abs} belongs to Windows or another user. OmniOne never changes it.`);
  return abs;
}
