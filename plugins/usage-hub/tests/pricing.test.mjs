// Built-in (adapter) pricing tests.
//
// Why these exist: the unit price used to come only from CC Switch's model_pricing
// table, so a machine without CC Switch showed "unavailable". The DeepSeek adapter
// now ships the table itself; these tests freeze the lookup rules (exact id, id
// prefix, longest pattern wins) and the precedence (adapter -> CC Switch -> unavailable).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { getAdapterPricing, pickPricing } from "../runtime/usage-helper.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const deepseek = JSON.parse(
  fs.readFileSync(path.join(HERE, "..", "runtime", "providers", "deepseek.json"), "utf8")
);

test("adapter pricing: exact id, id prefix and longest pattern wins", () => {
  const exact = getAdapterPricing(deepseek, ["deepseek-v4-flash"]);
  assert.equal(exact.status, "ok");
  assert.equal(exact.modelId, "deepseek-v4-flash");
  assert.equal(exact.displayName, "DeepSeek V4 Flash");
  assert.equal(exact.inputPerMillion, 0.3);
  assert.equal(exact.outputPerMillion, 1.2);
  assert.equal(exact.cacheReadPerMillion, 0.006);
  assert.equal(exact.source, "builtin");

  const dated = getAdapterPricing(deepseek, ["deepseek-v4-flash-0731"]);
  assert.equal(dated.modelId, "deepseek-v4-flash", "a dated model id must match its base row");

  const longest = getAdapterPricing(deepseek, ["deepseek-v3.1"]);
  assert.equal(longest.modelId, "deepseek-v3.1", "the longer pattern must win over deepseek-v3");
  assert.equal(longest.inputPerMillion, 0.55);

  assert.equal(getAdapterPricing(deepseek, ["qwen3.8-max"]), null, "unknown models must not match");
  assert.equal(getAdapterPricing({}, ["deepseek-v4-flash"]), null, "adapters without a table return null");
  assert.equal(getAdapterPricing(deepseek, []), null);
});

test("pricing precedence: adapter first, CC Switch as fallback, otherwise unavailable", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE model_pricing (model_id TEXT, display_name TEXT, input_cost_per_million REAL, output_cost_per_million REAL, cache_read_cost_per_million REAL, cache_creation_cost_per_million REAL)"
  );
  db.prepare("INSERT INTO model_pricing VALUES ('deepseek-v4-flash','DB DeepSeek',9,9,9,9)").run();
  db.prepare("INSERT INTO model_pricing VALUES ('other-model','Other Model',1,2,0.1,0)").run();

  const builtin = pickPricing(db, ["deepseek-v4-flash"], deepseek);
  assert.equal(builtin.source, "builtin", "the shipped table is authoritative for its own models");
  assert.equal(builtin.inputPerMillion, 0.3, "a CC Switch row must not override the built-in price");

  const fromDb = pickPricing(db, ["other-model"], deepseek);
  assert.equal(fromDb.source, "cc-switch", "models the adapter does not declare still come from CC Switch");
  assert.equal(fromDb.inputPerMillion, 1);

  const withoutAdapter = pickPricing(db, ["deepseek-v4-flash"], null);
  assert.equal(withoutAdapter.source, "cc-switch", "without an adapter the previous behaviour is unchanged");

  const nothing = pickPricing(null, ["deepseek-v4-flash"], null);
  assert.equal(nothing.status, "unavailable");
  assert.equal(nothing.source, "unavailable", "no table anywhere must not be blamed on CC Switch");

  db.close();
});