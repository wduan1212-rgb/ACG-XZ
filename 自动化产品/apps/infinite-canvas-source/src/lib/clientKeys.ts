const IMAGE_API_KEY_STORAGE = "xz-design:image-api-key";

export function getClientImageApiKey(): string {
  try {
    return localStorage.getItem(IMAGE_API_KEY_STORAGE)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setClientImageApiKey(key: string) {
  try {
    const clean = key.trim();
    if (clean) localStorage.setItem(IMAGE_API_KEY_STORAGE, clean);
    else localStorage.removeItem(IMAGE_API_KEY_STORAGE);
  } catch {
    /* localStorage can be disabled; the UI will simply show unsaved. */
  }
}

export function hasClientImageApiKey(): boolean {
  return getClientImageApiKey().length > 0;
}
