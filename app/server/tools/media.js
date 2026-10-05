// MiniMax media tools: H3 video generation and text-to-speech (pictures,
// cloned voices and music are in create.js and share the helpers here).
//
// Both use the MiniMax key saved in Settings — the same one the chat provider
// uses — so there is nothing extra to configure. They cost money per call, so
// the calls that spend credits are classed 'execute' and ask for approval in
// the default and acceptEdits modes.
//
// Video is asynchronous: create a task, poll its status, then download the
// result. The output URL MiniMax returns is time-limited, which is why the
// download is its own tool that writes into the workspace rather than a link
// handed back to the model.

import fs from 'node:fs';
import path from 'node:path';

import { registerTool } from '../toolRegistry.js';
import { resolveInWorkspace, toWorkspaceRelative } from '../workspace.js';
import { getProviderKey } from '../secrets.js';
import { providerById } from '../providers.js';

const API_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

// Per-model limits from the MiniMax video v2 reference. H3-Max trades the 2K
// tier and the 4-second minimum for speed.
export const VIDEO_MODELS = {
  'MiniMax-H3': { resolutions: ['768P', '2K'], minDuration: 4, maxDuration: 15 },
  'MiniMax-H3-Max': { resolutions: ['480P', '768P'], minDuration: 5, maxDuration: 15 },
};
const RATIOS = ['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const EXPANSION_MODES = ['disabled', 'balanced', 'quality'];

export const DEFAULT_TTS_MODEL = 'speech-2.8-hd';
const TTS_FORMATS = ['mp3', 'wav', 'flac', 'pcm', 'opus'];

/* https://api.minimax.io — taken from the provider's base URL so the chat and
 * media endpoints can never point at different hosts. */
function apiOrigin() {
  const base = providerById('minimax')?.baseUrl || 'https://api.minimax.io/v1';
  return new URL(base).origin;
}

function requireKey() {
  const key = getProviderKey('minimax') || process.env.MINIMAX_API_KEY || null;
  if (!key) {
    return { error: { ok: false, error: 'No MiniMax API key. Add one in ⚙ Settings (provider: MiniMax).' } };
  }
  return { key };
}

/* fetch with a deadline, cancelled with the run. */
export async function fetchWithTimeout(url, init, { signal, timeoutMs = API_TIMEOUT_MS } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
  timer.unref?.();
  const onOuterAbort = () => ac.abort(new Error('cancelled'));
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      throw new DOMException('Aborted', 'AbortError');
    }
    signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

/* Call a MiniMax JSON endpoint. MiniMax reports some failures as HTTP 200
 * with a non-zero base_resp.status_code, so both are checked. */
export async function minimaxJson(method, pathname, body, ctx = {}) {
  const auth = requireKey();
  if (auth.error) return auth.error;

  let resp;
  try {
    resp = await fetchWithTimeout(`${apiOrigin()}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth.key}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }, { signal: ctx.signal, timeoutMs: ctx.timeoutMs || API_TIMEOUT_MS });
  } catch (e) {
    if (e?.name === 'AbortError' && ctx.signal?.aborted) throw e;
    return { ok: false, error: `MiniMax request failed: ${e?.message || e}` };
  }

  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = null; }

  if (!resp.ok) {
    const msg = data?.base_resp?.status_msg || data?.error?.message || data?.message || text.slice(0, 500);
    return { ok: false, error: `MiniMax HTTP ${resp.status}: ${msg}` };
  }
  if (!data) return { ok: false, error: `MiniMax returned non-JSON: ${text.slice(0, 500)}` };
  const code = data.base_resp?.status_code;
  if (code != null && code !== 0) {
    return { ok: false, error: `MiniMax error ${code}: ${data.base_resp.status_msg || 'unknown'}` };
  }
  return { ok: true, data };
}

/* Pick a workspace path and refuse to clobber an existing file unless asked. */
export function prepareDest(dest, { overwrite = false } = {}) {
  let abs;
  try { abs = resolveInWorkspace(dest); } catch (e) { return { error: { ok: false, error: e.message } }; }
  if (!overwrite && fs.existsSync(abs)) {
    return { error: { ok: false, error: `${dest} already exists. Pass overwrite: true or choose another path.` } };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  return { abs };
}

/* Upload a file to MiniMax's file store (voice samples). Resolves to
 * { ok, fileId } or { ok: false, error }. */
export async function minimaxUpload(absPath, purpose, ctx = {}) {
  const auth = requireKey();
  if (auth.error) return auth.error;
  const fd = new FormData();
  fd.append('purpose', purpose);
  fd.append('file', new Blob([fs.readFileSync(absPath)]), path.basename(absPath));
  let resp;
  try {
    resp = await fetchWithTimeout(`${apiOrigin()}/v1/files/upload`, {
      method: 'POST', headers: { Authorization: `Bearer ${auth.key}` }, body: fd,
    }, { signal: ctx.signal, timeoutMs: 120_000 });
  } catch (e) {
    if (e?.name === 'AbortError' && ctx.signal?.aborted) throw e;
    return { ok: false, error: `MiniMax upload failed: ${e?.message || e}` };
  }
  const data = await resp.json().catch(() => null);
  const code = data?.base_resp?.status_code;
  if (!resp.ok || (code != null && code !== 0)) {
    return { ok: false, error: `MiniMax upload failed: ${data?.base_resp?.status_msg || `HTTP ${resp.status}`}` };
  }
  const fileId = data?.file?.file_id;
  if (fileId == null) return { ok: false, error: 'MiniMax upload returned no file_id.' };
  return { ok: true, fileId };
}

// --- video -----------------------------------------------------------------

export function validateVideoArgs({ model = 'MiniMax-H3', resolution, duration, ratio, first_frame_url, last_frame_url, prompt_expansion_mode }) {
  const spec = VIDEO_MODELS[model];
  if (!spec) return `Unknown model "${model}". Use one of: ${Object.keys(VIDEO_MODELS).join(', ')}.`;
  if (!spec.resolutions.includes(resolution)) {
    return `${model} supports resolution ${spec.resolutions.join(' or ')}, not "${resolution}".`;
  }
  if (!Number.isInteger(duration) || duration < spec.minDuration || duration > spec.maxDuration) {
    return `${model} supports whole-second durations from ${spec.minDuration} to ${spec.maxDuration}.`;
  }
  if (!RATIOS.includes(ratio)) return `Ratio must be one of: ${RATIOS.join(', ')}.`;
  // With no frame to take the shape from, MiniMax needs an explicit ratio.
  if (ratio === 'adaptive' && !first_frame_url && !last_frame_url) {
    return 'Text-to-video needs an explicit ratio such as "16:9" or "9:16"; "adaptive" only works with a first or last frame.';
  }
  if (prompt_expansion_mode && !EXPANSION_MODES.includes(prompt_expansion_mode)) {
    return `prompt_expansion_mode must be one of: ${EXPANSION_MODES.join(', ')}.`;
  }
  return null;
}

export function buildVideoRequest(args) {
  const {
    prompt, model = 'MiniMax-H3', resolution, duration, ratio,
    first_frame_url, last_frame_url, prompt_expansion_mode,
  } = args;
  const content = [{ type: 'text', text: prompt }];
  if (first_frame_url) content.push({ type: 'image_url', image_url: { url: first_frame_url }, role: 'first_frame' });
  if (last_frame_url) content.push({ type: 'image_url', image_url: { url: last_frame_url }, role: 'last_frame' });
  const body = { model, content, resolution, duration, ratio };
  if (prompt_expansion_mode) body.extra = { prompt_expansion_mode };
  return body;
}

registerTool({
  name: 'video_generate',
  description: 'Start a MiniMax H3 video generation task from a text prompt, optionally anchored to a first and/or last frame image URL. Returns a task_id immediately; generation takes minutes. Poll it with video_status, then save it with video_download. Costs MiniMax credits.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What happens in the video: subject, action, setting, camera movement. Max 7000 characters.' },
      model: { type: 'string', enum: Object.keys(VIDEO_MODELS), default: 'MiniMax-H3', description: 'MiniMax-H3 (768P or 2K, 4-15s) or MiniMax-H3-Max (480P or 768P, 5-15s, faster).' },
      resolution: { type: 'string', enum: ['480P', '768P', '2K'], default: '768P' },
      duration: { type: 'integer', minimum: 4, maximum: 15, default: 6, description: 'Length in seconds.' },
      ratio: { type: 'string', enum: RATIOS, default: '16:9', description: 'Aspect ratio. "adaptive" follows the first frame and is only valid when one is given.' },
      first_frame_url: { type: 'string', description: 'Optional public image URL to start the video from.' },
      last_frame_url: { type: 'string', description: 'Optional public image URL to end the video on.' },
      prompt_expansion_mode: { type: 'string', enum: EXPANSION_MODES, description: 'How much MiniMax rewrites the prompt. Default balanced.' },
    },
    required: ['prompt'],
  },
  handler: async (raw, ctx = {}) => {
    const args = { model: 'MiniMax-H3', resolution: '768P', duration: 6, ratio: '16:9', ...raw };
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return { ok: false, error: 'prompt is required.' };
    if (prompt.length > 7000) return { ok: false, error: 'prompt is over 7000 characters.' };
    args.prompt = prompt;
    const bad = validateVideoArgs(args);
    if (bad) return { ok: false, error: bad };

    const r = await minimaxJson('POST', '/v2/video_generation', buildVideoRequest(args), ctx);
    if (!r.ok) return r;
    if (!r.data.task_id) return { ok: false, error: `MiniMax did not return a task_id: ${JSON.stringify(r.data).slice(0, 500)}` };
    return {
      ok: true,
      result: {
        task_id: String(r.data.task_id),
        model: args.model,
        resolution: args.resolution,
        duration: args.duration,
        ratio: args.ratio,
        next: 'Call video_status with this task_id every 30 seconds or so until status is succeeded, then video_download.',
      },
    };
  },
});

registerTool({
  name: 'video_status',
  description: 'Check a MiniMax video task. Status is queued, running, succeeded, failed or cancelled. When succeeded, call video_download to save the file.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: { task_id: { type: 'string' } },
    required: ['task_id'],
  },
  handler: async ({ task_id }, ctx = {}) => {
    const id = String(task_id ?? '').trim();
    if (!/^[\w-]+$/.test(id)) return { ok: false, error: 'task_id is missing or malformed.' };
    const r = await minimaxJson('GET', `/v2/query/video_generation/${encodeURIComponent(id)}`, null, ctx);
    if (!r.ok) return r;
    const t = r.data.task || {};
    return {
      ok: true,
      result: {
        task_id: id,
        status: t.status || 'unknown',
        model: t.model,
        resolution: t.resolution,
        duration: t.duration,
        ratio: t.ratio,
        ready: t.status === 'succeeded' && Boolean(t.content?.url),
        ...(t.error || t.fail_reason ? { error: t.error || t.fail_reason } : {}),
      },
    };
  },
});

registerTool({
  name: 'video_download',
  description: 'Save a finished MiniMax video into the workspace as an .mp4. The task must have status succeeded. MiniMax output links expire, so download soon after it finishes.',
  permission: 'write',
  schema: {
    type: 'object',
    properties: {
      task_id: { type: 'string' },
      dest: { type: 'string', description: 'Workspace path for the file, e.g. "media/intro.mp4".' },
      overwrite: { type: 'boolean', default: false },
    },
    required: ['task_id', 'dest'],
  },
  affectedPaths: ({ dest }) => [dest],
  handler: async ({ task_id, dest, overwrite = false }, ctx = {}) => {
    const id = String(task_id ?? '').trim();
    if (!/^[\w-]+$/.test(id)) return { ok: false, error: 'task_id is missing or malformed.' };
    const d = prepareDest(dest, { overwrite });
    if (d.error) return d.error;

    const r = await minimaxJson('GET', `/v2/query/video_generation/${encodeURIComponent(id)}`, null, ctx);
    if (!r.ok) return r;
    const t = r.data.task || {};
    if (t.status !== 'succeeded') return { ok: false, error: `Task is ${t.status || 'unknown'}, not succeeded yet.` };
    const url = t.content?.url;
    if (!url) return { ok: false, error: 'Task succeeded but has no video URL.' };

    let resp;
    try {
      resp = await fetchWithTimeout(url, { method: 'GET' }, { signal: ctx.signal, timeoutMs: DOWNLOAD_TIMEOUT_MS });
    } catch (e) {
      if (e?.name === 'AbortError' && ctx.signal?.aborted) throw e;
      return { ok: false, error: `Download failed: ${e?.message || e}` };
    }
    if (!resp.ok) return { ok: false, error: `Download failed: HTTP ${resp.status}. The link may have expired.` };
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared > MAX_DOWNLOAD_BYTES) return { ok: false, error: `Video is ${declared} bytes, over the ${MAX_DOWNLOAD_BYTES}-byte limit.` };

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_DOWNLOAD_BYTES) return { ok: false, error: `Video is over the ${MAX_DOWNLOAD_BYTES}-byte limit.` };
    fs.writeFileSync(d.abs, buf);
    return { ok: true, result: { task_id: id, path: toWorkspaceRelative(d.abs), bytes: buf.length } };
  },
});

// --- speech ----------------------------------------------------------------

export function buildTtsRequest({ text, model = DEFAULT_TTS_MODEL, voice_id = 'English_expressive_narrator', speed, pitch, volume, emotion, format = 'mp3', language_boost }) {
  const voice_setting = { voice_id };
  if (speed != null) voice_setting.speed = speed;
  if (pitch != null) voice_setting.pitch = pitch;
  if (volume != null) voice_setting.vol = volume;
  if (emotion) voice_setting.emotion = emotion;
  const body = {
    model,
    text,
    stream: false,
    output_format: 'hex',
    voice_setting,
    audio_setting: { format, sample_rate: 32000, channel: 1, ...(format === 'mp3' ? { bitrate: 128000 } : {}) },
  };
  if (language_boost) body.language_boost = language_boost;
  return body;
}

/* Synthesize speech and return the audio bytes. Shared by the tool (which
 * writes a file) and the /api/speak route (which streams it to the face). */
export async function synthesizeSpeech(args, ctx = {}) {
  const r = await minimaxJson('POST', '/v1/t2a_v2', buildTtsRequest(args), ctx);
  if (!r.ok) return r;
  const hex = r.data.data?.audio;
  if (!hex || !/^[0-9a-f]+$/i.test(hex)) return { ok: false, error: 'MiniMax returned no audio.' };
  return { ok: true, buf: Buffer.from(hex, 'hex'), info: r.data.extra_info || {} };
}

registerTool({
  name: 'text_to_speech',
  description: 'Turn text into a spoken audio file in the workspace using MiniMax TTS — narration or voice-over for videos. Returns the file path and its length in milliseconds. Costs MiniMax credits.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'What to say. Max 10000 characters. Pause markers like <#0.5#> are supported.' },
      dest: { type: 'string', description: 'Workspace path for the audio, e.g. "media/voiceover.mp3".' },
      model: { type: 'string', default: DEFAULT_TTS_MODEL, description: 'MiniMax speech model ID, e.g. speech-2.8-hd or speech-2.8-turbo.' },
      voice_id: { type: 'string', default: 'English_expressive_narrator', description: 'A MiniMax system or cloned voice ID, e.g. English_expressive_narrator, English_Graceful_Lady, English_Persuasive_Man.' },
      speed: { type: 'number', minimum: 0.5, maximum: 2, description: 'Default 1.' },
      pitch: { type: 'integer', minimum: -12, maximum: 12, description: 'Semitones. Default 0.' },
      volume: { type: 'number', exclusiveMinimum: 0, maximum: 10, description: 'Default 1.' },
      emotion: { type: 'string', enum: ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'] },
      format: { type: 'string', enum: TTS_FORMATS, default: 'mp3' },
      language_boost: { type: 'string', description: 'Language hint such as "English" or "auto".' },
      overwrite: { type: 'boolean', default: false },
    },
    required: ['text', 'dest'],
  },
  affectedPaths: ({ dest }) => [dest],
  handler: async (args, ctx = {}) => {
    const text = String(args.text ?? '');
    if (!text.trim()) return { ok: false, error: 'text is required.' };
    if (text.length > 10000) return { ok: false, error: 'text is over 10000 characters; split it into several files.' };
    const format = args.format || 'mp3';
    if (!TTS_FORMATS.includes(format)) return { ok: false, error: `format must be one of: ${TTS_FORMATS.join(', ')}.` };
    const d = prepareDest(args.dest, { overwrite: args.overwrite });
    if (d.error) return d.error;

    const r = await synthesizeSpeech({ ...args, text, format }, ctx);
    if (!r.ok) return r;
    const { buf, info } = r;
    fs.writeFileSync(d.abs, buf);
    return {
      ok: true,
      result: {
        path: toWorkspaceRelative(d.abs),
        bytes: buf.length,
        duration_ms: info.audio_length,
        format: info.audio_format || format,
        model: args.model || DEFAULT_TTS_MODEL,
        characters_billed: info.usage_characters,
      },
    };
  },
});
