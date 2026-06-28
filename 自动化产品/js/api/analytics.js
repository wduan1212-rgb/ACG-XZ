/* 数据采集适配器：优先请求服务端 provider，失败时使用稳定的本地模拟数据
   后期团队部署服务器时，只需要实现 /api/analytics/* 即可替换真实数据源。 */

function hashText(str) {
  let h = 2166136261;
  for (const ch of String(str || "")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function extractNoteId(url) {
  const s = String(url || "");
  const m = s.match(/(?:explore|discovery\/item|item)\/([0-9a-zA-Z]+)/) || s.match(/[?&](?:note_id|noteId)=([0-9a-zA-Z]+)/);
  return m ? m[1] : "note_" + hashText(s).toString(36).slice(0, 8);
}

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

function mockResolve(url) {
  return {
    ok: true,
    provider: "local-mock",
    noteId: extractNoteId(url),
    canonicalUrl: String(url || "").trim(),
    resolvedAt: Date.now()
  };
}

function mockMetrics({ url, noteId, publishedAt, previous }) {
  const seed = hashText(url || noteId);
  const ageH = Math.max(1, Math.round((Date.now() - (publishedAt || Date.now() - 3600_000)) / 3600_000));
  const base = 260 + (seed % 1200);
  const velocity = 1 + ((seed >> 5) % 9) / 10;
  const wave = 1 + Math.min(9, Math.log2(ageH + 1)) * velocity;
  const views = Math.max(previous?.views || 0, Math.round(base * wave + ageH * (seed % 17)));
  const likeRate = 0.035 + ((seed >> 8) % 55) / 1000;
  const collectRate = 0.014 + ((seed >> 13) % 38) / 1000;
  const commentRate = 0.004 + ((seed >> 18) % 18) / 1000;
  const likes = Math.max(previous?.likes || 0, Math.round(views * likeRate));
  const collects = Math.max(previous?.collects || 0, Math.round(views * collectRate));
  const comments = Math.max(previous?.comments || 0, Math.round(views * commentRate));
  const shares = Math.max(previous?.shares || 0, Math.round(views * (0.003 + ((seed >> 22) % 12) / 1000)));
  const engagementRate = views ? (likes + collects + comments + shares) / views : 0;
  const qualityScore = Math.max(35, Math.min(96, Math.round(engagementRate * 520 + Math.log10(views + 10) * 12)));
  return {
    provider: "local-mock",
    noteId: noteId || extractNoteId(url),
    fetchedAt: Date.now(),
    metrics: { views, likes, collects, comments, shares, engagementRate, qualityScore },
    commentsSample: [
      "这个场景很真实，想看具体怎么批量整理",
      "标题如果直接说省多少时间会更想点",
      "步骤图再清楚一点就能直接照做"
    ],
    raw: { mock: true, seed, ageH }
  };
}

export const analyticsApi = {
  async resolve(url) {
    try {
      const data = await postJson("/api/analytics/resolve", { url });
      return { ...mockResolve(url), ...data, provider: data.provider || "server" };
    } catch (e) {
      return mockResolve(url);
    }
  },

  async fetchMetrics(link, previous) {
    try {
      const data = await postJson("/api/analytics/fetch", {
        url: link.url,
        noteId: link.noteId,
        assetId: link.assetId,
        accountId: link.accountId
      });
      if (!data.metrics) throw new Error("empty metrics");
      return { ...data, provider: data.provider || "server", fetchedAt: data.fetchedAt || Date.now() };
    } catch (e) {
      if (e.status && e.status >= 500) throw e;
      return mockMetrics({
        url: link.url,
        noteId: link.noteId,
        publishedAt: link.publishedAt || link.createdAt,
        previous
      });
    }
  }
};
