// End-to-end MCP protocol smoke test.
//
// Why this exists: the review-time harness (handover doc, section 6) proved the
// JSON-RPC layer by running a private copy of the plugin with
// scripts/start-overlay.ps1 removed, so ensureOverlay() throws instead of
// popping a real overlay window on the user's desktop. This test freezes that
// harness into the repository so the protocol contract cannot silently regress.
//
// Scope: protocol layer only - initialize / tools/list / tools/call / ping /
// notifications / clean exit on stdin close. It does NOT cover the overlay UI.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"));
const PLUGIN_VERSION = MANIFEST.version.split("+")[0];

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else fs.copyFileSync(from, to);
  }
}

function startHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-hub-mcp-"));
  const copy = path.join(root, "usage-hub");
  copyTree(PLUGIN_ROOT, copy);
  // Removing the launcher keeps ensureOverlay() from ever starting a real
  // overlay process; the failure is caught and logged, which is by design.
  fs.rmSync(path.join(copy, "scripts", "start-overlay.ps1"), { force: true });
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const child = spawn(process.execPath, [path.join(copy, "mcp", "server.mjs")], {
    cwd: copy,
    env: {
      ...process.env,
      USAGE_HUB_DATA_DIR: dataDir,
      // Keep timers from firing during the test.
      USAGE_HUB_OVERLAY_WATCHDOG_MS: "600000",
      USAGE_HUB_OWNER_HEARTBEAT_MS: "600000",
      // Private port so a real receiver on 32146 can never be probed.
      USAGE_HUB_WEB_BILL_PORT: "32199",
      // node:sqlite emits an ExperimentalWarning on Node 22. The protocol test
      // asserts clean stderr, so suppress runtime warnings in this child.
      NODE_NO_WARNINGS: "1"
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });

  const frames = [];
  const pending = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      frames.push(frame);
      if (frame.id !== undefined && pending.has(frame.id)) {
        pending.get(frame.id)(frame);
        pending.delete(frame.id);
      }
    }
  });
  const stderrChunks = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  let nextId = 1;
  function send(payload) {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }
  function request(method, params, timeoutMs = 20000) {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, (frame) => { clearTimeout(timer); resolve(frame); });
    });
    send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  });

  return { child, send, request, frames, stderr: () => stderrChunks.join(""), exited, dataDir };
}

test("mcp server: initialize, tools, ping, errors, notifications and clean exit", async (t) => {
  const harness = startHarness(t);
  const { request, send, frames, exited } = harness;

  const init = await request("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(init.jsonrpc, "2.0");
  assert.equal(init.result.serverInfo.name, "usage-hub");
  assert.equal(init.result.serverInfo.version, PLUGIN_VERSION);
  assert.deepEqual(init.result.capabilities, { tools: {} });

  // A notification must never produce a frame (responding to it would emit an
  // invalid JSON-RPC frame without an id).
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const list = await request("tools/list");
  assert.deepEqual(
    list.result.tools.map((tool) => tool.name).sort(),
    ["usage_overlay_control", "usage_runtime_status", "usage_snapshot"]
  );

  const ping = await request("ping");
  assert.deepEqual(ping.result, {});

  const status = await request("tools/call", { name: "usage_runtime_status", arguments: {} });
  const runtime = status.result.structuredContent;
  assert.equal(runtime.pluginVersion, PLUGIN_VERSION);
  // B3 regression: startup registration must be awaited, so the heartbeat is a
  // real timestamp instead of null for an early caller.
  assert.ok(runtime.ownerHeartbeatAt, "ownerHeartbeatAt must not be null");
  assert.ok(!Number.isNaN(Date.parse(runtime.ownerHeartbeatAt)), "ownerHeartbeatAt must be a timestamp");
  assert.equal(runtime.dataDir, harness.dataDir);
  assert.equal(runtime.ok, false, "no overlay is running inside the harness");

  // usage_snapshot must answer even when the overlay cannot be started (this
  // harness removed the launcher): the lazy on-demand overlay start is
  // fire-and-forget and must never delay or fail the data answer.
  const snapshot = await request("tools/call", { name: "usage_snapshot", arguments: {} });
  assert.ok(snapshot.result.structuredContent, "usage_snapshot must return structured content");
  assert.ok(snapshot.result.structuredContent.today, "usage_snapshot must report today's usage");

  const unknownTool = await request("tools/call", { name: "nope", arguments: {} });
  assert.equal(unknownTool.error.code, -32000);
  assert.match(unknownTool.error.message, /Unknown tool: nope/);

  const badAction = await request("tools/call", { name: "usage_overlay_control", arguments: { action: "explode" } });
  assert.equal(badAction.error.code, -32000);
  assert.match(badAction.error.message, /action must be show, hide, or restart/);

  const unsupported = await request("definitely/not/a/method");
  assert.equal(unsupported.error.code, -32601);

  // Give any stray notification response a moment to arrive before asserting.
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    frames.filter((frame) => frame.id === undefined || frame.id === null).length,
    0,
    "notifications must not be answered"
  );
  assert.equal(harness.stderr(), "");

  harness.child.stdin.end();
  const exit = await exited;
  assert.equal(exit.code, 0, `expected clean exit, got ${JSON.stringify(exit)}`);
});