// Sample PostToolUse hook: append every tool call to a rolling log file at
// logs/tools.log so you can audit what the AI did after a session.
//
// Payload shape: { tool, args, result, ok, durationMs }
// No reply needed; an empty JSON object tells the runner "no rewrite".

const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.on('data', (c) => { raw += c.toString('utf8'); });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(raw || '{}'); } catch { /* ignore */ }
  const line = JSON.stringify({
    at: new Date().toISOString(),
    tool: payload.tool,
    args: payload.args,
    ok: payload.ok,
    durationMs: payload.durationMs,
  }) + '\n';
  const dir = path.join(__dirname, '..', '..', 'logs');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const file = path.join(dir, 'tools.log');
  try { fs.appendFileSync(file, line); } catch { /* ignore */ }
  process.stdout.write('{}');
});
