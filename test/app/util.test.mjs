import test from "node:test";
import assert from "node:assert/strict";
import { h, cleanKids, fuzzyMatch, fuzzyFilter, classifyDiffLine, parseDiff, formatElapsed, formatTokens, formatMb, percent, pluralize, truncate, parseList, joinPath } from "../../public/panels/util.js";

// A just-big-enough fake DOM so h() can be exercised without a DOM library.
function fakeDocument() {
  class Node {
    constructor(name, type = 1) {
      this.nodeName = name;
      this.nodeType = type;
      this.children = [];
      this.attrs = {};
      this.listeners = {};
      this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
      this.className = "";
      this.textContent = "";
    }
    appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  }
  return {
    createElement: (n) => new Node(n),
    createElementNS: (_ns, n) => new Node(n),
    createTextNode: (t) => Object.assign(new Node("#text", 3), { textContent: String(t) }),
  };
}

test("h builds elements, classes, listeners and nested children", () => {
  globalThis.document = fakeDocument();
  let clicked = 0;
  const el = h("button", { class: ["btn", false, "btn-primary"], "aria-label": "Go", disabled: false, onClick: () => clicked++, "data-fk": "x", style: { width: "10px" } }, "Go ", [h("span", {}, "inner"), null], 7);
  assert.equal(el.className, "btn btn-primary");
  assert.equal(el.attrs["aria-label"], "Go");
  assert.equal(el.attrs["data-fk"], "x");
  assert.equal(el.style.props.width, "10px");
  assert.ok(!("disabled" in el.attrs));
  el.listeners.click[0]();
  assert.equal(clicked, 1);
  assert.deepEqual(el.children.map((c) => c.nodeName), ["#text", "span", "#text"]);
  assert.equal(el.children[2].textContent, "7");
});

test("h never parses untrusted strings as markup", () => {
  globalThis.document = fakeDocument();
  const evil = '<img src=x onerror="alert(1)"><script>boom()</script>';
  const el = h("p", { title: evil }, evil);
  assert.equal(el.children.length, 1);
  assert.equal(el.children[0].nodeType, 3);
  assert.equal(el.children[0].textContent, evil);
  assert.equal(el.attrs.title, evil);
  assert.ok(!("innerHTML" in el));
});

test("h treats a non-props second argument as a child", () => {
  globalThis.document = fakeDocument();
  const inner = h("b", {}, "x");
  const el = h("p", inner, "tail");
  assert.deepEqual(el.children.map((c) => c.nodeName), ["b", "#text"]);
});

test("fuzzyMatch: subsequence, every term, ranking", () => {
  assert.equal(fuzzyMatch("zzz", "Hold all agents"), null);
  assert.ok(fuzzyMatch("hld", "Hold all agents"));
  assert.ok(fuzzyMatch("hold all", "Hold all agents"));
  assert.equal(fuzzyMatch("hold xyz", "Hold all agents"), null);
  assert.deepEqual(fuzzyMatch("", "anything"), { score: 0, indices: [] });
  const tight = fuzzyMatch("res", "Resume all");
  const loose = fuzzyMatch("res", "Open the review screen");
  assert.ok(tight.score > loose.score);
  assert.deepEqual(fuzzyMatch("hol", "Hold").indices, [0, 1, 2]);
});

test("fuzzyFilter ranks, keeps stable order on ties, and keeps everything for an empty query", () => {
  const items = ["Open help", "Hold all", "Resume all", "Replay this run"];
  assert.deepEqual(fuzzyFilter(items, "").map((r) => r.item), items);
  assert.equal(fuzzyFilter(items, "hold")[0].item, "Hold all");
  assert.deepEqual(fuzzyFilter(items, "all").map((r) => r.item), ["Hold all", "Resume all"]);
  assert.deepEqual(fuzzyFilter(items, "qqq"), []);
  const objs = [{ label: "New run" }, { label: "Replay" }];
  assert.equal(fuzzyFilter(objs, "rep", (o) => o.label)[0].item.label, "Replay");
});

test("classifyDiffLine", () => {
  assert.equal(classifyDiffLine("@@ -1,2 +1,3 @@"), "hunk");
  assert.equal(classifyDiffLine("+++ b/a.js"), "meta");
  assert.equal(classifyDiffLine("--- a/a.js"), "meta");
  assert.equal(classifyDiffLine("diff --git a/a b/a"), "meta");
  assert.equal(classifyDiffLine("+const x = 1;"), "add");
  assert.equal(classifyDiffLine("-const x = 0;"), "del");
  assert.equal(classifyDiffLine(" context"), "ctx");
  assert.equal(classifyDiffLine("\\ No newline at end of file"), "meta");
  assert.equal(classifyDiffLine("--- a removed sql comment", true), "del");
  assert.equal(classifyDiffLine("+++ an added line starting with ++", true), "add");
});

test("parseDiff classifies by hunk and caps long diffs", () => {
  const diff = ["--- a/x.js", "+++ b/x.js", "@@ -1,2 +1,2 @@", " keep", "-- old comment", "+new", ""].join("\n");
  const { lines, hidden } = parseDiff(diff);
  assert.deepEqual(lines.map((l) => l.kind), ["meta", "meta", "hunk", "ctx", "del", "add"]);
  assert.equal(hidden, 0);
  const big = parseDiff("@@\n" + Array.from({ length: 50 }, (_, i) => "+l" + i).join("\n"), 10);
  assert.equal(big.lines.length, 10);
  assert.equal(big.hidden, 41);
  assert.deepEqual(parseDiff(""), { lines: [{ kind: "ctx", text: "" }], hidden: 0 });
});

test("cleanKids drops null/undefined/booleans and flattens", () => {
  assert.deepEqual(cleanKids([null, "a", [undefined, "b", [false, "c", true]], 0]), ["a", "b", "c", 0]);
  assert.deepEqual(cleanKids([]), []);
});

test("formatElapsed", () => {
  assert.equal(formatElapsed(0), "0:00");
  assert.equal(formatElapsed(7000), "0:07");
  assert.equal(formatElapsed(65000), "1:05");
  assert.equal(formatElapsed(3725000), "1:02:05");
  assert.equal(formatElapsed(-5), "0:00");
  assert.equal(formatElapsed(NaN), "0:00");
});

test("formatTokens and percent say unknown rather than guess", () => {
  assert.equal(formatTokens(null), "unknown");
  assert.equal(formatTokens(undefined), "unknown");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(136000), "136k");
  assert.equal(formatTokens(2500000), "2.5M");
  assert.equal(percent(50, 200), 25);
  assert.equal(percent(5, 0), null);
  assert.equal(percent(null, 100), null);
  assert.equal(percent(300, 100), 100);
});

test("formatMb shows - for unknown", () => {
  assert.equal(formatMb(null), "-");
  assert.equal(formatMb(undefined), "-");
  assert.equal(formatMb(NaN), "-");
  assert.equal(formatMb(412.4), "412 MB");
  assert.equal(formatMb(1536), "1.5 GB");
  assert.equal(formatMb(2048), "2 GB");
  assert.equal(formatMb(0), "0 MB");
});

test("pluralize, truncate, parseList, joinPath", () => {
  assert.equal(pluralize(1, "order"), "1 order");
  assert.equal(pluralize(3, "order"), "3 orders");
  assert.equal(pluralize(2, "entry", "entries"), "2 entries");
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello world", 6), "hello\u2026");
  assert.equal(truncate(null, 5), "");
  assert.deepEqual(parseList(" a.js, b.js\nc.js\n\na.js "), ["a.js", "b.js", "c.js"]);
  assert.deepEqual(parseList(undefined), []);
  assert.equal(joinPath("/p/q/", "src/a.js"), "/p/q/src/a.js");
  assert.equal(joinPath("/p", "/abs/a.js"), "/abs/a.js");
  assert.equal(joinPath("", "a.js"), "a.js");
});
