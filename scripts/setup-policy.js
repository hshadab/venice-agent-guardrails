// One-time policy compilation. Submits a plain-English policy to ICME's
// `POST /v1/makeRules` endpoint and prints the resulting policy_id.
//
// The example policy below is generic agent-tool-call guardrails. Edit it
// to match what YOUR agent should and shouldn't be allowed to do, then run:
//
//   source .env && node scripts/setup-policy.js
//
// Paste the printed policy_id into your .env as ICME_POLICY_ID.

const BASE = (process.env.ICME_BASE_URL || "https://api.icme.io/v1").replace(/\/+$/, "");
const KEY = process.env.ICME_API_KEY;

if (!KEY) {
  console.error("Missing ICME_API_KEY. Did you `source .env`?");
  process.exit(1);
}

const POLICY = `
You are compiling guardrails for an autonomous AI agent that runs on Venice E2EE.
Allow an action only when ALL of the following hold:

  - agentAuthorizationScope is not "AuthorizationScope_OTHER" without an explicit human approval.
  - For any tool call that sends data to a third party:
      * isRecipientOnAllowedList is true.
      * containsPII is false, OR userConsentForPII is true.
  - For any tool call that modifies persistent state:
      * isReversible is true, OR humanApproval is true.
  - For any tool call that spends resources:
      * estimatedCostUSD is at most spendLimitUSD.

Block the action if any of the above is violated. Treat missing values as fail-closed.
`.trim();

const res = await fetch(`${BASE}/makeRules`, {
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

// Pull the policy_id out of the SSE stream.
let policyId = null;
for (const evt of text.split(/\n\n+/).map((e) => e.trim()).filter(Boolean).reverse()) {
  const data = evt
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .join("\n");
  if (!data || data === "[DONE]") continue;
  try {
    const obj = JSON.parse(data);
    if (obj.policy_id) { policyId = obj.policy_id; break; }
    if (obj.id) { policyId = obj.id; break; }
  } catch { /* keep scanning */ }
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
