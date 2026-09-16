import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_LOG_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_LOG_KEEP_BYTES = 512 * 1024;

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{8,}/g,
  /Bearer\s+[A-Za-z0-9._\-]{16,}/gi,
  /eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g
];

/**
 * Replace credential-looking substrings with a fixed marker.
 * Used before anything is written to plugin.log or surfaced in snapshot warnings.
 */
export function redactSecrets(text) {
  let out = String(text ?? "");
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, "[REDACTED]");
  return out;
}

/**
 * Compact, redacted single-line-ish representation of an error:
 * message plus at most `frames` stack frames.
 */
export function shortStack(error, frames = 3) {
  const message = redactSecrets(error?.message || String(error ?? "unknown error"));
  const stack = String(error?.stack || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, Math.max(0, frames))
    .map((line) => `    ${redactSecrets(line)}`);
  return stack.length ? `${message}\n${stack.join("\n")}` : message;
}

/**
 * Atomically write JSON (or raw text when options.raw is set).
 *
 * The temporary file name carries a random suffix so concurrent writers inside
 * the same process can never share a temp path. The previous implementation used
 * only the pid, which made the second concurrent rename fail with ENOENT and, in
 * the fallback branch, delete the live target file.
 */
export async function writeJsonAtomic(filePath, value, options = {}) {
  const text = options.raw
    ? String(value)
    : `${JSON.stringify(value, null, options.indent === undefined ? 2 : options.indent)}\n`;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fsp.writeFile(tempPath, text, options.mode === undefined ? "utf8" : { encoding: "utf8", mode: options.mode });
    // Windows: renaming onto a target that another writer, reader or scanner is
    // touching fails transiently with EPERM/EBUSY/ENOENT. Retry with backoff
    // before resorting to remove-then-rename, which widens the missing window.
    let renamed = false; // set once fs.rename succeeds
    for (let attempt = 0; attempt < 8 && !renamed; attempt += 1) {
      try {
        await fsp.rename(tempPath, filePath);
        renamed = true;
      } catch (error) {
        if (attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 + attempt * 15));
      }
    }
    if (options.mode !== undefined) {
      try {
        await fsp.chmod(filePath, options.mode);
      } catch {}
    }
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

/** Read and parse JSON, tolerating a UTF-8 BOM and any read/parse failure. */
export async function readJsonSafe(filePath, fallback = null) {
  try {
    const text = (await fsp.readFile(filePath, "utf8")).replace(/^\uFEFF/, "");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Copy own enumerable properties into a null-prototype object so attacker
 * controlled keys such as "__proto__" or "constructor" cannot alter prototypes.
 */
export function createNullDict(source) {
  const out = Object.create(null);
  if (source && typeof source === "object") {
    for (const key of Object.keys(source)) out[key] = source[key];
  }
  return out;
}

/** Append a log line, then trim the file back to its tail once it grows too large. */
export async function appendLogCapped(filePath, line, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const keepBytes = Math.min(options.keepBytes ?? DEFAULT_LOG_KEEP_BYTES, maxBytes);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, line, "utf8");
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size <= maxBytes) return;
    const handle = await fsp.open(filePath, "r");
    let tail;
    try {
      const buffer = Buffer.alloc(keepBytes);
      const { bytesRead } = await handle.read(buffer, 0, keepBytes, stat.size - keepBytes);
      tail = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
    const firstNewline = tail.indexOf("\n");
    const kept = firstNewline >= 0 ? tail.slice(firstNewline + 1) : tail;
    await writeJsonAtomic(filePath, `... log truncated, older entries dropped ...\n${kept}`, { raw: true });
  } catch {}
}