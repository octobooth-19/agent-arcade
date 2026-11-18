// Work-orders board: what the Foreman proposed, who owns each order, and the big "Approve & start" button.
import { h, parseList, pluralize } from "./util.js";
import { icon } from "./icons.js";
import { btn, slot, panelHead, chip, emptyState, draftField, labeled, meter } from "./ui.js";
import { visibleOrders, orderStats, orderStatusMeta, orderOwner, ROLE_LABELS } from "./model.js";

const OWNER_ROLES = ["planner", "builder", "checker"];

export function createOrders(app) {
  const body = slot(app, "div", { class: "orders-body" });
  const progress = h("div", { class: "orders-progress" });
  const head = panelHead("orders", "Work orders", "orders-title", progress);
  const root = h("section", { class: "panel orders", id: "orders", "aria-labelledby": "orders-title", "data-sec": "orders" }, head, body.el);

  function update(state) {
    const orders = visibleOrders(state);
    const stats = orderStats(state);
    const ro = app.ui.readOnly;
    const live = app.arcade.source === "live";
    const lead = state.workerOrder.map((id) => state.workers[id]).find((w) => w.role === "lead");
    const leadBusy = lead && (lead.status === "working" || lead.status === "waiting_approval");
    const editing = [...app.ui.editing].join(",");

    progress.replaceChildren(
      ...(stats.total
        ? [
            h("span", { class: "progress-text" }, `${stats.shipped}/${stats.total} shipped`),
            meter({ pct: Math.round((stats.shipped / stats.total) * 100), label: "Work orders shipped", valueText: `${stats.shipped} of ${stats.total} shipped`, tone: "good" }),
          ]
        : []),
    );

    const sig = JSON.stringify([
      orders.map((o) => [o.id, o.title, o.status, o.ownerId, o.ownerRole, o.allowedFiles, o.acceptance, o.dependsOn, o.ownerId && state.workers[o.ownerId]?.queuedReason, o.ownerId && state.workers[o.ownerId]?.name]),
      state.batch.status, state.goal, ro, live, leadBusy, editing, app.ui.addingOrder, state.maxConcurrent,
    ]);
    body.set(sig, (el) => {
      const proposed = orders.filter((o) => o.status === "proposed");
      const canEdit = !ro && state.goal && state.batch.status !== "approved";

      if (!state.goal) {
        el.append(emptyState("No work orders yet.", "Set a goal above. The Foreman will break it into work orders for you to approve.", "orders"));
        return;
      }
      if (!orders.length && !app.ui.addingOrder) {
        el.append(emptyState(state.batch.status === "none" ? "The Foreman is drafting work orders\u2026" : "No work orders.", canEdit ? "You can also write an order yourself." : null, "orders"));
      }

      if (proposed.length && !ro && state.batch.status !== "approved") {
        const waiting = state.batch.status !== "proposed" && leadBusy;
        const start = h("div", { class: "approve-box" },
          h("div", { class: "approve-text" },
            h("strong", {}, state.batch.status === "proposed" ? "The Foreman is done. Read the orders, then start." : "Ready when you are."),
            h("span", { class: "muted small" }, `${pluralize(proposed.length, "order")} will go out, ${state.maxConcurrent} ${state.maxConcurrent === 1 ? "agent" : "agents"} at a time. Orders that depend on others wait at the stage door.` + (live ? " This starts real Copilot sessions that use your premium requests." : " Demo mode: scripted, nothing real runs.")),
          ),
          btn(app, { label: "Approve & start", icon: "play", kind: "primary", cls: "btn-big", fk: "ord:approve", reason: waiting ? "The Foreman is still drafting. Approve once the orders land." : null, onClick: () => app.approveBatch() }),
        );
        el.append(start);
      }

      if (orders.length) {
        const list = h("ol", { class: "order-list" });
        for (const o of orders) list.append(h("li", { class: "order-li" }, app.ui.editing.has(o.id) ? editForm(app, state, o, orders) : orderCard(app, state, o, canEdit)));
        el.append(list);
      }

      if (canEdit) {
        el.append(app.ui.addingOrder ? addForm(app, orders) : btn(app, { label: "Add order", icon: "plus", fk: "ord:add", onClick: () => { app.ui.addingOrder = true; app.ui.pendingFocus = "order:new:title"; app.forceRender(); } }));
      }
    });
  }

  return { el: root, update };
}

function orderCard(app, state, o, canEdit) {
  const m = orderStatusMeta(o.status);
  const owner = orderOwner(state, o);
  const ownerW = o.ownerId ? state.workers[o.ownerId] : null;
  const deps = (o.dependsOn ?? []).map((id) => state.orders[id]?.title ?? id);
  const proposed = o.status === "proposed";
  return h("article", { class: ["order", "os-" + o.status], "aria-label": `Order: ${o.title}` },
    h("div", { class: "order-top" },
      h("h3", { class: "order-title" }, o.title || "Untitled order"),
      chip(m.label, { tone: m.tone, icon: m.icon }),
    ),
    h("p", { class: "order-owner" }, app.avatar(owner.role, ownerW?.status ?? "idle", 24), h("span", {}, h("strong", {}, owner.name), owner.assigned ? " " : " (not started) "), h("span", { class: "muted" }, ROLE_LABELS[owner.role] ?? owner.role)),
    o.acceptance ? h("p", { class: "order-line" }, h("span", { class: "k" }, "Done when"), o.acceptance) : null,
    h("p", { class: "order-line" }, h("span", { class: "k" }, "May touch"), (o.allowedFiles ?? []).length ? h("span", { class: "files" }, o.allowedFiles.map((f) => h("code", { class: "file-chip" }, f))) : h("span", { class: "muted" }, "No file limits set")),
    deps.length ? h("p", { class: "order-line" }, h("span", { class: "k" }, "Waits for"), deps.join(", ")) : null,
    ownerW?.status === "queued" && ownerW.queuedReason ? h("p", { class: "order-line queued-why" }, icon("clock", { size: 14 }), ownerW.queuedReason) : null,
    h("div", { class: "order-actions" },
      ownerW ? btn(app, { label: "Inspect " + ownerW.name, icon: "inspector", small: true, kind: "ghost", fk: "ord:insp:" + o.id, onClick: () => app.select(ownerW.id, { open: true }) }) : null,
      o.status === "review" ? btn(app, { label: "Open review", icon: "eye", small: true, kind: "ghost", fk: "ord:rev:" + o.id, onClick: () => app.jumpTo("review") }) : null,
      proposed && canEdit ? btn(app, { label: "Edit", icon: "edit", small: true, fk: "ord:edit:" + o.id, onClick: () => startEdit(app, o) }) : null,
      proposed && canEdit ? btn(app, { label: "Remove", icon: "trash", small: true, kind: "ghost", fk: "ord:rm:" + o.id, onClick: () => app.act("removeOrder", { id: o.id }, { ok: `Removed \u201c${o.title}\u201d.` }) }) : null,
    ),
  );
}

function startEdit(app, o) {
  const k = (f) => `order:${o.id}:${f}`;
  app.ui.drafts.set(k("title"), o.title ?? "");
  app.ui.drafts.set(k("role"), o.ownerRole ?? "builder");
  app.ui.drafts.set(k("files"), (o.allowedFiles ?? []).join("\n"));
  app.ui.drafts.set(k("accept"), o.acceptance ?? "");
  app.ui.drafts.set(k("deps"), (o.dependsOn ?? []).join(","));
  app.ui.editing.add(o.id);
  app.ui.pendingFocus = k("title");
  app.forceRender();
}

function stopEdit(app, id) {
  app.ui.editing.delete(id);
  for (const key of [...app.ui.drafts.keys()]) if (key.startsWith(`order:${id}:`)) app.ui.drafts.delete(key);
  app.ui.pendingFocus = "ord:edit:" + id;
  app.forceRender();
}

function fields(app, prefix, orders, selfId) {
  const k = (f) => `${prefix}:${f}`;
  const title = draftField(app, { key: k("title"), placeholder: "What should be done?", ariaLabel: "Order title", maxlength: 200, fk: k("title") });
  const roleSel = h("select", { class: "field", "data-fk": k("role"), onChange: (e) => app.ui.drafts.set(k("role"), e.target.value) }, OWNER_ROLES.map((r) => h("option", { value: r }, ROLE_LABELS[r])));
  roleSel.value = app.ui.drafts.get(k("role")) ?? "builder";
  const files = draftField(app, { key: k("files"), tag: "textarea", rows: 2, placeholder: "One path per line, e.g. src/theme.js", ariaLabel: "Files this order may touch", fk: k("files") });
  const accept = draftField(app, { key: k("accept"), tag: "textarea", rows: 2, placeholder: "How will you know it is done?", ariaLabel: "Acceptance", fk: k("accept") });
  const others = orders.filter((o) => o.id !== selfId);
  const current = new Set(parseList(app.ui.drafts.get(k("deps"))));
  const deps = others.length
    ? h("fieldset", { class: "deps" }, h("legend", {}, "Waits for"), others.map((o) => {
        const cb = h("input", { type: "checkbox", id: `${prefix}-dep-${o.id}`, checked: current.has(o.id), "data-fk": `${k("dep")}:${o.id}` });
        cb.addEventListener("change", () => {
          const set = new Set(parseList(app.ui.drafts.get(k("deps"))));
          cb.checked ? set.add(o.id) : set.delete(o.id);
          app.ui.drafts.set(k("deps"), [...set].join(","));
        });
        return h("label", { class: "check", for: cb.id }, cb, h("span", {}, o.title));
      }))
    : null;
  const read = () => ({
    title: (app.ui.drafts.get(k("title")) ?? "").trim(),
    ownerRole: app.ui.drafts.get(k("role")) ?? "builder",
    allowedFiles: parseList(app.ui.drafts.get(k("files"))),
    acceptance: (app.ui.drafts.get(k("accept")) ?? "").trim(),
    dependsOn: parseList(app.ui.drafts.get(k("deps"))),
  });
  return { nodes: [labeled("Title", title), labeled("Who does it", roleSel), labeled("Files it may touch", files, "Leave empty for no limit."), labeled("Done when", accept), deps], read };
}

function editForm(app, state, o, orders) {
  const f = fields(app, `order:${o.id}`, orders, o.id);
  const save = async () => {
    const v = f.read();
    if (!v.title) return app.toast("An order needs a title.", "error");
    const r = await app.act("updateOrder", { order: { id: o.id, ...v } }, { ok: "Order updated." });
    if (r?.ok) stopEdit(app, o.id);
  };
  return h("form", { class: "order order-form", onSubmit: (e) => { e.preventDefault(); save(); }, "aria-label": `Edit order: ${o.title}` },
    h("h3", { class: "order-title" }, "Edit order"),
    f.nodes,
    h("div", { class: "order-actions" }, btn(app, { label: "Save", icon: "check", kind: "primary", small: true, type: "submit", fk: "ord:save:" + o.id }), btn(app, { label: "Cancel", small: true, kind: "ghost", fk: "ord:cancel:" + o.id, onClick: () => stopEdit(app, o.id) })),
  );
}

function addForm(app, orders) {
  const f = fields(app, "order:new", orders, null);
  const done = () => {
    app.ui.addingOrder = false;
    for (const key of [...app.ui.drafts.keys()]) if (key.startsWith("order:new:")) app.ui.drafts.delete(key);
    app.ui.pendingFocus = "ord:add";
    app.forceRender();
  };
  const save = async () => {
    const v = f.read();
    if (!v.title) return app.toast("An order needs a title.", "error");
    const r = await app.act("addOrder", { order: v }, { ok: "Order added." });
    if (r?.ok) done();
  };
  return h("form", { class: "order order-form", onSubmit: (e) => { e.preventDefault(); save(); }, "aria-label": "Add a work order" },
    h("h3", { class: "order-title" }, "Add an order"),
    f.nodes,
    h("div", { class: "order-actions" }, btn(app, { label: "Add order", icon: "plus", kind: "primary", small: true, type: "submit", fk: "ord:new:save" }), btn(app, { label: "Cancel", small: true, kind: "ghost", fk: "ord:new:cancel", onClick: done })),
  );
}
