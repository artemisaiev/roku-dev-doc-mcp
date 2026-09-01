# roku-dev-doc-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server that
serves Roku / BrightScript development documentation, mirrored from the `docs/`
folder of [rokudev/dev-doc](https://github.com/rokudev/dev-doc) (branch `v2.0`)
and indexed in SQLite with an FTS5 full-text index.

Read-only reference tooling: it never writes to the upstream repo, and needs no
authentication for the public repo.

- **600+ documents**, ~6 MB of markdown, indexed in about a second
- **Offline after first sync** — everything is served from a local SQLite file
- **Context-aware reads** — large docs are returned as a section outline rather
  than dumping 90k tokens into your context window

## Install

```bash
npm install -g .
```

Then point an MCP client at the `roku-dev-doc-mcp` command.

### Claude Code

```bash
claude mcp add roku-docs -- roku-dev-doc-mcp
```

### Claude Desktop / generic MCP config

```json
{
  "mcpServers": {
    "roku-docs": {
      "command": "roku-dev-doc-mcp"
    }
  }
}
```

During development, before installing globally:

```json
{
  "mcpServers": {
    "roku-docs": {
      "command": "node",
      "args": ["/absolute/path/to/roku-dev-doc-mcp/bin/roku-dev-doc-mcp.js"]
    }
  }
}
```

On first run the index is empty, so the server kicks off a sync **in the
background** — it connects immediately rather than blocking the client's
startup, and tools report that the index is still building until it lands
(about a second). To pre-warm it instead:

```bash
roku-dev-doc-mcp --sync
```

After that, the server refreshes itself in the background whenever the index is
more than **7 days** old. That refresh never blocks startup and never makes
tools unavailable — the existing docs keep being served while it runs, so it is
invisible to callers. Set `ROKU_DOCS_MCP_MAX_AGE_DAYS` to change the threshold,
or `0` to disable it and rely on manual `--sync` only.

## Using it in a project

**You don't need to add anything to your project's `CLAUDE.md`.** Adding the
server is the whole setup.

The server sends its own usage guidance to the client during initialization, via
the MCP `instructions` field (the `INSTRUCTIONS` constant in `src/server.js`, the
single source of truth for that text). Any project that connects gets the rules
automatically: prefer a lookup over a guess for `ro*` / `if*` symbols, SceneGraph
node fields and defaults, BrightScript syntax, manifest keys and certification
requirements — plus the folder map under [Where things live](#where-things-live).

`CLAUDE.md` is for what the server *cannot* know: your target Roku OS version,
SceneGraph vs the legacy SDK, house patterns, directories to avoid. If you have
such rules and want them shared across several Roku projects, reference one file
rather than copying it, so it cannot drift:

```markdown
@~/.claude/roku-project-conventions.md
```

> **Caveat.** The MCP spec makes `instructions` optional for clients to honour.
> Claude Code and Claude Desktop both surface it; a third-party client may not.
> The individual tool descriptions are therefore written to stand on their own —
> on a client that ignores `instructions` the tools still work correctly, they
> just lose the "prefer a lookup over a guess" nudge.

## Tools

| Tool | Arguments | Purpose |
| --- | --- | --- |
| `search_roku_docs` | `query`, `limit?`, `prefix?` | BM25-ranked full-text search with highlighted snippets |
| `get_roku_doc` | `path`, `section?`, `full?` | Read one page; large pages return an outline |
| `list_roku_docs` | `prefix?`, `limit?` | Browse the folder tree |
| `refresh_roku_docs` | `force?` | Re-sync from GitHub, returns a change summary |

`search_roku_docs` accepts plain keywords as well as FTS5 syntax
(`"exact phrase"`, `term*`, `AND`/`OR`/`NOT`). A malformed query degrades to a
plain keyword search rather than erroring.

`get_roku_doc` resolves paths leniently — `roarray`,
`roarray.md`, and the full
`docs/REFERENCES/brightscript/components/roarray.md` all work.

### Where things live

Pass any of these as `prefix` to narrow a search:

| Topic | `prefix` |
| --- | --- |
| Components (`ro*`) | `docs/REFERENCES/brightscript/components` |
| Interfaces (`if*`) | `docs/REFERENCES/brightscript/interfaces` |
| Events (`ro*Event`) | `docs/REFERENCES/brightscript/events` |
| Language / syntax | `docs/REFERENCES/brightscript/language` |
| SceneGraph nodes | `docs/REFERENCES/scenegraph` |
| Guides, tooling, debugging, Roku Pay | `docs/DEVELOPER` |
| Device / hardware specs | `docs/SPECIFICATIONS` |

Components are `ro*`, interfaces are `if*` — searching the exact symbol name is
usually the fastest route. Typical flow:
`search_roku_docs("Task control RUN")` →
`get_roku_doc("docs/REFERENCES/scenegraph/control-nodes/task.md")`.

### Large documents

Doc sizes are heavily skewed: most are a few KB, but the largest is ~354 KB
(roughly 90k tokens). Anything over **12 KB** returns a numbered section outline
instead of the body:

```
This document is too large to return whole (346.5 KB, 76 sections). Call
`get_roku_doc` again with a `section` number or heading text from this outline:

  1.   Ingest specifications  (772 B)
  2.     MovieLabs  (644 B)
  3.   Roku content policies  (24 B)
  …
```

Then request a section by number (`section: 24`) or by heading text
(`section: "closed captions"`). Search results for large docs also report which
section best matches the query — so arriving from a search costs no extra round
trip, you just pass that section straight to `get_roku_doc`. `full: true` forces
the whole document.

12 KB (~3k tokens) is the measured break-even for this corpus: 80% of docs still
return whole in a single call, the worst-case return drops from ~10.5k to ~3.2k
tokens, and the high-frequency BrightScript component and interface pages
(medians ~1.4 KB and ~3.3 KB) are unaffected. Tune it with
`ROKU_DOCS_MCP_MAX_DOC_BYTES` if your context budget differs.

## Resources

Docs are also exposed as MCP resources under `docs://{path}`, e.g.
`docs://docs/REFERENCES/brightscript/components/roarray.md`, with path
completion. Resources are the idiomatic mechanism for browsable read content;
the tools above are better suited to search and refresh.

## CLI

```bash
roku-dev-doc-mcp              # start the MCP server on stdio (default)
roku-dev-doc-mcp --sync       # sync the index and exit
roku-dev-doc-mcp --sync --force
roku-dev-doc-mcp --status     # show index status
roku-dev-doc-mcp --help
```

## How the sync works

A sync runs when the index is empty at startup, when it is older than the
staleness threshold at startup, or when you ask for one (`refresh_roku_docs`
or `--sync`). All startup syncs are non-blocking. Only one sync runs at a time —
concurrent callers share the same in-flight run.

1. Read the head SHA of the `v2.0` branch. If it matches the last synced SHA
   and the index is non-empty, stop — nothing to do.
2. Download the repo tarball **for that exact commit** (~1.4 MB, one request).
   Pinning to the SHA means a branch that moves mid-sync can't leave a
   recorded SHA that was never actually fetched.
3. Stream it through gunzip + tar in memory, keeping only `docs/**/*.md`.
4. Recompute each file's **git blob SHA** locally
   (`sha1("blob <len>\0" + bytes)`) and compare against the stored value.
   Unchanged files are skipped, so a re-sync only touches what actually moved
   and the change summary stays accurate.
5. Delete rows no longer present upstream, then update the sync markers.

One HTTP request per sync (plus one cheap API call for the SHA check). The
tarball is never written to disk.

`last_synced_at` records when the index was last *confirmed* in sync with
upstream, so it advances even when the SHA check finds nothing to download.
Without that, an index past the staleness threshold whose upstream never moves
would re-check on every single launch instead of once per interval.

### Titles and frontmatter

Every upstream doc carries YAML frontmatter, and most have **no `#` heading at
all** — so the frontmatter `title` is the primary source, with a first-heading
and then filename fallback. Frontmatter is parsed out into `title` and
`excerpt` columns and stripped from the stored content, so the full-text index
holds prose rather than YAML keys.

Eight docs are frontmatter-only section landing pages upstream with no body;
these are indexed by title and reported as such when read.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ROKU_DOCS_MCP_DATA_DIR` | Override the data directory |
| `GITHUB_TOKEN` / `GH_TOKEN` | Raise the GitHub API rate limit (optional) |
| `ROKU_DOCS_MCP_MAX_DOC_BYTES` | Whole-doc size threshold (default 12000) |
| `ROKU_DOCS_MCP_MAX_SECTION_BYTES` | Hard ceiling on any one response (default 60000) |
| `ROKU_DOCS_MCP_MAX_AGE_DAYS` | Background refresh threshold in days (default 7, `0` disables) |

The SQLite file lives in a per-user data directory, not in the install
directory:

- macOS — `~/Library/Application Support/roku-dev-doc-mcp/docs.sqlite`
- Linux — `$XDG_DATA_HOME/roku-dev-doc-mcp/` or `~/.local/share/roku-dev-doc-mcp/`
- Windows — `%LOCALAPPDATA%\roku-dev-doc-mcp\Data\`

Only one unauthenticated GitHub API call is made per sync (the branch SHA
check), so the 60/hour unauthenticated limit is not a practical concern.
`GITHUB_TOKEN` is only worth setting for very frequent automatic refreshes.

## Development

```bash
npm install
npm test
```

```
roku-dev-doc-mcp/
├── bin/roku-dev-doc-mcp.js   # CLI entrypoint (shebang), arg handling only
├── src/
│   ├── server.js             # MCP server, tool + resource registration
│   ├── sync.js               # GitHub fetch, extract, frontmatter, upsert
│   ├── sections.js           # markdown section splitting for large docs
│   ├── db.js                 # SQLite schema, FTS5 triggers, queries
│   └── paths.js              # per-user data dir resolution
└── test/
    ├── parsing.test.js       # frontmatter, sections, query sanitising
    └── staleness.test.js     # background-refresh threshold logic
```

Plain Node.js ESM, no TypeScript, no build step. Requires Node >= 18.

## License

[The Unlicense](https://unlicense.org/) — this software is released into the
public domain. Do whatever you like with it: copy, modify, publish, sell, or
redistribute, for any purpose, with no attribution required. See [LICENSE](LICENSE).

Two things the dedication does **not** cover, since they were never mine to give
away:

- **The documentation content itself.** The docs this server mirrors belong to
  Roku and are reproduced unmodified from
  [rokudev/dev-doc](https://github.com/rokudev/dev-doc). The public-domain
  dedication applies to the code in this repository, not to the indexed text.
- **Dependencies.** Each npm dependency keeps its own license — currently MIT
  (`@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`), ISC (`yaml`), and
  Blue Oak 1.0.0 (`tar`). All permissive, but they are not public domain.
