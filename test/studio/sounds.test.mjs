import test from "node:test";
import assert from "node:assert/strict";
import { createSounds, sounds, SOUND_NAMES } from "../../public/studio/sounds.js";

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => void data.set(k, String(v)),
  };
}

function fakeDoc() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type) => listeners.get(type)?.(),
  };
}

function fakeAudio() {
  const made = { contexts: 0, oscillators: 0, buffers: 0 };
  const node = () => ({ connect() {}, disconnect() {}, gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, frequency: { value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} } });
  class AudioContext {
    constructor() {
      made.contexts++;
      this.state = "running";
      this.currentTime = 0;
      this.sampleRate = 8000;
      this.destination = {};
    }
    createGain() { return node(); }
    createOscillator() { made.oscillators++; return { ...node(), start() {}, stop() {} }; }
    createBuffer(_c, frames) { made.buffers++; return { getChannelData: () => new Float32Array(frames) }; }
    createBufferSource() { return { ...node(), start() {} }; }
    createBiquadFilter() { return node(); }
    resume() { return Promise.resolve(); }
  }
  return { AudioContext, made };
}

test("sounds: the contract names", () => {
  assert.deepEqual([...SOUND_NAMES].sort(), ["approval", "blocked", "dispatch", "stamp"]);
  assert.equal(typeof sounds.play, "function");
  assert.equal(typeof sounds.setEnabled, "function");
  assert.equal(typeof sounds.isEnabled, "function");
});

test("sounds: muted by default, and importing the module does not touch audio or storage", () => {
  const storage = fakeStorage();
  const { AudioContext, made } = fakeAudio();
  const s = createSounds({ storage, audioContextClass: AudioContext, doc: fakeDoc() });
  assert.equal(s.isEnabled(), false);
  for (const name of SOUND_NAMES) s.play(name);
  assert.equal(made.contexts, 0, "no AudioContext while muted");
  assert.equal(storage.data.size, 0, "nothing written until the user chooses");
});

test("sounds: play() is a silent no-op when disabled, even after a gesture", () => {
  const storage = fakeStorage({ "arcade-sound": "0" });
  const { AudioContext, made } = fakeAudio();
  const doc = fakeDoc();
  const s = createSounds({ storage, audioContextClass: AudioContext, doc });
  doc.fire("pointerdown");
  for (const name of SOUND_NAMES) assert.doesNotThrow(() => s.play(name));
  assert.equal(made.contexts, 0);
  assert.equal(made.oscillators, 0);
});

test("sounds: no AudioContext available means play() does nothing and never throws", () => {
  const s = createSounds({ storage: fakeStorage(), audioContextClass: undefined, doc: fakeDoc() });
  const saved = { a: globalThis.AudioContext, w: globalThis.webkitAudioContext };
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  try {
    s.setEnabled(true);
    assert.equal(s.isEnabled(), true);
    for (const name of SOUND_NAMES) assert.doesNotThrow(() => s.play(name));
  } finally {
    if (saved.a) globalThis.AudioContext = saved.a;
    if (saved.w) globalThis.webkitAudioContext = saved.w;
  }
});

test("sounds: a constructor that throws is swallowed", () => {
  class Broken {
    constructor() { throw new Error("blocked by policy"); }
  }
  const s = createSounds({ storage: fakeStorage(), audioContextClass: Broken, doc: fakeDoc() });
  assert.doesNotThrow(() => s.setEnabled(true));
  assert.doesNotThrow(() => s.play("stamp"));
});

test("sounds: nothing plays before a user gesture; the first gesture unlocks it", () => {
  const storage = fakeStorage({ "arcade-sound": "1" }); // enabled on an earlier visit
  const { AudioContext, made } = fakeAudio();
  const doc = fakeDoc();
  let t = 0;
  const s = createSounds({ storage, audioContextClass: AudioContext, doc, now: () => (t += 1000) });
  assert.equal(s.isEnabled(), true);
  s.play("approval");
  assert.equal(made.contexts, 0, "no AudioContext before a gesture");
  assert.ok(doc.listeners.has("pointerdown") && doc.listeners.has("keydown"), "waits for a gesture");
  doc.fire("pointerdown");
  assert.equal(made.contexts, 1, "the gesture creates the context");
  s.play("approval");
  assert.ok(made.oscillators > 0, "and then it plays");
});

test("sounds: setEnabled persists to localStorage 'arcade-sound' and counts as the gesture", () => {
  const storage = fakeStorage();
  const { AudioContext, made } = fakeAudio();
  let t = 0;
  const s = createSounds({ storage, audioContextClass: AudioContext, doc: fakeDoc(), now: () => (t += 1000) });
  s.setEnabled(true);
  assert.equal(storage.data.get("arcade-sound"), "1");
  assert.equal(s.isEnabled(), true);
  for (const name of SOUND_NAMES) s.play(name);
  assert.ok(made.oscillators >= SOUND_NAMES.length, "every sound makes noise when enabled");
  s.setEnabled(false);
  assert.equal(storage.data.get("arcade-sound"), "0");
  const before = made.oscillators;
  s.play("stamp");
  assert.equal(made.oscillators, before, "muted again");
});

test("sounds: unknown names and rapid repeats are ignored", () => {
  const { AudioContext, made } = fakeAudio();
  let t = 0;
  const s = createSounds({ storage: fakeStorage(), audioContextClass: AudioContext, doc: fakeDoc(), now: () => t });
  s.setEnabled(true);
  s.play("explode");
  s.play("__proto__");
  s.play(undefined);
  assert.equal(made.oscillators, 0);
  s.play("stamp");
  const once = made.oscillators;
  assert.ok(once > 0);
  s.play("stamp");
  assert.equal(made.oscillators, once, "same sound inside the rate limit is dropped");
  t += 500;
  s.play("stamp");
  assert.ok(made.oscillators > once, "and plays again after the gap");
});

test("sounds: blocked storage is not fatal", () => {
  const storage = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
  };
  const s = createSounds({ storage, audioContextClass: undefined, doc: fakeDoc() });
  assert.equal(s.isEnabled(), false);
  assert.doesNotThrow(() => s.setEnabled(true));
  assert.equal(s.isEnabled(), true, "still works for this page");
});

test("sounds: the shared default instance is muted in Node (no localStorage, no AudioContext)", () => {
  // Newer Node versions warn when localStorage is touched without --localstorage-file; stand in for a browser without it.
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(sounds.isEnabled(), false);
    assert.doesNotThrow(() => sounds.play("stamp"));
  } finally {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else delete globalThis.localStorage;
  }
});
