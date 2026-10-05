// Files for the chat: shrink pictures in the browser, then upload them into
// the workspace's attachments/ folder (POST /api/attachments).

const MAX_SIDE = 2000;           // px, longest side sent to the model
const KEEP_AS_IS_BYTES = 1.5e6;  // small pictures go up untouched
export const ACCEPT = 'image/*,audio/*,.pdf,.docx,.xlsx,.txt,.md,.csv,.json,.mp4,.mov,.webm';

/* A big photo becomes a JPEG at most MAX_SIDE px wide or tall. GIFs (they may
 * move) and small pictures are left alone. */
export async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { return file; }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1 && file.size <= KEEP_AS_IS_BYTES) { bmp.close?.(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
  if (!blob) return file;
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return new File([blob], name || 'picture.jpg', { type: 'image/jpeg' });
}

/* Upload files; resolves to [{ name, path, size, kind, preview }]. */
export async function uploadAttachments(files) {
  const list = await Promise.all([...files].map(shrinkImage));
  const fd = new FormData();
  for (const f of list) fd.append('files', f, f.name || 'pasted.png');
  const r = await fetch('/api/attachments', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Upload failed (${r.status})`);
  return j.files.map((f, i) => ({
    ...f,
    preview: f.kind === 'image' ? URL.createObjectURL(list[i]) : null,
  }));
}
