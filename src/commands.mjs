// Commands (browser -> bridge). Mixed into Orchestrator.prototype; every method is `cmd_<name>(payload)` and returns
// the `data` of the response or throws UserError (-> { ok: false, error }). Interrupt semantics are deliberately honest:
// a hold is an ACP `session/cancel` (not a pause), a nudge waits for the turn to end, a redirect pre-empts.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ROLES_FOR_ORDERS, findCycle } from "./order-parser.mjs";
import { clip, handBackPrompt, nudgePrompt, redirectPrompt, sendBackPrompt, suggestionOrder } from "./prompts.mjs";
import { newRunId } from "./run-store.mjs";
import { ensureExclude, mergeBranch, removeWorktree, unmergedWorktrees } from "./worktree.mjs";

export class UserError extends Error {}
const bad = (msg) => {
  throw new UserError(msg);
};

export const COMMAND_NAMES = Object.freeze([
  "delegate",
  "addOrder",
  "updateOrder",
  "removeOrder",
  "approveBatch",
  "hold",
  "resume",
  "nudge",
  "redirect",
  "takeOver",
  "handBack",
  "holdAll",
  "resumeAll",
  "resolveApproval",
  "approveReview",
  "sendBack",
  "holdReview",
  "suggest",
  "resolveSuggestion",
  "setMaxConcurrent",
  "openInVSCode",
  "reset",
]);

const MAX_TEXT = 8000;
const label = (w) => w?.name ?? "That agent";
const pretty = (status) => String(status).replace("_", " ");
const isRunning = (w) => w.status === "working" || w.status === "waiting_approval";

const text = (v, what, max = MAX_TEXT) => {
  const s = typeof v === "string" ? v.replace(/\u0000/g, "").trim() : "";
  if (!s) bad(what);
  if (s.length > max) bad(`That is too long (limit ${max} characters)`);
  return s;
};

export const commandMethods = {
  async command(name, payload = {}) {
    if (typeof name !== "string" || !COMMAND_NAMES.includes(name)) return { ok: false, error: `Unknown command: ${clip(String(name), 40)}`, unknown: true };
    if (this.closing) return { ok: false, error: "Agent Arcade is shutting down" };
    try {
      const data = await this[`cmd_${name}`](payload && typeof payload === "object" ? payload : {});
      return data === undefined ? { ok: true } : { ok: true, data };
    } catch (err) {
      if (err instanceof UserError) return { ok: false, error: err.message };
      this.log(`command ${name} failed: ${err?.stack ?? err}`);
      return { ok: false, error: `Something went wrong: ${clip(err?.message ?? String(err), 200)}` };
    }
  },

  // ---- lookups ---------------------------------------------------------------------------------

  _rt(workerId) {
    const rt = typeof workerId === "string" ? this.rts.get(workerId) : null;
    if (!rt || rt.dead) bad("Unknown worker");
    return rt;
  },

  _review(reviewId) {
    if (typeof reviewId !== "string" || !Object.hasOwn(this.state.reviews, reviewId)) bad("That review is not open");
    return this.state.reviews[reviewId];
  },

  _requeue(rt) {
    rt.slot = false;
    this._emit({ type: "worker.status", id: rt.id, status: "queued", now: "Waiting at the stage door", reason: null });
    this._schedule();
  },

  // ---- starting a run --------------------------------------------------------------------------

  async cmd_delegate({ goal }) {
    const goalText = text(goal, "Describe the goal first");
    if (this.state.goal || this.delegating) bad("A run is already in progress. Reset it first.");
    this.delegating = true;
    try {
      if (this.connecting) await this.connecting;
      if (!this.copilotInfo.found) bad("The `copilot` command was not found. Install GitHub Copilot CLI and sign in first.");
      if (!(await this._ensureAcp())) bad(this.connection.message || "Copilot is not connected");
      if (this.git.isGit) await ensureExclude(this.git.root).catch(() => {});
      this.runId = newRunId();
      this._resetState();
      this._emit({ type: "run.started", goal: clip(goalText, 300), source: "live", project: this.state.project, maxConcurrent: this.maxConcurrent });
    } finally {
      this.delegating = false;
    }
    this.goalFull = goalText;
    void this._runLead(goalText);
    return { runId: this.runId };
  },

  // ---- orders ----------------------------------------------------------------------------------

  _cleanOrder(o, existing = null) {
    if (!o || typeof o !== "object") bad("Missing order");
    const out = {};
    if (!existing || o.title !== undefined) {
      const title = typeof o.title === "string" ? o.title.replace(/\s+/g, " ").trim() : "";
      if (!title) bad("An order needs a title");
      out.title = clip(title, 200);
    }
    if (!existing || o.ownerRole !== undefined) {
      const role = o.ownerRole ?? "builder";
      if (!ROLES_FOR_ORDERS.includes(role)) bad(`Role must be one of: ${ROLES_FOR_ORDERS.join(", ")}`);
      out.ownerRole = role;
    }
    if (!existing || o.allowedFiles !== undefined) {
      const list = o.allowedFiles ?? [];
      if (!Array.isArray(list) || list.length > 20) bad("Allowed files must be a list of at most 20 entries");
      out.allowedFiles = list.map((f) => (typeof f === "string" ? f.replace(/[\u0000-\u001f]/g, "").trim() : "")).filter(Boolean).map((f) => clip(f, 200));
    }
    if (!existing || o.acceptance !== undefined) {
      if (o.acceptance != null && typeof o.acceptance !== "string") bad("Acceptance must be text");
      out.acceptance = clip((o.acceptance ?? "").trim(), 1000);
    }
    if (!existing || o.prompt !== undefined) {
      if (o.prompt != null && typeof o.prompt !== "string") bad("Instructions must be text");
      out.prompt = clip((o.prompt ?? "").trim(), MAX_TEXT) || out.title || existing?.title;
    }
    if (!existing || o.dependsOn !== undefined) {
      const deps = o.dependsOn ?? [];
      if (!Array.isArray(deps) || deps.length > 20) bad("Dependencies must be a list of order ids");
      const ids = [];
      for (const d of deps) {
        if (typeof d !== "string" || !Object.hasOwn(this.state.orders, d) || this.state.orders[d].status === "rejected" || d === existing?.id) bad(`Unknown dependency: ${clip(String(d), 40)}`);
        if (!ids.includes(d)) ids.push(d);
      }
      out.dependsOn = ids;
    }
    return out;
  },

  _assertNoCycle(id, deps) {
    const graph = new Map();
    for (const oid of this.state.orderOrder) {
      const o = this.state.orders[oid];
      if (o.status !== "rejected") graph.set(oid, o.dependsOn ?? []);
    }
    graph.set(id, deps);
    if (findCycle(graph)) bad("Those dependencies would form a loop");
  },

  cmd_addOrder({ order }) {
    if (!this.state.goal) bad("Delegate a goal first, then add orders");
    if (this.state.orderOrder.length >= 40) bad("That is a lot of orders (limit 40)");
    const clean = this._cleanOrder(order);
    const id = `o${++this.seq.order}`;
    this._emit({ type: "order.added", order: { id, ownerId: null, status: "proposed", ...clean } });
    this._reproposeBatch();
    return { id };
  },

  cmd_updateOrder({ order }) {
    const id = order?.id;
    if (typeof id !== "string" || !Object.hasOwn(this.state.orders, id)) bad("Unknown order");
    const existing = this.state.orders[id];
    if (existing.status !== "proposed") bad("Only orders that are still proposed can be edited");
    const clean = this._cleanOrder(order, existing);
    if (clean.dependsOn) this._assertNoCycle(id, clean.dependsOn);
    this._emit({ type: "order.updated", order: { id, ...clean } });
  },

  cmd_removeOrder({ id }) {
    if (typeof id !== "string" || !Object.hasOwn(this.state.orders, id)) bad("Unknown order");
    if (this.state.orders[id].status !== "proposed") bad("Only orders that are still proposed can be removed");
    this._emit({ type: "order.updated", order: { id, status: "rejected" } });
    for (const oid of this.state.orderOrder) {
      const o = this.state.orders[oid];
      if (o.dependsOn?.includes(id)) this._emit({ type: "order.updated", order: { id: oid, dependsOn: o.dependsOn.filter((d) => d !== id) } });
    }
    if (this.state.batch.status === "proposed") this._reproposeBatch();
  },

  async cmd_approveBatch() {
    if (this.state.batch.status !== "proposed") bad("There is no batch waiting for approval");
    const ids = this.state.orderOrder.filter((id) => this.state.orders[id].status === "proposed");
    if (!ids.length) bad("There are no work orders to approve. Add one first.");
    this._assertNoCycle(ids[0], this.state.orders[ids[0]].dependsOn ?? []);
    if (!(await this._ensureAcp())) bad(this.connection.message || "Copilot is not connected");
    if (this.state.batch.status !== "proposed") bad("There is no batch waiting for approval");
    this._emit({ type: "batch.approved" });
    if (this.state.workers.lead?.status !== "working") this._emit({ type: "worker.status", id: "lead", status: "idle", now: "Handed out the work orders" });
    for (const id of ids) {
      const o = this.state.orders[id];
      const n = ++this.names[o.ownerRole];
      const workerId = `w${++this.seq.worker}`;
      this._emit({ type: "order.updated", order: { id, ownerId: workerId, status: "approved" } });
      this._emit({
        type: "worker.added",
        worker: {
          id: workerId,
          role: o.ownerRole,
          name: `${o.ownerRole[0].toUpperCase()}${o.ownerRole.slice(1)} ${n}`,
          model: this.model ?? this.defaultModel,
          status: "queued",
          orderId: id,
          now: "Waiting at the stage door",
        },
      });
      this.rts.set(workerId, this._makeRuntime({ id: workerId, role: o.ownerRole, orderId: id }));
    }
    this._schedule();
    return { started: ids.length };
  },

  // ---- interrupts ------------------------------------------------------------------------------

  /** Hold / take over a worker that has a turn in flight: a cancel the agent honors at its next safe point. */
  _requestHold(rt, kind, { fromAll = false, noteText = "" } = {}) {
    const noteId = this._note(rt, kind, noteText);
    rt.pendingHold = { kind, noteId, fromAll };
    this._cancelApprovals(rt);
    if (rt.turn && rt.sessionId && this.acp && !this.acp.exited) this.acp.notify("session/cancel", { sessionId: rt.sessionId });
    this._status(rt, "working", "Stopping at the next safe point");
    this._say(rt, `${kind === "takeover" ? "Take over" : "Hold"} requested: Copilot was asked to cancel the current turn. It stops at its next safe point, which is not instant.`);
    return noteId;
  },

  /** Held immediately: nothing is running (queued or blocked). */
  _holdNow(rt, kind, noteText = "") {
    const noteId = this._note(rt, kind, noteText);
    this._deliverNote(rt, noteId);
    if (kind === "takeover") {
      this._emit({ type: "worker.takeover", id: rt.id, value: true });
      this._status(rt, "held", "You are driving this desk");
    } else {
      this._status(rt, "held", "Held");
    }
    return noteId;
  },

  cmd_hold({ workerId }) {
    const rt = this._rt(workerId);
    const w = this.state.workers[rt.id];
    if (rt.pendingHold) bad(`${label(w)} is already stopping`);
    if (w.status === "held") bad(`${label(w)} is already held`);
    if (rt.finishing) bad(`${label(w)} is collecting its changes and running checks, so there is nothing to hold`);
    if (w.status === "queued" || w.status === "blocked") {
      const noteId = this._holdNow(rt, "hold");
      return { noteId, delivery: "delivered" };
    }
    if (isRunning(w) && (rt.turn || rt.starting)) return { noteId: this._requestHold(rt, "hold"), delivery: "queued" };
    bad(`${label(w)} is ${pretty(w.status)}, so there is nothing to hold`);
  },

  cmd_takeOver({ workerId }) {
    const rt = this._rt(workerId);
    const w = this.state.workers[rt.id];
    if (w.takeover) bad("Already in your hands");
    if (rt.pendingHold) bad(`${label(w)} is already stopping`);
    if (rt.finishing) bad(`${label(w)} is collecting its changes, so it cannot be taken over right now`);
    if (w.status === "held") {
      const noteId = this._holdNow(rt, "takeover");
      return { noteId, delivery: "delivered" };
    }
    if (w.status === "queued" || w.status === "blocked") {
      const noteId = this._holdNow(rt, "takeover");
      return { noteId, delivery: "delivered" };
    }
    if (isRunning(w) && (rt.turn || rt.starting)) return { noteId: this._requestHold(rt, "takeover"), delivery: "queued" };
    bad(`${label(w)} is ${pretty(w.status)} and cannot be taken over`);
  },

  /** Held -> running again with a fresh "continue" prompt (or a re-queue when it holds no stage-door slot). */
  _resumeHeld(rt) {
    const w = this.state.workers[rt.id];
    if (w.takeover) return;
    const noteId = this._note(rt, "resume", "");
    this._deliverNote(rt, noteId);
    if (!rt.sessionId || !rt.slot) return this._requeue(rt);
    if (!this.acpReady || rt.acp !== this.acp) return this._failWorker(rt, "The Copilot process restarted, so this agent's session is gone.");
    this._status(rt, "working", "Resuming");
    this._continueWorker(rt);
  },

  cmd_resume({ workerId }) {
    const rt = this._rt(workerId);
    const w = this.state.workers[rt.id];
    if (w.takeover) bad("This desk is in your hands. Use Hand back instead.");
    if (rt.pendingHold) bad(`${label(w)} is still stopping. Resume it once it shows as held.`);
    if (w.status === "held") {
      this._resumeHeld(rt);
      return;
    }
    if (w.status === "blocked") {
      const noteId = this._note(rt, "resume", "");
      this._deliverNote(rt, noteId);
      for (const item of this.state.inbox) if (item.open && item.workerId === rt.id && (item.kind === "failed_check" || item.kind === "question")) this._emit({ type: "inbox.resolve", id: item.id, resolution: "retried" });
      if (!this.acpReady || rt.acp !== this.acp) return this._failWorker(rt, "The Copilot process restarted, so this agent's session is gone.");
      this._status(rt, "working", "Resuming");
      this._continueWorker(rt);
      return;
    }
    if (w.status === "failed") {
      if (rt.sessionId && rt.acp !== this.acp) bad("The Copilot process restarted, so this agent's session is gone. Reset the run to start over.");
      for (const item of this.state.inbox) if (item.open && item.workerId === rt.id && item.kind === "question") this._emit({ type: "inbox.resolve", id: item.id, resolution: "retried" });
      const noteId = this._note(rt, "resume", "");
      this._deliverNote(rt, noteId);
      this._requeue(rt);
      return;
    }
    bad(`${label(w)} is ${pretty(w.status)}, so there is nothing to resume`);
  },

  cmd_nudge({ workerId, text: raw }) {
    const rt = this._rt(workerId);
    const w = this.state.workers[rt.id];
    const body = text(raw, "Write a note first");
    if (rt.finishing) bad(`${label(w)} is collecting its changes. Wait for the review, then use Send back.`);
    if (!["working", "waiting_approval", "held", "blocked", "queued"].includes(w.status)) bad(`${label(w)} is ${pretty(w.status)} and cannot take a note`);
    const noteId = this._note(rt, "nudge", body);
    rt.pendingNotes.push({ id: noteId, kind: "nudge", text: body });
    if (w.status === "blocked") {
      this._status(rt, "working", "Applying your note");
      this._continueWorker(rt);
      return { noteId, delivery: "delivered" };
    }
    if (isRunning(w)) this._say(rt, "Note queued: it is sent as the next prompt when the current turn ends. It does not interrupt.");
    else this._say(rt, "Note saved: it goes out with the next prompt this agent receives.");
    return { noteId, delivery: "queued" };
  },

  cmd_redirect({ workerId, text: raw }) {
    const rt = this._rt(workerId);
    const w = this.state.workers[rt.id];
    const body = text(raw, "Write a note first");
    if (w.takeover) bad("This desk is in your hands. Hand back first.");
    if (rt.finishing) bad(`${label(w)} is collecting its changes. Wait for the review, then use Send back.`);
    if (!["working", "waiting_approval", "held", "blocked", "queued"].includes(w.status)) bad(`${label(w)} is ${pretty(w.status)} and cannot take a note`);

    if (isRunning(w) && rt.turn) {
      const noteId = this._note(rt, "redirect", body);
      if (rt.pendingHold) this._failNote(rt, rt.takePendingHold().noteId, "The redirect replaced the pending stop.");
      if (rt.redirectNote) this._confirmRedirect(rt);
      this._cancelApprovals(rt);
      rt.redirectNote = noteId;
      this._status(rt, "working", "Redirected");
      this._say(rt, "Redirect sent now. A new prompt pre-empts the current turn; the previous turn ends as cancelled.");
      this._sendPrompt(rt, redirectPrompt(body), []);
      return { noteId, delivery: "queued" };
    }
    const noteId = this._note(rt, "redirect", body);
    if ((w.status === "held" || w.status === "blocked") && rt.sessionId && rt.slot) {
      if (!this.acpReady || rt.acp !== this.acp) {
        this._failNote(rt, noteId, "The Copilot process restarted, so this agent's session is gone.");
        bad("The Copilot process restarted, so this agent's session is gone.");
      }
      rt.blockedDetail = "";
      this._status(rt, "working", "Redirected");
      this._sendPrompt(rt, redirectPrompt(body), [noteId]);
      return { noteId, delivery: "delivered" };
    }
    rt.pendingNotes.push({ id: noteId, kind: "redirect", text: body });
    this._say(rt, "Redirect saved: it goes out with this agent's first prompt.");
    return { noteId, delivery: "queued" };
  },

  cmd_handBack({ workerId }) {
    const rt = this._rt(workerId);
    const w = this.state.workers[rt.id];
    if (!w.takeover) bad("This desk is not in your hands");
    if (rt.turn || rt.pendingHold) bad(`${label(w)} is still stopping`);
    this._emit({ type: "worker.takeover", id: rt.id, value: false });
    const noteId = this._note(rt, "resume", "");
    this._deliverNote(rt, noteId);
    if (w.status !== "held") return;
    if (!rt.sessionId || !rt.slot) return this._requeue(rt);
    if (!this.acpReady || rt.acp !== this.acp) return this._failWorker(rt, "The Copilot process restarted, so this agent's session is gone.");
    rt.nextPrompt = handBackPrompt();
    this._status(rt, "working", "Handed back");
    this._continueWorker(rt);
  },

  cmd_holdAll() {
    this._emit({ type: "hold.all", value: true });
    for (const rt of this.rts.values()) {
      const w = this.state.workers[rt.id];
      if (rt.dead || rt.pendingHold || rt.finishing || !isRunning(w) || !(rt.turn || rt.starting)) continue;
      this._requestHold(rt, "hold", { fromAll: true, noteText: "hold all" });
    }
    this._schedule();
  },

  cmd_resumeAll() {
    this._emit({ type: "hold.all", value: false });
    for (const rt of this.rts.values()) {
      const w = this.state.workers[rt.id];
      if (rt.dead || w.takeover) continue;
      if (w.status === "held" && !rt.pendingHold) this._resumeHeld(rt);
    }
    this._schedule();
  },

  // ---- approvals -------------------------------------------------------------------------------

  cmd_resolveApproval({ approvalId, optionId }) {
    if (typeof approvalId !== "string" || typeof optionId !== "string") bad("Missing approval or option");
    const pending = this.broker.get(approvalId);
    const shown = Object.hasOwn(this.state.approvals, approvalId) ? this.state.approvals[approvalId] : null;
    if (!pending || !shown || shown.status !== "open") bad("That approval is not waiting");
    const res = this.broker.resolve(approvalId, optionId);
    if (!res) bad("Unknown option");
    const kind = res.option.kind;
    const outcome = kind === "allow_once" ? "allowed" : kind === "allow_always" ? "allowed_always" : "denied";
    const more = this.broker.list().some((p) => p.workerId === pending.workerId);
    this._emit({ type: "approval.resolved", id: approvalId, outcome, nextStatus: more ? "waiting_approval" : "working" });
  },

  // ---- reviews ---------------------------------------------------------------------------------

  async cmd_approveReview({ reviewId }) {
    const rv = this._review(reviewId);
    if (rv.status !== "open" && rv.status !== "held") bad("That review is not open");
    if (this.merging.has(reviewId)) bad("That review is already being merged");
    const rt = this.rts.get(rv.workerId);
    const order = this.state.orders[rv.orderId];
    const gen = this.gen;
    this.merging.add(reviewId);
    try {
      if (!rt || !rt.wt) {
        this._emit({ type: "review.decided", id: reviewId, decision: "approved", mergeResult: { ok: true, message: rt ? "Nothing to merge: this agent made no separate branch." : "Nothing to merge." } });
        if (rt) {
          this._closeSession(rt);
          rt.slot = false;
        }
        this._saveRun();
        this._schedule();
        return { merged: false };
      }
      const wName = this.state.workers[rt.id].name;
      const result = await this._locked(() =>
        mergeBranch({ root: this.git.root, branch: rt.wt.branch, message: `Merge ${order?.title ?? rt.wt.branch} (Agent Arcade ${wName})`, env: this.gitEnv }),
      );
      if (gen !== this.gen) return { merged: result.ok };
      if (!result.ok) {
        this._emit({ type: "review.decided", id: reviewId, decision: "held", mergeResult: { ok: false, message: result.message } });
        bad(result.message);
      }
      this._emit({ type: "review.decided", id: reviewId, decision: "approved", mergeResult: { ok: true, message: result.message } });
      const wt = rt.wt;
      const rm = await this._locked(() => removeWorktree({ root: this.git.root, path: wt.path, branch: wt.branch }));
      if (gen === this.gen) {
        if (rm.ok) this._emit({ type: "worker.session", id: rt.id, worktree: null });
        else this._say(rt, rm.message);
        this._closeSession(rt);
        this._status(rt, "done", "Merged");
        this._saveRun();
        this._schedule();
      }
      return { merged: true, sha: result.sha ?? null, message: result.message };
    } finally {
      this.merging.delete(reviewId);
    }
  },

  async cmd_sendBack({ reviewId, text: raw }) {
    const rv = this._review(reviewId);
    if (rv.status !== "open" && rv.status !== "held") bad("That review is not open");
    const body = text(raw, "Write some feedback first");
    const rt = this.rts.get(rv.workerId);
    if (!rt || rt.dead) bad("That agent is gone");
    if (!rt.sessionId || rt.acp !== this.acp || !this.acpReady) bad("This agent's Copilot session is gone (Copilot restarted). Add a new order instead.");
    this._emit({ type: "review.decided", id: reviewId, decision: "sent_back" });
    const noteId = this._note(rt, "redirect", body);
    rt.nextPrompt = sendBackPrompt(body);
    rt.launchNotes.push(noteId);
    rt.blockedDetail = "";
    rt.warnedFiles.clear();
    this._saveRun();
    this._requeue(rt);
    return { noteId };
  },

  cmd_holdReview({ reviewId }) {
    const rv = this._review(reviewId);
    if (rv.status !== "open" && rv.status !== "held") bad("That review is not open");
    this._emit({ type: "review.decided", id: reviewId, decision: "held" });
  },

  // ---- suggestions -----------------------------------------------------------------------------

  cmd_suggest({ text: raw, from }) {
    const body = text(raw, "Write a suggestion first", 200);
    const open = Object.values(this.state.suggestions).filter((s) => s.status === "open").length;
    if (open >= 50) bad("The suggestion box is full. Decide on some first.");
    const who = typeof from === "string" && from.trim() ? clip(from.replace(/[\u0000-\u001f]/g, " ").trim(), 40) : "audience";
    const id = `s${++this.seq.suggestion}`;
    this._emit({ type: "suggestion.added", suggestion: { id, text: body, from: who } });
    return { id };
  },

  cmd_resolveSuggestion({ id, decision }) {
    if (typeof id !== "string" || !Object.hasOwn(this.state.suggestions, id)) bad("Unknown suggestion");
    if (this.state.suggestions[id].status !== "open") bad("That suggestion was already decided");
    if (decision !== "accept" && decision !== "reject") bad("Decision must be accept or reject");
    if (decision === "reject") {
      this._emit({ type: "suggestion.decided", id, decision: "rejected" });
      return;
    }
    if (!this.state.goal) bad("Start a run before accepting a suggestion");
    const orderId = `o${++this.seq.order}`;
    this._emit({ type: "suggestion.decided", id, decision: "accepted" });
    this._emit({ type: "order.added", order: { id: orderId, ownerId: null, status: "proposed", ...suggestionOrder(this.state.suggestions[id].text) } });
    this._reproposeBatch("A suggestion became a proposed work order");
    return { orderId };
  },

  // ---- settings and tools ----------------------------------------------------------------------

  cmd_setMaxConcurrent({ value }) {
    if (!Number.isInteger(value) || value < 1 || value > 6) bad("Choose a whole number from 1 to 6");
    if (!this.canWorktree && value > 1) bad("This project is not a git repository with commits, so agents run one at a time.");
    this.requestedMax = value;
    this.maxConcurrent = value;
    this._emit({ type: "settings", maxConcurrent: value });
    this._schedule();
  },

  async cmd_openInVSCode({ path: p, line, workerId }) {
    if (typeof p !== "string" || !p || p.length > 1000 || p.includes("\u0000")) bad("Missing file path");
    let base = this.projectDir;
    if (workerId !== undefined) {
      const rt = this._rt(workerId);
      base = rt.cwd;
    }
    const abs = path.resolve(base, p);
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      bad("That file does not exist");
    }
    const rootReal = fs.realpathSync(this.projectDir);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) bad("That path is outside the project");
    const n = line === undefined || line === null ? null : line;
    if (n !== null && (!Number.isInteger(n) || n < 1 || n > 1e7)) bad("Line must be a positive whole number");
    const isDir = fs.statSync(real).isDirectory();
    const args = isDir || n === null ? [real] : ["-g", `${real}:${n}`];
    await new Promise((resolve, reject) => {
      const child = spawn(this.codeBin, args, { detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", (err) =>
        reject(new UserError(err.code === "ENOENT" ? "The `code` command was not found. In VS Code, run \"Shell Command: Install 'code' command in PATH\"." : `Could not start VS Code: ${err.message}`)),
      );
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  },

  async cmd_reset() {
    if (this.merging.size) bad("A merge is in progress. Try again in a moment.");
    const turns = this._cancelEverything();
    for (const rt of this._allRts()) {
      rt.dead = true;
      rt.translator.flush();
    }
    if (turns.length) await Promise.race([Promise.allSettled(turns), sleep(1000)]);
    this._saveRun();
    for (const rt of this._allRts()) this._closeSession(rt);
    this.rts.clear();
    this.bySession.clear();
    this.leadRt = null;
    this.runId = null;
    this.delegating = false;
    let leftover = [];
    if (this.git.isGit) leftover = await unmergedWorktrees({ root: this.git.root, projectDir: this.projectDir }).catch(() => []);
    this.leftoverNote = leftover.length
      ? `${leftover.length} unmerged worktree${leftover.length === 1 ? "" : "s"} left under .arcade/worktrees (${leftover.map((l) => l.branch).join(", ")}); nothing was deleted.`
      : "";
    if (this.copilotInfo.found && (!this.acpReady || this.acp?.exited)) await this._ensureAcp().catch(() => false);
    this._resetState();
    return { unmerged: leftover };
  },
};
