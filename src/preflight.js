// ICME Preflight client.
//
// Two endpoints used here:
//   POST /v1/checkIt   — three-solver check with LLM extraction; returns zk_proof_id (SSE).
//   POST /v1/verify    — structured-values check, no LLM extraction; returns SAT/BLOCKED.
//
// References:
//   https://docs.icme.io
//   https://docs.icme.io/documentation/privacy-and-data-security/venice-ai-+-preflight

const DEFAULT_BASE_URL = "https://api.icme.io/v1";

export class PreflightClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, policyId } = {}) {
    if (!apiKey) throw new Error("PreflightClient: apiKey is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.policyId = policyId; // optional default
  }

  /**
   * Three-solver check (Z3 + Automated Reasoning + LLM) with zk_proof_id.
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

    const res = await fetch(`${this.baseUrl}/checkIt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ policy_id: policyId, action, ...(values ? { values } : {}) }),
    });
    if (!res.ok) {
      throw new Error(`Preflight checkIt failed: ${res.status} ${await res.text()}`);
    }
    const text = await res.text();
    return parseLastSseJson(text);
  }

  /**
   * Structured-values check. Cheaper, deterministic, no LLM extraction.
   * Use this in hot paths where the agent already has the policy variables
   * computed and you don't need the zk_proof_id.
   *
   * Returns: { check_id, action: "BLOCKED" | "SAT" }
   */
  async verify({ policyId = this.policyId, action, values }) {
    if (!policyId) throw new Error("Preflight.verify: policyId is required");
    const res = await fetch(`${this.baseUrl}/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
      },
      body: JSON.stringify({ policy_id: policyId, action, values }),
    });
    if (!res.ok) {
      throw new Error(`Preflight verify failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * Decide whether an ICME result should be treated as ALLOW.
   *
   * Convention (matches the ICME doc + reference implementations):
   *   - All three SAT                                → ALLOW
   *   - Any solver UNSAT                             → DENY
   *   - AR "uncertain" or "fail-closed", Z3+LLM SAT  → ALLOW (defense-in-depth)
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
    if (z3 === "SAT" && llm === "SAT" && (ar === "sat" || ar === "uncertain" || ar === "fail-closed" || ar === "")) {
      return true;
    }
    return false;
  }
}

// --- helpers ---

function parseLastSseJson(text) {
  // SSE events are separated by blank lines; data lines are prefixed with "data: ".
  // Return the JSON payload of the LAST data event (final result).
  const events = text.split(/\n\n+/).map((e) => e.trim()).filter(Boolean);
  for (let i = events.length - 1; i >= 0; i--) {
    const lines = events[i].split("\n");
    const dataLines = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    const joined = dataLines.join("\n");
    if (joined === "[DONE]") continue;
    try {
      return JSON.parse(joined);
    } catch {
      // try previous event
    }
  }
  // Fallback: try to parse the whole body.
  try { return JSON.parse(text); } catch { /* ignore */ }
  throw new Error("Preflight: could not parse SSE response");
}
