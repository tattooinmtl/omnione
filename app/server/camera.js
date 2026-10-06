// The live camera: Omi-One can see what's in front of a camera, one picture
// at a time, only while the user has the camera switched on.
//
// Two kinds of source:
//   - a picture address, e.g. an ESP32 camera's http://192.168.40.13/capture
//     (the Espressif/Freenove CameraWebServer sketch) or any local program
//     that serves a JPEG; MJPEG stream addresses work too (first frame);
//   - a webcam on this PC, captured with ffmpeg (DirectShow).
//
// On/off is kept in memory only: after a restart the camera is off until the
// user turns it on again. The source is remembered in the preferences.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getPrefs, setPrefs } from './prefs.js';
import { getWorkspaceRoot, toWorkspaceRelative } from './workspace.js';
import { publishLive } from './live.js';

const SNAP_TIMEOUT_MS = 8000;
const KEEP_PICTURES = 60;          // older camera pictures are deleted
const MAX_JPEG_BYTES = 8 * 1024 * 1024;

// ESP32 CameraWebServer picture sizes: the framesize numbers of the current
// esp32-camera library (checked on a Freenove WROVER board: 6 → 320×240,
// 8 → 400×296). OV2640 sensors go up to 1600×1200, but a sketch can only go
// as big as the size it started the camera with (it reserves the picture
// memory then): Freenove's sketch starts at FRAMESIZE_QVGA and tops out
// around 400×296. Start it at FRAMESIZE_UXGA to allow every size.
export const ESP32_SIZES = { 6: '320×240', 8: '400×296', 10: '640×480', 11: '800×600', 12: '1024×768', 13: '1280×720', 15: '1600×1200' };

let on = false;
let lastError = null;
let lastShotAt = null;
let sizeReady = Promise.resolve(); // the ESP32 size change, awaited by the next picture

export class CameraError extends Error {}

export function cameraState() {
  const c = getPrefs().camera;
  return { on, ...c, lastError, lastShotAt, configured: isConfigured(c) };
}

function isConfigured(c) {
  return c.source === 'webcam' ? Boolean(c.device) : Boolean(c.url);
}

export function setCamera(patch = {}) {
  const cur = getPrefs().camera;
  const next = { ...cur };
  if (patch.source != null) {
    if (!['url', 'webcam'].includes(patch.source)) throw new CameraError('Source must be "url" or "webcam".');
    next.source = patch.source;
  }
  if (patch.url != null) {
    const u = String(patch.url).trim();
    if (u) {
      let parsed;
      try { parsed = new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`); } catch { throw new CameraError('That address isn\'t valid.'); }
      if (!/^https?:$/.test(parsed.protocol)) throw new CameraError('The address must be http:// or https://.');
      // A bare ESP32 address means its /capture picture.
      if (parsed.pathname === '/' || parsed.pathname === '') parsed.pathname = '/capture';
      next.url = parsed.toString();
    } else next.url = '';
  }
  if (patch.device != null) next.device = String(patch.device);
  if (patch.label != null) next.label = String(patch.label).slice(0, 60);
  if (patch.esp32Size != null) next.esp32Size = Number(patch.esp32Size);
  setPrefs({ camera: next });
  if (patch.on != null) {
    if (patch.on && !isConfigured(next)) throw new CameraError('Choose a camera first (Settings → Camera).');
    on = Boolean(patch.on);
    lastError = null;
    if (on) sizeReady = applyEsp32Size(next).catch(() => {});
  }
  publishLive({ type: 'camera', on, label: next.label || null }, 'camera');
  return cameraState();
}

/* ESP32 cameras: ask for the chosen picture size when the camera is turned on. */
async function applyEsp32Size(c) {
  if (c.source !== 'url' || !c.url || !/\/capture$/.test(new URL(c.url).pathname) || !ESP32_SIZES[c.esp32Size]) return;
  const ctl = new URL(c.url);
  ctl.pathname = '/control';
  ctl.search = `?var=framesize&val=${c.esp32Size}`;
  await fetch(ctl, { signal: AbortSignal.timeout(3000) }).catch(() => {});
  // The sensor needs a moment; the first frames after a change are the old size.
  await new Promise((r) => setTimeout(r, 600));
}

// --- taking a picture ------------------------------------------------------------

/* The first complete JPEG in a buffer (an MJPEG stream chunk, or a JPEG). */
export function firstJpeg(buf) {
  const start = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (start < 0) return null;
  const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 3);
  if (end < 0) return null;
  return buf.subarray(start, end + 2);
}

async function grabUrl(url, signal) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SNAP_TIMEOUT_MS);
  const onAbort = () => ac.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let resp;
    try {
      resp = await fetch(url, { signal: ac.signal, headers: { 'Cache-Control': 'no-cache' } });
    } catch (e) {
      throw new CameraError(ac.signal.aborted ? `The camera at ${url} didn't answer within ${SNAP_TIMEOUT_MS / 1000}s. Is it on and on the same network?` : `Can't reach the camera at ${url}: ${e.cause?.message || e.message}`);
    }
    if (!resp.ok) throw new CameraError(`The camera answered ${resp.status}.`);
    const type = resp.headers.get('content-type') || '';
    // A stream never ends: read just until the first whole picture.
    const reader = resp.body.getReader();
    let buf = Buffer.alloc(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf = Buffer.concat([buf, Buffer.from(value)]);
      const jpg = firstJpeg(buf);
      if (jpg && (type.includes('multipart') || done)) { reader.cancel().catch(() => {}); return Buffer.from(jpg); }
      if (done) break;
      if (buf.length > MAX_JPEG_BYTES) { reader.cancel().catch(() => {}); break; }
    }
    throw new CameraError('The camera sent something that isn\'t a JPEG picture.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out = []; let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => { err = (err + d).slice(-8000); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: Buffer.alloc(0), err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(out), err }); });
  });
}

async function grabWebcam(device) {
  const r = await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `video=${device}`, '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], 15000);
  if (r.code !== 0 || !r.out.length) {
    if (/not found|No such file|ENOENT/i.test(r.err) && r.code === -1) throw new CameraError('ffmpeg is not installed: winget install Gyan.FFmpeg');
    throw new CameraError(`The webcam "${device}" didn't give a picture: ${r.err.trim().split('\n').pop() || 'no output'}`);
  }
  return r.out;
}

/* Webcams ffmpeg can see on this PC. */
export async function listWebcams() {
  const r = await run('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 10000);
  const out = [];
  for (const line of r.err.split('\n')) {
    const m = /"([^"]+)"\s+\(video\)/.exec(line);
    if (m) out.push(m[1]);
  }
  return out;
}

function cameraDir() {
  const dir = path.join(getWorkspaceRoot(), 'camera');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => /^camera-.*\.jpg$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_PICTURES))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* best effort */ }
}

/* Take a picture now. With save: true it's written into the workspace's
 * camera/ folder and its path returned (for the chat and the model). */
export async function takePicture({ save = true, signal, ignoreOff = false } = {}) {
  const c = getPrefs().camera;
  if (!ignoreOff && !on) throw new CameraError('The camera is off. The user turns it on with the camera button.');
  if (!isConfigured(c)) throw new CameraError('No camera is chosen yet (Settings → Camera).');
  await sizeReady;
  let jpg;
  try {
    jpg = c.source === 'webcam' ? await grabWebcam(c.device) : await grabUrl(c.url, signal);
    lastError = null;
  } catch (e) {
    lastError = e.message;
    throw e;
  }
  lastShotAt = Date.now();
  if (!save) return { jpg };
  const dir = cameraDir();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  let file = path.join(dir, `camera-${stamp}.jpg`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `camera-${stamp}-${n}.jpg`);
  fs.writeFileSync(file, jpg);
  prune(dir);
  return { jpg, path: file, rel: toWorkspaceRelative(file), name: path.basename(file) };
}

// --- finding an ESP32 camera on the network -----------------------------------------

function localSubnets() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal && /^(10|172\.(1[6-9]|2\d|3[01])|192\.168)\./.test(a.address)) {
        out.push(a.address.split('.').slice(0, 3).join('.'));
      }
    }
  }
  return [...new Set(out)];
}

/* Ask every address on the home network for /capture; the ones that answer
 * with a JPEG are cameras. Only private (home) networks are searched. */
export async function findNetworkCameras({ concurrency = 48, timeoutMs = 900 } = {}) {
  const found = [];
  for (const net of localSubnets()) {
    const ips = Array.from({ length: 254 }, (_, i) => `${net}.${i + 1}`);
    let next = 0;
    const worker = async () => {
      while (next < ips.length) {
        const ip = ips[next++];
        try {
          const r = await fetch(`http://${ip}/capture`, { signal: AbortSignal.timeout(timeoutMs) });
          if (r.ok && (r.headers.get('content-type') || '').includes('image/jpeg')) {
            await r.arrayBuffer();
            found.push({ ip, url: `http://${ip}/capture`, stream: `http://${ip}:81/stream` });
          } else {
            r.body?.cancel?.();
          }
        } catch { /* nothing there */ }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }
  return found;
}

export function _resetCameraForTest() { on = false; lastError = null; lastShotAt = null; }

/* The attachment the live camera adds to a message: a picture while it's on,
 * a note if it failed, nothing while it's off. Used by the chat and the
 * website chat bridge. */
export async function cameraAttachment() {
  if (!on) return null;
  try {
    const shot = await takePicture();
    return { kind: 'image', path: shot.path, mediaType: 'image/jpeg', name: shot.name, camera: { label: getPrefs().camera.label } };
  } catch (e) {
    return { kind: 'note', text: `[The live camera is on but didn't give a picture: ${e.message}]` };
  }
}
