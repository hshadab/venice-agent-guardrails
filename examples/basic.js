// Basic end-to-end example.
//
//   source .env && node examples/basic.js
//
// 1. The agent gets a user request.
// 2. We ask Venice (E2EE, TDX-attested) to choose a tool call and arguments.
// 3. We project the agent's chosen action onto the policy's formal variables.
// 4. Preflight returns SAT/UNSAT + zk_proof_id.
// 5. On SAT we "execute" the tool (print here, real side effect in your app);
//    on UNSAT we explain why and refuse.

import { VeniceClient, PreflightClient, Guardrails } from "../src/index.js";

const {
  VENICE_API_KEY,
  ICME_API_KEY,
  ICME_POLICY_ID,
  VENICE_BASE_URL,
  ICME_BASE_URL,
  VENICE_E2EE_MODEL,
} = process.env;

for (const [k, v] of Object.entries({ VENICE_API_KEY, ICME_API_KEY, ICME_POLICY_ID })) {
  if (!v) { console.error(`Missing ${k}. Did you \`source .env\`?`); process.exit(1); }
}

const venice = new VeniceClient({
  apiKey: VENICE_API_KEY,
  baseUrl: VENICE_BASE_URL,
  model: VENICE_E2EE_MODEL,
});
const preflight = new PreflightClient({
  apiKey: ICME_API_KEY,
  baseUrl: ICME_BASE_URL,
  policyId: ICME_POLICY_ID,
});
const guardrails = new Guardrails({ venice, preflight });

// --- the user request ---
const userRequest = "Email a project summary to alice@partner-corp.com. Don't include any customer PII.";

// --- ask Venice (privately) what tool call to make ---
const reasoning = await guardrails.privateReason({
  messages: [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userRequest },
  ],
  temperature: 0,
});

const plan = safeParseJson(reasoning.content);
if (!plan) {
  console.error("Agent did not return JSON. Got:\n", reasoning.content);
  process.exit(1);
}

console.log("\n[1] Venice E2EE inference");
console.log("    Model:           ", reasoning.model);
console.log("    Signing address: ", reasoning.attestation.signingAddress);
console.log("    Nonce match:     ", reasoning.attestation.nonceMatch);
console.log("    Plan:            ", JSON.stringify(plan));

// --- project the plan onto policy variables ---
const values = {
  agentAuthorizationScope: "AuthorizationScope_READ_ONLY",
  isRecipientOnAllowedList: ALLOWED_DOMAINS.includes(domainOf(plan.recipient)),
  containsPII: !!plan.containsPII,
  userConsentForPII: false,
  isReversible: plan.tool === "send_email", // emails are not really reversible — set false in prod
  humanApproval: false,
  estimatedCostUSD: 0,
  spendLimitUSD: 0,
};

const action = [
  `agent intends to call ${plan.tool}`,
  `recipient is ${plan.recipient}`,
  `isRecipientOnAllowedList is ${values.isRecipientOnAllowedList}`,
  `containsPII is ${values.containsPII}`,
  `userConsentForPII is ${values.userConsentForPII}`,
  `agentAuthorizationScope is ${values.agentAuthorizationScope}`,
].join("; ");

// --- run the Preflight check ---
console.log("\n[2] ICME Preflight check");
const decision = await guardrails.checkAction({ action, values });
console.log("    Z3:  ", decision.detail.z3);
console.log("    AR:  ", decision.detail.ar);
console.log("    LLM: ", decision.detail.llm);
console.log("    Result:   ", decision.allowed ? "ALLOW" : "DENY");
console.log("    proof_id: ", decision.proofId || "(none)");

// --- gate the side effect on the proof ---
console.log("\n[3] Gate");
if (!decision.allowed) {
  console.log("    Blocked. The agent will not call the tool.");
  process.exit(0);
}
console.log(`    Allowed. Would now call ${plan.tool}(${JSON.stringify(plan)})`);
console.log(`    Attach proof_id=${decision.proofId} to your audit log.`);

// --- helpers ---

const ALLOWED_DOMAINS = ["partner-corp.com", "trusted-vendor.io"];

function domainOf(email) {
  return String(email || "").split("@")[1] || "";
}

function safeParseJson(s) {
  if (!s) return null;
  // Strip markdown fences if the model included them.
  const cleaned = s.replace(/^```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { return null; }
}

const SYSTEM_PROMPT = `
You are an agent that decides which tool to call to satisfy the user.
Reply ONLY with a JSON object of the form:
{ "tool": "send_email" | "noop", "recipient": "<email>", "subject": "<string>", "body": "<string>", "containsPII": <boolean> }
Do not include any prose, markdown, or explanation. JSON only.
`.trim();
