/**
 * ledger-view — read-only. Joins the payment ledger's redemption and settlement
 * lines on claimId and prints one row per paid ask.
 *
 *   node src/ops/ledger-view.ts
 *   node src/ops/ledger-view.ts --ledger-dir .ap4m-ledger --channel-id 0x...
 *   node src/ops/ledger-view.ts --forbid "Ravi Kumar,Lakshmi Iyer,98765"
 *
 * --forbid takes comma-separated real values that must NOT appear anywhere in
 * the ledger. Each is searched for in the raw files; any hit exits 1. This is the
 * "no personal data" claim made checkable rather than asserted. Every line is
 * also run through assertNoText, so a stray text field fails the view too.
 *
 * Only claims with a redemption line are shown: a settlement line alone is a
 * claim this merchant never served (another process's payment on the channel).
 */
import { parseArgs } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ethers } from "ethers";
import { DEFAULT_API_URL, NAMES, env, explorerTx, loadEnvFile, publicConfig, rpcUrl } from "../shared/config.ts";
import { assertNoText, type RedemptionEntry, type SettlementEntry } from "../shared/ledger.ts";

const { values } = parseArgs({
  options: {
    "ledger-dir": { type: "string", default: ".ap4m-ledger" },
    "env-file": { type: "string", multiple: true },
    "api-url": { type: "string" },
    "channel-id": { type: "string" },
    forbid: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

const short = (id?: string): string => (id && id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : (id ?? "-"));
const rlusd = (wei: string): string => ethers.formatUnits(BigInt(wei), 18);

const TRANSFER = ethers.id("Transfer(address,address,uint256)");

/**
 * Look for the payout itself: an RLUSD Transfer to the seller of exactly this
 * claim's amount, in the blocks after the redemption. The service pays out on
 * its own, so a missing settlement LINE does not mean a missing payout: the
 * chain is the evidence, not this ledger.
 */
async function findPayout(
  provider: ethers.JsonRpcProvider,
  token: string,
  seller: string,
  entry: RedemptionEntry,
): Promise<{ block: number; tx: string } | undefined> {
  const receipt = await provider.getTransactionReceipt(entry.redeemTx);
  if (!receipt) return undefined;
  const head = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: token,
    topics: [TRANSFER, null, ethers.zeroPadValue(seller, 32)],
    fromBlock: receipt.blockNumber,
    toBlock: Math.min(head, receipt.blockNumber + 40),
  });
  const hit = logs.find((l) => BigInt(l.data) === BigInt(entry.amountWei));
  return hit ? { block: hit.blockNumber, tx: hit.transactionHash } : undefined;
}

async function main(): Promise<void> {
  const dir = resolve(values["ledger-dir"]!);
  if (!existsSync(dir)) {
    console.error(`no ledger at ${dir}`);
    process.exit(1);
  }
  const files = readdirSync(dir).filter((n) => /^payments-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort();
  const redemptions = new Map<string, RedemptionEntry>();
  const settlements = new Map<string, SettlementEntry>();
  let raw = "";
  let lines = 0;

  for (const name of files) {
    const text = readFileSync(join(dir, name), "utf8");
    raw += text;
    for (const line of text.split("\n")) {
      if (!line) continue;
      const entry = JSON.parse(line) as RedemptionEntry | SettlementEntry;
      assertNoText(entry);
      lines++;
      if (values["channel-id"] && entry.channelId !== values["channel-id"]) continue;
      if (entry.kind === "redemption") redemptions.set(entry.claimId, entry);
      else settlements.set(entry.claimId, entry);
    }
  }

  let chain: { provider: ethers.JsonRpcProvider; token: string; seller: string; explorer: (h: string) => string } | undefined;
  if (values["env-file"]?.length) {
    for (const file of values["env-file"]) loadEnvFile(file);
    const apiUrl = (values["api-url"] || env(NAMES.apiUrl, "AP4M API URL", false) || DEFAULT_API_URL).replace(/\/+$/, "");
    const config = await publicConfig(apiUrl);
    chain = {
      provider: new ethers.JsonRpcProvider(rpcUrl(config), undefined, { staticNetwork: true }),
      token: config.contracts.rlusdToken,
      seller: env(["MERCHANT_PAYOUT_ADDRESS", "MERCHANT_PAYOUT"], "merchant payout address"),
      explorer: (h) => explorerTx(config, h),
    };
  }

  const rows = [...redemptions.values()].sort((a, b) => a.ts.localeCompare(b.ts));
  if (values.json) {
    console.log(JSON.stringify(rows.map((r) => ({ redemption: r, settlement: settlements.get(r.claimId) ?? null })), null, 2));
  } else {
    console.log(`ledger ${dir}: ${lines} line(s) in ${files.length} file(s); ${rows.length} served ask(s)\n`);
    for (const r of rows) {
      const s = settlements.get(r.claimId);
      const quotedTok = Number((r.quote as { outTok?: number }).outTok ?? 0) + Number((r.quote as { inTok?: number }).inTok ?? 0);
      console.log(`${r.ts}  channel ${short(r.channelId)}  claim ${short(r.claimId)}`);
      console.log(`  paid        ${rlusd(r.amountWei)} RLUSD   running total ${rlusd(r.cumulativeWei)}`);
      console.log(`  model       ${r.model ?? "-"}   decision ${short(r.decisionId)}`);
      console.log(`  tokens      quoted ≤${quotedTok}   actual ${r.actual?.totalTokens ?? "-"}`);
      console.log(`  redeem tx   ${short(r.redeemTx)}`);
      let settled = s ? `yes   receipt ${s.receiptUrl ?? "none yet"}` : "";
      if (!s) {
        const payout = chain ? await findPayout(chain.provider, chain.token, chain.seller, r).catch(() => undefined) : undefined;
        settled = payout
          ? `yes, on chain: payout in block ${payout.block}  ${chain!.explorer(payout.tx)}`
          : chain
            ? "no payout found within 40 blocks of the redeem"
            : "no settlement line (pass --env-file to check the chain)";
      }
      console.log(`  settled     ${settled}\n`);
    }
  }

  if (values.forbid) {
    const hits = values.forbid.split(",").map((v) => v.trim()).filter(Boolean).filter((v) => raw.includes(v));
    if (hits.length) {
      console.error(`PERSONAL DATA FOUND in the ledger: ${hits.map((h) => JSON.stringify(h)).join(", ")}`);
      process.exit(1);
    }
    console.log(`personal data: none of ${values.forbid.split(",").length} forbidden value(s) appear in ${files.length} ledger file(s)`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
