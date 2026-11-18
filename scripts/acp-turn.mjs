// ACP turn spike: one cheap prompt in a scratch dir. Logs real update types, permission flow, cancel behaviour.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const SCRATCH = process.argv[2] || "/tmp/arcade-scratch";
const MODEL = process.argv[3] || "claude-haiku-4.5";
const child = spawn("copilot", ["--acp", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], cwd: SCRATCH });
let nextId = 1;
const pending = new Map();
const log = [];
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

function send(obj) { child.stdin.write(JSON.stringify(obj) + "\n"); }
const rpc = (method, params, timeoutMs = 120000) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => pending.has(id) && reject(new Error("timeout " + method)), timeoutMs);
  });

createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id) && !msg.method) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
    return;
  }
  if (msg.method === "session/request_permission") {
    log.push({ t: stamp(), kind: "PERMISSION_REQUEST", params: msg.params });
    // spike policy: allow once so we can observe the tool run, only inside scratch dir
    const opts = msg.params.options || [];
    const allow = opts.find((o) => /allow/i.test(o.kind || o.name || "")) || opts[0];
    send({ jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "selected", optionId: allow.optionId } } });
    log.push({ t: stamp(), kind: "PERMISSION_ANSWER", optionId: allow.optionId, options: opts.map((o) => o.kind + ":" + o.optionId) });
    return;
  }
  if (msg.method === "session/update") {
    const u = msg.params.update;
    log.push({ t: stamp(), kind: u.sessionUpdate, keys: Object.keys(u), sample: JSON.stringify(u).slice(0, 260) });
    return;
  }
  if (msg.method) {
    log.push({ t: stamp(), kind: "OTHER:" + msg.method });
    if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
  }
});
child.stderr.on("data", () => {});

const summarize = (title) => {
  console.log("\n=== " + title + " ===");
  const counts = {};
  for (const e of log) counts[e.kind] = (counts[e.kind] || 0) + 1;
  console.log("update counts:", counts);
  const firstOfKind = new Map();
  for (const e of log) if (!firstOfKind.has(e.kind)) firstOfKind.set(e.kind, e);
  for (const e of firstOfKind.values()) console.log(" first", e.t, e.kind, e.sample || JSON.stringify(e.params || e).slice(0, 400));
};

try {
  await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const s = await rpc("session/new", { cwd: SCRATCH, mcpServers: [] });
  console.log("session", s.sessionId, "currentModel:", s.models?.currentModelId, "currentMode:", s.modes?.currentModeId);
  console.log("configOptions:", JSON.stringify(s.configOptions).slice(0, 600));
  // select a cheap model if the method exists
  try { await rpc("session/set_model", { sessionId: s.sessionId, modelId: MODEL }, 15000); console.log("model set", MODEL); }
  catch (e) { console.log("set_model failed:", e.message.slice(0, 200)); }

  // TURN 1: tool use + permission flow
  log.length = 0;
  const r1 = await rpc("session/prompt", {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "Create a file named hello.txt in the current directory containing exactly: hi from arcade. Then reply with only the word done." }],
  });
  console.log("TURN1 result:", JSON.stringify(r1));
  summarize("TURN 1 (tool + permission)");
  writeFileSync(SCRATCH + "/../arcade-turn1-log.json", JSON.stringify(log, null, 1));

  // TURN 2: cancel mid-turn
  log.length = 0;
  const p2 = rpc("session/prompt", {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "Count slowly from 1 to 200, one number per line, and after every 10 numbers run the shell command `sleep 2`." }],
  });
  await new Promise((r) => setTimeout(r, 6000));
  send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: s.sessionId } });
  console.log("cancel sent at", stamp());
  const r2 = await p2;
  console.log("TURN2 result after cancel:", JSON.stringify(r2), "at", stamp());
  summarize("TURN 2 (cancelled)");

  // TURN 3: second prompt while a turn is running (mid-turn input behaviour)
  log.length = 0;
  const p3 = rpc("session/prompt", {
    sessionId: s.sessionId,
    prompt: [{ type: "text", text: "Write the numbers 1 to 60, one per line, then run `sleep 3`, then say finished." }],
  });
  await new Promise((r) => setTimeout(r, 3000));
  let p4res;
  try {
    p4res = await rpc("session/prompt", {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "Also, after finishing, say the word banana." }],
    }, 90000);
    console.log("CONCURRENT prompt returned:", JSON.stringify(p4res), "at", stamp());
  } catch (e) { console.log("CONCURRENT prompt error:", e.message.slice(0, 300)); }
  try { const r3 = await p3; console.log("TURN3 result:", JSON.stringify(r3), "at", stamp()); } catch (e) { console.log("TURN3 error:", e.message.slice(0, 300)); }
  summarize("TURN 3 (concurrent prompt)");
  const text = log.filter((e) => e.kind === "agent_message_chunk").map((e) => e.sample).join(" ");
  console.log("mentions banana:", /banana/i.test(text));
} catch (e) {
  console.log("ERROR", e.message);
  summarize("PARTIAL");
} finally {
  child.kill("SIGTERM");
}
