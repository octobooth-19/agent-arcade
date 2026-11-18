# Agent Arcade v1 contract

Agent Arcade is a local visual layer over the user's own GitHub Copilot. v1 ships **Pocket Studio** only (themes are v2).
No npm dependencies anywhere: Node built-ins in `src/` and `bin/`, plain ES modules in the browser. Node 18+ (tested on v26).

```
browser (public/)  <-- SSE /api/events, POST /api/command -->  bin/arcade.mjs + src/ (127.0.0.1)  <-- ACP NDJSON/stdio -->  copilot --acp
```

## Files and ownership

| Path | Owner | Notes |
| --- | --- | --- |
| `shared/state.js`, `shared/demo-engine.js`, `shared/client.js`, `fixtures/demo-timeline.json`, `docs/CONTRACT.md`, `docs/ACP-FINDINGS.md` | coordinator | Frozen. Request changes, do not edit. |
| `bin/arcade.mjs`, `src/**`, `test/bridge/**`, `README.md` | core-bridge agent | Server, ACP client, git worktrees, checks, metrics, security. |
| `public/index.html`, `public/app.js`, `public/app.css`, `public/panels/**` | app-shell agent | Theme-agnostic layout and panels. |
| `public/studio/**` | studio agent | The Pocket Studio scene, characters, tokens. |

Static serving: `public/` at `/`, `shared/` at `/shared/`, `fixtures/` at `/fixtures/`. `scripts/dev.mjs` (coordinator) is a static-only dev server for UI work.

## State and events

`shared/state.js` is the single source of truth: `createInitialState`, `reduce(state, event)`, `rebuild(events, upTo)`, `openInbox`, `workerElapsedMs`, `activeWorkerCount`, `describeEvent`. Read its comments and switch cases; the event list is the contract.
Every event is `{ type, t, ... }` where `t` = ms since run start. Skins/panels read state only and never mutate it.

Order shape (extra fields allowed): `{ id, title, ownerId, ownerRole, allowedFiles[], acceptance, prompt, dependsOn[], status }`.

## Commands (browser -> server, also implemented by the demo engine)

`POST /api/command` with header `x-arcade-token`, JSON body `{ name, ...payload }`, response `{ ok: true, data? }` or `{ ok: false, error }`.

| name | payload | meaning |
| --- | --- | --- |
| `delegate` | `{ goal }` | Start a run. Lead proposes work orders (`batch.proposed`). |
| `addOrder` / `updateOrder` / `removeOrder` | `{ order }` / `{ order }` / `{ id }` | Edit the proposed batch (also the human-authored fallback). |
| `approveBatch` | `{}` | Start workers (respecting `maxConcurrent`, dependencies, worktrees). |
| `hold` / `resume` | `{ workerId }` | Hold = `session/cancel` at the next safe point; resume = new "continue" prompt. Not a true pause. |
| `nudge` | `{ workerId, text }` | Queue a note; send as next prompt when the current turn ends. |
| `redirect` | `{ workerId, text }` | Send immediately; pre-empts the current turn. |
| `takeOver` / `handBack` | `{ workerId }` | Park the worker for the human, then resume it. |
| `holdAll` / `resumeAll` | `{}` | Hold or resume every worker. |
| `resolveApproval` | `{ approvalId, optionId }` | Answer an ACP permission request (`allow_once`, `allow_always`, `reject_once`). |
| `approveReview` | `{ reviewId }` | Live: merge that worker's branch locally (no push). |
| `sendBack` | `{ reviewId, text }` | Feedback prompt to the worker; produces a new review later. |
| `holdReview` | `{ reviewId }` | Keep the review open. |
| `suggest` / `resolveSuggestion` | `{ text, from? }` / `{ id, decision: "accept" \| "reject" }` | Audience suggestion box; presenter decides. |
| `setMaxConcurrent` | `{ value }` | 1-6. |
| `openInVSCode` | `{ path, line? }` | Runs `code -g path:line` if the `code` CLI exists. |
| `reset` | `{}` | End the run and clear state (never deletes unreviewed worktrees). |

Interrupt receipts: every hold/nudge/redirect/takeover creates a `note.added` event, later `note.delivered { atStep }` (or `note.failed`). Never describe an interrupt as instant unless it was.

## HTTP API (live mode)

- `GET /api/hello` (no token): `{ app: "agent-arcade", mode: "live" | "demo", version, needsToken: true }`. Lets the client choose live or demo.
- `GET /api/health` (token): `{ copilot: { found, version, loggedIn: true|false|"unknown" }, git: { found }, project: { name, path, isGit }, loginCommand }`.
- `GET /api/events?token=...`: Server-Sent Events. First message is a `snapshot` event with the full state, then every event as `data: <json>`. Heartbeat comment every 15 s. EventSource cannot set headers, hence the query token.
- `POST /api/command`: see above.
- `GET /api/runs` and `GET /api/runs/:id` (token): saved timelines (`.arcade/runs/*.json`, arrays of events) for replay.
- Token: random per launch, printed in the URL fragment (`http://127.0.0.1:PORT/#token=...`). Client reads and removes the fragment, keeps it in `sessionStorage`. Validate `Host` (127.0.0.1/localhost:PORT) and, when present, `Origin` on every `/api` request; reject everything else with 403. Bind 127.0.0.1 only.

## Client SDK (`shared/client.js`)

```js
import { connectArcade } from "/shared/client.js";
const arcade = await connectArcade({ source: "auto" });   // "auto" | "live" | "demo" | "replay"
arcade.source            // "live" | "demo" | "replay"
arcade.getState()        // current state (read-only)
arcade.subscribe(fn)     // fn(state, event|null); returns unsubscribe
arcade.command(name, payload) // Promise<{ ok, error?, data? }>
arcade.setSpeed(x)       // demo only
arcade.replay            // replay controls when source is "replay": { length, index, seek(i), play(), pause(), playing, speed }
arcade.health()          // Promise: live => /api/health payload; demo => { demo: true, copilot: {found:false...}, project }
arcade.listRuns()        // live only: Promise<{ ok, data: [{ id, startedAt, goal, events }] }> (shape owned by the bridge)
arcade.loadRun(id)       // live only: Promise<event[]|null>
arcade.recordEvents()    // copy of events so far (live or demo), ready for createReplay(events)
arcade.hello             // /api/hello payload or null;  arcade.needsToken: true when the server is live but no token is present
arcade.close()
import { createReplay } from "/shared/client.js";
const replay = createReplay(events);   // same shape as an arcade object with source "replay"; commands return { ok:false, error:"Replay is read-only" }
```

Rules for UI code:
- `getState()` returns ONE mutable object that is updated in place; compare `state.rev` to detect change. In demo mode `reset` swaps the object, so always call `getState()` again or use the `state` argument given to `subscribe` callbacks. Never mutate it.
- `subscribe(fn)` calls `fn(state, null)` immediately, then `fn(state, event)` for each event (including `clock` ticks, about once per second, so timers stay fresh). Events not worth redrawing for can be skipped by checking `event.type`.
- `command()` never throws; it resolves `{ ok:false, error }` with a short human-readable error that can be shown directly to the user.
- Demo mode: `delegate` shows scripted work orders (the goal text is only echoed). Replying to a demo `suggestedGoal` is in `arcade.fixture.suggestedGoal`. Demo `openInVSCode` returns `{ ok:false }`. Demo speed 0.25x to 8x via `setSpeed`.
- Time: `state.now` is virtual milliseconds since run start. Use `workerElapsedMs(state, worker)` for desk timers, not `Date.now()`.
```

Auto picks live when `/api/hello` says live and a token exists, otherwise demo. Demo mode is entirely in the browser (`shared/demo-engine.js`) and works offline; it is always labeled "DEMO, scripted" in the UI.

## Studio module (`public/studio/studio.js`)

```js
export function mountStudio(el, ctx) -> { update(state), destroy() }
// ctx = { getState(), select(workerId|null), selectedId(), command(name, payload), reducedMotion: boolean }
export function characterSvg(role, status, { size = 64 } = {}) -> string   // inline SVG markup, state-driven pose
export const sounds = { play(name) }   // names: "approval", "stamp", "dispatch"; no-ops until the user enables sound
export const labels = { appName, roles: { lead, planner, builder, checker }, statuses: { ... } }
```
The scene fills its container (min 480x320), re-renders cheaply on `update`, selects a worker on click or Enter/Space, and shows each worker's state (idle, working, waiting approval, held, blocked, done) and the stage door queue. Only original characters; Octocat is not used.

## CSS tokens

`public/studio/tokens.css` defines the variables the app uses: `--bg --surface --surface-2 --ink --ink-soft --line --accent --accent-ink --good --warn --bad --role-lead --role-planner --role-builder --role-checker --radius --radius-lg --shadow --font-display --font-body --font-mono`. `public/app.css` uses only these variables (no hard-coded colors), so a future theme can replace `tokens.css` and the studio module.

## Live bridge behavior (core-bridge agent)

1. **Startup:** `node bin/arcade.mjs [project-folder] [--demo] [--port N] [--max N] [--model ID] [--check "cmd"] [--no-open]`. Optional `<project>/.arcade.json`: `{ "check": "npm test", "maxConcurrent": 3, "model": "claude-haiku-4.5" }`. Default model: leave the CLI default and show it. Print the tokenized URL and open the browser (`open` on macOS) unless `--no-open`.
2. **One ACP process** (`copilot --acp --stdio`), many sessions. If `copilot` is missing or not logged in, serve the UI anyway and report it via `/api/health` and a `connection` event with `state: "error"`.
3. **Lead:** read-only by policy. Start it in the project cwd with a prompt that asks for JSON only: `{"orders":[{"title","ownerRole":"planner|builder|checker","allowedFiles":[],"acceptance":"","prompt":"","dependsOn":[]}]}`, 2-5 orders. Tolerate fenced JSON. If parsing fails, add an `inbox.add` question item and let the human author orders with `addOrder`. Permission requests from the Lead for edit/execute are answered `reject_once` by policy and logged to its output; this is the only automatic answer allowed.
4. **Workers:** each order becomes a worker with its own session. Builders run in a git worktree (`<project>/.arcade/worktrees/<id>`, branch `arcade/<runId>/<id>`) when the project is a git repo; planners/checkers run in the project cwd. If not a git repo, force `maxConcurrent` to 1 and say so in a `connection` message. Add `.arcade/` to the worktree-safe ignore via `.git/info/exclude`, never by editing tracked files. Workers wait (`queued`, with a reason) for `dependsOn` reviews to be approved and for capacity.
5. **Events:** translate every ACP update to the reducer's events (`worker.step`, `worker.file` from diff content, `worker.output`, `worker.usage` from `usage_update`, `approval.requested` from `session/request_permission`, ...). Unknown update types become a single `worker.output` line `[unsupported update: type]`; never invent progress.
6. **Permissions:** never auto-approve (except the Lead rule above). The pending JSON-RPC request id is held until `resolveApproval`.
7. **Interrupts:** implement exactly as `docs/ACP-FINDINGS.md` describes, with accurate receipts.
8. **Checks:** if a check command is configured, run it in the worker's worktree after a builder's turn ends (`sh -c`, 5 min timeout, output capped) and emit `check.run`; failure => `blocked` + `inbox.add` failed_check. With no check configured the review says so; do not fake checks.
9. **Review:** on a worker finishing, emit `review.ready` with summary (last agent message), files (+/-), and diff (`git diff` against the base). `approveReview` merges with `git merge --no-ff` into the project's current branch only if the working tree is clean; on conflict `git merge --abort` and report in `mergeResult`. Never push. After a successful merge remove that worktree and branch. Never delete a worktree whose changes were not merged.
10. **Metrics:** every 3 s emit `metrics` (RSS via `ps`) for the server process, the copilot process and its descendants. These are estimates.
11. **Persistence:** append the run's events to `.arcade/runs/<runId>.json` (written as a JSON array on each review decision and on exit). It is local only; tool output may contain secrets, so say so in the README.
12. **Shutdown:** on SIGINT/SIGTERM cancel running turns, close ACP, print any worktrees that still hold unmerged work.
13. **Tests:** `node --test test/bridge/` using a fake ACP agent script (`test/bridge/fake-acp.mjs`) so no premium requests are spent. Cover framing, permission broker, interrupt semantics, worktree create/merge/abort, token and Origin checks, JSON order parsing. One optional live smoke test is gated behind `ARCADE_LIVE=1`.
14. **Security:** commands never build shell strings from user text; use `execFile`/`spawn` with argument arrays. Validate `workerId`/`reviewId` against state. Treat model output as untrusted (never inject it as HTML on the server).
