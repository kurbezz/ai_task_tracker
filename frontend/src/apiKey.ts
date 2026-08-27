const API_KEY_STORAGE_KEY = "relay.api-key";

export function getApiKey(): string | null {
  try {
    const key = window.localStorage.getItem(API_KEY_STORAGE_KEY)?.trim();
    return key || null;
  } catch {
    return null;
  }
}

export function saveApiKey(key: string): string {
  const value = key.trim();
  if (!value) throw new Error("Enter the API key printed by the backend.");

  try {
    window.localStorage.setItem(API_KEY_STORAGE_KEY, value);
    return value;
  } catch {
    throw new Error("This browser could not save the API key. Check browser storage settings and try again.");
  }
}

export function clearApiKey() {
  try {
    window.localStorage.removeItem(API_KEY_STORAGE_KEY);
  } catch {
    // A blocked storage area is already treated as having no configured key.
  }
}
