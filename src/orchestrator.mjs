// The orchestrator owns the authoritative run state. Every change goes through emit() -> shared/state.js reduce(),
// is broadcast to listeners (SSE clients) and recorded for persistence. It talks to ONE `copilot --acp --stdio`
// process that hosts a session per agent (the Lead and one per work order).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AcpClient, rpcError } from "./acp-client.mjs";
import { runCheck } from "./checks.mjs";
import { commandMethods, COMMAND_NAMES } from "./commands.mjs";
import { detectCopilot } from "./health.mjs";
import { sampleMetrics } from "./metrics.mjs";
import { parseOrders, resolveDependsOn, findCycle } from "./order-parser.mjs";
import { CANCELLED, PermissionBroker } from "./permissions.mjs";
import {
  VERSION,
  blockedContinuePrompt,
  clip,
  continuePrompt,
  isAuthError,
  leadPrompt,
  mapKind,
  matchesAllowed,
  notesBlock,
  nudgePrompt,
  workerPrompt,
} from "./prompts.mjs";
import { RunStore, newRunId } from "./run-store.mjs";
import { createInitialState, reduce } from "./state-loader.mjs";
import { UpdateTranslator } from "./updates.mjs";
import { commitAll, createWorktree, diffAgainst, ensureExclude, git, gitInfo, gitVersion, identityEnv, unmergedWorktrees } from "./worktree.mjs";

export { COMMAND_NAMES, VERSION };

const MAX_EVENTS = 40000;
const ROLE_NAMES = { builder: "Builder", planner: "Planner", checker: "Checker" };
const tail = (s, n) => (s.length > n ? "…" + s.slice(-n) : s);

export class Orchestrator extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.projectDir absolute, real path
   * @param {string|null} [o.model]
   * @param {string|null} [o.check]  shell command run in a worker's worktree after a builder finishes
   * @param {number} [o.maxConcurrent]
   * @param {{command?: string, prefixArgs?: string[], acpArgs?: string[]}} [o.copilot]
   * @param {number} [o.metricsIntervalMs] 0 disables sampling
   * @param {string} [o.codeBin]
   * @param {(msg: string) => void} [o.log]
   */
  constructor(o) {
    super();
    this.setMaxListeners(100);
    this.projectDir = o.projectDir;
    this.projectName = path.basename(o.projectDir) || o.projectDir;
    this.model = o.model ?? null;
    this.check = o.check ?? null;
    this.requestedMax = Math.min(6, Math.max(1, Number(o.maxConcurrent) || 3));
    this.copilot = {
      command: o.copilot?.command ?? process.env.ARCADE_COPILOT_BIN ?? "copilot",
      prefixArgs: o.copilot?.prefixArgs ?? [],
      acpArgs: o.copilot?.acpArgs ?? ["--acp", "--stdio"],
      env: o.copilot?.env ?? null,
    };
    this.metricsIntervalMs = o.metricsIntervalMs ?? 3000;
    this.codeBin = o.codeBin ?? "code";
    this.log = o.log ?? (() => {});
    this.runStore = new RunStore(this.projectDir);
    this.broker = new PermissionBroker();

    this.acp = null;
    this.acpReady = false;
    this.closing = false;
    this.git = { isGit: false, hasCommits: false, root: null, prefix: "", head: null, branch: null };
    this.gitEnv = {};
    this.canWorktree = false;
    this.maxConcurrent = this.requestedMax;
    this.copilotInfo = { found: false, version: null, loggedIn: "unknown" };
    this.gitInfoVersion = null;
    this.loginCommand = "copilot login";
    this.agentInfo = null;
    this.defaultModel = null;
    this.availableModels = null;
    this.connection = { state: "connecting", message: "Starting" };

    this.rts = new Map(); // workerId -> runtime (workers only)
    this.leadRt = null;
    this.bySession = new Map(); // sessionId -> runtime
    this.merging = new Set();
    this._lock = Promise.resolve();
    this.metricsTimer = null;
    this.delegating = false;
    this.connecting = Promise.resolve();
    this.leftoverNote = "";

    // Id counters are never reset, so ids stay unique across runs within one launch.
    this.seq = { order: 0, worker: 0, review: 0, note: 0, suggestion: 0, inbox: 0, batch: 0 };
    this.names = { builder: 0, planner: 0, checker: 0 };

    this.runId = null;
    this.events = [];
    this.t0 = Date.now();
    this.gen = 0;
    this.state = createInitialState();
  }

  // ---- state ---------------------------------------------------------------------------------

  _now() {
    return Math.max(0, Date.now() - this.t0);
  }

  _emit(ev) {
    const event = { ...ev, t: this._now() };
    reduce(this.state, event);
    if (event.type === "metrics") this.state.timeline.pop();
    else if (this.events.length < MAX_EVENTS) this.events.push(event);
    this.emit("event", event);
    return event;
  }

  snapshot() {
    return { type: "snapshot", t: this._now(), state: this.state };
  }

  /** Fresh state for a new run (or after reset): connection + an idle Lead desk. Clients get a snapshot. */
  _resetState() {
    this.gen++;
    this.t0 = Date.now();
    this.events = [];
    this.names = { builder: 0, planner: 0, checker: 0 };
    this.state = createInitialState();
    this.state.source = "live";
    this.state.project = { name: this.projectName, path: this.projectDir, isGit: this.git.isGit };
    this.state.maxConcurrent = this.maxConcurrent;
    this._emitConnection();
    this._emit({
      type: "worker.added",
      worker: { id: "lead", role: "lead", name: "Foreman", model: this.model ?? this.defaultModel, status: "idle", now: "Waiting for a goal" },
    });
    this.emit("snapshot", this.snapshot());
  }

  _setConnection(state, message) {
    this.connection = { state, message };
    this._emitConnection();
  }

  _emitConnection() {
    const { state, message } = this.connection;
    this._emit({ type: "connection", state, message: this.leftoverNote ? `${message} ${this.leftoverNote}` : message, source: "live" });
  }

  health() {
    return {
      copilot: { ...this.copilotInfo },
      git: { found: this.gitInfoVersion !== null, version: this.gitInfoVersion },
      project: { name: this.projectName, path: this.projectDir, isGit: this.git.isGit },
      loginCommand: this.loginCommand,
      model: { requested: this.model, default: this.defaultModel },
      maxConcurrent: this.maxConcurrent,
      check: this.check,
      connection: this.connection,
      agent: this.agentInfo,
    };
  }

  // ---- startup / ACP -------------------------------------------------------------------------

  async start() {
    this.git = await gitInfo(this.projectDir);
    this.gitInfoVersion = await gitVersion();
    this.canWorktree = this.git.isGit && this.git.hasCommits;
    this.maxConcurrent = this.canWorktree ? this.requestedMax : 1;
    if (this.git.isGit) this.gitEnv = await identityEnv(this.git.root);
    if (this.git.isGit) {
      const left = await unmergedWorktrees({ root: this.git.root, projectDir: this.projectDir }).catch(() => []);
      if (left.length) this.leftoverNote = `Found ${left.length} unmerged worktree${left.length === 1 ? "" : "s"} from earlier runs under .arcade/worktrees (${left.map((l) => l.branch).join(", ")}). Nothing was deleted.`;
    }
    this._resetState();

    if (this.metricsIntervalMs > 0) {
      this.metricsTimer = setInterval(() => this._sampleMetrics(), this.metricsIntervalMs);
      this.metricsTimer.unref();
    }
    // Connecting to Copilot can take a while; the server is usable meanwhile (state shows "connecting").
    this.connecting = this._startCopilot().catch((err) => this.log(`startup error: ${err?.message ?? err}`));
    return this;
  }

  async _startCopilot() {
    const found = await detectCopilot(this.copilot);
    this.copilotInfo = { found: found.found, version: found.version, loggedIn: "unknown" };
    if (!found.found) {
      this._setConnection("error", "The `copilot` command was not found. Install GitHub Copilot CLI and sign in, then restart Agent Arcade. You can still explore the UI.");
      return;
    }
    await this._connectAcp();
    if (this.metricsIntervalMs > 0) this._sampleMetrics();
  }

  _gitNote() {
    if (!this.git.isGit) return "Not a git repository: agents run one at a time directly in your project folder, with no isolation and no merge step.";
    if (!this.git.hasCommits) return "This repository has no commits yet, so worktrees are not possible: agents run one at a time in your project folder.";
    return "";
  }

  async _connectAcp() {
    this._setConnection("connecting", "Connecting to Copilot");
    const acp = new AcpClient({
      command: this.copilot.command,
      args: [...this.copilot.prefixArgs, ...this.copilot.acpArgs],
      cwd: this.projectDir,
      env: this.copilot.env ? { ...process.env, ...this.copilot.env } : process.env,
    });
    this.acp = acp;
    this.acpReady = false;
    acp.setRequestHandler((method, params) => this._onAgentRequest(method, params));
    acp.on("notification", (method, params) => this._onNotification(method, params));
    acp.on("exit", (info) => this._onAcpExit(acp, info));
    acp.on("badline", () => {});
    acp.start();
    try {
      const init = await acp.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, { timeoutMs: 30000 });
      this.agentInfo = init?.agentInfo ?? null;
      this.loginCommand = loginCommandFrom(init) ?? this.loginCommand;
      const probe = await acp.request("session/new", { cwd: this.projectDir, mcpServers: [] }, { timeoutMs: 60000 });
      this.defaultModel = probe?.models?.currentModelId ?? null;
      this.availableModels = Array.isArray(probe?.models?.availableModels) ? probe.models.availableModels.map((m) => m.modelId) : null;
      acp.request("session/close", { sessionId: probe.sessionId }, { timeoutMs: 3000 }).catch(() => {});
      this.copilotInfo.loggedIn = true;
      this.acpReady = true;
      const shown = this.model ?? this.defaultModel;
      const note = this._gitNote();
      this._setConnection("ready", `Connected to Copilot${shown ? ` (model: ${shown})` : ""}.${note ? " " + note : ""}`);
      const lead = this.state.workers.lead;
      if (lead && shown && lead.model !== shown) this._emit({ type: "worker.session", id: "lead", model: shown });
    } catch (err) {
      if (acp.exited && this.closing) return;
      if (isAuthError(err)) {
        this.copilotInfo.loggedIn = false;
        this._setConnection("error", `Copilot is not signed in. Run \`${this.loginCommand}\` in a terminal, then restart Agent Arcade.`);
      } else {
        this.copilotInfo.loggedIn = "unknown";
        this._setConnection("error", `Could not start a Copilot session: ${clip(err?.message ?? err, 300)}${acp.stderrTail ? ` (${clip(acp.stderrTail.trim().split("\n").pop(), 200)})` : ""}`);
      }
      acp.close({ killAfterMs: 500 }).catch(() => {});
    }
  }

  _onAcpExit(acp, info) {
    if (acp !== this.acp) return;
    this.acpReady = false;
    if (this.closing) return;
    const why = info?.error ? info.error.message : `exit ${info?.signal ?? info?.code}`;
    if (this.connection.state !== "error") this._setConnection("error", `The Copilot process stopped (${why}). Running agents stopped with it. Reset the run to reconnect.`);
  }

  _onNotification(method, params) {
    if (method !== "session/update") return;
    const rt = this.bySession.get(params?.sessionId);
    if (!rt || rt.dead) return;
    rt.translator.handle(params.update);
  }

  async _ensureAcp() {
    if (this.acpReady) return true;
    // A command that arrives while the first connection is still in flight waits for it instead of failing.
    if (this.connecting) await this.connecting;
    if (this.acpReady) return true;
    if (!this.copilotInfo.found || this.closing) return false;
    if (this.acp?.exited || this.connection.state === "error") {
      if (this.acp && !this.acp.exited) await this.acp.close({ killAfterMs: 500 });
      await this._connectAcp();
    }
    return this.acpReady;
  }

  async _newSession(cwd, rt) {
    let res;
    try {
      res = await this.acp.request("session/new", { cwd, mcpServers: [] }, { timeoutMs: 60000 });
    } catch (err) {
      if (isAuthError(err)) {
        this.copilotInfo.loggedIn = false;
        this._setConnection("error", `Copilot is not signed in. Run \`${this.loginCommand}\` in a terminal, then restart Agent Arcade.`);
      }
      throw err;
    }
    let model = res?.models?.currentModelId ?? this.defaultModel;
    if (this.model) {
      if (this.availableModels && !this.availableModels.includes(this.model)) {
        this._say(rt, `Model ${this.model} is not offered by Copilot; using ${model ?? "the default"}.`);
      } else {
        try {
          await this.acp.request("session/set_model", { sessionId: res.sessionId, modelId: this.model }, { timeoutMs: 15000 });
          model = this.model;
        } catch (err) {
          this._say(rt, `Could not switch to model ${this.model} (${clip(err?.message, 120)}); using ${model ?? "the default"}.`);
        }
      }
    }
    return { sessionId: res.sessionId, model };
  }

  _closeSession(rt) {
    if (!rt.sessionId || rt.sessionClosed) return;
    rt.sessionClosed = true;
    const id = rt.sessionId;
    this.bySession.delete(id);
    if (this.acp && !this.acp.exited) this.acp.request("session/close", { sessionId: id }, { timeoutMs: 3000 }).catch(() => {});
  }

  // ---- permissions ---------------------------------------------------------------------------

  async _onAgentRequest(method, params) {
    if (method === "session/request_permission") return this._onPermission(params ?? {});
    throw rpcError(-32601, `Method not supported: ${method}`);
  }

  async _onPermission(params) {
    const rt = this.bySession.get(params.sessionId);
    if (!rt || rt.dead || this.closing) return CANCELLED;
    const tc = params.toolCall ?? {};
    const options = (Array.isArray(params.options) ? params.options : []).filter((o) => o && typeof o.optionId === "string");
    const kind = mapKind(tc.kind);
    const title = clip(tc.title || `${kind} request`, 200);

    // The only automatic answer in the whole app: the read-only Lead may not edit or run commands.
    if (rt.id === "lead" && (kind === "edit" || kind === "execute")) {
      const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => String(o.kind).startsWith("reject"));
      this._emit({ type: "worker.output", id: "lead", lines: [`» Auto-rejected: the Foreman is read-only (${title})`] });
      return reject ? { outcome: { outcome: "selected", optionId: reject.optionId } } : CANCELLED;
    }
    // A worker that is being stopped should not ask the human anything new.
    if (rt.pendingHold) return CANCELLED;

    const raw = tc.rawInput ?? {};
    const detail =
      kind === "execute"
        ? clip(raw.command ?? (Array.isArray(raw.commands) ? raw.commands.join("\n") : ""), 2000)
        : clip(raw.fileName ?? tc.locations?.[0]?.path ?? (typeof raw === "string" ? raw : ""), 2000);
    const { id, promise } = this.broker.request({ sessionId: params.sessionId, workerId: rt.id, options, toolCall: tc });
    this._emit({
      type: "approval.requested",
      approval: {
        id,
        workerId: rt.id,
        title,
        kind,
        detail,
        diff: typeof raw.diff === "string" ? clip(raw.diff, 60 * 1024) : "",
        options: options.map((o) => ({ id: o.optionId, kind: o.kind, label: clip(o.name ?? o.optionId, 60) })),
      },
    });
    return promise;
  }

  /** Cancel (never allow) every open approval of a session and tell the UI. */
  _cancelApprovals(rt) {
    if (!rt.sessionId) return 0;
    const cancelled = this.broker.cancelForSession(rt.sessionId).filter(Boolean);
    for (const p of cancelled) this._emit({ type: "approval.resolved", id: p.id, outcome: "cancelled", nextStatus: "working" });
    return cancelled.length;
  }

  // ---- runtime helpers -----------------------------------------------------------------------

  _makeRuntime({ id, role, orderId = null }) {
    const rt = {
      id,
      role,
      orderId,
      cwd: this.projectDir,
      sessionId: null,
      wt: null,
      turn: null,
      turnSeq: 0,
      pendingNotes: [], // [{ id, kind: "nudge" | "redirect", text }] waiting for the next prompt
      pendingHold: null, // { kind: "hold" | "takeover", noteId } while a cancel is in flight
      redirectNote: null,
      nextPrompt: null,
      promptSent: false,
      starting: false,
      finishing: false,
      slot: false,
      dead: false,
      blockedDetail: "",
      warnedFiles: new Set(),
      launchNotes: [], // note ids to mark delivered when the next prompt is sent
      sessionClosed: false,
      acp: null, // the ACP process that owns rt.sessionId (sessions do not survive a restart)
      /** Clears and returns the pending hold request. */
      takePendingHold() {
        const h = this.pendingHold;
        this.pendingHold = null;
        return h;
      },
    };
    rt.translator = new UpdateTranslator({
      workerId: id,
      cwd: this.projectDir,
      getStatus: () => this.state.workers[id]?.status,
      emit: (ev) => {
        if (!rt.dead) this._emit(ev);
      },
      onFile: (rel) => this._onFileChanged(rt, rel),
    });
    return rt;
  }

  _onFileChanged(rt, rel) {
    const order = rt.orderId ? this.state.orders[rt.orderId] : null;
    if (order && !matchesAllowed(rel, order.allowedFiles) && !rt.warnedFiles.has(rel)) {
      rt.warnedFiles.add(rel);
      this._say(rt, `⚠ Changed ${rel}, which is outside this order's allowed files (${order.allowedFiles.join(", ")}). Review it carefully.`);
    }
  }

  _status(rt, status, now, extra = {}) {
    this._emit({ type: "worker.status", id: rt.id, status, now, ...extra });
  }

  /** A line written by the bridge (not by the agent). */
  _say(rt, text) {
    if (rt && !rt.dead) this._emit({ type: "worker.output", id: rt.id, lines: [`» ${text}`] });
  }

  _note(rt, kind, text) {
    const id = `n${++this.seq.note}`;
    this._emit({ type: "note.added", id: rt.id, note: { id, kind, text } });
    return id;
  }

  _deliverNote(rt, noteId) {
    this._emit({ type: "note.delivered", id: rt.id, noteId, atStep: this.state.workers[rt.id]?.steps ?? 0 });
  }

  _failNote(rt, noteId, why) {
    this._emit({ type: "note.failed", id: rt.id, noteId });
    if (why) this._say(rt, why);
  }

  _locked(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  _slots() {
    let n = 0;
    for (const rt of this.rts.values()) if (rt.slot && !rt.dead) n++;
    return n;
  }

  _saveRun() {
    if (!this.runId || !this.state.goal) return;
    try {
      this.runStore.save(this.runId, this.events);
    } catch (err) {
      this.log(`Could not save the run file: ${err.message}`);
    }
  }

  async _sampleMetrics() {
    if (this.closing) return;
    const m = await sampleMetrics({ serverPid: process.pid, copilotPid: this.acp?.pid ?? null, sessions: this.bySession.size });
    if (!this.closing) this._emit({ type: "metrics", ...m });
  }

  // ---- prompts and turns ---------------------------------------------------------------------

  /** Send a prompt now. If a turn is running this PRE-EMPTS it (ACP behavior): the old turn resolves "cancelled". */
  _sendPrompt(rt, text, deliveredNotes = []) {
    const turn = { seq: ++rt.turnSeq, settled: null };
    rt.turn = turn;
    rt.translator.beginTurn();
    const request =
      this.acp && !this.acp.exited
        ? this.acp.request("session/prompt", { sessionId: rt.sessionId, prompt: [{ type: "text", text }] }, { timeoutMs: 0 })
        : Promise.reject(new Error("The Copilot process is not running"));
    turn.settled = request.then(
      (res) => this._onTurnEnd(rt, turn, res),
      (err) => this._onTurnError(rt, turn, err),
    );
    turn.settled.catch((err) => this.log(`turn handler error: ${err?.stack ?? err}`));
    for (const id of deliveredNotes) this._deliverNote(rt, id);
    return turn;
  }

  _firstPrompt(rt) {
    const order = this.state.orders[rt.orderId];
    let text = workerPrompt(order, rt.role);
    const notes = rt.pendingNotes.splice(0);
    if (notes.length) text += `\n\n${notesBlock(notes)}`;
    rt.promptSent = true;
    return { text, noteIds: notes.map((n) => n.id) };
  }

  /** Start (or restart after hold/block/send-back) a worker that already has a session. */
  _continueWorker(rt) {
    let text;
    let noteIds = [];
    if (!rt.promptSent) {
      ({ text, noteIds } = this._firstPrompt(rt));
    } else {
      const notes = rt.pendingNotes.splice(0);
      noteIds = notes.map((n) => n.id);
      noteIds.push(...rt.launchNotes.splice(0));
      if (rt.nextPrompt) text = rt.nextPrompt;
      else if (rt.blockedDetail) text = blockedContinuePrompt(rt.blockedDetail);
      else text = continuePrompt();
      rt.nextPrompt = null;
      if (notes.length) text += `\n\n${notesBlock(notes)}`;
    }
    rt.blockedDetail = "";
    this._sendPrompt(rt, text, noteIds);
  }

  // ---- scheduling ----------------------------------------------------------------------------

  _unmetDependency(order) {
    for (const d of order.dependsOn ?? []) {
      if (!Object.hasOwn(this.state.orders, d)) continue;
      const o = this.state.orders[d];
      if (o.status === "rejected") continue;
      if (o.status !== "shipped") return o;
    }
    return null;
  }

  /** Synchronous: marks workers "working" before any async startup so capacity is never over-committed. */
  _schedule() {
    if (this.closing || !this.state.goal) return;
    const max = this.state.maxConcurrent;
    let slots = this._slots();
    for (const id of [...this.state.workerOrder]) {
      const w = this.state.workers[id];
      if (w.role === "lead" || w.status !== "queued") continue;
      const rt = this.rts.get(id);
      if (!rt || rt.dead) continue;
      const order = this.state.orders[w.orderId];
      let reason = null;
      if (this.state.holdAll) reason = "Hold all is on";
      else {
        const dep = order ? this._unmetDependency(order) : null;
        if (dep) reason = `Waiting for "${dep.title}" to be approved`;
        else if (slots >= max) reason = `Stage door: ${max} agent${max === 1 ? "" : "s"} at a time`;
      }
      if (reason) {
        if (w.queuedReason !== reason) this._emit({ type: "worker.status", id, status: "queued", reason, now: reason });
        continue;
      }
      slots++;
      this._launch(rt);
    }
  }

  _launch(rt) {
    rt.slot = true;
    const first = !rt.sessionId;
    this._status(rt, "working", first ? "Starting" : "Resuming");
    if (rt.orderId) this._emit({ type: "order.updated", order: { id: rt.orderId, status: "working" } });
    if (first) {
      rt.starting = true;
      this._bootstrap(rt).catch((err) => this._failWorker(rt, err?.message ?? String(err)));
    } else if (!this.acpReady || rt.acp !== this.acp) {
      this._failWorker(rt, "The Copilot process is not running, so this agent's session is gone.");
    } else {
      this._continueWorker(rt);
    }
  }

  async _bootstrap(rt) {
    const order = this.state.orders[rt.orderId];
    try {
      if (!(await this._ensureAcp())) throw new Error(this.connection.message || "Copilot is not available");
      if (rt.dead) return;
      if (rt.role === "builder" && this.canWorktree && !rt.wt) {
        this._status(rt, "working", "Creating a worktree");
        const wt = await this._locked(() =>
          createWorktree({ root: this.git.root, prefix: this.git.prefix, projectDir: this.projectDir, runId: this.runId, workerId: rt.id }),
        );
        if (rt.dead) return;
        rt.wt = wt;
        rt.cwd = wt.cwd;
        rt.translator.setCwd(wt.cwd);
        this._emit({ type: "worker.session", id: rt.id, worktree: { path: wt.path, branch: wt.branch } });
      }
      this._status(rt, "working", "Starting a Copilot session");
      const { sessionId, model } = await this._newSession(rt.cwd, rt);
      if (rt.dead) {
        if (this.acp && !this.acp.exited) this.acp.request("session/close", { sessionId }, { timeoutMs: 3000 }).catch(() => {});
        return;
      }
      rt.sessionId = sessionId;
      rt.acp = this.acp;
      this.bySession.set(sessionId, rt);
      this._emit({ type: "worker.session", id: rt.id, sessionId, model });
      rt.starting = false;
      if (rt.pendingHold) return this._enterHeld(rt, rt.takePendingHold());
      this._status(rt, "working", `Working on: ${clip(order.title, 80)}`);
      this._continueWorker(rt);
    } finally {
      rt.starting = false;
    }
  }

  _failWorker(rt, message) {
    if (rt.dead) return;
    rt.starting = false;
    rt.finishing = false;
    rt.slot = false;
    rt.turn = null;
    this._cancelApprovals(rt);
    if (rt.pendingHold) this._failNote(rt, rt.takePendingHold().noteId);
    const w = this.state.workers[rt.id];
    this._status(rt, "failed", clip(message, 160));
    this._say(rt, `Stopped: ${clip(message, 400)}`);
    this._emit({
      type: "inbox.add",
      item: {
        id: `q${++this.seq.inbox}`,
        kind: "question",
        workerId: rt.id,
        summary: `${w?.name ?? rt.id} stopped: ${clip(message, 120)}`,
        detail: `${clip(message, 600)}\nIf the session is still alive you can press Resume to send a new "continue" prompt.`,
      },
    });
    this._schedule();
  }

  // ---- turn lifecycle ------------------------------------------------------------------------

  _confirmRedirect(rt, why) {
    if (!rt.redirectNote) return;
    const id = rt.redirectNote;
    rt.redirectNote = null;
    this._deliverNote(rt, id);
    if (why) this._say(rt, why);
  }

  _enterHeld(rt, hold, why) {
    if (rt.dead) return;
    rt.finishing = false;
    const takeover = hold?.kind === "takeover";
    this._status(rt, "held", takeover ? "You are driving this desk" : why ?? "Held");
    if (takeover) this._emit({ type: "worker.takeover", id: rt.id, value: true });
    if (hold) this._deliverNote(rt, hold.noteId);
    this._say(
      rt,
      !rt.promptSent
        ? "Held before it started working. Resume sends its first prompt."
        : takeover
          ? "Turn cancelled. The agent is stopped and the worktree is yours; press Hand back to let it re-read the files and continue."
          : "Turn cancelled. This is a cancel, not a pause: Resume sends a new \"continue\" prompt and the agent starts from the conversation so far.",
    );
  }

  async _onTurnEnd(rt, turn, res) {
    if (rt.dead) return;
    rt.translator.flush();
    if (this.closing) return;
    if (rt.turn !== turn) {
      // A newer prompt (redirect) pre-empted this turn.
      if (rt.redirectNote) this._confirmRedirect(rt, `Redirect delivered: the previous turn ended (${res?.stopReason ?? "unknown"}).`);
      return;
    }
    rt.turn = null;
    const reason = res?.stopReason;
    if (rt.id === "lead") return this._leadTurnEnded(rt, reason);
    this._confirmRedirect(rt, "Redirect delivered: the agent finished its turn.");

    const hold = rt.takePendingHold();
    if (reason === "cancelled") {
      this._enterHeld(rt, hold, hold ? undefined : "The turn was cancelled");
      // "Resume all" arrived while this Hold-all cancel was still in flight.
      if (hold?.fromAll && !this.state.holdAll) this._resumeHeld(rt);
      return;
    }
    if (reason === "end_turn") {
      if (hold) this._failNote(rt, hold.noteId, `${hold.kind === "takeover" ? "Take over" : "Hold"} arrived after the agent had already finished its turn, so nothing was stopped. Review the result below.`);
      const notes = rt.pendingNotes.filter((n) => n.kind !== "sendback");
      if (notes.length && !this.state.holdAll && !hold) {
        rt.pendingNotes = [];
        this._status(rt, "working", "Applying your note");
        this._sendPrompt(rt, nudgePrompt(notes), notes.map((n) => n.id));
        return;
      }
      return this._finishWork(rt);
    }
    if (hold) this._failNote(rt, hold.noteId);
    this._status(rt, "blocked", `Stopped: ${reason ?? "unknown reason"}`);
    this._emit({
      type: "inbox.add",
      item: {
        id: `q${++this.seq.inbox}`,
        kind: "question",
        workerId: rt.id,
        summary: `${this.state.workers[rt.id].name} stopped early (${reason ?? "unknown"})`,
        detail: "Copilot ended the turn without finishing. Press Resume to send a \"continue\" prompt, or Redirect with a clearer instruction.",
      },
    });
  }

  _onTurnError(rt, turn, err) {
    if (rt.dead || this.closing) return;
    rt.translator.flush();
    if (rt.turn !== turn) return;
    rt.turn = null;
    if (rt.id === "lead") return this._leadFailed(rt, err?.message ?? String(err));
    this._failWorker(rt, err?.message ?? String(err));
  }

  // ---- finishing, checks, review -------------------------------------------------------------

  async _finishWork(rt) {
    const gen = this.gen;
    const w = this.state.workers[rt.id];
    const order = this.state.orders[rt.orderId];
    const isBuilder = rt.role === "builder";
    rt.finishing = true;
    let summary = rt.translator.summary || "(The agent finished without writing a summary.)";
    const checks = [];
    let files = [];
    let diff = "";
    try {
      if (rt.wt) {
        this._status(rt, "working", "Collecting the changes");
        await commitAll(rt.wt.path, `Agent Arcade checkpoint: ${order.title}`, this.gitEnv);
        if (rt.dead || gen !== this.gen) return;
        if (this.check) {
          const name = clip(this.check, 60);
          this._status(rt, "working", `Running check: ${name}`);
          const r = await runCheck(this.check, rt.wt.cwd);
          if (rt.dead || gen !== this.gen) return;
          const out = tail(r.output.trim(), 3000);
          checks.push({ name, status: r.status, output: out });
          this._emit({ type: "check.run", id: rt.id, name, status: r.status, output: tail(out.split("\n").filter(Boolean).slice(-3).join(" | "), 300) });
          if (r.status === "fail") return this._checkFailed(rt, name, out, r.timedOut);
        }
        const d = await diffAgainst(rt.wt.path, rt.wt.baseSha);
        files = d.files;
        diff = d.diff;
      } else {
        files = w.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, diff: f.diff }));
        diff = files.map((f) => f.diff).filter(Boolean).join("\n");
        if (isBuilder && this.check) {
          const name = clip(this.check, 60);
          this._status(rt, "working", `Running check: ${name}`);
          const r = await runCheck(this.check, rt.cwd);
          if (rt.dead || gen !== this.gen) return;
          const out = tail(r.output.trim(), 3000);
          checks.push({ name, status: r.status, output: out });
          this._emit({ type: "check.run", id: rt.id, name, status: r.status, output: tail(out.split("\n").filter(Boolean).slice(-3).join(" | "), 300) });
          if (r.status === "fail") return this._checkFailed(rt, name, out, r.timedOut);
        }
      }
    } catch (err) {
      if (rt.dead || gen !== this.gen) return;
      return this._failWorker(rt, `Could not collect the changes: ${err.message}`);
    }
    if (rt.dead || gen !== this.gen) return;

    const notes = [];
    const outside = files.filter((f) => !matchesAllowed(f.path, order.allowedFiles)).map((f) => f.path);
    if (outside.length) notes.push(`Heads up: changed files outside the allowed list: ${outside.slice(0, 8).join(", ")}${outside.length > 8 ? ", …" : ""}.`);
    const noChecks = isBuilder && !this.check;
    if (noChecks) notes.push("No check command is configured, so nothing was verified automatically. Read the diff.");
    if (isBuilder && !files.length) notes.push("The agent did not change any files.");
    if (!rt.wt && isBuilder) notes.push("This ran directly in your project folder (not a git repository with commits), so there is no separate branch to merge.");
    summary = clip(summary, 3000) + (notes.length ? `\n\n${notes.join("\n")}` : "");

    rt.finishing = false;
    rt.slot = false;
    const id = `r${++this.seq.review}`;
    this._emit({
      type: "review.ready",
      review: { id, workerId: rt.id, orderId: rt.orderId, summary, files, checks, diff, noChecks, warnings: notes },
    });
    this._status(rt, "done", "Ready for review");
    this._schedule();
  }

  _checkFailed(rt, name, output, timedOut) {
    rt.finishing = false;
    rt.blockedDetail = `the check \`${name}\` ${timedOut ? "timed out" : "failed"}:\n${tail(output, 1500)}`;
    this._status(rt, "blocked", `Check failed: ${name}`);
    this._emit({
      type: "inbox.add",
      item: {
        id: `c${++this.seq.inbox}`,
        kind: "failed_check",
        workerId: rt.id,
        summary: `Check ${timedOut ? "timed out" : "failed"}: ${name}`,
        detail: tail(output, 2000) || "(no output)",
      },
    });
  }

  // ---- the Lead ------------------------------------------------------------------------------

  async _runLead(goal) {
    const rt = this._makeRuntime({ id: "lead", role: "lead" });
    this.leadRt = rt;
    try {
      if (!(await this._ensureAcp())) throw new Error(this.connection.message || "Copilot is not available");
      this._emit({ type: "worker.status", id: "lead", status: "working", now: "Reading the project" });
      const { sessionId, model } = await this._newSession(this.projectDir, rt);
      if (rt.dead) return;
      rt.sessionId = sessionId;
      this.bySession.set(sessionId, rt);
      this._emit({ type: "worker.session", id: "lead", sessionId, model });
      this._sendPrompt(rt, leadPrompt(goal));
    } catch (err) {
      this._leadFailed(rt, err?.message ?? String(err));
    }
  }

  _leadFailed(rt, message) {
    if (rt.dead) return;
    this._emit({ type: "worker.status", id: "lead", status: "failed", now: clip(message, 120) });
    this._emit({
      type: "inbox.add",
      item: {
        id: `q${++this.seq.inbox}`,
        kind: "question",
        workerId: "lead",
        summary: "The Lead could not plan this goal",
        detail: `${clip(message, 600)}\nYou can write the work orders yourself with "Add order", or reset and try again.`,
      },
    });
  }

  _leadTurnEnded(rt, reason) {
    if (reason === "end_turn") return this._leadFinished(rt);
    this._cancelApprovals(rt);
    if (reason === "cancelled") {
      this._emit({ type: "worker.status", id: "lead", status: "idle", now: "Stopped" });
      return;
    }
    this._leadFailed(rt, `Copilot ended the Lead's turn early (${reason ?? "unknown reason"}).`);
  }

  _leadFinished(rt) {
    const last = rt.translator.summary;
    const full = rt.translator.fullText;
    let parsed = parseOrders(last);
    if (!parsed.ok && full !== last) parsed = parseOrders(full);
    this._closeSession(rt);
    if (!parsed.ok) {
      this._emit({ type: "worker.status", id: "lead", status: "idle", now: "Could not read the plan" });
      this._emit({
        type: "inbox.add",
        item: {
          id: `q${++this.seq.inbox}`,
          kind: "question",
          workerId: "lead",
          summary: "The Lead's plan could not be read",
          detail: `${parsed.error} Add the work orders yourself with "Add order", or reset and try a different goal.\n\nLead's reply:\n${clip(full, 1500)}`,
        },
      });
      return;
    }
    const ids = parsed.orders.map(() => `o${++this.seq.order}`);
    const deps = resolveDependsOn(parsed.orders, ids);
    const graph = new Map(ids.map((id, i) => [id, deps[i]]));
    const cyc = findCycle(graph);
    const warnings = [...parsed.warnings];
    if (cyc) {
      warnings.push("The Lead's dependencies formed a loop, so they were dropped. Check the order of the work.");
      for (let i = 0; i < deps.length; i++) deps[i] = [];
    }
    parsed.orders.forEach((o, i) => {
      this._emit({
        type: "order.added",
        order: { id: ids[i], title: o.title, ownerRole: o.ownerRole, allowedFiles: o.allowedFiles, acceptance: o.acceptance, prompt: o.prompt, dependsOn: deps[i], status: "proposed" },
      });
    });
    if (warnings.length) this._emit({ type: "worker.output", id: "lead", lines: warnings.map((w) => `» ${w}`) });
    this._emit({ type: "worker.status", id: "lead", status: "idle", now: "Waiting for your approval" });
    this._reproposeBatch(`Foreman proposes ${ids.length} work order${ids.length === 1 ? "" : "s"}`);
  }

  /** Keeps state.batch.orderIds equal to the orders that are currently proposed. */
  _reproposeBatch(summary) {
    const ids = this.state.orderOrder.filter((id) => this.state.orders[id].status === "proposed");
    for (const item of this.state.inbox) if (item.kind === "batch" && item.open) this._emit({ type: "inbox.resolve", id: item.id, resolution: "updated" });
    this._emit({
      type: "batch.proposed",
      orderIds: ids,
      summary: summary ?? `${ids.length} work order${ids.length === 1 ? "" : "s"} ready for your approval`,
      inboxId: `b${++this.seq.batch}`,
    });
  }

  // ---- shutdown ------------------------------------------------------------------------------

  _allRts() {
    return [...this.rts.values(), ...(this.leadRt ? [this.leadRt] : [])];
  }

  /** Cancel every live turn and answer every open approval as cancelled. Used by reset and shutdown. */
  _cancelEverything() {
    const turns = [];
    for (const rt of this._allRts()) {
      if (rt.dead) continue;
      if (rt.turn && rt.sessionId && this.acp && !this.acp.exited) {
        this.acp.notify("session/cancel", { sessionId: rt.sessionId });
        turns.push(rt.turn.settled);
      }
    }
    this.broker.cancelAll();
    return turns;
  }

  async shutdown() {
    if (this.closing) return { worktrees: [] };
    this.closing = true;
    clearInterval(this.metricsTimer);
    const turns = this._cancelEverything();
    if (turns.length) await Promise.race([Promise.allSettled(turns), sleep(1500)]);
    for (const rt of this._allRts()) rt.translator.flush();
    this._saveRun();
    if (this.acp) await this.acp.close();
    await Promise.race([this.connecting, sleep(500)]);
    let worktrees = [];
    if (this.git.isGit) worktrees = await unmergedWorktrees({ root: this.git.root, projectDir: this.projectDir }).catch(() => []);
    return { worktrees };
  }
}

Object.assign(Orchestrator.prototype, commandMethods);

function loginCommandFrom(init) {
  const method = Array.isArray(init?.authMethods) ? init.authMethods[0] : null;
  const t = method?._meta?.["terminal-auth"];
  if (!t || typeof t.command !== "string") return null;
  const cmd = path.basename(t.command);
  const args = Array.isArray(t.args) ? t.args.filter((a) => typeof a === "string") : [];
  return clip([cmd, ...args].join(" "), 80);
}

