# Agent Arcade

Created by **kumarsashank** · GitHub: [@kumarsashank](https://github.com/KumarSashank).

A local web app that is a visual layer over **your own GitHub Copilot CLI**. You give a goal; a read-only Lead
agent proposes work orders; you approve them; builders work in separate git worktrees at the same time; you review
each diff and merge it (or send it back). The UI and bridge run on your machine, and Copilot does the actual work.

Agent Arcade does not replace Copilot or add a separate model provider. It starts `copilot --acp --stdio`
(the Agent Client Protocol) on your machine and shows what that process reports. Live mode uses Copilot's cloud
model services under your own account; the scripted demo makes no model requests.

## Quickstart

```sh
git clone https://github.com/octobooth-19/agent-arcade.git
cd agent-arcade

node bin/arcade.mjs ~/my-project        # live: drives your real Copilot CLI in that git repo
node bin/arcade.mjs --demo              # scripted demo in the browser; no Copilot process, nothing is touched
```

The command prints a link such as `http://127.0.0.1:4747/#token=...` and opens it with `open` (macOS), `xdg-open`
(Linux) or `start` (Windows). The link contains a private token, so do not share it. Use `--no-open` to only print it.
Press Ctrl+C to stop.

Options:

| Option | Meaning |
| --- | --- |
| `[project-folder]` | The project to work on (default: the current folder). A git repository with at least one commit is needed for parallel agents and merging. |
| `--demo` | Serve the UI with its built-in scripted demo. No Copilot process is started. |
| `--port N` | Listen on this port (default: the first free port from 4747). |
| `--max N` | Agents working at once, 1-6 (default 3). Also adjustable in the UI. |
| `--model ID` | Copilot model for every agent (default: Copilot's own default). |
| `--check "cmd"` | Command run in each builder's worktree before review, for example `npm test`. |
| `--no-open` | Do not open the browser. |

Optional `<project>/.arcade.json`: `{ "check": "npm test", "maxConcurrent": 3, "model": "claude-haiku-4.5" }`.
Command-line flags win. A `check` from a `.arcade.json` that is **tracked by git** is ignored (it would run code that
arrived with the repository) unless you pass `--check` yourself or set `ARCADE_TRUST_CONFIG=1`.

## Prerequisites

- Node.js 18 or newer. There are no npm dependencies and nothing to install.
- For live mode: the GitHub Copilot CLI (`copilot`) on your `PATH`, and signed in (`copilot login`).
  `git` must be installed too. `code` (VS Code's command) is only needed for "Open in VS Code".
- The UI still loads if `copilot` is missing or signed out. The connection banner says what is wrong and the
  `/api/health` view shows the login command Copilot reported.

Tested on macOS with Node 26 and Copilot CLI 1.0.114. Linux should work; Windows is untested.

## How worktrees and merging work

- Each builder gets its own git worktree at `<project>/.arcade/worktrees/<run>-<worker>` on a new branch
  `arcade/<run>/<worker>`, created from your current `HEAD`. Agents never edit your working folder directly, so
  parallel agents cannot step on each other and your own uncommitted work is not touched.
  `.arcade/` is added to `.git/info/exclude` (your `.gitignore` is not modified).
- When a builder finishes, Arcade commits its work on that branch, runs your check (if you set one), and shows the diff.
  A failing check does not reach review: the agent shows as blocked with the output in your inbox, and you press
  Resume or Redirect to have it fix the problem.
- **Approve** runs a local `git merge --no-ff` into the branch you have checked out, then removes the worktree and
  branch. It refuses if you have uncommitted changes to tracked files or are on a detached HEAD, and it aborts and
  reports a conflict instead of leaving a half-merged tree. Nothing is ever pushed.
- **Send back** gives the same Copilot session your feedback as a new prompt. **Hold** keeps the review open.
- Unmerged worktrees are never deleted automatically (not on reset, not on exit). Remove one yourself with
  `git worktree remove <path>` and `git branch -D <branch>` when you no longer want it.
- If the project is not a git repository (or has no commits), agents run one at a time directly in the folder and
  there is nothing to merge. Arcade tells you so.

## What is and is not instant

Interrupts follow what Copilot's ACP actually supports, and the UI shows a receipt for each one:

- **Hold / Take over** sends ACP `session/cancel`. This is a cancel, **not a pause**. Copilot stops at its next safe
  point (not necessarily mid-tool-call). The desk shows "held" only once Copilot confirms. **Resume** sends a new
  "continue" prompt in the same session; the agent restarts from the conversation so far.
- **Nudge** is queued and sent as the next prompt after the current turn ends. It never interrupts.
- **Redirect** sends a new prompt immediately, which pre-empts the running turn (the old turn ends as cancelled).
  It is immediate to send, but the agent still finishes its current step before it reacts.
- **Take over / Hand back**: after the cancel is confirmed the worktree is yours to edit. Hand back prompts the agent
  to re-read the files and continue; your edits become part of the diff.
- Hold on a queued worker is instant because nothing is running yet.

## Security model

Agent Arcade is a local tool that can start an agent that edits files, so the server is strict:

- Binds **127.0.0.1 only**. A random token is generated at every launch (`crypto.randomBytes`) and appears only in the
  printed link (in the URL fragment, which browsers do not send to the server). It is never logged elsewhere.
- Every `/api` route except `/api/hello` needs the token (compared in constant time), sent as the `x-arcade-token`
  header. The one exception is the event stream, whose `EventSource` cannot set headers, so it also accepts `?token=`.
- The `Host` and `Origin` headers are validated on every `/api` request, which blocks DNS-rebinding and cross-site
  requests. Request bodies are size-limited and must be JSON.
- Static files are served only from `public/`, `shared/` and `fixtures/`. Path traversal and symlinks that leave those
  folders are refused. Responses carry a restrictive Content-Security-Policy.
- No shell strings are built from user text: git, `copilot` and `code` are started with argument arrays, and ids from
  the browser are checked against the current state. The only shell command is your own `--check`, which you supply.
- **Permissions are never auto-approved.** A worker's permission request is held until you answer it in the UI;
  holding the worker cancels it. The one automatic answer is `reject_once` for edit/execute requests from the
  read-only Lead.
- This is not a sandbox. Arcade shows and answers what Copilot asks about, and some tool calls (for example certain
  shell commands) can run without Copilot asking. Worktrees isolate agents from your working folder, but a
  Copilot process runs with your user permissions. Treat it like running Copilot CLI yourself.

## Where run files are stored

Each run is saved to `<project>/.arcade/runs/<runId>.json` (a JSON array of events, mode `0600`, folder `0700`), and
can be reopened from the UI's run list. **These files can contain secrets**: they include agent output, command
output, diffs and your goal text. They are excluded from git, but do not share or commit them. Delete the
`.arcade/` folder to remove everything Arcade stored (after removing any worktrees you still want to keep or merge).

## Premium requests

Live mode uses your Copilot subscription. Every agent turn (the Lead, each builder, and each Resume, Nudge, Redirect
and Send back) is a Copilot request and can consume premium requests, depending on your plan and model. Use `--model` with a cheaper model while experimenting, keep goals small, and use
`--demo` to explore the interface for free. The app displays measured process footprints (server, Copilot process
and its children, from `ps`); these are estimates, not billing or savings figures.

## Troubleshooting

- **Copilot is not found**: install the Copilot CLI and make sure `copilot --version` works in the same terminal.
- **Copilot is not signed in**: run the login command shown in the banner (normally `copilot login`), then reload.
- **Nothing merges / "uncommitted changes"**: commit or stash changes to tracked files in the project, then approve again.
- **Merge conflict**: the merge is aborted and your project is unchanged. Use Send back to ask the agent to rebase its
  work onto the latest changes, or merge the branch by hand (`git merge arcade/...`).
- **Only one agent runs at a time**: the project is not a git repository with at least one commit, or `--max 1`.
- **The page says it has no access token**: open the link printed in the terminal by the current run (the token
  changes on every launch).
- **Port in use**: the default port scans upward from 4747; with `--port N` the port must be free.
- **Copilot process died**: the desks show the error. Reset the run (worktrees are kept) and delegate again.
- **Checks fail in a fresh worktree**: worktrees contain only committed files, so dependencies such as
  `node_modules` are not installed there. Make the check install what it needs, for example `npm ci && npm test`.

## Tests

```sh
node --test test/                           # everything: 268 pass, 2 skipped (live tests); fake ACP agent, no premium requests
ARCADE_LIVE=1 node --test test/bridge/live.test.mjs test/bridge/live-steer.test.mjs   # real Copilot, haiku, a few requests
```

The fake agent (`test/bridge/fake-acp.mjs`) speaks the same newline-delimited JSON-RPC as `copilot --acp`. Test
scratch folders are created under `.scratch/` in the project and removed afterwards.

**Verified on real Copilot (macOS, Copilot CLI 1.0.114):** delegate, approve a batch, two builders at once,
permission prompts, review with diff and check, and merge from the browser UI. Hold, redirect and nudge were
verified separately through the bridge's live steering test.
**Not yet verified on real Copilot:** take over / hand back, send back, Windows, Linux. Details and measured numbers
are in `docs/ACP-FINDINGS.md`.

## Layout

`bin/arcade.mjs` (CLI) · `src/` (server, security, ACP client, orchestrator and commands, worktrees, checks, metrics,
run store, order parser) · `public/` (the UI) · `shared/` (state reducer and browser client shared with the demo) ·
`docs/` (contract and the verified ACP behavior).
