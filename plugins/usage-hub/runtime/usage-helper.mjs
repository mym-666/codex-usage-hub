import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startWebBillServer } from "./web-bill-server.mjs";
import { scanCodexUsage } from "./codex-usage.mjs";
import {
  appendLogCapped,
  createNullDict,
  readJsonSafe,
  redactSecrets,
  shortStack,
  writeJsonAtomic
} from "./fs-atomic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
  "UsageHubPlugin"
);
// Only the directory shipped inside the plugin is trusted by default. Adapter
// files in the writable data directory are loaded only when config.providersDirs
// lists them explicitly, and their balance.url is then validated.
const BUNDLED_PROVIDERS_DIR = path.join(HERE, "providers");
const DEFAULT_PROVIDERS_DIRS = [BUNDLED_PROVIDERS_DIR];
const VERSION = "2.4.1";
const SESSION_FRESH_MS = 15 * 60 * 1000;
const WEB_BILL_STALE_MS = 15 * 60 * 1000;
const WEB_BALANCE_STALE_MS = 15 * 60 * 1000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BROWSER_FILE_BYTES = 32 * 1024 * 1024;
const TOKEN_WINDOW_BYTES = 2048;
const RECEIVER_ERROR_FRESH_MS = 60 * 60 * 1000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const readJsonIfExists = readJsonSafe;

function getConfigPath(dataDir) {
  return path.join(dataDir, "config.json");
}

async function loadConfig(dataDir) {
  const defaults = {
    // A usage snapshot is a background convenience, not a live feed: one poll a
    // minute keeps the daemon's CPU and disk churn negligible. Manual refresh
    // and every MCP tool call still rebuild on demand.
    refreshSeconds: 60,
    webUsage: true,
    allowBalanceDelta: true,
    browserOrder: ["edge", "chrome"],
    apiKey: "",
    browserTokens: {},
    providers: {},
    providersDirs: [],
    // Managed-overlay lifecycle. The overlay is a PowerShell + WinForms process,
    // so starting it on top of Codex's own start-up burst - and paying that cost
    // again on every reopen - is what makes the host feel slow. These defaults
    // stagger the start and keep a hidden overlay warm for a few minutes.
    overlayAutoStart: true,
    overlayStartDelaySeconds: 3,
    overlayIdleExitSeconds: 300
  };
  const config = await readJsonSafe(getConfigPath(dataDir), {});
  return {
    ...defaults,
    ...config,
    browserTokens: { ...defaults.browserTokens, ...(config?.browserTokens || {}) },
    providers: { ...defaults.providers, ...(config?.providers || {}) },
    providersDirs: Array.isArray(config?.providersDirs) ? config.providersDirs : defaults.providersDirs
  };
}

function hostOf(value) {
  if (!value) return "";
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return String(value).toLowerCase();
  }
}

function originOf(value) {
  if (!value) return "";
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).origin;
  } catch {
    return "";
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandTemplate(input, vars) {
  return String(input ?? "").replace(/\{\{([^}]+)\}\}/g, (_, key) => {
    const value = vars[key.trim()];
    return value === undefined || value === null ? "" : String(value);
  });
}

function parseTomlString(raw, key, section) {
  if (!raw) return "";
  const lines = String(raw).split(/\r?\n/);
  let active = !section;
  for (const line of lines) {
    const trimmed = line.trim();
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      active = sectionMatch[1] === section;
      continue;
    }
    if (!active || !trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(new RegExp(`^${escapeRegExp(key)}\\s*=\\s*["'](.*?)["']\\s*(?:#.*)?$`));
    if (match) return match[1];
  }
  return "";
}

function parseProviderSettings(raw) {
  let settings = {};
  try {
    settings = JSON.parse(raw || "{}");
  } catch {
    settings = {};
  }
  const config = typeof settings.config === "string" ? settings.config : "";
  const providerName = parseTomlString(config, "model_provider") || "custom";
  const baseUrl =
    parseTomlString(config, "base_url", "model_providers." + providerName) ||
    parseTomlString(config, "base_url") ||
    "";
  const configModel = parseTomlString(config, "model") || "";
  const apiKey =
    settings?.auth?.OPENAI_API_KEY ||
    settings?.auth?.api_key ||
    settings?.auth?.apiKey ||
    settings?.OPENAI_API_KEY ||
    settings?.api_key ||
    "";
  return { settings, config, providerName, baseUrl, model: configModel, apiKey: usableApiKey(apiKey) };
}

function usableApiKey(value) {
  const text = String(value || "").trim();
  if (!text || /^(PROXY_MANAGED|proxy_managed|null|undefined)$/i.test(text)) return "";
  return text;
}

async function readCodexModel(codexHome) {
  try {
    return parseTomlString(await fsp.readFile(path.join(codexHome, "config.toml"), "utf8"), "model") || "";
  } catch {
    return "";
  }
}

async function readCodexApiKey(codexHome) {
  const auth = await readJsonSafe(path.join(codexHome, "auth.json"), {});
  return usableApiKey(auth?.OPENAI_API_KEY || auth?.api_key || auth?.apiKey || "");
}

/**
 * Provider identity straight from Codex's own config.toml. This is the primary
 * source now; CC Switch is optional and may be missing entirely.
 */
async function readCodexProvider(codexHome) {
  try {
    const text = await fsp.readFile(path.join(codexHome, "config.toml"), "utf8");
    const key = parseTomlString(text, "model_provider") || "custom";
    const section = `model_providers.${key}`;
    return {
      id: `codex:${key}`,
      key,
      name: parseTomlString(text, "name", section) || key,
      baseUrl: parseTomlString(text, "base_url", section) || "",
      model: parseTomlString(text, "model") || ""
    };
  } catch {
    return null;
  }
}

/**
 * Display name for the configured model, read from Codex's own model catalog
 * (config.toml -> model_catalog_json). Works without CC Switch installed.
 */
async function readCodexModelDisplayName(codexHome, model) {
  try {
    const text = await fsp.readFile(path.join(codexHome, "config.toml"), "utf8");
    const catalogFile = parseTomlString(text, "model_catalog_json") || "";
    if (!catalogFile || !model) return "";
    const catalogPath = path.isAbsolute(catalogFile) ? catalogFile : path.join(codexHome, catalogFile);
    const catalog = await readJsonSafe(catalogPath, null);
    const rows = Array.isArray(catalog?.models) ? catalog.models : [];
    const wanted = String(model).toLowerCase();
    const row = rows.find((item) => String(item?.slug || "").toLowerCase() === wanted);
    return String(row?.display_name || "").trim();
  } catch {
    return "";
  }
}
/**
 * Credential order for balance probes. The provider's own key comes first: the key
 * in Codex's auth.json may be a proxy credential (for example "sk-ws-…" issued by a
 * local router) that the provider's real balance endpoint rejects with 401.
 */
function buildApiKeyCandidates(options = {}) {
  const candidates = [];
  const push = (key, source) => {
    const value = usableApiKey(key);
    if (!value || candidates.some((item) => item.key === value)) return;
    candidates.push({ key: value, source });
  };
  push(options.config?.apiKey, "config");
  push(options.config?.providers?.[options.providerId]?.apiKey, "config-provider");
  push(options.settings?.apiKey, "cc-switch");
  push(options.codexKey, "codex-auth");
  return candidates;
}
/**
 * Drop a balance.url from an adapter that was not shipped with the plugin unless
 * the adapter itself declares that host. Without this, any process able to write
 * into the data directory could redirect the user's Authorization header.
 */
function sanitizeUntrustedAdapter(adapter, file, skipped) {
  const url = adapter?.balance?.url;
  if (!url) return;
  let host = "";
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    host = "";
  }
  const declared = [...(adapter?.match?.hosts || []), ...(adapter?.match?.websiteHosts || [])]
    .map((entry) => String(entry).trim().toLowerCase())
    .filter((entry) => entry && entry !== "*");
  const allowed = Boolean(host) && declared.some((entry) => (entry.startsWith("*.") ? host.endsWith(entry.slice(1)) : host === entry));
  if (!allowed) {
    delete adapter.balance.url;
    skipped.push({ file, reason: `balance.url host not declared by this adapter: ${host || "unparsable"}` });
  }
}

function loadAdapters(extraDirs = []) {
  const requested = [...DEFAULT_PROVIDERS_DIRS, ...(Array.isArray(extraDirs) ? extraDirs : [])].filter(Boolean);
  const adapters = [];
  const skipped = [];
  const seenDirs = new Set();
  for (const dir of requested) {
    const resolvedDir = path.resolve(String(dir));
    if (seenDirs.has(resolvedDir)) continue;
    seenDirs.add(resolvedDir);
    const trusted = resolvedDir === path.resolve(BUNDLED_PROVIDERS_DIR);
    let names = [];
    try {
      names = fs.readdirSync(resolvedDir).filter((name) => name.endsWith(".json"));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(resolvedDir, name);
      try {
        const adapter = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
        if (!adapter || !adapter.id) continue;
        if (!trusted) sanitizeUntrustedAdapter(adapter, file, skipped);
        adapters.push(adapter);
      } catch {
        // Invalid local adapter files are ignored; known adapters remain usable.
        skipped.push({ file, reason: "invalid-json" });
      }
    }
  }
  const byId = new Map();
  for (const adapter of adapters) byId.set(adapter.id, adapter);
  return { adapters: [...byId.values()], skipped };
}

/**
 * Exact, wildcard-suffix or word-boundary matching. The previous substring match
 * made a provider named "notdeepseek" resolve to the DeepSeek adapter.
 */
function matchList(pattern, value) {
  const text = String(value || "").toLowerCase().trim();
  if (!text) return false;
  return (pattern || []).some((item) => {
    const candidate = String(item ?? "").trim().toLowerCase();
    if (!candidate) return false;
    if (candidate === "*") return true;
    if (candidate.startsWith("*.")) return text.endsWith(candidate.slice(1));
    if (text === candidate) return true;
    return new RegExp(`^${escapeRegExp(candidate)}(?![a-z0-9])`).test(text);
  });
}

const MULTI_LABEL_SUFFIXES = [
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
  "co.uk", "org.uk", "com.au", "net.au", "co.jp", "ne.jp", "or.jp",
  "com.tw", "com.hk", "co.kr", "com.sg", "com.br", "co.in"
];

function registrableDomain(host) {
  const labels = String(host || "").toLowerCase().split(".").filter(Boolean);
  if (labels.length < 2) return String(host || "").toLowerCase();
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && MULTI_LABEL_SUFFIXES.includes(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

function adapterScore(adapter, context) {
  const match = adapter.match || {};
  let best = 0;
  if (context.baseHost && (match.hosts || []).some((host) => String(host).toLowerCase() === context.baseHost)) best = 4;
  if (best < 4 && context.websiteHost && (match.websiteHosts || []).some((host) => String(host).toLowerCase() === context.websiteHost)) best = 4;
  if (best < 3 && matchList(match.names, context.name)) best = 3;
  if (best < 1 && matchList(match.categories, context.category)) best = 1;
  return best;
}

/**
 * Rank adapters instead of taking the first hit. A category-only match (score 1)
 * is honoured only when the adapter does not pin itself to specific hosts;
 * otherwise the generic fallback wins. Without this, every "cn_official" provider
 * resolved to the DeepSeek adapter and its API key was sent to api.deepseek.com.
 */
function matchAdapter(adapters, provider, baseUrl) {
  const context = {
    name: provider?.name || "",
    websiteHost: hostOf(provider?.website_url || ""),
    baseHost: hostOf(baseUrl),
    category: provider?.category || ""
  };
  const fallback = adapters.find((adapter) => adapter.fallback) || null;
  let winner = null;
  let winnerScore = 0;
  for (const adapter of adapters) {
    if (adapter.fallback) continue;
    const score = adapterScore(adapter, context);
    if (score > winnerScore) {
      winner = adapter;
      winnerScore = score;
    }
  }
  if (winner && winnerScore >= 2) return winner;
  if (winner && winnerScore === 1) {
    const match = winner.match || {};
    const pinsHosts = Boolean((match.hosts || []).length || (match.websiteHosts || []).length);
    if (!pinsHosts) return winner;
  }
  return fallback || winner;
}

/**
 * Hosts that belong to the provider itself. An Authorization header is only ever
 * sent to one of these (or to loopback), never to a host an adapter merely
 * happens to declare.
 */
function providerHosts(provider, baseUrl) {
  const hosts = new Set();
  for (const value of [hostOf(baseUrl), hostOf(provider?.website_url || "")]) {
    if (value) hosts.add(value);
  }
  return hosts;
}

function hostBelongsToProvider(host, provider, baseUrl) {
  for (const allowed of providerHosts(provider, baseUrl)) {
    if (host === allowed) return true;
    if (host.endsWith("." + allowed)) return true;
    if (registrableDomain(host) === registrableDomain(allowed)) return true;
  }
  return false;
}
/**
 * Open read-only and prove the handle works. SQLite defers the "file is not a
 * database" error until the first statement, so without the probe a corrupt file
 * would look like a successful open and never reach the copy fallback.
 */
function tryOpenReadOnly(dbPath) {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      db.prepare("SELECT 1").get();
    } catch (error) {
      try {
        db.close();
      } catch {}
      throw error;
    }
    return db;
  } catch {
    return null;
  }
}

/**
 * Open the CC Switch database read-only. Returns { db, mode } where mode is
 * "direct", "copy-fallback" or "unavailable". WAL databases often cannot be
 * opened read-only while the writer holds the -shm file, so fall back to a
 * private copy inside the plugin data directory.
 */
function openDatabase(dbPath, options = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) return { db: null, mode: "unavailable" };
  const direct = tryOpenReadOnly(dbPath);
  if (direct) return { db: direct, mode: "direct" };
  const dataDir = options.dataDir;
  if (!dataDir) return { db: null, mode: "unavailable" };
  const copyPath = path.join(dataDir, "cc-switch-readonly.db");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.copyFileSync(dbPath, copyPath);
    for (const suffix of ["-wal", "-shm"]) {
      const sideCar = `${dbPath}${suffix}`;
      if (fs.existsSync(sideCar)) fs.copyFileSync(sideCar, `${copyPath}${suffix}`);
    }
    const copied = tryOpenReadOnly(copyPath);
    if (copied) return { db: copied, mode: "copy-fallback" };
    for (const suffix of ["-wal", "-shm"]) {
      try {
        fs.rmSync(`${copyPath}${suffix}`, { force: true });
      } catch {}
    }
    const copyWithoutSideCars = tryOpenReadOnly(copyPath);
    if (copyWithoutSideCars) return { db: copyWithoutSideCars, mode: "copy-fallback" };
    try {
      fs.rmSync(copyPath, { force: true });
    } catch {}
    return { db: null, mode: "unavailable" };
  } catch {
    return { db: null, mode: "unavailable" };
  }
}

function getCurrentProvider(db) {
  if (!db) return null;
  try {
    return (
      db
        .prepare(
          `SELECT id, name, app_type, settings_config, website_url, category, meta, is_current
           FROM providers
           WHERE app_type = 'codex' AND is_current = 1
           ORDER BY sort_index ASC
           LIMIT 1`
        )
        .get() || null
    );
  } catch {
    return null;
  }
}

function getLatestRequestModel(db, providerId) {
  if (!db || !providerId) return "";
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(NULLIF(request_model, ''), NULLIF(model, ''), NULLIF(pricing_model, '')) AS model
         FROM proxy_request_logs
         WHERE app_type = 'codex' AND provider_id = ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(providerId);
    return row?.model || "";
  } catch {
    return "";
  }
}

function emptyTokenUsage() {
  return {
    requestCount: 0,
    successCount: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, freshInput: 0, total: 0 },
    cost: 0,
    firstAt: null,
    lastAt: null
  };
}

function queryAggregate(db, providerId, sinceUnix, threadId = "", dataSource = "proxy") {
  const empty = emptyTokenUsage();
  if (!db) return empty;
  if (dataSource !== "codex_session" && !providerId) return empty;
  try {
    const params = [];
    let sql = `SELECT COUNT(*) AS request_count,
                      COALESCE(SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END), 0) AS success_count,
                      COALESCE(SUM(input_tokens), 0) AS input_tokens,
                      COALESCE(SUM(output_tokens), 0) AS output_tokens,
                      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
                      COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
                      MIN(created_at) AS first_at,
                      MAX(created_at) AS last_at
               FROM proxy_request_logs
               WHERE app_type = 'codex'
                 AND created_at >= ?
                 AND data_source = ?`;
    params.push(sinceUnix, dataSource);
    if (dataSource !== "codex_session") {
      sql += " AND provider_id = ?";
      params.push(providerId);
    }
    if (threadId) {
      sql += " AND session_id = ?";
      params.push(threadId);
    }
    const row = db.prepare(sql).get(...params);
    if (!row) return empty;
    const inputTokens = Number(row.input_tokens || 0);
    const outputTokens = Number(row.output_tokens || 0);
    const cacheReadTokens = Number(row.cache_read_tokens || 0);
    const cacheCreationTokens = Number(row.cache_creation_tokens || 0);
    return {
      requestCount: Number(row.request_count || 0),
      successCount: Number(row.success_count || 0),
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheCreation: cacheCreationTokens,
        freshInput: Math.max(0, inputTokens - cacheReadTokens - cacheCreationTokens),
        total: inputTokens + outputTokens
      },
      cost: Number(row.total_cost_usd || 0),
      firstAt: row.first_at ? new Date(Number(row.first_at) * 1000).toISOString() : null,
      lastAt: row.last_at ? new Date(Number(row.last_at) * 1000).toISOString() : null
    };
  } catch {
    return empty;
  }
}

function getRecentSession(db, providerId, now = Date.now()) {
  if (!db || !providerId) return null;
  try {
    const cutoff = Math.floor((now - SESSION_FRESH_MS) / 1000);
    const row = db
      .prepare(
        `SELECT session_id
         FROM proxy_request_logs
         WHERE app_type = 'codex'
           AND data_source = 'codex_session'
           AND session_id IS NOT NULL
           AND session_id <> ''
           AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(cutoff);
    if (!row?.session_id) return null;
    return { id: row.session_id, kind: "recent" };
  } catch {
    return null;
  }
}

/**
 * Prices shipped inside an adapter (runtime/providers/*.json -> "pricing").
 * The repository is the source of truth for the models it declares, so the
 * plugin no longer needs the CC Switch price table to show a unit price.
 * Matching mirrors the database lookup (exact id first, then id prefix) but
 * prefers the longest pattern so "deepseek-v3.1" can never be captured by
 * "deepseek-v3".
 */
function getAdapterPricing(adapter, candidates) {
  const table = adapter?.pricing;
  const rows = Array.isArray(table?.models) ? table.models : [];
  if (rows.length === 0) return null;
  const normalized = candidates.map((item) => String(item || "").toLowerCase()).filter(Boolean);
  if (normalized.length === 0) return null;
  const entries = rows
    .map((row) => ({
      row,
      patterns: (Array.isArray(row.match) ? row.match : [row.id])
        .map((pattern) => String(pattern || "").toLowerCase())
        .filter(Boolean)
    }))
    .filter((entry) => entry.patterns.length > 0)
    .sort((a, b) => Math.max(...b.patterns.map((p) => p.length)) - Math.max(...a.patterns.map((p) => p.length)));
  const hit = entries.find((entry) =>
    entry.patterns.some(
      (pattern) =>
        normalized.includes(pattern) || normalized.some((candidate) => candidate.startsWith(pattern))
    )
  );
  if (!hit) return null;
  const row = hit.row;
  return {
    status: "ok",
    modelId: String(row.id || hit.patterns[0]),
    displayName: String(row.displayName || ""),
    currency: String(table.currency || "USD"),
    inputPerMillion: Number(row.inputPerMillion || 0),
    outputPerMillion: Number(row.outputPerMillion || 0),
    cacheReadPerMillion: Number(row.cacheReadPerMillion || 0),
    cacheCreationPerMillion: Number(row.cacheCreationPerMillion || 0),
    source: "builtin"
  };
}

/**
 * Adapter prices win for the models they declare (they ship with the plugin and
 * are reviewable in the repository); the CC Switch table stays as the fallback
 * for everything else. With neither, report an honest "unavailable" instead of
 * an empty table attributed to CC Switch.
 */
function pickPricing(db, candidates, adapter) {
  const builtin = getAdapterPricing(adapter, candidates);
  if (builtin) return builtin;
  const fromDatabase = getPricing(db, candidates);
  if (fromDatabase.status === "ok") return fromDatabase;
  return { ...fromDatabase, source: "unavailable" };
}

function getPricing(db, candidates) {
  const missing = {
    status: "unavailable",
    currency: "USD",
    inputPerMillion: null,
    outputPerMillion: null,
    cacheReadPerMillion: null,
    cacheCreationPerMillion: null,
    source: "cc-switch"
  };
  if (!db) return missing;
  try {
    const rows = db
      .prepare(
        `SELECT model_id, display_name, input_cost_per_million, output_cost_per_million,
                cache_read_cost_per_million, cache_creation_cost_per_million
         FROM model_pricing`
      )
      .all();
    const normalized = candidates.map((item) => String(item || "").toLowerCase()).filter(Boolean);
    const row =
      rows.find((item) => normalized.includes(String(item.model_id).toLowerCase())) ||
      rows.find((item) => normalized.some((candidate) => candidate.startsWith(String(item.model_id).toLowerCase()))) ||
      null;
    if (!row) return missing;
    return {
      status: "ok",
      modelId: row.model_id,
      displayName: row.display_name,
      currency: "USD",
      inputPerMillion: Number(row.input_cost_per_million || 0),
      outputPerMillion: Number(row.output_cost_per_million || 0),
      cacheReadPerMillion: Number(row.cache_read_cost_per_million || 0),
      cacheCreationPerMillion: Number(row.cache_creation_cost_per_million || 0),
      source: "cc-switch"
    };
  } catch {
    return missing;
  }
}

function pickFirst(values) {
  return values.find((value) => value !== undefined && value !== null && value !== "") ?? null;
}

function collectByPath(value, pathExpression) {
  if (!pathExpression) return [];
  const parts = String(pathExpression).split(".").filter(Boolean);
  let current = [value];
  for (const part of parts) {
    const next = [];
    for (const item of current) {
      if (item === null || item === undefined) continue;
      if (part === "*") {
        if (Array.isArray(item)) next.push(...item);
        else if (typeof item === "object") next.push(...Object.values(item));
      } else if (Array.isArray(item)) {
        const index = Number(part);
        if (Number.isInteger(index) && item[index] !== undefined) next.push(item[index]);
      } else if (typeof item === "object" && item[part] !== undefined) {
        next.push(item[part]);
      }
    }
    current = next;
  }
  return current;
}

function firstByPaths(value, paths) {
  const list = Array.isArray(paths) ? paths : [paths];
  for (const candidate of list) {
    if (!candidate) continue;
    const found = pickFirst(collectByPath(value, candidate));
    if (found !== null) return found;
  }
  return null;
}

function findFirstKey(value, keys, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstKey(item, keys, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findFirstKey(child, keys, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

function parseProviderMeta(provider) {
  try {
    return JSON.parse(provider?.meta || "{}");
  } catch {
    return {};
  }
}
/**
 * Extract the balance URL from a CC Switch usage_script snippet.
 * Returns null when the snippet wants the API key embedded in the URL:
 * credentials must travel in the Authorization header only.
 */
function resolveUrlFromUsageScript(meta, baseUrl) {
  const script = meta?.usage_script || meta?.usageScript;
  if (!script || script.enabled === false || !script.code) return "";
  const match = String(script.code).match(/url\s*:\s*["'`]([^"'`]+)["'`]/i);
  if (!match) return "";
  const raw = match[1];
  if (raw.includes("{{apiKey}}") || raw.includes("{{api_key}}")) return null;
  return raw.replaceAll("{{baseUrl}}", String(baseUrl || "").replace(/\/+$/, ""));
}

/**
 * Every URL that will carry an Authorization header must resolve to the provider
 * itself (base_url host, website host, a subdomain of either, or the same
 * registrable domain), or to loopback for local proxies. This applies to adapter
 * balance.url, CC Switch usage_script URLs, probe paths and web-usage templates,
 * so a mismatched adapter can never redirect the user's key to a third party.
 */
function assertSafeBalanceUrl(rawUrl, baseUrl, provider, source) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return { ok: false, reason: "unparsable-url" };
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = LOOPBACK_HOSTS.has(host);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    return { ok: false, reason: "insecure-protocol" };
  }
  if (isLoopback) return { ok: true, url: parsed.toString() };
  if (!hostBelongsToProvider(host, provider, baseUrl)) {
    return { ok: false, reason: "host-not-provider:" + host };
  }
  return { ok: true, url: parsed.toString() };
}

function joinUrl(base, suffix) {
  return `${String(base || "").replace(/\/+$/, "")}/${String(suffix || "").replace(/^\/+/, "")}`;
}

function resolveBalanceCandidates(adapter, provider, baseUrl) {
  const meta = parseProviderMeta(provider);
  const candidates = [];
  const rejected = [];
  const scriptUrl = resolveUrlFromUsageScript(meta, baseUrl);
  if (scriptUrl === null) {
    rejected.push("已拒绝 meta.usage_script 中的余额接口 URL：凭据不得拼入 URL，只通过请求头发送");
  } else if (scriptUrl) {
    const check = assertSafeBalanceUrl(scriptUrl, baseUrl, provider, "usage-script");
    if (check.ok) candidates.push(check.url);
    else rejected.push(`已拒绝可疑余额接口 URL（来源 meta.usage_script，原因 ${check.reason}）`);
  }
  if (adapter?.balance?.url) {
    const check = assertSafeBalanceUrl(adapter.balance.url, baseUrl, provider, "adapter");
    if (check.ok) candidates.push(check.url);
    else rejected.push(`已拒绝可疑余额接口 URL（来源适配器 ${adapter.id}，原因 ${check.reason}）`);
  }
  if (adapter?.balance?.probePaths) {
    const root = String(baseUrl || "").replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
    for (const probe of adapter.balance.probePaths) {
      const check = assertSafeBalanceUrl(joinUrl(root, probe), baseUrl, provider, "probe");
      if (check.ok) candidates.push(check.url);
    }
  }
  return { urls: [...new Set(candidates)], rejected: [...new Set(rejected)] };
}

async function readBodyCapped(response, limit) {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error("response too large");
    return text;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) {
      try {
        await response.body.cancel();
      } catch {}
      throw new Error("response too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchJson(url, headers = {}, timeoutMs = 15000) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw new Error("invalid url");
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && LOOPBACK_HOSTS.has(host))) {
    throw new Error("unsupported protocol");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, { headers, signal: controller.signal, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const error = new Error(`HTTP ${response.status} redirect refused`);
      error.status = response.status;
      throw error;
    }
    const text = await readBodyCapped(response, MAX_RESPONSE_BYTES);
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text.slice(0, 2000) };
    }
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBalance(adapter, provider, baseUrl, credentials, config) {
  const { urls, rejected } = resolveBalanceCandidates(adapter, provider, baseUrl);
  const candidates = (Array.isArray(credentials) ? credentials : [{ key: credentials, source: "config" }])
    .map((item) => (typeof item === "string" ? { key: item, source: "config" } : item))
    .filter((item) => item && usableApiKey(item.key));
  if (!candidates.length) {
    return { status: "unavailable", message: "API Key 不可用", source: "provider-api", rejected };
  }
  let sawUnauthorized = false;
  for (const candidate of candidates) {
    for (const url of urls) {
      try {
        const json = await fetchJson(url, {
          ...(adapter?.balance?.headers || {}),
          Authorization: `Bearer ${candidate.key}`
        });
        const fields = adapter?.balance?.fields || {};
        const available = firstByPaths(json, fields.available);
        const toppedUp = firstByPaths(json, fields.toppedUp);
        const granted = firstByPaths(json, fields.granted);
        const currency = firstByPaths(json, fields.currency) || "USD";
        const fallbackAvailable = findFirstKey(json, [
          "total_available",
          "totalAvailable",
          "available_balance",
          "availableBalance",
          "balance",
          "remaining",
          "remaining_balance",
          "remainingBalance",
          "total_balance",
          "totalBalance",
          "remain_quota",
          "remainQuota",
          "credits",
          "credit",
          "amount"
        ]);
        const value = available ?? fallbackAvailable;
        if (value === null) continue;
        return {
          status: "ok",
          currency: String(currency || "USD").toUpperCase(),
          available: Number(value),
          toppedUp: toppedUp === null ? null : Number(toppedUp),
          granted: granted === null ? null : Number(granted),
          source: "provider-api",
          credential: candidate.source,
          url,
          rejected
        };
      } catch (error) {
        if (error?.status === 401 || error?.status === 403) {
          // This credential cannot read the balance; try the next one.
          sawUnauthorized = true;
          break;
        }
      }
    }
  }
  if (sawUnauthorized) {
    return { status: "unauthorized", message: "API Key 无余额查询权限", source: "provider-api", rejected };
  }
  return { status: "unavailable", message: "未探测到余额接口", source: "provider-api", rejected };
}
function browserRoots(browser) {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  if (browser === "edge") {
    return [
      path.join(local, "Microsoft", "Edge", "User Data"),
      path.join(local, "Microsoft", "Edge Beta", "User Data")
    ];
  }
  return [
    path.join(local, "Google", "Chrome", "User Data"),
    path.join(local, "Google", "Chrome Beta", "User Data")
  ];
}

function decodeStorageText(buffer) {
  return [buffer.toString("utf8"), buffer.toString("latin1"), buffer.toString("utf16le")];
}

/**
 * Chromium localStorage LevelDB keys are "_<origin>\x00\x01<key>".
 * Matching that exact byte prefix binds the value to one origin AND one key, so a
 * token belonging to another site can no longer be picked up just because the
 * hostname happened to appear somewhere in the same file.
 */
function levelDbKeyNeedles(origin, key) {
  const normalizedOrigin = String(origin || "").trim().replace(/\/+$/, "").toLowerCase();
  const normalizedKey = typeof key === "string" ? key.trim() : "";
  if (!normalizedOrigin || !normalizedKey) return [];
  const variants = new Set([normalizedOrigin]);
  if (normalizedOrigin.startsWith("https://")) variants.add(normalizedOrigin.replace(/^https:/, "http:"));
  if (normalizedOrigin.startsWith("http://")) variants.add(normalizedOrigin.replace(/^http:/, "https:"));
  return [...variants].map((variant) => Buffer.from(`_${variant}\u0000\u0001${normalizedKey}`, "utf8"));
}

function pickTokenFromRegion(region, minLength = 20) {
  for (const text of decodeStorageText(region)) {
    const jwt = text.match(/[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{5,}/);
    if (jwt && jwt[0].length >= minLength) return jwt[0];
    const quoted = text.match(/"([A-Za-z0-9._\-+/=]{20,})"/);
    if (quoted) return quoted[1];
    const bare = text.match(/(?:^|[^A-Za-z0-9._\-+/=])([A-Za-z0-9._\-+/=]{32,})/);
    if (bare) return bare[1];
  }
  return "";
}

function extractScopedToken(buffer, needles, minLength = 20) {
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const start = buffer.indexOf(needle, from);
      if (start < 0) break;
      from = start + needle.length;
      const end = Math.min(buffer.length, start + needle.length + TOKEN_WINDOW_BYTES);
      const value = pickTokenFromRegion(buffer.subarray(start + needle.length, end), minLength);
      if (value) return value;
    }
  }
  return "";
}

function extractBrowserToken(origin, keys, browserOrder) {
  const expectedHost = hostOf(origin);
  if (!expectedHost) return null;
  const keyList = (Array.isArray(keys) ? keys : [keys]).map((key) => String(key || "").trim()).filter(Boolean);
  if (!keyList.length) return null;
  const needles = keyList.flatMap((key) => levelDbKeyNeedles(origin, key));
  if (!needles.length) return null;
  for (const browser of browserOrder) {
    for (const root of browserRoots(browser)) {
      let profiles = [];
      try {
        profiles = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of profiles) {
        if (!entry.isDirectory()) continue;
        if (entry.name !== "Default" && !entry.name.startsWith("Profile")) continue;
        const leveldb = path.join(root, entry.name, "Local Storage", "leveldb");
        let files = [];
        try {
          files = fs
            .readdirSync(leveldb)
            .filter((name) => name.endsWith(".log") || name.endsWith(".ldb"))
            .map((name) => path.join(leveldb, name));
        } catch {
          continue;
        }
        files.sort((a, b) => {
          try {
            return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
          } catch {
            return 0;
          }
        });
        for (const file of files) {
          try {
            const stat = fs.statSync(file);
            if (stat.size > MAX_BROWSER_FILE_BYTES) continue;
            const token = extractScopedToken(fs.readFileSync(file), needles);
            if (token) return { token, browser, file };
          } catch {
            // Browser storage files may be locked; try the next profile/file.
          }
        }
      }
    }
  }
  return null;
}

function localDateKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Local-midnight based day window. The previous implementation added a
 * fractional-hour "shift", which moved the window by 30 minutes for zones such
 * as Asia/Kolkata. new Date(y, m, d) already yields the correct local midnight.
 */
function getTodayRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime());
  end.setDate(end.getDate() + 1);
  return {
    startUnix: Math.floor(start.getTime() / 1000),
    endUnix: Math.floor(end.getTime() / 1000),
    tzOffset: -now.getTimezoneOffset() * 60
  };
}
async function readCachedWebBill(dataDir, adapter, provider) {
  const cache = await readJsonSafe(path.join(dataDir, "web-bills.json"), null);
  const bills = createNullDict(cache?.bills);
  const keys = [adapter?.id, provider?.id, String(provider?.name || "").toLowerCase(), "deepseek"];
  const key = keys.filter(Boolean).find((candidate) => Object.prototype.hasOwnProperty.call(bills, candidate));
  const bill = key ? bills[key] : null;
  if (!bill) return null;
  if (bill.date !== localDateKey(new Date())) return null;
  const capturedAt = Date.parse(bill.capturedAt);
  const ageMs = Number.isFinite(capturedAt) ? Math.max(0, Date.now() - capturedAt) : Number.POSITIVE_INFINITY;
  return {
    status: "ok",
    cost: Number(bill.cost),
    currency: String(bill.currency || "CNY").toUpperCase(),
    source: "web-extension",
    tokenSource: bill.tokenSource || (bill.tokens ? "api" : "cc-switch"),
    capturedAt: bill.capturedAt,
    stale: ageMs > WEB_BILL_STALE_MS,
    ageMs,
    tokens: bill.tokens || null
  };
}

/**
 * Balance captured from the provider's own website by the Edge extension
 * (platform.deepseek.com -> /api/v0/users/get_user_summary). This is the value the
 * API-key probe cannot produce when Codex authenticates through a local router with
 * a proxy credential.
 */
async function readWebBalance(dataDir, provider, now = Date.now()) {
  if (!provider) return null;
  const raw = await readJsonSafe(path.join(dataDir, "web-balance.json"), null);
  if (!raw || typeof raw !== "object") return null;
  const available = Number(raw.available);
  if (!Number.isFinite(available) || available < 0) return null;
  const capturedAt = Date.parse(raw.capturedAt || "");
  const ageMs = Number.isFinite(capturedAt) ? Math.max(0, now - capturedAt) : Number.POSITIVE_INFINITY;
  const currency = String(raw.currency || "").toUpperCase();
  return {
    status: "ok",
    available,
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "CNY",
    source: "web-extension",
    provider: String(raw.provider || ""),
    wallets: Array.isArray(raw.wallets) ? raw.wallets.slice(0, 8) : [],
    capturedAt: raw.capturedAt || null,
    ageMs,
    stale: ageMs > WEB_BALANCE_STALE_MS
  };
}

/**
 * API first, website second: the provider API needs no browser, and the website
 * value covers setups where the API key has no balance permission.
 */
function pickBalance(apiBalance, webBalance) {
  if (apiBalance?.status === "ok") return apiBalance;
  if (webBalance?.status === "ok") {
    // A website value that is older than 15 minutes is still the best number on
    // hand when the browser was closed; return it marked stale so the overlay and
    // usage_snapshot can label it instead of showing nothing at all.
    return { ...webBalance, apiStatus: apiBalance?.status || "unavailable" };
  }
  return apiBalance || webBalance || { status: "unavailable", message: "未探测到余额接口", source: "none" };
}
async function fetchWebUsage(adapter, provider, baseUrl, config, dataDir) {
  const cached = await readCachedWebBill(dataDir, adapter, provider);
  if (cached) return cached;
  const web = adapter?.webUsage;
  if (!web || !web.urlTemplate) {
    return { status: "unavailable", message: "Provider 未配置网页账单", source: "web" };
  }
  const providerId = provider?.id;
  const override =
    (providerId && config?.providers?.[providerId]?.webUsage) ||
    (adapter?.id && config?.providers?.[adapter.id]?.webUsage) ||
    {};
  const manualToken = override.token || config?.browserTokens?.[web.id] || config?.browserTokens?.[adapter.id] || "";
  const range = getTodayRange();
  const vars = {
    baseUrl: String(baseUrl || "").replace(/\/+$/, ""),
    websiteOrigin: originOf(provider?.website_url || ""),
    startUnix: range.startUnix,
    endUnix: range.endUnix,
    tzOffset: range.tzOffset
  };
  // Adapter templates may reference {{websiteOrigin}}; expand before use so the
  // token scan is scoped to a real origin instead of a literal placeholder.
  const authOrigin = expandTemplate(web.auth?.origin || "", vars);
  let token = manualToken;
  let tokenSource = token ? "config" : "";
  let browser = "";
  if (!token) {
    const found = extractBrowserToken(authOrigin, web.auth?.storageKeys || [], config.browserOrder || ["edge", "chrome"]);
    if (found) {
      token = found.token;
      browser = found.browser;
      tokenSource = found.browser;
    }
  }
  if (!token) {
    return {
      status: "login_required",
      message: `无法读取 ${provider?.name || "Provider"} 网页登录态；当前使用余额差值或本地估算。可在 config.json 的 browserTokens.${web.id} 配置平台 Token。`,
      source: "web"
    };
  }
  const check = assertSafeBalanceUrl(expandTemplate(web.urlTemplate, vars), baseUrl, provider, "web-usage");
  if (!check.ok) {
    return { status: "error", message: `网页账单 URL 被拒绝（${check.reason}）`, source: "web" };
  }
  try {
    const json = await fetchJson(check.url, { ...(web.headers || {}), Authorization: `Bearer ${token}` });
    for (const errorPath of web.errorPaths || []) {
      const value = pickFirst(collectByPath(json, errorPath));
      if (value !== null && Number(value) !== 0) {
        return { status: "error", message: `网页账单返回错误 ${value}`, source: "web" };
      }
    }
    const costs = [];
    for (const pathExpression of web.costPaths || []) {
      for (const item of collectByPath(json, pathExpression)) {
        const number = Number(item);
        if (Number.isFinite(number)) costs.push(number);
      }
    }
    const directCost = costs.length
      ? costs.reduce((sum, value) => sum + value, 0)
      : Number(findFirstKey(json, ["cost", "total_cost", "totalCost", "usage"]));
    if (!Number.isFinite(directCost)) {
      return { status: "error", message: "网页账单没有可识别费用字段", source: "web" };
    }
    const currency = firstByPaths(json, web.currencyPaths || []) || "CNY";
    return { status: "ok", cost: directCost, currency: String(currency || "CNY").toUpperCase(), source: "web", tokenSource, browser };
  } catch (error) {
    return {
      status: "error",
      message: error?.status ? `网页账单 HTTP ${error.status}` : "网页账单请求失败",
      source: "web"
    };
  }
}

async function updateBalanceDelta(dataDir, currentBalance, currency, enabled) {
  if (!enabled || !Number.isFinite(currentBalance)) return null;
  const statePath = path.join(dataDir, "state.json");
  const now = Date.now();
  const today = localDateKey(new Date(now));
  const prior = await readJsonSafe(statePath, {});
  let state;
  let reliable = false;
  if (!prior || prior.day !== today || prior.currency !== currency) {
    const gap = prior?.lastSampleAt ? now - Number(prior.lastSampleAt) : Number.POSITIVE_INFINITY;
    const dayStartBalance =
      prior?.currency === currency && prior?.lastBalance !== undefined ? Number(prior.lastBalance) : currentBalance;
    reliable = gap <= SESSION_FRESH_MS;
    state = {
      day: today,
      currency,
      dayStartBalance,
      dayStartReliable: reliable,
      lastBalance: currentBalance,
      lastSampleAt: now,
      topUp: 0
    };
  } else {
    const previous = Number(prior.lastBalance);
    let topUp = Number(prior.topUp || 0);
    if (currentBalance > previous + 1e-9) topUp += currentBalance - previous;
    state = { ...prior, lastBalance: currentBalance, lastSampleAt: now, topUp };
    reliable = Boolean(prior.dayStartReliable);
  }
  const spend = Math.max(
    0,
    Number(state.dayStartBalance || currentBalance) + Number(state.topUp || 0) - currentBalance
  );
  await writeJsonAtomic(statePath, state);
  return { status: "ok", cost: spend, currency, source: "balance_delta", reliable };
}

/**
 * The web-bill status file is written by a browser extension and can therefore be
 * influenced by web content. Never pass it through verbatim: strip control
 * characters, redact credential-looking text, cap the length and flag it.
 */
function sanitizeWebBillStatus(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    status: raw.status === "error" ? "error" : "unknown",
    message: redactSecrets(String(raw.message || ""))
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, 120),
    at: typeof raw.capturedAt === "string" ? raw.capturedAt : null,
    untrusted: true
  };
}

async function readReceiverError(dataDir) {
  const raw = await readJsonSafe(path.join(dataDir, "receiver-error.json"), null);
  if (!raw || typeof raw !== "object") return null;
  const at = Date.parse(raw.at);
  if (Number.isFinite(at) && Date.now() - at > RECEIVER_ERROR_FRESH_MS) return null;
  return {
    code: String(raw.code || "unknown"),
    message: redactSecrets(String(raw.message || "")).slice(0, 200),
    at: raw.at || null,
    foreign: Boolean(raw.foreign)
  };
}
async function buildSnapshot(options = {}) {
  const now = options.now || new Date();
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const config = await loadConfig(dataDir);
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const dbPath = options.ccSwitchDb || path.join(os.homedir(), ".cc-switch", "cc-switch.db");
  const opened = openDatabase(dbPath, { dataDir });
  const db = opened.db;
  const databaseMode = db ? opened.mode : "unavailable";
  try {
    const webBillStatus = sanitizeWebBillStatus(await readJsonSafe(path.join(dataDir, "web-bill-status.json"), null));
    const receiverError = await readReceiverError(dataDir);
    const warnings = [];
    if (receiverError && !receiverError.foreign) {
      warnings.push(`本地接收器异常（${receiverError.code}）：官网账单可能无法更新`);
    }
    const providerRow = getCurrentProvider(db);
    const codexProvider = await readCodexProvider(codexHome);
    if (!providerRow && !codexProvider) {
      warnings.push("未能从 Codex 配置或 CC Switch 识别出 Provider");
    }
    const settings = providerRow ? parseProviderSettings(providerRow.settings_config) : {};
    const providerName = codexProvider?.name || providerRow?.name || "";
    const baseUrl = codexProvider?.baseUrl || settings.baseUrl || "";
    const providerId = codexProvider?.id || providerRow?.id || "";
    // The adapter matcher only reads identity fields, so a Codex-only setup matches
    // an adapter without any CC Switch row present.
    const providerForMatching = {
      id: providerId,
      name: providerName,
      website_url: providerRow?.website_url || "",
      category: providerRow?.category || "",
      meta: providerRow?.meta || "{}",
      settings_config: providerRow?.settings_config || "{}"
    };
    const { adapters, skipped } = loadAdapters(config.providersDirs);
    for (const item of skipped) {
      warnings.push(`已忽略适配器配置 ${path.basename(String(item.file))}：${redactSecrets(item.reason)}`);
    }
    const adapter = matchAdapter(adapters, providerForMatching, baseUrl);
    // An adapter that ships with the plugin declares its own website host; using it
    // keeps credentialed requests bound to the provider even when CC Switch is absent.
    // Wildcard hosts (the generic fallback adapter declares "*") must not become a
    // website origin; without a real host the provider keeps only its base URL.
    const adapterWebsiteHost =
      (adapter?.match?.websiteHosts || []).find((host) => host && !String(host).includes("*")) || "";
    const websiteUrl = providerRow?.website_url || (adapterWebsiteHost ? `https://${adapterWebsiteHost}` : "");
    const providerForRequests = { ...providerForMatching, website_url: websiteUrl };
    const model =
      options.model ||
      codexProvider?.model ||
      (await readCodexModel(codexHome)) ||
      settings.model ||
      (providerRow ? getLatestRequestModel(db, providerRow.id) : "") ||
      "unknown";

    const catalogDisplayName = await readCodexModelDisplayName(codexHome, model);
    const codexUsage = await scanCodexUsage({ codexHome, dataDir, now, threadId: options.threadId || "" });
    const apiKeyCandidates = buildApiKeyCandidates({
      config,
      providerId: providerRow?.id || providerId,
      settings,
      codexKey: await readCodexApiKey(codexHome)
    });
    const pricing = pickPricing(db, [model, settings.model, providerName], adapter);
    const apiBalance = providerName
      ? await fetchBalance(adapter, providerForRequests, baseUrl, apiKeyCandidates, config)
      : { status: "unavailable", message: "未识别 Provider，跳过余额探测", source: "provider-api", rejected: [] };
    for (const reason of apiBalance.rejected || []) warnings.push(reason);
    const webBalance = await readWebBalance(dataDir, providerForRequests, now.getTime());
    const balance = pickBalance(apiBalance, webBalance);
    const webUsage = config.webUsage
      ? await fetchWebUsage(adapter, providerForRequests, baseUrl, config, dataDir)
      : { status: "unavailable", message: "网页账单已关闭", source: "web" };
    const range = getTodayRange(now);
    const todayLocal = providerRow ? queryAggregate(db, providerRow.id, range.startUnix) : emptyTokenUsage();
    let today = { ...todayLocal, currency: "USD", source: "cc-switch", tokenSource: "cc-switch", reliable: false };
    if (webUsage.status === "ok") {
      today = {
        ...today,
        cost: webUsage.cost,
        currency: webUsage.currency || "CNY",
        source: webUsage.source || "web",
        reliable: !webUsage.stale,
        stale: Boolean(webUsage.stale),
        capturedAt: webUsage.capturedAt,
        tokenSource: webUsage.tokenSource || "api",
        browser: webUsage.browser
      };
      if (webUsage.tokens) {
        today.tokens = { ...today.tokens, ...webUsage.tokens };
        if (!Number.isFinite(Number(today.tokens.total))) {
          today.tokens.total = Number(today.tokens.input || 0) + Number(today.tokens.output || 0);
        }
      }
    } else if (balance.status === "ok" && config.allowBalanceDelta) {
      const delta = await updateBalanceDelta(dataDir, balance.available, balance.currency, true);
      if (delta) {
        today = { ...today, cost: delta.cost, currency: delta.currency, source: "balance_delta", reliable: delta.reliable };
      }
      if (webUsage.status === "login_required") warnings.push(webUsage.message);
    } else if (webUsage.status !== "ok" && webUsage.message) {
      warnings.push(webUsage.message);
    }
    if (webUsage.status === "ok" && webUsage.stale) {
      const ageMinutes = Math.max(1, Math.round(Number(webUsage.ageMs || 0) / 60000));
      warnings.push(`网页账单已 ${ageMinutes} 分钟未更新；请保持 Edge 和扩展运行。`);
    }

    // Codex-local token detail: no CC Switch database and no browser required.
    today.codex = {
      ...codexUsage.today,
      threadId: codexUsage.thread?.id || "",
      updatedAt: codexUsage.thread?.at || codexUsage.updatedAt,
      source: "codex-log"
    };
    const webTokensUsable =
      webUsage.status === "ok" && !webUsage.stale && Number(today.tokens?.total || 0) > 0;
    // Page text cannot be told apart from the account- or range-wide figure the same
    // page renders, so only an API-sourced website value outranks Codex's own logs.
    // Scraped numbers are still reported through today.tokenSource, but they no longer
    // replace a first-party total (B17 follow-up).
    const webTokensExact = webTokensUsable && String(today.tokenSource || "") === "api";
    today.tokenScope =
      webTokensExact || (webTokensUsable && codexUsage.today.total <= 0)
        ? "web"
        : codexUsage.today.total > 0
          ? "codex"
          : "web";
    if (today.tokenScope === "codex") {
      today.tokens = {
        input: codexUsage.today.input,
        output: codexUsage.today.output,
        cacheRead: codexUsage.today.cached,
        cacheCreation: 0,
        freshInput: codexUsage.today.freshInput,
        total: codexUsage.today.total
      };
      today.tokenSource = "codex-log";
    }
    for (const warning of codexUsage.warnings || []) warnings.push(warning);

    const session = codexUsage.thread
      ? {
          status: "ok",
          id: codexUsage.thread.id,
          kind: "current",
          source: "codex-log",
          currency: null,
          cost: null,
          tokens: {
            input: codexUsage.thread.input,
            output: codexUsage.thread.output,
            cacheRead: codexUsage.thread.cached,
            cacheCreation: 0,
            freshInput: codexUsage.thread.freshInput,
            total: codexUsage.thread.total
          },
          requestCount: codexUsage.thread.responsesToday,
          responseCount: codexUsage.thread.responsesToday,
          reasoningTokens: codexUsage.thread.reasoning,
          lastAt: codexUsage.thread.at || null
        }
      : { status: "unavailable", message: "未找到会话数据", source: "codex-log" };

    if (webBillStatus?.status === "error" && webBillStatus.message) {
      warnings.push(`网页账单网络异常：${webBillStatus.message}`);
    }
    if (balance.status !== "ok" && balance.message) warnings.push(balance.message);
    else if (balance.stale) warnings.push("官网余额超过 15 分钟未更新；请保持 Edge 与扩展运行。");
    const { rejected: _rejected, ...publicBalance } = balance;
    return {
      provider:
        providerName || providerId
          ? {
              id: providerId,
              name: providerName,
              websiteUrl,
              category: providerRow?.category || "",
              baseUrl,
              adapter: adapter?.id || null
            }
          : null,
      model: {
        id: model,
        displayName: (pricing.status === "ok" && pricing.displayName) || catalogDisplayName || model,
        requestModel: model,
        pricingModel: pricing.modelId || null
      },
      currency: publicBalance.currency || today.currency || "USD",
      balance: publicBalance,
      today,
      session,
      pricing,
      source: {
        database: dbPath,
        databaseMode,
        codexHome,
        providerIdentity: codexProvider ? "codex-config" : providerRow ? "cc-switch" : "none",
        adapter: adapter?.id || null,
        webUsage: webUsage.source || null,
        tokens: today.tokenScope === "codex" ? "codex-log" : "web-extension"
      },
      webBillStatus,
      receiverError,
      updatedAt: now.toISOString(),
      warnings: [...new Set(warnings.map((item) => redactSecrets(String(item))))].filter(Boolean)
    };  } finally {
    // The CC Switch database handle must be released explicitly. Relying on GC
    // kept a read handle open on cc-switch.db across refresh cycles on Windows.
    try {
      db?.close();
    } catch {}
  }
}

async function probeForeignReceiver(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.service === "usage-hub-web-bill";
  } catch {
    return false;
  }
}
function snapshotPayloadKey(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return JSON.stringify(snapshot);
  const { updatedAt: _updatedAt, ...rest } = snapshot;
  return JSON.stringify(rest);
}

/**
 * The overlay re-reads snapshot.json on a timer and repaints whenever the file
 * changes, so rewriting it unconditionally every tick forced a UI refresh on a
 * fixed cadence even when no number had moved. updatedAt is excluded from the
 * comparison on purpose: it is a write timestamp the overlay never displays,
 * and treating it as a change would defeat the whole check.
 */
async function writeSnapshotIfChanged(dataDir, snapshot, options = {}) {
  const target = path.join(dataDir, "snapshot.json");
  if (!options.force) {
    const previous = await readJsonSafe(target, null);
    if (previous && snapshotPayloadKey(previous) === snapshotPayloadKey(snapshot)) {
      return { written: false, path: target };
    }
  }
  await writeJsonAtomic(target, snapshot);
  return { written: true, path: target };
}

async function runDaemon(options = {}) {
  const dataDir = options.dataDir || DEFAULT_DATA_DIR;
  const config = await loadConfig(dataDir);
  const intervalSeconds = Number(options.intervalSeconds || config.refreshSeconds || 60);
  const exitOnStop = options.exitOnStop !== false;
  const logPath = path.join(dataDir, "plugin.log");
  const receiverErrorPath = path.join(dataDir, "receiver-error.json");
  const webBillPort = Number(options.webBillPort || process.env.USAGE_HUB_WEB_BILL_PORT || 32146);
  let stopped = false;
  let webBillServer = null;
  let receiverError = null;
  let foreignReceiver = false;
  let stopping = null;

  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      stopped = true;
      clearInterval(timer);
      if (webBillServer) {
        try {
          await webBillServer.stop();
        } catch {}
      }
      if (exitOnStop) {
        const exitTimer = setTimeout(() => process.exit(0), 100);
        exitTimer.unref?.();
      }
    })();
    return stopping;
  }

  if (!options.disableWebBillServer) {
    try {
      await fsp.rm(receiverErrorPath, { force: true });
      webBillServer = await startWebBillServer({
        dataDir,
        port: webBillPort,
        onError: (error) => {
          void appendLogCapped(logPath, `${new Date().toISOString()} [web-bill-server] ${shortStack(error, 2)}\n`).catch(() => {});
        },
        onShutdown: () => {
          stop().catch(() => {});
        }
      });
    } catch (error) {
      // Never fail silently: an unusable receiver used to leave webBillServer
      // null while /health kept answering from an orphan process.
      webBillServer = null;
      if (error?.code === "EADDRINUSE" && (await probeForeignReceiver(webBillPort))) {
        foreignReceiver = true;
        await writeJsonAtomic(receiverErrorPath, {
          code: "EADDRINUSE",
          foreign: true,
          message: `port ${webBillPort} is already served by another Usage Hub instance`,
          at: new Date().toISOString()
        }).catch(() => {});
        await appendLogCapped(
          logPath,
          `${new Date().toISOString()} [web-bill-server] port ${webBillPort} already served by another Usage Hub instance\n`
        ).catch(() => {});
      } else {
        receiverError = {
          code: error?.code || "unknown",
          message: redactSecrets(error?.message || String(error)),
          at: new Date().toISOString()
        };
        await writeJsonAtomic(receiverErrorPath, receiverError).catch(() => {});
        await appendLogCapped(logPath, `${new Date().toISOString()} [web-bill-server] start failed: ${shortStack(error, 2)}\n`).catch(() => {});
      }
    }
  }

  async function tick() {
    try {
      const snapshot = await buildSnapshot({ ...options, dataDir });
      await writeSnapshotIfChanged(dataDir, snapshot);
      return snapshot;
    } catch (error) {
      const message = redactSecrets(error?.message || "用法数据读取失败");
      const snapshot = {
        provider: null,
        model: null,
        balance: { status: "error", message },
        today: { cost: 0, currency: "USD", source: "error", tokenSource: "cc-switch" },
        session: { status: "error", message },
        pricing: { status: "unavailable", currency: "USD" },
        source: { database: options.ccSwitchDb || null, databaseMode: "unavailable" },
        webBillStatus: null,
        receiverError,
        updatedAt: new Date().toISOString(),
        warnings: [message]
      };
      await writeSnapshotIfChanged(dataDir, snapshot).catch(() => {});
      await appendLogCapped(logPath, `${new Date().toISOString()} [helper] ${shortStack(error, 3)}\n`).catch(() => {});
      return snapshot;
    }
  }

  await tick();
  const timer = setInterval(() => {
    if (!stopped) tick().catch(() => {});
  }, Math.max(15, intervalSeconds) * 1000);
  timer.unref?.();

  return {
    get webBillServer() {
      return webBillServer;
    },
    get receiverError() {
      return receiverError;
    },
    get foreignReceiver() {
      return foreignReceiver;
    },
    stop,
    tick
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dataDir = args["data-dir"] || DEFAULT_DATA_DIR;
  await fsp.mkdir(dataDir, { recursive: true });
  if (args.daemon) {
    await runDaemon({
      dataDir,
      intervalSeconds: Number(args.interval || 0),
      threadId: args["thread-id"] || "",
      ccSwitchDb: args["cc-switch-db"],
      codexHome: args["codex-home"],
      webBillPort: Number(args["web-bill-port"] || process.env.USAGE_HUB_WEB_BILL_PORT || 32146)
    });
    return;
  }
  const snapshot = await buildSnapshot({
    dataDir,
    threadId: args["thread-id"] || "",
    ccSwitchDb: args["cc-switch-db"],
    codexHome: args["codex-home"]
  });
  if (args.write) {
    await writeJsonAtomic(path.join(dataDir, "snapshot.json"), snapshot);
    return;
  }
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

export {
  DEFAULT_DATA_DIR,
  VERSION,
  assertSafeBalanceUrl,
  buildSnapshot,
  collectByPath,
  expandTemplate,
  extractBrowserToken,
  extractScopedToken,
  fetchBalance,
  buildApiKeyCandidates,
  fetchJson,
  fetchWebUsage,
  getAdapterPricing,
  getPricing,
  pickPricing,
  pickBalance,
  readWebBalance,
  getTodayRange,
  levelDbKeyNeedles,
  loadAdapters,
  readCodexModelDisplayName,
  readCodexProvider,
  matchAdapter,
  matchList,
  openDatabase,
  providerHosts,
  registrableDomain,
  parseArgs,
  parseProviderSettings,
  queryAggregate,
  readJsonIfExists,
  redactSecrets,
  resolveUrlFromUsageScript,
  runDaemon,
  sanitizeWebBillStatus,
  shortStack,
  snapshotPayloadKey,
  writeJsonAtomic,
  writeSnapshotIfChanged
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${redactSecrets(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}