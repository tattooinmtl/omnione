// Pictures, cloned voices and music.
//
// Image generation, voice cloning and music use the MiniMax key, like the
// video and speech tools in media.js. MiniMax can only keep a person's face
// from a reference photo, not change a photo, so image_edit uses an OpenAI
// key when one is saved. Everything that spends credits is 'execute' and asks
// first.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerTool } from '../toolRegistry.js';
import { resolveInWorkspace, toWorkspaceRelative } from '../workspace.js';
import { getProviderKey } from '../secrets.js';
import { providerById } from '../providers.js';
import { imageTypeOf } from '../attachments.js';
import { getPrefs, setPrefs } from '../prefs.js';
import { minimaxJson, minimaxUpload, fetchWithTimeout, prepareDest } from './media.js';

export const IMAGE_RATIOS = ['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9'];
const MUSIC_MODELS = ['music-3.0', 'music-2.6', 'music-3.0-free', 'music-2.6-free'];
const CLONE_EXTS = new Set(['.mp3', '.m4a', '.wav']);

const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

/* A workspace file as a data URL, for APIs that take an image inline. */
function dataUrlOf(rel) {
  const abs = resolveInWorkspace(rel);
  const type = imageTypeOf(abs);
  if (!type) throw new Error(`${rel} isn't a png, jpg, gif or webp picture.`);
  if (!fs.existsSync(abs)) throw new Error(`No such file: ${rel}`);
  if (fs.statSync(abs).size > 10 * 1024 * 1024) throw new Error(`${rel} is over 10 MB.`);
  return `data:${type};base64,${fs.readFileSync(abs).toString('base64')}`;
}

/* Where generated files go when the model doesn't say: media/<kind>-<time>-N.ext */
function defaultDest(kind, ext, i = 0) {
  return path.join('media', `${kind}-${stamp()}${i ? `-${i + 1}` : ''}.${ext}`).replace(/\\/g, '/');
}

// --- pictures ---------------------------------------------------------------

export function buildImageRequest({ prompt, ratio, n = 1, reference_image, prompt_optimizer }) {
  const body = {
    model: 'image-01',
    prompt,
    aspect_ratio: ratio,
    response_format: 'base64',
    n: Math.max(1, Math.min(4, Math.floor(n) || 1)),
    prompt_optimizer: Boolean(prompt_optimizer),
  };
  if (reference_image) body.subject_reference = [{ type: 'character', image_file: dataUrlOf(reference_image) }];
  return body;
}

registerTool({
  name: 'image_generate',
  description: 'Make pictures from a description with MiniMax image-01. Optionally give reference_image (a workspace photo of a person) to keep that face in the new pictures. Saves PNG/JPEG files in the workspace and shows them to you. Costs MiniMax credits.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What the picture shows: subject, setting, style, lighting. Max 1500 characters.' },
      ratio: { type: 'string', enum: IMAGE_RATIOS, description: 'Aspect ratio. Default from Settings (1:1).' },
      n: { type: 'integer', minimum: 1, maximum: 4, default: 1, description: 'How many variations.' },
      reference_image: { type: 'string', description: 'Workspace path of a front-facing portrait whose face to keep.' },
      dest: { type: 'string', description: 'Workspace path for the first picture, e.g. "media/logo.jpg". Others get -2, -3.' },
    },
    required: ['prompt'],
  },
  handler: async (args, ctx = {}) => {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return { ok: false, error: 'prompt is required.' };
    if (prompt.length > 1500) return { ok: false, error: 'prompt is over 1500 characters.' };
    const prefs = getPrefs().media;
    const ratio = args.ratio || prefs.imageRatio;
    if (!IMAGE_RATIOS.includes(ratio)) return { ok: false, error: `ratio must be one of: ${IMAGE_RATIOS.join(', ')}.` };
    let body;
    try { body = buildImageRequest({ ...args, prompt, ratio, prompt_optimizer: prefs.imagePromptOptimizer }); } catch (e) { return { ok: false, error: e.message }; }

    const r = await minimaxJson('POST', '/v1/image_generation', body, ctx);
    if (!r.ok) return r;
    const pics = r.data.data?.image_base64 || [];
    if (!pics.length) return { ok: false, error: 'MiniMax made no picture (the prompt may have been refused by its safety check).' };
    return savePictures(pics.map((b) => Buffer.from(b, 'base64')), args.dest, 'image');
  },
});

function savePictures(buffers, dest, kind) {
  const saved = [];
  for (const [i, buf] of buffers.entries()) {
    const ext = buf[0] === 0x89 ? 'png' : 'jpg';
    let rel = dest
      ? (i ? dest.replace(/(\.\w+)?$/, (m) => `-${i + 1}${m || `.${ext}`}`) : dest)
      : defaultDest(kind, ext, i);
    if (!path.extname(rel)) rel += `.${ext}`;
    const d = prepareDest(rel, { overwrite: false });
    if (d.error) return d.error;
    fs.writeFileSync(d.abs, buf);
    saved.push({ path: toWorkspaceRelative(d.abs), abs: d.abs, mediaType: ext === 'png' ? 'image/png' : 'image/jpeg' });
  }
  return {
    ok: true,
    result: { saved: saved.map((s) => s.path), show: 'The pictures are shown in the chat. Describe them briefly; mention the file paths.' },
    images: saved.map((s) => ({ path: s.abs, mediaType: s.mediaType })),
  };
}

registerTool({
  name: 'image_edit',
  description: 'Change an existing picture by describing the change ("make the sky orange", "remove the man on the left"), using an OpenAI key (gpt-image-1). Saves a new file and shows it to you. Costs OpenAI credits. Without an OpenAI key, explain that editing needs one and offer image_generate with reference_image instead.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'Workspace path of the picture to change (png, jpg or webp).' },
      prompt: { type: 'string', description: 'The change to make.' },
      dest: { type: 'string', description: 'Workspace path for the result. Default media/edit-<time>.png.' },
    },
    required: ['image', 'prompt'],
  },
  handler: async ({ image, prompt, dest }, ctx = {}) => {
    const key = getProviderKey('openai') || process.env.OPENAI_API_KEY;
    if (!key) return { ok: false, error: 'Editing a picture needs an OpenAI key (Settings → AI → OpenAI). MiniMax can only keep a face from a reference photo: try image_generate with reference_image.' };
    let abs;
    try { abs = resolveInWorkspace(image); } catch (e) { return { ok: false, error: e.message }; }
    const type = imageTypeOf(abs);
    if (!type || type === 'image/gif') return { ok: false, error: `${image} must be a png, jpg or webp picture.` };
    if (!fs.existsSync(abs)) return { ok: false, error: `No such file: ${image}` };

    const fd = new FormData();
    fd.append('model', 'gpt-image-1');
    fd.append('prompt', String(prompt));
    fd.append('image', new Blob([fs.readFileSync(abs)], { type }), path.basename(abs));
    const base = providerById('openai')?.baseUrl || 'https://api.openai.com/v1';
    let resp;
    try {
      resp = await fetchWithTimeout(`${base.replace(/\/$/, '')}/images/edits`, {
        method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd,
      }, { signal: ctx.signal, timeoutMs: 180_000 });
    } catch (e) {
      if (e?.name === 'AbortError' && ctx.signal?.aborted) throw e;
      return { ok: false, error: `OpenAI request failed: ${e?.message || e}` };
    }
    const j = await resp.json().catch(() => null);
    if (!resp.ok) return { ok: false, error: `OpenAI HTTP ${resp.status}: ${j?.error?.message || 'no details'}` };
    const b64 = j?.data?.[0]?.b64_json;
    if (!b64) return { ok: false, error: 'OpenAI returned no picture.' };
    return savePictures([Buffer.from(b64, 'base64')], dest || defaultDest('edit', 'png'), 'edit');
  },
});

// --- cloned voices -------------------------------------------------------------

/* MiniMax's rules: 8-256 chars, starts with a letter, letters/digits/-/_,
 * not ending in - or _. Built from the name the user gave. */
export function makeVoiceId(name) {
  let id = String(name || '').normalize('NFKD').replace(/[^\w-]+/g, '_').replace(/^[^A-Za-z]+/, '').replace(/[-_]+$/, '');
  if (!id) id = 'Voice';
  id = `Omi_${id}_${stamp().slice(2, 12)}`;
  return id.slice(0, 64).replace(/[-_]+$/, '');
}

/* A recording in another format (the in-app recorder makes webm) is turned
 * into wav with ffmpeg, which MiniMax accepts. */
function ensureCloneFormat(abs) {
  if (CLONE_EXTS.has(path.extname(abs).toLowerCase())) return abs;
  const out = path.join(os.tmpdir(), `omnione-voice-${Date.now()}.wav`);
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', abs, '-ac', '1', '-ar', '32000', out], { windowsHide: true, timeout: 60_000 });
  if (r.status !== 0 || !fs.existsSync(out)) throw new Error('The sample must be mp3, m4a or wav (converting it needs ffmpeg: winget install Gyan.FFmpeg).');
  return out;
}

export async function cloneVoice({ sample, name, previewText }, ctx = {}) {
  let abs = resolveInWorkspace(sample);
  if (!fs.existsSync(abs)) return { ok: false, error: `No such file: ${sample}` };
  try { abs = ensureCloneFormat(abs); } catch (e) { return { ok: false, error: e.message }; }
  const size = fs.statSync(abs).size;
  if (size > 20 * 1024 * 1024) return { ok: false, error: 'The sample is over 20 MB; use 10 seconds to 5 minutes of clear speech.' };

  const up = await minimaxUpload(abs, 'voice_clone', ctx);
  if (!up.ok) return up;
  const voiceId = makeVoiceId(name);
  const body = { file_id: up.fileId, voice_id: voiceId };
  if (previewText) { body.text = String(previewText).slice(0, 300); body.model = getPrefs().voice.model; }
  const r = await minimaxJson('POST', '/v1/voice_clone', body, ctx);
  if (!r.ok) return r;
  if (r.data.input_sensitive && r.data.input_sensitive.type) {
    return { ok: false, error: 'MiniMax refused the sample in its safety check.' };
  }
  const entry = { voiceId, name: String(name || voiceId).slice(0, 60), createdAt: Date.now(), lastUsedAt: null, sample: toWorkspaceRelative(resolveInWorkspace(sample)) };
  const voice = getPrefs().voice;
  setPrefs({ voice: { clones: [...voice.clones.filter((c) => c.voiceId !== voiceId), entry] } });

  let preview = null;
  if (r.data.demo_audio) {
    try {
      const resp = await fetchWithTimeout(r.data.demo_audio, {}, { signal: ctx.signal });
      if (resp.ok) {
        const d = prepareDest(defaultDest('voice-preview', 'mp3'), {});
        if (!d.error) { fs.writeFileSync(d.abs, Buffer.from(await resp.arrayBuffer())); preview = toWorkspaceRelative(d.abs); }
      }
    } catch { /* the clone worked; the preview is a nicety */ }
  }
  return { ok: true, result: { voiceId, name: entry.name, preview, note: 'MiniMax deletes a cloned voice that is not used within 7 days. Use it with text_to_speech (voice_id), or pick it for Omi-One in Settings → Voice.' } };
}

registerTool({
  name: 'voice_clone',
  description: "Clone a voice from a recording in the workspace (10 seconds to 5 minutes of clear speech, mp3/m4a/wav; other formats are converted with ffmpeg). Returns a voice_id for text_to_speech, and it appears in Settings → Voice. ONLY clone the user's own voice or a voice they say they have permission to use; refuse famous or other people's voices otherwise. Costs MiniMax credits.",
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      sample: { type: 'string', description: 'Workspace path of the recording.' },
      name: { type: 'string', description: 'A name for the voice, e.g. "Erik narrator".' },
      preview_text: { type: 'string', description: 'Optional sentence to hear the new voice say.' },
    },
    required: ['sample', 'name'],
  },
  handler: ({ sample, name, preview_text }, ctx) => cloneVoice({ sample, name, previewText: preview_text }, ctx),
});

registerTool({
  name: 'voice_list',
  description: "List the voices cloned for this user (voice_id and name) and the voice Omi-One speaks with now.",
  permission: 'read',
  schema: { type: 'object', properties: {} },
  handler: () => {
    const v = getPrefs().voice;
    return { ok: true, result: { current: v.voiceId, clones: v.clones.map(({ voiceId, name, createdAt, lastUsedAt }) => ({ voiceId, name, createdAt, lastUsedAt })) } };
  },
});

// --- music ---------------------------------------------------------------------

export function buildMusicRequest({ prompt, lyrics, instrumental, model }) {
  const body = {
    model,
    output_format: 'hex',
    audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
  };
  if (prompt) body.prompt = prompt;
  if (instrumental) body.is_instrumental = true;
  else if (lyrics) body.lyrics = lyrics;
  else body.lyrics_optimizer = true; // MiniMax writes the words from the prompt
  return body;
}

registerTool({
  name: 'music_generate',
  description: 'Make a song or an instrumental with MiniMax music. Give a style prompt (genre, mood, instruments, tempo, voice) and either lyrics (with [Verse], [Chorus], [Bridge], [Outro] tags), instrumental: true, or neither to let MiniMax write the lyrics. Saves an mp3 in the workspace. Takes up to a few minutes. Costs MiniMax credits.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Style and mood, max 2000 characters.' },
      lyrics: { type: 'string', description: 'Song lyrics with section tags, max 3500 characters.' },
      instrumental: { type: 'boolean', default: false },
      model: { type: 'string', enum: MUSIC_MODELS, description: 'Default from Settings (music-3.0). The -free models are slower and rate-limited.' },
      dest: { type: 'string', description: 'Workspace path, e.g. "media/theme.mp3".' },
    },
    required: ['prompt'],
  },
  affectedPaths: ({ dest }) => (dest ? [dest] : []),
  handler: async (args, ctx = {}) => {
    const prompt = String(args.prompt ?? '').trim();
    const lyrics = args.lyrics ? String(args.lyrics).trim() : '';
    if (!prompt) return { ok: false, error: 'prompt is required.' };
    if (prompt.length > 2000) return { ok: false, error: 'prompt is over 2000 characters.' };
    if (lyrics.length > 3500) return { ok: false, error: 'lyrics are over 3500 characters.' };
    const model = args.model || getPrefs().media.musicModel;
    if (!MUSIC_MODELS.includes(model)) return { ok: false, error: `model must be one of: ${MUSIC_MODELS.join(', ')}.` };
    const d = prepareDest(args.dest || defaultDest('song', 'mp3'), {});
    if (d.error) return d.error;

    const r = await minimaxJson('POST', '/v1/music_generation', buildMusicRequest({ prompt, lyrics, instrumental: args.instrumental, model }), { ...ctx, timeoutMs: 10 * 60_000 });
    if (!r.ok) return r;
    const hex = r.data.data?.audio;
    if (!hex || !/^[0-9a-f]+$/i.test(hex)) return { ok: false, error: 'MiniMax returned no audio.' };
    const buf = Buffer.from(hex, 'hex');
    fs.writeFileSync(d.abs, buf);
    const info = r.data.extra_info || {};
    return { ok: true, result: { path: toWorkspaceRelative(d.abs), bytes: buf.length, duration_ms: info.music_duration, model } };
  },
});

