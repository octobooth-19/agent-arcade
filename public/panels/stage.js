// Stage: the studio scene (when the studio module loads) plus the crew list, which is also the accessible,
// keyboard-friendly fallback when the scene is missing or fails.
import { h, formatElapsed } from "./util.js";
import { icon } from "./icons.js";
import { slot, panelHead, chip, emptyState } from "./ui.js";
import { workerList, statusMeta, pendingNotes, orderStats } from "./model.js";
import { workerElapsedMs } from "/shared/state.js";

export function createStage(app) {
  const sceneMount = h("div", { class: "stage-scene-inner" });
  const sceneBox = h("div", { class: "stage-scene", role: "group", "aria-label": "Pocket Studio scene" }, sceneMount);
  const sceneNote = h("p", { class: "muted small stage-note", hidden: true });
  const crew = slot(app, "div", { class: "crew" });
  const summary = h("p", { class: "stage-summary", role: "status" });
  const root = h("section", { class: "panel stage", "aria-labelledby": "stage-title", "data-sec": "stage" }, panelHead("stage", "Stage", "stage-title", summary), sceneBox, sceneNote, crew.el);

  let instance = null;
  let mountedFor = null;
  let lastRev = -1;
  let lastSel = null;
  let failed = false;

  function ctx() {
    return {
      getState: () => app.state,
      select: (id) => app.select(id, { fromScene: true }),
      selectedId: () => app.ui.selectedId,
      command: (name, payload) => app.arcade.command(name, payload),
      get reducedMotion() {
        return app.reducedMotion();
      },
    };
  }

  function destroyScene() {
    try {
      instance?.destroy?.();
    } catch {
      /* ignore */
    }
    instance = null;
    mountedFor = null;
    sceneMount.replaceChildren();
    lastRev = -1;
  }

  // The scene needs ~480px. In narrower containers (phones, side panels) shrink it to fit rather than scroll sideways.
  const SCENE_W = 480;
  const SCENE_H = 320;
  function fitScene() {
    const w = sceneBox.clientWidth;
    const k = w > 0 && w < SCENE_W ? Math.max(w / SCENE_W, 0.6) : 1;
    if (k === 1) {
      sceneMount.removeAttribute("style");
      sceneBox.style.removeProperty("height");
      sceneBox.classList.remove("is-scaled");
      return;
    }
    sceneBox.classList.add("is-scaled");
    sceneMount.style.setProperty("width", `${SCENE_W}px`);
    sceneMount.style.setProperty("height", `${SCENE_H}px`);
    sceneMount.style.setProperty("transform", `scale(${k.toFixed(4)})`);
    sceneBox.style.setProperty("height", `${Math.ceil(SCENE_H * k)}px`);
  }
  if (typeof ResizeObserver === "function") new ResizeObserver(fitScene).observe(sceneBox);

  function mount() {
    const mod = app.studio;
    if (!mod || failed) return;
    if (instance && mountedFor === app.arcade) return;
    destroyScene();
    try {
      instance = mod.mountStudio(sceneMount, ctx());
      mountedFor = app.arcade;
      sceneBox.dataset.mounted = "1";
    } catch (err) {
      console.error("[arcade] studio failed to mount", err);
      failed = true;
      instance = null;
      sceneBox.dataset.mounted = "";
    }
  }

  function update(state) {
    mount();
    const hasScene = !!instance;
    sceneBox.hidden = !hasScene;
    root.dataset.scene = hasScene ? "on" : "off";
    if (hasScene && (state.rev !== lastRev || app.ui.selectedId !== lastSel)) {
      lastRev = state.rev;
      lastSel = app.ui.selectedId;
      try {
        instance.update(state);
      } catch (err) {
        console.error("[arcade] studio update failed", err);
        failed = true;
        destroyScene();
      }
    }
    sceneNote.hidden = hasScene || !app.studioProblem;
    sceneNote.textContent = hasScene ? "" : app.studioProblem ?? "";

    const workers = workerList(state);
    const active = workers.filter((w) => ["working", "waiting_approval", "blocked"].includes(w.status)).length;
    const stats = orderStats(state);
    summary.textContent = workers.length ? `${active} active \u00b7 ${stats.shipped}/${stats.total} shipped` : "Nobody here yet";

    const sig = workers
      .map((w) => [w.id, w.status, w.now, w.queuedReason, w.orderId, pendingNotes(w).length, w.takeover, w.name, w.role, w.id === app.ui.selectedId, state.orders[w.orderId]?.title].join("~"))
      .join("|");
    crew.set(sig + "|" + hasScene, (el) => {
      if (!workers.length) {
        el.append(emptyState("The studio is quiet.", "Give the Foreman a goal and the team shows up here.", "stage"));
        return;
      }
      const list = h("ul", { class: "crew-list", "aria-label": "Crew" });
      for (const w of workers) list.append(h("li", {}, card(app, state, w)));
      el.append(list);
    });

    for (const t of root.querySelectorAll("[data-elapsed]")) {
      const w = state.workers[t.dataset.elapsed];
      if (w) t.textContent = formatElapsed(workerElapsedMs(state, w));
    }
  }

  function remount() {
    failed = false;
    destroyScene();
  }

  return { el: root, update, remount, destroyScene };
}

function card(app, state, w) {
  const m = statusMeta(w.status);
  const selected = app.ui.selectedId === w.id;
  const order = w.orderId ? state.orders[w.orderId] : null;
  const pending = pendingNotes(w);
  const lines = [];
  if (w.status === "queued" && w.queuedReason) lines.push(h("span", { class: "card-line queued-why" }, icon("clock", { size: 13 }), w.queuedReason));
  else if (w.now) lines.push(h("span", { class: "card-line" }, w.now));
  if (order) lines.push(h("span", { class: "card-line muted" }, "Order: " + order.title));
  const b = h("button", { type: "button", class: ["crew-card", "st-" + w.status, selected && "is-selected"], "aria-pressed": String(selected), "data-fk": "crew:" + w.id, onClick: () => app.select(w.id), title: `Inspect ${w.name}` },
    h("span", { class: "avatar-wrap" }, app.avatar(w.role, w.status, 44)),
    h("span", { class: "card-body" },
      h("span", { class: "card-top" }, h("strong", { class: "card-name" }, w.name), w.name === app.roleLabel(w.role) ? null : h("span", { class: "card-role" }, app.roleLabel(w.role))),
      h("span", { class: "card-status" }, chip(app.statusLabel(w.status), { tone: m.tone, icon: m.icon }), w.takeover ? chip("You're driving", { tone: "accent", icon: "hand" }) : null, pending.length ? chip(`${pending.length} queued`, { tone: "warn", icon: "clock", title: "Notes waiting for the agent's next safe point" }) : null, w.role !== "lead" && w.status !== "idle" && w.status !== "queued" ? h("span", { class: "elapsed", title: "Time spent working" }, icon("clock", { size: 12 }), h("span", { "data-elapsed": w.id }, formatElapsed(workerElapsedMs(state, w)))) : null),
      lines,
    ),
  );
  return b;
}
