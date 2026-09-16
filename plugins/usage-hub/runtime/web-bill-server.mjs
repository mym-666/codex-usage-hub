import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createNullDict, readJsonSafe, shortStack, writeJsonAtomic } from "./fs-atomic.mjs";

const DEFAULT_PORT = 32146;
const DEFAULT_HOST = "127.0.0.1";
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DEBUG_BYTES = 8 * 1024;
const MAX_MESSAGE_CHARS = 500;
const MAX_SOURCE_URL_CHARS = 1000;
const MAX_WAITERS = 16;
const MAX_BALANCE_WALLETS = 8;
const MAX_WAIT_SECONDS = 25;
const PROVIDER_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
// "__proto__" and friends satisfy the character class above, so they need an
// explicit deny list even though the bills container is null-prototype.
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const ALLOWED_PAGE_ORIGINS = new Set(["https://platform.deepseek.com"]);
const EXTENSION_ORIGIN_PATTERN = /^(?:chrome|moz)-extension:\/\/[a-z0-9-]{8,64}$/i;
const ALLOWED_SEC_FETCH_SITE = new Set(["none", "same-origin"]);
const TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function parseHostHeader(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return null;
    const rest = raw.slice(end + 1);
    return { hostname: raw.slice(1, end), port: rest.startsWith(":") ? rest.slice(1) : "" };
  }
  const idx = raw.lastIndexOf(":");
  if (idx < 0) return { hostname: raw, port: "" };
  return { hostname: raw.slice(0, idx), port: raw.slice(idx + 1) };
}

function originAllowed(origin) {
  // Non-browser clients (the PowerShell overlay, the Node helper) send no Origin.
  if (!origin) return true;
  if (EXTENSION_ORIGIN_PATTERN.test(origin)) return true;
  return ALLOWED_PAGE_ORIGINS.has(origin);
}

/**
 * Loopback-only gate. Rejects DNS-rebinding style Host headers, cross-origin
 * browser requests and any request the browser itself flags as cross-site.
 * Returns null when allowed, otherwise a short machine-readable reason.
 */
function authorizeRequest(req, boundPort) {
  const host = parseHostHeader(req.headers.host);
  if (!host || !ALLOWED_HOSTNAMES.has(host.hostname)) return "invalid-host";
  if (host.port && Number(host.port) !== boundPort) return "invalid-port";
  const origin = req.headers.origin === undefined ? "" : String(req.headers.origin).trim();
  if (origin && !originAllowed(origin)) return "origin-not-allowed";
  // Extension contexts are already authenticated by their origin, and browsers
  // forbid pages from forging either header, so this is a hard gate for the web.
  if (EXTENSION_ORIGIN_PATTERN.test(origin)) return null;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined && !ALLOWED_SEC_FETCH_SITE.has(String(site).trim().toLowerCase())) return "cross-site-blocked";
  return null;
}

function extractToken(req) {
  const header = req.headers["x-usage-hub-token"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (typeof fromHeader === "string" && fromHeader.trim()) return fromHeader.trim();
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function tokensEqual(provided, expected) {
  const left = Buffer.from(String(provided ?? ""), "utf8");
  const right = Buffer.from(String(expected ?? ""), "utf8");
  if (left.length === 0 || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function sendJson(res, status, body, extraHeaders) {
  if (!res || res.headersSent || res.writableEnded) return;
  try {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store",
      ...(extraHeaders || {})
    });
    res.end(text);
  } catch {
    try {
      res.destroy();
    } catch {}
  }
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new Error("request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

async function parseJsonBody(req) {
  const body = await readBody(req);
  if (!body.trim()) return {};
  const parsed = JSON.parse(body);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
  return parsed;
}

function normalizeTokens(value) {
  if (!value || typeof value !== "object") return null;
  const result = {};
  for (const key of ["input", "output", "cacheRead", "cacheCreation", "freshInput", "total"]) {
    const number = Number(value[key]);
    if (Number.isFinite(number) && number >= 0) result[key] = number;
  }
  return Object.keys(result).length ? result : null;
}

function normalizeDebug(value) {
  if (!value || typeof value !== "object") return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!text || Buffer.byteLength(text) > MAX_DEBUG_BYTES) return null;
  return value;
}

const TOKEN_SOURCES = new Set(["api", "estimate", "dom-scrape", "cc-switch"]);

function isSafeProviderKey(value) {
  const text = String(value || "").trim();
  return PROVIDER_PATTERN.test(text) && !RESERVED_KEYS.has(text.toLowerCase());
}

function normalizeBill(payload) {
  const provider = String(payload?.provider || "").trim();
  const date = String(payload?.date || "").trim();
  const currency = String(payload?.currency || "").trim().toUpperCase();
  const hasCost = payload?.cost !== undefined && payload?.cost !== null && payload?.cost !== "";
  const cost = hasCost ? Number(payload.cost) : null;
  const tokens = normalizeTokens(payload?.tokens);
  const debug = normalizeDebug(payload?.debug);
  const tokenSourceRaw = String(payload?.tokenSource || "").trim();
  if (!PROVIDER_PATTERN.test(provider) || RESERVED_KEYS.has(provider.toLowerCase())) {
    throw new Error("provider must match [A-Za-z0-9._-]{1,64} and must not be a reserved key");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date must be YYYY-MM-DD");
  if (cost === null && !tokens && !debug) throw new Error("cost or tokens is required");
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new Error("cost must be a non-negative number");
  return {
    provider,
    date,
    currency: currency || "CNY",
    ...(cost !== null ? { cost } : {}),
    ...(tokens ? { tokens } : {}),
    ...(debug ? { debug } : {}),
    ...(TOKEN_SOURCES.has(tokenSourceRaw) ? { tokenSource: tokenSourceRaw } : {}),
    capturedAt: new Date().toISOString(),
    sourceUrl: String(payload?.sourceUrl || "").slice(0, MAX_SOURCE_URL_CHARS),
    extensionVersion: String(payload?.extensionVersion || "1.0.0").slice(0, 64)
  };
}

function normalizeStatus(payload) {
  return {
    provider: isSafeProviderKey(payload?.provider) ? String(payload.provider).trim() : "deepseek",
    status: "error",
    message: String(payload?.message || "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, MAX_MESSAGE_CHARS) || "network error",
    capturedAt: new Date().toISOString()
  };
}

/**
 * Balance captured from the provider website by the extension. The wallets array is
 * the source of truth (normal + bonus); an explicit `available` is only a fallback,
 * so a page can never smuggle a negative or non-numeric total into the snapshot.
 */
function normalizeBalance(payload) {
  const providerRaw = String(payload?.provider || "deepseek").trim();
  const provider = isSafeProviderKey(providerRaw) ? providerRaw : "deepseek";
  const wallets = [];
  const list = Array.isArray(payload?.wallets) ? payload.wallets.slice(0, MAX_BALANCE_WALLETS) : [];
  for (const item of list) {
    const currency = String(item?.currency || "").trim().toUpperCase();
    const balance = Number(item?.balance);
    if (!CURRENCY_PATTERN.test(currency)) continue;
    if (!Number.isFinite(balance) || balance < 0) continue;
    wallets.push({
      kind: String(item?.kind || "normal") === "bonus" ? "bonus" : "normal",
      currency,
      balance
    });
  }
  const explicit = Number(payload?.available);
  const available = wallets.length
    ? wallets.reduce((sum, wallet) => sum + wallet.balance, 0)
    : Number.isFinite(explicit) && explicit >= 0
      ? explicit
      : null;
  if (available === null) throw new Error("available or wallets is required");
  const declaredCurrency = String(payload?.currency || "").trim().toUpperCase();
  return {
    provider,
    currency: CURRENCY_PATTERN.test(declaredCurrency) ? declaredCurrency : wallets[0]?.currency || "CNY",
    available,
    wallets,
    capturedAt: new Date().toISOString(),
    sourceUrl: String(payload?.sourceUrl || "").slice(0, MAX_SOURCE_URL_CHARS),
    extensionVersion: String(payload?.extensionVersion || "1.0.0").slice(0, 64)
  };
}
async function ensureReceiverToken(dataDir) {
  const tokenPath = path.join(dataDir, "receiver-token.json");
  const existing = await readJsonSafe(tokenPath, null);
  if (existing && typeof existing.token === "string" && TOKEN_PATTERN.test(existing.token)) {
    return { tokenPath, token: existing.token };
  }
  const token = crypto.randomBytes(16).toString("hex");
  await writeJsonAtomic(tokenPath, { token, createdAt: new Date().toISOString() }, { mode: 0o600 });
  return { tokenPath, token };
}

export async function startWebBillServer(options = {}) {
  const dataDir = options.dataDir;
  if (!dataDir) throw new Error("dataDir is required");
  const host = options.host || DEFAULT_HOST;
  const port = Number(options.port ?? DEFAULT_PORT);
  const cachePath = path.join(dataDir, "web-bills.json");
  const refreshPath = path.join(dataDir, "refresh-request.json");
  const balancePath = path.join(dataDir, "web-balance.json");
  const statusPath = path.join(dataDir, "web-bill-status.json");
  const waiters = new Set();

  const { tokenPath, token } = await ensureReceiverToken(dataDir);

  function finishWaiter(waiter, body) {
    if (!waiter || waiter.done) return;
    waiter.done = true;
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    sendJson(waiter.res, 200, body);
  }

  function broadcastRefresh(requestedAt) {
    for (const waiter of [...waiters]) finishWaiter(waiter, { ok: true, requested: true, requestedAt });
  }

  const server = http.createServer(async (req, res) => {
    const boundPort = server.address()?.port || port;
    try {
      const denial = authorizeRequest(req, boundPort);
      if (denial) {
        sendJson(res, 403, { ok: false, error: "forbidden", reason: denial });
        return;
      }

      if (req.method === "OPTIONS") {
        const origin = String(req.headers.origin || "").trim();
        res.writeHead(204, {
          ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
          "Access-Control-Allow-Headers": "Content-Type, X-Usage-Hub-Token, Authorization",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Max-Age": "600",
          ...(req.headers["access-control-request-private-network"] === "true"
            ? { "Access-Control-Allow-Private-Network": "true" }
            : {})
        });
        res.end();
        return;
      }

      const url = new URL(req.url || "/", `http://${host}`);
      const isWrite = req.method === "POST";

      if (req.method === "GET" && url.pathname === "/health") {
        const refresh = await readJsonSafe(refreshPath, null);
        const status = await readJsonSafe(statusPath, null);
        sendJson(res, 200, {
          ok: true,
          service: "usage-hub-web-bill",
          port: boundPort,
          refreshPending: Boolean(refresh?.requestedAt),
          webBillStatus: status
        });
        return;
      }

      if (isWrite && url.pathname === "/request-refresh") {
        if (!tokensEqual(extractToken(req), token)) {
          sendJson(res, 403, { ok: false, error: "invalid token" });
          return;
        }
        const requestedAt = new Date().toISOString();
        await writeJsonAtomic(refreshPath, { requestedAt });
        broadcastRefresh(requestedAt);
        sendJson(res, 200, { ok: true, requestedAt });
        return;
      }

      if (isWrite && url.pathname === "/shutdown") {
        if (!tokensEqual(extractToken(req), token)) {
          sendJson(res, 403, { ok: false, error: "invalid token" });
          return;
        }
        sendJson(res, 200, { ok: true, shuttingDown: true });
        if (typeof options.onShutdown === "function") {
          const onShutdown = options.onShutdown;
          setTimeout(() => {
            try {
              onShutdown();
            } catch {}
          }, 25);
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/refresh-request") {
        const waitSeconds = Math.max(0, Math.min(MAX_WAIT_SECONDS, Number(url.searchParams.get("wait") || 0)));
        const refresh = await readJsonSafe(refreshPath, null);
        if (refresh?.requestedAt) {
          await fs.rm(refreshPath, { force: true });
          sendJson(res, 200, { ok: true, requested: true, requestedAt: refresh.requestedAt });
          return;
        }
        if (!waitSeconds || waiters.size >= MAX_WAITERS) {
          sendJson(res, 200, { ok: true, requested: false });
          return;
        }
        const waiter = { res, done: false, timer: null };
        waiter.timer = setTimeout(() => finishWaiter(waiter, { ok: true, requested: false }), waitSeconds * 1000);
        waiters.add(waiter);
        req.on("close", () => finishWaiter(waiter, { ok: true, requested: false }));
        return;
      }

      if (isWrite && url.pathname === "/web-bill-status") {
        const status = normalizeStatus(await parseJsonBody(req));
        await writeJsonAtomic(statusPath, status);
        sendJson(res, 200, { ok: true, status });
        return;
      }

      if (isWrite && url.pathname === "/web-balance") {
        const balance = normalizeBalance(await parseJsonBody(req));
        await writeJsonAtomic(balancePath, balance);
        sendJson(res, 200, { ok: true, balance });
        return;
      }
      if (isWrite && url.pathname === "/web-bill") {
        const bill = normalizeBill(await parseJsonBody(req));
        const parsedCache = await readJsonSafe(cachePath, null);
        const cache = {
          version: 1,
          bills: createNullDict(parsedCache?.bills)
        };
        const prior = Object.prototype.hasOwnProperty.call(cache.bills, bill.provider) ? cache.bills[bill.provider] : null;
        if (prior && prior.date === bill.date) {
          cache.bills[bill.provider] = {
            ...prior,
            ...bill,
            currency: bill.currency || prior.currency,
            cost: bill.cost !== undefined ? bill.cost : prior.cost,
            tokens: bill.tokens || prior.tokens,
            tokenSource: bill.tokenSource || prior.tokenSource,
            capturedAt: bill.capturedAt
          };
        } else {
          cache.bills[bill.provider] = bill;
        }
        await writeJsonAtomic(cachePath, cache);
        await fs.rm(statusPath, { force: true });
        sendJson(res, 200, { ok: true, bill: cache.bills[bill.provider] });
        return;
      }

      sendJson(res, 404, { ok: false, error: "not found" });
    } catch (error) {
      const message = String(error?.message || "bad request");
      sendJson(res, message === "request too large" ? 413 : 400, { ok: false, error: message });
    }
  });

  server.on("clientError", (_error, socket) => {
    try {
      if (socket && !socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    } catch {}
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });

  // Keep a permanent error listener attached: without one, a later socket or
  // listen error becomes an uncaught exception that kills the daemon.
  server.on("error", (error) => {
    if (typeof options.onError === "function") {
      try {
        options.onError(error);
      } catch {}
    }
  });

  return {
    server,
    cachePath,
    balancePath,
    refreshPath,
    statusPath,
    tokenPath,
    port: server.address().port,
    async stop() {
      for (const waiter of [...waiters]) finishWaiter(waiter, { ok: true, requested: false });
      waiters.clear();
      try {
        server.closeAllConnections?.();
      } catch {}
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  };
}

export { DEFAULT_PORT, MAX_WAITERS, PROVIDER_PATTERN, authorizeRequest, ensureReceiverToken, normalizeBalance, normalizeBill, normalizeStatus, tokensEqual };
export function describeListenError(error) {
  return { code: error?.code || "unknown", message: shortStack(error, 1), at: new Date().toISOString() };
}