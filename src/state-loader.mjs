// Loads the shared reducer. shared/state.js is a plain ".js" ES module without a package.json "type" field, which
// older Node versions (18, early 20) refuse to import. Fall back to importing its source through a data: URL.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const STATE_FILE = path.resolve(here, "..", "shared", "state.js");

export async function loadViaDataUrl(file = STATE_FILE) {
  const src = fs.readFileSync(file, "utf8");
  return import("data:text/javascript;base64," + Buffer.from(src).toString("base64"));
}

async function load() {
  try {
    return await import(pathToFileURL(STATE_FILE).href);
  } catch {
    return loadViaDataUrl();
  }
}

const mod = await load();
export const { createInitialState, reduce, rebuild, openInbox, activeWorkerCount, describeEvent, newWorker } = mod;
