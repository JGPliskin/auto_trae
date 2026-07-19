import test from 'node:test';
import assert from 'node:assert/strict';

import { createCdpClient } from '../src/cdp-client.mjs';
import { observe } from '../src/observer.mjs';
import { ContinueWatcher } from '../src/watcher.mjs';
import { FakeWebSocket } from './helpers/fakes.mjs';
import {
  IDS,
  makeObservationFixture,
  visibleBox,
} from './fixtures/observations.mjs';

const SIGNATURE = '[redacted] 输入「继续」以获取更多内容 [redacted]';

function candidate({
  sessionKey = 'target-a:session-a',
  candidateKey = `${sessionKey}:101:201:20`,
  promptBackendId = 101,
  buttonBackendId = 201,
  outputRevision,
} = {}) {
  return {
    kind: 'candidate',
    reason: 'candidate_proven',
    sessionKey,
    candidateKey,
    prompt: {
      backendNodeId: promptBackendId,
      role: 'statictext',
      visible: true,
      signatureMatches: true,
    },
    continueButton: {
      backendNodeId: buttonBackendId,
      role: 'button',
      name: 'Continue',
      visible: true,
      enabled: true,
    },
    region: {
      backendNodeId: 20,
      combinedAncestorDistance: 6,
    },
    outputRevision,
  };
}

async function productionObservation({
  fixture = makeObservationFixture({ promptName: SIGNATURE }),
  expectedSessionKey,
  axNodes = fixture.axNodes,
} = {}) {
  return observe({
    targetId: fixture.targetId,
    expectedSessionKey,
    client: {
      async getFullAXTree() { return { nodes: axNodes }; },
      async getDocument() { return { root: fixture.domRoot }; },
      async getBoxModel({ backendNodeId }) {
        return fixture.boxModels.get(backendNodeId) ?? visibleBox();
      },
    },
  });
}

function productionDisappearance(sessionKey, fixture) {
  return productionObservation({ fixture, expectedSessionKey: sessionKey, axNodes: [] });
}

function none({ sessionKey } = {}) {
  return {
    kind: 'none',
    reason: 'no_signature',
    sessionKey,
    candidateKey: undefined,
    prompt: undefined,
    continueButton: undefined,
    region: undefined,
  };
}

function unsafe(reason = 'box_model_unavailable') {
  return {
    kind: 'unsafe',
    reason,
    sessionKey: undefined,
    candidateKey: undefined,
    prompt: undefined,
    continueButton: undefined,
    region: undefined,
  };
}

function setup({ mode = 'live', maxContinueClicks = 3, invokeClick } = {}) {
  const clock = { value: 0 };
  const clicks = [];
  const events = [];
  const watcher = new ContinueWatcher({
    mode,
    maxContinueClicks,
    now: () => clock.value,
    clickCandidate: async (currentCandidate) => {
      clicks.push(currentCandidate);
      await invokeClick?.(currentCandidate);
    },
    logger: {
      async event(entry) {
        events.push(entry);
      },
    },
  });
  return { clicks, clock, events, watcher };
}

async function invoke(watcher, observation = candidate()) {
  assert.equal(await watcher.processObservation(observation), 'waiting');
  assert.equal(await watcher.processObservation(observation), 'click_invoked');
}

function manualEvents(events) {
  return events.filter(({ event }) => event === 'manual_intervention_required');
}

test('dry-run reports its first safe candidate once without clicking, budgeting, or blocking', async () => {
  const { clicks, events, watcher } = setup({ mode: 'dry-run' });
  const observation = candidate();

  assert.equal(await watcher.processObservation(observation), 'would_continue');
  assert.equal(await watcher.processObservation(observation), 'waiting');

  assert.deepEqual(events.map(({ event }) => event), ['candidate_observed', 'would_continue']);
  assert.equal(clicks.length, 0);
  assert.equal(watcher.state.sessionLedgers.size, 0);
  assert.equal(watcher.state.invokedCandidateKeys.size, 0);
  assert.equal(watcher.state.blockedContinuation.size, 0);
  assert.equal(watcher.state.inFlight, undefined);
});

test('live mode clicks only the second equal safe candidate and resolves its current backend node', async () => {
  const { clicks, events, watcher } = setup();
  const first = candidate();
  const second = candidate();

  assert.equal(await watcher.processObservation(first), 'waiting');
  assert.equal(clicks.length, 0);
  assert.equal(await watcher.processObservation(second), 'click_invoked');

  assert.deepEqual(clicks, [{
    candidateKey: second.candidateKey,
    backendNodeId: 201,
  }]);
  assert.equal(watcher.state.sessionLedgers.get(second.sessionKey).continueClicks, 1);
  assert.deepEqual(events.map(({ event }) => event), ['candidate_observed', 'click_invoked']);
});

test('a stale candidateKey with a changed button ID resets stability and cannot click', async () => {
  const { clicks, watcher } = setup();
  const original = candidate();
  const malformed = candidate({ buttonBackendId: 401 });

  assert.equal(await watcher.processObservation(original), 'waiting');
  assert.equal(await watcher.processObservation(malformed), 'waiting');
  assert.equal(clicks.length, 0);
  assert.equal(await watcher.processObservation(original), 'waiting');
  assert.equal(await watcher.processObservation(original), 'click_invoked');
  assert.deepEqual(clicks, [{
    candidateKey: original.candidateKey,
    backendNodeId: original.continueButton.backendNodeId,
  }]);
});

test('blocks before mutation and records the invocation only after the click returns', async () => {
  let releaseClick;
  const clickGate = new Promise((resolve) => {
    releaseClick = resolve;
  });
  const { events, watcher } = setup({ invokeClick: () => clickGate });
  const observation = candidate();

  assert.equal(await watcher.processObservation(observation), 'waiting');
  const pendingClick = watcher.processObservation(observation);

  assert.equal(watcher.state.inFlight.candidateKey, observation.candidateKey);
  assert.deepEqual(watcher.state.blockedContinuation.get(observation.sessionKey), {
    signature: 'continuation_signature',
    reason: 'verification_pending',
    reported: false,
  });
  assert.equal(watcher.state.sessionLedgers.get(observation.sessionKey).continueClicks, 0);
  assert.equal(events.some(({ event }) => event === 'click_invoked'), false);

  releaseClick();
  assert.equal(await pendingClick, 'click_invoked');
  assert.equal(watcher.state.sessionLedgers.get(observation.sessionKey).continueClicks, 1);
  assert.equal(events.filter(({ event }) => event === 'click_invoked').length, 1);
});

test('starts the thirty-second verification deadline after click invocation returns', async () => {
  let context;
  context = setup({
    invokeClick: async () => {
      context.clock.value = 10_000;
    },
  });
  const observation = candidate();

  await invoke(context.watcher, observation);

  assert.equal(context.watcher.state.inFlight.deadlineMs, 40_000);
});

test('a CDP click exception does not consume budget or log click_invoked', async (t) => {
  const socket = new FakeWebSocket('ws://127.0.0.1:39240/devtools/page/trae');
  const client = createCdpClient({
    webSocketDebuggerUrl: socket.url,
    webSocketFactory: () => socket,
  });
  socket.open();
  t.after(() => client.close());
  const context = setup({ invokeClick: ({ backendNodeId }) => client.click({ backendNodeId }) });
  const observation = candidate();

  assert.equal(await context.watcher.processObservation(observation), 'waiting');
  const pending = context.watcher.processObservation(observation);
  socket.respond({
    id: socket.sent[0].id,
    result: { object: { objectId: 'button-object' } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  socket.respond({
    id: socket.sent[1].id,
    result: { exceptionDetails: { text: '[redacted exception]' } },
  });

  assert.equal(await pending, 'manual_intervention_required');
  assert.equal(context.watcher.state.sessionLedgers.get(observation.sessionKey).continueClicks, 0);
  assert.equal(context.events.some(({ event }) => event === 'click_invoked'), false);
  assert.deepEqual(manualEvents(context.events).map(({ reason }) => reason), ['click_failed']);
});

test('unsafe, none, and different-candidate scans reset live stability', async (t) => {
  const breakers = [
    ['unsafe', unsafe()],
    ['none', none()],
    ['different candidate', candidate({ candidateKey: 'target-a:session-a:102:202:20' })],
  ];

  for (const [name, breaker] of breakers) {
    await t.test(name, async () => {
      const { clicks, watcher } = setup();
      const original = candidate();

      assert.equal(await watcher.processObservation(original), 'waiting');
      assert.equal(await watcher.processObservation(breaker), 'waiting');
      assert.equal(await watcher.processObservation(original), 'waiting');
      assert.equal(clicks.length, 0);
      assert.equal(await watcher.processObservation(original), 'click_invoked');
      assert.equal(clicks.length, 1);
    });
  }
});

test('an invoked key and a re-rendered visible blocked signature cannot be clicked again', async () => {
  const { clicks, clock, events, watcher } = setup();
  const original = candidate();
  const rerendered = candidate({
    candidateKey: 'target-a:session-a:101:401:20',
    promptBackendId: 101,
    buttonBackendId: 401,
  });

  await invoke(watcher, original);
  assert.equal(await watcher.processObservation(rerendered), 'waiting');
  assert.equal(clicks.length, 1);

  clock.value = 30_000;
  assert.equal(await watcher.processObservation(rerendered), 'manual_intervention_required');
  assert.equal(await watcher.processObservation(rerendered), 'blocked');
  assert.equal(await watcher.processObservation(rerendered), 'blocked');
  assert.equal(clicks.length, 1);
  assert.equal(manualEvents(events).length, 1);

  assert.equal(
    await watcher.processObservation(await productionDisappearance(original.sessionKey)),
    'waiting',
  );
  assert.equal(await watcher.processObservation(original), 'waiting');
  assert.equal(await watcher.processObservation(original), 'blocked');
  assert.equal(clicks.length, 1);
});

test('click caps are per session, report once, and leave a new session budget untouched', async () => {
  const { clicks, events, watcher } = setup();
  const sessionA = 'target-a:session-a';
  const sessionB = 'target-a:session-b';

  for (let index = 1; index <= 3; index += 1) {
    await invoke(watcher, candidate({
      sessionKey: sessionA,
      candidateKey: `${sessionA}:${index}:201:20`,
      promptBackendId: index,
    }));
    assert.equal(
      await watcher.processObservation(await productionDisappearance(sessionA)),
      'verification_succeeded',
    );
  }

  const fourth = candidate({
    sessionKey: sessionA,
    candidateKey: `${sessionA}:4:204:20`,
    promptBackendId: 4,
    buttonBackendId: 204,
  });
  assert.equal(await watcher.processObservation(fourth), 'manual_intervention_required');
  assert.equal(await watcher.processObservation(fourth), 'blocked');
  assert.equal(manualEvents(events).filter(({ reason }) => reason === 'click_cap_exhausted').length, 1);

  const firstB = candidate({ sessionKey: sessionB });
  await invoke(watcher, firstB);

  assert.equal(clicks.length, 4);
  assert.deepEqual(watcher.state.sessionLedgers.get(sessionA), {
    continueClicks: 3,
    exhaustedReported: true,
  });
  assert.deepEqual(watcher.state.sessionLedgers.get(sessionB), {
    continueClicks: 1,
    exhaustedReported: false,
  });
});

test('a failed third invocation stays blocked without a duplicate cap manual event', async () => {
  const { clicks, events, watcher } = setup({ maxContinueClicks: 3 });
  const sessionKey = 'target-a:session-a';

  for (let index = 1; index <= 2; index += 1) {
    await invoke(watcher, candidate({
      sessionKey,
      candidateKey: `${sessionKey}:${index}:20${index}:20`,
      promptBackendId: index,
      buttonBackendId: 200 + index,
    }));
    assert.equal(
      await watcher.processObservation(await productionDisappearance(sessionKey)),
      'verification_succeeded',
    );
  }

  const third = candidate({
    sessionKey,
    candidateKey: `${sessionKey}:3:203:20`,
    promptBackendId: 3,
    buttonBackendId: 203,
  });
  await invoke(watcher, third);
  assert.equal(await watcher.processObservation(unsafe()), 'manual_intervention_required');

  const rerenderedThird = candidate({
    sessionKey,
    candidateKey: `${sessionKey}:3:403:20`,
    promptBackendId: 3,
    buttonBackendId: 403,
  });
  const result = await watcher.processObservation(rerenderedThird);

  assert.equal(clicks.length, 3);
  assert.deepEqual(manualEvents(events).map(({ reason }) => reason), ['verification_unsafe']);
  assert.equal(result, 'blocked');
  assert.equal(watcher.state.sessionLedgers.get(sessionKey).exhaustedReported, false);
});

test('changed output alone is not proof; production-observed disappearance before 30 seconds is', async () => {
  const { clock, events, watcher } = setup();
  const original = candidate();
  await invoke(watcher, original);

  clock.value = 29_999;
  assert.equal(await watcher.processObservation(candidate({ outputRevision: 'changed' })), 'waiting');
  assert.equal(events.some(({ event }) => event === 'verification_succeeded'), false);

  assert.equal(
    await watcher.processObservation(await productionDisappearance(original.sessionKey)),
    'verification_succeeded',
  );
  assert.equal(events.filter(({ event }) => event === 'verification_succeeded').length, 1);
  assert.equal(watcher.state.inFlight, undefined);
  assert.equal(watcher.state.blockedContinuation.has(original.sessionKey), false);
});

test('a sessionless none cannot verify or unblock an in-flight continuation', async () => {
  const { clicks, events, watcher } = setup();
  const original = candidate();
  await invoke(watcher, original);

  assert.equal(await watcher.processObservation(none()), 'waiting');
  assert.equal(events.some(({ event }) => event === 'verification_succeeded'), false);
  assert.equal(watcher.state.inFlight.candidateKey, original.candidateKey);
  assert.equal(watcher.state.blockedContinuation.has(original.sessionKey), true);

  const rerendered = candidate({
    candidateKey: 'target-a:session-a:101:401:20',
    promptBackendId: 101,
    buttonBackendId: 401,
  });
  assert.equal(await watcher.processObservation(rerendered), 'waiting');
  assert.equal(await watcher.processObservation(rerendered), 'waiting');
  assert.equal(clicks.length, 1);
  assert.equal(events.some(({ event }) => event === 'verification_succeeded'), false);
  assert.equal(watcher.state.inFlight.candidateKey, original.candidateKey);
  assert.equal(watcher.state.blockedContinuation.has(original.sessionKey), true);
});

test('a hand-constructed sessionful none without observer proof cannot verify', async () => {
  const { events, watcher } = setup();
  const original = candidate();
  await invoke(watcher, original);

  assert.equal(
    await watcher.processObservation(none({ sessionKey: original.sessionKey })),
    'waiting',
  );
  assert.equal(events.some(({ event }) => event === 'verification_succeeded'), false);
  assert.equal(watcher.state.inFlight.candidateKey, original.candidateKey);
});

test('observer-to-watcher re-render changes stay blocked until proven disappearance and a fresh two-scan gate', async () => {
  const { clicks, events, watcher } = setup();
  const originalFixture = makeObservationFixture({ promptName: SIGNATURE });
  const replacementFixture = makeObservationFixture({
    promptName: SIGNATURE,
    promptIdBase: 301,
    buttonIdBase: 401,
  });
  const original = await productionObservation({ fixture: originalFixture });
  const replacement = await productionObservation({ fixture: replacementFixture });
  await invoke(watcher, original);

  assert.equal(await watcher.processObservation(replacement), 'waiting');
  assert.equal(await watcher.processObservation(replacement), 'waiting');
  assert.equal(clicks.length, 1);
  assert.equal(events.filter(({ event }) => event === 'verification_succeeded').length, 0);
  assert.equal(watcher.state.inFlight.candidateKey, original.candidateKey);

  const disappearance = await productionDisappearance(original.sessionKey, originalFixture);
  assert.equal(await watcher.processObservation(disappearance), 'verification_succeeded');
  assert.equal(events.filter(({ event }) => event === 'verification_succeeded').length, 1);

  assert.equal(await watcher.processObservation(replacement), 'waiting');
  assert.equal(clicks.length, 1);
  assert.equal(await watcher.processObservation(replacement), 'click_invoked');
  assert.equal(clicks.length, 2);
});

test('timeout, unsafe verification, and loss of session confirmation each report one manual event', async (t) => {
  const cases = [
    {
      name: 'visible prompt at the deadline',
      verification: ({ clock }) => {
        clock.value = 30_000;
        return candidate();
      },
      reason: 'verification_timeout',
    },
    {
      name: 'unsafe verification',
      verification: () => unsafe('dom_unavailable'),
      reason: 'verification_unsafe',
    },
    {
      name: 'loss of session confirmation',
      verification: () => candidate({
        sessionKey: 'target-a:session-b',
        candidateKey: 'target-a:session-b:101:201:20',
      }),
      reason: 'verification_confirmation_lost',
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const context = setup();
      const original = candidate();
      await invoke(context.watcher, original);
      const verification = scenario.verification(context);

      assert.equal(
        await context.watcher.processObservation(verification),
        'manual_intervention_required',
      );
      await context.watcher.processObservation(verification);

      assert.deepEqual(manualEvents(context.events).map(({ reason }) => reason), [scenario.reason]);
      assert.equal(context.clicks.length, 1);
      assert.deepEqual(context.watcher.state.blockedContinuation.get(original.sessionKey), {
        signature: 'continuation_signature',
        reason: scenario.reason,
        reported: true,
      });
    });
  }
});

test('a manually blocked session does not stop observation or clicks in a new session', async () => {
  const { clicks, watcher } = setup();
  await invoke(watcher, candidate());
  assert.equal(await watcher.processObservation(unsafe()), 'manual_intervention_required');

  const sessionB = 'target-a:session-b';
  const observationB = candidate({
    sessionKey: sessionB,
    candidateKey: `${sessionB}:101:201:20`,
  });
  assert.equal(await watcher.processObservation(observationB), 'waiting');
  assert.equal(await watcher.processObservation(observationB), 'click_invoked');

  assert.equal(clicks.length, 2);
  assert.equal(watcher.state.blockedContinuation.has('target-a:session-a'), true);
  assert.equal(watcher.state.inFlight.sessionKey, sessionB);
});

test('a none observed in session B cannot clear session A manual block', async () => {
  const { clicks, watcher } = setup();
  const originalA = candidate();
  await invoke(watcher, originalA);
  assert.equal(await watcher.processObservation(unsafe()), 'manual_intervention_required');

  const sessionB = 'target-a:session-b';
  const observationB = candidate({
    sessionKey: sessionB,
    candidateKey: `${sessionB}:101:201:20`,
  });
  assert.equal(await watcher.processObservation(observationB), 'waiting');
  assert.equal(await watcher.processObservation(none()), 'waiting');
  assert.equal(watcher.state.blockedContinuation.has(originalA.sessionKey), true);

  const rerenderedA = candidate({
    candidateKey: 'target-a:session-a:301:401:20',
    promptBackendId: 301,
    buttonBackendId: 401,
  });
  assert.equal(await watcher.processObservation(rerenderedA), 'blocked');
  assert.equal(await watcher.processObservation(rerenderedA), 'blocked');
  assert.equal(clicks.length, 1);
});
