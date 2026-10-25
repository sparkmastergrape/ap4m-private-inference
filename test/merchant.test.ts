/**
 * The merchant against a stub gateway.
 *
 * These cover everything that does not need the chain: the job store, the
 * gateway client, the construction rules, and the free HTTP surface
 * (POST /jobs, GET /quote, GET /healthz) plus the header checks the paid path
 * makes before it reads a Channel. The paid path itself needs a live Channel and
 * a funded submitter, so it is exercised against the real service, not here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "../src/merchant/jobs.ts";
import { GatewayError, answerText, httpGateway } from "../src/merchant/gateway-client.ts";
import { createMerchant } from "../src/merchant/x402-merchant.ts";
import { stubGateway } from "../src/merchant/stub-gateway.ts";
import type { Pricing } from "../src/shared/estimate.ts";

const PRICING: Pricing = JSON.parse(readFileSync(new URL("../config/pricing.json", import.meta.url), "utf8"));
const MODELS: { default: string; rates: Record<string, { inputPerM: number; outputPerM: number }> } = JSON.parse(
  readFileSync(new URL("../config/models.json", import.meta.url), "utf8"),
);

const CHANNEL = `0x${"ab".repeat(32)}`;
const OTHER_CHANNEL = `0x${"cd".repeat(32)}`;

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "ap4m-merchant-"));
}

/** A provider that answers nothing: construction never touches the chain. */
const DEAD_PROVIDER = {
  async getBlockNumber(): Promise<number> {
    throw new Error("no chain in this test");
  },
  async getBlock(): Promise<null> {
    throw new Error("no chain in this test");
  },
};

const CONTEXT = {
  network: { chainId: 1449000 },
  participantRequest: {},
  x402: {
    merchant: { environmentManifestDigest: `0x${"11".repeat(32)}`, ledger: `0x${"22".repeat(20)}` },
    validBefore: 4_000_000_000,
  },
};

function merchantFor(overrides: Record<string, unknown> = {}) {
  return createMerchant({
    context: CONTEXT as never,
    provider: DEAD_PROVIDER as never,
    submitter: { async sendTransaction() { throw new Error("not used in this test"); } },
    merchantParticipantId: `0x${"33".repeat(32)}`,
    payout: `0x${"44".repeat(20)}`,
    resourceUrl: "http://127.0.0.1:4308/resource",
    stateDirectory: stateDir(),
    pricing: PRICING,
    modelRates: MODELS.rates,
    defaultModel: MODELS.default,
    gateway: stubGateway(),
    ...overrides,
  } as never);
}

/** Start a merchant on an ephemeral port and give back a fetch bound to it. */
async function serve(overrides: Record<string, unknown> = {}) {
  const merchant = merchantFor(overrides);
  await new Promise<void>((resolve) => merchant.server.listen(0, "127.0.0.1", resolve));
  const { port } = merchant.server.address() as { port: number };
  const call = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  return { merchant, call, close: () => merchant.close() };
}

// ── the job store ─────────────────────────────────────────────────────────────

test("the job store round-trips a job and binds it to the voucher that paid", () => {
  const store = new JobStore(stateDir(), "identity-a");
  try {
    const job = store.createJob({
      channelId: CHANNEL,
      request: '{"messages":[]}',
      quoteWei: "104690000000000000",
      maximumAmount: "104690000000000000",
      breakdown: "{}",
      expiresAt: 2_000_000_000,
    });
    const read = store.job(job.jobId);
    assert.equal(read?.quoteWei, "104690000000000000");
    assert.equal(read?.voucherDigest, null, "a fresh job is unpaid");

    store.bindJob(job.jobId, "0xdeadbeef");
    assert.equal(store.job(job.jobId)?.voucherDigest, "0xdeadbeef");
    assert.equal(store.jobForVoucher("0xdeadbeef")?.jobId, job.jobId);
    assert.equal(store.job("not-a-job"), undefined);
  } finally {
    store.close();
  }
});

test("pruning drops expired unpaid jobs and keeps paid ones", () => {
  const store = new JobStore(stateDir(), "identity-b");
  try {
    const base = { channelId: CHANNEL, request: "{}", quoteWei: "1", maximumAmount: "1", breakdown: "{}" };
    const stale = store.createJob({ ...base, expiresAt: 1_000 });
    const paid = store.createJob({ ...base, expiresAt: 1_000 });
    const fresh = store.createJob({ ...base, expiresAt: 4_000_000_000 });
    store.bindJob(paid.jobId, "0xpaid");

    assert.equal(store.pruneExpired(2_000), 1, "only the stale unpaid job goes");
    assert.equal(store.job(stale.jobId), undefined);
    assert.ok(store.job(paid.jobId), "a paid job is kept as the record of what was bought");
    assert.ok(store.job(fresh.jobId));
  } finally {
    store.close();
  }
});

test("a second merchant cannot share one state directory", () => {
  const dir = stateDir();
  const first = new JobStore(dir, "identity-c");
  try {
    assert.throws(() => new JobStore(dir, "identity-c"), /merchant.lock/);
  } finally {
    first.close();
  }
  // Once closed, the lock is gone and the directory is usable again.
  const again = new JobStore(dir, "identity-c");
  again.close();
});

test("a store refuses a different configuration", () => {
  const dir = stateDir();
  const first = new JobStore(dir, "identity-one");
  first.close();
  assert.throws(() => new JobStore(dir, "identity-two"), /another configuration/);
});

// ── the gateway client ────────────────────────────────────────────────────────

test("answerText reads both plain and parts content", () => {
  assert.equal(answerText({ choices: [{ message: { content: "hello" } }] }), "hello");
  assert.equal(answerText({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] }), "ab");
  assert.equal(answerText({ choices: [{ text: "legacy" }] }), "legacy");
  assert.throws(() => answerText({ choices: [] }), GatewayError);
  assert.throws(() => answerText({ choices: [{ message: {} }] }), GatewayError);
});

test("the gateway client reports health, answers, and turns failures into GatewayError", async () => {
  let mode = "ok";
  const upstream: Server = createServer((req, res) => {
    if (req.url === "/healthz") return void res.writeHead(mode === "sick" ? 503 : 200).end("{}");
    if (mode === "refuse") return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"no key"}');
    if (mode === "garbage") return void res.writeHead(200, { "content-type": "application/json" }).end("not json");
    res.writeHead(200, { "content-type": "application/json", "x-chainaim-decision-id": "dec-1" });
    res.end(JSON.stringify({ model: "m", usage: { total_tokens: 7 }, choices: [{ message: { content: "answered" } }] }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const { port } = upstream.address() as { port: number };
  const gateway = httpGateway(`http://127.0.0.1:${port}`, "key");

  try {
    assert.equal(await gateway.healthy(), true);
    const answer = await gateway.complete("{}", 5_000);
    assert.equal(answer.text, "answered");
    assert.equal(answer.usage?.total_tokens, 7);
    assert.equal(answer.decisionId, "dec-1");

    mode = "sick";
    assert.equal(await gateway.healthy(), false);

    mode = "refuse";
    await assert.rejects(() => gateway.complete("{}", 5_000), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal((error as GatewayError).status, 502, "the agent sees a merchant-side failure");
      assert.equal((error as GatewayError).upstreamStatus, 401);
      return true;
    });

    mode = "garbage";
    await assert.rejects(() => gateway.complete("{}", 5_000), /did not answer with JSON/);
  } finally {
    await new Promise<void>((resolve, reject) => upstream.close((e) => (e ? reject(e) : resolve())));
  }
});

test("an unreachable gateway is unhealthy, not an exception", async () => {
  // Port 1 refuses immediately, so this needs no server.
  assert.equal(await httpGateway("http://127.0.0.1:1", "").healthy(), false);
  await assert.rejects(() => httpGateway("http://127.0.0.1:1", "").complete("{}", 2_000), GatewayError);
});

// ── construction rules ───────────────────────────────────────────────────────

test("the resource URL must be canonical and loopback-or-HTTPS", () => {
  assert.throws(() => merchantFor({ resourceUrl: "http://127.0.0.1:4308/other" }), /canonical/);
  // A query string is caught by the SDK's own parseX402ResourceUrl, which runs first.
  assert.throws(() => merchantFor({ resourceUrl: "http://127.0.0.1:4308/resource?x=1" }), /query parameters/);
  assert.throws(() => merchantFor({ resourceUrl: "http://example.com/resource" }), /require HTTPS/);
  // A public HTTPS resource is fine.
  const ok = merchantFor({ resourceUrl: "https://example.com/resource" });
  return ok.close();
});

test("the cutoff margin and the inference timeout must fit the 300-second window", () => {
  assert.throws(() => merchantFor({ cutoffMarginSeconds: 4 }), /5 through 299/);
  assert.throws(() => merchantFor({ cutoffMarginSeconds: 300 }), /5 through 299/);
  // 280s of inference plus 30s of head-room cannot finish inside 300s.
  assert.throws(() => merchantFor({ inferenceTimeoutMs: 280_000 }), /does not fit in the 300-second x402 window/);
});

// ── the free HTTP surface ────────────────────────────────────────────────────

test("healthz reports the stub gateway as healthy", async () => {
  const { call, close } = await serve();
  try {
    const response = await call("/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", jobs: 0, queued: 0 });
  } finally {
    await close();
  }
});

test("healthz says gateway_unavailable when inference is unreachable", async () => {
  const { call, close } = await serve({ gateway: httpGateway("http://127.0.0.1:1", "") });
  try {
    const response = await call("/healthz");
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { status: string }).status, "gateway_unavailable");
  } finally {
    await close();
  }
});

test("POST /jobs quotes a staged request and names what to send back", async () => {
  const { call, close } = await serve();
  try {
    const response = await call("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: CHANNEL, request: { messages: [{ role: "user", content: "x".repeat(4_000) }] }, maskedFields: 12, maxTokens: 256 }),
    });
    assert.equal(response.status, 201);
    const body = (await response.json()) as Record<string, never>;
    assert.match(String(body.jobId), /^[0-9a-f-]{36}$/);
    assert.match(String(body.amount), /^[1-9][0-9]*$/, "the amount is a positive integer in base units");
    assert.equal(body.amount, body.maximumAmount, "the ceiling is the quote, frozen once per job");
    assert.equal(body.resourceUrl, "http://127.0.0.1:4308/resource");
    assert.deepEqual(body.headers, { "X-AP4M-CHANNEL-ID": CHANNEL, "X-CHAINAIM-JOB": body.jobId });
    // The quote is reproducible: the same job asked again costs the same.
    const second = await call("/jobs", {
      method: "POST",
      body: JSON.stringify({ channelId: CHANNEL, request: { messages: [{ role: "user", content: "x".repeat(4_000) }] }, maskedFields: 12, maxTokens: 256 }),
    });
    assert.equal(((await second.json()) as { amount: string }).amount, body.amount);
  } finally {
    await close();
  }
});

test("POST /jobs refuses bad input before it costs anything", async () => {
  const { call, close } = await serve();
  const post = (body: string) => call("/jobs", { method: "POST", body });
  try {
    assert.equal((await post("not json")).status, 400);
    assert.equal(((await (await post('{"channelId":"0xnope","request":"hi"}')).json()) as { error: string }).error, "invalid_channel_id");
    assert.equal(((await (await post(`{"channelId":"${CHANNEL}"}`)).json()) as { error: string }).error, "invalid_job");
    assert.equal(
      ((await (await post(`{"channelId":"${CHANNEL}","request":"hi","maxTokens":0}`)).json()) as { error: string }).error,
      "invalid_job",
    );
    const unknown = (await (await post(`{"channelId":"${CHANNEL}","request":"hi","model":"gpt-9"}`)).json()) as { error: string; detail: string };
    assert.equal(unknown.error, "unknown_model");
    assert.match(unknown.detail, /priced models are/);
  } finally {
    await close();
  }
});

test("a job over the per-call ceiling is refused, not quoted", async () => {
  const { call, close } = await serve();
  try {
    const response = await call("/jobs", {
      method: "POST",
      // A huge output cap on a priced model pushes the quote past maximumPerCall.
      body: JSON.stringify({ channelId: CHANNEL, request: "summarise", maxTokens: 10_000_000, model: "claude-sonnet-4-6" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string; wouldBe: string; maximumPerCall: number };
    assert.equal(body.error, "quote_refused");
    assert.ok(Number(body.wouldBe) > body.maximumPerCall, `${body.wouldBe} should exceed ${body.maximumPerCall}`);
  } finally {
    await close();
  }
});

test("GET /quote reports a staged job and 404s an unknown one", async () => {
  const { call, close } = await serve();
  try {
    const staged = (await (
      await call("/jobs", { method: "POST", body: JSON.stringify({ channelId: CHANNEL, request: "hello" }) })
    ).json()) as { jobId: string; amount: string };

    const quote = (await (await call(`/quote/${staged.jobId}`)).json()) as Record<string, never>;
    assert.equal(quote.amount, staged.amount);
    assert.equal(quote.paid, false);
    assert.equal(quote.expired, false);
    assert.equal((await call("/quote/nope")).status, 404);
  } finally {
    await close();
  }
});

// ── the paid path's checks that come before any chain read ───────────────────

test("GET /resource refuses a request that names no usable job", async () => {
  const { call, close } = await serve();
  try {
    const bad = await call("/resource", { headers: { "x-ap4m-channel-id": "0x01" } });
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_channel_id");

    const noJob = await call("/resource", { headers: { "x-ap4m-channel-id": CHANNEL } });
    assert.equal(noJob.status, 400);
    assert.equal(((await noJob.json()) as { error: string }).error, "job_required");

    const unknown = await call("/resource", { headers: { "x-ap4m-channel-id": CHANNEL, "x-chainaim-job": "nope" } });
    assert.equal(unknown.status, 404);
    assert.equal(((await unknown.json()) as { error: string }).error, "no_such_job");

    const staged = (await (
      await call("/jobs", { method: "POST", body: JSON.stringify({ channelId: CHANNEL, request: "hello" }) })
    ).json()) as { jobId: string };
    const wrongChannel = await call("/resource", { headers: { "x-ap4m-channel-id": OTHER_CHANNEL, "x-chainaim-job": staged.jobId } });
    assert.equal(wrongChannel.status, 400);
    assert.equal(((await wrongChannel.json()) as { error: string }).error, "job_for_another_channel");
  } finally {
    await close();
  }
});

test("an expired job is refused before the chain is read", async () => {
  // The clock jumps past the job's TTL between staging and buying.
  let now = 1_000_000;
  const { call, close } = await serve({ clock: () => now, jobTtlSeconds: 60 });
  try {
    const staged = (await (
      await call("/jobs", { method: "POST", body: JSON.stringify({ channelId: CHANNEL, request: "hello" }) })
    ).json()) as { jobId: string; expiresAt: number };
    assert.equal(staged.expiresAt, 1_000_060);

    now = 1_000_061;
    const response = await call("/resource", { headers: { "x-ap4m-channel-id": CHANNEL, "x-chainaim-job": staged.jobId } });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: string }).error, "job_expired");
  } finally {
    await close();
  }
});

test("only GET /resource and the free routes exist", async () => {
  const { call, close } = await serve();
  try {
    assert.equal((await call("/")).status, 404);
    assert.equal((await call("/resource", { method: "POST" })).status, 404);
    assert.equal((await call("/jobs")).status, 404, "GET /jobs is not a route");
  } finally {
    await close();
  }
});

test("the stub gateway echoes the last message so a paid answer is recognisable", async () => {
  const answer = await stubGateway().complete(JSON.stringify({ messages: [{ role: "user", content: "who is due in November?" }] }), 1_000);
  assert.match(answer.text, /^\[stub gateway\] who is due in November\?$/);
  assert.equal(answer.model, "stub");
});
