# ACP findings (verified on this machine, Copilot CLI 1.0.114)

Source of truth for the live bridge. Spike scripts: `scripts/acp-handshake.mjs`, `scripts/acp-turn.mjs`.
The ACP server is public preview and may change; the bridge must tolerate unknown update types.

## Transport and startup

- Spawn `copilot --acp --stdio`. Newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout is protocol only; stderr is free.
- Client sends `initialize` with `{ protocolVersion: 1, clientCapabilities: {} }`.
  Response: `agentCapabilities { loadSession, sessionCapabilities { list, close }, promptCapabilities { image, embeddedContext } }`,
  `agentInfo { name, version }`, `authMethods [{ id: "copilot-login", _meta["terminal-auth"] { command, args: ["login"] } }]`.
- The existing Copilot CLI login is reused automatically. If a call fails with an auth error, show the login command from `authMethods`.
- **One process hosts many sessions.** Two `session/new` calls returned distinct session IDs on one process.
- Idle RSS sample (single measurement, not a benchmark): ~188 MB after init, ~219 MB with one session, ~223 MB with two.

## Sessions

- `session/new { cwd, mcpServers: [] }` returns `{ sessionId, models { currentModelId, availableModels[{ modelId }] }, modes { currentModeId, availableModes[{ id }] }, configOptions[] }`.
- Mode ids are URLs: `https://agentclientprotocol.com/protocol/session-modes#agent | #plan | #autopilot`. Default is agent mode.
- `session/set_model { sessionId, modelId }` works (verified with `claude-haiku-4.5`).
- `session/set_mode` exists per spec (not yet exercised). `session/list`, `session/load`, `session/close` are advertised.
- Tool filters and reasoning effort are fixed when the server starts (`--available-tools`, `--excluded-tools`, `--effort`), not per session.

## Prompt turn

- `session/prompt { sessionId, prompt: [{ type: "text", text }] }` stays pending for the whole turn and resolves with
  `{ stopReason: "end_turn" | "cancelled" | ..., usage { inputTokens, outputTokens, totalTokens, thoughtTokens?, cachedReadTokens, cachedWriteTokens } }`.
- Streaming `session/update` notifications (`params.update.sessionUpdate`), observed:
  - `agent_message_chunk { content { type: "text", text } }`
  - `agent_thought_chunk { content { type: "text", text }, messageId }` (many small chunks; treat as "thinking" activity, never as a claim about reasoning)
  - `tool_call { toolCallId, title, kind: "edit" | "execute" | ..., status: "pending", rawInput, locations[{ path }] }`
  - `tool_call_update { toolCallId, status: "completed" | ..., content[]: { type: "diff", path, oldText, newText } | { type: "content", content { type: "text", text } }, rawOutput }`
  - `usage_update { used, size }` (context window tokens used / available: a real context meter)
  - `session_info_update { title, updatedAt }`
  - `config_option_update`, `available_commands_update`
- Some informational messages arrive as `agent_message_chunk` text beginning with `Info:` (for example `Info: Operation cancelled by user`). Filter or label these.

## Permissions

- Agent sends a JSON-RPC **request** `session/request_permission { sessionId, toolCall { toolCallId, title, kind, status, rawInput, locations }, options[{ optionId, kind, name }] }`.
  For file edits `rawInput.diff` holds a unified diff and `rawInput.fileName` the path. For shell, `rawInput.command` and `rawInput.commands[]`.
- Options seen: `allow_once`, `allow_always`, `reject_once`. Reply with the same JSON-RPC id and `result: { outcome: { outcome: "selected", optionId } }`, or `{ outcome: { outcome: "cancelled" } }`.
- The turn blocks until answered. **Never auto-answer.** Surface it in the inbox. Not every command asked for permission in the spike (some shell commands ran without a request), so do not assume one request per tool.
- Any request method the client does not implement (anything other than permission) must be answered with a JSON-RPC error `-32601`.

## Interrupting

- `session/cancel { sessionId }` (a notification, no id) ends the turn within about a second. The pending `session/prompt` resolves with `stopReason: "cancelled"`. A running shell command is killed ("Operation cancelled by user"). **Hold = cancel**, and it is not a true pause: resuming means sending a new prompt such as "continue".
- Sending a second `session/prompt` while a turn is running **pre-empts the running turn**: the first prompt resolves `cancelled` and the second proceeds. So **Redirect = send the new instruction as a prompt immediately** (the worker will finish the current tool call or abandon it per cancel semantics). **Nudge = queue the note and send it as the next prompt when the turn ends** (mid-turn injection without pre-emption is not available).
- Receipts must say exactly what happened: "queued, will send when the current step ends" versus "sent, current step cancelled".

## Live verification of the bridge and UI (real Copilot, `claude-haiku-4.5`, scratch git repo)

- `test/bridge/live-steer.test.mjs` (gated by `ARCADE_LIVE=1`): two builders; hold gave a receipt in under 1 s; redirect made the new file; a nudge landed after the turn (`alpha\nnudged`); permissions answered with `allow_once`; both reviews merged cleanly into `main`.
- Through the browser UI: delegate, the real Lead proposed 4 orders for a 2-file goal (the human removed 2 before approving), 2 builders asked permission, allow once, review with real diff (+1/-0) and a passing check, Approve & merge on both. Result on disk: two `--no-ff` merge commits on `main`, correct file contents, no remote touched, working tree clean, worktrees removed.
- Footprint widget (estimate, sum of Copilot and Arcade process RSS; shared pages can overcount): about 299 MB idle, about 606 MB with 2 builders working, about 320 MB after they finished. One run, one machine; not a comparison with VS Code.
- Not yet verified on real Copilot: take over / hand back, send back, `session/set_mode`, slash commands, Windows, Linux.

## Safety notes for the bridge

- A permission request or tool use can occur inside any `cwd` passed to `session/new`. Use a separate git worktree per writing worker.
- Each live turn consumes the user's Copilot premium requests. Show the model in use. The spike used `claude-haiku-4.5` on purpose.
- Slash commands (`/context`, `/usage`) may be sent as prompts but are untested here; do not build on them until checked.
