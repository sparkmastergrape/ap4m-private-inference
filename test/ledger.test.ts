import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FORBIDDEN_LEDGER_FIELDS, Ledger, assertNoText, type RedemptionEntry, type SettlementEntry } from "../src/shared/ledger.ts";

const channelId = `0x${"6d".repeat(32)}`;
const claimId = `0x${"32".repeat(32)}`;

const redemption: RedemptionEntry = {
  ts: "2026-10-25T08:00:00.000Z",
  kind: "redemption",
  channelId,
  jobId: "job-1",
  agent: "0x37F2F4166646Ea3cea94BB37BaBD88a01F52A7A2",
  claimId,
  redeemTx: `0x${"5e".repeat(32)}`,
  amountWei: "104758000000000000",
  cumulativeWei: "805682000000000000",
  quote: { inTok: 700, outTok: 300, maskedFields: 9 },
  actual: { promptTokens: 650, completionTokens: 40, totalTokens: 690 },
  model: "cohere/north-mini-code:free",
  maskedFields: 9,
};

const settlement: SettlementEntry = {
  ts: "2026-10-25T08:41:21.221Z",
  kind: "settlement",
  channelId,
  claimId,
  amountWei: "104758000000000000",
  settleTx: `0x${"26".repeat(32)}`,
  receiptUrl: "https://hackathon.ap4m.build/public/evidence/claims/x/y.json",
  status: "settled",
};

test("a ledger with no directory is disabled and writes nothing", () => {
  const ledger = new Ledger(undefined);
  assert.equal(ledger.enabled, false);
  ledger.write(redemption);
  assert.equal(ledger.claimsWithLine("redemption").size, 0);
});

test("lines go to a daily file named for the entry date, one JSON object per line", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ledger-")), "nested");
  const ledger = new Ledger(dir);
  ledger.write(redemption);
  ledger.write(settlement);
  assert.deepEqual(readdirSync(dir), ["payments-2026-10-25.jsonl"]);
  const lines = readFileSync(join(dir, "payments-2026-10-25.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.kind), ["redemption", "settlement"]);
  assert.equal(lines[0].claimId, lines[1].claimId, "redemption and settlement join on claimId");
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "payments-2026-10-25.jsonl")).mode & 0o777, 0o600);
});

test("claimsWithLine reports only the requested kind and survives a torn line", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  const ledger = new Ledger(dir);
  ledger.write(redemption);
  assert.deepEqual([...ledger.claimsWithLine("redemption")], [claimId]);
  assert.equal(ledger.claimsWithLine("settlement").size, 0);
  ledger.write(settlement);
  assert.deepEqual([...ledger.claimsWithLine("settlement")], [claimId]);
  // A crash mid-append leaves half a line; the next read must not throw.
  const file = join(dir, "payments-2026-10-25.jsonl");
  const { appendFileSync } = require_fs();
  appendFileSync(file, '{"kind":"settlement","claimId":"0x');
  assert.deepEqual([...ledger.claimsWithLine("settlement")], [claimId]);
});

test("real entries carry no text field", () => {
  assert.doesNotThrow(() => assertNoText(redemption));
  assert.doesNotThrow(() => assertNoText(settlement));
});

test("every forbidden field name is refused, at any depth", () => {
  for (const field of FORBIDDEN_LEDGER_FIELDS) {
    assert.throws(() => assertNoText({ ...redemption, [field]: "x" }), /must never be written/, field);
    assert.throws(() => assertNoText({ ...redemption, quote: { nested: { [field]: "x" } } }), /must never be written/, `nested ${field}`);
  }
});

function require_fs(): typeof import("node:fs") {
  // node:fs is already imported above for reads; appendFileSync is needed once.
  return process.getBuiltinModule("node:fs");
}
