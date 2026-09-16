"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { validate, parse, safeTree, LIMITS } = require("..");
const fixture = require("../fixtures/decision-intent.json");

test("shared UTF-8 fixture round-trips without changing signed input text", () => {
  const text = JSON.stringify(fixture);
  assert.deepEqual(parse("decisionIntent", text), { ok: true, value: fixture });
  assert.equal(fixture.answers.q1, "中文🚀\n下一行");
});

test("unknown versions, action aliases and injected protocol output are rejected", () => {
  assert.equal(validate("decisionIntent", { ...fixture, protocolVersion: 2 }).error, "upgrade_required");
  for (const patch of [
    { optionId: "execute" }, { optionId: "allow " }, { optionId: "no-decision" },
    { expectedRevision: "1" }, { bindingRevision: 0 }, { shell: "echo injected" },
    { nativeMeta: {} }, { toolInput: {} }, { hookSpecificOutput: {} },
    { pcId: "../other" }, { pcSessionEpoch: "old" }, { approvalContextDigest: "sha256:bad" },
  ]) assert.equal(validate("decisionIntent", { ...fixture, ...patch }).ok, false);
});

test("parse rejects malformed JSON, oversized multibyte text and nesting", () => {
  assert.equal(parse("decisionIntent", "{").error, "invalid_json");
  const many = { ...fixture, answers: Object.fromEntries(Array.from({ length: 10 }, (_, i) => ["q" + i, "中".repeat(1000)])) };
  assert.ok(JSON.stringify(many).length < LIMITS.controlBytes);
  assert.equal(parse("decisionIntent", JSON.stringify(many)).error, "too_large");
  let nested = {};
  for (let i = 0; i < 20; i++) nested = { child: nested };
  assert.equal(safeTree(nested), false);
});

test("dangerous keys, non-record objects, cycles and getters cannot reach validators", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    const value = JSON.parse(JSON.stringify(fixture));
    value.answers = JSON.parse('{"' + key + '":"x"}');
    assert.equal(validate("decisionIntent", value).ok, false);
  }
  const cycle = {}; cycle.self = cycle;
  assert.equal(safeTree(cycle), false);
  assert.equal(safeTree(new Date()), false);
  assert.equal(safeTree({ get value() { throw Error("must not run"); } }), false);
  assert.equal(safeTree({ value: "\ud800" }), false);
});

test("dates and scalar limits are strict; no type coercion or answer truncation", () => {
  for (const patch of [
    { issuedAt: "2026-02-30T09:00:35.000Z" },
    { expiresAt: fixture.issuedAt }, { issuedAt: "2026-09-16T09:00:35Z" },
    { answers: { q1: "a".repeat(2001) } }, { answers: { q1: Array(21).fill("a") } },
    { answers: { q1: [] } }, { answers: { q1: true } },
    { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(validate("decisionIntent", { ...fixture, ...patch }).ok, false);
});

test("shipped validators have no Electron, Node, dynamic eval or Ajv dependency", () => {
  const generated = readFileSync(require.resolve("../generated/validators"), "utf8");
  assert.doesNotMatch(generated, /require\(|new Function\(|eval\(/);
  const source = readFileSync(require.resolve("../src/index"), "utf8");
  assert.doesNotMatch(source, /node:|electron|\bBuffer\b|\bprocess\./);
});
