// The code panel: an editor beside the Joomla frame, for trying out changes to a site, such as the steps of the
// component tutorial. Edit a file, save it (Ctrl+S) and the frame shows the result: the page reloads.
//
// It works through the site API (site-api.js), so it never writes at the same time as a page request, and a save
// clears OPcache for the file. A PHP file is checked for syntax errors before it is saved. This module and
// CodeMirror load only when the panel is opened.
//
// A blueprint can say which package it installed and which one came before it ("code": { "changes": ... }, as the
// component tutorial's steps do). The panel then lists the files this step changed, and shows those changes in the
// editor: removed lines in red, added lines in green.

import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentUnit, StreamLanguage } from '@codemirror/language';
import { indentWithTab } from '@codemirror/commands';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { php } from '@codemirror/lang-php';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { json } from '@codemirror/lang-json';
import { sql, MySQL } from '@codemirror/lang-sql';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { unifiedMergeView } from '@codemirror/merge';
import { readZip } from './zip-reader.js';

const LANGUAGES = {
  php: () => php(),
  js: () => javascript(),
  mjs: () => javascript(),
  css: () => css(),
  scss: () => css(),
  html: () => html(),
  htm: () => html(),
  xml: () => xml(),
  svg: () => xml(),
  json: () => json(),
  sql: () => sql({ dialect: MySQL }),
  ini: () => StreamLanguage.define(properties),
};

/** After a save, seconds until the panel says that the page does not come back (code that never ends?). */
const SLOW_PAGE = 15;

/** Larger files open read-only: an editor for code, not for data. */
const MAX_EDIT_SIZE = 2 * 1024 * 1024;

// A real PHP syntax check, without running the code: token_get_all() with TOKEN_PARSE throws a ParseError.
const CHECK_PHP = `
$code = base64_decode('%CODE%');
try {
  token_get_all($code, TOKEN_PARSE);
  echo json_encode(['ok' => true]);
} catch (ParseError $error) {
  echo json_encode(['ok' => false, 'line' => $error->getLine(), 'message' => $error->getMessage()]);
}`;

// A component's package, made from its files on the site, the way its manifest says the installer put them there:
// <files> in components/<element>, <administration><files> in administrator/components/<element>, <media> in
// media/<destination>, <languages> in (administrator/)language/<tag>, the manifest and the script file in the
// administrator folder. Prints the zip's path and how many files it has, as JSON.
const PACKAGE_FROM_SITE = `
$element = '%ELEMENT%';
$admin   = "administrator/components/$element";
$manifest = null;

foreach (glob("$admin/*.xml") as $file) {
  $xml = simplexml_load_file($file);

  if ($xml && $xml->getName() === 'extension' && (string) $xml['type'] === 'component') {
    $manifest = $file;
    break;
  }
}

if (!$manifest) {
  echo json_encode(['error' => "No manifest of $element in $admin"]);
  return;
}

$target = 'tmp/code-panel-' . $element . '.zip';
$zip = new ZipArchive();
$zip->open($target, ZipArchive::CREATE | ZipArchive::OVERWRITE);
$count = 0;
$add = function (string $site, string $package) use ($zip, &$count, &$add) {
  if (is_dir($site)) {
    foreach (scandir($site) as $name) {
      $name === '.' || $name === '..' || $add("$site/$name", "$package/$name");
    }
  } elseif (is_file($site)) {
    $zip->addFile($site, ltrim($package, '/'));
    $count++;
  }
};
$files = function ($node, string $site) use ($add) {
  if ($node === null || !count($node)) {
    return;
  }

  $folder = trim((string) $node['folder'], '/');

  foreach ($node->children() as $child) {
    $name = trim((string) $child, '/');

    if (in_array($child->getName(), ['folder', 'filename', 'file'], true)) {
      $add("$site/$name", ($folder === '' ? '' : "$folder/") . $name);
    }
  }
};
$languages = function ($node, string $site) use ($add) {
  if ($node === null || !count($node)) {
    return;
  }

  $folder = trim((string) $node['folder'], '/');

  foreach ($node->language as $language) {
    $path = trim((string) $language, '/');
    $add("$site/" . $language['tag'] . '/' . basename($path), ($folder === '' ? '' : "$folder/") . $path);
  }
};
$xml = simplexml_load_file($manifest);
$add($manifest, basename($manifest));
$files($xml->files, "components/$element");
$files($xml->administration->files, $admin);
$files($xml->media, 'media/' . ($xml->media['destination'] ?: $element));
$languages($xml->languages, 'language');
$languages($xml->administration->languages, 'administrator/language');

if ((string) $xml->scriptfile !== '') {
  $add("$admin/" . $xml->scriptfile, (string) $xml->scriptfile);
}

$zip->close();
echo json_encode(['zip' => $target, 'files' => $count]);`;

function extension(path) {
  return path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
}

/**
 * The files that differ between two packages, by their path on the site: path → { status, before, after }, with
 * status "added", "changed" or "removed". config: { from (URL, optional), to (URL), paths: { package path or
 * folder/: site path or folder/ } }; without "from", every file of "to" is new. Returns { changes, element (the
 * component of "to", or null) }.
 */
export async function packageChanges(config) {
  const read = async (url) => {
    if (!url) {
      return new Map();
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Cannot download ${url}: HTTP ${response.status}`);
    }

    return readZip(await response.arrayBuffer());
  };
  const [before, after] = await Promise.all([read(config.from), read(config.to)]);
  const decoder = new TextDecoder();
  // The longest match first: a file before the folder it is in.
  const paths = Object.entries(config.paths ?? {}).sort(([a], [b]) => b.length - a.length);
  const sitePath = (path) => {
    for (const [from, to] of paths) {
      if (path === from || (from.endsWith('/') && path.startsWith(from))) {
        return to + path.slice(from.length);
      }
    }

    return path;
  };
  const changes = new Map();
  // The component the package installs: <element> of its manifest, a .xml file at the package's root.
  let element = null;

  for (const [path, bytes] of after) {
    const manifest = !path.includes('/') && path.endsWith('.xml')
      ? new DOMParser().parseFromString(decoder.decode(bytes), 'application/xml').querySelector('extension[type="component"]')
      : null;

    element ??= manifest?.querySelector(':scope > element')?.textContent.trim() || null;
  }

  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const old = before.has(path) ? decoder.decode(before.get(path)) : null;
    const now = after.has(path) ? decoder.decode(after.get(path)) : null;

    if (old !== now) {
      changes.set(sitePath(path), {
        status: old === null ? 'added' : now === null ? 'removed' : 'changed',
        before: old ?? '',
        after: now ?? '',
      });
    }
  }

  return { changes: new Map([...changes].sort(([a], [b]) => a.localeCompare(b))), element };
}

function base64(text) {
  return base64Bytes(new TextEncoder().encode(text));
}

function base64Bytes(bytes) {
  let binary = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}

/**
 * Builds the panel in `container` and returns its controls.
 *
 * context: { site(operation, args), reloadFrame(), onClose(), changes: the blueprint's "changes" with absolute
 * URLs, or null }
 */
export function createCodePanel(container, context) {
  const dark = matchMedia('(prefers-color-scheme: dark)');
  /** Open files: path → { state, revision, saved (the text on the site), readOnly, removed }. */
  const files = new Map();
  let current = null;
  /** The files this step changed (see packageChanges()), once loaded; whether the editor shows the changes. */
  let changes = new Map();
  let showChanges = true;
  /** The component the step installs (its <element>), or null. */
  let element = null;
  const merge = new Compartment();

  container.innerHTML = `
    <div class="code-bar">
      <span class="code-file" aria-live="polite"></span>
      <label class="code-option" title="Reload the page in the frame after each save">
        <input type="checkbox" class="code-reload" checked> Reload after save
      </label>
      <button type="button" class="code-changes-toggle" aria-pressed="true" hidden title="Show what this step changed in the file">Changes</button>
      <button type="button" class="code-revert" title="Undo all changes since the last save of this file">Revert</button>
      <button type="button" class="code-save" title="Save (Ctrl+S)">Save</button>
      <button type="button" class="code-close" title="Close the code panel">Close</button>
    </div>
    <p class="code-message" role="status"></p>
    <div class="code-body">
      <nav class="code-tree" aria-label="Files of the site">
        <section class="code-step" hidden>
          <h2></h2>
          <div class="code-step-actions">
            <a class="code-previous" hidden></a>
            <a class="code-next" hidden></a>
          </div>
          <div class="code-step-actions">
            <button type="button" class="code-install" hidden title="Install the component again from its files on the site: needed after changes to its manifest, SQL files or languages, or a new namespace. The database stays as it is.">Install again</button>
            <button type="button" class="code-reset-step" hidden title="Install this step's package again: the component's files are as in the step, your changes to them are lost">Reset to step</button>
          </div>
          <ul></ul>
        </section>
      </nav>
      <div class="code-editor"></div>
    </div>`;

  const elements = {
    file: container.querySelector('.code-file'),
    reload: container.querySelector('.code-reload'),
    revert: container.querySelector('.code-revert'),
    changesToggle: container.querySelector('.code-changes-toggle'),
    step: container.querySelector('.code-step'),
    install: container.querySelector('.code-install'),
    resetStep: container.querySelector('.code-reset-step'),
    previous: container.querySelector('.code-previous'),
    next: container.querySelector('.code-next'),
    save: container.querySelector('.code-save'),
    close: container.querySelector('.code-close'),
    message: container.querySelector('.code-message'),
    tree: container.querySelector('.code-tree'),
    editor: container.querySelector('.code-editor'),
  };

  const view = new EditorView({ parent: elements.editor, state: EditorState.create({ doc: '' }) });

  function setMessage(text, kind = '') {
    elements.message.textContent = text;
    elements.message.dataset.kind = kind;
  }

  function isModified(path) {
    const file = files.get(path);

    // The open file's state is the editor's; the others keep theirs.
    return Boolean(file) && (path === current ? view.state : file.state).doc.toString() !== file.saved;
  }

  function renderState() {
    const modified = current && isModified(current);

    const file = current && files.get(current);
    const note = file?.removed ? ' (removed in this step)' : file?.readOnly ? ' (read-only)' : '';

    elements.file.textContent = current ? `${current}${modified ? ' ●' : ''}${note}` : 'No file open';
    elements.changesToggle.hidden = !current || !changes.has(current) || Boolean(file?.removed);
    elements.changesToggle.setAttribute('aria-pressed', String(showChanges));
    elements.save.disabled = !current || files.get(current).readOnly || !modified;
    elements.revert.disabled = !modified;

    for (const button of elements.tree.querySelectorAll('button[data-path]')) {
      button.classList.toggle('modified', isModified(button.dataset.path));
      button.toggleAttribute('aria-current', button.dataset.path === current);
    }
  }

  function extensions(path, readOnly) {
    const language = LANGUAGES[extension(path)];

    return [
      basicSetup,
      keymap.of([
        indentWithTab,
        { key: 'Mod-s', preventDefault: true, run: () => (save(), true) },
      ]),
      indentUnit.of('    '),
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of((update) => update.docChanged && renderState()),
      dark.matches ? oneDark : [],
      language ? language() : [],
      merge.of(mergeView(path)),
    ];
  }

  /** The changes of this step in a file, shown in its editor: its text before the step as the original. */
  function mergeView(path) {
    const change = changes.get(path);

    return showChanges && change && change.status !== 'removed'
      ? unifiedMergeView({ original: change.before, mergeControls: false, syntaxHighlightDeletions: true })
      : [];
  }

  /** After the changes were loaded or switched on or off: every open file shows them, or not. */
  function updateMergeViews() {
    for (const [path, file] of files) {
      if (path === current) {
        view.dispatch({ effects: merge.reconfigure(mergeView(path)) });
        file.state = view.state;
      } else {
        file.state = file.state.update({ effects: merge.reconfigure(mergeView(path)) }).state;
      }
    }

    renderState();
  }

  /** Opens a file of the site in the editor; edits of other open files are kept. */
  async function open(path) {
    path = path.replace(/^\/+/, '');
    await ready;

    if (current) {
      files.get(current).state = view.state;
    }

    if (!files.has(path)) {
      let file;

      try {
        file = await context.site('read', { path });
      } catch (error) {
        // A file this step removed: show what it was, read-only.
        if (error.code === 'NOT_FOUND' && changes.get(path)?.status === 'removed') {
          file = { text: changes.get(path).before, revision: null, removed: true };
        } else {
          setMessage(`${path} could not be opened: ${error.message}`, 'error');

          return;
        }
      }

      const readOnly = file.text === undefined || file.size > MAX_EDIT_SIZE || Boolean(file.removed);
      const text = file.text ?? '(A binary file: it cannot be edited here.)';

      files.set(path, {
        state: EditorState.create({ doc: text, extensions: extensions(path, readOnly) }),
        revision: file.revision,
        saved: text,
        readOnly,
        removed: Boolean(file.removed),
      });
    }

    current = path;
    view.setState(files.get(path).state);
    setMessage('');
    await revealInTree(path);
    renderState();
    view.focus();
  }

  /** A syntax error in PHP code: { line, message }, or null. */
  async function checkPhp(text) {
    const result = await context.site('runPhp', { code: CHECK_PHP.replace('%CODE%', base64(text)) });

    try {
      const check = JSON.parse(result.output);

      return check.ok ? null : check;
    } catch {
      // The check itself failed (it should not): do not block saving.
      return null;
    }
  }

  async function save({ overwrite = false } = {}) {
    if (!current || files.get(current).readOnly) {
      return;
    }

    const path = current;
    const file = files.get(path);
    const text = view.state.doc.toString();

    if (text === file.saved) {
      return;
    }

    elements.save.disabled = true;

    try {
      if (extension(path) === 'php') {
        const error = await checkPhp(text);

        if (error) {
          setMessage(`Not saved: ${error.message} on line ${error.line}.`, 'error');
          const line = view.state.doc.line(Math.min(Math.max(error.line, 1), view.state.doc.lines));

          view.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true });
          view.focus();

          return;
        }
      }

      const result = await context.site('write', { path, text, revision: overwrite ? undefined : file.revision });

      file.revision = result.revision;
      file.saved = text;
      file.state = view.state;
      setMessage(`Saved ${path}${elements.reload.checked ? '; the page reloads' : ''}.`, 'ok');

      if (elements.reload.checked) {
        reload();
      }
    } catch (error) {
      if (error.code === 'CONFLICT') {
        if (confirm(`${path} was changed on the site since you opened it (by Joomla, or an assistant). Overwrite it with your version?`)) {
          await save({ overwrite: true });

          return;
        }

        setMessage(`Not saved: ${path} changed on the site. Revert to load the site's version.`, 'error');
      } else {
        setMessage(`Not saved: ${error.message}`, 'error');
      }
    } finally {
      renderState();
    }
  }

  /** Back to the file as it is on the site now. */
  async function revert() {
    if (!current || !confirm(`Undo your changes to ${current}?`)) {
      return;
    }

    const path = current;

    files.delete(path);
    current = null;
    await open(path);
    setMessage(`${path} is as it is on the site.`, 'ok');
  }

  // The file tree: folders load their contents when they are opened.

  function folderItem(path, name) {
    const item = document.createElement('li');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const list = document.createElement('ul');

    summary.textContent = name;
    details.dataset.path = path;
    details.append(summary, list);
    details.addEventListener('toggle', () => details.open && fillFolder(details));
    item.append(details);

    return item;
  }

  function fileItem(path, name) {
    const item = document.createElement('li');
    const button = document.createElement('button');

    button.type = 'button';
    button.textContent = name;
    button.dataset.path = path;
    button.onclick = () => open(path);
    item.append(button);

    return item;
  }

  /** Folder → the promise of its contents, so a folder loads once even when it is opened twice meanwhile. */
  const loading = new WeakMap();

  function fillFolder(details) {
    if (!loading.has(details)) {
      loading.set(details, loadFolder(details));
    }

    return loading.get(details);
  }

  async function loadFolder(details) {
    const path = details.dataset.path;
    const list = details.querySelector(':scope > ul');

    try {
      const entries = await context.site('list', { path: path || '/' });

      list.replaceChildren(...entries.map(({ name, type }) => {
        const child = path ? `${path}/${name}` : name;

        return type === 'directory' ? folderItem(child, name) : fileItem(child, name);
      }));
    } catch (error) {
      list.replaceChildren(Object.assign(document.createElement('li'), { textContent: error.message }));
    }

    renderState();
  }

  /** Opens the folders down to `path` and scrolls its file into view. */
  async function revealInTree(path) {
    const parts = path.split('/');

    await fillFolder(elements.tree.querySelector('details'));

    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      const details = [...elements.tree.querySelectorAll('details')].find((item) => item.dataset.path === folder);

      if (!details) {
        return;
      }

      details.open = true;
      await fillFolder(details);
    }

    [...elements.tree.querySelectorAll('button[data-path]')].find((button) => button.dataset.path === path)?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Reloads the page in the frame. PHP in the browser has no time limit (set_time_limit() does nothing there), so
   * code that never ends keeps the site busy for good: say so when the page does not come back.
   */
  function reload() {
    const slow = setTimeout(() => {
      setMessage(
        `The page has not loaded after ${SLOW_PAGE} s. Does the code you saved run forever (a loop that does not end)? ` +
          'PHP in the browser cannot be stopped: Start over begins again, without your changes (copy them first), ' +
          'or wait if the page does a lot of work.',
        'error'
      );
    }, SLOW_PAGE * 1000);

    Promise.resolve(context.reloadFrame()).finally(() => clearTimeout(slow));
  }

  /** Whether a file has changes that are not saved. */
  function hasChanges() {
    return [...files.keys()].some(isModified);
  }

  /** The list of files this step changed, at the top of the tree. */
  async function loadChanges(config) {
    const heading = elements.step.querySelector('h2');
    const list = elements.step.querySelector('ul');
    const labels = { added: ['+', 'added'], changed: ['~', 'changed'], removed: ['−', 'removed'] };

    elements.step.hidden = false;
    heading.textContent = config.label ?? 'Changed in this step';

    // Links to the steps before and after this one, with the code panel open: { href, label }.
    for (const [link, target] of [[elements.previous, config.previous], [elements.next, config.next]]) {
      if (target?.href) {
        link.href = target.href;
        link.textContent = target.label;
        link.hidden = false;
      }
    }

    list.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Comparing…' }));

    try {
      ({ changes, element } = await packageChanges(config));
    } catch (error) {
      list.replaceChildren(Object.assign(document.createElement('li'), { textContent: error.message }));

      return;
    }

    list.replaceChildren(...[...changes].map(([path, change]) => {
      const slash = path.lastIndexOf('/');
      const item = fileItem(path, path.slice(slash + 1));
      const [sign, word] = labels[change.status];
      const button = item.querySelector('button');

      // The file's name, and its folder below it, smaller: the whole path is in the title.
      button.prepend(Object.assign(document.createElement('span'), { className: `code-status ${change.status}`, textContent: sign }));
      button.append(Object.assign(document.createElement('span'), { className: 'code-folder', textContent: slash > 0 ? path.slice(0, slash) : '' }));
      button.append(Object.assign(document.createElement('span'), { className: 'visually-hidden', textContent: ` (${word})` }));
      button.title = `${path} (${word})`;

      return item;
    }));
    elements.install.hidden = !element;
    elements.resetStep.hidden = !element;
    updateMergeViews();
  }

  /**
   * Installs the component again: from its files on the site (after changes to the manifest, the SQL files, the
   * languages or a new namespace, which Joomla only reads when installing), or from the step's own package (back to
   * the step). Joomla's console does it; the database tables stay as they are.
   */
  async function install(fromStep) {
    if (fromStep && !confirm(`Put the files of this step back? Your changes to the component's files are lost.`)) {
      return;
    }

    if (!fromStep && hasChanges() && !confirm('Some files have changes that are not saved. Install the files as they are on the site?')) {
      return;
    }

    elements.install.disabled = elements.resetStep.disabled = true;
    setMessage(fromStep ? 'Installing the step\'s package…' : `Installing ${element} from its files on the site…`);

    let zip = null;

    try {
      if (fromStep) {
        const response = await fetch(context.changes.to);

        if (!response.ok) {
          throw new Error(`Cannot download ${context.changes.to}: HTTP ${response.status}`);
        }

        zip = `tmp/code-panel-${element}.zip`;
        await context.site('write', { path: zip, base64: base64Bytes(new Uint8Array(await response.arrayBuffer())) });
      } else {
        const result = await context.site('runPhp', { code: PACKAGE_FROM_SITE.replace('%ELEMENT%', element) });
        const made = JSON.parse(result.output || '{}');

        if (!made.zip) {
          throw new Error(made.error ?? result.errors ?? 'The package could not be made');
        }

        zip = made.zip;
      }

      const info = await context.site('info');
      const result = await context.site('cli', { args: ['extension:install', `--path=${info.root}/${zip}`] });

      if (result.exitCode !== 0) {
        throw new Error((result.errors || result.output).trim().split('\n').slice(-3).join(' '));
      }

      // The files on the site may have changed: open files without unsaved changes are read again.
      for (const path of [...files.keys()]) {
        if (!isModified(path)) {
          files.delete(path);
        }
      }

      const reopen = current;

      current = null;
      reopen && (await open(reopen));
      setMessage(fromStep ? 'The step\'s files are back; the page reloads.' : `${element} is installed again; the page reloads.`, 'ok');
      reload();
    } catch (error) {
      setMessage(`Not installed: ${error.message}`, 'error');
    } finally {
      zip && (await context.site('delete', { path: zip }).catch(() => {}));
      elements.install.disabled = elements.resetStep.disabled = false;
      renderState();
    }
  }

  const root = folderItem('', 'Site');

  elements.tree.append(Object.assign(document.createElement('ul'), { className: 'code-root' }));
  elements.tree.querySelector('.code-root').append(root);
  root.querySelector('details').open = true;

  elements.install.onclick = () => install(false);
  elements.resetStep.onclick = () => install(true);
  elements.changesToggle.onclick = () => {
    showChanges = !showChanges;
    updateMergeViews();
  };
  elements.save.onclick = () => save();
  elements.revert.onclick = revert;
  elements.close.onclick = () => context.onClose();
  renderState();

  const ready = context.changes ? loadChanges(context.changes) : Promise.resolve();

  return {
    /** Done when the list of this step's changes has loaded. */
    ready,
    open,
    view,
    /** Whether a file has changes that are not saved. */
    hasChanges,
  };
}
