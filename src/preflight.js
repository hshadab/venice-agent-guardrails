// ICME Preflight client.
//
// Endpoint used here:
//   POST /v1/checkIt      — three-solver check with LLM extraction; returns
//                            proof_id + proof_url (SSE stream).
//
// Third parties (anyone, no API key) can later verify the returned proof_id by
//   POST /v1/verifyProof   { "proof_id": "..." }   (single-use)
//
// References:
//   https://docs.icme.io
//   https://docs.icme.io/documentation/privacy-and-data-security/venice-ai-+-preflight

import { fetchWithTimeout, DEFAULT_TIMEOUT_MS } from "./http.js";
import { parseLastSseJson } from "./sse.js";

const DEFAULT_BASE_URL = "https://api.icme.io/v1";

export class PreflightClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, policyId, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error("PreflightClient: apiKey is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.policyId = policyId; // optional default
    this.timeoutMs = timeoutMs;
  }

  /**
   * Three-solver check (Z3 + Automated Reasoning + LLM) with proof_id.
   *
   * The endpoint streams SSE; we buffer the stream and return the final
   * event payload, which contains the full structured result.
   *
   * Returns: { check_id, result, z3_result, ar_result, llm_result,
   *            ar_detail, detail, extracted, verification_time_ms,
   *            proof_id, proof_url, step, ... }
   */
  async checkIt({ policyId = this.policyId, action, values }) {
    if (!policyId) throw new Error("Preflight.checkIt: policyId is required");
    if (!action) throw new Error("Preflight.checkIt: action is required");

    const res = await fetchWithTimeout(
      `${this.baseUrl}/checkIt`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.apiKey,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ policy_id: policyId, action, ...(values ? { values } : {}) }),
      },
      this.timeoutMs
    );
    if (!res.ok) {
      throw new Error(`Preflight checkIt failed: ${res.status} ${await res.text()}`);
    }
    const text = await res.text();
    return parseLastSseJson(text);
  }


  /**
   * Public, single-use verification of a previously-issued proof_id.
   * Requires NO API key. The first caller consumes the proof.
   *
   * Returns: { proof_id, policy_id, policy_hash, result, valid, used, verify_ms, ... }
   */
  static async verifyProof(proofId, { baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const url = `${baseUrl.replace(/\/+$/, "")}/verifyProof`;
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proof_id: proofId }),
      },
      timeoutMs
    );
    if (!res.ok) {
      throw new Error(`Preflight verifyProof failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * Decide whether an ICME result should be treated as ALLOW.
   *
   * Convention (matches the ICME doc + reference implementations):
   *   - All three SAT                                → ALLOW
   *   - Any solver UNSAT / BLOCKED                   → DENY
   *   - AR "uncertain" or "fail-closed", Z3+LLM SAT  → ALLOW (the AR solver
   *                                                    reached a bounded
   *                                                    decision; Z3 + LLM carry)
   *
   * This gate is fail-closed: anything we cannot positively interpret as a SAT
   * decision — a missing top-level result, an empty AR result, an unrecognized
   * status — is treated as DENY.
   */
  static isAllowed(result) {
    if (!result) return false;
    const top = String(result.result || "").toUpperCase();
    if (top === "SAT") return true;
    if (top === "UNSAT" || top === "BLOCKED") return false;
    // Fall back to per-solver consensus.
    const z3 = String(result.z3_result || "").toUpperCase();
    const llm = String(result.llm_result || "").toUpperCase();
    const ar = String(result.ar_result || "").toLowerCase();
    if (z3 === "SAT" && llm === "SAT" && (ar === "sat" || ar === "uncertain" || ar === "fail-closed")) {
      return true;
    }
    return false;
  }
}
