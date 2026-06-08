import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLastSseJson, parseSseJsonEvents } from "../src/sse.js";

test("parseLastSseJson returns the final data event", () => {
  const body = [
    'data: {"step":"start"}',
    "",
    'data: {"step":"done","result":"SAT","proof_id":"abc"}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const out = parseLastSseJson(body);
  assert.equal(out.result, "SAT");
  assert.equal(out.proof_id, "abc");
});

test("parseLastSseJson tolerates a trailing [DONE] marker", () => {
  const body = 'data: {"ok":true}\n\ndata: [DONE]\n\n';
  assert.deepEqual(parseLastSseJson(body), { ok: true });
});

test("parseLastSseJson falls back to whole-body JSON", () => {
  assert.deepEqual(parseLastSseJson('{"plain":1}'), { plain: 1 });
});

test("parseLastSseJson throws on unparseable input", () => {
  assert.throws(() => parseLastSseJson("not json at all"), /could not parse/);
});

test("parseSseJsonEvents returns all payloads in stream order", () => {
  const body = [
    'data: {"i":1}',
    "",
    ": heartbeat comment",
    "",
    'data: {"i":2}',
    "",
    "data: [DONE]",
  ].join("\n");
  const events = parseSseJsonEvents(body);
  assert.deepEqual(events, [{ i: 1 }, { i: 2 }]);
});

test("parseSseJsonEvents returns [] for empty input", () => {
  assert.deepEqual(parseSseJsonEvents(""), []);
  assert.deepEqual(parseSseJsonEvents(null), []);
});
