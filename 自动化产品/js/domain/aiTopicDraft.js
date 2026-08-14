const text = value => String(value ?? "").trim();

function safeSources(item, referenceMap) {
  const embedded = Array.isArray(item?.sources) ? item.sources : [];
  if (embedded.length) return embedded.filter(Boolean).slice(0, 6);
  return (item?.sourceIds || [])
    .map(id => referenceMap.get(Number(id)))
    .filter(Boolean)
    .slice(0, 6);
}

export function normalizeAiTopicDraft(raw, accountIds = []) {
  const allowed = new Set((accountIds || []).map(String).filter(Boolean));
  const sourceRows = Array.isArray(raw?.references) ? raw.references : [];
  const referenceMap = new Map(sourceRows.map(item => [Number(item?.id), item]));
  const byAccount = new Map();
  for (const candidate of Array.isArray(raw?.items) ? raw.items : []) {
    const accountId = text(candidate?.accountId);
    if (!accountId || (allowed.size && !allowed.has(accountId)) || byAccount.has(accountId)) continue;
    byAccount.set(accountId, {
      ...candidate,
      accountId,
      title: text(candidate?.title),
      copy: text(candidate?.copy),
      sources: safeSources(candidate, referenceMap),
    });
  }
  const items = [...byAccount.values()];
  const generated = new Set(items.map(item => item.accountId));
  const missingAccountIds = [...allowed].filter(accountId => !generated.has(accountId));
  const errors = (Array.isArray(raw?.errors) ? raw.errors : [])
    .map(item => ({ accountId: text(item?.accountId), message: text(item?.message) }))
    .filter(item => missingAccountIds.includes(item.accountId));
  return {
    query: text(raw?.query),
    recency: raw?.recency === "month" ? "month" : "week",
    requestId: text(raw?.requestId),
    items,
    missingAccountIds,
    errors,
    complete: missingAccountIds.length === 0,
    updatedAt: Number(raw?.updatedAt || Date.now()),
  };
}

export function mergeAiTopicDraft(current, incoming, accountIds = [], query = "", recency = "week") {
  const normalizedQuery = text(query);
  const base = normalizeAiTopicDraft(
    text(current?.query) === normalizedQuery ? current : null,
    accountIds,
  );
  const next = normalizeAiTopicDraft(incoming, accountIds);
  const byAccount = new Map(base.items.map(item => [item.accountId, item]));
  next.items.forEach(item => byAccount.set(item.accountId, item));
  const missingErrors = new Map(base.errors.map(item => [item.accountId, item.message]));
  next.errors.forEach(item => missingErrors.set(item.accountId, item.message));
  next.items.forEach(item => missingErrors.delete(item.accountId));
  return normalizeAiTopicDraft({
    query: normalizedQuery,
    recency,
    requestId: next.requestId || base.requestId,
    items: [...byAccount.values()],
    errors: [...missingErrors].map(([accountId, message]) => ({ accountId, message })),
    updatedAt: Date.now(),
  }, accountIds);
}

export function aiTopicAccountIdsToGenerate(draft, accountIds = [], query = "", isValid = () => true) {
  const selected = (accountIds || []).map(String).filter(Boolean);
  if (text(draft?.query) !== text(query)) return selected;
  const valid = new Set(
    (draft?.items || [])
      .filter(item => isValid(item))
      .map(item => String(item.accountId)),
  );
  const missing = selected.filter(accountId => !valid.has(accountId));
  return missing.length ? missing : selected;
}

export function fillBlankAiTopicContent(plan, items = [], selectedAccountIds = [], isValid = () => true) {
  const selected = new Set((selectedAccountIds || []).map(String));
  plan.accountCopyTitles = plan.accountCopyTitles || {};
  plan.accountCopyBodies = plan.accountCopyBodies || {};
  plan.accountSingleImageTitles = plan.accountSingleImageTitles || {};
  plan.accountCustomCopyModes = plan.accountCustomCopyModes || {};
  let filled = 0;
  for (const item of items || []) {
    const accountId = text(item?.accountId);
    if (!selected.has(accountId) || !isValid(item)) continue;
    let changed = false;
    if (!text(plan.accountCopyTitles[accountId])) {
      plan.accountCopyTitles[accountId] = text(item.title);
      changed = true;
    }
    if (!text(plan.accountCopyBodies[accountId])) {
      plan.accountCopyBodies[accountId] = text(item.copy);
      changed = true;
    }
    if (plan.accountImageCreationModes?.[accountId] === "single"
      && !text(plan.accountSingleImageTitles[accountId])) {
      plan.accountSingleImageTitles[accountId] = text(item.title);
      changed = true;
    }
    if (changed) {
      plan.accountCustomCopyModes[accountId] = true;
      filled += 1;
    }
  }
  return filled;
}

export function pruneAiTopicDraft(draft, accountIds = []) {
  if (!draft) return null;
  const normalized = normalizeAiTopicDraft(draft, accountIds);
  return normalized.items.length || normalized.missingAccountIds.length ? normalized : null;
}
