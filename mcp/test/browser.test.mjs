// End to end: an MCP client → this MCP server → the built playground in Chrome → Joomla in PHP-WASM.
// Needs the built playground: npm run bundle && npm run web:build (in the repository's root).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { start } from '../mcp-server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const { chromium } = createRequire(`${root}/package.json`)('playwright-core');
const port = 5411;
const appUrl = `http://127.0.0.1:${port}/`;

let preview;
let server;
let client;
let browser;
let context;
let page;
let dialogs = 0;

const callTool = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const texts = result.content.map((block) => block.text);

  assert.ok(!result.isError, `${name}: ${texts.join('\n')}`);

  return texts;
};
const json = async (name, args) => JSON.parse((await callTool(name, args))[0]);

before(async () => {
  assert.ok(existsSync(`${root}/web/dist/index.html`), 'Build first: npm run bundle && npm run web:build');

  preview = spawn(process.execPath, [`${root}/node_modules/vite/bin/vite.js`, 'preview', '--config', 'web/vite.config.js', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: root,
    stdio: 'ignore',
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(appUrl)).ok) {
        break;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  server = await start(['--port=0', `--url=${appUrl}`], { transport: serverSide });
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);

  browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' });
  context = await browser.newContext();
  page = await context.newPage();
  page.on('dialog', (dialog) => {
    dialogs++;
    dialog.accept();
  });
});

after(async () => {
  await browser?.close();
  await client?.close();
  await server?.stop();
  preview?.kill();
});

describe('an assistant works on a playground in the browser', () => {
  test('the page from joomla_playground_url asks once, then connects', async () => {
    const { url } = await json('joomla_playground_url');

    await page.goto(url);
    assert.ok(await server.bridge.waitUntilReady(180000), 'the playground connected');
    assert.equal(dialogs, 1, 'the user was asked');
    assert.ok(!page.url().includes('mcp-port'), 'the address no longer has mcp-port');
    await page.waitForSelector('#assistant[data-state="connected"]');
  });

  test('reads, writes and runs on the site', async () => {
    const info = await json('joomla_site_info');

    assert.match(info.joomla, /^\d+\.\d+\.\d+$/);
    assert.equal(info.siteUrl, server.bridge.tabInfo.siteUrl);

    const written = await json('joomla_write_file', { path: 'mcp-test.php', text: '<?php echo "Hello from MCP";', revision: null });

    assert.equal(written.created, true);

    const [meta, body] = await callTool('joomla_request', { path: '/mcp-test.php' });

    assert.equal(JSON.parse(meta).status, 200);
    assert.equal(body, 'Hello from MCP');

    const found = await json('joomla_search_files', { query: 'Hello from MCP', glob: '*.php' });

    assert.deepEqual(found.results.map(({ path }) => path), ['mcp-test.php']);

    const cli = await json('joomla_cli', { args: ['extension:list', '--type=template'] });

    assert.equal(cli.exitCode, 0);
    assert.match(cli.output, /cassiopeia/i);
  });

  test('shows a page to the user', async () => {
    await json('joomla_show_page', { path: '/mcp-test.php' });

    const frame = await (await page.waitForSelector('#joomla')).contentFrame();

    await frame.waitForURL(/mcp-test\.php$/);
    assert.match(await frame.textContent('body'), /Hello from MCP/);
  });

  test('reconnects after a reload without asking again', async () => {
    const before = server.bridge.tabInfo.siteUrl;

    await page.reload();
    await page.waitForFunction(() => window.joomlaPlayground);
    await page.waitForSelector('#assistant[data-state="connected"]', { timeout: 60000 });
    assert.ok(await server.bridge.waitUntilReady(60000));

    // A temporary playground starts again after a reload: a new site.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.notEqual(server.bridge.tabInfo.siteUrl, before);
    assert.equal(dialogs, 1);
  });

  test('a second tab takes over; the first one says so', async () => {
    const { url } = await json('joomla_playground_url');
    const second = await context.newPage();

    second.on('dialog', (dialog) => dialog.accept());
    await second.goto(url);
    await page.waitForSelector('#assistant[data-state="replaced"]', { timeout: 180000 });
    await second.waitForSelector('#assistant[data-state="connected"]', { timeout: 180000 });
    // The tab tells the bridge about its playground right after it connected.
    assert.ok(await server.bridge.waitUntilReady(60000));
    assert.equal(server.bridge.tabInfo.page.startsWith(appUrl), true);
    await second.close();
  });

  test('a user who declines is not connected', async () => {
    const { url } = await json('joomla_playground_url');
    const declined = await context.newPage();

    declined.on('dialog', (dialog) => dialog.dismiss());
    await declined.goto(url);
    await declined.waitForFunction(() => window.joomlaPlayground, null, { timeout: 180000 });
    assert.equal(await declined.locator('#assistant').isHidden(), true);
    await declined.close();
  });
});
