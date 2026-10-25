/**
 * status — read-only. Says where the AP4M setup stands and changes nothing:
 * no transaction is sent, no Voucher is signed, no channel is opened.
 *
 * The only signature it makes is the sign-in message (EIP-191, gasless, no
 * chain write), which the service needs before it will list merchants and
 * channels. --no-sign-in skips even that and reports the chain-only view.
 *
 *   node src/ops/status.ts --env-file ../../../ap4m-hackathon/.env
 *   node src/ops/status.ts --env-file <path> --json
 *   node src/ops/status.ts --no-sign-in            config and balances only
 */
import { parseArgs } from "node:util";
import { ethers } from "ethers";
import sdk from "../../vendor/ap4m-hackathon-sdk.cjs";
import {
  DEFAULT_API_URL,
  NAMES,
  SetupError,
  checkDistinctWallets,
  env,
  explorerTx,
  loadEnvFile,
  publicConfig,
  rpcUrl,
  type PublicConfig,
} from "../shared/config.ts";

const { values } = parseArgs({
  options: {
    "env-file": { type: "string" },
    "api-url": { type: "string" },
    "sign-in": { type: "string", default: "on" },
    "no-sign-in": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];

/** RLUSD has 18 decimals; formatUnits keeps that exact rather than dividing in floating point. */
function rlusd(wei: unknown): string {
  try {
    return ethers.formatUnits(BigInt(String(wei ?? 0)), 18);
  } catch {
    return "?";
  }
}

function short(id: unknown): string {
  const s = String(id ?? "");
  return s.length > 14 ? `${s.slice(0, 10)}…${s.slice(-4)}` : s;
}

/**
 * One line per channel, and the detail that matters for the next purchase:
 * how much of the cap is left, since the SDK refuses a challenge whose
 * amount + redeemed would exceed it.
 */
function printChannels(channels: unknown, config: PublicConfig): void {
  const list = Array.isArray(channels) ? channels : [];
  if (!list.length) {
    console.log("channels  none: open one with setup-channel.ts");
    return;
  }
  const open = list.filter((c) => c?.channel_status === "open");
  console.log(`channels  ${list.length} total, ${open.length} open\n`);
  console.log("  channel          status  cap    redeemed  settled  left   receipt");
  for (const c of list) {
    const cap = rlusd(c?.cap_wei);
    const redeemed = rlusd(c?.last_voucher_amount);
    const settled = rlusd(c?.last_settled_cumulative_wei);
    let left = "?";
    try {
      left = ethers.formatUnits(BigInt(String(c?.cap_wei ?? 0)) - BigInt(String(c?.last_voucher_amount ?? 0)), 18);
    } catch {
      /* leave as ? */
    }
    console.log(
      `  ${short(c?.channel_id).padEnd(16)} ${String(c?.channel_status ?? "?").padEnd(7)} ` +
        `${cap.padEnd(6)} ${redeemed.padEnd(9)} ${settled.padEnd(8)} ${left.padEnd(6)} ${c?.receipt_available ? "yes" : "no"}`,
    );
  }
  for (const c of open) {
    console.log(`\n  OPEN  ${c?.channel_id}`);
    console.log(`        cap ${rlusd(c?.cap_wei)} RLUSD · redeemed ${rlusd(c?.last_voucher_amount)} · still spendable ${(() => {
      try {
        return ethers.formatUnits(BigInt(String(c?.cap_wei ?? 0)) - BigInt(String(c?.last_voucher_amount ?? 0)), 18);
      } catch {
        return "?";
      }
    })()} RLUSD`);
    if (c?.voucher_redeemed_tx) console.log(`        last redeem   ${explorerTx(config, String(c.voucher_redeemed_tx))}`);
    if (c?.claim_paid_tx) console.log(`        last payout    ${explorerTx(config, String(c.claim_paid_tx))}`);
  }
}

type Report = {
  apiUrl: string;
  network: { name: string; chainId: number; rpcUrl: string; chainIdSeen?: number };
  contracts: PublicConfig["contracts"];
  vaultBalance?: string;
  agent?: { address: string; xrp: string; rlusd: string };
  merchantConfigured?: { merchantId: string; payout: string };
  signedIn: boolean;
  merchants?: unknown;
  channels?: unknown;
  notes: string[];
};

async function main(): Promise<void> {
  const notes: string[] = [];
  if (values["env-file"]) {
    const shadowed = loadEnvFile(values["env-file"]);
    if (shadowed.length) notes.push(`already set in this shell, so the file's values were ignored: ${shadowed.join(", ")}`);
  }

  const apiUrl = (values["api-url"] || env(NAMES.apiUrl, "AP4M API URL", false) || DEFAULT_API_URL).replace(/\/+$/, "");
  const config = await publicConfig(apiUrl);

  const report: Report = {
    apiUrl,
    network: { name: config.network.name, chainId: config.network.chainId, rpcUrl: rpcUrl(config) },
    contracts: config.contracts,
    vaultBalance: config.vaultBalance,
    signedIn: false,
    notes,
  };

  const provider = new ethers.JsonRpcProvider(report.network.rpcUrl, undefined, { staticNetwork: true });
  try {
    const seen = await provider.getNetwork();
    report.network.chainIdSeen = Number(seen.chainId);
    if (report.network.chainIdSeen !== config.network.chainId) {
      notes.push(`the RPC reports chain ${report.network.chainIdSeen} but the service expects ${config.network.chainId}`);
    }
  } catch (error) {
    notes.push(`the RPC did not answer: ${(error as Error).message}`);
  }

  // Agent wallet: derive the address from the key when one is present, else use
  // the recorded address. The key itself is never printed.
  const key = env(NAMES.agentKey, "agent key", false);
  const recorded = env(NAMES.agentAddress, "agent address", false);
  let wallet: ethers.Wallet | undefined;
  if (key) {
    try {
      wallet = new ethers.Wallet(key, provider);
    } catch {
      throw new SetupError("AGENT_PRIVATE_KEY is not a usable private key");
    }
    if (recorded && recorded.toLowerCase() !== wallet.address.toLowerCase()) {
      notes.push(`AP4M_AGENT_ADDRESS (${recorded}) is not the address of AGENT_PRIVATE_KEY (${wallet.address})`);
    }
  }
  const address = wallet?.address ?? recorded;

  const merchantId = env(NAMES.merchantId, "merchant id", false);
  const payout = env(NAMES.merchantPayout, "merchant payout", false);
  if (merchantId || payout) report.merchantConfigured = { merchantId: merchantId || "(unset)", payout: payout || "(unset)" };
  if (address && payout) checkDistinctWallets(address, payout);

  if (address) {
    const agent: { address: string; xrp: string; rlusd: string } = { address, xrp: "?", rlusd: "?" };
    try {
      agent.xrp = ethers.formatEther(await provider.getBalance(address));
    } catch (error) {
      notes.push(`could not read the gas balance: ${(error as Error).message}`);
    }
    try {
      const rlusd = new ethers.Contract(config.contracts.rlusdToken, ERC20, provider);
      const [raw, decimals] = await Promise.all([rlusd.balanceOf(address), rlusd.decimals()]);
      agent.rlusd = ethers.formatUnits(raw, decimals);
    } catch (error) {
      notes.push(`could not read the RLUSD balance: ${(error as Error).message}`);
    }
    report.agent = agent;
  } else {
    notes.push("no agent wallet: set AGENT_PRIVATE_KEY or AP4M_AGENT_ADDRESS to see balances");
  }

  const wantSignIn = values["sign-in"] === "on" && !values["no-sign-in"];
  if (wantSignIn && wallet) {
    const teamName = env(NAMES.teamName, "team name", false);
    if (!teamName) {
      notes.push("no TEAM_NAME, so merchants and channels were not listed");
    } else {
      try {
        // Gasless EIP-191 message signature; nothing is written on chain.
        const session = await sdk.signIn(apiUrl, teamName, wallet);
        const token = session.token ?? session.sessionToken ?? session;
        report.signedIn = true;
        try {
          // listMerchants takes the API url only; it needs no token.
          report.merchants = await sdk.listMerchants(apiUrl);
        } catch (error) {
          notes.push(`listMerchants failed: ${(error as Error).message}`);
        }
        try {
          report.channels = await sdk.listChannels(apiUrl, token);
        } catch (error) {
          notes.push(`listChannels failed: ${(error as Error).message}`);
        }
      } catch (error) {
        notes.push(`sign-in failed: ${(error as Error).message}`);
      }
    }
  } else if (wantSignIn) {
    notes.push("no AGENT_PRIVATE_KEY, so sign-in was skipped");
  }

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const n = report.network;
  console.log(`AP4M status (read-only; nothing was sent or signed on chain)\n`);
  console.log(`service   ${report.apiUrl}`);
  console.log(`network   ${n.name}, chain ${n.chainId}${n.chainIdSeen ? ` (RPC reports ${n.chainIdSeen})` : ""}`);
  console.log(`rpc       ${n.rpcUrl}`);
  console.log(`ledger    ${report.contracts.paymentLedger}`);
  console.log(`registry  ${report.contracts.participantRegistry}`);
  console.log(`vault     ${report.contracts.pooledEscrowVault}${report.vaultBalance ? `  balance ${report.vaultBalance}` : ""}`);
  console.log(`rlusd     ${report.contracts.rlusdToken}`);
  if (report.agent) console.log(`\nagent     ${report.agent.address}\n          ${report.agent.xrp} XRP (gas) · ${report.agent.rlusd} RLUSD`);
  if (report.merchantConfigured) {
    console.log(`merchant  id ${report.merchantConfigured.merchantId}\n          payout ${report.merchantConfigured.payout}`);
  }
  console.log(`\nsigned in ${report.signedIn ? "yes" : "no"}`);
  if (report.merchants !== undefined) {
    const list = Array.isArray(report.merchants) ? report.merchants : [];
    console.log(`merchants ${list.length ? JSON.stringify(list) : "none listed (own-wallet merchants are not in the pool list)"}`);
  }
  if (report.channels !== undefined) printChannels(report.channels, config);
  if (notes.length) {
    console.log("\nnotes:");
    for (const note of notes) console.log(`  - ${note}`);
  }
}

main().catch((error) => {
  console.error(error instanceof SetupError ? error.message : error);
  process.exit(1);
});
