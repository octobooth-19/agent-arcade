// Timeline ticker, "Replay this run" with a scrubber, and the past-runs picker (live only).
import { h, formatElapsed, formatWhen, truncate, pluralize } from "./util.js";
import { icon } from "./icons.js";
import { btn, slot, panelHead, emptyState } from "./ui.js";
import { openDialog } from "./dialogs.js";
import { describeEvent } from "/shared/state.js";

const MAX_TICKER = 100;
const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8];

export function createTimeline(app) {
  const tools = h("div", { class: "panel-tools" });
  const toolsSlot = slot(app, "div", { class: "tl-tools" });
  tools.append(toolsSlot.el);
  const bar = h("div", { class: "replay-bar", hidden: true });
  const list = slot(app, "div", { class: "ticker-wrap" });
  const root = h("section", { class: "panel timeline", id: "timeline", "aria-labelledby": "timeline-title", "data-sec": "stage" }, h("div", { class: "panel-head" }, h("h2", { id: "timeline-title", class: "panel-title" }, icon("clock", { size: 18 }), h("span", {}, "Timeline")), tools), bar, list.el);

  let barFor = null;
  let refs = null;
  let dragging = false;
  window.addEventListener("pointerup", () => { dragging = false; });
  window.addEventListener("pointercancel", () => { dragging = false; });

  function buildBar(arcade) {
    const rp = arcade.replay;
    const scrub = h("input", { type: "range", class: "scrubber", min: "0", max: String(rp.length), step: "1", value: String(rp.index), "aria-label": "Replay position", "data-fk": "rp:scrub" });
    scrub.addEventListener("pointerdown", () => { dragging = true; });
    scrub.addEventListener("input", () => arcade.replay.seek(Number(scrub.value)));
    const playBtn = h("button", { type: "button", class: "btn btn-primary", "data-fk": "rp:play", onClick: () => (arcade.replay.playing ? arcade.replay.pause() : arcade.replay.play()) });
    const pos = h("span", { class: "replay-pos", role: "status" });
    const speed = h("select", { class: "field field-sm", id: "replay-speed", "aria-label": "Replay speed", "data-fk": "rp:speed", onChange: (e) => { arcade.setSpeed(Number(e.target.value)); } }, REPLAY_SPEEDS.map((s) => h("option", { value: s }, s + "x")));
    speed.value = String(rp.speed);
    const back = h("button", { type: "button", class: "btn btn-default", "data-fk": "rp:back", onClick: () => app.backToLive() }, icon("undo", { size: 16 }), h("span", { class: "btn-label" }, "Back to live"));
    bar.replaceChildren(h("p", { class: "replay-note" }, icon("eye", { size: 16 }), h("span", {}, h("strong", {}, "Replay. "), "This is a recording. Nothing here is running and controls are hidden.")), h("div", { class: "replay-ctl" }, playBtn, scrub, pos), h("div", { class: "replay-ctl" }, h("label", { for: "replay-speed", class: "small" }, "Speed"), speed, back));
    refs = { scrub, playBtn, pos };
  }

  function update(state) {
    const arcade = app.arcade;
    const replaying = arcade.source === "replay" && !!arcade.replay;
    const canReplay = !replaying && state.timeline.length > 0;
    const baseLive = app.baseArcade?.source === "live";

    toolsSlot.set([replaying, canReplay, baseLive].join("|"), (el) => {
      if (!replaying) el.append(btn(app, { label: "Replay this run", icon: "play", small: true, reason: canReplay ? null : "Nothing has happened yet, so there is nothing to replay.", fk: "tl:replay", onClick: () => app.startReplayOfCurrent() }));
      if (baseLive) el.append(btn(app, { label: "Past runs", icon: "folder", small: true, kind: "ghost", fk: "tl:past", onClick: () => openPastRuns(app) }));
    });

    bar.hidden = !replaying;
    if (replaying) {
      if (barFor !== arcade) {
        barFor = arcade;
        buildBar(arcade);
      }
      const rp = arcade.replay;
      if (!dragging && refs.scrub.value !== String(rp.index)) refs.scrub.value = String(rp.index);
      const ev = state.timeline[state.timeline.length - 1];
      const label = ev ? describeEvent(ev, state) : "";
      const text = `Event ${rp.index} of ${rp.length}${label ? ": " + truncate(label, 70) : ""}`;
      refs.pos.textContent = text;
      refs.scrub.setAttribute("aria-valuetext", text);
      const want = rp.playing ? "pause" : "play";
      if (refs.playBtn.dataset.state !== want) {
        refs.playBtn.dataset.state = want;
        refs.playBtn.replaceChildren(icon(want, { size: 16 }), h("span", { class: "btn-label" }, rp.playing ? "Pause" : rp.index >= rp.length ? "Replay again" : "Play"));
      } else if (!rp.playing) {
        const l = refs.playBtn.querySelector(".btn-label");
        if (l) l.textContent = rp.index >= rp.length ? "Replay again" : "Play";
      }
    } else {
      barFor = null;
      refs = null;
    }

    const tl = state.timeline;
    const last = tl[tl.length - 1];
    const sig = `${tl.length}|${last?.type}|${last?.t}|${last?.id ?? ""}|${last?.text ?? ""}|${replaying}`;
    list.set(sig, (el) => {
      const rows = [];
      for (let i = tl.length - 1; i >= 0 && rows.length < MAX_TICKER; i--) {
        const text = describeEvent(tl[i], state);
        if (text) rows.push({ t: tl[i].t, text });
      }
      if (!rows.length) return el.append(emptyState("Quiet so far.", "Things that happen show up here.", "list"));
      el.append(
        h("ol", { class: "ticker", role: "log", "aria-label": "Recent events, newest first" }, rows.map((r) => h("li", {}, h("span", { class: "tk-t" }, formatElapsed(r.t)), h("span", { class: "tk-text" }, truncate(r.text, 160))))),
        h("p", { class: "muted small" }, `Showing the latest ${pluralize(rows.length, "event")}.`),
      );
    });
  }

  return { el: root, update };
}

/** Dialog listing saved runs from the live server. Tolerates every kind of failure with plain words. */
export function openPastRuns(app) {
  openDialog({
    title: "Past runs",
    build: (close) => {
      const box = h("div", { class: "runs" }, h("p", { class: "muted" }, "Loading\u2026"));
      (async () => {
        let runs = null;
        let problem = "";
        try {
          const r = await app.baseArcade.listRuns?.();
          if (r && r.ok === false) problem = r.error ?? "The server could not list past runs.";
          else runs = Array.isArray(r) ? r : r?.data ?? r?.runs ?? [];
        } catch (err) {
          problem = err?.message ?? "Could not load past runs.";
        }
        box.replaceChildren();
        if (problem) return box.append(h("p", { class: "banner banner-warn" }, icon("alert", { size: 18 }), h("span", {}, "Couldn't load past runs. " + problem)));
        if (!runs.length) return box.append(emptyState("No saved runs yet.", "Finished runs show up here once the server has saved them.", "folder"));
        const ul = h("ul", { class: "run-list" });
        for (const run of runs) {
          const when = formatWhen(run.savedAt ?? run.startedAt);
          const count = Number.isFinite(run.events) ? pluralize(run.events, "event") : null;
          ul.append(
            h("li", { class: "run" },
              h("div", { class: "run-main" }, h("strong", {}, run.goal ? truncate(run.goal, 90) : "Untitled run"), h("span", { class: "muted small" }, [when, count].filter(Boolean).join(" \u00b7 "))),
              btn(app, { label: "Replay", icon: "play", small: true, fk: "run:" + run.id, onClick: async () => {
                const ev = await app.baseArcade.loadRun(run.id);
                if (!Array.isArray(ev) || !ev.length) return app.toast("That run could not be loaded.", "error");
                close();
                app.startReplay(ev, run.goal ? truncate(run.goal, 40) : "past run");
              } }),
            ),
          );
        }
        box.append(ul);
      })();
      return box;
    },
  });
}
