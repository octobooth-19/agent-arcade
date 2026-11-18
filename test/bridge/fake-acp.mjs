#!/usr/bin/env node
// A fake `copilot --acp --stdio` for tests. Speaks the same NDJSON JSON-RPC as docs/ACP-FINDINGS.md, costs nothing.
//
// Behaviour is scripted from the prompt text with directives written as [[fake:<name> <args>]]:
//   write <path> <content>      create/overwrite a file in the session cwd ("\n" in content becomes a newline)
//   askwrite <path> <content>   ask permission (kind edit) first; only writes when the answer is allow_*
//   exec <command text>         emit an execute tool call with some output (nothing is run)
//   askexec <command text>      ask permission (kind execute) first
//   say <text>                  agent_message_chunk
//   info <text>                 agent_message_chunk "Info: <text>"
//   think                       a few agent_thought_chunk updates
//   sleep <ms>                  cancellable wait (default turn is instant)
//   usage <used> <size>         usage_update
//   plan                        a two-entry plan update
//   unknown                     an update type the bridge does not know
//   fail <message>              the prompt request fails with a JSON-RPC error
//   stop <reason>               end the turn with this stopReason
//   crash                       exit the process mid-turn
// Environment: FAKE_ACP_LOG (append every incoming message and permission outcome as JSON lines),
//   FAKE_ACP_AUTH_FAIL=1 (session/new fails with an auth error), FAKE_LEAD_REPLY (text the Lead answers with),
//   FAKE_LEAD_ASK=1 (the Lead first asks to edit a file), FAKE_ACP_MODELS (comma list of model ids).
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write("Fake Copilot CLI 0.0.1-test\n");
  process.exit(0);
}

const LOG = process.env.FAKE_ACP_LOG;
const log = (entry) => {
  if (LOG) fs.appendFileSync(LOG, `${JSON.stringify(entry)}\n`);
};

const DEFAULT_LEAD_REPLY = `Here is the plan.\n\n\`\`\`json\n${JSON.stringify({
  orders: [
    { title: "Add hello file", ownerRole: "builder", allowedFiles: ["hello.txt"], acceptance: "hello.txt exists", prompt: "[[fake:write hello.txt hi\\n]]Create hello.txt", dependsOn: [] },
    { title: "Add notes file", ownerRole: "builder", allowedFiles: ["notes.txt"], acceptance: "notes.txt exists", prompt: "[[fake:write notes.txt notes\\n]]Create notes.txt", dependsOn: [] },
  ],
})}\n\`\`\``;

const MODELS = (process.env.FAKE_ACP_MODELS ?? "fake-fast,fake-smart").split(",").filter(Boolean);
const sessions = new Map(); // sessionId -> { cwd, model, prompt }
let nextSession = 1;
let nextOut = 1;
const waiting = new Map(); // our request id -> resolver

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const reply = (id, result) => send({ id, result });
const replyError = (id, code, message) => send({ id, error: { code, message } });
const update = (sessionId, u) => send({ method: "session/update", params: { sessionId, update: u } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(sessionId, toolCall) {
  const id = `fake-${nextOut++}`;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    send({
      id,
      method: "session/request_permission",
      params: {
        sessionId,
        toolCall,
        options: [
          { optionId: "allow_once", kind: "allow_once", name: "Allow" },
          { optionId: "allow_always", kind: "allow_always", name: "Always allow" },
          { optionId: "reject_once", kind: "reject_once", name: "Reject" },
        ],
      },
    });
  });
}

const parseDirectives = (text) => [...String(text).matchAll(/\[\[fake:(\w+)(?: ([\s\S]*?))?\]\]/g)].map((m) => ({ name: m[1], args: m[2] ?? "" }));

async function runPrompt(sessionId, session, promptText, run) {
  const isLead = /You are the Lead of a small team/.test(promptText);
  const directives = isLead ? [] : parseDirectives(promptText);
  const cancelled = () => run.cancelled;
  const pause = async (ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until && !cancelled()) await sleep(Math.min(10, until - Date.now()));
  };

  if (isLead) {
    if (process.env.FAKE_LEAD_ASK === "1") {
      const answer = await ask(sessionId, {
        toolCallId: "lead-edit",
        title: "Edit lead-notes.txt",
        kind: "edit",
        status: "pending",
        rawInput: { fileName: path.join(session.cwd, "lead-notes.txt"), diff: "+lead was here" },
        locations: [{ path: path.join(session.cwd, "lead-notes.txt") }],
      });
      log({ event: "permission-outcome", sessionId, outcome: answer });
    }
    const text = process.env.FAKE_LEAD_REPLY ?? DEFAULT_LEAD_REPLY;
    for (let i = 0; i < text.length && !cancelled(); i += 24) {
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: text.slice(i, i + 24) } });
      await sleep(1);
    }
    return cancelled() ? { stopReason: "cancelled" } : { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } };
  }

  let toolN = 0;
  for (const d of directives) {
    if (cancelled()) break;
    const tool = `t${++toolN}-${sessionId}`;
    switch (d.name) {
      case "sleep":
        await pause(Number(d.args) || 50);
        break;
      case "say":
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `${d.args}\n` } });
        break;
      case "info":
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Info: ${d.args}` } });
        break;
      case "think":
        for (let i = 0; i < 3; i++) update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm " }, messageId: "m1" });
        break;
      case "usage": {
        const [used, size] = d.args.split(/\s+/).map(Number);
        update(sessionId, { sessionUpdate: "usage_update", used, size });
        break;
      }
      case "plan":
        update(sessionId, { sessionUpdate: "plan", entries: [{ content: "Look around", status: "completed", priority: "medium" }, { content: "Write the file", status: "in_progress", priority: "medium" }] });
        break;
      case "unknown":
        update(sessionId, { sessionUpdate: "some_future_update", data: 1 });
        break;
      case "fail":
        throw Object.assign(new Error(d.args || "The agent failed"), { rpcCode: -32603 });
      case "stop":
        return { stopReason: d.args.trim() || "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
      case "crash":
        process.exit(3);
        break;
      case "write":
      case "askwrite": {
        const [file, ...rest] = d.args.split(" ");
        const content = rest.join(" ").replace(/\\n/g, "\n");
        const abs = path.resolve(session.cwd, file);
        let before = "";
        try {
          before = fs.readFileSync(abs, "utf8");
        } catch {
          /* new file */
        }
        update(sessionId, { sessionUpdate: "tool_call", toolCallId: tool, title: `Edit ${file}`, kind: "edit", status: "pending", rawInput: { fileName: abs }, locations: [{ path: abs }] });
        if (d.name === "askwrite") {
          const answer = await ask(sessionId, { toolCallId: tool, title: `Edit ${file}`, kind: "edit", status: "pending", rawInput: { fileName: abs, diff: `+${content}` }, locations: [{ path: abs }] });
          log({ event: "permission-outcome", sessionId, outcome: answer });
          const ok = answer?.outcome === "selected" && /^allow/.test(answer.optionId ?? "");
          if (!ok) {
            update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tool, status: "failed" });
            break;
          }
        }
        if (cancelled()) break;
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tool, status: "completed", content: [{ type: "diff", path: abs, oldText: before, newText: content }] });
        break;
      }
      case "exec":
      case "askexec": {
        update(sessionId, { sessionUpdate: "tool_call", toolCallId: tool, title: `Run ${d.args}`, kind: "execute", status: "pending", rawInput: { command: d.args } });
        if (d.name === "askexec") {
          const answer = await ask(sessionId, { toolCallId: tool, title: `Run ${d.args}`, kind: "execute", status: "pending", rawInput: { command: d.args, commands: [d.args] } });
          log({ event: "permission-outcome", sessionId, outcome: answer });
          if (!(answer?.outcome === "selected" && /^allow/.test(answer.optionId ?? ""))) {
            update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tool, status: "failed" });
            break;
          }
        }
        update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: tool, status: "completed", content: [{ type: "content", content: { type: "text", text: `ran: ${d.args}\nok` } }] });
        break;
      }
      default:
        update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `unknown directive ${d.name}\n` } });
    }
  }
  if (cancelled()) {
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Info: Operation cancelled by user" } });
    return { stopReason: "cancelled" };
  }
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done.\n" } });
  return { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0 } };
}

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      if (process.env.FAKE_ACP_INIT_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_ACP_INIT_DELAY_MS)));
      return reply(id, {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, close: {} }, promptCapabilities: { image: true, embeddedContext: true } },
        agentInfo: { name: "fake-copilot", version: "0.0.1" },
        authMethods: [{ id: "copilot-login", name: "Log in", _meta: { "terminal-auth": { command: "fake-copilot", args: ["login"] } } }],
      });
    case "session/new": {
      if (process.env.FAKE_ACP_AUTH_FAIL === "1") return replyError(id, -32000, "Authentication required");
      const sessionId = `fake-session-${nextSession++}`;
      sessions.set(sessionId, { cwd: params?.cwd ?? process.cwd(), model: MODELS[0], prompt: null });
      return reply(id, { sessionId, models: { currentModelId: MODELS[0], availableModels: MODELS.map((modelId) => ({ modelId })) }, modes: { currentModeId: "agent", availableModes: [] }, configOptions: [] });
    }
    case "session/set_model": {
      const s = sessions.get(params?.sessionId);
      if (!s) return replyError(id, -32602, "Unknown session");
      if (!MODELS.includes(params?.modelId)) return replyError(id, -32602, "Unknown model");
      s.model = params.modelId;
      return reply(id, {});
    }
    case "session/close":
      sessions.delete(params?.sessionId);
      return reply(id, {});
    case "session/prompt": {
      const s = sessions.get(params?.sessionId);
      if (!s) return replyError(id, -32602, "Unknown session");
      if (s.prompt) s.prompt.cancelled = true; // a second prompt pre-empts the first
      const run = { cancelled: false };
      s.prompt = run;
      const text = (params.prompt ?? []).map((p) => p?.text ?? "").join("\n");
      try {
        const result = await runPrompt(params.sessionId, s, text, run);
        return reply(id, result);
      } catch (err) {
        return replyError(id, err.rpcCode ?? -32603, err.message);
      } finally {
        if (s.prompt === run) s.prompt = null;
      }
    }
    default:
      if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log({ event: "in", msg });
  if (msg.method === "session/cancel") {
    const s = sessions.get(msg.params?.sessionId);
    if (s?.prompt) s.prompt.cancelled = true;
    // A cancel also unblocks a permission wait (the client answers "cancelled" for those).
    return;
  }
  if (msg.method === undefined && msg.id !== undefined && waiting.has(msg.id)) {
    const resolve = waiting.get(msg.id);
    waiting.delete(msg.id);
    return resolve(msg.result?.outcome ?? { outcome: "cancelled" });
  }
  if (msg.method) void handle(msg);
});
rl.on("close", () => process.exit(0));
