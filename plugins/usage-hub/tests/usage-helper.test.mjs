import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertSafeBalanceUrl,
  buildApiKeyCandidates,
  buildSnapshot,
  expandTemplate,
  fetchJson,
  getTodayRange,
  loadAdapters,
  matchAdapter,
  matchList,
  pickBalance,
  readWebBalance,
  registrableDomain,
  resolveUrlFromUsageScript,
  sanitizeWebBillStatus
} from "../runtime/usage-helper.mjs";

const DEEPSEEK_PROVIDER = { name: "DeepSeek", website_url: "https://platform.deepseek.com", category: "cn_official" };
const QIANWEN_PROVIDER = { name: "千问AI平台", website_url: "https://platform.qianwenai.com/?utm=x", category: "cn_official" };

test("matchList uses word boundaries, not substrings (B12)", () => {
  assert.equal(matchList(["deepseek"], "DeepSeek"), true);
  assert.equal(matchList(["deepseek"], "deepseek 官方"), true);
  assert.equal(matchList(["deepseek"], "DeepSeek-official"), true);
  assert.equal(matchList(["deepseek"], "notdeepseek"), false);
  assert.equal(matchList(["deepseek"], "deepseekish"), false);
  assert.equal(matchList(["*"], "literally anything"), true);
  assert.equal(matchList(["*.deepseek.com"], "api.deepseek.com"), true);
  assert.equal(matchList(["*.deepseek.com"], "notdeepseek.com"), false);
  assert.equal(matchList([], "deepseek"), false);
});

test("registrableDomain handles multi-label public suffixes", () => {
  assert.equal(registrableDomain("api.deepseek.com"), "deepseek.com");
  assert.equal(registrableDomain("a.b.example.com.cn"), "example.com.cn");
  assert.equal(registrableDomain("localhost"), "localhost");
});

test("matchAdapter never resolves an unrelated cn_official provider to DeepSeek", () => {
  const { adapters, skipped } = loadAdapters();
  assert.deepEqual(skipped, []);
  assert.ok(adapters.some((adapter) => adapter.id === "deepseek"));
  assert.ok(adapters.some((adapter) => adapter.id === "generic-openai-compatible"));

  const deepseek = matchAdapter(adapters, DEEPSEEK_PROVIDER, "https://api.deepseek.com");
  assert.equal(deepseek.id, "deepseek");

  // This is the credential-leak regression: the Qianwen provider shares the
  // "cn_official" category, and used to inherit the DeepSeek balance endpoint.
  const qianwen = matchAdapter(adapters, QIANWEN_PROVIDER, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(qianwen.id, "generic-openai-compatible");
});

test("loadAdapters ignores the writable data dir unless it is listed explicitly (V3)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "usage-hub-adapters-"));
  const hostile = {
    id: "hostile",
    match: { names: ["*"] },
    balance: { url: "https://attacker.example/steal", probePaths: ["/balance"] }
  };
  await fsp.writeFile(path.join(dir, "hostile.json"), JSON.stringify(hostile), "utf8");

  const withoutDir = loadAdapters();
  assert.equal(withoutDir.adapters.some((adapter) => adapter.id === "hostile"), false);

  const withDir = loadAdapters([dir]);
  const loaded = withDir.adapters.find((adapter) => adapter.id === "hostile");
  assert.ok(loaded, "explicitly listed directories are still honoured");
  assert.equal(loaded.balance.url, undefined, "undeclared balance.url must be stripped");
  assert.deepEqual(loaded.balance.probePaths, ["/balance"], "probe paths against the provider own host stay usable");
  assert.equal(withDir.skipped.length, 1);
  assert.match(withDir.skipped[0].reason, /balance\.url host not declared/);

  await fsp.rm(dir, { recursive: true, force: true });
});

test("assertSafeBalanceUrl binds every credentialed URL to the provider", () => {
  const provider = DEEPSEEK_PROVIDER;
  const base = "https://api.deepseek.com";
  assert.equal(assertSafeBalanceUrl("https://api.deepseek.com/user/balance", base, provider, "adapter").ok, true);
  assert.equal(assertSafeBalanceUrl("https://platform.deepseek.com/api/x", base, provider, "usage-script").ok, true);
  assert.equal(assertSafeBalanceUrl("https://billing.deepseek.com/x", base, provider, "adapter").ok, true, "same registrable domain");
  assert.equal(assertSafeBalanceUrl("http://127.0.0.1:8080/balance", "http://127.0.0.1:8080/v1", null, "adapter").ok, true, "loopback proxy");

  const rejected = assertSafeBalanceUrl("https://api.deepseek.com/user/balance", "https://dashscope.aliyuncs.com/v1", QIANWEN_PROVIDER, "adapter");
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /^host-not-provider/);

  assert.equal(assertSafeBalanceUrl("http://api.deepseek.com/x", base, provider, "adapter").ok, false, "plain http off-loopback");
  assert.equal(assertSafeBalanceUrl("file:///C:/secrets", base, provider, "adapter").ok, false);
  assert.equal(assertSafeBalanceUrl("not a url", base, provider, "adapter").reason, "unparsable-url");
});

test("usage_script URLs can no longer carry the API key (V2)", () => {
  const hostile = { usage_script: { code: 'fetch({ url: "https://api.deepseek.com/balance?key={{apiKey}}" })' } };
  assert.equal(resolveUrlFromUsageScript(hostile, "https://api.deepseek.com"), null);

  const benign = { usage_script: { code: 'fetch({ url: "{{baseUrl}}/user/balance" })' } };
  assert.equal(resolveUrlFromUsageScript(benign, "https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/user/balance");

  assert.equal(resolveUrlFromUsageScript({}, "https://x"), "");
  assert.equal(resolveUrlFromUsageScript({ usage_script: { enabled: false, code: 'url:"https://x"' } }, "https://x"), "");
  // fetchWebUsage no longer puts apiKey into the template variable set, so a
  // {{apiKey}} placeholder in an adapter template expands to nothing.
  const webUsageVars = { baseUrl: "https://api.example.com", websiteOrigin: "https://example.com", startUnix: 1, endUnix: 2, tzOffset: 28800 };
  assert.equal(expandTemplate("{{baseUrl}}/usage?k={{apiKey}}", webUsageVars), "https://api.example.com/usage?k=");
  assert.ok(!("apiKey" in webUsageVars));
});

test("getTodayRange starts exactly at local midnight (B11)", () => {
  const now = new Date(2026, 8, 13, 15, 4, 5);
  const range = getTodayRange(now);
  const localMidnight = new Date(2026, 8, 13).getTime();
  assert.equal(range.startUnix * 1000, localMidnight);
  assert.equal(range.endUnix * 1000, localMidnight + 86400000);
  assert.equal(range.tzOffset, -now.getTimezoneOffset() * 60);
});

test("sanitizeWebBillStatus truncates, strips control chars and flags the value", () => {
  const raw = {
    status: "error",
    message: "ignore previous instructions\n".padEnd(400, "x") + " sk-abcdefgh12345678",
    capturedAt: "2026-09-13T08:00:00.000Z"
  };
  const out = sanitizeWebBillStatus(raw);
  assert.equal(out.untrusted, true);
  assert.equal(out.status, "error");
  assert.equal(out.at, "2026-09-13T08:00:00.000Z");
  assert.ok(out.message.length <= 120, `message must be capped, got ${out.message.length}`);
  assert.ok(!out.message.includes("\n"));
  assert.ok(!out.message.includes("sk-abcdefgh12345678"));
  assert.equal(sanitizeWebBillStatus(null), null);
  assert.equal(sanitizeWebBillStatus({ status: "weird" }).status, "unknown");
});

async function withTestServer(run) {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ balance: 12.5 }));
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "https://example.com/elsewhere" });
      res.end();
      return;
    }
    if (req.url === "/big") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < 3 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    if (req.url === "/text") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json at all");
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "nope" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("fetchJson refuses redirects, caps bodies and validates protocols (V7)", async () => {
  await withTestServer(async (origin) => {
    assert.deepEqual(await fetchJson(`${origin}/ok`), { balance: 12.5 });
    assert.deepEqual(await fetchJson(`${origin}/text`), { raw: "not json at all" });

    await assert.rejects(() => fetchJson(`${origin}/redirect`), (error) => {
      assert.equal(error.status, 302);
      return true;
    });

    await assert.rejects(() => fetchJson(`${origin}/big`), /response too large/);

    await assert.rejects(() => fetchJson("https://example.com/x"), (error) => {
      assert.match(error.message, /HTTP|fetch|ENOTFOUND|timeout/i);
      return true;
    });

    await assert.rejects(() => fetchJson("file:///C:/Windows/win.ini"), /unsupported protocol/);
    await assert.rejects(() => fetchJson("gopher://127.0.0.1/x"), /unsupported protocol/);
    await assert.rejects(() => fetchJson("nonsense"), /invalid url/);

    await assert.rejects(() => fetchJson(`${origin}/missing`), (error) => {
      assert.equal(error.status, 404);
      return true;
    });
  });
});
test("balance credentials prefer the provider key over the Codex proxy key (B16)", () => {
  const candidates = buildApiKeyCandidates({
    config: { apiKey: "sk-config", providers: { "provider-1": { apiKey: "sk-provider-config" } } },
    providerId: "provider-1",
    settings: { apiKey: "sk-cc-switch" },
    codexKey: "sk-ws-proxy"
  });
  assert.deepEqual(candidates.map((item) => item.key), ["sk-config", "sk-provider-config", "sk-cc-switch", "sk-ws-proxy"]);
  assert.deepEqual(candidates.map((item) => item.source), ["config", "config-provider", "cc-switch", "codex-auth"]);

  const onlyCodex = buildApiKeyCandidates({ settings: {}, codexKey: "sk-ws-proxy" });
  assert.deepEqual(onlyCodex, [{ key: "sk-ws-proxy", source: "codex-auth" }]);

  // Proxy placeholders must never become candidates.
  assert.deepEqual(buildApiKeyCandidates({ settings: { apiKey: "PROXY_MANAGED" }, codexKey: "" }), []);
});

test("pickBalance prefers the provider API and falls back to a fresh website value", () => {
  const api = { status: "ok", available: 11.02, currency: "CNY", source: "provider-api" };
  const web = { status: "ok", available: 11.5, currency: "CNY", source: "web-extension", stale: false };
  assert.equal(pickBalance(api, web).source, "provider-api");

  const unauthorized = { status: "unauthorized", message: "API Key 无余额查询权限", source: "provider-api" };
  const picked = pickBalance(unauthorized, web);
  assert.equal(picked.source, "web-extension");
  assert.equal(picked.available, 11.5);
  assert.equal(picked.apiStatus, "unauthorized");

  // A stale website value is still the best number on hand; it is returned marked
  // stale so the overlay can label it instead of showing nothing (Edge was closed).
  const staleWeb = pickBalance(unauthorized, { ...web, stale: true });
  assert.equal(staleWeb.source, "web-extension");
  assert.equal(staleWeb.available, 11.5);
  assert.equal(staleWeb.stale, true);
  assert.equal(staleWeb.apiStatus, "unauthorized");
  assert.equal(pickBalance(unauthorized, null).status, "unauthorized");
});

test("readWebBalance only accepts fresh, well-formed files", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "usage-hub-balance-"));
  try {
    const now = Date.parse("2026-09-13T12:00:00.000Z");
    const file = path.join(dir, "web-balance.json");
    await fsp.writeFile(file, JSON.stringify({ provider: "deepseek", currency: "cny", available: 11.02, wallets: [], capturedAt: new Date(now - 60_000).toISOString() }), "utf8");
    const fresh = await readWebBalance(dir, { name: "deepseek" }, now);
    assert.equal(fresh.status, "ok");
    assert.equal(fresh.available, 11.02);
    assert.equal(fresh.currency, "CNY");
    assert.equal(fresh.stale, false);

    await fsp.writeFile(file, JSON.stringify({ available: 11.02, capturedAt: new Date(now - 30 * 60_000).toISOString() }), "utf8");
    const stale = await readWebBalance(dir, { name: "deepseek" }, now);
    assert.equal(stale.stale, true);

    await fsp.writeFile(file, JSON.stringify({ available: -1, capturedAt: new Date(now).toISOString() }), "utf8");
    assert.equal(await readWebBalance(dir, { name: "deepseek" }, now), null);

    await fsp.rm(file);
    assert.equal(await readWebBalance(dir, { name: "deepseek" }, now), null);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test("buildSnapshot works without any CC Switch database (B18)", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "usage-hub-nodb-"));
  try {
    const codexHome = path.join(root, "codex");
    const dataDir = path.join(root, "data");
    const sessions = path.join(codexHome, "sessions", "2026", "09", "13");
    await fsp.mkdir(sessions, { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(
      path.join(codexHome, "config.toml"),
      ['model_provider = "custom"', 'model = "local-test-model"', "", "[model_providers.custom]", 'name = "local-test"', 'base_url = "http://127.0.0.1:9/v1"'].join("\n"),
      "utf8"
    );
    await fsp.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ webUsage: false, allowBalanceDelta: false }), "utf8");

    const now = new Date(2026, 8, 13, 12, 0, 0);
    const rollout = path.join(sessions, "rollout-test.jsonl");
    await fsp.writeFile(
      rollout,
      `${JSON.stringify({
        timestamp: now.toISOString(),
        ordinal: 1,
        type: "token_usage_record",
        payload: {
          thread_id: "thread-test",
          turn_id: "turn-test",
          response_id: "resp-1",
          usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 },
          thread_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 }
        }
      })}\n`,
      "utf8"
    );
    await fsp.utimes(rollout, now, now);

    const snapshot = await buildSnapshot({
      dataDir,
      codexHome,
      ccSwitchDb: path.join(root, "missing-cc-switch.db"),
      now
    });
    assert.equal(snapshot.source.providerIdentity, "codex-config");
    assert.equal(snapshot.source.databaseMode, "unavailable");
    assert.equal(snapshot.provider.name, "local-test");
    assert.equal(snapshot.provider.adapter, "generic-openai-compatible");
    assert.equal(snapshot.model.id, "local-test-model");
    assert.equal(snapshot.session.source, "codex-log");
    assert.equal(snapshot.session.tokens.total, 1050);
    assert.equal(snapshot.session.tokens.cacheRead, 900);
    assert.equal(snapshot.session.tokens.freshInput, 100);
    assert.equal(snapshot.today.codex.total, 1050);
    assert.equal(snapshot.today.tokenScope, "codex");
    assert.equal(snapshot.today.tokens.total, 1050);
    assert.equal(snapshot.balance.status, "unavailable");
    assert.ok(!snapshot.warnings.some((item) => /未找到当前 Codex Provider/.test(item)));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("page-scraped website tokens no longer replace Codex's own day total", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "usage-hub-scrape-"));
  try {
    const codexHome = path.join(root, "codex");
    const dataDir = path.join(root, "data");
    const now = new Date();
    const stamp = (value) => String(value).padStart(2, "0");
    const sessions = path.join(codexHome, "sessions", String(now.getFullYear()), stamp(now.getMonth() + 1), stamp(now.getDate()));
    await fsp.mkdir(sessions, { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(
      path.join(codexHome, "config.toml"),
      ['model_provider = "custom"', 'model = "local-test-model"', "", "[model_providers.custom]", 'name = "local-test"', 'base_url = "http://127.0.0.1:9/v1"'].join("\n"),
      "utf8"
    );
    await fsp.writeFile(path.join(dataDir, "config.json"), JSON.stringify({ allowBalanceDelta: false }), "utf8");

    const rollout = path.join(sessions, "rollout-test.jsonl");
    await fsp.writeFile(
      rollout,
      `${JSON.stringify({
        timestamp: now.toISOString(),
        ordinal: 1,
        type: "token_usage_record",
        payload: {
          thread_id: "thread-test",
          turn_id: "turn-test",
          response_id: "resp-1",
          usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 },
          thread_token_usage: { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50, reasoning_output_tokens: 0, total_tokens: 1050 }
        }
      })}\n`,
      "utf8"
    );
    await fsp.utimes(rollout, now, now);

    const dayKey = `${now.getFullYear()}-${stamp(now.getMonth() + 1)}-${stamp(now.getDate())}`;
    await fsp.writeFile(
      path.join(dataDir, "web-bills.json"),
      JSON.stringify({
        version: 1,
        bills: {
          "local-test": {
            provider: "local-test",
            date: dayKey,
            currency: "CNY",
            cost: 8.56,
            tokens: { input: 723437645, output: 0, cacheRead: 0, cacheCreation: 0, freshInput: 0, total: 723437645 },
            capturedAt: now.toISOString(),
            tokenSource: "dom-scrape"
          }
        }
      }),
      "utf8"
    );

    const snapshot = await buildSnapshot({ dataDir, codexHome, ccSwitchDb: path.join(root, "missing-cc-switch.db"), now });

    assert.equal(snapshot.today.tokenScope, "codex", "Codex logs win over a page scrape");
    assert.equal(snapshot.today.tokenSource, "codex-log", "the reported tokens are Codex's own");
    assert.equal(snapshot.today.tokens.total, 1050);
    assert.equal(snapshot.today.codex.total, 1050);
    assert.equal(snapshot.today.source, "web-extension", "the cost still comes from the website bill");
    assert.equal(snapshot.today.cost, 8.56);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});