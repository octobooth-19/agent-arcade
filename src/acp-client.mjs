// ACP client: newline-delimited JSON-RPC 2.0 over the stdio of one `copilot --acp --stdio` process.
// Responsibilities: framing, request/response matching, handing agent->client requests to a handler.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";

export class AcpError extends Error {
  constructor(rpcError, method) {
    super(rpcError?.message ?? "ACP error");
    this.name = "AcpError";
    this.code = rpcError?.code;
    this.data = rpcError?.data;
    this.method = method;
  }
}

export const rpcError = (code, message) => Object.assign(new Error(message), { code });

const MAX_LINE = 64 * 1024 * 1024;

/**
 * Events: "notification" (method, params), "exit" ({ code, signal, error? }), "badline" (line), "stderr" (text).
 * Agent->client requests go to the handler set with setRequestHandler(async (method, params, id) => result).
 * Throw rpcError(-32601, ...) from the handler for unsupported methods.
 */
export class AcpClient extends EventEmitter {
  constructor({ command = "copilot", args = ["--acp", "--stdio"], cwd, env } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.exited = false;
    this.nextId = 1;
    this.pending = new Map();
    this.requestHandler = null;
    this.stderrTail = "";
    this.badLines = 0;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  setRequestHandler(fn) {
    this.requestHandler = fn;
  }

  start() {
    if (this.child) throw new Error("ACP client already started");
    const child = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
      env: this.env ?? process.env,
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stderrTail = (this.stderrTail + text).slice(-4000);
      this.emit("stderr", text);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => this.#gone({ code: null, signal: null, error }));
    child.on("exit", (code, signal) => this.#gone({ code, signal }));
    return this;
  }

  #gone(info) {
    if (this.exited) return;
    this.exited = true;
    const err = new Error(info.error ? `Could not run ${this.command}: ${info.error.message}` : `ACP process exited (${info.signal ?? info.code})`);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.emit("exit", info);
  }

  #onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    let nl;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.#onLine(line);
    }
    if (this.buffer.length > MAX_LINE) {
      this.buffer = "";
      this.badLines++;
      this.emit("badline", "(line exceeded size limit)");
    }
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.badLines++;
      this.emit("badline", line.slice(0, 200));
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      this.badLines++;
      return;
    }
    if (typeof msg.method === "string") {
      if (msg.id === undefined || msg.id === null) this.emit("notification", msg.method, msg.params);
      else this.#onAgentRequest(msg);
      return;
    }
    if (msg.id === undefined) return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new AcpError(msg.error, p.method));
    else p.resolve(msg.result);
  }

  #onAgentRequest(msg) {
    const handler = this.requestHandler;
    Promise.resolve()
      .then(() => {
        if (!handler) throw rpcError(-32601, `Method not supported: ${msg.method}`);
        return handler(msg.method, msg.params, msg.id);
      })
      .then(
        (result) => this.respond(msg.id, result ?? null),
        (err) => this.respondError(msg.id, Number.isInteger(err?.code) ? err.code : -32603, err?.message ?? "Internal error"),
      );
  }

  #write(obj) {
    if (this.exited || !this.child?.stdin?.writable) return false;
    return this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  respond(id, result) {
    return this.#write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    return this.#write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  notify(method, params) {
    return this.#write({ jsonrpc: "2.0", method, params });
  }

  /** timeoutMs: 0 means no timeout (prompt turns can run for minutes). */
  request(method, params, { timeoutMs = 60000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this.exited || !this.child) return reject(new Error("ACP process is not running"));
      const id = this.nextId++;
      const entry = { resolve, reject, method, timer: null };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      if (!this.#write({ jsonrpc: "2.0", id, method, params })) {
        // write() returning false only signals backpressure; a dead pipe is caught by the exit handler.
        if (this.exited) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
          reject(new Error("ACP process is not running"));
        }
      }
    });
  }

  close({ killAfterMs = 2000 } = {}) {
    return new Promise((resolve) => {
      if (!this.child || this.exited) return resolve();
      this.once("exit", () => resolve());
      try {
        this.child.stdin.end();
      } catch {
        /* closed */
      }
      try {
        this.child.kill("SIGTERM");
      } catch {
        /* gone */
      }
      setTimeout(() => {
        if (!this.exited) {
          try {
            this.child.kill("SIGKILL");
          } catch {
            /* gone */
          }
        }
      }, killAfterMs).unref();
    });
  }
}
