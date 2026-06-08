// Client-side end-to-end encryption for Venice E2EE (`e2ee-*`) models.
//
// Venice's E2EE models expect each message to be encrypted *by the client* to
// the model's TEE public key (from the attestation), and they stream responses
// back encrypted to a client session key. The server (and Venice) never sees
// plaintext — only the enclave does.
//
// Scheme (matches veniceai/venice-cli, src/lib/e2ee.ts):
//   - secp256k1 ECDH to a 32-byte shared secret (the X coordinate).
//   - HKDF-SHA256(sharedSecret, salt=undefined, info="ecdsa_encryption", 32)
//     to derive a 32-byte AES key.
//   - AES-256-GCM with a fresh 12-byte nonce; 16-byte tag appended by GCM.
//   - Wire format (hex): ephemeralPublic(65) || nonce(12) || ciphertext+tag.
//
// Two key pairs are in play:
//   1. A per-session key pair. Its public key goes in the request header so the
//      enclave can encrypt the *response* to it; its private key decrypts the
//      streamed response chunks.
//   2. A per-message ephemeral key pair generated inside encryptMessage, used to
//      encrypt that one outgoing message to the model public key.

import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { gcm } from "@noble/ciphers/aes.js";
import { hexToBytes, bytesToHex } from "./signature.js";

export const HKDF_INFO = "ecdsa_encryption";
export const EPHEMERAL_PUB_LENGTH = 65; // uncompressed secp256k1 point (0x04||X||Y)
export const NONCE_LENGTH = 12; // AES-GCM standard nonce
export const AES_GCM_TAG_LENGTH = 16;

// Minimum hex length for a valid encrypted blob: (65 + 12 + 16) bytes * 2.
const MIN_ENCRYPTED_HEX = (EPHEMERAL_PUB_LENGTH + NONCE_LENGTH + AES_GCM_TAG_LENGTH) * 2;

/** Generate a fresh secp256k1 key pair. `publicKeyHex` is uncompressed (130 hex). */
export function generateKeyPair() {
  const privateKey = secp256k1.utils.randomSecretKey();
  const publicKey = secp256k1.getPublicKey(privateKey, false); // uncompressed
  return { privateKey, publicKey, publicKeyHex: bytesToHex(publicKey) };
}

/**
 * ECDH shared secret as the 32-byte X coordinate.
 * noble returns a 33-byte compressed point (prefix || X); we drop the prefix to
 * match the raw-X convention used by the Venice CLI (elliptic `derive()`).
 */
function deriveSharedSecret(privateKey, peerPublicKey) {
  return secp256k1.getSharedSecret(privateKey, peerPublicKey).slice(1);
}

/** HKDF-SHA256 → 32-byte AES key. */
function deriveAesKey(sharedSecret) {
  return hkdf(sha256, sharedSecret, undefined, new TextEncoder().encode(HKDF_INFO), 32);
}

/**
 * Encrypt `plaintext` to the model's TEE public key.
 *
 * @param {string} plaintext
 * @param {string} modelPublicKeyHex  uncompressed pubkey hex from attestation.
 * @returns {string} hex: ephemeralPublic(65) || nonce(12) || ciphertext+tag.
 */
export function encryptMessage(plaintext, modelPublicKeyHex) {
  const modelPub = hexToBytes(modelPublicKeyHex);
  const ephemeral = generateKeyPair();
  const shared = deriveSharedSecret(ephemeral.privateKey, modelPub);
  const key = deriveAesKey(shared);
  const nonce = new Uint8Array(randomBytes(NONCE_LENGTH));
  const ciphertext = gcm(key, nonce).encrypt(new TextEncoder().encode(plaintext));

  const out = new Uint8Array(EPHEMERAL_PUB_LENGTH + NONCE_LENGTH + ciphertext.length);
  out.set(ephemeral.publicKey, 0);
  out.set(nonce, EPHEMERAL_PUB_LENGTH);
  out.set(ciphertext, EPHEMERAL_PUB_LENGTH + NONCE_LENGTH);
  return bytesToHex(out);
}

/**
 * Decrypt one streamed chunk using the session private key.
 *
 * @param {string} ciphertextHex  ephemeralPublic(65)||nonce(12)||ciphertext+tag.
 * @param {Uint8Array} sessionPrivateKey
 * @returns {string} plaintext.
 */
export function decryptChunk(ciphertextHex, sessionPrivateKey) {
  const blob = hexToBytes(ciphertextHex);
  if (blob.length < EPHEMERAL_PUB_LENGTH + NONCE_LENGTH + AES_GCM_TAG_LENGTH) {
    throw new Error("decryptChunk: ciphertext too short");
  }
  const serverEphemeralPub = blob.slice(0, EPHEMERAL_PUB_LENGTH);
  const nonce = blob.slice(EPHEMERAL_PUB_LENGTH, EPHEMERAL_PUB_LENGTH + NONCE_LENGTH);
  const ciphertext = blob.slice(EPHEMERAL_PUB_LENGTH + NONCE_LENGTH);
  const shared = deriveSharedSecret(sessionPrivateKey, serverEphemeralPub);
  const key = deriveAesKey(shared);
  const plaintext = gcm(key, nonce).decrypt(ciphertext);
  return new TextDecoder().decode(plaintext);
}

/**
 * Heuristic: does this string look like a Venice E2EE-encrypted blob? Used to
 * tell encrypted streamed deltas apart from any plaintext the gateway emits.
 */
export function isHexEncrypted(s) {
  return typeof s === "string" && s.length >= MIN_ENCRYPTED_HEX && /^[0-9a-fA-F]+$/.test(s);
}
