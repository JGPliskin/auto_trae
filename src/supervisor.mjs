import { spawn as defaultSpawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { parseArgs, usage } from './config.mjs';

const ABORTED = Symbol('aborted');
const DEFAULT_RESTART_DELAY_MS = 3_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 1_000;
const HEALTH_TIMEOUT_MARGIN_MS = 1_000;

export function healthTimeoutForPollMs(pollMs) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new TypeError('pollMs must be a positive integer');
  }
  return Math.max(DEFAULT_HEALTH_TIMEOUT_MS, (pollMs * 2) + HEALTH_TIMEOUT_MARGIN_MS);
}

function defaultSleep(ms, { signal } = {}) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };

    timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', finish, { once: true });
  });
}

function waitForAbort(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.resolve(ABORTED);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', handleAbort);
      callback(result);
    };
    const handleAbort = () => finish(resolve, ABORTED);

    signal.addEventListener('abort', handleAbort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

function waitForChild(
  child,
  signal,
  {
    healthTimeoutMs,
    healthCheckIntervalMs,
    now,
    setIntervalImpl,
    clearIntervalImpl,
    output,
  },
) {
  return new Promise((resolve) => {
    let settled = false;
    let stalled = false;
    let lastHeartbeatAt = now();
    let healthTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (healthTimer !== undefined) clearIntervalImpl(healthTimer);
      signal?.removeEventListener('abort', handleAbort);
      child.removeListener('close', handleClose);
      child.removeListener('error', handleError);
      child.removeListener('message', handleMessage);
      resolve(result);
    };
    const handleClose = (code, signalName) => finish({
      kind: 'exit',
      code,
      signal: signalName,
      stalled,
    });
    const handleError = (error) => finish({ kind: 'error', error, stalled });
    const handleMessage = (message) => {
      if (message?.event === 'watcher_heartbeat') lastHeartbeatAt = now();
    };
    const handleHealthCheck = () => {
      if (settled || stalled) return;
      const silenceMs = Math.max(0, now() - lastHeartbeatAt);
      if (silenceMs < healthTimeoutMs) return;
      stalled = true;
      outputSupervisorEvent(output, { event: 'watcher_child_stalled', silenceMs });
      try {
        child.kill();
      } catch {
        // The process may have exited between the health check and kill.
      }
    };
    const handleAbort = () => {
      try {
        child.kill();
      } catch {
        // The process may have exited between the abort and kill calls.
      }
      finish({ kind: 'aborted' });
    };

    child.once('close', handleClose);
    child.once('error', handleError);
    child.on('message', handleMessage);
    healthTimer = setIntervalImpl(handleHealthCheck, healthCheckIntervalMs);
    if (signal?.aborted) handleAbort();
    else signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

function validateRestartDelay(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError('restartDelayMs must be a non-negative finite number');
  }
}

function outputSupervisorEvent(output, event) {
  output?.(event);
}

function renderSupervisorEvent(entry) {
  if (entry.event === 'watcher_child_exit') {
    const code = entry.code === undefined ? 'unknown' : entry.code;
    const signal = entry.signal ? ` (${entry.signal})` : '';
    return `${entry.event}: code=${code}${signal}`;
  }
  return entry.event;
}

export async function runSupervisor({
  spawnProcess = defaultSpawn,
  nodePath = process.execPath,
  cliPath,
  cliArgs = [],
  cwd = process.cwd(),
  restartDelayMs = DEFAULT_RESTART_DELAY_MS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  sleep = defaultSleep,
  signal,
  output = () => {},
} = {}) {
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess must be a function');
  if (typeof nodePath !== 'string' || nodePath.length === 0) throw new TypeError('nodePath is required');
  if (typeof cliPath !== 'string' || cliPath.length === 0) throw new TypeError('cliPath is required');
  if (!Array.isArray(cliArgs)) throw new TypeError('cliArgs must be an array');
  validateRestartDelay(restartDelayMs);
  if (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs <= 0) {
    throw new TypeError('healthTimeoutMs must be a positive finite number');
  }
  if (!Number.isFinite(healthCheckIntervalMs) || healthCheckIntervalMs <= 0) {
    throw new TypeError('healthCheckIntervalMs must be a positive finite number');
  }
  if (signal?.aborted) return;

  while (!signal?.aborted) {
    let child;
    try {
      child = spawnProcess(
        nodePath,
        [cliPath, ...cliArgs],
        { cwd, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: true },
      );
    } catch {
      outputSupervisorEvent(output, { event: 'watcher_child_spawn_failed' });
      const delay = await waitForAbort(sleep(restartDelayMs, { signal }), signal);
      if (delay === ABORTED || signal?.aborted) break;
      continue;
    }

    const result = await waitForChild(child, signal, {
      healthTimeoutMs,
      healthCheckIntervalMs,
      now,
      setIntervalImpl,
      clearIntervalImpl,
      output,
    });
    if (result.kind === 'aborted' || signal?.aborted) break;

    if (result.kind === 'exit') {
      outputSupervisorEvent(output, {
        event: 'watcher_child_exit',
        code: result.code ?? undefined,
        signal: result.signal ?? undefined,
      });
    } else {
      outputSupervisorEvent(output, { event: 'watcher_child_error' });
    }

    const delay = await waitForAbort(sleep(restartDelayMs, { signal }), signal);
    if (delay === ABORTED || signal?.aborted) break;
  }
}

export const supervisorUsage = usage.replace('node src/cli.mjs', 'node src/supervisor.mjs');

function isMain(importMetaUrl) {
  return process.argv[1] !== undefined && importMetaUrl === pathToFileURL(process.argv[1]).href;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(supervisorUsage);
    return;
  }

  let config;
  try {
    config = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Usage: invalid options');
    process.exitCode = 1;
    return;
  }

  const controller = new AbortController();
  const handleInterrupt = () => controller.abort();
  process.once('SIGINT', handleInterrupt);
  process.once('SIGTERM', handleInterrupt);
  try {
    await runSupervisor({
      nodePath: process.execPath,
      cliPath: fileURLToPath(new URL('./cli.mjs', import.meta.url)),
      cliArgs: argv,
      cwd: process.cwd(),
      healthTimeoutMs: healthTimeoutForPollMs(config.pollMs),
      signal: controller.signal,
      output: (event) => console.log(renderSupervisorEvent(event)),
    });
  } finally {
    process.removeListener('SIGINT', handleInterrupt);
    process.removeListener('SIGTERM', handleInterrupt);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
