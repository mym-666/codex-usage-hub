// Codex rollout usage reader: aggregation, dedupe, incrementality and fault tolerance.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { localMidnightMs, parseTokenUsageRecord, scanCodexUsage, summariseUsage } = await import(
  new URL("../runtime/codex-usage.mjs", import.meta.url).href
);

const NOW = new Date(2026, 8, 13, 12, 0, 0);
const DAY = localMidnightMs(NOW);
const YESTERDAY = new Date(DAY - 12 * 60 * 60 * 1000);

function makeHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-hub-codex-"));
  fs.mkdirSync(path.join(root, "sessions", "2026", "09", "13"), { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function recordLine({ at, threadId = "thread-1", responseId, input, cached = 0, output = 0, total, threadUsage }) {
  return JSON.stringify({
    timestamp: new Date(at).toISOString(),
    ordinal: responseId,
    type: "token_usage_record",
    payload: {
      thread_id: threadId,
      turn_id: "turn-1",
      response_id: responseId,
      usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: output,
        reasoning_output_tokens: 0,
        total_tokens: total ?? input + output
      },
      ...(threadUsage ? { thread_token_usage: threadUsage } : {})
    }
  });
}

function writeRollout(home, name, lines, mtime = NOW) {
  const file = path.join(home, "sessions", "2026", "09", "13", name);
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  fs.utimesSync(file, mtime, mtime);
  return file;
}

test("parseTokenUsageRecord normalises and clamps values", () => {
  const parsed = parseTokenUsageRecord({
    usage: { input_tokens: 100, cached_input_tokens: 250, output_tokens: 10, reasoning_output_tokens: 4, total_tokens: 110 }
  });
  assert.deepEqual(parsed, { input: 100, cached: 100, output: 10, reasoning: 4, total: 110 });
  assert.equal(parseTokenUsageRecord({ usage: {} }), null);
  assert.equal(parseTokenUsageRecord(null), null);
  const derived = parseTokenUsageRecord({ usage: { input_tokens: 5, cached_input_tokens: 3, output_tokens: 2 } });
  assert.equal(derived.total, 7, "total falls back to input + output");
});

test("today totals skip yesterday, dedupe response ids and ignore broken lines", async (t) => {
  const home = makeHome(t);
  const dataDir = path.join(home, "data");
  const threadUsage = { input_tokens: 300, cached_input_tokens: 200, output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 330 };
  writeRollout(home, "rollout-a.jsonl", [
    recordLine({ at: YESTERDAY, responseId: "old-1", input: 999, output: 1 }),
    recordLine({ at: NOW, responseId: "r1", input: 100, cached: 80, output: 10, threadUsage }),
    "{ this is not json",
    JSON.stringify({ timestamp: new Date(NOW).toISOString(), type: "token_usage_record", payload: { usage: {} } }),
    recordLine({ at: NOW, responseId: "r2", input: 50, cached: 20, output: 5 })
  ]);
  // Same response id replayed in a second file must not be counted twice.
  writeRollout(home, "rollout-b.jsonl", [
    recordLine({ at: NOW, responseId: "r2", input: 50, cached: 20, output: 5 }),
    // Older than thread-1 by five minutes: "current session" must follow the newest record.
    recordLine({ at: new Date(NOW.getTime() - 5 * 60 * 1000), threadId: "thread-2", responseId: "r3", input: 10, cached: 0, output: 2 })
  ]);

  const result = await scanCodexUsage({ codexHome: home, dataDir, now: NOW, sinceMs: DAY });
  assert.equal(result.status, "ok");
  assert.equal(result.scannedFiles, 2);
  assert.deepEqual(
    { input: result.today.input, cached: result.today.cached, freshInput: result.today.freshInput, output: result.today.output, total: result.today.total, responseCount: result.today.responseCount },
    { input: 160, cached: 100, freshInput: 60, output: 17, total: 177, responseCount: 3 }
  );
  assert.equal(result.thread.id, "thread-1");
  assert.equal(result.thread.total, 330);
  assert.equal(result.thread.responsesToday, 2);
});

test("rescanning is incremental: identical result, appended record counted once", async (t) => {
  const home = makeHome(t);
  const dataDir = path.join(home, "data");
  const file = writeRollout(home, "rollout-a.jsonl", [recordLine({ at: NOW, responseId: "r1", input: 100, cached: 90, output: 10 })]);

  const first = await scanCodexUsage({ codexHome: home, dataDir, now: NOW });
  const second = await scanCodexUsage({ codexHome: home, dataDir, now: NOW });
  assert.deepEqual(second.today, first.today, "an unchanged file must not be counted twice");

  fs.appendFileSync(file, `${recordLine({ at: NOW, responseId: "r2", input: 40, cached: 0, output: 4 })}\n`, "utf8");
  fs.utimesSync(file, NOW, NOW);
  const third = await scanCodexUsage({ codexHome: home, dataDir, now: NOW });
  assert.equal(third.today.responseCount, 2);
  assert.equal(third.today.input, 140);
  assert.equal(third.today.total, 154);

  const cache = JSON.parse(fs.readFileSync(path.join(dataDir, "codex-usage-cache.json"), "utf8"));
  assert.equal(cache.files[file].offset, fs.statSync(file).size, "cache offset tracks the consumed bytes");
});

test("a truncated file is rebuilt instead of double counted", async (t) => {
  const home = makeHome(t);
  const dataDir = path.join(home, "data");
  const file = writeRollout(home, "rollout-a.jsonl", [
    recordLine({ at: NOW, responseId: "r1", input: 100, cached: 0, output: 0 }),
    recordLine({ at: NOW, responseId: "r2", input: 200, cached: 0, output: 0 })
  ]);
  const before = await scanCodexUsage({ codexHome: home, dataDir, now: NOW });
  assert.equal(before.today.input, 300);

  fs.writeFileSync(file, `${recordLine({ at: NOW, responseId: "r9", input: 7, cached: 0, output: 0 })}\n`, "utf8");
  fs.utimesSync(file, NOW, NOW);
  const after = await scanCodexUsage({ codexHome: home, dataDir, now: NOW });
  assert.equal(after.today.input, 7, "the rebuilt file replaces the previous totals");
  assert.equal(after.today.responseCount, 1);
});

test("missing sessions directory degrades instead of throwing", async (t) => {
  const home = makeHome(t);
  const result = await scanCodexUsage({ codexHome: path.join(home, "nope"), dataDir: path.join(home, "data"), now: NOW });
  assert.equal(result.status, "unavailable");
  assert.equal(result.today.total, 0);
  assert.match(result.warnings.join("\n"), /未找到今天写入的 Codex 会话文件/);
});

test("summariseUsage derives freshInput from input minus cached", () => {
  assert.deepEqual(summariseUsage({ input: 100, cached: 40, output: 5, reasoning: 0, total: 105, responseCount: 2 }), {
    input: 100,
    cached: 40,
    freshInput: 60,
    output: 5,
    reasoning: 0,
    total: 105,
    responseCount: 2
  });
});