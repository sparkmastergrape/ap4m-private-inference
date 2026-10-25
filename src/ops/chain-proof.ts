/**
 * chain-proof — read-only. For every paid ask in the payment ledger it looks up, on the RPC node:
 *
 *   - the redeem transaction: status, block, and the VoucherRedeemed log on the PaymentLedger, checked for this
 *     claim id and this amount;
 *   - the RLUSD payout: a Transfer to the seller of exactly this amount that no earlier claim used.
 *
 * Nothing is signed or sent, and no key is used: the lookups are public chain reads.
 *
 *   node src/ops/chain-proof.ts
 *   node src/ops/chain-proof.ts --env-file <env> --ledger-dir .ap4m-ledger --channel-id 0x...
 *
 * The RPC URL can carry an access token (QuickNode URLs do), so it is NEVER printed: the header names the provider
 * family only. Each claim is paired with its own payout by amount and order, not by the payout hash in the ledger's
 * settlement line, because two claims of equal amount can carry the same hash there. Exit 1 if anything is unconfirmed.
 */
import { parseArgs } from "node:util";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ethers } from "ethers";
import { DEFAULT_API_URL, NAMES, env, explorerTx, loadEnvFile, publicConfig, rpcUrl } from "../shared/config.ts";

const { values } = parseArgs({
  options: {
    "ledger-dir": { type: "string", default: ".ap4m-ledger" },
    "env-file": { type: "string", multiple: true },
    "api-url": { type: "string" },
    "channel-id": { type: "string" },
    "payout-window": { type: "string", default: "80" },
  },
});

type Line = {
  kind: string;
  channelId?: string;
  claimId?: string;
  amountWei?: string;
  redeemTx?: string;
  payoutTx?: string;
};

const TRANSFER = ethers.id("Transfer(address,address,uint256)");
const REDEEMED = ethers.id(
  "VoucherRedeemed(bytes32,bytes32,bytes32,bytes32,address,bytes32,address,address,uint256,uint256,uint256)",
);

const short = (h: string, a = 8, b = 4): string => (h.length > a + b + 3 ? `${h.slice(0, a)}…${h.slice(-b)}` : h);
const rlusd = (wei: bigint): string => ethers.formatUnits(wei, 18);
const topicAddress = (topic: string): string => ethers.getAddress(`0x${topic.slice(26)}`);

function readLedger(dir: string): Line[] {
  if (!existsSync(dir)) throw new Error(`no ledger directory at ${dir} (pass --ledger-dir)`);
  const lines: Line[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    for (const raw of readFileSync(join(dir, name), "utf8").split(/\r?\n/)) {
      if (raw.trim()) lines.push(JSON.parse(raw) as Line);
    }
  }
  return lines;
}

async function main(): Promise<number> {
  for (const file of values["env-file"] ?? []) loadEnvFile(file);
  const apiUrl = (values["api-url"] || env(NAMES.apiUrl, "AP4M API URL", false) || DEFAULT_API_URL).replace(/\/+$/, "");
  const config = await publicConfig(apiUrl);
  const url = rpcUrl(config);
  const provider = new ethers.JsonRpcProvider(url);
  const label = new URL(url).hostname.includes("quiknode") ? "QuickNode RPC" : "RPC node";
  const token = config.contracts.rlusdToken.toLowerCase();
  const ledgerAddress = config.contracts.paymentLedger.toLowerCase();
  const vault = config.contracts.pooledEscrowVault.toLowerCase();
  const windowBlocks = Number(values["payout-window"]);

  const all = readLedger(resolve(values["ledger-dir"]!));
  const wantChannel = values["channel-id"]?.toLowerCase();
  const inChannel = (l: Line): boolean => !wantChannel || l.channelId?.toLowerCase() === wantChannel;
  const redemptions = all.filter((l) => l.kind === "redemption" && l.redeemTx && l.claimId && l.amountWei && inChannel(l));
  const settlements = all.filter((l) => l.kind === "settlement" && l.payoutTx);
  if (redemptions.length === 0) {
    console.error("no paid asks in the ledger, so there is nothing to look up");
    return 1;
  }

  const [network, latest] = await Promise.all([provider.getNetwork(), provider.getBlockNumber()]);
  console.log(`${label} · ${config.network.name} · chain ${network.chainId} · latest block ${latest} · url hidden`);
  console.log(`PaymentLedger ${short(ledgerAddress, 8, 6)}   RLUSD ${short(token, 8, 6)}`);
  console.log("");

  // The seller: MERCHANT_PAYOUT_ADDRESS when set, else learned from the first settlement line's payout transaction.
  let seller = env(NAMES.merchantPayout, "merchant payout address", false) || null;
  const used = new Set<string>();
  let okRedeem = 0;
  let okPayout = 0;
  let total = 0n;
  let n = 0;

  for (const r of redemptions) {
    n++;
    const amount = BigInt(r.amountWei!);
    console.log(`${n}  claim ${short(r.claimId!, 10, 4)}   ${rlusd(amount)} RLUSD`);

    const rc = await provider.getTransactionReceipt(r.redeemTx!);
    if (!rc) {
      console.log("   redeem  not found on this node");
      console.log("");
      continue;
    }
    const log = rc.logs.find((l) => l.address.toLowerCase() === ledgerAddress && l.topics[0] === REDEEMED);
    const hasClaim = !!log && (log.topics.includes(r.claimId!) || log.data.includes(r.claimId!.slice(2)));
    const hasAmount = !!log && log.data.toLowerCase().includes(amount.toString(16).padStart(64, "0"));
    if (rc.status === 1 && hasClaim && hasAmount) okRedeem++;
    console.log(
      `   redeem  ${short(r.redeemTx!, 10, 4)}  block ${rc.blockNumber}  ${rc.status === 1 ? "success" : "FAILED"}  VoucherRedeemed on PaymentLedger`,
    );
    console.log(`           claim id in log: ${hasClaim ? "yes" : "NO"}   amount in log: ${hasAmount ? "yes" : "NO"}`);
    console.log(`           ${explorerTx(config, r.redeemTx!)}`);

    if (!seller) {
      const first = settlements.find((s) => s.claimId === r.claimId);
      const firstReceipt = first ? await provider.getTransactionReceipt(first.payoutTx!) : null;
      const transfer = firstReceipt?.logs.find((l) => l.address.toLowerCase() === token && l.topics[0] === TRANSFER);
      if (transfer) seller = topicAddress(transfer.topics[2]);
    }

    let payoutHash: string | null = null;
    if (seller) {
      const found = await provider.getLogs({
        address: token,
        topics: [TRANSFER, null, ethers.zeroPadValue(seller, 32)],
        fromBlock: rc.blockNumber,
        toBlock: rc.blockNumber + windowBlocks,
      });
      const hit = found.find((l) => BigInt(l.data) === amount && !used.has(l.transactionHash));
      if (hit) {
        payoutHash = hit.transactionHash;
        used.add(payoutHash);
      }
    }
    const payout = payoutHash ? await provider.getTransactionReceipt(payoutHash) : null;
    if (payout && payoutHash) {
      if (payout.status === 1) {
        okPayout++;
        total += amount;
      }
      for (const l of payout.logs.filter((x) => x.address.toLowerCase() === token && x.topics[0] === TRANSFER)) {
        const from = topicAddress(l.topics[1]);
        const to = topicAddress(l.topics[2]);
        console.log(
          `   payout  ${short(payoutHash, 10, 4)}  block ${payout.blockNumber}  ${payout.status === 1 ? "success" : "FAILED"}  RLUSD ${rlusd(BigInt(l.data))}`,
        );
        console.log(`           ${from.toLowerCase() === vault ? "vault" : "from"} ${short(from, 8, 4)}  ->  seller ${short(to, 8, 4)}`);
      }
      console.log(`           ${explorerTx(config, payoutHash)}`);
    } else {
      console.log(`   payout  not found on chain within ${windowBlocks} blocks of the redeem`);
    }
    console.log("");
  }

  console.log(
    `${okRedeem} of ${redemptions.length} redeems and ${okPayout} of ${redemptions.length} payouts confirmed on chain: ${rlusd(total)} RLUSD, vault -> seller`,
  );
  console.log("(claims with equal amounts are paired with their payout by order)");
  return okRedeem === redemptions.length && okPayout === redemptions.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    // Never echo the RPC URL, even from an error message that quotes it.
    console.error(String((error as Error).message ?? error).replace(/https?:\/\/\S+/g, "[url hidden]"));
    process.exit(1);
  },
);
