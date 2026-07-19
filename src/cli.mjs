import { pathToFileURL } from 'node:url';

import { createCdpClient as createDefaultCdpClient, discoverTraeTarget as discoverDefaultTraeTarget } from './cdp-client.mjs';
import { parseArgs, usage } from './config.mjs';
import { JsonlLogger } from './logger.mjs';
import { observe as observeDefault } from './observer.mjs';
import { ContinueWatcher } from './watcher.mjs';

const RECONNECT_DELAYS_MS = [1_500, 3_000, 6_000, 15_000];

function renderEvent(entry) {
  const detail = entry.connectionState && entry.reason
    ? `${entry.connectionState} (${entry.reason})`
    : entry.connectionState ?? entry.reason;
  return detail ? `${entry.event}: ${detail}` : entry.event;
}

function connectionReason(error) {
  if (/socket closed/i.test(error?.message)) return 'socket_closed';
  if (/timeout/i.test(error?.message)) return 'request_timeout';
  return 'connection_failed';
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
    if (signal?.aborted) {
      finish();
    } else {
      signal?.addEventListener('abort', finish, { once: true });
    }
  });
}

export async function runCli({
  argv = process.argv.slice(2),
  discoverTraeTarget = discoverDefaultTraeTarget,
  createCdpClient = createDefaultCdpClient,
  observe = observeDefault,
  sleep = defaultSleep,
  now = Date.now,
  logger,
  output = console.log,
  signal,
} = {}) {
  const config = parseArgs(argv);
  const baseLogger = logger ?? new JsonlLogger({
    file: config.logFile,
    mode: config.once || !config.enable ? 'dry-run' : 'live',
    now,
  });
  let lastConnectionFingerprint;
  const eventLogger = {
    async event(entry) {
      if (entry.event === 'connection_state_changed') {
        const fingerprint = `${entry.connectionState}:${entry.reason ?? ''}`;
        if (fingerprint === lastConnectionFingerprint) return false;
        lastConnectionFingerprint = fingerprint;
      }
      const written = await baseLogger.event(entry);
      if (written !== false) output(renderEvent(entry));
      return written;
    },
  };
  let client;
  const closeClient = () => {
    const activeClient = client;
    client = undefined;
    activeClient?.close();
  };
  const watcher = new ContinueWatcher({
    mode: config.once || !config.enable ? 'dry-run' : 'live',
    maxContinueClicks: config.maxContinueClicks,
    now,
    clickCandidate: ({ backendNodeId }) => client.click({ backendNodeId }),
    logger: eventLogger,
  });

  const handleAbort = () => closeClient();
  signal?.addEventListener('abort', handleAbort);
  try {
    let reconnectAttempt = 0;
    while (!signal?.aborted) {
      let stage = 'discovery';
      try {
        const target = await discoverTraeTarget({ endpoint: config.endpoint });
        if (target?.kind === 'unavailable' || target?.kind === 'ambiguous') {
          await eventLogger.event({
            event: 'connection_state_changed',
            connectionState: 'unavailable',
            reason: target.kind === 'ambiguous' ? 'target_ambiguous' : 'target_unavailable',
          });
        } else {
          stage = 'connection';
          client = createCdpClient({ webSocketDebuggerUrl: target.webSocketDebuggerUrl });
          await client.waitUntilOpen?.();
          if (signal?.aborted) break;
          await eventLogger.event({
            event: 'connection_state_changed',
            connectionState: 'connected',
            targetId: target.id,
          });
          reconnectAttempt = 0;
          do {
            const observation = await observe({ client, targetId: target.id });
            if (signal?.aborted) break;
            await watcher.processObservation(observation);
            if (observation?.kind === 'unsafe' && observation.reason === 'ax_unavailable') {
              throw new Error('CDP connection failed');
            }
            if (config.once || signal?.aborted) break;
            await sleep(config.pollMs, { signal });
          } while (!signal?.aborted);
        }
      } catch (error) {
        if (!signal?.aborted) {
          if (stage === 'connection') watcher.resetStability();
          await eventLogger.event({
            event: 'connection_state_changed',
            connectionState: stage === 'discovery' ? 'unavailable' : 'disconnected',
            reason: stage === 'discovery' ? 'discovery_failed' : connectionReason(error),
          });
        }
      } finally {
        closeClient();
      }

      if (config.once || signal?.aborted) break;
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
      reconnectAttempt += 1;
      await sleep(delay, { signal });
    }
  } finally {
    signal?.removeEventListener('abort', handleAbort);
    closeClient();
  }
}

function isMain(importMetaUrl) {
  return process.argv[1] !== undefined && importMetaUrl === pathToFileURL(process.argv[1]).href;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    console.log(usage);
    return;
  }

  const controller = new AbortController();
  const handleInterrupt = () => controller.abort();
  process.once('SIGINT', handleInterrupt);
  try {
    await runCli({ argv, signal: controller.signal });
  } catch (error) {
    console.error(error?.message ?? 'Foreground watcher failed');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', handleInterrupt);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
