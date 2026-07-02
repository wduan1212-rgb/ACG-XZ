/* 数据采集适配器：只展示服务端真实采集结果；失败时把真实错误交给页面展示。 */

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if (!res.ok) {
    const err = new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 180));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const analyticsApi = {
  async resolve(url) {
    const data = await postJson("/api/analytics/resolve", { url });
    if (!data.noteId) throw new Error("真实数据服务未返回笔记 ID");
    return {
      ...data,
      provider: data.provider || "server",
      canonicalUrl: data.canonicalUrl || String(url || "").trim(),
      resolvedAt: data.resolvedAt || Date.now()
    };
  },

  async fetchMetrics(link) {
    const data = await postJson("/api/analytics/fetch", {
      url: link.url,
      noteId: link.noteId,
      assetId: link.assetId,
      accountId: link.accountId,
      title: link.title || ""
    });
    if (!data.metrics) throw new Error("真实数据服务未返回可用指标");
    return { ...data, provider: data.provider || "server", fetchedAt: data.fetchedAt || Date.now() };
  }
};
