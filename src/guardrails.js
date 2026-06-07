// The guardrails wrapper: compose a Venice E2EE call with an ICME Preflight check.
//
// The intended pattern for Venice agents:
//
//   const g = new Guardrails({ venice, preflight, policyId });
//
//   // 1. Reason privately on Venice (E2EE + TDX attestation).
//   const reasoning = await g.privateReason({ messages });
//
//   // 2. The agent decides to take an action; project it onto the
//   //    policy's formal variables (e.g. { toolName: "send_email",
//   //    recipientDomain: "external.com", piiPresent: false }).
//   //    Run it through Preflight; get a SNARK proof_id on allow.
//   const decision = await g.checkAction({ action, values });
//   if (!decision.allowed) throw new Error("blocked by policy");
//
//   // 3. Perform the side effect, attaching decision.proofId for audit.

import { PreflightClient } from "./preflight.js";

export class Guardrails {
  constructor({ venice, preflight, policyId }) {
    if (!venice) throw new Error("Guardrails: venice client is required");
    if (!preflight) throw new Error("Guardrails: preflight client is required");
    this.venice = venice;
    this.preflight = preflight;
    this.policyId = policyId ?? preflight.policyId;
    if (!this.policyId) throw new Error("Guardrails: policyId is required");
  }

  /** Run an attested, end-to-end-encrypted chat completion on Venice. */
  async privateReason({ messages, temperature, maxTokens, extra }) {
    return this.venice.attestedChat({ messages, temperature, maxTokens, extra });
  }

  /**
   * Check an action against the policy with the three-solver pipeline.
   *
   * `action` is the natural-language action string (e.g.
   *   "agent intends to call send_email; isRecipientExternal is true; ...").
   * `values` is an optional object of structured variables that the
   * compiled policy exposes (recommended — bypasses LLM extraction).
   *
   * Returns: { allowed, result, proofId, raw }
   */
  async checkAction({ action, values, policyId = this.policyId }) {
    const raw = await this.preflight.checkIt({ policyId, action, values });
    const allowed = PreflightClient.isAllowed(raw);
    return {
      allowed,
      result: raw.result,
      proofId: raw.proof_id ?? null,
      proofUrl: raw.proof_url ?? null,
      checkId: raw.check_id ?? null,
      detail: {
        z3: raw.z3_result,
        ar: raw.ar_result,
        llm: raw.llm_result,
        arDetail: raw.ar_detail,
      },
      raw,
    };
  }

  /**
   * One-shot: reason on Venice, derive policy values via `project`, run the
   * Preflight check, return both pieces bound together. Does NOT execute any
   * side effect — the caller decides what to do once `allowed` is true.
   *
   * @param {object} args
   * @param {Array}  args.messages          OpenAI-style chat messages.
   * @param {(content: string) => {action: string, values?: object}} args.project
   *        Maps Venice's response content onto policy variables.
   */
  async guardedAction({ messages, project, temperature, maxTokens, extra }) {
    const reasoning = await this.privateReason({ messages, temperature, maxTokens, extra });
    const projected = project(reasoning.content);
    if (!projected || typeof projected.action !== "string") {
      throw new Error("Guardrails.guardedAction: project() must return { action, values? }");
    }
    const decision = await this.checkAction({
      action: projected.action,
      values: projected.values,
    });
    return { reasoning, projected, decision };
  }
}
