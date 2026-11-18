// Small unified-diff builder used to turn ACP edit content (oldText/newText) into worker.file events.

function splitLines(text) {
  if (text == null || text === "") return [];
  const lines = String(text).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((s) => ({ t: "+", s }));
  if (m === 0) return a.map((s) => ({ t: "-", s }));
  if (n * m > 4_000_000) return [...a.map((s) => ({ t: "-", s })), ...b.map((s) => ({ t: "+", s }))];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", s: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ t: "-", s: a[i++] });
    } else {
      ops.push({ t: "+", s: b[j++] });
    }
  }
  while (i < n) ops.push({ t: "-", s: a[i++] });
  while (j < m) ops.push({ t: "+", s: b[j++] });
  return ops;
}

function diffOps(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return [
    ...a.slice(0, s).map((x) => ({ t: " ", s: x })),
    ...lcsOps(a.slice(s, ea), b.slice(s, eb)),
    ...a.slice(ea).map((x) => ({ t: " ", s: x })),
  ];
}

/** Returns { diff, added, removed }. `diff` is "" when nothing changed. */
export function unifiedDiff(filePath, oldText, newText, ctx = 3) {
  const ops = diffOps(splitLines(oldText), splitLines(newText));
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === "+") added++;
    else if (o.t === "-") removed++;
  }
  if (!added && !removed) return { diff: "", added, removed };

  let ai = 0;
  let bi = 0;
  const rows = ops.map((o) => {
    const r = { ...o, a: ai, b: bi };
    if (o.t !== "+") ai++;
    if (o.t !== "-") bi++;
    return r;
  });
  const ranges = [];
  rows.forEach((o, i) => {
    if (o.t === " ") return;
    const s = Math.max(0, i - ctx);
    const e = Math.min(rows.length - 1, i + ctx);
    const last = ranges[ranges.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else ranges.push([s, e]);
  });

  const out = [`diff --git a/${filePath} b/${filePath}`];
  out.push(oldText ? `--- a/${filePath}` : "--- /dev/null", `+++ b/${filePath}`);
  for (const [s, e] of ranges) {
    const slice = rows.slice(s, e + 1);
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aLen ? slice[0].a + 1 : slice[0].a},${aLen} +${bLen ? slice[0].b + 1 : slice[0].b},${bLen} @@`);
    for (const o of slice) out.push(o.t + o.s);
  }
  return { diff: out.join("\n") + "\n", added, removed };
}
