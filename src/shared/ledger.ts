/**
 * The AP4M payment ledger: one JSON line per paid ask, and one per settlement.
 *
 * It deliberately mirrors the gateway's own decision ledger
 * (services/gateway/src/ledger.ts): daily JSONL files, synchronous append so
 * lines stay whole under concurrency, 0o600 files in a 0o700 directory. The two
 * are separate files because the boundary rule keeps hack/ap4m out of
 * services/*, and they join on `decisionId` where the gateway reported one.
 *
 * WHAT IT NEVER RECORDS, from DESIGN/xrplh-18 section 4 line 12 ("no text"):
 * the question, the documents, the masked request, the answer, the placeholder
 * map, or any upstream error body. Only identifiers, counts, prices and
 * transaction hashes. Everything here is safe to publish next to the receipt.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

type Base = { ts: string; kind: string; channelId: string };

/**
 * One paid ask, written when the merchant releases the answer. These are the
 * fields the design names, plus what is needed to show quoted against actual.
 */
export type RedemptionEntry = Base & {
  kind: "redemption";
  jobId: string;
  /** The Channel's agent wallet: who paid. Not known to the merchant, so optional. */
  agent?: string;
  claimId: string;
  /** The redemption that advanced the claim watermark. Moves no tokens. */
  redeemTx: string;
  /** What the Voucher was signed for, in token base units. */
  amountWei: string;
  /** The running total the Voucher carries. Cumulative, so it only counts up. */
  cumulativeWei: string;
  /** The quote this price came from: inTok, outTok, modelUsd, dataUsd and the rest. */
  quote: Record<string, unknown>;
  /** What the gateway said it actually used, so quoted and actual sit side by side. */
  actual?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  /** The model that answered, which may differ from the one priced. */
  model?: string;
  /** The gateway's own decision id, joining this line to its decision ledger. */
  decisionId?: string;
  /** What kind of data was involved, as the privacy service classified it. Never the data. */
  dataClass?: string;
  /** How many values masking replaced. A count, never the values. */
  maskedFields?: number;
};

/**
 * One settlement, written by ops/settle.ts. Settlement is the step that actually
 * moves RLUSD from the vault to the payout wallet; redemption above does not.
 */
export type SettlementEntry = Base & {
  kind: "settlement";
  /** The claim this line settles. Joins to RedemptionEntry.claimId. */
  claimId: string;
  /** What this one claim paid, in token base units. */
  amountWei: string;
  /** The settlement transaction the service reported for the batch. */
  settleTx?: string;
  /** The payout transaction: vault -> payout wallet. */
  payoutTx?: string;
  /** The service's verifiable receipt for THIS claim, absolute URL. */
  receiptUrl?: string;
  status?: string;
};

export type LedgerEntry = RedemptionEntry | SettlementEntry;

export class Ledger {
  readonly dir: string | undefined;

  /** @param dir directory for daily files, or undefined to disable */
  constructor(dir: string | undefined) {
    this.dir = dir;
    if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  get enabled(): boolean {
    return this.dir !== undefined;
  }

  write(entry: LedgerEntry): void {
    if (!this.dir) return;
    const file = join(this.dir, `payments-${entry.ts.slice(0, 10)}.jsonl`);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** Claim ids that already have a line of this kind, so a re-run does not duplicate them. */
  claimsWithLine(kind: LedgerEntry["kind"]): Set<string> {
    const seen = new Set<string>();
    if (!this.dir || !existsSync(this.dir)) return seen;
    for (const name of readdirSync(this.dir)) {
      if (!/^payments-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      for (const line of readFileSync(join(this.dir, name), "utf8").split("\n")) {
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as { kind?: string; claimId?: string };
          if (entry.kind === kind && entry.claimId) seen.add(entry.claimId);
        } catch {
          /* a torn line is skipped, not fatal */
        }
      }
    }
    return seen;
  }
}

/**
 * Field names that must never appear in a ledger line, whatever the shape of the
 * entry. Used by the tests and by anything that wants to assert the rule rather
 * than trust it.
 */
export const FORBIDDEN_LEDGER_FIELDS = [
  "answer",
  "request",
  "question",
  "documents",
  "messages",
  "content",
  "text",
  "map",
  "placeholders",
  "masked",
  "prompt",
  "detail",
] as const;

/** Throw if an entry carries anything that could hold document or answer text. */
export function assertNoText(entry: unknown, path = "entry"): void {
  if (entry === null || typeof entry !== "object") return;
  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    if ((FORBIDDEN_LEDGER_FIELDS as readonly string[]).includes(key)) {
      throw new Error(`${path}.${key} must never be written to the payment ledger`);
    }
    assertNoText(value, `${path}.${key}`);
  }
}
