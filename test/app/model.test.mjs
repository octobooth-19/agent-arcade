import test from "node:test";
import assert from "node:assert/strict";
import { interruptRules, receipt, pendingNotes, orderStats, visibleOrders, primaryAction, denyAction, announcementFor, statusMeta, HOLD_COPY } from "../../public/panels/model.js";

const worker = (over = {}) => ({ id: "w1", name: "Rivet", role: "builder", status: "working", notes: [], takeover: false, ...over });

test("hold copy is honest about not being a true pause", () => {
  assert.match(HOLD_COPY, /Stops at the next safe point\. Resume re-prompts the agent; it is not a true pause\./);
});

test("interruptRules: a working builder can be held, nudged, redirected and taken over", () => {
  const r = interruptRules(worker());
  assert.equal(r.hold, null);
  assert.equal(r.nudge, null);
  assert.equal(r.redirect, null);
  assert.equal(r.takeover, null);
  assert.match(r.resume, /not held/);
  assert.match(r.handBack, /not in your hands/);
});

test("interruptRules: held, idle, done, takeover and lead", () => {
  assert.equal(interruptRules(worker({ status: "held" })).resume, null);
  assert.match(interruptRules(worker({ status: "held" })).hold, /nothing to hold/);
  assert.match(interruptRules(worker({ status: "idle" })).nudge, /cannot take a note/);
  assert.match(interruptRules(worker({ status: "done" })).takeover, /cannot be taken over/);
  const driving = interruptRules(worker({ takeover: true }));
  assert.equal(driving.handBack, null);
  assert.match(driving.takeover, /Already/);
  assert.match(interruptRules(worker({ role: "lead" })).hold, /Foreman only plans/);
  assert.match(interruptRules(null).hold, /Pick a worker/);
});

test("interruptRules: a queued hold cannot be stacked and can be resumed", () => {
  const w = worker({ notes: [{ kind: "hold", delivery: "queued" }] });
  assert.match(interruptRules(w).hold, /already queued/);
  assert.equal(interruptRules(w).resume, null);
});

test("receipt shows exactly what the state says", () => {
  assert.deepEqual(receipt({ delivery: "queued" }), { label: "Queued", tone: "warn", icon: "clock" });
  assert.equal(receipt({ delivery: "delivered", atStep: 4 }).label, "Delivered at step 4");
  assert.equal(receipt({ delivery: "delivered" }).label, "Delivered");
  assert.equal(receipt({ delivery: "failed" }).label, "Failed");
  assert.equal(receipt({ delivery: "failed" }).tone, "bad");
});

test("pendingNotes only counts queued notes", () => {
  const w = worker({ notes: [{ delivery: "queued" }, { delivery: "delivered" }, { delivery: "failed" }, { delivery: "queued" }] });
  assert.equal(pendingNotes(w).length, 2);
  assert.equal(pendingNotes(undefined).length, 0);
});

test("orders: removed orders are hidden and progress counts shipped", () => {
  const state = {
    orderOrder: ["a", "b", "c", "d"],
    orders: { a: { id: "a", status: "shipped" }, b: { id: "b", status: "working" }, c: { id: "c", status: "rejected" }, d: { id: "d", status: "proposed" } },
  };
  assert.deepEqual(visibleOrders(state).map((o) => o.id), ["a", "b", "d"]);
  const s = orderStats(state);
  assert.equal(s.total, 3);
  assert.equal(s.shipped, 1);
  assert.equal(s.removed, 1);
});

test("primaryAction/denyAction use the real approval options and never invent one", () => {
  const approval = { id: "ap1", options: [{ id: "o1", kind: "allow_once", label: "Allow once" }, { id: "o2", kind: "reject_once", label: "Deny" }] };
  const state = { approvals: { ap1: approval } };
  const item = { id: "i1", kind: "approval", refId: "ap1", summary: "Run npm test" };
  const p = primaryAction(item, state);
  assert.equal(p.option.id, "o1");
  assert.equal(denyAction(item, state).option.id, "o2");
  const onlyAlways = { approvals: { ap1: { id: "ap1", options: [{ id: "o3", kind: "allow_always" }] } } };
  assert.equal(primaryAction(item, onlyAlways), null);
  assert.equal(denyAction(item, onlyAlways), null);
  assert.equal(primaryAction({ kind: "failed_check", refId: "x", summary: "s" }, state), null);
  assert.equal(primaryAction({ kind: "batch", refId: "b", summary: "s" }, state).type, "jump");
  assert.equal(primaryAction({ kind: "suggestion", refId: "s1", summary: "Suggestion: more tests" }, state).label, "Accept suggestion: more tests");
});

test("announcementFor names the agent", () => {
  const state = { workers: { w1: { name: "Rivet" } } };
  assert.equal(announcementFor({ kind: "approval", workerId: "w1" }, state), "Rivet needs your approval");
  assert.match(announcementFor({ kind: "failed_check", workerId: "w1" }, state), /Rivet/);
  assert.equal(announcementFor({ kind: "suggestion" }, state), null);
});

test("statusMeta tolerates unknown statuses", () => {
  assert.equal(statusMeta("working").tone, "good");
  assert.equal(statusMeta("on_fire").label, "on fire");
  assert.equal(statusMeta(undefined).label, "unknown");
});
