// Pure parsing helpers shared by content.js and the plugin test-suite.
// Loaded as a content script BEFORE content.js; also evaluated inside node:vm
// by tests/content-parse.test.mjs through globalThis.UsageHubParse.
(() => {
  "use strict";

  function localDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * Collect every "cost" value in the tree. Once a level provides a cost, its own
   * descendants are NOT visited: the previous implementation kept recursing and
   * added parent totals together with the per-bucket values they summarise.
   */
  function collectCosts(value, output = [], depth = 0) {
    if (!value || depth > 12) return output;
    if (Array.isArray(value)) {
      for (const item of value) collectCosts(item, output, depth + 1);
      return output;
    }
    if (!isPlainObject(value)) return output;
    let matchedHere = false;
    for (const [key, child] of Object.entries(value)) {
      if (key !== "cost") continue;
      const number = Number(child);
      if (Number.isFinite(number)) {
        output.push(number);
        matchedHere = true;
      }
    }
    if (matchedHere) return output;
    for (const child of Object.values(value)) collectCosts(child, output, depth + 1);
    return output;
  }

  /**
   * Sum the first matching key found at each level. Keys are an ordered
   * preference list, so only the first present key at a level contributes, and a
   * level that matched never contributes its descendants as well.
   */
  function sumNumbers(value, keys, depth = 0) {
    if (!value || depth > 10) return null;
    if (Array.isArray(value)) {
      let sum = 0;
      let found = false;
      for (const item of value) {
        const partial = sumNumbers(item, keys, depth + 1);
        if (partial !== null) {
          sum += partial;
          found = true;
        }
      }
      return found ? sum : null;
    }
    if (!isPlainObject(value)) return null;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      const number = Number(value[key]);
      if (Number.isFinite(number)) return number;
    }
    let sum = 0;
    let found = false;
    for (const child of Object.values(value)) {
      const partial = sumNumbers(child, keys, depth + 1);
      if (partial !== null) {
        sum += partial;
        found = true;
      }
    }
    return found ? sum : null;
  }

  function findCurrency(value) {
    if (!value || typeof value !== "object") return "";
    if (typeof value.currency === "string" && value.currency) return value.currency;
    for (const child of Object.values(value)) {
      const found = findCurrency(child);
      if (found) return found;
    }
    return "";
  }

  function extractTokens(value) {
    const cacheRead = sumNumbers(value, ["prompt_cache_hit_tokens", "promptCacheHitTokens", "cache_hit_tokens", "cacheHitTokens", "cache_read_tokens", "cacheReadTokens"]);
    const freshInput = sumNumbers(value, ["prompt_cache_miss_tokens", "promptCacheMissTokens", "cache_miss_tokens", "cacheMissTokens"]);
    const output = sumNumbers(value, ["completion_tokens", "completionTokens", "output_tokens", "outputTokens"]);
    const explicitInput = sumNumbers(value, ["prompt_tokens", "promptTokens", "input_tokens", "inputTokens"]);
    const input = explicitInput !== null ? explicitInput : (cacheRead || 0) + (freshInput || 0);
    if (input === null && output === null && cacheRead === null && freshInput === null) return null;
    const tokens = {
      input: input || 0,
      output: output || 0,
      cacheRead: cacheRead || 0,
      cacheCreation: 0,
      freshInput: freshInput || 0,
      total: (input || 0) + (output || 0)
    };
    return tokens.total > 0 ? tokens : null;
  }

  function parseTokenNumber(text) {
    const matches = String(text || "").matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(亿|万|[KMBT])?/gi);
    for (const match of matches) {
      let number = Number(String(match[1] || "").replace(/,/g, ""));
      if (!Number.isFinite(number)) continue;
      const unit = String(match[2] || "").toUpperCase();
      const scale =
        unit === "K" ? 1e3
        : unit === "M" ? 1e6
        : unit === "B" ? 1e9
        : unit === "T" ? 1e12
        : unit === "万" ? 1e4
        : unit === "亿" ? 1e8
        : 1;
      number *= scale;
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function matchesAny(text, patterns) {
    return patterns.some((pattern) => pattern.test(text));
  }

  function valueAfterLabel(line, patterns) {
    let start = 0;
    let matched = false;
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match || match.index === undefined) continue;
      matched = true;
      start = Math.max(start, match.index + match[0].length);
    }
    return matched ? parseTokenNumber(line.slice(start)) : null;
  }

  function extractTokensFromVisiblePage(bodyTextOverride) {
    const bodyText = bodyTextOverride !== undefined ? String(bodyTextOverride || "") : (document.body?.innerText || "");
    if (!bodyText.trim()) return null;
    const rows = bodyText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const labels = {
      // Deliberately narrow: a bare "总 Tokens" line on the usage page can be a range
      // or account-wide total, and a text scrape cannot tell that apart from today.
      // Labelled input/output lines below still provide the total when they exist.
      total: [/total\s*tokens?\s*(?:used|today)/i, /今日\s*tokens?/i, /tokens?\s*(?:今日|当天)/i],
      input: [/输入\s*tokens?/i, /input\s*tokens?/i, /prompt\s*tokens?/i],
      output: [/输出\s*tokens?/i, /output\s*tokens?/i, /completion\s*tokens?/i],
      cacheRead: [/缓存命中/i, /cache\s*hit/i, /cached\s*tokens?/i, /缓存读取/i],
      freshInput: [/未命中缓存/i, /缓存未命中/i, /cache\s*miss/i, /未缓存/i]
    };

    function findValue(kind) {
      const patterns = labels[kind];
      for (let index = 0; index < rows.length; index += 1) {
        const line = rows[index];
        if (!matchesAny(line, patterns)) continue;
        const value = valueAfterLabel(line, patterns);
        if (value !== null) return value;
        for (let next = index + 1; next < Math.min(rows.length, index + 4); next += 1) {
          const nextValue = parseTokenNumber(rows[next]);
          if (nextValue !== null) return nextValue;
        }
      }
      return null;
    }

    let input = findValue("input");
    let output = findValue("output");
    let total = findValue("total");
    const cacheRead = findValue("cacheRead");
    let freshInput = findValue("freshInput");
    if (freshInput === null && input !== null && cacheRead !== null) freshInput = Math.max(0, input - cacheRead);
    if (total === null && (input !== null || output !== null)) total = (input || 0) + (output || 0);
    if (total === null || total <= 0) return null;
    if (input === null) input = Math.max(0, total - (output || 0));
    if (output === null) output = Math.max(0, total - input);
    return { input, output, cacheRead: cacheRead || 0, cacheCreation: 0, freshInput: freshInput || 0, total };
  }

  function collectDiagnosticNumbers(value, output = {}, depth = 0) {
    if (!value || depth > 8) return output;
    if (Array.isArray(value)) {
      for (const child of value) collectDiagnosticNumbers(child, output, depth + 1);
      return output;
    }
    if (typeof value !== "object") return output;
    for (const [key, child] of Object.entries(value)) {
      if (
        (typeof child === "number" || (typeof child === "string" && child.trim() !== "" && Number.isFinite(Number(child)))) &&
        /token|estimate|input|output|cache|count|total/i.test(key)
      ) {
        output[key] = Number(child);
      }
      collectDiagnosticNumbers(child, output, depth + 1);
    }
    return output;
  }

  function collectDiagnosticKeys(value, output = [], depth = 0) {
    if (!value || depth > 6 || output.length >= 80) return output;
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 5)) collectDiagnosticKeys(child, output, depth + 1);
      return output;
    }
    if (typeof value !== "object") return output;
    for (const [key, child] of Object.entries(value)) {
      if (!output.includes(key)) output.push(key);
      collectDiagnosticKeys(child, output, depth + 1);
    }
    return output;
  }

  function extractEstimatedTokens(value) {
    const fields = collectDiagnosticNumbers(value);
    const lower = {};
    for (const [key, item] of Object.entries(fields)) lower[key.toLowerCase()] = item;
    const pick = (keys) => {
      for (const key of keys) {
        const item = Number(lower[key]);
        if (Number.isFinite(item) && item > 0) return item;
      }
      return null;
    };
    const input = pick(["input_tokens", "inputtokens", "input"]);
    const output = pick(["output_tokens", "outputtokens", "output"]);
    const cacheRead = pick(["cache_read_tokens", "cachereadtokens", "cache_hit_tokens", "cachehittokens", "cache_read", "cacheread"]);
    let freshInput = pick(["cache_miss_tokens", "cachemisstokens", "fresh_input", "freshinput", "cache_miss"]);
    let total = pick(["total_tokens", "totaltokens", "estimated_tokens", "estimatedtokens", "token_estimation", "tokenestimation", "token_count", "tokencount", "tokens", "total"]);
    if (total === null) {
      const candidates = Object.entries(lower)
        .filter(([key]) => /token|estimate/.test(key))
        .map(([, item]) => item)
        .filter((item) => Number.isFinite(item) && item > 0);
      if (candidates.length) total = Math.max(...candidates);
    }
    if (total === null && (input !== null || output !== null)) total = (input || 0) + (output || 0);
    if (total === null || total <= 0) return null;
    if (freshInput === null && input !== null && cacheRead !== null) freshInput = Math.max(0, input - cacheRead);
    return { input: input || 0, output: output || 0, cacheRead: cacheRead || 0, cacheCreation: 0, freshInput: freshInput || 0, total };
  }

  /**
   * Balance summary from the platform's own /users/get_user_summary response:
   * { normal_wallets: [{ balance, currency }], bonus_wallets: [...] }.
   */
  function parseBalanceWallets(biz) {
    const wallets = [];
    const groups = [["normal", biz?.normal_wallets], ["bonus", biz?.bonus_wallets]];
    for (const [kind, list] of groups) {
      if (!Array.isArray(list)) continue;
      for (const item of list.slice(0, 8)) {
        const balance = Number(item?.balance);
        const currency = String(item?.currency || "").toUpperCase();
        if (!Number.isFinite(balance) || balance < 0) continue;
        if (!/^[A-Z]{3}$/.test(currency)) continue;
        wallets.push({ kind, currency, balance });
      }
    }
    if (!wallets.length) return null;
    return {
      wallets,
      available: wallets.reduce((sum, wallet) => sum + wallet.balance, 0),
      currency: wallets[0].currency
    };
  }
  globalThis.UsageHubParse = {
    collectCosts,
    collectDiagnosticKeys,
    collectDiagnosticNumbers,
    extractEstimatedTokens,
    extractTokens,
    extractTokensFromVisiblePage,
    findCurrency,
    localDateKey,
    parseBalanceWallets,
    parseTokenNumber,
    sumNumbers
  };
})();