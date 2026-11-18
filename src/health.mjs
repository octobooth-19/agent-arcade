// Environment detection used by /api/health in both live and demo mode.
import { execFile } from "node:child_process";
import path from "node:path";
import { gitInfo, gitVersion } from "./worktree.mjs";

/** @returns {Promise<{ found: boolean, version: string | null }>} */
export function detectCopilot({ command = "copilot", prefixArgs = [] } = {}) {
  return new Promise((resolve) => {
    execFile(command, [...prefixArgs, "--version"], { timeout: 15000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ found: false, version: null });
      const first = String(stdout).split("\n").find((l) => l.trim()) ?? "";
      resolve({ found: true, version: first.trim() || null });
    });
  });
}

export async function detectProject(projectDir) {
  const info = await gitInfo(projectDir);
  return {
    name: path.basename(projectDir) || projectDir,
    path: projectDir,
    isGit: info.isGit,
    git: info,
  };
}

export async function detectGit() {
  const version = await gitVersion();
  return { found: version !== null, version };
}
