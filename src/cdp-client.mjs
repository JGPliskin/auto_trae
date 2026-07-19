const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

function requireLoopbackUrl(value, protocol) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CDP URL must be a valid 127.0.0.1 URL');
  }
  const authority = typeof value === 'string'
    ? /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1]
    : undefined;
  if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || !/^127\.0\.0\.1(?::\d+)?$/.test(authority)) {
    throw new Error('CDP URL must use 127.0.0.1');
  }
  return url;
}

function isTraePageTarget(target) {
  return target?.type === 'page'
    && typeof target.title === 'string'
    && target.title.startsWith('TRAE Work')
    && typeof target.url === 'string'
    && target.url.startsWith('vscode-file://vscode-app/')
    && typeof target.webSocketDebuggerUrl === 'string';
}

export async function discoverTraeTarget({ endpoint, fetchImpl = fetch }) {
  const endpointUrl = requireLoopbackUrl(endpoint, 'http:');
  const response = await fetchImpl(new URL('/json/list', endpointUrl).href);
  if (!response.ok) throw new Error(`CDP discovery failed with status ${response.status}`);

  const targets = await response.json();
  const matches = Array.isArray(targets) ? targets.filter(isTraePageTarget) : [];
  if (matches.length === 0) return { kind: 'unavailable' };
  if (matches.length > 1) return { kind: 'ambiguous' };

  requireLoopbackUrl(matches[0].webSocketDebuggerUrl, 'ws:');
  return matches[0];
}

export function createCdpClient({
  webSocketDebuggerUrl,
  webSocketFactory = (url) => new WebSocket(url),
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
}) {
  requireLoopbackUrl(webSocketDebuggerUrl, 'ws:');
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new Error('CDP request timeout must be positive');
  }

  const socket = webSocketFactory(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  let closed = false;

  function rejectPending(error) {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  }

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(new Error(message.error.message || 'CDP request failed'));
    } else {
      entry.resolve(message.result);
    }
  });
  socket.addEventListener('close', () => {
    closed = true;
    rejectPending(new Error('CDP socket closed'));
  });
  socket.addEventListener('error', () => {
    rejectPending(new Error('CDP socket error'));
  });

  function request(method, params) {
    if (closed) return Promise.reject(new Error('CDP socket closed'));
    if (socket.readyState !== socket.OPEN && socket.readyState !== 1) {
      return Promise.reject(new Error('CDP socket is not open'));
    }
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP request timeout for ${method}`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }));
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  return {
    request,
    close() {
      closed = true;
      rejectPending(new Error('CDP socket closed'));
      socket.close();
    },
    getFullAXTree() {
      return request('Accessibility.getFullAXTree');
    },
    getDocument() {
      return request('DOM.getDocument', { depth: -1, pierce: true });
    },
    getBoxModel({ backendNodeId }) {
      return request('DOM.getBoxModel', { backendNodeId });
    },
    resolveNode({ backendNodeId }) {
      return request('DOM.resolveNode', { backendNodeId });
    },
    callFunctionOn({ objectId, functionDeclaration }) {
      return request('Runtime.callFunctionOn', { objectId, functionDeclaration });
    },
    async click({ backendNodeId }) {
      const result = await request('DOM.resolveNode', { backendNodeId });
      return request('Runtime.callFunctionOn', {
        objectId: result.object.objectId,
        functionDeclaration: 'function () { this.click(); }',
      });
    },
  };
}
