// Shared widgets: buttons that explain why they are disabled, focus-preserving render slots, diff viewer, fields.
import { h, parseDiff, truncate, cleanKids } from "./util.js";
import { icon } from "./icons.js";
import { statusMeta } from "./model.js";

/**
 * A region of the page that is rebuilt only when its signature string changes. Re-rendering keeps keyboard focus
 * (via data-fk keys), and the text caret, so live updates never steal the user's place.
 */
export function slot(app, tag = "div", props = {}) {
  const el = h(tag, props);
  const nativeAppend = el.append.bind(el);
  // Render callbacks pass conditional children (cond ? node : null); the native append would print "null".
  el.append = (...kids) => nativeAppend(...cleanKids(kids));
  let last = null;
  return {
    el,
    set(sig, render) {
      const full = app.ui.epoch + "|" + sig;
      if (full === last) return false;
      last = full;
      renderKeepingFocus(app, el, () => {
        el.replaceChildren();
        render(el);
      });
      return true;
    },
    invalidate() {
      last = null;
    },
  };
}

export function renderKeepingFocus(app, root, fn) {
  const active = document.activeElement;
  const inside = active && root.contains(active) && active !== root;
  const fk = inside ? active.dataset?.fk ?? null : null;
  let sel = null;
  if (fk && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    try {
      sel = [active.selectionStart, active.selectionEnd];
    } catch {
      sel = null;
    }
  }
  fn();
  const pending = app.ui.pendingFocus;
  for (const want of [pending, fk]) {
    if (!want) continue;
    const target = [...root.querySelectorAll("[data-fk]")].find((n) => n.dataset.fk === want);
    if (!target) continue;
    target.focus({ preventScroll: want !== pending });
    if (want === fk && sel && target.setSelectionRange) {
      try {
        target.setSelectionRange(sel[0], sel[1]);
      } catch {
        /* not a text field */
      }
    }
    if (want === pending) app.ui.pendingFocus = null;
    break;
  }
}

/**
 * Button. When `reason` is set the button stays focusable (aria-disabled) and clicking it explains why,
 * instead of silently doing nothing. Async onClick handlers block double clicks.
 */
export function btn(app, o) {
  const { label, icon: ic, kind = "default", fk, title, reason, onClick, small, pressed, expanded, controls, hideLabel, type = "button", cls, describedby } = o;
  const content = [ic ? icon(ic, { size: small ? 14 : 16 }) : null, label ? h("span", { class: hideLabel ? "sr-only" : "btn-label" }, label) : null, reason ? h("span", { class: "sr-only" }, ` (unavailable: ${reason})`) : null];
  const el = h("button", {
    type,
    class: ["btn", "btn-" + kind, small && "btn-sm", hideLabel && "btn-icon", reason && "is-disabled", cls],
    title: reason || title || (hideLabel ? label : null),
    "aria-disabled": reason ? "true" : null,
    "aria-pressed": pressed === undefined || pressed === null ? null : String(!!pressed),
    "aria-expanded": expanded === undefined || expanded === null ? null : String(!!expanded),
    "aria-controls": controls,
    "aria-describedby": describedby,
    "data-fk": fk,
  }, content);
  el.addEventListener("click", async (e) => {
    if (reason) {
      e.preventDefault();
      app.toast(reason, "info");
      return;
    }
    if (!onClick || el.dataset.busy) return;
    el.dataset.busy = "1";
    el.classList.add("is-busy");
    try {
      await onClick(e);
    } finally {
      delete el.dataset.busy;
      el.classList.remove("is-busy");
    }
  });
  return el;
}

export function chip(text, { tone = "soft", icon: ic, title, cls } = {}) {
  return h("span", { class: ["chip", "tone-" + tone, cls], title }, ic ? icon(ic, { size: 14 }) : null, h("span", {}, text));
}

export function statusChip(app, status) {
  const m = statusMeta(status);
  return chip(app.statusLabel(status), { tone: m.tone, icon: m.icon });
}

export function emptyState(title, body, iconName) {
  return h("div", { class: "empty" }, iconName ? h("div", { class: "empty-icon" }, icon(iconName, { size: 28 })) : null, h("p", { class: "empty-title" }, title), body ? h("p", { class: "empty-body" }, body) : null);
}

export function panelHead(iconName, title, id, ...tools) {
  return h("div", { class: "panel-head" }, h("h2", { id, class: "panel-title" }, iconName ? icon(iconName, { size: 18 }) : null, h("span", {}, title)), tools.length ? h("div", { class: "panel-tools" }, tools) : null);
}

/** <details> whose body is built lazily, and whose open state survives re-renders. */
export function disclosure(app, key, summary, buildBody, { cls } = {}) {
  const d = h("details", { class: ["disclosure", cls] });
  const body = h("div", { class: "disclosure-body" });
  let built = false;
  const fill = () => {
    if (built) return;
    built = true;
    const content = buildBody();
    body.append(...(Array.isArray(content) ? content : [content]));
  };
  d.append(h("summary", {}, icon("chevron", { size: 14 }), summary), body);
  if (app.ui.open.has(key)) {
    d.open = true;
    fill();
  }
  d.addEventListener("toggle", () => {
    if (d.open) {
      app.ui.open.add(key);
      fill();
    } else {
      app.ui.open.delete(key);
    }
  });
  return d;
}

/** Unified diff as plain text, line-colored by class. Never HTML. */
export function diffBlock(text, { maxLines = 500, label = "Unified diff" } = {}) {
  if (!String(text ?? "").trim()) return h("p", { class: "muted" }, "No diff available.");
  const { lines, hidden } = parseDiff(text, maxLines);
  return h("div", {}, h("pre", { class: "diff", tabindex: "0", "aria-label": label }, lines.map((l) => h("span", { class: "dl dl-" + l.kind }, l.text || " "))), hidden ? h("p", { class: "muted small" }, `${hidden} more lines not shown.`) : null);
}

/** A text field whose content survives re-renders (kept in app.ui.drafts under `key`). */
export function draftField(app, { key, tag = "input", type = "text", placeholder, ariaLabel, rows, maxlength, onInput, onEnter, cls, id, fk }) {
  const el = h(tag, {
    class: ["field", cls],
    id,
    type: tag === "input" ? type : null,
    placeholder,
    rows,
    maxlength,
    autocomplete: "off",
    "aria-label": ariaLabel,
    "data-fk": fk ?? key,
    value: app.ui.drafts.get(key) ?? "",
  });
  el.addEventListener("input", () => {
    app.ui.drafts.set(key, el.value);
    onInput?.(el.value);
  });
  if (onEnter) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        onEnter(el.value);
      }
    });
  }
  return el;
}

export function labeled(text, control, hint) {
  return h("label", { class: "lbl" }, h("span", { class: "lbl-text" }, text), control, hint ? h("span", { class: "hint" }, hint) : null);
}

/** Horizontal meter with text. `tone` is a class from app.css. */
export function meter({ pct, label, valueText, tone = "good" }) {
  return h("div", { class: "meter", role: "progressbar", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": pct === null ? null : String(pct), "aria-valuetext": valueText }, h("div", { class: "meter-fill tone-" + tone, style: { width: (pct ?? 0) + "%" } }));
}

export function kv(label, value, cls) {
  return h("div", { class: ["kv", cls] }, h("dt", {}, label), h("dd", {}, value));
}

export const short = (s, n = 80) => truncate(s, n);
