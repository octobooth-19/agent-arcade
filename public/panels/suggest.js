// Suggestion box: a place for people watching over your shoulder to drop ideas. They land in Needs you; you decide.
import { h } from "./util.js";
import { btn, slot, panelHead, draftField } from "./ui.js";

export function createSuggest(app) {
  const body = slot(app, "div", { class: "suggest-body" });
  const root = h("section", { class: "panel suggest", id: "suggest", "aria-labelledby": "suggest-title", "data-sec": "inbox" }, panelHead("spark", "Suggestion box", "suggest-title"), body.el);

  function update() {
    const ro = app.ui.readOnly;
    body.set("v1|" + ro, (el) => {
      el.append(h("p", { class: "muted small" }, "Showing Arcade to someone? They can drop an idea here. It lands in Needs you and nothing happens unless you accept it."));
      if (ro) return el.append(h("p", { class: "muted small" }, "Not while replaying."));
      const send = async () => {
        const text = (app.ui.drafts.get("suggest") ?? "").trim();
        if (!text) return app.toast("Type an idea first.", "info");
        const r = await app.act("suggest", { text, from: "audience" }, { ok: "Thanks! The idea is in Needs you." });
        if (r?.ok) {
          app.ui.drafts.delete("suggest");
          const f = el.querySelector("input");
          if (f) f.value = "";
        }
      };
      el.append(h("div", { class: "goal-form" }, h("label", { class: "sr-only", for: "suggest-input" }, "Suggestion"), draftField(app, { key: "suggest", placeholder: "e.g. add a keyboard shortcut", ariaLabel: "Suggestion for the director", maxlength: 300, onEnter: send, fk: "sug:text", id: "suggest-input" }), btn(app, { label: "Suggest", icon: "send", fk: "sug:send", onClick: send })));
    });
  }

  return { el: root, update };
}
