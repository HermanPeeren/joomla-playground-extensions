---
name: joomla-playground
description: Work on a Joomla site that runs in the user's browser (Joomla Playground) through the joomla_* MCP tools. Use when the user asks to try, build, debug or demonstrate something in Joomla in the playground, or when joomla_* tools are available.
license: GPL-2.0-or-later
---

# Working on a Joomla Playground site

The Joomla Playground runs a complete Joomla site (PHP compiled to WebAssembly, the database on SQLite) in a browser
tab. The `joomla_*` tools of the `joomla-playground` MCP server act on that site. The tools come from
`mcp/README.md` in https://github.com/HermanPeeren/joomla-playground-extensions.

## Connecting

1. Call `joomla_site_info`.
2. If it says no playground is connected, call `joomla_playground_url` and give the user the link. Pass `blueprint`
   for a ready-made setup, for example `jcb` for Joomla Component Builder. Ask them to open it and allow the
   connection.
3. Then call `joomla_site_info` again. It gives the Joomla and PHP versions; check them before you rely on a
   feature.

Opening a new link starts a *new* playground in a new tab, and that tab replaces the connected one. Do not do this
in the middle of a task.

## Keeping the user's work

- **A temporary playground is lost on a reload.** If the work matters, ask the user to click **Save…** early. You
  cannot save it yourself: the name is their choice.
- **Saved sites keep your changes.** In a saved site, every change through the tools is kept in the browser.
- **Before you delete,** say what you will delete. `joomla_delete` with `recursive` cannot be undone.

## Changing files

- **Paths** are relative to the site's root: `templates/cassiopeia/index.php`, `administrator/components/com_content`.
- **Read first.** Read a file before you change it, and pass its `revision` to `joomla_write_file`.
  - `CONFLICT` means Joomla or the user changed the file meanwhile. Read it again and redo the change; do not write
    without a revision to force it.
  - `revision: null` creates a new file only.
- **PHP changes count at once.** A changed PHP file counts from the next request on; no cache clearing is needed for
  code.
- **Prefer overrides.** For Joomla's own output, use template overrides (`templates/<template>/html/...`) or a child
  template instead of changing core files.
- **Find code** with `joomla_search_files`: use `glob` (`*.php`, `*.xml`) and a `path` to stay small. For a class,
  search for `class Name` or the namespace line.

## Running things

- **The console:** `joomla_cli` runs Joomla's console and is the first choice for Joomla tasks:
  - `["list"]` shows the commands.
  - Common ones: `extension:list`, `extension:install --path=…`, `cache:clean`, `config:get`, `config:set`,
    `user:add`, `site:down` and `site:up`, `scheduler:list` and `scheduler:run`, `database:export`.
- **Installing an extension:** write the zip with `joomla_write_file` (`base64`) under `tmp/`, then run
  `["extension:install", "--path=tmp/<file>.zip"]`.
- **PHP code:** `joomla_run_php` runs code in the site's root. For Joomla's API, bootstrap it first:

  ```php
  define('_JEXEC', 1);
  define('JPATH_BASE', getcwd());
  require 'includes/defines.php';
  require 'includes/framework.php';
  $db = \Joomla\CMS\Factory::getContainer()->get(\Joomla\Database\DatabaseInterface::class);
  echo json_encode($db->setQuery('SELECT id, title FROM #__content LIMIT 5')->loadObjectList());
  ```

  Keep the output small: select fields, use `LIMIT`, and print JSON.
- **Requests:** `joomla_request` sends a request as the playground's own session, logged in to the administrator.
  - Use it to check a page's status, redirects or a form's result.
  - HTML pages are large; check `status` and search the text rather than reading it all.
  - The Web Services API (`/api/index.php/v1/...`) needs an API token (`X-Joomla-Token`); the session alone is not
    enough.

## Showing the result

Use `joomla_show_page` to open the page you changed, for example `/index.php?option=com_content&view=article&id=1`
or `/administrator/index.php?option=com_config`. Then tell the user what to look at.

## Limits of the playground

- **Outgoing requests:** PHP cannot connect to every host; downloads go through a proxy only where the playground
  has one. Prefer extension zips you can write yourself.
- **Mail** is caught, not sent. The user sees it under **Mail** in the toolbar.
- **Database:** it is SQLite behind Joomla's MySQL driver. Plain SQL works; exotic MySQL features may not.
- **Missing PHP extension:** there is no `intl`.
