# JoomEngine Playground, Desktop and Skills: what they do, and what we can learn

*20 November 2026; replaces the comparison of 30 October. About
[joomengine/playground](https://github.com/joomengine/playground) (Apache-2.0, at commit 3913d5e of 19 November),
[JoomEngine Desktop](https://github.com/joomengine/joomengine),
[JoomEngine Skills](https://github.com/joomengine/skills) and
[announcement #1032](https://github.com/joomengine/Joomla-Component-Builder/discussions/1032), compared with this
playground ([joomla-projects/joomla-playground](https://github.com/joomla-projects/joomla-playground) and this fork,
[HermanPeeren/joomla-playground-extensions](https://github.com/HermanPeeren/joomla-playground-extensions)) and with
[WordPress Playground](https://github.com/WordPress/wordpress-playground) (`@php-wasm` 3.1.65).
The PHP runtimes themselves are compared in [PHP-RUNTIMES.md](PHP-RUNTIMES.md).*

## In short

- JoomEngine Playground is now a **development environment for Joomla Component Builder (JCB)** in the browser.
  It has real MariaDB, a VS Code editor, PHP debugging of real Joomla requests, Adminer, a mail inbox, Joomla
  nightlies and upcoming releases, recipes for deployments, and guides for AI agents. It is built fast: 175 commits
  between 30 October and 19 November.
- Its PHP has **64-bit integers** since 1 November, from JoomEngine's own build
  ([php-wasm-int64](https://github.com/joomengine/php-wasm-int64)). Sean Morris's php-wasm itself is still 32-bit.
  This playground has had 64-bit integers all along, from `@php-wasm`. See [PHP-RUNTIMES.md](PHP-RUNTIMES.md).
- **JoomEngine Desktop** is a small native window (WebView2 on Windows, Qt WebEngine on Linux and macOS) around the
  hosted playground.joomengine.org, with its own browser profile. No local PHP or database, and it needs the
  internet to start.
- **JoomEngine Skills** are guides in the [Agent Skills](https://agentskills.io/specification) format (CC0) that let
  an AI agent build extensions *in JCB*, test them in the playground and hand over the result. The agent drives
  the playground through a browser, like a person: the playground has no connection for an agent outside the
  browser.
- **This playground is faster to start and simpler to host**: a prebuilt site starts in seconds, without
  cross-origin isolation. JoomEngine needs 30 to 50 seconds the first time.
- **What we can learn**, in order of value for Joomla: an MCP connection for AI agents (as WordPress has, and
  JoomEngine has not), an agent skill for the Joomla Playground, a code editor, Joomla nightlies, a review step
  before a shared link runs code, a database viewer, and debugging. The plan is in
  [DEVELOPER-PLAYGROUND-PLAN.md](DEVELOPER-PLAYGROUND-PLAN.md).

## What JoomEngine has now

### The playground

| Part | What it does |
|---|---|
| Runtime | php-wasm-int64 (PHP 8.3, 8.4, 8.5 with 64-bit integers; CGI in a PHP worker), every build takes the newest release. JoomEngine compiles its own extensions against it: a PDO driver for MariaDB, cURL over `fetch()`, Sodium, an HTTP stream adapter for `file_get_contents()`, and the phpdbg bridge. |
| Database | Real MariaDB ([lite4mariadb](https://github.com/shyim/lite4mariadb)) in a worker with 16 threads, through [mariadb-wasm-bridge](https://github.com/joomengine/mariadb-wasm-bridge). Needs `SharedArrayBuffer`, so cross-origin isolation (COOP and COEP headers). On GitHub Pages the service worker adds the headers and the page reloads once; it uses COEP `credentialless`, and falls back to `require-corp` where that is missing. |
| Versions | Joomla 5, 6 and 7: the current releases, the nightly builds (next patch, minor and major) and upcoming releases, found at build time from Joomla's feeds; JCB 5 and 6 from JCB's update server. Rebuilt every day. |
| Deployments | Recipes (`deploys/*.json`, with JSON schemas): packages pinned by URL and SHA-256 and served from the playground's own site, languages, site settings, menus, template, startup commands (Joomla CLI). A form to edit them; **Apply to this site** with a checkpoint first. A link with custom packages or commands is shown for review before it runs. Packages from private repositories (GitHub, Gitea, GitLab tokens). Prebuilt snapshots per Joomla release. |
| Saving | Automatic: the site (files and database) is kept in the browser's IndexedDB without a save step. One window owns the site; other tabs share it. Backups as explicit full copies; recovery of the files if the database fails. |
| Export | A complete site (`site/`, `database.sql`, `database.ndjson`, `export.json`, `DEPLOYMENT.md`, with a hash), files only, or SQL only. Upload restores a complete site. |
| JoomEngine Code | The VS Code workbench (CodinGame's packages), loaded only when opened: file tree, tabs, search, PHP language support of their own, layouts (docked, floating, separate window), **Refresh site**. PHP debugging of a real Joomla request with phpdbg: breakpoints, stepping, variables, call stack. An AI assistant with the user's own key, with changes shown as diffs. |
| DB | Adminer on the same database (about 250 KB extra). |
| Mail | An inbox for mail the site sends, with HTML, source and `.eml` download. |
| Network | PHP's HTTP requests go through `fetch()`; when CORS blocks one, once through JoomEngine's Cloudflare Worker. |
| UI | "Rocket", in 20 languages (also Hebrew and Arabic). |
| MCP | A deployment `jcb-mcp` with JoomEngine's Joomla MCP package. Only clients **in the same browser** can use it: "The static Playground URL does not expose a private browser instance to an external PHP client or a remote MCP connector" (Skills, `testing/playground/README.md`). |
| JavaScript API | `createPlayground()` returns a handle with `request`, `runPhp`, file operations, `exportSite` and more, for tests and harnesses; the shipped page keeps it private. |
| Tests | About 200 test files: unit, integration in Node with the real runtime and MariaDB, and Playwright in Chromium and Firefox (WebKit for start-up). A daily job refreshes all packages on a branch and only moves it to main when everything passes. |
| Mobile | "Complete mobile startup" (1 November). Their own docs: behaviour on physical devices "must be checked on the device separately". |

### Desktop

Released 19 and 20 November for Windows, macOS and Linux (many package formats). It opens
`https://playground.joomengine.org/` in a dedicated window with a persistent profile; other sites open in the normal
browser, downloads get a native Save dialog, pop-ups (the editor, Adminer) become native windows. It does **not**
contain PHP or MariaDB, and needs the internet to start ("Playground downloads Joomla, Joomla Component Builder,
PHP and MariaDB"). The announcement places it in a workflow: an agent builds a component in the playground,
exports the complete site, and you continue in Desktop. Deploying to a server (through OctoJoom) is announced as
work in progress.

### Skills

[joomengine/skills](https://github.com/joomengine/skills): seven skills in Agent Skills format, about 380 files,
CC0. They describe JCB's data model (components, admin views, fields, dynamic gets, Super Powers) with schemas and
workflows, so an agent turns a request into JCB records instead of hand-written code ("build in JCB from the
start"). `testing/playground/` tells the agent how to use the playground: through a browser tool, one action at a
time, the URL parameters, how to verify downloads by their SHA-256, and what does not work (no `mysqli`, no
sockets, no real mail). There is also an MCP route, but only for a native Joomla install with JoomEngine's MCP
package; in the playground the agent works through the browser.

## Measured

Same computer, Chrome in the Claude app's browser pane. On 20 November the pane was hidden, which slows pages down,
so those times are high for both sites.

| | This fork, `?blueprint=jcb` | JoomEngine, default (JCB) |
|---|---|---|
| First start, 30 Oct | 6.1 s (prebuilt site; 2.5 s from localhost) | 32 s after clicking Launch (plus a 9 s countdown) |
| First start, 20 Nov | 13.1 s | 50 s after clicking Launch |
| Reopen, 30 Oct | 6–13 s (starts again from the prebuilt site) | 7.6 s (resumes the saved site) |
| Compile JCB's Demo J6 component | 15.6–17.4 s | 13.1 s |
| Install it on the same site | 3.7 s | 2.8 s |
| PHP 8.4 build | 8.4.25, JSPI, OPcache (file cache) | 8.4.27, Asyncify, int64 |
| Extensions only one has | soap, OPcache | intl, sodium, MariaDB PDO, phpdbg |

Both run JCB's full loop: compile, download the zip, install it, open the generated component. In a phone-sized
viewport both start; ours wraps its toolbar over six lines. A real phone was not tested.

## Who can do what

| | Joomla Playground | JoomEngine Playground | WordPress Playground |
|---|---|---|---|
| Start | Seconds, from a prebuilt site | 30–50 s, real MariaDB | Seconds |
| Hosting | Any static host; no special headers | Needs cross-origin isolation; the service worker adds it | Any static host |
| Embedding in another site | Plain iframe | Only in an isolated parent page, with `allow="cross-origin-isolated"` | Plain iframe, plus a client library |
| Database | MySQL emulated on SQLite (gaps in MySQL-only SQL) | Real MariaDB | MySQL emulated on SQLite |
| PHP versions | 8.3, 8.4, 8.5 | 8.3, 8.4, 8.5 | 7.4–8.5 |
| Joomla versions | 6.2, 5.4 | 5, 6, 7: releases, nightlies, upcoming | (WordPress versions, nightly included) |
| Setup by link | Blueprints (`?blueprint=`, URL hash, `blueprint-url`) | Deploy recipes, `#deploy=` shares, review of custom code | Blueprints, a published standard with many steps |
| Code editor | No | VS Code workbench | A file browser with an editor in the site manager* |
| PHP debugging | No | In the browser (phpdbg) | Xdebug in Node, with the Playground CLI |
| Database viewer | No | Adminer | Adminer and phpMyAdmin* |
| Mail | Inbox | Inbox | —* |
| Saving | Optional (**Save…**), snapshots in OPFS | Automatic, IndexedDB, backups | Optional, in the browser or a local folder |
| AI agents | — | Agent Skills; agent drives the browser | **MCP server** into the open tab (`@wp-playground/mcp`), WebMCP |
| Local / CLI | `wasm/serve.mjs` for development | Desktop (a window around the website) | Playground CLI: a local server, folders mounted from disk |
| Languages | Language packs on board; guided tours in 8 languages | UI in 20 languages | — |
| Licence | GPL-2.0-or-later | Apache-2.0 | GPL-2.0-or-later |

\* Not checked for this report.

**Only JoomEngine:** real MariaDB, PHP debugging in the browser, the VS Code editor, Joomla nightlies and upcoming
releases, automatic saving with backups, JCB-specific recipes and private package sources, a desktop app.

**Only WordPress:** an MCP connection from an AI agent outside the browser to the playground in a tab, WebMCP tools
registered by the site itself, the CLI with Xdebug and mounted folders, the oldest PHP versions, a client library
for embedding.

**Only this playground:** the quickest start and the simplest hosting, Joomla's accredited language packs on board
(installing a language takes seconds), the guided tours of the Joomla User Guide, and being the official one.

## What we can learn

1. **Let AI agents in, from outside the browser.** JoomEngine's agents drive a browser; WordPress gives an agent an
   MCP server that talks to the open playground tab over a WebSocket on localhost, with tools such as
   `playground_execute_php`, `playground_read_file`, `playground_write_file`, `playground_request` and
   `playground_navigate`. For Joomla that would let Claude Code, Codex or Gemini install an extension, run PHP,
   read the log and look at a page in a playground the user also sees. Plus a short agent guide (an Agent Skill)
   for the Joomla Playground, like JoomEngine's `testing/playground`.
2. **A code editor, loaded only when wanted.** JoomEngine proves the VS Code workbench works in a Joomla playground.
   For this playground: the existing PHP worker already owns the files and the journal already saves edits. OPcache
   is on with a 2-second timestamp check, so the editor must clear a file from OPcache on save.
3. **Joomla nightlies and upcoming releases.** Testing the next patch release or Joomla 7 in one click is what
   Joomla's testers and the Bug Squad need; together with the Patch Tester blueprint it is a testing station.
4. **Review before running a shared link.** JoomEngine stops a shared configuration with custom packages or
   commands until the user agrees. This playground runs a blueprint from a link at once, `runPHP` included. The
   code runs only in the visitor's own tab, but a confirmation for blueprints from other sites is cheap and right.
5. **Pinned packages.** Recipes that pin each package by SHA-256 and serve it from the playground's own site make a
   demo reproducible. `assets.json` already serves packages from the site; a hash would make it exact.
6. **A database viewer.** Adminer runs on SQLite, so it can show this playground's database, although it shows the
   SQLite tables as they are stored.
7. **Debugging: start where it is cheap.** `@php-wasm/node` has Xdebug and `@php-wasm/xdebug-bridge` connects it to
   a debugger; the playground's `wasm/serve.mjs` already runs Joomla with `@php-wasm/node`. In the browser,
   `@php-wasm/web` has no debugger; JoomEngine needed its own phpdbg builds and a C extension for that.
8. **Not now:** real MariaDB (a 30–50 s start, cross-origin isolation, a 16 MB module and 16 threads: the evaluation
   in [PHP-RUNTIMES.md](PHP-RUNTIMES.md) stays the way to decide), a desktop app (an installable web app gives most
   of it), automatic saving (keep it optional: a temporary playground is what most demos want), and switching
   runtime.
9. **Small things:** `intl` is available for `@php-wasm/web` but not loaded here (JoomEngine has it); a compact
   toolbar on phones; and a daily test of the newest packages before they are deployed.

## Sources

- joomengine/playground README and docs (`joomengine-code-*.md`, `browser-compatibility.md`, `network.md`,
  `database-user-guide.md`, `mail-capture.md`), `versions.json`, `deploys/`, commits 30 October–19 November 2026
- joomengine/php-wasm-int64: README, `versions.json`, `docs/architecture.md`, `patches/`
- joomengine/joomengine: README, `src/desktop.hpp`, `src/qt.cpp`, `docs/using.md`, `docs/troubleshooting.md`
- joomengine/skills: `AGENTS.md`, `registries/skills.json`, `testing/playground/*`, `workflows/mcp.md`,
  `workflows/delivery.md`
- Discussion [#1032](https://github.com/joomengine/Joomla-Component-Builder/discussions/1032), 20 November 2026
- WordPress Playground: `packages/php-wasm/compile/php/Dockerfile`, npm `@wp-playground/mcp` and
  `@php-wasm/xdebug-bridge` 3.1.54–3.1.65 (READMEs)
- Measurements and phpinfo of playground.joomengine.org and hermanpeeren.github.io/joomla-playground-extensions,
  30 October and 20 November 2026
