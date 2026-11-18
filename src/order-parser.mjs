// Parses the Lead's reply into work orders. Model output is untrusted: everything is validated, clipped and
// stripped of control characters. Tolerates fenced JSON, prose around the JSON, and bare arrays.

export const ROLES_FOR_ORDERS = ["planner", "builder", "checker"];
const MAX_ORDERS = 8;

const clean = (s, max) =>
  String(s ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);

/** Every balanced {...} or [...] substring that starts at a "{" or "[" (strings and escapes respected). */
function balancedCandidates(text, limit = 24) {
  const out = [];
  for (let i = 0; i < text.length && out.length < limit; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          out.push(text.slice(i, j + 1));
          break;
        }
      }
    }
  }
  return out;
}

function candidates(text) {
  const list = [];
  const fence = /```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text))) list.push(m[1].trim());
  list.push(text.trim());
  list.push(...balancedCandidates(text));
  return list;
}

function toOrderList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray(value.orders)) return value.orders;
  return null;
}

function normalizeOrder(raw, warnings, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push(`Order ${index + 1} was not an object and was skipped.`);
    return null;
  }
  const prompt = clean(raw.prompt ?? raw.instructions ?? raw.description, 4000);
  let title = clean(raw.title ?? raw.name, 120);
  if (!title && prompt) title = clean(prompt.split("\n")[0], 80);
  if (!title) {
    warnings.push(`Order ${index + 1} had no title or prompt and was skipped.`);
    return null;
  }
  let role = clean(raw.ownerRole ?? raw.role, 20).toLowerCase();
  if (!ROLES_FOR_ORDERS.includes(role)) {
    if (role) warnings.push(`Order "${title}" had unknown role "${role}"; using builder.`);
    role = "builder";
  }
  const files = Array.isArray(raw.allowedFiles) ? raw.allowedFiles : typeof raw.allowedFiles === "string" ? [raw.allowedFiles] : [];
  return {
    title,
    ownerRole: role,
    allowedFiles: files.map((f) => clean(f, 200)).filter(Boolean).slice(0, 40),
    acceptance: clean(raw.acceptance, 1000),
    prompt: prompt || title,
    dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn.filter((d) => typeof d === "string" || typeof d === "number").slice(0, 20) : [],
  };
}

/**
 * @returns {{ ok: true, orders: object[], warnings: string[] } | { ok: false, error: string }}
 * Each order: { title, ownerRole, allowedFiles, acceptance, prompt, dependsOn } where dependsOn is still raw
 * (1-based positions or titles); use resolveDependsOn() once ids are assigned.
 */
export function parseOrders(text) {
  if (typeof text !== "string" || !text.trim()) return { ok: false, error: "The Lead returned no text." };
  const seen = new Set();
  for (const cand of candidates(text)) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    let parsed;
    try {
      parsed = JSON.parse(cand);
    } catch {
      continue;
    }
    const list = toOrderList(parsed);
    if (!list) continue;
    const warnings = [];
    const orders = list.map((o, i) => normalizeOrder(o, warnings, i)).filter(Boolean);
    if (orders.length === 0) continue;
    if (orders.length > MAX_ORDERS) warnings.push(`The Lead proposed ${orders.length} orders; kept the first ${MAX_ORDERS}.`);
    return { ok: true, orders: orders.slice(0, MAX_ORDERS), warnings };
  }
  return { ok: false, error: "Could not find a JSON object with an \"orders\" array in the Lead's reply." };
}

/**
 * Turn raw dependsOn entries into order ids. `orders` are the parsed orders (same order as `ids`).
 * Numbers (or numeric strings) are 1-based positions; other strings match a title (case-insensitive) or an id.
 * Unknown and self references are dropped.
 */
export function resolveDependsOn(orders, ids) {
  return orders.map((order, idx) =>
    [
      ...new Set(
        (order.dependsOn ?? [])
          .map((d) => {
            if (typeof d === "number" || (typeof d === "string" && /^\d+$/.test(d.trim()))) return ids[Number(d) - 1];
            const s = String(d).trim().toLowerCase();
            const byId = ids.find((id) => id.toLowerCase() === s);
            if (byId) return byId;
            const pos = orders.findIndex((o) => o.title.toLowerCase() === s);
            return pos >= 0 ? ids[pos] : undefined;
          })
          .filter((id) => id && id !== ids[idx]),
      ),
    ],
  );
}

/** Returns the id of an order that is part of a dependency cycle, or null. deps: Map<id, id[]>. */
export function findCycle(deps) {
  const state = new Map();
  const visit = (id) => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return id;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      const hit = visit(d);
      if (hit) return hit;
    }
    state.set(id, 2);
    return null;
  };
  for (const id of deps.keys()) {
    const hit = visit(id);
    if (hit) return hit;
  }
  return null;
}
