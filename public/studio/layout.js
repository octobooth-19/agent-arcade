// Pure geometry for the studio room. No DOM. layoutDesks(n, width, height) places the Foreman's desk, n worker desks,
// the stage door (with its queue line) and the done shelf inside a width x height box, without overlaps.
// Desks keep their grid cell for the whole run (queued workers just walk away from theirs), so nothing jumps around.

// Design units for one desk's art box. Everything inside a desk is drawn at this size and scaled by layout.scale.
export const DESIGN = Object.freeze({ deskW: 156, artH: 124, charBox: 88, charX: 34, charY: 4, leadK: 1.12 });

export const MAX_DESKS = 24;
const MIN_SCALE = 0.08;
const MAX_SCALE = 1.45;
const COMPACT_BELOW = 138; // desk px width under which the status text is dropped and labels use two rows
const TINY_BELOW = 96; // desk px width under which the status icon and battery move off the name row

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);
const r1 = (v) => Math.round(v * 10) / 10;

export function fontSize(scale) {
  return r1(clamp(12.5 * scale, 10, 17));
}

export function labelHeight(scale, compact) {
  const f = fontSize(scale);
  return r1(compact ? f * 2.85 + 8 : f * 4.3 + 11);
}

function deskDims(s) {
  const w = DESIGN.deskW * s;
  const compact = w < COMPACT_BELOW;
  const labelH = labelHeight(s, compact);
  return { w, compact, labelH, artH: DESIGN.artH * s, h: DESIGN.artH * s + labelH };
}

function leadDims(s) {
  const k = DESIGN.leadK;
  const d = deskDims(s);
  const w = DESIGN.deskW * s * k;
  const artH = DESIGN.artH * s * k;
  return { w, artH, labelH: d.labelH, h: artH + d.labelH, compact: d.compact, scale: s * k };
}

function frame(width, height) {
  const W = Math.max(1, finite(width, 1));
  const H = Math.max(1, finite(height, 1));
  const pad = clamp(Math.min(W, H) * 0.025, 5, 20);
  const gapX = pad * 0.7;
  const gapY = pad * 0.55;
  const wallH = clamp(H * 0.12, 20, 80);
  const doorColW = clamp(W * 0.14, 64, 150);
  const mainX = pad + doorColW + gapX;
  const mainW = Math.max(1, W - pad - mainX);
  const shelfW = clamp(W * 0.15, 64, 200);
  return { W, H, pad, gapX, gapY, wallH, doorColW, mainX, mainW, shelfW };
}

function fits(f, n, cols, s) {
  const d = deskDims(s);
  const l = leadDims(s);
  const rows = n === 0 ? 0 : Math.ceil(n / cols);
  const topPad = f.pad * 0.4;
  const need = topPad + l.h + (rows ? f.gapY * 1.5 + rows * d.h + (rows - 1) * f.gapY : 0) + f.pad;
  if (need > f.H - f.wallH) return false;
  if (rows && cols * d.w + (cols - 1) * f.gapX > f.mainW) return false;
  if (l.w + f.gapX + f.shelfW > f.mainW) return false;
  return true;
}

function bestScale(f, n, cols) {
  if (!fits(f, n, cols, MIN_SCALE)) return MIN_SCALE;
  if (fits(f, n, cols, MAX_SCALE)) return MAX_SCALE;
  let lo = MIN_SCALE;
  let hi = MAX_SCALE;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (fits(f, n, cols, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * @returns {{width:number,height:number,n:number,cols:number,rows:number,scale:number,compact:boolean,tiny:boolean,font:number,pad:number,
 *   wall:object,floor:object,door:object,shelf:object,lead:object,desks:object[],queue:{size:number,slots:object[]},decor:object[]}}
 */
export function layoutDesks(count, width, height) {
  const n = clamp(Math.floor(finite(count, 0)), 0, MAX_DESKS);
  const f = frame(width, height);
  const { W, H, pad, gapX, gapY, wallH, mainX, mainW, shelfW } = f;

  let cols = 1;
  let s = bestScale(f, n, 1);
  if (n > 1) {
    // Prefer the largest scale; on (near) ties prefer little empty space, then a roomy rather than tall grid.
    const waste = (c) => Math.ceil(n / c) * c - n;
    const ideal = Math.sqrt(n * 2.5);
    for (let c = 2; c <= Math.min(n, 8); c++) {
      const sc = bestScale(f, n, c);
      const tie = Math.abs(sc - s) <= 0.012;
      const better = waste(c) < waste(cols) || (waste(c) === waste(cols) && Math.abs(c - ideal) < Math.abs(cols - ideal));
      if (sc > s + 0.012 || (tie && better)) {
        s = Math.max(s, sc);
        cols = c;
      }
    }
  }
  const rows = n === 0 ? 0 : Math.ceil(n / cols);
  const d = deskDims(s);
  const l = leadDims(s);

  // Spread any spare height: a little above the content, a little between rows, the rest below.
  const topPad = pad * 0.4;
  const need = topPad + l.h + (rows ? gapY * 1.5 + rows * d.h + (rows - 1) * gapY : 0) + pad;
  const slack = Math.max(0, H - wallH - need);
  const rowGap = gapY + (rows > 1 ? Math.min(slack * 0.25 / (rows - 1), d.h * 0.2) : 0);
  const leadTop = wallH + topPad + (rows ? slack * 0.12 : slack * 0.4);
  const gridTop = leadTop + l.h + gapY * 1.5 + (rows ? slack * 0.12 : 0);

  const shelfX = mainX + mainW - shelfW;
  const leadX = Math.max(mainX, Math.min(mainX + (mainW - l.w) / 2, shelfX - gapX - l.w));
  const lead = { x: r1(leadX), y: r1(leadTop), w: r1(l.w), h: r1(l.h), scale: l.scale, artH: r1(l.artH), labelH: l.labelH };

  const desks = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols;
    const col = i - row * cols;
    const rowW = inRow * d.w + (inRow - 1) * gapX;
    desks.push({
      index: i,
      row,
      col,
      x: r1(mainX + (mainW - rowW) / 2 + col * (d.w + gapX)),
      y: r1(gridTop + row * (d.h + rowGap)),
      w: r1(d.w),
      h: r1(d.h),
      scale: s,
      artH: r1(d.artH),
      labelH: d.labelH,
    });
  }

  // Stage door: a tall door in the back wall on the left; the queue line forms on the floor under it.
  const doorH = clamp(wallH + l.h * 0.9, 56, (H - pad) * 0.46);
  const door = { x: r1(pad), y: r1(pad * 0.5), w: r1(f.doorColW), h: r1(doorH) };
  const doorBottom = door.y + door.h;
  let size = clamp(f.doorColW * 0.62, 24, 80);
  const queueTop = doorBottom + gapY;
  const room = H - pad - queueTop;
  if (n > 1) size = clamp(Math.min(size, room - (n - 1) * 8), 18, size);
  else size = Math.min(size, Math.max(18, room));
  const spacing = n > 1 ? clamp((room - size) / (n - 1), 8, size * 0.62) : 0;
  const slots = [];
  for (let k = 0; k < Math.max(n, 1); k++) {
    const sway = k % 2 ? 1 : -1;
    slots.push({
      index: k,
      size: r1(size),
      x: r1(pad + f.doorColW / 2 - size / 2 + (k === 0 ? 0 : sway * Math.min(size * 0.1, f.doorColW * 0.08))),
      y: r1(queueTop + k * spacing),
    });
  }

  const shelf = { x: r1(shelfX), y: r1(pad * 0.5), w: r1(shelfW), h: r1(Math.max(40, wallH - pad * 0.5 + l.h * 0.95)) };

  // Wall dressing between the door and the shelf. Purely decorative; may sit above the Foreman.
  const wallLeft = door.x + door.w + gapX;
  const wallRight = shelf.x - gapX;
  const decor = [];
  const wallRoom = wallRight - wallLeft;
  const winH = Math.max(0, wallH - pad * 0.5 - 4);
  if (wallRoom > 60 && winH >= 14) {
    const winW = Math.min(wallRoom * 0.34, winH * 2.4, 220);
    decor.push({ kind: "window", x: r1(wallLeft + wallRoom / 2 - winW / 2), y: r1(pad * 0.5), w: r1(winW), h: r1(winH) });
    if (wallRoom > winW * 2.2) {
      const px = Math.min(winH * 0.9, 56);
      decor.push({ kind: "poster", x: r1(wallLeft + wallRoom / 2 - winW / 2 - px - gapX * 1.5), y: r1(pad * 0.5 + 2), w: r1(px), h: r1(winH - 2) });
      decor.push({ kind: "clock", x: r1(wallLeft + wallRoom / 2 + winW / 2 + gapX * 1.5), y: r1(pad * 0.5 + 2), w: r1(Math.min(winH - 2, 40)), h: r1(Math.min(winH - 2, 40)) });
    }
  }

  return {
    width: W,
    height: H,
    n,
    cols,
    rows,
    scale: s,
    compact: d.compact,
    tiny: d.w < TINY_BELOW,
    font: fontSize(s),
    pad,
    wall: { x: 0, y: 0, w: W, h: r1(wallH) },
    floor: { x: 0, y: r1(wallH), w: W, h: r1(H - wallH) },
    door,
    shelf,
    lead,
    desks,
    queue: { size: r1(size), slots },
    decor,
  };
}

/** Rectangles for arrow-key focus moves: pick the nearest item in a direction (up, down, left, right). */
export function nextInDirection(items, id, dir) {
  const from = items.find((it) => it.id === id);
  if (!from) return items[0]?.id ?? null;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best = null;
  let bestScore = Infinity;
  for (const it of items) {
    if (it.id === id) continue;
    const dx = it.x + it.w / 2 - cx;
    const dy = it.y + it.h / 2 - cy;
    const along = dir === "right" ? dx : dir === "left" ? -dx : dir === "down" ? dy : -dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 1) continue;
    const score = along + across * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = it.id;
    }
  }
  return best;
}

export function rectsOverlap(a, b, eps = 0.01) {
  return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
}
