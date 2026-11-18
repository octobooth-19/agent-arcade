// Toasts and modal dialogs (native <dialog>, so focus trapping and Esc come from the browser).
import { h } from "./util.js";
import { icon } from "./icons.js";

const TOAST_MS = { error: 10000, info: 5000, ok: 4000 };

export function createToaster(container) {
  return function toast(message, kind = "info") {
    const text = String(message ?? "").slice(0, 400);
    if (!text) return;
    for (const old of [...container.children]) if (old.dataset.msg === text) old.remove();
    while (container.children.length >= 4) container.firstElementChild.remove();
    const item = h("div", { class: "toast toast-" + kind, role: kind === "error" ? "alert" : "status", "data-msg": text }, icon(kind === "error" ? "alert" : kind === "ok" ? "check" : "help", { size: 18 }), h("span", { class: "toast-msg" }, text));
    const close = h("button", { type: "button", class: "toast-x", "aria-label": "Dismiss message", title: "Dismiss" }, icon("x", { size: 14 }));
    close.addEventListener("click", () => item.remove());
    item.append(close);
    container.append(item);
    setTimeout(() => item.remove(), TOAST_MS[kind] ?? 5000);
  };
}

let dialogSeq = 0;

/** Opens a modal. `build(close)` returns the body nodes. Resolves nothing; use onClose for cleanup. */
export function openDialog({ title, build, cls, onClose, wide = false }) {
  const titleId = "dlg-title-" + ++dialogSeq;
  const dlg = h("dialog", { class: ["dlg", wide && "dlg-wide", cls], "aria-labelledby": titleId });
  const close = (value = "") => dlg.close(value);
  const inner = h("div", { class: "dlg-inner" }, h("div", { class: "dlg-head" }, h("h2", { id: titleId, class: "dlg-title" }, title), h("button", { type: "button", class: "btn btn-ghost btn-icon", "aria-label": "Close", title: "Close (Esc)", onClick: () => close() }, icon("x"))), h("div", { class: "dlg-body" }, build(close)));
  dlg.append(inner);
  dlg.addEventListener("click", (e) => {
    if (e.target === dlg) close();
  });
  dlg.addEventListener("close", () => {
    dlg.remove();
    onClose?.(dlg.returnValue);
  });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

/** Promise<boolean>. Cancel is focused first when the action is destructive or irreversible. */
export function confirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false, details }) {
  return new Promise((resolve) => {
    let answer = false;
    openDialog({
      title,
      cls: "dlg-confirm",
      build: (close) => {
        const cancel = h("button", { type: "button", class: "btn btn-default", autofocus: true, onClick: () => close("cancel") }, cancelLabel);
        const ok = h("button", { type: "button", class: ["btn", danger ? "btn-danger" : "btn-primary"], onClick: () => { answer = true; close("ok"); } }, confirmLabel);
        return [h("p", { class: "dlg-text" }, message), details ? h("p", { class: "muted small" }, details) : null, h("div", { class: "dlg-actions" }, cancel, ok)];
      },
      onClose: () => resolve(answer),
    });
  });
}
