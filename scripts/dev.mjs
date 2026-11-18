#!/usr/bin/env node
// Static-only dev server for UI work: serves public/, shared/ and fixtures/ with no API, so the client falls back to the scripted demo.
// Usage: node scripts/dev.mjs [port]
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mounts = [["/shared/", "shared"], ["/fixtures/", "fixtures"], ["/", "public"]];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".woff2": "font/woff2" };

const port = Number(process.argv[2]) || 4748;

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith("/api/")) { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"ok":false,"error":"No API in dev mode"}'); }
      if (pathname.endsWith("/")) pathname += "index.html";
      const [prefix, dir] = mounts.find(([p]) => pathname.startsWith(p));
      const base = path.join(root, dir);
      const file = path.resolve(base, pathname.slice(prefix.length));
      if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); return res.end("Forbidden"); }
      const info = await stat(file);
      if (!info.isFile()) throw new Error("not a file");
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(await readFile(file));
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found (the UI may still be under construction)");
    }
  })
  .listen(port, "127.0.0.1", () => console.log(`Dev server: http://127.0.0.1:${port}/`));
