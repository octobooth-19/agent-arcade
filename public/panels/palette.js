// Command palette (Ctrl/Cmd+K): fuzzy search over everything the app can do right now.
import { h, fuzzyFilter } from "./util.js";
import { icon } from "./icons.js";
import { openDialog } from "./dialogs.js";
import { paletteActions } from "./actions.js";

function highlight(text, indices) {
  if (!indices?.length) return text;
  const set = new Set(indices);
  const out = [];
  let buf = "";
  let on = false;
  const flush = () => {
    if (!buf) return;
    out.push(on ? h("mark", {}, buf) : buf);
    buf = "";
  };
  [...text].forEach((ch, i) => {
    const hit = set.has(i);
    if (hit !== on) {
      flush();
      on = hit;
    }
    buf += ch;
  });
  flush();
  return out;
}

export function openPalette(app) {
  const all = paletteActions(app);
  let query = "";
  let active = 0;
  let results = [];

  const input = h("input", { type: "text", class: "field palette-input", role: "combobox", "aria-expanded": "true", "aria-controls": "palette-list", "aria-autocomplete": "list", "aria-label": "Type an action", placeholder: "Type an action\u2026", autocomplete: "off", spellcheck: "false" });
  const list = h("ul", { class: "palette-list", id: "palette-list", role: "listbox", "aria-label": "Actions" });
  const status = h("p", { class: "sr-only", role: "status" });
  let closeFn = () => {};

  function render() {
    // Match on the label only for the highlight, but let hints help find things (e.g. "merge" finds the review action).
    results = fuzzyFilter(all, query, (a) => a.label + " " + (a.hint ?? ""));
    if (active >= results.length) active = Math.max(0, results.length - 1);
    list.replaceChildren(
      ...(results.length
        ? results.map(({ item, indices }, i) =>
            h("li", { id: "pal-" + i, role: "option", class: ["palette-item", i === active && "is-active", item.disabled && "is-disabled"], "aria-selected": String(i === active), "aria-disabled": item.disabled ? "true" : null, onMousedown: (e) => e.preventDefault(), onClick: () => choose(i) },
              h("span", { class: "pal-label" }, highlight(item.label, indices.filter((x) => x < item.label.length))),
              item.disabled ? h("span", { class: "pal-hint" }, item.disabled) : item.hint ? h("span", { class: "pal-hint" }, item.hint) : null,
            ),
          )
        : [h("li", { class: "palette-empty", role: "presentation" }, "Nothing matches. Try a shorter word.")]),
    );
    input.setAttribute("aria-activedescendant", results.length ? "pal-" + active : "");
    status.textContent = results.length ? `${results.length} actions` : "No matches";
    list.querySelector(".is-active")?.scrollIntoView({ block: "nearest" });
  }

  async function choose(i) {
    const entry = results[i];
    if (!entry) return;
    if (entry.item.disabled) {
      app.toast(entry.item.disabled, "info");
      return;
    }
    closeFn();
    // Let the dialog finish closing so focus returns first and the action can move it elsewhere.
    await new Promise((r) => setTimeout(r, 0));
    await entry.item.run();
  }

  input.addEventListener("input", () => {
    query = input.value;
    active = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      active = results.length ? (active + 1) % results.length : 0;
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = results.length ? (active - 1 + results.length) % results.length : 0;
      render();
    } else if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      choose(active);
    }
  });

  const { close } = openDialog({
    title: "Search & actions",
    cls: "dlg-palette",
    build: () => [h("div", { class: "palette-search" }, icon("search", { size: 18 }), input), list, status, h("p", { class: "hint" }, "\u2191 \u2193 to move \u00b7 Enter to run \u00b7 Esc to close")],
  });
  closeFn = close;
  render();
  input.focus();
}
