// Goal composer: first-run onboarding + goal input, then the goal heading with a "New run" action.
import { h } from "./util.js";
import { icon } from "./icons.js";
import { btn, slot, draftField } from "./ui.js";
import { orderStats } from "./model.js";

export function createComposer(app) {
  const root = slot(app, "section", { class: "composer", "aria-labelledby": "composer-title" });

  function update(state) {
    const goal = state.goal;
    const stats = orderStats(state);
    const ro = app.ui.readOnly;
    const suggested = !goal && app.arcade.source === "demo" ? app.arcade.fixture?.suggestedGoal ?? "" : "";
    const phase = !goal ? "none" : state.batch.status;
    const sig = [goal, phase, ro, suggested, stats.shipped, stats.total, state.stats.shipped].join("|");
    root.set(sig, (el) => {
      if (!goal) return renderEmpty(el, state, suggested, ro);
      el.classList.remove("is-empty");
      const status =
        phase === "none" ? "The Foreman is reading the project and drafting work orders."
        : phase === "proposed" ? "Work orders are waiting for your approval."
        : stats.total && stats.shipped === stats.total ? "Everything shipped. Nice."
        : `${stats.shipped} of ${stats.total} work orders shipped.`;
      el.append(
        h("div", { class: "goal-row" },
          h("div", { class: "goal-main" }, h("p", { class: "eyebrow", id: "composer-title" }, "Today's goal"), h("h1", { class: "goal-title" }, goal), h("p", { class: "goal-status", role: "status" }, status)),
          ro ? null : btn(app, { label: "New run", icon: "plus", fk: "cmp:new", title: "End this run and start over with a new goal", onClick: () => app.newRun() }),
        ),
      );
    });
  }

  function renderEmpty(el, state, suggested, ro) {
    el.classList.add("is-empty");
    const submit = async () => {
      const text = (app.ui.drafts.get("goal") ?? "").trim();
      if (!text) {
        app.toast("Type a goal first, for example \u201cmake the app support dark mode\u201d.", "info");
        input.focus();
        return;
      }
      const r = await app.act("delegate", { goal: text }, { ok: null });
      if (r?.ok) {
        app.ui.drafts.delete("goal");
        app.announce("Goal sent to the Foreman.");
      }
    };
    const input = draftField(app, { key: "goal", tag: "input", placeholder: "What should the team get done?", ariaLabel: "Goal for the team", maxlength: 600, onEnter: submit, fk: "cmp:goal" });
    el.append(
      h("p", { class: "eyebrow", id: "composer-title" }, "Start here"),
      h("h1", { class: "goal-title" }, "Give the team a goal"),
      ro
        ? h("p", { class: "muted" }, "This recording has no goal.")
        : h("div", { class: "goal-form" }, h("label", { class: "sr-only", for: "goal-input" }, "Goal for the team"), input, btn(app, { label: "Delegate", icon: "send", kind: "primary", fk: "cmp:delegate", onClick: submit })),
      suggested ? h("div", { class: "suggest-chip" }, h("span", { class: "muted small" }, "Try the demo goal:"), h("button", { type: "button", class: "chip chip-button tone-accent", "data-fk": "cmp:suggested", onClick: () => { app.ui.drafts.set("goal", suggested); app.ui.epoch++; app.ui.pendingFocus = "cmp:goal"; app.forceRender(); } }, icon("spark", { size: 14 }), suggested)) : null,
      h("ol", { class: "steps-intro", "aria-label": "How it works" },
        h("li", {}, h("span", { class: "step-n", "aria-hidden": "true" }, "1"), h("span", {}, h("strong", {}, "You set the goal."), " Plain words are fine.")),
        h("li", {}, h("span", { class: "step-n", "aria-hidden": "true" }, "2"), h("span", {}, h("strong", {}, "The Foreman splits it into work orders."), " You read them, tweak them, and approve.")),
        h("li", {}, h("span", { class: "step-n", "aria-hidden": "true" }, "3"), h("span", {}, h("strong", {}, "Agents work. You steer."), " Hold, nudge, redirect or take over at any time.")),
      ),
    );
    input.id = "goal-input";
  }

  return { el: root.el, update };
}
