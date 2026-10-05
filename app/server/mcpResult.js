// Turning an MCP tools/call result into what the agent sees.
//
// Text parts become the result text. Pictures come in two ways: as MCP image
// parts (base64), or as a path on disk in the result (the Blender add-on's
// render_image and screenshot_viewport return { path }). Both are saved into
// the workspace under renders/ and handed to the model as pictures, so it can
// look at its own render and fix what's wrong.

import fs from 'node:fs';
import path from 'node:path';
import { getWorkspaceRoot, toWorkspaceRelative } from './workspace.js';
import { imageTypeOf, MAX_IMAGE_BYTES } from './attachments.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_PICTURES = 4;

function rendersDir() {
  const dir = path.join(getWorkspaceRoot(), 'renders');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); }

function saveBuffer(buf, ext, base) {
  let file = path.join(rendersDir(), `${base}-${stamp()}.${ext}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(rendersDir(), `${base}-${stamp()}-${n}.${ext}`);
  fs.writeFileSync(file, buf);
  return file;
}

/* Absolute paths to existing picture files anywhere in a JSON value. */
export function findImagePaths(value, found = new Set()) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/([A-Za-z]:[\\/][^"'<>|\r\n]+?\.(?:png|jpe?g|webp))(?=$|["'\s,)}\]])/gi)) found.add(m[1]);
    if (/^\/[^\0]+\.(png|jpe?g|webp)$/i.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) findImagePaths(v, found);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) findImagePaths(v, found);
  }
  return found;
}

export function convertMcpResult(res, { tool = 'mcp' } = {}) {
  const parts = Array.isArray(res?.content) ? res.content : [];
  const texts = [];
  const images = [];
  const saved = [];
  const base = tool.replace(/[^\w-]+/g, '_').slice(0, 40);

  for (const p of parts) {
    if (p?.type === 'text' && typeof p.text === 'string') texts.push(p.text);
    else if (p?.type === 'image' && p.data && images.length < MAX_PICTURES) {
      const ext = EXT[p.mimeType] || 'png';
      const file = saveBuffer(Buffer.from(p.data, 'base64'), ext, base);
      images.push({ path: file, mediaType: p.mimeType || 'image/png' });
      saved.push(toWorkspaceRelative(file));
    } else if (p?.type === 'resource' && p.resource?.text) texts.push(p.resource.text);
  }
  if (!parts.length && res?.structuredContent) texts.push(JSON.stringify(res.structuredContent));

  // Pictures named by path in the text (renders, screenshots).
  const pathSource = [...texts];
  for (const t of texts) { try { pathSource.push(JSON.parse(t)); } catch { /* plain text */ } }
  // The same file can turn up twice (as JSON text and parsed): one copy each.
  const unique = new Map();
  for (const p of findImagePaths(pathSource)) {
    const key = path.resolve(p).toLowerCase();
    if (!unique.has(key)) unique.set(key, path.resolve(p));
  }
  for (const p of unique.values()) {
    if (images.length >= MAX_PICTURES) break;
    const type = imageTypeOf(p);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!type || !st.isFile() || st.size > MAX_IMAGE_BYTES * 4) continue;
    const ext = path.extname(p).slice(1).toLowerCase();
    const file = saveBuffer(fs.readFileSync(p), ext, base);
    if (st.size <= MAX_IMAGE_BYTES) images.push({ path: file, mediaType: type });
    saved.push(toWorkspaceRelative(file));
  }

  const text = texts.join('\n').trim() || (res?.isError ? 'The tool reported an error.' : 'Done.');
  const result = saved.length ? { output: text, saved, show: 'The pictures are attached: look at them before you answer.' } : text;
  if (res?.isError) return { ok: false, error: text };
  return images.length ? { ok: true, result, images } : { ok: true, result };
}
