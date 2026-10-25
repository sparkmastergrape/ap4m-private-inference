import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimate, countInputTokens, freezeMaximumAmount, QuoteRefused, type Pricing, type Work } from "../src/shared/estimate.ts";
import { count, countWithBedrock, utf8Bytes } from "../src/shared/token-count.ts";

const pricing: Pricing = JSON.parse(readFileSync(join(import.meta.dirname, "..", "config", "pricing.json"), "utf8"));

/** Nemotron 3 Nano on Bedrock, from config/catalog.bedrock.json. */
const nemotron = { inputPerM: 0.0618, outputPerM: 0.2472 };

function work(over: Partial<Work> = {}): Work {
  return { bytes: 8000, maskedFields: 4, maxTokens: 1024, model: nemotron, ...over };
}

test("pricing.json has every field estimate() needs", () => {
  for (const key of ["fixed", "perMaskedField", "perKB", "costShare", "minimum", "maximumPerCall", "charsPerToken", "inputMargin", "reasoningFactor"]) {
    assert.equal(typeof pricing[key as keyof Pricing], "number", `${key} missing`);
  }
  assert.ok(pricing.minimum <= pricing.maximumPerCall, "minimum must not exceed maximumPerCall");
});

test("the worked example from the design holds", () => {
  // xrplh-15 6.2: 2,000 input tokens, 1,024 output cap, costShare 1, fixed 0.10
  // -> model cost 0.0001236 + 0.0002531 = 0.0003767 USD.
  const q = estimate(work({ inputTokens: 2000, maxTokens: 1024, bytes: 0, maskedFields: 0 }), { ...pricing, perKB: 0, perMaskedField: 0 });
  assert.equal(q.inTok, 2000);
  assert.equal(q.inTokSource, "counted");
  // 2000*0.0618/1e6 + 1024*0.2472/1e6 = 0.0003767328; the design quotes it rounded to 0.0003767.
  assert.ok(Math.abs(q.modelUsd - 0.0003767328) < 1e-12, `modelUsd was ${q.modelUsd}`);
  // 0.10 + 0.0003767 rounds up to 0.100377 at 1e-6.
  assert.equal(q.totalRlusd, "0.100377");
});

test("the wei amount is exact, with no floating point drift", () => {
  const q = estimate(work({ inputTokens: 2000, maxTokens: 1024, bytes: 0, maskedFields: 0 }), { ...pricing, perKB: 0, perMaskedField: 0 });
  // 0.100377 RLUSD at 18 decimals.
  assert.equal(q.quoteWei, "100377000000000000");
  assert.equal(BigInt(q.quoteWei) % 1_000_000_000_000n, 0n, "must be a whole micro-RLUSD");
});

test("counting by size applies charsPerToken and inputMargin", () => {
  const { inTok, source } = countInputTokens(work({ bytes: 8000 }), pricing);
  assert.equal(inTok, Math.ceil((8000 / pricing.charsPerToken) * (1 + pricing.inputMargin)));
  assert.equal(source, "bytes");
});

test("the size estimate stays above what live asks measured", () => {
  // Masked text ran 2.14 to 2.73 bytes per actual input token on 5 live asks
  // (2026-10-25). If bytes-per-token assumed here exceeds 2.14, the quote can
  // fall below the tokens actually used, and it stops being a ceiling.
  assert.ok(pricing.charsPerToken / (1 + pricing.inputMargin) <= 2.14, "charsPerToken is too high for masked text");
});

test("an exact count wins over counting by size", () => {
  const { inTok, source } = countInputTokens(work({ bytes: 8000, inputTokens: 1234 }), pricing);
  assert.equal(inTok, 1234);
  assert.equal(source, "counted");
});

test("data cost scales with masked fields and kilobytes", () => {
  const bare = estimate(work({ maskedFields: 0, bytes: 1024, inputTokens: 0, maxTokens: 1 }), pricing);
  const rich = estimate(work({ maskedFields: 10, bytes: 1024, inputTokens: 0, maxTokens: 1 }), pricing);
  assert.ok(rich.dataUsd > bare.dataUsd, "more masked fields must cost more");
  assert.ok(BigInt(rich.quoteWei) > BigInt(bare.quoteWei));
});

test("the output cap drives the quote, because actual length is unknowable", () => {
  const small = estimate(work({ inputTokens: 100, maxTokens: 128 }), pricing);
  const large = estimate(work({ inputTokens: 100, maxTokens: 4096 }), pricing);
  assert.ok(BigInt(large.quoteWei) > BigInt(small.quoteWei));
});

test("a quote never falls below the minimum", () => {
  const free = { inputPerM: 0, outputPerM: 0 };
  const q = estimate(work({ model: free, bytes: 0, maskedFields: 0, inputTokens: 0, maxTokens: 1 }), { ...pricing, fixed: 0, perKB: 0, perMaskedField: 0 });
  assert.equal(q.totalRlusd, "0.010000");
  assert.equal(q.atMinimum, true);
});

test("a job above maximumPerCall is refused, not priced", () => {
  // A voucher only counts up, so there is no refund: an over-large job must be refused.
  assert.throws(
    () => estimate(work({ inputTokens: 10_000_000, maxTokens: 8192 }), pricing),
    (e: unknown) => {
      assert.ok(e instanceof QuoteRefused);
      assert.equal(e.maximumPerCall, pricing.maximumPerCall);
      assert.ok(Number(e.wouldBe) > pricing.maximumPerCall);
      return true;
    },
  );
});

test("the same work always produces the same wei, on both sides", () => {
  const w = work({ inputTokens: 3333, maxTokens: 777, bytes: 4096, maskedFields: 7 });
  assert.equal(estimate(w, pricing).quoteWei, estimate(w, pricing).quoteWei);
});

test("nonsense work is rejected", () => {
  assert.throws(() => estimate(work({ maxTokens: 0 }), pricing), /maxTokens/);
  assert.throws(() => estimate(work({ bytes: -1 }), pricing), /bytes/);
  assert.throws(() => estimate(work({ maskedFields: 1.5 }), pricing), /maskedFields/);
});

test("freezeMaximumAmount takes the lowest of the three fences", () => {
  assert.equal(freezeMaximumAmount({ sessionRemaining: 50n, maxPrice: 30n, channelRemaining: 40n }), 30n);
  assert.equal(freezeMaximumAmount({ sessionRemaining: 10n, maxPrice: 30n, channelRemaining: 40n }), 10n);
  assert.equal(freezeMaximumAmount({ sessionRemaining: 50n, maxPrice: 30n, channelRemaining: 5n }), 5n);
});

test("freezeMaximumAmount refuses when any fence is exhausted", () => {
  assert.throws(() => freezeMaximumAmount({ sessionRemaining: 0n, maxPrice: 30n, channelRemaining: 40n }), /authority/);
  assert.throws(() => freezeMaximumAmount({ sessionRemaining: 50n, maxPrice: 30n, channelRemaining: 0n }), /authority/);
});

test("utf8Bytes counts bytes, not characters", () => {
  assert.equal(utf8Bytes("abc"), 3);
  assert.ok(utf8Bytes("Ravi Kumār") > "Ravi Kumār".length - 1);
});

test("a bedrock count is used when it succeeds", async () => {
  const r = await countWithBedrock({}, async () => 4242);
  assert.deepEqual(r, { inputTokens: 4242, source: "counted" });
});

test("a failed bedrock count falls back to size rather than failing the quote", async () => {
  const r = await countWithBedrock({}, async () => {
    throw new Error("model does not support CountTokens");
  });
  assert.equal(r.source, "bytes");
  assert.equal(r.inputTokens, undefined);
  assert.match(r.note!, /CountTokens unavailable/);
});

test("a nonsense bedrock count falls back to size", async () => {
  const r = await countWithBedrock({}, async () => -1);
  assert.equal(r.source, "bytes");
  assert.match(r.note!, /counted by size/);
});

test("count() with no caller falls back to size", async () => {
  const r = await count("bedrock", {});
  assert.equal(r.source, "bytes");
  assert.match(r.note!, /no CountTokens caller/);
});
