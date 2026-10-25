/**
 * The agent's payment rail: one paid private-inference ask, end to end.
 *
 *   stage the masked request  ->  POST /jobs            (free, gives the quote)
 *   check the session budget  ->  refuse here, locally, before anything is signed
 *   buy it                    ->  buyResource()         (402, sign Voucher, redeem)
 *   record what it cost       ->  budget.json
 *
 * Three rules from DESIGN/xrplh-18 section 0 shape this file:
 *
 *   0.3  `buyResource` persists `maximumAmount` inside the purchase intent, and a
 *        resume with a different intent fails permanently. So the authority must
 *        be a function of the job alone, never of a running total. This rail
 *        passes the merchant's own quote back as `maximumAmount`: it is fixed
 *        when the job is staged and is identical on every retry. The session
 *        budget is therefore enforced BEFORE the purchase starts, by refusing,
 *        rather than by lowering the ceiling (which would only make
 *        `buyResource` reject the challenge with a confusing error).
 *
 *   0.4  `buyResource` sends only X-AP4M-CHANNEL-ID and refuses a resource URL
 *        with a query string, so the job id cannot ride in the path or the query.
 *        It does accept `requestFetch`, so that is where X-CHAINAIM-JOB goes.
 *
 *   The kit allows one unresolved purchase per state directory. An unresolved one
 *   must be resumed with its original arguments, so `pendingPurchase()` reports it
 *   and `ask()` refuses to start another until it is resolved.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ethers } from "ethers";
import { buyResource } from "./purchase.ts";

/** What the caller wants answered, already masked by the privacy service. */
export type Ask = {
  /** The gateway request body, verbatim: this is what gets priced and sent. */
  request: unknown;
  /** How many values masking replaced, for the data component of the quote. */
  maskedFields?: number;
  /** The output cap the quote is an upper bound on. */
  maxTokens?: number;
  /** Which model's rates to price against; the merchant's default if omitted. */
  model?: string;
  /**
   * The purchase name. Must be new for every purchase: reusing one returns the
   * earlier purchase instead of buying again. a-z, 0-9 and dashes, max 64.
   */
  operation: string;
};

export type Quote = {
  jobId: string;
  /** The challenge amount, in token base units. */
  amount: string;
  /** What this rail will pass as the purchase authority. Equals `amount`. */
  maximumAmount: string;
  rlusd: string;
  breakdown: Record<string, unknown>;
  expiresAt: number;
};

export type Receipt = {
  operation: string;
  jobId: string;
  claimId: string;
  transactionHash: string;
  redemption: string;
  /** What was actually paid, from the challenge the Voucher was signed against. */
  amountWei: string;
  rlusd: string;
  /** The merchant's answer payload. */
  resource: Record<string, unknown>;
};

export class RailRefused extends Error {
  detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "RailRefused";
    this.detail = detail;
  }
}

export type RailConfig = {
  /** The x402 context from loadX402Context(apiUrl). */
  context: unknown;
  provider: ethers.Provider;
  /** The agent wallet, connected to the provider: signVoucher refuses one without. */
  wallet: ethers.Wallet;
  /** The merchant's canonical /resource URL. */
  resourceUrl: string;
  /** Where the merchant stages jobs; derived from resourceUrl when omitted. */
  merchantBaseUrl?: string;
  channelId: string;
  /** This rail's own directory: purchase.json and budget.json live here. */
  stateDirectory: string;
  /** Ceiling for the whole session, in token base units. 0 means no ceiling. */
  sessionBudgetWei?: bigint;
  /** Refuse any single ask above this, in token base units. 0 means no limit. */
  maxPriceWei?: bigint;
  fetchImpl?: typeof fetch;
  /**
   * The purchase itself. Defaults to ./purchase.ts, which is the kit's
   * buyResource rebuilt on the same @ap4m/sdk primitives because the kit helper
   * cannot run on Windows (see that file's header). Injected only so the rail's
   * local limits, the job header and the budget ledger can be tested without a
   * chain. Production never passes this.
   */
  buyImpl?: typeof buyResource;
};

type Budget = { spentWei: string; purchases: { operation: string; amountWei: string; transactionHash: string }[] };

function rlusd(wei: string | bigint): string {
  return ethers.formatUnits(BigInt(wei), 18);
}

export function createRail(config: RailConfig) {
  if (!/^0x(?!0{64}$)[0-9a-f]{64}$/.test(config.channelId)) throw new RailRefused(`not a channel id: ${config.channelId}`);
  const base = (config.merchantBaseUrl ?? config.resourceUrl.replace(/\/resource$/, "")).replace(/\/+$/, "");
  const doFetch = config.fetchImpl ?? fetch;
  mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 });
  const budgetPath = join(config.stateDirectory, "budget.json");
  const purchasePath = join(config.stateDirectory, "purchase.json");

  function budget(): Budget {
    try {
      return JSON.parse(readFileSync(budgetPath, "utf8")) as Budget;
    } catch {
      return { spentWei: "0", purchases: [] };
    }
  }

  function record(operation: string, amountWei: string, transactionHash: string): void {
    const held = budget();
    if (held.purchases.some((p) => p.operation === operation)) return;
    const next: Budget = {
      spentWei: (BigInt(held.spentWei) + BigInt(amountWei)).toString(),
      purchases: [...held.purchases, { operation, amountWei, transactionHash }],
    };
    writeFileSync(budgetPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * The purchase the kit is still holding, if any. While this is set, no other
   * purchase may start: it has to be resumed with its original arguments.
   */
  function pendingPurchase(): { operation: string; complete: boolean } | undefined {
    try {
      const held = JSON.parse(readFileSync(purchasePath, "utf8")) as { intent?: { operation?: string }; complete?: boolean };
      if (!held?.intent?.operation) return undefined;
      return { operation: held.intent.operation, complete: held.complete === true };
    } catch {
      return undefined;
    }
  }

  /**
   * The staged job for one operation, created once and then reused.
   *
   * A retry must not stage a new job. The retained Voucher was signed against
   * the challenge the merchant built for the FIRST job, and the merchant refuses
   * a payment whose header names a different job with
   * `409 request_challenge_first`. This is the same trap as section 0.3: any
   * value inside a purchase must be a function of the purchase, not recomputed
   * per attempt.
   */
  async function stagedJob(input: Ask): Promise<Quote> {
    const path = join(config.stateDirectory, `job-${input.operation}.json`);
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Quote;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const priced = await quote(input);
    writeFileSync(path, `${JSON.stringify(priced, null, 2)}\n`, { mode: 0o600 });
    return priced;
  }

  /** Stage the masked request and get its price. Free, and signs nothing. */
  async function quote(ask: Ask): Promise<Quote> {
    let response: Response;
    try {
      response = await doFetch(`${base}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          channelId: config.channelId,
          request: ask.request,
          maskedFields: ask.maskedFields ?? 0,
          maxTokens: ask.maxTokens ?? 512,
          ...(ask.model ? { model: ask.model } : {}),
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new RailRefused(`the merchant at ${base} did not answer: ${(error as Error).message}`);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, never>;
    if (response.status !== 201) {
      throw new RailRefused(`the merchant refused the job (HTTP ${response.status}: ${body.error ?? "no reason given"})`, body);
    }
    return {
      jobId: String(body.jobId),
      amount: String(body.amount),
      maximumAmount: String(body.maximumAmount),
      rlusd: String(body.rlusd),
      breakdown: (body.breakdown ?? {}) as Record<string, unknown>,
      expiresAt: Number(body.expiresAt),
    };
  }

  /**
   * Buy one answer. Returns the receipt, or throws RailRefused with a reason the
   * caller can act on. Nothing is signed until every local limit has passed.
   */
  async function ask(input: Ask): Promise<Receipt> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.operation)) {
      throw new RailRefused(`operation must be a-z, 0-9 and dashes, up to 64 characters: ${input.operation}`);
    }
    const pending = pendingPurchase();
    if (pending && !pending.complete && pending.operation !== input.operation) {
      throw new RailRefused(
        `the purchase "${pending.operation}" is unresolved and must be resumed with its original arguments before another starts`,
        { pending: pending.operation },
      );
    }

    const priced = await stagedJob(input);

    // Local limits first: refusing here costs nothing and signs nothing.
    const maxPrice = config.maxPriceWei ?? 0n;
    if (maxPrice > 0n && BigInt(priced.amount) > maxPrice) {
      throw new RailRefused(
        `this ask costs ${rlusd(priced.amount)} RLUSD, above the ${rlusd(maxPrice)} limit for a single ask`,
        { amount: priced.amount, maxPrice: maxPrice.toString() },
      );
    }
    const sessionBudget = config.sessionBudgetWei ?? 0n;
    if (sessionBudget > 0n) {
      const spent = BigInt(budget().spentWei);
      if (spent + BigInt(priced.amount) > sessionBudget) {
        throw new RailRefused(
          `this ask costs ${rlusd(priced.amount)} RLUSD and ${rlusd(spent)} of the ${rlusd(sessionBudget)} session budget is already spent`,
          { amount: priced.amount, spentWei: spent.toString(), sessionBudgetWei: sessionBudget.toString() },
        );
      }
    }

    // Section 0.4: the job id can only reach the merchant through requestFetch.
    const requestFetch: typeof fetch = (url, init) =>
      doFetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), "X-CHAINAIM-JOB": priced.jobId } });

    const buy = config.buyImpl ?? buyResource;
    const bought = (await buy({
      context: config.context,
      provider: config.provider,
      wallet: config.wallet,
      stateDirectory: config.stateDirectory,
      resourceUrl: config.resourceUrl,
      channelId: config.channelId,
      // Section 0.3: the quote, fixed when the job was staged, so a resume matches.
      maximumAmount: priced.maximumAmount,
      operation: input.operation,
      requestFetch,
    })) as { operation: string; claimId: string; transactionHash: string; redemption: string; resource: Record<string, unknown> };

    record(input.operation, priced.amount, bought.transactionHash);
    return {
      operation: bought.operation,
      jobId: priced.jobId,
      claimId: bought.claimId,
      transactionHash: bought.transactionHash,
      redemption: bought.redemption,
      amountWei: priced.amount,
      rlusd: rlusd(priced.amount),
      resource: bought.resource,
    };
  }

  return { quote, ask, budget, pendingPurchase };
}
