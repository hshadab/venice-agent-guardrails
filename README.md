# venice-agent-guardrails

**Composes Venice E2EE chat with an [ICME Preflight](https://docs.icme.io) policy check — returns a verifiable proof per agent action.**

Drop-in library and MCP server. The added value is the *composition* (consensus convention, attestation nonce binding, policy-variable projection, MCP wrapping); the two underlying API clients are a means to that end.

- **Inference stays private** — Venice E2EE means prompts are decrypted only inside a TDX-attested enclave. Even Venice can't read them.
- **Policy stays private** — your rules compile to SMT-LIB and live on Preflight's side. Counterparties only see allow/deny, never the policy itself.
- **Decisions stay verifiable** — every check returns a `proof_id` that any third party can verify with zero API credentials by `POST`ing `{ "proof_id": "..." }` to `https://api.icme.io/v1/verifyProof`. Verification is single-use: the first caller consumes the proof.

> Reference for the composition pattern: [Venice AI + Preflight](https://docs.icme.io/documentation/privacy-and-data-security/venice-ai-+-preflight).

---

## What this gives you

Two deliverables and a worked example:

| | What it is | When to use it |
| --- | --- | --- |
| **Library** (`src/`) — *deliverable* | `Guardrails` composes `VeniceClient` + `PreflightClient`. Implements the three-solver consensus convention and attestation nonce check. | You're writing a Node agent and want to call the composition directly. |
| **MCP server** (`mcp/`) — *deliverable* | Stdio MCP server exposing `venice_private_chat` and `preflight_check` tools. | You use Claude Code, Hermes, or any MCP-capable agent and want guardrails as tool calls. |
| **Example** (`examples/basic.js`) — *documentation* | Worked example showing the pattern with a simulated `send_email` side effect. Replace the side effect with your real tool. | You want to see the pattern in ~100 lines before integrating. |

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

Anyone can verify that proof_id later, without an API key, by:

```bash
curl -X POST https://api.icme.io/v1/verifyProof \
  -H "Content-Type: application/json" \
  -d '{"proof_id":"30c244d2-bb1f-4c4d-97d3-76c5e40d8485"}'
# => {"valid":true,"result":"SAT","policy_hash":"...","trace_length":524288,...}
```

(Verification is single-use; the first caller consumes the proof.)

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

The `Guardrails.guardedAction({ messages, project })` helper bundles steps 1 and 2 into one call — see `src/guardrails.js`.

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

- `venice_private_chat({ messages, ... })` — TDX-attested E2EE chat completion.
- `preflight_check({ action, values })` — three-solver policy check, returns `proof_id` on allow.

The recommended agent loop:

1. Call `venice_private_chat` to decide the next tool call.
2. Call `preflight_check` with the resulting action.
3. Only execute the side-effecting tool if `allowed` is true; record `proof_id`.

---

## How the policy works

Write rules in plain English in `scripts/setup-policy.js`, then run `npm run setup-policy`. ICME compiles them to SMT-LIB and gives you back a `policy_id`. The compiled policy exposes formal variables (e.g. `isRecipientOnAllowedList`, `containsPII`, `agentAuthorizationScope`) that your agent supplies on each check.

**Important:** when you write the `action` string, use the policy's exact variable names — e.g. `isRecipientOnAllowedList is true` — not natural-language paraphrases. ICME's Automated Reasoning layer fails closed on names it can't translate. If you already have the structured values, pass them as `values: { ... }` and the check is deterministic.

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

## What's real vs. simulated

| Component | Status |
| --- | --- |
| Venice E2EE chat completion | **Real** — live `POST /v1/chat/completions` against an `supportsE2EE: true` model. |
| Venice TDX attestation | **Real** — `GET /v1/tee/attestation` with on-request nonce binding. |
| ICME policy compilation | **Real** — `POST /v1/makeRules` returns a real `policy_id`. |
| ICME three-solver check | **Real** — `POST /v1/checkIt` runs Z3, AR, and LLM; returns real `proof_id` + `proof_url`. |
| ICME public proof verification | **Real** — `POST /v1/verifyProof` verifies `proof_id` with no API key (single-use). |
| Side effects in `examples/basic.js` | **Simulated** — `send_email` just prints. Wire your real tool in once you've adopted the pattern. |

There is intentionally no payment or on-chain code in this repo. The pattern is "guardrails for any side effect"; payments are one possible side effect.

---

## API references

- **Venice** — [docs.venice.ai/api-reference/api-spec](https://docs.venice.ai/api-reference/api-spec) · [TEE & E2EE guide](https://docs.venice.ai/overview/guides/tee-e2ee-models) · [E2EE launch post](https://venice.ai/blog/venice-launches-end-to-end-encrypted-ai)
- **ICME** — [docs.icme.io](https://docs.icme.io) · [Venice AI + Preflight](https://docs.icme.io/documentation/privacy-and-data-security/venice-ai-+-preflight)

## Built in Venice submission

A ready-to-PR entry for [builtinvenice.ai](https://builtinvenice.ai) lives
in [`submission/`](./submission/). Copy
`submission/hshadab-venice-agent-guardrails.yaml` into
`content/projects/` of a fork of
[`veniceai/builtinvenice`](https://github.com/veniceai/builtinvenice) and
open a PR.

## License

MIT.
