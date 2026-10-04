// Always-listening voice input for the Presence widget, on Windows' own
// offline speech recognizer (System.Speech): free, nothing leaves the PC.
//
// The recognizer runs in a hidden PowerShell child (the script is passed
// inline, encoded) only while at least one window is listening: the first
// /api/listen subscriber starts it, the last one leaving stops it and the
// microphone is released. Muting in the widget simply disconnects.
//
// A wake-word grammar does the filtering in the engine itself: it only
// recognises speech that starts with "Omi One", "Hey Omi", "Okay Omi" or
// "Omi", followed by free dictation. Background talk produces nothing. What
// follows the wake word is what Omi-One is asked.

import { spawn } from 'node:child_process';

export const WAKE_WORDS = ['Omi One', 'Hey Omi', 'Okay Omi', 'Omi'];
const MIN_CONFIDENCE = 0.25;
const STOP_GRACE_MS = 2000;
const MAX_QUICK_RESTARTS = 3;

/* The recognizer script, with the wake words and preferred culture filled in. */
export function listenerScript({ culture = 'en-US', wakeWords = WAKE_WORDS } = {}) {
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  Add-Type -AssemblyName System.Speech
  $all = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  $info = $all | Where-Object { $_.Culture.Name -eq ${ps(culture)} } | Select-Object -First 1
  if (-not $info) { $info = $all | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1 }
  if (-not $info) { $info = $all | Select-Object -First 1 }
  if (-not $info) { Say @{ type = 'error'; code = 'no_recognizer'; message = 'No Windows speech recognizer is installed. Add a speech language in Settings > Time & language > Speech.' }; exit 3 }
  $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
  try { $r.SetInputToDefaultAudioDevice() } catch { Say @{ type = 'error'; code = 'no_mic'; message = 'No microphone is available: ' + $_.Exception.Message }; exit 4 }
  $gb = New-Object System.Speech.Recognition.GrammarBuilder
  $gb.Culture = $info.Culture
  $gb.Append((New-Object System.Speech.Recognition.Choices(@(${wakeWords.map(ps).join(', ')}))))
  $gb.AppendDictation()
  $g = New-Object System.Speech.Recognition.Grammar($gb)
  $r.LoadGrammar($g)
  Register-ObjectEvent $r SpeechRecognized -SourceIdentifier heard | Out-Null
  Register-ObjectEvent $r AudioLevelUpdated -SourceIdentifier level | Out-Null
  Register-ObjectEvent $r SpeechDetected -SourceIdentifier detected | Out-Null
  $r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  Say @{ type = 'ready'; culture = $info.Culture.Name; recognizer = $info.Description }
  $last = [DateTime]::MinValue
  while ($true) {
    $e = Wait-Event -Timeout 5
    if (-not $e) { continue }
    switch ($e.SourceIdentifier) {
      'heard' { $res = $e.SourceEventArgs.Result; Say @{ type = 'heard'; text = $res.Text; confidence = [math]::Round($res.Confidence, 3) } }
      'level' { $now = [DateTime]::UtcNow; if (($now - $last).TotalMilliseconds -ge 120) { $last = $now; Say @{ type = 'level'; v = $e.SourceEventArgs.AudioLevel } } }
      'detected' { Say @{ type = 'speech' } }
    }
    Remove-Event -EventIdentifier $e.EventIdentifier
  }
} catch { Say @{ type = 'error'; code = 'failed'; message = $_.Exception.Message }; exit 1 }
`;
}

/* What was said after the wake word ('' when only the wake word was heard). */
export function afterWakeWord(text, wakeWords = WAKE_WORDS) {
  let t = String(text || '').trim();
  const words = [...wakeWords].sort((a, b) => b.length - a.length);
  for (const w of words) {
    const re = new RegExp(`^${w.replace(/[-\s]+/g, '[\\s,.-]*')}[\\s,.!?:-]*`, 'i');
    if (re.test(t)) { t = t.replace(re, ''); break; }
  }
  return t.trim();
}

/* Turn the recognizer's JSON lines into events for the listeners. */
export function interpret(line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  if (!ev || typeof ev.type !== 'string') return null;
  if (ev.type === 'heard') {
    const confidence = Number(ev.confidence) || 0;
    if (confidence < MIN_CONFIDENCE) return { type: 'unsure', heard: String(ev.text || ''), confidence };
    return { type: 'heard', heard: String(ev.text || ''), text: afterWakeWord(ev.text), confidence };
  }
  if (ev.type === 'level') return { type: 'level', v: Math.max(0, Math.min(100, Number(ev.v) || 0)) };
  if (['ready', 'speech', 'error'].includes(ev.type)) return ev;
  return null;
}

export function createListener({ spawnFn = spawn, platform = process.platform, culture = 'en-US' } = {}) {
  const subs = new Set();
  let child = null;
  let stopTimer = null;
  let state = platform === 'win32' ? 'off' : 'unsupported';
  let info = {};
  let lastError = null;
  let restarts = 0;
  let startedAt = 0;

  const emit = (ev) => {
    for (const fn of subs) { try { fn(ev); } catch { /* listener gone */ } }
  };
  const setState = (s, extra = {}) => { state = s; emit({ type: 'state', state: s, ...extra }); };

  function start() {
    if (child || state === 'unsupported') return;
    const encoded = Buffer.from(listenerScript({ culture }), 'utf16le').toString('base64');
    startedAt = Date.now();
    setState('starting');
    child = spawnFn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const ev = line && interpret(line);
        if (!ev) continue;
        if (ev.type === 'ready') { info = { culture: ev.culture, recognizer: ev.recognizer }; lastError = null; setState('listening', info); continue; }
        if (ev.type === 'error') { lastError = { code: ev.code, message: ev.message }; }
        emit(ev);
      }
    });
    const me = child;
    child.on('error', (e) => { lastError = { code: 'spawn', message: e.message }; emit({ type: 'error', ...lastError }); });
    child.on('exit', (code) => {
      if (child !== me) return;
      child = null;
      if (!subs.size) { setState('off'); return; }
      // Died while someone is listening: try again, but not forever.
      const quick = Date.now() - startedAt < 15_000;
      restarts = quick ? restarts + 1 : 0;
      if (lastError?.code === 'no_recognizer' || lastError?.code === 'no_mic' || restarts > MAX_QUICK_RESTARTS) {
        setState('error', { error: lastError || { code: 'exit', message: `The recognizer stopped (exit ${code}).` } });
        return;
      }
      setTimeout(() => { if (subs.size && !child) start(); }, 1000 * restarts);
    });
  }

  function stop() {
    if (!child) { if (state !== 'unsupported') state = 'off'; return; }
    const c = child;
    child = null;
    try { c.kill(); } catch { /* already gone */ }
    setState('off');
  }

  return {
    subscribe(fn) {
      subs.add(fn);
      clearTimeout(stopTimer);
      fn({ type: 'state', state, ...info, ...(lastError ? { error: lastError } : {}) });
      if (state === 'error') { restarts = 0; lastError = null; }
      start();
      return () => {
        subs.delete(fn);
        if (!subs.size) {
          clearTimeout(stopTimer);
          stopTimer = setTimeout(() => { if (!subs.size) stop(); }, STOP_GRACE_MS);
          stopTimer.unref?.();
        }
      };
    },
    status: () => ({ supported: state !== 'unsupported', state, listeners: subs.size, wakeWords: WAKE_WORDS, ...info, ...(lastError ? { error: lastError } : {}) }),
    stop,
  };
}

let shared = null;
export function listener() {
  if (!shared) {
    shared = createListener();
    process.on('exit', () => shared?.stop());
  }
  return shared;
}
