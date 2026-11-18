import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { runCheck } from "../../src/checks.mjs";
import { unifiedDiff } from "../../src/diff.mjs";
import { descendantsOf, parsePs, summarize } from "../../src/metrics.mjs";
import { RunStore, newRunId, validRunId } from "../../src/run-store.mjs";
import { UpdateTranslator } from "../../src/updates.mjs";
import { cleanupAll, scratchDir } from "./helpers.mjs";

after(cleanupAll);

describe("update translator", () => {
  const make = (cwd = "/work/wt", status = "working") => {
    const events = [];
    const files = [];
    const t = new UpdateTranslator({ workerId: "w1", cwd, getStatus: () => status, emit: (e) => events.push(e), onFile: (f) => files.push(f), flushMs: 5 });
    return { t, events, files };
  };

  test("turns agent text, tool calls, plans, usage and diffs into reducer events", () => {
    const { t, events, files } = make();
    t.handle({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Looking at it.\nSecond " } });
    t.handle({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "line" } });
    t.handle({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit hello.txt", kind: "edit" });
    t.handle({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path: "/work/wt/hello.txt", oldText: "", newText: "hi\n" }] });
    t.handle({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path: "/work/wt/hello.txt", oldText: "", newText: "hi\nthere\n" }] });
    t.handle({ sessionUpdate: "plan", entries: [{ content: "Write file", status: "in_progress" }, { content: "Done", status: "completed" }, { content: "?", status: "weird" }] });
    t.handle({ sessionUpdate: "usage_update", used: 1000, size: 200000 });
    t.handle({ sessionUpdate: "usage_update", used: "lots", size: 1 });
    t.flush();

    assert.deepEqual(events.find((e) => e.type === "worker.output").lines, ["Looking at it."]);
    assert.ok(events.some((e) => e.type === "worker.output" && e.lines[0] === "Second line"));
    assert.deepEqual(events.find((e) => e.type === "worker.step"), { type: "worker.step", id: "w1", text: "Edit hello.txt" });
    const fileEvents = events.filter((e) => e.type === "worker.file");
    assert.equal(fileEvents.length, 2);
    assert.equal(fileEvents[0].path, "hello.txt", "paths are shown relative to the worker's directory");
    assert.equal(fileEvents[1].added, 2, "later diffs are cumulative against the first old text");
    assert.deepEqual(files, ["hello.txt"], "onFile fires once per file");
    assert.deepEqual(events.find((e) => e.type === "worker.plan").plan.map((p) => p.status), ["doing", "done", "todo"]);
    assert.equal(events.filter((e) => e.type === "worker.usage").length, 1, "a malformed usage update is ignored");
    assert.equal(t.summary, "Looking at it.\nSecond line", "with no text after the last tool call, the summary is the last stretch of text");
    t.handle({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "All done." } });
    assert.equal(t.summary, "All done.", "text after the last tool call wins");
  });

  test("shows Copilot's Info lines distinctly, reports unknown updates once, never invents progress", () => {
    const { t, events } = make();
    t.handle({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Info: Operation cancelled by user" } });
    t.handle({ sessionUpdate: "brand_new_thing" });
    t.handle({ sessionUpdate: "brand_new_thing" });
    t.handle({ sessionUpdate: "session_info_update" });
    t.handle({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x" } });
    t.handle(null);
    t.handle({});
    const lines = events.flatMap((e) => (e.type === "worker.output" ? e.lines : []));
    assert.deepEqual(lines, ["[copilot info] Operation cancelled by user", "[unsupported update: brand_new_thing]", "[unsupported update: agent_message_chunk:image]"]);
    assert.ok(!events.some((e) => e.type === "worker.step" || e.type === "worker.file"));
  });

  test("thinking is shown only for a working agent and only once per stretch", () => {
    const { t, events } = make("/w", "working");
    t.handle({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
    t.handle({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } });
    assert.equal(events.filter((e) => e.type === "worker.status").length, 1);
    const held = make("/w", "held");
    held.t.handle({ sessionUpdate: "agent_thought_chunk" });
    assert.equal(held.events.length, 0, "a late update never flips a held worker back to working");
  });

  test("execute output and failed tools are summarized in bounded lines", () => {
    const { t, events } = make();
    t.handle({ sessionUpdate: "tool_call", toolCallId: "x", title: "Run tests", kind: "execute" });
    t.handle({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "failed", content: [{ type: "content", content: { type: "text", text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") } }] });
    const out = events.filter((e) => e.type === "worker.output").flatMap((e) => e.lines);
    assert.equal(out.length, 12 + 1 + 1);
    assert.match(out.at(-2), /18 more lines/);
    assert.match(out.at(-1), /Run tests failed/);
  });
});

describe("unified diff", () => {
  test("produces a git-style diff with counts; identical text gives no diff", () => {
    const r = unifiedDiff("a.txt", "one\ntwo\nthree\n", "one\n2\nthree\nfour\n");
    assert.match(r.diff, /^diff --git a\/a\.txt b\/a\.txt\n--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ /);
    assert.match(r.diff, /-two\n\+2/);
    assert.equal(r.added, 2);
    assert.equal(r.removed, 1);
    assert.equal(unifiedDiff("a.txt", "same\n", "same\n").diff, "");
    const created = unifiedDiff("n.txt", "", "x\n");
    assert.match(created.diff, /\+x/);
    assert.equal(created.added, 1);
  });
});

describe("checks", () => {
  test("pass, fail with output, timeout kills the process tree, and the cwd is honored", async () => {
    const dir = scratchDir("chk");
    fs.writeFileSync(path.join(dir, "marker.txt"), "m");
    assert.equal((await runCheck("test -f marker.txt", dir)).status, "pass");
    const fail = await runCheck("echo broken >&2; exit 4", dir);
    assert.equal(fail.status, "fail");
    assert.equal(fail.code, 4);
    assert.match(fail.output, /broken/);
    const slow = await runCheck("sleep 30", dir, { timeoutMs: 150 });
    assert.equal(slow.status, "fail");
    assert.equal(slow.timedOut, true);
    assert.match(slow.output, /timed out/);
    const big = await runCheck("yes x | head -c 200000", dir, { maxOutput: 1000 });
    assert.ok(big.output.length <= 1000);
    assert.equal((await runCheck("true", path.join(dir, "missing-dir"))).status, "fail");
  });
});

describe("metrics", () => {
  const ps = ["  100     1  50000", "  200   100  300000", "  300   200  120000", "  400     1   9000", "garbage", ""].join("\n");

  test("parses ps output and sums descendants, ignoring garbage", () => {
    const rows = parsePs(ps);
    assert.equal(rows.length, 4);
    assert.deepEqual(descendantsOf(rows, 100).map((r) => r.pid).sort(), [200, 300]);
    assert.deepEqual(summarize(rows, { serverPid: 100, copilotPid: 200 }), { serverMb: 49, copilotMb: 293, childrenMb: 117 });
    assert.equal(summarize(rows, { serverPid: 400, copilotPid: null }).copilotMb, null);
  });

  test("a parent loop in ps output cannot hang the walk", () => {
    const rows = [{ pid: 1, ppid: 2, rssKb: 1 }, { pid: 2, ppid: 1, rssKb: 1 }];
    assert.equal(descendantsOf(rows, 1).length, 1);
  });
});

describe("run store", () => {
  test("saves private files atomically, lists them newest first, and rejects bad ids", () => {
    const dir = scratchDir("runs");
    const store = new RunStore(dir);
    const id = newRunId();
    assert.ok(validRunId(id));
    for (const bad of ["../x", "a/b", "", ".", "x".repeat(200), "a b", null, undefined, 5]) assert.equal(validRunId(bad), false, String(bad));
    assert.throws(() => store.save("../evil", []));
    const file = store.save(id, [{ type: "run.started", goal: "Ship it" }, { type: "x" }]);
    assert.equal(path.dirname(file), path.join(dir, ".arcade", "runs"));
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
    fs.writeFileSync(path.join(path.dirname(file), "notes.txt"), "ignored");
    fs.writeFileSync(path.join(path.dirname(file), "broken.json"), "{nope");
    const list = store.list();
    assert.equal(list.find((r) => r.id === id).goal, "Ship it");
    assert.equal(list.find((r) => r.id === id).events, 2);
    assert.ok(list.some((r) => r.id === "broken"), "an unreadable run is still listed");
    assert.equal(list.some((r) => r.id === "notes"), false);
    assert.equal(JSON.parse(store.loadRaw(id)).length, 2);
    assert.equal(store.loadRaw("../../etc/passwd"), null);
    assert.equal(store.loadRaw("nonexistent"), null);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp")), [], "no temp files are left behind");
  });
});
