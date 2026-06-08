// Venice E2EE client.
//
// Wraps two Venice endpoints:
//   GET  /v1/tee/attestation?model=<m>&nonce=<32-byte-hex>
//   POST /v1/chat/completions   (with an E2EE-capable model)
//
// References:
//   https://docs.venice.ai/api-reference/api-spec
//   https://docs.venice.ai/overview/guides/tee-e2ee-models
//   https://venice.ai/blog/venice-launches-end-to-end-encrypted-ai

import { randomBytes } from "node:crypto";
import { fetchWithTimeout, DEFAULT_TIMEOUT_MS } from "./http.js";

const DEFAULT_BASE_URL = "https://api.venice.ai/api/v1";
const DEFAULT_MODEL = "e2ee-venice-uncensored-24b-p";

export class VeniceClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (!apiKey) throw new Error("VeniceClient: apiKey is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  /** Generate a fresh 32-byte hex nonce for attestation binding. */
  newNonce() {
    return randomBytes(32).toString("hex");
  }

  /**
   * Fetch a TEE attestation for the configured model bound to `nonce`.
   *
   * Returns the raw Venice attestation envelope. Notable fields:
   *   signing_address, signing_algo, signing_public_key
   *   request_nonce       — the nonce echoed back; compare to what you sent
   *   intel_quote / quote — Intel TDX quote
   *   nvidia_payload      — NVIDIA confidential-compute payload
   *   verified            — Venice-side verification boolean
   *   server_verification — per-check booleans (tdx.valid, certificateChainValid, ...)
   *   tee_provider, tee_hardware, model, upstream_model
   */
  async getAttestation(nonce) {
    const url = `${this.baseUrl}/tee/attestation?model=${encodeURIComponent(this.model)}&nonce=${encodeURIComponent(nonce)}`;
    const res = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      this.timeoutMs
    );
    if (!res.ok) {
      throw new Error(`Venice attestation failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * Call the E2EE chat completion endpoint.
   * Returns the raw OpenAI-compatible response object.
   *
   * NOTE: E2EE models do not support `response_format`. Parse JSON from
   * the message content yourself if you need it.
   */
  async chat({ messages, temperature, maxTokens, extra = {} }) {
    const body = {
      model: this.model,
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
      ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
      ...extra,
    };
    const res = await fetchWithTimeout(
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      this.timeoutMs
    );
    if (!res.ok) {
      throw new Error(`Venice chat failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * Convenience: attest, chat, return the agent-relevant subset.
   *
   * Throws if the returned `request_nonce` does not match what we sent (replay
   * protection) or if Venice's `verified` flag is not exactly true (fail-closed:
   * a missing or non-true value is rejected).
   *
   * SECURITY LIMITATION — attestation is NOT bound to the completion. The
   * attestation and the chat completion are two independent HTTP requests. The
   * nonce binds the attestation to *this client's* attestation request, and
   * `verified` is Venice's own assessment of its TDX/NVIDIA quote; this code
   * does NOT (a) verify the Intel TDX quote against Intel collateral itself, nor
   * (b) verify a signature by `signing_address` over the returned completion.
   * The returned `attestation.signingAddress` / `signingPublicKey` / `intelQuote`
   * are surfaced so a caller can perform that verification out of band. Treat
   * the result as "this endpoint attested itself", not "this response is
   * provably from the attested enclave".
   */
  async attestedChat({ messages, temperature, maxTokens, extra }) {
    const nonce = this.newNonce();
    const attestation = await this.getAttestation(nonce);
    const nonceMatch = attestation?.request_nonce === nonce;
    if (!nonceMatch) {
      throw new Error("Venice attestation: request_nonce does not match (possible replay)");
    }
    if (attestation?.verified !== true) {
      throw new Error("Venice attestation: server did not report verified=true (fail-closed)");
    }
    const completion = await this.chat({ messages, temperature, maxTokens, extra });
    return {
      content: completion?.choices?.[0]?.message?.content ?? "",
      model: this.model,
      requestId: completion?.id,
      attestation: {
        signingAddress: attestation.signing_address,
        signingAlgo: attestation.signing_algo,
        signingPublicKey: attestation.signing_public_key,
        verified: attestation.verified,
        nonceMatch,
        teeProvider: attestation.tee_provider,
        teeHardware: attestation.tee_hardware,
        upstreamModel: attestation.upstream_model,
        intelQuote: attestation.intel_quote ?? attestation.quote,
        nvidiaPayload: attestation.nvidia_payload,
        serverVerification: attestation.server_verification,
        nonce,
      },
      raw: completion,
    };
  }
}
