const USAGE_URL = "https://platform.deepseek.com/usage";
const CAPTURE_ALARM = "usage-hub-capture";
const TAB_QUERY = { url: "https://platform.deepseek.com/*" };
// Single source of truth for the local receiver. Content scripts no longer talk
// to 127.0.0.1 directly, which removes the page-origin CORS preflight, the
// mixed-content question and the Private Network Access risk entirely.
const RECEIVER_ORIGIN = "http://127.0.0.1:32146";
const HEALTH_TTL_MS = 30000;
const FETCH_TIMEOUT_MS = 8000;
const WATCHER_BASE_BACKOFF_MS = 3000;
const WATCHER_MAX_BACKOFF_MS = 60000;
const WATCHER_MAX_FAILURES = 10;

let watcherStarted = false;
let watcherFailures = 0;
let healthCache = { at: 0, alive: false };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(pathname, body) {
  const response = await fetch(RECEIVER_ORIGIN + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
    cache: "no-store",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) throw new Error(parsed?.error || "receiver HTTP " + response.status);
  return parsed;
}

async function receiverAlive(force = false) {
  const now = Date.now();
  if (!force && now - healthCache.at < HEALTH_TTL_MS) return healthCache.alive;
  let alive = false;
  try {
    const response = await fetch(RECEIVER_ORIGIN + "/health", {
      cache: "no-store",
      signal: AbortSignal.timeout(2000)
    });
    const body = response.ok ? await response.json() : null;
    alive = Boolean(response.ok && body && body.service === "usage-hub-web-bill");
  } catch {
    alive = false;
  }
  healthCache = { at: Date.now(), alive };
  return alive;
}

async function recordStatus(result) {
  try {
    await chrome.storage.local.set({ lastWebBillStatus: result });
  } catch {}
  try {
    await chrome.runtime.sendMessage({ type: "web-bill-status", result });
  } catch {
    // The popup is usually closed; ignore.
  }
  return result;
}

async function usageTabs() {
  try {
    return await chrome.tabs.query(TAB_QUERY);
  } catch {
    return [];
  }
}

async function ensureUsageTab() {
  const tabs = await usageTabs();
  if (tabs.length) return tabs[0];
  return chrome.tabs.create({ url: USAGE_URL, active: false, pinned: true });
}

async function refreshUsageTab() {
  const tab = await ensureUsageTab();
  if (!tab?.id) return;
  await chrome.tabs.reload(tab.id, { bypassCache: true });
}

async function watchRefreshRequests() {
  if (watcherStarted) return;
  watcherStarted = true;
  watcherFailures = 0;
  while (watcherFailures < WATCHER_MAX_FAILURES) {
    try {
      const response = await fetch(RECEIVER_ORIGIN + "/refresh-request?wait=25", {
        cache: "no-store",
        signal: AbortSignal.timeout(30000)
      });
      const result = await response.json();
      if (!response.ok) throw new Error("receiver HTTP " + response.status);
      watcherFailures = 0;
      healthCache = { at: Date.now(), alive: true };
      if (result?.requested) await refreshUsageTab();
    } catch {
      watcherFailures += 1;
      healthCache = { at: Date.now(), alive: false };
      // Exponential backoff instead of hammering the loopback port every 3s
      // forever while Codex is closed.
      await sleep(Math.min(WATCHER_MAX_BACKOFF_MS, WATCHER_BASE_BACKOFF_MS * 2 ** (watcherFailures - 1)));
    }
  }
  // Give up; the capture alarm restarts the watcher when the receiver returns.
  watcherStarted = false;
  watcherFailures = 0;
}

async function ensureAlarms() {
  await chrome.alarms.create(CAPTURE_ALARM, { periodInMinutes: 2 });
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureAlarms();
  if (await receiverAlive(true)) {
    await refreshUsageTab().catch(() => {});
    watchRefreshRequests();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureAlarms();
  if (await receiverAlive(true)) {
    await refreshUsageTab().catch(() => {});
    watchRefreshRequests();
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CAPTURE_ALARM) return;
  // Stop reloading the DeepSeek tab every two minutes once the plugin is gone.
  if (!(await receiverAlive(true))) return;
  if (!watcherStarted) watchRefreshRequests();
  await refreshUsageTab().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (type === "refresh-now") {
    refreshUsageTab()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message }));
    return true;
  }

  if (type === "push-web-bill") {
    (async () => {
      try {
        const payload = message.payload || {};
        await postJson("/web-bill", payload);
        const result = await recordStatus({
          ok: true,
          at: new Date().toISOString(),
          cost: payload.cost ?? null,
          tokens: payload.tokens || null,
          tokenSource: payload.tokenSource || null,
          currency: payload.currency || "CNY"
        });
        sendResponse({ ok: true, result });
      } catch (error) {
        const result = await recordStatus({ ok: false, at: new Date().toISOString(), error: error?.message || "receiver unavailable" });
        sendResponse({ ok: false, error: error?.message || "receiver unavailable", result });
      }
    })();
    return true;
  }

  if (type === "push-web-balance") {
    (async () => {
      try {
        const payload = message.payload || {};
        const result = await postJson("/web-balance", payload);
        sendResponse({ ok: true, result });
      } catch (error) {
        // The balance is optional: a failure must not touch lastWebBillStatus.
        sendResponse({ ok: false, error: error?.message || "receiver unavailable" });
      }
    })();
    return true;
  }
  if (type === "push-web-bill-status") {
    (async () => {
      const payload = message.payload || {};
      try {
        await postJson("/web-bill-status", payload);
      } catch {
        // The local receiver may be down; the popup state below is still useful.
      }
      const result = await recordStatus({
        ok: false,
        at: new Date().toISOString(),
        error: String(payload.message || "网络异常")
      });
      sendResponse({ ok: true, result });
    })();
    return true;
  }

  return false;
});

watchRefreshRequests();