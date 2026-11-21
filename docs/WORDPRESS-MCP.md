# How WordPress Playground connects AI assistants (MCP)

*21 November 2026. Based on `@wp-playground/mcp` 3.1.x (the package and its source in WordPress/wordpress-playground),
the website code that starts the bridge (`init-mcp-bridge.ts`, `router.ts`) and the guide "Use WordPress Playground
with AI assistants through MCP".*

## The story in short

WordPress Playground runs WordPress entirely in a browser tab. An AI assistant such as Claude Code, Codex or Gemini
CLI runs somewhere else: in a terminal, or as a desktop app. To let the assistant work on the site in the tab,
WordPress built a small bridge:

```
AI assistant ──stdio──▶ MCP server (Node.js, npx @wp-playground/mcp)
                              │  WebSocket on 127.0.0.1:<port>
                              ▼
                 Playground tab in the user's browser ──▶ WordPress in PHP-WASM
```

1. The user adds the MCP server to the assistant once (`claude mcp add … npx -y @wp-playground/mcp`). The assistant
   starts it as a local process and talks to it over stdio.
2. The server opens an HTTP and WebSocket server on 127.0.0.1, on a free port (or `--port=`).
3. The assistant calls `playground_get_website_url` and gets
   `https://playground.wordpress.net/?mcp-port=<port>`. It gives that link to the user, or opens it.
4. The page sees `?mcp-port` and connects *outward* to the local server. The browser allows a public HTTPS page to
   open `ws://127.0.0.1`, because the loopback address counts as secure.
5. From then on the assistant's tool calls travel as JSON over the WebSocket to the tab. The tab runs them against
   the PHP instance through the normal Playground client API, and sends the result back.

The server never reaches into the browser. The browser tab connects to the server, so nothing works until the user
opens the link.

## Security model

- **Loopback only:** the server listens on 127.0.0.1, so other computers cannot reach it.
- **Allowed origins:** `localhost` and `127.0.0.1` on any port, `playground.wordpress.net`, and the origin given with
  `--url=` (for Personal Playground or a staging copy).
- **Session token:**
  - The page first fetches `GET /bridge-token`. The server answers only when the request's `Origin` is allowed, and
    the CORS header `Access-Control-Allow-Origin` names that origin.
  - The WebSocket must then carry `?token=…`, and its `Origin` must be allowed too.
  - So another website the user visits cannot read the token and pose as the playground.
- **No confirmation step:** the page connects as soon as the URL has `?mcp-port`. Opening the link is the consent.
- **Analytics:** the site logs an `mcpConnect` tracking event when a tab connects.

What this does *not* protect against:

- Any page served from `localhost` (any dev server on the user's machine) may get the token.
- Any local process can connect, because local processes are trusted anyway.
- Once connected, the assistant has full control of the site's PHP and files, by design.

## Tools

The assistant gets 17 tools, all named `playground_*`.

| Group | Tools |
|---|---|
| Sites and tabs | `list_sites`, `open_site_in_new_tab`, `rename_site`, `save_in_browser`, `get_website_url` |
| Browser | `navigate` (changes the page the user sees), `get_current_url` |
| Site | `get_site_info` (WordPress and PHP versions, site URL, document root) |
| Code and HTTP | `execute_php`, `request` |
| Files | `read_file`, `write_file`, `list_files`, `mkdir`, `delete_file`, `delete_directory`, `file_exists` |

Notable details:

- **Several sites and tabs.**
  - Every tab registers the sites it knows (temporary and saved in OPFS), and the server merges them.
  - Every tool takes a `siteId`, and `list_sites` must come first.
  - `open_site_in_new_tab` opens another site with the same `?mcp-port` and waits until that tab reports it as
    active.
- **Authenticated REST without setup.** For a request to `/wp-json/…`, the tool works out a REST nonce first:
  1. It writes a temporary PHP file that prints `wp_create_nonce('wp_rest')`.
  2. It requests that file and deletes it again.
  3. It sends the nonce as `X-WP-Nonce`.

  The assistant can then use the REST API as the logged-in admin.
- **Long, opinionated tool descriptions.**
  - `request` tells the model to prefer the REST API with `_fields`, to discover the Abilities API, and to fall back
    to PHP only for raw data.
  - `execute_php` warns that WordPress is not loaded automatically and that output is not truncated.
- **No root check.** Paths are absolute in the virtual file system (`/wordpress/…`), and nothing stops a call
  outside it.

## WebMCP

On top of the bridge, the website registers the same tools with WebMCP (`document.modelContext.registerTool`), a draft
browser API for agents that run *inside* the browser. This happens whether or not `?mcp-port` is set. It is a
progressive enhancement: failures are caught and logged. No CLI or WebSocket is needed then.

WordPress goes one step further:

- **Tools from inside the site.** A must-use plugin gives the WordPress document its own `document.modelContext`.
  Tools that a WordPress plugin registers there (on `wp_head` and `admin_head`) are re-offered by the outer
  Playground page:

  ```
  agent → page → PlaygroundClient → iframe → the plugin's own execute()
  ```

- **Per-page lifetime.** Those tools last as long as the page that registered them. A navigation starts with an
  empty list, and the login screen has none.

This turns any plugin into something an in-browser agent can call, without MCP code in the plugin.

## Capabilities and limitations

What it does well:

- The assistant works on the very site the user sees: logged-in admin screens, saved sites, redirects.
- `navigate` lets the assistant show the user the result.
- Saved sites and several tabs are first-class.
- REST calls are authenticated without any setup.
- It works with every stdio MCP client and needs no browser extension.

Limitations we found:

- **Node.js on the same computer.** It needs Node.js and npx on the computer that runs the browser. A phone or
  tablet cannot use it.
- **A second permission in Chrome.** A page on the internet that connects to 127.0.0.1 also needs Chrome's own
  permission for local network access, which recent Chrome versions ask for. That applies to every playground that
  works this way. We checked it for our page in Chrome 157: with the permission it connects, and without it the
  request fails.
- **The tab must stay open.** A temporary site is lost on a reload, so the docs advise calling `save_in_browser`
  early.
- **Text files only.**
  - `read_file` and `write_file` handle text only, so binary files are out.
  - There is no revision check, so the assistant can overwrite a change the site made meanwhile.
- **Missing tools:** no file search and no WP-CLI. The assistant has to list folders, or write PHP, to find things.
- **No output limit.** Large output (HTML pages, unbounded queries) lands in the model's context in full.
- **A new port per restart.** The port is random by default, so after the assistant restarts, an open tab cannot
  reconnect. The user has to open a new link.
- **Easy to pick the wrong site.** With several tabs and sites, the docs warn the user to check which site the
  assistant is using.
- **WebMCP is a draft.** It is behind a flag in Chrome and the API is still changing, so it is not widely usable yet.

## What we take for Joomla's playground

Taken over as it is:

- The architecture: stdio MCP server, WebSocket on 127.0.0.1, and the tab connecting outward only with `?mcp-port`.
- The origin allowlist and the token from a CORS-guarded endpoint.
- A tool that gives the exact URL, so the assistant never builds it itself.
- A `navigate` tool, called `joomla_show_page` here.
- WebMCP registration of the same tools.

Done differently (built on our [site API](SITE-API.md)):

| | WordPress | Joomla playground |
|---|---|---|
| Connecting | Automatic on `?mcp-port` | The page asks the user once per tab |
| Port | Random per start | Fixed default 5480, so an open tab reconnects after the assistant restarts (a free port if 5480 is taken) |
| Paths | Absolute, unchecked | Relative to the site root; `..` and links outside are refused |
| Writing | Text only, overwrites | Text or base64; a revision prevents overwriting a change made meanwhile |
| Finding code | No search | `joomla_search_files` with glob, regex and a result limit |
| Console | None | `joomla_cli` runs Joomla's console |
| PHP changes | Not addressed | OPcache is cleared for changed PHP files |
| Tabs | Many tabs and sites, `siteId` on every tool | One tab at a time: the newest one replaces the older one |

Worth taking later:

- **Authenticated Web Services API**, like their REST nonce trick. Joomla's `/api/` does not accept the session
  cookie; it needs an API token (or the Basic Auth plugin). The tool could create a token for the playground's admin
  and add the `X-Joomla-Token` header itself.
- **Save and rename tools.** Saving now asks the user for a name in the page, and that step should stay theirs.
- **Tools from inside the site through WebMCP**, so a Joomla extension can register its own tools. That is
  interesting for JCB: compile a component from the assistant.
- **Several sites at once**, if one tab turns out to be too few.
- **Model guidance in the tool descriptions**, like theirs: which tool fits which job, and keeping output small.

## Sources

- `@wp-playground/mcp` on npm (version 3.1.65; package 3.1.54 read in full): https://www.npmjs.com/package/@wp-playground/mcp
- Its source:
  - https://github.com/WordPress/wordpress-playground/tree/trunk/packages/playground/mcp
  - the bridge client: https://github.com/WordPress/wordpress-playground/blob/trunk/packages/playground/mcp/src/bridge-client.ts
  - the tool definitions: https://github.com/WordPress/wordpress-playground/blob/trunk/packages/playground/mcp/src/tools/tool-definitions.ts
- The package's README, with WebMCP and the tools a site registers: https://github.com/WordPress/wordpress-playground/blob/trunk/packages/playground/mcp/README.md
- Where the website starts the bridge and WebMCP: https://github.com/WordPress/wordpress-playground/blob/trunk/packages/playground/website/src/lib/state/redux/init-mcp-bridge.ts
- The `?mcp-port` check: https://github.com/WordPress/wordpress-playground/blob/trunk/packages/playground/website/src/lib/state/url/router.ts
- The guide "Use WordPress Playground with AI assistants through MCP": https://github.com/WordPress/wordpress-playground/blob/trunk/packages/docs/site/docs/main/guides/ai-assistants-mcp.md
- The announcement "Connect AI coding agents to WordPress Playground with MCP" (17 March 2026), linked from the guide: https://make.wordpress.org/playground/2026/03/17/connect-ai-coding-agents-to-wordpress-playground-with-mcp/
- The WebMCP proposal: https://github.com/webmachinelearning/webmcp
- Local Network Access, the permission Chrome asks before a public page reaches 127.0.0.1: https://github.com/WICG/local-network-access
- Our own check of that permission: Chrome 157 with Playwright, from https://hermanpeeren.github.io/joomla-playground-extensions/ to a bridge on 127.0.0.1, 21 November 2026
- Our own site API, which the Joomla tools build on: [SITE-API.md](SITE-API.md)
