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
  return axString(node, 'role').trim().toLowerCase().replace(/[\s_-]/g, '');
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

export function findAxCandidates(nodes) {
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

export function indexDomTree(root) {
  const nodes = new Map();
  const parents = new Map();
  const attributes = new Map();

  function visit(node, parent) {
    if (!node || typeof node !== 'object') return;
    if (parent) parents.set(node, parent);
    attributes.set(node, attributesMap(node.attributes));
    if (Number.isInteger(node.backendNodeId)) nodes.set(node.backendNodeId, node);

    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, node);
    for (const shadowRoot of Array.isArray(node.shadowRoots) ? node.shadowRoots : []) visit(shadowRoot, node);
    visit(node.contentDocument, node);
  }

  visit(root, undefined);
  return { nodes, parents, attributes };
}

export function analyzeCandidate({ targetId, axNodes, domRoot, boxModels }) {
  const { prompts, buttons } = findAxCandidates(axNodes);
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

  const dom = indexDomTree(domRoot);
  if (relevantNodes.some((node) => !dom.nodes.has(backendNodeId(node)))) {
    return emptyObservation('unsafe', 'dom_node_unavailable');
  }

  const allPairs = [];
  for (const promptNode of prompts) {
    for (const buttonNode of buttons) {
      const promptId = backendNodeId(promptNode);
      const buttonId = backendNodeId(buttonNode);
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
    const reason = allPairs.length > 0 ? 'region_distance_exceeded' : 'unmatched_signature';
    return emptyObservation('unsafe', reason);
  }

  const pair = qualifyingPairs[0];
  if (prompts.some((node) => node !== pair.promptNode)) {
    return emptyObservation('unsafe', 'unmatched_signature');
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
  const candidateKey = `${sessionKey}:${pair.promptId}:${pair.buttonId}:${pair.node.backendNodeId}`;
  return emptyObservation('candidate', 'candidate_proven', {
    sessionKey,
    candidateKey,
    prompt: {
      backendNodeId: pair.promptId,
      visible: true,
      signatureMatches: true,
    },
    continueButton: {
      backendNodeId: pair.buttonId,
      visible: true,
      enabled: true,
    },
    region: {
      backendNodeId: pair.node.backendNodeId,
      combinedAncestorDistance: pair.combinedAncestorDistance,
    },
  });
}
