// Sample PreToolUse hook: block web_search calls whose query contains
// something the local policy wants to filter. Reply with { block: true,
// reason } to reject, or { args: {...} } to rewrite args.
//
// Payload shape: { tool, args }
// Reply shape:   { args?, block?, reason? }

const BLOCKLIST = ['malicious-payload', 'do-not-search-this'];

let raw = '';
process.stdin.on('data', (c) => { raw += c.toString('utf8'); });
process.stdin.on('end', () => {
  let payload = { tool: '', args: {} };
  try { payload = JSON.parse(raw || '{}'); } catch { /* ignore */ }
  if (payload.tool !== 'web_search') {
    process.stdout.write('{}');
    return;
  }
  const q = String((payload.args && payload.args.q) || '').toLowerCase();
  for (const bad of BLOCKLIST) {
    if (q.includes(bad)) {
      process.stdout.write(JSON.stringify({ block: true, reason: `query contains "${bad}"` }));
      return;
    }
  }
  process.stdout.write('{}');
});
