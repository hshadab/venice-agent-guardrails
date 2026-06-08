// One-time policy compilation. Submits a plain-English policy to ICME's
// `POST /v1/makeRules` endpoint and prints the resulting policy_id.
//
// The example policy below is generic agent-tool-call guardrails. Edit it
// to match what YOUR agent should and shouldn't be allowed to do, then run:
//
//   source .env && node scripts/setup-policy.js
//
// Paste the printed policy_id into your .env as ICME_POLICY_ID.

import { fetchWithTimeout } from "../src/http.js";
import { parseSseJsonEvents } from "../src/sse.js";

const BASE = (process.env.ICME_BASE_URL || "https://api.icme.io/v1").replace(/\/+$/, "");
const KEY = process.env.ICME_API_KEY;

if (!KEY) {
  console.error("Missing ICME_API_KEY. Did you `source .env`?");
  process.exit(1);
}

const POLICY = [
  "Never send a message to a recipient not on the allowed list.",
  "Never send a message containing PII without user consent.",
  "Never call a tool if the agent authorization scope is read-only.",
].join(" ");

const res = await fetchWithTimeout(`${BASE}/makeRules`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-API-Key": KEY,
    Accept: "text/event-stream",
  },
  body: JSON.stringify({ policy: POLICY }),
});

if (!res.ok) {
  console.error(`makeRules failed: ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}

const text = await res.text();

// Pull the policy_id out of the SSE stream (scan newest-first).
let policyId = null;
for (const obj of parseSseJsonEvents(text).reverse()) {
  if (obj.policy_id) { policyId = obj.policy_id; break; }
  if (obj.id) { policyId = obj.id; break; }
}

if (!policyId) {
  console.error("Could not extract policy_id from response. Raw body:");
  console.error(text);
  process.exit(1);
}

console.log("");
console.log("  policy_id:", policyId);
console.log("");
console.log("Add this to your .env:");
console.log(`  ICME_POLICY_ID=${policyId}`);
