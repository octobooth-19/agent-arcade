import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Orchestrator } from "../../src/orchestrator.mjs";
import { generateToken, hostAllowed, originAllowed, resolveStatic, tokensMatch } from "../../src/security.mjs";
import { createBridgeServer } from "../../src/server.mjs";
import { FAKE_ACP, ROOT, cleanupAll, makeRepo, scratchDir, sleep, startLive } from "./helpers.mjs";

after(cleanupAll);

function request(port, { method = "GET", path: p = "/", headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: { ...(host ? { Host: host } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Opens an SSE stream and collects the decoded data frames. */
function openSse(port, { token, headers = {} } = {}) {
  const frames = [];
  const waiters = [];
  let status = null;
  let req;
  const ready = new Promise((resolve, reject) => {
    req = http.get({ host: "127.0.0.1", port, path: `/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`, headers }, (res) => {
      status = res.statusCode;
      if (status !== 200) {
        res.resume();
        return resolve();
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data) {
            frames.push(JSON.parse(data));
            for (const w of waiters.splice(0)) w();
          }
        }
      });
      resolve();
    });
    req.on("error", reject);
  });
  return {
    ready,
    frames,
    get status() {
      return status;
    },
    async waitFor(pred, ms = 8000) {
      const start = Date.now();
      while (!frames.some(pred)) {
        if (Date.now() - start > ms) throw new Error(`SSE timeout; saw ${frames.map((f) => f.type).join(",")}`);
        await new Promise((r) => {
          waiters.push(r);
          setTimeout(r, 50);
        });
      }
      return frames.find(pred);
    },
    close: () => req.destroy(),
  };
}

describe("security helpers", () => {
  test("token comparison accepts only the exact token", () => {
    const t = generateToken();
    assert.ok(t.length >= 40);
    assert.notEqual(t, generateToken());
    assert.equal(tokensMatch(t, t), true);
    for (const bad of [undefined, null, "", t.slice(0, -1), `${t}x`, t.toUpperCase(), 5]) assert.equal(tokensMatch(t, bad), false);
    assert.equal(tokensMatch("", ""), false);
  });

  test("Host and Origin must be loopback with our own port", () => {
    assert.equal(hostAllowed("127.0.0.1:4747", 4747), true);
    assert.equal(hostAllowed("localhost:4747", 4747), true);
    for (const h of ["evil.com", "evil.com:4747", "127.0.0.1:4748", "127.0.0.1", "127.0.0.1.evil.com:4747", undefined, "[::1]:4747"]) assert.equal(hostAllowed(h, 4747), false, String(h));
    assert.equal(originAllowed(undefined, 4747), true);
    assert.equal(originAllowed("http://127.0.0.1:4747", 4747), true);
    for (const o of ["http://evil.com", "null", "https://127.0.0.1:4747", "http://127.0.0.1:1", "http://localhost.evil.com:4747"]) assert.equal(originAllowed(o, 4747), false, o);
  });

  test("static resolution stays inside the served roots", () => {
    const pub = path.join(ROOT, "public");
    const roots = [
      { prefix: "/shared/", dir: path.join(ROOT, "shared") },
      { prefix: "/fixtures/", dir: path.join(ROOT, "fixtures") },
      { prefix: "/", dir: pub },
    ];
    assert.equal(resolveStatic("/shared/state.js", roots).ok, true);
    for (const p of ["/shared/../bin/arcade.mjs", "/../package.json", "/%2e%2e/bin/arcade.mjs", "/shared/%2e%2e/src/server.mjs", "/..%2fsrc/server.mjs", "/shared/..\\..\\src", "/a%00b", "/%zz", "/.arcade/runs/x.json", "/.git/config", "/src/server.mjs", "/bin/arcade.mjs", "/docs/CONTRACT.md"]) {
      const r = resolveStatic(p, roots);
      assert.equal(r.ok, false, `${p} must not resolve`);
      assert.ok([400, 403, 404].includes(r.status), p);
    }
  });

  test("symlinks that point outside a root are refused", () => {
    const outside = scratchDir("outside");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    const pub = scratchDir("pub");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(pub, "link.txt"));
    fs.symlinkSync(outside, path.join(pub, "dir"));
    const roots = [{ prefix: "/", dir: pub }];
    assert.equal(resolveStatic("/link.txt", roots).ok, false);
    assert.equal(resolveStatic("/dir/secret.txt", roots).ok, false);
  });
});

describe("HTTP server", () => {
  const token = generateToken();
  let h;
  let bridge;
  let port;
  const auth = { "x-arcade-token": token };
  const json = { ...auth, "content-type": "application/json" };

  before(async () => {
    h = await startLive();
    bridge = createBridgeServer({
      orchestrator: h.orch,
      mode: "live",
      token,
      projectDir: h.projectDir,
      publicDir: path.join(ROOT, "public"),
      sharedDir: path.join(ROOT, "shared"),
      fixturesDir: path.join(ROOT, "fixtures"),
      runStore: h.orch.runStore,
    });
    port = await bridge.listen(0);
  });
  after(async () => {
    await bridge.close();
  });

  test("binds to loopback only", () => {
    const addr = bridge.server.address();
    assert.equal(addr.address, "127.0.0.1");
  });

  test("/api/hello needs no token but still enforces Host and Origin", async () => {
    const ok = await request(port, { path: "/api/hello" });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { app: "agent-arcade", mode: "live", version: "1.0.0", needsToken: true });
    assert.equal((await request(port, { path: "/api/hello", host: "evil.com" })).status, 403);
    assert.equal((await request(port, { path: "/api/hello", host: `rebind.example:${port}` })).status, 403);
    assert.equal((await request(port, { path: "/api/hello", headers: { Origin: "http://evil.com" } })).status, 403);
    assert.equal((await request(port, { path: "/api/hello", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await request(port, { path: "/api/hello", host: `localhost:${port}`, headers: { Origin: `http://localhost:${port}` } })).status, 200);
  });

  test("every other API route needs the token", async () => {
    for (const [method, p] of [["GET", "/api/health"], ["GET", "/api/runs"], ["GET", "/api/runs/abc"], ["POST", "/api/command"], ["GET", "/api/events"]]) {
      const none = await request(port, { method, path: p, headers: method === "POST" ? { "content-type": "application/json" } : {}, body: method === "POST" ? "{}" : undefined });
      assert.equal(none.status, 401, `${method} ${p} without a token`);
      const wrong = await request(port, { method, path: p, headers: { "x-arcade-token": "nope", "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(wrong.status, 401, `${method} ${p} with a wrong token`);
      assert.doesNotMatch(none.text + wrong.text, new RegExp(token));
    }
  });

  test("a token in the query string works only for the event stream", async () => {
    assert.equal((await request(port, { path: `/api/health?token=${token}` })).status, 401);
    assert.equal((await request(port, { path: `/api/runs?token=${token}` })).status, 401);
    const sse = openSse(port, { token });
    await sse.ready;
    assert.equal(sse.status, 200);
    sse.close();
    const bad = openSse(port, { token: "wrong" });
    await bad.ready;
    assert.equal(bad.status, 401);
  });

  test("valid token plus bad Host or Origin is still refused", async () => {
    assert.equal((await request(port, { path: "/api/health", headers: auth, host: "evil.com" })).status, 403);
    assert.equal((await request(port, { path: "/api/health", headers: { ...auth, Origin: "http://evil.com" } })).status, 403);
    assert.equal((await request(port, { method: "POST", path: "/api/command", headers: { ...json, Origin: "http://evil.com" }, body: '{"name":"reset"}' })).status, 403);
    const sse = openSse(port, { token, headers: { Origin: "http://evil.com" } });
    await sse.ready;
    assert.equal(sse.status, 403);
  });

  test("/api/health reports the fake copilot and the project", async () => {
    const r = await request(port, { path: "/api/health", headers: auth });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.text);
    assert.equal(body.copilot.found, true);
    assert.equal(body.copilot.loggedIn, true);
    assert.equal(body.project.isGit, true);
    assert.equal(body.loginCommand, "fake-copilot login");
    assert.doesNotMatch(r.text, new RegExp(token));
  });

  test("/api/health right after launch waits for startup detection instead of reporting 'not found'", async () => {
    const orch = new Orchestrator({
      projectDir: makeRepo(),
      maxConcurrent: 1,
      metricsIntervalMs: 0,
      copilot: { command: process.execPath, prefixArgs: [FAKE_ACP], env: {} },
    });
    await orch.start();
    const early = createBridgeServer({ orchestrator: orch, mode: "live", token, projectDir: orch.projectDir, publicDir: path.join(ROOT, "public"), sharedDir: path.join(ROOT, "shared"), fixturesDir: path.join(ROOT, "fixtures"), runStore: orch.runStore });
    const p = await early.listen(0);
    try {
      const body = JSON.parse((await request(p, { path: "/api/health", headers: auth })).text);
      assert.equal(body.copilot.found, true);
      assert.equal(body.copilot.loggedIn, true);
      assert.equal(body.connection.state, "ready");
    } finally {
      await early.close();
      await orch.shutdown();
    }
  });

  test("command endpoint validates content type, size, JSON and command names", async () => {
    const post = (body, headers = json) => request(port, { method: "POST", path: "/api/command", headers, body });
    assert.equal((await post("{}", { ...auth, "content-type": "text/plain" })).status, 415);
    assert.equal((await post("{not json")).status, 400);
    const unknown = await post(JSON.stringify({ name: "rm -rf", x: 1 }));
    assert.equal(unknown.status, 400);
    assert.equal((await post(JSON.stringify({ name: "constructor" }))).status, 400);
    assert.equal((await post(JSON.stringify({ name: "__proto__" }))).status, 400);
    const huge = await post(JSON.stringify({ name: "delegate", goal: "x".repeat(300 * 1024) }));
    assert.equal(huge.status, 413);
    // command-level problems are HTTP 200 with ok:false, which is what shared/client.js expects
    const refused = await post(JSON.stringify({ name: "resolveApproval", approvalId: "a99", optionId: "allow_once" }));
    assert.equal(refused.status, 200);
    assert.equal(JSON.parse(refused.text).ok, false);
    const hold = await post(JSON.stringify({ name: "hold", workerId: "__proto__" }));
    assert.equal(JSON.parse(hold.text).ok, false);
  });

  test("static files: UI and shared modules are served, nothing else is", async () => {
    const state = await request(port, { path: "/shared/state.js" });
    assert.equal(state.status, 200);
    assert.match(state.headers["content-type"], /javascript/);
    assert.equal(state.headers["x-content-type-options"], "nosniff");
    assert.match(state.headers["content-security-policy"], /script-src 'self'/);
    assert.equal((await request(port, { path: "/fixtures/demo-timeline.json" })).status, 200);
    for (const p of ["/shared/../bin/arcade.mjs", "/%2e%2e/%2e%2e/etc/passwd", "/shared/%2e%2e/src/server.mjs", "/src/server.mjs", "/bin/arcade.mjs", "/docs/CONTRACT.md", "/.arcade/runs/x.json", "//etc/passwd", "/shared/..%5c..%5csrc", "/a%00b"]) {
      const r = await request(port, { path: p });
      assert.ok([400, 403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.doesNotMatch(r.text, /createBridgeServer|root:/);
    }
    assert.equal((await request(port, { method: "POST", path: "/shared/state.js", body: "x" })).status, 405);
    assert.equal((await request(port, { path: "/shared/state.js", host: "evil.com" })).status, 403);
  });

  test("a missing public/index.html is a clear 404, not a crash", async () => {
    const emptyPublic = scratchDir("nopublic");
    const b = createBridgeServer({ orchestrator: null, mode: "demo", token, projectDir: h.projectDir, publicDir: emptyPublic, sharedDir: path.join(ROOT, "shared"), fixturesDir: path.join(ROOT, "fixtures") });
    const p = await b.listen(0);
    try {
      for (const url of ["/", "/index.html"]) {
        const r = await request(p, { path: url });
        assert.equal(r.status, 404);
        assert.match(r.text, /public\/index\.html is missing/);
      }
      assert.equal(JSON.parse((await request(p, { path: "/api/hello" })).text).mode, "demo");
      assert.equal((await request(p, { path: "/api/events", headers: auth })).status, 404, "no live stream in demo mode");
      assert.equal((await request(p, { method: "POST", path: "/api/command", headers: json, body: '{"name":"reset"}' })).status, 404);
      assert.equal(JSON.parse((await request(p, { path: "/api/health", headers: auth })).text).mode, "demo");
    } finally {
      await b.close();
    }
  });

  test("run listing and loading validate ids", async () => {
    h.orch.runStore.save("20260101-000000-abcd", [{ type: "run.started", goal: "old", t: 0 }]);
    const list = JSON.parse((await request(port, { path: "/api/runs", headers: auth })).text);
    assert.equal(list.ok, true);
    assert.deepEqual(list.runs, list.data);
    assert.ok(list.runs.some((r) => r.id === "20260101-000000-abcd" && r.goal === "old"));
    const one = await request(port, { path: "/api/runs/20260101-000000-abcd", headers: auth });
    assert.deepEqual(JSON.parse(one.text), [{ type: "run.started", goal: "old", t: 0 }]);
    assert.equal((await request(port, { path: "/api/runs/..%2f..%2fpackage", headers: auth })).status, 400, "a malformed id is rejected before touching the disk");
    assert.equal((await request(port, { path: "/api/runs/does-not-exist", headers: auth })).status, 404);
  });

  test("a new SSE client gets a full snapshot first, then live events", async () => {
    const sse = openSse(port, { token });
    await sse.ready;
    const first = await sse.waitFor(() => true);
    assert.equal(first.type, "snapshot");
    assert.equal(first.state.source, "live");
    assert.equal(first.state.project.name, path.basename(h.projectDir));
    assert.ok(first.state.workers.lead, "the Lead is already seated");
    assert.equal(first.state.connection.state, "ready");
    assert.equal(sse.frames.length, 1);

    // a second client gets its own snapshot, not the first client's history
    const other = openSse(port, { token });
    await other.ready;
    assert.equal((await other.waitFor(() => true)).type, "snapshot");

    const res = await request(port, { method: "POST", path: "/api/command", headers: json, body: JSON.stringify({ name: "setMaxConcurrent", value: 2 }) });
    assert.equal(JSON.parse(res.text).ok, true);
    await sse.waitFor((e) => e.type === "settings" && e.maxConcurrent === 2);
    assert.equal(sse.frames[0].type, "snapshot");
    assert.ok(sse.frames.slice(1).every((f) => f.type !== "snapshot"));
    sse.close();
    other.close();
    await sleep(50);
  });
});
