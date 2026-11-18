import test from "node:test";
import assert from "node:assert/strict";
import { layoutDesks, nextInDirection, rectsOverlap, MAX_DESKS } from "../../public/studio/layout.js";

const SIZES = [
  [480, 320],
  [560, 360],
  [640, 400],
  [900, 600],
  [1024, 768],
  [1440, 900],
  [1920, 1080],
  [2560, 1440],
  [1200, 480], // wide and short
  [520, 900], // narrow and tall
];
const EPS = 0.51; // coordinates are rounded to 0.1

function boxes(L) {
  const list = [{ name: "lead", ...L.lead }];
  L.desks.forEach((d, i) => list.push({ name: `desk${i}`, ...d }));
  list.push({ name: "door", ...L.door }, { name: "shelf", ...L.shelf });
  return list;
}

function assertInside(r, W, H, label) {
  for (const k of ["x", "y", "w", "h"]) assert.ok(Number.isFinite(r[k]), `${label}.${k} is finite`);
  assert.ok(r.w > 0 && r.h > 0, `${label} has a size`);
  assert.ok(r.x >= -EPS && r.y >= -EPS, `${label} starts inside (${r.x}, ${r.y})`);
  assert.ok(r.x + r.w <= W + EPS, `${label} ends inside the width (${r.x + r.w} <= ${W})`);
  assert.ok(r.y + r.h <= H + EPS, `${label} ends inside the height (${r.y + r.h} <= ${H})`);
}

for (const [W, H] of SIZES) {
  for (let n = 0; n <= 8; n++) {
    test(`layoutDesks(${n}, ${W}x${H}): inside bounds, no overlaps`, () => {
      const L = layoutDesks(n, W, H);
      assert.equal(L.n, n);
      assert.equal(L.desks.length, n);
      assert.ok(L.cols * L.rows >= n, "grid holds every desk");
      assert.ok(L.scale > 0 && Number.isFinite(L.scale));
      assert.ok(Number.isFinite(L.font) && L.font >= 10 && L.font <= 17);

      const list = boxes(L);
      for (const b of list) assertInside(b, W, H, b.name);
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          assert.ok(!rectsOverlap(list[i], list[j], 0.5), `${list[i].name} overlaps ${list[j].name}`);
        }
      }

      // the queue line is on the floor, clear of the desks and inside the room
      assert.equal(L.queue.slots.length, Math.max(n, 1));
      for (const s of L.queue.slots) {
        const r = { x: s.x, y: s.y, w: s.size, h: s.size };
        assertInside(r, W, H, `queue slot ${s.index}`);
        for (const b of list) {
          if (b.name === "shelf") continue;
          assert.ok(!rectsOverlap(r, b, 0.5), `queue slot ${s.index} overlaps ${b.name}`);
        }
      }

      for (const d of L.decor) {
        assertInside(d, W, L.wall.h + 1, `decor ${d.kind}`);
        assert.ok(!rectsOverlap(d, L.door, 0.5) && !rectsOverlap(d, L.shelf, 0.5), `${d.kind} clear of door and shelf`);
      }
      assert.deepEqual(layoutDesks(n, W, H), L, "pure: the same input gives the same output");
    });
  }
}

test("layoutDesks: scale never shrinks as the room grows", () => {
  for (let n = 0; n <= 8; n++) {
    let last = 0;
    for (const k of [1, 1.5, 2, 3, 4]) {
      const { scale } = layoutDesks(n, 480 * k, 320 * k);
      assert.ok(scale >= last - 1e-9, `n=${n} k=${k}: ${scale} >= ${last}`);
      last = scale;
    }
  }
});

test("layoutDesks: desks keep their order in rows, left to right", () => {
  const L = layoutDesks(7, 1440, 900);
  for (let i = 1; i < L.desks.length; i++) {
    const a = L.desks[i - 1];
    const b = L.desks[i];
    assert.ok(b.row > a.row || (b.row === a.row && b.x > a.x), `desk ${i} comes after desk ${i - 1}`);
  }
  assert.equal(L.desks[0].row, 0);
  assert.equal(L.desks.at(-1).row, L.rows - 1);
});

test("layoutDesks: compact and tiny flags follow the desk width", () => {
  const roomy = layoutDesks(3, 1440, 900);
  assert.equal(roomy.compact, false);
  assert.equal(roomy.tiny, false);
  const cramped = layoutDesks(7, 480, 320);
  assert.equal(cramped.compact, true);
  assert.equal(cramped.tiny, true);
  assert.ok(cramped.desks.every((d) => d.w >= 20), "even the smallest desk stays usable");
});

test("layoutDesks: a lone Foreman (n=0) still gets a door, a shelf and a queue slot", () => {
  const L = layoutDesks(0, 900, 600);
  assert.equal(L.desks.length, 0);
  assert.equal(L.rows, 0);
  assert.ok(L.lead.w > 0 && L.door.w > 0 && L.shelf.w > 0);
  assert.equal(L.queue.slots.length, 1);
});

test("layoutDesks: bad input is clamped, never thrown or NaN", () => {
  for (const args of [[NaN, NaN, NaN], [-3, 0, 0], [undefined, undefined, undefined], [100, 800, 500], [3.7, 400, 200], [Infinity, Infinity, Infinity], ["4", "900", "600"]]) {
    const L = layoutDesks(...args);
    assert.ok(L.n >= 0 && L.n <= MAX_DESKS);
    assert.equal(L.desks.length, L.n);
    for (const b of boxes(L)) for (const k of ["x", "y", "w", "h"]) assert.ok(Number.isFinite(b[k]), `${b.name}.${k} finite for ${JSON.stringify(args)}`);
  }
  assert.equal(layoutDesks(100, 1920, 1080).n, MAX_DESKS);
  assert.equal(layoutDesks(3.7, 900, 600).n, 3);
});

test("nextInDirection: picks the nearest desk in the pressed direction", () => {
  const items = [
    { id: "a", x: 0, y: 0, w: 10, h: 10 },
    { id: "b", x: 20, y: 0, w: 10, h: 10 },
    { id: "c", x: 0, y: 20, w: 10, h: 10 },
    { id: "d", x: 20, y: 20, w: 10, h: 10 },
  ];
  assert.equal(nextInDirection(items, "a", "right"), "b");
  assert.equal(nextInDirection(items, "a", "down"), "c");
  assert.equal(nextInDirection(items, "d", "left"), "c");
  assert.equal(nextInDirection(items, "d", "up"), "b");
  assert.equal(nextInDirection(items, "a", "left"), null, "nothing to the left of the leftmost");
  assert.equal(nextInDirection(items, "a", "up"), null);
  assert.equal(nextInDirection(items, "zzz", "up"), "a", "unknown id falls back to the first item");
  assert.equal(nextInDirection([], "a", "up"), null);
});

test("rectsOverlap: touching edges are not an overlap", () => {
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), false);
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 9, w: 10, h: 10 }), true);
});
