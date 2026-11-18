// Live smoke test against the REAL Copilot CLI. It costs a few premium requests (two turns on a cheap model),
// so it only runs when ARCADE_LIVE=1:   ARCADE_LIVE=1 node --test test/bridge/live.test.mjs
// It drives the real bin/arcade.mjs process over its HTTP API, exactly as the browser would.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { createInitialState, reduce } from "../../shared/state.js";
import { ROOT, cleanupAll, git, makeRepo, sleep } from "./helpers.mjs";

const LIVE = process.env.ARCADE_LIVE === "1";
const MODEL = process.env.ARCADE_LIVE_MODEL || "claude-haiku-4.5";

after(cleanupAll);

test("live smoke: real Copilot delegates, builds, reviews and merges hello.txt", { skip: !LIVE && "set ARCADE_LIVE=1 to run (uses real Copilot requests)", timeout: 900000 }, async (t) => {
  const repo = makeRepo({ "README.md": "# live smoke\n" });
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "arcade.mjs"), repo, "--no-open", "--port", "0", "--model", MODEL], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let errOut = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (errOut += d));
  const exited = new Promise((r) => child.once("exit", r));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([exited, sleep(8000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  let match;
  for (let i = 0; i < 100 && !(match = /http:\/\/127\.0\.0\.1:(\d+)\/#token=(\S+)/.exec(out)); i++) await sleep(100);
  assert.ok(match, `the server did not print its link. stdout: ${out.replace(/token=\S+/g, "token=***")} stderr: ${errOut}`);
  const base = `http://127.0.0.1:${match[1]}`;
  const token = match[2];

  const call = async (route, init = {}) => {
    const res = await fetch(`${base}${route}`, { ...init, headers: { "x-arcade-token": token, "content-type": "application/json" } });
    return res.json();
  };
  const command = (name, payload = {}) => call("/api/command", { method: "POST", body: JSON.stringify({ name, ...payload }) });

  const hello = await (await fetch(`${base}/api/hello`)).json();
  assert.equal(hello.mode, "live");
  const health = await call("/api/health");
  console.log("health:", JSON.stringify({ copilot: health.copilot, model: health.model, connection: health.connection }));
  assert.equal(health.copilot?.found, true, "the copilot binary must be installed for the live smoke");
  assert.equal(health.copilot?.loggedIn, true, `Copilot must be signed in (${health.loginCommand ?? "copilot login"})`);

  // SSE: keep a local state with the shared reducer and record what really happens.
  const state = createInitialState();
  const seq = [];
  const started = Date.now();
  const ac = new AbortController();
  t.after(() => ac.abort());
  const sse = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`, { signal: ac.signal });
  assert.equal(sse.status, 200);
  (async () => {
    const dec = new TextDecoder();
    let buf = "";
    try {
      for await (const chunk of sse.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
          if (!data) continue;
          const ev = JSON.parse(data);
          reduce(state, ev);
          if (ev.type !== "metrics") seq.push({ ms: Date.now() - started, type: ev.type, status: ev.status, id: ev.id ?? ev.worker?.id ?? ev.order?.id });
        }
      }
    } catch {
      /* aborted at the end */
    }
  })();

  const waitFor = async (pred, what, ms = 240000) => {
    const begin = Date.now();
    for (;;) {
      let v;
      try { v = await pred(); } catch (err) { if (err?.name === "AssertionError") throw err; v = false; }
      if (v) return v;
      if (Date.now() - begin > ms) {
        throw new Error(`Timed out waiting for ${what}.\nconnection: ${JSON.stringify(state.connection)}\nworkers: ${Object.values(state.workers).map((w) => `${w.id}:${w.status}:${w.now}`).join(" | ")}\nevents: ${seq.slice(-25).map((e) => e.type).join(", ")}\nstderr: ${errOut}`);
      }
      await sleep(250);
    }
  };

  await waitFor(() => state.source === "live" && state.workers.lead, "the snapshot with the Lead");

  const delegated = await command("delegate", { goal: "create hello.txt containing hi" });
  assert.equal(delegated.ok, true, delegated.error);

  await waitFor(() => state.batch.status === "proposed", "the Lead to propose work orders");
  const proposed = state.orderOrder.map((id) => ({ id, ...state.orders[id] }));
  console.log("Lead proposed:", JSON.stringify(proposed.map((o) => ({ title: o.title, role: o.ownerRole, files: o.allowedFiles, dependsOn: o.dependsOn }))));

  // Keep the run small: one builder order is enough, so only two Copilot turns are used in total.
  const keep = proposed.find((o) => o.ownerRole === "builder") ?? proposed[0];
  for (const o of proposed) {
    if (o.id === keep.id) continue;
    const removed = await command("removeOrder", { id: o.id });
    assert.equal(removed.ok, true, removed.error);
  }
  const approved = await command("approveBatch");
  assert.equal(approved.ok, true, approved.error);
  assert.equal(approved.data?.started, 1);

  // Answer permission requests through the API (throwaway repo; the test, not the bridge, makes this choice).
  const answered = new Set();
  const review = await waitFor(
    async () => {
      for (const a of Object.values(state.approvals)) {
        if (a.status !== "open" || answered.has(a.id)) continue;
        const opt = a.options.find((o) => o.kind === "allow_once") ?? a.options[0];
        answered.add(a.id);
        console.log("permission request:", JSON.stringify({ title: a.title ?? a.summary, kind: a.kind, options: a.options.map((o) => o.kind) }), "-> answering", opt.kind);
        const r = await command("resolveApproval", { approvalId: a.id, optionId: opt.id });
        assert.equal(r.ok, true, r.error);
      }
      return Object.values(state.reviews).find((r) => r.status === "open");
    },
    "review.ready",
    480000,
  );
  assert.ok(review, "a review should be ready");
  assert.match(review.diff, /hello\.txt/, "the diff should mention hello.txt");
  assert.ok(review.files.some((f) => /hello\.txt/.test(typeof f === "string" ? f : f.path ?? f.name ?? "")), `files: ${JSON.stringify(review.files)}`);
  console.log("review diff:\n" + review.diff);

  const merged = await command("approveReview", { reviewId: review.id });
  assert.equal(merged.ok, true, merged.error);
  assert.equal(merged.data?.merged, true, JSON.stringify(merged));

  assert.equal(fs.readFileSync(path.join(repo, "hello.txt"), "utf8").trim().toLowerCase(), "hi");
  assert.match(git(repo, "log", "--oneline", "-3"), /\S/);
  assert.match(git(repo, "log", "--merges", "--oneline"), /\S/, "approve should create a --no-ff merge commit");
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=no"), "");
  await waitFor(() => state.orders[keep.id]?.status === "shipped", "the order to be shipped", 15000);

  console.log("observed event sequence (ms since SSE connect):\n" + seq.map((e) => `${String(e.ms).padStart(6)}  ${e.type}${e.status ? ` ${e.status}` : ""}${e.id ? ` ${e.id}` : ""}`).join("\n"));
});
