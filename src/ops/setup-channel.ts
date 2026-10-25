/**
 * setup-channel — open a funded Channel from the agent wallet to our own merchant.
 *
 * READ-ONLY BY DEFAULT. Without --confirm it only reports what it would do and
 * exits; nothing is signed and no gas is spent. --confirm sends the one
 * channel-request transaction (the only gas the agent ever pays: Vouchers
 * themselves are gasless).
 *
 *   node src/ops/setup-channel.ts --env-file ../../../ap4m-hackathon/.env
 *   node src/ops/setup-channel.ts --env-file <path> --cap 1 --confirm
 *
 * --cap N        channel cap in RLUSD (default CHANNEL_CAP, else 1)
 * --confirm      actually send the transaction
 * --extra        allow opening another channel while one is already open
 * --timeout-ms   how long to wait for the service to report it open (default 180000)
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
} from "../shared/config.ts";

const { values } = parseArgs({
  options: {
    "env-file": { type: "string" },
    "api-url": { type: "string" },
    cap: { type: "string" },
    confirm: { type: "boolean", default: false },
    extra: { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "180000" },
  },
});

function rlusd(wei: unknown): string {
  try {
    return ethers.formatUnits(BigInt(String(wei ?? 0)), 18);
  } catch {
    return "?";
  }
}

async function main(): Promise<void> {
  if (values["env-file"]) loadEnvFile(values["env-file"]);

  const apiUrl = (values["api-url"] || env(NAMES.apiUrl, "AP4M API URL", false) || DEFAULT_API_URL).replace(/\/+$/, "");
  const teamName = env(NAMES.teamName, "team name");
  const key = env(NAMES.agentKey, "agent private key");
  const merchantId = env(NAMES.merchantId, "merchant id");
  const payout = env(NAMES.merchantPayout, "merchant payout address", false);

  const cap = values.cap ?? env(NAMES.channelCap, "channel cap", false) ?? "";
  const capRlusd = Number(cap || "1");
  if (!Number.isFinite(capRlusd) || capRlusd <= 0) throw new SetupError(`--cap must be above zero, got ${cap}`);

  const config = await publicConfig(apiUrl);
  const rpc = rpcUrl(config);
  const provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true });

  let wallet: ethers.Wallet;
  try {
    wallet = new ethers.Wallet(key, provider);
  } catch {
    throw new SetupError("AGENT_PRIVATE_KEY is not a usable private key");
  }
  if (payout) checkDistinctWallets(wallet.address, payout);

  const gas = await provider.getBalance(wallet.address);
  console.log(`service    ${apiUrl}`);
  console.log(`network    ${config.network.name}, chain ${config.network.chainId}`);
  console.log(`agent      ${wallet.address}  ${ethers.formatEther(gas)} XRP for gas`);
  console.log(`merchant   ${merchantId}`);
  if (payout) console.log(`payout     ${payout}`);
  console.log(`cap        ${capRlusd} RLUSD\n`);

  if (gas === 0n) {
    throw new SetupError(
      "the agent wallet has no XRP for gas. Opening a Channel needs one transaction; fund it from the XRPL EVM Testnet faucet " +
        "(https://faucet.xrplevm.org — the host the service advertises has no DNS records, see AGENTS.md).",
    );
  }

  // Sign-in is a gasless message signature, so it is safe before --confirm.
  const session = await sdk.signIn(apiUrl, teamName, wallet);
  const token = session.token ?? session.sessionToken ?? session;

  const channels: Record<string, unknown>[] = await sdk.listChannels(apiUrl, token);
  const open = channels.filter((c) => c?.channel_status === "open");
  if (open.length) {
    console.log(`${open.length} channel(s) already open:`);
    for (const c of open) {
      const left = (() => {
        try {
          return ethers.formatUnits(BigInt(String(c.cap_wei ?? 0)) - BigInt(String(c.last_voucher_amount ?? 0)), 18);
        } catch {
          return "?";
        }
      })();
      console.log(`  ${c.channel_id}`);
      console.log(`    cap ${rlusd(c.cap_wei)} · redeemed ${rlusd(c.last_voucher_amount)} · still spendable ${left} RLUSD`);
    }
    if (!values.extra) {
      console.log(
        "\nNothing to do: reuse an open Channel for many payments. Pass --extra to open another anyway " +
          "(it costs gas and splits the budget).",
      );
      return;
    }
  }

  if (!values.confirm) {
    console.log("DRY RUN: nothing signed, no gas spent, no Channel opened.");
    console.log(`Re-run with --confirm to open a Channel with a cap of ${capRlusd} RLUSD.`);
    console.log("That sends ONE transaction from the agent wallet; Vouchers afterwards are gasless.");
    return;
  }

  console.log(`opening a Channel with a cap of ${capRlusd} RLUSD (this sends one transaction)...`);
  const channel = await sdk.requestChannel(apiUrl, token, wallet, {
    capRlusd,
    merchantId,
    rpcUrl: rpc,
    timeoutMs: Number(values["timeout-ms"]),
  });

  console.log(`\nchannel   ${channel.channel_id}`);
  console.log(`status    ${channel.channel_status}`);
  console.log(`cap       ${rlusd(channel.cap_wei)} RLUSD`);
  if (channel.request_tx) console.log(`request   ${explorerTx(config, String(channel.request_tx))}`);
  if (channel.channel_opened_tx) console.log(`opened    ${explorerTx(config, String(channel.channel_opened_tx))}`);
  console.log(`\nPut this in the agent's --channel-id, or let the rail read it from listChannels.`);
}

main().catch((error) => {
  console.error(error instanceof SetupError ? error.message : error);
  process.exit(1);
});
