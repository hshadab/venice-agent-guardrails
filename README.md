# venice-agent-guardrails

**Composes Venice E2EE chat with a privacy-preserving [ICME Preflight](https://docs.icme.io) policy check — returns a verifiable proof per agent action without revealing the action or the policy.**

Drop-in library and MCP server. The added value is the *composition* (consensus convention, attestation nonce binding, policy-variable projection, MCP wrapping); the two underlying API clients are a means to that end.

---

## Overview

You're building an AI agent. The agent reads requests, decides what tool to call, and then does something: sends an email, makes a payment, files a ticket, runs a script.

Two things you'd like to be true:

1. **The agent's reasoning shouldn't leak.** Whatever the user said to the agent, and whatever the agent thought back, shouldn't be readable by the model host, the GPU operator, or anyone watching the wire.
2. **Every side-effecting action should be checked against a policy first**, and you should be able to prove to a counterparty later that the check happened, without showing them the policy and without trusting them to take your word for it.

Venice solves the first half: it runs the model inside a hardware-attested enclave (Intel TDX on Phala), and prompts are end-to-end encrypted to that enclave. Even Venice can't read them.

ICME Preflight solves the second half: you write your rules in plain English, ICME compiles them to formal logic (SMT-LIB) and keeps them private. Each time the agent wants to do something, ICME runs three independent checks (Z3, an Automated Reasoning solver, and an LLM) and returns a SNARK `proof_id`. Anyone (your auditor, your counterparty, a regulator) can later POST that `proof_id` to a public endpoint and learn *that the action passed the policy* without learning the action or the policy.

This repo glues those two together so you don't have to.

---

## The bigger picture: Venice + Preflight as a privacy stack

From the ICME doc, [Venice AI + Preflight](https://docs.icme.io/documentation/privacy-and-data-security/venice-ai-+-preflight):

> "Inference privacy starts with Venice [...] Policies that provide guardrails for agent actions are generally not private". Preflight closes that gap by keeping policy private at enforcement, verification, and audit stages.

Together they give you three pillars (the doc's framing, paraphrased):

| Pillar | What stays private | How |
| --- | --- | --- |
| **1. Inference privacy** | Prompts, reasoning, model outputs | Venice E2EE: *"encrypted on-device, decrypted only inside an attested TEE"*, Intel TDX on Phala. |
| **2. Policy privacy** | Your business rules | Preflight: *"policy compiled to SMT-LIB and never returned to any caller"*. |
| **3. Verification privacy** | Action contents, business data | Preflight SNARKs: verifiers see only *"`valid`, `policy_hash`, `claimed_result`, `used`, plus proof metadata"*. Never the action, never which rule fired. |

Every decision is *"sealed into a SNARK that anyone can verify cryptographically without seeing the action, the policy, or any business data."* Verification is at a public endpoint, no API key required.

### Coming: zkML (JOLT Atlas) as the fourth pillar

The ICME doc flags a forthcoming fourth pillar:

> "Action text and extracted variables stay private from ICME's pipeline at check time, once JOLT Atlas zkML proofs are integrated."

[JOLT Atlas](https://github.com/ICME-Lab/jolt-atlas) is open-source zkML software with published research; production integration is the remaining engineering work. When it lands, the trust boundary at the ICME server (see [Trust boundary](#trust-boundary) below) will be closed cryptographically rather than relying on the operator. This repo will pick that up transparently when ICME exposes it via the same `checkIt` interface, with no consumer code changes.

---

## What this gives you

Two deliverables and a worked example:

| | What it is | When to use it |
| --- | --- | --- |
| **Library** (`src/`), *deliverable* | `Guardrails` composes `VeniceClient` + `PreflightClient`. Implements the three-solver consensus convention and the attestation nonce check. | You're writing a Node agent and want to call the composition directly. |
| **MCP server** (`mcp/`), *deliverable* | Stdio MCP server exposing `venice_private_chat` and `preflight_check` tools. | You use Claude Code, Hermes, or any MCP-capable agent and want guardrails as tool calls. |
| **Example** (`examples/basic.js`), *documentation* | Worked example showing the pattern with a simulated `send_email` side effect. Replace the side effect with your real tool. | You want to see the pattern in ~100 lines before integrating. |

---

## The agent loop, in five steps

The canonical flow from the ICME doc: *"Venice E2EE inference (prompt private), attestation verification (enclave verified), Preflight check (policy private, decision cryptographically sealed), then anyone can independently verify"*:

1. **Attest the enclave.** Generate a 32-byte nonce, fetch a Venice TDX attestation bound to that nonce, refuse to continue unless `verified=true` and the nonce echoes back. (`VeniceClient.attestedChat` does this for you.)
2. **Reason privately.** Send your prompt to the E2EE model. Venice can't read it; neither can the GPU operator.
3. **Project the plan onto the policy.** Take the agent's chosen action and map it to the formal variables your policy exposes (e.g. `isRecipientOnAllowedList`, `containsPII`).
4. **Check it.** Call ICME `/v1/checkIt`. Z3 + AR + LLM each independently decide SAT/UNSAT; you get a `proof_id` on allow.
5. **Gate the side effect.** Execute the real tool only if `allowed=true`, and attach `proof_id` to your audit log.

Later, anyone holding a `proof_id` can verify it:

```bash
curl -X POST https://api.icme.io/v1/verifyProof \
  -H "Content-Type: application/json" \
  -d '{"proof_id":"<your-proof-id>"}'
# => {"valid":true,"result":"SAT","policy_hash":"...","trace_length":524288,...}
```

Single-use: the first caller consumes the proof.

---

## What a verifier learns (and what they don't)

Directly from the doc:

> "They learn that the decision was correctly computed against a specific compiled policy version, and they learn nothing else. Not the action. Not the policy. Not which rule fired."

The `verifyProof` receipt contains only `valid`, `policy_hash`, `claimed_result`, `used`, and metadata. Notably absent: *"No action text. No policy text. No business data."*

At audit time:

> "An auditor reviewing the trail later can call `verifyProof` against each `proof_id` without an API key and confirm that every tool invocation passed the policy that was active at decision time."

The `policy_hash` ties the proof to a specific policy version; the rules themselves stay hidden.

---

## Quick start

```bash
npm install
cp .env.example .env
# fill VENICE_API_KEY and ICME_API_KEY
source .env
npm run setup-policy
# paste the printed policy_id into .env as ICME_POLICY_ID
source .env
npm run example
```

You'll see something like (real output from a live run):

```
[1] Venice E2EE inference
    Model:            e2ee-venice-uncensored-24b-p
    Signing address:  0x337F14bbAeAdDfD6f7C9A0722f3D06574674C426
    Nonce match:      true
    Plan:             {"tool":"send_email","recipient":"alice@partner-corp.com","subject":"Project Summary Update","body":"...","containsPII":false}

[2] ICME Preflight check
    Z3:   SAT
    AR:   SAT
    LLM:  SAT
    Result:    ALLOW
    proof_id:  30c244d2-bb1f-4c4d-97d3-76c5e40d8485
    proof_url: https://api.icme.io/v1/proof/30c244d2-bb1f-4c4d-97d3-76c5e40d8485

[3] Gate
    Allowed. Would now call send_email(...)
    Attach proof_id=30c244d2-... to your audit log.
```

---

## Use as a library

```js
import { VeniceClient, PreflightClient, Guardrails } from "venice-agent-guardrails";

const venice    = new VeniceClient({ apiKey: process.env.VENICE_API_KEY });
const preflight = new PreflightClient({
  apiKey:   process.env.ICME_API_KEY,
  policyId: process.env.ICME_POLICY_ID,
});
const guardrails = new Guardrails({ venice, preflight });

// 1. Reason privately on Venice.
const reasoning = await guardrails.privateReason({
  messages: [{ role: "user", content: "Email the Q3 summary to alice@partner-corp.com" }],
});

// 2. Project the agent's plan onto the policy's variables and check it.
const decision = await guardrails.checkAction({
  action: "agent intends to call send_email; isRecipientOnAllowedList is true; containsPII is false",
  values: { isRecipientOnAllowedList: true, containsPII: false },
});

if (!decision.allowed) throw new Error("blocked by policy");

// 3. Do the side effect, attach decision.proofId to your audit record.
await sendEmail(/* ... */);
auditLog.append({ proofId: decision.proofId, action: "send_email" });
```

The `Guardrails.guardedAction({ messages, project })` helper bundles steps 1 and 2 into one call. See `src/guardrails.js`.

For third-party verification of a `proof_id` (no API key needed):

```js
import { PreflightClient } from "venice-agent-guardrails";
const receipt = await PreflightClient.verifyProof(proofId);
// { valid: true, result: "SAT", policy_hash: "...", used: true, ... }
```

---

## Use as an MCP server

Add to your MCP config (e.g. `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "venice-guardrails": {
      "command": "node",
      "args": ["/abs/path/to/venice-agent-guardrails/mcp/server.js"],
      "env": {
        "VENICE_API_KEY": "...",
        "ICME_API_KEY":   "...",
        "ICME_POLICY_ID": "..."
      }
    }
  }
}
```

Your MCP agent now has two tools:

- `venice_private_chat({ messages, ... })`: TDX-attested E2EE chat completion.
- `preflight_check({ action, values })`: three-solver policy check, returns `proof_id` on allow.

The recommended agent loop:

1. Call `venice_private_chat` to decide the next tool call.
2. Call `preflight_check` with the resulting action.
3. Only execute the side-effecting tool if `allowed` is true; record `proof_id`.

---

## How the policy works

Write rules in plain English in `scripts/setup-policy.js`, then run `npm run setup-policy`. ICME compiles them to SMT-LIB and gives you back a `policy_id`. The compiled policy exposes formal variables (e.g. `isRecipientOnAllowedList`, `containsPII`, `agentAuthorizationScope`) that your agent supplies on each check.

**Keep the policy text terse.** ICME's LLM extraction step at check time has a context budget (~8k tokens). A multi-clause policy compiles fine but can exceed that at extraction time and fail with `LLM_ERROR: Prompt too long`. The shipped example policy is three "Never X..." sentences for that reason.

**Use the policy's exact variable names in the action string.** Write `isRecipientOnAllowedList is true`, not "the recipient is allowed". The Automated Reasoning layer fails closed on names it can't translate. If you have the structured values already, pass them as `values: { ... }` and the check is deterministic.

---

## Three-solver consensus

Every `/v1/checkIt` call runs three independent verifications:

| Outcome | Decision |
| --- | --- |
| All three SAT | ALLOW |
| AR uncertain or fail-closed, Z3 + LLM SAT | ALLOW (defense-in-depth) |
| Any solver UNSAT | DENY |

`PreflightClient.isAllowed(rawResult)` implements this convention.

---

## Trust boundary

Be honest about what the cryptography does and does not cover today. From the ICME doc:

> "ICME's server sees the plain-English policy at `/v1/makeRules` submission time and the plain-English action at `/v1/checkIt` time. The cryptographic guarantees protect downstream verifiers, not the compile-time and check-time submission paths."

Translated: at policy-compile time and at each check, ICME's server processes your inputs in plaintext. The SNARK protects everyone *downstream* of the decision (your counterparties, your auditor, the public), but not the moment of submission itself.

JOLT Atlas zkML (above) is the planned upgrade that closes this boundary.

For the inference half, Venice E2EE + TDX attestation means the prompt is plaintext only inside the attested enclave; the model host (Venice), the GPU operator (Phala), and any network observer see only ciphertext. The attestation nonce binding (handled in `VeniceClient.attestedChat`) prevents replayed enclave quotes.

---

## What's real vs. simulated

| Component | Status |
| --- | --- |
| Venice E2EE chat completion | **Real**. Live `POST /v1/chat/completions` against an `supportsE2EE: true` model. |
| Venice TDX attestation | **Real**. `GET /v1/tee/attestation` with on-request nonce binding, verified client-side. |
| ICME policy compilation | **Real**. `POST /v1/makeRules` returns a real `policy_id`. |
| ICME three-solver check | **Real**. `POST /v1/checkIt` runs Z3, AR, and LLM; returns real `proof_id` + `proof_url`. |
| ICME public proof verification | **Real**. `POST /v1/verifyProof` verifies `proof_id` with no API key (single-use). |
| zkML (JOLT Atlas) protection of action text at check time | **Forthcoming**. On ICME's roadmap; will be picked up transparently when exposed. |
| Side effects in `examples/basic.js` | **Simulated**. `send_email` just prints. Wire your real tool in once you've adopted the pattern. |

There is intentionally no payment or on-chain code in this repo. The pattern is "guardrails for any side effect"; payments are one possible side effect.

---

## API references

- **Venice**: [docs.venice.ai/api-reference/api-spec](https://docs.venice.ai/api-reference/api-spec) · [TEE & E2EE guide](https://docs.venice.ai/overview/guides/tee-e2ee-models) · [E2EE launch post](https://venice.ai/blog/venice-launches-end-to-end-encrypted-ai)
- **ICME**: [docs.icme.io](https://docs.icme.io) · [Venice AI + Preflight](https://docs.icme.io/documentation/privacy-and-data-security/venice-ai-+-preflight) · [JOLT Atlas (zkML)](https://github.com/ICME-Lab/jolt-atlas)

## Built in Venice submission

A ready-to-PR entry for [builtinvenice.ai](https://builtinvenice.ai) lives
in [`submission/`](./submission/). Copy
`submission/hshadab-venice-agent-guardrails.yaml` into
`content/projects/` of a fork of
[`veniceai/builtinvenice`](https://github.com/veniceai/builtinvenice) and
open a PR.

## License

MIT.
