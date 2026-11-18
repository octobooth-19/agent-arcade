// Translates ACP `session/update` notifications for one session into Agent Arcade reducer events.
// Never invents progress: every event is derived from something the agent actually sent. Unknown update types
// become a single "[unsupported update: type]" output line (once per type per worker).
import path from "node:path";
import { unifiedDiff } from "./diff.mjs";
import { clip } from "./prompts.mjs";

const IGNORED = new Set(["session_info_update", "config_option_update", "available_commands_update", "current_mode_update", "user_message_chunk"]);
const PLAN_STATUS = { pending: "todo", in_progress: "doing", completed: "done" };
const MAX_LINE = 1000;
const MAX_FILE_DIFF = 60 * 1024;
const MAX_TOOLS = 500;

export class UpdateTranslator {
  /**
   * @param {object} o
   * @param {string} o.workerId
   * @param {(ev: object) => void} o.emit  receives events without `t`
   * @param {string} o.cwd  used to show file paths relative to the worker's directory
   * @param {() => string} o.getStatus
   * @param {(relPath: string) => void} [o.onFile]  called the first time a file is changed
   */
  constructor({ workerId, emit, cwd, getStatus, onFile, flushMs = 600 }) {
    this.id = workerId;
    this._emit = emit;
    this.cwd = cwd;
    this.getStatus = getStatus;
    this.onFile = onFile;
    this.flushMs = flushMs;
    this.segments = [];
    this.cur = "";
    this.buf = "";
    this.timer = null;
    this.thinking = false;
    this.tools = new Map();
    this.fileBase = new Map();
    this.filesSeen = new Set();
    this.unsupported = new Set();
  }

  setCwd(cwd) {
    this.cwd = cwd;
  }

  beginTurn() {
    this.flush();
    this.segments = [];
    this.cur = "";
    this.thinking = false;
  }

  /** Last stretch of agent text (after the final tool call). */
  get summary() {
    return (this.cur.trim() || [...this.segments].reverse().find((s) => s.trim()) || "").trim();
  }

  get fullText() {
    return [...this.segments, this.cur].join("\n").trim();
  }

  out(lines) {
    const ls = (Array.isArray(lines) ? lines : [lines]).map((l) => clip(l, MAX_LINE)).filter((l) => l !== "");
    if (ls.length) this._emit({ type: "worker.output", id: this.id, lines: ls });
  }

  handle(u) {
    if (!u || typeof u.sessionUpdate !== "string") return;
    const kind = u.sessionUpdate;
    if (kind !== "agent_thought_chunk") this.thinking = false;
    switch (kind) {
      case "agent_message_chunk":
        return this._message(u.content);
      case "agent_thought_chunk":
        return this._thought();
      case "tool_call":
        this.flush();
        this._endSegment();
        return this._toolCall(u);
      case "tool_call_update":
        return this._toolUpdate(u);
      case "plan":
        return this._plan(u);
      case "usage_update":
        if (Number.isFinite(u.used) && Number.isFinite(u.size)) this._emit({ type: "worker.usage", id: this.id, used: u.used, size: u.size });
        return;
      default:
        if (IGNORED.has(kind)) return;
        this._unsupported(kind);
    }
  }

  _unsupported(kind) {
    const key = clip(kind, 60);
    if (this.unsupported.has(key)) return;
    this.unsupported.add(key);
    this.out(`[unsupported update: ${key}]`);
  }

  _endSegment() {
    if (this.cur.trim()) this.segments.push(this.cur);
    this.cur = "";
  }

  _message(content) {
    if (!content || content.type !== "text" || typeof content.text !== "string") return this._unsupported(`agent_message_chunk:${content?.type ?? "empty"}`);
    const text = content.text;
    if (!this.buf && !this.cur.trim() && /^\s*Info:/.test(text)) {
      this.out(`[copilot info] ${text.replace(/^\s*Info:\s*/, "").trim()}`);
      return;
    }
    this.cur += text;
    this.buf += text;
    const parts = this.buf.split("\n");
    this.buf = parts.pop();
    const lines = parts.map((l) => l.trimEnd()).filter(Boolean);
    if (lines.length) this.out(lines);
    clearTimeout(this.timer);
    if (this.buf) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  /** Emit buffered partial text now. */
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    const rest = this.buf.trim();
    this.buf = "";
    if (rest) this.out(rest);
  }

  _thought() {
    if (this.thinking) return;
    this.thinking = true;
    if (this.getStatus() === "working") this._emit({ type: "worker.status", id: this.id, status: "working", now: "Thinking…" });
  }

  _toolCall(u) {
    const id = u.toolCallId;
    const info = { title: String(u.title ?? ""), kind: u.kind ?? "other", locations: u.locations ?? [] };
    if (id != null) {
      this.tools.set(id, info);
      if (this.tools.size > MAX_TOOLS) this.tools.delete(this.tools.keys().next().value);
    }
    this._emit({ type: "worker.step", id: this.id, text: clip(info.title || info.kind || "Working", 140) });
  }

  _toolUpdate(u) {
    const info = this.tools.get(u.toolCallId) ?? { title: String(u.title ?? ""), kind: u.kind ?? "other", locations: [] };
    if (u.title && !info.title) info.title = String(u.title);
    for (const c of Array.isArray(u.content) ? u.content : []) {
      if (c?.type === "diff") this._diff(c);
      else if (c?.type === "content" && c.content?.type === "text" && info.kind === "execute") this._execText(c.content.text);
    }
    if (u.status === "failed") this.out(`✗ ${clip(info.title || "A tool call", 120)} failed`);
  }

  _execText(text) {
    if (typeof text !== "string" || !text.trim()) return;
    const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
    const shown = lines.slice(0, 12).map((l) => clip(l, 300));
    if (lines.length > shown.length) shown.push(`… (${lines.length - shown.length} more lines)`);
    this.out(shown);
  }

  _rel(p) {
    if (typeof p !== "string") return "";
    if (!path.isAbsolute(p)) return p;
    const rel = path.relative(this.cwd ?? "", p);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
  }

  _diff(c) {
    const rel = this._rel(c.path);
    if (!rel) return;
    // Cumulative diff: always against the first oldText seen for this path in this session.
    if (!this.fileBase.has(rel)) this.fileBase.set(rel, typeof c.oldText === "string" ? c.oldText : "");
    const newText = typeof c.newText === "string" ? c.newText : "";
    const { diff, added, removed } = unifiedDiff(rel, this.fileBase.get(rel), newText);
    const seen = this.filesSeen.has(rel);
    if (!diff && !seen) return;
    this.filesSeen.add(rel);
    if (!seen) this.onFile?.(rel);
    this._emit({ type: "worker.file", id: this.id, path: rel, added, removed, diff: clip(diff, MAX_FILE_DIFF) });
  }

  _plan(u) {
    const entries = Array.isArray(u.entries) ? u.entries : [];
    this._emit({
      type: "worker.plan",
      id: this.id,
      plan: entries.slice(0, 30).map((e) => ({ text: clip(e?.content ?? e?.title ?? "", 200), status: PLAN_STATUS[e?.status] ?? "todo" })),
    });
  }
}
