// The Node.js OmniOne needs: Vite 8 builds the screens only on Node ^20.19
// or >=22.12 (package.json "engines"). OmniOne.exe checks the same rule at
// start (shell/node.go) and the installer (distribution/install.ps1) before
// installing; keep the three in step.
//
// Run directly (npm's "prebuild"), it stops a build on an older Node with a
// message a person can act on, instead of Vite's own failure.

import { fileURLToPath } from 'node:url';

/* Is this Node version (like "v22.11.0") new enough? */
export function nodeSupported(version) {
  const m = String(version || '').trim().match(/^v?(\d+)\.(\d+)/);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major > 22;
}

export function nodeMessage(version) {
  return `OmniOne needs Node.js 20.19 or newer (22.12 or newer on Node 22); you have ${version}. Install the LTS from https://nodejs.org, then try again.`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!nodeSupported(process.version)) {
    console.error(nodeMessage(process.version));
    process.exit(1);
  }
}
