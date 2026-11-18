// Review & merge: finished work waiting for the human's decision. Nothing merges without a click here.
import { h, pluralize } from "./util.js";
import { icon } from "./icons.js";
import { btn, slot, panelHead, chip, emptyState, disclosure, diffBlock, draftField } from "./ui.js";
import { approveReview } from "./actions.js";

const STATUS = {
  open: { label: "Waiting for you", tone: "warn", icon: "eye" },
  held: { label: "On hold", tone: "accent", icon: "pause" },
  approved: { label: "Approved", tone: "good", icon: "check" },
  sent_back: { label: "Sent back", tone: "warn", icon: "undo" },
};

const normFile = (f) => (typeof f === "string" ? { path: f } : { path: f?.path ?? "(unknown file)", added: f?.added, removed: f?.removed });
const normCheck = (c) => (typeof c === "string" ? { name: c, status: null, output: "" } : { name: c?.name ?? "check", status: c?.status ?? null, output: c?.output ?? "" });

export function createReview(app) {
  const body = slot(app, "div", { class: "review-body" });
  const root = h("section", { class: "panel review", id: "review", "aria-labelledby": "review-title", "data-sec": "orders" }, panelHead("merge", "Review & merge", "review-title"), body.el);

  function update(state) {
    const all = Object.values(state.reviews);
    const open = all.filter((r) => r.status === "open" || r.status === "held");
    const done = all.filter((r) => r.status !== "open" && r.status !== "held");
    const ro = app.ui.readOnly;
    const sig = JSON.stringify([all, ro, app.arcade.source, all.map((r) => [state.workers[r.workerId]?.name, state.orders[r.orderId]?.title])]);
    body.set(sig, (el) => {
      if (!all.length) {
        el.append(emptyState("Nothing to review yet.", "Finished work shows up here. Nothing is merged until you approve it.", "merge"));
        return;
      }
      for (const r of open) el.append(reviewCard(app, state, r, ro));
      if (done.length) {
        el.append(h("h3", { class: "sec-title" }, icon("check", { size: 15 }), `Decided (${done.length})`));
        for (const r of [...done].reverse()) el.append(reviewCard(app, state, r, ro));
      }
    });
  }

  return { el: root, update };
}

function reviewCard(app, state, r, ro) {
  const w = state.workers[r.workerId];
  const order = r.orderId ? state.orders[r.orderId] : null;
  const m = STATUS[r.status] ?? { label: r.status, tone: "soft", icon: "dot" };
  const files = (r.files ?? []).map(normFile);
  const checks = (r.checks ?? []).map(normCheck);
  const decided = r.status === "approved" || r.status === "sent_back";
  const textKey = "rv:" + r.id;
  const key = "rv-diff:" + r.id;

  const sendBack = async () => {
    const t = (app.ui.drafts.get(textKey) ?? "").trim();
    if (!t) return app.toast("Say what should change so the agent knows what to fix.", "info");
    const res = await app.act("sendBack", { reviewId: r.id, text: t }, { ok: "Sent back with your note." });
    if (res?.ok) app.ui.drafts.delete(textKey);
  };

  const merge = r.mergeResult
    ? h("div", { class: ["merge-result", r.mergeResult.ok ? "merge-ok" : "merge-bad"], role: r.mergeResult.ok ? "status" : "alert" }, icon(r.mergeResult.ok ? "check" : "alert", { size: 20 }), h("div", {}, h("strong", {}, r.mergeResult.ok ? "Merge result: OK" : "Not merged"), h("p", {}, r.mergeResult.message ?? (r.mergeResult.ok ? "Merged." : "The merge was refused."))))
    : null;

  return h("article", { class: ["review-card", "rs-" + r.status], "aria-label": `Review: ${r.summary}` },
    h("div", { class: "review-head" },
      w ? app.avatar(w.role, w.status, 36) : null,
      h("div", { class: "review-who" }, h("h3", { class: "review-title" }, r.summary || "Work ready for review"), h("p", { class: "muted small" }, [w?.name, order ? `Order: ${order.title}` : null].filter(Boolean).join(" \u00b7 "))),
      chip(m.label, { tone: m.tone, icon: m.icon }),
    ),
    merge,
    h("div", { class: "review-sec" },
      h("h4", { class: "sub-title" }, `Files (${files.length})`),
      files.length
        ? h("ul", { class: "files-plain" }, files.map((f) => h("li", {}, h("code", { class: "file-path" }, f.path), f.added != null ? h("span", { class: "added" }, "+" + f.added) : null, f.removed != null ? h("span", { class: "removed" }, "\u2212" + f.removed) : null)))
        : h("p", { class: "muted small" }, "No files listed."),
    ),
    h("div", { class: "review-sec" },
      h("h4", { class: "sub-title" }, "Checks"),
      checks.length
        ? h("ul", { class: "checks" }, checks.map((c) => h("li", { class: "check-li " + (c.status === "pass" ? "pass" : c.status ? "fail" : "") }, c.status ? chip(c.status === "pass" ? "Passed" : "Failed", { tone: c.status === "pass" ? "good" : "bad", icon: c.status === "pass" ? "check" : "xcircle" }) : chip("No result", { tone: "soft" }), h("span", { class: "check-name" }, c.name), c.output ? disclosure(app, `rvchk:${r.id}:${c.name}`, "Output", () => h("pre", { class: "out", tabindex: "0", "aria-label": `Output of ${c.name}` }, c.output)) : null)))
        : h("p", { class: "muted small" }, "No checks configured. Nothing was verified automatically, so read the diff before you approve."),
    ),
    r.diff ? disclosure(app, key, `Diff (${pluralize(files.length, "file")})`, () => diffBlock(r.diff, { maxLines: 800, label: "Review diff" })) : null,
    !decided && !ro
      ? h("div", { class: "review-actions" },
          btn(app, { label: "Approve & merge", icon: "merge", kind: "primary", fk: `rv:${r.id}:approve`, title: app.arcade.source === "live" ? "Merges this branch into the project's current branch. Nothing is pushed." : "Demo mode: nothing is written to disk.", onClick: () => approveReview(app, r.id) }),
          r.status === "held" ? null : btn(app, { label: "Hold", icon: "pause", fk: `rv:${r.id}:hold`, title: "Keep this review open without deciding.", onClick: () => app.act("holdReview", { reviewId: r.id }, { ok: "Review held. It stays here until you decide." }) }),
          h("div", { class: "sendback" }, draftField(app, { key: textKey, placeholder: "What should change?", ariaLabel: "What should change before this can merge", maxlength: 600, fk: `rv:${r.id}:text`, onEnter: sendBack }), btn(app, { label: "Send back", icon: "undo", fk: `rv:${r.id}:sendback`, title: "Returns the work to the agent with your note.", onClick: sendBack })),
        )
      : null,
  );
}
