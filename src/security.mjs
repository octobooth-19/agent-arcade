// Request guards for the local server: token, Host and Origin checks, plus safe static path resolution.
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function generateToken() {
  return randomBytes(32).toString("base64url");
}

/** Constant-time comparison. Both sides are hashed first so the length is not leaked either. */
export function tokensMatch(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string" || !expected) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(a, b);
}

export function hostAllowed(hostHeader, port) {
  if (typeof hostHeader !== "string") return false;
  const h = hostHeader.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** A missing Origin is fine (same-origin GETs and non-browser clients); a present one must be our own. */
export function originAllowed(originHeader, port) {
  if (originHeader === undefined) return true;
  if (typeof originHeader !== "string") return false;
  const o = originHeader.toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}`;
}

/**
 * Validate one /api request. Returns { ok: true } or { ok: false, status, error }.
 * The query token is accepted only where `allowQueryToken` is set (EventSource cannot send headers).
 */
export function checkApiRequest(req, url, { port, token, needsToken = true, allowQueryToken = false }) {
  if (!hostAllowed(req.headers.host, port)) return { ok: false, status: 403, error: "Host not allowed" };
  if (!originAllowed(req.headers.origin, port)) return { ok: false, status: 403, error: "Origin not allowed" };
  if (req.headers["sec-fetch-site"] === "cross-site") return { ok: false, status: 403, error: "Cross-site request refused" };
  if (!needsToken) return { ok: true };
  let supplied = req.headers["x-arcade-token"];
  if (supplied === undefined && allowQueryToken) supplied = url.searchParams.get("token") ?? undefined;
  if (!tokensMatch(token, Array.isArray(supplied) ? supplied[0] : supplied)) {
    return { ok: false, status: 401, error: "Missing or invalid token" };
  }
  return { ok: true };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
};

export function mimeFor(file) {
  return MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Resolve a URL pathname to a file inside one of the served roots.
 * roots: [{ prefix: "/shared/", dir }, ...] checked in order, with the last entry as the catch-all ("/").
 * Returns { ok: true, file } | { ok: false, status, error }. Never leaves the chosen root (including via symlinks).
 */
export function resolveStatic(pathname, roots) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { ok: false, status: 400, error: "Bad path encoding" };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return { ok: false, status: 400, error: "Bad path" };
  if (!decoded.startsWith("/")) return { ok: false, status: 400, error: "Bad path" };
  const segments = decoded.split("/").filter((s) => s !== "");
  if (segments.some((s) => s === ".." || s === "." || s.startsWith("."))) {
    return { ok: false, status: 403, error: "Path not allowed" };
  }

  let root = null;
  let rest = segments;
  for (const r of roots) {
    if (r.prefix === "/") {
      root = r;
      break;
    }
    const seg = r.prefix.replace(/^\/|\/$/g, "");
    if (segments[0] === seg) {
      root = r;
      rest = segments.slice(1);
      break;
    }
  }
  if (!root) return { ok: false, status: 404, error: "Not found" };

  let rootReal;
  try {
    rootReal = fs.realpathSync(root.dir);
  } catch {
    return { ok: false, status: 404, error: "Not found", missingRoot: true };
  }
  let file = path.join(rootReal, ...rest);
  if (file !== rootReal && !file.startsWith(rootReal + path.sep)) return { ok: false, status: 403, error: "Path not allowed" };
  try {
    let real = fs.realpathSync(file);
    if (fs.statSync(real).isDirectory()) {
      file = path.join(file, "index.html");
      real = fs.realpathSync(file);
    }
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return { ok: false, status: 403, error: "Path not allowed" };
    if (!fs.statSync(real).isFile()) return { ok: false, status: 404, error: "Not found" };
    return { ok: true, file: real };
  } catch {
    return { ok: false, status: 404, error: "Not found", file };
  }
}
