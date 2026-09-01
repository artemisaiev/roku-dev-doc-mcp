import Database from 'better-sqlite3';
import { dbPath } from './paths.js';

/** Bump when the schema changes; the local DB is a rebuildable mirror, so a
 *  mismatch just drops and re-syncs rather than requiring a real migration. */
const SCHEMA_VERSION = '1';

let db = null;

/**
 * Open (once) and return the SQLite handle, creating the schema if needed.
 * @returns {import('better-sqlite3').Database}
 */
export function getDb() {
  if (db) return db;

  db = new Database(dbPath());
  db.pragma('journal_mode = WAL'); // lets tools read while a sync writes
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  init(db);
  return db;
}

function init(conn) {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const current = conn
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get()?.value;

  if (current && current !== SCHEMA_VERSION) {
    conn.exec(`
      DROP TRIGGER IF EXISTS docs_ai;
      DROP TRIGGER IF EXISTS docs_ad;
      DROP TRIGGER IF EXISTS docs_au;
      DROP TABLE IF EXISTS docs_fts;
      DROP TABLE IF EXISTS docs;
      DELETE FROM meta WHERE key IN ('last_synced_sha', 'last_synced_at');
    `);
  }

  conn.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      path        TEXT PRIMARY KEY,
      title       TEXT,
      excerpt     TEXT,
      content     TEXT NOT NULL,
      sha         TEXT,
      bytes       INTEGER NOT NULL DEFAULT 0,
      updated_at  TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      path UNINDEXED,
      title,
      excerpt,
      content,
      content='docs',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );

    CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
      INSERT INTO docs_fts(rowid, path, title, excerpt, content)
      VALUES (new.rowid, new.path, new.title, new.excerpt, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, path, title, excerpt, content)
      VALUES ('delete', old.rowid, old.path, old.title, old.excerpt, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
      INSERT INTO docs_fts(docs_fts, rowid, path, title, excerpt, content)
      VALUES ('delete', old.rowid, old.path, old.title, old.excerpt, old.content);
      INSERT INTO docs_fts(rowid, path, title, excerpt, content)
      VALUES (new.rowid, new.path, new.title, new.excerpt, new.content);
    END;
  `);

  conn
    .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`)
    .run(SCHEMA_VERSION);
}

/* ------------------------------------------------------------------ meta */

/** @returns {string|undefined} */
export function getMeta(key) {
  return getDb().prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
}

export function setMeta(key, value) {
  getDb()
    .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    .run(key, String(value));
}

/* ------------------------------------------------------------------ reads */

export function countDocs() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM docs').get().n;
}

/** Map of path -> stored git blob sha, used by sync to detect changes. */
export function allShas() {
  const rows = getDb().prepare('SELECT path, sha FROM docs').all();
  return new Map(rows.map((r) => [r.path, r.sha]));
}

/**
 * @param {string} path
 * @returns {{path:string,title:string,excerpt:string,content:string,sha:string,bytes:number,updated_at:string}|undefined}
 */
export function getDoc(path) {
  return getDb().prepare('SELECT * FROM docs WHERE path = ?').get(path);
}

/**
 * Resolve a user-supplied path leniently: exact match first, then
 * case-insensitive, then with a `docs/` prefix added or `.md` appended.
 * Doc paths contain spaces and uppercase segments, so exact matches are easy
 * to miss by hand.
 * @param {string} input
 * @returns {string|undefined} the canonical path, if one matches
 */
export function resolvePath(input) {
  const raw = String(input || '').trim().replace(/^\/+/, '');
  if (!raw) return undefined;

  const conn = getDb();
  const candidates = [raw];
  if (!raw.toLowerCase().endsWith('.md')) candidates.push(`${raw}.md`);
  if (!/^docs\//i.test(raw)) {
    candidates.push(`docs/${raw}`);
    if (!raw.toLowerCase().endsWith('.md')) candidates.push(`docs/${raw}.md`);
  }

  const exact = conn.prepare('SELECT path FROM docs WHERE path = ?');
  for (const c of candidates) {
    const hit = exact.get(c);
    if (hit) return hit.path;
  }

  const ci = conn.prepare('SELECT path FROM docs WHERE lower(path) = lower(?)');
  for (const c of candidates) {
    const hit = ci.get(c);
    if (hit) return hit.path;
  }

  // Last resort: unique suffix match, so a bare "roarray" or "roarray.md"
  // resolves without the caller knowing the full folder path.
  const suffix = conn.prepare(
    `SELECT path FROM docs WHERE lower(path) LIKE lower(?) ESCAPE '\\' LIMIT 2`
  );
  for (const candidate of candidates) {
    const tail = candidate.replace(/^docs\//i, '');
    if (!tail) continue;
    const rows = suffix.all(`%/${tail.replace(/[%_\\]/g, '\\$&')}`);
    if (rows.length === 1) return rows[0].path;
  }
  return undefined;
}

/**
 * @param {string} [prefix] folder prefix filter, e.g. "docs/REFERENCES"
 * @param {number} [limit]
 * @returns {{path:string,title:string,bytes:number}[]}
 */
export function listDocs(prefix, limit = 500) {
  const conn = getDb();
  if (prefix && prefix.trim()) {
    const p = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    const like = `${p.replace(/[%_\\]/g, '\\$&')}%`;
    return conn
      .prepare(
        `SELECT path, title, bytes FROM docs
          WHERE path LIKE ? ESCAPE '\\' COLLATE NOCASE
          ORDER BY path LIMIT ?`
      )
      .all(like, limit);
  }
  return conn
    .prepare('SELECT path, title, bytes FROM docs ORDER BY path LIMIT ?')
    .all(limit);
}

/** Distinct folder prefixes one level below `prefix`, for browsing. */
export function listFolders(prefix = 'docs') {
  const p = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const depth = p.split('/').length + 1;
  const rows = getDb()
    .prepare(
      `SELECT path FROM docs WHERE path LIKE ? ESCAPE '\\' COLLATE NOCASE`
    )
    .all(`${p.replace(/[%_\\]/g, '\\$&')}/%`);

  const counts = new Map();
  for (const { path } of rows) {
    const parts = path.split('/');
    if (parts.length <= depth) continue;
    const folder = parts.slice(0, depth).join('/');
    counts.set(folder, (counts.get(folder) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, docs]) => ({ path, docs }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/* ---------------------------------------------------------------- search */

/**
 * Full-text search ranked by BM25, with title/excerpt boosted over body text.
 * @param {string} query user query, may use FTS5 syntax (AND/OR/NOT/"phrase"/prefix*)
 * @param {number} [limit]
 * @param {string} [prefix] optional folder prefix filter
 * @returns {{path:string,title:string,excerpt:string,snippet:string,score:number}[]}
 */
export function search(query, limit = 10, prefix) {
  const conn = getDb();
  const filter = prefix && prefix.trim() ? prefix.trim().replace(/\/+$/, '') : null;

  const sql = `
    SELECT d.path       AS path,
           d.title      AS title,
           d.excerpt    AS excerpt,
           snippet(docs_fts, 3, '<<', '>>', ' … ', 18) AS snippet,
           bm25(docs_fts, 0.0, 12.0, 4.0, 1.0) AS score
      FROM docs_fts
      JOIN docs d ON d.rowid = docs_fts.rowid
     WHERE docs_fts MATCH ?
       ${filter ? `AND d.path LIKE ? ESCAPE '\\' COLLATE NOCASE` : ''}
     ORDER BY score
     LIMIT ?`;

  const args = (m) =>
    filter
      ? [m, `${filter.replace(/[%_\\]/g, '\\$&')}%`, limit]
      : [m, limit];

  // Try the query as written so power users keep FTS5 syntax, then fall back
  // to a sanitized token-AND form. The fallback covers both a hard syntax
  // error (unbalanced quote, dangling operator) and a raw query that simply
  // found nothing. A malformed query yields no hits, never an exception.
  const raw = String(query || '').trim();
  const clean = sanitizeQuery(query);
  const attempts = raw ? (clean && clean !== raw ? [raw, clean] : [raw]) : [];

  for (const match of attempts) {
    try {
      const rows = conn.prepare(sql).all(...args(match));
      if (rows.length) return rows;
    } catch {
      // fall through to the next, more conservative attempt
    }
  }
  return [];
}

/** FTS5 operators are case-sensitive and uppercase-only. */
const FTS_OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR']);

/**
 * Reduce an arbitrary string to a safe FTS5 expression: bare tokens, each
 * double-quoted, ANDed together. Trailing `*` on a token is kept as a prefix
 * search since that is the one operator worth preserving here. Bare uppercase
 * operators are dropped rather than quoted, so a dangling `AND` does not
 * become a literal search for the word "and".
 * @param {string} query
 * @returns {string}
 */
export function sanitizeQuery(query) {
  const tokens = String(query || '')
    .split(/[^\p{L}\p{N}_*]+/u)
    .filter(Boolean)
    .map((t) => {
      const prefix = t.endsWith('*');
      const bare = t.replace(/\*/g, '');
      if (!bare || FTS_OPERATORS.has(bare)) return null;
      return `"${bare}"${prefix ? '*' : ''}`;
    })
    .filter(Boolean);
  return tokens.join(' AND ');
}

/* ----------------------------------------------------------------- writes */

/**
 * Insert or update a doc. Uses ON CONFLICT (not INSERT OR REPLACE) so the
 * rowid is preserved and the FTS external-content index stays aligned.
 * @param {{path:string,title:string,excerpt:string,content:string,sha:string,bytes:number}} doc
 */
export function upsertDoc(doc) {
  getDb()
    .prepare(
      `INSERT INTO docs (path, title, excerpt, content, sha, bytes, updated_at)
       VALUES (@path, @title, @excerpt, @content, @sha, @bytes, @updated_at)
       ON CONFLICT(path) DO UPDATE SET
         title      = excluded.title,
         excerpt    = excluded.excerpt,
         content    = excluded.content,
         sha        = excluded.sha,
         bytes      = excluded.bytes,
         updated_at = excluded.updated_at`
    )
    .run({ ...doc, updated_at: new Date().toISOString() });
}

export function deleteDoc(path) {
  getDb().prepare('DELETE FROM docs WHERE path = ?').run(path);
}

/** Run `fn` inside a single transaction. */
export function transaction(fn) {
  return getDb().transaction(fn)();
}

/** Rebuild the FTS index from the docs table and compact it. */
export function optimizeFts() {
  const conn = getDb();
  conn.exec(`INSERT INTO docs_fts(docs_fts) VALUES('rebuild')`);
  conn.exec(`INSERT INTO docs_fts(docs_fts) VALUES('optimize')`);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}
