import {
  analyzeCandidate,
  findAxCandidates,
  findExpectedSession,
  proveDisappearance,
} from './candidate.mjs';

function unsafe(reason) {
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

export async function observe({ client, targetId, expectedSessionKey }) {
  let axResult;
  try {
    axResult = await client.getFullAXTree();
  } catch {
    return unsafe('ax_unavailable');
  }

  const axNodes = Array.isArray(axResult?.nodes) ? axResult.nodes : [];
  const { prompts, buttons } = findAxCandidates(axNodes);
  if (prompts.length === 0) {
    if (expectedSessionKey === undefined) {
      return analyzeCandidate({ targetId, axNodes, domRoot: undefined, boxModels: new Map() });
    }
    if (typeof expectedSessionKey !== 'string'
      || typeof targetId !== 'string'
      || !expectedSessionKey.startsWith(`${targetId}:`)) {
      return unsafe('verification_target_mismatch');
    }

    let documentResult;
    try {
      documentResult = await client.getDocument();
    } catch {
      return unsafe('dom_unavailable');
    }
    const session = findExpectedSession({
      targetId,
      expectedSessionKey,
      domRoot: documentResult?.root,
    });
    if (session.kind !== 'session') return unsafe(session.reason);

    let boxModel;
    try {
      boxModel = await client.getBoxModel({ backendNodeId: session.sessionBackendNodeId });
    } catch {
      return unsafe('box_model_unavailable');
    }
    return proveDisappearance({ session, boxModel });
  }

  const relevantNodes = [...prompts, ...buttons];
  if (relevantNodes.some((node) => !Number.isInteger(node?.backendNodeId))) {
    return analyzeCandidate({ targetId, axNodes, domRoot: undefined, boxModels: new Map() });
  }

  const backendNodeIds = [...new Set(relevantNodes.map((node) => node.backendNodeId))];
  let requests;
  try {
    requests = [
      client.getDocument(),
      ...backendNodeIds.map((backendNodeId) => client.getBoxModel({ backendNodeId })),
    ];
  } catch {
    return unsafe('dom_unavailable');
  }

  const [documentResult, ...boxResults] = await Promise.allSettled(requests);
  const boxModels = new Map();
  for (let index = 0; index < backendNodeIds.length; index += 1) {
    if (boxResults[index].status === 'fulfilled') {
      boxModels.set(backendNodeIds[index], boxResults[index].value);
    }
  }

  return analyzeCandidate({
    targetId,
    axNodes,
    domRoot: documentResult.status === 'fulfilled' ? documentResult.value?.root : undefined,
    boxModels,
  });
}
