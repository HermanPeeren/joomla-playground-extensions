#!/usr/bin/env node
// The program: node server.mjs [--url=…] [--port=…] [--allow-origin=…] [--timeout=…]. See mcp-server.mjs.

import { start } from './mcp-server.mjs';

start().catch((error) => {
  process.stderr.write(`[joomla-playground-mcp] Cannot start: ${error.message}
`);
  process.exit(1);
});
