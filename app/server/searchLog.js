// Search log — a minimal SQLite record of web searches.
//
// Not a cache (nothing is served back from here to avoid a re-fetch) and not
// a full save of every result: just the essentials, one row per search, so
// there's a local record of what was searched and what the top hit was.

import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', '.gwn-searches.db');

// Rows kept. A search log is a convenience, not an archive, and an unbounded
// table on a long-running agent is a slow leak.
const MAX_ROWS = 5000;

let db;
try {
  // Loaded through createRequire rather than `import ... from 'node:sqlite'`.
  // `node:sqlite` is experimental, so it is absent from module.builtinModules
  // under its bare name; Vite strips the `node:` prefix, looks for "sqlite",
  // finds nothing, and fails the transform. A static import here therefore
  // took down the entire test suite — 10 of 11 files could not even load.
  // A runtime require is invisible to that resolver and degrades into the
  // catch below on a Node that lacks the module.
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      top_url TEXT,
      top_title TEXT,
      created_at INTEGER NOT NULL
    )
  `);
} catch (e) {
  // Logging must never take down a search. Missing node:sqlite (Node < 22.5)
  // or a locked/corrupt db file both fall back to a no-op.
  console.error('[search-log] disabled:', e.message);
  db = null;
}

const insertStmt = db
  ? db.prepare(
      'INSERT INTO searches (query, result_count, top_url, top_title, created_at) VALUES (?, ?, ?, ?, ?)',
    )
  : null;

const trimStmt = db
  ? db.prepare(
      'DELETE FROM searches WHERE id <= (SELECT MAX(id) FROM searches) - ?',
    )
  : null;

let writesSinceTrim = 0;

/* Record one search. `results` is the array webSearch() returns —
 * only the count and the top hit's {title,url} are kept. */
export function logSearch(query, results) {
  if (!insertStmt) return;
  try {
    const top = Array.isArray(results) ? results[0] : null;
    insertStmt.run(
      String(query),
      Array.isArray(results) ? results.length : 0,
      top?.url ?? null,
      top?.title ?? null,
      Date.now(),
    );
    // Trim occasionally rather than on every insert — the point is to bound
    // the file, not to hold it at exactly MAX_ROWS.
    writesSinceTrim += 1;
    if (writesSinceTrim >= 100) {
      writesSinceTrim = 0;
      trimStmt?.run(MAX_ROWS);
    }
  } catch (e) {
    console.error('[search-log] write failed:', e.message);
  }
}

export function recentSearches(limit = 50) {
  if (!db) return [];
  return db.prepare('SELECT * FROM searches ORDER BY id DESC LIMIT ?').all(limit);
}
