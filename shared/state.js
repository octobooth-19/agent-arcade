// Agent Arcade shared state: a pure, dependency-free reducer used by the server, the demo engine and the browser.
// Every data source (live Copilot bridge, demo engine, replay) emits the same normalized events.
// The reducer MUTATES the state it is given and returns it. UI code must treat state as read-only.

export const ROLES = ["lead", "planner", "builder", "checker"];
export const WORKER_STATUSES = [
  "idle", "queued", "working", "waiting_approval", "held", "blocked", "done", "failed",
];
export const INBOX_KINDS = ["approval", "failed_check", "question", "batch", "review", "suggestion"];

const MAX_TIMELINE = 3000;
const MAX_OUTPUT_LINES = 80;
const MAX_NOTES = 60;
const NOTE_KINDS_COUNTED = new Set(["hold", "nudge", "redirect", "takeover"]);
const INBOX_PRIORITY = { approval: 0, failed_check: 1, question: 2, batch: 3, review: 4, suggestion: 5 };

export function createInitialState() {
  return {
    rev: 0,
    source: "demo", // "demo" | "live"
    connection: { state: "connecting", message: "" }, // connecting | ready | error
    project: null, // { name, path, isGit } in live mode
    goal: null,
    now: 0, // ms since run start, taken from the newest event
    maxConcurrent: 3,
    holdAll: false,
    workers: {},
    workerOrder: [],
    orders: {},
    orderOrder: [],
    batch: { status: "none", orderIds: [] }, // none | proposed | approved
    approvals: {},
    reviews: {},
    suggestions: {},
    inbox: [],
    timeline: [], // original events, capped; used for replay
    stats: { shipped: 0, approvals: 0, interrupts: 0, sentBack: 0 },
    metrics: null, // { sampledAt, serverMb, copilotMb, childrenMb, sessions } in live mode only
  };
}

export function newWorker(partial = {}) {
  return {
    id: "",
    role: "builder",
    name: "",
    sessionId: null,
    model: null,
    status: "idle",
    queuedReason: null,
    now: "",
    orderId: null,
    plan: [], // [{ text, status: "todo" | "doing" | "done" }]
    files: [], // [{ path, added, removed, diff }]
    output: [], // tail of lines
    notes: [], // [{ id, kind, text, sentAt, delivery: "queued" | "delivered" | "failed", atStep }]
    context: null, // { used, size } tokens, when the agent reports it
    steps: 0,
    activeMs: 0,
    activeSince: null,
    takeover: false,
    worktree: null, // { path, branch } in live mode
    ...partial,
  };
}

function setStatus(state, w, status, t) {
  if (w.status === "working" && w.activeSince != null) {
    w.activeMs += Math.max(0, t - w.activeSince);
    w.activeSince = null;
  }
  if (status === "working") w.activeSince = t;
  w.status = status;
  if (status !== "queued") w.queuedReason = null;
}

function addInbox(state, item, t) {
  state.inbox.push({
    id: item.id,
    kind: item.kind,
    refId: item.refId ?? item.id,
    workerId: item.workerId ?? null,
    summary: item.summary ?? "",
    detail: item.detail ?? "",
    createdAt: t,
    open: true,
    resolution: null,
    resolvedAt: null,
  });
}

function resolveInbox(state, id, resolution, t) {
  const item = state.inbox.find((i) => i.id === id && i.open);
  if (!item) return;
  item.open = false;
  item.resolution = resolution;
  item.resolvedAt = t;
}

/** Apply one event. Unknown events and events for unknown workers are ignored (still recorded for replay). */
export function reduce(state, rawEvent) {
  const ev = structuredClone(rawEvent);
  const t = typeof ev.t === "number" ? ev.t : state.now;
  state.rev += 1;
  if (t > state.now) state.now = t;
  if (ev.type !== "clock" && ev.type !== "snapshot") {
    state.timeline.push(rawEvent);
    if (state.timeline.length > MAX_TIMELINE) state.timeline.shift();
  }
  const w = ev.id ? state.workers[ev.id] : undefined;

  switch (ev.type) {
    case "snapshot": {
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, ev.state);
      state.rev = (state.rev || 0) + 1;
      break;
    }
    case "clock":
      break;
    case "connection":
      state.connection = { state: ev.state, message: ev.message ?? "" };
      if (ev.source) state.source = ev.source;
      break;
    case "run.started":
      state.goal = ev.goal ?? state.goal;
      if (ev.source) state.source = ev.source;
      if (ev.project) state.project = ev.project;
      if (ev.maxConcurrent) state.maxConcurrent = ev.maxConcurrent;
      break;
    case "settings":
      if (typeof ev.maxConcurrent === "number") state.maxConcurrent = ev.maxConcurrent;
      break;
    case "worker.added": {
      const nw = newWorker(ev.worker);
      state.workers[nw.id] = nw;
      if (!state.workerOrder.includes(nw.id)) state.workerOrder.push(nw.id);
      break;
    }
    case "worker.status":
      if (w) {
        setStatus(state, w, ev.status, t);
        if (ev.now != null) w.now = ev.now;
        if (ev.status === "queued") w.queuedReason = ev.reason ?? null;
        if (ev.orderId !== undefined) w.orderId = ev.orderId;
      }
      break;
    case "worker.step":
      if (w) {
        w.steps += 1;
        w.now = ev.text;
      }
      break;
    case "worker.plan":
      if (w) w.plan = ev.plan ?? [];
      break;
    case "worker.file":
      if (w) {
        const f = { path: ev.path, added: ev.added ?? 0, removed: ev.removed ?? 0, diff: ev.diff ?? "" };
        const i = w.files.findIndex((x) => x.path === f.path);
        if (i >= 0) w.files[i] = f;
        else w.files.push(f);
      }
      break;
    case "worker.output":
      if (w) {
        const lines = Array.isArray(ev.lines) ? ev.lines : String(ev.text ?? "").split("\n");
        w.output.push(...lines);
        if (w.output.length > MAX_OUTPUT_LINES) w.output.splice(0, w.output.length - MAX_OUTPUT_LINES);
      }
      break;
    case "worker.usage":
      if (w) w.context = { used: ev.used, size: ev.size };
      break;
    case "worker.session":
      if (w) {
        if (ev.sessionId !== undefined) w.sessionId = ev.sessionId;
        if (ev.model !== undefined) w.model = ev.model;
        if (ev.worktree !== undefined) w.worktree = ev.worktree;
      }
      break;
    case "worker.takeover":
      if (w) w.takeover = !!ev.value;
      break;
    case "note.added":
      if (w) {
        w.notes.push({ id: ev.note.id, kind: ev.note.kind, text: ev.note.text ?? "", sentAt: t, delivery: "queued", atStep: null });
        if (w.notes.length > MAX_NOTES) w.notes.shift();
        if (NOTE_KINDS_COUNTED.has(ev.note.kind)) state.stats.interrupts += 1;
      }
      break;
    case "note.delivered":
      if (w) {
        const n = w.notes.find((x) => x.id === ev.noteId);
        if (n) {
          n.delivery = "delivered";
          n.atStep = ev.atStep ?? w.steps;
        }
      }
      break;
    case "note.failed":
      if (w) {
        const n = w.notes.find((x) => x.id === ev.noteId);
        if (n) n.delivery = "failed";
      }
      break;
    case "order.added":
    case "order.updated": {
      const o = ev.order;
      const prev = state.orders[o.id];
      state.orders[o.id] = {
        id: o.id,
        title: "",
        ownerId: null,
        ownerRole: "builder",
        allowedFiles: [],
        acceptance: "",
        status: "proposed", // proposed | approved | queued | working | review | shipped | sent_back | rejected
        ...prev,
        ...o,
      };
      if (!state.orderOrder.includes(o.id)) state.orderOrder.push(o.id);
      break;
    }
    case "batch.proposed":
      state.batch = { status: "proposed", orderIds: ev.orderIds ?? [] };
      addInbox(state, { id: ev.inboxId ?? "batch-" + (ev.orderIds ?? []).join("+"), kind: "batch", summary: ev.summary ?? "Lead proposes a work-order split", detail: "" }, t);
      break;
    case "batch.approved":
      state.batch.status = "approved";
      for (const i of state.inbox) if (i.kind === "batch" && i.open) resolveInbox(state, i.id, "approved", t);
      break;
    case "approval.requested": {
      const a = ev.approval;
      state.approvals[a.id] = {
        id: a.id,
        workerId: a.workerId,
        title: a.title ?? "",
        kind: a.kind ?? "other", // edit | execute | read | other
        detail: a.detail ?? "",
        diff: a.diff ?? "",
        options: a.options ?? [
          { id: "allow_once", kind: "allow_once", label: "Allow once" },
          { id: "allow_always", kind: "allow_always", label: "Always allow" },
          { id: "reject_once", kind: "reject_once", label: "Deny" },
        ],
        status: "open", // open | allowed | allowed_always | denied | cancelled
        requestedAt: t,
      };
      const aw = state.workers[a.workerId];
      if (aw) setStatus(state, aw, "waiting_approval", t);
      addInbox(state, { id: a.id, kind: "approval", workerId: a.workerId, summary: a.title ?? "Permission needed", detail: a.detail ?? "" }, t);
      break;
    }
    case "approval.resolved": {
      const a = state.approvals[ev.id];
      if (a) {
        a.status = ev.outcome;
        state.stats.approvals += 1;
        resolveInbox(state, ev.id, ev.outcome, t);
        const aw = state.workers[a.workerId];
        if (aw && aw.status === "waiting_approval") setStatus(state, aw, ev.nextStatus ?? "working", t);
      }
      break;
    }
    case "check.run":
      if (w) {
        w.output.push(`${ev.status === "pass" ? "PASS" : "FAIL"} ${ev.name}${ev.output ? ": " + ev.output : ""}`);
        if (w.output.length > MAX_OUTPUT_LINES) w.output.splice(0, w.output.length - MAX_OUTPUT_LINES);
        w.checks = [...(w.checks ?? []).filter((c) => c.name !== ev.name), { name: ev.name, status: ev.status, output: ev.output ?? "" }];
      }
      break;
    case "inbox.add":
      addInbox(state, ev.item, t);
      break;
    case "inbox.resolve":
      resolveInbox(state, ev.id, ev.resolution ?? "resolved", t);
      break;
    case "review.ready": {
      const r = ev.review;
      state.reviews[r.id] = {
        id: r.id,
        workerId: r.workerId,
        orderId: r.orderId ?? null,
        summary: r.summary ?? "",
        files: r.files ?? [],
        checks: r.checks ?? [],
        diff: r.diff ?? "",
        status: "open", // open | approved | sent_back | held
        mergeResult: null, // live mode: { ok, message }
        decidedAt: null,
      };
      addInbox(state, { id: r.id, kind: "review", workerId: r.workerId, summary: r.summary ?? "Work ready for review" }, t);
      if (r.orderId && state.orders[r.orderId]) state.orders[r.orderId].status = "review";
      break;
    }
    case "review.decided": {
      const r = state.reviews[ev.id];
      if (r) {
        r.status = ev.decision; // approved | sent_back | held
        r.decidedAt = t;
        if (ev.mergeResult) r.mergeResult = ev.mergeResult;
        if (ev.decision === "approved") state.stats.shipped += 1;
        if (ev.decision === "sent_back") state.stats.sentBack += 1;
        if (ev.decision !== "held") resolveInbox(state, ev.id, ev.decision, t);
        const o = r.orderId && state.orders[r.orderId];
        if (o) o.status = ev.decision === "approved" ? "shipped" : ev.decision === "sent_back" ? "sent_back" : "review";
      }
      break;
    }
    case "suggestion.added": {
      const s = ev.suggestion;
      state.suggestions[s.id] = { id: s.id, text: s.text, from: s.from ?? "audience", status: "open" };
      addInbox(state, { id: s.id, kind: "suggestion", summary: `Suggestion: ${s.text}` }, t);
      break;
    }
    case "suggestion.decided": {
      const s = state.suggestions[ev.id];
      if (s) {
        s.status = ev.decision; // accepted | rejected
        resolveInbox(state, ev.id, ev.decision, t);
      }
      break;
    }
    case "hold.all":
      state.holdAll = !!ev.value;
      break;
    case "metrics":
      // Observed process footprint. Values are estimates: summed RSS can overcount shared pages.
      state.metrics = { sampledAt: t, serverMb: ev.serverMb ?? null, copilotMb: ev.copilotMb ?? null, childrenMb: ev.childrenMb ?? null, sessions: ev.sessions ?? null };
      break;
    default:
      break; // unknown event types are kept in the timeline and otherwise ignored
  }
  return state;
}

export function rebuild(events, upTo = events.length) {
  const s = createInitialState();
  for (let i = 0; i < upTo; i++) reduce(s, events[i]);
  return s;
}

export function openInbox(state) {
  return state.inbox
    .filter((i) => i.open)
    .sort((a, b) => INBOX_PRIORITY[a.kind] - INBOX_PRIORITY[b.kind] || a.createdAt - b.createdAt);
}

export function workerElapsedMs(state, w) {
  return w.activeMs + (w.status === "working" && w.activeSince != null ? Math.max(0, state.now - w.activeSince) : 0);
}

export function activeWorkerCount(state) {
  return state.workerOrder.filter((id) => {
    const s = state.workers[id].status;
    return s === "working" || s === "waiting_approval" || s === "held" || s === "blocked";
  }).length;
}

/** One-line human description of an event, for tickers and replay scrubbers. Returns "" for noise events. */
export function describeEvent(ev, state) {
  const name = (id) => state?.workers?.[id]?.name ?? id;
  switch (ev.type) {
    case "worker.step": return `${name(ev.id)}: ${ev.text}`;
    case "worker.status": return `${name(ev.id)} is ${ev.status.replace("_", " ")}`;
    case "approval.requested": return `${name(ev.approval.workerId)} needs approval: ${ev.approval.title}`;
    case "approval.resolved": return `Approval ${ev.outcome}`;
    case "check.run": return `${name(ev.id)} check ${ev.name}: ${ev.status}`;
    case "note.added": return `You ${ev.note.kind} ${name(ev.id)}${ev.note.text ? ": " + ev.note.text : ""}`;
    case "note.delivered": return `${name(ev.id)} received your note (step ${ev.atStep})`;
    case "review.ready": return `${name(ev.review.workerId)}: ready for review`;
    case "review.decided": return `Review ${ev.decision.replace("_", " ")}`;
    case "batch.proposed": return "Lead proposed work orders";
    case "batch.approved": return "Work orders approved";
    case "hold.all": return ev.value ? "Hold all" : "Resume all";
    case "run.started": return ev.goal ? `Goal: ${ev.goal}` : "";
    case "suggestion.added": return `Suggestion: ${ev.suggestion.text}`;
    default: return "";
  }
}
