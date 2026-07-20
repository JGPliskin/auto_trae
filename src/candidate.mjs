// Live evidence was six hops, leaving two wrapper levels of tolerance.
export const MAX_REGION_DISTANCE = 8;

const CONTINUATION_SIGNATURE = /输入\s*[「“"]\s*继续\s*[」”"]\s*以获取更多内容/;
const ACTION_NAMES = new Set(['继续', 'Continue']);

function emptyObservation(kind, reason, details = {}) {
  return {
    kind,
    reason,
    sessionKey: undefined,
    candidateKey: undefined,
    prompt: undefined,
    continueButton: undefined,
    region: undefined,
    ...details,
  };
}

function axString(node, property) {
  return typeof node?.[property]?.value === 'string' ? node[property].value : '';
}

function normalizedRole(node) {
  return axString(node, 'role').trim().toLowerCase();
}

function normalizedName(node) {
  return axString(node, 'name').trim().replace(/\s+/g, ' ');
}

function isDisabled(node) {
  if (!Array.isArray(node?.properties)) return false;
  const property = node.properties.find((entry) => entry?.name === 'disabled');
  return property?.value?.value === true;
}

function backendNodeId(node) {
  return Number.isInteger(node?.backendDOMNodeId) ? node.backendDOMNodeId : undefined;
}

function attributesMap(attributes) {
  const result = new Map();
  if (!Array.isArray(attributes)) return result;
  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (typeof attributes[index] === 'string' && typeof attributes[index + 1] === 'string') {
      result.set(attributes[index], attributes[index + 1]);
    }
  }
  return result;
}

function boxState(box) {
  const width = box?.model?.width;
  const height = box?.model?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 'unavailable';
  return width > 0 && height > 0 ? 'visible' : 'hidden';
}

function lowestCommonAncestor(left, right, parents) {
  const leftAncestors = new Map();
  let current = left;
  let distance = 0;
  while (current) {
    leftAncestors.set(current, distance);
    current = parents.get(current);
    distance += 1;
  }

  current = right;
  distance = 0;
  while (current) {
    if (leftAncestors.has(current)) {
      return {
        node: current,
        combinedAncestorDistance: leftAncestors.get(current) + distance,
      };
    }
    current = parents.get(current);
    distance += 1;
  }
  return undefined;
}

function isDescendantOrSelf(node, ancestor, parents) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = parents.get(current);
  }
  return false;
}

function preferredSessionIds(region, parents, attributes) {
  const sessionIds = new Set();
  let current = region;
  while (current) {
    const nodeAttributes = attributes.get(current) ?? new Map();
    const classTokens = new Set((nodeAttributes.get('class') ?? '').split(/\s+/).filter(Boolean));
    if (classTokens.has('ai-chat') && classTokens.has('chat-session')) {
      const sessionId = nodeAttributes.get('data-session-id')?.trim();
      if (sessionId) sessionIds.add(sessionId);
    }
    current = parents.get(current);
  }
  return sessionIds;
}

export function matchesContinuationSignature(value) {
  return typeof value === 'string' && CONTINUATION_SIGNATURE.test(value);
}

function selectAxCandidates(nodes) {
  const safeNodes = Array.isArray(nodes) ? nodes : [];
  return {
    prompts: safeNodes.filter((node) => (
      normalizedRole(node) === 'statictext'
      && matchesContinuationSignature(axString(node, 'name'))
    )),
    buttons: safeNodes.filter((node) => (
      normalizedRole(node) === 'button'
      && ACTION_NAMES.has(normalizedName(node))
    )),
  };
}

export function findAxCandidates(nodes) {
  const selected = selectAxCandidates(nodes);
  return {
    prompts: selected.prompts.map((node) => ({
      backendNodeId: backendNodeId(node),
      signatureMatches: true,
    })),
    buttons: selected.buttons.map((node) => ({
      backendNodeId: backendNodeId(node),
      enabled: !isDisabled(node),
    })),
  };
}

function buildDomIndex(root) {
  const nodes = new Map();
  const parents = new Map();
  const attributes = new Map();
  const documents = new Map();

  function visit(node, parent, documentIdentity) {
    if (!node || typeof node !== 'object') return;
    if (parent) parents.set(node, parent);
    documents.set(node, documentIdentity);
    attributes.set(node, attributesMap(node.attributes));
    if (Number.isInteger(node.backendNodeId)) nodes.set(node.backendNodeId, node);

    for (const child of Array.isArray(node.children) ? node.children : []) {
      visit(child, node, documentIdentity);
    }
    for (const shadowRoot of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) {
      visit(shadowRoot, node, documentIdentity);
    }
    if (node.contentDocument && typeof node.contentDocument === 'object') {
      visit(node.contentDocument, undefined, node.contentDocument);
    }
  }

  visit(root, undefined, root);
  return { nodes, parents, attributes, documents };
}

function candidateKeyFor({ sessionKey, promptBackendNodeId, buttonBackendNodeId, regionBackendNodeId }) {
  return `${sessionKey}:${promptBackendNodeId}:${buttonBackendNodeId}:${regionBackendNodeId}`;
}

export function isSafeCandidateObservation(observation) {
  const promptId = observation?.prompt?.backendNodeId;
  const buttonId = observation?.continueButton?.backendNodeId;
  const regionId = observation?.region?.backendNodeId;
  const distance = observation?.region?.combinedAncestorDistance;
  if (observation?.kind !== 'candidate' || observation.reason !== 'candidate_proven') return false;
  if (typeof observation.sessionKey !== 'string' || observation.sessionKey.length === 0) return false;
  const sessionSeparator = observation.sessionKey.indexOf(':');
  if (sessionSeparator <= 0 || sessionSeparator === observation.sessionKey.length - 1) return false;
  if (!Number.isInteger(promptId) || !Number.isInteger(buttonId) || !Number.isInteger(regionId)) return false;
  if (!Number.isInteger(distance) || distance < 0 || distance > MAX_REGION_DISTANCE) return false;
  if (observation.prompt.role !== 'statictext'
    || observation.prompt.visible !== true
    || observation.prompt.signatureMatches !== true) return false;
  if (observation.continueButton.role !== 'button'
    || !ACTION_NAMES.has(observation.continueButton.name)
    || observation.continueButton.visible !== true
    || observation.continueButton.enabled !== true) return false;

  return observation.candidateKey === candidateKeyFor({
    sessionKey: observation.sessionKey,
    promptBackendNodeId: promptId,
    buttonBackendNodeId: buttonId,
    regionBackendNodeId: regionId,
  });
}

export function isProvenDisappearanceObservation(observation) {
  const proof = observation?.disappearanceProof;
  return observation?.kind === 'none'
    && observation.reason === 'no_signature'
    && typeof observation.sessionKey === 'string'
    && observation.sessionKey.length > 0
    && observation.candidateKey === undefined
    && observation.prompt === undefined
    && observation.continueButton === undefined
    && observation.region === undefined
    && typeof proof?.targetId === 'string'
    && proof.targetId.length > 0
    && typeof proof.sessionId === 'string'
    && proof.sessionId.length > 0
    && Number.isInteger(proof.sessionBackendNodeId)
    && proof.visible === true
    && proof.signatureAbsent === true
    && observation.sessionKey === `${proof.targetId}:${proof.sessionId}`;
}

export function findExpectedSession({ targetId, expectedSessionKey, domRoot }) {
  if (typeof targetId !== 'string'
    || typeof expectedSessionKey !== 'string'
    || !expectedSessionKey.startsWith(`${targetId}:`)) {
    return { kind: 'unsafe', reason: 'verification_target_mismatch' };
  }
  if (!domRoot || typeof domRoot !== 'object') {
    return { kind: 'unsafe', reason: 'dom_unavailable' };
  }

  const sessionId = expectedSessionKey.slice(targetId.length + 1);
  if (sessionId.length === 0) return { kind: 'unsafe', reason: 'session_unavailable' };
  const dom = buildDomIndex(domRoot);
  const matches = [];
  for (const [node, nodeAttributes] of dom.attributes) {
    const classTokens = new Set((nodeAttributes.get('class') ?? '').split(/\s+/).filter(Boolean));
    if (classTokens.has('ai-chat')
      && classTokens.has('chat-session')
      && nodeAttributes.get('data-session-id')?.trim() === sessionId) {
      matches.push(node);
    }
  }
  if (matches.length === 0) return { kind: 'unsafe', reason: 'session_unavailable' };
  if (matches.length > 1) return { kind: 'unsafe', reason: 'session_ambiguous' };
  if (!Number.isInteger(matches[0].backendNodeId)) {
    return { kind: 'unsafe', reason: 'missing_backend_node_id' };
  }
  return {
    kind: 'session',
    targetId,
    sessionId,
    sessionKey: expectedSessionKey,
    sessionBackendNodeId: matches[0].backendNodeId,
  };
}

export function proveDisappearance({ session, boxModel }) {
  const state = boxState(boxModel);
  if (state === 'unavailable') return emptyObservation('unsafe', 'box_model_unavailable');
  if (state === 'hidden') return emptyObservation('unsafe', 'not_visible');
  return emptyObservation('none', 'no_signature', {
    sessionKey: session.sessionKey,
    disappearanceProof: {
      targetId: session.targetId,
      sessionId: session.sessionId,
      sessionBackendNodeId: session.sessionBackendNodeId,
      visible: true,
      signatureAbsent: true,
    },
  });
}

export function indexDomTree(root) {
  const rawIndex = buildDomIndex(root);
  const descriptors = new Map();
  const descriptorFor = (node) => {
    if (!descriptors.has(node)) {
      descriptors.set(node, {
        backendNodeId: Number.isInteger(node?.backendNodeId) ? node.backendNodeId : undefined,
      });
    }
    return descriptors.get(node);
  };
  const nodes = new Map(
    [...rawIndex.nodes].map(([id, node]) => [id, descriptorFor(node)]),
  );
  const parents = new Map(
    [...rawIndex.parents].map(([node, parent]) => [descriptorFor(node), descriptorFor(parent)]),
  );
  return { nodes, parents };
}

export function analyzeCandidate({ targetId, axNodes, domRoot, boxModels }) {
  const { prompts, buttons } = selectAxCandidates(axNodes);
  if (prompts.length === 0) return emptyObservation('none', 'no_signature');

  const relevantNodes = [...prompts, ...buttons];
  if (relevantNodes.some((node) => backendNodeId(node) === undefined)) {
    return emptyObservation('unsafe', 'missing_backend_node_id');
  }

  for (const node of relevantNodes) {
    const state = boxState(boxModels?.get(backendNodeId(node)));
    if (state === 'unavailable') return emptyObservation('unsafe', 'box_model_unavailable');
    if (state === 'hidden') return emptyObservation('unsafe', 'not_visible');
  }

  if (buttons.some(isDisabled)) return emptyObservation('unsafe', 'button_disabled');
  if (buttons.length === 0) return emptyObservation('unsafe', 'unmatched_signature');
  if (!domRoot || typeof domRoot !== 'object') return emptyObservation('unsafe', 'dom_unavailable');

  const dom = buildDomIndex(domRoot);
  if (relevantNodes.some((node) => !dom.nodes.has(backendNodeId(node)))) {
    return emptyObservation('unsafe', 'dom_node_unavailable');
  }

  const allPairs = [];
  let crossDocumentPair = false;
  for (const promptNode of prompts) {
    for (const buttonNode of buttons) {
      const promptId = backendNodeId(promptNode);
      const buttonId = backendNodeId(buttonNode);
      if (dom.documents.get(dom.nodes.get(promptId)) !== dom.documents.get(dom.nodes.get(buttonId))) {
        crossDocumentPair = true;
        continue;
      }
      const region = lowestCommonAncestor(
        dom.nodes.get(promptId),
        dom.nodes.get(buttonId),
        dom.parents,
      );
      if (region) allPairs.push({ promptNode, buttonNode, promptId, buttonId, ...region });
    }
  }

  const qualifyingPairs = allPairs.filter((pair) => (
    pair.combinedAncestorDistance <= MAX_REGION_DISTANCE
  ));
  if (qualifyingPairs.length > 1) return emptyObservation('unsafe', 'ambiguous_pair');
  if (qualifyingPairs.length === 0) {
    const reason = allPairs.length > 0
      ? 'region_distance_exceeded'
      : crossDocumentPair ? 'cross_document_pair' : 'unmatched_signature';
    return emptyObservation('unsafe', reason);
  }

  const pair = qualifyingPairs[0];
  const regionPrompts = prompts.filter((node) => (
    dom.documents.get(dom.nodes.get(backendNodeId(node))) === dom.documents.get(pair.node)
    && isDescendantOrSelf(dom.nodes.get(backendNodeId(node)), pair.node, dom.parents)
  ));
  const regionButtons = buttons.filter((node) => (
    dom.documents.get(dom.nodes.get(backendNodeId(node))) === dom.documents.get(pair.node)
    && isDescendantOrSelf(dom.nodes.get(backendNodeId(node)), pair.node, dom.parents)
  ));
  if (regionPrompts.length !== 1 || regionButtons.length !== 1) {
    // AX may expose historical or virtualized prompts outside the proven button region.
    // Region-local counts above keep same-card ambiguity fail-closed.
    return emptyObservation('unsafe', 'ambiguous_pair');
  }
  if (!Number.isInteger(pair.node.backendNodeId)) {
    return emptyObservation('unsafe', 'missing_backend_node_id');
  }

  const sessionIds = preferredSessionIds(pair.node, dom.parents, dom.attributes);
  if (sessionIds.size === 0) return emptyObservation('unsafe', 'session_unavailable');
  if (sessionIds.size > 1) return emptyObservation('unsafe', 'session_ambiguous');
  if (typeof targetId !== 'string' || targetId.length === 0) {
    return emptyObservation('unsafe', 'target_unavailable');
  }

  const sessionKey = `${targetId}:${[...sessionIds][0]}`;
  const candidateKey = candidateKeyFor({
    sessionKey,
    promptBackendNodeId: pair.promptId,
    buttonBackendNodeId: pair.buttonId,
    regionBackendNodeId: pair.node.backendNodeId,
  });
  return emptyObservation('candidate', 'candidate_proven', {
    sessionKey,
    candidateKey,
    prompt: {
      backendNodeId: pair.promptId,
      role: normalizedRole(pair.promptNode),
      visible: true,
      signatureMatches: true,
    },
    continueButton: {
      backendNodeId: pair.buttonId,
      role: normalizedRole(pair.buttonNode),
      name: normalizedName(pair.buttonNode),
      visible: true,
      enabled: true,
    },
    region: {
      backendNodeId: pair.node.backendNodeId,
      combinedAncestorDistance: pair.combinedAncestorDistance,
    },
  });
}
