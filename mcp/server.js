#!/usr/bin/env node
// MCP server exposing the guardrails as tools to any MCP-compatible agent
// (Claude Code, Hermes, etc.).
//
// Drop into your MCP config, e.g. ~/.claude/mcp.json:
//
//   {
//     "mcpServers": {
//       "venice-guardrails": {
//         "command": "node",
//         "args": ["/abs/path/to/venice-agent-guardrails/mcp/server.js"],
//         "env": {
//           "VENICE_API_KEY": "...",
//           "ICME_API_KEY":   "...",
//           "ICME_POLICY_ID": "..."
//         }
//       }
//     }
//   }
//
// Tools exposed:
//   - venice_private_chat   Run an E2EE chat completion on Venice (TDX-attested).
//   - preflight_check       Check an action against the ICME policy; returns
//                           SAT/UNSAT + zk_proof_id.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VeniceClient, PreflightClient } from "../src/index.js";

const {
  VENICE_API_KEY,
  ICME_API_KEY,
  ICME_POLICY_ID,
  VENICE_BASE_URL,
  ICME_BASE_URL,
  VENICE_E2EE_MODEL,
} = process.env;

for (const [k, v] of Object.entries({ VENICE_API_KEY, ICME_API_KEY, ICME_POLICY_ID })) {
  if (!v) {
    console.error(`venice-agent-guardrails MCP: missing ${k}`);
    process.exit(1);
  }
}

const venice = new VeniceClient({
  apiKey: VENICE_API_KEY,
  baseUrl: VENICE_BASE_URL,
  model: VENICE_E2EE_MODEL,
});
const preflight = new PreflightClient({
  apiKey: ICME_API_KEY,
  baseUrl: ICME_BASE_URL,
  policyId: ICME_POLICY_ID,
});

const server = new Server(
  { name: "venice-agent-guardrails", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "venice_private_chat",
      description:
        "Run a chat completion on Venice with end-to-end encryption and TDX " +
        "attestation. Use this for any reasoning step you want hidden from " +
        "Venice (or anyone else). Returns the message content plus the " +
        "attestation signing address and nonce match.",
      inputSchema: {
        type: "object",
        required: ["messages"],
        properties: {
          messages: {
            type: "array",
            description: "OpenAI-compatible chat messages.",
            items: {
              type: "object",
              required: ["role", "content"],
              properties: {
                role: { type: "string", enum: ["system", "user", "assistant"] },
                content: { type: "string" },
              },
            },
          },
          temperature: { type: "number" },
          max_tokens: { type: "integer" },
        },
      },
    },
    {
      name: "preflight_check",
      description:
        "Check a proposed agent action against the configured ICME policy. " +
        "Three independent solvers (Z3, Automated Reasoning, LLM) verify the " +
        "action; on SAT a SNARK proof_id is returned that anyone can verify " +
        "without an API key. Call this BEFORE executing any side effect.",
      inputSchema: {
        type: "object",
        required: ["action"],
        properties: {
          action: {
            type: "string",
            description:
              "Natural-language action string using the policy's exact " +
              "variable names, e.g. " +
              "\"agent intends to call send_email; isRecipientOnAllowedList is true; containsPII is false\".",
          },
          values: {
            type: "object",
            description:
              "Optional structured policy variables. Bypasses LLM extraction " +
              "and makes the check deterministic.",
            additionalProperties: true,
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  if (name === "venice_private_chat") {
    const r = await venice.attestedChat({
      messages: args.messages,
      temperature: args.temperature,
      maxTokens: args.max_tokens,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              content: r.content,
              attestation: {
                signing_address: r.attestation.signingAddress,
                nonce_match: r.attestation.nonceMatch,
              },
              model: r.model,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === "preflight_check") {
    const raw = await preflight.checkIt({ action: args.action, values: args.values });
    const allowed = PreflightClient.isAllowed(raw);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              allowed,
              result: raw.result,
              proof_id: raw.proof_id ?? null,
              proof_url: raw.proof_url ?? null,
              z3: raw.z3_result,
              ar: raw.ar_result,
              llm: raw.llm_result,
              ar_detail: raw.ar_detail,
            },
            null,
            2
          ),
        },
      ],
      isError: !allowed,
    };
  }

  return {
    content: [{ type: "text", text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
