/**
 * Run the AP4M x402 inference merchant.
 *
 *   node src/merchant/main.ts --env-file ../../../ap4m-hackathon/.env --gateway stub
 *   node src/merchant/main.ts --env-file <path> --gateway http --gateway-url http://127.0.0.1:8700
 *
 * --env-file PATH               repeatable: the AP4M wallet settings and the
 *                               ChainAim gateway settings live in separate files
 * --port N                      listen port (default 4308)
 * --resource-url URL            canonical /resource URL agents buy from
 *                               (default http://127.0.0.1:<port>/resource)
 * --gateway stub|http           where inference comes from (default http)
 * --gateway-url URL             the ChainAim gateway root (default CHAINAIM_GATEWAY_URL)
 * --pricing PATH                pricing sheet (default config/pricing.json)
 * --models PATH                 model rate table (default config/models.json)
 * --ledger-dir PATH             payments-YYYY-MM-DD.jsonl, ids and prices only (default .ap4m-ledger)
 * --state-dir PATH              SQLite + lock live here (default .ap4m-merchant-state)
 * --merchant-cutoff-seconds N   head-room before a window closes, 5..299 (default 30)
 * --inference-timeout-ms N      one inference's limit (default 90000)
 * --job-ttl-seconds N           how long a staged job stays buyable (default 600)
 *
 * Secrets come from the environment only: MERCHANT_SUBMITTER_KEY signs the
 * redemption transactions and is never printed. The submitter is a gas wallet,
 * not the payout wallet and not the agent wallet.
 */
import { Ledger } from "../shared/ledger.ts";
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ethers } from "ethers";
import { loadX402Context } from "../../vendor/ap4m-x402.mjs";
import { createMerchant } from "./x402-merchant.ts";
import { httpGateway, type Gateway } from "./gateway-client.ts";
import { stubGateway } from "./stub-gateway.ts";
import { DEFAULT_API_URL, NAMES, SetupError, checkDistinctWallets, env, loadEnvFile, publicConfig, rpcUrl } from "../shared/config.ts";
import type { Pricing, ModelRates } from "../shared/estimate.ts";

const { values } = parseArgs({
  options: {
    "env-file": { type: "string", multiple: true },
    "api-url": { type: "string" },
    port: { type: "string", default: "4308" },
    "resource-url": { type: "string" },
    gateway: { type: "string", default: "http" },
    "gateway-url": { type: "string" },
    pricing: { type: "string", default: "config/pricing.json" },
    models: { type: "string", default: "config/models.json" },
    "state-dir": { type: "string", default: ".ap4m-merchant-state" },
    "ledger-dir": { type: "string", default: ".ap4m-ledger" },
    "merchant-cutoff-seconds": { type: "string", default: "30" },
    "inference-timeout-ms": { type: "string", default: "90000" },
    "job-ttl-seconds": { type: "string", default: "600" },
  },
});

function readJson<T>(path: string, what: string): T {
  const full = resolve(path);
  try {
    return JSON.parse(readFileSync(full, "utf8")) as T;
  } catch (error) {
    throw new SetupError(`cannot read the ${what} at ${full}: ${(error as Error).message}`);
  }
}

async function main(): Promise<void> {
  // Repeatable: the AP4M wallet settings and the ChainAim gateway settings live
  // in separate files, and a value already in the shell always wins.
  for (const file of values["env-file"] ?? []) loadEnvFile(file);

  const apiUrl = (values["api-url"] || env(NAMES.apiUrl, "AP4M API URL", false) || DEFAULT_API_URL).replace(/\/+$/, "");
  const merchantParticipantId = env(NAMES.merchantId, "merchant id");
  const payout = env(NAMES.merchantPayout, "merchant payout address");
  const submitterKey = env(NAMES.submitterKey, "merchant submitter key");

  const port = Number(values.port);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new SetupError(`--port must be a port number, got ${values.port}`);
  const resourceUrl = values["resource-url"] || `http://127.0.0.1:${port}/resource`;

  const pricing = readJson<Pricing>(values.pricing!, "pricing sheet");
  const models = readJson<{ default: string; rates: Record<string, ModelRates> }>(values.models!, "model rate table");
  if (!models.rates?.[models.default]) throw new SetupError(`the model table's default (${models.default}) has no rates`);

  let gateway: Gateway;
  if (values.gateway === "stub") {
    gateway = stubGateway();
  } else if (values.gateway === "http") {
    const gatewayUrl = values["gateway-url"] || env(["CHAINAIM_GATEWAY_URL", "GATEWAY_URL"], "gateway URL");
    gateway = httpGateway(gatewayUrl, env(["CHAINAIM_GATEWAY_KEY", "GATEWAY_API_KEY"], "gateway API key", false));
  } else {
    throw new SetupError(`--gateway must be stub or http, got ${values.gateway}`);
  }

  const config = await publicConfig(apiUrl);
  const provider = new ethers.JsonRpcProvider(rpcUrl(config), undefined, { staticNetwork: true });
  let submitter: ethers.Wallet;
  try {
    submitter = new ethers.Wallet(submitterKey, provider);
  } catch {
    throw new SetupError("MERCHANT_SUBMITTER_KEY is not a usable private key");
  }
  // AP4M's rule is that the agent, payout and funding wallets differ. The
  // submitter only pays gas for redeemVoucher, and the team's onboarded merchant
  // wallet is both the submitter and the payout, so those two may match.
  checkDistinctWallets(env(NAMES.agentAddress, "agent address", false), payout);

  const gas = await provider.getBalance(submitter.address);
  const context = await loadX402Context(apiUrl);

  const merchant = createMerchant({
    context,
    provider,
    submitter,
    merchantParticipantId,
    payout,
    resourceUrl,
    stateDirectory: resolve(values["state-dir"]!),
    ledger: new Ledger(resolve(values["ledger-dir"]!)),
    pricing,
    modelRates: models.rates,
    defaultModel: models.default,
    gateway,
    cutoffMarginSeconds: Number(values["merchant-cutoff-seconds"]),
    inferenceTimeoutMs: Number(values["inference-timeout-ms"]),
    jobTtlSeconds: Number(values["job-ttl-seconds"]),
  });

  console.log("AP4M x402 inference merchant");
  console.log(`service    ${apiUrl}`);
  console.log(`network    ${config.network.name}, chain ${config.network.chainId}`);
  console.log(`merchant   ${merchantParticipantId}`);
  console.log(`payout     ${payout}`);
  console.log(`submitter  ${submitter.address}  ${ethers.formatEther(gas)} XRP for gas`);
  console.log(`gateway    ${values.gateway}${values.gateway === "http" ? ` ${values["gateway-url"] || "(from the environment)"}` : ""}`);
  console.log(`pricing    ${resolve(values.pricing!)}  model ${models.default}`);
  console.log(`state      ${resolve(values["state-dir"]!)}`);
  console.log(`ledger     ${resolve(values["ledger-dir"]!)}`);
  console.log(`resource   ${resourceUrl}`);
  if (gas === 0n) {
    console.log(
      "\nWARNING: the submitter has no XRP, so it cannot pay gas for redeemVoucher. " +
        "Fund it from https://faucet.xrplevm.org before taking a payment.",
    );
  }
  if (!(await gateway.healthy())) {
    console.log("\nWARNING: the gateway did not report healthy. Paid asks will answer 502 inference_failed until it does.");
  }

  merchant.server.listen(port, "127.0.0.1", () => {
    console.log(`\nlistening on http://127.0.0.1:${port}`);
    console.log("  POST /jobs          stage a masked request, get a quote   (free)");
    console.log("  GET  /quote/<id>    what a staged job costs               (free)");
    console.log("  GET  /resource      402 -> pay -> answer                  (paid)");
    console.log("  GET  /healthz       gateway reachability                  (free)");
  });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: closing`);
    merchant
      .close()
      .then(() => process.exit(0))
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}

main().catch((error) => {
  console.error(error instanceof SetupError ? error.message : error);
  process.exit(1);
});
