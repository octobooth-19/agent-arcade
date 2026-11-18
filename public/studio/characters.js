// Original robot critters for the studio. characterSvg(role, status, { size }) returns inline SVG markup for one pose.
// Only enum-validated inputs reach the markup, and no user text is ever part of it.
// Colors come from the design tokens (var(--role-*), --ink, --surface...), so the art follows the active theme.
// Classes named ps-* are animation hooks used by scene.css; the poses read fine without any CSS.

export const CHARACTER_ROLES = ["lead", "planner", "builder", "checker"];
export const CHARACTER_STATUSES = ["idle", "queued", "working", "waiting_approval", "held", "blocked", "done", "failed"];

const FALLBACK_ROLE = "builder";
const FALLBACK_STATUS = "idle";
const ROLE_NAMES = { lead: "Foreman", planner: "Planner", builder: "Builder", checker: "Checker" };
const STATUS_NAMES = {
  idle: "Idle",
  queued: "At the stage door",
  working: "Working",
  waiting_approval: "Needs your OK",
  held: "Held",
  blocked: "Stuck",
  done: "Done",
  failed: "Failed",
};

// Silhouettes differ by body shape as well as headgear, so roles still read in grayscale.
const BODY = {
  lead: { x: 21, y: 31, w: 58, h: 49, r: 22 },
  planner: { x: 30, y: 24, w: 40, h: 56, r: 20 },
  builder: { x: 25, y: 33, w: 50, h: 47, r: 15 },
  checker: { x: 26, y: 30, w: 48, h: 50, r: 24 },
};

const f1 = (n) => Math.round(n * 10) / 10;
const st = (fill, stroke, sw) => `style="fill:${fill}${stroke ? `;stroke:${stroke};stroke-width:${sw ?? 2}` : ""}"`;
const line = (d, stroke, sw, extra = "") => `<path d="${d}" style="fill:none;stroke:${stroke};stroke-width:${sw};stroke-linecap:round;stroke-linejoin:round" ${extra}/>`;

function star(cx, cy, R, r, points = 5) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const rad = i % 2 === 0 ? R : r;
    pts.push(`${f1(cx + Math.cos(a) * rad)},${f1(cy + Math.sin(a) * rad)}`);
  }
  return pts.join(" ");
}

function sparkle(cx, cy, s, fill, cls) {
  const d = `M${cx} ${cy - s}Q${cx} ${cy} ${cx + s} ${cy}Q${cx} ${cy} ${cx} ${cy + s}Q${cx} ${cy} ${cx - s} ${cy}Q${cx} ${cy} ${cx} ${cy - s}Z`;
  return `<path class="${cls}" d="${d}" ${st(fill)}/>`;
}

function pick(value, allowed, fallback) {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function makeContext(role) {
  const b = BODY[role];
  const cx = b.x + b.w / 2;
  const plate = { x: b.x + 6, y: b.y + (role === "planner" ? 7 : 8), w: b.w - 12, h: 21 };
  return {
    role,
    b,
    cx,
    plate,
    eyeY: plate.y + 9.5,
    eyeDx: Math.min(9.5, plate.w / 2 - 6.5),
    mouthY: plate.y + 17,
    shoulderL: [b.x + 1.5, b.y + 24],
    shoulderR: [b.x + b.w - 1.5, b.y + 24],
    bottom: b.y + b.h,
  };
}

// ---- face ------------------------------------------------------------------------------------------------------

function eyes(c, kind) {
  const { cx, eyeY: y, eyeDx: dx } = c;
  const xs = [cx - dx, cx + dx];
  const e = "var(--e)";
  const open = (rx, ry, px, py) =>
    xs.map((x) => `<ellipse cx="${f1(x)}" cy="${y}" rx="${rx}" ry="${ry}" ${st(e)}/><circle cx="${f1(x + px)}" cy="${f1(y + py)}" r="${f1(rx * 0.5)}" ${st("var(--p)")}/>`).join("");
  switch (kind) {
    case "sleep":
      return xs.map((x) => line(`M${f1(x - 4)} ${y - 0.5}Q${f1(x)} ${y + 4} ${f1(x + 4)} ${y - 0.5}`, e, 2.2)).join("");
    case "happy":
      return xs.map((x) => line(`M${f1(x - 4)} ${y + 2}Q${f1(x)} ${y - 4} ${f1(x + 4)} ${y + 2}`, e, 2.4)).join("");
    case "squint":
      return (
        line(`M${f1(xs[0] - 3.5)} ${y - 3.5}L${f1(xs[0] + 2.5)} ${y}L${f1(xs[0] - 3.5)} ${y + 3.5}`, e, 2.3) +
        line(`M${f1(xs[1] + 3.5)} ${y - 3.5}L${f1(xs[1] - 2.5)} ${y}L${f1(xs[1] + 3.5)} ${y + 3.5}`, e, 2.3)
      );
    case "x":
      return xs.map((x) => line(`M${f1(x - 3.4)} ${y - 3.4}L${f1(x + 3.4)} ${y + 3.4}M${f1(x + 3.4)} ${y - 3.4}L${f1(x - 3.4)} ${y + 3.4}`, e, 2.3)).join("");
    case "wide":
      return open(5, 6, 0, -1.4);
    case "left":
      return open(4.2, 5, -1.9, -0.6);
    case "down":
      return open(4.2, 5, 0, 1.7);
    default:
      return open(4.2, 5, 0, 0.2);
  }
}

function mouth(c, kind) {
  const { cx, mouthY: y } = c;
  const e = "var(--e)";
  switch (kind) {
    case "smile":
      return line(`M${f1(cx - 4.5)} ${y - 1}Q${cx} ${y + 4} ${f1(cx + 4.5)} ${y - 1}`, e, 1.9);
    case "grin":
      return `<path d="M${f1(cx - 5)} ${y - 1.5}Q${cx} ${y + 6} ${f1(cx + 5)} ${y - 1.5}Z" ${st(e)}/>`;
    case "o":
      return `<ellipse cx="${cx}" cy="${y + 0.5}" rx="2.2" ry="2.6" style="fill:none;stroke:${e};stroke-width:1.8"/>`;
    case "frown":
      return line(`M${f1(cx - 4.5)} ${y + 2}Q${cx} ${y - 2.5} ${f1(cx + 4.5)} ${y + 2}`, e, 1.9);
    case "wavy":
      return line(`M${f1(cx - 6)} ${y + 0.5}q2 -3 4 0t4 0t4 0`, e, 1.8);
    default:
      return line(`M${f1(cx - 3.2)} ${y + 0.5}H${f1(cx + 3.2)}`, e, 1.9);
  }
}

// ---- body, headgear, emblem --------------------------------------------------------------------------------------

function legs(c, tapRight) {
  const { cx, bottom } = c;
  const y = bottom - 4;
  const left = `<rect x="${f1(cx - 12)}" y="${y}" width="9.5" height="14" rx="4.7" ${st("var(--a)")}/>`;
  const rightStyle = tapRight ? ` class="ps-tap" style="transform-origin:${f1(cx + 7)}px ${y}px;fill:var(--a)"` : ` ${st("var(--a)")}`;
  const right = `<rect x="${f1(cx + 2.5)}" y="${y}" width="9.5" height="14" rx="4.7"${rightStyle}/>`;
  return left + right;
}

function body(c) {
  const { b } = c;
  const belly = `<ellipse cx="${c.cx}" cy="${f1(c.bottom - 9)}" rx="${f1(b.w * 0.3)}" ry="9" ${st("var(--l)")} opacity=".75"/>`;
  return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${b.r}" ${st("var(--b)", "var(--d)", 2.2)}/>${belly}` + `<rect x="${f1(c.plate.x)}" y="${f1(c.plate.y)}" width="${f1(c.plate.w)}" height="${c.plate.h}" rx="10" ${st("var(--p)")}/>`;
}

function headgear(c) {
  const { role, b, cx } = c;
  switch (role) {
    case "lead": {
      const x0 = b.x + 5;
      const w = b.w - 10;
      return (
        `<path d="M${x0} ${b.y + 6}Q${x0} ${b.y - 13} ${cx} ${b.y - 13}Q${x0 + w} ${b.y - 13} ${x0 + w} ${b.y + 6}Z" ${st("var(--d)", "var(--d)", 1.5)}/>` +
        `<rect x="${x0}" y="${b.y - 2}" width="${w}" height="3.4" ${st("var(--b)")}/>` +
        `<rect x="${b.x - 3}" y="${b.y + 4}" width="${b.w + 6}" height="5.5" rx="2.7" ${st("var(--d)")}/>` +
        `<circle cx="${cx}" cy="${b.y - 13}" r="2.6" ${st("var(--warn)")}/>`
      );
    }
    case "planner": {
      const ty = b.y - 21;
      return (
        line(`M${cx} ${b.y + 1}V${b.y - 8}`, "var(--d)", 2.4) +
        `<polygon class="ps-needle" points="${cx},${ty} ${cx + 5.5},${ty + 8.5} ${cx},${ty + 17} ${cx - 5.5},${ty + 8.5}" ${st("var(--s)", "var(--d)", 1.8)}/>` +
        `<polygon points="${cx},${ty + 1.2} ${cx + 4},${ty + 8.5} ${cx - 4},${ty + 8.5}" ${st("var(--bad)")}/>`
      );
    }
    case "builder": {
      const x0 = b.x + 1;
      const w = b.w - 2;
      return (
        `<path d="M${x0} ${b.y + 7}Q${x0} ${b.y - 15} ${cx} ${b.y - 15}Q${x0 + w} ${b.y - 15} ${x0 + w} ${b.y + 7}Z" ${st("var(--h)", "var(--d)", 2)}/>` +
        `<rect x="${cx - 3.2}" y="${b.y - 14}" width="6.4" height="17" rx="2" ${st("var(--b)")}/>` +
        `<rect x="${b.x - 3}" y="${b.y + 4.5}" width="${b.w + 6}" height="5.5" rx="2.7" ${st("var(--h)", "var(--d)", 2)}/>`
      );
    }
    default: {
      const ear = (x) => `<circle cx="${x}" cy="${b.y + 9}" r="6.5" ${st("var(--b)", "var(--d)", 2)}/><circle cx="${x}" cy="${b.y + 9}" r="3" ${st("var(--l)")}/>`;
      return ear(b.x + 1) + ear(b.x + b.w - 1);
    }
  }
}

function emblem(c) {
  const { role, cx, bottom } = c;
  const y = bottom - 11;
  switch (role) {
    case "lead":
      return `<polygon points="${star(cx, y, 6.2, 2.7)}" ${st("var(--warn)", "var(--d)", 1)}/>`;
    case "planner":
      return `<polygon points="${cx},${y - 6} ${cx + 4.6},${y} ${cx},${y + 6} ${cx - 4.6},${y}" ${st("var(--e)")} opacity=".9"/><circle cx="${cx}" cy="${y}" r="1.6" ${st("var(--b)")}/>`;
    case "builder":
      return `<polygon points="${hex(cx, y, 6.4)}" ${st("var(--e)")} opacity=".9"/><circle cx="${cx}" cy="${y}" r="2.2" ${st("var(--b)")}/>`;
    default:
      return `<circle cx="${cx}" cy="${y}" r="6.2" ${st("var(--e)")} opacity=".9"/>${line(`M${cx - 3} ${y + 0.2}L${cx - 0.8} ${y + 2.6}L${cx + 3.4} ${y - 2.6}`, "var(--b)", 1.9)}`;
  }
}

function hex(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    pts.push(`${f1(cx + Math.cos(a) * r)},${f1(cy + Math.sin(a) * r)}`);
  }
  return pts.join(" ");
}

// ---- arms and held props ---------------------------------------------------------------------------------------------

function arm(from, to, bend = [0, 0], cls = "", origin = "") {
  const mx = (from[0] + to[0]) / 2 + bend[0];
  const my = (from[1] + to[1]) / 2 + bend[1];
  const attrs = cls ? ` class="${cls}"` : "";
  const styleExtra = origin ? `transform-origin:${origin};` : "";
  return (
    `<g${attrs}${styleExtra ? ` style="${styleExtra}"` : ""}>` +
    `<path d="M${f1(from[0])} ${f1(from[1])}Q${f1(mx)} ${f1(my)} ${f1(to[0])} ${f1(to[1])}" style="fill:none;stroke:var(--a);stroke-width:7;stroke-linecap:round"/>` +
    `<circle cx="${f1(to[0])}" cy="${f1(to[1])}" r="4.2" ${st("var(--a)")}/></g>`
  );
}

const origin = (p) => `${f1(p[0])}px ${f1(p[1])}px`;
const hang = (c, side) => {
  const s = side === "l" ? c.shoulderL : c.shoulderR;
  const dir = side === "l" ? -1 : 1;
  return arm(s, [s[0] + dir * 3, s[1] + 24], [dir * 5, 0]);
};

const clipboard = (x, y, w, h) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${st("var(--w)", "var(--d)", 1.6)}/>` +
  `<rect x="${x + 2.4}" y="${y + 4}" width="${w - 4.8}" height="${h - 6.6}" rx="1.4" ${st("var(--s)")}/>` +
  line(`M${x + 5} ${y + 9}H${x + w - 5}M${x + 5} ${y + 13.5}H${x + w - 8}M${x + 5} ${y + 18}H${x + w - 6}`, "var(--d)", 1.4, 'opacity=".6"') +
  `<rect x="${x + w / 2 - 4.5}" y="${y - 1.6}" width="9" height="5" rx="2" ${st("var(--d)")}/>`;

const paper = (x, y, w, h, tilt = 0) =>
  `<g transform="rotate(${tilt} ${x + w / 2} ${y + h / 2})"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" ${st("var(--s)", "var(--d)", 1.6)}/>` +
  line(`M${x + 3} ${y + 5}H${x + w - 3}M${x + 3} ${y + 9.5}H${x + w - 3}M${x + 3} ${y + 14}H${x + w - 7}`, "var(--d)", 1.3, 'opacity=".55"') +
  `</g>`;

// ---- poses -----------------------------------------------------------------------------------------------------------

function pose(c, status) {
  const { role, b, cx } = c;
  const [slx, sly] = c.shoulderL;
  const [srx, sry] = c.shoulderR;
  const out = { face: "", back: "", front: "", arms: "", tilt: "", tapRight: false };

  switch (status) {
    case "idle": {
      out.tilt = `rotate(-6 ${cx} ${c.bottom + 10})`;
      out.face = eyes(c, "sleep") + mouth(c, "o");
      out.arms = arm([slx, sly], [slx - 3, sly + 22], [-5, 2]) + arm([srx, sry], [srx + 2, sry + 22], [5, 2]);
      const z = (x, y, s, cls) => `<path class="ps-zz ${cls}" d="M${x} ${y}h${5 * s}l${-5 * s} ${6 * s}h${5 * s}" style="fill:none;stroke:var(--k);stroke-width:${f1(1.7 / s)};stroke-linecap:round;stroke-linejoin:round" opacity=".65" transform="translate(0 0)"/>`;
      out.front = z(66, 24, 0.85, "ps-zz1") + z(74, 14, 1.1, "ps-zz2") + z(83, 3, 1.35, "ps-zz3");
      break;
    }
    case "queued": {
      out.tapRight = true;
      out.face = eyes(c, "left") + mouth(c, "flat");
      out.arms =
        arm([slx, sly], [slx - 7, sly + 13], [-6, 4]) +
        `<g transform="rotate(-14 ${slx - 11} ${sly + 9})"><rect x="${slx - 19}" y="${sly + 4}" width="14" height="10" rx="2" ${st("var(--s)", "var(--d)", 1.5)}/><circle cx="${slx - 19}" cy="${sly + 9}" r="2" ${st("var(--w)")}/><circle cx="${slx - 5}" cy="${sly + 9}" r="2" ${st("var(--w)")}/></g>` +
        arm([srx, sry], [srx - 4, sry + 14], [10, 2]);
      out.front =
        `<g class="ps-think"><rect x="64" y="8" width="29" height="15" rx="7.5" ${st("var(--s)", "var(--d)", 1.7)}/>` +
        `<circle class="ps-dot1" cx="72" cy="15.5" r="2" ${st("var(--k)")}/><circle class="ps-dot2" cx="78.5" cy="15.5" r="2" ${st("var(--k)")}/><circle class="ps-dot3" cx="85" cy="15.5" r="2" ${st("var(--k)")}/>` +
        `<circle cx="62" cy="27" r="2.6" ${st("var(--s)", "var(--d)", 1.3)}/><circle cx="58" cy="32" r="1.7" ${st("var(--s)", "var(--d)", 1.2)}/></g>`;
      break;
    }
    case "working": {
      out.face = eyes(c, "down") + mouth(c, "flat");
      if (role === "lead") {
        out.arms = arm([slx, sly], [cx - 16, sly + 31], [-10, 0]);
        out.front =
          clipboard(cx - 17, sly + 21, 34, 27) +
          `<g class="ps-write">${arm([srx, sry], [cx + 12, sly + 37], [10, 4])}<path d="M${f1(cx + 12)} ${sly + 37}l4 -9" style="fill:none;stroke:var(--warn);stroke-width:2.4;stroke-linecap:round"/></g>`;
      } else if (role === "planner") {
        out.arms = arm([slx, sly], [cx - 21, sly + 32], [-6, 4]) + arm([srx, sry], [cx + 21, sly + 32], [6, 4]);
        out.front =
          `<g><path d="M${cx - 26} ${sly + 28}L${cx - 9} ${sly + 25}L${cx + 9} ${sly + 29}L${cx + 26} ${sly + 25}V${sly + 45}L${cx + 9} ${sly + 49}L${cx - 9} ${sly + 45}L${cx - 26} ${sly + 49}Z" ${st("var(--s)", "var(--d)", 1.8)}/>` +
          line(`M${cx - 9} ${sly + 25}V${sly + 45}M${cx + 9} ${sly + 29}V${sly + 49}`, "var(--d)", 1.1, 'opacity=".45"') +
          `<path class="ps-route" d="M${cx - 20} ${sly + 42}Q${cx - 12} ${sly + 30} ${cx - 2} ${sly + 39}T${cx + 18} ${sly + 33}" style="fill:none;stroke:var(--bad);stroke-width:1.8;stroke-linecap:round;stroke-dasharray:3 3"/>` +
          `<circle class="ps-pin" cx="${cx + 18}" cy="${sly + 33}" r="2.8" ${st("var(--bad)")}/></g>`;
      } else if (role === "builder") {
        const hand = [srx + 3, sry - 6];
        out.arms = arm([slx, sly], [cx - 8, sly + 33], [-8, 2]);
        out.front =
          `<rect x="${cx - 17}" y="${sly + 31}" width="26" height="6" rx="2" ${st("var(--w)", "var(--d)", 1.4)}/>` +
          `<g class="ps-hammer" style="transform-origin:${origin(hand)}">${arm([srx, sry], hand, [9, 2])}` +
          `<rect x="${f1(hand[0] - 1.8)}" y="${f1(hand[1] - 26)}" width="3.6" height="26" rx="1.8" ${st("var(--w)", "var(--d)", 1.2)}/>` +
          `<rect x="${f1(hand[0] - 7.5)}" y="${f1(hand[1] - 31)}" width="15" height="8.5" rx="2.4" ${st("var(--k)", "var(--d)", 1)}/></g>` +
          sparkle(cx - 6, sly + 24, 5, "var(--warn)", "ps-spark1");
      } else {
        const lens = [srx + 4, sly + 12];
        out.arms = arm([slx, sly], [slx - 4, sly + 26], [-4, 3]);
        out.front =
          paper(slx - 14, sly + 17, 22, 26, -6) +
          `<g class="ps-scan">${arm([srx, sry], [lens[0] + 5, lens[1] + 22], [8, 4])}` +
          `<path d="M${f1(lens[0] + 6)} ${f1(lens[1] + 9)}L${f1(lens[0] + 12)} ${f1(lens[1] + 20)}" style="fill:none;stroke:var(--d);stroke-width:4.4;stroke-linecap:round"/>` +
          `<circle cx="${f1(lens[0])}" cy="${f1(lens[1])}" r="11.5" style="fill:var(--s);fill-opacity:.35;stroke:var(--d);stroke-width:3.4"/>` +
          `<path d="M${f1(lens[0] - 6)} ${f1(lens[1] - 3)}Q${f1(lens[0] - 4)} ${f1(lens[1] - 7)} ${f1(lens[0] + 1)} ${f1(lens[1] - 8)}" style="fill:none;stroke:var(--s);stroke-width:2;stroke-linecap:round"/></g>`;
      }
      break;
    }
    case "waiting_approval": {
      out.face = eyes(c, "wide") + mouth(c, "o");
      const raised = [slx - 8, sly - 26];
      out.arms =
        `<g class="ps-wave" style="transform-origin:${origin([slx, sly])}">${arm([slx, sly], raised, [-9, 2])}` +
        `<circle cx="${f1(raised[0] - 4)}" cy="${f1(raised[1] - 3)}" r="1.9" ${st("var(--a)")}/><circle cx="${f1(raised[0])}" cy="${f1(raised[1] - 5.5)}" r="1.9" ${st("var(--a)")}/><circle cx="${f1(raised[0] + 4)}" cy="${f1(raised[1] - 3)}" r="1.9" ${st("var(--a)")}/></g>` +
        arm([srx, sry], [srx + 2, sry + 15], [8, 0]);
      out.front =
        paper(srx - 3, sry + 8, 17, 22, 8) +
        `<g class="ps-ask"><path d="M66 27l-3.5 8.5l10 -7z" ${st("var(--s)", "var(--warn)", 2.2)}/>` +
        `<rect x="66" y="3" width="30" height="26" rx="10" ${st("var(--s)", "var(--warn)", 2.6)}/>` +
        `<path d="M66.5 26.5l-2 5l7 -4.5z" ${st("var(--s)")}/>` +
        `<path d="M75 12.4c0-3.4 2.3-5.4 5-5.4s5 1.8 5 4.6c0 4-5 3.9-5 8.4" style="fill:none;stroke:var(--warn);stroke-width:3.2;stroke-linecap:round"/>` +
        `<circle cx="80" cy="23.2" r="2" ${st("var(--warn)")}/></g>`;
      break;
    }
    case "held": {
      out.face = eyes(c, "open") + mouth(c, "flat");
      const hand = [srx + 3, sry - 9];
      out.arms = hang(c, "l") + arm([srx, sry], hand, [8, 0]);
      out.front =
        `<rect x="${f1(hand[0] - 1.6)}" y="26" width="3.2" height="${f1(hand[1] - 24)}" rx="1.6" ${st("var(--w)", "var(--d)", 1.1)}/>` +
        `<rect x="${f1(hand[0] - 16)}" y="6" width="32" height="22" rx="6" ${st("var(--accent)", "var(--d)", 2)}/>` +
        `<text x="${f1(hand[0])}" y="21" text-anchor="middle" style="font:800 10.5px var(--font-display);fill:var(--accent-ink);letter-spacing:.3px">HOLD</text>` +
        `<path d="M${b.x - 9} ${b.y + 8}l3 3l-3 3l-3 -3z" ${st("var(--accent)")} opacity=".75"/><path d="M${b.x - 5} ${b.y + 44}l2.6 2.6l-2.6 2.6l-2.6 -2.6z" ${st("var(--accent)")} opacity=".75"/>`;
      break;
    }
    case "blocked": {
      out.face = eyes(c, "squint") + mouth(c, "wavy");
      const scratch = [cx - b.w / 2 + 9, b.y - 3];
      out.arms =
        `<g class="ps-scratch" style="transform-origin:${origin([slx, sly])}">${arm([slx, sly], scratch, [-12, -2])}</g>` + arm([srx, sry], [srx + 3, sry + 22], [5, 1]);
      const puff = (x, y, r, cls) => `<circle class="ps-puff ${cls}" cx="${x}" cy="${y}" r="${r}" ${st("var(--s)", "var(--d)", 1.3)} opacity=".92"/>`;
      out.back = puff(cx - 3, b.y - 12, 4.3, "ps-puff1") + puff(cx + 5, b.y - 16, 3.4, "ps-puff2") + puff(cx - 10, b.y - 17, 2.8, "ps-puff3");
      out.front =
        `<path d="M${b.x + b.w + 1} ${b.y + 4}q3 5 0 7.5q-3 -2.5 0 -7.5z" ${st("var(--role-planner)")} opacity=".85"/>` +
        `<g class="ps-badge"><path d="M82 5.5L94.5 27.5H69.5Z" ${st("var(--bad)", "var(--bad)", 4)} stroke-linejoin="round"/>` +
        `<rect x="80.6" y="12.5" width="2.8" height="8" rx="1.4" ${st("var(--accent-ink)")}/><circle cx="82" cy="24" r="1.7" ${st("var(--accent-ink)")}/></g>` +
        line(`M${b.x - 8} ${b.y + 22}l4 -4l-3 -1l4 -5`, "var(--warn)", 2, 'class="ps-zap"');
      break;
    }
    case "done": {
      out.face = eyes(c, "happy") + mouth(c, "grin");
      const hand = [srx + 5, sry - 20];
      out.arms =
        arm([srx, sry], hand, [9, 0]) +
        `<path d="M${f1(hand[0] - 1)} ${f1(hand[1] - 3)}l1.5 -9" style="fill:none;stroke:var(--a);stroke-width:5.2;stroke-linecap:round"/>` +
        arm([slx, sly], [slx - 3, sly + 20], [-6, 2]);
      out.front =
        `<g class="ps-stamp-prop"><rect x="${slx - 14}" y="${sly + 14}" width="7" height="10" rx="3" ${st("var(--d)")}/><rect x="${slx - 18}" y="${sly + 23}" width="15" height="5.5" rx="2" ${st("var(--good)", "var(--d)", 1.4)}/></g>` +
        sparkle(14, 28, 6, "var(--warn)", "ps-spark1") +
        sparkle(90, 66, 5, "var(--good)", "ps-spark2") +
        sparkle(12, 66, 4, "var(--accent)", "ps-spark3");
      break;
    }
    case "failed": {
      out.tilt = `rotate(5 ${cx} ${c.bottom + 10})`;
      out.face = eyes(c, "x") + mouth(c, "frown");
      out.arms = arm([slx, sly], [slx - 2, sly + 24], [-4, 3]) + arm([srx, sry], [srx + 2, sry + 24], [4, 3]);
      out.front =
        `<g class="ps-badge"><circle cx="83" cy="17" r="11.5" ${st("var(--bad)", "var(--bad)", 1)}/>` +
        line("M78 12L88 22M88 12L78 22", "var(--accent-ink)", 3) +
        `</g>` +
        `<path d="M${b.x - 4} ${b.y + 40}q-2 6 0 9q3 -3 0 -9z" ${st("var(--role-planner)")} opacity=".7"/>`;
      break;
    }
    default:
      out.face = eyes(c, "open") + mouth(c, "flat");
      out.arms = hang(c, "l") + hang(c, "r");
  }
  return out;
}

/** Inline SVG markup for one role in one pose. Unknown role or status fall back to builder / idle. */
export function characterSvg(role, status, { size = 64 } = {}) {
  const r = pick(role, CHARACTER_ROLES, FALLBACK_ROLE);
  const s = pick(status, CHARACTER_STATUSES, FALLBACK_STATUS);
  const px = Number.isFinite(size) ? Math.round(Math.min(1024, Math.max(16, size))) : 64;
  const c = makeContext(r);
  const p = pose(c, s);
  const base = `var(--role-${r})`;
  const vars = [
    `--b:${base}`,
    `--d:color-mix(in srgb,${base} 52%,var(--screen-bg,var(--ink)))`,
    `--a:color-mix(in srgb,${base} 76%,var(--screen-bg,var(--ink)))`,
    `--l:color-mix(in srgb,${base} 45%,var(--surface))`,
    `--p:color-mix(in srgb,var(--screen-bg,var(--ink)) 90%,${base})`,
    `--h:color-mix(in srgb,${base} 22%,var(--surface))`,
    `--w:color-mix(in srgb,var(--warn) 45%,var(--surface))`,
    "--e:var(--screen-fg,var(--surface))",
    "--k:var(--ink)",
    "--s:var(--surface)",
  ].join(";");
  const label = `${ROLE_NAMES[r]}, ${STATUS_NAMES[s]}`;
  const feet = p.tilt ? `<g transform="${p.tilt}">` : "<g>";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${px}" height="${px}" role="img" aria-label="${label}" ` +
    `class="ps-char-svg" data-role="${r}" data-status="${s}" style="${vars}">` +
    `<ellipse cx="50" cy="92" rx="24" ry="4" style="fill:var(--screen-bg,var(--ink))" opacity=".18"/>` +
    p.back +
    `<g class="ps-figure">${feet}${legs(c, p.tapRight)}${body(c)}${emblem(c)}${p.face}${headgear(c)}${p.arms}</g></g>` +
    p.front +
    `</svg>`
  );
}
