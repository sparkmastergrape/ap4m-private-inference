/**
 * The AP4M x402 merchant for paid private inference.
 *
 * It follows the AP4M kit merchant (vendor/ap4m-x402.mjs, createX402Merchant)
 * primitive for primitive — same challenge build, same retained-payment
 * discipline, same canonical-event reconciliation — and changes exactly three
 * things:
 *
 *   1. The price is per job, not one fixed config value. The agent stages a
 *      masked request with POST /jobs, gets a quote, and names the job in a
 *      header. buildMerchantResourceChallenge takes `amount` per challenge, so
 *      this is what the protocol already allows (DESIGN/xrplh-18 section 0.1).
 *
 *   2. The resource is produced by inference, per voucher, instead of a static
 *      blob.
 *
 *   3. Inference runs BEFORE the redemption is submitted. If the gateway fails,
 *      the answer to the agent is 502 and no Voucher is redeemed: the agent is
 *      not charged for work that produced nothing. The order is
 *      verify -> infer -> redeem -> verify -> release.
 *
 * Everything about money is still the kit's: the Voucher is cumulative, the
 * redemption is persisted before it is sent, an unknown outcome is reconciled
 * from VoucherRedeemed logs rather than rebroadcast, and finality is rechecked
 * even on a replay.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  PARTICIPANT_LEDGER_INTERFACE,
  buildMerchantResourceChallenge,
  buildX402Challenge,
  buildX402RedemptionResponse,
  canonicalJson,
  decodeX402PaymentSignature,
  derivePaymentClaimId,
  encodeX402PaymentRequired,
  encodeX402PaymentResponse,
  encodeX402PaymentSignature,
  hashPaymentVoucher,
  parseX402ResourceUrl,
  prepareX402Redemption,
  readPublicLogs,
  verifyMerchantResourceRedemption,
  verifyX402Payment,
} from "@ap4m/sdk";
import { readParticipantFinalizedBlock, readPaymentChannelBinding } from "@ap4m/sdk/participant-requests";
import { JobStore, type Job } from "./jobs.ts";
import { GatewayError, type Gateway } from "./gateway-client.ts";
import type { Ledger } from "../shared/ledger.ts";
import { QuoteRefused, estimate, type ModelRates, type Pricing } from "../shared/estimate.ts";
import { count, type CountSource } from "../shared/token-count.ts";

/** 64 KiB is the kit's resource ceiling; an answer past it is returned marked, not dropped. */
const MAX_RESOURCE_BYTES = 65_536;
const MAX_JOB_BODY_BYTES = 1_048_576;
const MAX_ROWS = 10_000;

export type MerchantConfig = {
  /** The x402 context from loadX402Context(apiUrl). */
  context: {
    network: unknown;
    participantRequest: unknown;
    x402: { merchant: { environmentManifestDigest: string; ledger: string }; validBefore: number };
  };
  provider: unknown;
  /** The wallet that pays gas for redeemVoucher. Never the agent wallet, never a payout wallet. */
  submitter: {
    sendTransaction(tx: { to: string; data: string; value: bigint }): Promise<{ hash: string; wait?: (n?: number) => Promise<unknown> }>;
  };
  merchantParticipantId: string;
  payout: string;
  /** Canonical, credential-free, path exactly /resource. HTTPS unless loopback. */
  resourceUrl: string;
  stateDirectory: string;
  pricing: Pricing;
  /** Per-million token rates by model name, from config/models.json. */
  modelRates: Record<string, ModelRates>;
  /** The model priced when a job names none. Must be a key of modelRates. */
  defaultModel: string;
  gateway: Gateway;
  /**
   * How input tokens are counted for the quote. "chars" counts by size with the
   * configured margin and needs nothing else; "bedrock" needs `countTokens`.
   */
  tokenSource?: CountSource;
  countTokens?: (body: unknown) => Promise<number>;
  /** Seconds of head-room before a window closes; 5..299, default 30. */
  cutoffMarginSeconds?: number;
  /** How long one inference may take. Must leave room to redeem inside the window. */
  inferenceTimeoutMs?: number;
  /** How long a staged job stays buyable. */
  jobTtlSeconds?: number;
  /**
   * How long to keep re-checking canonical evidence for a redemption that is
   * mined but not yet finalized, before giving up and asking the agent to retry.
   * Without this the first ask on a quiet chain always 503s: the redemption is
   * sent, mined a block later, and verified against a finalized block that has
   * not caught up. Measured on XRPL EVM Testnet 2026-10-25: a redemption in
   * block 9229036 was not covered by the finalized head until ~28 blocks later.
   */
  finalityWaitMs?: number;
  /**
   * Where to append one line per released answer. Identifiers, counts and
   * prices only: no question, document or answer text (see shared/ledger.ts).
   */
  ledger?: Ledger;
  clock?: () => number;
};

type ChallengeRecord = { jobId: string; artifact: { value: Record<string, unknown>; digest: string } };
type Retained = { challenge: ChallengeRecord["artifact"]; header: string; transactionHash: string | null };

type Blocks = { getBlock(n: number): Promise<{ timestamp: number } | null>; getBlockNumber(): Promise<number> };

function header(incoming: IncomingMessage, name: string): string | undefined {
  const raw = incoming.rawHeaders;
  if (raw.filter((_, i) => i % 2 === 0 && raw[i].toLowerCase() === name).length > 1) throw new Error("duplicate header");
  const value = incoming.headers[name];
  if (value !== undefined && typeof value !== "string") throw new Error("invalid header");
  return value;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  const encoded = JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

async function readBody(incoming: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of incoming) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error(`request body is larger than ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createMerchant(config: MerchantConfig): { server: Server; close: () => Promise<void>; store: JobStore } {
  const cutoffMarginSeconds = config.cutoffMarginSeconds ?? 30;
  const inferenceTimeoutMs = config.inferenceTimeoutMs ?? 90_000;
  const jobTtlSeconds = config.jobTtlSeconds ?? 600;
  const finalityWaitMs = config.finalityWaitMs ?? 90_000;

  // Same resource-URL rules as the kit: a Voucher is bound to this exact string.
  const url = new URL(config.resourceUrl);
  parseX402ResourceUrl(config.resourceUrl);
  if (
    url.pathname !== "/resource" || url.search || url.hash || url.username || url.password ||
    url.href !== config.resourceUrl || !["http:", "https:"].includes(url.protocol)
  ) {
    throw new Error("resourceUrl must be a canonical credential-free HTTP(S) /resource URL");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("public merchant resources require HTTPS");
  }
  if (!Number.isSafeInteger(cutoffMarginSeconds) || cutoffMarginSeconds < 5 || cutoffMarginSeconds > 299) {
    throw new Error("cutoff margin must be 5 through 299 seconds");
  }
  // The whole paid path has to finish inside the 300-second x402 window, with the
  // cutoff margin reserved for the redemption itself.
  if ((inferenceTimeoutMs + finalityWaitMs) / 1000 + cutoffMarginSeconds >= 300) {
    throw new Error(
      `inference timeout (${inferenceTimeoutMs}ms) plus the finality wait (${finalityWaitMs}ms) plus the cutoff margin ` +
        `(${cutoffMarginSeconds}s) does not fit in the 300-second x402 window`,
    );
  }

  const clock = config.clock ?? (() => Math.floor(Date.now() / 1000));
  /** An idle chain's head can be behind real time; never trust it to be later than now. */
  const now = (blockTimestamp: number) => Math.max(blockTimestamp, clock());
  const paymentContext = config.context.x402;
  const provider = config.provider as never;
  const blocks = config.provider as Blocks;

  // canonicalJson is for protocol artifacts and takes safe integers only, so the
  // store's identity is a plain stable string with the pricing sheet hashed into
  // it: a changed sheet must not silently reuse a store full of old quotes.
  const identity = JSON.stringify({
    schemaId: "chainaim.ap4m.x402-inference-merchant.v1",
    environment: paymentContext.merchant.environmentManifestDigest,
    resourceUrl: config.resourceUrl,
    merchantParticipantId: config.merchantParticipantId,
    payout: config.payout,
    pricingDigest: createHash("sha256").update(JSON.stringify(config.pricing)).digest("hex"),
    cutoffMarginSeconds,
  });
  const store = new JobStore(config.stateDirectory, identity);
  const db = store.db;

  let queue: Promise<void> = Promise.resolve();
  let queued = 0;
  let closing = false;

  const server = createServer({ maxHeaderSize: 16_384 }, (incoming, response) => {
    response.setHeader("Cache-Control", "no-store, private");
    response.setHeader("Vary", "PAYMENT-SIGNATURE, X-AP4M-CHANNEL-ID, X-CHAINAIM-JOB");
    const path = (incoming.url ?? "/").split("?")[0];

    if (path === "/healthz" && incoming.method === "GET") {
      // Unauthenticated and free: says whether this merchant could serve a paid ask.
      void config.gateway
        .healthy()
        .then((healthy) =>
          send(response, healthy ? 200 : 503, {
            status: healthy ? "ok" : "gateway_unavailable",
            jobs: store.jobCount(),
            queued,
          }),
        )
        .catch(() => send(response, 503, { status: "gateway_unavailable" }));
      return;
    }

    if (closing || queued >= 32) return send(response, 503, { error: "merchant_busy" });

    // POST /jobs and GET /quote are free and touch no chain state, so they do not
    // go through the serialized queue that protects the one-payment-per-channel rule.
    if (path === "/jobs" && incoming.method === "POST") {
      void postJob(incoming, response).catch((error) =>
        send(response, 400, { error: "invalid_job", detail: (error as Error).message }),
      );
      return;
    }
    if (path.startsWith("/quote/") && incoming.method === "GET") return getQuote(path.slice("/quote/".length), response);

    if (incoming.method !== "GET" || path !== "/resource") return send(response, 404, { error: "not_found" });

    queued++;
    const work = queue
      .then(() => handle(incoming, response))
      .catch((error) => {
        if (error instanceof GatewayError) return send(response, 502, { error: "inference_failed", detail: error.message });
        // A retained payment may already be on chain, so this is never a silent
        // failure: the operator needs the reason to tell "retry me" from a defect.
        console.error(`[merchant] ${path} failed:`, error);
        send(response, 503, { error: "payment_pending_or_unavailable", retrySamePayment: true, detail: (error as Error).message });
      })
      .finally(() => {
        queued--;
      });
    queue = work;
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;

  /**
   * POST /jobs — free. Stage a masked request, price it, and hand back the
   * amount the agent will be asked for plus the ceiling to freeze.
   */
  async function postJob(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(incoming, MAX_JOB_BODY_BYTES);
    let input: { channelId?: string; request?: unknown; maskedFields?: number; maxTokens?: number; model?: string };
    try {
      input = JSON.parse(body);
    } catch {
      return send(response, 400, { error: "invalid_job", detail: "the request body is not valid JSON" });
    }
    const channelId = String(input.channelId ?? "");
    if (!/^0x(?!0{64}$)[0-9a-f]{64}$/.test(channelId)) return send(response, 400, { error: "invalid_channel_id" });
    if (input.request === undefined || input.request === null) {
      return send(response, 400, { error: "invalid_job", detail: "request is missing" });
    }

    const request = typeof input.request === "string" ? input.request : JSON.stringify(input.request);
    const maxTokens = Number(input.maxTokens ?? 512);
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
      return send(response, 400, { error: "invalid_job", detail: "maxTokens must be a positive integer" });
    }

    const modelName = String(input.model ?? config.defaultModel);
    const model = config.modelRates[modelName];
    if (!model) {
      return send(response, 400, {
        error: "unknown_model",
        detail: `no rates for ${modelName}; priced models are ${Object.keys(config.modelRates).join(", ")}`,
      });
    }

    store.pruneExpired(clock());
    if (store.jobCount() >= MAX_ROWS) return send(response, 503, { error: "merchant_capacity_reached" });

    // A counter that is unavailable must not fail the quote: count() falls back to
    // size and says so, which `inTokSource` then carries into the breakdown.
    const counted = await count(config.tokenSource ?? "chars", request, config.countTokens);

    let quote;
    try {
      quote = estimate(
        {
          inputTokens: counted.inputTokens,
          maxTokens,
          bytes: Buffer.byteLength(request),
          maskedFields: Number(input.maskedFields ?? 0),
          model,
        },
        config.pricing,
      );
    } catch (error) {
      if (error instanceof QuoteRefused) {
        return send(response, 400, {
          error: "quote_refused",
          detail: error.message,
          wouldBe: error.wouldBe,
          maximumPerCall: error.maximumPerCall,
        });
      }
      return send(response, 400, { error: "invalid_job", detail: (error as Error).message });
    }

    const job = store.createJob({
      channelId,
      request,
      quoteWei: quote.quoteWei,
      // The ceiling the agent must freeze and reuse on every retry (section 0.3).
      maximumAmount: quote.quoteWei,
      breakdown: JSON.stringify({ ...quote, model: modelName, countNote: counted.note }),
      expiresAt: clock() + jobTtlSeconds,
    });
    send(response, 201, {
      jobId: job.jobId,
      channelId,
      amount: job.quoteWei,
      maximumAmount: job.maximumAmount,
      rlusd: quote.totalRlusd,
      model: modelName,
      breakdown: quote,
      expiresAt: job.expiresAt,
      resourceUrl: config.resourceUrl,
      // What the agent must send back to buy it.
      headers: { "X-AP4M-CHANNEL-ID": channelId, "X-CHAINAIM-JOB": job.jobId },
    });
  }

  /** GET /quote/<jobId> — free. What a staged job costs and whether it is still buyable. */
  function getQuote(jobId: string, response: ServerResponse): void {
    const job = store.job(decodeURIComponent(jobId));
    if (!job) return send(response, 404, { error: "no_such_job" });
    send(response, 200, {
      jobId: job.jobId,
      channelId: job.channelId,
      amount: job.quoteWei,
      maximumAmount: job.maximumAmount,
      breakdown: JSON.parse(job.breakdown),
      expiresAt: job.expiresAt,
      expired: job.expiresAt < clock(),
      paid: job.voucherDigest !== null,
    });
  }

  /** Run the masked request through the gateway and shape the resource payload. */
  async function infer(job: Job): Promise<Record<string, unknown>> {
    const answer = await config.gateway.complete(job.request, inferenceTimeoutMs);
    const bytes = Buffer.byteLength(answer.text);
    const truncated = bytes > MAX_RESOURCE_BYTES;
    return {
      jobId: job.jobId,
      answer: truncated ? Buffer.from(answer.text).subarray(0, MAX_RESOURCE_BYTES - 512).toString("utf8") : answer.text,
      truncated,
      model: answer.model,
      usage: answer.usage,
      decisionId: answer.decisionId,
      quote: { amount: job.quoteWei, breakdown: JSON.parse(job.breakdown) },
    };
  }

  async function handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const channelId = header(incoming, "x-ap4m-channel-id");
    if (!channelId || !/^0x(?!0{64}$)[0-9a-f]{64}$/.test(channelId)) return send(response, 400, { error: "invalid_channel_id" });
    const jobId = header(incoming, "x-chainaim-job");
    if (!jobId) {
      return send(response, 400, {
        error: "job_required",
        detail: "stage the masked request with POST /jobs and send its id in X-CHAINAIM-JOB",
      });
    }
    const job = store.job(jobId);
    if (!job) return send(response, 404, { error: "no_such_job" });
    if (job.channelId !== channelId) return send(response, 400, { error: "job_for_another_channel" });

    const paymentHeader = header(incoming, "payment-signature");

    // ── 402: price this job against the live channel watermark ────────────────
    if (!paymentHeader) {
      if (job.expiresAt < clock()) return send(response, 409, { error: "job_expired" });
      if (job.voucherDigest !== null) return send(response, 409, { error: "job_already_paid" });

      const binding = await readPaymentChannelBinding(provider, config.context.participantRequest as never, channelId);
      const channel = binding.channel;
      if (!channel || binding.lifecycle !== "ChannelOpen" || binding.payout?.channelId !== channelId) {
        throw new Error("channel is not a managed open binding");
      }
      if (
        channel.merchantId.toLowerCase() !== config.merchantParticipantId.toLowerCase() ||
        channel.payout.toLowerCase() !== config.payout.toLowerCase()
      ) {
        return send(response, 403, { error: "channel_for_another_merchant" });
      }

      const latest = await blocks.getBlock(await blocks.getBlockNumber());
      const current = latest ? now(latest.timestamp) : undefined;
      if (current === undefined || current >= channel.validBefore - cutoffMarginSeconds) {
        return send(response, 409, { error: "merchant_acceptance_closed" });
      }
      if (db.prepare("SELECT 1 FROM payments WHERE channel_id=? AND complete=0").get(channelId)) {
        return send(response, 409, { error: "retry_retained_payment" });
      }
      // A Voucher only counts up, so the challenge must not ask for more than the
      // channel can still cover.
      if (BigInt(job.quoteWei) + BigInt(channel.redeemed) > BigInt(channel.cap)) {
        return send(response, 409, {
          error: "channel_cap_exceeded",
          detail: `this job costs ${job.quoteWei} and the channel has ${(BigInt(channel.cap) - BigInt(channel.redeemed)).toString()} left`,
        });
      }

      const existing = db.prepare("SELECT value FROM challenges WHERE channel_id=?").get(channelId) as { value: string } | undefined;
      let record: ChallengeRecord | undefined = existing ? (JSON.parse(String(existing.value)) as ChallengeRecord) : undefined;
      // Rebuild when the challenge is for another job, when the watermark moved
      // under it (section 0.2), or when its window is closing.
      if (
        !record || record.jobId !== job.jobId ||
        record.artifact.value.previousCumulativeAmount !== channel.redeemed ||
        current >= Number(record.artifact.value.validBefore) - cutoffMarginSeconds
      ) {
        const validBefore = Math.min(channel.validBefore, paymentContext.validBefore, binding.chainTimestamp + 300);
        if (current >= validBefore - cutoffMarginSeconds) {
          response.setHeader("Retry-After", "15");
          return send(response, 503, { error: "chain_head_stale", retryAfterSeconds: 15 });
        }
        if (!existing && Number((db.prepare("SELECT count(*) AS n FROM challenges").get() as { n: number }).n) >= 1024) {
          return send(response, 503, { error: "merchant_capacity_reached" });
        }
        const artifact = await buildMerchantResourceChallenge(provider, paymentContext.merchant as never, {
          channelId,
          merchantParticipantId: config.merchantParticipantId,
          payout: config.payout,
          // Per job, not per merchant. This is the whole point of the design.
          amount: job.quoteWei,
          resource: { uri: config.resourceUrl, description: "ChainAim private inference", mimeType: "application/json" },
          validBefore,
        } as never);
        record = { jobId: job.jobId, artifact: artifact as never };
        db.prepare("INSERT INTO challenges VALUES (?,?) ON CONFLICT(channel_id) DO UPDATE SET value=excluded.value").run(
          channelId,
          canonicalJson(record),
        );
      }
      response.setHeader(
        "PAYMENT-REQUIRED",
        encodeX402PaymentRequired(buildX402Challenge(paymentContext as never, record.artifact.value as never, record.artifact.digest)),
      );
      return send(response, 402, { x402Version: 2, error: "payment_required", jobId: job.jobId, amount: job.quoteWei });
    }

    // ── paid: verify, infer, redeem, verify, release ──────────────────────────
    let normalized: string;
    try {
      normalized = encodeX402PaymentSignature(decodeX402PaymentSignature(paymentHeader));
    } catch {
      return send(response, 400, { error: "invalid_payment" });
    }
    const payload = decodeX402PaymentSignature(normalized) as {
      accepted: { extra: { channelId: string; pricingMode: string } };
      payload: { voucher: { channelId: string; cumulativeAmount: string } };
    };
    if (payload.accepted.extra.channelId !== channelId) return send(response, 400, { error: "wrong_channel" });
    if (payload.accepted.extra.pricingMode !== "fixed" || !("cumulativeAmount" in payload.payload.voucher)) {
      return send(response, 400, { error: "fixed_pricing_required" });
    }

    const requestedDigest = hashPaymentVoucher(paymentContext.merchant as never, {
      channelId: payload.payload.voucher.channelId,
      cumulativeAmount: BigInt(payload.payload.voucher.cumulativeAmount),
    });

    const row = db.prepare("SELECT voucher_digest,value,complete FROM payments WHERE voucher_digest=?").get(requestedDigest) as
      | { voucher_digest: string; value: string; complete: number }
      | undefined;
    let retained: Retained;
    let replay = false;
    let voucherDigest: string;

    if (row && (JSON.parse(String(row.value)) as Retained).header === normalized) {
      // Same Voucher, same envelope: this is a retry of a purchase already paid
      // for. Never re-infer and never re-charge; the stored answer is released.
      retained = JSON.parse(String(row.value)) as Retained;
      voucherDigest = row.voucher_digest;
      replay = true;
    } else {
      const issued = db.prepare("SELECT value FROM challenges WHERE channel_id=?").get(channelId) as { value: string } | undefined;
      if (!issued) return send(response, 409, { error: "request_challenge_first" });
      const record = JSON.parse(String(issued.value)) as ChallengeRecord;
      if (record.jobId !== job.jobId) {
        return send(response, 409, { error: "request_challenge_first", detail: "the open challenge is for another job" });
      }

      const head = await blocks.getBlock(await blocks.getBlockNumber());
      // Refuse before submitting: a redemption mined after this deadline still moves funds.
      if (!head || now(head.timestamp) >= Number(record.artifact.value.validBefore) - cutoffMarginSeconds) {
        return send(response, 409, { error: "merchant_acceptance_closed" });
      }

      let plan: { payment: { voucherDigest: string }; transaction: { to: string; data: string } };
      try {
        plan = (await prepareX402Redemption(
          provider,
          paymentContext as never,
          record.artifact.value as never,
          record.artifact.digest,
          normalized,
        )) as never;
      } catch {
        return send(response, 400, { error: "invalid_payment" });
      }
      voucherDigest = plan.payment.voucherDigest;
      if (db.prepare("SELECT 1 FROM payments WHERE voucher_digest=? OR (channel_id=? AND complete=0)").get(voucherDigest, channelId)) {
        return send(response, 409, { error: "payment_conflict" });
      }
      if (Number((db.prepare("SELECT count(*) AS n FROM payments").get() as { n: number }).n) >= MAX_ROWS) {
        return send(response, 503, { error: "merchant_capacity_reached" });
      }

      // The one real departure from the kit: do the work the agent is paying for
      // BEFORE taking the payment. A GatewayError here becomes 502 and nothing
      // has been written to the payments table, so the Voucher is unspent and the
      // agent can retry or walk away.
      const resource = await infer(job);

      retained = { challenge: record.artifact, header: normalized, transactionHash: null };
      // Persist the envelope and the paid-for answer before sending the redemption.
      // An unknown outcome is reconciled from canonical events below, never
      // blindly rebroadcast, and a crash after the redeem still releases the answer.
      db.prepare("INSERT INTO payments(voucher_digest,channel_id,value) VALUES (?,?,?)").run(voucherDigest, channelId, canonicalJson(retained));
      db.prepare("INSERT OR IGNORE INTO resource_results VALUES (?,?)").run(voucherDigest, JSON.stringify(resource));
      store.bindJob(job.jobId, voucherDigest);
      try {
        const sent = await config.submitter.sendTransaction({ to: plan.transaction.to, data: plan.transaction.data, value: 0n });
        retained.transactionHash = sent.hash;
        db.prepare("UPDATE payments SET value=? WHERE voucher_digest=?").run(canonicalJson(retained), voucherDigest);
        // Mined is not the same as finalized, but verifying an unmined hash cannot
        // succeed at all, so wait for the receipt before the checks below.
        await sent.wait?.(1);
      } catch {
        /* Reconcile a lost submission response through canonical events below. */
      }
    }

    const payment = verifyX402Payment(paymentContext as never, retained.challenge.value as never, retained.challenge.digest, retained.header) as {
      voucher: { channelId: string; cumulativeAmount: string };
    };

    /**
     * Keep re-reading canonical evidence while it is merely not finalized yet.
     * The redemption is already on chain at this point, so giving up early turns
     * a paid, successful purchase into a 503 the agent has to retry by hand.
     */
    async function awaitFinality<T>(what: () => Promise<T>): Promise<T> {
      const deadline = Date.now() + finalityWaitMs;
      for (;;) {
        try {
          return await what();
        } catch (error) {
          if (Date.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
    }

    let transactionHash = retained.transactionHash;
    if (replay || !transactionHash) {
      const claimId = derivePaymentClaimId(
        paymentContext.merchant as never,
        { channelId: payment.voucher.channelId, cumulativeAmount: BigInt(payment.voucher.cumulativeAmount) },
        retained.challenge.value.previousCumulativeAmount as never,
      );
      const event = PARTICIPANT_LEDGER_INTERFACE.getEvent("VoucherRedeemed");
      transactionHash = await awaitFinality(async () => {
        const safe = await readParticipantFinalizedBlock(provider, config.context.participantRequest as never);
        const logs = await readPublicLogs(provider, {
          address: paymentContext.merchant.ledger,
          topics: [event.topicHash, channelId, claimId],
          fromBlock: retained.challenge.value.finalityBlockNumber as never,
          toBlock: safe.number,
        } as never);
        if (logs.length !== 1) throw new Error("redemption outcome is not confirmed");
        return logs[0].transactionHash as string;
      });
    }

    // Recheck canonical evidence even on a replay: a persisted success is not a
    // substitute for chain finality after a reorganization.
    const result = await awaitFinality(() =>
      verifyMerchantResourceRedemption(
        provider,
        paymentContext.merchant as never,
        retained.challenge.value as never,
        retained.challenge.digest,
        payment as never,
        transactionHash as string,
        { acceptLateInclusion: true },
      ),
    );
    if (retained.transactionHash !== transactionHash) {
      retained.transactionHash = transactionHash;
      db.prepare("UPDATE payments SET value=? WHERE voucher_digest=?").run(canonicalJson(retained), voucherDigest);
    }

    const stored = db.prepare("SELECT content FROM resource_results WHERE voucher_digest=?").get(voucherDigest) as { content: string } | undefined;
    if (!stored) throw new Error("the paid-for answer is missing from the store");
    const released = db.prepare("UPDATE payments SET complete=1 WHERE voucher_digest=? AND complete=0").run(voucherDigest) as { changes: number | bigint };
    if (config.ledger?.enabled && Number(released.changes) === 1) {
      // A ledger failure must never turn a paid, released answer into an error.
      try {
        const answer = JSON.parse(stored.content) as { model?: string; decisionId?: string; usage?: Record<string, number> };
        const jobBreakdown = JSON.parse(job.breakdown) as Record<string, unknown>;
        config.ledger.write({
          ts: new Date().toISOString(),
          kind: "redemption",
          channelId,
          jobId: job.jobId,
          claimId: String((result as { claimId?: unknown }).claimId ?? ""),
          redeemTx: transactionHash as string,
          amountWei: job.quoteWei,
          cumulativeWei: payment.voucher.cumulativeAmount,
          quote: jobBreakdown,
          actual: answer.usage
            ? { promptTokens: answer.usage.prompt_tokens, completionTokens: answer.usage.completion_tokens, totalTokens: answer.usage.total_tokens }
            : undefined,
          model: answer.model,
          decisionId: answer.decisionId,
          maskedFields: typeof jobBreakdown.maskedFields === "number" ? jobBreakdown.maskedFields : undefined,
        });
      } catch (error) {
        console.error("payment ledger write failed:", (error as Error).message);
      }
    }

    response.setHeader("PAYMENT-RESPONSE", encodeX402PaymentResponse(buildX402RedemptionResponse(result as never, config.context.network as never)));
    if (replay) response.setHeader("Idempotency-Replayed", "true");
    send(response, 200, { resource: JSON.parse(stored.content), redemption: result });
  }

  return {
    server,
    store,
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      const closed = new Promise<void>((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await queue;
      await closed;
      store.close();
    },
  };
}
