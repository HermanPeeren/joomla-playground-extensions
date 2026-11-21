// The tools an AI assistant gets for a Joomla Playground site. Shared by the MCP server (server.mjs) and the
// playground page, which runs them (web/src/mcp-bridge.js) and also offers them through WebMCP.
//
// A tool with an "operation" calls that operation of the site API (web/src/site-api.js) with the tool's input as
// its arguments; a tool with a "page" action runs on the page itself; a tool with neither is answered by the MCP
// server without a tab.

const path = { type: 'string', description: 'Path relative to the site\'s root, e.g. "templates/cassiopeia/index.php"' };
const readOnly = { readOnlyHint: true, openWorldHint: false };
const changes = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const destroys = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

/** @type {Array<{name: string, title: string, description: string, inputSchema: object, annotations: object, operation?: string, page?: string}>} */
export const TOOLS = [
  {
    name: 'joomla_playground_url',
    title: 'Playground URL',
    description:
      'The URL of the Joomla Playground page that connects to this assistant. Give it to the user to open in their ' +
      'browser (Chrome, Edge or Firefox); the page asks them to allow the connection. Optionally starts from a ' +
      'blueprint (e.g. "jcb") or opens a site the user saved in the browser.',
    inputSchema: {
      type: 'object',
      properties: {
        blueprint: { type: 'string', description: 'Name of a blueprint of the playground, e.g. "jcb"' },
        site: { type: 'string', description: 'Name (slug) of a site saved in the browser' },
      },
      additionalProperties: false,
    },
    annotations: readOnly,
  },
  {
    name: 'joomla_site_info',
    title: 'Site information',
    description: 'The connected playground site: its URL, Joomla and PHP versions, and the limits of the file tools.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: readOnly,
    operation: 'info',
  },
  {
    name: 'joomla_list_files',
    title: 'List files',
    description: 'Lists a folder of the site: folders first, then files.',
    inputSchema: { type: 'object', properties: { path: { ...path, default: '' } }, additionalProperties: false },
    annotations: readOnly,
    operation: 'list',
  },
  {
    name: 'joomla_file_info',
    title: 'File information',
    description: 'Whether a path exists and what it is (file, directory or symlink); for a file its size and revision.',
    inputSchema: { type: 'object', properties: { path }, required: ['path'], additionalProperties: false },
    annotations: readOnly,
    operation: 'stat',
  },
  {
    name: 'joomla_read_file',
    title: 'Read a file',
    description:
      'Reads a file of the site. Text files come as text, other files as base64. The revision identifies this ' +
      'content: pass it to joomla_write_file so a change made meanwhile is not overwritten.',
    inputSchema: { type: 'object', properties: { path }, required: ['path'], additionalProperties: false },
    annotations: readOnly,
    operation: 'read',
  },
  {
    name: 'joomla_write_file',
    title: 'Write a file',
    description:
      'Writes a file, creating missing folders. Give "revision" from joomla_read_file to change an existing file ' +
      'safely (fails with CONFLICT if it changed), null to create a new file only (fails with EXISTS), or leave it ' +
      'out to overwrite. A changed PHP file counts from the next request on.',
    inputSchema: {
      type: 'object',
      properties: {
        path,
        text: { type: 'string', description: 'The new content as text' },
        base64: { type: 'string', description: 'The new content as base64, for binary files' },
        revision: { type: ['string', 'null'], description: 'Revision from joomla_read_file, or null for a new file' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { ...changes, destructiveHint: true },
    operation: 'write',
  },
  {
    name: 'joomla_create_folder',
    title: 'Create a folder',
    description: 'Creates a folder and its missing parents.',
    inputSchema: { type: 'object', properties: { path }, required: ['path'], additionalProperties: false },
    annotations: { ...changes, idempotentHint: true },
    operation: 'mkdir',
  },
  {
    name: 'joomla_move',
    title: 'Move or rename',
    description: 'Moves or renames a file or folder. An existing file at the target is replaced only with "overwrite".',
    inputSchema: {
      type: 'object',
      properties: {
        from: path,
        to: path,
        overwrite: { type: 'boolean', default: false },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    annotations: destroys,
    operation: 'rename',
  },
  {
    name: 'joomla_delete',
    title: 'Delete',
    description: 'Deletes a file or folder; a folder with content only with "recursive".',
    inputSchema: {
      type: 'object',
      properties: { path, recursive: { type: 'boolean', default: false } },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: destroys,
    operation: 'delete',
  },
  {
    name: 'joomla_search_files',
    title: 'Search files',
    description:
      'Searches the text of the site\'s files, line by line. Skips caches, logs, tmp and media/vendor unless "all". ' +
      'Returns at most "limit" matches (200 at most).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to find, or a JavaScript regular expression with "regex"' },
        path: { ...path, description: 'Folder to search in (default: the whole site)' },
        regex: { type: 'boolean', default: false },
        caseSensitive: { type: 'boolean', default: false },
        glob: { type: 'string', description: 'Only files whose name matches, e.g. "*.php"' },
        all: { type: 'boolean', default: false, description: 'Also search caches, logs, tmp and media/vendor' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    annotations: readOnly,
    operation: 'search',
  },
  {
    name: 'joomla_run_php',
    title: 'Run PHP code',
    description:
      'Runs PHP code in the site\'s root folder, in the same PHP instance as the site; "<?php" may be left out. To ' +
      'use Joomla\'s API, bootstrap it first (define _JEXEC, require includes/defines.php and includes/framework.php).',
    inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    operation: 'runPhp',
  },
  {
    name: 'joomla_request',
    title: 'Send a request',
    description:
      'Sends an HTTP request to the site, as the playground\'s own session (logged in to the administrator when the ' +
      'playground is). The path starts with "/", e.g. "/index.php?option=com_content" or "/api/index.php/v1/content/articles".',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path and query, starting with "/"' },
        method: { type: 'string', default: 'GET' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    operation: 'request',
  },
  {
    name: 'joomla_cli',
    title: 'Joomla console',
    description:
      'Runs a command of Joomla\'s console (cli/joomla.php), e.g. ["list"], ["extension:list"], ["cache:clean"], ' +
      '["extension:install", "--path=tmp/pkg.zip"]. It never asks questions.',
    inputSchema: {
      type: 'object',
      properties: { args: { type: 'array', items: { type: 'string' }, description: 'The command and its options' } },
      required: ['args'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    operation: 'cli',
  },
  {
    name: 'joomla_show_page',
    title: 'Show a page',
    description: 'Opens a page of the site in the playground, so the user sees it, e.g. "/administrator/index.php?option=com_content".',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path and query, starting with "/"' } },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    page: 'show',
  },
];

/** The tools by name. */
export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
