/**
 * Buy one x402 resource: our own implementation of the kit's buyResource, built
 * on the same `@ap4m/sdk` primitives in the same order, with the same checks.
 *
 * WHY THIS EXISTS. The kit helper cannot complete on Windows. Its atomic save
 * ends with the POSIX durability idiom of flushing the containing directory:
 *
 *     renameSync(temporary, file);
 *     const directory = openSync(dirname(file), 'r');
 *     try { fsyncSync(directory); } finally { closeSync(directory); }
 *                                   -- vendor/ap4m-x402.mjs:60-62
 *
 * Windows cannot flush a directory handle, and cannot flush a read-only handle
 * either: both raise EPERM. So every save() throws after having already done its
 * work, and the purchase aborts between signing the Voucher and sending it. The
 * failure cannot be shimmed away from our side, because the helper binds
 * `fsyncSync` through an ESM named import, which a monkey-patch of `node:fs`
 * does not reach (measured 2026-10-25). Editing vendor/ is worse: it is the
 * organizers' published kit, checksummed in vendor/SOURCES.md.
 *
 * So the agent uses the primitives directly, exactly as src/merchant does on the
 * other side. Nothing here is a loosened check: every condition the helper
 * enforces is enforced below, and the durability it wanted is kept by writing
 * the file, flushing the FILE handle, and renaming into place.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PARTICIPANT_LEDGER_INTERFACE,
  buildX402PaymentPayload,
  canonicalJson,
  decodeX402PaymentRequired,
  decodeX402PaymentResponse,
  decodeX402PaymentSignature,
  derivePaymentClaimId,
  encodePaymentVoucherRedemption,
  encodeX402PaymentSignature,
  hashPaymentVoucher,
  requireCanonicalBlock,
} from "@ap4m/sdk";
import { readParticipantClaim, readParticipantFinalizedBlock, readParticipantPaymentChannel } from "@ap4m/sdk/participant-requests";

const SCHEMA = "chainaim.ap4m.x402-purchase.v1";
const MAX_BODY_BYTES = 131_072;

export type PurchaseInput = {
  context: { network: string; participantRequest: unknown; x402: { token: string; merchant: unknown } };
  provider: unknown;
  wallet: { address: string };
  stateDirectory: string;
  resourceUrl: string;
  channelId: string;
  maximumAmount: string;
  operation: string;
  requestFetch?: typeof fetch;
};

export type Purchase = {
  operation: string;
  claimId: string;
  transactionHash: string;
  redemption: "Confirmed";
  resource: Record<string, unknown>;
};

type Retained = {
  schemaId: string;
  intent: Record<string, string>;
  header: string;
  previousCumulativeAmount: string;
  complete: boolean;
};

/**
 * Write-then-rename, flushing the FILE handle. This is the kit's save() with the
 * directory flush dropped, because Windows cannot do it; on POSIX the rename is
 * still ordered after the data flush, which is what matters for not losing a
 * signed Voucher.
 */
function save(file: string, value: unknown): void {
  const temporary = `${file}.tmp`;
  try {
    unlinkSync(temporary);
  } catch {
    /* nothing to clear */
  }
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

async function request(
  url: string,
  headers: Record<string, string>,
  requestFetch: typeof fetch,
): Promise<{ response: Response; body: Record<string, never> }> {
  const response = await requestFetch(url, {
    headers,
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(150_000),
  });
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error("merchant response exceeds the sample limit");
  let body: Record<string, never>;
  try {
    body = JSON.parse(text) as Record<string, never>;
  } catch {
    throw new Error(`merchant answered HTTP ${response.status} with a body that is not JSON`);
  }
  return { response, body };
}

export async function buyResource(input: PurchaseInput): Promise<Purchase> {
  const { context, provider, wallet, channelId, resourceUrl, maximumAmount, operation } = input;
  const requestFetch = input.requestFetch ?? fetch;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(operation) || !/^0x[0-9a-f]{64}$/.test(channelId) || !/^[1-9][0-9]{0,77}$/.test(maximumAmount)) {
    throw new Error("invalid purchase intent");
  }
  const url = new URL(resourceUrl);
  if (url.href !== resourceUrl || url.username || url.password || url.hash || !["http:", "https:"].includes(url.protocol)) {
    throw new Error("resource must be a canonical credential-free URL");
  }
  const requestContext = context.participantRequest as never;
  mkdirSync(input.stateDirectory, { recursive: true, mode: 0o700 });
  const file = join(input.stateDirectory, "purchase.json");
  const intent = {
    environment: (context.x402.merchant as { environmentManifestDigest: string }).environmentManifestDigest,
    agent: wallet.address,
    resourceUrl,
    channelId,
    maximumAmount,
    operation,
  };

  let retained: Retained | undefined;
  try {
    const held = JSON.parse(readFileSync(file, "utf8")) as Retained;
    if (held.schemaId === SCHEMA) retained = held;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (retained && canonicalJson(retained.intent) !== canonicalJson(intent)) {
    // Never replace an unresolved payment; keep it for recovery.
    if (!retained.complete) throw new Error("an unresolved purchase must be resumed with its original arguments");
    const archived = join(input.stateDirectory, `purchase-${retained.intent.operation}.json`);
    save(archived, retained);
    retained = undefined;
  }
  if (!retained) {
    // Reusing a completed operation name must not buy a second resource.
    const archived = join(input.stateDirectory, `purchase-${operation}.json`);
    try {
      retained = JSON.parse(readFileSync(archived, "utf8")) as Retained;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (retained && canonicalJson(retained.intent) !== canonicalJson(intent)) throw new Error("operation name belongs to another purchase");
  }

  if (!retained) {
    const { response, body } = await request(resourceUrl, { "X-AP4M-CHANNEL-ID": channelId }, requestFetch);
    // Nothing is signed or retained yet, so the same operation can simply be retried.
    if (response.status === 503 && body.error === "chain_head_stale") {
      throw new Error("merchant is waiting for a new chain block; retry the same operation shortly");
    }
    if (response.status !== 402) {
      throw new Error(`merchant must return an x402 payment requirement (HTTP ${response.status}: ${body.error ?? ""})`);
    }
    const required = decodeX402PaymentRequired(response.headers.get("PAYMENT-REQUIRED") ?? "") as {
      accepts: {
        scheme: string;
        network: string;
        asset: string;
        amount: string;
        payTo: string;
        extra: { ledger: string; bindingVersion: string; pricingMode: string; channelId: string; acceptedCumulativeAmount: string };
      }[];
      resource: { url: string };
    };
    const safe = await readParticipantFinalizedBlock(provider as never, requestContext);
    const channel = (await readParticipantPaymentChannel(provider as never, requestContext, channelId, safe.number)) as {
      payout: string;
      redeemed: string;
      agent: string;
      status: number;
      validAfter: number;
      validBefore: number;
      cap: string;
    };
    const accepted = required.accepts[0];
    // Every one of the helper's conditions, in the same order.
    if (
      required.accepts.length !== 1 ||
      required.resource.url !== resourceUrl ||
      accepted.scheme !== "batch-settlement" ||
      accepted.network !== context.network ||
      accepted.asset !== context.x402.token ||
      accepted.payTo !== channel.payout ||
      accepted.extra.ledger !== (requestContext as { ledger: string }).ledger ||
      accepted.extra.bindingVersion !== "1" ||
      accepted.extra.pricingMode !== "fixed" ||
      accepted.extra.channelId !== channelId ||
      accepted.extra.acceptedCumulativeAmount !== channel.redeemed ||
      channel.agent !== wallet.address ||
      channel.status !== 1 ||
      safe.timestamp < channel.validAfter ||
      safe.timestamp >= channel.validBefore - 5 ||
      BigInt(accepted.amount) > BigInt(maximumAmount) ||
      BigInt(accepted.amount) + BigInt(channel.redeemed) > BigInt(channel.cap)
    ) {
      throw new Error("merchant challenge exceeds the configured purchase authority");
    }
    await requireCanonicalBlock(provider as never, safe.number, safe.hash);
    console.log(
      `402 Payment Required: merchant asks ${(Number(BigInt(accepted.amount) / 10n ** 12n) / 1e6).toFixed(6)} RLUSD to ${accepted.payTo} (within this agent's limit)`,
    );
    // This is the only signature: a gasless EIP-712 Voucher.
    const payload = await buildX402PaymentPayload({ paymentRequired: required as never, channelId, signer: input.wallet as never });
    retained = {
      schemaId: SCHEMA,
      intent,
      header: encodeX402PaymentSignature(payload),
      previousCumulativeAmount: channel.redeemed,
      complete: false,
    };
    save(file, retained);
  }

  const payload = decodeX402PaymentSignature(retained.header) as {
    accepted: { amount: string };
    payload: { voucher: { cumulativeAmount: string }; agentSignature: string };
  };
  const voucher = { channelId, cumulativeAmount: BigInt(payload.payload.voucher.cumulativeAmount) };
  const claimId = derivePaymentClaimId(requestContext, voucher, retained.previousCumulativeAmount as never);

  const { response, body } = await request(
    resourceUrl,
    { "X-AP4M-CHANNEL-ID": channelId, "PAYMENT-SIGNATURE": retained.header },
    requestFetch,
  );
  if (response.status !== 200) {
    throw new Error(`purchase outcome unavailable (HTTP ${response.status}: ${body.error ?? ""}); resume the same operation`);
  }
  const result = decodeX402PaymentResponse(response.headers.get("PAYMENT-RESPONSE") ?? "") as {
    transaction: string;
    success: boolean;
    network: string;
  };
  const transactionHash = result.transaction;
  const p = provider as {
    getTransactionReceipt(h: string): Promise<{ status: number; blockNumber: number; blockHash: string; logs: { address: string }[] } | null>;
    getTransaction(h: string): Promise<{ to: string; data: string; value: bigint } | null>;
  };
  const [receipt, transaction] = await Promise.all([p.getTransactionReceipt(transactionHash), p.getTransaction(transactionHash)]);
  const safe = await readParticipantFinalizedBlock(provider as never, requestContext);
  const call = encodePaymentVoucherRedemption(requestContext, voucher, payload.payload.agentSignature as never) as { to: string; data: string };
  const claim = (await readParticipantClaim(provider as never, requestContext, claimId, safe.number)) as { channelId: string; amount: string };

  if (
    !result.success ||
    result.network !== context.network ||
    !receipt ||
    receipt.status !== 1 ||
    receipt.blockNumber > safe.number ||
    !transaction ||
    transaction.to !== call.to ||
    transaction.data !== call.data ||
    transaction.value !== 0n ||
    claim.channelId !== channelId ||
    claim.amount !== payload.accepted.amount
  ) {
    throw new Error("merchant result is not a confirmed exact redemption");
  }
  await requireCanonicalBlock(provider as never, receipt.blockNumber, receipt.blockHash);

  const events = receipt.logs
    .flatMap((log) => {
      if (log.address !== call.to) return [];
      try {
        const event = PARTICIPANT_LEDGER_INTERFACE.parseLog(log as never);
        return event?.name === "VoucherRedeemed" ? [event] : [];
      } catch {
        return [];
      }
    })
    .filter((event) => event.args.claimId === claimId && event.args.voucherDigest === hashPaymentVoucher(requestContext, voucher));
  if (events.length !== 1) throw new Error("redemption receipt lacks the exact Voucher event");
  await requireCanonicalBlock(provider as never, safe.number, safe.hash);

  retained.complete = true;
  save(file, retained);
  return { operation, claimId, transactionHash, redemption: "Confirmed", resource: body.resource as Record<string, unknown> };
}
