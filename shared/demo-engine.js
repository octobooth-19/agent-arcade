// Scripted demo engine. Runs entirely in the browser (or Node) and speaks the same events and commands as the live bridge.
// Everything it shows is scripted: the UI must label this mode "DEMO, scripted" at all times.
import { createInitialState, reduce, activeWorkerCount } from "./state.js";

const WORKER_NAMES = ["Rivet", "Nova", "Dot", "Spark", "Pebble"];
const CONTEXT_SIZE = 136000;

export function createDemoEngine({ fixture, onEvent = () => {}, speed = 1, now = () => Date.now(), setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (h) => clearTimeout(h) }) {
  let state = createInitialState();
  let base = 0;
  let lastReal = now();
  let spd = speed;
  let noteSeq = 0;
  let suggestionSeq = 0;
  let orderSeq = 0;
  let spare = 0;
  let clockTimer = null;
  let stopped = false;
  let rt = {}; // per-worker runtime: { script, cursor, timer, queuedNotes, holdNoteId, pendingApproval }
  let leadTimer = null;
  const orderRegistry = {}; // scripted extras (steps, summary) that never enter the shared state

  const vt = () => Math.round(base + (now() - lastReal) * spd);
  const pace = fixture.pace ?? 1; // slows scripted steps so a person has time to interrupt
  const after = (ms, f) => setTimer(() => { if (!stopped) f(); }, Math.max(0, (ms * pace) / spd));

  function emit(ev) {
    const e = { ...ev, t: vt() };
    reduce(state, e);
    onEvent(state, e);
    return e;
  }

  const ok = (data) => ({ ok: true, ...(data ? { data } : {}) });
  const fail = (error) => ({ ok: false, error });

  function start() {
    stopped = false;
    emit({ type: "connection", state: "ready", source: "demo", message: "Scripted demo. No Copilot sessions are running." });
    emit({ type: "settings", maxConcurrent: fixture.maxConcurrent ?? 3 });
    emit({ type: "run.started", goal: null, source: "demo", project: fixture.project, maxConcurrent: fixture.maxConcurrent ?? 3 });
    emit({ type: "worker.added", worker: { id: "lead", role: "lead", name: fixture.lead.name, model: "demo", status: "idle", now: "Waiting for a goal" } });
    const tick = () => { if (stopped) return; emit({ type: "clock" }); clockTimer = setTimer(tick, 1000); };
    clockTimer = setTimer(tick, 1000);
  }

  function stop() {
    stopped = true;
    if (clockTimer) clearTimer(clockTimer);
    for (const r of Object.values(rt)) if (r.timer) clearTimer(r.timer);
    if (leadTimer) clearTimer(leadTimer);
  }

  function setSpeed(x) {
    base = vt();
    lastReal = now();
    spd = Math.max(0.25, Math.min(8, x));
  }

  // ---- worker script runner -------------------------------------------------------------

  function genericScript(order) {
    const file = order.allowedFiles?.[0] ?? "src/feature.js";
    return [
      { text: "Reading the relevant files", ms: 1800, usage: 11000 },
      { text: `Working on: ${order.title}`, ms: 2600, usage: 14000, plan: [{ text: order.title, status: "doing" }] },
      { text: `Editing ${file}`, ms: 2200, usage: 17000, file: { path: file, added: 9, removed: 2, diff: `--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,10 @@\n+// ${order.title}\n+export function apply() {\n+  return true;\n+}\n` } },
      { text: "Double-checking the change", ms: 1600, usage: 18000, plan: [{ text: order.title, status: "done" }] },
    ];
  }

  function launchWorker(stateOrder) {
    const order = orderRegistry[stateOrder.id] ?? stateOrder;
    const wid = order.ownerId;
    const script = order.script ?? genericScript(order);
    rt[wid] = { script, cursor: 0, timer: null, queuedNotes: [], holdNoteId: null, pendingApproval: null, reviewRound: 0 };
    emit({ type: "worker.status", id: wid, status: "working", now: "Starting", orderId: order.id });
    emit({ type: "order.updated", order: { id: order.id, status: "working" } });
    after(600, () => advance(wid));
  }

  function advance(wid) {
    const w = state.workers[wid];
    const r = rt[wid];
    if (!w || !r || w.status !== "working") return;
    const step = r.script[r.cursor];
    if (!step) return finishWorker(wid);
    emit({ type: "worker.step", id: wid, text: step.text });
    if (step.plan) emit({ type: "worker.plan", id: wid, plan: step.plan });
    if (step.usage) emit({ type: "worker.usage", id: wid, used: step.usage, size: CONTEXT_SIZE });
    if (step.file) emit({ type: "worker.file", id: wid, ...step.file });
    if (step.approval) {
      // Output of a gated action is only shown once the director allows it.
      const id = `ap-${wid}-${r.cursor}`;
      r.pendingApproval = id;
      emit({ type: "approval.requested", approval: { id, workerId: wid, ...step.approval } });
      return;
    }
    if (step.output) emit({ type: "worker.output", id: wid, lines: step.output });
    r.timer = after(step.ms ?? 1500, () => completeStep(wid));
  }

  function completeStep(wid) {
    const r = rt[wid];
    const step = r?.script[r.cursor];
    if (!step) return;
    if (step.check) {
      const c = step.check;
      emit({ type: "check.run", id: wid, name: c.name, status: c.status, output: c.output });
      if (c.status === "fail") {
        r.cursor += 1;
        r.blockedCheck = c;
        emit({ type: "worker.status", id: wid, status: "blocked", now: `Check failed: ${c.name}` });
        emit({ type: "inbox.add", item: { id: `chk-${wid}-${r.cursor}`, kind: "failed_check", workerId: wid, summary: `${state.workers[wid].name}: ${c.name} failed`, detail: c.output } });
        return;
      }
    }
    r.cursor += 1;
    boundary(wid);
  }

  function deliverQueuedNotes(wid) {
    const r = rt[wid];
    const w = state.workers[wid];
    const redirects = [];
    for (const n of r.queuedNotes.splice(0)) {
      emit({ type: "note.delivered", id: wid, noteId: n.id, atStep: w.steps });
      if (n.kind === "redirect" || n.kind === "nudge") redirects.push(n);
    }
    // Scripted acknowledgement: a short extra step per delivered note.
    for (const n of redirects.reverse()) {
      r.script.splice(r.cursor, 0, {
        text: n.kind === "redirect" ? `Redirected: ${n.text}` : `Noted: ${n.text}`,
        ms: 1600,
        output: [`> director ${n.kind}: ${n.text}`],
      });
    }
  }

  function boundary(wid) {
    const r = rt[wid];
    const w = state.workers[wid];
    if (!w || w.status !== "working") return;
    deliverQueuedNotes(wid);
    if (r.holdNoteId || state.holdAll || w.takeover) {
      if (r.holdNoteId) emit({ type: "note.delivered", id: wid, noteId: r.holdNoteId, atStep: w.steps });
      const msg = w.takeover ? "You are driving this desk" : `Held after step ${w.steps}`;
      r.holdNoteId = null;
      emit({ type: "worker.status", id: wid, status: "held", now: msg });
      return;
    }
    advance(wid);
  }

  function finishWorker(wid) {
    const w = state.workers[wid];
    const r = rt[wid];
    const order = state.orders[w.orderId];
    const extra = orderRegistry[w.orderId];
    emit({ type: "worker.status", id: wid, status: "done", now: "Finished. Ready for review." });
    r.reviewRound += 1;
    const rid = r.reviewRound === 1 ? `rv-${wid}` : `rv-${wid}-${r.reviewRound}`;
    emit({
      type: "review.ready",
      review: {
        id: rid,
        workerId: wid,
        orderId: order?.id ?? null,
        summary: extra?.summary ?? `${w.name} finished: ${order?.title ?? "work order"}`,
        files: w.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed })),
        checks: (w.checks ?? []).map((c) => ({ name: c.name, status: c.status })),
        diff: w.files.map((f) => f.diff).join("\n"),
      },
    });
    startQueued();
  }

  function depsSatisfied(order) {
    return (order.dependsOn ?? []).every((d) => state.orders[d]?.status === "shipped");
  }

  function queueReason(id, reason) {
    const w = state.workers[id];
    if (w.queuedReason !== reason) emit({ type: "worker.status", id, status: "queued", reason, now: reason });
  }

  function startQueued() {
    for (const id of state.workerOrder) {
      const w = state.workers[id];
      if (w.role === "lead" || w.status !== "queued") continue;
      const order = state.orders[w.orderId];
      if (!order) continue;
      if (state.holdAll) { queueReason(id, "Hold all is on"); continue; }
      if (!depsSatisfied(order)) {
        const dep = state.orders[(order.dependsOn ?? []).find((d) => state.orders[d]?.status !== "shipped")];
        queueReason(id, `Waiting for "${dep?.title ?? "another order"}" to be approved`);
        continue;
      }
      if (activeWorkerCount(state) >= state.maxConcurrent) {
        queueReason(id, `Stage door: ${state.maxConcurrent} agents at a time`);
        continue;
      }
      launchWorker(order);
    }
  }

  // ---- commands -------------------------------------------------------------------------

  function addNote(wid, kind, text) {
    const id = `n-${++noteSeq}`;
    emit({ type: "note.added", id: wid, note: { id, kind, text } });
    return id;
  }

  function resumeWorker(wid) {
    const r = rt[wid];
    const w = state.workers[wid];
    const nid = addNote(wid, "resume", "");
    emit({ type: "note.delivered", id: wid, noteId: nid, atStep: w.steps });
    r.holdNoteId = null;
    emit({ type: "worker.takeover", id: wid, value: false });
    emit({ type: "worker.status", id: wid, status: "working", now: "Resuming" });
    deliverQueuedNotes(wid);
    after(500, () => advance(wid));
  }

  function unblock(wid) {
    const r = rt[wid];
    const c = r.blockedCheck;
    r.blockedCheck = null;
    emit({ type: "worker.status", id: wid, status: "working", now: "Applying a fix" });
    for (const i of state.inbox) if (i.open && i.kind === "failed_check" && i.workerId === wid) emit({ type: "inbox.resolve", id: i.id, resolution: "retried" });
    r.script.splice(r.cursor, 0,
      { text: c.fixText ?? "Applying a fix", ms: 2200, output: c.fixOutput ?? ["> patched the failing case"], usage: 24000, file: c.fixFile },
      { text: c.retryText ?? `Re-running ${c.name}`, ms: 1800, check: { name: c.name, status: "pass", output: c.passOutput ?? "all passing" } },
    );
    after(400, () => advance(wid));
  }

  function command(name, p = {}) {
    if (stopped) return fail("Demo stopped");
    const wid = p.workerId;
    const w = wid ? state.workers[wid] : null;
    const r = wid ? rt[wid] : null;
    const needsWorker = ["hold", "resume", "nudge", "redirect", "takeOver", "handBack"];
    if (needsWorker.includes(name) && (!w || w.role === "lead")) return fail("Unknown worker");

    switch (name) {
      case "delegate": {
        if (!p.goal || !String(p.goal).trim()) return fail("Describe a goal first");
        if (state.goal) return fail("A run is already in progress. Reset it first.");
        emit({ type: "run.started", goal: String(p.goal).trim().slice(0, 300), source: "demo", project: fixture.project, maxConcurrent: state.maxConcurrent });
        emit({ type: "worker.status", id: "lead", status: "working", now: "Starting" });
        let i = 0;
        const steps = fixture.lead.script;
        const run = () => {
          const s = steps[i++];
          if (!s) return proposeBatch();
          emit({ type: "worker.step", id: "lead", text: s.text });
          if (s.usage) emit({ type: "worker.usage", id: "lead", used: s.usage, size: CONTEXT_SIZE });
          if (s.output) emit({ type: "worker.output", id: "lead", lines: s.output });
          leadTimer = after(s.ms ?? 1500, run);
        };
        after(400, run);
        return ok();
      }
      case "addOrder": {
        if (state.batch.status === "approved") return fail("The batch was already approved");
        const o = p.order ?? {};
        if (!o.title) return fail("An order needs a title");
        const id = `o-h${++orderSeq}`;
        emit({ type: "order.added", order: { id, title: o.title, ownerRole: o.ownerRole ?? "builder", allowedFiles: o.allowedFiles ?? [], acceptance: o.acceptance ?? "", status: "proposed" } });
        return ok({ id });
      }
      case "updateOrder": {
        const o = p.order;
        if (!o || !state.orders[o.id] || state.orders[o.id].status !== "proposed") return fail("Only proposed orders can be edited");
        emit({ type: "order.updated", order: o });
        return ok();
      }
      case "removeOrder": {
        if (!state.orders[p.id] || state.orders[p.id].status !== "proposed") return fail("Only proposed orders can be removed");
        emit({ type: "order.updated", order: { id: p.id, status: "rejected" } });
        return ok();
      }
      case "approveBatch": {
        if (state.batch.status !== "proposed") return fail("There is no proposed batch");
        const proposed = state.orderOrder.map((id) => state.orders[id]).filter((o) => o.status === "proposed");
        if (!proposed.length) return fail("No orders to start");
        emit({ type: "batch.approved" });
        emit({ type: "worker.status", id: "lead", status: "idle", now: "Handed out the work orders" });
        for (const o of proposed) {
          const fo = fixture.orders.find((x) => x.id === o.id);
          const ownerId = o.ownerId ?? `w-${o.id}`;
          const name = fo?.name ?? WORKER_NAMES[spare++ % WORKER_NAMES.length];
          emit({ type: "order.updated", order: { id: o.id, ownerId, status: "approved" } });
          emit({ type: "worker.added", worker: { id: ownerId, role: o.ownerRole, name, model: "demo", status: "queued", orderId: o.id, now: "Waiting at the stage door" } });
          const order = { ...state.orders[o.id], script: fo ? structuredClone(fo.script) : undefined, summary: fo?.summary };
          orderRegistry[o.id] = order;
        }
        startQueued();
        return ok();
      }
      case "hold": {
        if (!["working", "waiting_approval"].includes(w.status)) return fail(`${w.name} is ${w.status.replace("_", " ")}, so there is nothing to hold`);
        r.holdNoteId = addNote(wid, "hold", "");
        return ok();
      }
      case "resume": {
        if (w.status === "blocked") { const nid = addNote(wid, "resume", ""); emit({ type: "note.delivered", id: wid, noteId: nid, atStep: w.steps }); unblock(wid); return ok(); }
        if (w.status !== "held") {
          if (r.holdNoteId) { emit({ type: "note.failed", id: wid, noteId: r.holdNoteId }); r.holdNoteId = null; return ok(); }
          return fail(`${w.name} is not held`);
        }
        resumeWorker(wid);
        return ok();
      }
      case "nudge":
      case "redirect": {
        const text = String(p.text ?? "").trim();
        if (!text) return fail("Write a note first");
        if (!["working", "held", "blocked", "waiting_approval"].includes(w.status)) return fail(`${w.name} is ${w.status.replace("_", " ")} and cannot take a note`);
        const nid = addNote(wid, name, text);
        const note = { id: nid, kind: name, text };
        if (w.status === "blocked") {
          emit({ type: "note.delivered", id: wid, noteId: nid, atStep: w.steps });
          unblock(wid);
        } else {
          r.queuedNotes.push(note);
        }
        return ok();
      }
      case "takeOver": {
        if (w.takeover) return fail("Already in your hands");
        if (!["working", "held", "blocked", "waiting_approval"].includes(w.status)) return fail(`${w.name} is ${w.status.replace("_", " ")} and cannot be taken over`);
        emit({ type: "worker.takeover", id: wid, value: true });
        const nid = addNote(wid, "takeover", "");
        if (w.status === "held") { emit({ type: "note.delivered", id: wid, noteId: nid, atStep: w.steps }); emit({ type: "worker.status", id: wid, status: "held", now: "You are driving this desk" }); }
        else r.holdNoteId = nid;
        return ok();
      }
      case "handBack": {
        if (!w.takeover) return fail("This desk is not in your hands");
        if (w.status === "held") resumeWorker(wid);
        else emit({ type: "worker.takeover", id: wid, value: false });
        return ok();
      }
      case "holdAll": {
        emit({ type: "hold.all", value: true });
        for (const id of state.workerOrder) {
          const x = state.workers[id];
          if (x.role !== "lead" && ["working", "waiting_approval"].includes(x.status) && rt[id] && !rt[id].holdNoteId) rt[id].holdNoteId = addNote(id, "hold", "hold all");
        }
        return ok();
      }
      case "resumeAll": {
        emit({ type: "hold.all", value: false });
        for (const id of state.workerOrder) {
          const x = state.workers[id];
          if (x.status === "held" && !x.takeover) resumeWorker(id);
          else if (rt[id]?.holdNoteId) { emit({ type: "note.failed", id, noteId: rt[id].holdNoteId }); rt[id].holdNoteId = null; }
        }
        startQueued();
        return ok();
      }
      case "resolveApproval": {
        const a = state.approvals[p.approvalId];
        if (!a || a.status !== "open") return fail("That approval is not waiting");
        const opt = a.options.find((o) => o.id === p.optionId);
        if (!opt) return fail("Unknown option");
        const outcome = opt.kind === "allow_once" ? "allowed" : opt.kind === "allow_always" ? "allowed_always" : "denied";
        const wr = rt[a.workerId];
        emit({ type: "approval.resolved", id: a.id, outcome });
        wr.pendingApproval = null;
        const step = wr.script[wr.cursor];
        if (outcome === "denied") {
          emit({ type: "worker.step", id: a.workerId, text: `Skipped (denied): ${a.title}` });
          emit({ type: "worker.output", id: a.workerId, lines: ["> permission denied by director; skipping this action"] });
          wr.script[wr.cursor] = { text: "Skipped", ms: 900 };
        } else if (step.output) {
          emit({ type: "worker.output", id: a.workerId, lines: step.output });
        }
        wr.timer = after(outcome === "denied" ? 900 : (step.ms ?? 1500) * 0.6, () => completeStep(a.workerId));
        return ok();
      }
      case "approveReview":
      case "holdReview":
      case "sendBack": {
        const rv = state.reviews[p.reviewId];
        if (!rv || rv.status === "approved" || rv.status === "sent_back") return fail("That review is not open");
        if (name === "holdReview") { emit({ type: "review.decided", id: rv.id, decision: "held" }); return ok(); }
        if (name === "approveReview") {
          emit({ type: "review.decided", id: rv.id, decision: "approved", mergeResult: { ok: true, message: "Demo mode: nothing was merged or written to disk." } });
          if (state.orderOrder.every((id) => ["shipped", "rejected"].includes(state.orders[id].status)) && state.orderOrder.length) {
            emit({ type: "worker.status", id: "lead", status: "done", now: "Everything is shipped" });
          }
          startQueued();
          return ok();
        }
        const text = String(p.text ?? "").trim();
        if (!text) return fail("Say what should change");
        emit({ type: "review.decided", id: rv.id, decision: "sent_back" });
        const wk = rv.workerId;
        const nid = addNote(wk, "redirect", text);
        emit({ type: "note.delivered", id: wk, noteId: nid, atStep: state.workers[wk].steps });
        emit({ type: "worker.status", id: wk, status: "working", now: "Applying your feedback", orderId: rv.orderId });
        rt[wk].script.push({ text: `Applying feedback: ${text}`, ms: 2400, output: [`> feedback: ${text}`], usage: 30000 }, { text: "Re-checking the result", ms: 1500 });
        after(400, () => advance(wk));
        return ok();
      }
      case "suggest": {
        const text = String(p.text ?? "").trim();
        if (!text) return fail("Write a suggestion first");
        emit({ type: "suggestion.added", suggestion: { id: `sg-${++suggestionSeq}`, text: text.slice(0, 200), from: p.from ?? "audience" } });
        return ok();
      }
      case "resolveSuggestion": {
        const s = state.suggestions[p.id];
        if (!s || s.status !== "open") return fail("That suggestion is not open");
        if (p.decision === "reject") { emit({ type: "suggestion.decided", id: s.id, decision: "rejected" }); return ok(); }
        emit({ type: "suggestion.decided", id: s.id, decision: "accepted" });
        const id = `o-s${++orderSeq}`;
        emit({ type: "order.added", order: { id, title: s.text, ownerRole: "builder", allowedFiles: ["src/app.js"], acceptance: "Suggestion works as described", status: "proposed" } });
        if (state.batch.status === "approved") {
          const ownerId = `w-${id}`;
          const name = WORKER_NAMES[spare++ % WORKER_NAMES.length];
          emit({ type: "order.updated", order: { id, ownerId, status: "approved" } });
          emit({ type: "worker.added", worker: { id: ownerId, role: "builder", name, model: "demo", status: "queued", orderId: id, now: "Waiting at the stage door" } });
          orderRegistry[id] = { ...state.orders[id] };
          startQueued();
        }
        return ok({ orderId: id });
      }
      case "setMaxConcurrent": {
        const v = Number(p.value);
        if (!Number.isInteger(v) || v < 1 || v > 6) return fail("Choose 1 to 6");
        emit({ type: "settings", maxConcurrent: v });
        startQueued();
        return ok();
      }
      case "openInVSCode":
        return fail("Demo mode has no project on disk");
      case "reset": {
        stop();
        state = createInitialState();
        rt = {};
        for (const k of Object.keys(orderRegistry)) delete orderRegistry[k];
        noteSeq = suggestionSeq = orderSeq = spare = 0;
        base = 0;
        lastReal = now();
        emit({ type: "snapshot", state });
        start();
        return ok();
      }
      default:
        return fail(`Unknown command: ${name}`);
    }
  }

  function proposeBatch() {
    const ids = [];
    for (const o of fixture.orders) {
      ids.push(o.id);
      emit({ type: "order.added", order: { id: o.id, title: o.title, ownerRole: o.ownerRole, allowedFiles: o.allowedFiles, acceptance: o.acceptance, prompt: o.prompt ?? "", dependsOn: o.dependsOn ?? [], status: "proposed" } });
    }
    emit({ type: "worker.status", id: "lead", status: "idle", now: "Waiting for your approval" });
    emit({ type: "batch.proposed", orderIds: ids, summary: `Foreman proposes ${ids.length} work orders` });
  }

  return { start, stop, command, setSpeed, get state() { return state; } };
}
