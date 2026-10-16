/**
 * Node version guard.
 */
const MIN_MAJOR = 22;

const major = Number.parseInt(process.versions.node.split('.')[0], 10);

if (!Number.isFinite(major) || major < MIN_MAJOR) {
  process.stderr.write(
    `roku-dev-doc-mcp requires Node >= ${MIN_MAJOR}, but is running on ` +
      `Node ${process.versions.node} (${process.execPath}).\n\n` +
      'Its SQLite driver is a native module and cannot load on this version.\n' +
      'If an MCP client launched this, point its config at an absolute Node path\n' +
      'rather than relying on the bare command, for example:\n\n' +
      '  "command": "/path/to/node22/bin/node",\n' +
      '  "args": ["/path/to/roku-dev-doc-mcp/bin/roku-dev-doc-mcp.js"]\n'
  );
  process.exit(1);
}
