import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PARSE_PATH = path.join(HERE, "..", "edge-extension", "parse.js");

function loadParse() {
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(PARSE_PATH, "utf8"), context, { filename: PARSE_PATH });
  assert.ok(context.UsageHubParse, "parse.js must publish globalThis.UsageHubParse");
  return context.UsageHubParse;
}

const P = loadParse();

// Arrays returned from the vm context carry that realm's Array.prototype, so
// copy them into the host realm before deep comparisons.
const host = (value) => (Array.isArray(value) ? [...value] : value);

test("collectCosts does not add a parent total to the values it summarises (B7)", () => {
  assert.deepEqual(host(P.collectCosts({ cost: 5, nested: { cost: 2 } })), [5]);
  assert.deepEqual(host(P.collectCosts({ buckets: [{ cost: 1 }, { cost: 2 }] })), [1, 2]);
  assert.deepEqual(
    host(P.collectCosts({ data: [{ series: [{ buckets: [{ cost: 0.5 }, { cost: 0.25 }] }] }] })),
    [0.5, 0.25]
  );
  assert.deepEqual(host(P.collectCosts({ cost: "not-a-number" })), []);
  assert.deepEqual(host(P.collectCosts(null)), []);
});

test("sumNumbers takes the first matching key per level and skips that subtree (B7)", () => {
  assert.equal(P.sumNumbers({ usage: { prompt_tokens: 10, inner: { prompt_tokens: 4 } } }, ["prompt_tokens"]), 10);
  assert.equal(P.sumNumbers({ a: { prompt_tokens: 1 }, b: { prompt_tokens: 2 } }, ["prompt_tokens"]), 3);
  // prompt_tokens wins over input_tokens because the key list is a preference order
  assert.equal(P.sumNumbers({ prompt_tokens: 7, input_tokens: 99 }, ["prompt_tokens", "input_tokens"]), 7);
  assert.equal(P.sumNumbers({ unrelated: 1 }, ["prompt_tokens"]), null);
  assert.equal(P.sumNumbers([{ completion_tokens: 2 }, { completion_tokens: 3 }], ["completion_tokens"]), 5);
});

test("extractTokens builds a consistent breakdown from a realistic usage payload", () => {
  const payload = {
    data: {
      biz_data: {
        data: [
          {
            series: [
              {
                buckets: [
                  { usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 } },
                  { usage: { prompt_tokens: 500, completion_tokens: 50, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 100 } }
                ]
              }
            ]
          }
        ]
      }
    }
  };
  const biz = payload.data.biz_data;
  const tokens = P.extractTokens(biz);
  assert.equal(tokens.input, 1500);
  assert.equal(tokens.output, 250);
  assert.equal(tokens.cacheRead, 1200);
  assert.equal(tokens.freshInput, 300);
  assert.equal(tokens.total, 1750);
  assert.deepEqual(host(P.collectCosts({ data: [{ cost: 1.5 }, { cost: 2.25 }] })), [1.5, 2.25]);
});

test("extractTokensFromVisiblePage reads labelled values from page text", () => {
  const text = ["用量概览", "总 Tokens", "1,234,567", "输入 Tokens", "1,000,000", "输出 Tokens", "234,567", "缓存命中", "800,000"].join("\n");
  const tokens = P.extractTokensFromVisiblePage(text);
  assert.equal(tokens.total, 1234567);
  assert.equal(tokens.input, 1000000);
  assert.equal(tokens.output, 234567);
  assert.equal(tokens.cacheRead, 800000);
  assert.equal(P.extractTokensFromVisiblePage(""), null);
  assert.equal(P.extractTokensFromVisiblePage("no numbers here"), null);
});

test("a bare page total is not reported as today's token usage", () => {
  // The usage page renders an account- or range-wide total. A text scrape cannot
  // attribute it to today, so it must not become a token figure at all.
  assert.equal(P.extractTokensFromVisiblePage(["用量概览", "总 Tokens", "723.44M"].join("\n")), null);
  assert.equal(P.extractTokensFromVisiblePage("总 Tokens\n723,437,645"), null);
});

test("parseTokenNumber understands Chinese and SI units", () => {
  assert.equal(P.parseTokenNumber("1.5万"), 15000);
  assert.equal(P.parseTokenNumber("2亿"), 200000000);
  assert.equal(P.parseTokenNumber("3.2K"), 3200);
  assert.equal(P.parseTokenNumber("1,024"), 1024);
  assert.equal(P.parseTokenNumber("nothing"), null);
});

test("localDateKey formats the local calendar day", () => {
  assert.equal(P.localDateKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(P.localDateKey(new Date(2026, 11, 31, 0, 0)), "2026-12-31");
});

test("extractEstimatedTokens falls back to the largest token-ish field", () => {
  assert.equal(P.extractEstimatedTokens({ estimated_tokens: 42 }).total, 42);
  // No explicit total: the largest token-ish field wins (documented behaviour).
  assert.equal(P.extractEstimatedTokens({ input_tokens: 10, output_tokens: 5 }).total, 10);
  assert.equal(P.extractEstimatedTokens({ total_tokens: 15, input_tokens: 10 }).total, 15);
  assert.equal(P.extractEstimatedTokens({ nothing: 1 }), null);
});
test("parseBalanceWallets reads the platform wallet summary", () => {
  const summary = P.parseBalanceWallets({
    current_token: "ignored",
    normal_wallets: [{ balance: "11.02", currency: "CNY", token_estimation: 3915495 }],
    bonus_wallets: [{ balance: "0.48", currency: "CNY" }],
    total_costs: [{ currency: "CNY", amount: "6.12" }]
  });
  assert.equal(summary.available, 11.5);
  assert.equal(summary.currency, "CNY");
  const wallets = host(summary.wallets);
  assert.equal(wallets.length, 2);
  assert.equal(wallets[0].kind, "normal");
  assert.equal(wallets[0].currency, "CNY");
  assert.equal(wallets[0].balance, 11.02);
  assert.equal(wallets[1].kind, "bonus");
  assert.equal(wallets[1].balance, 0.48);

  assert.equal(P.parseBalanceWallets({ normal_wallets: [{ balance: "-1", currency: "CNY" }] }), null);
  assert.equal(P.parseBalanceWallets({ normal_wallets: [{ balance: "5", currency: "EURO" }] }), null, "only ISO-4217-shaped codes pass");
  assert.equal(P.parseBalanceWallets({}), null);
  assert.equal(P.parseBalanceWallets(null), null);
});
