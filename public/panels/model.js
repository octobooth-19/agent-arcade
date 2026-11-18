// Pure view-model helpers: labels, status metadata and the rules that decide which controls are available.
// No DOM and no imports, so they are unit-tested in test/app/.

export const ROLE_ORDER = ["lead", "planner", "builder", "checker"];
export const ROLE_LABELS = { lead: "Foreman", planner: "Planner", builder: "Builder", checker: "Checker" };

// icon names are defined in icons.js; tone maps to a color class in app.css. Text always accompanies the icon.
export const STATUS_META = {
  idle: { label: "Idle", icon: "dot", tone: "soft" },
  queued: { label: "At the stage door", icon: "clock", tone: "soft" },
  working: { label: "Working", icon: "play", tone: "good" },
  waiting_approval: { label: "Needs your OK", icon: "question", tone: "warn" },
  held: { label: "Held", icon: "pause", tone: "accent" },
  blocked: { label: "Blocked", icon: "alert", tone: "bad" },
  done: { label: "Done", icon: "check", tone: "good" },
  failed: { label: "Failed", icon: "xcircle", tone: "bad" },
};

export const ORDER_STATUS_META = {
  proposed: { label: "Proposed", icon: "edit", tone: "accent" },
  approved: { label: "Approved", icon: "check", tone: "soft" },
  queued: { label: "At the stage door", icon: "clock", tone: "soft" },
  working: { label: "Working", icon: "play", tone: "good" },
  review: { label: "In review", icon: "eye", tone: "warn" },
  shipped: { label: "Shipped", icon: "check", tone: "good" },
  sent_back: { label: "Sent back", icon: "undo", tone: "warn" },
  rejected: { label: "Removed", icon: "x", tone: "soft" },
};

export const NOTE_KIND_LABELS = { hold: "Hold", nudge: "Nudge", redirect: "Redirect", takeover: "Take over", resume: "Resume", handback: "Hand back" };

export const NOTE_QUEUED_HINT = {
  hold: "Stops at the next safe point.",
  nudge: "Sent as the next prompt, when the current step ends.",
  redirect: "Sent right away; it pre-empts the current step.",
  takeover: "Parks the agent at the next safe point.",
  resume: "Re-prompts the agent.",
};

export const HOLD_COPY = "Stops at the next safe point. Resume re-prompts the agent; it is not a true pause.";

const NOTEABLE = ["working", "held", "blocked", "waiting_approval"];
const HOLDABLE = ["working", "waiting_approval"];

export function statusMeta(status) {
  return STATUS_META[status] ?? { label: String(status ?? "unknown").replace(/_/g, " "), icon: "dot", tone: "soft" };
}

export function orderStatusMeta(status) {
  return ORDER_STATUS_META[status] ?? { label: String(status ?? "unknown").replace(/_/g, " "), icon: "dot", tone: "soft" };
}

const statusWords = (w) => String(w.status ?? "unknown").replace(/_/g, " ");
const hasPending = (w, kind) => (w.notes ?? []).some((n) => n.kind === kind && n.delivery === "queued");

/**
 * Which interrupt controls apply to this worker right now. Each value is null when the control is available,
 * otherwise the plain-language reason it is not (shown as a tooltip and read out by screen readers).
 */
export function interruptRules(w) {
  if (!w) {
    const none = "Pick a worker first.";
    return { hold: none, resume: none, nudge: none, redirect: none, takeover: none, handBack: none };
  }
  if (w.role === "lead") {
    const why = "The Foreman only plans. Interrupts apply to agents once the work orders are approved.";
    return { hold: why, resume: why, nudge: why, redirect: why, takeover: why, handBack: why };
  }
  const words = statusWords(w);
  const pendingHold = hasPending(w, "hold");
  return {
    hold: !HOLDABLE.includes(w.status) ? `${w.name} is ${words}, so there is nothing to hold.` : pendingHold ? "A hold is already queued. It lands at the next safe point." : null,
    resume: w.status === "held" || w.status === "blocked" || pendingHold ? null : `${w.name} is not held.`,
    nudge: NOTEABLE.includes(w.status) ? null : `${w.name} is ${words} and cannot take a note.`,
    redirect: NOTEABLE.includes(w.status) ? null : `${w.name} is ${words} and cannot take a note.`,
    takeover: w.takeover ? "Already in your hands." : NOTEABLE.includes(w.status) ? null : `${w.name} is ${words} and cannot be taken over.`,
    handBack: w.takeover ? null : "This desk is not in your hands.",
  };
}

/** Receipt text exactly as the state says: queued, delivered at step N, or failed. */
export function receipt(note) {
  if (note.delivery === "delivered") return { label: note.atStep != null ? `Delivered at step ${note.atStep}` : "Delivered", tone: "good", icon: "check" };
  if (note.delivery === "failed") return { label: "Failed", tone: "bad", icon: "xcircle" };
  return { label: "Queued", tone: "warn", icon: "clock" };
}

export function pendingNotes(w) {
  return (w?.notes ?? []).filter((n) => n.delivery === "queued");
}

/** Orders the user can see (removed ones are hidden), in board order. */
export function visibleOrders(state) {
  return state.orderOrder.map((id) => state.orders[id]).filter((o) => o && o.status !== "rejected");
}

export function orderStats(state) {
  const orders = visibleOrders(state);
  return {
    total: orders.length,
    shipped: orders.filter((o) => o.status === "shipped").length,
    proposed: orders.filter((o) => o.status === "proposed"),
    removed: state.orderOrder.length - orders.length,
  };
}

/** One-line description of who owns an order. */
export function orderOwner(state, order) {
  const w = order.ownerId ? state.workers[order.ownerId] : null;
  const role = ROLE_LABELS[order.ownerRole] ?? order.ownerRole ?? "agent";
  return w ? { name: w.name, role: w.role, assigned: true } : { name: role, role: order.ownerRole ?? "builder", assigned: false };
}

export function workerList(state, { includeLead = true } = {}) {
  return state.workerOrder.map((id) => state.workers[id]).filter((w) => w && (includeLead || w.role !== "lead"));
}

/** Worker name for sentences; falls back to the raw id. */
export function nameOf(state, id) {
  return state.workers?.[id]?.name ?? id ?? "An agent";
}

const INBOX_KIND_LABELS = { approval: "Approval", failed_check: "Failed check", question: "Question", batch: "Work orders", review: "Review", suggestion: "Suggestion" };
export const inboxKindLabel = (kind) => INBOX_KIND_LABELS[kind] ?? "Item";

/** What an announcement for a new inbox item should say (null: not worth interrupting for). */
export function announcementFor(item, state) {
  const name = item.workerId ? nameOf(state, item.workerId) : "";
  switch (item.kind) {
    case "approval": return `${name || "An agent"} needs your approval`;
    case "failed_check": return `${name || "An agent"}'s check failed`;
    case "batch": return "The Foreman proposed work orders. Review and approve them in Orders.";
    case "review": return `${name || "An agent"}'s work is ready for review`;
    case "question": return "The Foreman has a question for you";
    default: return null;
  }
}

/** Which tab (narrow layout) an inbox item's main action lives in. */
export function inboxTarget(item) {
  if (item.kind === "batch" || item.kind === "question") return "orders";
  if (item.kind === "review") return "orders";
  return "inbox";
}

/** The inbox action the "a" key and the palette take for an item. Never approves something the user has not seen named. */
export function primaryAction(item, state) {
  switch (item.kind) {
    case "approval": {
      const a = state.approvals[item.refId];
      const opt = a?.options?.find((o) => o.kind === "allow_once");
      return opt ? { type: "approval", approval: a, option: opt, label: `Allow once: ${item.summary}` } : null;
    }
    case "batch": return { type: "jump", target: "orders", label: "Review work orders" };
    case "question": return { type: "jump", target: "orders", label: "Add work orders by hand" };
    case "review": return { type: "review", reviewId: item.refId, label: `Approve & merge: ${item.summary}` };
    case "suggestion": return { type: "suggestion", id: item.refId, label: `Accept suggestion: ${item.summary.replace(/^Suggestion: /, "")}` };
    default: return null;
  }
}

/** The "d" key: deny / reject. Only for items that have a clear no. */
export function denyAction(item, state) {
  if (item.kind === "approval") {
    const a = state.approvals[item.refId];
    const opt = a?.options?.find((o) => o.kind === "reject_once");
    return opt ? { type: "approval", approval: a, option: opt, label: `Deny: ${item.summary}` } : null;
  }
  if (item.kind === "suggestion") return { type: "suggestion-reject", id: item.refId, label: `Reject suggestion` };
  return null;
}
