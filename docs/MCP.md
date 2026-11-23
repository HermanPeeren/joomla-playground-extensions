# An AI assistant in the Joomla Playground

*Status 2026-11-23: in this fork only (`HermanPeeren/joomla-playground-extensions`), live on
<https://hermanpeeren.github.io/joomla-playground-extensions/>. The server is on npm as
[`@hermanpeeren/joomla-playground-mcp`](https://www.npmjs.com/package/@hermanpeeren/joomla-playground-mcp).*

The playground can connect to an AI assistant on your computer, such as Claude Code, Claude Desktop, Codex,
Gemini CLI or another client of the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP). The
assistant then works on the Joomla site in your browser tab:

- it reads, searches and changes the site's files
- it runs PHP code and Joomla's console
- it sends requests to the site
- it shows you the page it changed

You watch the result in the tab while it works.

This page tells the story: how it works, an example, what it is good for, and its limits. The reference pages are:

- [mcp/README.md](../mcp/README.md): installing, the tools, options, security and tests
- [skills/joomla-playground](../skills/joomla-playground/SKILL.md): the guide the assistant itself reads
- [docs/SITE-API.md](SITE-API.md): the file and PHP operations the tools build on
- [docs/WORDPRESS-MCP.md](WORDPRESS-MCP.md): how WordPress Playground does the same, and what we took from it

## How it works

```
AI assistant ──stdio──▶ MCP server (mcp/, Node.js) ◀──WebSocket on 127.0.0.1── playground tab
                                                                                   │
                                                                     site API in the PHP worker
                                                                     (files, PHP, requests, console)
```

1. **The assistant starts the server.** The MCP server in `mcp/` is a small Node.js program, and the assistant
   starts it on your computer. It listens on 127.0.0.1, port 5480 by default.
2. **You open the playground with a link.** The assistant gives you a link that ends in `?mcp-port=5480`.
3. **You allow the connection.** The page asks whether it may connect. Chrome and Edge also ask for their Local
   Network Access permission, because a website wants to reach your own computer.
4. **The tab connects.** It fetches a token from the server and opens a WebSocket. The toolbar shows
   **AI assistant ●**.
5. **The assistant works through the tab.** Each tool call goes from the assistant to the server, from there to the
   tab, and then into the PHP worker. The answer goes back the same way.

The site never leaves your browser. The server is only a messenger: it has no copy of the site and no access to
your own files.

## An example

Here is an example session in Claude Code:

> **You:** Open the Joomla Playground and show the reading time under every article title.
>
> **Assistant:** *(calls `joomla_playground_url`)* Open this link and allow the connection:
> `https://hermanpeeren.github.io/joomla-playground-extensions/?mcp-port=5480`
>
> *(You open it, allow both questions, and the toolbar shows **AI assistant ●**.)*
>
> **Assistant:** *(calls `joomla_site_info` for the Joomla and PHP versions)*
> *(`joomla_search_files` for the article layout in `components/com_content/tmpl/article`)*
> *(`joomla_read_file` of `default.php`, then `joomla_write_file` of a template override
> `templates/cassiopeia/html/com_content/article/default.php` that adds the reading time)*
> *(`joomla_show_page` with `/index.php?option=com_content&view=article&id=1`)*
> Done: the article page now shows "4 min read" under the title. It is an override, so Joomla's own files are
> unchanged.

Other things you can ask for:

- "Install this extension zip and show me its settings."
- "Why does this page give an error? Fix it."
- "Run `extension:list` and tell me what is not from Joomla itself."
- "Add ten test articles in two categories."
- "Open the playground with JCB and build a small component with one list view." (`?blueprint=jcb`)

## What it is good for

- **A real Joomla site without setting up anything.** You don't need a local server, a database or an
  installation. The assistant gets a complete site within seconds, and you see the result in your own browser.
- **Safe experiments.** The site is a sandbox. If something breaks, open a new playground. A temporary playground
  is gone after a reload, and **Save…** keeps one in your browser.
- **The assistant checks its own work.** It can request a page, read the status and the error, and try again
  before it tells you it is done.
- **Developer level, not just content.** The assistant gets files, PHP, the console and requests, not only
  articles. That is what developing an extension, a template override or a fix needs.
- **Sharing a starting point.** A blueprint link (`?blueprint=jcb`) gives everyone the same site to start from.

## From playground to a real site

The playground is for building and trying. Your code reaches a real site in one of three ways:

- **Code (an extension, a template override, a child template): through the assistant.** It can read the files it
  made in the playground and write them into your own repository on your computer, with its normal file tools.
  From there you use your normal process: build the zip, test, install it on the real site.
- **A test or demo site: Export.** **Export** in the toolbar gives a zip of the whole site. It runs on an ordinary
  PHP server, with SQLite; see [Putting an exported site on a server](../README.md#putting-an-exported-site-on-a-server).
  Joomla itself does not support SQLite, so this is not the way to set up a production site.
- **Content: by hand for now.** There is no tool yet that moves articles and menus to a MySQL site.

## Joomla's own MCP server is something else

The Joomla project works on its own MCP server, in
[joomla-projects/joomla-mcp](https://github.com/joomla-projects/joomla-mcp): `com_mcp` with an endpoint
`/api/index.php/v1/mcp`. The two complement each other:

| | Joomla's own MCP server | This playground's MCP server |
|---|---|---|
| Where it runs | Inside a real Joomla site, as a component | On your computer, next to a playground tab |
| What it is for | Managing a site: articles, configuration, cache | Developing and trying things in a sandbox |
| Level | Content, through Joomla's abilities | Files, PHP, the console, requests |
| Access | API token per MCP client | Your consent per tab, loopback only |

The playground can host Joomla's own MCP server too: a blueprint with `com_mcp` installed, tested through
`joomla_request`. That is not built yet.

## Security

- **Your computer only.** The server listens on 127.0.0.1 only, so other computers cannot reach it.
- **The playground's own pages only.** The connection token is handed out only to the playground's own origin and
  to localhost, so another website cannot pose as the playground.
- **Your consent.** The tab connects only after you allow it, and Chrome asks a second time.
- **One tab at a time.** A new tab replaces the older one, and the older one stops.
- **What the assistant can do.** Once connected, it can do in the playground site everything PHP can, deleting
  included. It cannot reach your computer's own files through these tools; your assistant's own file tools are a
  separate matter of your assistant's settings.

## Limits

- **Browsers:** it works in Chrome, Edge and Firefox on a desktop. Safari and in-app browsers may block a website
  from connecting to 127.0.0.1.
- **The playground's own limits:**
  - SQLite behind a MySQL emulation
  - no `intl`
  - mail is caught, not sent
  - PHP's outgoing requests go only through the proxy
  - a temporary site is lost after a reload
- **Not there yet:**
  - Web Services API tokens
  - saving and renaming sites through the tools
  - tools that extensions register inside the site, the way WordPress plugins can
  - several sites at once

## Sources

**Specifications:**
- Model Context Protocol: <https://modelcontextprotocol.io/>
- WebMCP: <https://github.com/webmachinelearning/webmcp>
- Chrome's Local Network Access: <https://developer.chrome.com/blog/local-network-access>

**Code:**
- WordPress Playground's MCP server: <https://www.npmjs.com/package/@wp-playground/mcp>
- Joomla's own MCP server: <https://github.com/joomla-projects/joomla-mcp>

**This repository:**
- [mcp/README.md](../mcp/README.md)
- [mcp/tools.js](../mcp/tools.js)
- [web/src/mcp-bridge.js](../web/src/mcp-bridge.js)
- [docs/SITE-API.md](SITE-API.md)
- [docs/WORDPRESS-MCP.md](WORDPRESS-MCP.md)

**Earlier analysis:** "joomla-mcp repository analysis 2026-11-15" and "Joomla MCP Servers Compared", Herman
Peeren's notes, November 2026.
