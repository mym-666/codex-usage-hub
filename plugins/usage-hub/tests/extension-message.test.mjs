// Regression test for the page <-> content script message contract.
//
// Why this exists: release 1.6.0 validated `message.type` ("response" | "error")
// against a whitelist of message kinds ("usage" | "estimate" | "error"). Every
// captured bill therefore failed the guard and was dropped silently: the page
// kept calling its usage API, the extension kept receiving the responses, and
// nothing was ever posted - no success record, no error record. This test drives
// the exact message shape inject.js publishes, so the contract cannot silently
// regress again.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = path.resolve(HERE, "..", "edge-extension");
const PAGE_ORIGIN = "https://platform.deepseek.com";
const USAGE_URL = `${PAGE_ORIGIN}/api/v0/usage/?start=1&end=2`;

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadContentScript() {
  const sends = [];
  const warnings = [];
  const listeners = [];
  const sandbox = {
    console: { warn: (...args) => warnings.push(args.join(" ")), log() {}, error() {} },
    // Timers are stubbed: DOM-scrape fallbacks must not fire inside the test.
    setTimeout: () => 0,
    clearTimeout: () => {},
    MutationObserver: class { observe() {} },
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          sends.push(message);
          return { ok: true, result: {} };
        }
      },
      storage: { local: { set: async () => {} } }
    },
    document: { hidden: true, documentElement: {} },
    location: { href: `${PAGE_ORIGIN}/usage`, origin: PAGE_ORIGIN },
    addEventListener: (type, listener) => {
      if (type === "message") listeners.push(listener);
    }
  };
  sandbox.window = sandbox;
  // The dispatcher must build the event INSIDE the vm: a host object passed in
  // from the outside is not identity-equal to the vm's `window`, which would
  // trip the `event.source !== window` guard for the wrong reason.
  sandbox.__listeners = listeners;
  const context = vm.createContext(sandbox);
  for (const file of ["parse.js", "content.js"]) {
    const source = fs.readFileSync(path.join(EXTENSION_DIR, file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  assert.ok(sandbox.UsageHubParse, "parse.js must expose globalThis.UsageHubParse");

  const dispatch = vm.runInContext(
    `(data, overrides) => {
       const event = Object.assign({ source: window, origin: location.origin, data }, overrides || {});
       for (const listener of __listeners) listener(event);
     }`,
    context
  );

  function post(data, overrides = {}) {
    assert.ok(listeners.length > 0, "content.js must register a message listener");
    dispatch(data, overrides);
  }

  return { sends, warnings, post };
}

const usagePayload = {
  data: {
    biz_data: {
      currency: "CNY",
      cost: 1.23,
      prompt_cache_hit_tokens: 100,
      prompt_cache_miss_tokens: 200,
      completion_tokens: 50
    }
  }
};

test("a captured usage response reaches the receiver (regression: type/kind mismatch)", async () => {
  const harness = loadContentScript();
  harness.post({ marker: "__USAGE_HUB_WEB_BILL__", type: "response", kind: "usage", url: USAGE_URL, json: usagePayload });
  await flush();

  assert.equal(harness.sends.length, 1, `expected one push, got ${JSON.stringify(harness.sends)}`);
  const message = harness.sends[0];
  assert.equal(message.type, "push-web-bill");
  assert.equal(message.payload.provider, "deepseek");
  assert.equal(message.payload.cost, 1.23);
  assert.equal(message.payload.tokenSource, "api");
  assert.equal(message.payload.tokens.cacheRead, 100);
  assert.equal(message.payload.tokens.freshInput, 200);
  assert.equal(message.payload.tokens.output, 50);
  assert.equal(message.payload.tokens.total, 350);
  assert.deepEqual(harness.warnings, [], "a valid message must not warn");
});

test("an estimate alone never invents a daily cost", async () => {
  const harness = loadContentScript();
  harness.post({
    marker: "__USAGE_HUB_WEB_BILL__",
    type: "response",
    kind: "estimate",
    url: `${PAGE_ORIGIN}/api/v0/pricing/estimate_token`,
    json: { data: { biz_data: { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2, completion_tokens: 3 } } }
  });
  await flush();

  assert.equal(harness.sends.length, 1);
  const message = harness.sends[0];
  assert.equal(message.type, "push-web-bill");
  assert.ok(!("cost" in message.payload), "an estimate must never carry a daily cost");
  assert.equal(message.payload.tokenSource, "estimate");
  // Preserved legacy semantics: without an explicit total, the largest token-ish field wins (3), not their sum (6).
  assert.equal(message.payload.tokens.total, 3);
});

test("an estimate cannot downgrade authoritative api tokens or the daily cost", async () => {
  const harness = loadContentScript();
  harness.post({ marker: "__USAGE_HUB_WEB_BILL__", type: "response", kind: "usage", url: USAGE_URL, json: usagePayload });
  await flush();
  assert.equal(harness.sends.length, 1);

  harness.post({
    marker: "__USAGE_HUB_WEB_BILL__",
    type: "response",
    kind: "estimate",
    url: `${PAGE_ORIGIN}/api/v0/pricing/estimate_token`,
    json: { data: { biz_data: { prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 2, completion_tokens: 3 } } }
  });
  await flush();

  for (const message of harness.sends) {
    if (message.type !== "push-web-bill") continue;
    if ("cost" in message.payload) {
      assert.equal(message.payload.cost, 1.23, "the only cost that may be published is the daily bill's");
    }
    assert.equal(message.payload.tokens.cacheRead, 100, "api tokens must win over estimate tokens");
    assert.equal(message.payload.tokens.total, 350);
    assert.notEqual(message.payload.tokenSource, "estimate");
  }
});
test("page errors still surface as a status report", async () => {
  const harness = loadContentScript();
  harness.post({ marker: "__USAGE_HUB_WEB_BILL__", type: "error", message: "DeepSeek 账单请求超时" });
  await flush();

  assert.equal(harness.sends.length, 1);
  assert.equal(harness.sends[0].type, "push-web-bill-status");
  assert.equal(harness.sends[0].payload.message, "DeepSeek 账单请求超时");
});

test("unknown kinds, foreign origins and foreign sources are ignored", async () => {
  const harness = loadContentScript();

  harness.post({ marker: "__USAGE_HUB_WEB_BILL__", type: "response", kind: "totally-unknown", url: USAGE_URL, json: usagePayload });
  await flush();
  assert.equal(harness.sends.length, 0);
  assert.match(harness.warnings.join("\n"), /unknown kind/);

  harness.post({ marker: "__USAGE_HUB_WEB_BILL__", type: "response", kind: "usage", url: USAGE_URL, json: usagePayload }, { origin: "https://evil.example" });
  await flush();
  assert.equal(harness.sends.length, 0, "a foreign origin must never reach the receiver");

  harness.post({ marker: "__USAGE_HUB_WEB_BILL__", type: "response", kind: "usage", url: USAGE_URL, json: usagePayload }, { source: {} });
  await flush();
  assert.equal(harness.sends.length, 0, "a foreign source must never reach the receiver");
});
test("a platform balance response becomes a web-balance push", async () => {
  const harness = loadContentScript();
  harness.post({
    marker: "__USAGE_HUB_WEB_BILL__",
    type: "response",
    kind: "balance",
    url: `${PAGE_ORIGIN}/api/v0/users/get_user_summary`,
    json: {
      data: {
        biz_data: {
          current_token: "ignored",
          normal_wallets: [{ balance: "11.02", currency: "CNY", token_estimation: 1 }],
          bonus_wallets: [{ balance: "0.50", currency: "CNY" }]
        }
      }
    }
  });
  await flush();

  assert.equal(harness.sends.length, 1, JSON.stringify(harness.sends));
  const message = harness.sends[0];
  assert.equal(message.type, "push-web-balance");
  assert.equal(message.payload.provider, "deepseek");
  assert.equal(message.payload.available, 11.52);
  assert.equal(message.payload.currency, "CNY");
  assert.equal(message.payload.wallets.length, 2);
  const bonusWallet = message.payload.wallets[1];
  assert.equal(bonusWallet.kind, "bonus");
  assert.equal(bonusWallet.currency, "CNY");
  assert.equal(bonusWallet.balance, 0.5);
  assert.equal(message.payload.extensionVersion, "1.7.1");
});

test("balance responses without usable wallets stay silent", async () => {
  const harness = loadContentScript();
  harness.post({
    marker: "__USAGE_HUB_WEB_BILL__",
    type: "response",
    kind: "balance",
    url: `${PAGE_ORIGIN}/api/v0/users/get_user_summary`,
    json: { data: { biz_data: { normal_wallets: [{ balance: "-1", currency: "CNY" }] } } }
  });
  await flush();
  assert.equal(harness.sends.length, 0, "an unusable balance must not be forwarded");

  harness.post({
    marker: "__USAGE_HUB_WEB_BILL__",
    type: "response",
    kind: "balance",
    url: `${PAGE_ORIGIN}/api/v0/users/get_user_summary`,
    json: { data: {} }
  });
  await flush();
  assert.equal(harness.sends.length, 0);
});


// inject.js runs in the page's MAIN world, so only running the real script can
// prove that a given API path is intercepted at all. 2.2.0-2.4.0 shipped without
// the USER_SUMMARY_PATH constant: isBalanceUrl() threw a ReferenceError, the
// surrounding catch swallowed it, and the account summary was never forwarded, so
// the website balance could not appear no matter what the browser was logged into.
function loadPageHook() {
  const posted = [];
  let nextJson = null;
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    // fetchToday() only runs for usage URLs; keep timers inert regardless.
    setTimeout: () => 0,
    clearTimeout: () => {},
    URL,
    AbortController,
    Headers,
    location: { href: `${PAGE_ORIGIN}/usage`, origin: PAGE_ORIGIN },
    XMLHttpRequest: class { addEventListener() {} open() {} send() {} setRequestHeader() {} },
    postMessage: (message) => posted.push(message),
    fetch: async () => ({ clone: () => ({ json: async () => nextJson }) })
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(EXTENSION_DIR, "inject.js"), "utf8"), context, { filename: "inject.js" });
  return {
    posted,
    async request(url, json) {
      nextJson = json;
      await sandbox.fetch(url);
      await flush();
    }
  };
}

test("the page hook forwards the account summary (regression: missing USER_SUMMARY_PATH)", async () => {
  const hook = loadPageHook();
  await hook.request(`${PAGE_ORIGIN}/api/v0/users/get_user_summary`, {
    data: { biz_data: { normal_wallets: [{ balance: "11.02", currency: "CNY" }] } }
  });

  assert.equal(hook.posted.length, 1, `expected one page message, got ${JSON.stringify(hook.posted)}`);
  const message = hook.posted[0];
  assert.equal(message.marker, "__USAGE_HUB_WEB_BILL__");
  assert.equal(message.type, "response");
  assert.equal(message.kind, "balance");
  assert.match(message.url, /get_user_summary/);
  assert.equal(message.json.data.biz_data.normal_wallets[0].balance, "11.02");
});