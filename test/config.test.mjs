import test from 'node:test';
import assert from 'node:assert/strict';

import { endpointFor, parseArgs } from '../src/config.mjs';

test('uses safe local defaults', () => {
  assert.deepEqual(parseArgs([]), {
    endpoint: 'http://127.0.0.1:39240',
    enable: false,
    maxContinueClicks: 3,
    pollMs: 1500,
    once: false,
    logFile: 'logs/trae-auto-continue.jsonl',
  });
});

test('parses the supported flags together', () => {
  assert.deepEqual(parseArgs([
    '--enable',
    '--once',
    '--port', '39241',
    '--poll-ms', '2000',
    '--max-continue-clicks', '2',
    '--log-file', 'tmp/test.jsonl',
  ]), {
    endpoint: 'http://127.0.0.1:39241',
    enable: true,
    maxContinueClicks: 2,
    pollMs: 2000,
    once: true,
    logFile: 'tmp/test.jsonl',
  });
});

test('accepts only valid TCP ports, click limits, and non-busy poll intervals', () => {
  for (const port of [1, 65535]) {
    assert.equal(endpointFor(port), `http://127.0.0.1:${port}`);
  }
  for (const port of [0, 65536, 1.5, '39240']) {
    assert.throws(() => endpointFor(port), /Usage:/);
  }
  for (const clicks of [1, 2, 3]) {
    assert.equal(parseArgs(['--max-continue-clicks', String(clicks)]).maxContinueClicks, clicks);
  }
  for (const clicks of [0, 4, 1.5, 'two']) {
    assert.throws(() => parseArgs(['--max-continue-clicks', String(clicks)]), /Usage:/);
  }
  for (const pollMs of [250, 60000]) {
    assert.equal(parseArgs(['--poll-ms', String(pollMs)]).pollMs, pollMs);
  }
  for (const pollMs of [249, 60001, 1.5, 'slow']) {
    assert.throws(() => parseArgs(['--poll-ms', String(pollMs)]), /Usage:/);
  }
});

test('rejects unknown flags, missing values, invalid numbers, and endpoint input', () => {
  const invalidArgv = [
    ['--unknown'],
    ['--port'],
    ['--port', 'not-a-port'],
    ['--port', '39240.5'],
    ['--poll-ms'],
    ['--max-continue-clicks'],
    ['--log-file'],
    ['--endpoint', 'http://example.com:39240'],
    ['--endpoint', 'http://127.0.0.1:39240'],
  ];

  for (const argv of invalidArgv) {
    assert.throws(() => parseArgs(argv), /Usage:/, argv.join(' '));
  }
});
