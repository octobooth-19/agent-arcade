// Needs-you inbox: everything waiting on the human, priority-ordered, each with its real inline actions.
import { h, formatElapsed, truncate } from "./util.js";
import { icon } from "./icons.js";
import { btn, slot, panelHead, chip, emptyState, disclosure, diffBlock, draftField } from "./ui.js";
import { inboxKindLabel, interruptRules } from "./model.js";
import { openInbox } from "/shared/state.js";
import { runAction, primaryFor } from "./actions.js";

const APPROVAL_KIND = { edit: "wants to edit files", execute: "wants to run a command", read: "wants to read something", other: "is asking permission" };

export function createInbox(app) {
  const list = slot(app, "div", { class: "inbox-body" });
  const count = h("span", { class: "count-pill" }, "0");
  const root = h("section", { class: "panel inbox", id: "inbox", "aria-labelledby": "inbox-title", "data-sec": "inbox" }, panelHead("inbox", "Needs you", "inbox-title", count), list.el);

  function itemSig(state, item) {
    const w = item.workerId ? state.workers[item.workerId] : null;
    const base = [item.id, item.kind, item.summary, item.detail, item.id === app.ui.cursorId];
    if (item.kind === "approval") {
      const a = state.approvals[item.refId];
      base.push(a?.status, a?.title, a?.detail?.length, a?.diff?.length, JSON.stringify(a?.options));
    } else if (item.kind === "failed_check") {
      base.push(w?.status, JSON.stringify(w?.checks ?? []), (w?.notes ?? []).length, w?.takeover);
    } else if (item.kind === "suggestion") {
      base.push(state.suggestions[item.refId]?.text, state.suggestions[item.refId]?.from);
    } else if (item.kind === "review") {
      base.push(state.reviews[item.refId]?.status);
    }
    base.push(w?.name, w?.role);
    return base.join("~");
  }

  function update(state) {
    const items = openInbox(state);
    count.textContent = String(items.length);
    count.classList.toggle("is-zero", items.length === 0);
    const ro = app.ui.readOnly;
    const sig = items.map((i) => itemSig(state, i)).join("|") + "#" + ro + "#" + app.arcade.source;
    list.set(sig, (el) => {
      if (!items.length) {
        el.append(emptyState("Nothing needs you. Nice.", "When an agent asks permission, a check fails, or work is ready to review, it lands here.", "check"));
        return;
      }
      const ul = h("ul", { class: "inbox-list", "aria-label": "Items waiting for you" });
      for (const item of items) ul.append(h("li", {}, renderItem(app, state, item, ro)));
      el.append(ul);
      el.append(h("p", { class: "hint kbd-hint" }, "Keyboard: ", h("kbd", {}, "j"), " / ", h("kbd", {}, "k"), " move \u00b7 ", h("kbd", {}, "a"), " allow once \u00b7 ", h("kbd", {}, "d"), " deny"));
    });
    for (const t of root.querySelectorAll("[data-since]")) t.textContent = formatElapsed(state.now - Number(t.dataset.since));
  }

  return { el: root, update };
}

function renderItem(app, state, item, ro) {
  const w = item.workerId ? state.workers[item.workerId] : null;
  const cursor = app.ui.cursorId === item.id;
  const head = h("div", { class: "inbox-head" },
    w ? app.avatar(w.role, w.status, 32) : h("span", { class: "inbox-icon" }, icon(item.kind === "suggestion" ? "spark" : "bell", { size: 18 })),
    h("div", { class: "inbox-who" },
      h("p", { class: "inbox-kind" }, chip(inboxKindLabel(item.kind), { tone: item.kind === "approval" || item.kind === "failed_check" ? "warn" : "soft" }), w ? h("strong", {}, w.name) : null),
      h("p", { class: "inbox-wait muted small" }, "waiting ", h("span", { "data-since": item.createdAt }, formatElapsed(state.now - item.createdAt))),
    ),
  );
  let body;
  switch (item.kind) {
    case "approval": body = approvalBody(app, state, item, ro); break;
    case "failed_check": body = failedCheckBody(app, state, item, w, ro); break;
    case "batch": body = simpleBody(item, [btn(app, { label: "Review work orders", icon: "orders", kind: "primary", small: true, fk: "in:" + item.id + ":go", onClick: () => app.jumpTo("orders") })], "Nothing starts until you approve the orders."); break;
    case "review": body = simpleBody(item, [btn(app, { label: "Open review", icon: "eye", kind: "primary", small: true, fk: "in:" + item.id + ":go", onClick: () => app.jumpTo("review") })]); break;
    case "suggestion": body = suggestionBody(app, state, item, ro); break;
    case "question": body = simpleBody(item, [btn(app, { label: "Add work orders by hand", icon: "plus", kind: "primary", small: true, fk: "in:" + item.id + ":go", onClick: () => app.jumpTo("orders") })]); break;
    default: body = simpleBody(item, []);
  }
  return h("article", { class: ["inbox-item", "ik-" + item.kind, cursor && "is-cursor"], tabindex: "-1", "data-fk": "inbox:item:" + item.id, "aria-label": `${inboxKindLabel(item.kind)}${w ? " from " + w.name : ""}: ${truncate(item.summary, 80)}`, "aria-current": cursor ? "true" : null }, head, body);
}

function simpleBody(item, actions, note) {
  return h("div", { class: "inbox-body-in" }, h("p", { class: "inbox-summary" }, item.summary), item.detail ? h("p", { class: "inbox-detail" }, item.detail) : null, note ? h("p", { class: "muted small" }, note) : null, actions.length ? h("div", { class: "inbox-actions" }, actions) : null);
}

function approvalBody(app, state, item, ro) {
  const a = state.approvals[item.refId];
  if (!a) return simpleBody(item, []);
  const key = "appr:" + a.id;
  if (!app.ui.openSeen.has(key)) {
    app.ui.openSeen.add(key);
    if (a.diff) app.ui.open.add(key);
  }
  const w = state.workers[a.workerId];
  const buttons = (a.options ?? []).map((o) => {
    const kind = o.kind ?? "";
    const label = o.label ?? o.name ?? kind;
    const id = o.id ?? o.optionId;
    const tone = kind === "allow_once" ? "primary" : kind === "allow_always" ? "default" : kind.startsWith("reject") ? "danger" : "default";
    const ic = kind.startsWith("allow") ? "check" : kind.startsWith("reject") ? "x" : null;
    const title = kind === "allow_always" ? "Allow, and remember this choice. Only use this if you trust it." : kind === "allow_once" ? "Allow just this one request." : kind.startsWith("reject") ? "Say no. The agent is told it was denied." : label;
    return btn(app, { label, icon: ic, kind: tone, small: true, title, reason: ro ? "Not while replaying." : null, fk: `in:${item.id}:opt:${id}`, onClick: () => runAction(app, { type: "approval", approval: a, option: o }) });
  });
  return h("div", { class: "inbox-body-in" },
    h("p", { class: "inbox-summary" }, h("span", { class: "approval-kind" }, `${w?.name ?? "An agent"} ${APPROVAL_KIND[a.kind] ?? APPROVAL_KIND.other}`), h("strong", { class: "approval-title" }, a.title)),
    a.detail ? h("pre", { class: "detail-pre", tabindex: "0", "aria-label": "Request details" }, a.detail) : null,
    a.diff ? disclosure(app, key, "Proposed changes", () => diffBlock(a.diff, { label: "Proposed changes" })) : null,
    h("div", { class: "inbox-actions" }, buttons),
    h("p", { class: "muted small" }, "Nothing is approved for you. The agent waits until you choose."),
  );
}

function failedCheckBody(app, state, item, w, ro) {
  const failed = (w?.checks ?? []).filter((c) => c.status !== "pass");
  const rules = interruptRules(w);
  const textKey = "fc:" + item.id;
  const text = () => (app.ui.drafts.get(textKey) ?? "").trim();
  const send = (name) => {
    const t = text();
    if (!t) {
      app.toast(`Write a short instruction for ${w?.name ?? "the agent"} first.`, "info");
      return null;
    }
    const okText = name === "nudge" ? `Nudge queued for ${w.name}. It sends when the current step ends; see the receipt in the Inspector.` : `Redirect sent to ${w.name}. See the receipt in the Inspector.`;
    return app.act(name, { workerId: w.id, text: t }, { ok: okText }).then((r) => {
      if (r?.ok) app.ui.drafts.delete(textKey);
      return r;
    });
  };
  const field = draftField(app, { key: textKey, placeholder: "What should it try? e.g. use the existing helper", ariaLabel: `Instruction for ${w?.name ?? "the agent"}`, maxlength: 600, fk: `in:${item.id}:text`, onEnter: () => send("nudge") });
  const ro_ = ro ? "Not while replaying." : null;
  return h("div", { class: "inbox-body-in" },
    h("p", { class: "inbox-summary" }, item.summary),
    item.detail ? h("p", { class: "inbox-detail" }, item.detail) : null,
    failed.length
      ? disclosure(app, "chk:" + item.id, `View output (${failed.length} failing)`, () => failed.map((c) => h("div", { class: "check-out" }, h("p", { class: "check-name" }, icon("xcircle", { size: 14 }), c.name), h("pre", { class: "out", tabindex: "0", "aria-label": `Output of ${c.name}` }, c.output || "(no output)"))))
      : null,
    w ? h("div", { class: "inbox-steer" }, field, h("div", { class: "inbox-actions" },
      btn(app, { label: "Nudge", icon: "send", kind: "primary", small: true, title: "Sent as the next prompt, when the current step ends.", reason: ro_ ?? rules.nudge, fk: `in:${item.id}:nudge`, onClick: () => send("nudge") }),
      btn(app, { label: "Redirect", icon: "arrow", small: true, title: "Sent right away; pre-empts the current step.", reason: ro_ ?? rules.redirect, fk: `in:${item.id}:redirect`, onClick: () => send("redirect") }),
      btn(app, { label: "Resume", icon: "play", small: true, title: "Re-prompts the agent to continue.", reason: ro_ ?? rules.resume, fk: `in:${item.id}:resume`, onClick: () => app.act("resume", { workerId: w.id }, { ok: null }) }),
      btn(app, { label: w.takeover ? "Hand back" : "Take over", icon: "hand", small: true, reason: ro_ ?? (w.takeover ? rules.handBack : rules.takeover), fk: `in:${item.id}:take`, onClick: () => app.act(w.takeover ? "handBack" : "takeOver", { workerId: w.id }, { ok: null }) }),
      btn(app, { label: "Inspect", icon: "inspector", small: true, kind: "ghost", fk: `in:${item.id}:insp`, onClick: () => app.select(w.id, { open: true }) }),
    )) : null,
  );
}

function suggestionBody(app, state, item, ro) {
  const s = state.suggestions[item.refId];
  return h("div", { class: "inbox-body-in" },
    h("p", { class: "inbox-summary" }, s ? `\u201c${s.text}\u201d` : item.summary),
    s ? h("p", { class: "muted small" }, `From ${s.from}. You decide whether it goes anywhere.`) : null,
    h("div", { class: "inbox-actions" },
      btn(app, { label: "Accept", icon: "check", kind: "primary", small: true, reason: ro ? "Not while replaying." : null, fk: `in:${item.id}:accept`, onClick: () => app.act("resolveSuggestion", { id: item.refId, decision: "accept" }, { ok: "Suggestion accepted." }) }),
      btn(app, { label: "Reject", icon: "x", small: true, reason: ro ? "Not while replaying." : null, fk: `in:${item.id}:reject`, onClick: () => app.act("resolveSuggestion", { id: item.refId, decision: "reject" }, { ok: "Suggestion rejected." }) }),
    ),
  );
}

export { primaryFor };
