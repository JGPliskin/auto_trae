export const IDS = Object.freeze({
  document: 1,
  session: 10,
  region: 20,
  prompt: 101,
  button: 201,
  unmatchedPrompt: 301,
  extraButton: 401,
});

export function axNode({ backendNodeId, role, name, disabled }) {
  return {
    ...(backendNodeId === undefined ? {} : { backendDOMNodeId: backendNodeId }),
    role: { value: role },
    name: { value: name },
    properties: disabled === undefined
      ? []
      : [{ name: 'disabled', value: { value: disabled } }],
  };
}

export function visibleBox(width = 20, height = 10) {
  return { model: { width, height } };
}

const MAX_DEEP_BUTTON_HOPS = 6;

function branch(leaf, hops, idBase) {
  let node = leaf;
  for (let index = 1; index < hops; index += 1) {
    node = { backendNodeId: idBase + index, nodeName: 'DIV', children: [node] };
  }
  return node;
}

function sessionNode(backendNodeId, sessionId, children) {
  return {
    backendNodeId,
    nodeName: 'DIV',
    attributes: [
      'class', 'surface ai-chat chat-session active',
      'data-session-id', sessionId,
    ],
    children,
  };
}

export function makeObservationFixture({
  promptName,
  buttonName = 'Continue',
  distance = 6,
  pairCount = 1,
  sessionIds = ['session-a'],
  unmatchedPrompt = false,
  unmatchedPromptInRegion = false,
  deepExtraButton = false,
  promptIdBase = IDS.prompt,
  buttonIdBase = IDS.button,
  regionId = IDS.region,
} = {}) {
  const promptHops = Math.floor(distance / 2);
  const buttonHops = distance - promptHops;
  const axNodes = [];
  const boxModels = new Map();
  const regionChildren = [];

  for (let index = 0; index < pairCount; index += 1) {
    const promptId = promptIdBase + index;
    const buttonId = buttonIdBase + index;
    axNodes.push(
      axNode({ backendNodeId: promptId, role: 'StaticText', name: promptName }),
      axNode({ backendNodeId: buttonId, role: 'button', name: buttonName }),
    );
    boxModels.set(promptId, visibleBox());
    boxModels.set(buttonId, visibleBox());
    regionChildren.push(
      branch({ backendNodeId: promptId, nodeName: '#text' }, promptHops, 1_000 + (index * 100)),
      branch({ backendNodeId: buttonId, nodeName: 'BUTTON' }, buttonHops, 2_000 + (index * 100)),
    );
  }

  if (deepExtraButton) {
    axNodes.push(axNode({
      backendNodeId: IDS.extraButton,
      role: 'button',
      name: buttonName,
    }));
    boxModels.set(IDS.extraButton, visibleBox());
    regionChildren.push(branch(
      { backendNodeId: IDS.extraButton, nodeName: 'BUTTON' },
      MAX_DEEP_BUTTON_HOPS,
      4_000,
    ));
  }

  if (unmatchedPromptInRegion) {
    axNodes.push(axNode({
      backendNodeId: IDS.unmatchedPrompt,
      role: 'StaticText',
      name: promptName,
    }));
    boxModels.set(IDS.unmatchedPrompt, visibleBox());
    regionChildren.push(branch(
      { backendNodeId: IDS.unmatchedPrompt, nodeName: '#text' },
      2,
      5_000,
    ));
  }

  const region = {
    backendNodeId: regionId,
    nodeName: 'DIV',
    attributes: ['class', 'continuation-card'],
    children: regionChildren,
  };
  const sessionChildren = [region];

  if (unmatchedPrompt) {
    axNodes.push(axNode({
      backendNodeId: IDS.unmatchedPrompt,
      role: 'StaticText',
      name: promptName,
    }));
    boxModels.set(IDS.unmatchedPrompt, visibleBox());
    sessionChildren.push(branch(
      { backendNodeId: IDS.unmatchedPrompt, nodeName: '#text' },
      8,
      3_000,
    ));
  }

  let renderedTree = {
    backendNodeId: 15,
    nodeName: 'DIV',
    attributes: ['class', 'rendered-surface'],
    children: sessionChildren,
  };
  for (let index = sessionIds.length - 1; index >= 0; index -= 1) {
    renderedTree = sessionNode(IDS.session + index, sessionIds[index], [renderedTree]);
  }

  return {
    targetId: 'target-a',
    axNodes,
    domRoot: {
      backendNodeId: IDS.document,
      nodeName: '#document',
      children: [renderedTree],
    },
    boxModels,
  };
}

export function makeTraversalTree() {
  return {
    backendNodeId: 1,
    nodeName: '#document',
    children: [{ backendNodeId: 2, nodeName: 'DIV' }],
    shadowRoots: [{
      backendNodeId: 3,
      nodeName: '#document-fragment',
      children: [{ backendNodeId: 4, nodeName: 'SPAN' }],
    }],
    contentDocument: {
      backendNodeId: 5,
      nodeName: '#document',
      children: [{
        backendNodeId: 6,
        nodeName: 'IFRAME-CONTENT',
        attributes: ['class', 'inside frame', 'data-session-id', 'opaque-session'],
        contentDocument: {
          backendNodeId: 7,
          nodeName: '#document',
          children: [{ backendNodeId: 8, nodeName: 'BUTTON' }],
        },
      }],
    },
  };
}
