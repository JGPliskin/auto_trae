import test from 'node:test';
import assert from 'node:assert/strict';

import { createCdpClient } from '../src/cdp-client.mjs';
import { observe } from '../src/observer.mjs';
import { FakeWebSocket } from './helpers/fakes.mjs';
import { IDS, axNode, makeObservationFixture } from './fixtures/observations.mjs';

const REDACTED_SIGNATURE_INPUT = '[redacted] 输入「继续」以获取更多内容 [redacted]';

function setup(t) {
  const socket = new FakeWebSocket('ws://127.0.0.1:39240/devtools/page/trae');
  const client = createCdpClient({
    webSocketDebuggerUrl: socket.url,
    webSocketFactory: () => socket,
  });
  socket.open();
  t.after(() => client.close());
  return { client, socket };
}

function requestFor(socket, method, backendNodeId) {
  return socket.sent.find((request) => (
    request.method === method
    && (backendNodeId === undefined || request.params?.backendNodeId === backendNodeId)
  ));
}

async function flushRequests() {
  await new Promise((resolve) => setImmediate(resolve));
}

test('no AX continuation signature returns none without DOM or box requests', async (t) => {
  const { client, socket } = setup(t);
  const pending = observe({ client, targetId: 'target-a' });

  assert.deepEqual(socket.sent.map(({ method }) => method), ['Accessibility.getFullAXTree']);
  socket.respond({
    id: socket.sent[0].id,
    result: {
      nodes: [
        axNode({ backendNodeId: 50, role: 'StaticText', name: '[redacted]' }),
        axNode({ backendNodeId: 51, role: 'button', name: 'Continue' }),
      ],
    },
  });

  assert.equal((await pending).kind, 'none');
  assert.deepEqual(socket.sent.map(({ method }) => method), ['Accessibility.getFullAXTree']);
});

test('verification mode proves a target-bound rendered session before returning none', async (t) => {
  const fixture = makeObservationFixture({ promptName: REDACTED_SIGNATURE_INPUT });
  const { client, socket } = setup(t);
  const expectedSessionKey = 'target-a:session-a';
  const pending = observe({
    client,
    targetId: fixture.targetId,
    expectedSessionKey,
  });

  socket.respond({
    id: socket.sent[0].id,
    result: { nodes: [axNode({ backendNodeId: 50, role: 'StaticText', name: '[redacted]' })] },
  });
  await flushRequests();
  assert.deepEqual(socket.sent.slice(1).map(({ method }) => method), ['DOM.getDocument']);

  socket.respond({
    id: requestFor(socket, 'DOM.getDocument').id,
    result: { root: fixture.domRoot },
  });
  await flushRequests();
  const sessionBox = requestFor(socket, 'DOM.getBoxModel', IDS.session);
  assert.ok(sessionBox);
  socket.respond({ id: sessionBox.id, result: fixture.boxModels.get(IDS.prompt) });

  assert.deepEqual(await pending, {
    kind: 'none',
    reason: 'no_signature',
    sessionKey: expectedSessionKey,
    candidateKey: undefined,
    prompt: undefined,
    continueButton: undefined,
    region: undefined,
    disappearanceProof: {
      targetId: fixture.targetId,
      sessionId: 'session-a',
      sessionBackendNodeId: IDS.session,
      visible: true,
      signatureAbsent: true,
    },
  });
});

test('verification mode rejects an expected session from another target', async (t) => {
  const { client, socket } = setup(t);
  const pending = observe({
    client,
    targetId: 'target-a',
    expectedSessionKey: 'target-b:session-a',
  });

  socket.respond({ id: socket.sent[0].id, result: { nodes: [] } });

  assert.deepEqual(
    [
      (await pending).kind,
      (await pending).reason,
    ],
    ['unsafe', 'verification_target_mismatch'],
  );
  assert.deepEqual(socket.sent.map(({ method }) => method), ['Accessibility.getFullAXTree']);
});

test('only possible AX nodes request a pierced document and concurrent relevant box models', async (t) => {
  const fixture = makeObservationFixture({ promptName: REDACTED_SIGNATURE_INPUT });
  const { client, socket } = setup(t);
  const pending = observe({ client, targetId: fixture.targetId });

  socket.respond({
    id: socket.sent[0].id,
    result: {
      nodes: [
        ...fixture.axNodes,
        axNode({ backendNodeId: 999, role: 'generic', name: '[redacted]' }),
      ],
    },
  });
  await flushRequests();

  assert.deepEqual(socket.sent.slice(1).map(({ method }) => method), [
    'DOM.getDocument',
    'DOM.getBoxModel',
    'DOM.getBoxModel',
  ]);
  assert.deepEqual(
    socket.sent.filter(({ method }) => method === 'DOM.getBoxModel')
      .map(({ params }) => params.backendNodeId)
      .sort((left, right) => left - right),
    [101, 201],
  );
  assert.equal(requestFor(socket, 'DOM.getBoxModel', 999), undefined);

  const promptBox = requestFor(socket, 'DOM.getBoxModel', 101);
  const buttonBox = requestFor(socket, 'DOM.getBoxModel', 201);
  const documentRequest = requestFor(socket, 'DOM.getDocument');
  socket.respond({ id: buttonBox.id, result: fixture.boxModels.get(201) });
  socket.respond({ id: promptBox.id, result: fixture.boxModels.get(101) });
  socket.respond({ id: documentRequest.id, result: { root: fixture.domRoot } });

  const observation = await pending;
  assert.equal(observation.kind, 'candidate');
  assert.equal(observation.candidateKey, 'target-a:session-a:101:201:20');
});

async function observeWithFailure(t, failure) {
  const fixture = makeObservationFixture({ promptName: REDACTED_SIGNATURE_INPUT });
  const { client, socket } = setup(t);
  const pending = observe({ client, targetId: fixture.targetId });
  socket.respond({ id: socket.sent[0].id, result: { nodes: fixture.axNodes } });
  await flushRequests();

  const documentRequest = requestFor(socket, 'DOM.getDocument');
  const promptBox = requestFor(socket, 'DOM.getBoxModel', 101);
  const buttonBox = requestFor(socket, 'DOM.getBoxModel', 201);
  if (failure === 'dom') {
    socket.respond({ id: documentRequest.id, error: { message: 'unavailable' } });
    socket.respond({ id: promptBox.id, result: fixture.boxModels.get(101) });
  } else {
    socket.respond({ id: documentRequest.id, result: { root: fixture.domRoot } });
    socket.respond({ id: promptBox.id, error: { message: 'unavailable' } });
  }
  socket.respond({ id: buttonBox.id, result: fixture.boxModels.get(201) });
  return pending;
}

test('DOM and box failures become unsafe observations, never partial candidates', async (t) => {
  const domFailure = await observeWithFailure(t, 'dom');
  const boxFailure = await observeWithFailure(t, 'box');

  assert.deepEqual([domFailure.kind, domFailure.reason], ['unsafe', 'dom_unavailable']);
  assert.deepEqual([boxFailure.kind, boxFailure.reason], ['unsafe', 'box_model_unavailable']);
  assert.equal(domFailure.candidateKey, undefined);
  assert.equal(boxFailure.candidateKey, undefined);
});
