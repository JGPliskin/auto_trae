import {
  analyzeCandidate,
  findAxCandidates,
  findExpectedSession,
  proveDisappearance,
} from './candidate.mjs';

function transportReason(error) {
  if (/socket closed/i.test(error?.message)) return 'socket_closed';
  if (/timeout/i.test(error?.message)) return 'request_timeout';
  return 'connection_failed';
}

function unsafe(reason, error) {
  return {
    kind: 'unsafe',
    reason,
    ...(error ? { transportReason: transportReason(error) } : {}),
    sessionKey: undefined,
    candidateKey: undefined,
    prompt: undefined,
    continueButton: undefined,
    region: undefined,
  };
}

async function readAxTree(client) {
  let error;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { result: await client.getFullAXTree() };
    } catch (caught) {
      error = caught;
    }
  }
  return { error };
}

export async function observe({ client, targetId, expectedSessionKey }) {
  const axRead = await readAxTree(client);
  if (axRead.error) return unsafe('ax_unavailable', axRead.error);
  const { result: axResult } = axRead;

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
