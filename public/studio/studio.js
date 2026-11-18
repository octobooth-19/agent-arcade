// Pocket Studio: the animated room where the Foreman and the sub-agents work.
//   mountStudio(el, ctx) -> { update(state), destroy() }
// update() diffs each worker against what is already on screen and touches only what changed. There are no timers
// or animation loops in here: all motion is CSS (scene.css), so an idle scene costs almost nothing. Text that comes
// from state (names, titles, steps) only ever goes in through textContent / setAttribute.

import { characterSvg, CHARACTER_ROLES, CHARACTER_STATUSES } from "./characters.js";
import { labels } from "./labels.js";
import { sounds } from "./sounds.js";
import { layoutDesks, nextInDirection, MAX_DESKS } from "./layout.js";
import { deskBackSvg, deskFrontSvg, doorSvg, windowSvg, posterSvg, clockSvg, plantSvg, paperPlaneSvg, statusIconSvg } from "./furniture.js";

export { characterSvg, sounds, labels, layoutDesks };

const MIN_W = 480;
const MIN_H = 320;
const MAX_FX = 10;
const MAX_PLANES = 3;
const WALK_MS = 1250;
const STEER_SVG =
  `<svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.8" fill="none" stroke="currentColor" stroke-width="1.8"/>` +
  `<circle cx="8" cy="8" r="1.5" fill="currentColor"/><path d="M2.4 8h4.2M9.4 8h4.2M8 9.6v4.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const ARROWS = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
const DECOR_ART = { window: windowSvg, poster: posterSvg, clock: clockSvg };

const clip = (v, max = 160) => {
  const s = v == null ? "" : String(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const px = (n) => `${Math.round(n * 10) / 10}px`;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const knownStatus = (s) => (CHARACTER_STATUSES.includes(s) ? s : "idle");
const knownRole = (r) => (CHARACTER_ROLES.includes(r) ? r : "builder");

const poseCache = new Map();
function poseMarkup(role, status) {
  const key = `${role}|${status}`;
  let m = poseCache.get(key);
  if (!m) {
    m = characterSvg(role, status);
    poseCache.set(key, m);
  }
  return m;
}

/** The app may already link these files; only add what is missing. */
function ensureStyles(doc) {
  try {
    if (!doc || !doc.head || typeof doc.createElement !== "function") return;
    const links = typeof doc.querySelectorAll === "function" ? Array.from(doc.querySelectorAll("link[rel~='stylesheet']")) : [];
    const has = (file) => links.some((l) => (l.getAttribute("href") || "").split("?")[0].endsWith(`studio/${file}`));
    const add = (file) => {
      const link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = new URL(file, import.meta.url).href;
      link.setAttribute("data-pocket-studio", file);
      doc.head.appendChild(link);
    };
    if (!has("scene.css")) add("scene.css");
    const cs = doc.defaultView && typeof doc.defaultView.getComputedStyle === "function" ? doc.defaultView.getComputedStyle(doc.documentElement) : null;
    if (cs && !cs.getPropertyValue("--ink").trim() && !has("tokens.css")) add("tokens.css");
  } catch {
    // Styling is best effort: a missing stylesheet must never break the app.
  }
}

/** How many tiles the done shelf shows: stamped (shipped), pending (open review), held, and a "+n" chip for the rest. */
export function shelfPlan(stamped, pending, held, cap) {
  const total = stamped + pending + held;
  if (total <= cap) return { stamped, pending, held, more: 0 };
  let room = Math.max(0, cap - 2);
  const p = Math.min(pending, room);
  room -= p;
  const h = Math.min(held, room);
  room -= h;
  const s = Math.min(stamped, room);
  return { stamped: s, pending: p, held: h, more: total - s - p - h };
}

export function mountStudio(host, ctx = {}) {
  const doc = host.ownerDocument || globalThis.document;
  const win = (doc && doc.defaultView) || globalThis;
  ensureStyles(doc);

  const mk = (tag, cls, parent) => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  };
  const setClass = (e, cls, on) => (on ? e.classList.add(cls) : e.classList.remove(cls));

  let destroyed = false;
  let reduced = false;
  let paused = false;
  let visible = true;
  let baseline = false; // the first update only records what is on screen; effects start after it
  let lastState = null;
  let layout = null;
  let layoutKey = "";
  let orderKey = "";
  let shownSel = null;
  let fxLive = 0;
  let door = { key: null, list: [] };
  let shelfState = { key: "", text: "", stamped: 0, pending: 0, held: 0, approved: 0, cap: 8 };
  let reviewSeen = new Map();
  let backdropKey = "";
  const desks = new Map();
  const elToDesk = new WeakMap();
  const timers = new Set();

  // ---- skeleton ------------------------------------------------------------------------------------------------------
  const root = mk("div", "ps-root", host);
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", labels.scene);
  setClass(host, "ps-host", true);
  const wall = mk("div", "ps-wall", root);
  const floor = mk("div", "ps-floor", root);
  const rug = mk("div", "ps-rug", root);
  const decorLayer = mk("div", "ps-decor-layer", root);
  const runner = mk("div", "ps-runner", root);

  const doorEl = mk("div", "ps-door", root);
  doorEl.innerHTML = doorSvg();
  doorEl.setAttribute("role", "group");
  const doorSign = mk("div", "ps-door-sign", doorEl);
  doorSign.textContent = labels.stageDoor;
  const doorCount = mk("div", "ps-door-count", doorEl);
  doorCount.hidden = true;

  const shelfEl = mk("div", "ps-shelf", root);
  shelfEl.setAttribute("role", "group");
  const shelfHead = mk("div", "ps-shelf-head", shelfEl);
  shelfHead.textContent = labels.doneShelf;
  shelfHead.setAttribute("aria-hidden", "true");
  const shelfGrid = mk("div", "ps-shelf-grid", shelfEl);
  shelfGrid.setAttribute("aria-hidden", "true");

  const desksEl = mk("div", "ps-desks", root);
  const fxEl = mk("div", "ps-fx", root);
  const tip = mk("div", "ps-tip", root);
  tip.setAttribute("aria-hidden", "true");
  const tipTitle = mk("div", "ps-tip-title", tip);
  const tipL1 = mk("div", "ps-tip-line", tip);
  const tipL2 = mk("div", "ps-tip-line", tip);
  const live = mk("div", "ps-live", root);
  live.setAttribute("role", "status");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  const emptyEl = mk("div", "ps-empty", root);
  emptyEl.textContent = labels.emptyHint;
  emptyEl.hidden = true;

  // ---- timers and effects ------------------------------------------------------------------------------------------
  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!destroyed) fn();
    }, ms);
    timers.add(id);
    return id;
  }
  function cancel(id) {
    if (id != null) {
      clearTimeout(id);
      timers.delete(id);
    }
  }

  const fxNodes = new Set();
  /** Put a short-lived effect element somewhere; it removes itself after ms. Returns false when over budget. */
  function addFx(parent, node, ms, desk) {
    if (fxLive >= MAX_FX) return false;
    parent.appendChild(node);
    fxLive++;
    fxNodes.add(node);
    if (desk) {
      desk.fx++;
      setClass(desk.el, "ps-fxing", true);
    }
    later(() => dropFx(node, desk), ms);
    return true;
  }
  function dropFx(node, desk) {
    if (!fxNodes.delete(node)) return;
    node.remove();
    fxLive--;
    if (desk) {
      desk.fx = Math.max(0, desk.fx - 1);
      if (!desk.fx) setClass(desk.el, "ps-fxing", false);
    }
  }
  function clearFx() {
    for (const node of Array.from(fxNodes)) {
      node.remove();
      fxNodes.delete(node);
    }
    fxLive = 0;
    for (const d of desks.values()) {
      d.fx = 0;
      setClass(d.el, "ps-fxing", false);
      setClass(d.charEl, "ps-shake", false);
      setClass(d.charEl, "ps-hop", false);
    }
  }

  // ---- desks --------------------------------------------------------------------------------------------------------
  function createDesk(id, isLead) {
    const el = mk("div", "ps-desk", desksEl);
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-pressed", "false");
    el.setAttribute("data-id", id);
    const d = { id, isLead, el, v: null, sig: "", status: null, role: null, rect: null, qi: -1, fx: 0, outs: [], pose: null, poseTimer: null, walkTimer: null, disabled: false };
    mk("div", "ps-plate", el);
    d.back = mk("div", "ps-back", el);
    d.charEl = mk("div", "ps-char", el);
    d.charEl.setAttribute("aria-hidden", "true");
    d.front = mk("div", "ps-front", el);
    const lab = mk("div", "ps-labels", el);
    d.nm = mk("div", "ps-nm", lab);
    d.name = mk("span", "ps-name", d.nm);
    d.roleEl = mk("span", "ps-role", d.nm);
    d.batt = mk("span", "ps-batt", lab);
    d.battFill = mk("i", "", d.batt);
    d.batt.hidden = true;
    d.sign = mk("div", "ps-sign", lab);
    d.signT = mk("span", "ps-sign-t", d.sign);
    d.prog = mk("div", "ps-prog", d.sign);
    d.progFill = mk("i", "", d.prog);
    d.prog.hidden = true;
    d.pill = mk("span", "ps-pill", lab);
    d.pillIcon = mk("span", "ps-pill-icon", d.pill);
    d.pillTxt = mk("span", "ps-pill-txt", d.pill);
    d.frac = mk("span", "ps-frac", lab);
    d.frac.hidden = true;
    d.take = mk("div", "ps-takeover", el);
    const tIcon = mk("span", "ps-takeover-icon", d.take);
    tIcon.innerHTML = STEER_SVG;
    mk("span", "ps-takeover-txt-long", d.take).textContent = labels.takeover;
    mk("span", "ps-takeover-txt-short", d.take).textContent = labels.takeoverShort;
    d.take.hidden = true;
    elToDesk.set(el, d);
    for (const child of [d.back, d.charEl, d.front, lab, d.take]) elToDesk.set(child, d);
    desks.set(id, d);
    if (shownSel === id) el.setAttribute("aria-pressed", "true");
    return d;
  }

  function removeDesk(d) {
    cancel(d.poseTimer);
    cancel(d.walkTimer);
    for (const node of Array.from(fxNodes)) {
      if (d.el.contains && d.el.contains(node)) dropFx(node, d);
    }
    d.el.remove();
    desks.delete(d.id);
  }

  function setRoleArt(d, role) {
    d.back.innerHTML = deskBackSvg(role);
    d.front.innerHTML = deskFrontSvg(role, { lead: d.isLead });
    d.el.setAttribute("data-role", role);
  }

  function clearOuts(d) {
    cancel(d.poseTimer);
    d.poseTimer = null;
    for (const o of d.outs) o.remove();
    d.outs.length = 0;
  }

  /** Swap the character's pose; the old pose fades out while the new one pops in. */
  function setPose(d, animate) {
    const markup = poseMarkup(d.role, d.status);
    clearOuts(d);
    if (!d.pose) {
      d.pose = mk("div", "ps-pose", d.charEl);
      d.pose.innerHTML = markup;
      return;
    }
    if (!animate) {
      d.pose.innerHTML = markup;
      d.pose.className = "ps-pose";
      return;
    }
    const old = d.pose;
    old.className = "ps-pose ps-out";
    d.outs.push(old);
    const next = mk("div", "ps-pose ps-in", d.charEl);
    next.innerHTML = markup;
    d.pose = next;
    d.poseTimer = later(() => clearOuts(d), 320);
  }

  function viewOf(state, id, w, isLead) {
    const role = isLead ? "lead" : knownRole(w.role);
    const status = knownStatus(w.status);
    const order = !isLead && w.orderId && state.orders ? state.orders[w.orderId] : null;
    const title = isLead ? clip(state.goal) : clip(order && order.title);
    const ctxInfo = w.context;
    const ctxPct =
      ctxInfo && Number.isFinite(ctxInfo.used) && Number.isFinite(ctxInfo.size) && ctxInfo.size > 0 ? clamp(Math.round((ctxInfo.used / ctxInfo.size) * 100), 0, 100) : -1;
    const plan = Array.isArray(w.plan) ? w.plan : [];
    let planDone = 0;
    for (const s of plan) if (s && s.status === "done") planDone++;
    return {
      role,
      status,
      name: clip(w.name || labels.roles[role], 60),
      now: clip(w.now),
      reason: clip(w.queuedReason),
      title,
      takeover: !!w.takeover,
      ctxPct,
      planDone,
      planTotal: plan.length,
    };
  }

  function sigOf(v) {
    return [v.role, v.status, v.name, v.now, v.reason, v.title, v.takeover ? 1 : 0, v.ctxPct, v.planDone, v.planTotal].join("\u0001");
  }

  function labelFor(d, v) {
    const roleLabel = labels.roles[v.role];
    const parts = [v.name];
    if (v.name !== roleLabel) parts.push(roleLabel);
    parts.push(labels.statuses[v.status]);
    let a = parts.join(", ");
    const detail = v.status === "queued" ? v.reason || v.now : v.now;
    if (detail) a += `: ${detail}`;
    if (v.title) a += `, ${d.isLead ? "goal" : labels.order}: ${v.title}`;
    if (v.takeover) a += `. ${labels.takeover}`;
    if (v.ctxPct >= 0) a += `. ${v.ctxPct}% ${labels.contextUsed}`;
    if (v.planTotal) a += `. ${v.planDone}/${v.planTotal} ${labels.planSteps}`;
    return a;
  }

  /** Writes only the parts of one desk that differ from what it already shows. */
  function applyView(d, v, animate) {
    const o = d.v || {};
    const roleChanged = v.role !== o.role;
    const statusChanged = v.status !== o.status;
    d.role = v.role;
    d.status = v.status;
    if (roleChanged) setRoleArt(d, v.role);
    if (statusChanged) {
      d.el.setAttribute("data-status", v.status);
      d.pillIcon.innerHTML = statusIconSvg(v.status);
      d.pillTxt.textContent = labels.statuses[v.status];
    }
    if (roleChanged || statusChanged) setPose(d, animate && !!d.v);
    if (v.name !== o.name) d.name.textContent = v.name;
    const roleLabel = labels.roles[v.role];
    if (roleChanged || v.name !== o.name) {
      d.roleEl.textContent = roleLabel;
      d.roleEl.hidden = v.name === roleLabel;
    }
    if (v.title !== o.title) {
      d.signT.textContent = v.title || (d.isLead ? labels.noGoal : labels.noOrder);
      d.sign.setAttribute("data-empty", v.title ? "false" : "true");
    }
    if (v.ctxPct !== o.ctxPct) {
      d.batt.hidden = v.ctxPct < 0;
      if (v.ctxPct >= 0) {
        const left = 100 - v.ctxPct;
        d.battFill.style.setProperty("width", `${left}%`);
        d.batt.setAttribute("data-lvl", left >= 35 ? "ok" : left >= 15 ? "low" : "crit");
      }
    }
    if (v.planDone !== o.planDone || v.planTotal !== o.planTotal) {
      const has = v.planTotal > 0;
      d.prog.hidden = !has;
      d.frac.hidden = !has;
      if (has) {
        d.progFill.style.setProperty("width", `${Math.round((v.planDone / v.planTotal) * 100)}%`);
        d.frac.textContent = `${v.planDone}/${v.planTotal}`;
      }
    }
    if (v.takeover !== o.takeover) d.take.hidden = !v.takeover;
    d.el.setAttribute("aria-label", labelFor(d, v));
    d.v = v;
  }

  // ---- layout -------------------------------------------------------------------------------------------------------
  function measure() {
    return {
      w: Math.max(MIN_W, Math.round(root.clientWidth || host.clientWidth || 0)),
      h: Math.max(MIN_H, Math.round(root.clientHeight || host.clientHeight || 0)),
    };
  }

  function box(e, r) {
    e.style.setProperty("left", px(r.x));
    e.style.setProperty("top", px(r.y));
    e.style.setProperty("width", px(r.w));
    e.style.setProperty("height", px(r.h));
  }

  function applyBackdrop(L, ids) {
    setClass(root, "ps-compact", L.compact);
    setClass(root, "ps-tiny", L.tiny);
    root.style.setProperty("--f", px(L.font));
    box(wall, L.wall);
    box(floor, L.floor);
    box(doorEl, L.door);
    doorSign.textContent = L.door.w < 100 ? labels.stageDoorShort : labels.stageDoor;
    box(shelfEl, L.shelf);

    const xs = [L.lead.x];
    const x2 = [L.lead.x + L.lead.w];
    let bottom = L.lead.y + L.lead.h;
    for (const r of L.desks) {
      xs.push(r.x);
      x2.push(r.x + r.w);
      bottom = Math.max(bottom, r.y + r.h);
    }
    const rx = Math.min(...xs) - L.pad * 0.7;
    const ry = L.lead.y - L.pad * 0.3;
    box(rug, { x: rx, y: ry, w: Math.max(...x2) + L.pad * 0.7 - rx, h: Math.min(L.height - ry - 3, bottom + L.pad * 0.5 - ry) });

    const runTop = L.door.y + L.door.h + 2;
    box(runner, { x: L.door.x + L.door.w * 0.2, y: runTop, w: L.door.w * 0.6, h: Math.max(10, L.height - L.pad - runTop) });

    const key = JSON.stringify(L.decor);
    const rects = [L.lead, ...L.desks, L.shelf, L.door];
    const plantKey = `${L.width}x${L.height}|${L.n}|${key}`;
    if (plantKey !== backdropKey) {
      backdropKey = plantKey;
      while (decorLayer.firstChild) decorLayer.removeChild(decorLayer.firstChild);
      for (const dec of L.decor) {
        const art = DECOR_ART[dec.kind];
        if (!art) continue;
        const de = mk("div", "ps-decor", decorLayer);
        box(de, dec);
        de.innerHTML = art();
      }
      const ph = clamp(L.height * 0.17, 32, 96);
      const pw = ph * 0.66;
      const spots = [
        { x: L.width - L.pad - pw, y: L.height - L.pad * 0.4 - ph, w: pw, h: ph },
        { x: L.door.x + L.door.w + L.pad * 0.5, y: L.height - L.pad * 0.4 - ph, w: pw, h: ph },
        { x: L.lead.x - pw - L.pad * 0.8, y: L.lead.y + L.lead.h * 0.35, w: pw, h: ph },
      ];
      let placed = 0;
      for (const sp of spots) {
        if (placed >= 2 || sp.x < 0 || sp.x + sp.w > L.width) continue;
        const pad = 6;
        const probe = { x: sp.x - pad, y: sp.y - pad, w: sp.w + pad * 2, h: sp.h + pad * 2 };
        const hits = rects.some((r) => probe.x < r.x + r.w && r.x < probe.x + probe.w && probe.y < r.y + r.h && r.y < probe.y + probe.h);
        const hitsQueue = L.queue.slots.slice(0, Math.max(1, L.n)).some((q) => probe.x < q.x + q.size && q.x < probe.x + probe.w && probe.y < q.y + q.size && q.y < probe.y + probe.h);
        if (hits || hitsQueue) continue;
        const pe = mk("div", "ps-plant", decorLayer);
        box(pe, sp);
        pe.innerHTML = plantSvg();
        placed++;
      }
    }
  }

  function placeDesk(d, rect, scale, labelH, z) {
    d.rect = rect;
    box(d.el, rect);
    d.el.style.setProperty("--s", String(Math.round(scale * 1000) / 1000));
    d.el.style.setProperty("--lh", px(labelH));
    d.el.style.setProperty("--z", String(z));
  }

  function placeQueue(d) {
    const L = layout;
    if (d.qi < 0 || !d.rect) return;
    const slot = L.queue.slots[Math.min(d.qi, L.queue.slots.length - 1)];
    const s = d.rect.scale || L.scale;
    d.el.style.setProperty("--qx", px(slot.x - (d.rect.x + 34 * s)));
    d.el.style.setProperty("--qy", px(slot.y - (d.rect.y + 4 * s)));
    d.el.style.setProperty("--qk", String(Math.round((slot.size / (88 * s)) * 1000) / 1000));
    d.el.style.setProperty("--z", String(10 + d.qi));
  }

  // ---- door and shelf -----------------------------------------------------------------------------------------------
  function renderDoor(list) {
    const key = list.map((q) => `${q.name}\u0001${q.reason}`).join("\u0002");
    if (key === door.key) return;
    door.key = key;
    door.list = list;
    const n = list.length;
    doorCount.hidden = n === 0;
    doorCount.textContent = String(n);
    const detail = list.slice(0, 5).map((q) => (q.reason ? `${q.name}: ${q.reason}` : q.name));
    doorEl.setAttribute("aria-label", n ? `${labels.stageDoor}: ${n} ${labels.waiting}. ${detail.join(". ")}` : `${labels.stageDoor}: ${labels.stageDoorEmpty}`);
  }

  function shelfCapacity() {
    const S = layout.shelf;
    const cols = S.w >= 120 ? 4 : S.w >= 84 ? 3 : 2;
    const tileW = (S.w - 30) / cols;
    const head = layout.font * 1.5 + 6;
    const rows = clamp(Math.floor((S.h - head - 22) / (tileW * 1.15 + 4)), 1, 3);
    return { cols, rows, cap: cols * rows };
  }

  function renderShelf(counts, fresh) {
    const g = shelfCapacity();
    const plan = shelfPlan(counts.approved, counts.pending, counts.held, g.cap);
    const key = `${g.cols}|${g.rows}|${plan.stamped}|${plan.pending}|${plan.held}|${plan.more}`;
    const text = `${labels.doneShelf}: ${counts.approved} ${labels.shipped}${counts.pending ? `, ${counts.pending} ${labels.waitingForReview}` : ""}${counts.held ? `, ${counts.held} ${labels.heldReviews}` : ""}`;
    shelfEl.setAttribute("aria-label", text);
    shelfState.text = text;
    shelfHead.textContent = layout.compact || layout.shelf.w < 100 ? labels.shelfShort : labels.doneShelf;
    if (key === shelfState.key && !fresh) return;
    shelfState.key = key;
    shelfGrid.style.setProperty("--cols", String(g.cols));
    shelfGrid.style.setProperty("--rows", String(g.rows));
    while (shelfGrid.firstChild) shelfGrid.removeChild(shelfGrid.firstChild);
    const tile = (kind) => {
      const t = mk("div", "ps-tile", shelfGrid);
      t.setAttribute("data-kind", kind);
      return t;
    };
    for (let i = 0; i < plan.stamped; i++) {
      const t = tile("stamped");
      if (fresh && i === plan.stamped - 1) t.className = "ps-tile ps-fresh";
    }
    for (let i = 0; i < plan.pending; i++) tile("pending");
    for (let i = 0; i < plan.held; i++) tile("held");
    if (plan.more) mk("div", "ps-tile-more", shelfGrid).textContent = `+${plan.more}`;
    const used = plan.stamped + plan.pending + plan.held + (plan.more ? 2 : 0);
    for (let i = used; i < g.cap; i++) tile("empty");
  }

  // ---- tooltip ------------------------------------------------------------------------------------------------------
  function placeTip(anchor) {
    const W = layout ? layout.width : root.clientWidth;
    const H = layout ? layout.height : root.clientHeight;
    const tw = tip.offsetWidth || 200;
    const th = tip.offsetHeight || 60;
    let x = clamp(anchor.x + anchor.w / 2 - tw / 2, 4, Math.max(4, W - tw - 4));
    let y = anchor.y - th - 6;
    if (y < 4) y = Math.min(anchor.y + anchor.h + 6, Math.max(4, H - th - 4));
    tip.style.setProperty("left", px(x));
    tip.style.setProperty("top", px(y));
  }

  function showTip(title, l1, l2, anchor) {
    tipTitle.textContent = title;
    tipL1.textContent = l1 || "";
    tipL1.hidden = !l1;
    tipL2.textContent = l2 || "";
    tipL2.hidden = !l2;
    placeTip(anchor);
    setClass(tip, "ps-show", true);
  }

  function hideTip() {
    setClass(tip, "ps-show", false);
  }

  function showDeskTip(d) {
    const v = d.v;
    if (!v || !d.rect) return;
    const roleLabel = labels.roles[v.role];
    const title = v.name === roleLabel ? v.name : `${v.name} · ${roleLabel}`;
    const detail = v.status === "queued" ? v.reason || v.now : v.now;
    const l1 = detail ? `${labels.statuses[v.status]}: ${detail}` : labels.statuses[v.status];
    const l2 = [v.title ? `${d.isLead ? "Goal" : "Order"}: ${v.title}` : "", v.takeover ? labels.takeover : ""].filter(Boolean).join("\n");
    let anchor = d.rect;
    if (v.status === "queued" && d.qi >= 0 && layout) {
      const slot = layout.queue.slots[Math.min(d.qi, layout.queue.slots.length - 1)];
      anchor = { x: slot.x, y: slot.y, w: slot.size, h: slot.size };
    }
    showTip(title, l1, l2, anchor);
  }

  function showDoorTip() {
    if (!layout) return;
    const list = door.list;
    const lines = list.slice(0, 5).map((q) => (q.reason ? `${q.name}: ${q.reason}` : q.name));
    if (list.length > 5) lines.push(`+${list.length - 5} ${labels.andMore}`);
    showTip(labels.stageDoor, list.length ? lines.join("\n") : labels.stageDoorEmpty, "", layout.door);
  }

  function showShelfTip() {
    if (!layout) return;
    showTip(labels.doneShelf, (shelfState.text || "").replace(`${labels.doneShelf}: `, ""), "", layout.shelf);
  }

  // ---- effects ------------------------------------------------------------------------------------------------------
  function planeTo(desk, delay) {
    if (reduced || !layout) return;
    const L = layout;
    const from = { x: L.lead.x + L.lead.w * 0.5, y: L.lead.y + L.lead.artH * 0.3 };
    let to;
    if (desk.status === "queued" && desk.qi >= 0) {
      const slot = L.queue.slots[Math.min(desk.qi, L.queue.slots.length - 1)];
      to = { x: slot.x + slot.size / 2, y: slot.y + slot.size * 0.4 };
    } else {
      to = { x: desk.rect.x + desk.rect.w / 2, y: desk.rect.y + desk.rect.artH * 0.4 };
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    later(() => {
      if (reduced) return;
      const plane = mk("div", "ps-plane");
      const arc = mk("div", "ps-plane-arc", plane);
      arc.innerHTML = paperPlaneSvg();
      const dur = clamp(0.7 + dist / 900, 0.8, 1.5);
      plane.style.setProperty("--x0", px(from.x));
      plane.style.setProperty("--y0", px(from.y));
      plane.style.setProperty("--x1", px(to.x));
      plane.style.setProperty("--y1", px(to.y));
      plane.style.setProperty("--dur", `${dur.toFixed(2)}s`);
      plane.style.setProperty("--arc", px(-Math.min(46, dist * 0.22 + 10)));
      plane.style.setProperty("--rot", `${Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 14)}deg`);
      plane.style.setProperty("--ps", String(Math.round(clamp(L.scale * 1.15, 0.6, 1.4) * 100) / 100));
      addFx(fxEl, plane, dur * 1000 + 150);
    }, delay);
  }

  function stampOn(desk, text, tone) {
    const st = mk("div", "ps-stamp");
    st.textContent = text;
    if (tone) st.setAttribute("data-tone", tone);
    addFx(desk.el, st, reduced ? 1800 : 1900, desk);
  }

  function shakeOn(desk, sparks) {
    if (reduced) return;
    setClass(desk.charEl, "ps-shake", true);
    later(() => setClass(desk.charEl, "ps-shake", false), 650);
    if (!sparks) return;
    const box = mk("div", "ps-sparks");
    const spread = [[-22, -20], [20, -24], [-30, 2], [28, -4], [-8, -32], [10, -34]];
    for (const [sx, sy] of spread) {
      const i = mk("i", "", box);
      i.style.setProperty("--sx", `${sx}px`);
      i.style.setProperty("--sy", `${sy}px`);
    }
    addFx(desk.el, box, 900, desk);
  }

  function rippleOn(desk) {
    if (reduced) return;
    addFx(desk.el, mk("div", "ps-ripple"), 2400, desk);
  }

  function hopOn(desk) {
    if (reduced) return;
    setClass(desk.charEl, "ps-hop", true);
    later(() => setClass(desk.charEl, "ps-hop", false), 550);
  }

  function walk(d) {
    if (reduced) return;
    setClass(d.el, "ps-walking", true);
    cancel(d.walkTimer);
    d.walkTimer = later(() => setClass(d.el, "ps-walking", false), WALK_MS);
  }

  // ---- update -------------------------------------------------------------------------------------------------------
  function syncMotion() {
    const media = win && typeof win.matchMedia === "function" ? win.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const r = !!ctx.reducedMotion || !!(media && media.matches);
    if (r !== reduced) {
      reduced = r;
      setClass(root, "ps-reduced", r);
      if (r) clearFx();
    }
  }

  function syncPaused() {
    const p = !!(doc && doc.hidden) || !visible;
    if (p !== paused) {
      paused = p;
      setClass(root, "ps-paused", p);
    }
  }

  function syncSelection() {
    let id = null;
    try {
      id = typeof ctx.selectedId === "function" ? ctx.selectedId() : null;
    } catch {
      id = null;
    }
    if (id === undefined) id = null;
    if (id === shownSel) return;
    const old = shownSel != null ? desks.get(shownSel) : null;
    if (old) old.el.setAttribute("aria-pressed", "false");
    shownSel = id;
    const now = id != null ? desks.get(id) : null;
    if (now) now.el.setAttribute("aria-pressed", "true");
  }

  function update(state) {
    if (destroyed) return;
    const st = state || (typeof ctx.getState === "function" ? ctx.getState() : null);
    if (!st || typeof st !== "object" || !st.workers) return;
    lastState = st;
    syncMotion();
    syncPaused();

    const workers = st.workers;
    const order = Array.isArray(st.workerOrder) ? st.workerOrder : Object.keys(workers);
    let leadId = null;
    const ids = [];
    for (const id of order) {
      const w = workers[id];
      if (!w) continue;
      if (w.role === "lead" && leadId === null) leadId = id;
      else if (ids.length < MAX_DESKS) ids.push(id);
    }
    const leadKey = leadId ?? "lead";
    const wanted = new Set([leadKey, ...ids]);
    for (const d of Array.from(desks.values())) if (!wanted.has(d.id)) removeDesk(d);

    const fresh = [];
    for (const id of [leadKey, ...ids]) {
      if (!desks.has(id)) fresh.push(createDesk(id, id === leadKey));
    }
    const nextOrder = [leadKey, ...ids].join("\u0001");
    // New desks are appended in order already; only a reshuffle of existing workers needs the DOM re-ordered.
    if (orderKey && nextOrder !== orderKey) for (const id of [leadKey, ...ids]) desksEl.appendChild(desks.get(id).el);

    // layout
    const size = measure();
    const lk = `${ids.length}|${size.w}|${size.h}`;
    const relaid = lk !== layoutKey || nextOrder !== orderKey;
    if (lk !== layoutKey) {
      layoutKey = lk;
      layout = layoutDesks(ids.length, size.w, size.h);
    }
    orderKey = nextOrder;
    if (relaid) {
      applyBackdrop(layout, ids.length);
      const lead = desks.get(leadKey);
      placeDesk(lead, layout.lead, layout.lead.scale, layout.lead.labelH, 2);
      ids.forEach((id, i) => {
        const r = layout.desks[i];
        placeDesk(desks.get(id), r, r.scale, r.labelH, 3 + r.row);
      });
    }

    // per-worker diff
    const events = [];
    let queueIndex = 0;
    const queuedList = [];
    const seq = [leadKey, ...ids];
    for (const id of seq) {
      const d = desks.get(id);
      const isLead = id === leadKey;
      const w = isLead && leadId === null ? { name: labels.roles.lead, role: "lead", status: "idle" } : workers[id];
      const v = viewOf(st, id, w, isLead);
      const prev = d.status;
      const isNew = prev === null;
      const disabled = isLead && leadId === null;
      d.disabled = disabled;
      const sig = sigOf(v) + (disabled ? "\u0001x" : "");
      if (sig !== d.sig) {
        d.sig = sig;
        applyView(d, v, baseline && !reduced);
        d.el.setAttribute("aria-disabled", disabled ? "true" : "false");
        if (disabled) d.el.setAttribute("aria-label", `${labels.roles.lead}: ${labels.noGoal}`);
      }

      let qi = -1;
      if (v.status === "queued" && !isLead) {
        qi = queueIndex++;
        queuedList.push({ name: v.name, reason: v.reason || v.now });
      }
      const qChanged = qi !== d.qi;
      d.qi = qi;
      if (qi >= 0 && (qChanged || relaid)) placeQueue(d);
      if (qi < 0 && qChanged && d.rect && !relaid) d.el.style.setProperty("--z", String(isLead ? 2 : 3 + d.rect.row));

      if (!baseline) continue;
      const was = isNew ? null : prev;
      if (was !== v.status) {
        if (was !== null && (was === "queued" || v.status === "queued")) walk(d);
        events.push({ d, was, now: v.status, isNew, name: v.name });
      }
    }
    renderDoor(queuedList);

    // reviews and the done shelf
    const nextReviews = new Map();
    const counts = { approved: 0, pending: 0, held: 0 };
    const newlyApproved = [];
    const reviews = st.reviews && typeof st.reviews === "object" ? st.reviews : {};
    for (const rid of Object.keys(reviews)) {
      const r = reviews[rid];
      if (!r) continue;
      nextReviews.set(rid, r.status);
      if (r.status === "approved") counts.approved++;
      else if (r.status === "open") counts.pending++;
      else if (r.status === "held") counts.held++;
      if (baseline && r.status === "approved" && reviewSeen.get(rid) !== "approved") newlyApproved.push(r);
    }
    const shipped = st.stats && Number.isFinite(st.stats.shipped) ? st.stats.shipped : 0;
    counts.approved = Math.max(counts.approved, shipped);
    reviewSeen = nextReviews;
    renderShelf(counts, newlyApproved.length > 0 && !reduced);
    emptyEl.hidden = ids.length > 0;

    if (baseline) runEffects(events, newlyApproved);
    baseline = true;
    syncSelection();
  }

  function runEffects(events, approved) {
    const once = new Set();
    const play = (name) => {
      if (once.has(name)) return;
      once.add(name);
      sounds.play(name);
    };
    const stamped = new Set();
    const notes = [];
    let planes = 0;
    for (const e of events) {
      const { d, was, now, isNew } = e;
      const starts = now === "working" && (was === "queued" || was === "idle" || was === null);
      if ((isNew || starts || (was === "queued" && now !== "queued")) && !d.isLead && planes < MAX_PLANES) {
        planeTo(d, planes * 140);
        planes++;
        play("dispatch");
        if (isNew) notes.push(`${e.name} ${labels.startedAnnounce}`);
      }
      if (now === "waiting_approval") {
        rippleOn(d);
        play("approval");
        notes.push(`${e.name} ${labels.needsOkAnnounce}`);
      } else if (now === "blocked") {
        shakeOn(d, true);
        play("blocked");
        notes.push(`${e.name} ${labels.stuckAnnounce}`);
      } else if (now === "failed") {
        shakeOn(d, false);
        play("blocked");
        notes.push(`${e.name} ${labels.failedAnnounce}`);
      } else if (now === "done") {
        stampOn(d, labels.statuses.done.toUpperCase());
        stamped.add(d.id);
        hopOn(d);
        play("stamp");
        notes.push(`${e.name} ${labels.doneAnnounce}`);
      }
    }
    for (const r of approved) {
      const d = desks.get(r.workerId);
      if (d && !stamped.has(d.id)) {
        stampOn(d, labels.approved.toUpperCase());
        stamped.add(d.id);
      }
      play("stamp");
    }
    if (notes.length) live.textContent = notes.slice(0, 3).join(". ");
  }

  // ---- input --------------------------------------------------------------------------------------------------------
  function deskFromTarget(target) {
    let n = target;
    while (n && n !== root) {
      const d = elToDesk.get(n);
      if (d) return d;
      n = n.parentNode;
    }
    return null;
  }

  function within(target, node) {
    let n = target;
    while (n && n !== root) {
      if (n === node) return true;
      n = n.parentNode;
    }
    return false;
  }

  function selectedNow() {
    try {
      return typeof ctx.selectedId === "function" ? (ctx.selectedId() ?? null) : null;
    } catch {
      return null;
    }
  }

  function choose(d) {
    if (d.disabled || typeof ctx.select !== "function") return;
    ctx.select(selectedNow() === d.id ? null : d.id);
    syncSelection();
    later(syncSelection, 0);
  }

  function clearSelection() {
    if (typeof ctx.select === "function" && selectedNow() != null) {
      ctx.select(null);
      syncSelection();
      later(syncSelection, 0);
    }
  }

  function focusDesk(id) {
    const d = desks.get(id);
    if (d) d.el.focus();
  }

  function onClick(e) {
    const d = deskFromTarget(e.target);
    if (d) choose(d);
    else clearSelection();
  }

  function onKeydown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === "Escape") {
      hideTip();
      clearSelection();
      return;
    }
    const d = deskFromTarget(e.target);
    if (!d) return;
    if (k === "Enter" || k === " " || k === "Spacebar") {
      e.preventDefault();
      choose(d);
      return;
    }
    const seq = Array.from(desks.values()).filter((x) => x.rect);
    if (k === "Home" || k === "End") {
      e.preventDefault();
      const t = k === "Home" ? seq[0] : seq[seq.length - 1];
      if (t) focusDesk(t.id);
      return;
    }
    const dir = ARROWS[k];
    if (!dir) return;
    e.preventDefault();
    const items = seq.map((x) => ({ id: x.id, x: x.rect.x, y: x.rect.y, w: x.rect.w, h: x.rect.h }));
    let target = nextInDirection(items, d.id, dir);
    if (!target && (dir === "left" || dir === "right")) {
      const i = seq.indexOf(d) + (dir === "right" ? 1 : -1);
      if (seq[i]) target = seq[i].id;
    }
    if (target) focusDesk(target);
  }

  function onOver(e) {
    if (e.pointerType === "touch") return;
    syncSelection();
    const d = deskFromTarget(e.target);
    if (d) showDeskTip(d);
    else if (within(e.target, doorEl)) showDoorTip();
    else if (within(e.target, shelfEl)) showShelfTip();
    else hideTip();
  }

  function onFocusIn(e) {
    syncSelection();
    const d = deskFromTarget(e.target);
    if (!d) return;
    let keyboard = false;
    try {
      keyboard = !!(e.target.matches && e.target.matches(":focus-visible"));
    } catch {
      keyboard = false;
    }
    if (keyboard) showDeskTip(d);
  }

  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onKeydown);
  root.addEventListener("pointerover", onOver);
  root.addEventListener("pointerleave", hideTip);
  root.addEventListener("focusin", onFocusIn);
  root.addEventListener("focusout", hideTip);

  // ---- environment: size, visibility, reduced motion ------------------------------------------------------------------
  const onResize = () => {
    if (destroyed || !lastState) return;
    const s = measure();
    if (`${(layout && layout.n) || 0}|${s.w}|${s.h}` !== layoutKey) update(lastState);
  };
  let ro = null;
  if (typeof win.ResizeObserver === "function") {
    ro = new win.ResizeObserver(onResize);
    ro.observe(root);
  } else if (typeof win.addEventListener === "function") {
    win.addEventListener("resize", onResize);
  }
  let io = null;
  if (typeof win.IntersectionObserver === "function") {
    io = new win.IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) {
        visible = last.isIntersecting;
        syncPaused();
      }
    });
    io.observe(root);
  }
  const onVisibility = () => syncPaused();
  if (doc && typeof doc.addEventListener === "function") doc.addEventListener("visibilitychange", onVisibility);
  let media = null;
  const onMedia = () => {
    syncMotion();
    if (lastState) update(lastState);
  };
  if (win && typeof win.matchMedia === "function") {
    media = win.matchMedia("(prefers-reduced-motion: reduce)");
    if (media && typeof media.addEventListener === "function") media.addEventListener("change", onMedia);
  }
  syncMotion();
  syncPaused();

  if (typeof ctx.getState === "function") {
    const first = ctx.getState();
    if (first) update(first);
  }

  return {
    update,
    /** Optional: re-read ctx.selectedId() when selection changed somewhere else and no state update follows. */
    sync: syncSelection,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onKeydown);
      root.removeEventListener("pointerover", onOver);
      root.removeEventListener("pointerleave", hideTip);
      root.removeEventListener("focusin", onFocusIn);
      root.removeEventListener("focusout", hideTip);
      if (ro) ro.disconnect();
      else if (typeof win.removeEventListener === "function") win.removeEventListener("resize", onResize);
      if (io) io.disconnect();
      if (doc && typeof doc.removeEventListener === "function") doc.removeEventListener("visibilitychange", onVisibility);
      if (media && typeof media.removeEventListener === "function") media.removeEventListener("change", onMedia);
      desks.clear();
      fxNodes.clear();
      root.remove();
      setClass(host, "ps-host", false);
    },
  };
}
