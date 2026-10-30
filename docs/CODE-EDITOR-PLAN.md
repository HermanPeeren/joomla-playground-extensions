# A code editor in the playground: plan

A plan for editing the files of the running site in the playground, next to the site. Nothing of it is built yet.
It follows what JoomEngine did in its playground ("JoomEngine Code"), adapted to this playground's runtime.

## What JoomEngine built

[JoomEngine Playground](https://github.com/joomengine/playground) (Apache License 2.0) added JoomEngine Code in
October 2026. Its scope is in
[docs/joomengine-code-scope.md](https://github.com/joomengine/playground/blob/main/docs/joomengine-code-scope.md),
the debugger in
[docs/joomengine-code-debugger.md](https://github.com/joomengine/playground/blob/main/docs/joomengine-code-debugger.md).

| Part | How they do it | Where |
|---|---|---|
| Editor | The VS Code workbench in the browser: CodinGame's `@codingame/monaco-vscode-*` 38.1.3 (MIT), about 40 packages (explorer, editor groups, search, settings, TextMate grammars, themes, debug UI), loaded only when the editor is opened | `src/code/workbench.mjs` |
| Files | A VS Code `FileSystemProvider` for URIs `jec://<site>/<path>`. It asks the PHP worker for every operation; the editor holds no copy of the site | `src/code/file-provider.mjs` |
| File operations in the worker | stat, list, read, write, mkdir, copy, rename, delete, search, batches, a short recovery history. Confined to the document root (no `..`, symlinks checked, the root cannot be deleted). Runs in the same queue as PHP requests | `src/code/workspace-files.mjs` |
| Layout | Docked left, right or bottom, full workspace, floating panel, separate browser window | `src/code/layout.mjs`, `detached-tools.mjs` |
| Refresh | Saving writes the file; **Refresh site** reloads the page in the preview. Manual by default, optionally after each save | `src/code/refresh.mjs` |
| PHP language support | Their own index with `php-parser` (BSD-3-Clause): symbols, go to definition, completion, diagnostics | `src/code/languages-php.mjs` |
| PHP debugging | Sean Morris's `php-dbg-wasm` (phpdbg in WebAssembly) and their own C extension that makes phpdbg serve an HTTP request. One chosen request runs in a separate debugger worker with a copy of the files; the changes are copied back afterwards. A Debug Adapter Protocol adapter in the browser connects it to VS Code's debug UI | `src/code/debug-*.mjs`, `native/phpdbg/jec_phpdbg_http.c` |
| AI | Chat with an OpenAI-compatible endpoint and the user's own key; proposed changes shown as diffs to accept or reject | `src/code/ai-*.mjs` |

What we saw on 30 October 2026: the editor opens docked on the right, with the site's file tree. It works.

## What is different here

- **Our runtime is WordPress's `@php-wasm/web`.** Its browser builds have no debugger: the PHP 8.4 build brings
  only `intl` as an extension. `@php-wasm/node` does have Xdebug (`node-8-4/jspi/extensions/xdebug`). phpdbg is
  not built at all. JoomEngine's debugger cannot be reused: it is built for Sean Morris's runtime.
- **The worker already owns the files.** `web/src/php-worker.js` runs PHP, and its actions (`boot`, `save`,
  `exportSite`, `flush`) run one at a time in a queue, together with the requests from the service worker. Writing
  files from the editor fits in that queue.
- **Saved sites keep edits by themselves.** `journalFSEvents` notes every change below the document root, also
  changes that are not made by PHP. A file saved in the editor ends up in the next snapshot. A temporary
  playground stays temporary.
- **No OPcache.** A saved PHP file is used from the next request on, so no cache needs to be cleared. Joomla's own
  cache may still need **System > Clear Cache**.
- **License.** The playground is GPL-2.0-or-later; JoomEngine's code is Apache-2.0. Apache-2.0 code may be
  combined with GPLv3, not with GPLv2 only. So: use the same MIT packages (CodinGame, Monaco) and write our own
  modules after their design. Where we copy a file of theirs, keep its Apache-2.0 header, add their `NOTICE`, and
  say in the README that the combination is distributed under GPLv3.

## The plan

Work in this branch (`feat/code-editor`) of the fork; each step is a pull request that works on its own. When it
works well, offer it to [joomla-projects/joomla-playground](https://github.com/joomla-projects/joomla-playground).

### 1. Files in the worker

New worker actions, in the existing queue, confined to the document root:
`fs.list`, `fs.stat`, `fs.read`, `fs.write`, `fs.mkdir`, `fs.rename`, `fs.delete`, `fs.search`.
- Paths relative to the document root; reject `..`, NUL, backslashes, and symlinks that lead outside.
- Refuse to delete or rename the root itself, and `configuration.php` only after a confirmation.
- A revision (mtime and size) on every read; a write with an outdated revision fails, so the editor can offer
  a reload or an overwrite instead of silently losing a change made by Joomla.
- Unit tests in Node with `@php-wasm/node`, like the existing integration tests.

### 2. The editor

The VS Code workbench of CodinGame, like JoomEngine, rather than plain Monaco: it brings the explorer, tabs,
split editors, search, the command palette, and the debug UI that step 5 needs. Pinned versions, loaded only
when the editor is opened, so the playground starts as fast as now.
- A small set of services and grammars: files, explorer, search, TextMate, themes; PHP, JavaScript, CSS/SCSS,
  HTML, XML, INI, JSON, SQL, Markdown.
- A `FileSystemProvider` that calls the worker actions of step 1.
- A toolbar button **Code**; the editor docked on the right, with a divider to drag, and a full-width mode.
- The licenses and notices of the shipped packages in the build output, as JoomEngine does in
  `dependencies/joomengine-code/`.

Done when you can open a Joomla file, change it, save it and see the change after **Refresh site**, in a
temporary and in a saved playground.

### 3. Refresh and layout

- **Refresh site** in the editor and in the toolbar: waits for saves still running, then reloads the preview at the
  same address. Manual by default, optionally after each save.
- "Saved changes since the last refresh" next to it.
- Docked at the bottom; a floating panel; later perhaps a separate window. Remember the layout.
- On a phone: the editor takes the whole width, with a switch between editor and site.

### 4. PHP support

- First the TextMate grammar only (highlighting, brackets).
- Then an index with `php-parser` in a Web Worker: go to definition, completion of classes and methods of Joomla
  and the extension being edited. Like `languages-php.mjs`, our own code.

### 5. Debugging (research first)

There is no debugger in the browser builds of `@php-wasm`. Options, cheapest first:
1. **Debugging locally, in Node.** `wasm/serve.mjs` already serves a site with `@php-wasm/node`, which has
   Xdebug. Start it with Xdebug, and debug with VS Code or PhpStorm on your own computer. Small, and useful for
   developing the playground itself, but not in the browser.
2. **Xdebug in the browser.** Ask WordPress Playground whether an Xdebug build of `@php-wasm/web` is planned, or
   build `xdebug.so` for the web builds ourselves. The worker then needs a DBGp client (Xdebug's protocol), and the
   editor a Debug Adapter Protocol adapter for it. Most of the work, and the result JoomEngine has.
3. **Not:** porting JoomEngine's phpdbg bridge. It is built for another runtime and needs our own PHP builds.

### 6. Later, if wanted

- AI-assisted editing with the user's own key, with diffs to accept or reject, like JoomEngine. Optional; the
  editor must work without it.
- Upload and download of files and folders in the explorer (Export already gives the whole site).

## Tests

- Node: the worker's file actions (confinement, revisions, rename and delete).
- Browser (`tests/browser`): open the editor, edit `templates/cassiopeia/index.php`, save, refresh, see the
  change; the same in a saved site after reopening it; the playground's start time stays the same when the editor
  is never opened.
