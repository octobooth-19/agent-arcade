// Live steering test against the REAL Copilot CLI: two builders, then Hold/Resume, Redirect and Nudge on a running turn.
// It uses a few premium requests on a cheap model, so it only runs when ARCADE_LIVE=1:
//   ARCADE_LIVE=1 node --test test/bridge/live-steer.test.mjs
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

test("live steering: hold, resume, redirect and nudge real Copilot workers", { skip: !LIVE && "set ARCADE_LIVE=1 to run (uses real Copilot requests)", timeout: 900000 }, async (t) => {
  const repo = makeRepo({ "README.md": "# live steer\n" });
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "arcade.mjs"), repo, "--no-open", "--port", "0", "--model", MODEL], { stdio: ["ignore", "pipe", "pipe"] });
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
  assert.ok(match, "the server did not print its link");
  const base = `http://127.0.0.1:${match[1]}`;
  const token = match[2];
  const call = async (route, init = {}) => (await fetch(`${base}${route}`, { ...init, headers: { "x-arcade-token": token, "content-type": "application/json" } })).json();
  const command = (name, payload = {}) => call("/api/command", { method: "POST", body: JSON.stringify({ name, ...payload }) });

  const state = createInitialState();
  const seq = [];
  const started = Date.now();
  const log = (msg) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${msg}`);
  const ac = new AbortController();
  t.after(() => ac.abort());
  const sse = await fetch(`${base}/api/events?token=${encodeURIComponent(token)}`, { signal: ac.signal });
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
          if (ev.type === "metrics") continue;
          seq.push(ev);
          if (ev.type === "worker.status" || ev.type.startsWith("note.") || ev.type.startsWith("approval.") || ev.type.startsWith("review.")) {
            log(`${ev.type} ${ev.id ?? ev.noteId ?? ""} ${ev.status ?? ""} ${ev.atStep ?? ""}`.trim());
          }
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
        throw new Error(`Timed out waiting for ${what}.\nworkers: ${Object.values(state.workers).map((w) => `${w.id}:${w.status}:${w.now}`).join(" | ")}\nstderr: ${errOut}`);
      }
      await sleep(250);
    }
  };
  const must = async (name, payload) => {
    const r = await command(name, payload);
    assert.equal(r.ok, true, `${name}: ${r.error}`);
    return r;
  };

  await waitFor(() => state.source === "live" && state.workers.lead, "the Lead");
  await must("delegate", { goal: "make two small text files" });
  await waitFor(() => state.batch.status === "proposed", "the Lead's proposal");

  // Replace whatever the Lead proposed with two human-authored orders so the timing is predictable.
  for (const id of [...state.orderOrder]) if (state.orders[id].status === "proposed") await must("removeOrder", { id });
  const slow = (file, word) => `Run the shell command "sleep 20" and wait for it to finish. Then create the file ${file} containing exactly the word ${word}. Do nothing else.`;
  await must("addOrder", { order: { title: "Write alpha.txt", ownerRole: "builder", allowedFiles: ["alpha.txt"], acceptance: "alpha.txt exists", prompt: slow("alpha.txt", "alpha") } });
  await must("addOrder", { order: { title: "Write beta.txt", ownerRole: "builder", allowedFiles: ["beta.txt", "beta2.txt"], acceptance: "beta.txt exists", prompt: slow("beta.txt", "beta") } });
  const approved = await must("approveBatch");
  assert.equal(approved.data?.started, 2);

  await waitFor(() => Object.values(state.workers).filter((w) => w.role === "builder").length === 2, "both builders to appear", 15000);
  const workers = Object.values(state.workers).filter((w) => w.role === "builder");
  const [A, B] = workers.map((w) => w.id);

  // Never auto-approve in the product; this test is the human and picks allow_once in a throwaway repo.
  const answered = new Set();
  const answerOpen = async () => {
    for (const a of Object.values(state.approvals)) {
      if (a.status !== "open" || answered.has(a.id)) continue;
      answered.add(a.id);
      const opt = a.options.find((o) => o.kind === "allow_once") ?? a.options[0];
      log(`approval ${a.id} for ${a.workerId}: ${a.title ?? a.summary} -> ${opt.kind}`);
      await must("resolveApproval", { approvalId: a.id, optionId: opt.id });
    }
  };

  await waitFor(async () => { await answerOpen(); return state.workers[A].status === "working" && state.workers[B].status === "working"; }, "both builders working");
  await sleep(6000);
  await answerOpen();

  // 1. Hold A while its sleep is running: the turn is cancelled and the worker is held.
  log("HOLD A");
  await must("hold", { workerId: A });
  await waitFor(() => state.workers[A].status === "held", "A to be held", 30000);
  const holdNote = state.workers[A].notes.at(-1);
  log(`A hold receipt: ${JSON.stringify(holdNote)}`);
  assert.equal(holdNote.kind, "hold");
  await waitFor(() => state.workers[A].notes.at(-1).delivery === "delivered", "the hold receipt", 30000);

  // 2. Redirect B while its sleep is running: a new prompt pre-empts the current turn.
  log("REDIRECT B");
  await must("redirect", { workerId: B, text: "Change of plan: create beta2.txt containing the word beta instead of beta.txt. Skip the sleep this time." });
  await waitFor(async () => { await answerOpen(); return state.workers[B].notes.some((n) => n.kind === "redirect" && n.delivery === "delivered"); }, "the redirect receipt", 60000);

  // 3. Resume A, then nudge it. The nudge is queued and lands when the turn ends.
  log("RESUME A");
  await must("resume", { workerId: A });
  await waitFor(async () => { await answerOpen(); return state.workers[A].status === "working"; }, "A to work again", 30000);
  log("NUDGE A");
  await must("nudge", { workerId: A, text: "One more thing: put a second line in alpha.txt that says nudged." });
  await waitFor(() => state.workers[A].notes.some((n) => n.kind === "nudge"), "the nudge to appear in the history", 10000);

  const reviews = await waitFor(
    async () => {
      await answerOpen();
      const open = Object.values(state.reviews).filter((r) => r.status === "open");
      return open.length >= 2 ? open : false;
    },
    "both reviews",
    600000,
  );
  for (const r of reviews) log(`review ${r.id} for ${r.workerId}: ${JSON.stringify(r.files)}`);
  const nudge = state.workers[A].notes.find((n) => n.kind === "nudge");
  log(`nudge receipt: ${JSON.stringify(nudge)}`);

  for (const r of reviews) {
    const merged = await must("approveReview", { reviewId: r.id });
    assert.equal(merged.data?.merged, true, JSON.stringify(merged));
  }
  const files = fs.readdirSync(repo).filter((f) => f.endsWith(".txt")).sort();
  log(`files on main: ${files.join(", ")}`);
  for (const f of files) log(`${f}: ${JSON.stringify(fs.readFileSync(path.join(repo, f), "utf8"))}`);
  assert.ok(files.includes("alpha.txt"));
  assert.ok(files.includes("beta2.txt") || files.includes("beta.txt"));
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(nudge.delivery, "delivered", "the nudge should have been delivered");
  assert.ok(/nudged/.test(fs.readFileSync(path.join(repo, "alpha.txt"), "utf8")), "alpha.txt should carry the nudged line");
});
