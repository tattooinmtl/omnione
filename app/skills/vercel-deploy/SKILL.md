---
name: vercel-deploy
description: Put a site or web app from the workspace online with Vercel, check the build, fix failures from the logs, and go live or roll back. Use when the user says deploy, publish, put it online, host it, go live, Vercel, preview link, or a Vercel build failed.
---

# Deploying with Vercel

Tools: `vercel_projects`, `vercel_deployments`, `vercel_status`, `vercel_logs` (look, run
freely), `vercel_deploy`, `vercel_redeploy`, `vercel_promote` (publish, always ask the user).

## Not connected?

If a tool says Vercel isn't connected, tell the user: Settings → Connections → Vercel, create
a token at vercel.com/account/tokens (free), paste it, Connect. Don't ask for the token in chat.

## Deploy

1. **Find the folder.** The project root (where `package.json` is) for Next.js, Vite, Astro,
   SvelteKit, Nuxt, Remix: Vercel builds it. For a plain HTML/CSS/JS site, the folder with
   `index.html`. Make sure it works locally first if you can (`npm run build`).
2. **Preview first**: `vercel_deploy` with `target: "preview"` (default). Name the project
   after the site (lowercase, dashes). Never deploy the whole workspace root by accident.
3. **Watch the build**: `vercel_status` every 15-30 seconds until `READY` or `ERROR`. Small
   static sites take seconds; framework builds 30 s to a few minutes.
4. **READY**: give the user the URL. Preview links are protected by Vercel: they open for
   the user while signed in to Vercel, and redirect to a login for anyone else (and for
   `browser_open`). Production addresses (`<project>.vercel.app`, in `vercel_status` aliases)
   are public.
   If the result has a `warning` that Vercel put it on production, tell the user it is live.
5. **Production only when the user says so**: either `vercel_promote` the READY preview
   (no rebuild, instant) or `vercel_deploy` with `target: "production"`.

## When the build fails

`vercel_logs` with `errors_only: true`, then the last 120 lines if that isn't enough.
Common causes:

| Log says | Fix |
|---|---|
| `Module not found` / `Cannot find module` | Missing dependency in `package.json`, or wrong import path case (Vercel builds on Linux: `Header.jsx` ≠ `header.jsx`) |
| `command "npm run build" exited with 1` | Run the build locally, fix the first error it prints |
| `No Output Directory named "dist"` | Wrong framework detected: pass `framework` (e.g. `"vite"`), or deploy the built folder with `framework: "static"` |
| Missing `process.env.X` / API keys | Environment variables live on Vercel (project settings), not in `.env` files: `.env` is never uploaded. Tell the user to add them, then `vercel_redeploy` |
| 404 on refresh in a single-page app | Add `vercel.json` with `{"rewrites": [{"source": "/(.*)", "destination": "/index.html"}]}` |

Fix, deploy a new preview, check again.

## Roll back

`vercel_deployments` with `project` and `target: "production"`, pick the last good READY one,
`vercel_promote` it (asks the user).

## Never

- Deploy to production without the user asking.
- Put secrets in files you deploy. `.env` files, `.gwn-*` files and `node_modules` are skipped
  automatically, but a key pasted into a `.js` file would go online.
