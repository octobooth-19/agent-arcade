// Pocket Studio preview: mounts the scene with the scripted demo or with hand-set states, and exposes a debug panel.
// Useful URL flags: ?mode=manual&n=5&all=waiting_approval&theme=dark&reduced=1&size=900x600&gray=1
import { mountStudio, characterSvg, sounds, labels } from "./studio.js";
import { connectArcade } from "/shared/client.js";
import { createInitialState, newWorker, WORKER_STATUSES } from "/shared/state.js";

const params = new URLSearchParams(location.search);
const ROLES = ["lead", "planner", "builder", "checker"];
const SIZES = [["fill", "Fill the page"], ["480x320", "480 × 320"], ["900x600", "900 × 600"], ["1440x900", "1440 × 900"]];
const CAST = [
  { name: "Rivet", role: "builder", title: "Add theme tokens", now: "Adding the toggle button" },
  { name: "Pip", role: "planner", title: "Plan the settings page", now: "Mapping the files that change" },
  { name: "Tally", role: "checker", title: "Check the theme toggle", now: "Running the checks" },
  { name: "Nova", role: "builder", title: "Wire the toggle into settings with a deliberately long order title that must truncate", now: "Editing settings.js" },
  { name: "Dot", role: "builder", title: "Write the dark palette", now: "Choosing contrast colors" },
  { name: "Spark", role: "checker", title: "Review the new tokens", now: "Reading the diff" },
  { name: "Pebble", role: "planner", title: "Plan the follow-up", now: "Listing the next steps" },
];
const DEFAULT_STATUS = ["working", "working", "waiting_approval", "blocked", "queued", "queued", "done"];

const $ = (sel) => document.querySelector(sel);
const stage = $("#stage");
const panel = $("#panel");
const note = $("#stage-note");

const view = {
  mode: params.get("mode") === "manual" ? "manual" : "demo",
  reduced: params.get("reduced") === "1",
  theme: params.get("theme") || "system",
  size: params.get("size") || "fill",
  gray: params.get("gray") === "1",
  count: Math.min(7, Math.max(1, Number(params.get("n")) || 5)),
  shipped: Number(params.get("shipped")) || 0,
};
const manual = {
  leadStatus: "idle",
  workers: CAST.map((c, i) => ({ ...c, status: DEFAULT_STATUS[i], takeover: false, ctx: -1, planDone: 1, planTotal: 3, reason: "Waiting for a free desk" })),
};
const forced = params.get("all");
if (forced && WORKER_STATUSES.includes(forced)) for (const w of manual.workers) w.status = forced;

let selected = null;
let arcade = null;
let unsubscribe = null;
let studio = null;
let current = null;
const log = [];

const ctx = {
  getState: () => current,
  select(id) {
    selected = id;
    addLog(id ? `select(${id})` : "select(null)");
    studio?.sync?.();
    refreshReadout();
  },
  selectedId: () => selected,
  command(name, payload) {
    addLog(`command(${name})`);
    return arcade?.command ? arcade.command(name, payload) : Promise.resolve({ ok: false, error: "No demo running" });
  },
  get reducedMotion() {
    return view.reduced;
  },
};

// ---- small DOM helper (all text via textContent) ------------------------------------------------------------------------
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "text") e.textContent = v;
    else if (k in e && k !== "list") e[k] = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid);
  return e;
}
const card = (title, ...kids) => h("section", { class: "pv-card" }, h("h2", { text: title }), ...kids);
const row = (...kids) => h("div", { class: "pv-row" }, ...kids);
const check = (text, checked, onChange) => h("label", {}, h("input", { type: "checkbox", checked, onchange: (e) => onChange(e.target.checked) }), text);
const select = (options, value, onChange, aria) =>
  h("select", { "aria-label": aria, onchange: (e) => onChange(e.target.value) }, options.map(([v, t]) => h("option", { value: v, text: t, selected: v === value })));

function addLog(text) {
  log.unshift(`${new Date().toLocaleTimeString([], { hour12: false })} ${text}`);
  if (log.length > 30) log.length = 30;
  const ul = $("#pv-log");
  if (!ul) return;
  ul.replaceChildren(...log.map((t) => h("li", { text: t })));
}

// ---- manual state ---------------------------------------------------------------------------------------------------------
function manualState() {
  const st = createInitialState();
  st.connection = { state: "ready", message: "" };
  st.goal = "Preview";
  st.maxConcurrent = 3;
  st.workers.lead = newWorker({ id: "lead", role: "lead", name: labels.roles.lead, status: manual.leadStatus, now: manual.leadStatus === "working" ? "Reviewing the plan" : "Waiting for a goal" });
  st.workerOrder.push("lead");
  const reviews = {};
  manual.workers.slice(0, view.count).forEach((c, i) => {
    const id = `w${i + 1}`;
    const orderId = `o${i + 1}`;
    st.orders[orderId] = { id: orderId, title: c.title, status: "approved", ownerRole: c.role, ownerId: id };
    st.orderOrder.push(orderId);
    const plan = Array.from({ length: c.planTotal }, (_, k) => ({ text: `Step ${k + 1}`, status: k < c.planDone ? "done" : k === c.planDone ? "doing" : "todo" }));
    st.workers[id] = newWorker({
      id,
      role: c.role,
      name: c.name,
      status: c.status,
      orderId,
      now: c.now,
      queuedReason: c.status === "queued" ? c.reason : null,
      plan: c.planTotal > 0 ? plan : [],
      context: c.ctx >= 0 ? { used: Math.round((136000 * c.ctx) / 100), size: 136000 } : null,
      takeover: c.takeover,
    });
    st.workerOrder.push(id);
    if (c.status === "done") reviews[`r${i + 1}`] = { id: `r${i + 1}`, workerId: id, orderId, status: "open" };
  });
  st.reviews = reviews;
  st.stats.shipped = view.shipped;
  st.rev = ++manualRev;
  return st;
}
let manualRev = 0;

function pushManual() {
  current = manualState();
  studio?.update(current);
  refreshReadout();
}

// ---- demo --------------------------------------------------------------------------------------------------------------
async function startDemo() {
  stopDemo();
  arcade = await connectArcade({ source: "demo" });
  unsubscribe = arcade.subscribe((state) => {
    current = state;
    studio?.update(state);
    syncDemoButtons();
  });
}

function stopDemo() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  if (arcade) arcade.close();
  arcade = null;
}

function openItem(map, status) {
  return Object.values(map || {}).find((x) => x.status === status);
}

async function demoCommand(name, payload = {}) {
  const res = await ctx.command(name, payload);
  if (res && res.ok === false) note.textContent = `${name}: ${res.error}`;
  else note.textContent = "";
  syncDemoButtons();
}

const demoButtons = {};
function syncDemoButtons() {
  const st = current;
  if (!st || !demoButtons.delegate) return;
  demoButtons.delegate.disabled = !!st.goal;
  demoButtons.batch.disabled = st.batch?.status !== "proposed";
  demoButtons.approval.disabled = !openItem(st.approvals, "open");
  demoButtons.review.disabled = !openItem(st.reviews, "open");
}

// ---- panel -------------------------------------------------------------------------------------------------------------
function applyView() {
  const root = document.documentElement;
  if (view.theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", view.theme);
  if (view.size === "fill") {
    stage.style.width = "";
    stage.style.height = "";
  } else {
    const [w, hgt] = view.size.split("x").map(Number);
    stage.style.width = `${w}px`;
    stage.style.height = `${hgt}px`;
  }
  const cast = $("#pv-cast");
  if (cast) cast.dataset.gray = view.gray ? "1" : "0";
  studio?.update(current);
}

function buildPanel() {
  const readout = h("div", { id: "pv-readout", class: "pv-kv" });
  const modeBtn = (mode, text) =>
    h("button", {
      type: "button",
      text,
      "aria-pressed": String(view.mode === mode),
      onclick: () => {
        view.mode = mode;
        selected = null;
        switchMode();
      },
    });

  const demoCard = card(
    "Scripted demo",
    row(
      (demoButtons.delegate = h("button", { type: "button", text: "Hand the Foreman a goal", onclick: () => demoCommand("delegate", { goal: "Add a dark-mode toggle to the settings page" }) })),
      (demoButtons.batch = h("button", { type: "button", text: "Approve the work orders", onclick: () => demoCommand("approveBatch") })),
    ),
    row(
      (demoButtons.approval = h("button", { type: "button", text: "Say OK to a waiting worker", onclick: () => {
        const a = openItem(current.approvals, "open");
        if (a) demoCommand("resolveApproval", { approvalId: a.id, optionId: "allow_once" });
      } })),
      (demoButtons.review = h("button", { type: "button", text: "Approve a finished review", onclick: () => {
        const r = openItem(current.reviews, "open");
        if (r) demoCommand("approveReview", { reviewId: r.id });
      } })),
    ),
    row(
      h("button", { type: "button", text: "Start over", onclick: () => demoCommand("reset") }),
      h("label", {}, "Speed ", select([["1", "1×"], ["2", "2×"], ["4", "4×"]], "1", (v) => arcade?.setSpeed(Number(v)), "Demo speed")),
    ),
  );
  demoCard.id = "pv-demo";

  const workerRows = manual.workers.map((c, i) => {
    const box = h("div", { class: "pv-w", "data-i": i });
    const statusOptions = WORKER_STATUSES.map((s) => [s, s]);
    box.append(
      h("b", { text: c.name }),
      select(statusOptions, c.status, (v) => { c.status = v; pushManual(); }, `${c.name} status`),
      select(ROLES.slice(1).map((r) => [r, labels.roles[r]]), c.role, (v) => { c.role = v; pushManual(); }, `${c.name} role`),
      h("div", { class: "pv-sub" },
        check("takeover", c.takeover, (v) => { c.takeover = v; pushManual(); }),
        h("label", {}, "context ", h("input", { type: "range", min: -1, max: 100, value: c.ctx, "aria-label": `${c.name} context percent, below zero hides it`, oninput: (e) => { c.ctx = Number(e.target.value); pushManual(); } })),
        h("label", {}, "plan ", h("input", { type: "number", min: 0, max: 8, value: c.planDone, style: "width:44px", "aria-label": `${c.name} plan steps done`, oninput: (e) => { c.planDone = Math.max(0, Number(e.target.value) || 0); pushManual(); } }),
          "/", h("input", { type: "number", min: 0, max: 8, value: c.planTotal, style: "width:44px", "aria-label": `${c.name} plan steps total`, oninput: (e) => { c.planTotal = Math.max(0, Number(e.target.value) || 0); pushManual(); } })),
      ),
    );
    return box;
  });

  const manualCard = card(
    "Manual states",
    row(
      h("label", {}, "Workers ", h("input", { id: "pv-count", type: "range", min: 1, max: 7, value: view.count, "aria-label": "Worker count", oninput: (e) => { view.count = Number(e.target.value); $("#pv-count-n").textContent = String(view.count); syncWorkerRows(); pushManual(); } })),
      h("b", { id: "pv-count-n", text: String(view.count) }),
    ),
    row(
      h("label", {}, "Foreman ", select(WORKER_STATUSES.map((s) => [s, s]), manual.leadStatus, (v) => { manual.leadStatus = v; pushManual(); }, "Foreman status")),
      h("label", {}, "Shipped ", h("input", { type: "number", min: 0, max: 40, value: view.shipped, style: "width:52px", "aria-label": "Shipped count", oninput: (e) => { view.shipped = Math.max(0, Number(e.target.value) || 0); pushManual(); } })),
    ),
    row(h("span", { text: "Everyone:" }), WORKER_STATUSES.map((s) => h("button", { type: "button", text: s, onclick: () => { for (const w of manual.workers) w.status = s; syncWorkerRows(); pushManual(); } }))),
    h("div", { class: "pv-workers" }, workerRows),
  );
  manualCard.id = "pv-manual";

  const viewCard = card(
    "View",
    row(
      check("Reduced motion", view.reduced, (v) => { view.reduced = v; studio?.update(current); }),
      check("Sound", sounds.isEnabled(), (v) => { sounds.setEnabled(v); }),
    ),
    row(
      h("label", {}, "Theme ", select([["system", "System"], ["light", "Light"], ["dark", "Dark"]], view.theme, (v) => { view.theme = v; applyView(); }, "Theme")),
      h("label", {}, "Size ", select(SIZES, view.size, (v) => { view.size = v; applyView(); }, "Scene size")),
    ),
    row(...["approval", "stamp", "dispatch", "blocked"].map((n) => h("button", { type: "button", text: `♪ ${n}`, onclick: () => sounds.play(n) }))),
  );

  const castCard = card(
    "Cast sheet · 64px",
    row(check("Grayscale", view.gray, (v) => { view.gray = v; applyView(); })),
    buildCast(),
  );

  const logCard = card("Selection and log", readout, h("ul", { id: "pv-log", class: "pv-log" }));

  panel.replaceChildren(
    card("Mode", row(modeBtn("demo", "Scripted demo"), modeBtn("manual", "Manual states"))),
    demoCard,
    manualCard,
    viewCard,
    logCard,
    castCard,
  );
}

function syncWorkerRows() {
  panel.querySelectorAll(".pv-w").forEach((box) => {
    const i = Number(box.dataset.i);
    box.hidden = i >= view.count;
    const c = manual.workers[i];
    const sel = box.querySelectorAll("select");
    if (sel[0]) sel[0].value = c.status;
  });
}

function buildCast() {
  const grid = h("div", { id: "pv-cast", class: "pv-cast", "data-gray": view.gray ? "1" : "0" });
  grid.append(h("span"));
  for (const r of ROLES) grid.append(h("span", { class: "pv-cast-h", text: labels.roles[r] }));
  for (const s of WORKER_STATUSES) {
    grid.append(h("span", { class: "pv-cast-r", text: s.replace("_", " ") }));
    for (const r of ROLES) {
      const cell = h("span", { class: "pv-cast-cell", role: "img", "aria-label": `${labels.roles[r]}, ${labels.statuses[s]}` });
      cell.innerHTML = characterSvg(r, s, { size: 64 });
      grid.append(cell);
    }
  }
  return grid;
}

function refreshReadout() {
  const el = $("#pv-readout");
  if (!el) return;
  const w = selected && current?.workers?.[selected];
  el.textContent = selected ? `selected: ${selected}${w ? ` · ${w.role} · ${w.status}` : ""}` : "selected: nothing";
}

function switchMode() {
  for (const b of panel.querySelectorAll("#panel > section:first-child button")) b.setAttribute("aria-pressed", String(b.textContent.startsWith("Scripted") === (view.mode === "demo")));
  $("#pv-demo").hidden = view.mode !== "demo";
  $("#pv-manual").hidden = view.mode !== "manual";
  if (view.mode === "demo") {
    startDemo();
    note.textContent = "Scripted demo: hand the Foreman a goal, then approve the work orders and the OKs as they come.";
  } else {
    stopDemo();
    note.textContent = "Manual states: every worker can be forced into any status.";
    pushManual();
  }
  refreshReadout();
}

// ---- stress and boot -------------------------------------------------------------------------------------------------------
function countNodes() {
  return stage.querySelectorAll("*").length;
}

function stress(rounds = 2000) {
  const before = countNodes();
  const t0 = performance.now();
  let peak = before;
  for (let i = 0; i < rounds; i++) {
    for (const w of manual.workers) w.status = WORKER_STATUSES[(i + manual.workers.indexOf(w)) % WORKER_STATUSES.length];
    view.count = 1 + (i % 7);
    current = manualState();
    studio.update(current);
    if (i % 50 === 0) peak = Math.max(peak, countNodes());
  }
  const ms = performance.now() - t0;
  return { before, after: countNodes(), peak, rounds, msPerUpdate: Number((ms / rounds).toFixed(3)) };
}

buildPanel();
studio = mountStudio(stage, ctx);
applyView();
switchMode();

window.__preview = {
  studio,
  ctx,
  view,
  manual,
  stress,
  countNodes,
  pushManual,
  setAll(status) {
    for (const w of manual.workers) w.status = status;
    syncWorkerRows();
    pushManual();
  },
  setStatus(i, status) {
    manual.workers[i].status = status;
    syncWorkerRows();
    pushManual();
  },
  setCount(n) {
    view.count = n;
    syncWorkerRows();
    pushManual();
  },
  setMode(mode) {
    view.mode = mode;
    switchMode();
  },
  get state() {
    return current;
  },
  get arcade() {
    return arcade;
  },
};
