// A very small DOM stand-in, just big enough to mount the studio in Node. It counts every write so tests can check
// that update() only touches what changed, and it records every innerHTML write so tests can check that state text
// never reaches it.

const bubbleKeys = ["ctrlKey", "metaKey", "altKey"];

class FakeStyle {
  constructor(owner) {
    this.owner = owner;
    this.props = new Map();
  }
  setProperty(name, value) {
    const v = String(value);
    if (this.props.get(name) === v) return;
    this.props.set(name, v);
    this.owner.touch(`style:${name}`);
  }
  getPropertyValue(name) {
    return this.props.get(name) ?? "";
  }
  removeProperty(name) {
    if (this.props.delete(name)) this.owner.touch(`style:${name}`);
  }
}

export class FakeEl {
  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = new Map();
    this.listeners = new Map();
    this.classes = new Set();
    this.style = new FakeStyle(this);
    this._text = "";
    this._html = "";
    this._hidden = false;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.offsetWidth = 0;
    this.offsetHeight = 0;
    const self = this;
    this.classList = {
      add(...c) {
        for (const x of c) if (!self.classes.has(x)) (self.classes.add(x), self.touch(`class:+${x}`));
      },
      remove(...c) {
        for (const x of c) if (self.classes.delete(x)) self.touch(`class:-${x}`);
      },
      contains: (c) => self.classes.has(c),
      toggle(c, force) {
        const on = force ?? !self.classes.has(c);
        on ? this.add(c) : this.remove(c);
        return on;
      },
    };
  }

  touch(what) {
    this.ownerDocument.mutations++;
    this.ownerDocument.mutLog.push({ el: this, what });
  }

  get className() {
    return [...this.classes].join(" ");
  }
  set className(v) {
    const next = new Set(String(v).split(/\s+/).filter(Boolean));
    if (next.size === this.classes.size && [...next].every((c) => this.classes.has(c))) return;
    this.classes = next;
    this.touch("className");
  }

  get hidden() {
    return this._hidden;
  }
  set hidden(v) {
    if (!!v === this._hidden) return;
    this._hidden = !!v;
    this.touch("hidden");
  }

  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    const s = String(v);
    if (s === this._text && !this.children.length && !this._html) return;
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._html = "";
    this._text = s;
    this.touch("textContent");
  }

  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    const s = String(v);
    this.ownerDocument.innerHTMLWrites.push({ el: this, html: s });
    if (s === this._html && !this.children.length) return;
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = "";
    this._html = s;
    this.touch("innerHTML");
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  setAttribute(name, value) {
    const v = String(value);
    if (this.attrs.get(name) === v) return;
    this.attrs.set(name, v);
    this.touch(`attr:${name}`);
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  appendChild(child) {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    this.touch("appendChild");
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i < 0) throw new Error("removeChild: not a child");
    this.children.splice(i, 1);
    child.parentNode = null;
    this.touch("removeChild");
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  matches() {
    return false;
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
    this.ownerDocument.listenerCount++;
  }
  removeEventListener(type, fn) {
    if (this.listeners.get(type)?.delete(fn)) this.ownerDocument.listenerCount--;
  }

  /** Dispatches a bubbling event, like the browser does for click, keydown, pointerover and focusin. */
  fire(type, init = {}) {
    const e = { type, target: this, defaultPrevented: false, ...Object.fromEntries(bubbleKeys.map((k) => [k, false])), ...init };
    e.preventDefault = () => {
      e.defaultPrevented = true;
    };
    for (let n = this; n; n = n.parentNode) for (const fn of [...(n.listeners.get(type) ?? [])]) fn(e);
    return e;
  }

  focus() {
    const doc = this.ownerDocument;
    if (doc.activeElement === this) return;
    doc.activeElement = this;
    this.fire("focusin");
  }

  find(pred) {
    const out = [];
    const walk = (n) => {
      if (pred(n)) out.push(n);
      for (const c of n.children) walk(c);
    };
    walk(this);
    return out;
  }
  byClass(cls) {
    return this.find((n) => n.classes.has(cls));
  }
}

export class FakeObserver {
  constructor(cb) {
    this.cb = cb;
    this.targets = new Set();
    this.disconnected = false;
  }
  observe(t) {
    this.targets.add(t);
  }
  disconnect() {
    this.targets.clear();
    this.disconnected = true;
  }
}

/** Builds a document + window pair. Options let a test leave out observers or matchMedia. */
export function createFakeDom({ observers = true, reducedMedia = false } = {}) {
  const docListeners = new Map();
  const doc = {
    mutations: 0,
    mutLog: [],
    innerHTMLWrites: [],
    listenerCount: 0,
    hidden: false,
    activeElement: null,
    stylesheets: [],
    createElement: (tag) => new FakeEl(doc, tag),
    querySelectorAll: () => doc.stylesheets,
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
      doc.listenerCount++;
    },
    removeEventListener(type, fn) {
      if (docListeners.get(type)?.delete(fn)) doc.listenerCount--;
    },
    fire(type) {
      for (const fn of [...(docListeners.get(type) ?? [])]) fn({ type });
    },
    resetLog() {
      doc.mutLog.length = 0;
      doc.mutations = 0;
      doc.innerHTMLWrites.length = 0;
    },
  };
  doc.head = new FakeEl(doc, "head");
  doc.documentElement = new FakeEl(doc, "html");

  const media = {
    matches: reducedMedia,
    listeners: new Set(),
    addEventListener(_t, fn) {
      media.listeners.add(fn);
    },
    removeEventListener(_t, fn) {
      media.listeners.delete(fn);
    },
    set(matches) {
      media.matches = matches;
      for (const fn of [...media.listeners]) fn({ matches });
    },
  };
  const win = { observers: { resize: [], intersection: [] }, media };
  win.matchMedia = () => media;
  if (observers) {
    win.ResizeObserver = class extends FakeObserver {
      constructor(cb) {
        super(cb);
        win.observers.resize.push(this);
      }
    };
    win.IntersectionObserver = class extends FakeObserver {
      constructor(cb) {
        super(cb);
        win.observers.intersection.push(this);
      }
    };
  }
  doc.defaultView = win;

  const host = new FakeEl(doc, "div");
  host.clientWidth = 900;
  host.clientHeight = 600;
  return { doc, win, host, media };
}

export function countNodes(el) {
  let n = 1;
  for (const c of el.children) n += countNodes(c);
  return n;
}

/** Node count per first class name, handy for explaining a count mismatch. */
export function histogram(el, h = {}) {
  const k = `${el.tagName}.${[...el.classes][0] ?? ""}`;
  h[k] = (h[k] ?? 0) + 1;
  for (const c of el.children) histogram(c, h);
  return h;
}

/** Nearest ancestor (or self) that is a .ps-desk, as its data-id; null when the element is outside any desk. */
export function deskIdOf(el) {
  for (let n = el; n; n = n.parentNode) if (n.classes?.has("ps-desk")) return n.getAttribute("data-id");
  return null;
}
