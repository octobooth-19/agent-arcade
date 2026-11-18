import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { AcpClient, AcpError } from "../../src/acp-client.mjs";
import { PermissionBroker } from "../../src/permissions.mjs";
import { FAKE_ACP, cleanupAll, scratchDir, sleep } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";

after(cleanupAll);

const fake = (env = {}) => new AcpClient({ command: process.execPath, args: [FAKE_ACP], env: { ...process.env, ...env } }).start();
const textPrompt = (sessionId, text) => ({ sessionId, prompt: [{ type: "text", text }] });

describe("ACP client framing and request matching", () => {
  test("matches responses to requests, even when they finish out of order", async () => {
    const c = fake();
    try {
      const init = await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, { timeoutMs: 5000 });
      assert.equal(init.agentInfo.name, "fake-copilot");
      assert.equal(init.authMethods[0]._meta["terminal-auth"].command, "fake-copilot");
      const [a, b] = await Promise.all([c.request("session/new", { cwd: "/x", mcpServers: [] }), c.request("session/new", { cwd: "/y", mcpServers: [] })]);
      assert.notEqual(a.sessionId, b.sessionId);

      // A slow prompt and a fast one on different sessions, answered in the opposite order to how they were sent.
      const slow = c.request("session/prompt", textPrompt(a.sessionId, "[[fake:sleep 200]]"));
      const fast = c.request("session/prompt", textPrompt(b.sessionId, "quick"));
      const order = [];
      slow.then(() => order.push("slow"));
      fast.then(() => order.push("fast"));
      const [rs, rf] = await Promise.all([slow, fast]);
      assert.deepEqual(order, ["fast", "slow"]);
      assert.equal(rs.stopReason, "end_turn");
      assert.equal(rf.stopReason, "end_turn");
    } finally {
      await c.close();
    }
  });

  test("turns JSON-RPC errors into AcpError with the code", async () => {
    const c = fake();
    try {
      await assert.rejects(c.request("nope", {}), (err) => err instanceof AcpError && err.code === -32601);
    } finally {
      await c.close();
    }
  });

  test("delivers notifications, survives garbage lines, and answers unsupported agent requests with -32601", async () => {
    const dir = scratchDir("framing");
    const script = path.join(dir, "agent.mjs");
    fs.writeFileSync(
      script,
      [
        'process.stdout.write("not json at all\\n");',
        'process.stdout.write(JSON.stringify({jsonrpc:"2.0",method:"session/update",params:{n:1}})+"\\n");',
        // a response split across two chunks proves the line buffer works
        'process.stdout.write(\'{"jsonrpc":"2.0","method":"fs/read_text_file",\');',
        'setTimeout(()=>process.stdout.write(\'"id":77,"params":{}}\\n\'),30);',
        'process.stdin.on("data",(d)=>{ for (const l of String(d).split("\\n").filter(Boolean)) { const m=JSON.parse(l); process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result:{echo:m.method,got77:!!m.error||m.id===77}})+"\\n"); process.stderr.write("seen "+l+"\\n"); } });',
      ].join("\n"),
    );
    const c = new AcpClient({ command: process.execPath, args: [script] });
    const notes = [];
    const bad = [];
    const stderr = [];
    c.on("notification", (m, p) => notes.push([m, p]));
    c.on("badline", (l) => bad.push(l));
    c.on("stderr", (t) => stderr.push(t));
    c.setRequestHandler(async (method) => {
      const e = new Error(`no ${method}`);
      e.code = -32601;
      throw e;
    });
    c.start();
    try {
      await sleep(200);
      assert.deepEqual(notes, [["session/update", { n: 1 }]]);
      assert.equal(bad.length, 1);
      assert.match(stderr.join(""), /"id":77/);
      assert.match(stderr.join(""), /-32601/);
      const r = await c.request("ping", {}, { timeoutMs: 2000 });
      assert.equal(r.echo, "ping");
    } finally {
      await c.close();
    }
  });

  test("rejects pending requests when the process dies, and honors timeouts", async () => {
    const c = fake();
    try {
      await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, { timeoutMs: 5000 });
      const { sessionId } = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] });
      await assert.rejects(c.request("session/prompt", textPrompt(sessionId, "[[fake:sleep 2000]]"), { timeoutMs: 80 }), /timed out/i);
      const dying = c.request("session/prompt", textPrompt(sessionId, "[[fake:crash]]"));
      await assert.rejects(dying, /exited/);
      assert.equal(c.exited, true);
    } finally {
      await c.close();
    }
  });
});

describe("permission requests", () => {
  async function session(c) {
    await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    return (await c.request("session/new", { cwd: scratchDir("perm"), mcpServers: [] })).sessionId;
  }

  test("a permission request is held open until it is answered, then the agent proceeds", async () => {
    const dir = scratchDir("perm");
    const c = fake({ FAKE_ACP_LOG: path.join(dir, "log.jsonl") });
    const broker = new PermissionBroker();
    const seen = [];
    c.setRequestHandler(async (method, params) => {
      assert.equal(method, "session/request_permission");
      const { id, promise } = broker.request({ sessionId: params.sessionId, workerId: "w1", options: params.options, toolCall: params.toolCall });
      seen.push(id);
      return promise;
    });
    try {
      const sid = await session(c);
      let done = false;
      const turn = c.request("session/prompt", textPrompt(sid, "[[fake:askwrite out.txt hello]]")).then((r) => ((done = true), r));
      await sleep(250);
      assert.equal(done, false, "the turn must stay blocked while the request is unanswered");
      assert.equal(broker.list().length, 1);
      assert.equal(broker.list()[0].toolCall.kind, "edit");
      assert.equal(broker.resolve(seen[0], "not-an-option"), null, "unknown option ids are refused");
      assert.equal(broker.list().length, 1);
      const chosen = broker.resolve(seen[0], "allow_once");
      assert.equal(chosen.option.optionId, "allow_once");
      const result = await turn;
      assert.equal(result.stopReason, "end_turn");
      assert.equal(broker.list().length, 0);
      assert.equal(broker.resolve(seen[0], "allow_once"), null, "an answered request cannot be answered twice");
    } finally {
      await c.close();
    }
  });

  test("selected reject and cancelled outcomes reach the agent exactly", async () => {
    const dir = scratchDir("perm");
    const logFile = path.join(dir, "log.jsonl");
    const c = fake({ FAKE_ACP_LOG: logFile });
    const broker = new PermissionBroker();
    c.setRequestHandler(async (_m, params) => broker.request({ sessionId: params.sessionId, options: params.options }).promise);
    try {
      const sid = await session(c);
      const t1 = c.request("session/prompt", textPrompt(sid, "[[fake:askexec rm -rf x]]"));
      await sleep(150);
      broker.resolve(broker.list()[0].id, "reject_once");
      await t1;
      const t2 = c.request("session/prompt", textPrompt(sid, "[[fake:askexec ls]]"));
      await sleep(150);
      broker.cancelForSession(sid);
      await t2;
      const outcomes = fs
        .readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.event === "permission-outcome")
        .map((e) => e.outcome);
      assert.deepEqual(outcomes, [{ outcome: "selected", optionId: "reject_once" }, { outcome: "cancelled" }]);
    } finally {
      await c.close();
    }
  });
});
