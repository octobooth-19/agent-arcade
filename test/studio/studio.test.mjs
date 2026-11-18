import test from "node:test";
import assert from "node:assert/strict";

import { mountStudio, sounds, labels, shelfPlan } from "../../public/studio/studio.js";
import { MAX_DESKS } from "../../public/studio/layout.js";
import { createFakeDom, countNodes, histogram } from "./fake-dom.mjs";

const EVIL = `<img src=x onerror=alert(1)>"'&</script>`;

function makeState(specs, { goal = "Ship the theme toggle", reviews = {}, shipped = 0, lead = true } = {}) {
  const workers = {};
  const orders = {};
  const workerOrder = [];
  if (lead) {
    workers.lead = { id: "lead", role: "lead", name: "Foreman", status: "working", now: "Planning", orderId: null, plan: [], context: null, takeover: false };
    workerOrder.push("lead");
  }
  for (const s of specs) {
    const orderId = s.title ? `o-${s.id}` : null;
    if (orderId) orders[orderId] = { id: orderId, title: s.title };
    workers[s.id] = {
      id: s.id,
      role: s.role ?? "builder",
      name: s.name ?? s.id,
      status: s.status ?? "idle",
      now: s.now ?? "",
      queuedReason: s.reason ?? null,
      orderId,
      plan: s.plan ?? [],
      context: s.context ?? null,
      takeover: !!s.takeover,
    };
    workerOrder.push(s.id);
  }
  return { workers, workerOrder, orders, goal, reviews, stats: { shipped } };
}

const team = (n, status = "idle") => Array.from({ length: n }, (_, i) => ({ id: `w${i + 1}`, name: `Worker ${i + 1}`, status, role: ["planner", "builder", "checker"][i % 3] }));

function setup(t, specs, opts = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = createFakeDom({ observers: opts.observers ?? true, reducedMedia: !!opts.mediaReduced });
  const played = [];
  const original = sounds.play;
  sounds.play = (name) => played.push(name);
  const calls = [];
  const box = { state: makeState(specs, opts.state), selected: opts.selected ?? null };
  const ctx = {
    getState: () => box.state,
    select: (id) => {
      calls.push(id);
      box.selected = id;
    },
    selectedId: () => box.selected,
    command() {},
    reducedMotion: !!opts.reduced,
  };
  const studio = mountStudio(dom.host, ctx);
  t.after(() => {
    studio.destroy();
    sounds.play = original;
  });
  const desk = (id) => dom.host.find((n) => n.classes.has("ps-desk") && n.getAttribute("data-id") === id)[0];
  const push = (specs2, o2 = {}) => {
    box.state = makeState(specs2, { ...opts.state, ...o2 });
    studio.update(box.state);
  };
  // Node's mock clock does not run timers that a firing timer schedules inside the same tick, so advance in small steps.
  const tick = (ms) => {
    for (let left = ms; left > 0; left -= 50) t.mock.timers.tick(Math.min(50, left));
  };
  return { ...dom, studio, ctx, calls, played, box, desk, push, tick, desks: () => dom.host.find((n) => n.classes.has("ps-desk")) };
}

test("mounts a lead desk plus one focusable button per worker with a full accessible label", (t) => {
  const s = setup(t, [
    { id: "w1", name: "Rivet", role: "builder", status: "working", now: "Adding the toggle button", title: "Add theme tokens" },
    { id: "w2", name: "Pip", role: "planner", status: "waiting_approval", title: "Plan the work" },
  ]);
  assert.equal(s.desks().length, 3);
  for (const d of s.desks()) {
    assert.equal(d.getAttribute("role"), "button");
    assert.equal(d.getAttribute("tabindex"), "0");
    assert.equal(d.getAttribute("aria-pressed"), "false");
  }
  assert.equal(s.desk("w1").getAttribute("aria-label"), "Rivet, Builder, Working: Adding the toggle button, order: Add theme tokens");
  assert.match(s.desk("w2").getAttribute("aria-label"), /^Pip, Planner, Needs your OK/);
  assert.match(s.desk("lead").getAttribute("aria-label"), /^Foreman, Working.*goal: Ship the theme toggle/);
  assert.equal(s.desk("w1").getAttribute("data-status"), "working");
  assert.equal(s.host.byClass("ps-root").length, 1);
});

test("renders 0 to 8 workers and caps the desks at MAX_DESKS", (t) => {
  const s = setup(t, []);
  assert.equal(s.desks().length, 1);
  assert.equal(s.host.byClass("ps-empty")[0].hidden, false);
  for (const n of [1, 3, 7, 8, 0, 5]) {
    s.push(team(n));
    assert.equal(s.desks().length, 1 + n, `n=${n}`);
    assert.equal(s.host.byClass("ps-empty")[0].hidden, n > 0);
  }
  s.push(team(MAX_DESKS + 10));
  assert.equal(s.desks().length, 1 + MAX_DESKS);
});

test("click selects, a second click deselects, Escape deselects, aria-pressed follows", (t) => {
  const s = setup(t, team(3));
  s.desk("w2").fire("click");
  assert.deepEqual(s.calls, ["w2"]);
  assert.equal(s.desk("w2").getAttribute("aria-pressed"), "true");
  assert.equal(s.desk("w1").getAttribute("aria-pressed"), "false");

  s.desk("w3").fire("click");
  assert.deepEqual(s.calls, ["w2", "w3"]);
  assert.equal(s.desk("w2").getAttribute("aria-pressed"), "false");
  assert.equal(s.desk("w3").getAttribute("aria-pressed"), "true");

  s.desk("w3").fire("click");
  assert.equal(s.calls.at(-1), null);
  assert.equal(s.desk("w3").getAttribute("aria-pressed"), "false");

  s.desk("lead").fire("click");
  assert.equal(s.calls.at(-1), "lead");
  const esc = s.desk("lead").fire("keydown", { key: "Escape" });
  assert.equal(s.calls.at(-1), null);
  assert.equal(s.box.selected, null);
  assert.equal(esc.defaultPrevented, false);
  const before = s.calls.length;
  s.desk("lead").fire("keydown", { key: "Escape" });
  assert.equal(s.calls.length, before, "Escape with nothing selected does not call select again");
});

test("Enter and Space select; clicking empty floor deselects", (t) => {
  const s = setup(t, team(2));
  const enter = s.desk("w1").fire("keydown", { key: "Enter" });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(s.calls.at(-1), "w1");
  s.desk("w1").fire("keydown", { key: " " });
  assert.equal(s.calls.at(-1), null);
  s.desk("w2").fire("keydown", { key: " " });
  assert.equal(s.calls.at(-1), "w2");
  s.host.byClass("ps-floor")[0].fire("click");
  assert.equal(s.calls.at(-1), null);
  assert.equal(s.desk("w2").getAttribute("aria-pressed"), "false");
});

test("selection made elsewhere shows up on the next update and via sync()", (t) => {
  const s = setup(t, team(2));
  s.box.selected = "w2";
  s.studio.update(s.box.state);
  assert.equal(s.desk("w2").getAttribute("aria-pressed"), "true");
  s.box.selected = "w1";
  s.studio.sync();
  assert.equal(s.desk("w1").getAttribute("aria-pressed"), "true");
  assert.equal(s.desk("w2").getAttribute("aria-pressed"), "false");
});

test("arrow keys, Home and End move focus between desks", (t) => {
  const s = setup(t, team(3));
  const focused = () => s.doc.activeElement && s.doc.activeElement.getAttribute("data-id");
  s.desk("w1").focus();
  s.desk("w1").fire("keydown", { key: "ArrowRight" });
  assert.equal(focused(), "w2");
  s.desk("w2").fire("keydown", { key: "ArrowRight" });
  assert.equal(focused(), "w3");
  s.desk("w3").fire("keydown", { key: "ArrowLeft" });
  assert.equal(focused(), "w2");
  s.desk("w2").fire("keydown", { key: "ArrowUp" });
  assert.equal(focused(), "lead");
  s.desk("lead").fire("keydown", { key: "ArrowDown" });
  assert.match(focused(), /^w\d$/);
  s.desk("w2").fire("keydown", { key: "End" });
  assert.equal(focused(), "w3");
  s.desk("w2").fire("keydown", { key: "Home" });
  assert.equal(focused(), "lead");
  assert.equal(s.calls.length, 0, "moving focus never selects");
});

test("the first update is a baseline: it plays no sounds and creates no effects", (t) => {
  const s = setup(t, [
    { id: "w1", status: "working" },
    { id: "w2", status: "waiting_approval" },
    { id: "w3", status: "blocked" },
    { id: "w4", status: "done" },
  ]);
  assert.deepEqual(s.played, []);
  for (const cls of ["ps-plane", "ps-stamp", "ps-sparks", "ps-ripple"]) assert.equal(s.host.byClass(cls).length, 0, cls);
});

test("status changes trigger the matching sound and effect", (t) => {
  const s = setup(t, [{ id: "w1", name: "Rivet", status: "queued" }, { id: "w2", status: "working" }, { id: "w3", status: "working" }, { id: "w4", status: "working" }]);
  s.push([{ id: "w1", name: "Rivet", status: "working" }, { id: "w2", status: "waiting_approval" }, { id: "w3", status: "blocked" }, { id: "w4", status: "done" }]);
  assert.deepEqual([...new Set(s.played)].sort(), ["approval", "blocked", "dispatch", "stamp"]);
  assert.equal(s.played.length, 4, "each sound plays once per update even with several workers");
  assert.equal(s.host.byClass("ps-ripple").length, 1);
  assert.equal(s.host.byClass("ps-sparks").length, 1);
  assert.equal(s.host.byClass("ps-stamp").length, 1);
  assert.equal(s.host.byClass("ps-stamp")[0].textContent, labels.statuses.done.toUpperCase());
  s.tick(300);
  assert.equal(s.host.byClass("ps-plane").length, 1, "the paper plane leaves after its delay");
  assert.match(s.host.byClass("ps-live")[0].textContent, /w2 needs your OK/);
  s.tick(5000);
  for (const cls of ["ps-plane", "ps-stamp", "ps-sparks", "ps-ripple"]) assert.equal(s.host.byClass(cls).length, 0, `${cls} cleans itself up`);
});

test("a new worker is dispatched; an unchanged update plays nothing", (t) => {
  const s = setup(t, team(1, "working"));
  s.push([...team(1, "working"), { id: "w9", name: "Newcomer", status: "working" }]);
  assert.deepEqual(s.played, ["dispatch"]);
  s.played.length = 0;
  s.push([...team(1, "working"), { id: "w9", name: "Newcomer", status: "working" }]);
  assert.deepEqual(s.played, []);
});

test("an approved review stamps the worker's desk once", (t) => {
  const s = setup(t, team(2, "done"), { state: { reviews: { r1: { id: "r1", workerId: "w1", status: "open" } } } });
  const approved = { r1: { id: "r1", workerId: "w1", status: "approved" } };
  s.push(team(2, "done"), { reviews: approved, shipped: 1 });
  assert.deepEqual(s.played, ["stamp"]);
  assert.equal(s.host.byClass("ps-stamp")[0].textContent, labels.approved.toUpperCase());
  s.played.length = 0;
  s.push(team(2, "done"), { reviews: approved, shipped: 1 });
  assert.deepEqual(s.played, []);
  assert.match(s.host.byClass("ps-shelf")[0].getAttribute("aria-label"), /1 /);
});

test("reduced motion: static poses, no flying or looping effects, still readable", (t) => {
  const s = setup(t, [{ id: "w1", status: "queued" }, { id: "w2", status: "working" }], { reduced: true });
  assert.equal(s.host.byClass("ps-root")[0].classList.contains("ps-reduced"), true);
  s.push([{ id: "w1", status: "working" }, { id: "w2", status: "waiting_approval" }, { id: "w3", status: "blocked" }]);
  for (const cls of ["ps-plane", "ps-sparks", "ps-ripple"]) assert.equal(s.host.byClass(cls).length, 0, cls);
  assert.equal(s.host.byClass("ps-pose").length, 4, "no cross-fading second pose");
  assert.equal(s.desk("w2").getAttribute("data-status"), "waiting_approval");
  assert.match(s.desk("w2").getAttribute("aria-label"), /Needs your OK/);
});

test("prefers-reduced-motion is honoured live and cleared when it turns off", (t) => {
  const s = setup(t, team(2, "working"));
  const root = s.host.byClass("ps-root")[0];
  assert.equal(root.classList.contains("ps-reduced"), false);
  s.media.set(true);
  assert.equal(root.classList.contains("ps-reduced"), true);
  s.media.set(false);
  assert.equal(root.classList.contains("ps-reduced"), false);
});

test("animations pause when the document is hidden or the scene is offscreen", (t) => {
  const s = setup(t, team(2, "working"));
  const root = s.host.byClass("ps-root")[0];
  assert.equal(root.classList.contains("ps-paused"), false);
  s.doc.hidden = true;
  s.doc.fire("visibilitychange");
  assert.equal(root.classList.contains("ps-paused"), true);
  s.doc.hidden = false;
  s.doc.fire("visibilitychange");
  assert.equal(root.classList.contains("ps-paused"), false);
  const io = s.win.observers.intersection[0];
  io.cb([{ isIntersecting: false }]);
  assert.equal(root.classList.contains("ps-paused"), true);
  io.cb([{ isIntersecting: true }]);
  assert.equal(root.classList.contains("ps-paused"), false);
});

test("works without ResizeObserver, IntersectionObserver or matchMedia", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dom = createFakeDom({ observers: false });
  delete dom.win.matchMedia;
  dom.win.addEventListener = () => {};
  dom.win.removeEventListener = () => {};
  const studio = mountStudio(dom.host, { getState: () => makeState(team(2)), select() {}, selectedId: () => null });
  assert.equal(dom.host.find((n) => n.classes.has("ps-desk")).length, 3);
  studio.destroy();
});

test("state text only reaches the DOM as text or attribute values, never as markup", (t) => {
  const s = setup(t, [
    { id: "w1", name: EVIL, status: "working", now: EVIL, title: EVIL, reason: EVIL, role: "builder", plan: [{ text: EVIL, status: "done" }, { text: EVIL, status: "todo" }] },
    { id: "w2", name: EVIL, status: "queued", reason: EVIL, title: EVIL },
  ], { state: { goal: EVIL } });
  s.push([{ id: "w1", name: EVIL, status: "waiting_approval", now: EVIL, title: EVIL }, { id: "w2", name: EVIL, status: "blocked", reason: EVIL, title: EVIL }]);
  assert.ok(s.doc.innerHTMLWrites.length > 0);
  assert.equal(s.doc.innerHTMLWrites.filter((w) => w.html.includes("onerror") || w.html.includes("alert(1)") || w.html.includes(EVIL)).length, 0);
  for (const w of s.doc.innerHTMLWrites) assert.match(w.html, /^\s*<(svg|div|path|g)/, "only static art goes through innerHTML");
  assert.match(s.desk("w1").getAttribute("aria-label"), /onerror/);
  assert.ok(s.desk("w1").byClass("ps-name")[0].textContent.includes("<img"));
  assert.ok(s.desk("w1").byClass("ps-sign-t")[0].textContent.includes("alert(1)"));
  assert.equal(s.host.find((n) => n.tagName === "IMG").length, 0);
});

test("long names and titles are clipped before they are drawn", (t) => {
  const long = "x".repeat(5000);
  const s = setup(t, [{ id: "w1", name: long, title: long, now: long, status: "working" }]);
  assert.ok(s.desk("w1").byClass("ps-name")[0].textContent.length <= 60);
  assert.ok(s.desk("w1").byClass("ps-sign-t")[0].textContent.length <= 160);
  assert.ok(s.desk("w1").getAttribute("aria-label").length < 600);
});

test("unknown roles and statuses fall back to something drawable", (t) => {
  const s = setup(t, [{ id: "w1", role: "wizard", status: "levitating", name: "Odd" }]);
  assert.equal(s.desk("w1").getAttribute("data-status"), "idle");
  assert.equal(s.desk("w1").getAttribute("data-role"), "builder");
  assert.match(s.desk("w1").getAttribute("aria-label"), /^Odd, Builder, /);
});

test("queued workers are listed at the stage door with their reason", (t) => {
  const s = setup(t, [
    { id: "w1", name: "Rivet", status: "queued", reason: "Waiting for the plan to be approved" },
    { id: "w2", name: "Pip", status: "queued", reason: "Capacity: 3 of 3 busy" },
    { id: "w3", status: "working" },
  ]);
  const door = s.host.byClass("ps-door")[0];
  assert.match(door.getAttribute("aria-label"), /2 /);
  assert.match(door.getAttribute("aria-label"), /Rivet: Waiting for the plan to be approved/);
  assert.match(door.getAttribute("aria-label"), /Pip: Capacity: 3 of 3 busy/);
  assert.equal(s.host.byClass("ps-door-count")[0].textContent, "2");
  assert.match(s.desk("w1").getAttribute("aria-label"), /At the stage door: Waiting for the plan to be approved/);
  s.push([{ id: "w1", status: "working" }, { id: "w2", status: "working" }, { id: "w3", status: "working" }]);
  assert.equal(s.host.byClass("ps-door-count")[0].hidden, true);
  assert.match(door.getAttribute("aria-label"), /empty|No one|nobody/i);
});

test("takeover, context battery and plan progress show on the desk", (t) => {
  const s = setup(t, [{ id: "w1", name: "Rivet", status: "working", takeover: true, context: { used: 800, size: 1000 }, plan: [{ status: "done" }, { status: "done" }, { status: "doing" }, { status: "todo" }] }]);
  const d = s.desk("w1");
  assert.equal(d.byClass("ps-takeover")[0].hidden, false);
  assert.match(d.getAttribute("aria-label"), /You're driving/);
  assert.equal(d.byClass("ps-batt")[0].hidden, false);
  assert.equal(d.byClass("ps-batt")[0].getAttribute("data-lvl"), "low");
  assert.equal(d.byClass("ps-batt")[0].children[0].style.getPropertyValue("width"), "20%");
  assert.equal(d.byClass("ps-frac")[0].textContent, "2/4");
  assert.equal(d.byClass("ps-prog")[0].children[0].style.getPropertyValue("width"), "50%");
  s.push([{ id: "w1", name: "Rivet", status: "working" }]);
  assert.equal(d.byClass("ps-takeover")[0].hidden, true);
  assert.equal(d.byClass("ps-batt")[0].hidden, true);
  assert.equal(d.byClass("ps-frac")[0].hidden, true);
});

test("without a lead the Foreman desk is shown but cannot be selected", (t) => {
  const s = setup(t, team(1), { state: { lead: false } });
  assert.equal(s.desk("lead").getAttribute("aria-disabled"), "true");
  s.desk("lead").fire("click");
  assert.deepEqual(s.calls, []);
  s.desk("w1").fire("click");
  assert.deepEqual(s.calls, ["w1"]);
});

test("an update with nothing new touches no DOM", (t) => {
  const s = setup(t, [
    { id: "w1", status: "working", now: "Typing", title: "A", context: { used: 1, size: 10 }, plan: [{ status: "done" }] },
    { id: "w2", status: "queued", reason: "Waiting" },
  ]);
  s.tick(5000);
  s.doc.resetLog();
  s.studio.update(s.box.state);
  s.studio.update(makeState([
    { id: "w1", status: "working", now: "Typing", title: "A", context: { used: 1, size: 10 }, plan: [{ status: "done" }] },
    { id: "w2", status: "queued", reason: "Waiting" },
  ]));
  assert.equal(s.doc.mutations, 0, s.doc.mutLog.map((m) => m.what).join(","));
});

test("a change to one worker touches only that desk", (t) => {
  const s = setup(t, [...team(5, "working")]);
  s.tick(5000);
  s.doc.resetLog();
  s.push([{ ...team(5, "working")[0], now: "Something new" }, ...team(5, "working").slice(1)]);
  const touched = new Set(s.doc.mutLog.map((m) => m.el));
  const other = s.desk("w3");
  for (const el of touched) assert.equal(other.contains(el), false, "another worker's desk was touched");
  assert.ok(s.desk("w1").getAttribute("aria-label").includes("Something new"));
});

test("thousands of updates keep the DOM, listeners and effects bounded", (t) => {
  const statuses = ["idle", "queued", "working", "waiting_approval", "held", "blocked", "done", "failed"];
  const specsAt = (i) => Array.from({ length: 1 + (i % 7) }, (_, k) => ({ id: `w${(i + k) % 11}`, name: `n${(i * 7 + k) % 5}`, role: ["planner", "builder", "checker"][(i + k) % 3], status: statuses[(i * 3 + k * 5) % statuses.length], title: `Order ${i % 9}`, now: `step ${i % 13}`, reason: i % 2 ? "Waiting" : null, takeover: i % 17 === 0, context: { used: i % 100, size: 100 }, plan: [{ status: "done" }, { status: "todo" }] }));
  const s = setup(t, specsAt(0));
  const rev = (i) => ({ [`r${i % 4}`]: { id: `r${i % 4}`, workerId: `w${i % 11}`, status: ["open", "approved", "held"][i % 3] } });
  const settle = () => s.tick(10000);
  for (let i = 0; i < 200; i++) s.push(specsAt(i), { reviews: rev(i), shipped: i % 6 });
  settle();
  s.push(team(7, "working"));
  settle();
  const baseline = countNodes(s.host);
  const baseHist = histogram(s.host);
  const listeners = s.doc.listenerCount;
  let peak = 0;
  for (let i = 0; i < 4000; i++) {
    s.push(specsAt(i), { reviews: rev(i), shipped: i % 6 });
    if (i % 25 === 0) peak = Math.max(peak, countNodes(s.host));
    if (i % 5 === 0) s.tick(400);
  }
  assert.ok(peak < baseline + 200, `peak ${peak} vs baseline ${baseline}`);
  settle();
  s.push(team(7, "working"));
  settle();
  assert.deepEqual(histogram(s.host), baseHist, "nothing leaks once the effects have finished");
  assert.equal(countNodes(s.host), baseline);
  assert.equal(s.doc.listenerCount, listeners);
  for (const cls of ["ps-plane", "ps-stamp", "ps-sparks", "ps-ripple"]) assert.equal(s.host.byClass(cls).length, 0, cls);
});

test("destroy removes the DOM, listeners, observers and pending timers", (t) => {
  const s = setup(t, [{ id: "w1", status: "queued" }]);
  s.push([{ id: "w1", status: "working" }]);
  assert.ok(s.doc.listenerCount > 0);
  assert.equal(s.host.classes.has("ps-host"), true);
  s.studio.destroy();
  assert.equal(s.host.children.length, 0);
  assert.equal(s.host.classes.has("ps-host"), false);
  assert.equal(s.doc.listenerCount, 0);
  assert.equal(s.media.listeners.size, 0);
  assert.ok(s.win.observers.resize.every((o) => o.disconnected));
  assert.ok(s.win.observers.intersection.every((o) => o.disconnected));
  s.doc.resetLog();
  s.studio.update(makeState(team(3, "working")));
  s.tick(10000);
  assert.equal(s.doc.mutations, 0, "no timers or updates touch the DOM after destroy");
  s.studio.destroy();
});

test("resizing the container re-lays the desks out", (t) => {
  const s = setup(t, team(4, "working"));
  const x = () => s.desk("w1").style.getPropertyValue("left");
  const before = x();
  s.host.clientWidth = 1600;
  s.host.clientHeight = 900;
  s.win.observers.resize[0].cb([]);
  assert.notEqual(x(), before);
});

test("shelfPlan always fits the capacity and accounts for every review", () => {
  for (let cap = 1; cap <= 12; cap++) {
    for (let a = 0; a <= 10; a++) {
      for (let p = 0; p <= 4; p++) {
        for (let h = 0; h <= 3; h++) {
          const plan = shelfPlan(a, p, h, cap);
          const tiles = plan.stamped + plan.pending + plan.held + (plan.more ? 1 : 0);
          assert.ok(tiles <= cap, `${a}/${p}/${h} in ${cap}`);
          assert.equal(plan.stamped + plan.pending + plan.held + plan.more, a + p + h);
        }
      }
    }
  }
});
