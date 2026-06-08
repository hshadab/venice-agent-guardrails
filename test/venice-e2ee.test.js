import { test } from "node:test";
import assert from "node:assert/strict";
import { VeniceClient } from "../src/venice.js";
import { encryptMessage } from "../src/e2ee.js";

test("e2ee auto-detects from model prefix and respects explicit override", () => {
  assert.equal(new VeniceClient({ apiKey: "k", model: "e2ee-foo" }).e2ee, true);
  assert.equal(new VeniceClient({ apiKey: "k", model: "plain-foo" }).e2ee, false);
  assert.equal(new VeniceClient({ apiKey: "k", model: "e2ee-foo", e2ee: false }).e2ee, false);
  assert.equal(new VeniceClient({ apiKey: "k", model: "plain-foo", e2ee: true }).e2ee, true);
});

test("_buildE2eeContext reads model pubkey from either attestation field", () => {
  const c = new VeniceClient({ apiKey: "k", model: "e2ee-foo" });
  const a = c._buildE2eeContext({ signing_key: "abc" });
  assert.equal(a.modelPublicKeyHex, "abc");
  assert.equal(a.session.publicKey.length, 65);
  const b = c._buildE2eeContext({ signing_public_key: "def" });
  assert.equal(b.modelPublicKeyHex, "def");
});

test("_buildE2eeContext throws when no model public key is present", () => {
  const c = new VeniceClient({ apiKey: "k", model: "e2ee-foo" });
  assert.throws(() => c._buildE2eeContext({}), /no model public key/);
});

test("_decryptStream reassembles and decrypts an encrypted SSE response", () => {
  const c = new VeniceClient({ apiKey: "k", model: "e2ee-foo" });
  const ctx = c._buildE2eeContext({ signing_key: "00" }); // model key unused here
  const sessionPubHex = ctx.session.publicKeyHex;

  // Simulate the enclave encrypting each delta to the client session pubkey.
  const chunks = ["Hello", ", ", "world", "!"];
  const events = chunks.map((text, i) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-xyz",
      choices: [{ index: 0, delta: { ...(i === 0 ? { role: "assistant" } : {}), content: encryptMessage(text, sessionPubHex) }, finish_reason: i === chunks.length - 1 ? "stop" : null }],
    })}`
  );
  const body = events.join("\n\n") + "\n\ndata: [DONE]\n\n";

  const completion = c._decryptStream(body, ctx.session.privateKey);
  assert.equal(completion.id, "chatcmpl-xyz");
  assert.equal(completion.choices[0].message.role, "assistant");
  assert.equal(completion.choices[0].message.content, "Hello, world!");
  assert.equal(completion.choices[0].finish_reason, "stop");
  assert.equal(completion._e2ee, true);
});

test("_decryptStream passes through any plaintext deltas unchanged", () => {
  const c = new VeniceClient({ apiKey: "k", model: "e2ee-foo" });
  const ctx = c._buildE2eeContext({ signing_key: "00" });
  const body =
    `data: ${JSON.stringify({ id: "id1", choices: [{ delta: { content: "plain " } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "text" }, finish_reason: "stop" }] })}\n\n` +
    "data: [DONE]\n\n";
  const completion = c._decryptStream(body, ctx.session.privateKey);
  assert.equal(completion.choices[0].message.content, "plain text");
});
