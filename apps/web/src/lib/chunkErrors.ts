const RELOAD_KEY = 'myhive.chunk-reload-at';
const RELOAD_WINDOW_MS = 30_000;

let chunkError = false;
const listeners = new Set<() => void>();

/**
 * A redeploy replaces the hashed chunks. A tab that still has the old
 * index.html will ask for old hashes (404) and dynamic imports fail.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk \d+ failed|ChunkLoadError/i.test(message);
}

/** Reloads the page at most once per short window to avoid a reload loop. */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // If sessionStorage is unavailable, never risk an infinite reload loop.
    return false;
  }
  window.location.reload();
  return true;
}

export function markChunkError() {
  chunkError = true;
  for (const listener of listeners) listener();
}

export function clearChunkError() {
  chunkError = false;
}

export function getChunkError() {
  return chunkError;
}

export function subscribeChunkError(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
