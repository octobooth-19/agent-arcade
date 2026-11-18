import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator } from "../../src/orchestrator.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FAKE_ACP = path.join(ROOT, "test", "bridge", "fake-acp.mjs");
const SCRATCH = path.join(ROOT, ".scratch");

const cleanups = [];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A throwaway directory inside the project's own .scratch folder (never /tmp). */
export function scratchDir(prefix = "t") {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, `${prefix}-`)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function cleanupAll() {
  while (cleanups.length) await cleanups.pop()();
}

export const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function makeRepo(files = { "README.md": "# demo\n" }) {
  const dir = scratchDir("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

/** A Lead reply (what the fake Lead says) with the given orders. */
export const leadReply = (orders) => `\`\`\`json\n${JSON.stringify({ orders })}\n\`\`\``;

export function order(title, directives = "", extra = {}) {
  return { title, ownerRole: "builder", allowedFiles: [], acceptance: "", prompt: `${directives}${title}`, dependsOn: [], ...extra };
}

/** Starts a live Orchestrator wired to the fake ACP agent. */
export async function startLive({ projectDir = makeRepo(), env = {}, maxConcurrent = 3, check = null, model = null, copilot = {}, code, awaitConnect = true } = {}) {
  const logFile = path.join(scratchDir("acplog"), "acp.jsonl");
  const orch = new Orchestrator({
    projectDir,
    model,
    check,
    maxConcurrent,
    metricsIntervalMs: 0,
    codeBin: code,
    copilot: { command: process.execPath, prefixArgs: [FAKE_ACP], env: { FAKE_ACP_LOG: logFile, ...env }, ...copilot },
  });
  const events = [];
  orch.on("event", (e) => events.push(e));
  await orch.start();
  if (awaitConnect) await orch.connecting;
  cleanups.push(() => orch.shutdown());

  const h = {
    orch,
    projectDir,
    events,
    get state() {
      return orch.state;
    },
    cmd: (name, payload = {}) => orch.command(name, payload),
    /** Resolves when predicate(state) is truthy; fails with a readable dump otherwise. */
    async waitFor(predicate, what = "condition", timeoutMs = 10000) {
      const start = Date.now();
      for (;;) {
        let value;
        try {
          value = predicate(orch.state);
        } catch {
          value = false;
        }
        if (value) return value;
        if (Date.now() - start > timeoutMs) {
          const ws = Object.values(orch.state.workers).map((w) => `${w.id}:${w.status}(${w.now})`).join(", ");
          throw new Error(`Timed out waiting for ${what}. workers: ${ws}; connection: ${JSON.stringify(orch.state.connection)}`);
        }
        await sleep(15);
      }
    },
    workerFor: (title) => Object.values(orch.state.workers).find((w) => orch.state.orders[w.orderId]?.title === title),
    received() {
      try {
        return fs
          .readFileSync(logFile, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    prompts() {
      return this.received()
        .filter((e) => e.event === "in" && e.msg.method === "session/prompt")
        .map((e) => ({ sessionId: e.msg.params.sessionId, text: e.msg.params.prompt.map((p) => p.text).join("\n") }));
    },
    /** Waits until the fake agent's log contains an entry matching pred, and returns it. */
    async waitLog(pred, what = "a log entry", timeoutMs = 5000) {
      const start = Date.now();
      for (;;) {
        const hit = this.received().find(pred);
        if (hit) return hit;
        if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what} in the fake agent log`);
        await sleep(15);
      }
    },
    cancels: () => h.received().filter((e) => e.event === "in" && e.msg.method === "session/cancel").length,
    types: () => events.map((e) => e.type),
    async stop() {
      await orch.shutdown();
    },
  };
  return h;
}

/** Delegate with a scripted Lead reply and approve the batch. Returns when every worker exists. */
export async function runOrders(h, orders, { approve = true } = {}) {
  const res = await h.cmd("delegate", { goal: "test goal" });
  if (!res.ok) throw new Error(`delegate failed: ${res.error}`);
  await h.waitFor((s) => s.batch.status === "proposed" && s.orderOrder.length === orders.length, "the Lead's batch");
  if (!approve) return;
  const ok = await h.cmd("approveBatch");
  if (!ok.ok) throw new Error(`approveBatch failed: ${ok.error}`);
}
