// Vercel tools for Omi-One. Looking (projects, deployments, logs) runs
// freely; deploying, redeploying and promoting publish something on the web,
// so they always ask the user first and never run on their own (heartbeat,
// scheduled tasks).

import { registerTool } from '../toolRegistry.js';
import { resolveInWorkspace, toWorkspaceRelative } from '../workspace.js';
import {
  listProjects, listDeployments, getDeployment, getBuildLogs, deployFolder, redeploy, promote, vercelStatus, VercelError,
} from '../vercel.js';

const wrap = (fn) => async (args = {}, ctx = {}) => {
  try {
    return { ok: true, result: await fn(args, ctx) };
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    if (e instanceof VercelError) return { ok: false, error: e.message };
    throw e;
  }
};

registerTool({
  name: 'vercel_projects',
  description: 'List the Vercel projects of the connected account (or team): name, framework, production URL, latest deployment state. Vercel must be connected in Settings → Connections.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      search: { type: 'string', description: 'Filter by name.' },
      limit: { type: 'integer', default: 20 },
    },
  },
  handler: wrap((a, ctx) => {
    if (!vercelStatus().connected) throw new VercelError('Vercel is not connected. Ask the user to add a token in Settings → Connections → Vercel (vercel.com/account/tokens, free).');
    return listProjects(a, ctx);
  }),
});

registerTool({
  name: 'vercel_deployments',
  description: 'List recent Vercel deployments, optionally for one project: id, state (BUILDING, READY, ERROR…), target (production/preview), URL.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project name or id.' },
      target: { type: 'string', enum: ['production', 'preview'] },
      limit: { type: 'integer', default: 10 },
    },
  },
  handler: wrap((a, ctx) => listDeployments(a, ctx)),
});

registerTool({
  name: 'vercel_status',
  description: 'Check one deployment: state (QUEUED, BUILDING, READY, ERROR, CANCELED), URL, aliases, error. Call it every 15-30 seconds after vercel_deploy until it is READY or ERROR.',
  permission: 'read',
  schema: { type: 'object', properties: { deployment: { type: 'string', description: 'Deployment id or URL.' } }, required: ['deployment'] },
  handler: wrap((a, ctx) => getDeployment(a.deployment, ctx)),
});

registerTool({
  name: 'vercel_logs',
  description: 'Read the build log of a deployment, newest lines last. Use errors_only to find why a build failed.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      deployment: { type: 'string', description: 'Deployment id or URL.' },
      limit: { type: 'integer', default: 120, description: 'Lines from the end.' },
      errors_only: { type: 'boolean', default: false },
    },
    required: ['deployment'],
  },
  handler: wrap((a, ctx) => getBuildLogs(a.deployment, { limit: a.limit, errorsOnly: a.errors_only }, ctx)),
});

registerTool({
  name: 'vercel_deploy',
  description: 'Deploy a folder from the workspace to Vercel (creates the project if it doesn\'t exist; detects Next.js, Vite, Astro, SvelteKit… from package.json, otherwise serves it as a static site). target "preview" (default) gives a test URL; "production" updates the live site: only when the user asked for production. Secrets (.env), node_modules and .git are never uploaded. Then follow it with vercel_status.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      folder: { type: 'string', description: 'Workspace folder to deploy, e.g. "." or "my-site" or "my-app/dist".' },
      project: { type: 'string', description: 'Vercel project name. Default: the folder name.' },
      target: { type: 'string', enum: ['preview', 'production'], default: 'preview' },
      framework: { type: 'string', description: 'Override the detected framework (e.g. "nextjs", "vite"); "static" for none.' },
    },
    required: ['folder'],
  },
  handler: wrap(async (a, ctx) => {
    const root = resolveInWorkspace(a.folder || '.');
    const framework = a.framework === 'static' ? null : a.framework;
    const d = await deployFolder(root, { project: a.project, target: a.target || 'preview', framework }, ctx);
    return { ...d, folder: toWorkspaceRelative(root) || '.', next: 'Building now. Check with vercel_status every 15-30 s; on ERROR read vercel_logs with errors_only.' };
  }),
});

registerTool({
  name: 'vercel_redeploy',
  description: 'Build an existing deployment again (same files), e.g. after changing environment variables on Vercel. target "production" to make it live.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      deployment: { type: 'string', description: 'Deployment id or URL to rebuild.' },
      target: { type: 'string', enum: ['preview', 'production'] },
    },
    required: ['deployment'],
  },
  handler: wrap((a, ctx) => redeploy(a.deployment, { target: a.target }, ctx)),
});

registerTool({
  name: 'vercel_promote',
  description: 'Make an existing (READY) deployment the live production version of its project, without rebuilding. Also how to roll back: promote an older deployment.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project name or id.' },
      deployment: { type: 'string', description: 'Deployment id.' },
    },
    required: ['project', 'deployment'],
  },
  handler: wrap((a, ctx) => promote(a.project, a.deployment, ctx)),
});
