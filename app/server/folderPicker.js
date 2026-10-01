// Windows' native "choose a folder" dialog, for the workspace setting.
//
// The browser can't hand a page a real folder path, but this server runs on
// the user's own PC, so it can show the system dialog itself. PowerShell
// (always present on Windows) opens it; the chosen path comes back on stdout.

import { execFile } from 'node:child_process';

const SCRIPT = `
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = 'Choose the folder Omi-One can search, read and change'
$d.ShowNewFolderButton = $true
if ($env:OMNI_PICK_START -and (Test-Path -LiteralPath $env:OMNI_PICK_START)) { $d.SelectedPath = $env:OMNI_PICK_START }
if ($d.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }
`;

let open = false;

/* Resolves to the chosen folder, or null if the user cancelled. */
export function pickFolder(startAt) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('The folder dialog is only available on Windows. Type the path instead.'));
  }
  if (open) return Promise.reject(new Error('The folder dialog is already open. Look for it behind your browser.'));
  open = true;
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      {
        windowsHide: true,
        timeout: 10 * 60 * 1000,
        encoding: 'utf8',
        env: { ...process.env, OMNI_PICK_START: startAt || '' },
      },
      (err, stdout) => {
        open = false;
        if (err) return reject(new Error('Could not open the folder dialog.'));
        const chosen = String(stdout || '').trim();
        resolve(chosen || null);
      },
    );
  });
}
