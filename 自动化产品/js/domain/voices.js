import { myId, state, save } from "../core/store.js";
import { uid } from "../core/util.js";
import { defaultTtsVoiceId, findKnownTtsVoice, ttsVoicePresets } from "../api/providers.js";

function ensureVoiceMeta() {
  state.voicePresets = Array.isArray(state.voicePresets) ? state.voicePresets : [];
  state.ui.favoriteVoiceIds = Array.isArray(state.ui.favoriteVoiceIds) ? state.ui.favoriteVoiceIds : [];
  state.ui.voiceLab = state.ui.voiceLab || {};
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
    createdAt: item.createdAt || 0,
    updatedAt: item.updatedAt || item.createdAt || 0,
    previewAudioDataUrl: item.previewAudioDataUrl || item.audioDataUrl || "",
  };
}

export function voiceMeta() {
  ensureVoiceMeta();
  return state.ui;
}

export function favoriteVoiceIds() {
  ensureVoiceMeta();
  return new Set((state.ui.favoriteVoiceIds || []).filter(Boolean));
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
  state.ui.favoriteVoiceIds = [...favs];
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
    .filter(v => !v.ownerId || !current || v.ownerId === current)
    .map(x => cleanVoiceOption(x, "mine"))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
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

export function rememberCustomVoice(item = {}) {
  const voiceId = String(item.voiceId || "").trim();
  if (!voiceId) return null;
  ensureVoiceMeta();
  const now = Date.now();
  const current = state.voicePresets.find(v => v.voiceId === voiceId);
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
  if (current) Object.assign(current, next);
  else state.voicePresets.unshift(next);
  save("voicePresets");
  return next;
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
  pushGroup("mine", "我的音色", "mine", customVoiceOptions());
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
