# From playground to developer playground: plan

*20 November 2026; replaces the code-editor plan of 30 October. Why these steps: [JOOMENGINE.md](JOOMENGINE.md).
Status 21 November 2026: steps 0, 1 and 2 are built in this fork (PRs #2 to #5); see the "Built" notes below.*

The playground is good at showing Joomla and extensions. JoomEngine shows what developers want on top: an editor,
debugging, a look in the database, the newest Joomla, and AI agents that can work in it. WordPress shows how an
agent outside the browser can work in a playground in a tab. This plan adds that to the Joomla Playground, in the
order that gives most for least, without making the start slower or the hosting harder.

## Rules

- **Nothing slower for visitors who do not use it.** Editor, database viewer and agent connection load only when
  asked for. The start time of `?blueprint=jcb` and of a plain playground stays as it is.
- **No new hosting requirements.** No cross-origin isolation, no server of our own; GitHub Pages keeps working.
- **One owner of the site.** Everything (page requests, editor, agent, blueprints) goes through the PHP worker's
  existing queue (`serialized()` in `web/src/php-worker.js`), so nothing writes at the same time.
- **General first.** What is useful for every Joomla playground goes to
  [joomla-projects/joomla-playground](https://github.com/joomla-projects/joomla-playground) as pull requests. This fork
  keeps the extension demos (`?blueprint=jcb`, later Extengen) and tries things out first.
- **Licences.** The playground is GPL-2.0-or-later; JoomEngine is Apache-2.0. Use the same MIT packages
  (CodinGame, Monaco) and write our own code after their design. A copied file keeps its Apache-2.0 header and
  JoomEngine's `NOTICE`, and the README then says the whole is distributed under GPLv3.

## 0. Catch up with upstream

The fork is 31 commits behind: guided tours, working inside an iframe, `@php-wasm` 3.1.62. Merge `upstream/main`
into the fork's `main`, rebuild, check `?blueprint=jcb` (fresh and prebuilt), deploy.

**Built** (21 November, fork PR #2).

## 1. A site API in the worker (foundation for steps 2 and 3)

New worker actions, in the existing queue:

| Action | What it does |
|---|---|
| `fs.list`, `fs.stat`, `fs.read` | Folders and files of the site, with a revision (mtime and size) |
| `fs.write`, `fs.mkdir`, `fs.rename`, `fs.delete` | Changes; a write with an outdated revision fails, so a change Joomla made is not lost silently |
| `fs.search` | Text search in the site, cancellable, with a limit |
| `php.run` | Run PHP code in the site's root, return output and errors |
| `site.request` | A request to the site (method, path, body), returning status, headers and body |
| `site.cli` | Joomla's console (`cli/joomla.php`), e.g. `extension:install`, `cache:clean` |

- Paths relative to the document root; reject `..`, NUL and backslashes; symlinks must stay inside; the root itself
  cannot be deleted or renamed.
- After every write: `opcache_invalidate()` of the file. OPcache is on (file cache, timestamps checked every
  2 seconds), so without it a saved PHP file can be ignored for up to 2 seconds.
- Saved sites keep the changes through the existing journal; temporary playgrounds stay temporary.
- Tests in Node (`@php-wasm/node`), like the existing integration tests: confinement, revisions, rename and delete
  of trees, OPcache.

**Built** (21 November, fork PR #3), with these differences from the plan:
- **One action:** `site` in the worker, with the operations info, stat, list, read, write, mkdir, rename, delete,
  search, runPhp, request and cli.
- **Revisions:** a revision is the SHA-256 of the content, not the mtime and size.
- **Reference:** [SITE-API.md](SITE-API.md).
- **Tests:** `tests/site-api/`.

## 2. AI agents: an MCP connection and an agent guide

Like `@wp-playground/mcp`: an AI client starts a small MCP server on the developer's computer; that server talks
over a WebSocket on `localhost` to the playground tab the developer has open. The agent and the developer work on
the same site, and the developer sees what the agent does.

```
AI client (stdio) → MCP server (Node, this repository: mcp/) → WebSocket on localhost → playground tab → PHP worker
```

- **Tools**, on top of step 1: `joomla_site_info`, `joomla_list_files`, `joomla_read_file`, `joomla_write_file`,
  `joomla_delete_file`, `joomla_run_php`, `joomla_request`, `joomla_cli`, `joomla_install_extension` (URL or file),
  `joomla_navigate` (show a page in the tab), `joomla_read_mail`, `joomla_export_site`, `joomla_run_blueprint`.
- **Connecting**: the page connects only when asked: a toolbar button **Connect agent**, or `?mcp=<port>`. It shows
  that an agent is connected, and every connection must be confirmed in the page. Only `ws://localhost` and
  `ws://127.0.0.1`. A pairing code shown in the page and given to the MCP server keeps other local programs out.
- **Package**: `npx joomla-playground-mcp` (name to be decided with the Joomla project), with a configuration example
  for Claude Code, Claude Desktop, Codex and Gemini CLI.
- **WebMCP** (`document.modelContext`, a draft supported by Chrome behind a flag): register the same tools on the
  page as well. Cheap once the tools exist; no Node needed for browsers that support it.
- **Agent guide**: an Agent Skill `skills/joomla-playground/SKILL.md`: what the playground is, the URL parameters
  and blueprint steps, the MCP tools, how to test an extension and hand over the result (Export), and what does not
  work (MySQL-only SQL in the emulation, hosts without CORS). JoomEngine's `testing/playground/` guide is the
  example.

Done when Claude Code, with only the MCP server configured, installs Weblinks in an open playground, adds a link
through Joomla's own model, shows the front end page in the tab, and exports the site.

**Built** (21 November, fork PRs #4 and #5). It differs from the plan in these ways:
- **Tools:** 14 tools (see [mcp/README.md](../mcp/README.md)).
  - Renamed: `joomla_navigate` became `joomla_show_page`, and `joomla_delete_file` became `joomla_delete`.
  - Added: `joomla_search_files`, `joomla_move`, `joomla_create_folder`, `joomla_file_info` and
    `joomla_playground_url`.
  - Not built: `joomla_install_extension`, `joomla_read_mail`, `joomla_export_site` and `joomla_run_blueprint`.
    An extension installs with `joomla_write_file` and `joomla_cli` (`extension:install`).
- **Connecting:** `?mcp-port=<port>` (default 5480), confirmed in the page once per tab.
  - There is no pairing code. The server gives its token only to the playground's own origins and localhost.
  - Chrome and Edge also ask for their Local Network Access permission.
  - The toolbar button shows the connection and disconnects it; it doesn't start one.
- **Package:** on npm as `@hermanpeeren/joomla-playground-mcp` (23 November 2026), started with `npx -y`.
- **Documentation:** [MCP.md](MCP.md), and the comparison with WordPress in [WORDPRESS-MCP.md](WORDPRESS-MCP.md).
- **The "done when" check:** the end-to-end tests in Chrome (`mcp/test/browser.test.mjs`) cover files, requests,
  the console and showing a page. On 21 November, a script did the Weblinks check through the MCP server, against
  a local build in Chrome:
  - it installed Weblinks with `joomla_write_file` and `joomla_cli`
  - it added a link through `WeblinkModel` with `joomla_run_php`
  - it showed the category, with the link, through `joomla_show_page`

  That run found two bugs, which are now fixed: the console missed `JOOMLA_MINIMUM_PHP`, and the skill's PHP
  bootstrap missed `defines.php`. Exporting is still the user's **Export** button. A run by a real assistant
  (Claude Code) is still to do.

## 3. The code editor

As in the October plan, now with JoomEngine's experience:

- The VS Code workbench of CodinGame (MIT), pinned, loaded only when **Code** is clicked. A small set of services:
  files, explorer, search, TextMate grammars and themes for PHP, JavaScript, CSS/SCSS, HTML, XML, INI, JSON, SQL,
  Markdown.
- A `FileSystemProvider` on the actions of step 1; URIs `joomla://<site>/<path>`, translated in one place.
- Docked right, divider to drag, full width; on a phone the editor takes the whole screen with a switch to the site.
- **Refresh site**, manual by default, optionally after each save; "saved changes since the last refresh".
- Later: PHP symbols, go to definition and completion with `php-parser` in a worker (JoomEngine's
  `languages-php.mjs` is the example, our own code); bottom dock and a floating panel.
- Licences and notices of the shipped packages in the build output.

Done when you can open `templates/cassiopeia/index.php`, change it, save, refresh and see the change, in a
temporary and in a saved playground, and the playground starts as fast as before when the editor is not opened.

## 4. Safer and exact links

- **Review before running.** A blueprint from another site (`blueprint-url`, or a blueprint in the URL hash) with
  `runPHP`, `runSql`, `writeFile`, `unzip` or extensions from other hosts is shown first: which steps, which
  downloads. Running it needs a click. The playground's own blueprints (`?blueprint=`) run at once.
- **Pinned packages.** `assets.json` gets an optional `sha256`; the build checks it, so a demo cannot change under a
  blueprint without a commit.

## 5. Joomla nightlies and upcoming releases

- Add Joomla's nightly builds (next patch, next minor, next major) and release candidates to the bundles, found
  from Joomla's own nightly and update feeds when the playground is built, every day.
- In the version selector under "Nightly" and "Upcoming"; `?joomla=nightly-6.3` or similar in links.
- With the Patch Tester blueprint this makes the playground a testing station for the Bug Squad. Ask the Joomla
  project which builds they want; each one adds about 30 MB to the site, not to a visitor's download.

## 6. A look in the database

Adminer (Apache-2.0 or GPL-2.0) with its SQLite driver on the site's database, loaded only when **DB** is clicked,
as JoomEngine does for MariaDB. It shows the SQLite tables as the emulation stores them; good enough to look and to
run a query. Check first how WordPress Playground shows its database, which is stored the same way.

## 7. Debugging

1. **In Node, now possible.** `wasm/serve.mjs` serves a site with `@php-wasm/node`, which has Xdebug.
   Start it with Xdebug, and connect VS Code or PhpStorm (or Chrome DevTools through `@php-wasm/xdebug-bridge`).
   For developing extensions and the playground itself on your own computer. Small.
2. **In the browser, later.** `@php-wasm/web` has no Xdebug. Ask WordPress Playground whether a web build with
   Xdebug is planned; without it, this means building it ourselves plus a DBGp client and a Debug Adapter Protocol
   adapter in the browser: what JoomEngine did with phpdbg, and the largest piece of work in this plan.

## 8. Small things

- Load `intl` (`@php-wasm/web` ships it as a loadable extension); check Joomla's language and date handling with it.
- A compact toolbar on phones (now six lines at 375 pixels).
- A daily build that tests the newest `@php-wasm` and packages before deploying, as JoomEngine's
  `refresh-packages.yml` does.
- Make the playground installable as a web app (manifest and icons): most of what JoomEngine Desktop gives, without
  a separate program.

## Not now

- **Real MariaDB.** It works at JoomEngine, at the price of a 30–50 s start, cross-origin isolation, a 16 MB module
  and 16 threads. The step-by-step evaluation in [PHP-RUNTIMES.md](PHP-RUNTIMES.md) remains the way to decide.
- **Switching to JoomEngine's int64 runtime.** We already have 64-bit integers; see [PHP-RUNTIMES.md](PHP-RUNTIMES.md).
- **Automatic saving.** Keep **Save…** optional: most demos should stay temporary.
- **An AI assistant inside the page** with the user's own key. An agent through MCP (step 2) gives more, with the
  tools developers already use.

## Order

Step 0, then 1 and 2 together (2 needs 1, and is the quickest way to prove 1 works), then 3. Steps 4, 5, 6 and 8 are
independent of each other and can be done in between; step 7.1 any time, step 7.2 last.

## Sources

- The analysis this plan is based on: [JOOMENGINE.md](JOOMENGINE.md) (with its own sources) and
  [PHP-RUNTIMES.md](PHP-RUNTIMES.md)
- JoomEngine's playground: https://github.com/joomengine/playground and https://playground.joomengine.org/
- JoomEngine's int64 PHP build: https://github.com/joomengine/php-wasm-int64
- JoomEngine Desktop: https://github.com/joomengine/joomengine and discussion
  https://github.com/joomengine/Joomla-Component-Builder/discussions/1032
- JoomEngine's agent skills: https://github.com/joomengine/skills
- WordPress Playground's MCP server: https://www.npmjs.com/package/@wp-playground/mcp and
  https://github.com/WordPress/wordpress-playground/tree/trunk/packages/playground/mcp
- WordPress Playground's Xdebug bridge: https://www.npmjs.com/package/@php-wasm/xdebug-bridge
- The code editor JoomEngine uses: https://github.com/CodinGame/monaco-vscode-api
- WebMCP: https://github.com/webmachinelearning/webmcp
- Agent Skills format: https://agentskills.io/
- The upstream playground: https://github.com/joomla-projects/joomla-playground
