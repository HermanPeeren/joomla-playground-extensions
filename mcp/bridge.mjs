// The local end of the connection between the MCP server and a playground tab.
//
//   AI assistant ──stdio── MCP server (server.mjs) ── this bridge ──WebSocket on 127.0.0.1── playground tab
//
// The tab connects to the bridge, not the other way around, and only when the user opened the playground with
// ?mcp-port=<port> and allowed it. The bridge listens on 127.0.0.1 only. A page gets the token for the WebSocket
// from GET /token, which answers only the playground's own origins (CORS), so another website the user visits
// cannot connect and pose as the playground.

import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

export const PROTOCOL = 1;

/** Origins that may always connect: a playground on this computer (npm run web:dev and web:preview). */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/** Close code for a tab that another tab replaced: it does not reconnect. */
export const REPLACED = 4000;

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class PlaygroundBridge {
  /**
   * @param {object} options
   * @param {string[]} options.origins Origins of the playground besides localhost, e.g. "https://example.github.io"
   * @param {number} options.timeout   Milliseconds a call may take
   * @param {(message: string) => void} options.log
   */
  constructor({ origins = [], timeout = 300_000, log = () => {} } = {}) {
    this.origins = new Set(origins.map((origin) => new URL(origin).origin));
    this.timeout = timeout;
    this.log = log;
    this.token = randomBytes(24).toString('base64url');
    this.tab = null;
    this.tabInfo = null;
    this.pending = new Map();
    this.nextId = 1;
    this.waiters = new Set();
  }

  isAllowedOrigin(origin) {
    return typeof origin === 'string' && (LOCAL_ORIGIN.test(origin) || this.origins.has(origin));
  }

  /**
   * Listens on 127.0.0.1; with port 0 on a free port.
   */
  async listen(port = 0) {
    const http = createServer((request, response) => this.answerHttp(request, response));

    // Listen before the WebSocket server is attached: it repeats the HTTP server's errors as its own, and a port in
    // use (another assistant's server) would then crash this process instead of rejecting here.
    await new Promise((resolve, reject) => {
      http.once('error', reject);
      http.listen(port, '127.0.0.1', () => {
        http.off('error', reject);
        resolve();
      });
    });

    this.http = http;
    this.wss = new WebSocketServer({
      server: this.http,
      maxPayload: 64 * 1024 * 1024,
      verifyClient: ({ origin, req }, done) => {
        const token = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token');

        if (!this.isAllowedOrigin(origin)) {
          this.log(`Refused a connection from ${origin ?? 'a client without an origin'}`);
          done(false, 403, 'Forbidden');
        } else if (token !== this.token) {
          done(false, 401, 'Invalid token');
        } else {
          done(true);
        }
      },
    });
    this.wss.on('connection', (socket) => this.connected(socket));
    this.wss.on('error', (error) => this.log(`Bridge error: ${error.message}`));

    return this.port;
  }

  get port() {
    return this.http?.address()?.port ?? null;
  }

  answerHttp(request, response) {
    const origin = request.headers.origin;
    const { pathname } = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (pathname !== '/token') {
      response.writeHead(404).end();

      return;
    }

    if (!this.isAllowedOrigin(origin)) {
      response.writeHead(403).end('Forbidden');

      return;
    }

    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');

    if (request.method === 'OPTIONS') {
      // The preflight of Chrome's Private Network Access, for a page on the internet that asks this computer.
      response.setHeader('Access-Control-Allow-Methods', 'GET');
      response.setHeader('Access-Control-Allow-Private-Network', 'true');
      response.writeHead(204).end();

      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ token: this.token, protocol: PROTOCOL }));
  }

  connected(socket) {
    if (this.tab) {
      // One tab at a time: the newest one, which the user just opened or allowed.
      this.tab.close(REPLACED, 'Another tab connected to the assistant');
    }

    this.tab = socket;
    this.tabInfo = null;
    this.log('A playground tab connected');

    socket.on('message', (data) => {
      let message;

      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }

      if (message?.type === 'hello') {
        this.tabInfo = message.playground ?? {};
        this.log(`Playground ready: ${this.tabInfo.siteUrl ?? 'unknown site'}`);

        for (const waiter of this.waiters) {
          waiter();
        }
      } else if (message?.type === 'result' && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);

        clearTimeout(timer);
        this.pending.delete(message.id);
        message.error ? reject(new BridgeError(message.code ?? 'FAILED', message.error)) : resolve(message.value);
      }
    });

    socket.on('close', () => {
      if (this.tab !== socket) {
        return;
      }

      this.tab = null;
      this.tabInfo = null;
      this.log('The playground tab disconnected');

      for (const [id, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        reject(new BridgeError('DISCONNECTED', 'The playground tab closed or reloaded before it answered.'));
        this.pending.delete(id);
      }
    });
  }

  /** Whether a tab is connected and runs a playground. */
  get ready() {
    return Boolean(this.tab && this.tabInfo);
  }

  /**
   * Waits until a tab runs a playground, at most this long.
   */
  waitUntilReady(milliseconds) {
    if (this.ready) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const done = (result) => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(result);
      };
      const waiter = () => done(true);
      const timer = setTimeout(() => done(false), milliseconds);

      this.waiters.add(waiter);
    });
  }

  /**
   * Runs a tool in the connected tab.
   */
  call(tool, args) {
    if (!this.ready) {
      return Promise.reject(new BridgeError('NOT_CONNECTED', 'No playground tab is connected.'));
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError('TIMEOUT', `The playground did not answer within ${this.timeout / 1000} seconds.`));
      }, this.timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.tab.send(JSON.stringify({ type: 'call', id, tool, args }));
    });
  }

  async close() {
    for (const client of this.wss?.clients ?? []) {
      client.terminate();
    }

    await new Promise((resolve) => this.wss ? this.wss.close(() => resolve()) : resolve());
    await new Promise((resolve) => this.http ? this.http.close(() => resolve()) : resolve());
  }
}
