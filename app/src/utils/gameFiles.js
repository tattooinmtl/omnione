// Multi-file project support for the OmniOne agent harness.
//
// PORTED VERBATIM from GameForgerAI/client/src/utils/gameFiles.js (read-only
// reference, not modified). The AI emits either a single self-contained HTML
// file OR a small project with separate index.html / style.css / main.js / etc.
// Each file is marked with a `<!-- FILE: name -->` header before the code.
//
// Three exports used by the app:
//   parseFiles(raw)        — raw model output -> { name: content } map
//   combineForPreview(map) — file map -> single srcdoc HTML for the preview
//   serializeFiles(map)    — file map -> prompt-shaped string (for modify)
//   languageFor(name)      — file name -> Monaco language id

// `<!-- FILE: index.html -->` (line-anchored so the marker never matches inside
// a code sample or a doc comment that mentions the syntax)
export const FILE_MARKER_RE = /^\s*<!--\s*FILE:\s*([^\s>]+)\s*-->\s*$/gim;

const DEFAULT_FILENAME = 'index.html';
const KNOWN_JS_FILES = /\.(js|mjs|cjs)$/i;
const KNOWN_CSS_FILE = /\.css$/i;
const KNOWN_HTML_FILE = /\.html?$/i;

/**
 * Some models dump planning prose into `content` before the real game. That
 * prose used to be saved as index.html, so the preview iframe showed a wall of
 * "OK now I need to draw the tiles…" with the canvas stuck in the corner.
 * Pull the actual HTML (or FILE-marked project) out of that dump.
 */
export function extractPlayableSource(raw) {
  let text = String(raw || '');
  if (!text.trim()) return '';
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');

  const fileIdx = text.search(/<!--\s*FILE:/i);
  if (fileIdx >= 0) return text.slice(fileIdx).trim();

  const lower = text.toLowerCase();
  const dt = lower.lastIndexOf('<!doctype html');
  const ht = lower.lastIndexOf('<html');
  let start = -1;
  if (dt >= 0 && ht >= 0) start = Math.min(dt, ht);
  else start = dt >= 0 ? dt : ht;
  if (start < 0) return stripCodeFence(text);

  let doc = text.slice(start).trim();
  doc = stripCodeFence(doc);
  doc = doc.replace(
    /(<body[^>]*>)([\s\S]*?)(?=<(?:canvas|div|script|style|section|main|header|nav|svg|table|img|video|pre|h[1-6]))/i,
    (all, body, lead) => {
      if (!lead.trim()) return all;
      if (/<[a-z]/i.test(lead)) return all;
      if (lead.trim().length < 80) return all;
      return body;
    },
  );
  return doc.trim();
}

/** Parse the AI's raw stream output into a { filename: content } map. */
export function parseFiles(raw) {
  const text = extractPlayableSource(raw);
  if (!text.trim()) return {};

  // Fast path: no markers -> one file. Strip fenced wrappers so single-file
  // output is presentable without a broken code fence at the top.
  if (!/<!--\s*FILE:/i.test(text)) {
    return { [DEFAULT_FILENAME]: stripCodeFence(text) };
  }

  const re = new RegExp(FILE_MARKER_RE.source, 'gim');
  const files = {};
  const markers = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    markers.push({ name: sanitiseFilename(m[1]), start: m.index, end: m.index + m[0].length });
  }

  for (let i = 0; i < markers.length; i++) {
    const { name, end } = markers[i];
    const nextStart = i + 1 < markers.length ? markers[i + 1].start : text.length;
    let body = text.slice(end, nextStart);

    body = body.replace(/<!--\s*END FILE\s*-->\s*$/i, '');
    body = stripCodeFence(body).trim();

    if (body) files[name] = body;
  }

  if (Object.keys(files).length === 0) {
    return { [DEFAULT_FILENAME]: stripCodeFence(text) };
  }
  return files;
}

/**
 * Combine a { filename: content } map into a single srcdoc HTML for the preview
 * iframe. Inlines CSS into <head> (or replaces <link rel="stylesheet"> tags)
 * and JS into <body> (or replaces <script src> tags).
 */
export function combineForPreview(files) {
  if (!files || typeof files !== 'object') return '';
  const names = Object.keys(files);
  if (names.length === 0) return '';

  const htmlName = names.includes(DEFAULT_FILENAME)
    ? DEFAULT_FILENAME
    : names.find((n) => KNOWN_HTML_FILE.test(n)) || null;

  const cssFiles = names.filter((n) => KNOWN_CSS_FILE.test(n));
  const jsFiles = names.filter((n) => KNOWN_JS_FILES.test(n));

  if (!htmlName) {
    const styleBlock = cssFiles.map((n) => `<style data-src="${escapeAttr(n)}">${files[n]}</style>`).join('\n');
    const scriptBlock = jsFiles.map((n) => `<script data-src="${escapeAttr(n)}">${files[n]}</script>`).join('\n');
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8">${styleBlock}</head>
<body>${scriptBlock}</body></html>`;
  }

  let html = files[htmlName];

  for (const cssName of cssFiles) {
    const linkRe = new RegExp(
      `<link[^>]*href=["']${escapeRegex(cssName)}["'][^>]*>`,
      'gi',
    );
    if (linkRe.test(html)) {
      html = html.replace(linkRe, `<style data-src="${escapeAttr(cssName)}">\n${files[cssName]}\n</style>`);
    } else if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, `<style data-src="${escapeAttr(cssName)}">\n${files[cssName]}\n</style>\n</head>`);
    } else {
      html = `<style data-src="${escapeAttr(cssName)}">\n${files[cssName]}\n</style>\n` + html;
    }
  }

  for (const jsName of jsFiles) {
    // Detect module syntax so the injected <script> tag gets type="module".
    // Without it, `import` statements throw "Cannot use import statement outside a module".
    const isModule = /\b(import\s|import\s*\(|import\s*\{|export\s|export\s\{|export\s+default)/m.test(files[jsName] || '');
    const scriptTag = (body) => `<script type="${isModule ? 'module' : 'text/javascript'}" data-src="${escapeAttr(jsName)}">\n${body}\n</script>`;
    const srcRe = new RegExp(
      `<script[^>]*src=["']${escapeRegex(jsName)}["'][^>]*>\\s*</script>`,
      'gi',
    );
    if (srcRe.test(html)) {
      html = html.replace(srcRe, scriptTag(files[jsName]));
    } else if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, scriptTag(files[jsName]) + '\n</body>');
    } else {
      html = html + '\n' + scriptTag(files[jsName]);
    }
  }

  // If any inline JS uses bare-specifier imports (e.g. `import * as THREE from 'three'`),
  // add the standard importmap so the iframe resolves them.
  if (/\bimport\s+[^;]+from\s+['"]three['"]/m.test(html) && !/type=["']importmap["']/.test(html)) {
    const importmap = `<script type="importmap">{"imports":{"three":"https://unpkg.com/three@0.169.0/build/three.module.js"}}</script>`;
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + importmap);
    else html = importmap + html;
  }

  // Inject runtime-error forwarder so the parent can catch iframe crashes
  try {
    const ERROR_FORWARDER = `<script data-gwn-preview="error-forwarder">
(function(){
  function post(level, info) {
    try {
      parent.postMessage({
        __gwnPreview: true,
        type: 'runtime-error',
        level: level,
        message: String(info && (info.message || info) || ''),
        source: (info && info.source) || '',
        lineno: (info && info.lineno) || 0,
        stack: (info && info.stack) || ((info && info.error && info.error.stack) || null),
      }, '*');
    } catch (e) { /* parent gone */ }
  }
  window.addEventListener('error', function (e) { post('error', e); });
  window.addEventListener('unhandledrejection', function (e) {
    var reason = e && e.reason;
    post('unhandledrejection', {
      message: reason && (reason.message || reason) || String(reason || ''),
      stack: reason && reason.stack || null,
    });
  });
  var raf = window.requestAnimationFrame;
  if (typeof raf === 'function') {
    window.requestAnimationFrame = function (cb) {
      return raf.call(window, function (t) {
        try { return cb(t); } catch (err) { post('error', err); }
      });
    };
  }
})();
</script>`;
    const FIT_CSS = `<style data-gwn-preview="fit">
html,body{width:100%!important;height:100%!important;margin:0!important;overflow:hidden!important;background:#111!important}
body{display:flex!important;align-items:center!important;justify-content:center!important;flex-direction:column!important}
canvas{max-width:100%!important;max-height:100%!important;width:auto!important;height:auto!important;object-fit:contain}
</style>`;
    if (!html.includes('data-gwn-preview="error-forwarder"')) {
      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head[^>]*>/i, (m) => m + ERROR_FORWARDER + FIT_CSS);
      } else if (/<body[^>]*>/i.test(html)) {
        html = html.replace(/<body[^>]*>/i, (m) => ERROR_FORWARDER + FIT_CSS + m);
      } else {
        html = ERROR_FORWARDER + FIT_CSS + html;
      }
    }
  } catch (_) { /* preview hardening is best-effort */ }

  return html;
}

/** Serialize the file map back to a single string for the modify prompt. */
export function serializeFiles(files) {
  const names = Object.keys(files || {});
  if (names.length === 0) return '';
  if (names.length === 1 && names[0] === DEFAULT_FILENAME) return files[names[0]] || '';
  return names.map((n) => `<!-- FILE: ${n} -->\n${files[n] || ''}`).join('\n\n');
}

/** Total character count across every file — for the context meter. */
export function totalChars(files) {
  if (!files) return 0;
  let n = 0;
  for (const k in files) n += (files[k] || '').length;
  return n;
}

/** Map a filename to a Monaco language id. */
export function languageFor(filename) {
  if (KNOWN_CSS_FILE.test(filename)) return 'css';
  if (KNOWN_JS_FILES.test(filename)) return 'javascript';
  if (/\.json$/i.test(filename)) return 'json';
  if (/\.(py|python)$/i.test(filename)) return 'python';
  if (/\.glsl$|\.vert$|\.frag$/i.test(filename)) return 'cpp';
  if (/\.md$/i.test(filename)) return 'markdown';
  if (/\.html?$/i.test(filename)) return 'html';
  return 'plaintext';
}

// ---- internals ----

function stripCodeFence(text) {
  const m = /^\s*```(?:html|javascript|js|css|json|python|py|xml|cpp|glsl)?\s*\n([\s\S]*?)```\s*$/i.exec(text);
  return (m ? m[1] : text).trim();
}

function sanitiseFilename(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/^\.?\/+/, '')
    .replace(/\.\.[\/\\]/g, '')
    .slice(0, 80);
  return cleaned || DEFAULT_FILENAME;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;');
}
