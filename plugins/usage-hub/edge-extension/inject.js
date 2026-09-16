(() => {
  "use strict";
  const MARKER = "__USAGE_HUB_WEB_BILL__";
  const USAGE_PATH = "/api/v0/usage/";
  const ESTIMATE_PATH = "/api/v0/pricing/estimate_token";
  // Account summary (wallet balances). 2.2.0-2.4.0 shipped with isBalanceUrl()
  // referencing this name while the constant itself was missing, so the
  // ReferenceError was swallowed by that function's catch and the website
  // balance was never captured. Keep it defined next to the other paths.
  const USER_SUMMARY_PATH = "/api/v0/users/get_user_summary";
  const inFlight = new Set();
  let lastAuthHeaders = null;

  function isEstimateUrl(input) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      return typeof url === "string" && url.includes(ESTIMATE_PATH);
    } catch {
      return false;
    }
  }

  function isUsageUrl(input) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      return typeof url === "string" && (url.includes(USAGE_PATH) || url.includes(ESTIMATE_PATH));
    } catch {
      return false;
    }
  }

  function isBalanceUrl(input) {
    try {
      const url = typeof input === "string" ? input : input?.url;
      return typeof url === "string" && url.includes(USER_SUMMARY_PATH);
    } catch {
      return false;
    }
  }

  function publishError(message) {
    window.postMessage({ marker: MARKER, type: "error", message: String(message || "网络异常") }, location.origin);
  }

  // "usage" carries the authoritative daily bill, "estimate" is a single-request
  // projection. content.js keeps them apart so an estimate can never overwrite
  // the daily cost.
  function publish(url, json, kind) {
    window.postMessage(
      { marker: MARKER, type: "response", kind: kind === "balance" ? "balance" : kind === "estimate" ? "estimate" : "usage", url, json },
      location.origin
    );
  }

  function toHeaders(value) {
    try {
      const headers = new Headers(value || {});
      const copy = {};
      headers.forEach((headerValue, key) => {
        if (!["host", "content-length", "origin", "referer"].includes(key.toLowerCase())) copy[key] = headerValue;
      });
      return copy;
    } catch {
      return {};
    }
  }

  function captureHeaders(value) {
    const headers = toHeaders(value);
    if (Object.keys(headers).length) lastAuthHeaders = headers;
    return headers;
  }

  /**
   * Local-midnight window. The previous version added a fractional-hour "shift",
   * which displaced the window by 30 minutes in half-hour zones such as IST.
   */
  function todayParams() {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(start.getTime());
    end.setDate(end.getDate() + 1);
    return {
      start: Math.floor(start.getTime() / 1000),
      end: Math.floor(end.getTime() / 1000),
      tz: -now.getTimezoneOffset() * 60
    };
  }

  function todayUrl(originalUrl) {
    const parsed = new URL(originalUrl, location.origin);
    const range = todayParams();
    parsed.searchParams.set("start", String(range.start));
    parsed.searchParams.set("end", String(range.end));
    parsed.searchParams.set("tz", String(range.tz));
    return parsed.toString();
  }

  async function fetchToday(originalUrl, headers) {
    const key = new URL(originalUrl, location.origin).pathname;
    if (inFlight.has(key)) return;
    const merged = { ...(lastAuthHeaders || {}), ...(headers || {}) };
    lastAuthHeaders = merged;
    inFlight.add(key);
    const url = todayUrl(originalUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await originalFetch.call(window, url, {
        method: "GET",
        credentials: "include",
        headers: { ...merged, Accept: "application/json" },
        signal: controller.signal
      });
      if (response?.ok) {
        publish(url, await response.json(), "usage");
      } else {
        publishError("DeepSeek 账单接口返回 HTTP " + (response?.status || "unknown"));
      }
    } catch (error) {
      publishError(error?.name === "AbortError" ? "DeepSeek 账单请求超时" : "无网络连接或 DeepSeek 请求失败");
    } finally {
      clearTimeout(timer);
      // Do not retain captured Authorization headers across requests.
      lastAuthHeaders = null;
      inFlight.delete(key);
    }
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = async function usageHubFetch(...args) {
      let response;
      try {
        response = await originalFetch.apply(this, args);
      } catch (error) {
        if (isUsageUrl(args[0])) {
          publishError(error?.name === "AbortError" ? "DeepSeek 页面请求超时" : "无网络连接或 DeepSeek 页面请求失败");
        }
        throw error;
      }
      try {
        if (isBalanceUrl(args[0])) {
          const originalUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
          response
            .clone()
            .json()
            .then((json) => publish(originalUrl, json, "balance"))
            .catch(() => {});
        }
        if (isUsageUrl(args[0])) {
          const inputHeaders = args[0]?.headers;
          const initHeaders = args[1]?.headers;
          const originalUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
          if (isEstimateUrl(originalUrl)) {
            response
              .clone()
              .json()
              .then((json) => publish(originalUrl, json, "estimate"))
              .catch(() => {});
          } else {
            const headers = captureHeaders(initHeaders || inputHeaders);
            fetchToday(originalUrl, headers).catch(() => {});
          }
        }
      } catch {}
      return response;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function usageHubOpen(method, url, ...rest) {
    this.__usageHubUrl = String(url || "");
    this.__usageHubHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function usageHubSetHeader(name, value) {
    try {
      this.__usageHubHeaders[name] = value;
      lastAuthHeaders = { ...(lastAuthHeaders || {}), [name]: value };
    } catch {}
    return originalSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function usageHubSend(...args) {
    try {
      if (isBalanceUrl(this.__usageHubUrl)) {
        this.addEventListener("load", () => {
          if (this.status < 200 || this.status >= 300) return;
          try {
            publish(this.__usageHubUrl, JSON.parse(this.responseText), "balance");
          } catch {}
        });
      }
      if (isUsageUrl(this.__usageHubUrl)) {
        this.addEventListener("load", () => {
          if (this.status < 200 || this.status >= 300) return;
          if (isEstimateUrl(this.__usageHubUrl)) {
            try {
              publish(this.__usageHubUrl, JSON.parse(this.responseText), "estimate");
            } catch {}
          } else {
            fetchToday(this.__usageHubUrl, this.__usageHubHeaders || {}).catch(() => {});
          }
        });
        this.addEventListener("error", () => publishError("无网络连接或 DeepSeek 页面请求失败"));
        this.addEventListener("timeout", () => publishError("DeepSeek 账单请求超时"));
      }
    } catch {}
    return originalSend.apply(this, args);
  };
})();