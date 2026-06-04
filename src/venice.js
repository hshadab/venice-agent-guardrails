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

const DEFAULT_BASE_URL = "https://api.venice.ai/api/v1";
const DEFAULT_MODEL = "e2ee-venice-uncensored-24b-p";

export class VeniceClient {
  constructor({ apiKey, baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL } = {}) {
    if (!apiKey) throw new Error("VeniceClient: apiKey is required");
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
  }

  /** Generate a fresh 32-byte hex nonce for attestation binding. */
  newNonce() {
    return randomBytes(32).toString("hex");
  }

  /**
   * Fetch a TEE attestation for the configured model bound to `nonce`.
   * Caller is responsible for checking `nonce_match === true`.
   */
  async getAttestation(nonce) {
    const url = `${this.baseUrl}/tee/attestation?model=${encodeURIComponent(this.model)}&nonce=${nonce}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
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
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Venice chat failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  /**
   * Convenience: attest, chat, return the agent-relevant subset.
   * Throws if the returned attestation nonce does not match what we sent.
   */
  async attestedChat({ messages, temperature, maxTokens, extra }) {
    const nonce = this.newNonce();
    const attestation = await this.getAttestation(nonce);
    if (attestation?.nonce_match !== true) {
      throw new Error("Venice attestation: nonce_match is not true (possible replay)");
    }
    const completion = await this.chat({ messages, temperature, maxTokens, extra });
    return {
      content: completion?.choices?.[0]?.message?.content ?? "",
      model: this.model,
      requestId: completion?.id,
      attestation: {
        signingAddress: attestation.signing_address,
        nonceMatch: attestation.nonce_match,
        intelTdxQuote: attestation.intel_tdx_quote,
        nvidiaPayload: attestation.nvidia_payload,
        nonce,
      },
      raw: completion,
    };
  }
}
