// Glass Box inspector: everything about the selected worker, plus honest steering controls.
import { h, formatElapsed, formatTokens, percent, joinPath } from "./util.js";
import { icon } from "./icons.js";
import { btn, slot, panelHead, chip, emptyState, disclosure, diffBlock, draftField, meter, kv, renderKeepingFocus } from "./ui.js";
import { statusMeta, interruptRules, receipt, NOTE_KIND_LABELS, NOTE_QUEUED_HINT, HOLD_COPY, pendingNotes } from "./model.js";
import { workerElapsedMs } from "/shared/state.js";

export function createInspector(app) {
  const empty = h("div", { class: "insp-empty" }, emptyState("Pick someone to look inside.", "Click a character on the stage, a crew card, or an item in Needs you.", "inspector"));
  const header = slot(app, "div", { class: "insp-header" });
  const meta = slot(app, "div", { class: "insp-meta" });
  const plan = slot(app, "div", { class: "insp-sec" });
  const files = slot(app, "div", { class: "insp-sec" });
  const outputBox = h("div", { class: "insp-sec insp-output" });
  const outputPre = h("pre", { class: "out out-tail", tabindex: "0", "aria-label": "Latest output from this agent" });
  const outputNote = h("p", { class: "muted small", hidden: true }, "Scrolled up: new output keeps arriving below.");
  const checks = slot(app, "div", { class: "insp-sec" });
  const notes = slot(app, "div", { class: "insp-sec" });
  const controls = slot(app, "div", { class: "insp-controls" });
  const noteField = h("div", { class: "insp-notefield" });
  const body = h("div", { class: "insp-body" }, header.el, controls.el, noteField, meta.el, plan.el, files.el, outputBox, checks.el, notes.el);
  const root = h("section", { class: "panel inspector", id: "inspector", "aria-labelledby": "inspector-title", "data-sec": "inspector" }, panelHead("inspector", "Inspector", "inspector-title", h("span", { class: "muted small glass-tag" }, "Glass box")), empty, body);

  let shownId = null;
  let stick = true;
  let outSig = "";
  outputBox.append(h("h3", { class: "sec-title" }, icon("list", { size: 15 }), "Output (latest lines)"), outputPre, outputNote);
  outputPre.addEventListener("scroll", () => {
    stick = outputPre.scrollHeight - outputPre.scrollTop - outputPre.clientHeight < 28;
    outputNote.hidden = stick;
  });

  function update(state) {
    const w = state.workers[app.ui.selectedId];
    empty.hidden = !!w;
    body.hidden = !w;
    if (!w) {
      shownId = null;
      return;
    }
    if (shownId !== w.id) {
      shownId = w.id;
      stick = true;
      outSig = "";
      noteField.replaceChildren();
      noteField.dataset.for = "";
    }
    const ro = app.ui.readOnly;
    const m = statusMeta(w.status);
    const order = w.orderId ? state.orders[w.orderId] : null;

    header.set([w.id, w.name, w.role, w.status, w.takeover, order?.title, w.queuedReason].join("|"), (el) => {
      el.append(
        h("div", { class: "insp-who" },
          app.avatar(w.role, w.status, 64),
          h("div", { class: "insp-id" },
            h("h3", { class: "insp-name" }, w.name),
            h("p", { class: "muted" }, app.roleLabel(w.role) + (w.model ? " \u00b7 " + w.model : "")),
            h("div", { class: "insp-chips" }, chip(app.statusLabel(w.status), { tone: m.tone, icon: m.icon }), w.takeover ? chip("You're driving", { tone: "accent", icon: "hand" }) : null),
          ),
        ),
        w.status === "queued" && w.queuedReason ? h("p", { class: "queued-why" }, icon("clock", { size: 14 }), w.queuedReason) : null,
        order ? h("p", { class: "insp-order" }, h("span", { class: "k" }, "Order"), order.title) : h("p", { class: "insp-order muted" }, "No order assigned."),
      );
    });

    const ctxPct = w.context ? percent(w.context.used, w.context.size) : null;
    meta.set([w.now, w.steps, w.context?.used, w.context?.size, w.worktree?.branch, w.worktree?.path, w.role].join("|"), (el) => {
      el.append(
        h("dl", { class: "kvs kvs-inline" },
          kv("Now", w.now || "Nothing yet"),
          kv("Steps so far", String(w.steps ?? 0)),
          kv("Time working", h("span", { "data-elapsed": w.id }, formatElapsed(workerElapsedMs(state, w)))),
          w.worktree?.branch ? kv("Branch", h("code", {}, w.worktree.branch)) : null,
        ),
        h("div", { class: "ctx" },
          h("p", { class: "ctx-label" }, "Context window ", h("span", { class: "muted small" }, "(how much of the agent's memory is used)")),
          w.context && ctxPct !== null
            ? [meter({ pct: ctxPct, label: "Context used", valueText: `${formatTokens(w.context.used)} of ${formatTokens(w.context.size)} tokens`, tone: ctxPct >= 90 ? "bad" : ctxPct >= 70 ? "warn" : "good" }), h("p", { class: "ctx-text" }, `${formatTokens(w.context.used)} of ${formatTokens(w.context.size)} tokens (${ctxPct}%)`)]
            : h("p", { class: "ctx-text" }, "unknown", h("span", { class: "muted small" }, " \u2014 this agent hasn't reported it")),
        ),
      );
    });
    for (const t of body.querySelectorAll("[data-elapsed]")) t.textContent = formatElapsed(workerElapsedMs(state, w));

    plan.set(JSON.stringify([w.id, w.plan]), (el) => {
      el.append(h("h3", { class: "sec-title" }, icon("list", { size: 15 }), "Plan"));
      if (!w.plan?.length) return el.append(h("p", { class: "muted small" }, "No plan reported yet."));
      el.append(
        h("ul", { class: "plan" }, w.plan.map((p) => {
          const label = p.status === "done" ? "done" : p.status === "doing" ? "in progress" : "to do";
          return h("li", { class: "plan-" + p.status }, icon(p.status === "done" ? "check" : p.status === "doing" ? "play" : "dot", { size: 14 }), h("span", {}, p.text), h("span", { class: "sr-only" }, ` (${label})`));
        })),
      );
    });

    const base = w.worktree?.path ?? state.project?.path ?? "";
    const vsReason = ro ? "Not while replaying." : app.arcade.source !== "live" ? "Opens your real project, so it only works when connected to Copilot (live mode)." : !base ? "No folder is known for this agent yet." : null;
    files.set(JSON.stringify([w.id, (w.files ?? []).map((f) => [f.path, f.added, f.removed, (f.diff ?? "").length]), vsReason]), (el) => {
      el.append(h("h3", { class: "sec-title" }, icon("edit", { size: 15 }), `Files changed (${w.files?.length ?? 0})`));
      if (!w.files?.length) return el.append(h("p", { class: "muted small" }, "No file changes yet."));
      const ul = h("ul", { class: "files-list" });
      for (const f of w.files) {
        ul.append(
          h("li", {},
            disclosure(app, `file:${w.id}:${f.path}`, h("span", { class: "file-sum" }, h("code", { class: "file-path" }, f.path), h("span", { class: "added", title: "lines added" }, "+" + (f.added ?? 0)), h("span", { class: "removed", title: "lines removed" }, "\u2212" + (f.removed ?? 0))), () => [
              diffBlock(f.diff, { maxLines: 400, label: `Diff of ${f.path}` }),
              btn(app, { label: "Open in VS Code", icon: "external", small: true, kind: "ghost", reason: vsReason, fk: `vs:${w.id}:${f.path}`, onClick: () => app.act("openInVSCode", { path: joinPath(base, f.path) }, { ok: "Opening in VS Code." }) }),
            ]),
          ),
        );
      }
      el.append(ul);
    });

    const out = w.output ?? [];
    const sig = out.length + "|" + (out[out.length - 1] ?? "") + "|" + out[0];
    if (sig !== outSig) {
      outSig = sig;
      const wasStuck = stick;
      outputPre.replaceChildren(...(out.length ? out.map((line) => h("span", { class: "ol " + (/^FAIL\b/.test(line) ? "ol-fail" : /^PASS\b/.test(line) ? "ol-pass" : "") }, line || " ")) : [h("span", { class: "ol muted" }, "No output yet.")]));
      if (wasStuck) outputPre.scrollTop = outputPre.scrollHeight;
    }

    checks.set(JSON.stringify([w.id, w.checks ?? []]), (el) => {
      el.append(h("h3", { class: "sec-title" }, icon("check", { size: 15 }), "Checks"));
      if (!w.checks?.length) return el.append(h("p", { class: "muted small" }, "No checks have run for this agent."));
      el.append(h("ul", { class: "checks" }, w.checks.map((c) => {
        const pass = c.status === "pass";
        return h("li", { class: "check-li " + (pass ? "pass" : "fail") },
          chip(pass ? "Passed" : "Failed", { tone: pass ? "good" : "bad", icon: pass ? "check" : "xcircle" }),
          h("span", { class: "check-name" }, c.name),
          c.output ? disclosure(app, `chk:${w.id}:${c.name}`, "Output", () => h("pre", { class: "out", tabindex: "0", "aria-label": `Output of ${c.name}` }, c.output)) : null,
        );
      })));
    });

    notes.set(JSON.stringify([w.id, w.notes]), (el) => {
      el.append(h("h3", { class: "sec-title" }, icon("send", { size: 15 }), "Notes you sent"));
      if (!w.notes?.length) return el.append(h("p", { class: "muted small" }, "Nothing sent yet. Holds, nudges and redirects show up here with a receipt."));
      el.append(
        h("ul", { class: "notes" }, [...w.notes].reverse().map((n) => {
          const r = receipt(n);
          return h("li", { class: "note note-" + n.delivery },
            h("div", { class: "note-top" }, h("strong", {}, NOTE_KIND_LABELS[n.kind] ?? n.kind), chip(r.label, { tone: r.tone, icon: r.icon }), h("span", { class: "muted small" }, "at " + formatElapsed(n.sentAt))),
            n.text ? h("p", { class: "note-text" }, n.text) : null,
            n.delivery === "queued" && NOTE_QUEUED_HINT[n.kind] ? h("p", { class: "muted small" }, NOTE_QUEUED_HINT[n.kind]) : null,
            n.delivery === "failed" ? h("p", { class: "muted small" }, "Not delivered. You can send it again.") : null,
          );
        })),
      );
    });

    const rules = interruptRules(w);
    const rr = (why) => (ro ? "Not while replaying. Use Back to live to steer." : why);
    const pend = pendingNotes(w).length;
    const popOpen = app.ui.pop === "interrupts";
    controls.set([w.id, w.status, w.takeover, pend, ro, app.arcade.source, popOpen].join("|"), (el) => {
      el.append(
        h("div", { class: "ctl-row", role: "group", "aria-label": `Steer ${w.name}` },
          btn(app, { label: "Hold", icon: "pause", reason: rr(rules.hold), title: HOLD_COPY, fk: "insp:hold", onClick: () => app.act("hold", { workerId: w.id }, { ok: "Hold queued. It stops at the next safe point; see the receipt below." }) }),
          btn(app, { label: "Resume", icon: "play", reason: rr(rules.resume), title: "Re-prompts the agent so it carries on.", fk: "insp:resume", onClick: () => app.act("resume", { workerId: w.id }, { ok: "Resume sent. The agent is re-prompted." }) }),
          w.takeover
            ? btn(app, { label: "Hand back", icon: "undo", reason: rr(rules.handBack), fk: "insp:handback", onClick: () => app.act("handBack", { workerId: w.id }, { ok: null }) })
            : btn(app, { label: "Take over", icon: "hand", reason: rr(rules.takeover), title: "Parks the agent at its next safe point so you can work in its folder.", fk: "insp:takeover", onClick: () => app.act("takeOver", { workerId: w.id }, { ok: null }) }),
          btn(app, { label: "Open in VS Code", icon: "external", kind: "ghost", reason: vsReason, fk: "insp:vscode", onClick: () => app.act("openInVSCode", { path: base }, { ok: "Opening in VS Code." }) }),
          btn(app, { label: "How interrupts work", icon: "help", kind: "ghost", expanded: popOpen, controls: "pop-interrupts", fk: "insp:how", cls: "pop-trigger", onClick: () => app.togglePopover("interrupts") }),
        ),
        popOpen ? interruptsPopover() : null,
      );
    });

    const fieldKey = `note:${w.id}`;
    if (noteField.dataset.for !== w.id + "|" + ro + "|" + rules.nudge + "|" + rules.redirect) {
      noteField.dataset.for = w.id + "|" + ro + "|" + rules.nudge + "|" + rules.redirect;
      const send = async (name, okText) => {
        const text = (app.ui.drafts.get(fieldKey) ?? "").trim();
        if (!text) return app.toast(`Write a short instruction for ${w.name} first.`, "info");
        const r = await app.act(name, { workerId: w.id, text }, { ok: okText });
        if (r?.ok) {
          app.ui.drafts.delete(fieldKey);
          const f = noteField.querySelector("input");
          if (f) f.value = "";
        }
      };
      const input = draftField(app, { key: fieldKey, placeholder: `Tell ${w.name} something\u2026`, ariaLabel: `Message for ${w.name}`, maxlength: 600, fk: "insp:note", onEnter: () => send("nudge", "Nudge queued. It sends when the current step ends; see the receipt below.") });
      renderKeepingFocus(app, noteField, () => noteField.replaceChildren(
        h("label", { class: "lbl" }, h("span", { class: "lbl-text" }, "Nudge or redirect"), input),
        h("div", { class: "ctl-row" },
          btn(app, { label: "Nudge", icon: "send", kind: "primary", reason: rr(rules.nudge), title: NOTE_QUEUED_HINT.nudge, fk: "insp:nudge", onClick: () => send("nudge", "Nudge queued. It sends when the current step ends; see the receipt below.") }),
          btn(app, { label: "Redirect", icon: "arrow", reason: rr(rules.redirect), title: NOTE_QUEUED_HINT.redirect, fk: "insp:redirect", onClick: () => send("redirect", "Redirect sent. See the receipt below for when it lands.") }),
        ),
        h("p", { class: "hint" }, "Nudge waits for the current step to end. Redirect cuts in right away and abandons the current step."),
      ));
    }
  }

  return { el: root, update };
}

function interruptsPopover() {
  const row = (term, text) => h("div", { class: "kv" }, h("dt", {}, term), h("dd", {}, text));
  return h("div", { class: "popover popover-block", id: "pop-interrupts", role: "dialog", "aria-label": "How interrupts work" },
    h("p", { class: "pop-title" }, "How interrupts work"),
    h("dl", { class: "kvs" },
      row("Hold", HOLD_COPY),
      row("Resume", "Sends the agent a new \u201ccontinue\u201d prompt. It picks up from what it knows, not from a frozen moment."),
      row("Nudge", "Queued, then sent as the next prompt when the current step ends. It never cuts in."),
      row("Redirect", "Sent right away. It pre-empts the current turn, so the step in progress is abandoned."),
      row("Take over", "Parks the agent at the next safe point so you can work in its folder. Hand back when you're done."),
    ),
    h("p", { class: "muted small" }, "Every note shows a receipt: Queued, then Delivered at step N, or Failed. Nothing here is instant."),
  );
}
