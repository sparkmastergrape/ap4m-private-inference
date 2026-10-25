/**
 * The agent rail and the paid-inference tool.
 *
 * These cover what does not need the chain: pricing a job against a merchant,
 * every local limit that refuses before anything is signed, the X-CHAINAIM-JOB
 * header the merchant can only be addressed through (section 0.4), the budget
 * ledger, and the tool's input and output shapes. The purchase itself is
 * injected, so the real on-chain redemption is proved by a live paid ask rather
 * than mocked here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RailRefused, createRail } from "../src/agent/rail.ts";
import { TOOL_SPEC, makeToolHandler, operationNamer } from "../src/agent/tool.ts";

const CHANNEL = `0x${"ab".repeat(32)}`;
const WEI = 10n ** 18n;

function dir(): string {
  return mkdtempSync(join(tmpdir(), "ap4m-agent-"));
}

/** A merchant that prices every job the same, and can be told to refuse. */
async function fakeMerchant(options: { amount?: string; status?: number; error?: string } = {}) {
  const seen: { path: string; headers: Record<string, string>; body: string }[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    seen.push({ path: req.url ?? "", headers: req.headers as Record<string, string>, body });

    if (req.url === "/jobs" && req.method === "POST") {
      if (options.status && options.status !== 201) {
        res.writeHead(options.status, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: options.error ?? "refused" }));
      }
      const amount = options.amount ?? "103593000000000000";
      res.writeHead(201, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({ jobId: "job-1", amount, maximumAmount: amount, rlusd: "0.103593", breakdown: { inTok: 40 }, expiresAt: 4_000_000_000 }),
      );
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

/** A purchase that succeeds without a chain, and records how it was called. */
function fakeBuy(capture: { args?: Record<string, unknown> } = {}) {
  return async (args: Record<string, unknown>) => {
    capture.args = args;
    return {
      operation: args.operation as string,
      claimId: `0x${"cc".repeat(32)}`,
      transactionHash: `0x${"dd".repeat(32)}`,
      redemption: "Confirmed",
      resource: { answer: "three patients", model: "stub", truncated: false },
    };
  };
}

function railOn(merchantBase: string, overrides: Record<string, unknown> = {}) {
  return createRail({
    context: {} as never,
    provider: {} as never,
    wallet: {} as never,
    resourceUrl: `${merchantBase}/resource`,
    merchantBaseUrl: merchantBase,
    channelId: CHANNEL,
    stateDirectory: dir(),
    buyImpl: fakeBuy() as never,
    ...overrides,
  } as never);
}

// ── quoting ───────────────────────────────────────────────────────────────────

test("the rail prices a job through the merchant without signing anything", async () => {
  const merchant = await fakeMerchant();
  try {
    const rail = railOn(merchant.base);
    const quote = await rail.quote({ request: { messages: [] }, maskedFields: 7, maxTokens: 256, operation: "q" });
    assert.equal(quote.amount, "103593000000000000");
    assert.equal(quote.maximumAmount, quote.amount, "the authority is the quote, fixed with the job (section 0.3)");
    assert.equal(quote.rlusd, "0.103593");

    const staged = JSON.parse(merchant.seen[0].body) as Record<string, never>;
    assert.equal(staged.channelId, CHANNEL);
    assert.equal(staged.maskedFields, 7);
    assert.equal(staged.maxTokens, 256);
  } finally {
    await merchant.close();
  }
});

test("a merchant refusal is reported with its reason, not swallowed", async () => {
  const merchant = await fakeMerchant({ status: 400, error: "quote_refused" });
  try {
    await assert.rejects(() => railOn(merchant.base).quote({ request: {}, operation: "q" }), (error: unknown) => {
      assert.ok(error instanceof RailRefused);
      assert.match((error as Error).message, /quote_refused/);
      return true;
    });
  } finally {
    await merchant.close();
  }
});

test("an unreachable merchant is a refusal, not a crash", async () => {
  // Port 1 refuses immediately, so this needs no server.
  await assert.rejects(() => railOn("http://127.0.0.1:1").quote({ request: {}, operation: "q" }), RailRefused);
});

// ── local limits: these must refuse before any Voucher is signed ─────────────

test("an operation name that the kit would reject is refused up front", async () => {
  const merchant = await fakeMerchant();
  try {
    const rail = railOn(merchant.base);
    for (const bad of ["Has-Caps", "has_underscore", "-leading", "", "x".repeat(65)]) {
      await assert.rejects(() => rail.ask({ request: {}, operation: bad }), /operation must be/);
    }
    assert.equal(merchant.seen.length, 0, "nothing was even staged");
  } finally {
    await merchant.close();
  }
});

test("an ask above the single-ask limit is refused and never bought", async () => {
  const merchant = await fakeMerchant({ amount: (WEI / 2n).toString() });
  const capture: { args?: Record<string, unknown> } = {};
  try {
    const rail = railOn(merchant.base, { maxPriceWei: WEI / 10n, buyImpl: fakeBuy(capture) });
    await assert.rejects(() => rail.ask({ request: {}, operation: "too-dear" }), (error: unknown) => {
      assert.ok(error instanceof RailRefused);
      assert.match((error as Error).message, /above the 0\.1 limit for a single ask/);
      return true;
    });
    assert.equal(capture.args, undefined, "the purchase was never started");
  } finally {
    await merchant.close();
  }
});

test("an ask that would break the session budget is refused", async () => {
  const merchant = await fakeMerchant({ amount: (WEI / 10n).toString() });
  const state = dir();
  // 0.45 RLUSD already spent against a 0.5 ceiling leaves no room for 0.1.
  writeFileSync(join(state, "budget.json"), JSON.stringify({ spentWei: (WEI * 45n / 100n).toString(), purchases: [] }));
  const capture: { args?: Record<string, unknown> } = {};
  try {
    const rail = railOn(merchant.base, { stateDirectory: state, sessionBudgetWei: WEI / 2n, buyImpl: fakeBuy(capture) });
    await assert.rejects(() => rail.ask({ request: {}, operation: "over-budget" }), (error: unknown) => {
      assert.match((error as Error).message, /0\.45 of the 0\.5 session budget is already spent/);
      return true;
    });
    assert.equal(capture.args, undefined, "the purchase was never started");
  } finally {
    await merchant.close();
  }
});

test("an unresolved purchase blocks a different one until it is resumed", async () => {
  const merchant = await fakeMerchant();
  const state = dir();
  writeFileSync(join(state, "purchase.json"), JSON.stringify({ intent: { operation: "earlier-ask" }, complete: false }));
  try {
    const rail = railOn(merchant.base, { stateDirectory: state });
    assert.deepEqual(rail.pendingPurchase(), { operation: "earlier-ask", complete: false });
    await assert.rejects(() => rail.ask({ request: {}, operation: "another-ask" }), (error: unknown) => {
      assert.match((error as Error).message, /"earlier-ask" is unresolved and must be resumed/);
      return true;
    });
    // Resuming the same operation is allowed through.
    const receipt = await rail.ask({ request: {}, operation: "earlier-ask" });
    assert.equal(receipt.operation, "earlier-ask");
  } finally {
    await merchant.close();
  }
});

test("a completed purchase does not block the next one", async () => {
  const merchant = await fakeMerchant();
  const state = dir();
  writeFileSync(join(state, "purchase.json"), JSON.stringify({ intent: { operation: "done-ask" }, complete: true }));
  try {
    const receipt = await railOn(merchant.base, { stateDirectory: state }).ask({ request: {}, operation: "next-ask" });
    assert.equal(receipt.operation, "next-ask");
  } finally {
    await merchant.close();
  }
});

// ── the job header and the budget ledger ────────────────────────────────────

test("the job id reaches the merchant through requestFetch (section 0.4)", async () => {
  const merchant = await fakeMerchant();
  const capture: { args?: Record<string, unknown> } = {};
  try {
    const rail = railOn(merchant.base, { buyImpl: fakeBuy(capture) });
    await rail.ask({ request: { messages: [] }, operation: "header-check" });

    // The kit passes only the channel header itself, so the rail's wrapper has to
    // be what carries the job. Call it the way the kit's request() does.
    const requestFetch = capture.args!.requestFetch as typeof fetch;
    assert.equal(typeof requestFetch, "function", "a requestFetch wrapper must be supplied");
    await requestFetch(`${merchant.base}/jobs`, { headers: { "X-AP4M-CHANNEL-ID": CHANNEL } } as RequestInit);

    const last = merchant.seen.at(-1)!;
    assert.equal(last.headers["x-chainaim-job"], "job-1", "the wrapper adds the staged job id");
    assert.equal(last.headers["x-ap4m-channel-id"], CHANNEL, "and keeps the kit's own header");
    // And the authority passed is the quote, unchanged.
    assert.equal(capture.args!.maximumAmount, "103593000000000000");
    assert.equal(capture.args!.channelId, CHANNEL);
  } finally {
    await merchant.close();
  }
});

test("the budget ledger records each purchase once", async () => {
  const merchant = await fakeMerchant({ amount: (WEI / 10n).toString() });
  const state = dir();
  try {
    const rail = railOn(merchant.base, { stateDirectory: state });
    await rail.ask({ request: {}, operation: "first-ask" });
    assert.equal(rail.budget().spentWei, (WEI / 10n).toString());

    await rail.ask({ request: {}, operation: "second-ask" });
    assert.equal(rail.budget().spentWei, (WEI / 5n).toString());
    assert.equal(rail.budget().purchases.length, 2);

    // Re-running the same operation must not double-count: the kit returns the
    // earlier purchase rather than buying again.
    await rail.ask({ request: {}, operation: "first-ask" });
    assert.equal(rail.budget().spentWei, (WEI / 5n).toString(), "still two purchases' worth");
    assert.equal(rail.budget().purchases.length, 2);

    const onDisk = JSON.parse(readFileSync(join(state, "budget.json"), "utf8")) as { purchases: unknown[] };
    assert.equal(onDisk.purchases.length, 2);
  } finally {
    await merchant.close();
  }
});

test("the rail refuses a channel id that is not one", () => {
  assert.throws(() => railOn("http://127.0.0.1:1", { channelId: "0x01" }), RailRefused);
  assert.throws(() => railOn("http://127.0.0.1:1", { channelId: `0x${"0".repeat(64)}` }), RailRefused);
});

// ── the tool ────────────────────────────────────────────────────────────────

test("the tool spec is the shape a tool runtime needs", () => {
  assert.equal(TOOL_SPEC.name, "paid_private_inference");
  assert.deepEqual(TOOL_SPEC.inputSchema.required, ["question"]);
  assert.equal(TOOL_SPEC.inputSchema.additionalProperties, false);
  assert.ok(TOOL_SPEC.description.includes("budget"), "the model is told it is spending real money");
});

test("the tool buys an answer and reports what it cost", async () => {
  const merchant = await fakeMerchant();
  const capture: { args?: Record<string, unknown> } = {};
  try {
    const rail = railOn(merchant.base, { buyImpl: fakeBuy(capture) });
    const handle = makeToolHandler({ ask: rail.ask, nextOperation: () => "tool-ask", maskedFields: () => 4 });
    const out = await handle({ question: "Who is due in November?", documents: "masked text", maxTokens: 128 });

    assert.ok(out.ok);
    assert.equal(out.answer, "three patients");
    assert.equal(out.cost.rlusd, "0.103593");
    assert.equal(out.payment.redemption, "Confirmed");
    assert.equal(out.model, "stub");

    // The question and the documents both reach the gateway request, and the
    // masked-field count reaches the price.
    const staged = JSON.parse(merchant.seen.at(-1)!.body) as { request: { messages: { content: string }[]; max_tokens: number }; maskedFields: number };
    assert.match(staged.request.messages[0].content, /Who is due in November\?/);
    assert.match(staged.request.messages[0].content, /masked text/);
    assert.equal(staged.request.max_tokens, 128);
    assert.equal(staged.maskedFields, 4);
  } finally {
    await merchant.close();
  }
});

test("a refusal comes back as a result the model can act on, not an exception", async () => {
  const merchant = await fakeMerchant({ amount: WEI.toString() });
  try {
    const rail = railOn(merchant.base, { maxPriceWei: WEI / 10n });
    const handle = makeToolHandler({ ask: rail.ask, nextOperation: () => "tool-dear" });
    const out = await handle({ question: "something expensive" });
    assert.equal(out.ok, false);
    assert.match((out as { refused: string }).refused, /above the 0\.1 limit/);

    const empty = await handle({ question: "   " });
    assert.equal(empty.ok, false);
    assert.match((empty as { refused: string }).refused, /no question/);
  } finally {
    await merchant.close();
  }
});

test("operation names are unique and in the kit's accepted shape", () => {
  const next = operationNamer("ask");
  const names = [next(), next(), next()];
  assert.equal(new Set(names).size, 3);
  for (const name of names) assert.match(name, /^[a-z0-9][a-z0-9-]{0,63}$/);
});
