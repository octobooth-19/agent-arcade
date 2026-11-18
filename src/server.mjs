// HTTP + SSE server. Binds 127.0.0.1 only. Every request is Host-checked, every /api request is Origin-checked and
// (except /api/hello) token-checked. Static files come only from public/, shared/ and fixtures/.
import http from "node:http";
import fs from "node:fs";
import { COMMAND_NAMES } from "./commands.mjs";
import { detectCopilot, detectGit, detectProject } from "./health.mjs";
import { VERSION } from "./prompts.mjs";
import { validRunId } from "./run-store.mjs";
import { checkApiRequest, hostAllowed, mimeFor, resolveStatic } from "./security.mjs";

const MAX_BODY = 256 * 1024;
const MAX_SSE_CLIENTS = 20;
const SSE_BACKLOG_LIMIT = 8 * 1024 * 1024;

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const BASE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": CSP,
};

const NO_INDEX_MESSAGE =
  "Agent Arcade is running, but the web UI is not installed (public/index.html is missing).\n" +
  "The API is up: /api/hello answers without a token. Ask whoever builds public/ to add index.html.\n";

/**
 * @param {object} o
 * @param {import("./orchestrator.mjs").Orchestrator | null} o.orchestrator null in demo mode
 * @param {"live" | "demo"} o.mode
 * @param {string} o.token
 * @param {string} o.projectDir
 * @param {string} o.publicDir
 * @param {string} o.sharedDir
 * @param {string} o.fixturesDir
 * @param {import("./run-store.mjs").RunStore | null} [o.runStore]
 * @param {{ copilot?: { command?: string, prefixArgs?: string[] } }} [o.copilot]
 * @param {(msg: string) => void} [o.log]
 */
export function createBridgeServer(o) {
  const { orchestrator = null, mode, token, projectDir, publicDir, sharedDir, fixturesDir, runStore = null } = o;
  const log = o.log ?? (() => {});
  const roots = [
    { prefix: "/shared/", dir: sharedDir },
    { prefix: "/fixtures/", dir: fixturesDir },
    { prefix: "/", dir: publicDir },
  ];
  let port = 0;
  const clients = new Set();
  let demoHealth = null;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`request error: ${err?.message ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Internal error" });
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  function sendJson(res, status, body, extra = {}) {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": data.length, ...extra });
    res.end(data);
  }

  function sendText(res, status, text, req) {
    const data = Buffer.from(text);
    res.writeHead(status, { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Content-Length": data.length });
    res.end(req?.method === "HEAD" ? undefined : data);
  }

  async function readJsonBody(req) {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY) throw Object.assign(new Error("Request body too large"), { status: 413 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) throw Object.assign(new Error("Request body too large"), { status: 413 });
      chunks.push(chunk);
    }
    if (!size) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw Object.assign(new Error("Body must be valid JSON"), { status: 400 });
    }
  }

  async function getHealth() {
    if (orchestrator) {
      // Startup detection (copilot --version, initialize, session/new) runs in the background; wait for it briefly
      // so the first answer is not a misleading "copilot not found".
      let timer;
      await Promise.race([orchestrator.connecting, new Promise((r) => (timer = setTimeout(r, 15_000)))]);
      clearTimeout(timer);
      return orchestrator.health();
    }
    const now = Date.now();
    if (!demoHealth || now - demoHealth.at > 30_000) {
      const [copilot, git, project] = await Promise.all([detectCopilot(o.copilot ?? {}), detectGit(), detectProject(projectDir)]);
      demoHealth = {
        at: now,
        value: {
          copilot: { found: copilot.found, version: copilot.version, loggedIn: "unknown" },
          git,
          project: { name: project.name, path: project.path, isGit: project.isGit },
          loginCommand: "copilot login",
          mode: "demo",
        },
      };
    }
    return demoHealth.value;
  }

  function onSse(req, res) {
    if (!orchestrator) return sendJson(res, 404, { ok: false, error: "Live events are not available in demo mode" });
    if (clients.size >= MAX_SSE_CLIENTS) return sendJson(res, 503, { ok: false, error: "Too many open event streams" });
    res.writeHead(200, {
      ...BASE_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const client = { res };
    // No await between the snapshot and registering the client, so no event can fall in the gap.
    res.write(`data: ${JSON.stringify(orchestrator.snapshot())}\n\n`);
    clients.add(client);
    const drop = () => {
      clients.delete(client);
    };
    req.on("close", drop);
    res.on("close", drop);
    res.on("error", drop);
  }

  function broadcast(payload) {
    if (!clients.size) return;
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) {
      if (c.res.writableLength > SSE_BACKLOG_LIMIT) {
        clients.delete(c);
        c.res.destroy();
        continue;
      }
      c.res.write(frame);
    }
  }

  if (orchestrator) {
    orchestrator.on("event", broadcast);
    orchestrator.on("snapshot", broadcast);
  }
  const heartbeat = setInterval(() => {
    for (const c of clients) c.res.write(": hb\n\n");
  }, 15_000);
  heartbeat.unref();

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const isEvents = p === "/api/events" && req.method === "GET";
    const guard = checkApiRequest(req, url, { port, token, needsToken: p !== "/api/hello", allowQueryToken: isEvents });
    if (!guard.ok) return sendJson(res, guard.status, { ok: false, error: guard.error });

    if (p === "/api/hello") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Use GET" }, { Allow: "GET" });
      return sendJson(res, 200, { app: "agent-arcade", mode, version: VERSION, needsToken: true });
    }
    if (p === "/api/health") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Use GET" }, { Allow: "GET" });
      return sendJson(res, 200, await getHealth());
    }
    if (p === "/api/events") {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Use GET" }, { Allow: "GET" });
      return onSse(req, res);
    }
    if (p === "/api/command") {
      if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Use POST" }, { Allow: "POST" });
      if (!orchestrator) return sendJson(res, 404, { ok: false, error: "Demo mode: commands run in the browser" });
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
        return sendJson(res, 415, { ok: false, error: "Content-Type must be application/json" });
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        const status = err.status ?? 400;
        return sendJson(res, status, { ok: false, error: err.message }, status === 413 ? { Connection: "close" } : {});
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return sendJson(res, 400, { ok: false, error: "Body must be a JSON object" });
      const { name, ...payload } = body;
      if (typeof name !== "string" || !COMMAND_NAMES.includes(name)) return sendJson(res, 400, { ok: false, error: "Unknown command", unknown: true });
      const result = await orchestrator.command(name, payload);
      return sendJson(res, result.unknown ? 400 : 200, result);
    }
    if (p === "/api/runs" || p.startsWith("/api/runs/")) {
      if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "Use GET" }, { Allow: "GET" });
      if (!runStore) return sendJson(res, 404, { ok: false, error: "No saved runs" });
      if (p === "/api/runs") {
        const runs = runStore.list();
        return sendJson(res, 200, { ok: true, data: runs, runs });
      }
      const id = p.slice("/api/runs/".length);
      if (!validRunId(id)) return sendJson(res, 400, { ok: false, error: "Bad run id" });
      const raw = runStore.loadRaw(id);
      if (raw === null) return sendJson(res, 404, { ok: false, error: "Run not found" });
      res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(raw) });
      return void res.end(raw);
    }
    return sendJson(res, 404, { ok: false, error: "Not found" });
  }

  function handleStatic(req, res, url) {
    if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "Method not allowed\n", req);
    const r = resolveStatic(url.pathname, roots);
    if (!r.ok) {
      const isRootIndex = url.pathname === "/" || url.pathname === "/index.html";
      if (r.status === 404 && isRootIndex) return sendText(res, 404, NO_INDEX_MESSAGE, req);
      return sendText(res, r.status, `${r.error}\n`, req);
    }
    const stat = fs.statSync(r.file);
    const headers = { ...BASE_HEADERS, "Content-Type": mimeFor(r.file), "Content-Length": stat.size };
    res.writeHead(200, headers);
    if (req.method === "HEAD") return void res.end();
    const stream = fs.createReadStream(r.file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  async function handle(req, res) {
    if (!hostAllowed(req.headers.host, port)) return sendText(res, 403, "Host not allowed\n");
    const target = req.url ?? "/";
    if (!target.startsWith("/") || target.startsWith("//")) return sendText(res, 400, "Bad request target\n");
    let url;
    try {
      url = new URL(target, "http://127.0.0.1");
    } catch {
      return sendText(res, 400, "Bad request\n");
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    return handleStatic(req, res, url);
  }

  return {
    server,
    get port() {
      return port;
    },
    get sseClients() {
      return clients.size;
    },
    /** @returns {Promise<number>} the bound port */
    listen(wantedPort) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(wantedPort, "127.0.0.1", () => {
          server.off("error", reject);
          port = server.address().port;
          resolve(port);
        });
      });
    },
    async close() {
      clearInterval(heartbeat);
      for (const c of clients) c.res.end();
      clients.clear();
      if (orchestrator) {
        orchestrator.off("event", broadcast);
        orchestrator.off("snapshot", broadcast);
      }
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
