import test from 'node:test';
import assert from 'node:assert/strict';

import * as candidateModule from '../src/candidate.mjs';
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

  assert.deepEqual(selected.prompts.map((node) => node.backendNodeId), [1]);
  assert.deepEqual(selected.buttons.map((node) => node.backendNodeId), [3, 4]);
});

test('AX role matching rejects malformed near-matches while allowing casing and outer whitespace only', () => {
  const signature = APPROVED_SIGNATURE_INPUTS[0];

  for (const role of ['static text', 'static-text', 'static_text']) {
    const fixture = makeObservationFixture({ promptName: signature });
    fixture.axNodes[0].role.value = role;
    assert.deepEqual(
      [analyzeCandidate(fixture).kind, analyzeCandidate(fixture).reason],
      ['none', 'no_signature'],
      role,
    );
  }

  for (const role of ['but ton', 'but-ton', 'but_ton']) {
    const fixture = makeObservationFixture({ promptName: signature });
    fixture.axNodes[1].role.value = role;
    assert.deepEqual(
      [analyzeCandidate(fixture).kind, analyzeCandidate(fixture).reason],
      ['unsafe', 'unmatched_signature'],
      role,
    );
  }

  const safelyNormalized = makeObservationFixture({ promptName: signature });
  safelyNormalized.axNodes[0].role.value = '  statictext  ';
  safelyNormalized.axNodes[1].role.value = '  BUTTON  ';
  assert.equal(analyzeCandidate(safelyNormalized).kind, 'candidate');
});

test('exported AX and DOM analysis exposes structural descriptors without raw protocol text', () => {
  const signature = `[redacted-prefix] ${APPROVED_SIGNATURE_INPUTS[0]} [redacted-suffix]`;
  const promptNode = axNode({ backendNodeId: 1, role: 'StaticText', name: signature });
  const buttonNode = axNode({ backendNodeId: 2, role: 'button', name: 'Continue' });
  const selected = findAxCandidates([promptNode, buttonNode]);

  assert.deepEqual(selected, {
    prompts: [{ backendNodeId: 1, signatureMatches: true }],
    buttons: [{ backendNodeId: 2, enabled: true }],
  });
  assert.notEqual(selected.prompts[0], promptNode);
  assert.doesNotMatch(JSON.stringify(selected), /redacted-prefix|redacted-suffix|Continue/);

  const tree = makeTraversalTree();
  tree.children[0].nodeValue = '[redacted-dom-text]';
  const index = indexDomTree(tree);
  assert.deepEqual(index.nodes.get(2), { backendNodeId: 2 });
  assert.notEqual(index.nodes.get(2), tree.children[0]);
  assert.equal(index.attributes, undefined);
  assert.doesNotMatch(JSON.stringify([...index.nodes.values()]), /redacted-dom-text/);
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

test('never pairs a prompt and button across a contentDocument boundary', () => {
  const signature = APPROVED_SIGNATURE_INPUTS[0];
  const fixture = makeObservationFixture({ promptName: signature });
  const prompt = { backendNodeId: IDS.prompt, nodeName: '#text' };
  const button = { backendNodeId: IDS.button, nodeName: 'BUTTON' };
  fixture.domRoot = {
    backendNodeId: IDS.document,
    nodeName: '#document',
    children: [{
      backendNodeId: IDS.session,
      nodeName: 'DIV',
      attributes: [
        'class', 'surface ai-chat chat-session active',
        'data-session-id', 'session-a',
      ],
      children: [{
        backendNodeId: IDS.region,
        nodeName: 'DIV',
        children: [
          button,
          {
            backendNodeId: 30,
            nodeName: 'IFRAME',
            contentDocument: {
              backendNodeId: 31,
              nodeName: '#document',
              children: [prompt],
            },
          },
        ],
      }],
    }],
  };

  const observation = analyzeCandidate(fixture);

  assert.deepEqual([observation.kind, observation.reason], ['unsafe', 'cross_document_pair']);
  assert.equal(observation.candidateKey, undefined);
});

test('rejects an extra permitted visible button deeper in the proven region', () => {
  const observation = analyzeCandidate(makeObservationFixture({
    promptName: APPROVED_SIGNATURE_INPUTS[0],
    deepExtraButton: true,
  }));

  assert.deepEqual([observation.kind, observation.reason], ['unsafe', 'ambiguous_pair']);
  assert.equal(observation.candidateKey, undefined);
});

test('shared candidate validation recomputes identity and requires exact proof fields', () => {
  assert.equal(typeof candidateModule.isSafeCandidateObservation, 'function');
  const observation = analyzeCandidate(makeObservationFixture({
    promptName: APPROVED_SIGNATURE_INPUTS[0],
  }));
  assert.equal(candidateModule.isSafeCandidateObservation(observation), true);

  const malformed = [
    { ...observation, reason: 'unreviewed_reason' },
    { ...observation, candidateKey: `${observation.sessionKey}:stale` },
    {
      ...observation,
      sessionKey: 'session-only',
      candidateKey: `session-only:${IDS.prompt}:${IDS.button}:${IDS.region}`,
    },
    { ...observation, prompt: { ...observation.prompt, role: 'generic' } },
    { ...observation, continueButton: { ...observation.continueButton, name: 'continue' } },
    { ...observation, region: { ...observation.region, combinedAncestorDistance: 9 } },
  ];
  for (const value of malformed) {
    assert.equal(candidateModule.isSafeCandidateObservation(value), false);
  }
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
