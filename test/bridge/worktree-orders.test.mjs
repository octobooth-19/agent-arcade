import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { findCycle, parseOrders, resolveDependsOn } from "../../src/order-parser.mjs";
import { commitAll, createWorktree, diffAgainst, ensureExclude, git as gitRaw, identityEnv, mergeBranch, removeWorktree, unmergedWorktrees } from "../../src/worktree.mjs";
import { git, makeRepo, cleanupAll } from "./helpers.mjs";

after(cleanupAll);

describe("order JSON parsing", () => {
  const body = { orders: [{ title: "Add login", ownerRole: "builder", allowedFiles: ["src/login.js"], acceptance: "works", prompt: "Do it", dependsOn: [] }] };

  test("parses a fenced block surrounded by prose", () => {
    const r = parseOrders(`Sure! Here you go:\n\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\`\nHope that helps.`);
    assert.equal(r.ok, true);
    assert.equal(r.orders[0].title, "Add login");
    assert.deepEqual(r.orders[0].allowedFiles, ["src/login.js"]);
  });

  test("parses unfenced JSON, JSON embedded in prose, and a bare array", () => {
    assert.equal(parseOrders(JSON.stringify(body)).ok, true);
    assert.equal(parseOrders(`Plan: ${JSON.stringify(body)} (end)`).ok, true);
    assert.equal(parseOrders(JSON.stringify(body.orders)).orders.length, 1);
  });

  test("normalizes sloppy fields instead of trusting them", () => {
    const r = parseOrders(JSON.stringify({ orders: [{ title: "  T  ", ownerRole: "wizard", allowedFiles: "a.js", prompt: 5, dependsOn: [1, "x", {}] }] }));
    assert.equal(r.ok, true);
    const o = r.orders[0];
    assert.equal(o.title, "T");
    assert.equal(o.ownerRole, "builder", "unknown roles fall back to builder");
    assert.ok(Array.isArray(o.allowedFiles));
    assert.deepEqual(o.dependsOn, [1, "x"]);
  });

  test("rejects garbage without throwing", () => {
    for (const text of ["", "   ", "no json here", "{not json", '{"orders": []}', '{"orders": "nope"}', '{"other": 1}', null, 42, "```json\n```"]) {
      const r = parseOrders(text);
      assert.equal(r.ok, false, `should reject ${JSON.stringify(text)}`);
      assert.equal(typeof r.error, "string");
    }
  });

  test("caps the number of orders", () => {
    const many = { orders: Array.from({ length: 30 }, (_, i) => ({ title: `Order ${i}`, ownerRole: "builder" })) };
    const r = parseOrders(JSON.stringify(many));
    assert.equal(r.ok, true);
    assert.ok(r.orders.length <= 12);
    assert.ok(r.warnings.length > 0);
  });

  test("resolves dependsOn positions and titles, and drops unknown or self references", () => {
    const orders = [{ title: "A", dependsOn: [] }, { title: "B", dependsOn: [1, "a", 9] }, { title: "C", dependsOn: ["C", 2] }];
    assert.deepEqual(resolveDependsOn(orders, ["o1", "o2", "o3"]), [[], ["o1"], ["o2"]]);
  });

  test("finds dependency cycles", () => {
    assert.equal(findCycle(new Map([["a", ["b"]], ["b", ["c"]], ["c", []]])), null);
    assert.ok(findCycle(new Map([["a", ["b"]], ["b", ["a"]]])));
    assert.ok(findCycle(new Map([["a", ["a"]]])));
  });
});

describe("worktrees and merging", () => {
  test("creates a worktree on its own branch, collects a diff, merges with --no-ff, then removes it", async () => {
    const root = makeRepo({ "a.txt": "one\n" });
    await ensureExclude(root);
    const env = await identityEnv(root);
    const wt = await createWorktree({ root, projectDir: root, runId: "run1", workerId: "w1" });
    assert.ok(wt.path.startsWith(path.join(root, ".arcade", "worktrees")));
    assert.equal(wt.branch, "arcade/run1/w1");
    assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "HEAD"), "arcade/run1/w1");

    fs.writeFileSync(path.join(wt.path, "b.txt"), "two\n");
    fs.appendFileSync(path.join(wt.path, "a.txt"), "more\n");
    const commit = await commitAll(wt.path, "Arcade: w1", env);
    assert.equal(commit.committed, true);
    assert.equal((await commitAll(wt.path, "again", env)).committed, false, "nothing left to commit");

    const d = await diffAgainst(wt.path, wt.baseSha);
    assert.deepEqual(d.files.map((f) => f.path).sort(), ["a.txt", "b.txt"]);
    assert.match(d.diff, /\+two/);
    assert.equal(d.files.find((f) => f.path === "a.txt").added, 1);

    assert.equal(fs.existsSync(path.join(root, "b.txt")), false, "the main checkout is untouched until approval");
    const left = await unmergedWorktrees({ root, projectDir: root });
    assert.equal(left.length, 1);
    assert.equal(left[0].commitsAhead, 1);

    const merged = await mergeBranch({ root, branch: wt.branch, message: "Merge w1", env });
    assert.equal(merged.ok, true, merged.message);
    assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "two\n");
    assert.equal(git(root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "a real merge commit (two parents)");
    assert.equal(git(root, "log", "-1", "--format=%s"), "Merge w1");

    const removed = await removeWorktree({ root, path: wt.path, branch: wt.branch });
    assert.equal(removed.ok, true, removed.message);
    assert.equal(fs.existsSync(wt.path), false);
    assert.equal(git(root, "branch", "--list", wt.branch), "");
    assert.equal((await unmergedWorktrees({ root, projectDir: root })).length, 0);
  });

  test("a conflicting merge is aborted and leaves the project exactly as it was", async () => {
    const root = makeRepo({ "a.txt": "base\n" });
    const env = await identityEnv(root);
    const wt = await createWorktree({ root, projectDir: root, runId: "run2", workerId: "w1" });
    fs.writeFileSync(path.join(wt.path, "a.txt"), "from agent\n");
    await commitAll(wt.path, "agent", env);

    fs.writeFileSync(path.join(root, "a.txt"), "from human\n");
    git(root, "commit", "-qam", "human edit");
    const head = git(root, "rev-parse", "HEAD");

    const r = await mergeBranch({ root, branch: wt.branch, message: "Merge w1", env });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "conflict");
    assert.deepEqual(r.conflicts, ["a.txt"]);
    assert.equal(git(root, "rev-parse", "HEAD"), head, "HEAD did not move");
    assert.equal(git(root, "status", "--porcelain", "--untracked-files=no"), "", "the working tree is clean again");
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "from human\n");
    assert.equal((await gitRaw(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code, 1, "no merge left in progress");

    const kept = await removeWorktree({ root, path: wt.path, branch: wt.branch });
    assert.equal(kept.ok, false, "an unmerged worktree is never removed");
    assert.equal(fs.existsSync(wt.path), true);
  });

  test("refuses to merge into a dirty tree and does not touch the user's edits", async () => {
    const root = makeRepo({ "a.txt": "base\n", "b.txt": "b\n" });
    const env = await identityEnv(root);
    const wt = await createWorktree({ root, projectDir: root, runId: "run3", workerId: "w1" });
    fs.writeFileSync(path.join(wt.path, "b.txt"), "agent\n");
    await commitAll(wt.path, "agent", env);

    fs.writeFileSync(path.join(root, "a.txt"), "my unsaved thoughts\n");
    const head = git(root, "rev-parse", "HEAD");
    const r = await mergeBranch({ root, branch: wt.branch, message: "Merge", env });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "dirty");
    assert.equal(git(root, "rev-parse", "HEAD"), head);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "my unsaved thoughts\n");
    assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "b\n");
  });

  test("refuses on a detached HEAD", async () => {
    const root = makeRepo({ "a.txt": "base\n" });
    const env = await identityEnv(root);
    const wt = await createWorktree({ root, projectDir: root, runId: "run4", workerId: "w1" });
    fs.writeFileSync(path.join(wt.path, "n.txt"), "n\n");
    await commitAll(wt.path, "agent", env);
    git(root, "checkout", "-q", "--detach");
    const r = await mergeBranch({ root, branch: wt.branch, message: "Merge", env });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "detached");
  });

  test("a worktree without any change is reported as nothing new, not as an error", async () => {
    const root = makeRepo({ "a.txt": "base\n" });
    const env = await identityEnv(root);
    const wt = await createWorktree({ root, projectDir: root, runId: "run5", workerId: "w1" });
    const r = await mergeBranch({ root, branch: wt.branch, message: "Merge", env });
    assert.equal(r.ok, true);
    assert.match(r.message, /Nothing new/);
  });
});
