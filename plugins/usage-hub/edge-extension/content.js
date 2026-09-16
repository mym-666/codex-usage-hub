(() => {
  "use strict";
  const MARKER = "__USAGE_HUB_WEB_BILL__";
  const VERSION = "1.7.1";
  const DOM_DEBOUNCE_MS = 3000;
  const DOM_PUSH_COOLDOWN_MS = 60000;
  const TOKEN_RANK = { api: 3, estimate: 2, "dom-scrape": 1 };
  // Message shape ("response" | "error") is carried in `type`; the semantic kind
  // ("usage" | "estimate") is carried in `kind`. Validating `type` against the
  // kind whitelist silently dropped every captured bill (regression fixed in
  // 1.6.1), so the two fields are checked separately below.
  const ALLOWED_RESPONSE_KINDS = new Set(["usage", "estimate", "balance"]);

  const P = globalThis.UsageHubParse;
  if (!P) {
    // parse.js must be listed before content.js in manifest.json.
    console.warn("[Usage Hub] parse.js missing; web bill capture disabled");
    return;
  }

  // State for the current local day. An "estimate" response is a single-request
  // projection and must never overwrite the authoritative daily cost.
  let daily = null;
  let lastTokenSignature = "";
  let lastTokenPushAt = 0;
  let domCaptureTimer = null;

  function send(type, payload) {
    return chrome.runtime.sendMessage({ type, payload });
  }

  function ensureDaily(biz, url) {
    const today = P.localDateKey();
    if (!daily || daily.date !== today) {
      daily = {
        date: today,
        currency: String(P.findCurrency(biz) || "CNY").toUpperCase(),
        cost: null,
        tokens: null,
        tokenSource: null,
        sourceUrl: String(url || location.href)
      };
      lastTokenSignature = "";
      lastTokenPushAt = 0;
    }
    return daily;
  }

  function tokensAreBetter(candidate, candidateSource) {
    if (!candidate) return false;
    if (!daily || !daily.tokens) return true;
    return (TOKEN_RANK[candidateSource] || 0) > (TOKEN_RANK[daily.tokenSource] || 0);
  }

  function applyTokens(biz) {
    const apiTokens = P.extractTokens(biz);
    if (apiTokens && tokensAreBetter(apiTokens, "api")) {
      daily.tokens = apiTokens;
      daily.tokenSource = "api";
      return;
    }
    const estimated = P.extractEstimatedTokens(biz);
    if (estimated && tokensAreBetter(estimated, "estimate")) {
      daily.tokens = estimated;
      daily.tokenSource = "estimate";
      return;
    }
    const dom = P.extractTokensFromVisiblePage();
    if (dom && tokensAreBetter(dom, "dom-scrape")) {
      daily.tokens = dom;
      daily.tokenSource = "dom-scrape";
    }
  }

  async function pushPayload(payload) {
    const response = await send("push-web-bill", payload);
    if (!response || response.ok !== true) {
      throw new Error(response && response.error ? String(response.error) : "receiver unavailable");
    }
    return response.result;
  }

  async function publishDaily(extra) {
    if (!daily) return null;
    if (daily.cost === null && !daily.tokens) {
      if (!extra || !extra.debug) return null;
    }
    const payload = {
      provider: "deepseek",
      date: daily.date,
      currency: daily.currency || "CNY",
      sourceUrl: daily.sourceUrl,
      extensionVersion: VERSION,
      ...(daily.cost !== null ? { cost: daily.cost } : {}),
      ...(daily.tokens ? { tokens: daily.tokens } : {}),
      ...(daily.tokenSource ? { tokenSource: daily.tokenSource } : {}),
      ...(extra || {})
    };
    const result = await pushPayload(payload);
    if (daily.tokens) {
      lastTokenSignature = JSON.stringify(daily.tokens);
      lastTokenPushAt = Date.now();
    }
    return result;
  }

  async function handleResponse(url, json, kind) {
    const bizCode = json?.data?.biz_code ?? json?.code;
    if (bizCode !== undefined && Number(bizCode) !== 0) {
      throw new Error(json?.data?.biz_msg || json?.msg || "business code " + bizCode);
    }
    const biz = json?.data?.biz_data ?? json?.data;
    if (!biz) throw new Error("usage response missing biz_data");
    ensureDaily(biz, url);

    if (kind === "usage") {
      const costs = P.collectCosts(biz);
      if (costs.length) daily.cost = costs.reduce((sum, value) => sum + value, 0);
      const currency = P.findCurrency(biz);
      if (currency) daily.currency = String(currency).toUpperCase();
      daily.sourceUrl = String(url || location.href);
      applyTokens(biz);
      const debug = daily.tokens
        ? null
        : { numericFields: P.collectDiagnosticNumbers(biz), keys: P.collectDiagnosticKeys(biz) };
      const result = await publishDaily(debug ? { debug } : null);
      scheduleDomCapture();
      return result;
    }

    // kind === "estimate": token detail only, never a daily cost.
    const estimated = P.extractEstimatedTokens(biz);
    if (estimated && tokensAreBetter(estimated, "estimate")) {
      daily.tokens = estimated;
      daily.tokenSource = "estimate";
    }
    if (daily.cost === null && !daily.tokens) return null;
    return publishDaily();
  }

  async function refreshFromVisiblePage() {
    if (typeof document === "undefined" || document.hidden) return null;
    if (!daily) {
      const dom = P.extractTokensFromVisiblePage();
      if (!dom) return null;
      ensureDaily({}, location.href);
      daily.tokens = dom;
      daily.tokenSource = "dom-scrape";
    } else {
      const dom = P.extractTokensFromVisiblePage();
      if (!dom) return null;
      if (!tokensAreBetter(dom, "dom-scrape")) return null;
      daily.tokens = dom;
      daily.tokenSource = "dom-scrape";
    }
    const signature = JSON.stringify(daily.tokens);
    const now = Date.now();
    if (signature === lastTokenSignature && now - lastTokenPushAt < DOM_PUSH_COOLDOWN_MS) return null;
    return publishDaily();
  }

  function scheduleDomCapture() {
    for (const delay of [1000, 3000, 7000, 15000]) {
      setTimeout(() => refreshFromVisiblePage().catch(() => {}), delay);
    }
  }

  function observeVisibleTokens() {
    const root = typeof document === "undefined" ? null : document.documentElement;
    if (!root) {
      setTimeout(observeVisibleTokens, 100);
      return;
    }
    const observer = new MutationObserver(() => {
      clearTimeout(domCaptureTimer);
      domCaptureTimer = setTimeout(() => refreshFromVisiblePage().catch(() => {}), DOM_DEBOUNCE_MS);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    window.addEventListener("load", () => scheduleDomCapture());
    scheduleDomCapture();
  }

  /**
   * Platform balance (get_user_summary). Failures stay silent: a missing balance
   * must never look like a bill error.
   */
  async function handleBalance(url, json) {
    const biz = json?.data?.biz_data ?? json?.data;
    if (!biz) return null;
    const summary = P.parseBalanceWallets(biz);
    if (!summary) return null;
    const response = await send("push-web-balance", {
      provider: "deepseek",
      wallets: summary.wallets,
      currency: summary.currency,
      available: summary.available,
      sourceUrl: String(url || location.href),
      extensionVersion: VERSION
    });
    return response?.ok === true ? response.result || response : null;
  }

  async function pushStatus(message) {
    await send("push-web-bill-status", {
      provider: "deepseek",
      message: String(message || "网络异常"),
      sourceUrl: location.href,
      extensionVersion: VERSION
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    // The page and the injected MAIN-world script share this channel, so also
    // require a same-origin event and an explicitly known message kind.
    if (event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.marker !== MARKER) return;
    if (data.type === "error") {
      pushStatus(data.message).catch(() => {});
      return;
    }
    if (data.type !== "response") {
      console.warn("[Usage Hub] ignored message with unknown type:", data.type);
      return;
    }
    const kind = typeof data.kind === "string" ? data.kind : "";
    if (!ALLOWED_RESPONSE_KINDS.has(kind)) {
      console.warn("[Usage Hub] ignored response with unknown kind:", data.kind);
      return;
    }
    if (kind === "balance") {
      handleBalance(data.url, data.json).catch(() => {});
      return;
    }
    handleResponse(data.url, data.json, kind).catch(async (error) => {
      try {
        await chrome.storage.local.set({
          lastWebBillStatus: { ok: false, at: new Date().toISOString(), error: error?.message || "web bill parse failed" }
        });
      } catch {}
    });
  });

  observeVisibleTokens();
})();