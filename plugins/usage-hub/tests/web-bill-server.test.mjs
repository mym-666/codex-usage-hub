import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startWebBillServer } from "../runtime/web-bill-server.mjs";
import { readJsonSafe } from "../runtime/fs-atomic.mjs";

const EXTENSION_ORIGIN = "chrome-extension://" + "a".repeat(32);
const TODAY = new Date().toISOString().slice(0, 10);

function rawRequest(port, options = {}) {
  const { method = "GET", path: urlPath = "/", headers = {}, body = null, timeout = 5000 } = options;
  const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, headers, timeout });
  const promise = new Promise((resolve) => {
    let settled = false;
    req.on("response", (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", (error) => {
      if (settled) return;
      settled = true;
      resolve({ status: 0, headers: {}, text: "", json: null, error: error.code || error.message });
    });
    req.on("timeout", () => {
      if (settled) return;
      settled = true;
      req.destroy();
      resolve({ status: 0, headers: {}, text: "", json: null, error: "timeout" });
    });
  });
  if (body !== null) req.write(body);
  req.end();
  return { promise, req };
}

async function withServer(t, run) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "usage-hub-wbs-"));
  let shutdownCalls = 0;
  const handle = await startWebBillServer({
    dataDir,
    port: 0,
    host: "127.0.0.1",
    onShutdown: () => {
      shutdownCalls += 1;
    }
  });
  const token = (await readJsonSafe(path.join(dataDir, "receiver-token.json"), {})).token;
  try {
    await run({ port: handle.port, dataDir, handle, token, shutdownCalls: () => shutdownCalls });
  } finally {
    await handle.stop();
    await fsp.rm(dataDir, { recursive: true, force: true });
  }
}

function validBill(extra = {}) {
  return JSON.stringify({ provider: "deepseek", date: TODAY, currency: "CNY", cost: 1.5, tokens: { input: 10, output: 5, total: 15 }, tokenSource: "api", ...extra });
}

test("health answers loopback clients and never sends a wildcard CORS header", (t) =>
  withServer(t, async ({ port }) => {
    const res = await rawRequest(port, { path: "/health" }).promise;
    assert.equal(res.status, 200);
    assert.equal(res.json.service, "usage-hub-web-bill");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  }));

test("a web page origin is rejected on every write route (V1)", (t) =>
  withServer(t, async ({ port, dataDir }) => {
    for (const urlPath of ["/web-bill", "/web-bill-status", "/request-refresh", "/shutdown"]) {
      const res = await rawRequest(port, {
        method: "POST",
        path: urlPath,
        headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
        body: "{}"
      }).promise;
      assert.equal(res.status, 403, `${urlPath} must reject a web origin`);
      assert.equal(res.json.reason, "origin-not-allowed");
    }
    assert.equal(await readJsonSafe(path.join(dataDir, "web-bills.json"), null), null);
  }));

test("Sec-Fetch-Site cross-site is rejected even with an allowed-looking origin", (t) =>
  withServer(t, async ({ port }) => {
    const res = await rawRequest(port, {
      method: "POST",
      path: "/web-bill",
      headers: { Origin: "https://platform.deepseek.com", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      body: validBill()
    }).promise;
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "cross-site-blocked");
  }));

test("a forged Host header is rejected (DNS rebinding)", (t) =>
  withServer(t, async ({ port }) => {
    const res = await rawRequest(port, { path: "/health", headers: { Host: "evil.example" } }).promise;
    assert.equal(res.status, 403);
    assert.equal(res.json.reason, "invalid-host");
  }));

test("extension origins are accepted and can post a bill", (t) =>
  withServer(t, async ({ port, dataDir }) => {
    const res = await rawRequest(port, {
      method: "POST",
      path: "/web-bill",
      headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
      body: validBill()
    }).promise;
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    const cache = await readJsonSafe(path.join(dataDir, "web-bills.json"), null);
    assert.equal(cache.bills.deepseek.cost, 1.5);
    assert.equal(cache.bills.deepseek.tokenSource, "api");
  }));

test("shutdown and request-refresh require the receiver token", (t) =>
  withServer(t, async ({ port, token, shutdownCalls }) => {
    const noToken = await rawRequest(port, { method: "POST", path: "/shutdown" }).promise;
    assert.equal(noToken.status, 403);
    assert.equal(shutdownCalls(), 0);

    const wrongToken = await rawRequest(port, {
      method: "POST",
      path: "/shutdown",
      headers: { "X-Usage-Hub-Token": "f".repeat(32) }
    }).promise;
    assert.equal(wrongToken.status, 403);

    const withToken = await rawRequest(port, {
      method: "POST",
      path: "/shutdown",
      headers: { Authorization: `Bearer ${token}` }
    }).promise;
    assert.equal(withToken.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(shutdownCalls(), 1);

    const refreshNoToken = await rawRequest(port, { method: "POST", path: "/request-refresh" }).promise;
    assert.equal(refreshNoToken.status, 403);
    const refreshWithToken = await rawRequest(port, {
      method: "POST",
      path: "/request-refresh",
      headers: { "X-Usage-Hub-Token": token }
    }).promise;
    assert.equal(refreshWithToken.status, 200);
    assert.equal(refreshWithToken.json.ok, true);
  }));

test("prototype-polluting provider keys are rejected (V8)", (t) =>
  withServer(t, async ({ port, dataDir }) => {
    const res = await rawRequest(port, {
      method: "POST",
      path: "/web-bill",
      headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "__proto__", date: TODAY, cost: 9 })
    }).promise;
    assert.equal(res.status, 400);
    for (const hostile of ["constructor", "prototype", "toString"]) {
      const res2 = await rawRequest(port, {
        method: "POST",
        path: "/web-bill",
        headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ provider: hostile, date: TODAY, cost: 9 })
      }).promise;
      assert.ok(res2.status === 400 || res2.status === 200, "unexpected " + res2.status);
      if (hostile !== "toString") assert.equal(res2.status, 400, hostile + " must be rejected");
    }
    const ok = await rawRequest(port, {
      method: "POST",
      path: "/web-bill",
      headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
      body: validBill()
    }).promise;
    assert.equal(ok.status, 200);
    const cache = await readJsonSafe(path.join(dataDir, "web-bills.json"), null);
    // The in-memory bills container is null-prototype, so "toString" is stored as
    // an ordinary own key instead of shadowing Object.prototype.toString.
    assert.equal(Object.prototype.hasOwnProperty.call(cache.bills, "toString"), true);
    assert.equal(cache.bills.deepseek.cost, 1.5);
    assert.equal(cache.bills.constructor?.date, undefined, "no reserved key may survive as bill data");
    assert.equal({}.polluted, undefined, "Object.prototype must stay clean");
    assert.equal(Object.prototype.toString.call({}), "[object Object]");
  }));

test("20 concurrent authenticated refresh requests all succeed (B2)", (t) =>
  withServer(t, async ({ port, token, dataDir }) => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        rawRequest(port, {
          method: "POST",
          path: "/request-refresh",
          headers: { "X-Usage-Hub-Token": token, "Content-Type": "application/json" },
          body: "{}"
        }).promise
      )
    );
    assert.ok(results.every((res) => res.status === 200), JSON.stringify(results.map((r) => r.status)));
    const leftovers = (await fsp.readdir(dataDir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  }));

test("long-poll waiters are capped at 16", (t) =>
  withServer(t, async ({ port }) => {
    const pending = Array.from({ length: 16 }, () => rawRequest(port, { path: "/refresh-request?wait=1", timeout: 8000 }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    const overflow = await rawRequest(port, { path: "/refresh-request?wait=20", timeout: 8000 }).promise;
    const elapsed = Date.now() - started;
    assert.equal(overflow.status, 200);
    assert.equal(overflow.json.requested, false);
    assert.ok(elapsed < 2000, `overflow request must not queue, took ${elapsed}ms`);
    await Promise.all(pending.map((item) => item.promise));
  }));

test("an oversized body is refused and nothing is cached", (t) =>
  withServer(t, async ({ port, dataDir }) => {
    const huge = JSON.stringify({ provider: "deepseek", date: TODAY, cost: 1, sourceUrl: "x".repeat(300 * 1024) });
    const res = await rawRequest(port, {
      method: "POST",
      path: "/web-bill",
      headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(huge) },
      body: huge
    }).promise;
    assert.ok(res.status === 413 || res.status === 0, `expected 413 or a reset, got ${res.status} ${res.error || ""}`);
    const cache = await readJsonSafe(path.join(dataDir, "web-bills.json"), null);
    assert.equal(cache, null);
  }));

test("preflight echoes an allowed origin and refuses a hostile one", (t) =>
  withServer(t, async ({ port }) => {
    const ok = await rawRequest(port, {
      method: "OPTIONS",
      path: "/web-bill",
      headers: { Origin: EXTENSION_ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Private-Network": "true" }
    }).promise;
    assert.equal(ok.status, 204);
    assert.equal(ok.headers["access-control-allow-origin"], EXTENSION_ORIGIN);
    assert.equal(ok.headers["access-control-allow-private-network"], "true");

    const bad = await rawRequest(port, { method: "OPTIONS", path: "/web-bill", headers: { Origin: "https://evil.example" } }).promise;
    assert.equal(bad.status, 403);
  }));
test("web-balance accepts validated wallets from the extension origin", (t) =>
  withServer(t, async ({ port, dataDir }) => {
    const body = JSON.stringify({
      provider: "deepseek",
      currency: "CNY",
      wallets: [
        { kind: "normal", currency: "CNY", balance: 11.02 },
        { kind: "bonus", currency: "CNY", balance: 0.5 }
      ],
      sourceUrl: "https://platform.deepseek.com/usage",
      extensionVersion: "1.7.0"
    });
    const denied = await rawRequest(port, {
      method: "POST",
      path: "/web-balance",
      headers: { "content-type": "application/json", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
      body
    }).promise;
    assert.equal(denied.status, 403);
    assert.equal(denied.headers["access-control-allow-origin"], undefined);
    assert.equal(await readJsonSafe(path.join(dataDir, "web-balance.json"), null), null, "a rejected origin must not write");

    const ok = await rawRequest(port, {
      method: "POST",
      path: "/web-balance",
      headers: { "content-type": "application/json", Origin: EXTENSION_ORIGIN },
      body
    }).promise;
    assert.equal(ok.status, 200);
    assert.equal(ok.json.balance.available, 11.52);
    assert.equal(ok.json.balance.currency, "CNY");
    assert.equal(ok.json.balance.provider, "deepseek");

    const stored = await readJsonSafe(path.join(dataDir, "web-balance.json"), null);
    assert.equal(stored.available, 11.52);
    assert.equal(stored.wallets.length, 2);
    assert.ok(stored.capturedAt, "the receiver stamps capturedAt itself");
  }));

test("web-balance drops negative, malformed and foreign-currency wallets", (t) =>
  withServer(t, async ({ port, dataDir }) => {
    const headers = { "content-type": "application/json", Origin: EXTENSION_ORIGIN };
    const negative = await rawRequest(port, { method: "POST", path: "/web-balance", headers, body: JSON.stringify({ wallets: [{ currency: "CNY", balance: -5 }] }) }).promise;
    assert.equal(negative.status, 400);

    const junk = await rawRequest(port, { method: "POST", path: "/web-balance", headers, body: JSON.stringify({ wallets: "not-an-array" }) }).promise;
    assert.equal(junk.status, 400);

    const filtered = await rawRequest(port, {
      method: "POST",
      path: "/web-balance",
      headers,
      body: JSON.stringify({
        wallets: [
          { kind: "normal", currency: "CNY", balance: 3 },
          { kind: "normal", currency: "CNY", balance: -1 },
          { kind: "normal", currency: "EURO", balance: 9 }
        ]
      })
    }).promise;
    assert.equal(filtered.status, 200);
    assert.equal(filtered.json.balance.available, 3, "only the valid wallet contributes");
    assert.equal(filtered.json.balance.wallets.length, 1);
    assert.equal((await readJsonSafe(path.join(dataDir, "web-balance.json"), null)).available, 3);

    const explicit = await rawRequest(port, { method: "POST", path: "/web-balance", headers, body: JSON.stringify({ available: 7.5, currency: "USD" }) }).promise;
    assert.equal(explicit.status, 200);
    assert.equal(explicit.json.balance.available, 7.5);
    assert.equal(explicit.json.balance.currency, "USD");
    assert.deepEqual(explicit.json.balance.wallets, []);
  }));
