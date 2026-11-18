// Git helpers: worktrees per writing worker, checkpoint commits, review diffs, and a safe local merge.
// Every call uses execFile with an argument array (no shell). Nothing here ever pushes.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_PAGER: "cat", LC_ALL: "C" };
const MAX_FILE_DIFF = 60 * 1024;
const MAX_TOTAL_DIFF = 300 * 1024;
const MAX_FILES_WITH_DIFF = 60;

/** Never throws. Resolves { code, stdout, stderr }; code 127 when git itself is missing. */
export function git(cwd, args, { timeoutMs = 60000, env = {}, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, env: { ...process.env, ...GIT_ENV, ...env }, timeout: timeoutMs, maxBuffer, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && err.code === "ENOENT") return resolve({ code: 127, stdout: "", stderr: "git was not found", missing: true });
        let code = 0;
        if (err) code = typeof err.code === "number" ? err.code : 1;
        let errText = String(stderr);
        if (err?.killed) errText += "\n[git timed out]";
        resolve({ code, stdout: String(stdout), stderr: errText });
      },
    );
  });
}

export async function gitVersion() {
  const r = await git(process.cwd(), ["--version"], { timeoutMs: 10000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** { isGit, root, prefix, hasCommits, head, branch } (branch is null when detached). */
export async function gitInfo(dir) {
  const r = await git(dir, ["rev-parse", "--show-toplevel", "--show-prefix"]);
  if (r.code !== 0) return { isGit: false, hasCommits: false, root: null, prefix: "", head: null, branch: null };
  const [root, prefix = ""] = r.stdout.split("\n");
  const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
  const br = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return {
    isGit: true,
    root,
    prefix: prefix.trim(),
    hasCommits: head.code === 0,
    head: head.code === 0 ? head.stdout.trim() : null,
    branch: br.code === 0 ? br.stdout.trim() : null,
  };
}

/** Is this path tracked by git? Used to avoid trusting a committed .arcade.json check command. */
export async function isTracked(dir, relPath) {
  const r = await git(dir, ["ls-files", "--error-unmatch", "--", relPath]);
  return r.code === 0;
}

/** Make sure the repo ignores `.arcade/` via .git/info/exclude. Never touches tracked files. */
export async function ensureExclude(root) {
  const r = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (r.code !== 0) return { ok: false };
  const file = path.resolve(root, r.stdout.trim());
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    /* new file */
  }
  if (existing.split(/\r?\n/).some((l) => [".arcade", ".arcade/", "/.arcade", "/.arcade/"].includes(l.trim()))) return { ok: true, changed: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}.arcade/\n`);
  return { ok: true, changed: true, file };
}

/** Env that supplies a committer identity only when the user has none configured. */
export async function identityEnv(root) {
  const name = await git(root, ["config", "user.name"]);
  const email = await git(root, ["config", "user.email"]);
  const env = {};
  if (!name.stdout.trim()) Object.assign(env, { GIT_AUTHOR_NAME: "Agent Arcade", GIT_COMMITTER_NAME: "Agent Arcade" });
  if (!email.stdout.trim()) Object.assign(env, { GIT_AUTHOR_EMAIL: "arcade@localhost", GIT_COMMITTER_EMAIL: "arcade@localhost" });
  return env;
}

const oneLine = (s, max = 100) => String(s ?? "").replace(/[\r\n\u0000]+/g, " ").trim().slice(0, max);

export async function createWorktree({ root, prefix = "", projectDir, runId, workerId }) {
  const wtPath = path.join(projectDir, ".arcade", "worktrees", `${runId}-${workerId}`);
  const branch = `arcade/${runId}/${workerId}`;
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]);
  if (head.code !== 0) throw new Error("The repository has no commits yet, so a worktree cannot be created.");
  const baseSha = head.stdout.trim();
  fs.mkdirSync(path.dirname(wtPath), { recursive: true, mode: 0o700 });
  const r = await git(root, ["worktree", "add", "-b", branch, wtPath, baseSha]);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return { path: wtPath, branch, baseSha, cwd: prefix ? path.join(wtPath, prefix) : wtPath };
}

/** Commit everything in the worktree as a checkpoint on the worker branch. */
export async function commitAll(wtPath, message, env = {}) {
  const add = await git(wtPath, ["add", "-A"]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.stderr.trim()}`);
  const st = await git(wtPath, ["status", "--porcelain"]);
  if (!st.stdout.trim()) return { committed: false };
  const r = await git(wtPath, ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", oneLine(message)], { env });
  if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr.trim() || r.stdout.trim()}`);
  const sha = await git(wtPath, ["rev-parse", "HEAD"]);
  return { committed: true, sha: sha.stdout.trim() };
}

const clip = (text, max) => (text.length > max ? text.slice(0, max) + "\n… diff truncated …\n" : text);

/** Diff of everything the worker branch changed since baseSha: { diff, files: [{ path, added, removed, diff }] }. */
export async function diffAgainst(wtPath, baseSha) {
  const base = ["-c", "core.quotepath=false", "diff", "--no-renames", "--no-ext-diff", "--no-textconv"];
  const num = await git(wtPath, [...base, "--numstat", "-z", baseSha, "HEAD"]);
  const files = [];
  for (const rec of num.stdout.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (m) files.push({ path: m[3], added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]), diff: "" });
  }
  const full = await git(wtPath, [...base, baseSha, "HEAD"]);
  for (const f of files.slice(0, MAX_FILES_WITH_DIFF)) {
    const one = await git(wtPath, [...base, baseSha, "HEAD", "--", f.path]);
    f.diff = clip(one.stdout, MAX_FILE_DIFF);
  }
  return { diff: clip(full.stdout, MAX_TOTAL_DIFF), files };
}

export async function trackedChanges(root) {
  const r = await git(root, ["status", "--porcelain", "--untracked-files=no"]);
  return r.stdout.split("\n").filter((l) => l.trim());
}

/**
 * Merge `branch` into the project's current branch with --no-ff, only when tracked files are clean.
 * On conflict the merge is aborted. Never pushes.
 * @returns {{ ok: boolean, reason?: string, message: string, sha?: string, conflicts?: string[] }}
 */
export async function mergeBranch({ root, branch, message, env = {} }) {
  const dirty = await trackedChanges(root);
  if (dirty.length) {
    return {
      ok: false,
      reason: "dirty",
      message: `Your project has uncommitted changes to ${dirty.length} tracked file${dirty.length === 1 ? "" : "s"}. Commit or stash them, then approve again. Nothing was merged.`,
    };
  }
  const br = await git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (br.code !== 0) {
    return { ok: false, reason: "detached", message: "Your project is on a detached HEAD. Check out a branch, then approve again. Nothing was merged." };
  }
  const current = br.stdout.trim();
  const before = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
  const r = await git(root, ["merge", "--no-ff", "--no-edit", "-m", oneLine(message, 200), branch], { env });
  if (r.code === 0) {
    const sha = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    const upToDate = sha === before;
    return {
      ok: true,
      sha,
      message: upToDate ? `Nothing new to merge into ${current}.` : `Merged ${branch} into ${current} (merge commit ${sha.slice(0, 7)}). Nothing was pushed.`,
    };
  }
  const conflicts = (await git(root, ["diff", "--name-only", "--diff-filter=U"])).stdout.split("\n").filter(Boolean);
  const inMerge = (await git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"])).code === 0;
  if (inMerge) await git(root, ["merge", "--abort"]);
  const left = await trackedChanges(root);
  const tail = left.length ? " The abort left some changes behind; check `git status`." : " Your project is unchanged.";
  if (conflicts.length) {
    return { ok: false, reason: "conflict", conflicts, message: `Merge conflict in ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? ", …" : ""}. The merge was aborted.${tail}` };
  }
  return { ok: false, reason: "failed", message: `git merge failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}.${tail}` };
}

/** Remove a merged worktree and its branch. Refuses (returns ok:false) rather than forcing anything. */
export async function removeWorktree({ root, path: wtPath, branch }) {
  const merged = await git(root, ["merge-base", "--is-ancestor", branch, "HEAD"]);
  if (merged.code !== 0) return { ok: false, message: `Kept ${wtPath}: its branch is not merged into your current branch.` };
  const rm = await git(root, ["worktree", "remove", wtPath]);
  if (rm.code !== 0) return { ok: false, message: `Kept ${wtPath}: ${rm.stderr.trim().split("\n")[0] || "git could not remove it"}.` };
  const del = await git(root, ["branch", "-d", branch]);
  return { ok: del.code === 0, message: del.code === 0 ? "Worktree and branch removed." : `Worktree removed; branch ${branch} kept (${del.stderr.trim().split("\n")[0]}).` };
}

/** Worktrees under <projectDir>/.arcade/worktrees that still hold work (uncommitted files or commits not on HEAD). */
export async function unmergedWorktrees({ root, projectDir }) {
  const dir = path.join(projectDir, ".arcade", "worktrees") + path.sep;
  const list = await git(root, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) return [];
  const found = [];
  let cur = null;
  for (const line of list.stdout.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9), branch: null };
    else if (line.startsWith("branch ") && cur) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (!line && cur) {
      found.push(cur);
      cur = null;
    }
  }
  if (cur) found.push(cur);
  const out = [];
  for (const wt of found) {
    let real;
    try {
      real = fs.realpathSync(wt.path);
    } catch {
      continue;
    }
    const realDir = (() => {
      try {
        return fs.realpathSync(dir) + path.sep;
      } catch {
        return dir;
      }
    })();
    if (!real.startsWith(realDir) || !wt.branch) continue;
    const dirty = (await git(wt.path, ["status", "--porcelain"])).stdout.split("\n").filter((l) => l.trim()).length;
    const ahead = Number((await git(root, ["rev-list", "--count", `HEAD..${wt.branch}`])).stdout.trim()) || 0;
    if (dirty || ahead) out.push({ path: wt.path, branch: wt.branch, dirtyFiles: dirty, commitsAhead: ahead });
  }
  return out;
}

/** For shutdown reports: does this worktree still hold work that is not in the project's branch? */
export async function worktreeStatus({ root, path: wtPath, baseSha }) {
  const dirty = (await git(wtPath, ["status", "--porcelain"])).stdout.split("\n").filter((l) => l.trim()).length;
  const ahead = Number((await git(wtPath, ["rev-list", "--count", `${baseSha}..HEAD`])).stdout.trim()) || 0;
  return { dirtyFiles: dirty, commitsAhead: ahead, hasWork: dirty > 0 || ahead > 0 };
}
