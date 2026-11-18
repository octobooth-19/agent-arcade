// Static furniture art for the studio, as SVG markup strings. All colors are CSS variables set in scene.css (derived from tokens.css),
// and nothing here ever contains user text, so these strings are safe to assign with innerHTML.

const ROLES = ["lead", "planner", "builder", "checker"];
const f1 = (n) => Math.round(n * 10) / 10;
const pts = (list) => list.map(([x, y]) => `${f1(x)},${f1(y)}`).join(" ");
const fill = (v, extra = "") => `style="fill:${v}${extra}"`;

// Desk geometry: a 52 x 32 slab, 14 high, projected isometrically into the 156 x 124 art box.
const CX = 69;
const CY = 82;
const P = (x, y, z) => [CX + (x - y) * 0.866, CY + (x + y) * 0.5 - z];
const TOP = 14;

function safeRole(role) {
  return ROLES.includes(role) ? role : "builder";
}

/** Chair, shadow: drawn BEHIND the character so an empty chair shows when the worker is away. */
export function deskBackSvg(role) {
  const r = safeRole(role);
  const c = `var(--role-${r})`;
  return (
    `<svg class="ps-svg" viewBox="0 0 156 124" width="156" height="124" aria-hidden="true" focusable="false">` +
    `<ellipse cx="78" cy="116" rx="66" ry="9" style="fill:var(--ps-screen-bg)" opacity=".16"/>` +
    `<rect x="53" y="38" width="50" height="46" rx="14" style="fill:color-mix(in srgb,${c} 40%,var(--ps-wood-dark));stroke:color-mix(in srgb,${c} 30%,var(--ink));stroke-width:2"/>` +
    `<rect x="58" y="44" width="40" height="34" rx="10" style="fill:color-mix(in srgb,${c} 28%,var(--surface))" opacity=".55"/>` +
    `</svg>`
  );
}

function glyphs(role) {
  const FG = "var(--ps-fg)";
  const g = (status, body) => `<g class="ps-g ps-g-${status}" transform="translate(50.2 64.5)">${body}</g>`;
  const stroke = (color, w = 2.4) => `style="fill:none;stroke:${color};stroke-width:${w};stroke-linecap:round;stroke-linejoin:round"`;
  const working = {
    lead: `<rect x="-7" y="-6.4" width="14" height="12.8" rx="2" ${fill(FG)}/><path d="M-4 -2.4h8M-4 .8h8M-4 4h5" ${stroke("var(--ps-screen-bg)", 1.5)}/><path class="ps-g-blink" d="M3.4 5l3 -3.4" ${stroke("var(--ps-g-warn)", 2)}/>`,
    planner: `<path d="M-9 -4l6 -2 6 2 6 -2v10l-6 2 -6 -2 -6 2z" ${fill(FG)}/><path class="ps-g-route" d="M-6 3q3 -8 6 -2t7 -3" style="fill:none;stroke:var(--ps-screen-bg);stroke-width:1.8;stroke-linecap:round;stroke-dasharray:2.4 2.2"/><circle cx="7" cy="-2" r="2" ${fill("var(--ps-g-bad)")}/>`,
    builder: `<path d="M-4 -4.5l-5 4.5 5 4.5M4 -4.5l5 4.5 -5 4.5" ${stroke("var(--ps-g-builder)", 2.2)}/><path class="ps-g-blink" d="M1.4 -6.5l-2.8 13" ${stroke(FG, 1.8)}/>`,
    checker: `<path d="M-8 -4l2.2 2.2 3.6 -4M-8 4.4l2.2 2.2 3.6 -4" ${stroke("var(--ps-g-good)", 2.2)}/><path d="M-1 -4.2h9M-1 4.6h9" ${stroke(FG, 1.8)} opacity=".85"/>`,
  };
  return (
    g("idle", `<path d="M-7 -5h6l-6 7h6" ${stroke(FG, 1.8)} opacity=".75"/><path d="M2 -2h4.5l-4.5 5.4h4.5" ${stroke(FG, 1.6)} opacity=".55"/>`) +
    g("queued", `<path d="M-5 -7h10M-5 7h10M-4 -7c0 6 3.5 5 4 7c-.5 2 -4 1 -4 7M4 -7c0 6 -3.5 5 -4 7c.5 2 4 1 4 7" ${stroke(FG, 1.8)}/><path d="M-2 5.6h4l-2 -2.2z" ${fill("var(--ps-g-warn)")}/>`) +
    g("working", working[safeRole(role)]) +
    g("waiting_approval", `<path d="M-4.2 -2.4c0 -3.4 2.2 -5 4.2 -5s4.2 1.5 4.2 3.8c0 3.2 -4.2 3.2 -4.2 6.4" ${stroke("var(--ps-g-warn)", 2.8)}/><circle cx="0" cy="6.8" r="1.8" ${fill("var(--ps-g-warn)")}/>`) +
    g("held", `<rect x="-6" y="-6.4" width="4.2" height="12.8" rx="1.4" ${fill("var(--ps-g-accent)")}/><rect x="1.8" y="-6.4" width="4.2" height="12.8" rx="1.4" ${fill("var(--ps-g-accent)")}/>`) +
    g("blocked", `<path d="M0 -7.6L8.4 6.6H-8.4Z" ${fill("var(--ps-g-bad)")}/><rect x="-1.1" y="-2.6" width="2.2" height="5" rx="1.1" ${fill("var(--ps-screen-bg)")}/><circle cx="0" cy="4.3" r="1.2" ${fill("var(--ps-screen-bg)")}/>`) +
    g("done", `<circle r="7.2" ${fill("var(--ps-g-good)")}/><path d="M-3.6 .2l2.6 2.8 4.6 -5.6" ${stroke("var(--ps-screen-bg)", 2.2)}/>`) +
    g("failed", `<circle r="7.2" ${fill("var(--ps-g-bad)")}/><path d="M-3 -3l6 6M3 -3l-6 6" ${stroke("var(--ps-screen-bg)", 2.2)}/>`)
  );
}

/** Desk slab, monitor (with a glyph per status, shown by CSS), mug. Drawn IN FRONT of the character. */
export function deskFrontSvg(role, { lead = false } = {}) {
  const r = safeRole(role);
  const c = `var(--role-${r})`;
  const T = P(0, 0, TOP);
  const R = P(52, 0, TOP);
  const B = P(52, 32, TOP);
  const L = P(0, 32, TOP);
  const L0 = P(0, 32, 0);
  const B0 = P(52, 32, 0);
  const R0 = P(52, 0, 0);
  const matA = P(9, 6, TOP);
  const matB = P(43, 6, TOP);
  const matC = P(43, 26, TOP);
  const matD = P(9, 26, TOP);
  const stripA = P(0, 32, TOP - 3.4);
  const stripB = P(52, 32, TOP - 3.4);
  const rstripA = P(52, 0, TOP - 3.4);
  const mug = P(40, 8, TOP);
  const paper = [P(26, 22, TOP), P(36, 22, TOP), P(36, 30, TOP), P(26, 30, TOP)];
  const extras = lead
    ? `<circle cx="${f1(P(46, 24, TOP)[0])}" cy="${f1(P(46, 24, TOP)[1] - 4)}" r="4.6" style="fill:var(--warn);stroke:var(--ps-wood-dark);stroke-width:1.2"/><rect x="${f1(P(46, 24, TOP)[0] - 5.6)}" y="${f1(P(46, 24, TOP)[1] - 0.4)}" width="11.2" height="2.6" rx="1.3" style="fill:var(--ps-wood-dark)"/>` +
      `<polygon points="${pts([P(0, 32, TOP), P(52, 32, TOP), P(52, 32, TOP - 1.8), P(0, 32, TOP - 1.8)])}" style="fill:var(--warn)" opacity=".9"/>`
    : "";
  return (
    `<svg class="ps-svg" viewBox="0 0 156 124" width="156" height="124" aria-hidden="true" focusable="false">` +
    `<polygon points="${pts([L, B, B0, L0])}" style="fill:var(--ps-wood-top);filter:brightness(.9);stroke:var(--ps-wood-dark);stroke-width:1.4;stroke-linejoin:round"/>` +
    `<polygon points="${pts([B, R, R0, B0])}" style="fill:var(--ps-wood-top);filter:brightness(.76);stroke:var(--ps-wood-dark);stroke-width:1.4;stroke-linejoin:round"/>` +
    `<polygon points="${pts([L, B, stripB, stripA])}" style="fill:${c}" opacity=".95"/>` +
    `<polygon points="${pts([B, R, rstripA, stripB])}" style="fill:${c};filter:brightness(.82)" opacity=".95"/>` +
    `<polygon points="${pts([T, R, B, L])}" style="fill:var(--ps-wood-top);stroke:var(--ps-wood-dark);stroke-width:1.4;stroke-linejoin:round"/>` +
    `<polygon points="${pts([matA, matB, matC, matD])}" style="fill:color-mix(in srgb,${c} 32%,var(--ps-wood-top))" opacity=".8"/>` +
    `<polygon points="${pts(paper)}" style="fill:var(--surface);stroke:var(--ps-wood-dark);stroke-width:.8"/>` +
    `<g><rect x="${f1(mug[0] - 4.2)}" y="${f1(mug[1] - 8)}" width="8.4" height="8" rx="2.2" style="fill:var(--surface);stroke:var(--ps-wood-dark);stroke-width:1.2"/><path d="M${f1(mug[0] + 4.2)} ${f1(mug[1] - 6)}q3.4 0 3.4 2.6t-3.4 2.6" style="fill:none;stroke:var(--ps-wood-dark);stroke-width:1.4"/></g>` +
    extras +
    `<g class="ps-monitor"><ellipse cx="50" cy="82.6" rx="9.5" ry="3.2" style="fill:var(--ps-wood-dark)"/><rect x="47.2" y="74" width="5.6" height="8" style="fill:var(--ps-wood-dark)"/>` +
    `<rect class="ps-bezel" x="35.5" y="53.5" width="29.5" height="22" rx="3.6" style="fill:var(--ps-screen-bg);stroke:var(--ps-wood-dark);stroke-width:1.2"/>` +
    `<rect class="ps-screen" x="38" y="56" width="24.4" height="16.8" rx="2" style="fill:color-mix(in srgb,var(--ps-screen-bg) 80%,${c})"/>` +
    glyphs(r) +
    `</g></svg>`
  );
}

export function doorSvg() {
  return (
    `<svg class="ps-svg" viewBox="0 0 100 150" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">` +
    `<rect x="9" y="22" width="82" height="126" rx="7" style="fill:var(--ps-wood-dark)"/>` +
    `<rect x="15" y="28" width="70" height="120" rx="4" style="fill:var(--ps-door-in)"/>` +
    `<path d="M15 148V45q0 -17 17 -17h36q17 0 17 17v103z" style="fill:var(--ps-glow)" opacity=".55"/>` +
    `<path d="M15 148l22 -12V40l-22 -12z" style="fill:var(--ps-wood-top);stroke:var(--ps-wood-dark);stroke-width:1.6;stroke-linejoin:round"/>` +
    `<circle cx="31" cy="92" r="2.4" style="fill:var(--warn)"/>` +
    `<path d="M40 148h42" style="stroke:var(--ps-glow);stroke-width:3;stroke-linecap:round" opacity=".7"/>` +
    `<rect x="4" y="144" width="92" height="6" rx="3" style="fill:var(--ps-mat)"/>` +
    `</svg>`
  );
}

export function windowSvg() {
  return (
    `<svg class="ps-svg" viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
    `<rect x="1.5" y="1.5" width="97" height="47" rx="5" style="fill:var(--ps-sky);stroke:var(--ps-wood-dark);stroke-width:3"/>` +
    `<path d="M50 2v46M2 25h96" style="stroke:var(--ps-wood-dark);stroke-width:2.4"/>` +
    `<path d="M8 20q8 -9 17 -2q7 -5 14 1q6 1 6 5H8z" style="fill:var(--surface)" opacity=".7"/>` +
    `</svg>`
  );
}

export function posterSvg() {
  return (
    `<svg class="ps-svg" viewBox="0 0 40 50" preserveAspectRatio="xMidYMid meet" aria-hidden="true" focusable="false">` +
    `<rect x="3" y="2" width="34" height="46" rx="3" style="fill:var(--surface);stroke:var(--ps-wood-dark);stroke-width:2"/>` +
    `<circle cx="20" cy="18" r="7.5" style="fill:var(--role-lead)" opacity=".8"/><path d="M8 40l8 -11 6 7 4 -4 8 8z" style="fill:var(--role-checker)" opacity=".75"/>` +
    `<path d="M9 44h22" style="stroke:var(--ink-soft);stroke-width:2;stroke-linecap:round" opacity=".6"/>` +
    `</svg>`
  );
}

export function clockSvg() {
  return (
    `<svg class="ps-svg" viewBox="0 0 40 40" aria-hidden="true" focusable="false">` +
    `<circle cx="20" cy="20" r="17" style="fill:var(--surface);stroke:var(--ps-wood-dark);stroke-width:3"/>` +
    `<path d="M20 9v11l7 4" style="fill:none;stroke:var(--ink);stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round"/>` +
    `</svg>`
  );
}

export function plantSvg() {
  return (
    `<svg class="ps-svg" viewBox="0 0 40 60" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">` +
    `<path d="M20 38C10 34 7 22 11 12c7 3 10 12 9 26z" style="fill:var(--role-checker)" opacity=".85"/>` +
    `<path d="M20 38c-2 -10 4 -22 12 -26c3 10 -1 22 -12 26z" style="fill:var(--good)" opacity=".85"/>` +
    `<path d="M20 38c-1 -9 -1 -19 0 -30" style="fill:none;stroke:var(--good);stroke-width:2.2;stroke-linecap:round"/>` +
    `<path d="M9 40h22l-3 17H12z" style="fill:var(--role-builder);stroke:var(--ps-wood-dark);stroke-width:1.6;stroke-linejoin:round"/>` +
    `</svg>`
  );
}

export function paperPlaneSvg() {
  return (
    `<svg viewBox="0 0 40 28" width="40" height="28" aria-hidden="true" focusable="false">` +
    `<path d="M2 12L38 2L26 26L19 16Z" style="fill:var(--surface);stroke:var(--ink);stroke-width:2;stroke-linejoin:round"/>` +
    `<path d="M38 2L19 16L18 25L26 26" style="fill:color-mix(in srgb,var(--accent) 30%,var(--surface));stroke:var(--ink);stroke-width:2;stroke-linejoin:round"/>` +
    `</svg>`
  );
}

export const STATUS_ICONS = {
  idle: `<path d="M3 4h5L3 11h5M10 2h3.5L10 7h3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
  queued: `<path d="M4 2h8M4 14h8M5 2c0 5 3 4.5 3 6s-3 1-3 6M11 2c0 5-3 4.5-3 6s3 1 3 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
  working: `<path d="M8 2v3M8 11v3M2 8h3M11 8h3M3.8 3.8l2 2M10.2 10.2l2 2M12.2 3.8l-2 2M5.8 10.2l-2 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`,
  waiting_approval: `<path d="M5.4 5.8c0-1.9 1.2-2.9 2.7-2.9s2.7 1 2.7 2.4c0 2.2-2.7 2.1-2.7 4.3" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="8.1" cy="12.9" r="1.1" fill="currentColor"/>`,
  held: `<rect x="3.6" y="3" width="3" height="10" rx="1" fill="currentColor"/><rect x="9.4" y="3" width="3" height="10" rx="1" fill="currentColor"/>`,
  blocked: `<path d="M8 2.2L14.4 13H1.6Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 6.4v3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11.3" r=".9" fill="currentColor"/>`,
  done: `<path d="M3 8.4l3.2 3.2L13 4.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
  failed: `<path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`,
};

export function statusIconSvg(status) {
  const body = Object.hasOwn(STATUS_ICONS, status) ? STATUS_ICONS[status] : STATUS_ICONS.idle;
  return `<svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true" focusable="false">${body}</svg>`;
}
