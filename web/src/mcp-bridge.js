// Connects the playground to an AI assistant: to the MCP server of mcp/ on this computer (opened with
// ?mcp-port=<port>), and to an agent in the browser through WebMCP (document.modelContext), where a browser has it.
// The tools are those of mcp/tools.js; most of them call the site API of the PHP worker (web/src/site-api.js).

import { TOOLS, TOOLS_BY_NAME } from '../../mcp/tools.js';

const PROTOCOL = 1;
const STORAGE_KEY = 'joomla-playground-mcp-port';
const RETRY = 3000;
/** Close code of the bridge for a tab that another tab replaced (mcp/bridge.mjs). */
const REPLACED = 4000;

/**
 * The port of the assistant this tab may connect to: from ?mcp-port, after the user allowed it, or the one allowed
 * before in this tab (a reload, or a link that dropped the parameter). The parameter is removed from the address,
 * so a copied link does not connect another tab.
 */
export function allowedPort(url = new URL(location.href)) {
  const asked = url.searchParams.get('mcp-port');
  let allowed = null;

  try {
    allowed = sessionStorage.getItem(STORAGE_KEY);
  } catch {}

  if (asked !== null) {
    url.searchParams.delete('mcp-port');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);

    if (!/^\d{1,5}$/.test(asked) || Number(asked) < 1 || Number(asked) > 65535) {
      return null;
    }

    if (asked !== allowed) {
      const ok = confirm(
        'Connect this playground to the AI assistant on this computer (port ' + asked + ')?\n\n' +
        'The assistant can then read and change the files of this Joomla site, run PHP code and send requests to it. ' +
        'Only allow this if you just asked your assistant to open the playground.'
      );

      if (!ok) {
        return null;
      }

      try {
        sessionStorage.setItem(STORAGE_KEY, asked);
      } catch {}
    }

    return Number(asked);
  }

  return allowed && /^\d{1,5}$/.test(allowed) ? Number(allowed) : null;
}

/**
 * Runs a tool for an assistant.
 *
 * @param {object} context
 * @param {() => object|null} context.playground The running playground (null while it starts)
 * @param {(type: string, payload: object) => Promise<any>} context.call Sends an action to the PHP worker
 * @param {(url: string) => void} context.showUrl Shows a URL of the site in the playground's frame
 */
export async function runTool(name, args, { playground, call, showUrl }) {
  const tool = TOOLS_BY_NAME.get(name);

  if (!tool || (!tool.operation && !tool.page)) {
    throw Object.assign(new Error(`Unknown tool: ${name}`), { code: 'UNKNOWN_TOOL' });
  }

  const current = playground();

  if (!current) {
    throw Object.assign(new Error('The playground is starting; try again in a moment.'), { code: 'NOT_READY' });
  }

  if (tool.page === 'show') {
    const path = String(args?.path ?? '/');

    if (!path.startsWith('/') || path.startsWith('//')) {
      throw Object.assign(new Error('The path starts with a single "/".'), { code: 'INVALID_ARGUMENT' });
    }

    showUrl(`${current.siteUrl}${path}`);

    return { shown: path };
  }

  return call('site', { operation: tool.operation, args: args ?? {} });
}

/**
 * Keeps a connection to the MCP server on 127.0.0.1:port, reconnecting when it restarts.
 *
 * @param {number} port
 * @param {object} context See runTool(); also onState(state, detail) for the toolbar
 */
export function connectAssistant(port, context) {
  let socket = null;
  let timer = null;
  let stopped = false;

  const hello = () => {
    const current = context.playground();

    if (socket?.readyState === WebSocket.OPEN && current) {
      socket.send(JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL,
        playground: {
          siteUrl: current.siteUrl,
          joomla: current.manifest?.joomla ?? null,
          php: current.phpVersion ?? null,
          site: current.site ?? null,
          page: location.href,
        },
      }));
    }
  };

  const retry = () => {
    if (!stopped) {
      context.onState('waiting');
      timer = setTimeout(open, RETRY);
    }
  };

  async function open() {
    timer = null;

    let token;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/token`, { cache: 'no-store' });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      ({ token } = await response.json());
    } catch {
      retry();

      return;
    }

    if (stopped) {
      return;
    }

    socket = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
    socket.onopen = () => {
      context.onState('connected');
      hello();
    };
    socket.onmessage = async ({ data }) => {
      let message;

      try {
        message = JSON.parse(data);
      } catch {
        return;
      }

      if (message?.type !== 'call') {
        return;
      }

      const reply = (result) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: 'result', id: message.id, ...result }));

      try {
        reply({ value: await runTool(message.tool, message.args, context) });
      } catch (error) {
        reply({ error: String(error?.message ?? error), code: error?.code ?? null });
      }
    };
    socket.onclose = ({ code }) => {
      socket = null;

      if (code === REPLACED) {
        stopped = true;
        context.onState('replaced');
      } else {
        retry();
      }
    };
  }

  open();

  return {
    /** The playground started or changed: tell the assistant. */
    hello,
    stop() {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
      socket = null;

      try {
        sessionStorage.removeItem(STORAGE_KEY);
      } catch {}

      context.onState('off');
    },
  };
}

/**
 * Offers the tools to an agent in the browser through WebMCP, a draft browser API. Without it this does nothing.
 */
export async function registerWebMcpTools(context) {
  const modelContext = document.modelContext ?? navigator.modelContext;

  if (typeof modelContext?.registerTool !== 'function') {
    return false;
  }

  for (const tool of TOOLS.filter(({ operation, page }) => operation || page)) {
    await modelContext.registerTool({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      execute: async (input) => {
        try {
          return await runTool(tool.name, input, context);
        } catch (error) {
          return { error: `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}` };
        }
      },
    });
  }

  return true;
}
