import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { healthTimeoutForPollMs, runSupervisor } from '../src/supervisor.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    if (child.killed) return;
    child.killed = true;
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
  };
  return child;
}

test('keeps the health timeout beyond the configured polling interval', () => {
  assert.equal(healthTimeoutForPollMs(1_500), 30_000);
  assert.equal(healthTimeoutForPollMs(30_000), 61_000);
});

test('restarts a stopped watcher and kills the active child on supervisor abort', async () => {
  const controller = new AbortController();
  const children = [];
  const sleeps = [];
  const spawns = [];
  const events = [];

  const spawnProcess = (nodePath, args, options) => {
    const child = fakeChild();
    children.push(child);
    spawns.push({ nodePath, args, options });
    if (children.length === 1) {
      queueMicrotask(() => child.emit('close', 17, null));
    } else {
      queueMicrotask(() => controller.abort());
    }
    return child;
  };

  await runSupervisor({
    spawnProcess,
    nodePath: 'node.exe',
    cliPath: 'src/cli.mjs',
    cliArgs: ['--enable', '--port', '39240'],
    cwd: 'E:\\project\\auto_trae',
    restartDelayMs: 250,
    sleep: async (ms) => { sleeps.push(ms); },
    signal: controller.signal,
    output: (event) => events.push(event),
  });

  assert.equal(children.length, 2);
  assert.equal(children[1].killed, true);
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(spawns[0], {
    nodePath: 'node.exe',
    args: ['src/cli.mjs', '--enable', '--port', '39240'],
    options: {
      cwd: 'E:\\project\\auto_trae',
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    },
  });
  assert.deepEqual(events, [
    { event: 'watcher_child_exit', code: 17, signal: undefined },
  ]);
});

test('restarts a live but silent watcher after the health timeout', async () => {
  const controller = new AbortController();
  const children = [];
  const sleeps = [];
  const spawns = [];
  const intervals = [];
  const events = [];
  let now = 0;

  const spawnProcess = (nodePath, args, options) => {
    const child = fakeChild();
    children.push(child);
    spawns.push({ nodePath, args, options });
    if (children.length === 1) {
      queueMicrotask(() => {
        now = 1_001;
        intervals[0]();
      });
    } else {
      queueMicrotask(() => controller.abort());
    }
    return child;
  };

  await runSupervisor({
    spawnProcess,
    nodePath: 'node.exe',
    cliPath: 'src/cli.mjs',
    cliArgs: ['--enable', '--port', '39240'],
    cwd: 'E:\\project\\auto_trae',
    restartDelayMs: 250,
    healthTimeoutMs: 1_000,
    healthCheckIntervalMs: 100,
    now: () => now,
    setIntervalImpl: (callback, ms) => {
      assert.equal(ms, 100);
      intervals.push(callback);
      return callback;
    },
    clearIntervalImpl: () => {},
    sleep: async (ms) => { sleeps.push(ms); },
    signal: controller.signal,
    output: (event) => events.push(event),
  });

  assert.equal(children.length, 2);
  assert.equal(children[0].killed, true);
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(spawns[0].options, {
    cwd: 'E:\\project\\auto_trae',
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  assert.deepEqual(events.map(({ event }) => event), [
    'watcher_child_stalled',
    'watcher_child_exit',
  ]);
  assert.equal(events[0].silenceMs, 1_001);
});
