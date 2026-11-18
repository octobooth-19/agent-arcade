// Process footprint samples (RSS via `ps`). These are estimates: summed RSS can overcount shared pages.
import { execFile } from "node:child_process";

export function parsePs(text) {
  const rows = [];
  for (const line of String(text).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]) });
  }
  return rows;
}

/** All descendants of rootPid (not including it). */
export function descendantsOf(rows, rootPid) {
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r);
  }
  const out = [];
  const stack = [rootPid];
  const seen = new Set([rootPid]);
  while (stack.length) {
    for (const k of kids.get(stack.pop()) ?? []) {
      if (seen.has(k.pid)) continue;
      seen.add(k.pid);
      out.push(k);
      stack.push(k.pid);
    }
  }
  return out;
}

const mb = (kb) => Math.round(kb / 1024);

export function summarize(rows, { serverPid, copilotPid }) {
  const server = rows.find((r) => r.pid === serverPid);
  const copilot = copilotPid ? rows.find((r) => r.pid === copilotPid) : null;
  const kids = copilotPid ? descendantsOf(rows, copilotPid) : [];
  return {
    serverMb: server ? mb(server.rssKb) : Math.round(process.memoryUsage().rss / 1048576),
    copilotMb: copilot ? mb(copilot.rssKb) : null,
    childrenMb: copilot ? mb(kids.reduce((a, r) => a + r.rssKb, 0)) : null,
  };
}

export function sampleMetrics({ serverPid = process.pid, copilotPid = null, sessions = null } = {}) {
  return new Promise((resolve) => {
    execFile("ps", ["-A", "-o", "pid=,ppid=,rss="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        return resolve({ serverMb: Math.round(process.memoryUsage().rss / 1048576), copilotMb: null, childrenMb: null, sessions });
      }
      resolve({ ...summarize(parsePs(stdout), { serverPid, copilotPid }), sessions });
    });
  });
}
