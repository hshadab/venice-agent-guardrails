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
import { verifyCompletionSignature } from "./signature.js";

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
  async chat(opts) {
    const { completion } = await this._chat(opts);
    return completion;
  }

  /** Internal: chat that also surfaces the inline TEE signature header. */
  async _chat({ messages, temperature, maxTokens, extra = {} }) {
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
    const signatureHeader = res.headers.get("x-venice-tee-signature") || null;
    return { completion: await res.json(), signatureHeader };
  }

  /**
   * Fetch the persisted TEE signature for a completion `request_id`
   * (the `id` field of the chat response, e.g. "chatcmpl-..."). Returns the raw
   * payload; field names vary, so callers use {@link extractSignature}.
   *
   * Endpoint: GET /v1/tee/signature?model=<m>&request_id=<id>&signing_algo=ecdsa
   */
  async getSignature({ requestId, signingAlgo = "ecdsa" }) {
    if (!requestId) throw new Error("VeniceClient.getSignature: requestId is required");
    const url =
      `${this.baseUrl}/tee/signature` +
      `?model=${encodeURIComponent(this.model)}` +
      `&request_id=${encodeURIComponent(requestId)}` +
      `&signing_algo=${encodeURIComponent(signingAlgo)}`;
    const res = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
      this.timeoutMs
    );
    if (!res.ok) {
      throw new Error(`Venice signature fetch failed: ${res.status} ${await res.text()}`);
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
   * BINDING — pass `verifySignature: true` to bind the completion to the
   * attestation cryptographically. After the chat call, this fetches the TEE
   * signature for the completion's `request_id` and verifies (via
   * {@link verifyCompletionSignature}) that it was produced by the attested
   * `signing_address`. On success `attestation.signatureVerified` is true; on a
   * recovered-signer mismatch (or unavailable signature) it throws (fail-closed).
   *
   * With `verifySignature: false` (default) only the endpoint is attested
   * (nonce echo + `verified=true`); the specific response is NOT proven to come
   * from the enclave. Full client-side Intel TDX quote verification is still out
   * of scope; `attestation.intelQuote` is surfaced for out-of-band checks.
   */
  async attestedChat({ messages, temperature, maxTokens, extra, verifySignature = false }) {
    const nonce = this.newNonce();
    const attestation = await this.getAttestation(nonce);
    // Venice has used both `request_nonce` and `nonce` for the echoed value.
    const echoedNonce = attestation?.request_nonce ?? attestation?.nonce;
    const nonceMatch = echoedNonce === nonce;
    if (!nonceMatch) {
      throw new Error("Venice attestation: nonce does not match (possible replay)");
    }
    if (attestation?.verified !== true) {
      throw new Error("Venice attestation: server did not report verified=true (fail-closed)");
    }
    const signingAddress = attestation.signing_address;
    const { completion } = await this._chat({ messages, temperature, maxTokens, extra });

    let signatureVerified = false;
    let signedText = null;
    if (verifySignature) {
      const payload = await this.getSignature({ requestId: completion?.id });
      const extracted = extractSignature(payload);
      signedText = extracted.signedText;
      const v = verifyCompletionSignature({
        signedText,
        signatureHex: extracted.signatureHex,
        signingAddress,
      });
      if (!v.verified) {
        throw new Error(`Venice signature verification failed (fail-closed): ${v.error}`);
      }
      signatureVerified = true;
    }

    return {
      content: completion?.choices?.[0]?.message?.content ?? "",
      model: this.model,
      requestId: completion?.id,
      attestation: {
        signingAddress,
        signingAlgo: attestation.signing_algo,
        signingPublicKey: attestation.signing_public_key ?? attestation.signing_key,
        verified: attestation.verified,
        nonceMatch,
        signatureVerified,
        signedText,
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

/**
 * Pull a signature + signed-text pair out of a /tee/signature payload. Field
 * names are not fully standardized across Venice/partner gateways, so we try
 * the documented shapes: an explicit `signed_text`, or the
 * "<request_hash>:<response_hash>" pair.
 */
export function extractSignature(payload) {
  if (!payload || typeof payload !== "object") return { signatureHex: null, signedText: null };
  const signatureHex =
    payload.signature ?? payload.tee_signature ?? payload.sig ?? null;
  const reqHash = payload.request_hash ?? payload.req_hash;
  const resHash = payload.response_hash ?? payload.res_hash;
  const signedText =
    payload.signed_text ??
    payload.text ??
    payload.message ??
    (reqHash && resHash ? `${reqHash}:${resHash}` : null);
  return { signatureHex, signedText };
}
