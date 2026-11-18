// Top bar: brand, LIVE/DEMO/REPLAY badge, project, connection, needs-you count, and the global controls.
import { h, formatMb, pluralize } from "./util.js";
import { icon } from "./icons.js";
import { btn, slot, chip } from "./ui.js";
import { HOLD_COPY, workerList } from "./model.js";
import { openInbox } from "/shared/state.js";

const SPEEDS = [0.5, 1, 2, 4];

export function createTopbar(app) {
  const badge = slot(app, "div", { class: "tb-badge" });
  const project = slot(app, "div", { class: "tb-project" });
  const needs = slot(app, "div", { class: "tb-needs" });
  const tools = slot(app, "div", { class: "tb-tools" });
  const controls = slot(app, "div", { class: "tb-controls", id: "tb-controls" });

  const brand = h("div", { class: "tb-brand" }, h("span", { class: "brand-mark", "aria-hidden": "true" }, icon("spark", { size: 18 })), h("span", { class: "brand-text" }, h("span", { class: "brand-name" }, "Agent Arcade"), h("span", { class: "brand-sub" }, "Pocket Studio")));
  const root = h("header", { class: "topbar", id: "topbar" }, h("div", { class: "tb-row tb-main" }, brand, badge.el, project.el, needs.el, tools.el), controls.el);

  function update(state) {
    const arcade = app.arcade;
    const replay = arcade.source === "replay";

    badge.set(`${arcade.source}|${app.ui.replayLabel}|${state.source}`, (el) => {
      if (arcade.source === "demo") el.append(h("span", { class: "mode mode-demo", title: "Everything here is scripted. No Copilot sessions are running." }, icon("record", { size: 14 }), "DEMO \u00b7 scripted"));
      else if (arcade.source === "live") el.append(h("span", { class: "mode mode-live", title: "Connected to your own GitHub Copilot CLI. Agents here are real Copilot sessions and may use your Copilot premium requests." }, icon("record", { size: 14 }), "LIVE \u00b7 your Copilot"));
      else el.append(h("span", { class: "mode mode-replay", title: "A recording. Nothing here is running." }, icon("play", { size: 14 }), "REPLAY", h("span", { class: "mode-sub" }, app.ui.replayLabel || (state.source === "live" ? "recorded live run" : "recorded demo"))));
    });

    const p = state.project;
    const c = state.connection;
    project.set(`${p?.name}|${p?.path}|${p?.isGit}|${c.state}|${c.message}|${replay}`, (el) => {
      if (p) {
        el.append(h("div", { class: "proj", title: p.path ?? "" }, icon("folder", { size: 15 }), h("span", { class: "proj-name" }, p.name ?? "project"), p.path ? h("span", { class: "proj-path" }, p.path) : null));
        if (p.isGit === false) el.append(chip("not a git repo", { tone: "warn", icon: "alert", title: "Not a git repository: agents run one at a time and work happens directly in the folder." }));
      }
      if (replay) {
        el.append(h("span", { class: "conn conn-soft", title: "Replays are read-only." }, icon("eye", { size: 14 }), "Replay, read-only"));
      } else {
        const tone = c.state === "ready" ? "good" : c.state === "error" ? "bad" : "soft";
        const label = c.state === "ready" ? (arcade.source === "demo" ? "Demo ready" : "Connected") : c.state === "error" ? "Connection problem" : "Connecting";
        el.append(h("span", { class: "conn conn-" + tone, role: "status", title: c.message || label }, icon(c.state === "ready" ? "check" : c.state === "error" ? "alert" : "clock", { size: 14 }), label));
      }
    });

    const count = openInbox(state).length;
    needs.set(`${count}|${replay}`, (el) => {
      el.append(
        h("button", { type: "button", class: ["needs-btn", count ? "has-items" : ""], "aria-label": count ? `Needs you: ${pluralize(count, "item")}. Open the inbox.` : "Needs you: nothing right now. Open the inbox.", onClick: () => app.jumpTo("inbox") }, icon("bell", { size: 16 }), h("span", { class: "needs-label" }, "Needs you"), h("span", { class: "count-badge", "aria-hidden": "true" }, String(count))),
      );
    });

    tools.set(`${app.ui.moreOpen}`, (el) => {
      el.append(
        btn(app, { label: "Search & actions", icon: "search", kind: "ghost", hideLabel: true, title: "Command palette (Ctrl/Cmd+K)", fk: "tb:palette", onClick: () => app.openPalette() }),
        btn(app, { label: "Help and shortcuts", icon: "help", kind: "ghost", hideLabel: true, title: "Help and shortcuts (?)", fk: "tb:help", onClick: () => app.openHelp() }),
        btn(app, { label: "Controls", icon: "settings", kind: "ghost", cls: "more-toggle", expanded: app.ui.moreOpen, controls: "tb-controls", fk: "tb:more", onClick: () => { app.ui.moreOpen = !app.ui.moreOpen; app.forceRender(); } }),
      );
    });
    root.dataset.more = app.ui.moreOpen ? "open" : "closed";

    const workers = workerList(state, { includeLead: false });
    const m = state.metrics;
    const fpSig = m ? `${m.serverMb}|${m.copilotMb}|${m.childrenMb}|${m.sessions}|${m.sampledAt}` : "null";
    controls.set(`${arcade.source}|${state.maxConcurrent}|${state.holdAll}|${workers.length}|${app.ui.speed}|${app.ui.soundOn}|${app.sound.available}|${app.ui.pop}|${fpSig}`, (el) => {
      if (replay) {
        el.append(h("p", { class: "muted small" }, "Controls are hidden while replaying. Use Back to live to steer."));
        return;
      }
      const select = h("select", { class: "field field-sm", id: "max-agents", "aria-describedby": "max-agents-hint", onChange: (e) => { app.act("setMaxConcurrent", { value: Number(e.target.value) }); }, "data-fk": "tb:max" }, [1, 2, 3, 4, 5, 6].map((n) => h("option", { value: n }, String(n))));
      select.value = String(state.maxConcurrent);
      el.append(h("div", { class: "ctl", title: "How many agents work at once. The rest wait at the stage door." }, h("label", { for: "max-agents" }, "Agents at a time"), select, h("span", { id: "max-agents-hint", class: "sr-only" }, "How many agents work at once. The rest wait at the stage door.")));

      el.append(
        state.holdAll
          ? btn(app, { label: "Resume all", icon: "play", kind: "accent", title: "Re-prompts every held agent. " + HOLD_COPY, fk: "tb:holdall", onClick: () => app.act("resumeAll", {}, { ok: "Resume all sent. Held agents are re-prompted." }) })
          : btn(app, { label: "Hold all", icon: "pause", title: HOLD_COPY, reason: workers.length ? null : "No agents are working yet. " + HOLD_COPY, fk: "tb:holdall", onClick: () => app.act("holdAll", {}, { ok: "Hold all requested. Each agent stops at its next safe point." }) }),
      );

      el.append(footprint(app, m));

      if (arcade.source === "demo") {
        el.append(
          h("div", { class: "seg", role: "group", "aria-label": "Demo speed" }, h("span", { class: "seg-label" }, "Demo speed"), SPEEDS.map((s) => btn(app, { label: s + "x", kind: "seg", pressed: app.ui.speed === s, small: true, fk: "tb:speed" + s, title: `Run the scripted demo at ${s}x`, onClick: () => app.setSpeed(s) }))),
        );
      }

      el.append(
        btn(app, {
          label: app.ui.soundOn ? "Sound on" : "Sound off",
          icon: app.ui.soundOn ? "sound" : "mute",
          kind: "default",
          pressed: app.ui.soundOn,
          reason: app.sound.available ? null : "Sounds come with the studio scene, which is not loaded.",
          title: "Short, quiet sound cues for approvals and merges. Off by default.",
          fk: "tb:sound",
          onClick: () => app.toggleSound(),
        }),
      );
    });
  }

  return { el: root, update };
}

function footprint(app, m) {
  const total = m ? [m.serverMb, m.copilotMb, m.childrenMb].filter(Number.isFinite).reduce((a, b) => a + b, 0) : null;
  const known = m && [m.serverMb, m.copilotMb, m.childrenMb].some(Number.isFinite);
  const open = app.ui.pop === "footprint";
  const trigger = h("button", { type: "button", class: "btn btn-default footprint", "aria-expanded": String(open), "aria-controls": "pop-footprint", "data-pop-trigger": "footprint", "data-fk": "tb:footprint", onClick: () => app.togglePopover("footprint") }, icon("wrench", { size: 14 }), h("span", { class: "fp-label" }, "Footprint (estimate)"), h("strong", { class: "fp-value" }, known ? formatMb(total) : "-"));
  const row = (k, v) => h("div", { class: "kv" }, h("dt", {}, k), h("dd", {}, v));
  const pop = open
    ? h("div", { class: "popover", id: "pop-footprint", role: "dialog", "aria-label": "Footprint estimate" },
        h("p", { class: "pop-title" }, "Footprint (estimate)"),
        h("dl", { class: "kvs" }, row("Arcade server", formatMb(m?.serverMb)), row("Copilot process", formatMb(m?.copilotMb)), row("Tools it started", formatMb(m?.childrenMb)), row("Sessions", m && Number.isFinite(m.sessions) ? String(m.sessions) : "-")),
        h("p", { class: "muted small" }, m ? "Estimates from summed process memory (RSS). Shared memory can be counted more than once, so these can overcount." : app.arcade.source === "demo" ? "The demo does not measure anything, so there is nothing to show." : "No measurement yet. Estimates appear once the server reports them."),
        h("p", { class: "muted small" }, "These numbers describe this run only. They are not a comparison with any other tool."),
      )
    : null;
  return h("div", { class: "pop", "data-pop": "footprint" }, trigger, pop);
}
