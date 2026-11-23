// The code panel: an editor beside the Joomla frame, for trying out changes to a site, such as the steps of the
// component tutorial. Edit a file, save it (Ctrl+S) and the frame shows the result: the page reloads.
//
// It works through the site API (site-api.js), so it never writes at the same time as a page request, and a save
// clears OPcache for the file. A PHP file is checked for syntax errors before it is saved. This module and
// CodeMirror load only when the panel is opened.

import { EditorState } from '@codemirror/state';
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

function extension(path) {
  return path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
}

function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';

  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}

/**
 * Builds the panel in `container` and returns its controls.
 *
 * context: { site(operation, args), reloadFrame(), onClose() }
 */
export function createCodePanel(container, context) {
  const dark = matchMedia('(prefers-color-scheme: dark)');
  /** Open files: path → { state, revision, saved (the text on the site), readOnly }. */
  const files = new Map();
  let current = null;

  container.innerHTML = `
    <div class="code-bar">
      <span class="code-file" aria-live="polite"></span>
      <label class="code-option" title="Reload the page in the frame after each save">
        <input type="checkbox" class="code-reload" checked> Reload after save
      </label>
      <button type="button" class="code-revert" title="Undo all changes since the last save of this file">Revert</button>
      <button type="button" class="code-save" title="Save (Ctrl+S)">Save</button>
      <button type="button" class="code-close" title="Close the code panel">Close</button>
    </div>
    <p class="code-message" role="status"></p>
    <div class="code-body">
      <nav class="code-tree" aria-label="Files of the site"></nav>
      <div class="code-editor"></div>
    </div>`;

  const elements = {
    file: container.querySelector('.code-file'),
    reload: container.querySelector('.code-reload'),
    revert: container.querySelector('.code-revert'),
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

    elements.file.textContent = current ? `${current}${modified ? ' ●' : ''}${files.get(current).readOnly ? ' (read-only)' : ''}` : 'No file open';
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
    ];
  }

  /** Opens a file of the site in the editor; edits of other open files are kept. */
  async function open(path) {
    path = path.replace(/^\/+/, '');

    if (current) {
      files.get(current).state = view.state;
    }

    if (!files.has(path)) {
      let file;

      try {
        file = await context.site('read', { path });
      } catch (error) {
        setMessage(`${path} could not be opened: ${error.message}`, 'error');

        return;
      }

      const readOnly = file.text === undefined || file.size > MAX_EDIT_SIZE;
      const text = file.text ?? '(A binary file: it cannot be edited here.)';

      files.set(path, {
        state: EditorState.create({ doc: text, extensions: extensions(path, readOnly) }),
        revision: file.revision,
        saved: text,
        readOnly,
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
        context.reloadFrame();
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

  const root = folderItem('', 'Site');

  elements.tree.append(Object.assign(document.createElement('ul'), { className: 'code-root' }));
  elements.tree.firstChild.append(root);
  root.querySelector('details').open = true;

  elements.save.onclick = () => save();
  elements.revert.onclick = revert;
  elements.close.onclick = () => context.onClose();
  renderState();

  return {
    open,
    view,
    /** Whether a file has changes that are not saved. */
    hasChanges: () => [...files.keys()].some(isModified),
  };
}
