import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateKeyPair,
  encryptMessage,
  decryptChunk,
  isHexEncrypted,
  EPHEMERAL_PUB_LENGTH,
  NONCE_LENGTH,
  AES_GCM_TAG_LENGTH,
} from "../src/e2ee.js";

test("generateKeyPair returns an uncompressed secp256k1 public key", () => {
  const kp = generateKeyPair();
  assert.equal(kp.privateKey.length, 32);
  assert.equal(kp.publicKey.length, EPHEMERAL_PUB_LENGTH); // 65
  assert.equal(kp.publicKey[0], 0x04); // uncompressed prefix
  assert.equal(kp.publicKeyHex.length, EPHEMERAL_PUB_LENGTH * 2);
});

test("outgoing round trip: encrypt to model pubkey, decrypt with model privkey", () => {
  const model = generateKeyPair();
  const blob = encryptMessage("secret prompt", model.publicKeyHex);
  assert.equal(decryptChunk(blob, model.privateKey), "secret prompt");
});

test("response round trip: encrypt to session pubkey, decrypt with session privkey", () => {
  const session = generateKeyPair();
  const blob = encryptMessage("streamed reply", session.publicKeyHex);
  assert.equal(decryptChunk(blob, session.privateKey), "streamed reply");
});

test("each encryption uses a fresh ephemeral key (ciphertext is non-deterministic)", () => {
  const model = generateKeyPair();
  const a = encryptMessage("same text", model.publicKeyHex);
  const b = encryptMessage("same text", model.publicKeyHex);
  assert.notEqual(a, b);
  assert.equal(decryptChunk(a, model.privateKey), "same text");
  assert.equal(decryptChunk(b, model.privateKey), "same text");
});

test("wire format is ephemeralPub(65) || nonce(12) || ciphertext+tag", () => {
  const model = generateKeyPair();
  const blob = encryptMessage("x", model.publicKeyHex);
  const bytes = blob.length / 2;
  // 1 byte plaintext → 1 + 16 (tag) ciphertext bytes.
  assert.equal(bytes, EPHEMERAL_PUB_LENGTH + NONCE_LENGTH + 1 + AES_GCM_TAG_LENGTH);
});

test("decryption fails on a tampered ciphertext (GCM auth)", () => {
  const model = generateKeyPair();
  const blob = encryptMessage("integrity matters", model.publicKeyHex);
  // Flip the last byte (inside the GCM tag).
  const tampered = blob.slice(0, -2) + (blob.slice(-2) === "00" ? "01" : "00");
  assert.throws(() => decryptChunk(tampered, model.privateKey));
});

test("decryption fails with the wrong private key", () => {
  const model = generateKeyPair();
  const other = generateKeyPair();
  const blob = encryptMessage("not for you", model.publicKeyHex);
  assert.throws(() => decryptChunk(blob, other.privateKey));
});

test("decryptChunk rejects a too-short blob", () => {
  assert.throws(() => decryptChunk("deadbeef", generateKeyPair().privateKey), /too short/);
});

test("isHexEncrypted distinguishes encrypted blobs from plaintext", () => {
  const model = generateKeyPair();
  assert.equal(isHexEncrypted(encryptMessage("hello", model.publicKeyHex)), true);
  assert.equal(isHexEncrypted("hello world"), false);
  assert.equal(isHexEncrypted("deadbeef"), false); // hex but too short
  assert.equal(isHexEncrypted("z".repeat(300)), false); // long but not hex
  assert.equal(isHexEncrypted(null), false);
});
