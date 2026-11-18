import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { cleanupAll, git, leadReply, makeRepo, order, runOrders, scratchDir, sleep, startLive } from "./helpers.mjs";

after(cleanupAll);

/** Waits until the fake agent has received the worker prompt for an order. */
const started = (h, title) =>
  h.waitLog((e) => e.event === "in" && e.msg.method === "session/prompt" && e.msg.params.prompt[0].text.includes(title), `the prompt for "${title}"`);
const reviews = (h) => Object.values(h.state.reviews);
const wid = (h, title) => h.workerFor(title).id;
const note = (h, id, kind) => h.state.workers[id].notes.filter((n) => n.kind === kind);

describe("hold and resume", () => {
  test("Hold is a cancel: queued until the agent confirms, then held; Resume sends a new continue prompt", async () => {
    const o = order("Slow one", "[[fake:sleep 5000]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    await started(h, "Slow one");
    const id = wid(h, "Slow one");

    const res = await h.cmd("hold", { workerId: id });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.data.delivery, "queued");
    assert.equal(note(h, id, "hold").at(-1).delivery, "queued", "the receipt starts as queued");
    assert.equal(h.state.workers[id].status, "working", "not held until the agent confirms");
    assert.match(h.state.workers[id].now, /next safe point/);

    await h.waitFor((s) => s.workers[id].status === "held", "held");
    assert.equal(note(h, id, "hold").at(-1).delivery, "delivered");
    assert.equal(h.cancels(), 1, "exactly one session/cancel was sent");
    assert.equal((await h.cmd("hold", { workerId: id })).ok, false, "already held");
    assert.equal((await h.cmd("handBack", { workerId: id })).ok, false);

    const before = h.prompts().length;
    assert.equal((await h.cmd("resume", { workerId: id })).ok, true);
    await h.waitFor(() => reviews(h).length === 1, "a review after resuming");
    assert.equal(h.prompts().length, before + 1);
    assert.equal(h.prompts().at(-1).text, "Please continue where you left off.");
    assert.equal(note(h, id, "resume").length, 1);
    assert.equal(h.state.workers[id].status, "done");
  });

  test("a queued worker is held immediately and keeps its place after Resume", async () => {
    const a = order("First slow", "[[fake:sleep 5000]]");
    const b = order("Second");
    const h = await startLive({ maxConcurrent: 1, env: { FAKE_LEAD_REPLY: leadReply([a, b]) } });
    await runOrders(h, [a, b]);
    await started(h, "First slow");
    const A = wid(h, "First slow");
    const B = wid(h, "Second");
    assert.equal(h.state.workers[B].status, "queued");
    assert.equal(h.state.workers[B].queuedReason, "Stage door: 1 agent at a time");
    assert.equal(h.state.workers[B].now, "Waiting at the stage door".length ? "Stage door: 1 agent at a time" : "");

    const held = await h.cmd("hold", { workerId: B });
    assert.equal(held.data.delivery, "delivered", "nothing was running, so the hold is instant");
    assert.equal(h.state.workers[B].status, "held");
    assert.equal(h.prompts().filter((p) => p.text.includes("Second")).length, 0, "a held, never-started worker is not prompted");

    assert.equal((await h.cmd("resume", { workerId: B })).ok, true);
    assert.equal(h.state.workers[B].status, "queued");
    assert.equal(h.state.workers[B].queuedReason, "Stage door: 1 agent at a time");

    await h.cmd("hold", { workerId: A });
    await h.waitFor((s) => s.workers[A].status === "held", "A held");
    assert.equal(h.state.workers[B].status, "queued", "a held agent keeps its stage-door slot");
    await h.cmd("resume", { workerId: A });
    await h.waitFor(() => reviews(h).length === 2, "both reviews");
    assert.equal(h.prompts().filter((p) => p.text.includes("Second")).length, 1);
  });

  test("Hold all stops running agents, blocks the stage door, and Resume all restarts them", async () => {
    const a = order("First slow", "[[fake:sleep 5000]]");
    const b = order("Second");
    const h = await startLive({ maxConcurrent: 1, env: { FAKE_LEAD_REPLY: leadReply([a, b]) } });
    await runOrders(h, [a, b]);
    await started(h, "First slow");
    const A = wid(h, "First slow");
    const B = wid(h, "Second");

    assert.equal((await h.cmd("holdAll")).ok, true);
    assert.equal(h.state.holdAll, true);
    await h.waitFor((s) => s.workers[A].status === "held", "A held");
    assert.equal(h.state.workers[B].queuedReason, "Hold all is on");
    assert.equal(note(h, A, "hold").at(-1).delivery, "delivered");

    assert.equal((await h.cmd("resumeAll")).ok, true);
    assert.equal(h.state.holdAll, false);
    await h.waitFor(() => reviews(h).length === 2, "both reviews after Resume all");
    assert.equal(h.state.workers[B].status, "done");
  });

  test("Resume all arriving while the Hold-all cancel is still in flight does not strand the worker", async () => {
    const a = order("Only slow", "[[fake:sleep 5000]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([a]) } });
    await runOrders(h, [a]);
    await started(h, "Only slow");
    await h.cmd("holdAll");
    await h.cmd("resumeAll");
    await h.waitFor(() => reviews(h).length === 1, "the worker finishing instead of staying held");
  });
});

describe("nudge and redirect", () => {
  test("Nudge never interrupts: queued, sent as the next prompt after the turn ends, then delivered", async () => {
    const o = order("Napper", "[[fake:sleep 600]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    await started(h, "Napper");
    const id = wid(h, "Napper");
    const before = h.prompts().length;

    const res = await h.cmd("nudge", { workerId: id, text: "also write [[fake:write nudged.txt n\\n]]" });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.data.delivery, "queued");
    await sleep(150);
    assert.equal(h.prompts().length, before, "no extra prompt while the turn is running");
    assert.equal(h.cancels(), 0);
    assert.equal(note(h, id, "nudge").at(-1).delivery, "queued");

    await h.waitFor((s) => s.workers[id].notes.find((n) => n.kind === "nudge")?.delivery === "delivered", "the nudge being delivered");
    assert.equal(h.prompts().length, before + 1);
    assert.match(h.prompts().at(-1).text, /Note from the human lead/);
    assert.match(h.prompts().at(-1).text, /also write/);
    await h.waitFor(() => reviews(h).length === 1, "review");
    assert.ok(reviews(h)[0].files.some((f) => f.path === "nudged.txt"), "the agent acted on the nudge");
    assert.equal((await h.cmd("nudge", { workerId: id, text: "too late" })).ok, false, "a finished worker cannot take a note");
    assert.equal((await h.cmd("nudge", { workerId: id, text: "  " })).ok, false);
  });

  test("Redirect is immediate: a new prompt pre-empts the running turn without a cancel or a hold", async () => {
    const o = order("Long task", "[[fake:sleep 5000]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    await started(h, "Long task");
    const id = wid(h, "Long task");
    const before = h.prompts().length;

    const res = await h.cmd("redirect", { workerId: id, text: "do this instead [[fake:write redirected.txt r\\n]]" });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.data.delivery, "queued", "queued until the previous turn is confirmed ended");
    await h.waitFor(() => h.prompts().length === before + 1, "the redirect prompt");
    assert.match(h.prompts().at(-1).text, /New instruction from the human lead/);
    assert.equal(h.cancels(), 0, "a redirect is a prompt, not a session/cancel");

    await h.waitFor(() => reviews(h).length === 1, "review");
    assert.equal(note(h, id, "redirect").at(-1).delivery, "delivered");
    assert.ok(reviews(h)[0].files.some((f) => f.path === "redirected.txt"));
    assert.ok(!h.events.some((e) => e.type === "worker.status" && e.id === id && e.status === "held"), "the pre-empted turn ending as cancelled is not a hold");
    assert.equal(h.state.inbox.filter((i) => i.open && i.workerId === id && i.kind !== "review").length, 0);
  });

  test("Redirect of a held worker sends the new instruction at once", async () => {
    const o = order("Held then redirected", "[[fake:sleep 5000]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    await started(h, "Held then");
    const id = wid(h, "Held then redirected");
    await h.cmd("hold", { workerId: id });
    await h.waitFor((s) => s.workers[id].status === "held", "held");
    const res = await h.cmd("redirect", { workerId: id, text: "go [[fake:write r.txt r\\n]]" });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.data.delivery, "delivered");
    await h.waitFor(() => reviews(h).length === 1, "review");
    assert.ok(reviews(h)[0].files.some((f) => f.path === "r.txt"));
  });
});

describe("take over and hand back", () => {
  test("Take over cancels, then the human edits the worktree; Hand back re-prompts and the edits reach the review", async () => {
    const o = order("Driven", "[[fake:sleep 5000]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    await started(h, "Driven");
    const id = wid(h, "Driven");

    const res = await h.cmd("takeOver", { workerId: id });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.data.delivery, "queued");
    await h.waitFor((s) => s.workers[id].status === "held" && s.workers[id].takeover, "taken over");
    assert.equal(note(h, id, "takeover").at(-1).delivery, "delivered");
    assert.match((await h.cmd("resume", { workerId: id })).error, /Hand back/);
    assert.match((await h.cmd("redirect", { workerId: id, text: "x" })).error, /Hand back/);
    assert.match((await h.cmd("takeOver", { workerId: id })).error, /Already in your hands/);

    fs.writeFileSync(path.join(h.state.workers[id].worktree.path, "human.txt"), "mine\n");
    const before = h.prompts().length;
    assert.equal((await h.cmd("handBack", { workerId: id })).ok, true);
    assert.equal(h.state.workers[id].takeover, false);
    await h.waitFor(() => reviews(h).length === 1, "review");
    assert.equal(h.prompts().length, before + 1);
    assert.match(h.prompts().at(-1).text, /finished working in this directory/);
    assert.ok(reviews(h)[0].files.some((f) => f.path === "human.txt"), "the human's edit is part of the diff");
    assert.match((await h.cmd("handBack", { workerId: id })).error, /not in your hands/);
  });

  test("Take over of a queued worker is instant", async () => {
    const a = order("Busy", "[[fake:sleep 5000]]");
    const b = order("Waiting");
    const h = await startLive({ maxConcurrent: 1, env: { FAKE_LEAD_REPLY: leadReply([a, b]) } });
    await runOrders(h, [a, b]);
    await started(h, "Busy");
    const B = wid(h, "Waiting");
    const res = await h.cmd("takeOver", { workerId: B });
    assert.equal(res.data.delivery, "delivered");
    assert.equal(h.state.workers[B].takeover, true);
    assert.equal(h.state.workers[B].status, "held");
  });
});

describe("stage door and dependencies", () => {
  test("maxConcurrent queues with exact reasons; dependsOn waits for approval, not just completion", async () => {
    const a = order("Alpha", "[[fake:sleep 300]]");
    const b = order("Beta", "", { dependsOn: ["Alpha"] });
    const c = order("Gamma", "[[fake:sleep 200]]");
    const h = await startLive({ maxConcurrent: 1, env: { FAKE_LEAD_REPLY: leadReply([a, b, c]) } });
    await runOrders(h, [a, b, c]);
    const [A, B, C] = ["Alpha", "Beta", "Gamma"].map((t) => wid(h, t));
    assert.equal(h.state.workers[A].status, "working");
    assert.equal(h.state.workers[B].queuedReason, 'Waiting for "Alpha" to be approved');
    assert.equal(h.state.workers[C].queuedReason, "Stage door: 1 agent at a time");

    await h.waitFor((s) => s.workers[A].status === "done", "Alpha reviewed");
    await h.waitFor((s) => s.workers[C].status === "done", "Gamma reviewed (it was not blocked by Beta)");
    assert.equal(h.state.workers[B].status, "queued", "Beta still waits: Alpha is reviewed but not approved");
    assert.equal(h.state.workers[B].queuedReason, 'Waiting for "Alpha" to be approved');

    const alphaReview = reviews(h).find((r) => r.workerId === A);
    assert.equal((await h.cmd("approveReview", { reviewId: alphaReview.id })).ok, true);
    await h.waitFor((s) => s.workers[B].status === "done", "Beta reviewed once Alpha shipped");
  });

  test("raising and lowering the stage-door limit takes effect immediately", async () => {
    const a = order("One", "[[fake:sleep 5000]]");
    const b = order("Two", "[[fake:sleep 5000]]");
    const c = order("Three", "[[fake:sleep 5000]]");
    const h = await startLive({ maxConcurrent: 1, env: { FAKE_LEAD_REPLY: leadReply([a, b, c]) } });
    await runOrders(h, [a, b, c]);
    const [A, B, C] = ["One", "Two", "Three"].map((t) => wid(h, t));
    assert.equal(h.state.workers[B].queuedReason, "Stage door: 1 agent at a time");

    assert.equal((await h.cmd("setMaxConcurrent", { value: 2 })).ok, true);
    assert.equal(h.state.maxConcurrent, 2);
    assert.equal(h.state.workers[B].status, "working");
    assert.equal(h.state.workers[C].queuedReason, "Stage door: 2 agents at a time");
    assert.equal((await h.cmd("setMaxConcurrent", { value: 3 })).ok, true);
    assert.equal(h.state.workers[C].status, "working");
    assert.equal(h.state.workers[A].status, "working");
    assert.equal((await h.cmd("setMaxConcurrent", { value: 0 })).ok, false);
    assert.equal((await h.cmd("setMaxConcurrent", { value: 7 })).ok, false);
    assert.equal(h.state.maxConcurrent, 3);
    assert.equal(h.state.workerOrder.filter((id) => h.state.workers[id].status === "working" && id !== "lead").length, 3);
  });

  test("a project that is not a git repository runs agents one at a time, in place, with nothing to merge", async () => {
    const dir = scratchDir("plain");
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    const a = order("Plain A", "[[fake:write p1.txt one\\n]]");
    const b = order("Plain B", "[[fake:write p2.txt two\\n]]");
    const h = await startLive({ projectDir: dir, maxConcurrent: 3, env: { FAKE_LEAD_REPLY: leadReply([a, b]) } });
    assert.equal(h.state.maxConcurrent, 1);
    assert.equal(h.orch.health().project.isGit, false);
    const refused = await h.cmd("setMaxConcurrent", { value: 2 });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /one at a time/);
    await runOrders(h, [a, b]);
    await h.waitFor(() => reviews(h).length === 2, "both reviews");
    assert.equal(h.state.workers[wid(h, "Plain A")].worktree, null);
    assert.equal(fs.existsSync(path.join(dir, "p1.txt")), true, "work lands in the project folder directly");
    const res = await h.cmd("approveReview", { reviewId: reviews(h)[0].id });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.data.merged, false);
  });
});

describe("suggestions", () => {
  test("suggestions are validated; accepting one creates a new proposed order that needs approval", async () => {
    const o = order("Base");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    const early = await h.cmd("suggest", { text: "make it blue", from: "Sam" });
    assert.equal(early.ok, true);
    assert.equal((await h.cmd("resolveSuggestion", { id: early.data.id, decision: "accept" })).ok, false, "no goal yet");
    assert.equal(h.state.suggestions[early.data.id].status, "open");

    await runOrders(h, [o]);
    await h.waitFor(() => reviews(h).length === 1, "review");
    assert.equal((await h.cmd("suggest", { text: "" })).ok, false);
    assert.equal((await h.cmd("suggest", { text: "x".repeat(201) })).ok, false);
    const s2 = await h.cmd("suggest", { text: "add a dark mode [[fake:write dark.txt d\\n]]", from: "Alex\n\u0000" });
    assert.equal(h.state.suggestions[s2.data.id].from, "Alex");

    const accepted = await h.cmd("resolveSuggestion", { id: s2.data.id, decision: "accept" });
    assert.equal(accepted.ok, true, accepted.error);
    assert.equal(h.state.suggestions[s2.data.id].status, "accepted");
    const created = h.state.orders[accepted.data.orderId];
    assert.equal(created.status, "proposed", "accepting does not start anything by itself");
    assert.equal(h.state.batch.status, "proposed");
    assert.equal(Object.keys(h.state.workers).length, 2, "no new worker yet (Lead + Base)");
    assert.equal((await h.cmd("resolveSuggestion", { id: s2.data.id, decision: "accept" })).ok, false, "already decided");

    assert.equal((await h.cmd("approveBatch")).ok, true);
    await h.waitFor(() => reviews(h).length === 2, "the suggestion's review");
    assert.ok(reviews(h).some((r) => r.files.some((f) => f.path === "dark.txt")));

    const s3 = await h.cmd("suggest", { text: "rewrite everything in Rust" });
    assert.equal((await h.cmd("resolveSuggestion", { id: s3.data.id, decision: "reject" })).ok, true);
    assert.equal(h.state.suggestions[s3.data.id].status, "rejected");
    assert.equal((await h.cmd("resolveSuggestion", { id: s3.data.id, decision: "maybe" })).ok, false);
  });
});

describe("reset", () => {
  test("reset saves the run, keeps unmerged worktrees, and allows a fresh delegate", async () => {
    const o = order("Keeper", "[[fake:write keep.txt k\\n]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    await h.waitFor(() => reviews(h).length === 1, "review");
    const w = h.workerFor("Keeper");
    const wtPath = w.worktree.path;
    const runId = h.orch.runId;
    assert.ok(runId);

    const res = await h.cmd("reset");
    assert.equal(res.ok, true, res.error);
    assert.equal(h.state.goal, null);
    assert.deepEqual(Object.keys(h.state.workers), ["lead"]);
    assert.equal(fs.existsSync(wtPath), true, "reset never deletes an unmerged worktree");
    assert.match(h.state.connection.message, /1 unmerged worktree/);

    const file = path.join(h.projectDir, ".arcade", "runs", `${runId}.json`);
    assert.equal(fs.existsSync(file), true);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600, "run files are private to the user");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(Array.isArray(saved) && saved.some((e) => e.type === "review.ready") && saved.some((e) => e.type === "run.started"));
    assert.ok(!saved.some((e) => e.type === "metrics"), "measurement samples are not persisted");
    assert.match(fs.readFileSync(path.join(h.projectDir, ".git", "info", "exclude"), "utf8"), /\.arcade/);
    assert.equal(git(h.projectDir, "status", "--porcelain", "--untracked-files=all"), "", ".arcade never shows up as an untracked change");

    const again = await h.cmd("delegate", { goal: "second run" });
    assert.equal(again.ok, true, again.error);
    assert.notEqual(again.data.runId, runId);
    await h.waitFor((s) => s.batch.status === "proposed", "a new batch");
  });
});

describe("failures", () => {
  test("a JSON-RPC error fails the worker with an inbox question; Resume retries on the same session", async () => {
    const o = order("Flaky", "[[fake:fail boom]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    await h.waitFor((s) => Object.values(s.workers).some((w) => w.status === "failed"), "a failed worker");
    const id = wid(h, "Flaky");
    assert.match(h.state.workers[id].now, /boom/);
    assert.ok(h.state.inbox.some((i) => i.open && i.workerId === id && /boom/.test(i.summary)));
    assert.equal((await h.cmd("hold", { workerId: id })).ok, false);
    assert.equal((await h.cmd("resume", { workerId: id })).ok, true);
    await h.waitFor(() => reviews(h).length === 1, "review after the retry");
    assert.equal(h.state.inbox.filter((i) => i.open && i.workerId === id && i.kind === "question").length, 0);
    assert.equal(h.prompts().at(-1).text, "Please continue where you left off.");
  });

  test("an odd stop reason blocks the worker and asks the human; Resume continues", async () => {
    const o = order("Truncated", "[[fake:stop max_tokens]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    const id = wid(h, "Truncated");
    await h.waitFor((s) => s.workers[id].status === "blocked", "blocked");
    assert.match(h.state.workers[id].now, /max_tokens/);
    assert.ok(h.state.inbox.some((i) => i.open && i.workerId === id));
    assert.equal((await h.cmd("resume", { workerId: id })).ok, true);
    await h.waitFor(() => reviews(h).length === 1, "review");
  });

  test("a failing check can be fixed through Redirect and then passes into review", async () => {
    const o = order("Needs file", "[[fake:write other.txt x\\n]]");
    const h = await startLive({ check: "test -f fixed.txt", env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    const id = wid(h, "Needs file");
    await h.waitFor((s) => s.workers[id].status === "blocked", "blocked by the check");
    assert.equal((await h.cmd("redirect", { workerId: id, text: "[[fake:write fixed.txt f\\n]]" })).ok, true);
    await h.waitFor(() => reviews(h).length === 1, "review after the fix");
    assert.equal(reviews(h)[0].checks.at(-1).status, "pass");
  });

  test("the agent process dying is reported, not fatal: workers fail and the UI shows the connection error", async () => {
    const o = order("Doomed", "[[fake:crash]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    const id = wid(h, "Doomed");
    await h.waitFor((s) => s.workers[id].status === "failed", "the worker to fail");
    assert.notEqual(h.state.connection.state, "ready");
    assert.ok(h.state.inbox.some((i) => i.open && i.workerId === id));
    assert.equal(h.orch.snapshot().type, "snapshot", "the bridge itself is still serving state");
  });
});

describe("open in VS Code", () => {
  function fakeCode() {
    const dir = scratchDir("code");
    const log = path.join(dir, "args.json");
    const bin = path.join(dir, "code");
    fs.writeFileSync(bin, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
    fs.chmodSync(bin, 0o755);
    return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []) };
  }

  test("opens a project file at a line with -g, and refuses anything outside the project", async () => {
    const code = fakeCode();
    const h = await startLive({ code: code.bin });
    const real = fs.realpathSync(path.join(h.projectDir, "README.md"));
    assert.equal((await h.cmd("openInVSCode", { path: "README.md", line: 3 })).ok, true);
    for (let i = 0; i < 100 && !code.calls().length; i++) await sleep(20);
    assert.deepEqual(code.calls()[0], ["-g", `${real}:3`]);

    for (const bad of [{ path: "../outside.txt" }, { path: "/etc/hosts" }, { path: "nope.txt" }, { path: "README.md", line: "3" }, { path: "README.md", line: -1 }, { path: "" }, {}, { path: "README.md", workerId: "ghost" }]) {
      assert.equal((await h.cmd("openInVSCode", bad)).ok, false, JSON.stringify(bad));
    }
    await sleep(100);
    assert.equal(code.calls().length, 1, "refused requests never start a process");
  });

  test("a missing `code` command gives a helpful message", async () => {
    const h = await startLive({ code: path.join(scratchDir("nocode"), "code") });
    const res = await h.cmd("openInVSCode", { path: "README.md" });
    assert.equal(res.ok, false);
    assert.match(res.error, /code/);
  });
});
