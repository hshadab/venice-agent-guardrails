import { test } from "node:test";
import assert from "node:assert/strict";
import { PreflightClient } from "../src/preflight.js";

const { isAllowed } = PreflightClient;

test("null / missing result is denied (fail-closed)", () => {
  assert.equal(isAllowed(null), false);
  assert.equal(isAllowed(undefined), false);
  assert.equal(isAllowed({}), false);
});

test("top-level SAT is allowed", () => {
  assert.equal(isAllowed({ result: "SAT" }), true);
  assert.equal(isAllowed({ result: "sat" }), true);
});

test("top-level UNSAT / BLOCKED is denied", () => {
  assert.equal(isAllowed({ result: "UNSAT" }), false);
  assert.equal(isAllowed({ result: "BLOCKED" }), false);
});

test("per-solver consensus: Z3+LLM SAT with AR sat/uncertain/fail-closed is allowed", () => {
  assert.equal(isAllowed({ z3_result: "SAT", llm_result: "SAT", ar_result: "sat" }), true);
  assert.equal(isAllowed({ z3_result: "SAT", llm_result: "SAT", ar_result: "uncertain" }), true);
  assert.equal(isAllowed({ z3_result: "SAT", llm_result: "SAT", ar_result: "fail-closed" }), true);
});

test("empty / missing AR result is denied even when Z3+LLM are SAT (fail-closed)", () => {
  assert.equal(isAllowed({ z3_result: "SAT", llm_result: "SAT", ar_result: "" }), false);
  assert.equal(isAllowed({ z3_result: "SAT", llm_result: "SAT" }), false);
});

test("any UNSAT solver denies via consensus", () => {
  assert.equal(isAllowed({ z3_result: "UNSAT", llm_result: "SAT", ar_result: "sat" }), false);
  assert.equal(isAllowed({ z3_result: "SAT", llm_result: "UNSAT", ar_result: "sat" }), false);
});

test("unrecognized top-level status is denied (fail-closed)", () => {
  assert.equal(isAllowed({ result: "MAYBE" }), false);
});
