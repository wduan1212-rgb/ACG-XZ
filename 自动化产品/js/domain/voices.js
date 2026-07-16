import { myId, state, save } from "../core/store.js";
import * as remote from "../core/remote.js";
import { uid } from "../core/util.js";
import { defaultTtsVoiceId, findKnownTtsVoice, ttsVoicePresets } from "../api/providers.js";

function ensureVoiceMeta() {
  state.voicePresets = Array.isArray(state.voicePresets) ? state.voicePresets : [];
  state.ui.voiceByMember = state.ui.voiceByMember && typeof state.ui.voiceByMember === "object"
    ? state.ui.voiceByMember
    : {};
  const memberId = myId() || "anonymous";
  const bucket = state.ui.voiceByMember[memberId] && typeof state.ui.voiceByMember[memberId] === "object"
    ? state.ui.voiceByMember[memberId]
    : {};
  if (!state.ui.voiceByMember[memberId]) {
    bucket.favoriteVoiceIds = Array.isArray(state.ui.favoriteVoiceIds) ? state.ui.favoriteVoiceIds : [];
    bucket.voiceLab = state.ui.voiceLab && typeof state.ui.voiceLab === "object" ? state.ui.voiceLab : {};
    bucket.voicePreviewAssetIds = state.ui.voicePreviewAssetIds && typeof state.ui.voicePreviewAssetIds === "object"
      ? state.ui.voicePreviewAssetIds
      : {};
    state.ui.voiceByMember[memberId] = bucket;
    delete state.ui.favoriteVoiceIds;
    delete state.ui.voiceLab;
    delete state.ui.voicePreviewAssetIds;
  }
  bucket.favoriteVoiceIds = Array.isArray(bucket.favoriteVoiceIds) ? bucket.favoriteVoiceIds : [];
  bucket.voiceLab = bucket.voiceLab && typeof bucket.voiceLab === "object" ? bucket.voiceLab : {};
  bucket.voicePreviewAssetIds = bucket.voicePreviewAssetIds && typeof bucket.voicePreviewAssetIds === "object"
    ? bucket.voicePreviewAssetIds
    : {};
  return bucket;
}

function cleanVoiceOption(item = {}, source = "system") {
  const voiceId = String(item.voiceId || item.id || "").trim();
  if (!voiceId) return null;
  return {
    id: item.id || voiceId,
    voiceId,
    name: String(item.name || item.label || voiceId).trim(),
    description: String(item.description || item.prompt || "").trim(),
    source,
    ownerId: String(item.ownerId || "").trim(),
    createdAt: item.createdAt || 0,
    updatedAt: item.updatedAt || item.createdAt || 0,
    previewAudioDataUrl: item.previewAudioDataUrl || item.audioDataUrl || "",
  };
}

export function voiceMeta() {
  return ensureVoiceMeta();
}

export function favoriteVoiceIds() {
  const meta = ensureVoiceMeta();
  return new Set((meta.favoriteVoiceIds || []).filter(Boolean));
}

export function isFavoriteVoice(voiceId = "") {
  return favoriteVoiceIds().has(String(voiceId || "").trim());
}

export function setFavoriteVoice(voiceId = "", enabled = true) {
  const id = String(voiceId || "").trim();
  if (!id) return;
  const favs = favoriteVoiceIds();
  if (enabled) favs.add(id);
  else favs.delete(id);
  ensureVoiceMeta().favoriteVoiceIds = [...favs];
  save("meta");
}

export function toggleFavoriteVoice(voiceId = "") {
  const id = String(voiceId || "").trim();
  if (!id) return false;
  const next = !isFavoriteVoice(id);
  setFavoriteVoice(id, next);
  return next;
}

export function customVoiceOptions() {
  ensureVoiceMeta();
  const current = myId();
  return (state.voicePresets || [])
    .map(x => cleanVoiceOption(x, x.ownerId && current && x.ownerId === current ? "mine" : "shared"))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
}

export function canManageCustomVoice(voice = {}) {
  const ownerId = String(voice.ownerId || "").trim();
  return state.role === "admin" || Boolean(ownerId && myId() && ownerId === myId());
}

async function syncOwnedVoicePreset(item) {
  if (!remote.isOn()) return;
  if (!remote.hasToken()) throw new Error("登录已过期，请重新登录后再保存音色");
  /* 只能发送本次新增/修改的单条音色，禁止把共享列表中的他人旧快照回推。 */
  await remote.syncCollection("voicePresets", [JSON.parse(JSON.stringify(item))]);
}

async function deleteOwnedVoicePreset(id) {
  if (!remote.isOn()) return;
  if (!remote.hasToken()) throw new Error("登录已过期，请重新登录后再删除音色");
  await remote.deleteDoc("voicePresets", id);
}

export function systemVoiceOptions() {
  const system = (ttsVoicePresets() || [])
    .map(x => cleanVoiceOption(x, "system"))
    .filter(Boolean);
  const defaultId = defaultTtsVoiceId();
  return system.sort((a, b) => {
    if (a.voiceId === defaultId && b.voiceId !== defaultId) return -1;
    if (b.voiceId === defaultId && a.voiceId !== defaultId) return 1;
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
}

export function findVoiceOption(voiceId = "") {
  const id = String(voiceId || "").trim();
  if (!id) return { voiceId: "", name: "默认/手动声线", source: "default" };
  const custom = customVoiceOptions().find(v => v.voiceId === id);
  if (custom) return custom;
  const system = systemVoiceOptions().find(v => v.voiceId === id);
  if (system) return system;
  const known = findKnownTtsVoice(id);
  return { voiceId: id, name: known?.name || id, source: known?.source || "custom" };
}

export async function rememberCustomVoice(item = {}) {
  const voiceId = String(item.voiceId || "").trim();
  if (!voiceId) return null;
  ensureVoiceMeta();
  const now = Date.now();
  const existing = state.voicePresets.find(v => v.voiceId === voiceId);
  if (existing && !canManageCustomVoice(existing)) return null;
  const current = existing || null;
  const next = {
    id: current?.id || item.id || uid(),
    voiceId,
    name: String(item.name || current?.name || voiceId).trim(),
    description: String(item.description || item.prompt || current?.description || "").trim(),
    source: "mine",
    ownerId: current?.ownerId || item.ownerId || myId() || "",
    createdAt: current?.createdAt || now,
    updatedAt: now,
    previewAudioDataUrl: item.previewAudioDataUrl || item.audioDataUrl || current?.previewAudioDataUrl || "",
  };
  await syncOwnedVoicePreset(next);
  const latest = state.voicePresets.find(v => v.id === next.id || v.voiceId === voiceId);
  if (latest) Object.assign(latest, next);
  else state.voicePresets.unshift(next);
  save("voicePresets");
  return next;
}

export async function renameCustomVoice(voiceId = "", name = "") {
  const id = String(voiceId || "").trim();
  const nextName = String(name || "").trim().slice(0, 40);
  if (!id || !nextName) return null;
  ensureVoiceMeta();
  const current = state.voicePresets.find(v => v.voiceId === id);
  if (!current || !canManageCustomVoice(current)) return null;
  const next = { ...current, name: nextName, updatedAt: Date.now() };
  await syncOwnedVoicePreset(next);
  const latest = state.voicePresets.find(v => v.id === current.id || v.voiceId === id);
  if (!latest || !canManageCustomVoice(latest)) return null;
  Object.assign(latest, next);
  (state.accounts || []).forEach(account => {
    if (account.voiceId === id) account.voiceName = nextName;
  });
  (state.productions || []).forEach(production => {
    if (production?.artifacts?.audio?.voiceId === id) production.artifacts.audio.voiceName = nextName;
  });
  save("voicePresets", "accounts", "productions");
  return cleanVoiceOption(latest, "mine");
}

export async function deleteCustomVoice(voiceId = "") {
  const id = String(voiceId || "").trim();
  if (!id) return false;
  ensureVoiceMeta();
  const target = state.voicePresets.find(v => v.voiceId === id);
  if (!target || !canManageCustomVoice(target)) return false;
  await deleteOwnedVoicePreset(target.id || id);
  const before = state.voicePresets.length;
  state.voicePresets = state.voicePresets.filter(v => v.voiceId !== id);
  if (state.voicePresets.length === before) return false;
  const meta = ensureVoiceMeta();
  meta.favoriteVoiceIds = (meta.favoriteVoiceIds || []).filter(x => x !== id);
  (state.accounts || []).forEach(account => {
    if (account.voiceId === id) {
      account.voiceId = "";
      account.voiceName = "";
    }
  });
  save("voicePresets", "accounts", "meta");
  return true;
}

export function voicePickerGroups({ selectedId = "", selectedName = "", includeDefault = true } = {}) {
  ensureVoiceMeta();
  const favs = favoriteVoiceIds();
  const byId = new Set();
  const groups = [];
  const pushGroup = (key, title, source, list) => {
    const items = [];
    list.forEach(item => {
      const opt = cleanVoiceOption(item, source) || (item.voiceId === "" ? item : null);
      if (!opt) return;
      const id = opt.voiceId || "";
      if (byId.has(id)) return;
      byId.add(id);
      items.push(opt);
    });
    if (items.length) groups.push({ key, title, items });
  };

  const current = selectedId ? findVoiceOption(selectedId) : null;
  if (current && current.source !== "mine" && current.source !== "system") {
    pushGroup("current", "当前声线", "current", [{ ...current, name: selectedName || current.name }]);
  }
  const favoriteItems = [...favs].map(id => findVoiceOption(id)).filter(x => x?.voiceId);
  pushGroup("favorite", "收藏音色", "favorite", favoriteItems);
  pushGroup("mine", "定制音色", "shared", customVoiceOptions());
  pushGroup("system", "系统音色", "system", [
    ...(includeDefault ? [{ voiceId: "", name: "默认/手动声线", source: "default" }] : []),
    ...systemVoiceOptions()
  ]);
  return groups;
}

export function voiceListByTab(tab = "system") {
  if (tab === "mine") return customVoiceOptions();
  if (tab === "favorite") return [...favoriteVoiceIds()].map(id => findVoiceOption(id)).filter(x => x?.voiceId);
  return systemVoiceOptions();
}
