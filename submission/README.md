# Submitting to Built in Venice

This folder contains the entry to submit to
[`veniceai/builtinvenice`](https://github.com/veniceai/builtinvenice).

## Pull-request path

1. Fork `veniceai/builtinvenice`.
2. Copy `hshadab-venice-agent-guardrails.yaml` to
   `content/projects/hshadab-venice-agent-guardrails.yaml` in your fork.
   - One file per submission. Do not edit anything in `src/`.
3. Open a PR with a single entry.
4. Reviewers (Sabrina Aquino or Josh Meyer) merge.

Reference: [`CONTRIBUTING.md`](https://github.com/veniceai/builtinvenice/blob/main/CONTRIBUTING.md).

## Form path (alternative)

Open the [Project submission form](https://github.com/veniceai/builtinvenice/issues/new?template=submit-project.yml&title=%5BProject%5D+)
and paste the field values from the YAML.

## Field notes

- **`category: ecosystem`** — this is a primitive other Venice builders
  compose with, not an app. Matches `teep`, `venice-e2ee`,
  `venice-e2ee-proxy`, `venicestats-mcp`.
- **Tags** are drawn from the existing tag pool used by similar entries.
  `Privacy` and `TEE` align with `teep`; `MCP` aligns with
  `venicestats-mcp` and `VVVKernel`; `Agent` aligns with `Hermes OS` and
  `VeniceGuard`; `Library` aligns with `venice-e2ee`.
- **Description** is ~210 characters and leads with the composition verb
  ("Composes …") so reviewers see the added functionality, not the API
  wrappers underneath.
- **No `stars` / `forks`** — left out per CONTRIBUTING: *"optional; leave
  out if you don't know."* The maintainer's `npm run refresh-projects`
  step will populate them and pre-bake the repo OG image.
- **No `thumbnail`** — same reason; the GitHub OG image is auto-baked
  for GitHub Repo entries.
