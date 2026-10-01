// Sample UserPromptSubmit hook: strip any "system:" or "assistant:" tags the
// user accidentally pasted into the prompt so they don't leak through to
// the model as spoofed role messages. The full payload arrives on stdin
// as JSON; reply with a JSON object on stdout to rewrite the prompt.
//
// Payload shape: { prompt, currentCode, provider, model }
// Reply shape:    { prompt?, currentCode?, block?: boolean, error?: string }

let raw = '';
process.stdin.on('data', (c) => { raw += c.toString('utf8'); });
process.stdin.on('end', () => {
  let payload;
  try { payload = JSON.parse(raw || '{}'); }
  catch { payload = { prompt: raw || '' }; }

  const before = String(payload.prompt || '');
  const after = before
    .replace(/^\s*(system|assistant|user)\s*:\s*/gim, '')
    .replace(/\n\s*(system|assistant|user)\s*:\s*/g, '\n');

  if (after === before) {
    // No change. Output empty JSON to signal "no rewrite".
    process.stdout.write(JSON.stringify({}));
    return;
  }
  process.stdout.write(JSON.stringify({ prompt: after }));
});
