# Joomla Playground MCP server

Lets an AI assistant (Claude Code, Claude Desktop, Codex, Gemini CLI or any other MCP client) work on a Joomla site
that runs in your browser in the [Joomla Playground](https://hermanpeeren.github.io/joomla-playground-extensions/).
The assistant can read, search and change the site's files, run PHP code, send requests to the site, run Joomla's
console and show you a page.

```
AI assistant ──stdio──▶ this MCP server ◀──WebSocket on 127.0.0.1── playground tab in your browser
```

The assistant starts this server on your computer. You open the playground with the link the assistant gives you.
The page asks whether it may connect, and then connects to the server. Nothing leaves your computer except the
playground page itself, which your browser loads as usual.

## Setting it up

You need Node.js 20 or later. The server is on npm as
[`@hermanpeeren/joomla-playground-mcp`](https://www.npmjs.com/package/@hermanpeeren/joomla-playground-mcp), and
your assistant starts it with `npx`, so there is nothing to install by hand.

**Claude Code**

```sh
claude mcp add --transport stdio --scope user joomla-playground -- npx -y @hermanpeeren/joomla-playground-mcp
```

**JSON configuration** (Claude Desktop's `claude_desktop_config.json`, a project's `.mcp.json`, Gemini CLI's
`settings.json`):

```json
{
  "mcpServers": {
    "joomla-playground": {
      "command": "npx",
      "args": ["-y", "@hermanpeeren/joomla-playground-mcp"]
    }
  }
}
```

Options (see below) go after the package name, e.g. `npx -y @hermanpeeren/joomla-playground-mcp --port=5481`.

**From a checkout** (to change the server itself):

```sh
git clone https://github.com/HermanPeeren/joomla-playground-extensions.git
cd joomla-playground-extensions/mcp
npm ci
claude mcp add --transport stdio --scope user joomla-playground -- node "$PWD/server.mjs"
```

## Using it

1. Ask your assistant to open the Joomla Playground, for example: "Open the Joomla Playground with JCB".
2. Open the link it gives you (`…?mcp-port=5480`) in Chrome, Edge or Firefox.
3. Allow the connection when the page asks. Chrome and Edge then also ask whether the site may access apps on your
   device (their Local Network Access permission): allow that too, since the server is on your own computer. The
   toolbar then shows **AI assistant ●**.
4. Ask the assistant what you want: "Find where the Cassiopeia template prints the footer and add a line to it",
   "Install this extension and show me its settings", "Why does this page give an error?".

Clicking **AI assistant ●** disconnects it. The connection lasts for that tab: it survives a reload, and a new link
connects a new tab, which then replaces the older one.

The site is a playground, so a temporary site is gone after a reload. Save it (**Save…**) to keep it in your browser.
The assistant's changes go into the saved site too.

## Tools

| Tool | What it does |
|---|---|
| `joomla_playground_url` | The link to open, optionally with a blueprint (`jcb`) or a saved site |
| `joomla_site_info` | Site URL, Joomla and PHP versions |
| `joomla_list_files`, `joomla_file_info`, `joomla_read_file` | Look at files and folders |
| `joomla_write_file`, `joomla_create_folder`, `joomla_move`, `joomla_delete` | Change them |
| `joomla_search_files` | Search the files' text, with glob, regex and a result limit |
| `joomla_run_php` | Run PHP code in the site's root |
| `joomla_request` | Send a request to the site, as the logged-in playground session |
| `joomla_cli` | Run a command of Joomla's console (`cli/joomla.php`) |
| `joomla_show_page` | Show a page of the site in the playground |

The tools build on the playground's [site API](https://github.com/HermanPeeren/joomla-playground-extensions/blob/main/docs/SITE-API.md). That API keeps every path inside the site's
root, prevents overwriting a file that changed meanwhile (revisions), and clears OPcache for changed PHP files.

The same tools are offered to agents in the browser through [WebMCP](https://github.com/webmachinelearning/webmcp)
(`document.modelContext`), in browsers that have it.

## Options

| Option | Default | |
|---|---|---|
| `--url=` | `https://hermanpeeren.github.io/joomla-playground-extensions/` | The playground to open, e.g. `http://localhost:5400/` for `npm run web:dev` |
| `--port=` | `5480` | Port on 127.0.0.1. If 5480 is taken, a free port is used. `0` always takes a free port |
| `--allow-origin=` | | Another origin whose playground may connect; may be repeated |
| `--timeout=` | `300` | Seconds a tool may take in the browser |

## Security

- **Loopback only:** the server listens on 127.0.0.1, so other computers cannot reach it.
- **Allowed origins:** a page gets the connection token only from the playground's own origin (the `--url` origin,
  `--allow-origin`) or from localhost. Another website you visit cannot connect and pose as the playground.
- **Consent:** the playground connects only when it is opened with `?mcp-port` and you allow it. The parameter is
  removed from the address, so a copied link does not connect another tab without asking.
- **What the assistant can do:** once connected, it can do everything in the playground site that PHP can,
  including deleting files. It cannot reach your computer's own files through these tools.

## Tests

```sh
npm test   # in mcp/: the server with a fake tab, and end to end in Chrome (needs npm run bundle && npm run web:build)
```
