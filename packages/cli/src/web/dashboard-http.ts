// HTTP helpers shared by the web console server: request guards, JSON/text/file responses.
import { type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { URL } from "node:url";
import { isIP } from "node:net";
import { z } from "zod";
import { TeamAuth } from "./team-auth.js";

export class WebRequestError extends Error {
  constructor(message: string, readonly statusCode: number) { super(message); }
}

const WEB_HOST_ALIASES: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

export function errorStatusCode(error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  if (error && typeof error === "object" && "statusCode" in error &&
      typeof error.statusCode === "number" && Number.isInteger(error.statusCode) &&
      error.statusCode >= 400 && error.statusCode < 600) return error.statusCode;
  return 500;
}

/** Do not issue a local execution capability through a rebinding hostname. */
export function authorizeWebRequest(req: IncomingMessage, origin: string): void {
  const serverUrl = new URL(origin);
  const authority = req.headers.host;
  if (!authority || !/^[A-Za-z0-9.[\]:-]+$/.test(authority)) throw new WebRequestError("Invalid web application host.", 403);
  const requestOrigin = new URL(`http://${authority}`);
  if ((requestOrigin.hostname !== serverUrl.hostname && !WEB_HOST_ALIASES[requestOrigin.hostname]) ||
      requestOrigin.port !== serverUrl.port) throw new WebRequestError("Use the bound loopback host and port.", 403);
  if (req.headers.origin !== undefined && req.headers.origin !== requestOrigin.origin) {
    throw new WebRequestError("Cross-origin web application requests are not allowed.", 403);
  }
  // An OIDC provider returns through a top-level cross-site GET. Its one-use
  // state and browser cookie are checked by TeamAuth before issuing a session.
  const ssoCallback = req.method === "GET" && /^\/api\/team\/auth\/callback(?:\?|$)/.test(req.url ?? "");
  if (req.url?.startsWith("/api/") && req.headers["sec-fetch-site"] === "cross-site" && !ssoCallback) {
    throw new WebRequestError("Cross-site control requests are not allowed.", 403);
  }
  if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new WebRequestError("Invalid request target.", 400);
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

export function text(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function sendFile(res: ServerResponse, filePath: string, controlToken?: string): void {
  const ext = extname(filePath);
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  res.writeHead(200, {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Content-Type": contentType,
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300",
  });
  let content: string | Buffer = readFileSync(filePath);
  // Inject the per-session control token into HTML pages so the dashboard
  // frontend can attach it to control API requests.
  if (controlToken && ext === ".html") {
    content = content.toString().replace(
      "</head>",
      `<meta name="0-control-token" content="${controlToken}"></head>`,
    );
  }
  res.end(content);
}

export function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let settled = false;
  const onData = (chunk: Buffer | string) => {
    if (settled) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.length;
    if (bytes > maxBytes) {
      settled = true;
      req.removeListener("data", onData);
      req.resume();
      reject(new WebRequestError("Request body too large.", 413));
      return;
    }
    chunks.push(data);
  };
  req.on("data", onData);
  req.on("end", () => {
    if (settled) return;
    settled = true;
    try {
      const data = Buffer.concat(chunks, bytes).toString("utf8");
      resolve(data ? JSON.parse(data) : {});
    } catch { reject(new WebRequestError("Request body is not valid JSON.", 400)); }
  });
  req.on("error", error => {
    if (!settled) { settled = true; reject(error); }
  });
  return promise;
}

export function requireControlToken(req: IncomingMessage, res: ServerResponse, controlToken: string, engineBearer?: string): boolean {
  const provided = req.headers["x-0-control-token"];
  const matches = (a: unknown, b: string) => typeof a === "string" && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const bearer = typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer ") ? req.headers.authorization.slice(7) : undefined;
  if (!matches(provided, controlToken) && !matches(bearer, controlToken) && !(engineBearer && matches(bearer, engineBearer))) {
    json(res, 403, { error: "Invalid or missing control token" });
    return false;
  }
  return true;
}


export function isLoopbackDashboardHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}
