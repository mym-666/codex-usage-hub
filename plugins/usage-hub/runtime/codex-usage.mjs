import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJsonSafe, writeJsonAtomic } from "./fs-atomic.mjs";

/**
 * Codex-local usage reader.
 *
 * Codex appends one `token_usage_record` per model response to its rollout files
 * (~/.codex/sessions/<date>/rollout-*.jsonl). Each record carries the per-response
 * usage (input / cached_input / output / reasoning) plus cumulative turn and thread
 * totals, so the plugin no longer needs CC Switch to answer "how much did I use
 * today" or "what is this session costing".
 *
 * The scan is incremental: every file keeps a byte offset plus the response ids it
 * already counted, so a refresh only parses whatever was appended since last time.
 */

const CACHE_VERSION = 1;
const MAX_FILES = 400;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_IDS_PER_FILE = 20000;
const MAX_LINE_BYTES = 4 * 1024 * 1024;

export function localMidnightMs(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

export function emptyUsageTotals() {
  return { input: 0, cached: 0, output: 0, reasoning: 0, total: 0, responseCount: 0 };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Normalise one token_usage_record payload into a comparable usage snapshot. */
export function parseTokenUsageRecord(payload) {
  const usage = payload?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = numberOrNull(usage.input_tokens);
  const cached = numberOrNull(usage.cached_input_tokens);
  const output = numberOrNull(usage.output_tokens);
  const reasoning = numberOrNull(usage.reasoning_output_tokens);
  const total = numberOrNull(usage.total_tokens);
  if (input === null && cached === null && output === null && total === null) return null;
  const inputTokens = input || 0;
  const cachedTokens = Math.min(cached || 0, inputTokens);
  return {
    input: inputTokens,
    cached: cachedTokens,
    output: output || 0,
    reasoning: reasoning || 0,
    total: total === null ? inputTokens + (output || 0) : total
  };
}

export function parseThreadUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const parsed = parseTokenUsageRecord({ usage });
  if (!parsed) return null;
  return {
    input: parsed.input,
    cached: parsed.cached,
    freshInput: Math.max(0, parsed.input - parsed.cached),
    output: parsed.output,
    reasoning: parsed.reasoning,
    total: parsed.total
  };
}

function addUsage(target, usage) {
  target.input += usage.input;
  target.cached += usage.cached;
  target.output += usage.output;
  target.reasoning += usage.reasoning;
  target.total += usage.total;
  target.responseCount += 1;
}

export function summariseUsage(totals) {
  return {
    input: totals.input,
    cached: totals.cached,
    freshInput: Math.max(0, totals.input - totals.cached),
    output: totals.output,
    reasoning: totals.reasoning,
    total: totals.total,
    responseCount: totals.responseCount
  };
}

export function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function listRolloutFiles(root, sinceMs) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6 || files.length >= MAX_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        if (stat.mtimeMs < sinceMs) continue;
        files.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  };
  walk(root, 0);
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return files;
}

async function readTail(file, offset, size) {
  const handle = await fsp.open(file, "r");
  try {
    const length = size - offset;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(Math.min(length, MAX_FILE_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    try {
      await handle.close();
    } catch {}
  }
}

function newFileEntry() {
  return { size: 0, offset: 0, mtimeMs: 0, usage: emptyUsageTotals(), ids: [], firstAt: null, lastAt: null, latest: null, latestThread: null, threadCounts: Object.create(null) };
}

function consumeText(entry, text, sinceMs, nowMs, globalIds) {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline < 0) return { consumed: 0, rest: text };
  const complete = text.slice(0, lastNewline + 1);
  const consumed = Buffer.byteLength(complete, "utf8");
  for (const rawLine of complete.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.length > MAX_LINE_BYTES) continue;
    if (!line.includes("token_usage_record")) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const at = Date.parse(record?.timestamp || "");
    if (!Number.isFinite(at) || at < sinceMs || at > nowMs + 60 * 60 * 1000) continue;
    const payload = record?.payload || {};
    const usage = parseTokenUsageRecord(payload);
    if (!usage) continue;
    const id = String(payload.response_id || `${payload.thread_id || "thread"}:${record.ordinal ?? ""}`);
    if (entry.ids.includes(id) || globalIds.has(id)) continue;
    entry.ids.push(id);
    globalIds.add(id);
    if (entry.ids.length > MAX_IDS_PER_FILE) entry.ids.splice(0, entry.ids.length - MAX_IDS_PER_FILE);
    addUsage(entry.usage, usage);
    const threadKey = String(payload.thread_id || "");
    if (threadKey) entry.threadCounts[threadKey] = Number(entry.threadCounts[threadKey] || 0) + 1;
    if (!entry.firstAt || at < Date.parse(entry.firstAt)) entry.firstAt = new Date(at).toISOString();
    if (!entry.lastAt || at > Date.parse(entry.lastAt)) entry.lastAt = new Date(at).toISOString();
    const threadUsage = parseThreadUsage(payload.thread_token_usage);
    const threadId = String(payload.thread_id || "");
    if (!entry.latest || at >= Date.parse(entry.latest.at)) {
      entry.latest = { at: new Date(at).toISOString(), threadId, turnId: String(payload.turn_id || "") };
    }
    // Some records omit the cumulative block; keep the newest one that has it so
    // the "current session" totals are always available.
    if (threadUsage && (!entry.latestThread || at >= Date.parse(entry.latestThread.at))) {
      entry.latestThread = { at: new Date(at).toISOString(), threadId, threadUsage };
    }
  }
  return { consumed, rest: "" };
}export function mergeTotals(target, usage) {
  target.input += Number(usage?.input || 0);
  target.cached += Number(usage?.cached || 0);
  target.output += Number(usage?.output || 0);
  target.reasoning += Number(usage?.reasoning || 0);
  target.total += Number(usage?.total || 0);
  target.responseCount += Number(usage?.responseCount || 0);
  return target;
}

function restoreEntry(raw) {
  const entry = newFileEntry();
  if (!raw || typeof raw !== "object") return entry;
  const usage = raw.usage && typeof raw.usage === "object" ? raw.usage : {};
  for (const key of Object.keys(entry.usage)) {
    const value = Number(usage[key]);
    if (Number.isFinite(value) && value >= 0) entry.usage[key] = value;
  }
  entry.size = Number.isFinite(Number(raw.size)) ? Number(raw.size) : 0;
  entry.offset = Number.isFinite(Number(raw.offset)) ? Number(raw.offset) : 0;
  entry.mtimeMs = Number.isFinite(Number(raw.mtimeMs)) ? Number(raw.mtimeMs) : 0;
  entry.ids = Array.isArray(raw.ids) ? raw.ids.filter((id) => typeof id === "string").slice(-MAX_IDS_PER_FILE) : [];
  entry.firstAt = typeof raw.firstAt === "string" ? raw.firstAt : null;
  entry.lastAt = typeof raw.lastAt === "string" ? raw.lastAt : null;
  entry.latest = raw.latest && typeof raw.latest === "object" ? raw.latest : null;
  entry.latestThread = raw.latestThread && typeof raw.latestThread === "object" ? raw.latestThread : null;
  entry.threadCounts = Object.assign(Object.create(null), raw.threadCounts && typeof raw.threadCounts === "object" ? raw.threadCounts : {});
  return entry;
}

function serialiseEntry(entry) {
  return {
    size: entry.size,
    offset: entry.offset,
    mtimeMs: entry.mtimeMs,
    usage: entry.usage,
    ids: entry.ids.slice(-MAX_IDS_PER_FILE),
    firstAt: entry.firstAt,
    lastAt: entry.lastAt,
    latest: entry.latest,
    latestThread: entry.latestThread,
    threadCounts: entry.threadCounts
  };
}

/**
 * Scan today's Codex rollout files.
 *
 * @param {object} options
 * @param {string} [options.codexHome]   Codex home (defaults to $CODEX_HOME or ~/.codex)
 * @param {string} [options.dataDir]     where codex-usage-cache.json lives
 * @param {string} [options.cachePath]   explicit cache path (tests)
 * @param {Date}   [options.now]
 * @param {number} [options.sinceMs]     start of the window (defaults to local midnight)
 * @param {string} [options.threadId]    prefer this thread for the "current session"
 * @param {boolean}[options.useCache]    set false to ignore/refresh the cache (tests)
 */
export async function scanCodexUsage(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const nowMs = now.getTime();
  const sinceMs = Number.isFinite(Number(options.sinceMs)) ? Number(options.sinceMs) : localMidnightMs(now);
  const codexHome = options.codexHome || defaultCodexHome();
  const cachePath = options.cachePath || (options.dataDir ? path.join(options.dataDir, "codex-usage-cache.json") : "");
  const warnings = [];
  const result = {
    status: "unavailable",
    source: "codex-log",
    codexHome,
    since: new Date(sinceMs).toISOString(),
    scannedFiles: 0,
    today: { ...summariseUsage(emptyUsageTotals()), firstAt: null, lastAt: null },
    thread: null,
    updatedAt: now.toISOString(),
    warnings
  };

  let cache = null;
  if (cachePath && options.useCache !== false) cache = await readJsonSafe(cachePath, null);
  const dayKey = new Date(sinceMs).toDateString();
  const files = {};
  if (cache && Number(cache.version) === CACHE_VERSION && cache.dayKey === dayKey && cache.files && typeof cache.files === "object") {
    for (const [file, raw] of Object.entries(cache.files)) files[file] = restoreEntry(raw);
  }

  const globalIds = new Set();
  for (const entry of Object.values(files)) {
    for (const id of entry.ids) globalIds.add(id);
  }

  let list = [];
  try {
    list = listRolloutFiles(path.join(codexHome, "sessions"), sinceMs);
  } catch (error) {
    warnings.push(`无法读取 Codex 会话目录：${error?.message || error}`);
  }

  const present = new Set();
  for (const info of list) {
    present.add(info.file);
    let entry = files[info.file] || (files[info.file] = newFileEntry());
    if (entry.offset > info.size) {
      // The file was truncated or replaced: rebuild it from scratch.
      entry = files[info.file] = newFileEntry();
    }
    if (entry.offset === info.size && entry.mtimeMs === info.mtimeMs && entry.offset > 0) continue;
    if (entry.offset && entry.offset === info.size) {
      entry.mtimeMs = info.mtimeMs;
      continue;
    }
    let text = "";
    try {
      text = await readTail(info.file, entry.offset, info.size);
    } catch (error) {
      warnings.push(`无法读取 ${path.basename(info.file)}：${error?.message || error}`);
      continue;
    }
    try {
      const { consumed } = consumeText(entry, text, sinceMs, nowMs, globalIds);
      entry.offset += consumed;
      entry.size = info.size;
      entry.mtimeMs = info.mtimeMs;
    } catch (error) {
      warnings.push(`解析 ${path.basename(info.file)} 失败：${error?.message || error}`);
    }
  }

  for (const file of Object.keys(files)) {
    if (!present.has(file)) delete files[file];
  }

  const totals = emptyUsageTotals();
  let firstAt = null;
  let lastAt = null;
  let latest = null;
  const threadCounts = {};
  for (const entry of Object.values(files)) {
    mergeTotals(totals, entry.usage);
    if (entry.firstAt && (!firstAt || Date.parse(entry.firstAt) < Date.parse(firstAt))) firstAt = entry.firstAt;
    if (entry.lastAt && (!lastAt || Date.parse(entry.lastAt) > Date.parse(lastAt))) lastAt = entry.lastAt;
    if (entry.latest && (!latest || Date.parse(entry.latest.at) >= Date.parse(latest.at))) latest = entry.latest;
    for (const [threadId, count] of Object.entries(entry.threadCounts || {})) {
      threadCounts[threadId] = Number(threadCounts[threadId] || 0) + Number(count || 0);
    }
  }

  let thread = null;
  if (options.threadId && latest && latest.threadId === options.threadId) thread = latest;
  else if (options.threadId) {
    for (const entry of Object.values(files)) {
      if (entry.latest?.threadId === options.threadId && (!thread || Date.parse(entry.latest.at) > Date.parse(thread.at))) thread = entry.latest;
    }
  }
  if (!thread) thread = latest;
  let threadSnapshot = null;
  for (const entry of Object.values(files)) {
    const candidate = entry.latestThread;
    if (!candidate) continue;
    if (thread && candidate.threadId !== thread.threadId) continue;
    if (!threadSnapshot || Date.parse(candidate.at) > Date.parse(threadSnapshot.at)) threadSnapshot = candidate;
  }
  if (!threadSnapshot && !thread) {
    for (const entry of Object.values(files)) {
      const candidate = entry.latestThread;
      if (candidate && (!threadSnapshot || Date.parse(candidate.at) > Date.parse(threadSnapshot.at))) threadSnapshot = candidate;
    }
  }

  result.scannedFiles = list.length;
  result.today = { ...summariseUsage(totals), firstAt, lastAt };
  const threadId = threadSnapshot?.threadId || thread?.threadId || "";
  if (threadId) {
    result.thread = {
      id: threadId,
      at: threadSnapshot?.at || thread?.at || null,
      turnId: thread?.turnId || "",
      responsesToday: Number(threadCounts[threadId] || 0),
      ...(threadSnapshot?.threadUsage || {})
    };
  }

  if (list.length > 0) result.status = "ok";
  else warnings.push("未找到今天写入的 Codex 会话文件");

  if (cachePath && options.useCache !== false) {
    const payload = {
      version: CACHE_VERSION,
      dayKey,
      updatedAt: new Date().toISOString(),
      files: Object.fromEntries(Object.entries(files).map(([file, entry]) => [file, serialiseEntry(entry)]))
    };
    await writeJsonAtomic(cachePath, payload).catch(() => {});
  }

  return result;
}
