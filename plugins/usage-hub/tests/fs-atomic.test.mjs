import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendLogCapped, createNullDict, readJsonSafe, redactSecrets, shortStack, writeJsonAtomic } from "../runtime/fs-atomic.mjs";

async function tempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "usage-hub-fs-"));
}

test("writeJsonAtomic survives 50 concurrent writes to the same path (B2)", async () => {
  const dir = await tempDir();
  const target = path.join(dir, "nested", "value.json");
  const writes = [];
  for (let i = 0; i < 50; i += 1) writes.push(writeJsonAtomic(target, { i }));
  await Promise.all(writes);

  const parsed = await readJsonSafe(target, null);
  assert.ok(parsed && Number.isInteger(parsed.i), "final file must be valid JSON from one of the writers");
  const leftovers = (await fsp.readdir(path.dirname(target))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temporary files may be left behind");
});

test("writeJsonAtomic honours an explicit file mode where the platform supports it", async () => {
  const dir = await tempDir();
  const target = path.join(dir, "token.json");
  await writeJsonAtomic(target, { token: "a".repeat(32) }, { mode: 0o600 });
  const mode = fs.statSync(target).mode & 0o777;
  if (process.platform === "win32") {
    // Windows only models the read-only bit, so 0o600 cannot be represented.
    assert.equal(mode & 0o222, 0o222, "file must stay writable for the owner");
  } else {
    assert.equal(mode, 0o600);
  }
  assert.equal((await readJsonSafe(target, null)).token.length, 32);
});

test("readJsonSafe tolerates a BOM and malformed content", async () => {
  const dir = await tempDir();
  const bom = path.join(dir, "bom.json");
  const bad = path.join(dir, "bad.json");
  await fsp.writeFile(bom, "\uFEFF{\"a\":1}", "utf8");
  await fsp.writeFile(bad, "{not json", "utf8");
  assert.deepEqual(await readJsonSafe(bom, null), { a: 1 });
  assert.equal(await readJsonSafe(bad, "fallback"), "fallback");
  assert.equal(await readJsonSafe(path.join(dir, "missing.json"), null), null);
});

test("createNullDict blocks prototype keys", () => {
  const dict = createNullDict({ deepseek: { cost: 1 } });
  assert.equal(Object.getPrototypeOf(dict), null);
  assert.equal(dict.deepseek.cost, 1);
  const hostile = createNullDict(JSON.parse('{"__proto__":{"polluted":true},"a":1}'));
  assert.equal({}.polluted, undefined, "Object.prototype must stay clean");
  assert.equal(hostile.a, 1);
});

test("redactSecrets covers key, bearer and JWT shapes", () => {
  const text = "key sk-abcdefgh12345678 and Bearer abcdefghijklmnopqrstuvwx plus eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue";
  const out = redactSecrets(text);
  assert.ok(!out.includes("sk-abcdefgh12345678"));
  assert.ok(!out.includes("abcdefghijklmnopqrstuvwx"));
  assert.ok(!out.includes("eyJhbGciOiJIUzI1NiJ9"));
  assert.equal((out.match(/\[REDACTED\]/g) || []).length, 3);
});

test("shortStack limits frames and redacts", () => {
  const error = new Error("boom sk-abcdefgh12345678");
  const out = shortStack(error, 2);
  assert.ok(out.startsWith("boom [REDACTED]"));
  assert.equal(out.split("\n").filter((line) => line.trim().startsWith("at ")).length, 2);
});

test("appendLogCapped trims the tail once the cap is exceeded", async () => {
  const dir = await tempDir();
  const log = path.join(dir, "plugin.log");
  for (let i = 0; i < 40; i += 1) {
    await appendLogCapped(log, `line ${i} ${"x".repeat(200)}\n`, { maxBytes: 4096, keepBytes: 1024 });
  }
  const size = fs.statSync(log).size;
  assert.ok(size <= 4096 + 400, `log should stay near the cap, got ${size}`);
  const text = await fsp.readFile(log, "utf8");
  assert.ok(text.includes("log truncated"), "truncation marker expected");
  assert.ok(text.includes("line 39"), "newest line must survive");
  assert.ok(!text.includes("line 0 "), "oldest lines must be dropped");
});