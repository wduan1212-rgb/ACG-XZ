const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function shanghaiDayKey(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(Number(timestamp) || Date.now()));
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function resolvePublishPlanDate(value = "", timestamp = Date.now()) {
  const today = shanghaiDayKey(timestamp);
  const selected = String(value || "").trim();
  return DAY_KEY_PATTERN.test(selected) && selected >= today ? selected : today;
}
