import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDemoEngine } from "../../shared/demo-engine.js";
import { createReplay } from "../../shared/client.js";
import { activeWorkerCount, createInitialState, openInbox, rebuild, reduce } from "../../shared/state.js";

const fixture = JSON.parse(readFileSync(new URL("../../fixtures/demo-timeline.json", import.meta.url), "utf8"));

function makeHarness(opts = {}) {
  let clock = 0;
  let seq = 0;
  const timers = new Map();
  const maxActive = { n: 0 };
  let state = null;
  const engine = createDemoEngine({
    fixture,
    speed: 1,
    now: () => clock,
    setTimer: (f, ms) => { const id = ++seq; timers.set(id, { at: clock + ms, f, id }); return id; },
    clearTimer: (id) => timers.delete(id),
    onEvent: (s) => { state = s; maxActive.n = Math.max(maxActive.n, activeWorkerCount(s)); },
    ...opts,
  });
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const next = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      timers.delete(next.id);
      clock = Math.max(clock, next.at);
      next.f();
    }
    clock = end;
  };
  engine.start();
  return { engine, advance, maxActive, get state() { return state; } };
}

const byName = (h, n) => Object.values(h.state.workers).find((x) => x.name === n);

test("reducer ignores unknown events and unknown workers", () => {
  const s = createInitialState();
  reduce(s, { type: "worker.step", id: "ghost", text: "x", t: 1 });
  reduce(s, { type: "totally.new", t: 2 });
  assert.equal(Object.keys(s.workers).length, 0);
  assert.equal(s.timeline.length, 2);
});

test("reducer does not alias incoming events", () => {
  const s = createInitialState();
  const ev = { type: "worker.added", worker: { id: "a", role: "builder", name: "A", plan: [] }, t: 0 };
  reduce(s, ev);
  s.workers.a.plan.push({ text: "mutated" });
  assert.deepEqual(ev.worker.plan, []);
});

test("rebuild reproduces live state from the timeline", () => {
  const h = makeHarness();
  h.engine.command("delegate", { goal: "dark mode" });
  h.advance(30000);
  h.engine.command("approveBatch");
  h.advance(30000);
  const rebuilt = rebuild(h.state.timeline);
  assert.deepEqual(Object.keys(rebuilt.workers), Object.keys(h.state.workers));
  for (const id of Object.keys(h.state.workers)) assert.equal(rebuilt.workers[id].status, h.state.workers[id].status);
  h.engine.stop();
});

test("delegate proposes the batch and does nothing until approved", () => {
  const h = makeHarness();
  assert.equal(h.engine.command("delegate", { goal: "  " }).ok, false);
  assert.equal(h.engine.command("delegate", { goal: "dark mode" }).ok, true);
  h.advance(30000);
  assert.equal(h.state.batch.status, "proposed");
  assert.equal(h.state.batch.orderIds.length, 5);
  assert.equal(openInbox(h.state)[0].kind, "batch");
  assert.equal(h.state.workerOrder.length, 1, "only the lead exists before approval");
  h.engine.stop();
});

test("stage door and dependencies queue workers with a reason", () => {
  const h = makeHarness();
  h.engine.command("delegate", { goal: "dark mode" });
  h.advance(30000);
  assert.equal(h.engine.command("approveBatch").ok, true);
  assert.match(byName(h, "Dot").queuedReason, /Stage door: 3/);
  assert.match(byName(h, "Tally").queuedReason, /Waiting for/);
  assert.equal(h.maxActive.n <= 3, true);
  h.engine.command("setMaxConcurrent", { value: 4 });
  assert.notEqual(byName(h, "Dot").status, "queued");
  h.engine.stop();
});

test("a full scripted run ships every order with receipts for interrupts", () => {
  const h = makeHarness();
  h.engine.command("delegate", { goal: "dark mode" });
  h.advance(30000);
  h.engine.command("approveBatch");

  let sawApproval = false;
  let sawBlocked = false;
  for (let i = 0; i < 600 && h.state.stats.shipped < 5; i++) {
    h.advance(500);
    for (const a of Object.values(h.state.approvals)) {
      if (a.status === "open") { sawApproval = true; h.engine.command("resolveApproval", { approvalId: a.id, optionId: "allow_once" }); }
    }
    const nova = byName(h, "Nova");
    if (nova.status === "blocked" && !sawBlocked) {
      sawBlocked = true;
      assert.equal(h.engine.command("nudge", { workerId: nova.id, text: "check the storage key" }).ok, true);
    }
    for (const r of Object.values(h.state.reviews)) {
      if (r.status === "open") h.engine.command("approveReview", { reviewId: r.id });
    }
  }
  assert.equal(sawApproval, true);
  assert.equal(sawBlocked, true);
  assert.equal(h.state.stats.shipped, 5);
  assert.equal(h.state.workers.lead.status, "done");
  assert.equal(h.maxActive.n <= 3, true);
  assert.equal(byName(h, "Tally").status, "done");
  const nudge = byName(h, "Nova").notes.find((n) => n.kind === "nudge");
  assert.equal(nudge.delivery, "delivered");
  assert.equal(h.state.inbox.filter((i) => i.open).length, 0);
  h.engine.stop();
});

test("hold waits for a safe point and records where it landed; resume continues", () => {
  const h = makeHarness();
  h.engine.command("delegate", { goal: "dark mode" });
  h.advance(30000);
  h.engine.command("approveBatch");
  h.advance(3500);
  const rivet = byName(h, "Rivet");
  assert.equal(h.engine.command("hold", { workerId: rivet.id }).ok, true);
  assert.equal(rivet.notes.at(-1).delivery, "queued");
  h.advance(40000);
  assert.equal(rivet.status, "held");
  assert.equal(rivet.notes.at(-1).delivery, "delivered");
  assert.equal(typeof rivet.notes.at(-1).atStep, "number");
  assert.equal(h.engine.command("hold", { workerId: rivet.id }).ok, false);
  assert.equal(h.engine.command("resume", { workerId: rivet.id }).ok, true);
  h.advance(5000);
  assert.notEqual(rivet.status, "held");
  h.engine.stop();
});

test("hold all stops new workers from starting; resume all releases them", () => {
  const h = makeHarness();
  h.engine.command("delegate", { goal: "dark mode" });
  h.advance(30000);
  h.engine.command("approveBatch");
  h.advance(500);
  h.engine.command("holdAll");
  h.advance(40000);
  const crew = Object.values(h.state.workers).filter((w) => w.role !== "lead");
  assert.equal(crew.every((w) => ["held", "queued", "waiting_approval"].includes(w.status)), true);
  h.engine.command("resumeAll");
  assert.equal(h.state.holdAll, false);
  h.advance(9000);
  assert.equal(crew.some((w) => w.status === "working"), true);
  h.engine.stop();
});

test("approvals can be denied and reviews can be sent back", () => {
  const h = makeHarness();
  h.engine.command("delegate", { goal: "dark mode" });
  h.advance(30000);
  h.engine.command("approveBatch");
  let denied = false;
  for (let i = 0; i < 200 && !denied; i++) {
    h.advance(500);
    const open = Object.values(h.state.approvals).find((a) => a.status === "open");
    if (open) { h.engine.command("resolveApproval", { approvalId: open.id, optionId: "reject_once" }); denied = true; }
  }
  assert.equal(denied, true);
  let sent = false;
  for (let i = 0; i < 200 && !sent; i++) {
    h.advance(500);
    const rv = Object.values(h.state.reviews).find((r) => r.status === "open");
    if (rv) {
      assert.equal(h.engine.command("sendBack", { reviewId: rv.id, text: "" }).ok, false);
      assert.equal(h.engine.command("sendBack", { reviewId: rv.id, text: "rename the toggle" }).ok, true);
      sent = true;
    }
  }
  assert.equal(sent, true);
  assert.equal(h.state.stats.sentBack, 1);
  h.engine.stop();
});

test("suggestions can be accepted into a new proposed order", () => {
  const h = makeHarness();
  assert.equal(h.engine.command("suggest", { text: "" }).ok, false);
  h.engine.command("suggest", { text: "Add a high-contrast mode" });
  const s = Object.values(h.state.suggestions)[0];
  const r = h.engine.command("resolveSuggestion", { id: s.id, decision: "accept" });
  assert.equal(r.ok, true);
  assert.equal(h.state.orders[r.data.orderId].status, "proposed");
  assert.equal(h.engine.command("resolveSuggestion", { id: s.id, decision: "accept" }).ok, false);
  h.engine.stop();
});

test("reset returns a clean state", () => {
  const h = makeHarness();
  h.engine.command("delegate", { goal: "dark mode" });
  h.advance(30000);
  h.engine.command("reset");
  assert.equal(h.state.goal, null);
  assert.equal(h.state.workerOrder.length, 1);
  assert.equal(h.state.batch.status, "none");
  h.engine.stop();
});

test("replay seeks and refuses commands", async () => {
  const h = makeHarness();
  h.engine.command("delegate", { goal: "dark mode" });
  h.advance(30000);
  h.engine.command("approveBatch");
  h.advance(40000);
  const events = structuredClone(h.state.timeline);
  const arcade = createReplay(events);
  arcade.replay.seek(events.length);
  assert.equal(Object.keys(arcade.getState().workers).length, Object.keys(h.state.workers).length);
  arcade.replay.seek(0);
  assert.equal(arcade.getState().workerOrder.length, 0);
  assert.equal((await arcade.command("hold", {})).ok, false);
  h.engine.stop();
});
