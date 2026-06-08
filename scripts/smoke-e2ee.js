// Temporary live smoke test for the E2EE path. Not part of the test suite.
// Run: node --env-file=.env scripts/smoke-e2ee.js
import { VeniceClient } from "../src/index.js";

const apiKey = process.env.VENICE_API_KEY;
const baseUrl = process.env.VENICE_BASE_URL || undefined;
if (!apiKey) {
  console.error("VENICE_API_KEY not set");
  process.exit(1);
}

const model = process.env.VENICE_E2EE_MODEL || "e2ee-venice-uncensored-24b-p";
const venice = new VeniceClient({ apiKey, baseUrl, model });
console.log("model:", model, "| e2ee auto-detected:", venice.e2ee);

try {
  const r = await venice.attestedChat({
    messages: [{ role: "user", content: "Reply with exactly: E2EE OK" }],
    maxTokens: 32,
    temperature: 0,
  });
  console.log("--- attestation ---");
  console.log("verified:        ", r.attestation.verified);
  console.log("nonceMatch:      ", r.attestation.nonceMatch);
  console.log("e2ee:            ", r.attestation.e2ee);
  console.log("signingAddress:  ", r.attestation.signingAddress);
  console.log("teeProvider:     ", r.attestation.teeProvider, "| teeHardware:", r.attestation.teeHardware);
  console.log("modelPubKey len: ", (r.attestation.signingPublicKey || "").length);
  console.log("--- completion ---");
  console.log("requestId:       ", r.requestId);
  console.log("content:         ", JSON.stringify(r.content));
  console.log("\nSMOKE RESULT:", r.content && r.content.length > 0 ? "PASS (decrypted non-empty content)" : "FAIL (empty content)");
} catch (err) {
  console.error("SMOKE RESULT: ERROR");
  console.error(err?.message || err);
  process.exit(2);
}
