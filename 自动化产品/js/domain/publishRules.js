export const PUBLISH_TEXT_LIMITS = Object.freeze({
  xiaohongshuTitle: 20,
  xiaohongshuCopy: 1000,
  wechatChannelsTitle: 16,
});

export function publishTextLength(value = "") {
  return [...String(value || "")].length;
}

export function validatePublishText({ platform = "", title = "", copy = "" } = {}) {
  const name = String(platform || "").trim();
  const cleanTitle = String(title || "").trim();
  const cleanCopy = String(copy || "").trim();
  const errors = [];
  if (name === "小红书") {
    const titleLength = publishTextLength(cleanTitle);
    const copyLength = publishTextLength(cleanCopy);
    if (titleLength > PUBLISH_TEXT_LIMITS.xiaohongshuTitle) {
      errors.push(`小红书标题不能超过 ${PUBLISH_TEXT_LIMITS.xiaohongshuTitle} 字（标点也计入），当前 ${titleLength} 字`);
    }
    if (copyLength > PUBLISH_TEXT_LIMITS.xiaohongshuCopy) {
      errors.push(`小红书文案不能超过 ${PUBLISH_TEXT_LIMITS.xiaohongshuCopy} 字，当前 ${copyLength} 字`);
    }
  }
  if (name === "视频号") {
    const titleLength = publishTextLength(cleanTitle);
    if (titleLength > PUBLISH_TEXT_LIMITS.wechatChannelsTitle) {
      errors.push(`视频号标题不能超过 ${PUBLISH_TEXT_LIMITS.wechatChannelsTitle} 字，当前 ${titleLength} 字`);
    }
    if (/\p{P}/u.test(cleanTitle)) {
      errors.push("视频号标题不能包含标点符号");
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    message: errors.join("；"),
    titleLength: publishTextLength(cleanTitle),
    copyLength: publishTextLength(cleanCopy),
  };
}

export function assertPublishText(input = {}) {
  const result = validatePublishText(input);
  if (!result.ok) throw new Error(result.message);
  return result;
}
