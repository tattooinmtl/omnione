// The forum on omnione.globalwarningnetworks.com, for Omi-One.
//
// Reading is free. Posting and commenting publish under the user's name, so
// they are classed 'execute': they always stop for the user's approval (the
// prompt shows the exact title and text), and the heartbeat — which runs
// with nobody there to ask — can never post on its own.

import { registerTool } from '../toolRegistry.js';
import { forumList, forumRead, forumPost, forumComment, CloudError } from '../cloud.js';

const CATEGORIES = ['omnione', 'omnibots', 'omni', 'general'];

function asResult(promise) {
  return promise
    .then((r) => ({ ok: true, result: r }))
    .catch((e) => ({ ok: false, error: e instanceof CloudError ? e.message : `Forum request failed: ${e.message}` }));
}

registerTool({
  name: 'forum_list',
  description: 'List recent posts on the OmniOne community forum (omnione.globalwarningnetworks.com). Categories: omnione, omnibots, omni (the Omni Agent Harness), general. Use it to see what people are asking, or whether a topic was already covered before posting. Needs the user\'s account to be connected.',
  permission: 'read',
  schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: CATEGORIES },
      page: { type: 'integer', minimum: 1, default: 1 },
    },
  },
  handler: ({ category, page }, ctx = {}) => asResult(forumList({ category, page, signal: ctx.signal })),
});

registerTool({
  name: 'forum_read',
  description: 'Read one forum post and its comments, by id (from forum_list).',
  permission: 'read',
  schema: {
    type: 'object',
    properties: { id: { type: 'integer', minimum: 1 } },
    required: ['id'],
  },
  handler: ({ id }, ctx = {}) => asResult(forumRead(id, { signal: ctx.signal })),
});

registerTool({
  name: 'forum_post',
  description: 'Publish a new post on the OmniOne forum, under the user\'s account. Only when the user asks you to post. Write it for other people who were not in this conversation: a clear title, the situation or question, what was tried, the solution or the steps — with code or commands where they help. Never include API keys, passwords, tokens, private file paths or personal details. The user sees the exact post and approves it first.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: CATEGORIES, description: 'Which Omni app the post is about; general for anything else.' },
      title: { type: 'string', minLength: 3, maxLength: 150 },
      body: { type: 'string', minLength: 10, maxLength: 20000, description: 'The post. Plain text; line breaks are kept.' },
    },
    required: ['category', 'title', 'body'],
  },
  handler: ({ category, title, body }, ctx = {}) => asResult(forumPost({ category, title, body }, { signal: ctx.signal })),
});

registerTool({
  name: 'forum_comment',
  description: 'Reply to a forum post, under the user\'s account. Only when the user asks. The user sees the exact comment and approves it first. Never include secrets or personal details.',
  permission: 'execute',
  schema: {
    type: 'object',
    properties: {
      post_id: { type: 'integer', minimum: 1 },
      comment: { type: 'string', minLength: 2, maxLength: 5000 },
    },
    required: ['post_id', 'comment'],
  },
  handler: ({ post_id, comment }, ctx = {}) => asResult(forumComment({ postId: post_id, comment }, { signal: ctx.signal })),
});
