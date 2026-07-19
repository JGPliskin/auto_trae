import test from 'node:test';
import assert from 'node:assert/strict';

import { createCdpClient, discoverTraeTarget } from '../src/cdp-client.mjs';
import { FakeWebSocket, fakeFetch } from './helpers/fakes.mjs';

const traeTarget = {
  type: 'page',
  title: 'TRAE Work CN',
  url: 'vscode-file://vscode-app/solo-lite.html',
  webSocketDebuggerUrl: 'ws://127.0.0.1:39240/devtools/page/trae',
};

class TrackingWebSocket extends FakeWebSocket {
  constructor(url) {
    super(url);
    this.listeners = new Map();
  }

  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.listeners.get(type)?.delete(listener);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

test('discovers exactly one loopback TRAE Work page target', async () => {
  const { calls, fetchImpl } = fakeFetch([
    { type: 'page', title: 'Other', url: 'https://example.test', webSocketDebuggerUrl: 'ws://127.0.0.1/other' },
    traeTarget,
  ]);

  assert.deepEqual(await discoverTraeTarget({ endpoint: 'http://127.0.0.1:39240', fetchImpl }), traeTarget);
  assert.equal(calls[0][0], 'http://127.0.0.1:39240/json/list');
});

test('reports unavailable or ambiguous Trae targets without choosing one', async () => {
  const unavailable = await discoverTraeTarget({
    endpoint: 'http://127.0.0.1:39240',
    fetchImpl: fakeFetch([]).fetchImpl,
  });
  const ambiguous = await discoverTraeTarget({
    endpoint: 'http://127.0.0.1:39240',
    fetchImpl: fakeFetch([traeTarget, { ...traeTarget, id: 'another' }]).fetchImpl,
  });

  assert.deepEqual(unavailable, { kind: 'unavailable' });
  assert.deepEqual(ambiguous, { kind: 'ambiguous' });
});

test('rejects non-loopback discovery and debugger URLs before socket creation', async () => {
  await assert.rejects(
    discoverTraeTarget({ endpoint: 'http://192.168.1.2:39240', fetchImpl: fakeFetch([]).fetchImpl }),
    /127\.0\.0\.1/,
  );

  let created = false;
  assert.throws(() => createCdpClient({
    webSocketDebuggerUrl: 'ws://localhost:39240/devtools/page/trae',
    webSocketFactory: () => { created = true; },
  }), /127\.0\.0\.1/);
  assert.equal(created, false);
});

test('rejects normalized alternate loopback host spellings before discovery or socket creation', async () => {
  for (const host of ['2130706433', '0x7f000001', '127.0.0.1.']) {
    const discovery = fakeFetch([]);
    await assert.rejects(
      discoverTraeTarget({ endpoint: `http://${host}:39240`, fetchImpl: discovery.fetchImpl }),
      /127\.0\.0\.1/,
    );
    assert.equal(discovery.calls.length, 0, `discovery fetch for ${host}`);

    let created = 0;
    assert.throws(() => createCdpClient({
      webSocketDebuggerUrl: `ws://${host}:39240/devtools/page/trae`,
      webSocketFactory: () => { created += 1; },
    }), /127\.0\.0\.1/);
    assert.equal(created, 0, `socket creation for ${host}`);
  }
});

test('correlates out-of-order responses and rejects only the matching CDP error', async () => {
  const socket = new FakeWebSocket('ws://127.0.0.1:39240/devtools/page/trae');
  const client = createCdpClient({ webSocketDebuggerUrl: socket.url, webSocketFactory: () => socket });
  socket.open();

  const first = client.request('Runtime.evaluate', { expression: 'first' });
  const second = client.request('Runtime.evaluate', { expression: 'second' });
  const third = client.request('Runtime.evaluate', { expression: 'third' });
  socket.respond({ id: socket.sent[1].id, result: { value: 'second' } });
  socket.respond({ id: socket.sent[2].id, error: { message: 'denied' } });
  socket.respond({ id: socket.sent[0].id, result: { value: 'first' } });

  assert.deepEqual(await first, { value: 'first' });
  assert.deepEqual(await second, { value: 'second' });
  await assert.rejects(third, /denied/);
});

test('rejects outstanding work on close and a later client can reconnect', async () => {
  const firstSocket = new FakeWebSocket('ws://127.0.0.1:39240/devtools/page/one');
  const first = createCdpClient({ webSocketDebuggerUrl: firstSocket.url, webSocketFactory: () => firstSocket });
  firstSocket.open();
  const pending = first.request('Accessibility.getFullAXTree');
  firstSocket.close();
  await assert.rejects(pending, /closed/);

  const secondSocket = new FakeWebSocket('ws://127.0.0.1:39240/devtools/page/two');
  const second = createCdpClient({ webSocketDebuggerUrl: secondSocket.url, webSocketFactory: () => secondSocket });
  secondSocket.open();
  const request = second.request('Accessibility.getFullAXTree');
  secondSocket.respond({ id: secondSocket.sent[0].id, result: { nodes: [] } });
  assert.deepEqual(await request, { nodes: [] });
});

test('exposes an awaitable attachment boundary before the first CDP request', async () => {
  const socket = new FakeWebSocket('ws://127.0.0.1:39240/devtools/page/trae');
  const client = createCdpClient({ webSocketDebuggerUrl: socket.url, webSocketFactory: () => socket });
  let attached = false;
  const attachment = client.waitUntilOpen().then(() => {
    attached = true;
  });

  await Promise.resolve();
  assert.equal(attached, false);

  socket.open();
  await attachment;
  assert.equal(attached, true);
});

test('waitUntilOpen rejects a pre-open socket error and cleans temporary listeners', async () => {
  const socket = new TrackingWebSocket('ws://127.0.0.1:39240/devtools/page/trae');
  const client = createCdpClient({ webSocketDebuggerUrl: socket.url, webSocketFactory: () => socket });
  const attachment = client.waitUntilOpen();

  assert.deepEqual(
    ['open', 'close', 'error'].map((type) => socket.listenerCount(type)),
    [1, 2, 2],
  );
  socket.dispatchEvent(new Event('error'));

  await assert.rejects(attachment, /socket error/);
  assert.deepEqual(
    ['open', 'close', 'error'].map((type) => socket.listenerCount(type)),
    [0, 1, 1],
  );
  socket.open();
  await assert.rejects(attachment, /socket error/);
});

test('waitUntilOpen rejects a pre-open close and cleans temporary listeners', async () => {
  const socket = new TrackingWebSocket('ws://127.0.0.1:39240/devtools/page/trae');
  const client = createCdpClient({ webSocketDebuggerUrl: socket.url, webSocketFactory: () => socket });
  const attachment = client.waitUntilOpen();

  socket.close();

  await assert.rejects(attachment, /socket closed/);
  assert.deepEqual(
    ['open', 'close', 'error'].map((type) => socket.listenerCount(type)),
    [0, 1, 1],
  );
  socket.dispatchEvent(new Event('error'));
  await assert.rejects(attachment, /socket closed/);
});

test('uses the thin protocol helpers and a fresh object for the exact click function', async () => {
  const socket = new FakeWebSocket('ws://127.0.0.1:39240/devtools/page/trae');
  const client = createCdpClient({ webSocketDebuggerUrl: socket.url, webSocketFactory: () => socket });
  socket.open();

  const axTree = client.getFullAXTree();
  const document = client.getDocument();
  const box = client.getBoxModel({ backendNodeId: 7 });
  const resolved = client.resolveNode({ backendNodeId: 7 });
  const called = client.callFunctionOn({ objectId: 'object-7', functionDeclaration: 'function () { return this; }' });
  const clicked = client.click({ backendNodeId: 7 });

  assert.deepEqual(socket.sent.map(({ method, params }) => ({ method, params })), [
    { method: 'Accessibility.getFullAXTree', params: undefined },
    { method: 'DOM.getDocument', params: { depth: -1, pierce: true } },
    { method: 'DOM.getBoxModel', params: { backendNodeId: 7 } },
    { method: 'DOM.resolveNode', params: { backendNodeId: 7 } },
    { method: 'Runtime.callFunctionOn', params: { objectId: 'object-7', functionDeclaration: 'function () { return this; }' } },
    { method: 'DOM.resolveNode', params: { backendNodeId: 7 } },
  ]);

  for (const sent of socket.sent.slice(0, 5)) socket.respond({ id: sent.id, result: {} });
  socket.respond({ id: socket.sent[5].id, result: { object: { objectId: 'fresh-object-7' } } });
  await Promise.resolve();
  assert.deepEqual(socket.sent[6], {
    id: socket.sent[6].id,
    method: 'Runtime.callFunctionOn',
    params: { objectId: 'fresh-object-7', functionDeclaration: 'function () { this.click(); }' },
  });
  socket.respond({ id: socket.sent[6].id, result: {} });

  await Promise.all([axTree, document, box, resolved, called, clicked]);
});

test('bounds a request timeout', async () => {
  const socket = new FakeWebSocket('ws://127.0.0.1:39240/devtools/page/trae');
  const client = createCdpClient({
    webSocketDebuggerUrl: socket.url,
    webSocketFactory: () => socket,
    requestTimeoutMs: 5,
  });
  socket.open();

  await assert.rejects(client.request('Runtime.evaluate'), /timeout/);
});
