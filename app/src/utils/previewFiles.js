/* What the preview shows, from the project's real files.
 *
 * The page to show: the HTML file in front in the editor, else index.html at
 * the top of the project, else the HTML file closest to the top. Only the
 * stylesheets and scripts that page links to (relative paths) are inlined, so
 * the rest of a real project (a server, tests, board code) never runs in the
 * preview. combineForPreview does the inlining, keyed by the exact href/src
 * the page uses.
 */

import { dirName } from './workspaceApi.js';

const HTML = /\.html?$/i;
const REF_RE = /<(?:link\b[^>]*\bhref|script\b[^>]*\bsrc)\s*=\s*["']([^"']+)["']/gi;

export function pickPreviewPage(filePaths, activePath) {
  if (activePath && HTML.test(activePath) && filePaths.includes(activePath)) return activePath;
  if (filePaths.includes('index.html')) return 'index.html';
  const pages = filePaths.filter((p) => HTML.test(p));
  pages.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  return pages[0] || null;
}

/* Resolve a relative reference from a page in folder `dir`. Returns null for
 * anything that isn't a file in the project (http:, //cdn, data:, #, …). */
export function resolveRef(dir, ref) {
  if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref)) return null;
  const clean = ref.split(/[?#]/)[0];
  const parts = (clean.startsWith('/') ? [] : dir.split('/').filter(Boolean));
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/') || null;
}

/* The references (href/src) in a page that point at project files, as
 * [{ ref, path }]. */
export function pageRefs(pagePath, html) {
  const dir = dirName(pagePath);
  const out = [];
  const seen = new Set();
  let m;
  const re = new RegExp(REF_RE.source, 'gi');
  while ((m = re.exec(html)) !== null) {
    const ref = m[1].trim();
    if (seen.has(ref)) continue;
    seen.add(ref);
    const path = resolveRef(dir, ref);
    if (path && /\.(css|m?js|cjs)$/i.test(path)) out.push({ ref, path });
  }
  return out;
}
