// Regression tests for the idle-cost work in 2.3.0.
//
// Why these exist: the daemon used to rewrite snapshot.json on every tick and the
// overlay repainted whenever the file changed, so a completely idle plugin still
// produced a disk write and a UI repaint on a fixed cadence. The gate has to keep
// ignoring updatedAt (a write stamp the overlay never shows) without ever hiding a
// real value change.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  snapshotPayloadKey,
  writeSnapshotIfChanged
} from "../runtime/usage-helper.mjs";

function tempDataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-hub-snapshot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseSnapshot(overrides = {}) {
  return {
    provider: { name: "DeepSeek" },
    today: { cost: 1.23, currency: "USD", tokens: { total: 100 } },
    session: { status: "ok", cost: 0.45 },
    updatedAt: "2026-09-13T12:00:00.000Z",
    ...overrides
  };
}

test("snapshot payload key ignores updatedAt but keeps every other field", () => {
  const first = baseSnapshot();
  const later = baseSnapshot({ updatedAt: "2026-09-13T12:05:00.000Z" });
  const changed = baseSnapshot({ today: { cost: 1.24, currency: "USD", tokens: { total: 100 } } });

  assert.equal(snapshotPayloadKey(first), snapshotPayloadKey(later));
  assert.notEqual(snapshotPayloadKey(first), snapshotPayloadKey(changed));
});

test("writeSnapshotIfChanged writes once and then skips unchanged snapshots", async (t) => {
  const dataDir = tempDataDir(t);
  const target = path.join(dataDir, "snapshot.json");

  const first = await writeSnapshotIfChanged(dataDir, baseSnapshot());
  assert.equal(first.written, true);
  const firstRaw = fs.readFileSync(target, "utf8");

  const heartbeatOnly = await writeSnapshotIfChanged(
    dataDir,
    baseSnapshot({ updatedAt: "2026-09-13T12:01:00.000Z" })
  );
  assert.equal(heartbeatOnly.written, false, "an updatedAt-only change must not touch the file");
  assert.equal(fs.readFileSync(target, "utf8"), firstRaw, "the file must stay byte-identical");

  const realChange = await writeSnapshotIfChanged(dataDir, baseSnapshot({ today: { cost: 9.99 } }));
  assert.equal(realChange.written, true, "a real value change must be written");
  assert.notEqual(fs.readFileSync(target, "utf8"), firstRaw);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).today.cost, 9.99);
});

test("writeSnapshotIfChanged can be forced and writes when no snapshot exists yet", async (t) => {
  const dataDir = tempDataDir(t);
  const target = path.join(dataDir, "snapshot.json");

  const missing = await writeSnapshotIfChanged(dataDir, baseSnapshot({ today: { cost: 2.5 } }));
  assert.equal(missing.written, true);
  assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).today.cost, 2.5);

  const forced = await writeSnapshotIfChanged(dataDir, baseSnapshot({ today: { cost: 2.5 } }), {
    force: true
  });
  assert.equal(forced.written, true, "force bypasses the change check");
});
