/**
 * The job cost quote, as one pure function. Both sides run this: the agent to
 * refuse early, the merchant to set the challenge amount. See DESIGN/xrplh-18 7.
 *
 * All money is handled as integer micro-RLUSD (1e-6) and converted to wei with
 * BigInt, never with floating point, so the quote the agent computes and the
 * amount the merchant puts in the challenge are bit-identical.
 *
 * RLUSD on XRPL EVM has 18 decimals, so 1 micro-RLUSD = 1e12 wei.
 */

/** Prices, from config/pricing.json. Every field is RLUSD except the last three. */
export type Pricing = {
  /** Flat component per ask. */
  fixed: number;
  /** Per masked field found in the request. */
  perMaskedField: number;
  /** Per kilobyte of masked request sent. */
  perKB: number;
  /** How much of the model's own cost is passed on; 1 = all of it. */
  costShare: number;
  /** Never quote below this. */
  minimum: number;
  /** Above this the job is refused rather than quoted. */
  maximumPerCall: number;
  /** Characters per token when counting by size. */
  charsPerToken: number;
  /** Safety margin added to a counted-by-size input. */
  inputMargin: number;
  /** Extra billed output a reasoning model adds; 0 for a plain model. */
  reasoningFactor: number;
};

/** Per-million token prices for the model that will run the job. */
export type ModelRates = { inputPerM: number; outputPerM: number };

/** What the merchant recounts from the staged job. */
export type Work = {
  /** utf8 bytes of the masked request, system prompt and tools included. */
  bytes: number;
  /** How many values masking replaced. */
  maskedFields: number;
  /** The requested output cap; the quote is an upper bound because of it. */
  maxTokens: number;
  /** Exact input tokens when a counter was available; omit to count by size. */
  inputTokens?: number;
  model: ModelRates;
};

export type Quote = {
  inTok: number;
  outTok: number;
  /** How inTok was obtained, so a disagreement is explainable. */
  inTokSource: "counted" | "bytes";
  modelUsd: number;
  dataUsd: number;
  /** The quote, as a decimal string with 6 places: what a human reads. */
  totalRlusd: string;
  /** The same number in token base units, for the x402 challenge. */
  quoteWei: string;
  /** True when the clamp raised the total to `minimum`. */
  atMinimum: boolean;
};

export class QuoteRefused extends Error {
  /** What the job would have cost, as a decimal string. */
  wouldBe: string;
  /** The limit it broke. */
  maximumPerCall: number;

  constructor(message: string, wouldBe: string, maximumPerCall: number) {
    super(message);
    this.name = "QuoteRefused";
    this.wouldBe = wouldBe;
    this.maximumPerCall = maximumPerCall;
  }
}

const MICRO = 1_000_000;
/** 1e-6 RLUSD expressed in wei, for an 18-decimal token. */
const WEI_PER_MICRO = 1_000_000_000_000n;

/** Round up to whole micro-RLUSD. The epsilon absorbs binary representation error. */
function toMicro(rlusd: number): bigint {
  if (!Number.isFinite(rlusd) || rlusd < 0) throw new Error(`not a usable amount: ${rlusd}`);
  return BigInt(Math.ceil(rlusd * MICRO - 1e-9));
}

function fromMicro(micro: bigint): string {
  const whole = micro / BigInt(MICRO);
  const frac = (micro % BigInt(MICRO)).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

export function countInputTokens(work: Work, pricing: Pricing): { inTok: number; source: "counted" | "bytes" } {
  if (work.inputTokens !== undefined) {
    if (!Number.isInteger(work.inputTokens) || work.inputTokens < 0) throw new Error("inputTokens must be a whole number");
    return { inTok: work.inputTokens, source: "counted" };
  }
  if (pricing.charsPerToken <= 0) throw new Error("charsPerToken must be above zero");
  return { inTok: Math.ceil((work.bytes / pricing.charsPerToken) * (1 + pricing.inputMargin)), source: "bytes" };
}

/**
 * Quote one job. Throws QuoteRefused when the job would cost more than
 * `maximumPerCall`, because a voucher can only ever count up: there is no
 * refund path, so an over-large job must be refused, not priced.
 */
export function estimate(work: Work, pricing: Pricing): Quote {
  if (!Number.isInteger(work.maxTokens) || work.maxTokens <= 0) throw new Error("maxTokens must be a whole number above zero");
  if (!Number.isInteger(work.bytes) || work.bytes < 0) throw new Error("bytes must be a whole number");
  if (!Number.isInteger(work.maskedFields) || work.maskedFields < 0) throw new Error("maskedFields must be a whole number");

  const { inTok, source } = countInputTokens(work, pricing);
  const outTok = work.maxTokens;

  const modelUsd =
    (inTok * work.model.inputPerM + outTok * work.model.outputPerM * (1 + pricing.reasoningFactor)) / 1e6;
  const dataUsd = pricing.perMaskedField * work.maskedFields + pricing.perKB * (work.bytes / 1024);

  const rawMicro = toMicro(pricing.fixed + dataUsd + pricing.costShare * modelUsd);
  const maxMicro = toMicro(pricing.maximumPerCall);
  const minMicro = toMicro(pricing.minimum);

  if (rawMicro > maxMicro) {
    throw new QuoteRefused(
      `this job would cost ${fromMicro(rawMicro)} RLUSD, above the ${pricing.maximumPerCall} limit per call`,
      fromMicro(rawMicro),
      pricing.maximumPerCall,
    );
  }

  const totalMicro = rawMicro < minMicro ? minMicro : rawMicro;
  return {
    inTok,
    outTok,
    inTokSource: source,
    modelUsd,
    dataUsd,
    totalRlusd: fromMicro(totalMicro),
    quoteWei: (totalMicro * WEI_PER_MICRO).toString(),
    atMinimum: totalMicro === minMicro && rawMicro < minMicro,
  };
}

/**
 * The ceiling passed to buyResource, frozen when the job is created.
 *
 * buyResource puts maximumAmount inside the purchase intent it persists, and on
 * resume throws "operation name belongs to another purchase" if the intent
 * changed. So this must be computed ONCE per operation and stored on the job;
 * recomputing it after a partial spend makes the resume fail for good.
 * See DESIGN/xrplh-18 0.3.
 */
export function freezeMaximumAmount(limitsWei: { sessionRemaining: bigint; maxPrice: bigint; channelRemaining: bigint }): bigint {
  const lowest = [limitsWei.sessionRemaining, limitsWei.maxPrice, limitsWei.channelRemaining].reduce(
    (a, b) => (b < a ? b : a),
  );
  if (lowest <= 0n) throw new Error("no purchase authority left: session, price limit or channel cap is exhausted");
  return lowest;
}
