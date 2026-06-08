// Minimal Server-Sent Events parsing shared by the Preflight client and the
// policy-setup script. Both ICME endpoints stream SSE and we only care about
// the JSON payloads of the `data:` lines.

/**
 * Parse a buffered SSE response body into the ordered list of JSON payloads
 * carried by its `data:` lines. Unparseable payloads and `[DONE]` markers are
 * skipped.
 *
 * @param {string} text Full SSE response body.
 * @returns {object[]} Parsed JSON objects, in stream order.
 */
export function parseSseJsonEvents(text) {
  const events = String(text || "")
    .split(/\n\n+/)
    .map((e) => e.trim())
    .filter(Boolean);

  const out = [];
  for (const event of events) {
    const data = event
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      out.push(JSON.parse(data));
    } catch {
      // Not JSON (e.g. a heartbeat / comment line); ignore.
    }
  }
  return out;
}

/**
 * Return the JSON payload of the LAST `data:` event (the final result), or
 * fall back to parsing the whole body as JSON.
 *
 * @param {string} text Full SSE response body.
 * @throws if no JSON payload can be recovered.
 */
export function parseLastSseJson(text) {
  const events = parseSseJsonEvents(text);
  if (events.length) return events[events.length - 1];
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("SSE: could not parse response");
  }
}
