import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  countDocs,
  getDoc,
  listDocs,
  listFolders,
  resolvePath,
  search as searchDocs,
} from './db.js';
import {
  REF,
  REPO,
  indexAgeDays,
  isStale,
  isSyncing,
  maxAgeDays,
  syncDocs,
  syncStatus,
} from './sync.js';
import {
  SECTION_HARD_LIMIT,
  WHOLE_DOC_LIMIT,
  buildToc,
  clamp,
  findSectionFor,
  formatBytes,
  selectSection,
  splitSections,
} from './sections.js';

export const SERVER_NAME = 'roku-dev-doc-mcp';
export const SERVER_VERSION = '0.1.0';

/** stdout is the MCP protocol channel — every log line must go to stderr. */
export function log(...args) {
  process.stderr.write(`[${SERVER_NAME}] ${args.join(' ')}\n`);
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

/**
 * Guard for tools that need a populated index. Returns a message to send back,
 * or null when the index is ready.
 * @returns {string|null}
 */
function notReady() {
  if (countDocs() > 0) return null;
  if (isSyncing()) {
    return (
      'The Roku docs index is still building (first run downloads and indexes ' +
      `~590 documents from ${REPO}@${REF}; this usually takes a few seconds). ` +
      'Please retry shortly.'
    );
  }
  return (
    'The Roku docs index is empty. Run the `refresh_roku_docs` tool to download ' +
    `and index the documentation from ${REPO}@${REF}.`
  );
}

/**
 * Guidance sent to the client during initialization, so a consuming project
 * needs nothing in its own CLAUDE.md — adding the server is the whole setup.
 *
 * MCP clients MAY ignore `instructions`, so the individual tool descriptions
 * are kept self-sufficient; this carries the "when to reach for it" layer that
 * tool schemas cannot express.
 */
export const INSTRUCTIONS = `Roku and BrightScript development documentation, mirrored from ${REPO}@${REF} and indexed locally for full-text search.

Use this instead of answering BrightScript/SceneGraph questions from memory. Component names, interface methods, node fields and their defaults are exactly the details that get misremembered convincingly. A five-second lookup beats a plausible guess, and if a lookup contradicts your recollection, the docs win.

Look something up before writing or reviewing code that touches:
- any ro* component or if* interface (roArray, roUrlTransfer, ifStringOps)
- any SceneGraph node, its fields, defaults, or access permissions
- BrightScript syntax and built-in functions
- manifest keys, deep linking, certification, RAF/ads, Roku Pay
- anything you would otherwise preface with "I believe" or "typically"

Tools:
- search_roku_docs(query, limit?, prefix?) — start here
- get_roku_doc(path, section?, full?) — read a page
- list_roku_docs(prefix?) — browse when you do not know the term yet

Where things live (pass as \`prefix\` to narrow a search):
- docs/REFERENCES/brightscript/components — ro* components
- docs/REFERENCES/brightscript/interfaces — if* interfaces
- docs/REFERENCES/brightscript/events — ro*Event events
- docs/REFERENCES/brightscript/language — syntax and built-in functions
- docs/REFERENCES/scenegraph — SceneGraph nodes
- docs/DEVELOPER — guides, tooling, debugging, Roku Pay
- docs/SPECIFICATIONS — device and hardware specs

Components are ro*, interfaces are if* — searching the exact symbol name is usually the fastest route. Typical flow: search_roku_docs("Task control RUN") then get_roku_doc("docs/REFERENCES/scenegraph/control-nodes/task.md"). Paths resolve leniently, so "roarray" finds the full path. Large documents return a numbered section outline instead of the body; search results already name the best-matching section, so pass that straight to get_roku_doc rather than fetching the outline first.`;

/**
 * Build the MCP server with all tools and resources registered.
 * @returns {McpServer}
 */
export function createServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS }
  );

  registerTools(server);
  registerResources(server);
  return server;
}

/* ------------------------------------------------------------------ tools */

function registerTools(server) {
  server.registerTool(
    'search_roku_docs',
    {
      title: 'Search Roku docs',
      description:
        'Full-text search across the Roku/BrightScript documentation, ranked by relevance. ' +
        'Supports plain keywords as well as FTS5 syntax ("exact phrase", term*, AND/OR/NOT). ' +
        'Returns the path, title, and a highlighted snippet for each hit — use `get_roku_doc` ' +
        'to read a result in full.',
      inputSchema: {
        query: z.string().min(1).describe('Search terms, e.g. "roArray Push" or "video playback"'),
        limit: z
          .number().int().min(1).max(50).optional()
          .describe('Maximum results to return (default 10)'),
        prefix: z
          .string().optional()
          .describe('Restrict to a folder, e.g. "docs/REFERENCES/brightscript"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit = 10, prefix }) => {
      const blocked = notReady();
      if (blocked) return fail(blocked);

      const hits = searchDocs(query, limit, prefix);
      if (hits.length === 0) {
        return text(
          `No matches for ${JSON.stringify(query)}` +
            (prefix ? ` under "${prefix}"` : '') +
            `.\n\nTried ${countDocs()} indexed documents. Try broader or fewer terms, ` +
            'or use `list_roku_docs` to browse by folder.'
        );
      }

      const lines = hits.map((hit, i) => {
        const parts = [`${i + 1}. ${hit.title}`, `   path: ${hit.path}`];
        if (hit.excerpt) parts.push(`   ${truncate(hit.excerpt, 200)}`);
        if (hit.snippet) parts.push(`   match: ${flatten(hit.snippet)}`);

        // Point at the right part of documents too large to return whole.
        const doc = getDoc(hit.path);
        if (doc && doc.bytes > WHOLE_DOC_LIMIT) {
          const idx = findSectionFor(splitSections(doc.content), query);
          if (idx) {
            parts.push(
              `   large doc (${formatBytes(doc.bytes)}) — best match in section ${idx}; ` +
                `call get_roku_doc with section: ${idx}`
            );
          }
        }
        return parts.join('\n');
      });

      return text(
        `Found ${hits.length} match${hits.length === 1 ? '' : 'es'} for ` +
          `${JSON.stringify(query)}${prefix ? ` under "${prefix}"` : ''}:\n\n` +
          lines.join('\n\n')
      );
    }
  );

  server.registerTool(
    'get_roku_doc',
    {
      title: 'Read a Roku doc',
      description:
        'Return the markdown content of a single documentation page by path. ' +
        `Documents larger than ${formatBytes(WHOLE_DOC_LIMIT)} are returned as a numbered ` +
        'section outline instead; pass `section` (a number or heading text) to read one of ' +
        'those sections. Search results for such documents already name the best-matching ' +
        'section, so you can request it directly without fetching the outline first.',
      inputSchema: {
        path: z
          .string().min(1)
          .describe('Doc path, e.g. "docs/REFERENCES/brightscript/components/roarray.md"'),
        section: z
          .union([z.string(), z.number()]).optional()
          .describe('Section number from the outline, or heading text to match'),
        full: z
          .boolean().optional()
          .describe('Return the entire document even if large (may be very long)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, section, full = false }) => {
      const blocked = notReady();
      if (blocked) return fail(blocked);

      const resolved = resolvePath(path);
      if (!resolved) {
        const guesses = listDocs(undefined, 5000)
          .filter((d) => d.path.toLowerCase().includes(String(path).toLowerCase().replace(/^docs\//i, '')))
          .slice(0, 8);
        return fail(
          `No document found at "${path}".` +
            (guesses.length
              ? `\n\nDid you mean:\n${guesses.map((g) => `  ${g.path}`).join('\n')}`
              : '\n\nUse `search_roku_docs` or `list_roku_docs` to find the right path.')
        );
      }

      const doc = getDoc(resolved);
      const header = `# ${doc.title}\n\nSource: ${REPO}@${REF} — ${doc.path} (${formatBytes(doc.bytes)})`;

      if (!doc.content.trim()) {
        return text(
          `${header}\n\nThis page is a section landing page upstream and has no body content. ` +
            `Use \`list_roku_docs\` with prefix "${doc.path.replace(/\/index\.md$/i, '')}" to see the pages under it.`
        );
      }

      const sections = splitSections(doc.content);

      if (section !== undefined && section !== null && section !== '') {
        const picked = selectSection(sections, section);
        if (!picked) {
          return fail(
            `No section matching ${JSON.stringify(String(section))} in ${doc.path}.\n\n` +
              `Sections:\n${buildToc(sections)}`
          );
        }
        const { text: body, truncated } = clamp(picked.content, SECTION_HARD_LIMIT);
        return text(
          `${header}\n\nSection ${picked.index} of ${sections.length}: ${picked.title}\n\n---\n\n${body}` +
            (truncated ? '\n\n…[section truncated]' : '') +
            `\n\n---\nOther sections available — call get_roku_doc with a different \`section\`.`
        );
      }

      const wholeDoc = full || doc.bytes <= WHOLE_DOC_LIMIT;
      if (wholeDoc) {
        const { text: body, truncated } = clamp(doc.content, SECTION_HARD_LIMIT);
        return text(
          `${header}\n\n---\n\n${body}` +
            (truncated
              ? `\n\n…[truncated at ${formatBytes(SECTION_HARD_LIMIT)} — request a \`section\` to read further]`
              : '')
        );
      }

      return text(
        `${header}\n\nThis document is too large to return whole (${formatBytes(doc.bytes)}, ` +
          `${sections.length} sections). Call \`get_roku_doc\` again with a \`section\` number ` +
          `or heading text from this outline:\n\n${buildToc(sections)}\n\n` +
          `(Pass \`full: true\` to force the entire document.)`
      );
    }
  );

  server.registerTool(
    'list_roku_docs',
    {
      title: 'List Roku docs',
      description:
        'Browse the documentation tree. With no prefix, lists the top-level sections and ' +
        'their document counts; with a prefix, lists the subfolders and documents beneath it.',
      inputSchema: {
        prefix: z
          .string().optional()
          .describe('Folder to list, e.g. "docs/REFERENCES/scenegraph"'),
        limit: z
          .number().int().min(1).max(2000).optional()
          .describe('Maximum documents to list (default 200)'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ prefix, limit = 200 }) => {
      const blocked = notReady();
      if (blocked) return fail(blocked);

      const base = (prefix || 'docs').trim().replace(/^\/+|\/+$/g, '') || 'docs';
      const folders = listFolders(base);
      const docs = listDocs(base, limit + 1);

      if (folders.length === 0 && docs.length === 0) {
        return fail(
          `Nothing found under "${base}".\n\nTop-level sections:\n` +
            listFolders('docs').map((f) => `  ${f.path} (${f.docs})`).join('\n')
        );
      }

      const out = [`${base} — ${countUnder(base)} document(s)`];

      if (folders.length) {
        out.push(
          '',
          'Folders:',
          ...folders.map((f) => `  ${f.path}/  (${f.docs} doc${f.docs === 1 ? '' : 's'})`)
        );
      }

      // Only list the files sitting directly in this folder; deeper ones are
      // reachable by drilling into the folders listed above.
      const depth = base.split('/').length;
      const direct = docs.filter((d) => d.path.split('/').length === depth + 1);
      if (direct.length) {
        out.push(
          '',
          'Documents:',
          ...direct.slice(0, limit).map((d) => `  ${d.path}  — ${d.title} (${formatBytes(d.bytes)})`)
        );
        if (direct.length > limit) out.push(`  …and ${direct.length - limit} more`);
      }

      return text(out.join('\n'));
    }
  );

  server.registerTool(
    'refresh_roku_docs',
    {
      title: 'Refresh Roku docs',
      description:
        `Re-sync the local index from ${REPO}@${REF}. Skips the download when the upstream ` +
        'branch has not moved since the last sync; pass `force: true` to re-index regardless. ' +
        'Returns a summary of what changed.',
      inputSchema: {
        force: z
          .boolean().optional()
          .describe('Re-download and re-index even if the branch has not changed'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ force = false }) => {
      try {
        const r = await syncDocs({ force, onProgress: log });
        const status = syncStatus();

        if (r.skipped) {
          return text(
            `Already up to date with ${REPO}@${REF} (${short(r.sha)}).\n` +
              `${r.total} documents indexed. Last synced: ${status.lastSyncedAt}.\n` +
              'Pass force: true to re-index anyway.'
          );
        }

        return text(
          `Synced ${REPO}@${REF} (${short(r.sha)}) in ${(r.durationMs / 1000).toFixed(1)}s.\n\n` +
            `  added:     ${r.added}\n` +
            `  updated:   ${r.updated}\n` +
            `  removed:   ${r.removed}\n` +
            `  unchanged: ${r.unchanged}\n` +
            `  total:     ${r.total} documents indexed\n` +
            (r.note ? `\nNote: ${r.note}\n` : '')
        );
      } catch (err) {
        return fail(
          `Sync failed: ${err.message}\n\n` +
            'The existing local index (if any) is unchanged. If this is a GitHub rate limit, ' +
            'set a GITHUB_TOKEN environment variable and try again.'
        );
      }
    }
  );
}

/* -------------------------------------------------------------- resources */

function registerResources(server) {
  server.registerResource(
    'roku-doc',
    new ResourceTemplate('docs://{+path}', {
      list: () => {
        if (countDocs() === 0) return { resources: [] };
        return {
          resources: listDocs(undefined, 2000).map((d) => ({
            uri: `docs://${d.path}`,
            name: d.title || d.path,
            description: d.path,
            mimeType: 'text/markdown',
          })),
        };
      },
      complete: {
        path: (value) =>
          listDocs(undefined, 5000)
            .filter((d) => d.path.toLowerCase().includes(String(value || '').toLowerCase()))
            .slice(0, 100)
            .map((d) => d.path),
      },
    }),
    {
      title: 'Roku documentation page',
      description: `Markdown source of a page from ${REPO}@${REF}`,
      mimeType: 'text/markdown',
    },
    async (uri, { path }) => {
      const wanted = decodeURIComponent(Array.isArray(path) ? path.join('/') : String(path ?? ''));
      const resolved = resolvePath(wanted);
      if (!resolved) throw new Error(`No Roku doc at "${wanted}"`);

      const doc = getDoc(resolved);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: `# ${doc.title}\n\n<!-- ${REPO}@${REF} — ${doc.path} -->\n\n${doc.content}`,
          },
        ],
      };
    }
  );
}

/* ------------------------------------------------------------------ start */

/**
 * Start the stdio MCP server.
 *
 * Neither sync path blocks startup: the transport connects immediately and the
 * work happens in the background. An empty index makes tools report that they
 * are still building; a stale one keeps serving the existing docs while the
 * refresh runs, so a background refresh is invisible to callers.
 *
 * @param {{autoSync?: boolean}} [options]
 */
export async function start({ autoSync = true } = {}) {
  const server = createServer();
  const status = syncStatus();

  if (autoSync && status.docCount === 0) {
    log('Index is empty — starting initial sync in the background…');
    backgroundSync('Initial sync');
  } else if (autoSync && isStale()) {
    log(
      `Index ${describeAge()} exceeds the ${maxAgeDays()}-day threshold — ` +
        `refreshing in the background (${status.docCount} documents still served meanwhile)…`
    );
    backgroundSync('Background refresh');
  } else {
    log(
      `Ready — ${status.docCount} documents indexed ` +
        `(last synced ${status.lastSyncedAt ?? 'never'}).`
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

/**
 * Fire a sync without blocking the caller. Failures are logged and swallowed:
 * a refresh that cannot reach GitHub must never take the server down, and the
 * existing index remains served either way.
 * @param {string} label
 */
function backgroundSync(label) {
  syncDocs({ onProgress: log })
    .then((r) =>
      log(
        r.skipped
          ? `${label}: already up to date (${r.total} documents).`
          : `${label} complete: +${r.added} added, ~${r.updated} updated, ` +
            `-${r.removed} removed (${r.total} total).`
      )
    )
    .catch((err) => log(`${label} failed: ${err.message} — serving the existing index.`));
}

/** Human-readable index age for the startup log. */
function describeAge() {
  const age = indexAgeDays();
  if (age === null) return 'age is unknown, which';
  return `is ${age.toFixed(1)} days old, which`;
}

/* ----------------------------------------------------------------- utils */

function short(sha) {
  return sha ? sha.slice(0, 12) : 'unknown';
}

function flatten(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function truncate(s, n) {
  const t = flatten(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function countUnder(prefix) {
  return listDocs(prefix, 100000).length;
}
