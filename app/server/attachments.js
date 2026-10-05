// Files the user hands to Omi-One: pictures, PDFs, Word and Excel documents.
//
// Pictures go to the model as pictures (every provider OmniOne talks to can
// see them on its current models). Documents are turned into text here,
// because no provider reads a .docx and only some read PDFs.
//
// Messages keep a picture as a file path, never as base64: a transcript that
// embeds every screenshot grows by megabytes per turn. The adapters read the
// file when they build the request.

import fs from 'node:fs';
import path from 'node:path';

export const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export const DOCUMENT_EXTS = new Set(['.pdf', '.docx', '.xlsx']);

/* Anthropic refuses images over 5 MB; the others are close. The chat shrinks
 * pictures before uploading, so this only bites on files the agent opens. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOC_CHARS = 200_000;

export function imageTypeOf(file) {
  return IMAGE_TYPES[path.extname(String(file)).toLowerCase()] || null;
}

export function isDocument(file) {
  return DOCUMENT_EXTS.has(path.extname(String(file)).toLowerCase());
}

/* Which models can look at a picture. Older MiniMax models (M2.x) and the
 * built-in stub cannot; MiniMax drops image parts silently instead of failing,
 * so guessing wrong would look like the model ignoring the user. */
export function modelSeesImages(providerId, model) {
  const m = String(model || '').toLowerCase();
  if (providerId === 'gwn-local') return false;
  if (providerId === 'minimax') return !/(^|-)m[12]([.-]|$)|abab|text-01/.test(m);
  if (providerId === 'openai') return !/gpt-3\.5|o1-mini|o3-mini/.test(m);
  return true;
}

/* Read a picture for a request. null when it is gone or too big, so an old
 * conversation whose attachment was deleted still works. */
export function readImage(absPath) {
  const mediaType = imageTypeOf(absPath);
  if (!mediaType) return null;
  let st;
  try { st = fs.statSync(absPath); } catch { return null; }
  if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return null;
  return { mediaType, data: fs.readFileSync(absPath).toString('base64') };
}

/* Text out of a PDF, Word or Excel file. Throws with a readable message. */
export async function extractDocumentText(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const buf = fs.readFileSync(absPath);
  let text;
  if (ext === '.pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { totalPages, text: pages } = await extractText(pdf, { mergePages: false });
    text = pages.map((t, i) => `--- page ${i + 1} of ${totalPages} ---\n${t.trim()}`).join('\n\n');
    if (!pages.some((t) => t.trim())) {
      text += '\n\n(No text layer: this PDF is probably scanned pictures. Use view_image on a screenshot of a page to read it.)';
    }
  } else if (ext === '.docx') {
    const mammoth = (await import('mammoth')).default;
    text = (await mammoth.extractRawText({ buffer: buf })).value;
  } else if (ext === '.xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const parts = [];
    wb.eachSheet((sheet) => {
      const rows = [];
      sheet.eachRow({ includeEmpty: false }, (row) => {
        const cells = (row.values || []).slice(1).map(cellText);
        rows.push(cells.join('\t'));
      });
      parts.push(`--- sheet "${sheet.name}" (${rows.length} rows, tab-separated) ---\n${rows.join('\n')}`);
    });
    text = parts.join('\n\n');
  } else {
    throw new Error(`Can't read ${ext} files as a document.`);
  }
  text = text.trim();
  if (text.length > MAX_DOC_CHARS) {
    text = `${text.slice(0, MAX_DOC_CHARS)}\n…(cut off: ${text.length - MAX_DOC_CHARS} more characters)`;
  }
  return text;
}

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return String(v.text);
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('hyperlink' in v) return String(v.hyperlink);
    return JSON.stringify(v);
  }
  return String(v).replace(/[\t\n]/g, ' ');
}

/* A safe file name for an upload: keeps letters, digits, dot, dash. */
export function safeUploadName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '');
  return (base || 'file').slice(-120);
}
