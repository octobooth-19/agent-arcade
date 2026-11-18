// Tiny WebAudio synth for the studio. No audio files. Muted by default, persisted in localStorage "arcade-sound".
// play() is a silent no-op unless sound is enabled, a user gesture has happened, and an AudioContext exists.

export const SOUND_NAMES = ["approval", "stamp", "dispatch", "blocked"];
const STORAGE_KEY = "arcade-sound";
const MASTER_GAIN = 0.14;
const MIN_GAP_MS = 120; // same sound twice inside this window is dropped

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked storage throws on access
  }
}

/** Factory so tests can inject a fake storage, AudioContext and clock. The default export below uses the real ones. */
export function createSounds({ storage, audioContextClass, doc, now = () => Date.now() } = {}) {
  let enabled = null; // read lazily so importing this module never touches storage
  let gesture = false;
  let ctx = null;
  let master = null;
  let listening = false;
  const lastPlayed = {};

  const store = () => storage ?? defaultStorage();
  const AC = () => audioContextClass ?? globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
  const document_ = () => doc ?? globalThis.document ?? null;

  function readEnabled() {
    if (enabled === null) {
      try {
        enabled = store()?.getItem(STORAGE_KEY) === "1";
      } catch {
        enabled = false;
      }
    }
    return enabled;
  }

  function markGesture() {
    gesture = true;
    const d = document_();
    if (listening && d?.removeEventListener) {
      for (const type of ["pointerdown", "keydown", "touchstart"]) d.removeEventListener(type, markGesture, true);
    }
    listening = false;
    if (readEnabled()) ensureContext();
  }

  // Browsers refuse audio before a gesture. Wait for the first real one instead of trying early.
  function listenForGesture() {
    if (gesture || listening) return;
    const d = document_();
    if (!d?.addEventListener) return;
    listening = true;
    for (const type of ["pointerdown", "keydown", "touchstart"]) d.addEventListener(type, markGesture, { capture: true, passive: true });
  }

  function ensureContext() {
    if (ctx) return ctx;
    const Ctor = AC();
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      master = null;
    }
    return ctx;
  }

  function tone(c, out, { type = "sine", from, to = from, start = 0, dur = 0.15, peak = 0.6 }) {
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(out);
    osc.onended = () => {
      try {
        osc.disconnect();
        g.disconnect();
      } catch {
        /* already disconnected */
      }
    };
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise(c, out, { start = 0, dur = 0.05, peak = 0.35, freq = 900 }) {
    const t0 = c.currentTime + start;
    const frames = Math.max(1, Math.floor(c.sampleRate * dur));
    const buf = c.createBuffer(1, frames, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const g = c.createGain();
    src.buffer = buf;
    filter.type = "lowpass";
    filter.frequency.value = freq;
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter);
    filter.connect(g);
    g.connect(out);
    src.onended = () => {
      try {
        src.disconnect();
        filter.disconnect();
        g.disconnect();
      } catch {
        /* already disconnected */
      }
    };
    src.start(t0);
  }

  const voices = {
    approval(c, out) {
      // soft two-note doorbell: asks for attention without nagging
      tone(c, out, { from: 784, dur: 0.22, peak: 0.55 });
      tone(c, out, { from: 1047, start: 0.14, dur: 0.34, peak: 0.5 });
    },
    stamp(c, out) {
      // a papery thump
      tone(c, out, { from: 170, to: 62, dur: 0.12, peak: 0.9 });
      noise(c, out, { dur: 0.05, peak: 0.3, freq: 1200 });
    },
    dispatch(c, out) {
      // little upward whoosh
      tone(c, out, { type: "triangle", from: 420, to: 980, dur: 0.2, peak: 0.32 });
      tone(c, out, { type: "sine", from: 1320, start: 0.17, dur: 0.1, peak: 0.18 });
    },
    blocked(c, out) {
      // two gentle descending bonks
      tone(c, out, { type: "triangle", from: 330, to: 250, dur: 0.14, peak: 0.45 });
      tone(c, out, { type: "triangle", from: 262, to: 190, start: 0.16, dur: 0.18, peak: 0.4 });
    },
  };

  return {
    play(name) {
      if (!readEnabled()) return;
      if (!Object.hasOwn(voices, name)) return;
      if (!gesture) {
        listenForGesture();
        return;
      }
      const stamp = now();
      if (stamp - (lastPlayed[name] ?? -Infinity) < MIN_GAP_MS) return;
      const c = ensureContext();
      if (!c) return;
      if (c.state !== "running") {
        // still suspended: try to wake it for next time, never queue sound into the future
        try {
          c.resume?.()?.catch?.(() => {});
        } catch {
          /* ignore */
        }
        return;
      }
      lastPlayed[name] = stamp;
      try {
        voices[name](c, master);
      } catch {
        /* audio must never break the scene */
      }
    },
    setEnabled(value) {
      enabled = !!value;
      try {
        store()?.setItem(STORAGE_KEY, enabled ? "1" : "0");
      } catch {
        /* storage can be blocked */
      }
      if (enabled) {
        // Called from a toggle click in practice, which is itself the user gesture.
        gesture = true;
        const c = ensureContext();
        try {
          c?.resume?.()?.catch?.(() => {});
        } catch {
          /* ignore */
        }
      }
    },
    isEnabled() {
      return readEnabled();
    },
  };
}

export const sounds = createSounds();
