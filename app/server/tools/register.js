// Importing this module registers every built-in tool.
//
// It exists as a separate file to keep the import graph acyclic: each tool
// module imports `registerTool` from ../toolRegistry.js, so the registry
// cannot import them back. Anything that needs the full tool set — the
// server, the agent loop, the tests — imports this instead.

import './fs.js';
import './shell.js';
import './skills.js';
import './todo.js';
import './memory.js';
import './task.js';
import './boards.js';
import './pi.js';
import './media.js';
import './mind.js';
import './forum.js';
import './pc.js';
import './fixes.js';
import './computer.js';
import './projects.js';
