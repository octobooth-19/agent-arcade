// Pure helpers plus the tiny DOM builder used by every panel.
// Nothing in the app parses HTML: untrusted text (agents, models, files, diffs) only ever reaches the page through
// textContent / text nodes created here. The single innerHTML in the app is the studio's characterSvg() (see app.js).

const SVG_NS = "http://www.w3.org/2000/svg";
const VALUE_PROPS = new Set(["checked", "selected", "disabled", "hidden", "open", "required", "readOnly", "multiple"]);

const isNode = (v) => v !== null && typeof v === "object" && typeof v.nodeType === "number";
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !isNode(v);
const kebab = (s) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

function appendAll(el, kids, doc) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) appendAll(el, c, doc);
    else if (isNode(c)) el.appendChild(c);
    else el.appendChild(doc.createTextNode(String(c)));
  }
}

function build(el, props, children, doc, svg) {
  let value;
  let hasValue = false;
  if (props !== null && props !== undefined && !isPlain(props)) {
    children = [props, ...children];
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class" || k === "className") {
      const cls = Array.isArray(v) ? v.filter(Boolean).join(" ") : String(v);
      if (svg) el.setAttribute("class", cls);
      else el.className = cls;
    } else if (k === "style" && isPlain(v)) {
      for (const [name, val] of Object.entries(v)) el.style.setProperty(name, String(val));
    } else if (k === "dataset" && isPlain(v)) {
      for (const [name, val] of Object.entries(v)) if (val !== null && val !== undefined && val !== false) el.setAttribute("data-" + kebab(name), String(val));
    } else if (k === "text") {
      el.textContent = String(v);
    } else if (k.length > 2 && k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (!svg && k === "value") {
      value = v;
      hasValue = true;
    } else if (!svg && VALUE_PROPS.has(k)) {
      el[k] = !!v;
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
  appendAll(el, children, doc);
  // value goes last: <select> needs its options and <input type=range> its min/max first.
  if (hasValue) el.value = String(value);
  return el;
}

/** Flatten nested arrays and drop null/undefined/booleans, so native append()/replaceChildren() never print "null". */
export function cleanKids(kids) {
  const out = [];
  for (const k of kids) {
    if (k === null || k === undefined || k === false || k === true) continue;
    if (Array.isArray(k)) out.push(...cleanKids(k));
    else out.push(k);
  }
  return out;
}

/** h("button", { class: "btn", onClick: fn }, "Label", child, [more, children]) */
export function h(tag, props, ...children) {
  const doc = globalThis.document;
  return build(doc.createElement(tag), props, children, doc, false);
}

export function svgEl(tag, props, ...children) {
  const doc = globalThis.document;
  return build(doc.createElementNS(SVG_NS, tag), props, children, doc, true);
}

// ---- formatters -----------------------------------------------------------------------------------

/** 7000 -> "0:07", 65000 -> "1:05", 3725000 -> "1:02:05" */
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const hrs = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, "0");
  return hrs > 0 ? `${hrs}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Token counts: 950 -> "950", 12345 -> "12k", 136000 -> "136k", null -> "unknown" */
export function formatTokens(n) {
  if (!Number.isFinite(n)) return "unknown";
  if (n < 1000) return String(Math.round(n));
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1000000) return Math.round(n / 1000) + "k";
  return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
}

/** Memory: 412.4 -> "412 MB", 1536 -> "1.5 GB", unknown -> "-" */
export function formatMb(n) {
  if (!Number.isFinite(n) || n < 0) return "-";
  if (n >= 1024) return (n / 1024).toFixed(1).replace(/\.0$/, "") + " GB";
  return Math.round(n) + " MB";
}

/** Whole-number percentage, or null when it cannot be known. */
export function percent(used, size) {
  if (!Number.isFinite(used) || !Number.isFinite(size) || size <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((used / size) * 100)));
}

export function pluralize(n, one, many = one + "s") {
  return `${n} ${n === 1 ? one : many}`;
}

export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, Math.max(0, max - 1)) + "\u2026" : s;
}

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/** "a.js, b.js\nc.js" -> ["a.js", "b.js", "c.js"] (trimmed, de-duplicated, empties dropped) */
export function parseList(text) {
  const seen = new Set();
  const out = [];
  for (const part of String(text ?? "").split(/[\n,]/)) {
    const p = part.trim();
    if (p && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** "my-order_id" -> "My order id" */
export function humanize(s) {
  const t = String(s ?? "").replace(/[_-]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

/** Date or epoch/ISO string -> short local label; "" when unknown. */
export function formatWhen(v) {
  if (v === null || v === undefined || v === "") return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function joinPath(base, rel) {
  if (!base) return rel;
  if (!rel) return base;
  if (rel.startsWith("/")) return rel;
  return base.replace(/[\\/]+$/, "") + "/" + rel.replace(/^\.\//, "");
}

// ---- fuzzy matching (command palette) ---------------------------------------------------------------

function matchTerm(term, t) {
  let best = null;
  for (let start = t.indexOf(term[0]); start !== -1; start = t.indexOf(term[0], start + 1)) {
    const indices = [];
    let prev = -2;
    let score = 0;
    let ok = true;
    for (let qi = 0; qi < term.length; qi++) {
      const pos = qi === 0 ? start : t.indexOf(term[qi], prev + 1);
      if (pos === -1) {
        ok = false;
        break;
      }
      let s = 10;
      if (pos === prev + 1) s += 8;
      if (pos === 0 || !/[a-z0-9]/.test(t[pos - 1])) s += 10;
      if (prev >= 0) s -= Math.min(pos - prev - 1, 6);
      score += s;
      indices.push(pos);
      prev = pos;
    }
    if (!ok) break; // later starts cannot match more of the term than this one did
    score -= Math.min(indices[0], 10) * 0.3;
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

/** Subsequence match; every whitespace-separated term of the query must match. null when it does not. */
export function fuzzyMatch(query, text) {
  const t = String(text ?? "").toLowerCase();
  const terms = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, indices: [] };
  let score = 0;
  const all = new Set();
  for (const term of terms) {
    const m = matchTerm(term, t);
    if (!m) return null;
    score += m.score;
    for (const i of m.indices) all.add(i);
  }
  if (t.startsWith(terms[0])) score += 12;
  if (t.includes(terms.join(" "))) score += 15;
  return { score, indices: [...all].sort((a, b) => a - b) };
}

/** Filters and ranks items; ties keep their original order. Empty query keeps everything. */
export function fuzzyFilter(items, query, getText = (x) => String(x)) {
  const out = [];
  items.forEach((item, order) => {
    const m = fuzzyMatch(query, getText(item));
    if (m) out.push({ item, score: m.score, indices: m.indices, order });
  });
  return out.sort((a, b) => b.score - a.score || a.order - b.order);
}

// ---- unified diff -----------------------------------------------------------------------------------

function classifyInHunk(line) {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

/** Class of a single diff line. `inHunk` stops "-- comment" removals from looking like file headers. */
export function classifyDiffLine(line, inHunk = false) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("\\")) return "meta";
  if (inHunk) return classifyInHunk(line);
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (/^(diff |index |new file|deleted file|similarity |rename |old mode|new mode)/.test(line)) return "meta";
  return classifyInHunk(line);
}

/** Splits a unified diff into [{ kind, text }] and caps the length. Returns { lines, hidden }. */
export function parseDiff(text, maxLines = 600) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const lines = [];
  let inHunk = false;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    // A "--- x" + "+++ y" pair, or a "diff --git" line, always starts a new file section.
    if ((line.startsWith("--- ") && raw[i + 1]?.startsWith("+++ ")) || line.startsWith("diff --git")) inHunk = false;
    const kind = classifyDiffLine(line, inHunk);
    if (kind === "hunk") inHunk = true;
    if (lines.length < maxLines) lines.push({ kind, text: line });
  }
  return { lines, hidden: Math.max(0, raw.length - lines.length) };
}
