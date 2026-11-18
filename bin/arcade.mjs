#!/usr/bin/env node
// Agent Arcade: a local visual layer over your own GitHub Copilot CLI.
//   node bin/arcade.mjs [project-folder] [--demo] [--port N] [--max N] [--model ID] [--check "cmd"] [--no-open]
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Orchestrator } from "../src/orchestrator.mjs";
import { VERSION } from "../src/prompts.mjs";
import { RunStore } from "../src/run-store.mjs";
import { generateToken } from "../src/security.mjs";
import { createBridgeServer } from "../src/server.mjs";
import { isTracked } from "../src/worktree.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 4747;

const USAGE = `Agent Arcade ${VERSION}: a visual layer over your own GitHub Copilot CLI

Usage:
  node bin/arcade.mjs [project-folder] [options]

Options:
  --demo          Serve the UI with the scripted demo (no Copilot process is started)
  --port N        Port to listen on (default: first free port from ${DEFAULT_PORT})
  --max N         Agents working at once, 1-6 (default 3)
  --model ID      Copilot model for every agent (default: Copilot's own default)
  --check "cmd"   Command run in each worktree after a builder finishes (e.g. "npm test")
  --no-open       Do not open the browser
  -h, --help      Show this help

Optional <project>/.arcade.json: { "check": "npm test", "maxConcurrent": 3, "model": "claude-haiku-4.5" }
`;

function fail(message, code = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function intOption(value, name, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

async function main() {
  if (Number(process.versions.node.split(".")[0]) < 18) fail(`Agent Arcade needs Node 18 or newer (this is ${process.versions.node}).`);

  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        demo: { type: "boolean", default: false },
        port: { type: "string" },
        max: { type: "string" },
        model: { type: "string" },
        check: { type: "string" },
        "no-open": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (err) {
    fail(`${err.message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (positionals.length > 1) fail(`Expected one project folder, got ${positionals.length}.\n\n${USAGE}`);

  const wantedProject = positionals[0] ?? process.cwd();
  const expanded = wantedProject === "~" || wantedProject.startsWith("~/") ? path.join(os.homedir(), wantedProject.slice(1)) : wantedProject;
  let projectDir;
  try {
    projectDir = fs.realpathSync(path.resolve(expanded));
    if (!fs.statSync(projectDir).isDirectory()) throw new Error("not a directory");
  } catch {
    fail(`Project folder not found: ${wantedProject}`);
  }

  // Project settings: CLI flags win over .arcade.json. A check command from a git-tracked file would run code that
  // arrived with the repository, so it is ignored unless you pass --check yourself or set ARCADE_TRUST_CONFIG=1.
  const config = await readConfig(projectDir, { cliCheck: values.check });
  const maxConcurrent = values.max !== undefined ? intOption(values.max, "--max", 1, 6) : (config.maxConcurrent ?? 3);
  const model = values.model ?? config.model ?? null;
  if (model !== null && !/^[A-Za-z0-9._:/-]{1,100}$/.test(model)) fail("--model must be a Copilot model id such as claude-haiku-4.5.");
  const check = values.check ?? config.check ?? null;
  const explicitPort = values.port !== undefined ? intOption(values.port, "--port", 0, 65535) : null;

  const token = generateToken();
  const mode = values.demo ? "demo" : "live";
  const orchestrator =
    mode === "live"
      ? new Orchestrator({ projectDir, model, check, maxConcurrent, log: (m) => process.stderr.write(`[arcade] ${m}\n`) })
      : null;
  const runStore = orchestrator?.runStore ?? new RunStore(projectDir);
  const bridge = createBridgeServer({
    orchestrator,
    mode,
    token,
    projectDir,
    publicDir: path.join(ROOT, "public"),
    sharedDir: path.join(ROOT, "shared"),
    fixturesDir: path.join(ROOT, "fixtures"),
    runStore,
    log: (m) => process.stderr.write(`[arcade] ${m}\n`),
  });

  let port;
  if (explicitPort !== null) {
    try {
      port = await bridge.listen(explicitPort);
    } catch (err) {
      fail(err.code === "EADDRINUSE" ? `Port ${explicitPort} is already in use. Pick another with --port, or omit it to use the first free port.` : `Could not listen: ${err.message}`, 1);
    }
  } else {
    for (let p = DEFAULT_PORT; p < DEFAULT_PORT + 100 && port === undefined; p++) {
      try {
        port = await bridge.listen(p);
      } catch (err) {
        if (err.code !== "EADDRINUSE") fail(`Could not listen: ${err.message}`, 1);
      }
    }
    if (port === undefined) fail(`No free port found from ${DEFAULT_PORT} to ${DEFAULT_PORT + 99}. Use --port.`, 1);
  }

  if (orchestrator) await orchestrator.start();

  const url = `http://127.0.0.1:${port}/#token=${token}`;
  const lines = [
    `Agent Arcade ${VERSION} (${mode})`,
    `Project: ${projectDir}`,
    mode === "live" ? `Check:   ${check ?? "none (nothing is verified automatically)"}` : "Demo mode: scripted, no Copilot process is started.",
    ...config.notes,
    ...(orchestrator?.leftoverNote ? [orchestrator.leftoverNote] : []),
    "",
    "Open this link in your browser. It contains a private token, so do not share it:",
    `  ${url}`,
    "",
    "Press Ctrl+C to stop.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  if (!values["no-open"]) openBrowser(url);

  let stopping = false;
  const stop = async (signal) => {
    if (stopping) process.exit(130);
    stopping = true;
    process.stdout.write(`\nStopping (${signal})...\n`);
    const force = setTimeout(() => process.exit(1), 8000);
    force.unref();
    try {
      const result = orchestrator ? await orchestrator.shutdown() : { worktrees: [] };
      await bridge.close();
      if (result.worktrees.length) {
        process.stdout.write(`\n${result.worktrees.length} worktree${result.worktrees.length === 1 ? " still holds" : "s still hold"} work that is not merged. Nothing was deleted:\n`);
        for (const w of result.worktrees) process.stdout.write(`  ${w.branch}  ${w.path}  (${w.commitsAhead} commit${w.commitsAhead === 1 ? "" : "s"} ahead, ${w.dirtyFiles} uncommitted file${w.dirtyFiles === 1 ? "" : "s"})\n`);
      }
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("unhandledRejection", (err) => process.stderr.write(`[arcade] unhandled rejection: ${err?.message ?? err}\n`));
}

async function readConfig(projectDir, { cliCheck }) {
  const out = { check: null, maxConcurrent: null, model: null, notes: [] };
  const file = path.join(projectDir, ".arcade.json");
  let raw;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 64 * 1024) {
      out.notes.push("Ignoring .arcade.json (not a regular file or too large).");
      return out;
    }
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    out.notes.push("Ignoring .arcade.json: it is not valid JSON.");
    return out;
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    out.notes.push("Ignoring .arcade.json: expected a JSON object.");
    return out;
  }
  if (typeof cfg.maxConcurrent === "number" && Number.isInteger(cfg.maxConcurrent) && cfg.maxConcurrent >= 1 && cfg.maxConcurrent <= 6) out.maxConcurrent = cfg.maxConcurrent;
  else if (cfg.maxConcurrent !== undefined) out.notes.push("Ignoring .arcade.json maxConcurrent (use a whole number from 1 to 6).");
  if (typeof cfg.model === "string" && /^[A-Za-z0-9._:/-]{1,100}$/.test(cfg.model)) out.model = cfg.model;
  else if (cfg.model !== undefined) out.notes.push("Ignoring .arcade.json model (not a valid model id).");
  if (typeof cfg.check === "string" && cfg.check.trim() && cfg.check.length <= 500) {
    if (cliCheck !== undefined) {
      /* --check wins */
    } else if ((await isTracked(projectDir, ".arcade.json").catch(() => false)) && process.env.ARCADE_TRUST_CONFIG !== "1") {
      out.notes.push(`Ignoring the check command in .arcade.json because that file is tracked by git (it could have arrived with the repository). Pass --check "${cfg.check.trim().slice(0, 80)}" or set ARCADE_TRUST_CONFIG=1 to use it.`);
    } else {
      out.check = cfg.check.trim();
    }
  } else if (cfg.check !== undefined) {
    out.notes.push("Ignoring .arcade.json check (expected a non-empty command under 500 characters).");
  }
  return out;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(cmd, args, { windowsHide: true }, () => {
    /* the link is printed above, so a missing opener is not an error */
  });
}

main().catch((err) => fail(`Agent Arcade could not start: ${err?.message ?? err}`, 1));
