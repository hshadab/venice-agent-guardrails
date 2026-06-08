// Small fetch helpers shared by the Venice and Preflight clients.

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * fetch() with a hard timeout. Aborts the request after `timeoutMs` and throws
 * a descriptive error instead of hanging the agent indefinitely.
 *
 * A guardrail that gates real side effects must not block forever on a stalled
 * upstream, so every network call in this library goes through here.
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export { DEFAULT_TIMEOUT_MS };
