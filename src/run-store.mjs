// Run persistence: <project>/.arcade/runs/<runId>.json holds the run's events as a JSON array.
// Local only. Tool output can contain secrets, so files are created owner-readable only.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function newRunId(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Run ids start with a local timestamp (YYYYMMDD-HHMMSS); returns an ISO string or null. */
function startedFromId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function validRunId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

export class RunStore {
  constructor(projectDir) {
    this.dir = path.join(projectDir, ".arcade", "runs");
  }

  save(runId, events) {
    if (!validRunId(runId)) throw new Error("Invalid run id");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${runId}.json`);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(events), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return file;
  }

  list(limit = 100) {
    let names;
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const runs = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      if (!validRunId(id)) continue;
      try {
        const file = path.join(this.dir, name);
        const st = fs.statSync(file);
        let goal = null;
        let events = null;
        try {
          const arr = JSON.parse(fs.readFileSync(file, "utf8"));
          events = arr.length;
          goal = arr.find((e) => e?.type === "run.started")?.goal ?? null;
        } catch {
          /* unreadable run: still listed */
        }
        runs.push({ id, startedAt: startedFromId(id) ?? st.birthtime.toISOString(), savedAt: st.mtime.toISOString(), bytes: st.size, events, goal });
      } catch {
        /* vanished */
      }
    }
    return runs.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, limit);
  }

  /** Raw JSON text of a saved run, or null. */
  loadRaw(id) {
    if (!validRunId(id)) return null;
    try {
      return fs.readFileSync(path.join(this.dir, `${id}.json`), "utf8");
    } catch {
      return null;
    }
  }
}
