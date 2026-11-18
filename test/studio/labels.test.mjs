import test from "node:test";
import assert from "node:assert/strict";
import { labels } from "../../public/studio/labels.js";
import { labels as reexported } from "../../public/studio/studio.js";
import { ROLES, WORKER_STATUSES } from "../../shared/state.js";

test("labels: every role and every worker status has a short friendly label", () => {
  assert.equal(labels.appName, "Agent Arcade");
  assert.deepEqual(Object.keys(labels.roles).sort(), [...ROLES].sort());
  assert.deepEqual(Object.keys(labels.statuses).sort(), [...WORKER_STATUSES].sort());
  assert.deepEqual(Object.keys(labels.statusShort).sort(), [...WORKER_STATUSES].sort());
  for (const [group, map] of [["roles", labels.roles], ["statuses", labels.statuses], ["statusShort", labels.statusShort]]) {
    for (const [key, text] of Object.entries(map)) {
      assert.equal(typeof text, "string", `${group}.${key}`);
      assert.ok(text.trim().length > 0 && text.length <= 24, `${group}.${key} is short: "${text}"`);
      assert.ok(!/[<>&]/.test(text), `${group}.${key} has no markup characters`);
    }
  }
});

test("labels: the contract wording", () => {
  assert.deepEqual(labels.roles, { lead: "Foreman", planner: "Planner", builder: "Builder", checker: "Checker" });
  assert.equal(labels.statuses.queued, "At the stage door");
  assert.equal(labels.statuses.waiting_approval, "Needs your OK");
  assert.equal(labels.statuses.blocked, "Stuck");
  assert.equal(labels.statuses.held, "Held");
});

test("labels: every other string is non-empty text", () => {
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === "object") continue;
    assert.ok(typeof value === "string" && value.trim().length > 0, `labels.${key}`);
  }
});

test("studio.js re-exports the same labels object", () => {
  assert.equal(reexported, labels);
});
