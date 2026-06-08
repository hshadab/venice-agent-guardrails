import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverSignerAddress, verifyCompletionSignature } from "../src/signature.js";

// Published Venice / NEAR AI Cloud verification vector: an eth_sign (EIP-191)
// signature over "<request_hash>:<response_hash>" recovers to signing_address.
const SIGNED_TEXT =
  "b524f8f4b611b43526aa988c636cf1d7e72aa661876c3d969e2c2acae125a8ba:" +
  "aae79d9de9c46f0a9c478481ceb84df5742a88067a6ab8bac9e98664d712d58f";
const SIGNATURE =
  "0x649b30be41e53ac33cb3fe414c8f5fd30ad72cacaeac0f41c4977fee4b67506e" +
  "185300f1978039306c406b398c4eda49c3dad476d5054c63fd811570815012cc1b";
const SIGNING_ADDRESS = "0x319f1b8BB3b723A5d098FFB67005Bdf7BB579ACa";

test("recoverSignerAddress matches the published vector", () => {
  const recovered = recoverSignerAddress(SIGNED_TEXT, SIGNATURE);
  assert.equal(recovered, SIGNING_ADDRESS.toLowerCase().replace(/^0x/, ""));
});

test("verifyCompletionSignature accepts a valid signature for the attested address", () => {
  const r = verifyCompletionSignature({
    signedText: SIGNED_TEXT,
    signatureHex: SIGNATURE,
    signingAddress: SIGNING_ADDRESS,
  });
  assert.equal(r.verified, true);
});

test("verifyCompletionSignature rejects a different attested address (binding works)", () => {
  const r = verifyCompletionSignature({
    signedText: SIGNED_TEXT,
    signatureHex: SIGNATURE,
    signingAddress: "0x0000000000000000000000000000000000000001",
  });
  assert.equal(r.verified, false);
  assert.match(r.error, /!=/);
});

test("verifyCompletionSignature rejects a tampered signed text", () => {
  const r = verifyCompletionSignature({
    signedText: SIGNED_TEXT.replace("b524", "0000"),
    signatureHex: SIGNATURE,
    signingAddress: SIGNING_ADDRESS,
  });
  assert.equal(r.verified, false);
});

test("verifyCompletionSignature fails closed on missing inputs", () => {
  assert.equal(verifyCompletionSignature({ signedText: "x", signatureHex: null, signingAddress: SIGNING_ADDRESS }).verified, false);
  assert.equal(verifyCompletionSignature({ signedText: "x", signatureHex: SIGNATURE, signingAddress: null }).verified, false);
});

test("recoverSignerAddress returns null on malformed signature", () => {
  assert.equal(recoverSignerAddress(SIGNED_TEXT, "0xdeadbeef"), null);
});
