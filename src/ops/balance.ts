/**
 * balance — read-only. RLUSD and gas balances of the agent and the seller
 * (merchant payout), straight from the chain. Judges check that the seller's
 * balance changed; run it before and after a paid ask.
 *
 *   node src/ops/balance.ts --env-file ../../../ap4m-hackathon/.env
 */
import { parseArgs } from "node:util";
import { ethers } from "ethers";
import { DEFAULT_API_URL, NAMES, env, explorerTx, loadEnvFile, publicConfig, rpcUrl } from "../shared/config.ts";

const { values } = parseArgs({ options: { "env-file": { type: "string", multiple: true }, "api-url": { type: "string" } } });

async function main(): Promise<void> {
  for (const file of values["env-file"] ?? []) loadEnvFile(file);
  const apiUrl = (values["api-url"] || env(NAMES.apiUrl, "AP4M API URL", false) || DEFAULT_API_URL).replace(/\/+$/, "");
  const config = await publicConfig(apiUrl);
  const provider = new ethers.JsonRpcProvider(rpcUrl(config), undefined, { staticNetwork: true });
  const token = new ethers.Contract(config.contracts.rlusdToken, ["function balanceOf(address) view returns (uint256)"], provider);

  const agent = new ethers.Wallet(env(NAMES.agentKey, "agent private key"), provider).address;
  const seller = env(["MERCHANT_PAYOUT_ADDRESS", "MERCHANT_PAYOUT"], "merchant payout address");
  const block = await provider.getBlockNumber();

  console.log(`network   ${config.network.name}  block ${block}`);
  for (const [name, address] of [["agent", agent], ["seller", seller]] as const) {
    const [rlusd, gas] = await Promise.all([token.balanceOf(address), provider.getBalance(address)]);
    console.log(`${name.padEnd(9)} ${address}`);
    console.log(`          ${ethers.formatUnits(rlusd, 18)} RLUSD   ${Number(ethers.formatEther(gas)).toFixed(3)} XRP (gas)`);
  }
  console.log(`explorer  ${explorerTx(config, "").replace(/\/tx\/$/, "")}/address/${seller}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
