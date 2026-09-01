import { homedir, platform, tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = 'roku-dev-doc-mcp';

/**
 * Resolve the per-user data directory for this package.
 *
 * Order of preference:
 *   1. $ROKU_DOCS_MCP_DATA_DIR (explicit override)
 *   2. platform convention ($XDG_DATA_HOME, ~/Library/Application Support, %LOCALAPPDATA%)
 *   3. ~/.roku-dev-doc-mcp
 *
 * Deliberately NOT relative to the install directory: once this is installed
 * globally that location may be read-only or shared between users.
 *
 * @returns {string} absolute path to an existing directory
 */
export function dataDir() {
  const dir = resolveDataDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resolveDataDir() {
  const override = process.env.ROKU_DOCS_MCP_DATA_DIR;
  if (override && override.trim()) return override.trim();

  const home = safeHomedir();

  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', APP_DIR);
  }
  if (platform() === 'win32') {
    const base = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(base, APP_DIR, 'Data');
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) return join(xdg.trim(), APP_DIR);
  return join(home, '.local', 'share', APP_DIR);
}

/** homedir() throws on some locked-down systems; fall back to tmp. */
function safeHomedir() {
  try {
    return homedir() || tmpdir();
  } catch {
    return tmpdir();
  }
}

/** @returns {string} absolute path to the SQLite database file */
export function dbPath() {
  return join(dataDir(), 'docs.sqlite');
}
