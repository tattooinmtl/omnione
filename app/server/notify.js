// Windows notifications ("toasts") for things that finish while nobody is
// looking: a scheduled task, a run waiting for approval.
//
// The tray library can't show them, so the server asks Windows directly
// through PowerShell's built-in toast API. Until OmniOne registers an app id
// of its own, Windows shows them as coming from "Windows PowerShell".
// Best-effort: a failure is logged and forgotten.

import { spawn } from 'node:child_process';
import { getPrefs } from './prefs.js';

const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const xmlEscape = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function toastScript(title, body) {
  const xml = `<toast><visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual></toast>`;
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
    '$x = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$x.LoadXml('${xml.replace(/'/g, "''")}')`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_AUMID}').Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join('; ');
}

let sent = [];

/* Show a notification. Returns false when it was not shown (turned off,
 * not Windows, tests). */
export function notify(title, body = '') {
  const t = String(title).slice(0, 120);
  const b = String(body).replace(/\s+/g, ' ').slice(0, 300);
  if (process.env.VITEST || process.env.GWN_NOTIFY === '0') { sent.push({ title: t, body: b }); return false; }
  if (process.platform !== 'win32' || !getPrefs().notifications.desktop) return false;
  try {
    const encoded = Buffer.from(toastScript(t, b), 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true, stdio: 'ignore', detached: false,
    });
    child.on('error', (e) => console.error('[omnione] notification failed:', e.message));
    child.unref();
    return true;
  } catch (e) {
    console.error('[omnione] notification failed:', e.message);
    return false;
  }
}

/* Notifications "shown" during tests, newest last. */
export function _sentForTest() { const s = sent; sent = []; return s; }
