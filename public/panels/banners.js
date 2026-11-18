// Banners under the top bar: health/login guidance (live only), connection problems, replay notice.
import { h } from "./util.js";
import { icon } from "./icons.js";
import { btn, slot } from "./ui.js";

const INSTALL_CMD = "npm install -g @github/copilot";

export function createBanners(app) {
  const health = slot(app, "div", { class: "banners" });
  let result = null; // last /api/health payload, or { error }
  let loading = false;
  let loadedFor = null;

  async function refresh() {
    const arcade = app.arcade;
    if (arcade.source !== "live" || loading) return;
    loading = true;
    try {
      const r = await arcade.health();
      result = r && r.ok !== false && !r.error ? r : { error: r?.error ?? "The server did not answer the health check." };
    } catch (err) {
      result = { error: err?.message ?? "Health check failed." };
    }
    loading = false;
    loadedFor = arcade;
    app.forceRender();
  }

  function copyRow(text, fk) {
    return h("div", { class: "copy-row" }, h("code", { class: "cmd" }, text), btn(app, { label: "Copy", icon: "copy", small: true, fk, onClick: () => app.copy(text) }));
  }

  function update(state) {
    const arcade = app.arcade;
    if (arcade.source === "live" && loadedFor !== arcade && !loading) refresh();
    const live = arcade.source === "live";
    const c = state.connection;
    const cop = result?.copilot;
    const gitMissing = result?.git && result.git.found === false;
    const notRepo = live && state.project && state.project.isGit === false;
    const sig = [live, c.state, c.message, JSON.stringify(cop ?? null), result?.error ?? "", result?.loginCommand ?? "", gitMissing, notRepo, app.ui.readOnly].join("|");
    health.set(sig, (el) => {
      if (app.ui.readOnly) return;
      if (c.state === "error") {
        el.append(banner("bad", "alert", "Connection problem", c.message || "The Arcade server is not answering.", [btn(app, { label: "Reload", icon: "undo", small: true, fk: "ban:reload", onClick: () => location.reload() })]));
      }
      if (!live) return;
      if (result?.error) {
        el.append(banner("warn", "alert", "Could not check Copilot", result.error, [btn(app, { label: "Check again", icon: "undo", small: true, fk: "ban:recheck", onClick: refresh })]));
      } else if (cop && cop.found === false) {
        el.append(banner("bad", "alert", "GitHub Copilot CLI was not found", "Agent Arcade drives your own Copilot CLI. Install it, sign in, then check again.", [copyRow(INSTALL_CMD, "ban:install"), copyRow(result?.loginCommand || "copilot login", "ban:login0"), btn(app, { label: "Check again", icon: "undo", small: true, fk: "ban:recheck", onClick: refresh })]));
      } else if (cop && cop.loggedIn === false) {
        el.append(banner("warn", "alert", "Copilot is not signed in", "Sign in from a terminal, then check again. Nothing runs until you do.", [copyRow(result?.loginCommand || "copilot login", "ban:login"), btn(app, { label: "Check again", icon: "undo", small: true, fk: "ban:recheck", onClick: refresh })]));
      } else if (cop && cop.loggedIn === "unknown") {
        el.append(banner("soft", "help", "Sign-in status unknown", "Arcade can't tell whether Copilot is signed in. If an agent fails to start, run the login command in a terminal.", [copyRow(result?.loginCommand || "copilot login", "ban:login2")]));
      }
      if (gitMissing) el.append(banner("warn", "alert", "git was not found", "Agents work in separate git worktrees, so git is needed. Install git and reload.", []));
      if (notRepo) el.append(banner("soft", "help", "This folder is not a git repository", "Agents will run one at a time, directly in the folder, with no separate branches to merge. Initialise a repo for parallel work.", []));
    });
  }

  return { el: health.el, update, refresh };
}

function banner(tone, ic, title, body, actions) {
  return h("div", { class: ["banner", "banner-" + tone], role: tone === "bad" ? "alert" : "status" }, icon(ic, { size: 18 }), h("div", { class: "banner-text" }, h("strong", {}, title), h("span", {}, " " + body)), actions?.length ? h("div", { class: "banner-actions" }, actions) : null);
}
