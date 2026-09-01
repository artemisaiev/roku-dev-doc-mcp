import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { basename } from 'node:path';
import { Parser } from 'tar';
import YAML from 'yaml';

import {
  allShas,
  countDocs,
  deleteDoc,
  getMeta,
  setMeta,
  transaction,
  upsertDoc,
  optimizeFts,
} from './db.js';

export const REPO = 'rokudev/dev-doc';
export const REF = 'v2.0';

const API_BASE = 'https://api.github.com';
const CODELOAD = 'https://codeload.github.com';
const UA = 'roku-dev-doc-mcp';

/** Only one sync may run at a time; concurrent callers await the same run. */
let inFlight = null;

/**
 * Mirror the `docs/` folder of the upstream repo into the local index.
 *
 * Downloads the whole repo tarball (~1.4 MB, one request) rather than fetching
 * files individually. Git blob SHAs are recomputed locally from the extracted
 * bytes, which is what lets a tarball-only sync still report accurate
 * added/updated/unchanged counts and skip untouched rows.
 *
 * @param {{force?: boolean, onProgress?: (msg: string) => void}} [options]
 * @returns {Promise<{skipped:boolean, sha:string|null, added:number, updated:number,
 *   removed:number, unchanged:number, total:number, durationMs:number, note?:string}>}
 */
export function syncDocs(options = {}) {
  if (inFlight) return inFlight;
  inFlight = runSync(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** @returns {boolean} whether a sync is currently running */
export function isSyncing() {
  return inFlight !== null;
}

async function runSync({ force = false, onProgress } = {}) {
  const started = Date.now();
  const log = (msg) => onProgress?.(msg);

  log(`Checking ${REPO}@${REF} for changes…`);
  const head = await fetchHeadSha();
  const lastSynced = getMeta('last_synced_sha');
  const haveDocs = countDocs() > 0;

  if (!force && head && head === lastSynced && haveDocs) {
    // Record that freshness was confirmed just now, even though nothing was
    // downloaded. `last_synced_at` therefore means "last verified in sync with
    // upstream", which is what the staleness check needs — otherwise a stale
    // index whose upstream never moves would re-check on every single launch.
    setMeta('last_synced_at', new Date().toISOString());
    return {
      skipped: true,
      sha: head,
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: countDocs(),
      total: countDocs(),
      durationMs: Date.now() - started,
      note: 'Already up to date.',
    };
  }

  // Pin the download to the exact commit we checked so the branch moving
  // mid-sync cannot leave us recording a SHA we never actually fetched.
  const ref = head || REF;
  log(`Downloading tarball for ${ref.slice(0, 12)}…`);
  const archive = await fetchTarball(ref);
  log(`Extracting markdown from ${(archive.length / 1048576).toFixed(2)} MB archive…`);

  const entries = await extractDocs(archive);
  if (entries.length === 0) {
    throw new Error(
      `No markdown files found under docs/ in the ${REPO}@${ref} tarball — ` +
        'the upstream layout may have changed.'
    );
  }
  log(`Indexing ${entries.length} documents…`);

  const known = allShas();
  const seen = new Set();
  let added = 0;
  let updated = 0;
  let unchanged = 0;

  transaction(() => {
    for (const entry of entries) {
      seen.add(entry.path);
      const priorSha = known.get(entry.path);

      if (priorSha === entry.sha && !force) {
        unchanged += 1;
        continue;
      }

      const { title, excerpt, content } = parseDoc(entry.path, entry.raw);
      upsertDoc({
        path: entry.path,
        title,
        excerpt,
        content,
        sha: entry.sha,
        bytes: entry.bytes,
      });

      if (priorSha === undefined) added += 1;
      else if (priorSha === entry.sha) unchanged += 1;
      else updated += 1;
    }

    for (const path of known.keys()) {
      if (!seen.has(path)) deleteDoc(path);
    }
  });

  const removed = [...known.keys()].filter((p) => !seen.has(p)).length;

  if (added + updated + removed > 0) optimizeFts();

  if (head) setMeta('last_synced_sha', head);
  setMeta('last_synced_at', new Date().toISOString());
  setMeta('doc_count', String(countDocs()));

  return {
    skipped: false,
    sha: head,
    added,
    updated,
    removed,
    unchanged,
    total: countDocs(),
    durationMs: Date.now() - started,
    ...(head ? {} : { note: 'Could not read the branch SHA; sync ran unconditionally.' }),
  };
}

/* --------------------------------------------------------------- fetching */

function ghHeaders(extra = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  return {
    'User-Agent': UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/**
 * Head commit SHA of the tracked branch. Returns null instead of throwing:
 * the SHA is only an optimisation (short-circuit + pinning), so an API rate
 * limit should degrade to an unconditional sync rather than fail outright.
 * @returns {Promise<string|null>}
 */
export async function fetchHeadSha() {
  try {
    const res = await fetch(`${API_BASE}/repos/${REPO}/branches/${REF}`, {
      headers: ghHeaders({ Accept: 'application/vnd.github+json' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.commit?.sha === 'string' ? body.commit.sha : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} ref commit SHA or branch name
 * @returns {Promise<Buffer>} gzipped tarball
 */
async function fetchTarball(ref) {
  const url = `${CODELOAD}/${REPO}/tar.gz/${encodeURIComponent(ref)}`;
  const res = await fetch(url, {
    headers: ghHeaders(),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Stream the tarball through gunzip + tar, keeping only markdown under the
 * archive's `docs/` folder. The archive root is a single generated directory
 * (e.g. `dev-doc-2.0/`) whose exact name tracks the ref, so it is matched
 * generically and stripped.
 *
 * @param {Buffer} archive
 * @returns {Promise<{path:string, raw:string, sha:string, bytes:number}[]>}
 */
async function extractDocs(archive) {
  const out = [];
  const pending = [];

  const parser = new Parser({
    filter: (path) => /^[^/]+\/docs\/.+\.md$/i.test(path),
    onReadEntry(entry) {
      const chunks = [];
      pending.push(
        new Promise((resolve, reject) => {
          entry.on('data', (c) => chunks.push(c));
          entry.on('error', reject);
          entry.on('end', () => {
            const buf = Buffer.concat(chunks);
            out.push({
              path: entry.path.replace(/^[^/]+\//, ''), // drop archive root
              raw: buf.toString('utf8'),
              sha: gitBlobSha(buf),
              bytes: buf.length,
            });
            resolve();
          });
        })
      );
    },
  });

  await pipeline(Readable.from(archive), createGunzip(), parser);
  await Promise.all(pending);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/**
 * The SHA-1 git assigns a blob: sha1("blob <bytelength>\0" + bytes).
 * Computing it locally reproduces exactly what the GitHub tree API would have
 * reported, so stored SHAs stay comparable across sync strategies.
 * @param {Buffer} buf
 * @returns {string}
 */
export function gitBlobSha(buf) {
  return createHash('sha1')
    .update(`blob ${buf.length}\0`)
    .update(buf)
    .digest('hex');
}

/* ------------------------------------------------------------ frontmatter */

/**
 * Split leading YAML frontmatter from the markdown body.
 * @param {string} raw
 * @returns {{data: Record<string, any>, body: string}}
 */
export function parseFrontmatter(raw) {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return { data: {}, body: text };

  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };

  let data = {};
  try {
    const parsed = YAML.parse(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
  } catch {
    // Malformed frontmatter: fall back to heading/filename derivation rather
    // than losing the document.
  }
  return { data, body: text.slice(match[0].length) };
}

/**
 * Derive the stored title/excerpt/content for one document.
 *
 * Every upstream doc carries frontmatter with a `title`, and most have no `#`
 * heading at all, so frontmatter is the primary source and the heading only a
 * fallback. Frontmatter is stripped from the stored content so the FTS index
 * holds prose rather than YAML keys.
 *
 * @param {string} path
 * @param {string} raw
 * @returns {{title:string, excerpt:string, content:string}}
 */
export function parseDoc(path, raw) {
  const { data, body } = parseFrontmatter(raw);
  const content = body.replace(/^\s+/, '').replace(/\s+$/, '');

  const title =
    str(data.title) ||
    firstHeading(content) ||
    humanizeFilename(path);

  const excerpt =
    str(data.excerpt) ||
    str(data.metadata?.description) ||
    firstParagraph(content);

  return { title, excerpt, content };
}

function str(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function firstHeading(body) {
  const m = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/m.exec(body);
  return m ? m[1].trim() : '';
}

function firstParagraph(body, max = 240) {
  const cleaned = body
    .replace(/^```[\s\S]*?^```/gm, '') // drop leading code blocks
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+.*$/gm, '') // drop headings
    .replace(/^[ \t]{0,3}[>|].*$/gm, '') // drop quotes / table rows
    .trim();

  const para = cleaned.split(/\r?\n\s*\r?\n/).find((p) => p.trim().length > 0) || '';
  const flat = para
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function humanizeFilename(path) {
  const name = basename(path, '.md');
  if (name.toLowerCase() === 'index') {
    const parent = path.split('/').slice(-2, -1)[0] || name;
    return titleCase(parent);
  }
  return titleCase(name);
}

function titleCase(slug) {
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* -------------------------------------------------------------- status */

/** @returns {{lastSyncedSha:string|null, lastSyncedAt:string|null, docCount:number, syncing:boolean}} */
export function syncStatus() {
  return {
    lastSyncedSha: getMeta('last_synced_sha') ?? null,
    lastSyncedAt: getMeta('last_synced_at') ?? null,
    docCount: countDocs(),
    syncing: isSyncing(),
  };
}

/* ----------------------------------------------------------- staleness */

/** Refresh in the background once the index is this old, unless overridden. */
export const DEFAULT_MAX_AGE_DAYS = 7;

/**
 * Age threshold for the startup background refresh, in days.
 * `ROKU_DOCS_MCP_MAX_AGE_DAYS=0` disables the refresh entirely.
 * @returns {number}
 */
export function maxAgeDays() {
  const raw = process.env.ROKU_DOCS_MCP_MAX_AGE_DAYS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_MAX_AGE_DAYS;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_AGE_DAYS;
  return n;
}

/**
 * How long ago the index was last confirmed in sync with upstream.
 * @returns {number|null} age in days, or null if never synced or unparseable
 */
export function indexAgeDays() {
  const at = getMeta('last_synced_at');
  if (!at) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 86_400_000;
}

/**
 * Whether the index is old enough to warrant a background refresh. A missing or
 * unparseable timestamp counts as stale, since a single refresh repairs it.
 * @returns {boolean}
 */
export function isStale() {
  const max = maxAgeDays();
  if (max <= 0) return false; // explicitly disabled
  const age = indexAgeDays();
  return age === null || age >= max;
}
