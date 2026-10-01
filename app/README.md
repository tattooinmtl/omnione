# OmniOne — Agent Harness

OmniOne is a local AI agent with a mind of its own: a coding harness with
memory, moods, goals, a heartbeat, and a live face and voice. Single-page
React + Vite + Three.js app with a local Node server.

The development checkout still lives in `C:\VPS_GWN_Decentralized`; once
installed, OmniOne will live in the user's home folder at `~/.omnione`.

A small local Node proxy in `server/` runs alongside Vite so the React app
can call real AI providers (MiniMax, OpenAI, Anthropic) without exposing
your API key in the browser. OmniOne Local is the built-in no-key stub.

## Quick start

```bash
npm install
npm run dev            # starts Vite (:5174) + the API server (:5180) together
# → http://localhost:5174/
```

If you prefer them separate (e.g. when you only want the web shell):

```bash
npm run dev:web        # Vite only on :5174 (proxy /api -> :5180)
npm run dev:api        # Node proxy only on :5180
```

Production build:

```bash
npm run build
npm run preview
```

Dev server is on `:5174` (port `:5173` is occupied by another project on this
machine). The Vite `base` is `/`, so the same `dist/` build is intended to be
served at the site root of any host.

## Stack

- **React 18** + **Vite 5** (web shell)
- **Express 4** (local AI proxy on :5180, Vite proxies `/api/*` to it)
- **react-router-dom** for `/` (splash) and `/app` (agent harness)
- **three** + **@react-three/fiber** for the neural backdrop
- **@monaco-editor/react** for the code editor with file tabs
- **jszip** for the Download-ZIP action
- **concurrently** for `npm run dev`
- **Google Fonts** (Major Mono Display, Space Grotesk)

## What's in here

- **Splash** (`/`) — hero video, glitchy title, Three.js neural backdrop,
  ENTER button.
- **Agent Harness** (`/app`) — three **user-resizable** panels in a left-to-right row:
  1. **AI Prompt** (left) — provider-aware prompt input, chat history, live context meter,
     live trace steps + thinking
  2. **Preview** (center) — sandboxed iframe that renders the combined
     `index.html + style.css + *.js`
  3. **Code Editor** (right) — Monaco editor with one tab per file
     (`+` to add, `×` to delete)
- **Top bar** — SAVE (project.json), DOWNLOAD ZIP, ⚙ (Settings), ↩ (back to splash)
- **Settings modal** — provider + model + key, with the published token chart
  in a table the same way the reference project's profile page does

## AI providers

| Provider | API style | Key required | Notes |
| --- | --- | --- | --- |
| `gwn-local` | Built-in stub | No | Streams a working multi-file starter so the whole UI is exercisable end-to-end. |
| `minimax` | OpenAI-compatible | Yes | Base URL: `https://api.minimax.io/v1`. The platform's default. |
| `openai` | OpenAI | Yes | Base URL: `https://api.openai.com/v1`. gpt-4o / gpt-4o-mini. |
| `anthropic` | Anthropic Messages | Yes | Base URL: `https://api.anthropic.com/v1`. Claude Sonnet 4.5. |

Open the ⚙ Settings modal in the app, pick a provider, paste a key, and
click Save. The key is written to `.gwn-secrets.json` (mode `0o600`) in the
project root — the UI only ever sees a 4-character hint.

The Node proxy never logs the key. The browser only ever talks to the proxy
over `localhost`, so the key never leaves the machine.

### MiniMax media tools

The agent can also make videos and voice-overs with the same MiniMax key
([server/tools/media.js](server/tools/media.js)):

| Tool | What it does | Permission |
| --- | --- | --- |
| `video_generate` | Starts an H3 video task (`MiniMax-H3`: 768P/2K, 4–15s; `MiniMax-H3-Max`: 480P/768P, 5–15s). Optional first/last frame image URLs. | execute (costs credits) |
| `video_status` | Polls a task: queued, running, succeeded, failed, cancelled. | read |
| `video_download` | Saves a finished video into the workspace. Output links expire, so download promptly. | write |
| `text_to_speech` | Writes narration audio to the workspace via `/v1/t2a_v2`. Default model `speech-2.8-hd`; any MiniMax speech model ID can be passed. | execute (costs credits) |

## Architecture

```
Browser  ──── /api/* (Vite proxy) ────►  Node proxy  ──── HTTPS ────►  Provider
   │                                       │
   │                                       └─ reads .gwn-secrets.json
   │
   └─ React app, react-router, Monaco, Three.js, JSZip
```

Streaming flow:

1. User submits prompt in `AiPanel` → AppShell dispatches `gwn:request-generation`
2. `AiPanel` POSTs `/api/generate` with `{ prompt, currentCode }`
3. Server runs the active provider's adapter, streams SSE events
4. Each event (`step` / `thinking` / `delta` / `done` / `error`) is forwarded
   to the browser as `data: {...}\n\n`
5. `AiPanel` parses SSE, dispatches `gwn:generation-progress` for trace
   updates, accumulates text, and dispatches `gwn:generation-result` on done
6. `AppShell` ingests the final text, runs `parseFiles`, updates the editor
   tabs and preview iframe

## Reference patterns ported (read-only)

The following pieces were modelled on the C:\GameForgerAI project, not copied
verbatim. The original files were never modified:

| This project | GameForgerAI reference |
| --- | --- |
| `src/utils/gameFiles.js` | `client/src/utils/gameFiles.js` |
| `src/hooks/useProviderTokenBudget.js` | `client/src/hooks/useProviderTokenBudget.js` |
| `src/components/ContextMeter.{jsx,css}` | `client/src/components/ContextMeter.jsx` |
| `src/components/AiPanel.jsx` (prompt input) | `client/src/components/gs/PromptInput.jsx` |
| `src/components/SettingsModal.jsx` | `client/src/components/AiSettings.jsx` |
| `src/components/AppShell.jsx` (creator shell) | `client/src/pages/GameSimCreator.jsx` |

## Project layout

```
C:\VPS_GWN_Decentralized\
├── index.html
├── package.json
├── vite.config.js
├── .gitignore
├── .gwn-secrets.json             # created on first Save; mode 0600
├── public/
│   └── videos/
│       └── gwn-agent-harness.mp4
├── server/
│   ├── index.js                  # Express: /api/health, /providers, /settings, /generate
│   ├── secrets.js                # .gwn-secrets.json read/write
│   ├── providers.js              # provider catalog
│   ├── prompts.js                # system prompt (file marker format)
│   └── adapters.js               # OpenAI / Anthropic / MiniMax / stub stream adapters
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── styles/global.css
    ├── three/NeuralBackdrop.jsx
    ├── utils/
    │   ├── gameFiles.js          # parseFiles, combineForPreview, ...
    │   ├── projectIO.js          # saveProject, downloadZip
    │   └── projectStore.js       # default project + localStorage
    ├── hooks/
    │   └── useProviderTokenBudget.js
    └── components/
        ├── Splash.jsx + .css
        ├── AppShell.jsx + .css
        ├── AiPanel.jsx + .css
        ├── PreviewPanel.jsx + .css
        ├── CodeEditor.jsx + .css
        ├── ContextMeter.jsx + .css
        ├── SettingsModal.jsx + .css
        └── ComingSoon.{jsx,css}.obsolete  # old stub, no longer wired
```

## Next steps

1. Tool-calling harness: when the model emits `save_game_files` (or a custom
   tool), persist the result through the same `parseFiles` path the streaming
   response already uses.
2. Model catalogue fetch (OpenAI `/v1/models`, Anthropic `/v1/models`) so the
   Settings modal can offer a dropdown instead of a free-text field.
3. Import a `.gwn.json` back into the editor (the export side is already done).
4. Code execution sandbox for non-iframe runtimes (Web Workers for headless
   tests; sandboxed iframes already work for HTML/JS).

