export function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

export function fakeFetch(body, options) {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return jsonResponse(body, options);
  };
  return { calls, fetchImpl };
}

export class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  send(message) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('Fake socket is not open');
    }
    this.sent.push(JSON.parse(message));
  }

  respond(payload) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }
}
