// Verify that a Venice TEE completion was signed by the attested enclave.
//
// Venice's TEE models sign their output with a secp256k1 key whose Ethereum
// address is `signing_address` in the attestation. The signature is an
// eth_sign / EIP-191 ("personal_sign") signature over a text payload — for the
// current gateway that payload is "<request_hash>:<response_hash>" (two sha256
// hex digests). Recovering the signer address and comparing it to the attested
// `signing_address` binds the completion to the attested enclave, closing the
// gap left by attestation alone (which only proves the *endpoint* attested
// itself, not that a given response came from it).
//
// Algorithm and the public test vector below match veniceai/venice-cli
// (src/lib/e2ee.ts) and the NEAR AI Cloud verification docs.

import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export function hexToBytes(hex) {
  const h = String(hex).startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("hexToBytes: odd-length hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.substr(i * 2, 2), 16);
  }
  return out;
}

export function bytesToHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** keccak256 of the EIP-191 ("\x19Ethereum Signed Message:\n<len>") wrapping. */
function eip191Hash(message) {
  const msg = new TextEncoder().encode(message);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const prefixed = new Uint8Array(prefix.length + msg.length);
  prefixed.set(prefix, 0);
  prefixed.set(msg, prefix.length);
  return keccak_256(prefixed);
}

/** Lowercase 40-hex Ethereum address (no 0x) from an uncompressed pubkey point. */
function addressFromPublicKey(point) {
  const raw = point.toBytes(false); // 65 bytes: 0x04 || X || Y
  return bytesToHex(keccak_256(raw.slice(1)).slice(12));
}

/**
 * Recover the signer's Ethereum address from an eth_sign-style ECDSA
 * secp256k1 signature (r||s||v, 65 bytes; v of 0/1 or 27/28).
 *
 * @returns {string|null} lowercase 40-hex address (no 0x), or null on failure.
 */
export function recoverSignerAddress(message, signatureHex) {
  try {
    const sig = hexToBytes(signatureHex);
    if (sig.length !== 65) return null;
    let v = sig[64];
    if (v >= 27) v -= 27;
    if (v !== 0 && v !== 1) return null;
    const recovered = secp256k1.Signature
      .fromBytes(sig.slice(0, 64), "compact")
      .addRecoveryBit(v)
      .recoverPublicKey(eip191Hash(message));
    return addressFromPublicKey(recovered);
  } catch {
    return null;
  }
}

/**
 * Verify a TEE completion signature against the attested signing address.
 *
 * @param {object} p
 * @param {string} p.signedText        The exact text the enclave signed.
 * @param {string} p.signatureHex      65-byte hex signature (0x-optional).
 * @param {string} p.signingAddress    Attestation `signing_address`.
 * @returns {{verified: boolean, recovered: string|null, error?: string}}
 */
export function verifyCompletionSignature({ signedText, signatureHex, signingAddress }) {
  if (!signatureHex) return { verified: false, recovered: null, error: "missing signature" };
  if (!signingAddress) return { verified: false, recovered: null, error: "missing signing address" };
  const expected = String(signingAddress).toLowerCase().replace(/^0x/, "");
  const recovered = recoverSignerAddress(signedText, signatureHex);
  if (!recovered) {
    return { verified: false, recovered: null, error: "could not recover signer address" };
  }
  if (recovered !== expected) {
    return {
      verified: false,
      recovered,
      error: `recovered signer ${recovered} != attested ${expected}`,
    };
  }
  return { verified: true, recovered };
}
