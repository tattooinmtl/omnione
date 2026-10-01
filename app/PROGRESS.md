# OmniOne — Progress

The bar is a modern coding-agent harness (Claude Code / kimi-code / pi /
opencode). The plan and the full gap list live in the audit; this file tracks
what is actually built and verified.

Last update: Phases 0-2, hardening, 4 and 5 complete. Phase 3 (IDE shell) open.

## Correction to the previous scoring

An earlier version of this file scored 6 of 8 pieces as "won". That was too
generous, and two of the claims were wrong:

- **Tool calling was scored "won". It did not work.** `/api/generate` let the
  model finish, then regex-scanned the finished text for `<!-- TOOL: -->`
  markers, ran them, and sent the results *to the browser*. The model never
  saw them, so a tool call was a dead end — while the system prompt told the
  model "the harness will run them and continue the generation with the
  results in your context".
- **MCP was scored "won". No server could ever connect.** The stdio client
  framed messages LSP-style with `Content-Length` headers; the MCP stdio
  transport is newline-delimited JSON. `initialize` never resolved. The
  shipped config was empty, so this was never exercised.

Both are fixed and covered by tests that fail against the old code.

## Phase 0 — foundations ✅

| Piece | Status | Notes |
|---|---|---|
| Version control | done | `git init`, ignore rules for secrets, token, sessions, checkpoints. |
| Loopback auth | done | `.gwn-token` shared secret injected by the Vite proxy (so the browser never sees it and EventSource still authenticates), `Host`-header check against DNS rebinding, explicit `127.0.0.1` bind. Previously any page in any browser could POST `/api/tools/run`. |
| Skill-upload path traversal | done | `safeRelativePath` + a resolved-path containment check. An `originalname` of `a/../../../../evil.js` used to write outside the staging dir. |
| MCP stdio transport | done | NDJSON framing, 30s request timeout, stderr captured into error messages. Verified against `@modelcontextprotocol/server-filesystem`: 14 tools listed, `list_directory` called end to end. |
| MCP on Windows | done | `resolveSpawn` routes `npx` (and any `.cmd`/`.bat`) through `cmd.exe /d /s /c`. Every published MCP config uses `npx`, and all of them died on `spawn npx ENOENT`. |
| Upload temp handling | done | One temp dir per request instead of one per file, so cleanup no longer leaked all but one. |
| Route ordering | done | Skill routes were registered *after* `app.listen`. Boot moved to the end; `app` exported for tests. |
| Model resolution | done | `/api/settings` and `/api/generate` resolved the model differently, so Settings could show one model while generation used another. Both call `resolveModel()`. |
| Test harness | done | vitest + supertest. |

## Phase 1 — the agentic loop ✅

| Piece | Status | Notes |
|---|---|---|
| Tool loop | done | `server/agent.js`: model → tool calls → results appended as messages → model again, up to 25 turns. Stops cleanly at the cap and says so rather than pretending it finished. |
| Native tool calling | done | OpenAI `tools` + streamed `tool_calls` deltas; Anthropic `tools` + `tool_use` / `tool_result` blocks. The HTML-comment marker protocol is gone. |
| Tool registry | done | `server/toolRegistry.js` owns each tool's JSON Schema, handler and permission class, and renders both providers' formats. MCP tools register as `mcp__<server>__<tool>` so they cannot shadow a built-in. |
| Conversation memory | done | `server/sessions.js`, one append-only JSONL transcript per session. `/api/sessions` lists, reads, deletes and forks. Every turn used to be turn one. |
| Retry & backoff | done | Exponential backoff with jitter on 408/429/5xx, honouring `Retry-After`. |
| Context overflow recovery | done | `compactMessages` drops the middle, keeps the task and the recent tail, and never orphans a `tool_use` from its result — a naive slice turns an overflow into a hard 400. |
| Prompt caching | done | Anthropic `cache_control` on the system block; the OpenAI path keeps the system prefix byte-stable so prefix caching applies. |
| Usage telemetry | done | Real token counts from the provider, streamed as `usage` events and recorded in the transcript. |
| Client | done | `AiPanel` sends `sessionId`, renders each tool call in the trace, and takes the final turn's text (not every turn concatenated) as the project output. `/new` starts a fresh conversation. |

### One bug worth remembering

The first live run produced nothing but a `session` event. The abort
controller listened on `req.on('close')`, which Node fires as soon as the
request *body* has been read — immediately, for a POST. Every run was
cancelled before the first model call, silently, because the loop checks
`signal.aborted` and returns. It must be `res.on('close')`. Covered by
`tests/generate.test.js`.

## Phase 2 — workspace, filesystem and shell ✅

The agent works on real files now. The "project" used to be a
`{filename: string}` map in React state persisted to localStorage, with no
way out but Save-JSON and Download-ZIP.

| Piece | Status | Notes |
|---|---|---|
| Workspace | done | `server/workspace.js`. One root, set via `/api/workspace`, default `./workspace`. Every agent-supplied path is resolved and checked for containment — including drive-relative (`C:evil`) and UNC forms, and paths that reach out through a symlink. |
| Ignore rules | done | `.gitignore` + `.agentignore`, with globs, anchoring, directory-only rules and negation. `.git`, `node_modules`, `.sessions` and `.checkpoints` are always hidden. |
| fs tools | done | `read_file` (numbered lines, offset/limit, binary and size refusal), `write_file`, `edit_file`, `list_dir`, `glob`, `grep` (ripgrep when installed, JS fallback otherwise). |
| edit_file contract | done | Exact-string replace, refused when the snippet is missing or ambiguous. Line numbers drift; a model-authored diff that will not apply fails in ways that are hard to report back. |
| Shell | done | `bash` with workspace cwd, timeout, middle-truncated output, and background jobs (`bash_output`, `bash_kill`). |
| Permissions | done | `server/permissions.js`. Modes: plan / default / acceptEdits / bypass. Reads always run; writes and commands ask. An approval prompt streams over the same SSE channel and the run *pauses* until the user answers. Unanswered prompts deny after 5 minutes rather than parking the run. "Allow for this session" is scoped to the exact command, so approving `npm test` does not also approve `rm -rf /`. |
| Checkpoints | done | `server/checkpoints.js`. Files are snapshotted before every write; reverting restores them and deletes files the agent created. `/api/checkpoints/:id/revert`. |

### The bug this phase turned up

A 700ms timeout on a hung command took **19 seconds** to return.
`spawn(cmd, { shell })` starts `cmd.exe`, which starts the real command;
killing the shell left the command running with the stdio pipes open, so
`'close'` never fired. In other words the timeout did not actually stop
anything — exactly the failure mode it exists to prevent. Now killed as a
process tree (`taskkill /T /F` on Windows, process-group signal elsewhere);
the same test returns in under a second.

## Hardening pass — holes found and patched ✅

A full sweep over the pipeline after Phase 2, plus the session-resume and
search-log work that landed alongside it.

| Hole | Why it mattered | Fix |
|---|---|---|
| **The whole test suite was dead.** `searchLog.js` did `import { DatabaseSync } from 'node:sqlite'`. `node:sqlite` is experimental, so it is absent from `module.builtinModules` under its bare name; Vite strips the `node:` prefix, looks for "sqlite", finds nothing, and fails the transform. 10 of 11 test files could not load. | Nothing was being verified. | Load it through `createRequire`, invisible to that resolver, inside the existing try/catch. |
| **A hook that never exited hung the harness.** `runOne` spawned the script with no timeout and no kill. `UserPromptSubmit` blocks the first model call and `PreToolUse` blocks every tool. | One bad script and every run wedged, with no diagnostic and no way out but restarting the server. | 10s timeout (env-overridable), process-tree kill, output capped at 256KB. |
| **`web_search` and `browser_open` used bare `fetch`.** No timeout, no body cap. | A server that accepts the connection then says nothing parked the agent loop indefinitely — no error, no progress. | 30s deadline, 5MB body cap, and the run's `AbortSignal` threaded through. |
| **`browser_open` accepted any scheme**, including `file://`. | A way straight around the workspace containment every filesystem tool enforces. | http/https only. |
| **Cancelling a run did not stop its tools.** The signal never reached `executeTool`. | Stopping during a build left the compiler running, burning CPU and still writing to the workspace. | `ctx.signal` plumbed into the registry, the network tools and `bash`, which kills its process tree on abort. |
| **No stop button.** The client built an `AbortController` and never aborted it. | A run could not be cancelled at all. | Stop button replaces Send while running; Esc also stops. Aborting the fetch closes the response, which the server turns into the run's abort. |
| **Two runs on one session corrupted it.** No lock. | Interleaved appends produce a `tool_use` with no result and a user message mid-tool-loop. Both providers reject that on the next turn, so the session is bricked rather than merely confused. | Per-session run lock; a concurrent `/api/generate` gets a 409. Released in `finally`, so no exit path can leave a session stuck busy. |
| **`listSessions` crashed on a concurrent delete.** `readdir` gives a snapshot; the `statSync` that followed sat outside the try. | One vanishing session turned the whole endpoint into a 500. | Stat moved inside the guard, in both `listSessions` and `findLatestSessionForWorkspace`. |
| **Skills were unreachable by the agent.** The folder, scanner, REST API and UI all existed, but there was no tool — the only way a skill entered context was the user pasting it in. The system prompt referred to `[SKILL: ...]` blocks the model had no way to obtain. | The feature was half-built: a database the agent was blind to. | `list_skills`, `load_skill`, `load_skill_file`, plus a name-and-description index in the system prompt so the model knows to look. Bodies load on demand — sending them all would spend the window on tasks nobody asked about. |
| **Unknown `/api` paths returned HTML.** | A client doing `await r.json()` sees a crash, not an error it can report. | JSON 404 and a JSON error handler, registered after every route. |
| **The search log was write-only** and unbounded. | Nothing could read it; the table grew forever. | `GET /api/tools/searches`, and a 5000-row cap trimmed periodically. |

Also fixed: a stopped run never dispatched a result, so the composer stayed
disabled forever; `/new` now stops the run in flight rather than walking away
from a session still being written to; and `hooks.js` gained a test-only
directory override, because test hooks written into the real `hooks/` fired
inside other suites' agent runs.

## Phase 4 — skills, subagents, self-evolution ✅

Closes the gap to Hermes Agent. The harness could load skills but never write
one, and could remember the current conversation but nothing before it.

| Piece | Notes |
|---|---|
| `todo_write` / `todo_read` | A task list the model maintains. Long tasks drift — it finishes step two, forgets four and five existed, and declares victory. Exactly one item may be `in_progress`. |
| `search_memory` / `recall_session` | Full-text across every transcript. Solve something Tuesday and the agent had no idea on Friday. Plain scanning, not an index: a few hundred files is milliseconds, and an index is another thing to corrupt. |
| `task` + subagents | Delegate a sub-job to a nested loop with its own context and tool subset, returning one summary. Fifteen greps inline is fifteen tool results in the conversation forever. A subagent never gets `task` (recursion turns one prompt into a bill) and runs under the parent's permission mode. |
| Auto skill creation | After a substantial run the agent reviews its own transcript and proposes reusable skills. |
| `DraftsModal` | The human gate: review the instructions and the evidence, approve or reject with a reason. |

**Three constraints make self-evolution safe:**

1. Output goes to `skills/_drafts/`, never `skills/`. The scanner skips that
   folder, so a proposal is inert — not listed, not loadable — until approved.
   An agent that teaches itself a mistake repeats it in every later session.
2. Rejections are logged with their reason and fed back into the next pass.
   Without that the same draft returns after every session and the human says
   no forever.
3. One reflection per session, and only above 6 tool calls. A two-turn chat
   has nothing to teach. It fires after the response is sent, so it never
   delays an answer. `GWN_AUTO_REFLECT=0` disables it.

## Phase 5 — boards ✅

| Piece | Notes |
|---|---|
| Detection | USB VID/PID, not friendly names. Reports a **confidence level**: most ESP32 boards use a separate bridge chip, so a CP2102 id identifies the bridge and says nothing about the MCU behind it. |
| UF2 volumes | An RP2040 in BOOTSEL is a drive, not a serial port — invisible to port enumeration. |
| Toolchains | Prefers what is installed. Verified live on this machine: found arduino-cli 1.5.1 and esptool 5.3.0, flagged platformio and mpremote missing with install commands, and correctly reported the missing `esp32:esp32` core with its three setup commands. |
| Drivers | `pnputil /enum-devices /problem` tells "nothing plugged in" apart from "plugged in with no driver, so no COM port appears" — which every other tool reports identically as "no board found". Never installs: that needs elevation and can brick a working setup. |

16 board tools: `board_list`, `board_doctor`, `board_setup`, `board_compile`,
`board_upload`, `board_flash_uf2`, `esp_chip_info`, `esp_erase_flash`,
`mpy_push`, `mpy_run`, `board_monitor`, `board_send`, `pi_run`, `pi_ping`,
`pi_put`, `pi_get`.

**Not yet verified against hardware.** Identification, toolchain discovery,
driver diagnosis and input validation are tested; compiling, flashing and
monitoring need the boards plugged in. The physical checklist is in the plan.

## Phase 6 — a mind, and a face ✅

The agent used to exist only while a request was open. Now it persists.

| Piece | Notes |
|---|---|
| Loop upgrades | Consecutive read-only calls run in parallel; the same call repeated 3× in a run gets a "step back" note (after the OpenHands stuck detector); compaction summarises the dropped middle with the model instead of discarding it, and fires proactively at 80% of the window; a model that stops with unfinished todos is nudged once. |
| Identity | `mind/SOUL.md` — user-authored, read every turn, not writable by the agent. |
| Memory | Core blocks (persona / human / project / scratch) the agent rewrites itself, with hard size limits (after Letta/MemGPT). A memory stream ranked by recency × importance × relevance (after Generative Agents). Every conversation is recorded as an episode without a model call. |
| Mood | Valence and energy, nudged by what happens (errors, finished runs, running out of turns), drifting back to baseline with a 6 h half-life. In the prompt every turn. |
| Goals & proposals | Self-adopted goals (after BabyAGI) and an inbox of things it wants to do but may not do alone. |
| Heartbeat | Wakes on a schedule when nobody is working, in the new `autonomous` permission mode: reads and checkpointed edits run, commands and paid calls are refused and go to the inbox. Bounded by a turn cap per beat and a daily token budget. `GWN_HEARTBEAT=0` disables. |
| Presence | Three.js wireframe head (parametric, no model file) with glowing lids, particles and bloom; a live voice waveform; an emotion-core filament sphere. One emotion engine turns run events, mood and the intent of each reply into expression, gesture and vocal delivery. Voice out via MiniMax TTS through a Web Audio analyser (mouth follows the real audio), browser speech as fallback; voice in via SpeechRecognition. |

Mind state lives in `.gwn-mind/` (gitignored). Tests point it at a temp dir.

## Verification

```bash
npm test          # 261 tests
npm run build
npm run dev       # Vite :5174 + API :5180
```

Live checks that were run:

```bash
T=$(cat .gwn-token)

# Auth gate
curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5180/api/health     # 200
curl -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5180/api/providers  # 401
curl -o /dev/null -w "%{http_code}\n" -H "x-gwn-token: $T" \
  http://127.0.0.1:5180/api/providers                                      # 200

# MCP against a real server (add it to .gwn-mcp.json first)
curl -X POST -H "x-gwn-token: $T" http://127.0.0.1:5180/api/mcp/reload
curl -H "x-gwn-token: $T" http://127.0.0.1:5180/api/mcp/tools

# A full run, and a follow-up in the same conversation
curl -N -X POST -H "x-gwn-token: $T" -H 'Content-Type: application/json' \
  -d '{"prompt":"make a bouncing ball"}' http://127.0.0.1:5180/api/generate
curl -H "x-gwn-token: $T" http://127.0.0.1:5180/api/sessions

# The workspace loop: write a file, run it, search it, list the tree
curl -X POST -H "x-gwn-token: $T" -H 'Content-Type: application/json' \
  -d '{"name":"write_file","args":{"path":"demo/hello.py","content":"print(1+1)\n"}}' \
  http://127.0.0.1:5180/api/tools/run
curl -X POST -H "x-gwn-token: $T" -H 'Content-Type: application/json' \
  -d '{"name":"bash","args":{"command":"python demo/hello.py"}}' \
  http://127.0.0.1:5180/api/tools/run
curl -H "x-gwn-token: $T" http://127.0.0.1:5180/api/workspace/tree

# Containment (both refused)
curl -X POST -H "x-gwn-token: $T" -H 'Content-Type: application/json' \
  -d '{"name":"read_file","args":{"path":"../.gwn-token"}}' \
  http://127.0.0.1:5180/api/tools/run
```

## Next

**Phase 3 — the IDE shell** is the main thing left: file tree, diff review,
terminal panel, git panel, LSP diagnostics. The server side is ready; this is
the UI that exposes it. The editor still shows the preview project rather
than the workspace on disk.

**Phase 5 hardware verification** needs you present with the boards. The
checklist: plug in the ESP32 and confirm `board_list` names the chip and port;
blink an LED end to end (compile, upload, monitor); Pico in BOOTSEL flashed by
UF2; MicroPython round-trip with `mpy_push`/`mpy_run`; Pi Zero 2 W over
`pi_ping`/`pi_run`.

Also open from the audit: headless CLI, image input, MCP SSE/HTTP transports,
model catalog fetch, `/compact`, the remaining hook events, and a headless
browser for `browser_open`.

The approval prompt does render in the UI (`ApprovalModal`): it shows the
exact command, the content about to be written, or the before/after of an
edit, with Allow once / Allow for this session / Deny. Enter allows once and
Esc denies; neither shortcut can grant a session-wide allow by accident.

What is *not* in the UI yet, and is Phase 3's job: the file tree, the
diff view for reviewing a batch of edits after the fact, the terminal panel,
the git panel, and LSP diagnostics. The editor still shows the preview
project rather than the workspace on disk, so for now the workspace is best
driven through the agent and inspected with `/api/workspace/tree`.
