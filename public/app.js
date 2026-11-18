// Agent Arcade browser app: boots the SDK, owns shared UI state and wires the panels together.
// Rendering is requestAnimationFrame-throttled and each panel only rebuilds the parts whose inputs changed.
import { connectArcade, createReplay } from "/shared/client.js";
import { openInbox, ROLES, WORKER_STATUSES } from "/shared/state.js";
import { h, truncate, pluralize } from "./panels/util.js";
import { icon } from "./panels/icons.js";
import { createToaster, confirmDialog } from "./panels/dialogs.js";
import { STATUS_META, ROLE_LABELS, announcementFor, interruptRules } from "./panels/model.js";
import { currentItem, moveCursor, primaryFor, denyFor, runAction } from "./panels/actions.js";
import { createTopbar } from "./panels/topbar.js";
import { createBanners } from "./panels/banners.js";
import { createComposer } from "./panels/composer.js";
import { createStage } from "./panels/stage.js";
import { createOrders } from "./panels/orders.js";
import { createInbox } from "./panels/inbox.js";
import { createInspector } from "./panels/inspector.js";
import { createReview } from "./panels/review.js";
import { createSuggest } from "./panels/suggest.js";
import { createTimeline, openPastRuns } from "./panels/timeline.js";
import { openPalette } from "./panels/palette.js";
import { openHelp } from "./panels/help.js";

const BOOT_QUIET_MS = 2500;
const narrowMq = window.matchMedia("(max-width: 759px)");
const wideMq = window.matchMedia("(min-width: 1200px)");
const motionMq = window.matchMedia("(prefers-reduced-motion: reduce)");
const bootAt = performance.now();

const root = document.getElementById("app");
const toast = createToaster(document.getElementById("toasts"));
const announcer = document.getElementById("announcer");

function announce(message) {
  if (!message) return;
  announcer.textContent = "";
  setTimeout(() => {
    announcer.textContent = message;
  }, 40);
}

// ---------------------------------------------------------------------------------------------------
// boot

async function boot() {
  const param = new URLSearchParams(location.search).get("source");
  const explicit = param === "demo" || param === "live" || param === "replay" ? param : null;
  let arcade;
  try {
    arcade = await connectArcade({ source: explicit === "demo" || explicit === "live" ? explicit : "auto" });
  } catch (err) {
    return showProblem(err);
  }
  if (arcade.needsToken && !explicit) {
    arcade.close?.();
    return showNeedsToken();
  }
  start(arcade, { openRuns: explicit === "replay" });
}

function screen(...kids) {
  root.dataset.mode = "screen";
  root.replaceChildren(h("main", { class: "screen", id: "main", tabindex: "-1" }, h("div", { class: "screen-card" }, h("p", { class: "brand-line" }, icon("spark", { size: 20 }), h("strong", {}, "Agent Arcade")), kids)));
  document.getElementById("main").focus();
}

function showNeedsToken() {
  screen(
    h("h1", {}, "Open the link from your terminal"),
    h("p", {}, "A real Arcade server is running here, but this page doesn't have its access token. The link it printed in your terminal when it started includes the token. Open that link and you're in."),
    h("p", { class: "muted" }, "Lost it? Stop the server and start it again to get a fresh link. Nothing runs without it."),
    h("div", { class: "dlg-actions" }, h("button", { type: "button", class: "btn btn-primary", onClick: () => { location.search = "?source=demo"; } }, icon("play", { size: 16 }), h("span", { class: "btn-label" }, "Try the demo instead"))),
    h("p", { class: "muted small" }, "The demo is scripted and runs entirely in this browser tab."),
  );
}

function showProblem(err) {
  screen(
    h("h1", {}, "Couldn't start Agent Arcade"),
    h("p", {}, err?.message ?? "Something went wrong while connecting."),
    h("div", { class: "dlg-actions" }, h("button", { type: "button", class: "btn btn-primary", onClick: () => { location.search = "?source=demo"; } }, "Try the demo"), h("button", { type: "button", class: "btn btn-default", onClick: () => location.reload() }, "Reload")),
  );
}

// ---------------------------------------------------------------------------------------------------
// the app object that every panel receives

function start(base, { openRuns = false } = {}) {
  let current = base;
  let unsub = null;
  let raf = 0;
  let lastRev = -1;
  let lastEpoch = -1;
  let lastState = null;
  let seenInbox = null;
  let labels = { roles: ROLE_LABELS, statuses: Object.fromEntries(Object.entries(STATUS_META).map(([k, v]) => [k, v.label])) };

  const ui = {
    epoch: 0,
    drafts: new Map(),
    open: new Set(),
    openSeen: new Set(),
    editing: new Set(),
    addingOrder: false,
    pendingFocus: null,
    selectedId: null,
    cursorId: null,
    readOnly: false,
    replay: false,
    replayLabel: "",
    moreOpen: false,
    pop: null,
    speed: 1,
    soundOn: false,
    tab: "stage",
    baseSource: base.source,
  };

  const app = {
    ui,
    toast,
    announce,
    confirm: confirmDialog,
    studio: null,
    studioProblem: "",
    get arcade() { return current; },
    get baseArcade() { return base; },
    get state() { return current.getState(); },
    get labels() { return labels; },
    reducedMotion: () => motionMq.matches,
    roleLabel: (r) => labels.roles?.[r] ?? ROLE_LABELS[r] ?? String(r),
    statusLabel: (s) => labels.statuses?.[s] ?? STATUS_META[s]?.label ?? String(s).replace(/_/g, " "),
    sound: {
      get available() { return typeof app.studio?.sounds?.setEnabled === "function"; },
    },
  };

  app.forceRender = () => { ui.epoch++; schedule(); };

  app.act = async (name, payload = {}, opts = {}) => {
    if (ui.readOnly) {
      toast("This is a replay, so it is read-only. Use Back to live to steer.", "info");
      return { ok: false, error: "read-only" };
    }
    let r;
    try {
      r = await current.command(name, payload);
    } catch (err) {
      r = { ok: false, error: err?.message ?? "That didn't work." };
    }
    if (!r || r.ok === false) {
      toast(r?.error || "That didn't work. Try again.", "error");
      app.forceRender();
      return r ?? { ok: false };
    }
    if (typeof opts.ok === "string") toast(opts.ok, "ok");
    schedule();
    return r;
  };

  app.avatar = (role, status, size = 40) => {
    const mod = app.studio;
    const r = ROLES.includes(role) ? role : "builder";
    const s = WORKER_STATUSES.includes(status) ? status : "idle";
    if (typeof mod?.characterSvg === "function") {
      const span = h("span", { class: "avatar", "aria-hidden": "true", style: { width: size + "px", height: size + "px" } });
      try {
        // The one permitted innerHTML: SVG markup from the studio module, built from the enum values above only.
        span.innerHTML = mod.characterSvg(r, s, { size });
        return span;
      } catch {
        span.replaceChildren();
      }
    }
    return h("span", { class: "avatar avatar-fallback role-" + r, "aria-hidden": "true", style: { width: size + "px", height: size + "px", "font-size": Math.round(size * 0.42) + "px" } }, (app.roleLabel(r) || "?").slice(0, 1).toUpperCase());
  };

  app.copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied.", "ok");
    } catch {
      toast("Couldn't copy automatically. Select the text and copy it by hand.", "error");
    }
  };

  app.togglePopover = (name) => {
    ui.pop = ui.pop === name ? null : name;
    app.forceRender();
  };

  app.setSpeed = (s) => {
    ui.speed = s;
    base.setSpeed?.(s);
    app.forceRender();
  };

  app.toggleSound = () => {
    const s = app.studio?.sounds;
    if (typeof s?.setEnabled !== "function") return toast("Sounds come with the studio scene, which isn't loaded.", "info");
    const on = !(typeof s.isEnabled === "function" ? s.isEnabled() : ui.soundOn);
    s.setEnabled(on);
    ui.soundOn = on;
    announce(on ? "Sound on." : "Sound off.");
    app.forceRender();
  };

  app.approveBatch = async () => {
    const r = await app.act("approveBatch", {}, { ok: null });
    if (r?.ok) announce("Work orders approved. Agents are starting.");
    return r;
  };

  app.newRun = async () => {
    const live = base.source === "live";
    const ok = await confirmDialog({ title: "Start a new run?", message: live ? "This clears the board so you can set a new goal. Nothing is merged." : "This starts the scripted demo over from the beginning.", confirmLabel: "New run", danger: true });
    if (!ok) return;
    const r = await app.act("reset", {}, { ok: null });
    if (r?.ok) {
      resetUiForNewRun();
      app.focusGoal();
    }
  };

  // ---- navigation -------------------------------------------------------------------------------
  const PANEL_FOR = { stage: "stage", orders: "orders", inbox: "inbox", inspector: "inspector", review: "review" };
  const TAB_FOR = { stage: "stage", orders: "orders", review: "orders", inbox: "inbox", inspector: "inspector" };

  app.goTab = (name) => {
    ui.tab = TAB_FOR[name] ?? "stage";
    root.dataset.tab = ui.tab;
    syncTabbar();
    if (!narrowMq.matches) document.getElementById(PANEL_FOR[name])?.scrollIntoView({ block: "nearest", behavior: motionMq.matches ? "auto" : "smooth" });
    else window.scrollTo({ top: 0, behavior: "auto" });
  };

  app.jumpTo = (name) => {
    app.goTab(name);
    const el = document.getElementById(PANEL_FOR[name] ?? name);
    if (!el) return;
    requestAnimationFrame(() => {
      el.setAttribute("tabindex", "-1");
      el.scrollIntoView({ block: "start", behavior: motionMq.matches ? "auto" : "smooth" });
      el.focus({ preventScroll: true });
    });
  };

  app.select = (id, opts = {}) => {
    const w = id ? app.state.workers[id] : null;
    ui.selectedId = w ? id : null;
    if (w) {
      announce(`Inspecting ${w.name}.`);
      if (narrowMq.matches) {
        if (!opts.stay) app.goTab("inspector");
      } else if (!wideMq.matches) {
        // Two-column layout: the inspector sits below the inbox, so bring it into view.
        requestAnimationFrame(() => document.getElementById("inspector")?.scrollIntoView({ block: "nearest", behavior: motionMq.matches ? "auto" : "smooth" }));
      }
    }
    app.forceRender();
  };

  app.focusGoal = () => {
    app.goTab("stage");
    requestAnimationFrame(() => document.querySelector('[data-fk="cmp:goal"]')?.focus());
  };

  app.openHelp = () => openHelp(app);
  app.openPalette = () => openPalette(app);
  app.openPastRuns = () => openPastRuns(app);

  // ---- replay swap --------------------------------------------------------------------------------
  function attach(arcade) {
    unsub?.();
    current = arcade;
    unsub = arcade.subscribe((state, ev) => {
      if (ev?.type === "snapshot") resetUiForNewRun(false);
      schedule();
    });
  }

  app.startReplay = (events, label) => {
    if (!Array.isArray(events) || !events.length) return toast("There is nothing to replay yet.", "info");
    if (ui.replay) current.close?.();
    const rep = createReplay(events, { speed: 1 });
    ui.replay = true;
    ui.readOnly = true;
    ui.replayLabel = label ?? "";
    resetUiForNewRun(false);
    attach(rep);
    root.dataset.mode = "replay";
    app.goTab("stage");
    rep.replay.play();
    announce("Replay started. Controls are hidden while replaying.");
    app.forceRender();
    refocus('[data-fk="rp:play"]');
  };

  // The control that triggered a swap is removed from the DOM, so hand focus to its natural successor.
  function refocus(selector) {
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected) return;
      document.querySelector(selector)?.focus();
    });
  }

  app.startReplayOfCurrent = () => {
    const events = base.recordEvents?.() ?? structuredClone(base.getState().timeline);
    app.startReplay(events, base.source === "live" ? "this run" : "this demo run");
  };

  app.backToLive = () => {
    current.close?.();
    ui.replay = false;
    ui.readOnly = false;
    ui.replayLabel = "";
    resetUiForNewRun(false);
    attach(base);
    root.dataset.mode = base.source;
    announce("Back to live.");
    app.forceRender();
    refocus('[data-fk="tl:replay"]');
  };

  function resetUiForNewRun(forceRender = true) {
    ui.selectedId = null;
    ui.cursorId = null;
    ui.drafts.clear();
    ui.editing.clear();
    ui.addingOrder = false;
    ui.open.clear();
    ui.openSeen.clear();
    seenInbox = null;
    if (forceRender) app.forceRender();
    else ui.epoch++;
  }

  // ---- layout -----------------------------------------------------------------------------------
  const topbar = createTopbar(app);
  const banners = createBanners(app);
  const composer = createComposer(app);
  const stage = createStage(app);
  const timeline = createTimeline(app);
  const inspector = createInspector(app);
  const orders = createOrders(app);
  const review = createReview(app);
  const inbox = createInbox(app);
  const suggest = createSuggest(app);
  composer.el.dataset.sec = "stage";

  const strip = h("div", { class: "needs-strip", hidden: true });
  const stripText = h("span", { class: "strip-text" });
  const stripBtn = h("button", { type: "button", class: "btn btn-primary btn-sm", onClick: () => app.jumpTo("inbox"), "data-fk": "strip:open" }, h("span", { class: "btn-label" }, "Open"), icon("arrow", { size: 14 }));
  strip.append(icon("bell", { size: 16 }), stripText, stripBtn);

  const main = h("main", { class: "layout", id: "main", tabindex: "-1" },
    h("div", { class: "col col-main" }, composer.el, stage.el, timeline.el),
    h("div", { class: "col-right" }, h("div", { class: "col col-insp" }, inspector.el), h("div", { class: "col col-side" }, inbox.el, orders.el, review.el, suggest.el)),
  );

  const TABS = [["stage", "Stage", "stage"], ["orders", "Orders", "orders"], ["inbox", "Inbox", "inbox"], ["inspector", "Inspector", "inspector"]];
  const tabBadges = {};
  const tabbar = h("nav", { class: "tabbar", "aria-label": "Sections" }, TABS.map(([id, label, ic]) => {
    const badge = h("span", { class: "tab-badge", hidden: true });
    tabBadges[id] = badge;
    return h("button", { type: "button", class: "tab", "data-tab": id, "data-fk": "tab:" + id, onClick: () => app.goTab(id) }, h("span", { class: "tab-ic" }, icon(ic, { size: 20 }), badge), h("span", { class: "tab-label" }, label));
  }));

  function syncTabbar() {
    for (const b of tabbar.querySelectorAll(".tab")) {
      const on = b.dataset.tab === ui.tab;
      b.setAttribute("aria-current", on ? "page" : "false");
      b.classList.toggle("is-active", on);
    }
  }

  root.dataset.mode = base.source;
  root.dataset.tab = ui.tab;
  root.replaceChildren(topbar.el, banners.el, strip, main, tabbar);
  syncTabbar();

  const panels = [["topbar", topbar], ["banners", banners], ["composer", composer], ["stage", stage], ["timeline", timeline], ["inspector", inspector], ["orders", orders], ["review", review], ["inbox", inbox], ["suggest", suggest]];
  const broken = new Set();

  // ---- the render loop ---------------------------------------------------------------------------
  function schedule() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function frame() {
    raf = 0;
    const state = current.getState();
    if (state !== lastState && lastState !== null) resetUiForNewRun(false);
    if (state === lastState && state.rev === lastRev && ui.epoch === lastEpoch) return;
    lastState = state;
    lastRev = state.rev;
    lastEpoch = ui.epoch;

    if (ui.selectedId && !state.workers[ui.selectedId]) ui.selectedId = null;
    const items = syncInbox(state);
    if (ui.cursorId && !items.some((i) => i.id === ui.cursorId)) ui.cursorId = null;

    for (const [name, p] of panels) {
      try {
        p.update(state);
      } catch (err) {
        if (!broken.has(name)) console.error(`[arcade] panel "${name}" failed to update`, err);
        broken.add(name);
      }
    }
    chrome(state, items);
    ui.pendingFocus = null;
  }

  function syncInbox(state) {
    const items = openInbox(state);
    if (seenInbox === null) {
      seenInbox = new Set(items.map((i) => i.id));
      return items;
    }
    const quiet = performance.now() - bootAt < BOOT_QUIET_MS || ui.readOnly;
    const fresh = items.filter((i) => !seenInbox.has(i.id));
    for (const i of items) seenInbox.add(i.id);
    if (!quiet && fresh.length) {
      announce(fresh.map((i) => announcementFor(i, state)).filter(Boolean).join(". "));
    }
    return items;
  }

  function chrome(state, items) {
    const n = items.length;
    document.title = (n ? `(${n}) ` : "") + "Agent Arcade";
    const first = items[0];
    strip.hidden = !n || ui.readOnly;
    if (n) stripText.textContent = n === 1 ? `1 thing needs you: ${truncate(first.summary, 60)}` : `${n} things need you. First: ${truncate(first.summary, 50)}`;
    setBadge(tabBadges.inbox, n, `${pluralize(n, "item")} need you`);
    const proposed = state.batch.status === "proposed" ? 1 : 0;
    setBadge(tabBadges.orders, proposed ? "!" : 0, "Work orders are waiting for approval");
    const open = Object.values(state.reviews).filter((r) => r.status === "open").length;
    if (!proposed) setBadge(tabBadges.orders, open, `${pluralize(open, "review")} waiting`);
  }

  function setBadge(el, value, label) {
    el.hidden = !value;
    el.textContent = value ? String(value) : "";
    el.setAttribute("aria-label", label);
  }

  // ---- keyboard ----------------------------------------------------------------------------------
  const typing = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.getAttribute?.("role") === "combobox");

  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented) return;
    const dialog = document.querySelector("dialog[open]");
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (!dialog) app.openPalette();
      return;
    }
    if (e.key === "Escape" && ui.pop && !dialog) {
      const trigger = ui.pop === "footprint" ? "tb:footprint" : "insp:how";
      ui.pop = null;
      ui.pendingFocus = trigger;
      app.forceRender();
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || dialog || typing(e.target)) return;
    const state = app.state;
    switch (e.key) {
      case "?":
        e.preventDefault();
        app.openHelp();
        break;
      case "j":
      case "k": {
        const item = moveCursor(app, state, e.key === "j" ? 1 : -1);
        if (!item) return announce("Nothing needs you.");
        e.preventDefault();
        if (narrowMq.matches) app.goTab("inbox");
        ui.pendingFocus = "inbox:item:" + item.id;
        app.forceRender();
        break;
      }
      case "a":
      case "d": {
        e.preventDefault();
        if (ui.readOnly) return toast("This is a replay, so it is read-only.", "info");
        const items = openInbox(state);
        if (!items.length) return announce("Nothing needs you.");
        const picked = items.find((i) => i.id === ui.cursorId);
        if (!picked) {
          // The first press only highlights, so nothing is ever approved without being looked at.
          const first = items[0];
          ui.cursorId = first.id;
          if (narrowMq.matches) app.goTab("inbox");
          ui.pendingFocus = "inbox:item:" + first.id;
          app.forceRender();
          const a = primaryFor(app, first);
          announce(`Highlighted: ${first.summary}. ${a ? `Press a to ${a.label.split(":")[0].toLowerCase()}` : "Open it to decide"}${denyFor(app, first) ? ", or d to deny" : ""}.`);
          return;
        }
        const action = e.key === "a" ? primaryFor(app, picked) : denyFor(app, picked);
        if (!action) return toast(e.key === "a" ? "That one needs a closer look. Open it to decide." : "There's no quick \u201cdeny\u201d for that item.", "info");
        runAction(app, action);
        break;
      }
      case "h":
      case "r": {
        const w = state.workers[ui.selectedId];
        if (!w) return toast("Pick an agent first, then press " + e.key + ".", "info");
        if (ui.readOnly) return toast("This is a replay, so it is read-only.", "info");
        const rules = interruptRules(w);
        const reason = e.key === "h" ? rules.hold : rules.resume;
        if (reason) return toast(reason, "info");
        app.act(e.key === "h" ? "hold" : "resume", { workerId: w.id }, { ok: e.key === "h" ? "Hold queued. It stops at the next safe point; see the receipt in the Inspector." : "Resume sent. The agent is re-prompted." });
        break;
      }
      default:
    }
  });

  document.addEventListener("click", (e) => {
    if (!ui.pop) return;
    if (e.target.closest?.("[data-pop], .popover, .pop-trigger")) return;
    ui.pop = null;
    app.forceRender();
  });

  narrowMq.addEventListener("change", () => {
    root.dataset.tab = ui.tab;
    schedule();
  });

  // ---- go ----------------------------------------------------------------------------------------
  attach(base);
  schedule();
  loadStudio();
  if (openRuns) {
    if (base.source === "live") app.openPastRuns();
    else toast("Nothing is recorded yet. Run something, then use Replay this run.", "info");
  }

  async function loadStudio() {
    try {
      const mod = await import("/studio/studio.js");
      app.studio = mod;
      if (mod.labels) labels = { roles: { ...ROLE_LABELS, ...mod.labels.roles }, statuses: { ...labels.statuses, ...mod.labels.statuses } };
      if (typeof mod.sounds?.isEnabled === "function") ui.soundOn = !!mod.sounds.isEnabled();
      app.studioProblem = "";
    } catch (err) {
      app.studio = null;
      app.studioProblem = "The Pocket Studio scene isn't available here, so you get the plain crew list. Everything still works.";
      console.info("[arcade] studio scene not loaded:", err?.message ?? err);
    }
    app.forceRender();
  }

  window.__arcade = app; // handy in the browser console while developing; read-only use
}

boot();
