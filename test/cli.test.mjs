import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { discoverTraeTarget as discoverDefaultTraeTarget } from '../src/cdp-client.mjs';
import { renderProcessError, runCli } from '../src/cli.mjs';
import { usage } from '../src/config.mjs';
import { observe as observeDefault } from '../src/observer.mjs';
import { makeObservationFixture, visibleBox } from './fixtures/observations.mjs';

const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

const target = {
  id: 'target-a',
  webSocketDebuggerUrl: 'ws://127.0.0.1:39240/devtools/page/target-a',
};

function candidate({
  candidateKey = 'target-a:session-a:101:201:20',
  promptBackendId = 101,
  buttonBackendId = 201,
} = {}) {
  return {
    kind: 'candidate',
    reason: 'candidate_proven',
    sessionKey: 'target-a:session-a',
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
    region: { backendNodeId: 20, combinedAncestorDistance: 6 },
  };
}

function none(sessionKey = 'target-a:session-a') {
  const separator = sessionKey?.indexOf(':') ?? -1;
  const targetId = separator > 0 ? sessionKey.slice(0, separator) : undefined;
  const sessionId = separator > 0 ? sessionKey.slice(separator + 1) : undefined;
  return {
    kind: 'none',
    reason: 'no_signature',
    sessionKey,
    candidateKey: undefined,
    prompt: undefined,
    continueButton: undefined,
    region: undefined,
    ...(targetId && sessionId ? {
      disappearanceProof: {
        targetId,
        sessionId,
        sessionBackendNodeId: 10,
        visible: true,
        signatureAbsent: true,
      },
    } : {}),
  };
}

function setup({ clickImpl, discoverImpl, eventImpl, observeImpl, sleepImpl } = {}) {
  const calls = {
    clientCreations: 0,
    clicks: [],
    closes: 0,
    discoveries: 0,
    events: [],
    observations: 0,
    observationArgs: [],
    output: [],
    sleeps: [],
  };
  const client = {
    async waitUntilOpen() {},
    async click(value) {
      calls.clicks.push(value);
      await clickImpl?.(value);
    },
    close() { calls.closes += 1; },
  };
  const dependencies = {
    async discoverTraeTarget() {
      calls.discoveries += 1;
      return discoverImpl ? discoverImpl(calls.discoveries) : target;
    },
    createCdpClient() {
      calls.clientCreations += 1;
      return client;
    },
    async observe(args) {
      calls.observations += 1;
      calls.observationArgs.push(args);
      return observeImpl ? observeImpl(calls.observations, args) : candidate();
    },
    async sleep(ms, options) {
      calls.sleeps.push(ms);
      await sleepImpl?.(ms, options);
    },
    now: () => 0,
    logger: {
      async event(entry) {
        calls.events.push(entry);
        await eventImpl?.(entry);
      },
    },
    output(line) { calls.output.push(line); },
  };
  return { calls, dependencies };
}

test('--once performs one read-only observation even with --enable and does not reconnect', async () => {
  const { calls, dependencies } = setup();

  await runCli({ argv: ['--once', '--enable'], ...dependencies });

  assert.equal(calls.discoveries, 1);
  assert.equal(calls.observations, 1);
  assert.equal(calls.clicks.length, 0);
  assert.equal(calls.sleeps.length, 0);
  assert.equal(calls.closes, 1);
  assert.deepEqual(calls.events.map(({ event }) => event), [
    'connection_state_changed',
    'candidate_observed',
    'would_continue',
  ]);
});

test('default dry-run reports a candidate without invoking its click helper', async () => {
  const controller = new AbortController();
  const { calls, dependencies } = setup({
    sleepImpl: async () => controller.abort(),
  });

  await runCli({ argv: [], signal: controller.signal, ...dependencies });

  assert.deepEqual(calls.sleeps, [1500]);
  assert.equal(calls.clicks.length, 0);
  assert.equal(calls.closes, 1);
  assert.deepEqual(calls.events.map(({ event }) => event), [
    'connection_state_changed',
    'candidate_observed',
    'would_continue',
  ]);
});

test('discovery failures use bounded 1.5, 3, 6, then 15 second reconnect delays', async () => {
  const controller = new AbortController();
  let context;
  context = setup({
    discoverImpl: async () => { throw new Error('discovery offline'); },
    sleepImpl: async () => {
      if (context.calls.sleeps.length === 5) controller.abort();
    },
  });

  await runCli({ argv: [], signal: controller.signal, ...context.dependencies });

  assert.equal(context.calls.discoveries, 5);
  assert.deepEqual(context.calls.sleeps, [1500, 3000, 6000, 15000, 15000]);
  assert.equal(context.calls.observations, 0);
});

test('identical unavailable states are deduplicated and connection recovery is logged', async () => {
  const controller = new AbortController();
  const context = setup({
    discoverImpl: async (call) => (call < 3 ? { kind: 'unavailable' } : target),
    observeImpl: async () => {
      controller.abort();
      return candidate();
    },
  });

  await runCli({ argv: [], signal: controller.signal, ...context.dependencies });

  assert.deepEqual(context.calls.sleeps, [1500, 3000]);
  assert.deepEqual(
    context.calls.events
      .filter(({ event }) => event === 'connection_state_changed')
      .map(({ connectionState, reason }) => [connectionState, reason]),
    [
      ['unavailable', 'target_unavailable'],
      ['connected', undefined],
    ],
  );
  assert.deepEqual(context.calls.output, [
    'connection_state_changed: unavailable (target_unavailable)',
    'connection_state_changed: connected',
  ]);
});

test('a socket closure reconnects after 1.5 seconds and resets consecutive-scan proof', async () => {
  const controller = new AbortController();
  const context = setup({
    observeImpl: async (call) => {
      if (call === 2) throw new Error('CDP socket closed');
      return candidate();
    },
    clickImpl: async () => controller.abort(),
  });

  await runCli({
    argv: ['--enable', '--poll-ms', '250'],
    signal: controller.signal,
    ...context.dependencies,
  });

  assert.equal(context.calls.discoveries, 2);
  assert.equal(context.calls.observations, 4);
  assert.deepEqual(context.calls.sleeps, [250, 1500, 250]);
  assert.equal(context.calls.closes, 2);
  assert.deepEqual(context.calls.clicks, [{ backendNodeId: 201 }]);
  assert.equal(
    context.calls.events.filter(({ event }) => event === 'candidate_observed').length,
    2,
  );
  assert.deepEqual(
    context.calls.events
      .filter(({ event }) => event === 'connection_state_changed')
      .map(({ connectionState, reason }) => [connectionState, reason]),
    [
      ['connected', undefined],
      ['disconnected', 'socket_closed'],
      ['connected', undefined],
    ],
  );
});

test('an observer-level AX transport failure also replaces the client', async () => {
  const controller = new AbortController();
  const context = setup({
    observeImpl: async (call) => {
      if (call === 1) {
        return {
          kind: 'unsafe',
          reason: 'ax_unavailable',
          sessionKey: undefined,
          candidateKey: undefined,
          prompt: undefined,
          continueButton: undefined,
          region: undefined,
        };
      }
      controller.abort();
      return none();
    },
  });

  await runCli({ argv: [], signal: controller.signal, ...context.dependencies });

  assert.equal(context.calls.discoveries, 2);
  assert.deepEqual(context.calls.sleeps, [1500]);
  assert.equal(context.calls.closes, 2);
});

test('session click ledger survives a transport reconnect in the same watcher', async () => {
  const controller = new AbortController();
  let clickCount = 0;
  const replacement = candidate({
    candidateKey: 'target-a:session-a:301:401:20',
    promptBackendId: 301,
    buttonBackendId: 401,
  });
  const context = setup({
    observeImpl: async (call) => {
      if (call <= 2) return candidate();
      if (call === 3) return none();
      if (call === 4) throw new Error('CDP socket closed');
      return replacement;
    },
    clickImpl: async () => {
      clickCount += 1;
      if (clickCount === 2) controller.abort();
    },
  });

  await runCli({
    argv: ['--enable', '--poll-ms', '250'],
    signal: controller.signal,
    ...context.dependencies,
  });

  assert.equal(context.calls.discoveries, 2);
  assert.equal(context.calls.closes, 2);
  assert.deepEqual(context.calls.clicks, [
    { backendNodeId: 201 },
    { backendNodeId: 401 },
  ]);
  assert.deepEqual(
    context.calls.events
      .filter(({ event }) => event === 'click_invoked')
      .map(({ continueClicks }) => continueClicks),
    [1, 2],
  );
});

test('passes the in-flight session to the observer for production disappearance proof', async () => {
  const controller = new AbortController();
  const context = setup({
    observeImpl: async (call) => {
      if (call <= 2) return candidate();
      controller.abort();
      return none();
    },
  });

  await runCli({
    argv: ['--enable', '--poll-ms', '250'],
    signal: controller.signal,
    ...context.dependencies,
  });

  assert.deepEqual(
    context.calls.observationArgs.map(({ expectedSessionKey }) => expectedSessionKey),
    [undefined, undefined, 'target-a:session-a'],
  );
});

test('manual verification block clears through production observer proof before a later two-scan click', async () => {
  const controller = new AbortController();
  const signature = '[redacted] 输入「继续」以获取更多内容 [redacted]';
  const original = makeObservationFixture({ promptName: signature });
  const replacement = makeObservationFixture({
    promptName: signature,
    promptIdBase: 301,
    buttonIdBase: 401,
  });
  const disappearedRoot = structuredClone(original.domRoot);
  disappearedRoot.children[0].children = [];
  const events = [];
  const expectedSessionKeys = [];
  const clickScans = [];
  let scan = 0;

  const client = {
    async waitUntilOpen() {},
    close() {},
    async getFullAXTree() {
      scan += 1;
      if (scan === 7) controller.abort();
      if (scan <= 3) return { nodes: original.axNodes };
      if (scan === 4 || scan === 7) return { nodes: [] };
      return { nodes: replacement.axNodes };
    },
    getDocument() {
      if (scan === 3) throw new Error('[redacted DOM failure]');
      if (scan === 4) return Promise.resolve({ root: disappearedRoot });
      return Promise.resolve({ root: scan < 4 ? original.domRoot : replacement.domRoot });
    },
    async getBoxModel({ backendNodeId }) {
      const boxes = scan < 4 ? original.boxModels : replacement.boxModels;
      return boxes.get(backendNodeId) ?? visibleBox();
    },
    async click() {
      clickScans.push(scan);
      if (clickScans.length === 2) controller.abort();
    },
  };

  await runCli({
    argv: ['--enable', '--poll-ms', '250'],
    signal: controller.signal,
    discoverTraeTarget: async () => target,
    createCdpClient: () => client,
    observe: async (args) => {
      expectedSessionKeys.push(args.expectedSessionKey);
      return observeDefault(args);
    },
    sleep: async () => {},
    now: () => 0,
    logger: { async event(entry) { events.push(entry); } },
    output: () => {},
  });

  assert.equal(scan, 6);
  assert.deepEqual(expectedSessionKeys, [
    undefined,
    undefined,
    'target-a:session-a',
    'target-a:session-a',
    undefined,
    undefined,
  ]);
  assert.deepEqual(clickScans, [2, 6]);
  assert.deepEqual(
    events.filter(({ event }) => event === 'manual_intervention_required')
      .map(({ reason }) => reason),
    ['verification_unsafe'],
  );
  assert.equal(events.filter(({ event }) => event === 'candidate_observed').length, 2);
  assert.equal(events.filter(({ event }) => event === 'click_invoked').length, 2);
});

test('AbortSignal closes an attached client immediately and exits foreground cleanly', async () => {
  const controller = new AbortController();
  let releaseObservation;
  let observationStarted;
  const started = new Promise((resolve) => { observationStarted = resolve; });
  const context = setup({
    observeImpl: () => new Promise((resolve) => {
      releaseObservation = resolve;
      observationStarted();
    }),
  });

  const running = runCli({ argv: [], signal: controller.signal, ...context.dependencies });
  await started;
  controller.abort();
  await Promise.resolve();
  const closesAtAbort = context.calls.closes;
  releaseObservation(candidate());
  await running;

  assert.equal(closesAtAbort, 1);
  assert.equal(context.calls.closes, 1);
  assert.equal(context.calls.clicks.length, 0);
  assert.equal(context.calls.sleeps.length, 0);
});

test('abort during slow discovery returns before discovery settles and never creates a client', async () => {
  const controller = new AbortController();
  let discoveryStarted;
  let resolveDiscovery;
  const started = new Promise((resolve) => { discoveryStarted = resolve; });
  const context = setup({
    discoverImpl: () => new Promise((resolve) => {
      resolveDiscovery = resolve;
      discoveryStarted();
    }),
  });
  let settled = false;
  const running = runCli({ argv: [], signal: controller.signal, ...context.dependencies })
    .then(() => { settled = true; });

  await started;
  controller.abort();
  await Promise.resolve();
  await Promise.resolve();
  const settledBeforeDiscovery = settled;
  resolveDiscovery(target);
  await running;

  assert.equal(settledBeforeDiscovery, true);
  assert.equal(context.calls.clientCreations, 0);
  assert.equal(context.calls.observations, 0);
  assert.equal(context.calls.clicks.length, 0);
});

test('foreground abort reaches and cancels the underlying production discovery fetch', async () => {
  const controller = new AbortController();
  let fetchSignal;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const fetchImpl = (_url, { signal } = {}) => {
    fetchSignal = signal;
    markStarted();
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('[redacted abort]')), { once: true });
    });
  };

  const running = runCli({
    signal: controller.signal,
    discoverTraeTarget: (args) => discoverDefaultTraeTarget({
      ...args,
      fetchImpl,
      discoveryTimeoutMs: 1_000,
    }),
    createCdpClient: () => { throw new Error('client must not be created'); },
    sleep: async () => {},
    logger: { async event() {} },
    output: () => {},
  });
  await started;
  controller.abort();
  await running;

  assert.equal(fetchSignal?.aborted, true);
});

test('a discovery rejection after abort is consumed without unhandled rejection', async () => {
  const controller = new AbortController();
  let rejectDiscovery;
  const context = setup({
    discoverImpl: () => new Promise((_, reject) => {
      rejectDiscovery = reject;
    }),
  });
  const unhandled = [];
  const handleUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', handleUnhandled);

  try {
    const running = runCli({ argv: [], signal: controller.signal, ...context.dependencies });
    await Promise.resolve();
    controller.abort();
    await running;
    rejectDiscovery(new Error('late sensitive discovery failure'));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(unhandled, []);
    assert.equal(context.calls.clientCreations, 0);
  } finally {
    process.removeListener('unhandledRejection', handleUnhandled);
  }
});

test('abort from connected logging prevents the first observation and closes the client', async () => {
  const controller = new AbortController();
  const context = setup({
    eventImpl: async ({ event, connectionState }) => {
      if (event === 'connection_state_changed' && connectionState === 'connected') {
        controller.abort();
      }
    },
  });

  await runCli({ argv: [], signal: controller.signal, ...context.dependencies });

  assert.equal(context.calls.clientCreations, 1);
  assert.equal(context.calls.closes, 1);
  assert.equal(context.calls.observations, 0);
  assert.equal(context.calls.clicks.length, 0);
});

test('process-level --help prints exported usage and exits before foreground startup', () => {
  const result = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${usage}\n`);
  assert.equal(result.stderr, '');
});

test('process entry parses invalid configuration and exits with a usage error', () => {
  const result = spawnSync(process.execPath, [cliPath, '--port', 'invalid'], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Usage: port must be an integer/);
  assert.equal(result.stdout, '');
});

test('unexpected process errors render a fixed redacted message', () => {
  const secret = 'socket exploded at C:\\Users\\private\\chat-secret';

  const rendered = renderProcessError(new Error(secret));

  assert.equal(rendered, 'Foreground watcher failed (runtime_failure)');
  assert.equal(rendered.includes(secret), false);
});
