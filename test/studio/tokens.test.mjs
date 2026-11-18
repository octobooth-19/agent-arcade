import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../../public/studio/${name}`, import.meta.url), "utf8");
const tokensCss = read("tokens.css");

const REQUIRED = [
  "bg", "surface", "surface-2", "ink", "ink-soft", "line", "accent", "accent-ink", "good", "warn", "bad",
  "role-lead", "role-planner", "role-builder", "role-checker", "radius", "radius-lg", "shadow",
  "font-display", "font-body", "font-mono", "stage",
];
const COLORS = ["bg", "surface", "surface-2", "ink", "ink-soft", "line", "accent", "accent-ink", "good", "warn", "bad", "role-lead", "role-planner", "role-builder", "role-checker", "stage", "screen-bg", "screen-fg"];

/** Returns the declarations of the first rule whose selector starts with `selector`. */
function block(css, selector) {
  const at = css.indexOf(selector);
  assert.ok(at >= 0, `found ${selector}`);
  const open = css.indexOf("{", at);
  const close = css.indexOf("}", open);
  const vars = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const light = block(tokensCss, ":root {");
const darkMedia = block(tokensCss, ":root:not([data-theme=\"light\"]) {");
const darkForced = block(tokensCss, ":root[data-theme=\"dark\"] {");
const dark = { ...light, ...darkMedia };

function lin(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  assert.ok(m, `${hex} is a 6-digit hex color`);
  const n = parseInt(m[1], 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("tokens: every variable the contract names is defined for light and dark", () => {
  for (const name of REQUIRED) {
    assert.ok(name in light, `light --${name}`);
    assert.ok(name in dark, `dark --${name}`);
  }
  for (const name of COLORS) {
    assert.match(light[name], /^#[0-9a-f]{6}$/i, `light --${name}`);
    assert.match(dark[name], /^#[0-9a-f]{6}$/i, `dark --${name}`);
  }
});

test("tokens: dark mode by media query and by data-theme='dark' are identical", () => {
  assert.deepEqual(darkForced, darkMedia);
});

for (const [theme, t] of [["light", light], ["dark", dark]]) {
  test(`tokens (${theme}): text meets WCAG AA 4.5:1`, () => {
    for (const fg of ["ink", "ink-soft"]) {
      for (const bg of ["bg", "surface", "surface-2", "stage"]) {
        const c = contrast(t[fg], t[bg]);
        assert.ok(c >= 4.5, `--${fg} on --${bg} is ${c.toFixed(2)}`);
      }
    }
    for (const bg of ["accent", "good", "warn", "bad"]) {
      const c = contrast(t["accent-ink"], t[bg]);
      assert.ok(c >= 4.5, `--accent-ink on --${bg} is ${c.toFixed(2)}`);
    }
    for (const fg of ["accent", "good", "warn", "bad"]) {
      const c = contrast(t[fg], t.surface);
      assert.ok(c >= 4.5, `--${fg} text on --surface is ${c.toFixed(2)}`);
    }
    const screen = contrast(t["screen-fg"], t["screen-bg"]);
    assert.ok(screen >= 7, `monitor glyph --screen-fg on --screen-bg is ${screen.toFixed(2)}`);
  });

  test(`tokens (${theme}): role colors stand out from the surface (3:1 for fills and outlines)`, () => {
    for (const r of ["role-lead", "role-planner", "role-builder", "role-checker"]) {
      const c = contrast(t[r], t.surface);
      assert.ok(c >= 3, `--${r} against --surface is ${c.toFixed(2)}`);
    }
  });
}

test("scene sources take every color from the tokens (no hard-coded hex, rgb or hsl)", () => {
  for (const file of ["scene.css", "characters.js", "furniture.js", "studio.js", "preview.css"]) {
    const text = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .filter((line) => !/-webkit-mask|mask:|mask-image/.test(line)) // masks only use alpha
      .join("\n");
    assert.doesNotMatch(text, /#[0-9a-fA-F]{3,8}\b/, `${file} has a hex color`);
    assert.doesNotMatch(text, /\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\(/, `${file} has a color function`);
  }
});

test("scene.css honors reduced motion and never loops forever on hidden pages", () => {
  const css = read("scene.css");
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.ps-reduced/);
  assert.match(css, /\.ps-paused[^{]*\{[^}]*animation-play-state: paused/);
});

test("studio sources use no animation loops or inline-HTML for state text", () => {
  for (const file of ["studio.js", "layout.js", "characters.js", "furniture.js", "sounds.js"]) {
    const text = read(file);
    assert.doesNotMatch(text, /requestAnimationFrame|setInterval/, `${file} has no loops`);
  }
  // innerHTML may only receive static art helpers
  const studio = read("studio.js");
  for (const m of studio.matchAll(/(\w+(?:\.\w+)*)\.innerHTML\s*=\s*([^;\n]+)/g)) {
    assert.match(m[2], /Svg\(|STEER_SVG|markup|\bart\(\)/, `innerHTML only takes static art: ${m[0]}`);
  }
});
