// Read-only ACP handshake spike: initialize, open two sessions, report capabilities. Sends no prompts.
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";

const child = spawn("copilot", ["--acp", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1;
const pending = new Map();
const notices = [];

createInterface({ input: child.stdout }).on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    notices.push(msg.method + ":" + (msg.params?.update?.sessionUpdate ?? ""));
  }
});
child.stderr.on("data", () => {});

const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => pending.has(id) && reject(new Error("timeout " + method)), 20000);
  });

const rssMb = () =>
  Math.round(Number(execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)]).toString().trim()) / 1024);

try {
  const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
  console.log("INIT", JSON.stringify(init, null, 1));
  console.log("RSS after init (MB):", rssMb());
  const s1 = await rpc("session/new", { cwd: process.cwd(), mcpServers: [] });
  console.log("SESSION1 keys:", Object.keys(s1), "id:", s1.sessionId);
  console.log("RSS after 1 session (MB):", rssMb());
  const s2 = await rpc("session/new", { cwd: process.cwd(), mcpServers: [] });
  console.log("SESSION2 id:", s2.sessionId, "distinct:", s1.sessionId !== s2.sessionId);
  console.log("RSS after 2 sessions (MB):", rssMb());
  console.log("modes:", JSON.stringify(s1.modes?.availableModes?.map((m) => m.id)));
  console.log("models:", JSON.stringify(s1.models?.availableModels?.map((m) => m.modelId)?.slice(0, 8)));
  await new Promise((r) => setTimeout(r, 1500));
  console.log("NOTIFICATIONS:", [...new Set(notices)]);
} catch (e) {
  console.log("ERROR", e.message);
  console.log("NOTIFICATIONS:", [...new Set(notices)]);
} finally {
  child.kill("SIGTERM");
}
