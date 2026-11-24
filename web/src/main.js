// Main page of the Joomla Playground: registers the service worker, starts the PHP worker, shows Joomla in an
// iframe and offers saving, exporting and importing playgrounds.
//
// ?site=<slug> opens a site saved in this browser; without it, a new temporary playground starts, set up by the
// blueprint in the URL if there is one (see blueprint.js). ?new starts an empty one: the address without parameters
// is the overview (index.html sends it on to overview/). ?code=<path> opens the code panel with that file
// (code-panel.js).

import { deleteSite, freeSlug, isSiteOpen, listSites, readMeta, renameSite } from './storage.js';
import { PHP_VERSIONS, blueprintFromUrl } from './blueprint.js';
import { parseMail } from './mail.js';
import { allowedPort, connectAssistant, registerWebMcpTools } from './mcp-bridge.js';
import { forgetToken, gitHubHeaders, rememberToken, rememberedToken } from './github-token.js';

const base = new URL('./', location.href);

// A CORS proxy (proxy/cors-proxy.js) for downloads from hosts without CORS headers, by blueprints and by PHP itself;
// set at build time: VITE_CORS_PROXY=https://joomla-playground-cors-proxy.example.workers.dev/
const corsProxy = import.meta.env.VITE_CORS_PROXY || null;

const elements = {
  status: document.querySelector('#status'),
  loading: document.querySelector('#loading'),
  loadingStatus: document.querySelector('#loading-status'),
  frame: document.querySelector('#joomla'),
  site: document.querySelector('#open-site'),
  admin: document.querySelector('#open-admin'),
  newSite: document.querySelector('#new-site'),
  reset: document.querySelector('#reset-site'),
  php: document.querySelector('#php-version'),
  joomla: document.querySelector('#joomla-version'),
  save: document.querySelector('#save-site'),
  exportSite: document.querySelector('#export-site'),
  importSite: document.querySelector('#import-site'),
  importFile: document.querySelector('#import-file'),
  sitesMenu: document.querySelector('#sites-menu'),
  sitesList: document.querySelector('#sites-list'),
  credentials: document.querySelector('#credentials'),
  assistant: document.querySelector('#assistant'),
  stage: document.querySelector('#stage'),
  code: document.querySelector('#code'),
  codePanel: document.querySelector('#code-panel'),
  codeDivider: document.querySelector('#code-divider'),
  info: document.querySelector('#info'),
  mail: document.querySelector('#mail'),
  mailCount: document.querySelector('#mail-count'),
  mailDialog: document.querySelector('#mail-dialog'),
  mailList: document.querySelector('#mail-list'),
  mailHeaders: document.querySelector('#mail-headers'),
  mailView: document.querySelector('#mail-view'),
  pullRequest: document.querySelector('#pull-request'),
  pullRequestLink: document.querySelector('#pull-request-link'),
  pullRequestToggle: document.querySelector('#pull-request-toggle'),
  gitHubToken: document.querySelector('#github-token'),
  tokenDialog: document.querySelector('#token-dialog'),
  tokenForm: document.querySelector('#token-form'),
  tokenInput: document.querySelector('#token-input'),
  tokenState: document.querySelector('#token-state'),
  tokenError: document.querySelector('#token-error'),
  tokenForget: document.querySelector('#token-forget'),
};

let worker = null;
let workerUsed = false;
let workerError = null;
let playground = null;

/** The pull request of joomla-cms this playground tests (?pr=), or null: { number, method: "patchtester", test },
 *  test being the id of the Patch Tester's record while the pull request is applied; or { number, method: "package",
 *  package: { folder, built }, applied } for Joomla CI's build of it (see pullRequestMethod()). */
let pullRequest = null;

/**
 * The service worker serves the Joomla frame. It starts while PHP and the site are downloaded; only the frame waits
 * for it (show()).
 */
let serviceWorkerReady = null;
/** Settles when the frame has loaded the first page of the current playground (see show()). */
let firstPageLoaded = Promise.resolve();
let readyStatus = '';
let backgroundStatus = null;

/** The Joomla bundles of this playground: { default: '6.2.0', versions: [manifest, ...] } (joomla/versions.json). */
let bundles = null;
const pending = new Map();
/** The code panel (code-panel.js), once it was opened; codeRequested: the ?code file to open when ready. */
let codePanel = null;
let codeRequested = new URL(location.href).searchParams.get('code');
/** The blueprint's "code": { "changes" }, with absolute URLs: the packages the code panel compares. */
let codeChanges = null;
/** The connection to an AI assistant, if any (see setUpAssistant()). */
let assistant = null;
let nextId = 1;

/** The mails the running playground sent, newest first. */
let mails = [];
let selectedMail = null;

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.title = message;
  elements.status.classList.toggle('error', isError);
  elements.status.setAttribute('role', isError ? 'alert' : 'status');
  elements.status.setAttribute('aria-live', isError ? 'assertive' : 'polite');

  // While the loader shows, it says the same.
  elements.loadingStatus.textContent = message;
  elements.loading.classList.toggle('error', isError);
}

/**
 * Joomla's loader over the Joomla frame while a playground starts, until its first page has loaded.
 */
function setLoading(loading) {
  elements.loading.hidden = !loading;
}

// The loader is Joomla's own web component, from the default bundle (copied there by bin/build-browser-bundles.php).
import(/* @vite-ignore */ new URL('joomla/joomla-core-loader.js', base).href).catch(() => {});

function setBusy(busy) {
  for (const button of [elements.site, elements.admin, elements.newSite, elements.save, elements.exportSite, elements.importSite, elements.mail, elements.code, elements.php, elements.gitHubToken]) {
    button.disabled = busy;
  }

  elements.pullRequestToggle.disabled = busy || !pullRequest;

  // A saved site keeps the Joomla version it was made with.
  elements.joomla.disabled = busy || Boolean(playground?.site);

  // A saved site keeps its changes; starting over is for temporary playgrounds.
  elements.reset.disabled = busy || Boolean(playground?.site);

  elements.save.disabled = busy || Boolean(playground?.site);
}

/**
 * Sends an action to the PHP worker and waits for its result.
 */
function call(type, payload = {}, transfer = []) {
  const id = nextId++;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...payload }, transfer);
  });
}

function startWorker() {
  worker?.terminate();
  worker = new Worker(new URL('./php-worker.js', import.meta.url), { type: 'module' });
  workerUsed = false;
  workerError = null;
  mails = [];
  selectedMail = null;
  readyStatus = '';
  backgroundStatus = null;
  renderMails();
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      setStatus(data.message);
    } else if (data.type === 'background') {
      // A blueprint step that runs after the playground is ready (its first messages may come before show()).
      backgroundStatus = data.message;
      readyStatus && setStatus(backgroundStatus ? `${readyStatus} · ${backgroundStatus}` : readyStatus);
    } else if (data.type === 'mail') {
      mails.unshift({ ...parseMail(data.mail.raw), received: data.mail.received });
      renderMails();
    } else if (data.type === 'result' && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);

      pending.delete(data.id);
      data.error ? reject(Object.assign(new Error(data.error), data.code ? { code: data.code } : {})) : resolve(data.value);
    }
  };
  worker.onerror = (event) => {
    const error = new Error(event.message || 'The PHP worker failed');

    if (pending.size === 0) {
      workerError = error;
      worker?.terminate();
      worker = null;
    }

    for (const { reject } of pending.values()) {
      reject(error);
    }

    pending.clear();
  };
}

/**
 * Starts a playground in a new PHP worker: from the bundle, a saved site or an imported zip.
 */
async function boot(options = {}, transfer = []) {
  setBusy(true);
  setLoading(true);
  elements.frame.src = 'about:blank';

  if (workerError && !workerUsed) {
    const error = workerError;

    workerError = null;
    throw error;
  }

  if (!worker || workerUsed) {
    startWorker();
  }

  workerUsed = true;

  // The scope ends with the Joomla version: the service worker serves media files from that bundle.
  const joomla = options.joomla ?? bundles.default;
  const scope = `scope-${Math.random().toString(36).slice(2, 10)}-${joomla.replaceAll('.', '-')}`;

  playground = await call('boot', { base: base.href, scope, corsProxy, ...options, joomla }, transfer);
  // Before the first page: the Patch Tester has the remembered token when that page asks GitHub.
  await fillGitHubToken();
  show(playground.landingPage ?? '/administrator/');

  if (playground.blueprintError) {
    setStatus(playground.blueprintError, true);
  }

  return playground;
}

function show(path = '/administrator/') {
  const seconds = (playground.timings.ready / 1000).toFixed(1);
  const where = playground.site ? `saved as "${playground.site}"` : playground.prebuilt ? 'temporary, prebuilt demo' : 'temporary';

  readyStatus = `Ready in ${seconds} s (${where})`;
  setStatus(backgroundStatus ? `${readyStatus} · ${backgroundStatus}` : readyStatus);
  elements.credentials.textContent = `${playground.username} / ${playground.password}`;
  elements.info.textContent = `Joomla ${playground.manifest.development ?? playground.manifest.joomla} · ${playground.manifest.driver}`;
  elements.php.value = playground.phpVersion;
  elements.joomla.value = playground.manifest.joomla;
  elements.info.title = Object.entries(playground.timings).map(([step, ms]) => `${step}: ${ms} ms`).join('\n');
  setBusy(false);
  let loaded;

  firstPageLoaded = new Promise((resolve) => (loaded = resolve));
  serviceWorkerReady
    .then(() => {
      elements.frame.addEventListener(
        'load',
        () => {
          setLoading(false);
          loaded();
        },
        { once: true }
      );
      elements.frame.src = `${playground.siteUrl}${path}`;
    })
    .catch((error) => {
      loaded();
      setStatus(`The service worker did not start: ${error.message}`, true);
    });

  // A new playground (another site, Joomla or PHP version): the assistant hears of it.
  assistant?.hello();

  // ?code or ?code=<path>: the code panel opens with the site, with that file.
  if (codeRequested !== null) {
    const path = codeRequested;

    codeRequested = null;
    toggleCode(true, path).catch((error) => setStatus(`The code panel did not open: ${error.message}`, true));
  }

  // For tests and debugging; the export for scripts/build-demos.mjs.
  window.joomlaPlayground = playground;
  window.joomlaPlaygroundExport = exportSite;
  // The site API (web/src/site-api.js): window.joomlaPlaygroundSite('read', { path: 'index.php' }). A failed
  // operation rejects with an Error that has a code, such as NOT_FOUND or CONFLICT.
  window.joomlaPlaygroundSite = (operation, args = {}) => call('site', { operation, args });
}

async function saveSite() {
  const title = prompt('Save this playground in your browser as:', 'My Joomla site');

  if (!title) {
    return;
  }

  setBusy(true);

  try {
    const site = await freeSlug(title);

    // Ask the browser not to evict the saved sites when storage runs low.
    await navigator.storage.persist?.();
    await call('save', { site, title });

    playground.site = site;
    history.replaceState(null, '', `?site=${encodeURIComponent(site)}${pullRequest ? `&pr=${pullRequest.number}` : ''}`);
    show();
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.media] Whether the zip gets the real content of Joomla's media files, so it runs on a
 *                                  server as it is; scripts/build-demos.mjs leaves the bundle's placeholders.
 */
async function exportSite({ media = true } = {}) {
  setBusy(true);
  setStatus('Exporting the site');

  try {
    const bytes = await call('exportSite', { media });
    const name = `${playground.site ?? 'joomla-playground'}-${new Date().toISOString().slice(0, 10)}.zip`;
    const link = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(new Blob([bytes], { type: 'application/zip' })),
      download: name,
    });

    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    show();
  } catch (error) {
    setStatus(error.message, true);
    setBusy(false);
  }
}

async function importSite(file) {
  const bytes = await file.arrayBuffer();

  // An imported site starts as a temporary playground; it can be saved from there.
  history.replaceState(null, '', `${base.pathname}?new`);

  try {
    // An export says which Joomla version it holds: use the bundle of that version, if there is one.
    const from = zipComment(bytes);
    const joomla = bundles.versions.some((bundle) => bundle.joomla === from?.joomla) ? from.joomla : bundles.default;
    const result = await boot({ zip: bytes, joomla }, [bytes]);

    if (from?.joomla && from.joomla !== result.manifest.joomla) {
      setStatus(`Imported a Joomla ${from.joomla} site into the Joomla ${result.manifest.joomla} playground: media files may not match`, true);
    }
  } catch (error) {
    setStatus(`Import failed: ${error.message}`, true);
    setBusy(false);
  }
}

async function renderSites() {
  const sites = await listSites();

  elements.sitesList.replaceChildren();

  if (sites.length === 0) {
    elements.sitesList.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No saved sites yet' }));

    return;
  }

  for (const site of sites) {
    const item = document.createElement('li');
    const open = Object.assign(document.createElement('a'), { href: `?site=${encodeURIComponent(site.slug)}`, textContent: site.title });
    const details = Object.assign(document.createElement('span'), {
      className: 'details',
      textContent: `Joomla ${site.joomla} · ${new Date(site.updated).toLocaleString()}`,
    });
    const actions = Object.assign(document.createElement('span'), { className: 'actions' });
    const rename = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Rename' });
    const remove = Object.assign(document.createElement('button'), { type: 'button', className: 'delete', textContent: 'Delete' });

    rename.setAttribute('aria-label', `Rename ${site.title}`);
    remove.setAttribute('aria-label', `Delete ${site.title}`);

    rename.onclick = async () => {
      const title = prompt('New name for this site:', site.title)?.trim();

      if (title && title !== site.title) {
        await renameSite(site.slug, title);
        await renderSites();
      }
    };

    remove.onclick = async () => {
      if (await isSiteOpen(site.slug)) {
        alert(`"${site.title}" is open in a tab. Close it first (or start a new playground there).`);

        return;
      }

      if (confirm(`Delete "${site.title}" from this browser? This cannot be undone.`)) {
        await deleteSite(site.slug);
        await renderSites();
      }
    };

    actions.append(rename, remove);
    item.append(open, details, actions);
    elements.sitesList.append(item);
  }
}

/**
 * The Mail button shows how many mails were sent; its dialog lists them and shows the selected one.
 */
function renderMails() {
  elements.mailCount.textContent = mails.length ? String(mails.length) : '';

  if (!elements.mailDialog.open) {
    return;
  }

  elements.mailList.replaceChildren();

  if (mails.length === 0) {
    elements.mailList.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'No mail yet. Mails the site sends show up here.' }));
  }

  const activeMail = selectedMail ?? mails[0];

  for (const mail of mails) {
    const item = document.createElement('li');
    const button = Object.assign(document.createElement('button'), { type: 'button' });

    if (mail === activeMail) {
      button.setAttribute('aria-current', 'true');
    }

    button.append(
      Object.assign(document.createElement('div'), { className: 'subject', textContent: mail.subject }),
      Object.assign(document.createElement('div'), { className: 'meta', textContent: `To ${mail.to} · ${new Date(mail.received).toLocaleTimeString()}` })
    );
    button.onclick = () => {
      selectedMail = mail;
      renderMails();
    };
    item.append(button);
    elements.mailList.append(item);
  }

  const mail = activeMail;
  const headers = mail ? [['From', mail.from], ['To', mail.to], ['Subject', mail.subject], ['Date', mail.date]] : [];

  elements.mailHeaders.replaceChildren(
    ...headers.flatMap(([name, value]) => [
      Object.assign(document.createElement('dt'), { textContent: name }),
      Object.assign(document.createElement('dd'), { textContent: value }),
    ])
  );

  // An HTML mail is shown in a sandboxed frame without scripts; a text mail as text.
  const content = mail?.html
    ? Object.assign(document.createElement('iframe'), { id: 'mail-html', title: 'Mail', sandbox: '', srcdoc: mail.html })
    : Object.assign(document.createElement('pre'), { id: 'mail-text', textContent: mail?.text ?? '' });

  elements.mailView.replaceChildren(elements.mailHeaders, content);
}

/**
 * Another PHP version: a saved site reopens with it (and keeps it); a temporary playground starts again from the
 * same link with it.
 */
function switchPhp() {
  const version = elements.php.value;
  const url = new URL(location.href);

  if (!playground.site && !confirm(`Start a new playground with PHP ${version}? This one is not saved and will be lost.`)) {
    elements.php.value = playground.phpVersion;

    return;
  }

  url.searchParams.set('php', version);
  location.href = url.href;
}

function switchJoomla() {
  const version = elements.joomla.value;
  const url = new URL(location.href);

  const bundle = bundles.versions.find((candidate) => candidate.joomla === version);

  if (!confirm(`Start a new playground with Joomla ${bundleLabel(bundle)}? This one is not saved and will be lost.`)) {
    elements.joomla.value = playground.manifest.joomla;

    return;
  }

  // The development branch by its name: the link keeps working when the branch gets a new version number.
  url.searchParams.set('joomla', bundle.branch ?? version);
  location.href = url.href;
}

/**
 * How the toolbar names a bundle: its version, or the branch of a development bundle ("6.3-dev", "6.2-dev").
 */
function bundleLabel(bundle) {
  return bundle.branch ?? bundle.joomla;
}

/**
 * The Joomla version to start: a saved site's own, the one a blueprint or ?joomla= asks for (a version or its
 * start, like "5" or "5.4"; a branch like "6.2-dev" for its nightly build, "dev" for the development branch of the
 * next minor version), or the default. A release goes before a development branch: "6" is the newest 6 release and
 * "6.2" is 6.2.0, not the nightly build of 6.2-dev.
 */
async function chooseJoomla(site, blueprint) {
  const available = bundles.versions.map((bundle) => bundle.joomla);

  if (site) {
    const meta = await readMeta(site);

    if (!meta || available.includes(meta.joomla)) {
      return { joomla: meta?.joomla ?? bundles.default };
    }

    return { joomla: bundles.default, warning: `This site was made with Joomla ${meta.joomla}, which this playground no longer has: its media files come from Joomla ${bundles.default}` };
  }

  const wanted = blueprint?.preferredVersions?.joomla;

  if (!wanted) {
    return { joomla: bundles.default };
  }

  // The development branches come first in versions.json, the next minor version's first.
  const developments = bundles.versions.filter((bundle) => bundle.branch);
  const releases = bundles.versions.filter((bundle) => !bundle.branch).map((bundle) => bundle.joomla);
  const branch = developments.find((bundle) => bundle.branch === String(wanted));
  const version = String(wanted).replace(/-dev$/, '');
  const joomla = ['dev', 'development'].includes(version)
    ? developments[0]?.joomla
    : (branch?.joomla ??
      [...releases, ...developments.map((bundle) => bundle.joomla)].find((candidate) => `${candidate}.`.startsWith(`${version}.`)));

  if (!joomla) {
    throw new Error(`Joomla ${wanted} is not available; choose ${bundles.versions.map(bundleLabel).join(', ')}`);
  }

  return { joomla };
}

/**
 * The JSON comment of a zip (an export of a playground), or null.
 */
function zipComment(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // The end of central directory record: signature, ..., comment length at +20, comment at +22.
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 22 - 65535); offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      try {
        return JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 22, offset + 22 + view.getUint16(offset + 20, true))));
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * The newest service worker: after a new deploy, the previous one would not know the bundles' URLs.
 */
async function newestServiceWorker(registration) {
  await registration.update().catch(() => {});

  const pending = registration.installing ?? registration.waiting;

  if (pending) {
    await new Promise((resolve) => {
      pending.addEventListener('statechange', () => ['activated', 'redundant'].includes(pending.state) && resolve());
    });
  }

  await navigator.serviceWorker.ready;
}

/**
 * The prebuilt export of one of the playground's own blueprints (web/dist/demos/, see scripts/build-demos.mjs), when
 * it was made from this version of the blueprint. Not with ?fresh, nor when the URL changes the blueprint.
 *
 * @returns {Promise<{url: string, joomla: string}|null>}
 */
async function prebuiltDemo(blueprint, url) {
  const name = blueprint?.source?.name;
  const changed = ['fresh', 'php', 'joomla', 'url', 'login', 'extension', 'language', 'pr'].some((key) => url.searchParams.has(key));

  if (!name || changed || url.hash.length > 1) {
    return null;
  }

  try {
    const response = await fetch(new URL(`demos/${name}.json`, base));
    const demo = response.ok ? await response.json() : null;

    if (demo?.blueprint !== blueprint.source.sha256) {
      return null;
    }

    const joomla = bundles.versions.some((bundle) => bundle.joomla === demo.joomla) ? demo.joomla : bundles.default;

    return { url: new URL(`demos/${name}.zip`, base).href, joomla };
  } catch {
    // No prebuilt demo (e.g. vite's fallback page instead of JSON): run the blueprint.
    return null;
  }
}

/** Labels of joomla-cms for pull requests that need a build before they can be tested (the Patch Tester hides them). */
const BUILD_LABELS = ['npm resource changed', 'composer dependency changed'];

const NO_PACKAGE = corsProxy
  ? 'Joomla\'s CI has no build of it (it failed, is still running, or was deleted after about two weeks)'
  : 'This playground has no CORS proxy to download Joomla CI\'s build of it';

/** A build folder of Joomla's CI for a pull request (its "Download" status on GitHub). */
const PACKAGE_FOLDER = /^https:\/\/artifacts\.joomla\.org\/drone\/joomla\/joomla-cms\/[A-Za-z0-9._-]+\/[1-9][0-9]*\/downloads\/[1-9][0-9]*$/;

/**
 * What GitHub says about a pull request of joomla-cms: { title, branch, url, sha, labels, needsBuild, package }, or
 * null when GitHub does not answer (e.g. after 60 requests in an hour without a token). package is the build of the
 * pull request's last commit by Joomla's CI, { folder, built }, or null when there is none (it failed, is still
 * running, or was deleted: the CI keeps them about two weeks). Kept for the tab, so starting over asks GitHub only once.
 */
async function pullRequestInfo(number) {
  const key = `joomla-playground-pr-v3-${number}`;

  try {
    const cached = JSON.parse(sessionStorage.getItem(key));

    if (cached) {
      return cached;
    }
  } catch {
    // No session storage: ask GitHub.
  }

  try {
    const response = await fetch(`https://api.github.com/repos/joomla/joomla-cms/pulls/${number}`, { headers: gitHubHeaders() });

    if (!response.ok) {
      return null;
    }

    const pull = await response.json();
    const labels = (pull.labels ?? []).map((label) => label.name);
    const info = {
      title: pull.title,
      branch: pull.base?.ref ?? null,
      url: pull.html_url,
      sha: pull.head?.sha ?? null,
      labels,
      needsBuild: labels.some((label) => BUILD_LABELS.includes(label.toLowerCase())),
      package: pull.head?.sha ? await pullRequestPackageInfo(pull.head.sha) : null,
    };

    if (info.package && info.branch) {
      info.package.behind = await commitsBehind(info.branch, info.sha);
    }

    // Undefined: GitHub or the proxy did not answer. Then no build is used now, but the next start asks again.
    const unsure = info.package === undefined;

    info.package ??= null;
    info.packageUnsure = unsure;

    try {
      unsure || sessionStorage.setItem(key, JSON.stringify(info));
    } catch {
      // Not kept: the next start asks again.
    }

    return info;
  } catch {
    return null;
  }
}

/**
 * The build of a commit of joomla-cms by Joomla's CI: the newest "Download" status of the commit, when it succeeded
 * and its folder still exists. GitHub keeps the status after the CI has deleted the build (after about two weeks).
 * The builds can only be downloaded through the CORS proxy: without one, there is none to use. Undefined when GitHub
 * or the proxy does not answer (a rate limit, a network error), so that answer is not kept.
 */
async function pullRequestPackageInfo(sha) {
  if (!corsProxy) {
    return null;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/joomla/joomla-cms/commits/${sha}/statuses?per_page=100`, { headers: gitHubHeaders() });

    if (!response.ok) {
      return undefined;
    }

    // Newest first: the last word of the CI on this commit.
    const status = (await response.json()).find((item) => item.context === 'Download');

    if (status?.state !== 'success' || !PACKAGE_FOLDER.test(status.target_url ?? '')) {
      return null;
    }

    const details = await fetch(`${corsProxy}?url=${encodeURIComponent(`${status.target_url}/pr_extension.xml`)}`, { method: 'HEAD' });

    if (details.ok) {
      return { folder: status.target_url, built: status.created_at };
    }

    // 404: the CI deleted the build. Anything else (the proxy's own refusal, a rate limit) may pass.
    return details.status === 404 ? null : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How many commits of its branch a pull request's commit lacks (GitHub's compare), or null when GitHub does not say.
 * A build of such a pull request also takes the files it replaces back to before those commits.
 */
async function commitsBehind(branch, sha) {
  try {
    const response = await fetch(`https://api.github.com/repos/joomla/joomla-cms/compare/${encodeURIComponent(branch)}...${sha}?per_page=1`, { headers: gitHubHeaders() });

    return response.ok ? ((await response.json()).behind_by ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * How to test a pull request: "package" (Joomla CI's build laid over the site) or "patchtester". ?method= chooses;
 * by default a pull request that needs a build (by its labels) uses its package, when the CI has one. note says why
 * a pull request that needs a build is tested with the Patch Tester anyway.
 *
 * @returns {{method: string, note: string|null}}
 */
function pullRequestMethod(info, requested) {
  if (requested === 'package' || requested === 'patchtester') {
    const missing = requested === 'package' && !info?.package;

    return {
      method: missing ? 'patchtester' : requested,
      note: missing ? `${NO_PACKAGE}: testing it with the Patch Tester` : null,
    };
  }

  if (!info?.needsBuild) {
    return { method: 'patchtester', note: null };
  }

  const why = info.packageUnsure ? 'GitHub or the CORS proxy did not say whether Joomla\'s CI has a build of it (start over to ask again)' : NO_PACKAGE;

  return info.package
    ? { method: 'package', note: null }
    : {
        method: 'patchtester',
        note: `This pull request needs a build (JavaScript, CSS or Composer). ${why}: the Patch Tester applies only its PHP, template and language changes`,
      };
}

/**
 * The Joomla version of this playground for a pull request's branch ("5.4-dev", "6.3-dev"): the nightly build of that
 * branch, or else a release of its minor version, or else the newest version before it (for 7.0-dev the development
 * branch 6.3-dev), with a note when it is not the version the pull request is for.
 *
 * @returns {{joomla: string, note: string|null}|null}
 */
function joomlaForBranch(branch) {
  const match = /^(\d+)\.(\d+)/.exec(branch ?? '');

  if (!match) {
    return null;
  }

  const nightly = bundles.versions.find((bundle) => bundle.branch === `${match[1]}.${match[2]}-dev`);
  const exact = nightly?.joomla ?? bundles.versions.map((bundle) => bundle.joomla).find((version) => version.startsWith(`${match[1]}.${match[2]}.`));

  if (exact) {
    return { joomla: exact, note: null };
  }

  const numbers = (version) => version.split('.').map(Number);
  const newestFirst = [...bundles.versions].sort((a, b) => {
    const [x, y] = [numbers(a.joomla), numbers(b.joomla)];

    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  });
  const wanted = [Number(match[1]), Number(match[2])];
  const before = newestFirst.find((bundle) => {
    const [major, minor] = numbers(bundle.joomla);

    return major < wanted[0] || (major === wanted[0] && minor < wanted[1]);
  });
  const bundle = before ?? newestFirst.at(-1);

  return {
    joomla: bundle.joomla,
    note: `The pull request is for ${branch}; this playground has Joomla ${bundleLabel(bundle)}, so the patch may not apply`,
  };
}

function preparePullRequest(number) {
  elements.pullRequestLink.textContent = `PR #${number}`;
  elements.pullRequestLink.href = `https://github.com/joomla/joomla-cms/pull/${number}`;
  elements.pullRequestLink.title = 'The pull request on GitHub';
  elements.pullRequestToggle.textContent = 'Apply patch';
  elements.pullRequestToggle.disabled = true;
  elements.pullRequest.hidden = false;
}

/**
 * Shows the pull request in the toolbar, with a button to apply or revert it: with the Patch Tester, or (method
 * "package") Joomla CI's build of it.
 */
async function showPullRequest(number, info, method = 'patchtester') {
  pullRequest = method === 'package'
    ? { number, method, package: info.package, branch: info.branch, applied: (await call('pullRequestPackage', { pullRequest: number })).applied }
    : { number, method, test: await call('pullRequestTest', { pullRequest: number }) };
  elements.pullRequestLink.textContent = `PR #${number}`;
  elements.pullRequestLink.href = info?.url ?? `https://github.com/joomla/joomla-cms/pull/${number}`;
  elements.pullRequestLink.title = info
    ? `${info.title} (${info.branch})${info.labels?.length ? `\nLabels: ${info.labels.join(', ')}` : ''}`
    : 'The pull request on GitHub';
  elements.pullRequest.hidden = false;
  renderPullRequest();
  elements.pullRequestToggle.disabled = false;
}

function renderPullRequest() {
  if (pullRequest.method === 'package') {
    const built = new Date(pullRequest.package.built).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

    elements.pullRequestToggle.textContent = pullRequest.applied ? 'Revert build' : 'Apply build';
    elements.pullRequestToggle.title = pullRequest.applied
      ? `Put the original files back (changes to the database stay), and show this page again`
      : `Lay the build of PR #${pullRequest.number} by Joomla's CI (${built}) over the site, with its built JavaScript, CSS and Composer packages, and show this page again${
          pullRequest.package.behind > 0 ? `.\nThe PR is ${pullRequest.package.behind} commit${pullRequest.package.behind === 1 ? '' : 's'} behind ${pullRequest.branch}: the files it replaces are taken back to before those commits.` : ''
        }`;

    return;
  }

  elements.pullRequestToggle.textContent = pullRequest.test ? 'Revert patch' : 'Apply patch';
  elements.pullRequestToggle.title = pullRequest.test
    ? `Undo the changes of PR #${pullRequest.number}, and show this page again`
    : `Apply the changes of PR #${pullRequest.number} with the Patch Tester, and show this page again`;
}

/**
 * Lays Joomla CI's build of the pull request over the site, or takes it off again, then shows the page that was
 * open again.
 */
async function togglePullRequestPackage(page) {
  const { number, applied } = pullRequest;

  setBusy(true);
  setLoading(true);
  setStatus(applied ? `Reverting the build of PR #${number}` : `Applying the build of PR #${number}`);

  try {
    const result = await call('pullRequestPackage', { pullRequest: number, folder: pullRequest.package.folder, apply: !applied });
    const changes = result.changes;

    pullRequest.applied = result.applied;
    renderPullRequest();

    const downloaded = result.applied && changes?.downloaded ? `; ${(changes.downloaded / 1048576).toFixed(1)} MB downloaded` : '';
    const counts = changes ? `${changes.replaced.length} files changed, ${changes.added.length} added, ${changes.deleted.length} deleted${downloaded}` : '';
    const database = changes?.sql ? ` · database: ${changes.sql.message}` : '';
    const behind = result.applied && pullRequest.package.behind > 0
      ? ` · the PR is ${pullRequest.package.behind} commit${pullRequest.package.behind === 1 ? '' : 's'} behind ${pullRequest.branch}: files changed since are taken back to its state too`
      : '';

    setStatus(`${readyStatus} · build of PR #${number} ${result.applied ? 'applied' : 'reverted'} (${counts})${database}${behind}`, Boolean(changes?.sql && !changes.sql.ok));
    await loadFrame(page);
  } catch (error) {
    setStatus(`The build of PR #${number} was not ${applied ? 'reverted' : 'applied'}: ${error.message}`, true);
  } finally {
    setLoading(false);
    setBusy(false);
  }
}

function loadFrame(src) {
  return new Promise((resolve) => {
    elements.frame.addEventListener('load', resolve, { once: true });
    elements.frame.src = src;
  });
}

/**
 * Applies or reverts the pull request with the Patch Tester's own task, then shows the page that was open again:
 * before and after, one click apart. On an error, the Patch Tester's page with its message stays.
 */
async function togglePullRequest() {
  const { number, test } = pullRequest;
  const applied = Boolean(test);
  // The apply task takes the number of the pull request, the revert task the id of the test.
  const [task, id] = applied ? ['revert', test] : ['apply', number];
  let page = null;

  try {
    page = elements.frame.contentWindow.location.href;
  } catch {
    // Not the playground's page: show the administrator afterwards.
  }

  if (!page?.startsWith(`${playground.siteUrl}/`) || page.includes('option=com_patchtester')) {
    page = `${playground.siteUrl}/administrator/`;
  }

  if (pullRequest.method === 'package') {
    return togglePullRequestPackage(page);
  }

  setBusy(true);
  setLoading(true);
  setStatus(applied ? `Reverting PR #${number}` : `Applying PR #${number} (the Patch Tester downloads its files from GitHub)`);

  try {
    await loadFrame(`${playground.siteUrl}/administrator/index.php?option=com_patchtester&task=${task}.${task}&pull_id=${id}`);
    pullRequest.test = await call('pullRequestTest', { pullRequest: number });
    renderPullRequest();

    if (Boolean(pullRequest.test) !== applied) {
      setStatus(`${readyStatus} · PR #${number} ${pullRequest.test ? 'applied' : 'reverted'}`);
      await loadFrame(page);

      return;
    }

    // The Patch Tester said why (or the administrator asks to log in): show its page.
    const document = elements.frame.contentDocument;
    const alerts = [...(document?.querySelectorAll('joomla-alert[type="danger"], joomla-alert[type="warning"], .alert-danger') ?? [])];
    const reason = alerts.map((alert) => alert.querySelector('.alert-message')?.textContent ?? alert.textContent).join(' ').trim()
      || (document?.title.startsWith('Error') ? document.title : '');
    const login = document?.querySelector('form#form-login, input[name="username"]');

    setStatus(login ? 'Log in to the administrator first' : `PR #${number} was not ${applied ? 'reverted' : 'applied'}${reason ? `: ${reason}` : ''}`, true);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setLoading(false);
    setBusy(false);
  }
}

/**
 * Gives the Patch Tester of a new playground the GitHub token this browser remembers (github-token.js), if it has
 * none yet; a token entered in the site itself stays. The toolbar shows the GitHub token button where the Patch Tester
 * is installed.
 */
async function fillGitHubToken() {
  const token = rememberedToken();

  try {
    playground.patchTester = await call('patchTester', { set: token });
  } catch (error) {
    console.error('The Patch Tester did not get the GitHub token:', error);
    playground.patchTester = null;
  }

  renderGitHubToken();
}

function renderGitHubToken() {
  const remembered = Boolean(rememberedToken());
  const site = playground?.patchTester;

  elements.gitHubToken.hidden = !site?.installed;
  elements.gitHubToken.title = site?.hasToken
    ? `The Patch Tester has a GitHub token${remembered ? ', remembered in this browser for every new playground' : ''}`
    : 'Give the Patch Tester a GitHub token, remembered in this browser for every new playground';
  elements.tokenState.textContent = [
    remembered ? 'This browser remembers a token.' : 'This browser remembers no token.',
    site?.hasToken ? 'The Patch Tester of this playground has one.' : 'The Patch Tester of this playground has none.',
  ].join(' ');
  elements.tokenForget.disabled = !remembered;
}

function openTokenDialog() {
  elements.tokenInput.value = '';
  elements.tokenInput.removeAttribute('aria-invalid');
  elements.tokenError.textContent = '';
  renderGitHubToken();
  elements.tokenDialog.showModal();
  elements.tokenInput.focus();
}

/** Remembers the token and gives it to this playground's Patch Tester, also over a token it had. */
async function saveGitHubToken(event) {
  event.preventDefault();

  try {
    const token = rememberToken(elements.tokenInput.value);

    playground.patchTester = await call('patchTester', { set: token, overwrite: true });
    elements.tokenInput.removeAttribute('aria-invalid');
    elements.tokenDialog.close();
    setStatus(`${readyStatus} · GitHub token remembered and given to the Patch Tester`);
  } catch (error) {
    elements.tokenInput.setAttribute('aria-invalid', 'true');
    elements.tokenError.textContent = error.message;
  }

  renderGitHubToken();
}

/** Forgets the token, and takes it from this playground's Patch Tester again (if it still has that one). */
async function forgetGitHubToken() {
  const token = rememberedToken();

  forgetToken();

  try {
    playground.patchTester = await call('patchTester', { clear: token });
    setStatus(`${readyStatus} · GitHub token forgotten`);
  } catch (error) {
    elements.tokenError.textContent = error.message;
  }

  renderGitHubToken();
}

/**
 * Opens or closes the code panel beside the frame (code-panel.js, loaded the first time), optionally with a file.
 */
async function toggleCode(show = elements.codePanel.hidden, path = '') {
  if (show && !codePanel) {
    elements.code.disabled = true;

    try {
      const { createCodePanel } = await import('./code-panel.js');

      codePanel = createCodePanel(elements.codePanel, {
        site: (operation, args) => call('site', { operation, args }),
        reloadFrame,
        onClose: () => toggleCode(false),
        changes: codeChanges,
      });
      setUpDivider();
    } finally {
      elements.code.disabled = false;
    }
  }

  elements.codePanel.hidden = !show;
  elements.codeDivider.hidden = !show;
  elements.code.setAttribute('aria-pressed', String(show));

  if (show && path) {
    await codePanel.open(path);
  }
}

/**
 * Shows the frame's page again (a GET, so a form is not sent twice), e.g. after a file was saved. Resolves when the
 * page has loaded.
 */
function reloadFrame() {
  const loaded = new Promise((resolve) => elements.frame.addEventListener('load', resolve, { once: true }));

  try {
    const page = elements.frame.contentWindow.location.href;

    elements.frame.contentWindow.location.replace(page);
  } catch {
    elements.frame.src = elements.frame.src;
  }

  return loaded;
}

/** The divider between the code panel and the frame: drag it, or use the arrow keys. */
function setUpDivider() {
  const setWidth = (pixels) => {
    const total = elements.stage.clientWidth;
    const width = Math.min(Math.max(pixels, 280), total - 200);

    elements.stage.style.setProperty('--code-width', `${Math.round((width / total) * 1000) / 10}%`);
  };

  elements.codeDivider.addEventListener('pointerdown', (event) => {
    elements.codeDivider.setPointerCapture(event.pointerId);
    elements.stage.classList.add('resizing');
  });
  elements.codeDivider.addEventListener('pointermove', (event) => {
    if (elements.codeDivider.hasPointerCapture(event.pointerId)) {
      setWidth(event.clientX - elements.stage.getBoundingClientRect().left);
    }
  });
  elements.codeDivider.addEventListener('lostpointercapture', () => elements.stage.classList.remove('resizing'));
  elements.codeDivider.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -40, ArrowRight: 40 }[event.key];

    if (step) {
      event.preventDefault();
      setWidth(elements.codePanel.getBoundingClientRect().width + step);
    }
  });
}

function startOver() {
  if (confirm('Throw this playground away and start again from the same link?')) {
    location.reload();
  }
}

async function start() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('This browser does not support service workers (they need HTTPS or localhost).');
  }

  // Reserve the pull request / Patch Tester controls in the toolbar up front so unhiding them after boot does not shift the layout.
  const url = new URL(location.href);
  const prParam = url.searchParams.get('pr');
  const hasPr = Boolean(prParam && /^[1-9][0-9]*$/.test(prParam));

  if (hasPr) {
    preparePullRequest(Number(prParam));
  }

  if (hasPr || url.searchParams.get('blueprint') === 'patchtester') {
    elements.gitHubToken.hidden = false;
    elements.gitHubToken.disabled = true;
  }

  // Not awaited: the service worker and PHP worker load in parallel with versions.json and any blueprint.
  setStatus('Starting');
  serviceWorkerReady = navigator.serviceWorker.register(new URL('sw.js', base), { scope: base.pathname }).then(newestServiceWorker);
  startWorker();

  bundles = await (await fetch(new URL('joomla/versions.json', base))).json();
  elements.joomla.replaceChildren(...bundles.versions.map((bundle) => new Option(bundleLabel(bundle), bundle.joomla)));
  elements.joomla.onchange = switchJoomla;

  elements.site.onclick = () => (elements.frame.src = `${playground.siteUrl}/`);
  elements.admin.onclick = () => (elements.frame.src = `${playground.siteUrl}/administrator/`);
  elements.newSite.onclick = () => (location.href = `${base.pathname}?new`);
  elements.reset.onclick = startOver;
  elements.php.replaceChildren(...PHP_VERSIONS.map((version) => new Option(version, version)));
  elements.php.onchange = switchPhp;
  elements.save.onclick = saveSite;
  elements.exportSite.onclick = () => exportSite();
  elements.importSite.onclick = () => elements.importFile.click();
  elements.importFile.onchange = () => elements.importFile.files[0] && importSite(elements.importFile.files[0]);
  elements.sitesMenu.ontoggle = () => elements.sitesMenu.open && renderSites();
  elements.pullRequestToggle.onclick = togglePullRequest;
  elements.gitHubToken.onclick = openTokenDialog;
  elements.tokenForm.onsubmit = saveGitHubToken;
  elements.tokenInput.oninput = () => {
    elements.tokenInput.removeAttribute('aria-invalid');
    elements.tokenError.textContent = '';
  };
  elements.tokenForget.onclick = forgetGitHubToken;
  elements.code.onclick = () => toggleCode().catch((error) => setStatus(`The code panel did not open: ${error.message}`, true));
  addEventListener('beforeunload', (event) => codePanel?.hasChanges() && event.preventDefault());
  elements.mail.onclick = () => {
    elements.mailDialog.showModal();
    renderMails();
  };

  setUpAssistant();

  // Fallback for browsers without closedby="any" support (e.g. Safari).
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    for (const dialog of [elements.mailDialog, elements.tokenDialog]) {
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) {
          return;
        }

        const rect = dialog.getBoundingClientRect();
        const isDialogContent = rect.top <= event.clientY && event.clientY <= rect.top + rect.height
          && rect.left <= event.clientX && event.clientX <= rect.left + rect.width;

        if (!isDialogContent) {
          dialog.close();
        }
      });
    }
  }

  // A saved site writes its changes shortly after requests; when the tab is hidden or closed, write them now.
  const flush = () => playground?.site && call('flush').catch(() => {});

  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());
  addEventListener('pagehide', flush);

  const site = url.searchParams.get('site');
  // A pull request: its labels and Joomla CI's build decide how it is tested, and so which blueprint it gets.
  const info = hasPr ? await pullRequestInfo(Number(prParam)) : null;
  // A pull request picks the Joomla version of its branch, unless the link names one.
  const branch = info && !site && !url.searchParams.has('joomla') ? joomlaForBranch(info.branch) : null;
  let { method, note: methodNote } = hasPr ? pullRequestMethod(info, url.searchParams.get('method')) : { method: 'patchtester', note: null };

  // A build of another branch (a 7.0-dev pull request on 6.3-dev) would replace most of the site: an update without
  // its database changes. Only when the link asks for it.
  if (method === 'package' && branch?.note && url.searchParams.get('method') !== 'package') {
    method = 'patchtester';
    methodNote = `This playground has no Joomla of ${info.branch}, so Joomla CI's build of the pull request is not laid over it (add &method=package to do so anyway)`;
  }

  const blueprint = await blueprintFromUrl(url, { pullRequestMethod: method });

  if (blueprint?.code?.changes) {
    const { from, to } = blueprint.code.changes;

    codeChanges = { ...blueprint.code.changes, from: from && new URL(from, blueprint.baseUrl ?? location.href).href, to: new URL(to, blueprint.baseUrl ?? location.href).href };

    // Links to other steps are relative to the playground's page, like a link in the address bar.
    for (const key of ['previous', 'next']) {
      const link = blueprint.code.changes[key];

      codeChanges[key] = link && { ...link, href: new URL(link.href, location.href).href };
    }
  }

  const prebuilt = site ? null : await prebuiltDemo(blueprint, url);

  if (prebuilt) {
    // The site the blueprint makes, exported at build time: start from it, like an import, without the steps.
    // The PHP worker downloads the zip while it loads PHP.
    await boot({
      zipUrl: prebuilt.url,
      joomla: prebuilt.joomla,
      php: blueprint.preferredVersions?.php ?? null,
      blueprint: { landingPage: blueprint.landingPage, login: blueprint.login, steps: [] },
    });
    playground.prebuilt = blueprint.source.name;
    show(playground.landingPage ?? '/administrator/');

    return;
  }

  if (branch) {
    blueprint.preferredVersions = { ...blueprint.preferredVersions, joomla: branch.joomla };
  }

  const { joomla, warning } = await chooseJoomla(site, blueprint);

  await boot({ ...(site ? { site } : {}), joomla, php: blueprint?.preferredVersions?.php ?? null, blueprint });

  if (blueprint?.pullRequest) {
    await showPullRequest(blueprint.pullRequest, info, method);
  }

  const notes = [warning ?? branch?.note, methodNote].filter(Boolean);

  if (notes.length) {
    setStatus(notes.join(' · '), true);
  }

  // A saved site remembers its PHP version: its address needs no ?php any more.
  if (site && url.searchParams.has('php')) {
    history.replaceState(null, '', `?site=${encodeURIComponent(site)}${pullRequest ? `&pr=${pullRequest.number}` : ''}`);
  }
}

/**
 * The connection to an AI assistant (see mcp-bridge.js and mcp/): to its MCP server on this computer when the
 * playground was opened with ?mcp-port and the user allowed it, and through WebMCP where the browser has it.
 */
function setUpAssistant() {
  const context = {
    playground: () => playground,
    call,
    // After the frame's first page (at most 20 s): a navigation to that page still under way, with Joomla's
    // redirects, could otherwise replace this one. The page that is there can still navigate before it unloads:
    // Joomla's guided tour does so on the first visit to the administrator. Then the frame shows this URL again.
    showUrl: async (url) => {
      const wait = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(resolve, 20000))]);
      const path = (href) => {
        const { pathname, search } = new URL(href, location.href);

        return pathname + search;
      };

      await serviceWorkerReady;
      await wait(firstPageLoaded);

      for (let attempt = 0; attempt < 3; attempt++) {
        const loaded = new Promise((resolve) => elements.frame.addEventListener('load', resolve, { once: true }));

        elements.frame.src = url;
        await wait(loaded);

        let shown;

        try {
          shown = elements.frame.contentWindow.location.href;
        } catch {
          return;
        }

        if (path(shown) === path(url)) {
          return;
        }
      }
    },
    onState: (state) => {
      const labels = {
        waiting: ['AI assistant: waiting', 'Waiting for the MCP server of the assistant on this computer; click to disconnect'],
        connected: ['AI assistant ●', 'An AI assistant works on this site; click to disconnect'],
        replaced: ['AI assistant: in another tab', 'The assistant connected to another playground tab'],
      };

      elements.assistant.hidden = !labels[state];
      [elements.assistant.textContent, elements.assistant.title] = labels[state] ?? ['', ''];
      elements.assistant.dataset.state = state;
    },
  };
  const port = allowedPort();

  if (port) {
    assistant = connectAssistant(port, context);
    elements.assistant.onclick = () => {
      if (elements.assistant.dataset.state === 'replaced') {
        elements.assistant.hidden = true;
      } else if (confirm('Disconnect the AI assistant from this playground?')) {
        assistant.stop();
        assistant = null;
      }
    };
  }

  registerWebMcpTools(context).catch((error) => console.warn('WebMCP: the tools could not be registered', error));
}

start().catch((error) => {
  if (!playground) {
    worker?.terminate();
    worker = null;
  }

  console.error(error);
  setStatus(error.message, true);
});
