#!/usr/bin/env node
/**
 * CLI entrypoint. Deliberately thin: argument handling only, with all of the
 * real work living in src/ so it stays testable without spawning a process.
 */
import { SERVER_NAME, SERVER_VERSION, log, start } from '../src/server.js';
import { REF, REPO, indexAgeDays, isStale, maxAgeDays, syncDocs, syncStatus } from '../src/sync.js';
import { dataDir, dbPath } from '../src/paths.js';

const args = new Set(process.argv.slice(2));

if (args.has('--help') || args.has('-h')) {
  process.stdout.write(
    `${SERVER_NAME} v${SERVER_VERSION}\n\n` +
      `Local MCP server serving Roku/BrightScript documentation from ${REPO}@${REF}.\n\n` +
      'Usage:\n' +
      `  ${SERVER_NAME}              Start the MCP server on stdio (default)\n` +
      `  ${SERVER_NAME} --sync       Sync the docs index and exit\n` +
      `  ${SERVER_NAME} --sync --force  Re-index everything and exit\n` +
      `  ${SERVER_NAME} --status     Show index status and exit\n` +
      `  ${SERVER_NAME} --version    Print the version\n` +
      `  ${SERVER_NAME} --help       Show this help\n\n` +
      'Environment:\n' +
      '  ROKU_DOCS_MCP_DATA_DIR     Override the data directory\n' +
      '  ROKU_DOCS_MCP_MAX_AGE_DAYS Background refresh threshold (default 7, 0 disables)\n' +
      '  GITHUB_TOKEN               Raise GitHub API rate limits (optional)\n\n' +
      `Data directory: ${dataDir()}\n`
  );
  process.exit(0);
}

if (args.has('--version') || args.has('-v')) {
  process.stdout.write(`${SERVER_VERSION}\n`);
  process.exit(0);
}

if (args.has('--status')) {
  const s = syncStatus();
  const age = indexAgeDays();
  const max = maxAgeDays();
  process.stdout.write(
    `${SERVER_NAME} v${SERVER_VERSION}\n` +
      `  source:      ${REPO}@${REF}\n` +
      `  database:    ${dbPath()}\n` +
      `  documents:   ${s.docCount}\n` +
      `  last synced: ${s.lastSyncedAt ?? 'never'}` +
      `${age === null ? '' : ` (${age.toFixed(1)} days ago)`}\n` +
      `  commit:      ${s.lastSyncedSha ?? 'unknown'}\n` +
      `  auto-refresh: ${
        max <= 0
          ? 'disabled'
          : `after ${max} day(s) — currently ${isStale() ? 'STALE, will refresh on next start' : 'fresh'}`
      }\n`
  );
  process.exit(0);
}

if (args.has('--sync')) {
  try {
    const r = await syncDocs({
      force: args.has('--force'),
      onProgress: (m) => process.stdout.write(`${m}\n`),
    });
    process.stdout.write(
      r.skipped
        ? `Already up to date — ${r.total} documents indexed.\n`
        : `Done in ${(r.durationMs / 1000).toFixed(1)}s: ` +
            `+${r.added} added, ~${r.updated} updated, -${r.removed} removed, ` +
            `${r.unchanged} unchanged (${r.total} total).\n`
    );
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Sync failed: ${err.message}\n`);
    process.exit(1);
  }
}

const unknown = [...args].filter((a) => a.startsWith('-') && a !== '--force');
if (unknown.length) {
  process.stderr.write(`Unknown option(s): ${unknown.join(', ')}\nTry --help.\n`);
  process.exit(2);
}

try {
  await start();
} catch (err) {
  log(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
}
