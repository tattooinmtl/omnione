// Looking at pictures and videos in the workspace.
//
// view_image hands the picture itself to the model (see the image handling in
// adapters.js). view_video samples frames with ffmpeg and hands those over, the
// way the original Omni harness did (extensions/vision-tools.js there).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { registerTool } from '../toolRegistry.js';
import { resolveInWorkspace, toWorkspaceRelative } from '../workspace.js';
import { imageTypeOf, MAX_IMAGE_BYTES } from '../attachments.js';

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v']);
const MAX_FRAMES = 8;
const FFMPEG_TIMEOUT_MS = 60_000;

registerTool({
  name: 'view_image',
  description: 'Look at a picture in the workspace (png, jpg, gif, webp): a screenshot, a photo the user attached, an image you generated. You receive the picture itself. Up to 5 MB.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Path relative to the workspace root.' } },
    required: ['path'],
  },
  handler: async ({ path: p }) => {
    const abs = resolveInWorkspace(p);
    const mediaType = imageTypeOf(abs);
    if (!mediaType) return { ok: false, error: `${p} isn't a png, jpg, gif or webp picture.` };
    if (!fs.existsSync(abs)) return { ok: false, error: `No such file: ${p}` };
    const { size } = fs.statSync(abs);
    if (size > MAX_IMAGE_BYTES) {
      return { ok: false, error: `${p} is ${size} bytes, over the 5 MB a model accepts. Make a smaller copy first (for example with ffmpeg -vf scale=1600:-1).` };
    }
    return { ok: true, result: { path: toWorkspaceRelative(abs), mediaType, bytes: size }, images: [{ path: abs, mediaType }] };
  },
});

let ffmpegOk = null;
function hasFfmpeg() {
  if (ffmpegOk === null) {
    const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    ffmpegOk = r.status === 0;
  }
  return ffmpegOk;
}

function run(cmd, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let err = '';
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    const timer = setTimeout(() => child.kill(), FFMPEG_TIMEOUT_MS);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, out, err });
    });
  });
}

/* Evenly spaced timestamps that stay clear of the very start and end, where
 * videos are often black. */
export function evenTimestamps(duration, n) {
  if (!(duration > 0)) return [0];
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(n) || 1));
  return Array.from({ length: count }, (_, i) => +((duration * (i + 0.5)) / count).toFixed(2));
}

registerTool({
  name: 'view_video',
  description: `Look at a video in the workspace: samples up to ${MAX_FRAMES} frames evenly across it (or at the times you give) and hands you those pictures. Needs ffmpeg.`,
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the workspace root.' },
      frames: { type: 'integer', description: `How many frames, 1-${MAX_FRAMES}.`, default: 4 },
      times: { type: 'array', items: { type: 'number' }, description: 'Exact seconds to grab instead of spreading them evenly.' },
    },
    required: ['path'],
  },
  handler: async ({ path: p, frames = 4, times }, ctx = {}) => {
    const abs = resolveInWorkspace(p);
    if (!VIDEO_EXTS.has(path.extname(abs).toLowerCase())) return { ok: false, error: `${p} isn't a video file I know (${[...VIDEO_EXTS].join(', ')}).` };
    if (!fs.existsSync(abs)) return { ok: false, error: `No such file: ${p}` };
    if (!hasFfmpeg()) return { ok: false, error: 'ffmpeg is not installed. Install it with: winget install Gyan.FFmpeg' };

    let stamps = Array.isArray(times) && times.length ? times.slice(0, MAX_FRAMES).map(Number).filter((t) => t >= 0) : null;
    let duration = null;
    if (!stamps) {
      const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', abs], ctx.signal).catch(() => null);
      duration = probe ? Number(String(probe.out).trim()) : NaN;
      stamps = evenTimestamps(duration, frames);
    }

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnione-frames-'));
    const images = [];
    for (const [i, t] of stamps.entries()) {
      const out = path.join(dir, `frame-${i + 1}.jpg`);
      const r = await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-i', abs, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '4', out], ctx.signal);
      if (r.code === 0 && fs.existsSync(out)) images.push({ path: out, mediaType: 'image/jpeg', at: t });
    }
    if (!images.length) return { ok: false, error: `ffmpeg couldn't take frames from ${p}.` };
    return {
      ok: true,
      result: { path: toWorkspaceRelative(abs), duration: Number.isFinite(duration) ? duration : undefined, frames: images.map((f, i) => `frame ${i + 1} at ${f.at}s`) },
      images: images.map(({ path: fp, mediaType }) => ({ path: fp, mediaType })),
    };
  },
});
