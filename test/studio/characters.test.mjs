import test from "node:test";
import assert from "node:assert/strict";
import { characterSvg, CHARACTER_ROLES, CHARACTER_STATUSES } from "../../public/studio/characters.js";
import { ROLES, WORKER_STATUSES } from "../../shared/state.js";

/** Walks the tags and checks they nest properly. SVG here is machine-made, so a small tokenizer is enough. */
function assertBalanced(svg, label) {
  const stack = [];
  for (const m of svg.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9]*)\b[^>]*?(\/?)>/g)) {
    const [, closing, tag, selfClose] = m;
    if (selfClose) continue;
    if (closing) {
      assert.equal(stack.pop(), tag, `${label}: </${tag}> closes the open tag`);
    } else {
      stack.push(tag);
    }
  }
  assert.deepEqual(stack, [], `${label}: every tag is closed`);
}

test("the character enums match the shared state contract", () => {
  assert.deepEqual(CHARACTER_ROLES, ROLES);
  assert.deepEqual(CHARACTER_STATUSES, WORKER_STATUSES);
});

test("characterSvg: every role x status gives valid, safe, labelled markup", () => {
  for (const role of CHARACTER_ROLES) {
    for (const status of CHARACTER_STATUSES) {
      const label = `${role}/${status}`;
      const svg = characterSvg(role, status);
      assert.equal(typeof svg, "string", label);
      assert.ok(svg.startsWith("<svg "), `${label} starts with <svg`);
      assert.ok(svg.endsWith("</svg>"), `${label} ends with </svg>`);
      assert.ok(svg.includes('viewBox="0 0 100 100"'), `${label} has a viewBox so it scales`);
      assert.ok(svg.includes(`data-role="${role}"`) && svg.includes(`data-status="${status}"`), `${label} records its pose`);
      assert.match(svg, /role="img" aria-label="[^"<>]+"/, `${label} has an accessible name`);
      assertBalanced(svg, label);
      assert.doesNotMatch(svg, /<script|<foreignObject|<iframe|<image|<use\b/i, `${label} has no active content`);
      assert.doesNotMatch(svg, /\son[a-z]+\s*=/i, `${label} has no event handlers`);
      assert.doesNotMatch(svg, /javascript:|href\s*=|url\(\s*["']?https?:/i, `${label} loads nothing`);
      assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), /https?:\/\//, `${label} has no external URLs`);
      assert.doesNotMatch(svg, /NaN|undefined|\[object/, `${label} has no leaked JS values`);
      assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,8}\b/, `${label} takes its colors from the CSS variables`);
    }
  }
});

test("characterSvg: poses differ by status and silhouettes differ by role", () => {
  for (const role of CHARACTER_ROLES) {
    const seen = new Set(CHARACTER_STATUSES.map((s) => characterSvg(role, s)));
    assert.equal(seen.size, CHARACTER_STATUSES.length, `${role}: eight different poses`);
  }
  for (const status of CHARACTER_STATUSES) {
    const seen = new Set(CHARACTER_ROLES.map((r) => characterSvg(r, status)));
    assert.equal(seen.size, CHARACTER_ROLES.length, `${status}: four different characters`);
  }
});

test("characterSvg: unknown or hostile role and status fall back and are never echoed", () => {
  const hostile = [
    '"><script>alert(1)</script>',
    "x' onload='alert(1)",
    "<img src=x onerror=alert(1)>",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "",
    "BUILDER",
    " builder",
    null,
    undefined,
    42,
    {},
    [],
    () => "builder",
  ];
  const fallback = characterSvg("builder", "idle");
  for (const bad of hostile) {
    const svg = characterSvg(bad, bad);
    assert.equal(svg, fallback, `fallback for ${typeof bad} ${String(bad).slice(0, 24)}`);
    if (typeof bad === "string" && bad) assert.ok(!svg.includes(bad), "hostile text is not in the markup");
    assert.equal(characterSvg("planner", bad), characterSvg("planner", "idle"), "bad status keeps a valid role");
    assert.equal(characterSvg(bad, "working"), characterSvg("builder", "working"), "bad role keeps a valid status");
  }
});

test("characterSvg: size is validated", () => {
  const w = (svg) => Number(/ width="(\d+)"/.exec(svg)[1]);
  assert.equal(w(characterSvg("lead", "idle")), 64);
  assert.equal(w(characterSvg("lead", "idle", { size: 128 })), 128);
  assert.equal(w(characterSvg("lead", "idle", { size: 3 })), 16);
  assert.equal(w(characterSvg("lead", "idle", { size: 99999 })), 1024);
  for (const bad of [NaN, Infinity, "<x>", "100", null, undefined, {}]) {
    assert.equal(w(characterSvg("lead", "idle", { size: bad })), 64, `size ${String(bad)} falls back to 64`);
  }
  assert.doesNotThrow(() => characterSvg("lead", "idle", undefined));
});

test("characterSvg: the pose class hooks the scene CSS animates are present", () => {
  const has = (role, status, cls) => characterSvg(role, status).includes(cls);
  assert.ok(has("builder", "working", "ps-hammer"));
  assert.ok(has("checker", "working", "ps-scan"));
  assert.ok(has("planner", "working", "ps-needle"));
  assert.ok(has("builder", "idle", "ps-zz"));
  assert.ok(has("builder", "waiting_approval", "ps-ask"));
  assert.ok(has("builder", "blocked", "ps-badge"));
  assert.ok(has("builder", "failed", "ps-badge"));
});
