// Permission broker: holds each ACP session/request_permission JSON-RPC request open until a human answers it.
// Nothing here ever answers on its own; the orchestrator decides which requests (Lead edit/execute only) are
// auto-rejected before they reach the broker.

export const CANCELLED = Object.freeze({ outcome: { outcome: "cancelled" } });

export class PermissionBroker {
  constructor() {
    this.pending = new Map();
    this.seq = 0;
  }

  /** @returns {{ id: string, promise: Promise<object> }} promise resolves to the ACP `result` for the request. */
  request({ sessionId, workerId, options, toolCall }) {
    const id = `a${++this.seq}`;
    let resolve;
    const promise = new Promise((r) => (resolve = r));
    this.pending.set(id, { id, sessionId, workerId, options: options ?? [], toolCall: toolCall ?? null, resolve });
    return { id, promise };
  }

  get(id) {
    return this.pending.get(id) ?? null;
  }

  /** Answer with one of the offered options. Returns the chosen option, or null when id/option is not valid. */
  resolve(id, optionId) {
    const p = this.pending.get(id);
    if (!p) return null;
    const option = p.options.find((o) => o.optionId === optionId);
    if (!option) return null;
    this.pending.delete(id);
    p.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
    return { option, pending: p };
  }

  cancel(id) {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    p.resolve(CANCELLED);
    return p;
  }

  cancelForSession(sessionId) {
    return [...this.pending.values()].filter((p) => p.sessionId === sessionId).map((p) => this.cancel(p.id));
  }

  cancelAll() {
    return [...this.pending.keys()].map((id) => this.cancel(id));
  }

  list() {
    return [...this.pending.values()];
  }
}
