// Help dialog: how the app works, keyboard shortcuts, and what is (and is not) real.
import { h } from "./util.js";
import { openDialog } from "./dialogs.js";
import { HOLD_COPY } from "./model.js";

export const SHORTCUTS = [
  [["Ctrl/\u2318", "K"], "Open the command palette"],
  [["?"], "Open this help"],
  [["j"], "Next item in Needs you"],
  [["k"], "Previous item in Needs you"],
  [["a"], "Do the highlighted item's main action (for an approval: Allow once)"],
  [["d"], "Deny the highlighted approval, or reject a suggestion"],
  [["h"], "Hold the selected agent"],
  [["r"], "Resume the selected agent"],
  [["Esc"], "Close a dialog"],
];

export function openHelp(app) {
  const live = app.baseArcade?.source === "live";
  openDialog({
    title: "How Agent Arcade works",
    wide: true,
    build: () => [
      h("section", { class: "help-sec" },
        h("h3", {}, "The loop"),
        h("ol", { class: "help-list" },
          h("li", {}, h("strong", {}, "You set the goal."), " Say what you want in plain words."),
          h("li", {}, h("strong", {}, "The Foreman splits it into work orders."), " You read them, edit if you like, and press Approve & start."),
          h("li", {}, h("strong", {}, "Agents work. You steer."), " Anything that needs a human lands in Needs you. Nothing is approved for you."),
        ),
      ),
      h("section", { class: "help-sec" },
        h("h3", {}, live ? "What's real" : "What you're looking at"),
        h("p", {}, live ? "You're connected to your own GitHub Copilot CLI. Agents are real Copilot sessions in this project and may use your Copilot premium requests. Merges only happen when you approve them, and nothing is pushed." : "This is the scripted demo. A recording-like script plays out so you can try every control. No Copilot sessions run and nothing touches your files. Start the server from a terminal to go live."),
      ),
      h("section", { class: "help-sec" },
        h("h3", {}, "Steering, honestly"),
        h("dl", { class: "kvs" },
          kv("Hold", HOLD_COPY),
          kv("Nudge", "Queued, then sent as the next prompt when the current step ends."),
          kv("Redirect", "Sent right away. It pre-empts the step in progress."),
          kv("Take over", "Parks the agent so you can work in its folder. Hand back when done."),
        ),
        h("p", { class: "muted small" }, "Each note shows a receipt: Queued, then Delivered at step N, or Failed. Nothing here is instant."),
      ),
      h("section", { class: "help-sec" },
        h("h3", {}, "Keyboard"),
        h("dl", { class: "shortcuts" }, SHORTCUTS.map(([keys, what]) => h("div", { class: "kv" }, h("dt", {}, keys.map((k, i) => [i ? " + " : "", h("kbd", {}, k)])), h("dd", {}, what)))),
        h("p", { class: "muted small" }, "Shortcuts never fire while you're typing in a box."),
      ),
      h("section", { class: "help-sec" },
        h("h3", {}, "Creator"),
        h("p", {}, "Created by ", h("strong", {}, "kumarsashank"), "."),
        h("p", {}, "GitHub: ", h("a", { href: "https://github.com/KumarSashank", target: "_blank", rel: "noopener noreferrer" }, "@kumarsashank")),
      ),
    ],
  });
}

const kv = (k, v) => h("div", { class: "kv" }, h("dt", {}, k), h("dd", {}, v));
