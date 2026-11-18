import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { cleanupAll, git, leadReply, makeRepo, order, runOrders, scratchDir, sleep, startLive } from "./helpers.mjs";

after(cleanupAll);

const reviewOf = (h, title) => Object.values(h.state.reviews).find((r) => h.state.orders[r.orderId]?.title === title);

describe("startup and health", () => {
  test("connects to the agent, seats the Lead, and reports health", async () => {
    const h = await startLive();
    assert.equal(h.state.source, "live");
    assert.equal(h.state.connection.state, "ready");
    assert.ok(h.state.workers.lead);
    assert.equal(h.state.workers.lead.role, "lead");
    const health = h.orch.health();
    assert.equal(health.copilot.found, true);
    assert.equal(health.copilot.loggedIn, true);
    assert.match(health.copilot.version, /Fake Copilot/);
    assert.equal(health.loginCommand, "fake-copilot login");
    assert.equal(health.project.isGit, true);
    assert.equal(h.orch.snapshot().type, "snapshot");
    assert.equal(h.orch.snapshot().state.workers.lead.id, "lead");
  });

  test("a command sent while Copilot is still connecting waits for the connection instead of failing", async () => {
    const h = await startLive({ env: { FAKE_ACP_INIT_DELAY_MS: "300", FAKE_LEAD_REPLY: leadReply([order("Only order")]) }, awaitConnect: false });
    assert.notEqual(h.state.connection.state, "ready");
    const res = await h.cmd("delegate", { goal: "early goal" });
    assert.equal(res.ok, true, res.error);
    assert.equal(h.state.connection.state, "ready");
    await h.waitFor((s) => s.batch.status === "proposed", "the Lead's batch");
  });

  test("an auth failure is reported as loggedIn:false with the login command", async () => {
    const h = await startLive({ env: { FAKE_ACP_AUTH_FAIL: "1" } });
    assert.equal(h.orch.health().copilot.loggedIn, false);
    assert.equal(h.state.connection.state, "error");
    assert.match(h.state.connection.message, /fake-copilot login/);
    const res = await h.cmd("delegate", { goal: "anything" });
    assert.equal(res.ok, false);
    assert.match(res.error, /not signed in|login/i);
  });

  test("a missing copilot binary still leaves the UI usable and explains why", async () => {
    const h = await startLive({ copilot: { command: path.join(scratchDir("nobin"), "no-such-copilot"), prefixArgs: [], env: {} } });
    const health = h.orch.health();
    assert.equal(health.copilot.found, false);
    assert.equal(health.copilot.loggedIn, "unknown");
    assert.equal(h.state.connection.state, "error");
    assert.match(h.state.connection.message, /not found/);
    assert.equal((await h.cmd("delegate", { goal: "x" })).ok, false);
    assert.equal(h.orch.health().project.name, path.basename(h.projectDir));
  });

  test("an unrelated startup failure leaves loggedIn as unknown, not false", async () => {
    // initialize works but session/new gets a non-auth error: simulate with a model list that makes nothing fail,
    // and a broken executable that exits immediately after --version
    const dir = scratchDir("flaky");
    const script = path.join(dir, "flaky.mjs");
    fs.writeFileSync(script, 'if (process.argv.includes("--version")) { console.log("flaky 1"); process.exit(0); }\nprocess.exit(1);\n');
    const h = await startLive({ copilot: { command: process.execPath, prefixArgs: [script], env: {} } });
    assert.equal(h.orch.health().copilot.found, true);
    assert.equal(h.orch.health().copilot.loggedIn, "unknown");
    assert.equal(h.state.connection.state, "error");
  });

  test("unknown commands and bad payloads are refused without throwing", async () => {
    const h = await startLive();
    assert.deepEqual(await h.cmd("format-disk"), { ok: false, error: "Unknown command: format-disk", unknown: true });
    for (const name of ["constructor", "__proto__", "toString"]) assert.equal((await h.cmd(name)).ok, false);
    assert.equal((await h.cmd("hold", { workerId: "nobody" })).ok, false);
    assert.equal((await h.cmd("hold", { workerId: "__proto__" })).ok, false);
    assert.equal((await h.cmd("approveReview", { reviewId: "constructor" })).ok, false);
    assert.equal((await h.cmd("resolveSuggestion", { id: "toString", decision: "accept" })).ok, false);
    assert.equal((await h.cmd("setMaxConcurrent", { value: 99 })).ok, false);
    assert.equal((await h.cmd("setMaxConcurrent", { value: "3" })).ok, false);
    assert.equal((await h.cmd("delegate", { goal: "   " })).ok, false);
    assert.equal((await h.cmd("approveBatch")).ok, false);
    assert.equal((await h.cmd("hold", null)).ok, false);
  });
});

describe("delegate, batch and review", () => {
  test("Lead orders become a proposed batch, approval starts workers in worktrees, review shows a diff, approve merges", async () => {
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([order("Hello file", "[[fake:write hello.txt hi\\n]]"), order("Notes file", "[[fake:write notes.txt n\\n]]")]) } });
    const res = await h.cmd("delegate", { goal: "create hello.txt containing hi" });
    assert.equal(res.ok, true);
    await h.waitFor((s) => s.batch.status === "proposed", "batch.proposed");
    assert.equal(h.state.orderOrder.length, 2);
    assert.ok(h.state.orderOrder.every((id) => h.state.orders[id].status === "proposed"));
    assert.equal(Object.keys(h.state.workers).length, 1, "no workers exist before the batch is approved");
    assert.equal(h.state.inbox.filter((i) => i.kind === "batch" && i.open).length, 1);
    assert.equal(h.state.workers.lead.status, "idle");
    assert.equal(h.prompts().length, 1, "only the Lead has been prompted");

    assert.equal((await h.cmd("approveBatch")).ok, true);
    await h.waitFor((s) => Object.keys(s.reviews).length === 2, "two reviews");
    const r1 = reviewOf(h, "Hello file");
    assert.match(r1.diff, /\+\+\+ b\/hello\.txt/);
    assert.match(r1.diff, /\+hi/);
    assert.deepEqual(r1.files.map((f) => f.path), ["hello.txt"]);
    assert.equal(r1.files[0].added, 1);
    const w1 = h.state.workers[r1.workerId];
    assert.equal(w1.status, "done", "a worker waiting for review is done in the reducer's vocabulary");
    assert.ok(w1.worktree.path.includes(path.join(".arcade", "worktrees")), "builders work in their own worktree");
    assert.match(w1.worktree.branch, /^arcade\//);
    assert.ok(w1.files.some((f) => f.path === "hello.txt"));
    assert.equal(fs.existsSync(path.join(h.projectDir, "hello.txt")), false, "nothing reaches the project before approval");
    assert.equal(git(h.projectDir, "status", "--porcelain", "--untracked-files=no"), "");

    const approved = await h.cmd("approveReview", { reviewId: r1.id });
    assert.equal(approved.ok, true, approved.error);
    assert.equal(approved.data.merged, true);
    assert.equal(fs.readFileSync(path.join(h.projectDir, "hello.txt"), "utf8"), "hi\n");
    assert.equal(h.state.reviews[r1.id].status, "approved");
    assert.equal(h.state.reviews[r1.id].mergeResult.ok, true);
    assert.equal(h.state.orders[r1.orderId].status, "shipped");
    assert.equal(h.state.workers[r1.workerId].status, "done");
    assert.equal(h.state.workers[r1.workerId].worktree, null);
    assert.match(git(h.projectDir, "log", "-1", "--format=%P"), /^\S+ \S+$/, "a --no-ff merge commit");
    assert.equal(git(h.projectDir, "branch", "--list", "arcade/*").split("\n").filter(Boolean).length, 1, "the merged branch is deleted, the other remains");
    assert.equal(git(h.projectDir, "remote").trim(), "", "nothing was pushed anywhere");
    assert.equal(h.state.stats.shipped, 1);
  });

  test("the Lead is read-only: its edit request is auto-rejected, never shown, never allowed", async () => {
    const h = await startLive({ env: { FAKE_LEAD_ASK: "1", FAKE_LEAD_REPLY: leadReply([order("Only one")]) } });
    await h.cmd("delegate", { goal: "g" });
    await h.waitFor((s) => s.batch.status === "proposed", "batch");
    assert.deepEqual(Object.keys(h.state.approvals), [], "the human is not asked about the Lead's edit");
    const outcome = h.received().find((e) => e.event === "permission-outcome");
    assert.deepEqual(outcome.outcome, { outcome: "selected", optionId: "reject_once" });
    assert.equal(fs.existsSync(path.join(h.projectDir, "lead-notes.txt")), false);
    assert.ok(h.state.workers.lead.output.some((l) => /read-only/i.test(l)), "the Lead's desk explains the rejection");
  });

  test("an unparseable Lead reply raises a question in the inbox and the human can add orders by hand", async () => {
    const h = await startLive({ env: { FAKE_LEAD_REPLY: "I would rather chat about it. No JSON today." } });
    await h.cmd("delegate", { goal: "g" });
    await h.waitFor((s) => s.inbox.some((i) => i.open), "an inbox item");
    assert.equal(h.state.orderOrder.length, 0);
    assert.notEqual(h.state.batch.status, "approved");
    const add = await h.cmd("addOrder", { order: order("Manual order", "[[fake:write m.txt m\\n]]") });
    assert.equal(add.ok, true);
    assert.equal(h.state.batch.status, "proposed");
    assert.equal((await h.cmd("approveBatch")).ok, true);
    await h.waitFor((s) => Object.keys(s.reviews).length === 1, "the manual order's review");
  });

  test("orders can be edited, removed and validated before approval", async () => {
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([order("A"), order("B"), order("C")]) } });
    await h.cmd("delegate", { goal: "g" });
    await h.waitFor((s) => s.batch.status === "proposed", "batch");
    const [a, b, c] = h.state.orderOrder;
    assert.equal((await h.cmd("updateOrder", { order: { id: a, title: "A renamed", allowedFiles: ["x.js"] } })).ok, true);
    assert.equal(h.state.orders[a].title, "A renamed");
    assert.deepEqual(h.state.orders[a].allowedFiles, ["x.js"]);
    assert.equal((await h.cmd("updateOrder", { order: { id: b, ownerRole: "wizard" } })).ok, false);
    assert.equal((await h.cmd("updateOrder", { order: { id: c, dependsOn: ["nope"] } })).ok, false);
    assert.equal((await h.cmd("updateOrder", { order: { id: b, dependsOn: [c] } })).ok, true);
    assert.equal((await h.cmd("updateOrder", { order: { id: c, dependsOn: [b] } })).ok, false, "a dependency loop is refused");
    assert.equal((await h.cmd("removeOrder", { id: c })).ok, true);
    assert.equal(h.state.orders[c].status, "rejected");
    assert.deepEqual(h.state.orders[b].dependsOn, [], "dependencies on a removed order are dropped");
    assert.equal((await h.cmd("addOrder", { order: { title: "" } })).ok, false);
    assert.equal((await h.cmd("approveBatch")).ok, true);
    await h.waitFor((s) => s.workerOrder.length === 3, "two workers plus the Lead");
    assert.equal((await h.cmd("updateOrder", { order: { id: a, title: "late" } })).ok, false, "approved orders are frozen");
    assert.equal((await h.cmd("approveBatch")).ok, false, "a batch is approved once");
  });

  test("a run can only be delegated once until reset", async () => {
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([order("A")]) } });
    assert.equal((await h.cmd("delegate", { goal: "one" })).ok, true);
    const second = await h.cmd("delegate", { goal: "two" });
    assert.equal(second.ok, false);
    assert.match(second.error, /already in progress/);
  });
});

describe("permission requests", () => {
  const edit = order("Needs approval", "[[fake:askwrite gated.txt secret\\n]]");

  test("a worker's permission request is held until a human answers; allow_once lets it proceed", async () => {
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([edit]) } });
    await runOrders(h, [edit]);
    await h.waitFor((s) => Object.values(s.approvals).some((a) => a.status === "open"), "an open approval");
    const ap = Object.values(h.state.approvals)[0];
    assert.equal(ap.kind, "edit");
    assert.match(ap.diff + ap.detail + ap.title, /gated\.txt/);
    assert.deepEqual(ap.options.map((o) => o.id).sort(), ["allow_always", "allow_once", "reject_once"]);
    const w = h.state.workers[ap.workerId];
    assert.equal(w.status, "waiting_approval");
    assert.ok(h.state.inbox.some((i) => i.id === ap.id && i.open));
    await sleep(300);
    assert.equal(h.state.approvals[ap.id].status, "open", "nothing answers on the human's behalf");
    assert.equal(Object.keys(h.state.reviews).length, 0, "the turn is still blocked");

    assert.equal((await h.cmd("resolveApproval", { approvalId: ap.id, optionId: "bogus" })).ok, false);
    assert.equal((await h.cmd("resolveApproval", { approvalId: ap.id, optionId: "allow_once" })).ok, true);
    assert.equal(h.state.approvals[ap.id].status, "allowed");
    await h.waitFor((s) => Object.keys(s.reviews).length === 1, "the review after approval");
    assert.match(Object.values(h.state.reviews)[0].diff, /\+secret/);
    assert.equal((await h.cmd("resolveApproval", { approvalId: ap.id, optionId: "allow_once" })).ok, false, "already answered");
    assert.equal((await h.waitLog((e) => e.event === "permission-outcome", "a permission outcome")).outcome.optionId, "allow_once");
  });

  test("reject_once denies the request and the agent does not write the file", async () => {
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([edit]) } });
    await runOrders(h, [edit]);
    await h.waitFor((s) => Object.values(s.approvals).some((a) => a.status === "open"), "an open approval");
    const ap = Object.values(h.state.approvals)[0];
    await h.cmd("resolveApproval", { approvalId: ap.id, optionId: "reject_once" });
    assert.equal(h.state.approvals[ap.id].status, "denied");
    assert.equal((await h.waitLog((e) => e.event === "permission-outcome", "a permission outcome")).outcome.optionId, "reject_once");
    await h.waitFor((s) => Object.keys(s.reviews).length === 1 || s.workers[ap.workerId].status === "done", "the worker to wrap up");
    const w = h.state.workers[ap.workerId];
    assert.ok(!w.files.some((f) => f.path === "gated.txt"));
  });

  test("holding a worker that waits for approval cancels the request (never allows it)", async () => {
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([edit]) } });
    await runOrders(h, [edit]);
    await h.waitFor((s) => Object.values(s.approvals).some((a) => a.status === "open"), "an open approval");
    const ap = Object.values(h.state.approvals)[0];
    assert.equal((await h.cmd("hold", { workerId: ap.workerId })).ok, true);
    await h.waitFor((s) => s.workers[ap.workerId].status === "held", "held");
    assert.equal(h.state.approvals[ap.id].status, "cancelled");
    assert.deepEqual((await h.waitLog((e) => e.event === "permission-outcome", "a permission outcome")).outcome, { outcome: "cancelled" });
    assert.equal(h.orch.broker.list().length, 0);
  });
});

describe("approve, send back, hold review", () => {
  async function oneReview(extra = {}) {
    const o = order("Task", "[[fake:write out.txt v1\\n]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) }, ...extra });
    await runOrders(h, [o]);
    await h.waitFor((s) => Object.keys(s.reviews).length === 1, "review");
    return { h, review: Object.values(h.state.reviews)[0] };
  }

  test("approving into a dirty tree is refused, keeps the review open, and changes nothing", async () => {
    const { h, review } = await oneReview();
    fs.appendFileSync(path.join(h.projectDir, "README.md"), "my edit\n");
    const head = git(h.projectDir, "rev-parse", "HEAD");
    const res = await h.cmd("approveReview", { reviewId: review.id });
    assert.equal(res.ok, false);
    assert.match(res.error, /uncommitted changes/);
    assert.equal(git(h.projectDir, "rev-parse", "HEAD"), head);
    assert.equal(h.state.reviews[review.id].status, "held");
    assert.equal(h.state.reviews[review.id].mergeResult.ok, false);
    assert.equal(fs.existsSync(path.join(h.projectDir, "out.txt")), false);
    assert.match(fs.readFileSync(path.join(h.projectDir, "README.md"), "utf8"), /my edit/);
    // once the human commits, the same review can be approved
    git(h.projectDir, "commit", "-qam", "my edit");
    const again = await h.cmd("approveReview", { reviewId: review.id });
    assert.equal(again.ok, true, again.error);
    assert.equal(fs.existsSync(path.join(h.projectDir, "out.txt")), true);
  });

  test("a merge conflict is aborted, reported, and the project stays clean", async () => {
    const o = order("Edit readme", "[[fake:write README.md agent version\\n]]");
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    await h.waitFor((s) => Object.keys(s.reviews).length === 1, "review");
    fs.writeFileSync(path.join(h.projectDir, "README.md"), "human version\n");
    git(h.projectDir, "commit", "-qam", "human");
    const review = Object.values(h.state.reviews)[0];
    const res = await h.cmd("approveReview", { reviewId: review.id });
    assert.equal(res.ok, false);
    assert.match(res.error, /conflict/i);
    assert.equal(git(h.projectDir, "status", "--porcelain", "--untracked-files=no"), "");
    assert.equal(fs.readFileSync(path.join(h.projectDir, "README.md"), "utf8"), "human version\n");
    assert.equal(h.state.reviews[review.id].status, "held");
    assert.equal(h.state.orders[review.orderId].status, "review");
  });

  test("holdReview keeps it open; sendBack prompts the same session and produces a second review", async () => {
    const { h, review } = await oneReview();
    assert.equal((await h.cmd("holdReview", { reviewId: review.id })).ok, true);
    assert.equal(h.state.reviews[review.id].status, "held");
    assert.ok(h.state.inbox.find((i) => i.id === review.id).open, "a held review stays in the inbox");

    const before = h.prompts().length;
    const sent = await h.cmd("sendBack", { reviewId: review.id, text: "Please also write [[fake:write second.txt two\\n]]" });
    assert.equal(sent.ok, true, sent.error);
    assert.equal(h.state.reviews[review.id].status, "sent_back");
    await h.waitFor((s) => Object.keys(s.reviews).length === 2, "a second review");
    const prompts = h.prompts();
    assert.equal(prompts.length, before + 1);
    assert.match(prompts.at(-1).text, /sent it back with this feedback/);
    assert.equal(prompts.at(-1).sessionId, prompts[1].sessionId, "the same ACP session continues");
    const second = Object.values(h.state.reviews).find((r) => r.id !== review.id);
    assert.ok(second.files.some((f) => f.path === "second.txt"));
    assert.ok(h.state.workers[review.workerId].notes.some((n) => n.kind === "redirect" && /also write/.test(n.text) && n.delivery === "delivered"));
    assert.equal((await h.cmd("sendBack", { reviewId: review.id, text: "again" })).ok, false, "a decided review cannot be decided again");
    assert.equal((await h.cmd("sendBack", { reviewId: second.id, text: "  " })).ok, false);
  });

  test("a review of a planner (no worktree) is approved with nothing to merge", async () => {
    const o = order("Investigate", "[[fake:say found nothing]]", { ownerRole: "planner" });
    const h = await startLive({ env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(h, [o]);
    await h.waitFor((s) => Object.keys(s.reviews).length === 1, "review");
    const w = Object.values(h.state.workers).find((x) => x.role === "planner");
    assert.equal(w.worktree ?? null, null);
    const res = await h.cmd("approveReview", { reviewId: Object.keys(h.state.reviews)[0] });
    assert.equal(res.ok, true);
    assert.equal(res.data.merged, false);
  });

  test("a failing check blocks the worker and asks the human; a passing check is recorded on the review", async () => {
    const o = order("Checked", "[[fake:write c.txt c\\n]]");
    const failing = await startLive({ check: "echo nope >&2; exit 3", env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(failing, [o]);
    await failing.waitFor((s) => Object.values(s.workers).some((w) => w.status === "blocked"), "a blocked worker");
    const w = Object.values(failing.state.workers).find((x) => x.role === "builder");
    assert.equal(w.checks.at(-1).status, "fail");
    assert.match(w.checks.at(-1).output, /nope/);
    assert.ok(failing.state.inbox.some((i) => i.open && i.workerId === w.id));
    assert.equal(Object.keys(failing.state.reviews).length, 0, "a failing check never reaches review");

    const passing = await startLive({ check: "test -f c.txt", env: { FAKE_LEAD_REPLY: leadReply([o]) } });
    await runOrders(passing, [o]);
    await passing.waitFor((s) => Object.keys(s.reviews).length === 1, "review");
    const rv = Object.values(passing.state.reviews)[0];
    assert.equal(rv.checks.at(-1).status, "pass");
    assert.equal(passing.state.workers[rv.workerId].checks.at(-1).status, "pass");
  });
});
