import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildSnapshot,
  extractBrowserToken,
  extractScopedToken,
  levelDbKeyNeedles,
  openDatabase
} from "../runtime/usage-helper.mjs";
import { writeJsonAtomic } from "../runtime/fs-atomic.mjs";

const SCHEMA = `
CREATE TABLE providers (
  id TEXT, name TEXT, app_type TEXT, settings_config TEXT, website_url TEXT,
  category TEXT, meta TEXT, is_current INTEGER, sort_index INTEGER
);
CREATE TABLE proxy_request_logs (
  app_type TEXT, provider_id TEXT, data_source TEXT, session_id TEXT, created_at INTEGER,
  status_code INTEGER, input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_creation_tokens INTEGER, total_cost_usd REAL,
  request_model TEXT, model TEXT, pricing_model TEXT
);
CREATE TABLE model_pricing (
  model_id TEXT, display_name TEXT, input_cost_per_million REAL, output_cost_per_million REAL,
  cache_read_cost_per_million REAL, cache_creation_cost_per_million REAL
);`;

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function createFixtureDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const settings = {
    config: ['model_provider = "local"', "[model_providers.local]", 'base_url = "http://127.0.0.1:9/v1"', 'model = "fixture-model"'].join("\n"),
    auth: { OPENAI_API_KEY: "sk-fixturekey1234567890" }
  };
  db.prepare("INSERT INTO providers VALUES (?, ?, 'codex', ?, ?, 'cn_official', '{}', 1, 0)").run(
    "provider-1",
    "Fixture Provider",
    JSON.stringify(settings),
    "https://fixture.example"
  );
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO proxy_request_logs VALUES ('codex','provider-1','proxy','session-1',?,200,1000,200,800,0,0.01,'fixture-model','fixture-model','fixture-model')"
  ).run(now);
  db.prepare("INSERT INTO model_pricing VALUES ('fixture-model','Fixture Model',0.3,1.2,0.006,0)").run();
  db.close();
}

test("openDatabase reports direct, unavailable and never throws on garbage", async () => {
  const dir = await tempDir("usage-hub-db-");
  const dbPath = path.join(dir, "cc-switch.db");
  createFixtureDb(dbPath);

  const opened = openDatabase(dbPath, { dataDir: dir });
  assert.equal(opened.mode, "direct");
  assert.ok(opened.db);
  opened.db.close();

  assert.deepEqual(openDatabase(path.join(dir, "missing.db"), { dataDir: dir }), { db: null, mode: "unavailable" });

  const garbage = path.join(dir, "garbage.db");
  await fsp.writeFile(garbage, "this is definitely not a sqlite database", "utf8");
  const bad = openDatabase(garbage, { dataDir: dir });
  assert.equal(bad.db, null);
  assert.equal(bad.mode, "unavailable");

  await fsp.rm(dir, { recursive: true, force: true });
});

test("buildSnapshot releases the SQLite handle so the file can be deleted (B8)", async () => {
  const dataDir = await tempDir("usage-hub-data-");
  const codexHome = await tempDir("usage-hub-codex-");
  const dbPath = path.join(dataDir, "cc-switch.db");
  createFixtureDb(dbPath);
  await writeJsonAtomic(path.join(dataDir, "config.json"), { webUsage: false, allowBalanceDelta: false });

  const snapshot = await buildSnapshot({ dataDir, ccSwitchDb: dbPath, codexHome });
  assert.equal(snapshot.provider.id, "provider-1");
  assert.equal(snapshot.model.id, "fixture-model");
  assert.equal(snapshot.source.databaseMode, "direct");
  assert.equal(snapshot.today.requestCount, 1);
  assert.equal(snapshot.today.tokens.input, 1000);
  assert.equal(snapshot.today.tokenSource, "cc-switch");
  assert.equal(snapshot.pricing.status, "ok");

  // On Windows this fails with EBUSY/EPERM while any read handle is still open,
  // which is exactly the leak the old implementation had on every refresh tick.
  fs.rmSync(dbPath);
  assert.equal(fs.existsSync(dbPath), false);

  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(codexHome, { recursive: true, force: true });
});

test("repeated snapshots do not accumulate handles or temporary files (B8, B2)", async () => {
  const dataDir = await tempDir("usage-hub-loop-");
  const codexHome = await tempDir("usage-hub-codex2-");
  const dbPath = path.join(dataDir, "cc-switch.db");
  createFixtureDb(dbPath);
  await writeJsonAtomic(path.join(dataDir, "config.json"), { webUsage: false, allowBalanceDelta: false });

  for (let i = 0; i < 12; i += 1) {
    await buildSnapshot({ dataDir, ccSwitchDb: dbPath, codexHome });
  }
  fs.rmSync(dbPath);
  const leftovers = (await fsp.readdir(dataDir)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);

  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(codexHome, { recursive: true, force: true });
});

test("buildSnapshot still releases the handle on the no-provider early return", async () => {
  const dataDir = await tempDir("usage-hub-empty-");
  const codexHome = await tempDir("usage-hub-codex3-");
  const dbPath = path.join(dataDir, "empty.db");
  new DatabaseSync(dbPath).close();

  const snapshot = await buildSnapshot({ dataDir, ccSwitchDb: dbPath, codexHome });
  assert.equal(snapshot.provider, null);
  assert.ok(snapshot.warnings.length > 0);
  fs.rmSync(dbPath);

  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(codexHome, { recursive: true, force: true });
});

function localStorageRecord(origin, key, value) {
  const keyBuffer = Buffer.from(`_${origin}\u0000\u0001${key}`, "utf8");
  const valueBuffer = Buffer.concat([Buffer.from([0]), Buffer.from(value, "utf8")]);
  return Buffer.concat([Buffer.from([keyBuffer.length]), keyBuffer, Buffer.from([valueBuffer.length]), valueBuffer]);
}

test("browser token lookup is scoped to the exact origin and key (B14)", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.signaturepart";
  const needles = levelDbKeyNeedles("https://platform.deepseek.com", "userToken");
  assert.equal(needles.length, 2, "https and http spellings of the origin");

  const positive = Buffer.concat([
    Buffer.from("some leveldb block noise .........", "utf8"),
    localStorageRecord("https://platform.deepseek.com", "userToken", jwt)
  ]);
  assert.equal(extractScopedToken(positive, needles), jwt);

  // The old matcher only required the hostname to appear somewhere in the file,
  // so this record belonging to another site would have been returned.
  const foreignToken = "ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdef";
  const negative = Buffer.concat([
    Buffer.from("referer https://platform.deepseek.com/usage was seen here", "utf8"),
    localStorageRecord("https://other-site.example", "userToken", foreignToken)
  ]);
  assert.equal(extractScopedToken(negative, needles), "", "a different origin's token must not be returned");
  assert.ok(negative.toString("latin1").includes("platform.deepseek.com"), "the hostname really is present in the file");

  assert.equal(extractScopedToken(Buffer.from("nothing relevant here", "utf8"), needles), "");
  assert.deepEqual(levelDbKeyNeedles("", "userToken"), []);
  assert.deepEqual(levelDbKeyNeedles("https://platform.deepseek.com", []), [], "a non-string key yields no needles");
  assert.deepEqual(levelDbKeyNeedles("https://platform.deepseek.com", "   "), []);
  assert.equal(extractBrowserToken("https://platform.deepseek.com", [], ["edge"]), null, "no keys means no scan");
});

test("token needles cover both http and https spellings of the origin", () => {
  const needles = levelDbKeyNeedles("https://platform.deepseek.com/", "userToken");
  assert.equal(needles.length, 2);
  const record = localStorageRecord("http://platform.deepseek.com", "userToken", "0123456789abcdefghijklmnopqrstuvwxyz");
  assert.ok(needles.some((needle) => record.includes(needle)));
});