import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JsonlLogger } from '../src/logger.mjs';

const FIXED_TIME = Date.parse('2026-07-19T08:09:10.000Z');

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'auto-trae-logger-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'nested', 'events.jsonl');
  const logger = new JsonlLogger({
    file,
    mode: 'live',
    now: () => FIXED_TIME,
  });
  return { file, logger };
}

async function lines(file) {
  return (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
}

test('writes a fixed JSONL schema with timestamp, event code, mode, opaque IDs, and counts', async (t) => {
  const { file, logger } = await setup(t);

  await logger.event({
    event: 'candidate_observed',
    targetId: 'target-secret',
    sessionKey: 'target-secret:session-secret',
    candidateKey: 'target-secret:session-secret:101:201:20',
    continueClicks: 2,
    maxContinueClicks: 3,
  });

  const [entry] = await lines(file);
  assert.deepEqual(Object.keys(entry), [
    'timestamp',
    'event',
    'mode',
    'target_id',
    'session_id',
    'candidate_id',
    'continuation_signature',
    'continue_clicks',
    'max_continue_clicks',
  ]);
  assert.equal(entry.timestamp, '2026-07-19T08:09:10.000Z');
  assert.equal(entry.event, 'candidate_observed');
  assert.equal(entry.mode, 'live');
  assert.match(entry.target_id, /^sha256:[0-9a-f]{24}$/);
  assert.match(entry.session_id, /^sha256:[0-9a-f]{24}$/);
  assert.match(entry.candidate_id, /^sha256:[0-9a-f]{24}$/);
  assert.equal(entry.continuation_signature, 'continuation_signature');
  assert.equal(entry.continue_clicks, 2);
  assert.equal(entry.max_continue_clicks, 3);
});

test('drops raw AX names, session IDs, prompt preambles, and surrounding chat text', async (t) => {
  const { file, logger } = await setup(t);
  const sensitive = {
    targetId: 'target-secret',
    sessionKey: 'target-secret:data-session-id-secret',
    candidateKey: 'target-secret:data-session-id-secret:101:201:20',
    axName: 'raw-ax-name-secret',
    dataSessionId: 'data-session-id-secret',
    prompt: 'raw-prompt-preamble-secret',
    surroundingText: 'raw-conversation-secret',
    signature: 'raw-signature-secret',
  };

  await logger.event({
    event: 'manual_intervention_required',
    ...sensitive,
    reason: 'verification_timeout',
    continueClicks: 1,
    maxContinueClicks: 3,
  });

  const serialized = await readFile(file, 'utf8');
  for (const rawValue of Object.values(sensitive)) {
    assert.doesNotMatch(serialized, new RegExp(rawValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.deepEqual(Object.keys(JSON.parse(serialized)), [
    'timestamp',
    'event',
    'mode',
    'target_id',
    'session_id',
    'candidate_id',
    'continuation_signature',
    'reason',
    'continue_clicks',
    'max_continue_clicks',
  ]);
});

test('deduplicates repeated state but emits state transitions and repeated actions', async (t) => {
  const { file, logger } = await setup(t);
  const firstCandidate = {
    event: 'candidate_observed',
    sessionKey: 'session-a',
    candidateKey: 'candidate-a',
    continueClicks: 0,
    maxContinueClicks: 3,
  };

  await logger.event(firstCandidate);
  await logger.event(firstCandidate);
  await logger.event({ ...firstCandidate, candidateKey: 'candidate-b' });
  await logger.event({ ...firstCandidate, event: 'would_continue' });
  await logger.event({ ...firstCandidate, event: 'would_continue' });

  assert.deepEqual((await lines(file)).map(({ event, candidate_id }) => [event, candidate_id]), [
    ['candidate_observed', (await lines(file))[0].candidate_id],
    ['candidate_observed', (await lines(file))[1].candidate_id],
    ['would_continue', (await lines(file))[2].candidate_id],
    ['would_continue', (await lines(file))[3].candidate_id],
  ]);
  assert.notEqual((await lines(file))[0].candidate_id, (await lines(file))[1].candidate_id);
});

test('allows only fixed event codes', async (t) => {
  const { logger } = await setup(t);

  await assert.rejects(
    logger.event({ event: 'raw_debug_dump', surroundingText: 'secret' }),
    /Unsupported log event/,
  );
});

test('rejects unapproved reason and connection-state tokens instead of logging them as codes', async (t) => {
  const { file, logger } = await setup(t);

  await assert.rejects(
    logger.event({
      event: 'manual_intervention_required',
      reason: 'rawaxname',
      surroundingText: 'rawconversationtext',
    }),
    /Unsupported reason code/,
  );
  await assert.rejects(
    logger.event({
      event: 'connection_state_changed',
      connectionState: 'rawsessionid',
    }),
    /Unsupported connection state/,
  );
  await assert.rejects(readFile(file, 'utf8'), /ENOENT/);
});
