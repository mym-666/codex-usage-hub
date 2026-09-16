import readline from "node:readline";
import fsp from "node:fs/promises";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_DATA_DIR, VERSION, buildSnapshot } from "../runtime/usage-helper.mjs";
import { appendLogCapped, readJsonSafe, redactSecrets, shortStack, writeJsonAtomic } from "../runtime/fs-atomic.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const START_OVERLAY_PATH = path.join(PLUGIN_ROOT, "scripts", "start-overlay.ps1");
const HELPER_PATH = path.join(PLUGIN_ROOT, "runtime", "usage-helper.mjs");
const EXTENSION_PATH = path.join(PLUGIN_ROOT, "edge-extension");
const DATA_DIR = process.env.USAGE_HUB_DATA_DIR || DEFAULT_DATA_DIR;
const WEB_BILL_PORT = Number(process.env.USAGE_HUB_WEB_BILL_PORT || 32146);
const OVERLAY_PID_PATH = path.join(DATA_DIR, "overlay.pid");
const OVERLAY_CONTROL_PATH = path.join(DATA_DIR, "overlay-control.json");
const OVERLAY_STOP_PATH = path.join(DATA_DIR, "overlay-stopped.json");
const HELPER_PID_PATH = path.join(DATA_DIR, "helper.pid");
const RECEIVER_ERROR_PATH = path.join(DATA_DIR, "receiver-error.json");
const OWNER_DIR = path.join(DATA_DIR, "mcp-owners");
const OWNER_FILE = path.join(OWNER_DIR, `${process.pid}.json`);
const LOG_PATH = path.join(DATA_DIR, "plugin.log");
// Every open thread runs its own MCP server, and each of those used to re-read
// overlay.pid every 5s. The overlay already announces itself through its own
// heartbeat, so a slower watchdog costs nothing and keeps idle threads quiet.
const OVERLAY_WATCHDOG_MS = Number(process.env.USAGE_HUB_OVERLAY_WATCHDOG_MS || 15000);
const OWNER_HEARTBEAT_MS = Number(process.env.USAGE_HUB_OWNER_HEARTBEAT_MS || 60000);
// Starting the overlay (PowerShell + WinForms + helper daemon) is the most
// expensive thing this plugin does, and doing it while Codex is still bringing
// up a thread is what users feel as "Codex is slow after a restart". The
// automatic start is therefore staggered and can be switched off entirely.
const OVERLAY_START_DELAY_MS = Number(process.env.USAGE_HUB_OVERLAY_START_DELAY_MS);
const DEFAULT_OVERLAY_START_DELAY_SECONDS = 3;
const DEFAULT_OVERLAY_IDLE_EXIT_SECONDS = 300;

let stopped = false;
let ensureOverlayPromise = null;
let ownerRegistered = false;
let ownerStartedAt = null;
let ownerRegistration = null;
let ownerHeartbeatAt = null;
let ownerHeartbeatTimer = null;
let overlayWatchdogTimer = null;
let overlayWatchdogBusy = false;
let cachedOverlayPid = null;

// A JSON-RPC notification has no id and must not be answered; emitting a response
// without "id" would produce an invalid frame.
function respond(id, result) {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, code, message) {
  if (id === undefined) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeLog(line, context) {
  try {
    await appendLogCapped(LOG_PATH, `${new Date().toISOString()} [${context}] ${line}\n`);
  } catch {}
}

async function logError(error, context = "runtime") {
  await writeLog(shortStack(error, 3), context);
}

async function logMessage(message, context = "mcp") {
  await writeLog(redactSecrets(String(message)), context);
}

/**
 * Always rewrite the owner record. The previous version early-returned once
 * ownerRegistered was true, so if the overlay ever removed the file (for example
 * after a transient read failure) the MCP server could never re-announce itself
 * and the overlay closed itself permanently.
 */
async function registerOwner() {
  if (!ownerStartedAt) ownerStartedAt = new Date().toISOString();
  const payload = {
    pid: process.pid,
    parentPid: process.ppid,
    startedAt: ownerStartedAt,
    writtenAt: new Date().toISOString()
  };
  await fsp.mkdir(OWNER_DIR, { recursive: true });
  await writeJsonAtomic(OWNER_FILE, payload);
  ownerRegistered = true;
  ownerHeartbeatAt = payload.writtenAt;
}

function startOwnerHeartbeat() {
  if (ownerHeartbeatTimer) return;
  ownerHeartbeatTimer = setInterval(() => {
    if (stopped) return;
    registerOwner().catch((error) => logError(error, "owner-heartbeat"));
  }, Math.max(5000, OWNER_HEARTBEAT_MS));
  ownerHeartbeatTimer.unref?.();
}

function stopOwnerHeartbeat() {
  if (ownerHeartbeatTimer) {
    clearInterval(ownerHeartbeatTimer);
    ownerHeartbeatTimer = null;
  }
}

function unregisterOwner() {
  stopOwnerHeartbeat();
  if (!ownerRegistered && !existsSync(OWNER_FILE)) return;
  try {
    rmSync(OWNER_FILE, { force: true });
  } catch {}
  ownerRegistered = false;
}

const readJson = readJsonSafe;

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Overlay lifecycle is configurable from <dataDir>/config.json so the plugin
 * can be tuned without editing the manifest:
 *   overlayAutoStart (bool)        keep the overlay off until a tool asks for it
 *   overlayStartDelaySeconds (num) stagger the automatic start away from Codex's own start-up
 *   overlayIdleExitSeconds (num)   how long a hidden overlay stays warm, so reopening
 *                                  Codex reuses it instead of cold-starting PowerShell again
 */
async function overlayBehavior() {
  const config = (await readJson(path.join(DATA_DIR, "config.json"), {})) || {};
  const startDelayMs = Number.isFinite(OVERLAY_START_DELAY_MS)
    ? clampNumber(OVERLAY_START_DELAY_MS, DEFAULT_OVERLAY_START_DELAY_SECONDS * 1000, 0, 120000)
    : clampNumber(config.overlayStartDelaySeconds, DEFAULT_OVERLAY_START_DELAY_SECONDS, 0, 120) * 1000;
  return {
    autoStart: config.overlayAutoStart !== false,
    startDelayMs,
    idleExitSeconds: clampNumber(config.overlayIdleExitSeconds, DEFAULT_OVERLAY_IDLE_EXIT_SECONDS, 15, 3600)
  };
}

async function readPid(filePath) {
  const value = await readJson(filePath, null);
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (value && Number.isInteger(Number(value.pid))) return Number(value.pid);
  try {
    const raw = Number((await fsp.readFile(filePath, "utf8")).trim());
    return Number.isInteger(raw) ? raw : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function writeControl(action) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await writeJsonAtomic(OVERLAY_CONTROL_PATH, { action, requestedAt: new Date().toISOString() });
}

async function getOverlayState() {
  // Cheap path first: while the PID we already know about is alive there is
  // nothing to re-read from disk. The watchdog, the status tool and the overlay
  // control path all used to hit overlay.pid unconditionally.
  if (cachedOverlayPid && isProcessRunning(cachedOverlayPid)) {
    return { running: true, pid: cachedOverlayPid, stoppedByUser: existsSync(OVERLAY_STOP_PATH) };
  }
  const pid = await readPid(OVERLAY_PID_PATH);
  const running = isProcessRunning(pid);
  cachedOverlayPid = running ? pid : null;
  if (!running && pid) {
    await fsp.rm(OVERLAY_PID_PATH, { force: true }).catch(() => {});
  }
  return { running, pid: running ? pid : null, stoppedByUser: existsSync(OVERLAY_STOP_PATH) };
}

async function waitForOverlayState(timeoutMs = 4000) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / 200));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await getOverlayState();
    if (state.running) return state;
    await delay(200);
  }
  return getOverlayState();
}

async function getHelperState() {
  const pid = await readPid(HELPER_PID_PATH);
  const running = isProcessRunning(pid);
  if (!running && pid) {
    await fsp.rm(HELPER_PID_PATH, { force: true }).catch(() => {});
  }
  return { running, pid: running ? pid : null };
}

async function webBillHealth() {
  try {
    const response = await fetch(`http://127.0.0.1:${WEB_BILL_PORT}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) return { running: false, error: `HTTP ${response.status}` };
    return { running: true, ...(await response.json()) };
  } catch (error) {
    return { running: false, error: redactSecrets(error?.message || "web bill server unavailable") };
  }
}

function getPowerShellPath() {
  const candidate = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  return existsSync(candidate) ? candidate : "powershell.exe";
}

async function ensureOverlay(options = {}) {
  if (stopped) return { running: false, error: "MCP server is stopping" };
  await registerOwner();
  if (options.clearStop !== false) {
    await fsp.rm(OVERLAY_STOP_PATH, { force: true }).catch(() => {});
  }
  const current = await getOverlayState();
  if (current.running && !options.force) return current;
  if (ensureOverlayPromise) return ensureOverlayPromise;

  const reason = options.reason || "startup";
  const behavior = await overlayBehavior();
  if (!behavior.autoStart && reason === "startup") {
    // Explicitly disabled: leave the desktop alone until a tool asks for the
    // overlay. The owner record is already written, so a later show() is fast.
    return { running: false, pid: null, skipped: "overlayAutoStart is disabled" };
  }

  ensureOverlayPromise = (async () => {
    if (reason === "startup" && behavior.startDelayMs > 0) {
      // Stagger the automatic start off Codex's own start-up burst. A watchdog
      // recovery or an explicit tool call never waits.
      await delay(behavior.startDelayMs);
      const settled = await getOverlayState();
      if (settled.running && !options.force) return settled;
    }
    await fsp.mkdir(DATA_DIR, { recursive: true });
    if (!existsSync(START_OVERLAY_PATH)) {
      throw new Error(`Overlay launcher is missing: ${START_OVERLAY_PATH}`);
    }
    if (options.force && current.running) {
      await writeControl("restart");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await delay(250);
        if (!(await getOverlayState()).running) break;
      }
      if ((await getOverlayState()).running) throw new Error("Overlay did not restart gracefully");
      await delay(500);
    }

    const args = [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-WindowStyle", "Hidden",
      "-File", START_OVERLAY_PATH,
      "-DataDir", DATA_DIR,
      "-HelperPath", HELPER_PATH,
      "-NodePath", process.execPath,
      "-WebBillPort", String(WEB_BILL_PORT),
      "-OwnerDir", OWNER_DIR,
      "-StopPath", OVERLAY_STOP_PATH,
      "-IdleExitSeconds", String(behavior.idleExitSeconds)
    ];
    const child = spawn(getPowerShellPath(), args, {
      cwd: PLUGIN_ROOT,
      detached: false,
      windowsHide: true,
      stdio: "ignore"
    });
    child.unref();
    const state = await waitForOverlayState(Number(options.timeoutMs || 7000));
    if (!state.running) {
      throw new Error(state.stoppedByUser ? "Overlay start was cancelled by user" : "Overlay did not start");
    }
    await logMessage(`overlay started (pid ${state.pid})`, "lifecycle");
    return state;
  })();

  try {
    return await ensureOverlayPromise;
  } finally {
    ensureOverlayPromise = null;
  }
}

async function controlOverlay(action) {
  const normalized = String(action || "").toLowerCase();
  if (normalized === "show") {
    await fsp.rm(OVERLAY_STOP_PATH, { force: true }).catch(() => {});
    const state = await getOverlayState();
    if (state.running) {
      await writeControl("show");
      await delay(800);
      if (!(await getOverlayState()).running) await ensureOverlay({ reason: "user" });
    } else {
      await ensureOverlay({ reason: "user" });
    }
  } else if (normalized === "hide") {
    if ((await getOverlayState()).running) await writeControl("hide");
  } else if (normalized === "restart") {
    await ensureOverlay({ force: true, reason: "user" });
  } else {
    throw new Error("action must be show, hide, or restart");
  }
  await waitForOverlayState(3000);
  return getRuntimeStatus();
}

function stopOverlayWatchdog() {
  if (overlayWatchdogTimer) {
    clearInterval(overlayWatchdogTimer);
    overlayWatchdogTimer = null;
  }
}

function startOverlayWatchdog() {
  if (overlayWatchdogTimer || stopped) return;
  overlayWatchdogTimer = setInterval(async () => {
    if (stopped || overlayWatchdogBusy) return;
    overlayWatchdogBusy = true;
    try {
      const state = await getOverlayState();
      if (state.running || state.stoppedByUser) return;
      // overlayAutoStart=false means "do not run the overlay unless a tool asks
      // for it", so the watchdog must not resurrect it behind the user's back.
      if (!(await overlayBehavior()).autoStart) return;
      await logMessage("overlay is missing; restarting it", "watchdog");
      await ensureOverlay({ clearStop: false, reason: "watchdog" });
    } catch (error) {
      await logError(error, "overlay-watchdog");
    } finally {
      overlayWatchdogBusy = false;
    }
  }, Math.max(1000, OVERLAY_WATCHDOG_MS));
  overlayWatchdogTimer.unref();
}

function shutdown(reason) {
  if (stopped) return;
  stopped = true;
  stopOverlayWatchdog();
  unregisterOwner();
  void logMessage(`MCP server stopping (${reason})`, "lifecycle");
}

async function configSummary() {
  const config = await readJson(path.join(DATA_DIR, "config.json"), {});
  return {
    refreshSeconds: Number(config.refreshSeconds || 60),
    webUsage: config.webUsage !== false,
    allowBalanceDelta: config.allowBalanceDelta !== false,
    browserOrder: Array.isArray(config.browserOrder) ? config.browserOrder : ["edge", "chrome"],
    providerOverrideCount: config.providers && typeof config.providers === "object" ? Object.keys(config.providers).length : 0,
    providerDirectoryCount: Array.isArray(config.providersDirs) ? config.providersDirs.length : 0
  };
}

/**
   * The in-memory value is null until registerOwner() completes, which can be
   * after an early usage_runtime_status call has already been answered. Fall back
   * to the record on disk, because that is what the overlay actually reads.
   */
async function getOwnerHeartbeat() {
  // Deterministic: wait for the startup registration so this field is never
  // spuriously null for a client that queries right after initialize.
  if (ownerRegistration) {
    try {
      await ownerRegistration;
    } catch {}
  }
  if (ownerHeartbeatAt) return ownerHeartbeatAt;
  const record = await readJson(OWNER_FILE, null);
  return record?.writtenAt || null;
}

async function getRuntimeStatus() {
  const [overlay, helper, webBill, config, receiverError, heartbeat] = await Promise.all([
    getOverlayState(),
    getHelperState(),
    webBillHealth(),
    configSummary(),
    readJson(RECEIVER_ERROR_PATH, null),
    getOwnerHeartbeat()
  ]);
  return {
    ok: overlay.running,
    pluginVersion: VERSION,
    pluginRoot: PLUGIN_ROOT,
    dataDir: DATA_DIR,
    logPath: LOG_PATH,
    extensionPath: EXTENSION_PATH,
    extensionPathExists: existsSync(EXTENSION_PATH),
    webBillPort: WEB_BILL_PORT,
    overlay,
    helper,
    webBillServer: { ...webBill, foreign: Boolean(receiverError?.foreign) },
    receiverError: receiverError
      ? { code: receiverError.code, message: receiverError.message, at: receiverError.at, foreign: Boolean(receiverError.foreign) }
      : null,
    ownerHeartbeatAt: heartbeat,
    config
  };
}

async function usageSnapshot(args = {}) {
  const snapshot = await buildSnapshot({ dataDir: DATA_DIR, threadId: args.threadId || "" });
  await writeJsonAtomic(path.join(DATA_DIR, "snapshot.json"), snapshot);
  return snapshot;
}

function toolDefinitions() {
  return [
    {
      name: "usage_snapshot",
      description: "Return provider balance, today's usage, current Codex session usage, token breakdown, and model pricing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          threadId: {
            type: "string",
            description: "Optional current Codex thread id for exact session usage."
          }
        }
      }
    },
    {
      name: "usage_runtime_status",
      description: "Return Usage Hub overlay, helper, web-bill server, extension path, data directory, and configuration status.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} }
    },
    {
      name: "usage_overlay_control",
      description: "Show, hide, or restart the managed Usage Hub overlay.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: { action: { type: "string", enum: ["show", "hide", "restart"] } }
      }
    }
  ];
}

async function callTool(name, args) {
  if (name === "usage_snapshot") {
    // Asking for usage data IS asking for the plugin, so this is the hook that
    // makes an on-demand overlay (overlayAutoStart=false) appear when the user
    // invokes the plugin - including the manifest default prompt. Started in the
    // background: the snapshot answer must not wait for a PowerShell start-up.
    void ensureOverlay({ reason: "user" }).catch((error) => logError(error, "ensure-overlay"));
    return usageSnapshot(args);
  }
  if (name === "usage_runtime_status") return getRuntimeStatus();
  if (name === "usage_overlay_control") return controlOverlay(args?.action);
  throw new Error(`Unknown tool: ${name}`);
}

async function handleMessage(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "usage-hub", version: VERSION }
    });
    void ensureOverlay().catch((error) => logError(error, "ensure-overlay"));
    return;
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "ping") {
    respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, { tools: toolDefinitions() });
    return;
  }
  if (method === "tools/call") {
    const name = params?.name;
    try {
      const result = await callTool(name, params?.arguments || {});
      respond(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result
      });
    } catch (error) {
      respondError(id, -32000, redactSecrets(error?.message || `${name} failed`));
    }
    return;
  }
  if (method === "shutdown") {
    respond(id, {});
    shutdown("shutdown request");
    setTimeout(() => process.exit(0), 10);
    return;
  }
  if (id !== undefined) respondError(id, -32601, `Unsupported method: ${method}`);
}

// Register ownership before any request can be served, so the overlay sees a
// live owner from the very first follow tick.
ownerRegistration = registerOwner().catch((error) => logError(error, "startup-owner"));

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  try {
    handleMessage(JSON.parse(line)).catch((error) => logError(error, "message"));
  } catch (error) {
    logError(error, "parse").catch(() => {});
  }
});
rl.on("close", () => {
  shutdown("stdin closed");
  setImmediate(() => process.exit(0));
});

process.on("SIGINT", () => {
  shutdown("SIGINT");
  process.exit(0);
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
  process.exit(0);
});
process.on("exit", () => {
  stopped = true;
  unregisterOwner();
});
process.on("unhandledRejection", (error) => {
  void logError(error, "unhandled-rejection");
});

setImmediate(() => {
  startOwnerHeartbeat();
  ensureOverlay().catch((error) => logError(error, "startup"));
  startOverlayWatchdog();
});