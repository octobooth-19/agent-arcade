// Client SDK: one interface over the live bridge (SSE + fetch), the scripted demo engine, and replay of a recorded run.
// UI code only talks to the object returned by connectArcade(). It never needs to know which source is behind it.
import { createInitialState, reduce, rebuild } from "./state.js";

const TOKEN_KEY = "arcade-token";

function readToken(loc, storage) {
  let token = null;
  try {
    const m = /(?:^|[#&])token=([^&]+)/.exec(loc?.hash ?? "");
    if (m) {
      token = decodeURIComponent(m[1]);
      storage?.setItem(TOKEN_KEY, token);
      if (typeof history !== "undefined" && loc) history.replaceState(null, "", loc.pathname + loc.search);
    } else {
      token = storage?.getItem(TOKEN_KEY) ?? null;
    }
  } catch {
    /* storage can be blocked; the token then lives only for this page load */
  }
  return token;
}

function makeEmitter() {
  const subs = new Set();
  return {
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    notify(state, ev) {
      for (const fn of [...subs]) {
        try {
          fn(state, ev);
        } catch (err) {
          console.error("arcade subscriber failed", err);
        }
      }
    },
  };
}

/** Replay controls over a recorded event list. Read-only: commands are refused. */
export function createReplay(events, { speed = 1 } = {}) {
  const em = makeEmitter();
  let state = rebuild(events, 0);
  let index = 0;
  let timer = null;
  const ctl = {
    length: events.length,
    get index() { return index; },
    get playing() { return timer != null; },
    speed,
    seek(i) {
      index = Math.max(0, Math.min(events.length, Math.round(i)));
      state = rebuild(events, index);
      em.notify(state, null);
    },
    play() {
      if (timer != null) return;
      if (index >= events.length) ctl.seek(0);
      const step = () => {
        if (index >= events.length) { timer = null; em.notify(state, null); return; }
        const ev = events[index++];
        reduce(state, ev);
        em.notify(state, ev);
        const next = events[index];
        const gap = next ? Math.min(900, Math.max(40, ((next.t ?? 0) - (ev.t ?? 0)) / ctl.speed)) : 0;
        timer = setTimeout(step, gap);
      };
      timer = setTimeout(step, 0);
      em.notify(state, null);
    },
    pause() {
      if (timer != null) clearTimeout(timer);
      timer = null;
      em.notify(state, null);
    },
  };
  return {
    source: "replay",
    replay: ctl,
    getState: () => state,
    subscribe(fn) {
      const off = em.subscribe(fn);
      fn(state, null);
      return off;
    },
    command: async () => ({ ok: false, error: "Replay is read-only" }),
    setSpeed(x) { ctl.speed = Math.max(0.25, Math.min(16, x)); },
    health: async () => ({ replay: true }),
    close() { ctl.pause(); },
  };
}

async function connectLive({ token, fetchImpl, EventSourceImpl, base }) {
  const em = makeEmitter();
  const state = createInitialState();
  state.source = "live";
  state.connection = { state: "connecting", message: "Connecting to the Arcade server" };
  const headers = { "content-type": "application/json", "x-arcade-token": token };

  const es = new EventSourceImpl(`${base}/api/events?token=${encodeURIComponent(token)}`);
  es.onmessage = (m) => {
    let ev;
    try { ev = JSON.parse(m.data); } catch { return; }
    reduce(state, ev);
    em.notify(state, ev);
  };
  es.onerror = () => {
    const ev = { type: "connection", state: "error", message: "Lost the connection to the Arcade server. Retrying...", t: state.now };
    reduce(state, ev);
    em.notify(state, ev);
  };

  const call = async (path, init) => {
    try {
      const res = await fetchImpl(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && body.ok === undefined) return { ok: false, error: body.error ?? `Server said ${res.status}` };
      return body;
    } catch (err) {
      return { ok: false, error: `Could not reach the Arcade server (${err.message})` };
    }
  };

  return {
    source: "live",
    getState: () => state,
    subscribe(fn) {
      const off = em.subscribe(fn);
      fn(state, null);
      return off;
    },
    command: (name, payload = {}) => call("/api/command", { method: "POST", body: JSON.stringify({ name, ...payload }) }),
    setSpeed() {},
    health: () => call("/api/health"),
    listRuns: () => call("/api/runs"),
    loadRun: async (id) => {
      const r = await call(`/api/runs/${encodeURIComponent(id)}`);
      return Array.isArray(r) ? r : r?.events ?? null;
    },
    close() { es.close(); },
  };
}

async function connectDemo({ fixture, fixtureUrl, fetchImpl, speed, engineOptions }) {
  const { createDemoEngine } = await import("./demo-engine.js");
  const data = fixture ?? (await (await fetchImpl(fixtureUrl)).json());
  const em = makeEmitter();
  let current = createInitialState();
  const engine = createDemoEngine({
    fixture: data,
    speed,
    ...engineOptions,
    onEvent: (s, ev) => {
      current = s;
      em.notify(s, ev);
    },
  });
  engine.start();
  return {
    source: "demo",
    fixture: data,
    getState: () => current,
    subscribe(fn) {
      const off = em.subscribe(fn);
      fn(current, null);
      return off;
    },
    command: async (name, payload = {}) => engine.command(name, payload),
    setSpeed: (x) => engine.setSpeed(x),
    health: async () => ({ demo: true, copilot: { found: false, version: null, loggedIn: "unknown" }, project: data.project }),
    close() { engine.stop(); },
  };
}

/**
 * connectArcade({ source: "auto" | "live" | "demo" | "replay", events?, speed?, fixture?, fixtureUrl? })
 * "auto" uses the live bridge when /api/hello says live and a token is available, otherwise the scripted demo.
 * The returned object also has: health(), listRuns()/loadRun(id) (live only), close(), and for live/demo a
 * recordEvents() helper that returns a copy of the events so far, ready for createReplay().
 */
export async function connectArcade(options = {}) {
  const hasWindow = typeof window !== "undefined";
  const fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
  const loc = options.location ?? (hasWindow ? window.location : null);
  const storage = options.storage ?? (hasWindow ? window.sessionStorage : null);
  const base = options.base ?? "";
  const fixtureUrl = options.fixtureUrl ?? new URL("../fixtures/demo-timeline.json", import.meta.url).href;
  const speed = options.speed ?? 1;
  const param = loc?.search ? new URLSearchParams(loc.search).get("source") : null;
  let source = options.source ?? param ?? "auto";

  if (source === "replay") {
    if (options.events) return createReplay(options.events, { speed });
    throw new Error("Replay needs options.events (use loadRun() on a live connection to fetch them)");
  }

  let hello = null;
  if (source === "auto" || source === "live") {
    try {
      const res = await fetchImpl(`${base}/api/hello`, { cache: "no-store" });
      if (res.ok) hello = await res.json();
    } catch {
      /* no bridge here: static server, file://, or offline */
    }
  }

  const token = options.token ?? readToken(loc, storage);
  if (source === "live" && !(hello?.app === "agent-arcade" && hello.mode === "live" && token)) {
    throw new Error(hello ? "The Arcade server needs its launch link (it contains the access token)." : "No Arcade server found at this address.");
  }
  if (source === "auto") source = hello?.app === "agent-arcade" && hello.mode === "live" && token ? "live" : "demo";

  const arcade = source === "live"
    ? await connectLive({ token, fetchImpl, EventSourceImpl: options.EventSource ?? globalThis.EventSource, base })
    : await connectDemo({ fixture: options.fixture, fixtureUrl, fetchImpl, speed, engineOptions: options.engineOptions });

  arcade.hello = hello;
  arcade.needsToken = !!(hello?.mode === "live" && !token);
  arcade.recordEvents = () => structuredClone(arcade.getState().timeline);
  return arcade;
}
