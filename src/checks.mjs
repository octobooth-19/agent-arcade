// Runs the user-configured check command (sh -c) in a worker's working directory. The command comes from
// --check or .arcade.json, never from the browser.
import { spawn } from "node:child_process";

/** @returns {Promise<{ status: "pass" | "fail", code: number | null, output: string, timedOut: boolean }>} */
export function runCheck(command, cwd, { timeoutMs = 5 * 60 * 1000, maxOutput = 20000, env = {} } = {}) {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ output: output.slice(-maxOutput), timedOut, ...res });
    };
    let child;
    try {
      child = spawn("sh", ["-c", command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: { ...process.env, CI: "1", ...env },
      });
    } catch (err) {
      output = String(err.message);
      return resolve({ status: "fail", code: null, output, timedOut: false });
    }
    const onData = (chunk) => {
      output = (output + chunk.toString("utf8")).slice(-maxOutput * 2);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const killTree = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      output += `\n[check timed out after ${Math.round(timeoutMs / 1000)}s and was killed]`;
      killTree();
    }, timeoutMs);
    child.on("error", (err) => {
      output += `\n[could not start check: ${err.message}]`;
      finish({ status: "fail", code: null });
    });
    child.on("close", (code) => finish({ status: code === 0 && !timedOut ? "pass" : "fail", code }));
  });
}
