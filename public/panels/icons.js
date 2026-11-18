// Small stroke icons (16x16). Built with createElementNS, never from markup strings.
import { svgEl } from "./util.js";

// Each icon: list of [tag, attrs]. Stroke-only, currentColor, so they follow text color and the tokens.
const ICONS = {
  dot: [["circle", { cx: 8, cy: 8, r: 3 }]],
  clock: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M8 4.6V8l2.3 1.5" }]],
  play: [["path", { d: "M5.5 3.6v8.8L12.4 8z" }]],
  pause: [["path", { d: "M5.5 3.5v9M10.5 3.5v9" }]],
  check: [["path", { d: "M3.2 8.6l3.1 3.1 6.5-7.4" }]],
  x: [["path", { d: "M4 4l8 8M12 4l-8 8" }]],
  xcircle: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4" }]],
  alert: [["path", { d: "M8 2.4l6 10.6H2z" }], ["path", { d: "M8 6.6v3M8 11.3v.2" }]],
  question: [["circle", { cx: 8, cy: 8, r: 6 }], ["path", { d: "M6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3M8 11.4v.2" }]],
  bell: [["path", { d: "M4 11.2h8l-1.1-1.6V7a2.9 2.9 0 0 0-5.8 0v2.6z" }], ["path", { d: "M6.6 13.2a1.5 1.5 0 0 0 2.8 0" }]],
  arrow: [["path", { d: "M3 8h10M9 4l4 4-4 4" }]],
  copy: [["rect", { x: 5.5, y: 5.5, width: 7.5, height: 8, rx: 1.2 }], ["path", { d: "M3 10.5V3.8A1.3 1.3 0 0 1 4.3 2.5H9" }]],
  help: [["circle", { cx: 8, cy: 8, r: 6.2 }], ["path", { d: "M6.2 6.3a1.9 1.9 0 1 1 2.7 1.7c-.6.3-.9.7-.9 1.3M8 11.4v.2" }]],
  sound: [["path", { d: "M2.8 6.3h2.4L8.6 3.5v9L5.2 9.7H2.8z" }], ["path", { d: "M11 5.8a3.1 3.1 0 0 1 0 4.4M12.6 4.2a5.3 5.3 0 0 1 0 7.6" }]],
  mute: [["path", { d: "M2.8 6.3h2.4L8.6 3.5v9L5.2 9.7H2.8z" }], ["path", { d: "M11 6l3 4M14 6l-3 4" }]],
  search: [["circle", { cx: 7, cy: 7, r: 4.2 }], ["path", { d: "M10.2 10.2L13.5 13.5" }]],
  external: [["path", { d: "M6.5 3H3.5v9.5H13V9.5M9 3h4v4M13 3L7.6 8.4" }]],
  send: [["path", { d: "M2.5 8l11-5-4.2 11-2.2-4.6z" }]],
  edit: [["path", { d: "M3 13l.9-3.4 7.2-7.2 2.5 2.5-7.2 7.2z" }]],
  trash: [["path", { d: "M3.5 4.6h9M6.2 4.6V3h3.6v1.6M4.6 4.6l.6 8.4h5.6l.6-8.4" }]],
  plus: [["path", { d: "M8 3v10M3 8h10" }]],
  undo: [["path", { d: "M5 4L2.8 6.2 5 8.4" }], ["path", { d: "M3 6.2h5.6a3.4 3.4 0 0 1 0 6.8H6" }]],
  eye: [["path", { d: "M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" }], ["circle", { cx: 8, cy: 8, r: 1.9 }]],
  stage: [["path", { d: "M2 12.8h12M3.4 12.8V7L8 3.6 12.6 7v5.8" }], ["path", { d: "M6.4 12.8V9.6h3.2v3.2" }]],
  orders: [["path", { d: "M5.5 4.5h8M5.5 8h8M5.5 11.5h8" }], ["path", { d: "M2.6 4.5h.2M2.6 8h.2M2.6 11.5h.2" }]],
  inbox: [["path", { d: "M2.3 9.5l1.6-5.6h8.2l1.6 5.6V12.2H2.3z" }], ["path", { d: "M2.3 9.5h3.4l.6 1.6h3.4l.6-1.6h3.4" }]],
  inspector: [["rect", { x: 2.6, y: 2.6, width: 10.8, height: 10.8, rx: 2 }], ["path", { d: "M5.4 6h5.2M5.4 8.4h5.2M5.4 10.8h3" }]],
  hand: [["path", { d: "M5.2 8.2V3.9a1 1 0 0 1 2 0V7M7.2 6.2V3.2a1 1 0 0 1 2 0V7M9.2 6.6V4.2a1 1 0 0 1 2 0V9c0 2.4-1.6 4.2-3.9 4.2C5.4 13.2 4 12 3.2 10.4L2.6 9.2a1 1 0 0 1 1.7-1z" }]],
  merge: [["circle", { cx: 4.5, cy: 3.8, r: 1.6 }], ["circle", { cx: 4.5, cy: 12.2, r: 1.6 }], ["circle", { cx: 11.5, cy: 8, r: 1.6 }], ["path", { d: "M4.5 5.4v5.2M4.5 5.6c0 2.4 2.2 2.4 5.4 2.4" }]],
  spark: [["path", { d: "M8 2l1.4 4.2L13.6 7.6 9.4 9 8 13.2 6.6 9 2.4 7.6 6.6 6.2z" }]],
  chevron: [["path", { d: "M6 3.8L10.2 8 6 12.2" }]],
  list: [["path", { d: "M4.5 4.5h8.5M4.5 8h8.5M4.5 11.5h8.5" }], ["path", { d: "M2.3 4.5h.2M2.3 8h.2M2.3 11.5h.2" }]],
  record: [["circle", { cx: 8, cy: 8, r: 5.4 }], ["circle", { cx: 8, cy: 8, r: 1.8 }]],
  folder: [["path", { d: "M2.2 4.2h4l1.2 1.5h6.4v6.6H2.2z" }]],
  wrench: [["path", { d: "M10.4 2.6a3.2 3.2 0 0 0-3 4.4L2.8 11.6a1.4 1.4 0 0 0 2 2l4.6-4.6a3.2 3.2 0 0 0 4.4-3l-2 1.6-1.6-.6-.6-1.6z" }]],
  settings: [["path", { d: "M3 5h10M3 11h10" }], ["circle", { cx: 6, cy: 5, r: 1.5 }], ["circle", { cx: 10.5, cy: 11, r: 1.5 }]],
};

export function icon(name, { size = 16, label } = {}) {
  const spec = ICONS[name] ?? ICONS.dot;
  const props = {
    class: "icon icon-" + name,
    viewBox: "0 0 16 16",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 1.6,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    focusable: "false",
  };
  if (label) {
    props.role = "img";
    props["aria-label"] = label;
  } else {
    props["aria-hidden"] = "true";
  }
  return svgEl("svg", props, spec.map(([tag, attrs]) => svgEl(tag, attrs)));
}

export const hasIcon = (name) => name in ICONS;
