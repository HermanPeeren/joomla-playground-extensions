// MCP server for the Joomla Playground: an AI assistant (Claude Code, Claude Desktop, Gemini CLI, …) works on a
// Joomla site that runs in the user's browser. See README.md.
//
// Options:
//   --url=<playground URL>   The playground to open (default: the playground of this fork on GitHub Pages)
//   --port=<port>            Port of the local bridge on 127.0.0.1 (default 5480; 0 for any free port)
//   --allow-origin=<origin>  Another origin whose playground may connect (may be repeated)
//   --timeout=<seconds>      How long a tool may run in the browser (default 300)

import { readFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { PlaygroundBridge } from './bridge.mjs';
import { TOOLS, TOOLS_BY_NAME } from './tools.js';

export const DEFAULT_URL = 'https://hermanpeeren.github.io/joomla-playground-extensions/';
export const DEFAULT_PORT = 5480;

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const log = (message) => process.stderr.write(`[joomla-playground-mcp] ${message}\n`);

function options(argv) {
  const values = (name) => argv.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.slice(name.length + 3));
  const url = new URL(values('url').at(-1) ?? DEFAULT_URL);
  const port = values('port').at(-1);
  const timeout = Number(values('timeout').at(-1) ?? 300);

  if (port !== undefined && !/^\d+$/.test(port)) {
    throw new Error(`--port must be a number, not "${port}"`);
  }

  return {
    url,
    port: port === undefined ? null : Number(port),
    origins: [url.origin, ...values('allow-origin')],
    timeout: timeout * 1000,
  };
}

/**
 * The URL that opens the playground and connects it to this server.
 */
function playgroundUrl(base, port, { blueprint, site } = {}) {
  const url = new URL(base);

  if (site) {
    url.searchParams.set('site', site);
  } else if (blueprint) {
    url.searchParams.set('blueprint', blueprint);
  }

  url.searchParams.set('mcp-port', String(port));

  return url.href;
}

/**
 * A tool's result as MCP content. A file's text is a block of its own, so it is not escaped as JSON.
 */
function content(value) {
  if (value && typeof value === 'object' && typeof value.text === 'string' && ('revision' in value || 'status' in value)) {
    const { text, ...rest } = value;

    return [
      { type: 'text', text: JSON.stringify(rest, null, 2) },
      { type: 'text', text },
    ];
  }

  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2) }];
}

export async function start(argv = process.argv.slice(2), { transport = new StdioServerTransport() } = {}) {
  const settings = options(argv);
  const bridge = new PlaygroundBridge({ origins: settings.origins, timeout: settings.timeout, log });

  if (settings.port === null) {
    try {
      await bridge.listen(DEFAULT_PORT);
    } catch (error) {
      if (error.code !== 'EADDRINUSE') {
        throw error;
      }

      // Another assistant runs a server already: this one takes a free port (joomla_playground_url gives it).
      log(`Port ${DEFAULT_PORT} is in use; taking a free port`);
      await bridge.listen(0);
    }
  } else {
    await bridge.listen(settings.port);
  }

  log(`Bridge on ws://127.0.0.1:${bridge.port}; open ${playgroundUrl(settings.url, bridge.port)}`);

  const server = new Server(
    { name: 'joomla-playground', title: 'Joomla Playground', version },
    {
      capabilities: { tools: {} },
      instructions:
        'These tools work on a Joomla site that runs in the user\'s browser (Joomla Playground). Start with ' +
        'joomla_site_info; when no playground is connected, give the user the URL from joomla_playground_url to ' +
        'open. Read a file before you change it and pass its revision to joomla_write_file. The site is a ' +
        'playground: changes stay in the browser, and only a site the user saved survives a reload.',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const tool = TOOLS_BY_NAME.get(params.name);
    const args = params.arguments ?? {};

    if (!tool) {
      return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${params.name}` }] };
    }

    if (tool.name === 'joomla_playground_url') {
      return {
        content: content({
          url: playgroundUrl(settings.url, bridge.port, args),
          connected: bridge.ready,
          site: bridge.tabInfo,
          note: bridge.ready
            ? 'A playground is connected. Opening this URL starts another playground, which replaces it.'
            : 'Ask the user to open this URL and allow the connection to the assistant.',
        }),
      };
    }

    // Just after the page reloaded, the tab may be on its way back.
    if (!bridge.ready && !(await bridge.waitUntilReady(3000))) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: bridge.tab
            ? 'NOT_READY: The playground tab is connected but its site is still starting (this can take a minute for ' +
              'a blueprint). Try again in a few seconds.'
            : 'NOT_CONNECTED: No Joomla Playground is connected. Ask the user to open ' +
              `${playgroundUrl(settings.url, bridge.port)} in their browser and allow the connection (the page asks, ` +
              'and Chrome may ask for access to this device too), then try again.',
        }],
      };
    }

    try {
      return { content: content(await bridge.call(tool.name, args)) };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `${error.code ? `${error.code}: ` : ''}${error.message}` }] };
    }
  });

  await server.connect(transport);
  log(`Joomla Playground MCP server ${version} on stdio`);

  const stop = async () => {
    await server.close();
    await bridge.close();
  };

  return { server, bridge, stop, url: playgroundUrl(settings.url, bridge.port) };
}
