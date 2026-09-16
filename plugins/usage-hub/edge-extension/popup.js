const status = document.getElementById("status");
const refresh = document.getElementById("refresh");

const TOKEN_SOURCE_LABELS = {
  api: "接口返回",
  estimate: "接口估算",
  "dom-scrape": "页面刮取",
  "cc-switch": "本地统计"
};

function formatNumber(value) {
  if (value === null || value === undefined) return "0";
  return Number(value).toLocaleString();
}

function render(value) {
  status.classList.remove("warn");
  if (!value) {
    status.textContent = "尚未收到同步结果。请确认已登录 DeepSeek 页面。";
    return;
  }
  if (value.ok) {
    const tokens = value.tokens || {};
    const lines = [
      "同步成功",
      value.cost !== null && value.cost !== undefined ? `费用：${value.currency || "CNY"} ${Number(value.cost).toFixed(4)}` : null,
      tokens.total !== undefined ? `Tokens：${formatNumber(tokens.total)}` : null,
      tokens.cacheRead !== undefined ? `缓存命中：${formatNumber(tokens.cacheRead)}` : null,
      tokens.freshInput !== undefined ? `未命中缓存：${formatNumber(tokens.freshInput)}` : null,
      tokens.output !== undefined ? `输出：${formatNumber(tokens.output)}` : null,
      value.tokenSource ? `Token 来源：${TOKEN_SOURCE_LABELS[value.tokenSource] || value.tokenSource}` : null,
      `时间：${new Date(value.at).toLocaleString()}`
    ].filter(Boolean);
    const ageMs = Date.now() - Date.parse(value.at || "");
    if (Number.isFinite(ageMs) && ageMs > 5 * 60 * 1000) {
      lines.push("⚠ 数据已超过 5 分钟未更新；请确认 Edge 仍在后台运行。");
      status.classList.add("warn");
    }
    if (value.tokenSource === "dom-scrape") {
      lines.push("⚠ Token 明细来自页面文字刮取，仅供参考。");
      status.classList.add("warn");
    }
    status.textContent = lines.join("\n");
  } else {
    status.textContent = `同步失败：${value.error || "未知错误"}\n时间：${value.at ? new Date(value.at).toLocaleString() : "-"}`;
  }
}

chrome.storage.local.get("lastWebBillStatus").then((result) => render(result.lastWebBillStatus));
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "web-bill-status") render(message.result);
});
refresh.addEventListener("click", () => {
  refresh.disabled = true;
  chrome.runtime.sendMessage({ type: "refresh-now" }).finally(() => {
    refresh.disabled = false;
  });
});