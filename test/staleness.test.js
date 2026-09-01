import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point at a throwaway database before anything opens one.
const DIR = mkdtempSync(join(tmpdir(), 'roku-docs-staleness-'));
process.env.ROKU_DOCS_MCP_DATA_DIR = DIR;

const { setMeta, upsertDoc, closeDb } = await import('../src/db.js');
const { DEFAULT_MAX_AGE_DAYS, indexAgeDays, isStale, maxAgeDays } = await import('../src/sync.js');

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

/** Restore the env var after each case that changes it. */
function withMaxAge(value, fn) {
  const prior = process.env.ROKU_DOCS_MCP_MAX_AGE_DAYS;
  if (value === undefined) delete process.env.ROKU_DOCS_MCP_MAX_AGE_DAYS;
  else process.env.ROKU_DOCS_MCP_MAX_AGE_DAYS = String(value);
  try {
    fn();
  } finally {
    if (prior === undefined) delete process.env.ROKU_DOCS_MCP_MAX_AGE_DAYS;
    else process.env.ROKU_DOCS_MCP_MAX_AGE_DAYS = prior;
  }
}

test.after(() => {
  closeDb();
  rmSync(DIR, { recursive: true, force: true });
});

test('maxAgeDays defaults to 7 and honours the env override', () => {
  withMaxAge(undefined, () => assert.equal(maxAgeDays(), DEFAULT_MAX_AGE_DAYS));
  withMaxAge(undefined, () => assert.equal(maxAgeDays(), 7));
  withMaxAge('14', () => assert.equal(maxAgeDays(), 14));
  withMaxAge('0.5', () => assert.equal(maxAgeDays(), 0.5));
  withMaxAge('0', () => assert.equal(maxAgeDays(), 0));
});

test('maxAgeDays falls back to the default on junk or negative input', () => {
  withMaxAge('nonsense', () => assert.equal(maxAgeDays(), 7));
  withMaxAge('-3', () => assert.equal(maxAgeDays(), 7));
  withMaxAge('', () => assert.equal(maxAgeDays(), 7));
});

test('indexAgeDays reads the stored timestamp', () => {
  setMeta('last_synced_at', daysAgo(3));
  const age = indexAgeDays();
  assert.ok(age >= 2.99 && age <= 3.01, `expected ~3 days, got ${age}`);
});

test('indexAgeDays returns null when never synced or unparseable', () => {
  setMeta('last_synced_at', '');
  assert.equal(indexAgeDays(), null);
  setMeta('last_synced_at', 'not-a-date');
  assert.equal(indexAgeDays(), null);
});

test('isStale triggers only past the threshold', () => {
  withMaxAge(7, () => {
    setMeta('last_synced_at', daysAgo(1));
    assert.equal(isStale(), false, '1 day old should be fresh');

    setMeta('last_synced_at', daysAgo(6.9));
    assert.equal(isStale(), false, 'just under 7 days should be fresh');

    setMeta('last_synced_at', daysAgo(7.1));
    assert.equal(isStale(), true, 'just over 7 days should be stale');

    setMeta('last_synced_at', daysAgo(400));
    assert.equal(isStale(), true, 'very old should be stale');
  });
});

test('an unparseable or missing timestamp counts as stale', () => {
  withMaxAge(7, () => {
    setMeta('last_synced_at', 'garbage');
    assert.equal(isStale(), true, 'a refresh repairs the bad timestamp');
  });
});

test('ROKU_DOCS_MCP_MAX_AGE_DAYS=0 disables the refresh entirely', () => {
  setMeta('last_synced_at', daysAgo(9999));
  withMaxAge(0, () => assert.equal(isStale(), false));
  // and confirm it is genuinely the override doing the work
  withMaxAge(7, () => assert.equal(isStale(), true));
});

test('a future timestamp (clock skew) is treated as fresh, not stale', () => {
  withMaxAge(7, () => {
    setMeta('last_synced_at', new Date(Date.now() + 86_400_000).toISOString());
    assert.equal(isStale(), false);
  });
});

test('a custom threshold shifts the boundary', () => {
  setMeta('last_synced_at', daysAgo(10));
  withMaxAge(30, () => assert.equal(isStale(), false, '10 days is fresh under a 30-day rule'));
  withMaxAge(1, () => assert.equal(isStale(), true, '10 days is stale under a 1-day rule'));
});

test('syncStatus surfaces the doc count alongside the timestamp', async () => {
  const { syncStatus } = await import('../src/sync.js');
  upsertDoc({ path: 'docs/x.md', title: 'X', excerpt: '', content: 'body', sha: 'a', bytes: 4 });
  const s = syncStatus();
  assert.equal(s.docCount, 1);
  assert.equal(s.syncing, false);
});
