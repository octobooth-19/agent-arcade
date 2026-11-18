// Prompt text and small helpers shared by the orchestrator. Model output is never trusted; user text is only
// ever embedded in prompts (plain text), never in shell commands.

export const VERSION = "1.0.0";

export const clip = (s, max) => {
  const str = String(s ?? "");
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
};

export function leadPrompt(goal) {
  return [
    "You are the Lead of a small team of coding agents. A human developer wants this done:",
    "",
    "<goal>",
    goal,
    "</goal>",
    "",
    "Look at the project in the current directory. You are strictly read-only: do not edit files and do not run commands that change anything.",
    "Split the goal into 2 to 5 small work orders for your team.",
    "",
    "Reply with JSON only (no prose, no markdown fences) in exactly this shape:",
    '{"orders":[{"title":"short title","ownerRole":"planner|builder|checker","allowedFiles":["paths or globs the worker may touch"],"acceptance":"how to tell it is done","prompt":"complete, self-contained instructions for the worker","dependsOn":[]}]}',
    "",
    "Rules:",
    "- ownerRole is one of planner, builder, checker. Builders write code. Planners only investigate. Checkers only verify.",
    "- dependsOn lists the 1-based positions of orders that must be finished and approved first, for example [1].",
    "- Prefer orders that touch different files so they can run in parallel.",
  ].join("\n");
}

const ROLE_RULES = {
  planner: "You are read-only: investigate and report. Do not modify any files.",
  checker: "You are verifying: run read-only checks and report what you found. Do not modify any files.",
  builder: "You may create and edit files to complete the task.",
};

export function workerPrompt(order, role) {
  const allowed = order.allowedFiles?.length
    ? `Files you may change: ${order.allowedFiles.join(", ")}. Stay inside this list.`
    : "No file list was given, so keep your change as small as possible.";
  return [
    `You are the ${role} on a small team of coding agents working for a human lead developer.`,
    "",
    `Task: ${order.title}`,
    order.prompt && order.prompt !== order.title ? order.prompt : "",
    order.acceptance ? `\nAcceptance: ${order.acceptance}` : "",
    "",
    allowed,
    "",
    "Rules:",
    "- Work only inside the current directory.",
    "- Do not run git commit or git push and do not change git configuration. Agent Arcade collects your changes for review.",
    `- ${ROLE_RULES[role] ?? ROLE_RULES.builder}`,
    "- When you are done, reply with a short plain-text summary of what you did.",
  ]
    .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
    .join("\n");
}

export const continuePrompt = () => "Please continue where you left off.";
export const blockedContinuePrompt = (detail) =>
  `Please continue. ${detail ? `The last attempt ended with: ${detail}. ` : ""}Fix what is wrong and then reply with a short summary.`;
export const redirectPrompt = (text) => `New instruction from the human lead. Stop what you were doing and do this instead:\n${text}`;
/** notes: [{ kind: "nudge" | "redirect", text }] */
export const notesBlock = (notes) =>
  [
    `Note${notes.length > 1 ? "s" : ""} from the human lead:`,
    ...notes.map((n) => (n.kind === "redirect" ? `- NEW INSTRUCTION (replaces what you were doing): ${n.text}` : `- ${n.text}`)),
  ].join("\n");
export const nudgePrompt = (notes) => `${notesBlock(notes)}\nKeep going with your task, taking this into account.`;
export const handBackPrompt = () =>
  "The human lead has finished working in this directory. Re-read the current files (check git status and the diff) and continue the task from this state.";
export const sendBackPrompt = (text) =>
  `The human lead reviewed your work and sent it back with this feedback:\n${text}\nPlease address it, then reply with a short summary.`;

export function suggestionOrder(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return { title: clip(t, 80), ownerRole: "builder", allowedFiles: [], acceptance: "", prompt: t, dependsOn: [] };
}

/** Tiny glob: "*" within a path segment, "**" across segments, bare directory names match everything below. */
export function matchesAllowed(file, patterns) {
  if (!patterns?.length) return true;
  const f = file.replace(/^\.\//, "");
  return patterns.some((raw) => {
    const p = raw.replace(/^\.\//, "").replace(/\/+$/, "");
    if (!p) return false;
    if (f === p || f.startsWith(p + "/")) return true;
    if (!/[*?]/.test(p)) return false;
    const re = new RegExp(
      "^" +
        p
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*\//g, "(?:.*/)?")
          .replace(/\*\*/g, ".*")
          .replace(/\*/g, "[^/]*")
          .replace(/\?/g, "[^/]") +
        "(?:/.*)?$",
    );
    return re.test(f);
  });
}

export function isAuthError(err) {
  if (!err) return false;
  if (err.code === -32000) return true;
  const text = `${err.message ?? ""}`;
  return /\bauth(entication|enticated|orized|orization)?\b|log\s?in|sign\s?in|unauthori[sz]ed|credential|\b40[13]\b/i.test(text);
}

export function mapKind(kind) {
  switch (kind) {
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "execute":
      return "execute";
    case "read":
    case "search":
      return "read";
    default:
      return "other";
  }
}
