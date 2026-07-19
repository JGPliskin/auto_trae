import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_REGION_DISTANCE,
  analyzeCandidate,
  findAxCandidates,
  indexDomTree,
  matchesContinuationSignature,
} from '../src/candidate.mjs';
import {
  IDS,
  axNode,
  makeObservationFixture,
  makeTraversalTree,
  visibleBox,
} from './fixtures/observations.mjs';

const APPROVED_SIGNATURE_INPUTS = [
  '模型思考次数已达上限，请输入「继续」以获取更多内容。',
  '输出过长，请输入 “ 继续 ” 以获取更多内容。',
];

test('matches both approved preambles through the shared normalized signature', () => {
  for (const input of APPROVED_SIGNATURE_INPUTS) {
    assert.equal(matchesContinuationSignature(input), true);
  }
  assert.equal(matchesContinuationSignature('输入  "  继续  "  以获取更多内容'), true);
});

test('rejects a bare action label, a generic retry sentence, and a button without the signature', () => {
  assert.equal(matchesContinuationSignature('「继续」'), false);
  assert.equal(matchesContinuationSignature('[redacted generic retry]'), false);

  const observation = analyzeCandidate({
    targetId: 'target-a',
    axNodes: [axNode({ backendNodeId: IDS.button, role: 'button', name: 'Continue' })],
    domRoot: makeTraversalTree(),
    boxModels: new Map([[IDS.button, visibleBox()]]),
  });
  assert.deepEqual(observation, {
    kind: 'none',
    reason: 'no_signature',
    sessionKey: undefined,
    candidateKey: undefined,
    prompt: undefined,
    continueButton: undefined,
    region: undefined,
  });
});

test('AX filtering requires static text and an exact normalized action name', () => {
  const signature = APPROVED_SIGNATURE_INPUTS[0];
  const selected = findAxCandidates([
    axNode({ backendNodeId: 1, role: 'StaticText', name: signature }),
    axNode({ backendNodeId: 2, role: 'generic', name: signature }),
    axNode({ backendNodeId: 3, role: 'button', name: '  Continue  ' }),
    axNode({ backendNodeId: 4, role: 'button', name: ' 继续 ' }),
    axNode({ backendNodeId: 5, role: 'button', name: 'continue' }),
    axNode({ backendNodeId: 6, role: 'link', name: 'Continue' }),
  ]);

  assert.deepEqual(selected.prompts.map((node) => node.backendDOMNodeId), [1]);
  assert.deepEqual(selected.buttons.map((node) => node.backendDOMNodeId), [3, 4]);
});

test('disabled, missing-ID, failed-box, and zero-area evidence is unsafe', () => {
  const signature = APPROVED_SIGNATURE_INPUTS[0];

  const disabled = makeObservationFixture({ promptName: signature });
  disabled.axNodes[1].properties = [{ name: 'disabled', value: { value: true } }];

  const missingId = makeObservationFixture({ promptName: signature });
  delete missingId.axNodes[1].backendDOMNodeId;

  const failedBox = makeObservationFixture({ promptName: signature });
  failedBox.boxModels.delete(IDS.prompt);

  const zeroArea = makeObservationFixture({ promptName: signature });
  zeroArea.boxModels.set(IDS.button, visibleBox(0, 10));

  assert.equal(analyzeCandidate(disabled).reason, 'button_disabled');
  assert.equal(analyzeCandidate(missingId).reason, 'missing_backend_node_id');
  assert.equal(analyzeCandidate(failedBox).reason, 'box_model_unavailable');
  assert.equal(analyzeCandidate(zeroArea).reason, 'not_visible');
  for (const fixture of [disabled, missingId, failedBox, zeroArea]) {
    assert.equal(analyzeCandidate(fixture).kind, 'unsafe');
  }
});

test('DOM indexing traverses children, shadow roots, and recursive content documents', () => {
  const index = indexDomTree(makeTraversalTree());

  assert.deepEqual([...index.nodes.keys()], [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(index.parents.get(index.nodes.get(4)).backendNodeId, 3);
  assert.equal(index.parents.get(index.nodes.get(8)).backendNodeId, 7);
  assert.deepEqual(index.attributes.get(index.nodes.get(6)), new Map([
    ['class', 'inside frame'],
    ['data-session-id', 'opaque-session'],
  ]));
});

test('a unique preferred chat container proves session identity; absent or ambiguous identity is unsafe', () => {
  const signature = APPROVED_SIGNATURE_INPUTS[0];
  const proven = analyzeCandidate(makeObservationFixture({ promptName: signature }));
  const absent = analyzeCandidate(makeObservationFixture({ promptName: signature, sessionIds: [] }));
  const ambiguous = analyzeCandidate(makeObservationFixture({
    promptName: signature,
    sessionIds: ['session-a', 'session-b'],
  }));

  assert.equal(proven.sessionKey, 'target-a:session-a');
  assert.deepEqual([absent.kind, absent.reason], ['unsafe', 'session_unavailable']);
  assert.deepEqual([ambiguous.kind, ambiguous.reason], ['unsafe', 'session_ambiguous']);
});

test('MAX_REGION_DISTANCE is eight because live distance six gets only two wrapper levels of tolerance', () => {
  const signature = APPROVED_SIGNATURE_INPUTS[0];
  assert.equal(MAX_REGION_DISTANCE, 8);

  for (const distance of [6, 8]) {
    const observation = analyzeCandidate(makeObservationFixture({ promptName: signature, distance }));
    assert.equal(observation.kind, 'candidate', `distance ${distance}`);
    assert.equal(observation.region.combinedAncestorDistance, distance);
  }

  const rejected = analyzeCandidate(makeObservationFixture({ promptName: signature, distance: 9 }));
  assert.deepEqual([rejected.kind, rejected.reason], ['unsafe', 'region_distance_exceeded']);
});

test('multiple qualifying pairs or a visible unmatched signature is unsafe', () => {
  const signature = APPROVED_SIGNATURE_INPUTS[0];
  const ambiguous = analyzeCandidate(makeObservationFixture({
    promptName: signature,
    pairCount: 2,
  }));
  const unmatched = analyzeCandidate(makeObservationFixture({
    promptName: signature,
    unmatchedPrompt: true,
  }));

  assert.deepEqual([ambiguous.kind, ambiguous.reason], ['unsafe', 'ambiguous_pair']);
  assert.deepEqual([unmatched.kind, unmatched.reason], ['unsafe', 'unmatched_signature']);
});

test('candidate keys bind target, session, prompt, button, and region IDs', () => {
  const observation = analyzeCandidate(makeObservationFixture({
    promptName: APPROVED_SIGNATURE_INPUTS[1],
  }));

  assert.equal(observation.kind, 'candidate');
  assert.equal(observation.sessionKey, 'target-a:session-a');
  assert.equal(
    observation.candidateKey,
    `target-a:session-a:${IDS.prompt}:${IDS.button}:${IDS.region}`,
  );
});
