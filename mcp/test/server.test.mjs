// Tests of the MCP server and its bridge, with a fake playground tab (a WebSocket client in Node).

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PlaygroundBridge } from '../bridge.mjs';
import { start } from '../mcp-server.mjs';
import { TOOLS } from '../tools.js';

const PLAYGROUND = 'https://playground.example.test/joomla/';
const ORIGIN = new URL(PLAYGROUND).origin;

let server;
let client;
let base;

before(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  server = await start(['--port=0', `--url=${PLAYGROUND}`, '--timeout=5'], { transport: serverSide });
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  base = `http://127.0.0.1:${server.bridge.port}`;
});

after(async () => {
  await client?.close();
  await server?.stop();
});

const callTool = (name, args = {}) => client.callTool({ name, arguments: args });
const text = (result) => result.content.map((block) => block.text).join('\n');

/**
 * A fake playground tab: connects like web/src/mcp-bridge.js and answers calls with answer(tool, args).
 */
async function openTab(answer, { origin = ORIGIN, playground = { siteUrl: 'https://playground.example.test/joomla/scope-x' } } = {}) {
  const { token } = await (await fetch(`${base}/token`, { headers: { Origin: origin } })).json();
  const socket = new WebSocket(`ws://127.0.0.1:${server.bridge.port}/?token=${token}`, { origin });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.on('message', async (data) => {
    const message = JSON.parse(String(data));

    try {
      socket.send(JSON.stringify({ type: 'result', id: message.id, value: await answer(message.tool, message.args) }));
    } catch (error) {
      socket.send(JSON.stringify({ type: 'result', id: message.id, error: error.message, code: error.code }));
    }
  });
  socket.send(JSON.stringify({ type: 'hello', protocol: 1, playground }));
  await server.bridge.waitUntilReady(2000);

  return socket;
}

const closed = (socket) => new Promise((resolve) => socket.once('close', (code) => resolve(code)));

describe('the MCP server', () => {
  test('lists the tools of tools.js', async () => {
    const { tools } = await client.listTools();

    assert.deepEqual(tools.map(({ name }) => name), TOOLS.map(({ name }) => name));
    assert.ok(tools.every(({ inputSchema }) => inputSchema.type === 'object'));
  });

  test('gives the URL that connects a playground', async () => {
    const result = JSON.parse(text(await callTool('joomla_playground_url', { blueprint: 'jcb' })));
    const url = new URL(result.url);

    assert.equal(`${url.origin}${url.pathname}`, PLAYGROUND);
    assert.equal(url.searchParams.get('mcp-port'), String(server.bridge.port));
    assert.equal(url.searchParams.get('blueprint'), 'jcb');
    assert.equal(result.connected, false);
  });

  test('without a tab, a tool explains what the user must open', async () => {
    const result = await callTool('joomla_site_info');

    assert.equal(result.isError, true);
    assert.match(text(result), new RegExp(`mcp-port=${server.bridge.port}`));
  });

  test('an unknown tool is an error', async () => {
    assert.equal((await callTool('joomla_format_disk')).isError, true);
  });
});

describe('the bridge', () => {
  test('a port in use is an error to handle, not a crash', async () => {
    // A second assistant session starts its own server while the first one has the port.
    const second = new PlaygroundBridge();

    await assert.rejects(second.listen(server.bridge.port), { code: 'EADDRINUSE' });

    const port = await second.listen(0);

    assert.ok(port > 0 && port !== server.bridge.port);
    await second.close();
  });

  test('gives the token only to the playground\'s origins', async () => {
    const allowed = await fetch(`${base}/token`, { headers: { Origin: ORIGIN } });

    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), ORIGIN);
    assert.match((await allowed.json()).token, /^[\w-]{20,}$/);

    assert.equal((await fetch(`${base}/token`, { headers: { Origin: 'http://localhost:5401' } })).status, 200);
    assert.equal((await fetch(`${base}/token`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/token`)).status, 403);
    assert.equal((await fetch(`${base}/other`, { headers: { Origin: ORIGIN } })).status, 404);
  });

  test('answers the preflight of Private Network Access', async () => {
    const response = await fetch(`${base}/token`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true' },
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
  });

  test('refuses a WebSocket without the token or from another origin', async () => {
    const refused = (url, origin) =>
      new Promise((resolve) => {
        const socket = new WebSocket(url, { origin });

        socket.once('unexpected-response', (request, response) => resolve(response.statusCode));
        socket.once('open', () => resolve('open'));
        socket.once('error', () => {});
      });
    const { token } = await (await fetch(`${base}/token`, { headers: { Origin: ORIGIN } })).json();
    const url = `ws://127.0.0.1:${server.bridge.port}/`;

    assert.equal(await refused(`${url}?token=wrong`, ORIGIN), 401);
    assert.equal(await refused(`${url}?token=${token}`, 'https://evil.example'), 403);
  });

  test('passes tool calls to the tab and back', async () => {
    const calls = [];
    const tab = await openTab((tool, args) => {
      calls.push([tool, args]);

      if (tool === 'joomla_read_file') {
        return { path: args.path, size: 5, revision: 'abc', text: '<?php' };
      }

      const error = new Error('No such file or folder: nothing.php');

      error.code = 'NOT_FOUND';
      throw error;
    });

    const read = await callTool('joomla_read_file', { path: 'index.php' });

    assert.equal(read.isError, undefined);
    assert.deepEqual(JSON.parse(read.content[0].text), { path: 'index.php', size: 5, revision: 'abc' });
    assert.equal(read.content[1].text, '<?php', 'the file\'s text is a block of its own');

    const missing = await callTool('joomla_delete', { path: 'nothing.php' });

    assert.equal(missing.isError, true);
    assert.match(text(missing), /^NOT_FOUND: No such file/);
    assert.deepEqual(calls, [['joomla_read_file', { path: 'index.php' }], ['joomla_delete', { path: 'nothing.php' }]]);

    const url = JSON.parse(text(await callTool('joomla_playground_url')));

    assert.equal(url.connected, true);
    assert.equal(url.site.siteUrl, 'https://playground.example.test/joomla/scope-x');

    tab.close();
    await closed(tab);
  });

  test('a newer tab replaces the older one, which is told so', async () => {
    const first = await openTab(() => 'first');
    const replaced = closed(first);
    const second = await openTab(() => 'second');

    assert.equal(await replaced, 4000);
    assert.equal(text(await callTool('joomla_site_info')), 'second');

    second.close();
    await closed(second);
  });

  test('a call fails when the tab goes away or does not answer', async () => {
    const tab = await openTab(() => new Promise(() => {}));
    const pending = callTool('joomla_cli', { args: ['list'] });

    setTimeout(() => tab.close(), 100);
    assert.match(text(await pending), /^DISCONNECTED/);

    const silent = await openTab(() => new Promise(() => {}));

    assert.match(text(await callTool('joomla_cli', { args: ['list'] })), /^TIMEOUT/);
    silent.close();
    await closed(silent);
  });
});
