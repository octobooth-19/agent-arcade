// Shared action helpers used by the inbox, review panel, keyboard shortcuts and the command palette.
import { openInbox } from "/shared/state.js";
import { primaryAction, denyAction, interruptRules, inboxKindLabel, nameOf, workerList, HOLD_COPY } from "./model.js";

export const LIVE_MERGE_CONFIRM = "Merge this branch into the project's current branch? Nothing is pushed.";

/** The inbox item the keyboard cursor is on, falling back to the first open item. */
export function currentItem(app, state) {
  const items = openInbox(state);
  return items.find((i) => i.id === app.ui.cursorId) ?? items[0] ?? null;
}

export function moveCursor(app, state, dir) {
  const items = openInbox(state);
  if (!items.length) return null;
  const at = items.findIndex((i) => i.id === app.ui.cursorId);
  const next = items[at < 0 ? (dir > 0 ? 0 : items.length - 1) : (at + dir + items.length) % items.length];
  app.ui.cursorId = next.id;
  return next;
}

export async function approveReview(app, reviewId) {
  const state = app.state;
  const review = state.reviews[reviewId];
  if (!review) return { ok: false, error: "That review is gone." };
  if (app.arcade.source === "live") {
    const ok = await app.confirm({ title: "Approve & merge?", message: LIVE_MERGE_CONFIRM, confirmLabel: "Approve & merge", details: "Checks and conflicts are verified by the server first. If the merge can't be done cleanly it will say so here." });
    if (!ok) return { ok: false, cancelled: true };
  }
  const r = await app.act("approveReview", { reviewId }, { ok: null });
  return r;
}

/** Runs the action object returned by primaryAction()/denyAction(). */
export async function runAction(app, action) {
  if (!action) return { ok: false };
  switch (action.type) {
    case "approval": {
      const r = await app.act("resolveApproval", { approvalId: action.approval.id, optionId: action.option.id ?? action.option.optionId }, { ok: null });
      if (r?.ok) {
        const denied = action.option.kind?.startsWith("reject");
        const what = action.approval.title ? `: ${action.approval.title}` : "";
        app.announce(denied ? "Denied." : "Allowed.");
        app.toast(`${denied ? "Denied" : "Allowed"}${what}`, denied ? "info" : "ok");
      }
      return r;
    }
    case "jump":
      app.jumpTo(action.target);
      return { ok: true };
    case "review":
      return approveReview(app, action.reviewId);
    case "suggestion":
      return app.act("resolveSuggestion", { id: action.id, decision: "accept" }, { ok: "Suggestion accepted." });
    case "suggestion-reject":
      return app.act("resolveSuggestion", { id: action.id, decision: "reject" }, { ok: "Suggestion rejected." });
    default:
      return { ok: false };
  }
}

export const primaryFor = (app, item) => (item ? primaryAction(item, app.state) : null);
export const denyFor = (app, item) => (item ? denyAction(item, app.state) : null);

/** Everything the command palette can do right now. Labels name exactly what will happen. */
export function paletteActions(app) {
  const state = app.state;
  const ro = app.ui.readOnly;
  const items = [];
  const add = (id, label, hint, run, extra = {}) => items.push({ id, label, hint, run, ...extra });

  add("help", "Open help and shortcuts", "?", () => app.openHelp());
  add("focus-goal", "Focus the goal box", "Delegate", () => app.focusGoal(), { disabled: ro || !!state.goal ? (ro ? "Not while replaying" : "A run is already going. Start a new run first.") : null });
  add("goto-stage", "Go to Stage", "", () => app.goTab("stage"));
  add("goto-orders", "Go to Work orders", "", () => app.goTab("orders"));
  add("goto-inbox", "Go to Needs you", "", () => app.goTab("inbox"));
  add("goto-inspector", "Go to Inspector", "", () => app.goTab("inspector"));
  add("goto-review", "Go to Review & merge", "", () => app.jumpTo("review"));

  const live = workerList(state, { includeLead: false });
  add("hold-all", "Hold all agents", "Stops each at its next safe point", () => app.act("holdAll", {}, { ok: "Hold all requested. Each agent stops at its next safe point." }), { disabled: ro ? "Not while replaying" : state.holdAll ? "Already holding" : live.length ? null : "No agents yet" });
  add("resume-all", "Resume all agents", "Re-prompts held agents", () => app.act("resumeAll", {}, { ok: "Resume all sent. Held agents are re-prompted." }), { disabled: ro ? "Not while replaying" : state.holdAll ? null : "Nothing is held" });

  const item = currentItem(app, state);
  const prim = primaryFor(app, item);
  add("approve-next", prim ? `${prim.label}` : "Approve next inbox item", item ? `${inboxKindLabel(item.kind)}` : "", () => runAction(app, prim), { disabled: ro ? "Not while replaying" : prim ? null : item ? "This item needs a closer look. Open it in the inbox." : "Nothing needs you" });
  const den = denyFor(app, item);
  if (den) add("deny-next", den.label, inboxKindLabel(item.kind), () => runAction(app, den), { disabled: ro ? "Not while replaying" : null });

  for (const w of workerList(state)) {
    add("select-" + w.id, `Inspect ${w.name}`, app.roleLabel(w.role) + " \u00b7 " + app.statusLabel(w.status), () => app.select(w.id, { open: true }));
  }
  const sel = state.workers[app.ui.selectedId];
  if (sel) {
    const rules = interruptRules(sel);
    add("hold-selected", `Hold ${sel.name}`, HOLD_COPY, () => app.act("hold", { workerId: sel.id }, { ok: null }), { disabled: ro ? "Not while replaying" : rules.hold });
    add("resume-selected", `Resume ${sel.name}`, "Re-prompts the agent", () => app.act("resume", { workerId: sel.id }, { ok: null }), { disabled: ro ? "Not while replaying" : rules.resume });
  }

  add("toggle-sound", app.ui.soundOn ? "Turn sound off" : "Turn sound on", "", () => app.toggleSound(), { disabled: app.sound.available ? null : "Sounds come with the studio scene" });
  add("new-run", "New run", "Ends this run", () => app.newRun(), { disabled: ro ? "Not while replaying" : state.goal ? null : "There is no run yet" });
  if (app.ui.replay) add("back-to-live", "Back to live", "", () => app.backToLive());
  else add("replay", "Replay this run", "Watch it back with a scrubber", () => app.startReplayOfCurrent(), { disabled: state.timeline.length ? null : "Nothing recorded yet" });
  if (app.arcade.source === "live" || app.ui.baseSource === "live") add("past-runs", "Past runs\u2026", "Replay a saved run", () => app.openPastRuns());
  return items;
}

export { nameOf };
